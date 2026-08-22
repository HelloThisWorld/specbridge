import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RepositoryContextIndex,
  REPOSITORY_INDEX_FORMAT_VERSION,
  buildRepositoryIndex,
  isCredentialShapedPath,
  isIndexReusable,
  linkEntries,
  moduleOf,
  pathTokens,
  refreshRepositoryIndex,
  resolveFresh,
  scanWorkspace,
  testStem,
  workspaceKeyFor,
} from '@specbridge/context';

/**
 * The repository context index: boundaries, provenance, freshness, and
 * incremental refresh. Everything here runs against a real temp workspace,
 * because the guarantees under test are about BYTES on disk — an index that
 * only agreed with an in-memory fake would prove nothing about staleness.
 */

const NOW = '2026-08-22T10:00:00.000Z';
const created: string[] = [];

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-index-'));
  created.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const root = created.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const FOO_SERVICE = [
  "import { helper } from './helper.js';",
  '',
  'export class FooService {',
  '  load(): string {',
  '    return helper();',
  '  }',
  '}',
  '',
].join('\n');

const FOO_TEST = [
  "import { FooService } from '../src/foo-service.js';",
  '',
  'describe("FooService", () => {',
  '  it("loads", () => { new FooService().load(); });',
  '});',
  '',
].join('\n');

function sampleRepository(): string {
  return workspace({
    'src/foo-service.ts': FOO_SERVICE,
    'src/helper.ts': 'export function helper(): string { return "ok"; }\n',
    'src/unrelated-widget.ts': 'export function renderWidget(): void {}\n',
    'tests/foo-service.test.ts': FOO_TEST,
    'docs/architecture.md': '# Architecture\n\nThe FooService loads things.\n',
    'package.json': '{ "name": "sample" }\n',
  });
}

describe('repository index: boundaries', () => {
  it('never indexes credential-shaped paths, even when the name looks relevant', () => {
    const root = workspace({
      'src/foo-service.ts': FOO_SERVICE,
      '.env': 'API_KEY=abcdef0123456789\n',
      '.env.production': 'TOKEN=zzz\n',
      'config/foo-service-credentials.json': '{ "secret": "abc" }\n',
      'deploy/foo-service.pem': '-----BEGIN PRIVATE KEY-----\n',
    });
    const state = buildRepositoryIndex({ rootDir: root, now: NOW });
    const paths = state.entries.map((entry) => entry.path);

    expect(paths).toContain('src/foo-service.ts');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('.env.production');
    expect(paths).not.toContain('config/foo-service-credentials.json');
    expect(paths).not.toContain('deploy/foo-service.pem');
    expect(state.skippedCounts['credential-shaped']).toBeGreaterThanOrEqual(4);
  });

  it('classifies credential shapes structurally, not by directory', () => {
    expect(isCredentialShapedPath('a/b/.env')).toBe(true);
    expect(isCredentialShapedPath('keys/id_rsa')).toBe(true);
    expect(isCredentialShapedPath('certs/server.pem')).toBe(true);
    expect(isCredentialShapedPath('config/db-secrets.yaml')).toBe(true);
    expect(isCredentialShapedPath('src/environment.ts')).toBe(false);
    // Source ABOUT credentials stays retrievable: the boundary stops
    // credential FILES reaching a prompt, it does not censor the topic.
    expect(isCredentialShapedPath('src/secret-store.ts')).toBe(false);
    expect(isCredentialShapedPath('src/credentials-form.tsx')).toBe(false);
  });

  it('excludes build output, dependency caches, and SpecBridge sidecar state', () => {
    const root = workspace({
      'src/app.ts': 'export const app = 1;\n',
      'node_modules/left-pad/index.js': 'module.exports = 1;\n',
      'dist/app.js': 'var app = 1;\n',
      'coverage/report.json': '{}\n',
      '.specbridge/state/thing.json': '{}\n',
      '.kiro/specs/demo/requirements.md': '# Requirements\n',
    });
    const paths = buildRepositoryIndex({ rootDir: root, now: NOW }).entries.map((entry) => entry.path);
    expect(paths).toEqual(['src/app.ts']);
  });

  it('honours .gitignore, including nested negation', () => {
    const root = workspace({
      '.gitignore': 'generated/\n*.log\n',
      'src/app.ts': 'export const app = 1;\n',
      'generated/schema.ts': 'export const schema = 1;\n',
      'debug.log': 'noise\n',
      'src/.gitignore': '!keep.log\n',
      'src/keep.log': 'kept\n',
    });
    const paths = buildRepositoryIndex({ rootDir: root, now: NOW }).entries.map((entry) => entry.path);
    expect(paths).toContain('src/app.ts');
    expect(paths).not.toContain('generated/schema.ts');
    expect(paths).not.toContain('debug.log');
    expect(paths).toContain('src/keep.log');
  });

  it('excludes configured protected paths before reading them', () => {
    const root = workspace({
      'src/app.ts': 'export const app = 1;\n',
      'secrets/keys.ts': 'export const key = "value";\n',
    });
    const state = buildRepositoryIndex({ rootDir: root, now: NOW, protectedPaths: ['secrets'] });
    expect(state.entries.map((entry) => entry.path)).not.toContain('secrets/keys.ts');
    expect(state.skipped.some((entry) => entry.reason === 'protected-path')).toBe(true);
  });

  it('is deterministic: two builds of the same tree produce identical entries', () => {
    const root = sampleRepository();
    const first = buildRepositoryIndex({ rootDir: root, now: NOW });
    const second = buildRepositoryIndex({ rootDir: root, now: NOW });
    expect(second.entries).toEqual(first.entries);
  });
});

