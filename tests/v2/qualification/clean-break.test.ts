import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_TOOL_NAMES } from '@specbridge/mcp-server';

describe('SpecBridge 2.0 clean-break qualification', () => {
  it('contains no active implementation runtime dependency or workspace package', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const workspace = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const packageJson = readFileSync(path.join(root, 'package.json'), 'utf8');
    for (const legacy of [
      'autonomy',
      'execution',
      'orchestration',
      'runners',
      'mission',
      'intake',
    ]) {
      expect(workspace).not.toContain('packages/' + legacy);
      expect(existsSync(path.join(root, 'packages', legacy, 'package.json'))).toBe(false);
      expect(packageJson).not.toContain('qualification:vnext');
    }
    const activePackages = readdirSync(path.join(root, 'packages'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(path.join(root, 'packages', entry.name, 'package.json')),
      )
      .map((entry) => entry.name)
      .sort();
    expect(activePackages).toEqual(['cli', 'core', 'design', 'mcp-server', 'repository']);
    expect(DESIGN_TOOL_NAMES.some((name) => /job|worker|runner|attempt/.test(name))).toBe(false);
  });

  it('keeps legacy execution concepts out of active production source', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const sourceFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (entry.isFile() && entry.name.endsWith('.ts')) sourceFiles.push(target);
      }
    };
    for (const packageName of ['cli', 'core', 'design', 'mcp-server', 'repository']) {
      visit(path.join(root, 'packages', packageName, 'src'));
    }
    const activeSource = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const legacyType of [
      'JobRuntime',
      'MissionRuntime',
      'WorkUnit',
      'ExecutionLedger',
      'StrongBuilder',
      'SecondaryBuilder',
      'AdaptiveScheduler',
      'WorkerSession',
    ]) {
      expect(activeSource).not.toContain(legacyType);
    }
  });
});
