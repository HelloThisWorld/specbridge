import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { beginInteractiveTask } from '@specbridge/execution';
import type { ServerContext } from '../context.js';
import { LIMITS, truncateText } from '../limits.js';
import { specNameArg } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';
import { interactiveDeps, throwBlocked } from './interactive-shared.js';

/**
 * task_begin — start an interactive task implementation run.
 *
 * The CURRENT host agent session implements the task; no nested agent
 * process is ever spawned and no model is invoked here. This tool acquires
 * the repository-local execution lock, captures the pre-run Git snapshot,
 * records the run (AWAITING_AGENT_CHANGES), and returns bounded approved
 * context plus explicit instructions.
 */

const inputSchema = {
  specName: specNameArg,
  taskId: z
    .string()
    .max(64)
    .optional()
    .describe('Task to implement (default: next deterministic executable leaf task)'),
  allowDirty: z
    .boolean()
    .optional()
    .describe('Allow starting on a dirty tree; pre-existing changes are baselined (default false)'),
  runVerificationOnComplete: z
    .boolean()
    .optional()
    .describe('Run trusted verification commands during task_complete (default true)'),
};

const outputSchema = {
  runId: z.string(),
  specName: z.string(),
  task: z.object({
    id: z.string(),
    number: z.string().optional(),
    title: z.string(),
    state: z.string(),
    requirementRefs: z.array(z.string()),
    line: z.number().int().describe('1-based line number in tasks.md'),
  }),
  context: z.string().describe('Bounded approved spec context (steering + documents + task plan)'),
  contextTruncated: z.boolean(),
  boundaries: z.array(z.string()),
  protectedPaths: z.array(z.string()),
  verificationCommands: z.array(
    z.object({ name: z.string(), argv: z.array(z.string()), required: z.boolean() }),
  ),
  instructions: z.array(z.string()),
  allowDirty: z.boolean(),
  runVerificationOnComplete: z.boolean(),
  warnings: z.array(z.string()),
};

export function registerTaskBeginTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'task_begin',
    title: 'Begin interactive task',
    description:
      'Begin an interactive task implementation run: validates approvals and the working tree, ' +
      'acquires the repository lock, snapshots Git state, and returns the approved context, ' +
      'boundaries, and instructions for the CURRENT agent session to implement the task. ' +
      'Modifies no source files and invokes no model. Finish with task_complete or task_abort.',
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
        const workspace = context.requireWorkspace();
        const outcome = await beginInteractiveTask(interactiveDeps(context, workspace), {
          specName: args.specName,
          ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
          ...(args.allowDirty !== undefined ? { allowDirty: args.allowDirty } : {}),
          ...(args.runVerificationOnComplete !== undefined
            ? { runVerificationOnComplete: args.runVerificationOnComplete }
            : {}),
        });
        if (outcome.kind === 'blocked') throwBlocked(outcome);

        context.logger.info('interactive_run_started', {
          runId: outcome.runId,
          tool: 'task_begin',
        });

        const boundedContext = truncateText(outcome.contextMarkdown, LIMITS.maximumDocumentBytes);
        const task = outcome.task;
        const text = [
          `Interactive run ${outcome.runId} started for "${outcome.specName}", task ${task.id}: ${task.title}.`,
          '',
          'Instructions:',
          ...outcome.instructions.map((instruction) => `- ${instruction}`),
          '',
          `Verification on complete: ${outcome.runVerificationOnComplete ? outcome.verificationCommands.map((c) => c.name).join(', ') || '(none configured)' : 'disabled'}.`,
          `When the source changes are ready, call task_complete with runId "${outcome.runId}".`,
        ].join('\n');

        return {
          text,
          structured: {
            runId: outcome.runId,
            specName: outcome.specName,
            task: {
              id: task.id,
              ...(task.number !== undefined ? { number: task.number } : {}),
              title: task.title,
              state: task.state,
              requirementRefs: task.requirementRefs,
              line: task.line + 1,
            },
            context: boundedContext.text,
            contextTruncated: boundedContext.truncated,
            boundaries: outcome.boundaries,
            protectedPaths: outcome.protectedPaths,
            verificationCommands: outcome.verificationCommands,
            instructions: outcome.instructions,
            allowDirty: outcome.allowDirty,
            runVerificationOnComplete: outcome.runVerificationOnComplete,
            warnings: outcome.warnings,
          },
        };
      }),
  });
}
