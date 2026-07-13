import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listTaskEvidence } from '@specbridge/evidence';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { paginate } from '../limits.js';
import { cursorArg, limitArg, paginationShape, specNameArg } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';

/** task_list — parsed task hierarchy with evidence summaries. */

const taskShape = z.object({
  id: z.string(),
  number: z.string().optional(),
  title: z.string(),
  state: z.enum(['open', 'done', 'in-progress', 'unknown']),
  optional: z.boolean(),
  executableLeaf: z.boolean().describe('True when the task has no children (one unit of implementation)'),
  parentId: z.string().optional(),
  childIds: z.array(z.string()),
  requirementRefs: z.array(z.string()),
  line: z.number().int().describe('1-based line number in tasks.md'),
  evidence: z
    .object({
      attempts: z.number().int(),
      latestStatus: z.string().optional(),
    })
    .describe('Recorded evidence summary for this task'),
});

const outputSchema = {
  specName: z.string(),
  progress: z.object({
    total: z.number().int(),
    completed: z.number().int(),
    inProgress: z.number().int(),
    optionalTotal: z.number().int(),
    optionalCompleted: z.number().int(),
  }),
  tasks: z.array(taskShape),
  pagination: paginationShape,
};

export function registerTaskListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'task_list',
    title: 'List tasks',
    description:
      'Parsed task hierarchy from tasks.md: ids, checkbox states, parent/child structure, requirement ' +
      'references, source lines, and recorded evidence summaries. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { specName: specNameArg, limit: limitArg, cursor: cursorArg },
    outputSchema,
    handler: async (args) => {
      const { workspace, analysis } = context.requireSpecAnalysis(args.specName);
      if (analysis.tasks === undefined) {
        throw new McpToolError('SBMCP007', `Spec "${analysis.folder.name}" has no readable tasks.md.`, {
          remediation: ['Author the tasks stage first (spec_stage_validate + spec_stage_apply).'],
        });
      }
      const model = analysis.tasks;
      const parentOf = new Map<string, string>();
      for (const task of model.allTasks) {
        for (const child of task.children) parentOf.set(child.id, task.id);
      }

      const views = model.allTasks.map((task) => {
        const { records } = listTaskEvidence(workspace, analysis.folder.name, task.id);
        const latest = records[records.length - 1];
        return {
          id: task.id,
          ...(task.number !== undefined ? { number: task.number } : {}),
          title: task.title,
          state: task.state,
          optional: task.optional,
          executableLeaf: task.children.length === 0,
          ...(parentOf.has(task.id) ? { parentId: parentOf.get(task.id) as string } : {}),
          childIds: task.children.map((child) => child.id),
          requirementRefs: [...task.requirementRefs],
          line: task.line + 1,
          evidence: {
            attempts: records.length,
            ...(latest !== undefined ? { latestStatus: latest.status } : {}),
          },
        };
      });

      const page = paginate(views, {
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        token: `task_list:${analysis.folder.name}`,
      });

      const box = (state: string): string =>
        state === 'done' ? '[x]' : state === 'in-progress' ? '[-]' : '[ ]';
      const lines = page.items.map(
        (task) => `- ${box(task.state)} ${task.id} ${task.title}${task.optional ? ' (optional)' : ''}`,
      );
      const progress = model.progress;
      const text =
        `Tasks for "${analysis.folder.name}": ${progress.completed}/${progress.total} required complete.` +
        (lines.length > 0 ? `\n${lines.join('\n')}` : '\n(no tasks parsed)');

      return {
        text,
        structured: {
          specName: analysis.folder.name,
          progress,
          tasks: page.items,
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
