import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import { BUILTIN_TEMPLATE_PACKS } from './builtin-packs.generated.js';
import { TemplateError } from './errors.js';
import type { TemplateEntrySource, TemplateReference, TemplateSource } from './ids.js';
import {
  formatExtensionTemplateReference,
  formatTemplateReference,
  parseTemplateReference,
} from './ids.js';
import type { LoadedTemplatePack, TemplatePackData } from './pack.js';
import { loadTemplatePack, readTemplatePackDirectory } from './pack.js';
import type { TemplateValidationIssue } from './types.js';

/**
 * Template catalog: built-in templates (embedded at build time) plus
 * project-local packs installed under `.specbridge/templates/`.
 *
 * Discovery only ever inspects those two locations — never the repository at
 * large, never the user's home directory, never the network. Invalid packs
 * are reported as diagnostics-carrying entries instead of crashing the whole
 * catalog, and identical IDs across sources are surfaced as ambiguity rather
 * than silently shadowed.
 */

export function projectTemplatesDir(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, 'templates');
}

export interface TemplateCatalogEntry {
  source: TemplateEntrySource;
  id: string;
  /** Qualified reference, e.g. `builtin:rest-api` or `extension:api-pack/rest-api`. */
  ref: string;
  pack: LoadedTemplatePack;
  /** No error-severity issues. Invalid entries are listed but not applied. */
  valid: boolean;
}

/**
 * One template pack contributed by an enabled template-provider extension.
 * The extension host validates the pack at install time; the catalog
 * revalidates it here like any other pack (data-only, never a process).
 */
export interface ExtensionTemplatePackInput {
  extensionId: string;
  templateId: string;
  data: TemplatePackData;
}

export interface TemplateCatalog {
  /** Deterministic order: builtin before project, then by ID. */
  entries: TemplateCatalogEntry[];
  /** Non-fatal discovery problems (unreadable pack directories etc.). */
  diagnostics: Diagnostic[];
}

export interface LoadCatalogOptions {
  /** Restrict discovery to one source. Default: all. */
  source?: TemplateSource | 'extension' | 'all';
  /** Override the version used for compatibility checks (tests). */
  specbridgeVersion?: string;
  /**
   * Packs contributed by enabled template-provider extensions. Callers that
   * integrate extensions (CLI, MCP) collect these via @specbridge/extensions
   * and pass them in; the templates package itself never reads extension
   * state, keeping the dependency direction one-way.
   */
  extensionPacks?: readonly ExtensionTemplatePackInput[];
}

function builtinEntries(options: LoadCatalogOptions): TemplateCatalogEntry[] {
  const entries: TemplateCatalogEntry[] = [];
  for (const packData of BUILTIN_TEMPLATE_PACKS) {
    const pack = loadTemplatePack(
      { origin: `builtin:${packData.id}`, files: new Map(Object.entries(packData.files)) },
      {
        requireReadme: true,
        ...(options.specbridgeVersion !== undefined
          ? { specbridgeVersion: options.specbridgeVersion }
          : {}),
      },
    );
    entries.push({
      source: 'builtin',
      id: packData.id,
      ref: formatTemplateReference('builtin', packData.id),
      pack,
      valid: pack.valid && pack.manifest?.id === packData.id,
    });
  }
  return entries;
}

