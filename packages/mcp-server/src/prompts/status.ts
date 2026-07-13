import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { promptResult } from './helpers.js';

export function registerStatusPrompt(server: McpServer, context: ServerContext): void {
  server.registerPrompt(
    'specbridge-status',
    {
      title: 'SpecBridge status',
      description: 'Inspect the workspace or one spec and explain the next valid workflow step.',
      argsSchema: {
        specName: z.string().max(120).optional().describe('Spec to inspect (omit for the workspace overview)'),
      },
    },
    ({ specName }) => {
      const target =
        specName !== undefined && specName.length > 0
          ? `the spec "${specName}"`
          : 'this workspace';
      const steps =
        specName !== undefined && specName.length > 0
          ? [
              `1. Call the spec_status tool with specName "${specName}".`,
              '2. Report the workflow status, each stage with its effective approval state, and task progress.',
              '3. If approvals are stale, explain exactly which stage changed after approval and that a human must re-approve it via the SpecBridge CLI — never work around a stale approval.',
              '4. State the single next valid workflow step from suggestedNextActions.',
            ]
          : [
              '1. Call the workspace_detect tool.',
              '2. Call the spec_list tool.',
              '3. Summarize: workspace health, spec count, and per-spec status/approval health.',
              '4. Recommend the single most useful next step (inspect a spec, create one, or fix a reported problem).',
            ];
      return promptResult(
        context,
        'specbridge-status',
        `Status of ${target}`,
        [
          `Inspect ${target} with the SpecBridge MCP tools and explain where the workflow stands.`,
          '',
          ...steps,
          '',
          'Ground every statement in tool output. Approval state comes only from spec_status — never infer approval from file existence.',
        ].join('\n'),
      );
    },
  );
}