describe('repository index: extraction', () => {
  it('extracts declared symbols and resolves repository-internal imports', () => {
    const root = sampleRepository();
    const index = new RepositoryContextIndex(buildRepositoryIndex({ rootDir: root, now: NOW }));

    expect(index.get('src/foo-service.ts')?.symbols).toContain('FooService');
    expect(index.dependenciesOf('src/foo-service.ts')).toContain('src/helper.ts');
    expect(index.dependentsOf('src/helper.ts')).toContain('src/foo-service.ts');
    expect(index.declaring('FooService')).toContain('src/foo-service.ts');
  });

  it('pairs tests with the sources they cover', () => {
    const root = sampleRepository();
    const index = new RepositoryContextIndex(buildRepositoryIndex({ rootDir: root, now: NOW }));
    expect(index.get('tests/foo-service.test.ts')?.kind).toBe('test');
    expect(index.sourcesFor('tests/foo-service.test.ts')).toContain('src/foo-service.ts');
    expect(index.testsFor('src/foo-service.ts')).toContain('tests/foo-service.test.ts');
  });

  it('derives module association and path tokens deterministically', () => {
    expect(moduleOf('packages/context/src/items.ts')).toBe('packages/context');
    expect(moduleOf('src/foo/bar.ts')).toBe('src/foo');
    expect(pathTokens('src/foo-service.ts')).toEqual(['src', 'foo', 'service']);
    expect(testStem('tests/foo-service.test.ts')).toBe('foo-service');
  });

  it('never stores file content, only metadata', () => {
    const root = sampleRepository();
    const state = buildRepositoryIndex({ rootDir: root, now: NOW });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('return helper()');
    expect(serialized).toContain('src/foo-service.ts');
  });
});

describe('repository index: freshness', () => {
  it('detects a stale entry by hash and never reports old content as current', () => {
    const root = sampleRepository();
    const state = buildRepositoryIndex({ rootDir: root, now: NOW });
    const index = new RepositoryContextIndex(state);
    const entry = index.get('src/foo-service.ts');
    expect(entry).toBeDefined();

    expect(resolveFresh(root, entry!).status).toBe('current');

    writeFileSync(
      path.join(root, 'src/foo-service.ts'),
      FOO_SERVICE.replace('load()', 'loadRenamed()'),
      'utf8',
    );

    const resolved = resolveFresh(root, entry!, { withContent: true });
    expect(resolved.status).toBe('stale');
    expect(resolved.currentHash).not.toBe(entry!.contentHash);
    // The CURRENT bytes come back, never the indexed snapshot.
    expect(resolved.content).toContain('loadRenamed');
  });

  it('reports a deleted file as missing rather than current', () => {
    const root = sampleRepository();
    const index = new RepositoryContextIndex(buildRepositoryIndex({ rootDir: root, now: NOW }));
    const entry = index.get('src/helper.ts');
    rmSync(path.join(root, 'src/helper.ts'));
    expect(resolveFresh(root, entry!).status).toBe('missing');
  });
});

