import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { selectTask } from '@specbridge/execution';
import { evaluateWorkflow } from '@specbridge/workflow';
import type { ServerContext } from '../context.js';
import { specNameArg } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';

/**
 * task_next — the next deterministic executable leaf task (never starts
 * execution). Blockers are reported as a structured result, not an error,
 * so clients can present them.
 */

const outputSchema = {
  specName: z.string(),
  executable: z.boolean(),
  task: z
    .object({
      id: z.string(),
      number: z.string().optional(),
      title: z.string(),
      state: z.string(),
      requirementRefs: z.array(z.string()),
      line: z.number().int().describe('1-based line number in tasks.md'),
    })
    .optional(),
  blockers: z.array(z.string()),
};

export function registerTaskNextTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'task_next',
    title: 'Next executable task',
    description:
      'Return the next deterministic executable leaf task (first open required leaf in document order), ' +
      'or the exact blockers when none is executable. Never starts execution. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { specName: specNameArg },
    outputSchema,
    handler: async (args) => {
      const { workspace, analysis } = context.requireSpecAnalysis(args.specName);
      const blockers: string[] = [];

      if (analysis.state === undefined) {
        blockers.push(
          'The spec is unmanaged (no SpecBridge workflow state); approve a stage first to initialize it.',
        );
      } else {
        const evaluation = evaluateWorkflow(workspace, analysis.state);
        if (evaluation.health === 'stale') {
          blockers.push(
            `Approved stage(s) changed after approval: ${[...evaluation.staleStages, ...evaluation.invalidatedStages].join(', ')}. Re-approve them first.`,
          );
        } else if (evaluation.effectiveStatus !== 'READY_FOR_IMPLEMENTATION') {
          const unapproved = evaluation.stages
            .filter((stage) => stage.effective !== 'approved')
            .map((stage) => stage.stage);
          blockers.push(`Not every stage is approved yet (missing: ${unapproved.join(', ')}).`);
        }
      }

      if (analysis.tasks === undefined || analysis.documents.tasks === undefined) {
        blockers.push('tasks.md is missing or unreadable.');
      }

      if (blockers.length === 0 && analysis.tasks !== undefined && analysis.documents.tasks !== undefined) {
        const selection = selectTask(analysis.tasks, analysis.documents.tasks, { next: true });
        if (selection.ok) {
          const task = selection.task;
          return {
            text: `Next executable task in "${analysis.folder.name}": ${task.id} — ${task.title}.`,
            structured: {
              specName: analysis.folder.name,
              executable: true,
              task: {
                id: task.id,
                ...(task.number !== undefined ? { number: task.number } : {}),
                title: task.title,
                state: task.state,
                requirementRefs: task.requirementRefs,
                line: task.line + 1,
              },
              blockers: [],
            },
          };
        }
        blockers.push(selection.message);
      }

      return {
        text: `No executable task in "${analysis.folder.name}":\n${blockers.map((blocker) => `- ${blocker}`).join('\n')}`,
        structured: { specName: analysis.folder.name, executable: false, blockers },
      };
    },
  });
}
