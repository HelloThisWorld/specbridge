import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listSteeringFiles, loadSteeringDocument, resolveSteeringName } from '@specbridge/compat-kiro';
import type { ServerContext } from '../context.js';
import { assertPlainName, markdownContents, resourceNotFound } from './helpers.js';

/** specbridge://steering/{name} — one steering document body (Markdown). */

export function registerSteeringResources(server: McpServer, context: ServerContext): void {
  server.registerResource(
    'steering',
    new ResourceTemplate('specbridge://steering/{name}', {
      list: () => {
        const workspace = context.tryWorkspace();
        if (workspace === undefined) return { resources: [] };
        return {
          resources: listSteeringFiles(workspace).map((info) => ({
            uri: `specbridge://steering/${encodeURIComponent(info.name)}`,
            name: info.name,
            description: `Steering document ${info.fileName} (inclusion: ${info.inclusion})`,
            mimeType: 'text/markdown',
          })),
        };
      },
    }),
    {
      title: 'Steering document',
      description: 'One .kiro/steering document by name (front matter excluded).',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const name = assertPlainName('steering name', String(variables['name'] ?? ''));
      const workspace = context.requireWorkspace();
      const info = resolveSteeringName(workspace, name);
      if (info === undefined) {
        throw resourceNotFound(
          `Steering document "${name}"`,
          'List available names with the steering_list tool.',
        );
      }
      const document = loadSteeringDocument(workspace, info.name);
      return markdownContents(context, uri.href, document.body);
    },
  );
}
