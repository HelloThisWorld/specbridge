import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { diagnosticShape } from '../schemas/common.js';
import { buildWorkspaceDetection, workspaceDetectionText } from '../schemas/workspace-view.js';
import { registerDefinedTool } from './helpers.js';

/**
 * workspace_detect — read-only workspace detection.
 *
 * A missing `.kiro` directory is a normal detection result here (found:
 * false with guidance), not an error: this is the tool hosts call first to
 * find out whether SpecBridge applies to the current project at all.
 */

const outputSchema = {
  found: z.boolean().describe('True when a .kiro workspace was found'),
  projectRoot: z.string().describe('The project root this server process serves (display only)'),
  workspaceRoot: z
    .string()
    .optional()
    .describe('Directory containing .kiro ("." when identical to the project root)'),
  kiroPresent: z.boolean(),
  steeringCount: z.number().int(),
  specCount: z.number().int(),
  sidecarPresent: z.boolean().describe('True when .specbridge exists'),
  configStatus: z.enum(['absent-defaults', 'valid', 'invalid']),
  git: z.object({
    repository: z.boolean(),
    clean: z.boolean().optional(),
    branch: z.string().optional(),
    head: z.string().optional(),
    dirtyPaths: z.number().int().optional(),
  }),
  diagnostics: z.array(diagnosticShape),
  suggestedNextSteps: z.array(z.string()),
};

export function registerWorkspaceDetectTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'workspace_detect',
    title: 'Detect SpecBridge workspace',
    description:
      'Detect the Kiro-compatible workspace for this project: .kiro presence, steering and spec counts, ' +
      '.specbridge sidecar and configuration status, and a Git summary. Read-only; changes nothing.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {},
    outputSchema,
    handler: async () => {
      const detection = await buildWorkspaceDetection(context);
      return { text: workspaceDetectionText(detection), structured: detection };
    },
  });
}
