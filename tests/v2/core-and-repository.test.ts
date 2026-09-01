import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertInsideWorkspace,
  stableId,
  writeFileAtomic,
} from '@specbridge/core';
import {
  bootstrapRepository,
  retrieveRepositoryContext,
} from '@specbridge/repository';
import { DesignService } from '@specbridge/design';
import { createSyntheticRepository } from './fixtures.js';

describe('core workspace safety', () => {
  it('rejects paths outside the workspace and writes atomically inside it', () => {
    const root = createSyntheticRepository('workspace-safety');
    expect(() => assertInsideWorkspace(root, '..')).toThrow(/outside/i);
    const file = assertInsideWorkspace(root, path.join('.specbridge', 'safe.txt'));
    writeFileAtomic(file, 'safe\n');
    expect(readFileSync(file, 'utf8')).toBe('safe\n');
    expect(stableId('EV', 'a')).toBe(stableId('EV', 'a'));
    expect(new DesignService({ rootDir: path.join(root, 'src') }).rootDir).toBe(root);
  });
});

describe('repository intelligence', () => {
  it('creates a bounded evidence snapshot and retrieves related files deterministically', () => {
    const root = createSyntheticRepository('repository-intelligence');
    const result = bootstrapRepository({ rootDir: root, maxFiles: 100 });
    expect(result.snapshot.schemaVersion).toBe('specbridge.snapshot.v2');
    expect(result.snapshot.projectType).toBe('BROWNFIELD');
    expect(result.snapshot.languages['TypeScript']).toBeGreaterThan(5);
    expect(result.snapshot.evidence.length).toBeGreaterThan(0);
    expect(existsSync(result.snapshotPath)).toBe(true);
    const first = retrieveRepositoryContext(result.index, {
      rootDir: root,
      query: 'Entity1 module tenant',
      limit: 3,
    });
    const second = retrieveRepositoryContext(result.index, {
      rootDir: root,
      query: 'Entity1 module tenant',
      limit: 3,
    });
    expect(first).toEqual(second);
    expect(first[0]?.path).toContain('module-1.ts');
  });
});
