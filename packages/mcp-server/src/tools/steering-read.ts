import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadSteeringDocument, resolveSteeringName } from '@specbridge/compat-kiro';
import { isSpecBridgeError, trySha256File } from '@specbridge/core';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { LIMITS, truncateText } from '../limits.js';
import { repoRelative } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';

/**
 * steering_read — read one steering document by NAME.
 *
 * Only names resolvable inside .kiro/steering are accepted; the tool never
 * reads an arbitrary path.
 */

const inputSchema = {
  name: z
    .string()
    .min(1)
    .max(255)
    .describe('Steering document name, e.g. "product" or "product.md" (never a path)'),
};

const outputSchema = {
  name: z.string(),
  path: z.string().describe('Repository-relative path'),
  contentType: z.literal('text/markdown'),
  content: z.string(),
  truncated: z.boolean(),
  sizeBytes: z.number().int(),
  contentHash: z.string().optional().describe('SHA-256 of the exact file bytes'),
  inclusion: z.enum(['always', 'fileMatch', 'manual', 'unknown']),
  fileMatchPattern: z.string().optional(),
  isDefault: z.boolean(),
  hasFrontMatter: z.boolean(),
};

export function registerSteeringReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'steering_read',
    title: 'Read a steering document',
    description:
      'Read one steering document by name (front matter excluded from the returned body). ' +
      'Names only — arbitrary filesystem paths are rejected. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      if (args.name.includes('/') || args.name.includes('\\') || args.name.includes('\0')) {
        throw new McpToolError('SBMCP002', 'steering_read accepts a steering NAME, not a path.', {
          remediation: ['List valid names with the steering_list tool.'],
        });
      }
      const workspace = context.requireWorkspace();
      const info = resolveSteeringName(workspace, args.name);
      if (info === undefined) {
        throw new McpToolError('SBMCP002', `Steering document "${args.name}" was not found.`, {
          remediation: ['List valid names with the steering_list tool.'],
        });
      }
      let body: string;
      try {
        body = loadSteeringDocument(workspace, info.name).body;
      } catch (cause) {
        if (isSpecBridgeError(cause)) {
          throw new McpToolError('SBMCP002', cause.message);
        }
        throw cause;
      }
      const bounded = truncateText(body, LIMITS.maximumDocumentBytes);
      const hash = trySha256File(info.path);
      return {
        text: bounded.truncated
          ? `${info.fileName} (truncated to ${LIMITS.maximumDocumentBytes} bytes)\n\n${bounded.text}`
          : `${info.fileName}\n\n${bounded.text}`,
        structured: {
          name: info.name,
          path: repoRelative(workspace, info.path),
          contentType: 'text/markdown' as const,
          content: bounded.text,
          truncated: bounded.truncated,
          sizeBytes: info.sizeBytes,
          ...(hash !== undefined ? { contentHash: hash } : {}),
          inclusion: info.inclusion,
          ...(info.fileMatchPattern !== undefined ? { fileMatchPattern: info.fileMatchPattern } : {}),
          isDefault: info.isDefault,
          hasFrontMatter: info.hasFrontMatter,
        },
      };
    },
  });
}
