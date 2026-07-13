import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sha256File } from '@specbridge/core';
import {
  RUN_RECORD_SCHEMA_VERSION,
  appendRunEvent,
  createRun,
  invalidateDependentApprovals,
  writeRunArtifact,
  writeStageDocument,
} from '@specbridge/execution';
import { evaluateWorkflow } from '@specbridge/workflow';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { LIMITS, capDiagnostics } from '../limits.js';
import { diagnosticShape, repoRelative, specNameArg, stageArg, toDiagnosticViews } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';
import { assertCurrentHash, evaluateStageCandidate } from './stage-shared.js';

/**
 * spec_stage_apply — atomically apply a previously reviewed candidate.
 *
 * Hash-bound: the current document hash and the candidate hash must both
 * match what spec_stage_validate reported, so neither the on-disk document
 * nor the candidate can be substituted between review and apply. There is
 * deliberately no force option; every refusal explains its remediation.
 * Nothing here approves anything — the stage stays draft.
 */

const inputSchema = {
  specName: specNameArg,
  stage: stageArg,
  candidateMarkdown: z
    .string()
    .max(LIMITS.maximumCandidateBytes)
    .describe('The exact reviewed candidate content'),
  expectedCurrentHash: z
    .string()
    .nullable()
    .describe('SHA-256 of the current document bytes from spec_stage_validate (null = file must be absent)'),
  expectedCandidateHash: z
    .string()
    .describe('candidateHash returned by spec_stage_validate for the reviewed candidate'),
  acknowledgement: z
    .literal('apply-reviewed-candidate')
    .describe('Literal confirmation that a human reviewed the validated candidate'),
};

const outputSchema = {
  applied: z.literal(true),
  specName: z.string(),
  stage: stageArg,
  filePath: z.string(),
  created: z.boolean(),
  oldHash: z.string().nullable(),
  newHash: z.string(),
  invalidatedApprovals: z.array(z.string()),
  workflowStatus: z.string(),
  runId: z.string().describe('Append-only interactive-authoring run id'),
  diagnostics: z.array(diagnosticShape),
  stageRemainsUnapproved: z.literal(true),
  nextStep: z.string(),
};

export function registerSpecStageApplyTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_stage_apply',
    title: 'Apply a reviewed stage candidate',
    description:
      'Atomically write a previously validated stage candidate into .kiro, bound to the exact reviewed ' +
      'hashes (current document + candidate). Refuses analysis errors, hash mismatches, and approved ' +
      'stages. Invalidates dependent approvals per workflow rules and records an append-only authoring ' +
      'run. The stage remains unapproved; approval stays a human CLI action.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) =>
      context.withWriteLock(async () => {
        // Re-evaluate everything inside the write lock: gate, current hash,
        // candidate hash, and deterministic analysis.
        const evaluation = evaluateStageCandidate(context, {
          specName: args.specName,
          stage: args.stage,
          candidateMarkdown: args.candidateMarkdown,
        });
        assertCurrentHash(evaluation, args.expectedCurrentHash);

        if (evaluation.candidateHash !== args.expectedCandidateHash) {
          throw new McpToolError(
            'SBMCP002',
            `The supplied candidate does not match expectedCandidateHash (expected ${args.expectedCandidateHash}, ` +
              `computed ${evaluation.candidateHash}). Apply exactly the candidate that was validated and reviewed.`,
            { remediation: ['Re-run spec_stage_validate and review the new candidate.'] },
          );
        }
        if (evaluation.analysisResult.hasErrors) {
          throw new McpToolError(
            'SBMCP016',
            `The candidate has ${evaluation.analysisResult.errorCount} analysis error(s) and cannot be applied.`,
            { remediation: ['Fix the findings reported by spec_stage_validate and validate again.'] },
          );
        }

        const workspace = evaluation.workspace;
        const specName = evaluation.analysis.folder.name;
        const clock = context.clock;

        const written = writeStageDocument(workspace, specName, args.stage, evaluation.normalizedCandidate);
        const newHash = sha256File(written.filePath);
        const invalidation = invalidateDependentApprovals(
          workspace,
          evaluation.state,
          args.stage,
          clock,
        );

        // Append-only authoring run record (host: mcp). No conversation
        // content and no model identity are stored — only the artifacts.
        const runId = context.idFactory();
        const appliedAt = clock().toISOString();
        createRun(workspace, {
          schemaVersion: RUN_RECORD_SCHEMA_VERSION,
          runId,
          kind: 'interactive-authoring',
          specName,
          stage: args.stage,
          runner: 'interactive',
          createdAt: appliedAt,
          finishedAt: appliedAt,
          outcome: 'completed',
          applied: true,
          resumeSupported: false,
          warnings: evaluation.gateWarnings,
          host: 'mcp',
        });
        writeRunArtifact(workspace, runId, `candidate-${args.stage}.md`, evaluation.normalizedCandidate);
        if (evaluation.diff.length > 0) {
          writeRunArtifact(workspace, runId, `candidate-${args.stage}.diff`, evaluation.diff);
        }
        writeRunArtifact(
          workspace,
          runId,
          'candidate-analysis.json',
          `${JSON.stringify(
            {
              errorCount: evaluation.analysisResult.errorCount,
              warningCount: evaluation.analysisResult.warningCount,
              diagnostics: evaluation.analysisResult.diagnostics,
            },
            null,
            2,
          )}\n`,
        );
        writeRunArtifact(
          workspace,
          runId,
          'authoring.json',
          `${JSON.stringify(
            {
              specName,
              stage: args.stage,
              oldHash: evaluation.currentHash,
              newHash,
              appliedAt,
              invalidatedApprovals: invalidation.invalidated,
              host: 'mcp',
            },
            null,
            2,
          )}\n`,
        );
        appendRunEvent(workspace, runId, {
          at: appliedAt,
          type: 'stage-written',
          stage: args.stage,
          invalidated: invalidation.invalidated,
        });

        const statusNow = evaluateWorkflow(workspace, invalidation.state).effectiveStatus;
        const capped = capDiagnostics(
          toDiagnosticViews(workspace, evaluation.analysisResult.diagnostics),
        );
        const nextStep =
          `The ${args.stage} stage is written but NOT approved. A human approves it with: ` +
          `specbridge spec approve ${specName} --stage ${args.stage}`;

        const text = [
          `Applied ${args.stage}.md for "${specName}" (${written.created ? 'created' : 'updated'}, ${written.eol.toUpperCase()} preserved).`,
          invalidation.invalidated.length > 0
            ? `Invalidated dependent approval(s): ${invalidation.invalidated.join(', ')}.`
            : 'No dependent approvals were invalidated.',
          `Authoring run: ${runId}.`,
          nextStep,
        ].join('\n');

        return {
          text,
          structured: {
            applied: true as const,
            specName,
            stage: args.stage,
            filePath: repoRelative(workspace, written.filePath),
            created: written.created,
            oldHash: evaluation.currentHash,
            newHash,
            invalidatedApprovals: invalidation.invalidated,
            workflowStatus: statusNow,
            runId,
            diagnostics: capped.items,
            stageRemainsUnapproved: true as const,
            nextStep,
          },
        };
      }),
  });
}
