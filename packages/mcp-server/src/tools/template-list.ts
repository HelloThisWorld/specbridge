import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { clampListLimit, paginate } from '../limits.js';
import { registerDefinedTool } from './helpers.js';
import { catalogFor, entrySummary, filterEntries, templateSourceInput, templateSummaryShape } from './template-shared.js';

/** template_list — read-only, bounded, deterministic template discovery. */

const inputSchema = {
  source: templateSourceInput.optional().describe('Restrict to one source (default all)'),
  kind: z.enum(['feature', 'bugfix']).optional(),
  mode: z.enum(['requirements-first', 'design-first', 'quick']).optional(),
  tag: z.string().max(32).optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().optional(),
};

const outputSchema = {
  templates: z.array(templateSummaryShape),
  totalCount: z.number().int(),
  nextCursor: z.string().nullable(),
};

export function registerTemplateListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'template_list',
    title: 'List spec templates',
    description:
      'List built-in and project-local spec templates with metadata and validation status. ' +
      'Deterministic and offline: no registry, no network, no model.',
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
      const filtered = filterEntries(catalog.entries, args);
      const page = paginate(filtered.map(entrySummary), {
        limit: clampListLimit(args.limit),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        token: 'template-list',
      });
      const text =
        page.items.length === 0
          ? 'No templates match the given filters.'
          : page.items
              .map((template) => `- ${template.ref} v${template.version ?? '?'} — ${template.displayName ?? '(invalid)'}`)
              .join('\n');
      return {
        text,
        structured: {
          templates: page.items,
          totalCount: filtered.length,
          nextCursor: page.nextCursor ?? null,
        },
      };
    },
  });
}
