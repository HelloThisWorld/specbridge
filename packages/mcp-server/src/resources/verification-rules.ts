import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { builtInVerificationRules } from '@specbridge/drift';
import type { ServerContext } from '../context.js';
import { jsonContents } from './helpers.js';

/** specbridge://verification/rules — the stable SBV rule registry as JSON. */

export function registerVerificationRulesResource(server: McpServer, context: ServerContext): void {
  server.registerResource(
    'verification-rules',
    'specbridge://verification/rules',
    {
      title: 'Verification rules',
      description: 'The deterministic drift verification rule registry (stable SBV rule IDs).',
      mimeType: 'application/json',
    },
    async (uri) =>
      jsonContents(context, uri.href, {
        rules: builtInVerificationRules().map((rule) => ({
          id: rule.id,
          title: rule.title,
          category: rule.category,
          scope: rule.scope,
          confidence: rule.confidence,
          defaultSeverity: rule.defaultSeverity,
        })),
      }),
  );
}
