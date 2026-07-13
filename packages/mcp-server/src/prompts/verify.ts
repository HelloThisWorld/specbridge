import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { promptResult } from './helpers.js';

export function registerVerifyPrompt(server: McpServer, context: ServerContext): void {
  server.registerPrompt(
    'specbridge-verify',
    {
      title: 'Verify spec drift',
      description:
        'Run the deterministic drift checks and explain the findings without overstating what they prove.',
      argsSchema: {
        specName: z.string().max(120).optional().describe('One spec (omit to verify changed specs)'),
        comparison: z
          .string()
          .max(20)
          .optional()
          .describe('Comparison mode: working-tree (default) | staged | diff'),
        strict: z.string().max(5).optional().describe('"true" for strict policy evaluation'),
      },
    },
    ({ specName, comparison, strict }) =>
      promptResult(
        context,
        'specbridge-verify',
        `Verify ${specName !== undefined && specName.length > 0 ? `spec "${specName}"` : 'changed specs'}`,
        [
          'Verify spec drift with the SpecBridge MCP tools.',
          '',
          `1. Call spec_check_drift${specName !== undefined && specName.length > 0 ? ` with scope "spec" and specName "${specName}"` : ' (default scope: changed specs)'}` +
            `${comparison !== undefined && comparison.length > 0 ? `, comparison "${comparison}"` : ' (default comparison: working-tree)'}` +
            `${strict === 'true' ? ', strict true' : ''}. This runs only the deterministic rules — no commands execute.`,
          '2. Present the findings grouped by severity, always with the stable rule ID and its remediation. Distinguish deterministic findings from heuristic (confidence-labelled) ones.',
          '3. If the findings warrant it, ask the user whether to also run the trusted configured verification commands, then — only after they confirm — call spec_run_verification.',
          '4. Summarize honestly: these checks prove structural and evidence consistency, not full semantic correctness. Never claim complete semantic proof.',
        ].join('\n'),
      ),
  );
}
