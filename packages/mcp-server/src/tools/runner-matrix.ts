import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { renderRunnerMatrixMarkdown, runnerMatrixRows } from '@specbridge/runners';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';
import { loadRunnerToolContext } from './runner-shared.js';

/**
 * runner_matrix — the authoritative capability matrix, generated from
 * registered runner metadata by the SAME shared implementation the CLI
 * uses (`specbridge runner matrix`). Pure configuration: no probes, no
 * processes, no network.
 */

const matrixRowShape = z.object({
  profile: z.string(),
  implementation: z.string(),
  category: z.string(),
  support: z.string(),
  enabled: z.boolean(),
  author: z.boolean(),
  refine: z.boolean(),
  execute: z.boolean(),
  resume: z.boolean(),
  local: z.boolean(),
});

const outputSchema = {
  rows: z.array(matrixRowShape),
  markdown: z.string().describe('The same matrix as a Markdown table'),
};

export function registerRunnerMatrixTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'runner_matrix',
    title: 'Runner capability matrix',
    description:
      'The authoritative runner capability matrix (author/refine/execute/resume per profile), ' +
      'generated from registered runner metadata — identical to "specbridge runner matrix". ' +
      'Read-only; no probes, no processes, no network.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {},
    outputSchema,
    handler: async () => {
      const { registry } = loadRunnerToolContext(context);
      const rows = runnerMatrixRows(registry.listProfiles());
      const markdown = renderRunnerMatrixMarkdown(rows);
      return {
        text: markdown,
        structured: { rows, markdown },
      };
    },
  });
}
