import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_SEARCH_LIMIT, searchTemplates } from '@specbridge/templates';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';
import { catalogFor, entrySummary, filterEntries, templateSourceInput, templateSummaryShape } from './template-shared.js';

/** template_search — deterministic local keyword search (not semantic). */

const inputSchema = {
  query: z.string().min(1).max(200).describe('Keyword query matched against ID, name, description, tags'),
  source: templateSourceInput.optional(),
  kind: z.enum(['feature', 'bugfix']).optional(),
  mode: z.enum(['requirements-first', 'design-first', 'quick']).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
};

const outputSchema = {
  results: z.array(templateSummaryShape.extend({ score: z.number().int() })),
  totalCount: z.number().int(),
};

export function registerTemplateSearchTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'template_search',
    title: 'Search spec templates',
    description:
      'Deterministic local keyword search over template IDs, display names, descriptions, and tags. ' +
      'Ranking: exact ID, ID prefix, exact tag, display-name token, description token. No model, no network.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      const catalog = catalogFor(context, args.source);
      const filtered = { entries: filterEntries(catalog.entries, args), diagnostics: catalog.diagnostics };
      const results = searchTemplates(filtered, args.query, args.limit !== undefined ? { limit: args.limit } : {});
      const summaries = results.map((result) => ({ ...entrySummary(result.entry), score: result.score }));
      const text =
        summaries.length === 0
          ? `No templates match "${args.query}".`
          : summaries.map((result) => `- ${result.ref} (score ${result.score}) — ${result.displayName ?? ''}`).join('\n');
      return { text, structured: { results: summaries, totalCount: summaries.length } };
    },
  });
}
