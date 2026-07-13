import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { abortInteractiveTask } from '@specbridge/execution';
import type { ServerContext } from '../context.js';
import { LIMITS } from '../limits.js';
import { registerDefinedTool } from './helpers.js';
import { interactiveDeps, throwBlocked } from './interactive-shared.js';

/**
 * task_abort — close an active interactive run without touching source
 * changes. Files are never reset, evidence is never deleted, and the task
 * checkbox is never changed. Aborting an already finalized run returns its
 * current status without mutating anything.
 */

const inputSchema = {
  runId: z.string().min(1).max(128).describe('Run id returned by task_begin'),
  reason: z
    .string()
    .min(1)
    .max(LIMITS.maximumShortTextChars)
    .describe('Why the run is being aborted (required, recorded on the run)'),
};

const outputSchema = {
  runId: z.string(),
  status: z.enum(['aborted', 'already-completed', 'already-aborted']),
  reason: z.string().optional(),
  remainingChangedPaths: z
    .array(z.string())
    .describe('Working-tree paths still changed relative to the run baseline (never reset)'),
  lockReleased: z.boolean(),
  nextRecommendedAction: z.string(),
};

export function registerTaskAbortTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'task_abort',
    title: 'Abort interactive task',
    description:
      'Abort an active interactive run: records the reason, releases the execution lock, and reports ' +
      'the working-tree changes that remain. Never resets files, never deletes evidence, never touches ' +
      'checkboxes. Idempotent on finalized runs.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const outcome = await abortInteractiveTask(interactiveDeps(context, workspace), {
          runId: args.runId,
          reason: args.reason,
        });
        if (outcome.kind === 'blocked') throwBlocked(outcome);

        if (outcome.kind === 'already-final') {
          const status =
            outcome.lifecycleStatus === 'COMPLETED'
              ? ('already-completed' as const)
              : ('already-aborted' as const);
          const next =
            status === 'already-completed'
              ? 'The run already finalized; inspect it with run_read. Nothing was changed.'
              : 'The run was already aborted; nothing was changed. Start fresh with task_begin.';
          return {
            text: `Run ${outcome.runId} is ${status.replace('-', ' ')}${outcome.outcome !== undefined ? ` (outcome: ${outcome.outcome})` : ''}. Nothing was mutated.`,
            structured: {
              runId: outcome.runId,
              status,
              remainingChangedPaths: [],
              lockReleased: false,
              nextRecommendedAction: next,
            },
          };
        }

        context.logger.info('interactive_run_aborted', {
          runId: outcome.runId,
          tool: 'task_abort',
        });
        const next =
          outcome.remainingChangedPaths.length > 0
            ? `${outcome.remainingChangedPaths.length} working-tree change(s) remain — review, keep, or revert them manually; SpecBridge never resets files.`
            : 'The working tree matches the run baseline. Start fresh with task_begin when ready.';
        return {
          text: [
            `Run ${outcome.runId} aborted: ${outcome.reason}`,
            `Remaining changed paths: ${outcome.remainingChangedPaths.join(', ') || '(none)'}`,
            next,
          ].join('\n'),
          structured: {
            runId: outcome.runId,
            status: 'aborted' as const,
            reason: outcome.reason,
            remainingChangedPaths: outcome.remainingChangedPaths,
            lockReleased: outcome.lockReleased,
            nextRecommendedAction: next,
          },
        };
      }),
  });
}
