import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listSteeringFiles } from '@specbridge/compat-kiro';
import { trySha256File } from '@specbridge/core';
import type { ServerContext } from '../context.js';
import { diagnosticShape, repoRelative, toDiagnosticViews } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';

/** steering_list — list steering documents with hashes and diagnostics. */

const outputSchema = {
  steering: z.array(
    z.object({
      name: z.string(),
      path: z.string().describe('Repository-relative path'),
      isDefault: z.boolean().describe('True for product.md, tech.md, structure.md'),
      inclusion: z.enum(['always', 'fileMatch', 'manual', 'unknown']),
      fileMatchPattern: z.string().optional(),
      sizeBytes: z.number().int(),
      contentHash: z.string().optional().describe('SHA-256 of the exact file bytes'),
      status: z.enum(['ok', 'warning', 'error']),
      diagnostics: z.array(diagnosticShape),
    }),
  ),
  count: z.number().int(),
};

export function registerSteeringListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'steering_list',
    title: 'List steering documents',
    description:
      'List the .kiro/steering documents (defaults first, then additional files) with sizes, ' +
      'content hashes, inclusion modes, and diagnostics. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {},
    outputSchema,
    handler: async () => {
      const workspace = context.requireWorkspace();
      const steering = listSteeringFiles(workspace).map((info) => {
        const hash = trySha256File(info.path);
        const worst = info.diagnostics.some((d) => d.severity === 'error')
          ? ('error' as const)
          : info.diagnostics.some((d) => d.severity === 'warning')
            ? ('warning' as const)
            : ('ok' as const);
        return {
          name: info.name,
          path: repoRelative(workspace, info.path),
          isDefault: info.isDefault,
          inclusion: info.inclusion,
          ...(info.fileMatchPattern !== undefined ? { fileMatchPattern: info.fileMatchPattern } : {}),
          sizeBytes: info.sizeBytes,
          ...(hash !== undefined ? { contentHash: hash } : {}),
          status: worst,
          diagnostics: toDiagnosticViews(workspace, info.diagnostics),
        };
      });
      const text =
        steering.length === 0
          ? 'No steering documents exist (.kiro/steering is absent or empty). Steering is optional.'
          : `${steering.length} steering document(s): ${steering.map((s) => s.name).join(', ')}.`;
      return { text, structured: { steering, count: steering.length } };
    },
  });
}
