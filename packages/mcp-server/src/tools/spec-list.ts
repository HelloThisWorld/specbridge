import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyzeSpec, discoverSpecs } from '@specbridge/compat-kiro';
import type { ServerContext } from '../context.js';
import { paginate } from '../limits.js';
import { cursorArg, limitArg, paginationShape } from '../schemas/common.js';
import { evaluateSpecBundle, specSummaryShape, toSpecSummary } from '../schemas/spec-views.js';
import { registerDefinedTool } from './helpers.js';

/** spec_list — paginated spec summaries with deterministic filters. */

const inputSchema = {
  type: z.enum(['feature', 'bugfix']).optional().describe('Only specs of this type'),
  status: z.string().max(64).optional().describe('Only specs whose workflow status equals this value'),
  staleApprovalsOnly: z.boolean().optional().describe('Only specs with stale approvals'),
  incompleteTasksOnly: z.boolean().optional().describe('Only specs with open required tasks'),
  limit: limitArg,
  cursor: cursorArg,
};

const outputSchema = {
  specs: z.array(specSummaryShape),
  pagination: paginationShape,
};

export function registerSpecListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_list',
    title: 'List specs',
    description:
      'List specs under .kiro/specs with type, workflow mode and status, approval health, ' +
      'task progress, and diagnostic counts. Supports filters and pagination. Read-only.',
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
      const summaries = discoverSpecs(workspace)
        .map((folder) => toSpecSummary(evaluateSpecBundle(workspace, analyzeSpec(workspace, folder))))
        .filter((summary) => {
          if (args.type !== undefined && summary.type !== args.type) return false;
          if (args.status !== undefined && summary.workflowStatus !== args.status) return false;
          if (args.staleApprovalsOnly === true && summary.approvalHealth !== 'stale') return false;
          if (
            args.incompleteTasksOnly === true &&
            summary.taskProgress.completed >= summary.taskProgress.total
          ) {
            return false;
          }
          return true;
        });

      const page = paginate(summaries, {
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        token: 'spec_list',
      });

      const lines = page.items.map(
        (spec) =>
          `- ${spec.name} [${spec.type}/${spec.workflowMode}] ${spec.workflowStatus}, approvals ${spec.approvalHealth}, ` +
          `tasks ${spec.taskProgress.completed}/${spec.taskProgress.total}`,
      );
      const text =
        page.totalCount === 0
          ? 'No specs match. This workspace may have no specs yet; create one with spec_create.'
          : `${page.totalCount} spec(s)${page.truncated ? ` (showing ${page.items.length})` : ''}:\n${lines.join('\n')}`;

      return {
        text,
        structured: {
          specs: page.items,
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
