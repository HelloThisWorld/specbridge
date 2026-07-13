import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { LIMITS, capDiagnostics, truncateText } from '../limits.js';
import { diagnosticShape, specNameArg, stageArg, toDiagnosticViews } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';
import { assertCurrentHash, evaluateStageCandidate } from './stage-shared.js';

/**
 * spec_stage_validate — validate a candidate stage document WITHOUT writing.
 *
 * Runs the same deterministic analysis the CLI uses, computes the proposed
 * diff and approval effects, and returns the candidate hash that
 * spec_stage_apply requires — binding apply to exactly the reviewed bytes.
 */

const inputSchema = {
  specName: specNameArg,
  stage: stageArg,
  candidateMarkdown: z
    .string()
    .max(LIMITS.maximumCandidateBytes)
    .describe('Full candidate document content (Markdown)'),
  expectedCurrentHash: z
    .string()
    .nullable()
    .optional()
    .describe('Optional guard: SHA-256 of the current document bytes (null asserts the file is absent)'),
};

const outputSchema = {
  specName: z.string(),
  stage: stageArg,
  valid: z.boolean().describe('True when the candidate has no analysis errors'),
  candidateHash: z.string().describe('Pass this to spec_stage_apply as expectedCandidateHash'),
  currentHash: z.string().nullable().describe('SHA-256 of the current document bytes (null when absent)'),
  currentExists: z.boolean(),
  targetPath: z.string(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  diagnostics: z.array(diagnosticShape),
  diagnosticsDropped: z.number().int(),
  diff: z.string().describe('Unified diff current → candidate (may be truncated)'),
  diffTruncated: z.boolean(),
  wouldInvalidateApprovals: z.array(z.string()),
  warnings: z.array(z.string()),
  nextStep: z.string(),
};

export function registerSpecStageValidateTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_stage_validate',
    title: 'Validate a stage candidate',
    description:
      'Validate a candidate requirements/bugfix/design/tasks document without writing anything: ' +
      'deterministic analysis, proposed diff, approval-invalidation effects, and the candidate hash ' +
      'that spec_stage_apply requires. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      const evaluation = evaluateStageCandidate(context, {
        specName: args.specName,
        stage: args.stage,
        candidateMarkdown: args.candidateMarkdown,
      });
      assertCurrentHash(evaluation, args.expectedCurrentHash);

      const valid = !evaluation.analysisResult.hasErrors;
      const capped = capDiagnostics(
        toDiagnosticViews(evaluation.workspace, evaluation.analysisResult.diagnostics),
      );
      const boundedDiff = truncateText(evaluation.diff, LIMITS.maximumDocumentBytes);

      const nextStep = valid
        ? 'Present the diff for review; after explicit user confirmation call spec_stage_apply with this candidateHash.'
        : 'Fix the error-level findings and validate again; spec_stage_apply refuses candidates with errors.';

      const text = [
        `Candidate ${args.stage}.md for "${evaluation.analysis.folder.name}": ` +
          `${valid ? 'VALID' : 'INVALID'} (${evaluation.analysisResult.errorCount} error(s), ${evaluation.analysisResult.warningCount} warning(s)).`,
        `Candidate hash: ${evaluation.candidateHash}`,
        `Current document: ${evaluation.currentExists ? `hash ${evaluation.currentHash}` : '(absent)'}`,
        evaluation.wouldInvalidate.length > 0
          ? `Applying would invalidate approved stage(s): ${evaluation.wouldInvalidate.join(', ')}.`
          : 'Applying invalidates no approvals.',
        `Next: ${nextStep}`,
      ].join('\n');

      return {
        text,
        structured: {
          specName: evaluation.analysis.folder.name,
          stage: args.stage,
          valid,
          candidateHash: evaluation.candidateHash,
          currentHash: evaluation.currentHash,
          currentExists: evaluation.currentExists,
          targetPath: `.kiro/specs/${evaluation.analysis.folder.name}/${args.stage}.md`,
          errorCount: evaluation.analysisResult.errorCount,
          warningCount: evaluation.analysisResult.warningCount,
          diagnostics: capped.items,
          diagnosticsDropped: capped.dropped,
          diff: boundedDiff.text,
          diffTruncated: boundedDiff.truncated,
          wouldInvalidateApprovals: evaluation.wouldInvalidate,
          warnings: evaluation.gateWarnings,
          nextStep,
        },
      };
    },
  });
}
