import { z } from 'zod';
import { collectExtensionTemplatePacks } from '@specbridge/extensions';
import type { TemplateCatalog, TemplateCatalogEntry } from '@specbridge/templates';
import { loadTemplateCatalog } from '@specbridge/templates';
import type { ServerContext } from '../context.js';

/**
 * Shared plumbing for the template_* tools. All tools reuse the same catalog
 * and rendering services as the CLI — one implementation, two front ends.
 * Nothing here exposes absolute filesystem paths: templates are identified
 * by qualified references only.
 */

export const templateSourceInput = z.enum(['builtin', 'project', 'extension', 'all']);

export function catalogFor(context: ServerContext, source?: 'builtin' | 'project' | 'extension' | 'all'): TemplateCatalog {
  const workspace = context.requireWorkspace();
  const extensionTemplates = collectExtensionTemplatePacks(workspace);
  return loadTemplateCatalog(workspace, {
    source: source ?? 'all',
    extensionPacks: [...extensionTemplates.packs],
  });
}

export const templateSummaryShape = z.object({
  ref: z.string().describe('Qualified reference, e.g. builtin:rest-api'),
  id: z.string(),
  source: z.string().min(1).max(100),
  valid: z.boolean(),
  displayName: z.string().nullable(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  kind: z.enum(['feature', 'bugfix']).nullable(),
  supportedModes: z.array(z.enum(['requirements-first', 'design-first', 'quick'])),
  defaultMode: z.enum(['requirements-first', 'design-first', 'quick']).nullable(),
  tags: z.array(z.string()),
  deprecated: z.boolean(),
  errors: z.array(z.string()).describe('Validation errors (SBT codes) for invalid templates'),
});

export type TemplateSummary = z.infer<typeof templateSummaryShape>;

export function entrySummary(entry: TemplateCatalogEntry): TemplateSummary {
  const manifest = entry.pack.manifest;
  return {
    ref: entry.ref,
    id: entry.id,
    source: entry.source,
    valid: entry.valid,
    displayName: manifest?.displayName ?? null,
    version: manifest?.version ?? null,
    description: manifest?.description ?? null,
    kind: manifest?.kind ?? null,
    supportedModes: manifest?.supportedModes ?? [],
    defaultMode: manifest?.defaultMode ?? null,
    tags: manifest?.tags ?? [],
    deprecated: manifest?.deprecated === true,
    errors: entry.pack.issues
      .filter((issue) => issue.severity === 'error')
      .slice(0, 10)
      .map((issue) => `${issue.code}: ${issue.message}`),
  };
}

export interface TemplateFilters {
  kind?: 'feature' | 'bugfix' | undefined;
  mode?: 'requirements-first' | 'design-first' | 'quick' | undefined;
  tag?: string | undefined;
}

export function filterEntries(entries: TemplateCatalogEntry[], filters: TemplateFilters): TemplateCatalogEntry[] {
  let result = entries;
  if (filters.kind !== undefined) {
    result = result.filter((entry) => entry.pack.manifest?.kind === filters.kind);
  }
  if (filters.mode !== undefined) {
    result = result.filter((entry) => entry.pack.manifest?.supportedModes.includes(filters.mode as never) === true);
  }
  if (filters.tag !== undefined) {
    result = result.filter((entry) => entry.pack.manifest?.tags.includes(filters.tag as string) === true);
  }
  return result;
}

/** Variable values accepted over MCP: scalars only, like the manifest types. */
export const templateVariablesInput = z
  .record(z.union([z.string().max(100_000), z.number(), z.boolean()]))
  .optional()
  .describe('Template variables by name (scalars only)');
