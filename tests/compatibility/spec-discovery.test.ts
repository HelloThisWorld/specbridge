import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@specbridge/core';
import { discoverSpecs, findSpec, requireSpec, specFile } from '@specbridge/compat-kiro';
import { fixturePath } from '../helpers.js';

describe('spec discovery', () => {
  it('discovers spec folders sorted by name', () => {
    const ws = resolveWorkspace(fixturePath('standard-feature'))!;
    const specs = discoverSpecs(ws);
    expect(specs.map((s) => s.name)).toEqual(['user-authentication']);
    const spec = specs[0]!;
    expect(spec.files.map((f) => `${f.fileName}:${f.kind}`)).toEqual([
      'design.md:design',
      'requirements.md:requirements',
      'tasks.md:tasks',
    ]);
  });

  it('classifies unknown files as "other" and preserves them in the listing', () => {
    const ws = resolveWorkspace(fixturePath('manually-edited-feature'))!;
    const spec = findSpec(ws, 'search-filters');
    expect(spec).toBeDefined();
    const notes = spec!.files.find((f) => f.fileName === 'notes.md');
    expect(notes?.kind).toBe('other');
    expect(specFile(spec!, 'requirements')?.fileName).toBe('requirements.md');
    expect(specFile(spec!, 'design')).toBeUndefined();
  });

  it('finds specs case-insensitively and errors helpfully otherwise', () => {
    const ws = resolveWorkspace(fixturePath('bugfix-spec'))!;
    expect(findSpec(ws, 'LOGIN-TIMEOUT-FIX')?.name).toBe('login-timeout-fix');
    expect(() => requireSpec(ws, 'missing-spec')).toThrowError(/Available specs: login-timeout-fix/);
  });

  it('returns an empty list when .kiro/specs is absent', () => {
    const ws = resolveWorkspace(fixturePath('partial-spec'))!;
    // partial-spec HAS a specs dir; build a synthetic workspace without one.
    const noSpecs = { ...ws };
    delete (noSpecs as { specsDir?: string }).specsDir;
    expect(discoverSpecs(noSpecs)).toEqual([]);
  });
});
