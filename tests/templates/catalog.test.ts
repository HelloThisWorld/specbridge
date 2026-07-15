import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@specbridge/core';
import {
  BUILTIN_TEMPLATE_PACKS,
  loadTemplateCatalog,
  resolveTemplate,
  resolveValidTemplate,
  searchTemplates,
} from '@specbridge/templates';
import { bugfixManifest, bugfixPackFiles, featureManifest, featurePackFiles, freshKiroWorkspace, writePack } from '../helpers-templates';

function workspaceWithProjectPack(
  packId: string,
  files: Record<string, string>,
): ReturnType<typeof resolveWorkspace> {
  const root = freshKiroWorkspace();
  const packDir = path.join(root, '.specbridge', 'templates', packId);
  mkdirSync(packDir, { recursive: true });
  writePack(packDir, files);
  return resolveWorkspace(root);
}

describe('template catalog', () => {
  it('discovers built-in templates without a workspace', () => {
    const catalog = loadTemplateCatalog(undefined);
    expect(catalog.entries.length).toBeGreaterThanOrEqual(BUILTIN_TEMPLATE_PACKS.length);
    const restApi = catalog.entries.find((entry) => entry.ref === 'builtin:rest-api');
    expect(restApi?.valid).toBe(true);
  });

  it('every built-in entry is valid', () => {
    const catalog = loadTemplateCatalog(undefined);
    for (const entry of catalog.entries) {
      expect(entry.valid, `${entry.ref}: ${JSON.stringify(entry.pack.issues)}`).toBe(true);
    }
  });

  it('discovers project templates', () => {
    const workspace = workspaceWithProjectPack('sample-feature', featurePackFiles());
    const catalog = loadTemplateCatalog(workspace);
    const entry = catalog.entries.find((item) => item.ref === 'project:sample-feature');
    expect(entry?.valid).toBe(true);
    expect(entry?.source).toBe('project');
  });

  it('reports an invalid project template without crashing the catalog', () => {
    const workspace = workspaceWithProjectPack('broken', { 'specbridge-template.json': '{ not json' });
    const catalog = loadTemplateCatalog(workspace);
    const broken = catalog.entries.find((item) => item.ref === 'project:broken');
    expect(broken?.valid).toBe(false);
    expect(broken?.pack.issues.length).toBeGreaterThan(0);
    expect(catalog.entries.some((item) => item.source === 'builtin' && item.valid)).toBe(true);
  });

  it('reports a directory/manifest id mismatch', () => {
    const workspace = workspaceWithProjectPack('wrong-name', featurePackFiles());
    const catalog = loadTemplateCatalog(workspace);
    const entry = catalog.entries.find((item) => item.ref === 'project:wrong-name');
    expect(entry?.valid).toBe(false);
    expect(entry?.pack.issues.some((issue) => issue.message.includes('does not match manifest id'))).toBe(true);
  });

  it('orders entries deterministically: builtin first, then by ID', () => {
    const workspace = workspaceWithProjectPack('sample-feature', featurePackFiles());
    const catalog = loadTemplateCatalog(workspace);
    const refs = catalog.entries.map((entry) => entry.ref);
    const sorted = [...refs].sort((a, b) => {
      const aBuiltin = a.startsWith('builtin:');
      const bBuiltin = b.startsWith('builtin:');
      if (aBuiltin !== bBuiltin) return aBuiltin ? -1 : 1;
      return a.localeCompare(b, 'en');
    });
    expect(refs).toEqual(sorted);
  });

  it('resolves qualified references', () => {
    const workspace = workspaceWithProjectPack('sample-feature', featurePackFiles());
    const catalog = loadTemplateCatalog(workspace);
    expect(resolveTemplate(catalog, 'builtin:rest-api').source).toBe('builtin');
    expect(resolveTemplate(catalog, 'project:sample-feature').source).toBe('project');
  });

  it('resolves a unique unqualified reference', () => {
    const catalog = loadTemplateCatalog(undefined);
    expect(resolveTemplate(catalog, 'rest-api').ref).toBe('builtin:rest-api');
  });

  it('fails on an ambiguous unqualified reference with SBT002', () => {
    const workspace = workspaceWithProjectPack('rest-api', featurePackFiles(featureManifest({ id: 'rest-api' })));
    const catalog = loadTemplateCatalog(workspace);
    expect(() => resolveTemplate(catalog, 'rest-api')).toThrowError(/SBT002/);
    expect(() => resolveTemplate(catalog, 'rest-api')).toThrowError(/builtin:rest-api or project:rest-api/);
    // Qualified references still work — nothing is silently shadowed.
    expect(resolveTemplate(catalog, 'builtin:rest-api').source).toBe('builtin');
    expect(resolveTemplate(catalog, 'project:rest-api').source).toBe('project');
  });

  it('fails on an unknown template with SBT001 and suggestions', () => {
    const catalog = loadTemplateCatalog(undefined);
    expect(() => resolveTemplate(catalog, 'rest')).toThrowError(/SBT001/);
    expect(() => resolveTemplate(catalog, 'no-such-template')).toThrowError(/template list/);
  });

  it('fails on an invalid reference shape with SBT003', () => {
    const catalog = loadTemplateCatalog(undefined);
    expect(() => resolveTemplate(catalog, '../evil')).toThrowError(/SBT003/);
    expect(() => resolveTemplate(catalog, 'npm:thing')).toThrowError(/SBT003/);
  });

  it('refuses to hand an invalid template to preview/apply', () => {
    const workspace = workspaceWithProjectPack('broken', { 'specbridge-template.json': '{ not json' });
    const catalog = loadTemplateCatalog(workspace);
    expect(() => resolveValidTemplate(catalog, 'project:broken')).toThrowError(/SBT004/);
  });

  it('filters by source', () => {
    const workspace = workspaceWithProjectPack('sample-feature', featurePackFiles());
    const builtinOnly = loadTemplateCatalog(workspace, { source: 'builtin' });
    expect(builtinOnly.entries.every((entry) => entry.source === 'builtin')).toBe(true);
    const projectOnly = loadTemplateCatalog(workspace, { source: 'project' });
    expect(projectOnly.entries).toHaveLength(1);
    expect(projectOnly.entries[0]?.source).toBe('project');
  });
});

