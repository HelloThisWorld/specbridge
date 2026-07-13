import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { promptResult } from './helpers.js';

export function registerImplementPrompt(server: McpServer, context: ServerContext): void {
  server.registerPrompt(
    'specbridge-implement-task',
    {
      title: 'Implement a task',
      description:
        'Implement one approved task in the current session through the interactive lifecycle: ' +
        'task_begin → edit source → task_complete. Completion is decided by Git evidence and trusted ' +
        'verification, never by claims.',
      argsSchema: {
        specName: z.string().max(120).describe('Spec whose task to implement'),
        taskId: z.string().max(64).optional().describe('Task id (omit for the next executable task)'),
      },
    },
    ({ specName, taskId }) =>
      promptResult(
        context,
        'specbridge-implement-task',
        `Implement ${taskId !== undefined && taskId.length > 0 ? `task ${taskId}` : 'the next task'} of "${specName}"`,
        [
          `Implement one task of the spec "${specName}" in THIS session using the SpecBridge interactive lifecycle.`,
          '',
          `1. Call task_begin with specName "${specName}"${taskId !== undefined && taskId.length > 0 ? ` and taskId "${taskId}"` : ''}.`,
          '2. If task_begin returns an error, explain the exact gate (approvals, dirty tree, active run) and stop.',
          '3. Read the returned context, boundaries, and instructions. Follow the instructions exactly:',
          '   implement only the selected task; never edit .kiro or .specbridge; never change checkboxes; never commit or push.',
          '4. Inspect only the repository files relevant to the task, then make the smallest safe change. Add or update tests where the task requires them.',
          '5. When the source changes are ready, call task_complete with the runId, an honest summary, and the files you believe you changed (these are recorded as claims, not proof).',
          '6. Report the ACTUAL outcome from task_complete: actual changed files, verifier outcomes, evidence status, and whether the checkbox was updated.',
          '7. If the outcome is not "verified", say so plainly and follow nextRecommendedAction. Never claim completion without verified evidence.',
          '8. If you cannot continue, call task_abort with the runId and an honest reason.',
          '',
          'Never launch another agent process or a nested Claude session; you are the implementer.',
        ].join('\n'),
      ),
  );
}
