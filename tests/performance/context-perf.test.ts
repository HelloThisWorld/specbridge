import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RepositoryContextIndex,
  allocateContextBudget,
  buildEfficientContext,
  buildRepositoryIndex,
  buildRetrievalQuery,
  contextBudgetConfigSchema,
  defaultContextAllocationPolicy,
  rankCandidates,
  refreshRepositoryIndex,
  selectWorkingSet,
} from '@specbridge/context';
import type { ContextItem, RepositoryContextIndexState } from '@specbridge/context';

/**
 * vNext.7 large-repository performance suite.
 *
 * The requirement this measures is architectural, not cosmetic: retrieval
 * runs on EVERY dispatch of a long-horizon job, so an implementation that
 * scanned file bodies per dispatch would be unusable on a real repository
 * however good its rankings were. The budgets below therefore protect a
 * shape rather than a number —
 *
 *   index build       O(files), once, and cacheable
 *   incremental       O(changed files), not O(repository)
 *   ranking           O(index metadata), never a file read
 *   selection         O(selected files), a handful of reads
 *
 * Every measurement warms up, then times one run, and asserts against a
 * budget several times the value observed on a development machine — the
 * same philosophy as the existing suite: a benchmark that logs what it saw,
 * not a tight gate that flakes on a loaded CI runner.
 */

const NOW = '2026-08-22T10:00:00.000Z';
const FILE_COUNT = 4_000;

let root: string;
let baseline: RepositoryContextIndexState;

function budget() {
  return contextBudgetConfigSchema.parse({
    modelContextTokens: 200_000,
    reservedOutputTokens: 16_000,
    reservedReasoningTokens: 8_000,
    reservedGrowthTokens: 8_000,
  });
}

function canonical(): ContextItem[] {
  return [
    {
      itemId: 'pinned-task-contract',
      layer: 'PINNED',
      kind: 'task-contract',
      title: 'TaskContract',
      content: 'Fix the stale-read defect in src/module-7/service-3.ts.',
      createdAt: NOW,
      compacted: false,
      authority: 'CANONICAL',
      freshness: 'IMMUTABLE',
    },
    {
      itemId: 'current-action',
      layer: 'CURRENT_ACTION',
      kind: 'next-action',
      title: 'Continue from here',
      content: 'Invalidate the cache entry inside save().',
      createdAt: NOW,
      compacted: false,
      authority: 'CANONICAL',
      freshness: 'EPHEMERAL',
    },
  ];
}

function query() {
  return buildRetrievalQuery({
    taskId: 'T-perf',
    role: 'EXECUTOR',
    contract: 'Fix the stale-read defect in src/module-7/service-3.ts so save() invalidates the cache.',
    objective: 'service cache invalidation stale read module',
    failureText: 'ServiceThree failed: expected "fresh" (src/module-7/service-3.ts:12)',
  });
}

/**
 * A deterministic tree of ~4,000 source files across 200 modules, with real
 * import edges and matching tests — large enough for the measurements to be
 * about the algorithm rather than about constant overhead.
 */
