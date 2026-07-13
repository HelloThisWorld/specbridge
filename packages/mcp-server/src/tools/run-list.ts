import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listRuns } from '@specbridge/execution';
import type { ServerContext } from '../context.js';
import { paginate } from '../limits.js';
import { cursorArg, limitArg, paginationShape } from '../schemas/common.js';
import { runSummaryShape, toRunSummary } from '../schemas/run-views.js';
import { registerDefinedTool } from './helpers.js';

/** run_list — bounded run summaries (newest first), no prompts or logs. */

const inputSchema = {
  specName: z.string().max(120).optional().describe('Only runs for this spec'),
  taskId: z.string().max(64).optional().describe('Only runs for this task id'),
  status: z
    .string()
    .max(64)
    .optional()
    .describe('Only runs whose evidence status, outcome, or lifecycle status equals this value'),
  limit: limitArg,
  cursor: cursorArg,
};

const outputSchema = {
  runs: z.array(runSummaryShape),
  pagination: paginationShape,
};

export function registerRunListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'run_list',
    title: 'List runs',
    description:
      'List recorded runs (newest first) with kind, run type, lifecycle, outcome, and evidence status. ' +
      'Bounded summaries only — never raw prompts or logs. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const { runs } = listRuns(workspace);
      const filtered = runs
        .map(toRunSummary)
        .filter((run) => {
          if (args.specName !== undefined && run.specName !== args.specName) return false;
          if (args.taskId !== undefined && run.taskId !== args.taskId) return false;
          if (
            args.status !== undefined &&
            run.evidenceStatus !== args.status &&
            run.outcome !== args.status &&
            run.lifecycleStatus !== args.status
          ) {
            return false;
          }
          return true;
        });

      const page = paginate(filtered, {
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        token: 'run_list',
      });

      const lines = page.items.map(
        (run) =>
          `- ${run.runId.slice(0, 12)} ${run.runType} ${run.specName}${run.taskId !== undefined ? `#${run.taskId}` : ''} ` +
          `→ ${run.evidenceStatus ?? run.lifecycleStatus ?? run.outcome ?? '(in progress)'}`,
      );
      const text =
        page.totalCount === 0
          ? 'No recorded runs match.'
          : `${page.totalCount} run(s)${page.truncated ? ` (showing ${page.items.length})` : ''}:\n${lines.join('\n')}`;

      return {
        text,
        structured: {
          runs: page.items,
          pagination: {
            totalCount: page.totalCount,
            truncated: page.truncated,
            ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
          },
        },
      };
    },
  });
}
