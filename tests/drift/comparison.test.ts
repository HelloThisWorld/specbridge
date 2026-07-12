import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isSafeGitRef,
  parseDiffRange,
  parseNameStatusZ,
  parseNumstatZ,
  resolveComparison,
} from '@specbridge/drift';
import { emptyTempDir } from '../helpers.js';
import { git, initGitRepo } from '../helpers-execution.js';

describe('git ref safety', () => {
  it('accepts normal refs and rejects option-like or hostile input', () => {
    expect(isSafeGitRef('origin/main')).toBe(true);
    expect(isSafeGitRef('HEAD~1')).toBe(true);
    expect(isSafeGitRef('v1.0.0')).toBe(true);
    expect(isSafeGitRef('feature/UTF-8-ünïcode')).toBe(true);
    expect(isSafeGitRef('--upload-pack=evil')).toBe(false);
    expect(isSafeGitRef('-C')).toBe(false);
    expect(isSafeGitRef('main branch')).toBe(false);
    expect(isSafeGitRef('a\0b')).toBe(false);
    expect(isSafeGitRef('')).toBe(false);
  });

  it('parses base...head and base..head ranges', () => {
    expect(parseDiffRange('origin/main...HEAD')).toEqual({ base: 'origin/main', head: 'HEAD' });
    expect(parseDiffRange('origin/main...')).toEqual({ base: 'origin/main', head: 'HEAD' });
    expect(parseDiffRange('a..b')).toEqual({ base: 'a', head: 'b' });
    expect(parseDiffRange('justoneref')).toBeUndefined();
    expect(parseDiffRange('...HEAD')).toBeUndefined();
  });
});

describe('-z output parsing', () => {
  it('parses name-status with renames, UTF-8 paths, and spaces', () => {
    const raw = ['M', 'src/päth with space.ts', 'R100', 'old/name.ts', 'new/name.ts', 'A', 'added.md', 'D', 'gone.md', ''].join(
      '\0',
    );
    const files = parseNameStatusZ(raw);
    expect(files).toEqual([
      { path: 'src/päth with space.ts', changeType: 'modified', binary: false, symlinkOutsideRepository: false },
      { path: 'new/name.ts', oldPath: 'old/name.ts', changeType: 'renamed', binary: false, symlinkOutsideRepository: false },
      { path: 'added.md', changeType: 'added', binary: false, symlinkOutsideRepository: false },
      { path: 'gone.md', changeType: 'deleted', binary: false, symlinkOutsideRepository: false },
    ]);
  });

  it('parses numstat including binary markers and rename form', () => {
    const raw = ['3\t1\tsrc/a.ts', '-\t-\tassets/logo.png', '2\t2\t', 'old/name.ts', 'new/name.ts', ''].join('\0');
    const stats = parseNumstatZ(raw);
    expect(stats.get('src/a.ts')).toEqual({ insertions: 3, deletions: 1, binary: false });
    expect(stats.get('assets/logo.png')).toEqual({ binary: true });
    expect(stats.get('new/name.ts')).toEqual({ insertions: 2, deletions: 2, binary: false });
  });
});

function makeRepo(): string {
  const root = emptyTempDir();
  writeFileSync(path.join(root, 'keep.txt'), 'baseline\n', 'utf8');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
  writeFileSync(path.join(root, 'src', 'old-name.ts'), 'export const legacy = true;\n', 'utf8');
  initGitRepo(root);
  return root;
}

describe('resolveComparison (live git)', () => {
  it('working tree covers modified, deleted, untracked, and binary files', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 2;\n', 'utf8');
    rmSync(path.join(root, 'keep.txt'));
    writeFileSync(path.join(root, 'new-untracked.txt'), 'hello\n', 'utf8');
    writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));

    const result = await resolveComparison(root, { mode: 'working-tree' });
    expect(result.ok).toBe(true);
    const byPath = new Map(result.changedFiles.map((file) => [file.path, file]));
    expect(byPath.get('src/app.ts')?.changeType).toBe('modified');
    expect(byPath.get('src/app.ts')?.insertions).toBe(1);
    expect(byPath.get('keep.txt')?.changeType).toBe('deleted');
    expect(byPath.get('new-untracked.txt')?.changeType).toBe('untracked');
    expect(byPath.get('binary.bin')?.changeType).toBe('untracked');
    expect(byPath.get('binary.bin')?.binary).toBe(true);
    // Deterministic path ordering.
    const paths = result.changedFiles.map((file) => file.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('staged mode sees exactly what is staged', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 3;\n', 'utf8');
    writeFileSync(path.join(root, 'unstaged.txt'), 'not staged\n', 'utf8');
    git(root, 'add', 'src/app.ts');

    const result = await resolveComparison(root, { mode: 'staged' });
    expect(result.ok).toBe(true);
    expect(result.changedFiles.map((file) => file.path)).toEqual(['src/app.ts']);
  });

  it('diff mode resolves SHAs and detects renames', async () => {
    const root = makeRepo();
    renameSync(path.join(root, 'src', 'old-name.ts'), path.join(root, 'src', 'new-name.ts'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'rename');

    const result = await resolveComparison(root, { mode: 'diff', base: 'HEAD~1', head: 'HEAD' });
    expect(result.ok).toBe(true);
    expect(result.descriptor.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.descriptor.headSha).toMatch(/^[0-9a-f]{40}$/);
    const renamed = result.changedFiles.find((file) => file.changeType === 'renamed');
    expect(renamed?.path).toBe('src/new-name.ts');
    expect(renamed?.oldPath).toBe('src/old-name.ts');
  });

  it('unresolvable refs fail structurally with fetch guidance, never throw', async () => {
    const root = makeRepo();
    const result = await resolveComparison(root, {
      mode: 'diff',
      base: 'origin/does-not-exist',
      head: 'HEAD',
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('ref-not-found');
    expect(result.failure?.message).toContain('origin/does-not-exist');
    expect(result.failure?.message).toContain('never fetches');
  });

  it('option-injection refs are rejected before git ever runs', async () => {
    const root = makeRepo();
    const result = await resolveComparison(root, {
      mode: 'diff',
      base: '--upload-pack=evil',
      head: 'HEAD',
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('invalid-ref');
  });

  it('a non-repository directory fails with a clear reason', async () => {
    const result = await resolveComparison(emptyTempDir(), { mode: 'working-tree' });
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('not-a-repository');
  });
});