describe('repository index: incremental refresh', () => {
  it('refreshes only the changed entry and leaves the rest byte-identical', () => {
    const root = sampleRepository();
    const before = buildRepositoryIndex({ rootDir: root, now: NOW });
    const unchangedBefore = before.entries.find((entry) => entry.path === 'src/helper.ts');

    writeFileSync(
      path.join(root, 'src/foo-service.ts'),
      `${FOO_SERVICE}\nexport class FooExtras {}\n`,
      'utf8',
    );

    const refreshed = refreshRepositoryIndex(before, {
      rootDir: root,
      now: '2026-08-22T11:00:00.000Z',
      changedPaths: ['src/foo-service.ts'],
    });

    expect(refreshed.rebuilt).toBe(false);
    expect(refreshed.refreshedPaths).toEqual(['src/foo-service.ts']);
    expect(refreshed.removedPaths).toEqual([]);

    const index = new RepositoryContextIndex(refreshed.state);
    expect(index.get('src/foo-service.ts')?.symbols).toContain('FooExtras');
    expect(index.get('src/foo-service.ts')?.contentHash).not.toBe(
      before.entries.find((entry) => entry.path === 'src/foo-service.ts')?.contentHash,
    );
    const unchangedAfter = index.get('src/helper.ts');
    expect(unchangedAfter?.contentHash).toBe(unchangedBefore?.contentHash);
    expect(unchangedAfter?.indexedAt).toBe(unchangedBefore?.indexedAt);
  });

  it('adds new files and drops deleted ones during an untargeted refresh', () => {
    const root = sampleRepository();
    const before = buildRepositoryIndex({ rootDir: root, now: NOW });
    rmSync(path.join(root, 'src/unrelated-widget.ts'));

    const refreshed = refreshRepositoryIndex(before, {
      rootDir: root,
      now: '2026-08-22T11:00:00.000Z',
    });
    expect(refreshed.removedPaths).toContain('src/unrelated-widget.ts');
    expect(new RepositoryContextIndex(refreshed.state).has('src/unrelated-widget.ts')).toBe(false);
  });

  it('rebuilds rather than adopting an index from a different workspace', () => {
    const rootA = sampleRepository();
    const rootB = sampleRepository();
    const fromA = buildRepositoryIndex({ rootDir: rootA, now: NOW });

    expect(isIndexReusable(fromA, { workspaceKey: workspaceKeyFor(rootB) })).toBe(false);
    const refreshed = refreshRepositoryIndex(fromA, { rootDir: rootB, now: NOW });
    expect(refreshed.rebuilt).toBe(true);
    expect(refreshed.state.workspaceKey).toBe(workspaceKeyFor(rootB));
  });

  it('rebuilds rather than adopting an index written by an older format', () => {
    const root = sampleRepository();
    const state = buildRepositoryIndex({ rootDir: root, now: NOW });
    const older = { ...state, formatVersion: REPOSITORY_INDEX_FORMAT_VERSION - 1 };
    expect(isIndexReusable(older, { workspaceKey: state.workspaceKey })).toBe(false);
    expect(refreshRepositoryIndex(older, { rootDir: root, now: NOW }).rebuilt).toBe(true);
  });

  it('rebuilds from nothing when the cache is absent entirely', () => {
    const root = sampleRepository();
    const refreshed = refreshRepositoryIndex(undefined, { rootDir: root, now: NOW });
    expect(refreshed.rebuilt).toBe(true);
    expect(refreshed.state.entries.length).toBeGreaterThan(0);
  });
});

describe('repository index: scan bounds', () => {
  it('records truncation instead of exceeding the entry ceiling', () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) {
      files[`src/file-${index}.ts`] = `export const value${index} = ${index};\n`;
    }
    const root = workspace(files);
    const scan = scanWorkspace({ rootDir: root, indexedAt: NOW, maxEntries: 5 });
    expect(scan.entries).toHaveLength(5);
    expect(scan.truncated).toBe(true);
    expect(scan.skippedCounts['entry-limit']).toBeGreaterThanOrEqual(1);
  });

  it('skips oversized files without reading them', () => {
    const root = workspace({ 'src/huge.ts': 'x'.repeat(5_000) });
    const scan = scanWorkspace({ rootDir: root, indexedAt: NOW, maxFileBytes: 1_000 });
    expect(scan.entries).toHaveLength(0);
    expect(scan.skipped).toContainEqual({ path: 'src/huge.ts', reason: 'too-large' });
  });

  it('resolves import edges only after the full path set is known', () => {
    const entries = linkEntries([
      {
        path: 'src/a.ts',
        kind: 'source',
        language: 'typescript',
        module: 'src',
        sizeBytes: 10,
        lineCount: 1,
        contentHash: 'a',
        mtimeMs: 0,
        symbols: [],
        imports: ['./b.js', 'zod'],
        importPaths: [],
        tokens: ['a'],
        testTargets: [],
        indexedAt: NOW,
      },
      {
        path: 'src/b.ts',
        kind: 'source',
        language: 'typescript',
        module: 'src',
        sizeBytes: 10,
        lineCount: 1,
        contentHash: 'b',
        mtimeMs: 0,
        symbols: [],
        imports: [],
        importPaths: [],
        tokens: ['b'],
        testTargets: [],
        indexedAt: NOW,
      },
    ]);
    // The relative import resolves; the bare dependency specifier does not.
    expect(entries[0]?.importPaths).toEqual(['src/b.ts']);
  });
});