function projectEntries(
  workspace: WorkspaceInfo | undefined,
  options: LoadCatalogOptions,
  diagnostics: Diagnostic[],
): TemplateCatalogEntry[] {
  if (workspace === undefined) return [];
  const dir = projectTemplatesDir(workspace);
  if (!existsSync(dir)) return [];

  const entries: TemplateCatalogEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'));
  } catch (cause) {
    diagnostics.push({
      severity: 'warning',
      code: 'TEMPLATE_DIR_UNREADABLE',
      message: `Cannot read ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return [];
  }

  for (const name of names) {
    const packDir = path.join(dir, name);
    let pack: LoadedTemplatePack;
    try {
      const data = readTemplatePackDirectory(packDir);
      pack = loadTemplatePack(
        data,
        options.specbridgeVersion !== undefined
          ? { specbridgeVersion: options.specbridgeVersion }
          : {},
      );
    } catch (cause) {
      // A broken installed pack must not take down discovery: surface it as
      // an invalid entry carrying the failure as its only issue.
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure: TemplateValidationIssue = {
        code: cause instanceof TemplateError ? cause.templateCode : 'SBT025',
        category: 'files',
        severity: 'error',
        message,
      };
      pack = {
        origin: packDir,
        manifest: undefined,
        manifestText: undefined,
        readme: undefined,
        files: new Map(),
        issues: [failure],
        valid: false,
      };
    }
    const manifestMismatch = pack.manifest !== undefined && pack.manifest.id !== name;
    if (manifestMismatch) {
      pack.issues.push({
        code: 'SBT004',
        category: 'manifest',
        severity: 'error',
        message: `Installed directory "${name}" does not match manifest id "${pack.manifest?.id}".`,
      });
    }
    entries.push({
      source: 'project',
      id: name,
      ref: formatTemplateReference('project', name),
      pack,
      valid: pack.valid && !manifestMismatch,
    });
  }
  return entries;
}

function extensionEntries(options: LoadCatalogOptions): TemplateCatalogEntry[] {
  const entries: TemplateCatalogEntry[] = [];
  for (const input of options.extensionPacks ?? []) {
    const pack = loadTemplatePack(input.data, {
      requireReadme: true,
      ...(options.specbridgeVersion !== undefined
        ? { specbridgeVersion: options.specbridgeVersion }
        : {}),
    });
    const manifestMismatch = pack.manifest !== undefined && pack.manifest.id !== input.templateId;
    if (manifestMismatch) {
      pack.issues.push({
        code: 'SBT004',
        category: 'manifest',
        severity: 'error',
        message: `Extension pack directory "${input.templateId}" does not match manifest id "${pack.manifest?.id}".`,
      });
    }
    entries.push({
      source: `extension:${input.extensionId}`,
      id: input.templateId,
      ref: formatExtensionTemplateReference(input.extensionId, input.templateId),
      pack,
      valid: pack.valid && !manifestMismatch,
    });
  }
  return entries;
}

const SOURCE_RANK: Record<string, number> = { builtin: 0, project: 1 };

function sourceRank(source: TemplateEntrySource): number {
  return SOURCE_RANK[source] ?? 2;
}

/**
 * Discover all templates. Deterministic: built-ins first, then project
 * templates, then extension-contributed templates, each sorted by ID.
 */
export function loadTemplateCatalog(
  workspace: WorkspaceInfo | undefined,
  options: LoadCatalogOptions = {},
): TemplateCatalog {
  const diagnostics: Diagnostic[] = [];
  const source = options.source ?? 'all';
  const entries: TemplateCatalogEntry[] = [];
  if (source === 'all' || source === 'builtin') {
    entries.push(...builtinEntries(options));
  }
  if (source === 'all' || source === 'project') {
    entries.push(...projectEntries(workspace, options, diagnostics));
  }
  if (source === 'all' || source === 'extension') {
    entries.push(...extensionEntries(options));
  }
  entries.sort(
    (a, b) =>
      sourceRank(a.source) - sourceRank(b.source) ||
      a.id.localeCompare(b.id, 'en') ||
      a.ref.localeCompare(b.ref, 'en'),
  );
  return { entries, diagnostics };
}

/**
 * Resolve a template reference against the catalog.
 *
 * Qualified references (`builtin:x`, `project:x`) resolve directly.
 * An unqualified ID resolves only when exactly one source provides it; the
 * same ID in several sources is an explicit ambiguity error (SBT002) — one
 * source never silently shadows another.
 */
export function resolveTemplate(catalog: TemplateCatalog, rawReference: string): TemplateCatalogEntry {
  const reference: TemplateReference | undefined = parseTemplateReference(rawReference);
  if (reference === undefined) {
    throw new TemplateError(
      'SBT003',
      `"${rawReference}" is not a valid template reference.`,
      'Use a template ID like "rest-api" or a qualified reference like "builtin:rest-api", ' +
        '"project:my-template", or "extension:<extension-id>/<template-id>".',
      { reference: rawReference },
    );
  }

  const matches = catalog.entries.filter(
    (entry) => entry.id === reference.id && (reference.source === undefined || entry.source === reference.source),
  );

  if (matches.length === 0) {
    const suggestions = catalog.entries
      .filter((entry) => entry.id.includes(reference.id) || reference.id.includes(entry.id))
      .map((entry) => entry.ref)
      .slice(0, 5);
    throw new TemplateError(
      'SBT001',
      `Template "${rawReference}" was not found.`,
      suggestions.length > 0
        ? `Did you mean: ${suggestions.join(', ')}? Run "specbridge template list" to see all templates.`
        : 'Run "specbridge template list" to see available templates.',
      { reference: rawReference },
    );
  }
  if (matches.length > 1) {
    throw new TemplateError(
      'SBT002',
      `Template ID "${reference.id}" exists in multiple sources.`,
      `Use a qualified reference: ${matches.map((entry) => entry.ref).join(' or ')}.`,
      { reference: rawReference, candidates: matches.map((entry) => entry.ref) },
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new TemplateError('SBT001', `Template "${rawReference}" was not found.`, 'Run "specbridge template list".');
  }
  return match;
}

/**
 * Resolve a template that must be valid (for preview/apply). Invalid packs
 * resolve for inspection commands but refuse rendering.
 */
export function resolveValidTemplate(catalog: TemplateCatalog, rawReference: string): TemplateCatalogEntry {
  const entry = resolveTemplate(catalog, rawReference);
  if (!entry.valid || entry.pack.manifest === undefined) {
    const problems = entry.pack.issues
      .filter((item) => item.severity === 'error')
      .slice(0, 5)
      .map((item) => `${item.code}: ${item.message}`);
    throw new TemplateError(
      'SBT004',
      `Template ${entry.ref} failed validation and cannot be used.` +
        (problems.length > 0 ? ` Problems: ${problems.join(' | ')}` : ''),
      `Run "specbridge template validate ${entry.ref}" for the full report.`,
      { reference: entry.ref },
    );
  }
  return entry;
}
