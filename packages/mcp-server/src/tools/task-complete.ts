import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { completeInteractiveTask } from '@specbridge/execution';
import type { ServerContext } from '../context.js';
import { LIMITS, assertInputSize } from '../limits.js';
import { registerDefinedTool } from './helpers.js';
import {
  changedFileShape,
  interactiveDeps,
  nextActionFor,
  throwBlocked,
  verifierOutcomes,
  verifierOutcomeShape,
} from './interactive-shared.js';

/**
 * task_complete — finalize an interactive run after the current session
 * edited source files.
 *
 * The reported* fields are MODEL CLAIMS and are recorded as claims only.
 * Verification derives exclusively from the actual Git snapshot delta and
 * the trusted configured verification commands; the checkbox is updated
 * surgically and only for verified evidence. Repeated calls on a finalized
 * run return the recorded result without duplicating anything.
 */

const inputSchema = {
  runId: z.string().min(1).max(128).describe('Run id returned by task_begin'),
  summary: z
    .string()
    .min(1)
    .max(LIMITS.maximumShortTextChars)
    .describe('What was implemented (recorded as a claim, never as evidence)'),
  runVerification: z
    .boolean()
    .optional()
    .describe('Override the begin-time verification setting for this completion'),
  reportedChangedFiles: z
    .array(z.string().max(1024))
    .max(500)
    .optional()
    .describe('Files the agent believes it changed (claim only)'),
  reportedTests: z
    .array(
      z.object({
        name: z.string().max(512),
        status: z.enum(['passed', 'failed', 'skipped']),
      }),
    )
    .max(500)
    .optional()
    .describe('Tests the agent reports (claim only)'),
  reportedRisks: z.array(z.string().max(2048)).max(100).optional(),
};

const outputSchema = {
  runId: z.string(),
  outcome: z.enum([
    'verified',
    'implemented-unverified',
    'failed',
    'blocked',
    'no-change',
    'protected-path-violation',
    'repository-diverged',
  ]),
  evidenceStatus: z.string(),
  checkboxUpdated: z.boolean(),
  finalizedNow: z.boolean().describe('False when this call returned an earlier finalization'),
  actualChangedFiles: z.array(changedFileShape),
  verifierOutcomes: z.array(verifierOutcomeShape),
  violations: z.array(z.string()),
  warnings: z.array(z.string()),
  reasons: z.array(z.string()),
  evidencePath: z.string(),
  nextRecommendedAction: z.string(),
};

export function registerTaskCompleteTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'task_complete',
    title: 'Complete interactive task',
    description:
      'Finalize an interactive run: captures the post-run Git snapshot, attributes actual changes, ' +
      'detects protected-path modifications, runs trusted verification commands, evaluates evidence ' +
      'with the v0.3 rules, and updates the task checkbox only for verified evidence. Reported fields ' +
      'are claims, never proof. Idempotent once finalized.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args, extras) =>
      context.withWriteLock(async () => {
        assertInputSize('summary', args.summary, LIMITS.maximumShortTextChars);
        const workspace = context.requireWorkspace();
        const deps = { ...interactiveDeps(context, workspace), signal: extras.signal };
        const outcome = await completeInteractiveTask(deps, {
          runId: args.runId,
          summary: args.summary,
          ...(args.runVerification !== undefined ? { runVerification: args.runVerification } : {}),
          ...(args.reportedChangedFiles !== undefined
            ? { reportedChangedFiles: args.reportedChangedFiles }
            : {}),
          ...(args.reportedTests !== undefined ? { reportedTests: args.reportedTests } : {}),
          ...(args.reportedRisks !== undefined ? { reportedRisks: args.reportedRisks } : {}),
        });
        if (outcome.kind === 'blocked') throwBlocked(outcome);

        const report = outcome.report;
        context.logger.info('interactive_run_completed', {
          runId: report.runId,
          tool: 'task_complete',
          outcome: outcome.outcome,
        });

        const actualChangedFiles = report.changedFiles.filter((file) => file.modifiedDuringRun);
        const nextRecommendedAction = nextActionFor(outcome.outcome, report);

        const text = [
          `Run ${report.runId}: ${outcome.outcome.toUpperCase()} (evidence: ${report.evidenceStatus}).` +
            `${outcome.finalizedNow ? '' : ' [already finalized; returning the recorded result]'}`,
          `Actual changed files (${actualChangedFiles.length}): ${actualChangedFiles.map((f) => f.path).join(', ') || '(none)'}`,
          report.verification.ran
            ? `Verification: ${report.verification.passed ? 'passed' : `FAILED (${report.verification.requiredFailed.join(', ')})`}`
            : 'Verification: not run.',
          `Checkbox updated: ${report.checkboxUpdated ? 'yes (exactly one line)' : 'no'}.`,
          report.violations.length > 0 ? `Violations:\n${report.violations.map((v) => `- ${v}`).join('\n')}` : '',
          `Next: ${nextRecommendedAction}`,
        ]
          .filter((line) => line.length > 0)
          .join('\n');

        return {
          text,
          structured: {
            runId: report.runId,
            outcome: outcome.outcome,
            evidenceStatus: report.evidenceStatus,
            checkboxUpdated: report.checkboxUpdated,
            finalizedNow: outcome.finalizedNow,
            actualChangedFiles,
            verifierOutcomes: verifierOutcomes(report),
            violations: report.violations,
            warnings: report.warnings,
            reasons: report.reasons,
            evidencePath: `.specbridge/evidence/${report.specName}/${report.taskId.replace(/[^A-Za-z0-9._-]+/g, '-')}/${report.runId}.json`,
            nextRecommendedAction,
          },
        };
      }),
  });
}
