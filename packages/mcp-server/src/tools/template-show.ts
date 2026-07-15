import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveTemplate } from '@specbridge/templates';
import type { ServerContext } from '../context.js';
import { LIMITS, truncateText } from '../limits.js';
import { registerDefinedTool } from './helpers.js';
import { catalogFor, entrySummary, templateSummaryShape } from './template-shared.js';

/**
 * template_show — read-only template detail: manifest metadata, variables,
 * files, README, and validation issues. Exposes qualified references only,
 * never filesystem paths.
 */

const inputSchema = {
  reference: z
    .string()
    .min(1)
    .max(150)
    .describe('Template reference: rest-api, builtin:rest-api, or project:my-template'),
};

const variableShape = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(['string', 'boolean', 'integer', 'enum']),
  required: z.boolean(),
  default: z.union([z.string(), z.boolean(), z.number()]).nullable(),
  values: z.array(z.string()).nullable(),
});

const outputSchema = {
  template: templateSummaryShape,
  license: z.string().nullable(),
  compatibility: z.object({ specbridge: z.string(), kiroLayout: z.string() }).nullable(),
  variables: z.array(variableShape),
  files: z.array(z.object({ target: z.string(), stage: z.string() })),
  builtinVariables: z.array(z.string()),
  examples: z.array(z.string()),
  readme: z.string().nullable().describe('Template README (truncated if large)'),
  issues: z.array(z.object({ code: z.string(), category: z.string(), severity: z.string(), message: z.string() })),
};

export function registerTemplateShowTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'template_show',
    title: 'Show one spec template',
    description:
      'Show a template in depth: metadata, declared variables, target files, README, and validation ' +
      'status. Read-only. Ambiguous unqualified references fail with the qualified candidates.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      const catalog = catalogFor(context);
      const entry = resolveTemplate(catalog, args.reference);
      const manifest = entry.pack.manifest;
      const summary = entrySummary(entry);
      const readme = entry.pack.readme !== undefined ? truncateText(entry.pack.readme, LIMITS.maximumShortTextChars) : undefined;

      const text = [
        `${entry.ref} — ${manifest?.displayName ?? '(invalid template)'} v${manifest?.version ?? '?'}`,
        manifest?.description ?? '',
        manifest !== undefined
          ? `Variables: ${manifest.variables.map((variable) => variable.name).join(', ') || '(none)'}`
          : `Invalid: ${summary.errors.join(' | ')}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n');

      return {
        text,
        structured: {
          template: summary,
          license: manifest?.license ?? null,
          compatibility: manifest?.compatibility ?? null,
          variables: (manifest?.variables ?? []).map((variable) => ({
            name: variable.name,
            description: variable.description,
            type: variable.type,
            required: variable.required,
            default: variable.default ?? null,
            values: variable.values ?? null,
          })),
          files: (manifest?.files ?? []).map((file) => ({ target: file.target, stage: file.stage })),
          builtinVariables: ['specName', 'title', 'description', 'kind', 'mode'],
          examples: manifest?.examples ?? [],
          readme: readme?.text ?? null,
          issues: entry.pack.issues.map((issue) => ({
            code: issue.code,
            category: issue.category,
            severity: issue.severity,
            message: issue.message,
          })),
        },
      };
    },
  });
}