function buildLargeRepository(): string {
  const created = mkdtempSync(path.join(os.tmpdir(), 'specbridge-ctx-perf-'));
  const write = (relative: string, content: string): void => {
    const absolute = path.join(created, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  const modules = 200;
  const perModule = Math.floor(FILE_COUNT / modules / 2);
  write('src/support/logger.ts', 'export const logger = { debug(_m: string): void {} };\n');

  for (let moduleIndex = 0; moduleIndex < modules; moduleIndex += 1) {
    for (let fileIndex = 0; fileIndex < perModule; fileIndex += 1) {
      const name = `Service${moduleIndex}_${fileIndex}`;
      write(
        `src/module-${moduleIndex}/service-${fileIndex}.ts`,
        [
          "import { logger } from '../support/logger.js';",
          '',
          `export class ${name} {`,
          ...Array.from(
            { length: 12 },
            (_, step) =>
              `  step${step}(input: string): string {\n    logger.debug(input);\n    return input + '${step}';\n  }`,
          ),
          '}',
          '',
        ].join('\n'),
      );
      write(
        `tests/module-${moduleIndex}/service-${fileIndex}.test.ts`,
        [
          `import { ${name} } from '../../src/module-${moduleIndex}/service-${fileIndex}.js';`,
          '',
          `it('constructs ${name}', () => { new ${name}(); });`,
          '',
        ].join('\n'),
      );
    }
  }
  return created;
}

function measure<T>(label: string, run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  const ms = performance.now() - started;
  console.log(`  ${label}: ${ms.toFixed(1)} ms`);
  return { value, ms };
}

beforeAll(() => {
  root = buildLargeRepository();
  baseline = buildRepositoryIndex({ rootDir: root, now: NOW });
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('vNext.7 context performance', () => {
  it('indexes a large repository once, within a practical budget', () => {
    // Warm the filesystem cache first, then time a clean build.
    buildRepositoryIndex({ rootDir: root, now: NOW });
    const { value, ms } = measure('initial index build', () =>
      buildRepositoryIndex({ rootDir: root, now: NOW }),
    );

    expect(value.entries.length).toBeGreaterThan(FILE_COUNT * 0.8);
    expect(value.truncated).toBe(false);
    // Generous: ~5-10x a development machine, per the suite's philosophy.
    expect(ms).toBeLessThan(60_000);
    // The index stores metadata only, so its footprint stays proportional to
    // the file COUNT rather than to the repository's size in bytes.
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    console.log(`  index size: ${(bytes / 1_048_576).toFixed(2)} MiB for ${value.entries.length} files`);
    expect(bytes / value.entries.length).toBeLessThan(4_096);
  });

  it('refreshes incrementally in time proportional to the CHANGED files', () => {
    const changed = 'src/module-7/service-3.ts';
    writeFileSync(
      path.join(root, changed),
      'export class Service7_3 { changed(): string { return "changed"; } }\n',
      'utf8',
    );

    refreshRepositoryIndex(baseline, { rootDir: root, now: NOW, changedPaths: [changed] });
    const { value, ms } = measure('incremental refresh (1 changed file)', () =>
      refreshRepositoryIndex(baseline, { rootDir: root, now: NOW, changedPaths: [changed] }),
    );

    expect(value.rebuilt).toBe(false);
    expect(value.refreshedPaths).toEqual([changed]);
    // The whole point: a per-turn refresh must not cost a rebuild.
    expect(ms).toBeLessThan(5_000);
  });

  it('ranks candidates from metadata alone, without reading any file body', () => {
    const index = new RepositoryContextIndex(baseline);
    const request = query();
    rankCandidates(index, request, { maxCandidates: 200 });
    const { value, ms } = measure('retrieval ranking over the full index', () =>
      rankCandidates(index, request, { maxCandidates: 200 }),
    );

    expect(value.length).toBeGreaterThan(0);
    expect(value[0]?.path).toBe('src/module-7/service-3.ts');
    // Metadata-only: fast enough to run on every dispatch of a long job.
    expect(ms).toBeLessThan(3_000);
  });

  it('selects and materializes only the handful of files it chose', () => {
    const index = new RepositoryContextIndex(baseline);
    const request = query();
    const candidates = rankCandidates(index, request, { maxCandidates: 200 });
    const allocation = allocateContextBudget(budget(), defaultContextAllocationPolicy(), 'MATERIALIZED');

    const run = () =>
      selectWorkingSet({
        index,
        rootDir: root,
        candidates,
        query: request,
        shape: 'MATERIALIZED',
        allocation,
        expansionLevel: 'TOP_WORKING_SET',
        maxSelectedItems: 8,
        createdAt: NOW,
      });
    run();
    const { value, ms } = measure('selection (freshness-verified reads)', run);

    expect(value.selected.length).toBeGreaterThan(0);
    expect(value.selected.length).toBeLessThanOrEqual(8);
    expect(ms).toBeLessThan(5_000);
  });

  it('assembles a complete package end to end within a practical budget', async () => {
    const index = new RepositoryContextIndex(baseline);
    const build = async () =>
      buildEfficientContext({
        strategy: 'SELECTIVE',
        shape: 'MATERIALIZED',
        expansionLevel: 'TOP_WORKING_SET',
        canonicalItems: canonical(),
        budget: budget(),
        createdAt: NOW,
        planId: 'perf-plan',
        taskId: 'T-perf',
        index,
        rootDir: root,
        query: query(),
        maxSelectedItems: 8,
      });

    await build();
    const started = performance.now();
    const result = await build();
    const ms = performance.now() - started;
    console.log(`  full context assembly: ${ms.toFixed(1)} ms`);

    expect(result.plan.selectedWorkingItems.length).toBeGreaterThan(0);
    expect(result.assembled.package.items.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(10_000);
  });
});
