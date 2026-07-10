import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireWorkspace, resolveWorkspace, SpecBridgeError, assertInsideWorkspace } from '@specbridge/core';
import { detectKiroWorkspace } from '@specbridge/compat-kiro';
import { emptyTempDir, fixturePath } from '../helpers.js';

describe('workspace detection', () => {
  it('detects a .kiro workspace from its root', () => {
    const root = fixturePath('standard-feature');
    const workspace = resolveWorkspace(root);
    expect(workspace).toBeDefined();
    expect(workspace?.rootDir).toBe(root);
    expect(workspace?.kiroDir).toBe(path.join(root, '.kiro'));
    expect(workspace?.steeringDir).toBe(path.join(root, '.kiro', 'steering'));
    expect(workspace?.specsDir).toBe(path.join(root, '.kiro', 'specs'));
  });

  it('walks up from a nested subdirectory', () => {
    const nested = fixturePath('standard-feature', 'src', 'app');
    const workspace = resolveWorkspace(nested);
    expect(workspace?.rootDir).toBe(fixturePath('standard-feature'));
  });

  it('reports steering/specs dirs as absent without failing', () => {
    const workspace = resolveWorkspace(fixturePath('partial-spec'));
    expect(workspace).toBeDefined();
    expect(workspace?.steeringDir).toBeUndefined();
    expect(workspace?.specsDir).toBe(path.join(fixturePath('partial-spec'), '.kiro', 'specs'));
  });

  it('returns undefined when no .kiro exists anywhere upward', () => {
    const dir = emptyTempDir();
    expect(resolveWorkspace(dir)).toBeUndefined();
    const status = detectKiroWorkspace(dir);
    expect(status.found).toBe(false);
  });

  it('requireWorkspace throws WORKSPACE_NOT_FOUND with guidance', () => {
    const dir = emptyTempDir();
    try {
      requireWorkspace(dir);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SpecBridgeError);
      expect((error as SpecBridgeError).code).toBe('WORKSPACE_NOT_FOUND');
      expect((error as SpecBridgeError).message).toContain('.kiro');
    }
  });

  it('rejects paths escaping the workspace root', () => {
    const root = fixturePath('standard-feature');
    expect(() => assertInsideWorkspace(root, path.join('..', 'outside.md'))).toThrowError(
      /outside the workspace root/,
    );
    expect(assertInsideWorkspace(root, path.join('.kiro', 'specs'))).toBe(
      path.join(root, '.kiro', 'specs'),
    );
  });
});
