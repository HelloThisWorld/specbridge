import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { buildWorkspaceDetection } from '../schemas/workspace-view.js';
import { jsonContents } from './helpers.js';

/** specbridge://workspace — the workspace detection summary as JSON. */

export function registerWorkspaceResource(server: McpServer, context: ServerContext): void {
  server.registerResource(
    'workspace',
    'specbridge://workspace',
    {
      title: 'SpecBridge workspace',
      description: 'Workspace detection summary: .kiro, steering/spec counts, sidecar, Git.',
      mimeType: 'application/json',
    },
    async (uri) => jsonContents(context, uri.href, await buildWorkspaceDetection(context)),
  );
}