describe('template search', () => {
  function catalogWithPacks() {
    const root = freshKiroWorkspace();
    const dirA = path.join(root, '.specbridge', 'templates', 'sample-feature');
    mkdirSync(dirA, { recursive: true });
    writePack(dirA, featurePackFiles());
    const dirB = path.join(root, '.specbridge', 'templates', 'sample-bugfix');
    mkdirSync(dirB, { recursive: true });
    writePack(dirB, bugfixPackFiles(bugfixManifest()));
    return loadTemplateCatalog(resolveWorkspace(root));
  }

  it('ranks an exact ID match first', () => {
    const catalog = loadTemplateCatalog(undefined);
    const results = searchTemplates(catalog, 'rest-api');
    expect(results[0]?.entry.ref).toBe('builtin:rest-api');
  });

  it('ranks ID prefixes above tag matches', () => {
    const catalog = loadTemplateCatalog(undefined);
    const results = searchTemplates(catalog, 'rest');
    expect(results[0]?.entry.id).toBe('rest-api');
  });

  it('finds templates by exact tag', () => {
    const catalog = loadTemplateCatalog(undefined);
    const results = searchTemplates(catalog, 'http');
    expect(results.some((result) => result.entry.id === 'rest-api')).toBe(true);
  });

  it('finds templates by display-name and description tokens', () => {
    const catalog = catalogWithPacks();
    expect(searchTemplates(catalog, 'Sample').some((r) => r.entry.id === 'sample-feature')).toBe(true);
    expect(searchTemplates(catalog, 'regression').some((r) => r.entry.id === 'bugfix-regression')).toBe(true);
  });

  it('is case-insensitive', () => {
    const catalog = loadTemplateCatalog(undefined);
    const lower = searchTemplates(catalog, 'rest-api');
    const upper = searchTemplates(catalog, 'REST-API');
    expect(upper.map((r) => r.entry.ref)).toEqual(lower.map((r) => r.entry.ref));
  });

  it('produces stable ordering across runs', () => {
    const catalog = catalogWithPacks();
    const first = searchTemplates(catalog, 'sample').map((r) => `${r.entry.ref}:${r.score}`);
    const second = searchTemplates(catalog, 'sample').map((r) => `${r.entry.ref}:${r.score}`);
    expect(first).toEqual(second);
  });

  it('bounds the limit', () => {
    const catalog = loadTemplateCatalog(undefined);
    expect(searchTemplates(catalog, 'a', { limit: 10_000 }).length).toBeLessThanOrEqual(50);
    expect(searchTemplates(catalog, 'bugfix', { limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for an empty query', () => {
    const catalog = loadTemplateCatalog(undefined);
    expect(searchTemplates(catalog, '   ')).toEqual([]);
  });
});
