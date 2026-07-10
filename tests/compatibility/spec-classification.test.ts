import { describe, expect, it } from 'vitest';
import type { SpecState } from '@specbridge/core';
import { resolveWorkspace } from '@specbridge/core';
import { classifySpec, findSpec } from '@specbridge/compat-kiro';
import { fixturePath } from '../helpers.js';

function folderOf(fixture: string, spec: string) {
  const ws = resolveWorkspace(fixturePath(fixture))!;
  const folder = findSpec(ws, spec);
  if (folder === undefined) throw new Error(`fixture spec missing: ${fixture}/${spec}`);
  return folder;
}

describe('spec classification', () => {
  it('classifies a complete feature spec', () => {
    const result = classifySpec(folderOf('standard-feature', 'user-authentication'));
    expect(result.type).toBe('feature');
    expect(result.completeness).toBe('complete');
    expect(result.missingKinds).toEqual([]);
  });

  it('reports workflow order as unknown without sidecar state (never invents one)', () => {
    const result = classifySpec(folderOf('standard-feature', 'user-authentication'));
    expect(result.workflowMode).toBe('unknown');
  });

  it('uses sidecar state for the workflow mode when available', () => {
    const state: SpecState = {
      specName: 'user-authentication',
      specType: 'feature',
      workflowMode: 'design-first',
      status: 'DESIGN_APPROVED',
    };
    const result = classifySpec(folderOf('standard-feature', 'user-authentication'), state);
    expect(result.workflowMode).toBe('design-first');
  });

  it('classifies a bugfix spec (bugfix.md wins)', () => {
    const result = classifySpec(folderOf('bugfix-spec', 'login-timeout-fix'));
    expect(result.type).toBe('bugfix');
    expect(result.completeness).toBe('complete');
  });

  it('classifies a partial spec and lists missing stages', () => {
    const result = classifySpec(folderOf('partial-spec', 'notification-settings'));
    expect(result.type).toBe('feature');
    expect(result.completeness).toBe('partial');
    expect(result.missingKinds).toEqual(['design', 'tasks']);
  });

  it('classifies a folder with only unknown files as unknown/empty', () => {
    const folder = folderOf('manually-edited-feature', 'search-filters');
    const onlyNotes = {
      ...folder,
      files: folder.files.filter((f) => f.kind === 'other'),
    };
    const result = classifySpec(onlyNotes);
    expect(result.type).toBe('unknown');
    expect(result.completeness).toBe('empty');
    expect(result.diagnostics.some((d) => d.code === 'SPEC_NO_KNOWN_FILES')).toBe(true);
  });

  it('flags sidecar/file-layout type mismatches instead of guessing', () => {
    const state: SpecState = {
      specName: 'login-timeout-fix',
      specType: 'feature',
      workflowMode: 'quick',
      status: 'DRAFT',
    };
    const result = classifySpec(folderOf('bugfix-spec', 'login-timeout-fix'), state);
    expect(result.type).toBe('bugfix');
    expect(result.diagnostics.some((d) => d.code === 'SIDECAR_TYPE_MISMATCH')).toBe(true);
  });
});
