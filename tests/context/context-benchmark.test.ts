import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RepositoryContextIndex,
  allocateContextBudget,
  buildEfficientContext,
  buildRepositoryIndex,
  buildRetrievalQuery,
  compressArtifact,
  contextBudgetConfigSchema,
  defaultContextAllocationPolicy,
  deduplicateItems,
  estimateItemsTokens,
  estimateTokens,
  rankCandidates,
} from '@specbridge/context';
import type { ContextItem } from '@specbridge/context';

/**
 * The context-efficiency benchmark.
 *
 * Deterministic and offline: one fixture repository, a fixed set of
 * representative task shapes, and measurements taken from the same code the
 * runtime uses. Every number printed below is produced by this run — none is
 * quoted from a previous one.
 *
 * The comparison is deliberately chosen to be HONEST rather than flattering.
 * Measuring SELECTIVE against LEGACY on total tokens would score retrieval
 * as a regression, because LEGACY sends no repository content at all: the
 * two are not doing the same job. So each scenario names the baseline it is
 * actually reducing:
 *
 *   materialization  every ranked candidate, whole   vs  bounded selection
 *   worker shape     the same set materialized       vs  pointers
 *   mechanical bulk  the raw artifact                vs  structured parse
 *   repetition       the same fact, several times    vs  deduplicated
 *
 * And the gate (§82-83) is not "fewer tokens". A strategy passes only when
 * it reduces redundant or duplicated context AND preserves the deterministic
 * outcome — the contract, the criteria, the recovery-critical state, and the
 * mandatory references all still present.
 */

const NOW = '2026-08-22T10:00:00.000Z';
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Measurement {
  scenario: string;
  baseline: string;
  baselineTokens: number;
  strategyTokens: number;
  reductionPercent: number;
  detail: string;
}

const measurements: Measurement[] = [];

function record(entry: Omit<Measurement, 'reductionPercent'>): void {
  const reduction =
    entry.baselineTokens === 0
      ? 0
      : Math.round(((entry.baselineTokens - entry.strategyTokens) / entry.baselineTokens) * 1_000) / 10;
  measurements.push({ ...entry, reductionPercent: reduction });
}

/** A fixture repository with real module structure and realistic file sizes. */
function benchmarkRepository(): { root: string; index: RepositoryContextIndex } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-bench-'));
  roots.push(root);
  const write = (relative: string, content: string): void => {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  const body = (name: string, methods: number): string =>
    [
      "import { logger } from '../support/logger.js';",
      '',
      `export class ${name} {`,
      ...Array.from(
        { length: methods },
        (_, index) => `  step${index}(input: string): string {\n    logger.debug(input);\n    return input + '${index}';\n  }`,
      ),
      '}',
      '',
    ].join('\n');

  write('src/settings/settings-store.ts', body('SettingsStore', 40));
  write('src/settings/settings-codec.ts', body('SettingsCodec', 30));
  write('src/workflow/validator.ts', body('WorkflowValidator', 35));
  write('src/workflow/stages.ts', body('WorkflowStages', 25));
  write('src/support/logger.ts', 'export const logger = { debug(_m: string): void {} };\n');
  write(
    'tests/settings-store.test.ts',
    "import { SettingsStore } from '../src/settings/settings-store.js';\nit('works', () => {});\n",
  );
  for (let index = 0; index < 80; index += 1) {
    write(`src/billing/report-${index}.ts`, body(`BillingReport${index}`, 12));
  }
  for (let index = 0; index < 60; index += 1) {
    write(`src/telemetry/probe-${index}.ts`, body(`TelemetryProbe${index}`, 8));
  }

  return { root, index: new RepositoryContextIndex(buildRepositoryIndex({ rootDir: root, now: NOW })) };
}

function budget() {
  return contextBudgetConfigSchema.parse({
    modelContextTokens: 200_000,
    reservedOutputTokens: 16_000,
    reservedReasoningTokens: 8_000,
    reservedGrowthTokens: 8_000,
  });
}

const CONTRACT =
  'Fix the stale-read defect in src/settings/settings-store.ts so that save() invalidates the cache.';

function canonical(): ContextItem[] {
  return [
    {
      itemId: 'pinned-task-contract',
      layer: 'PINNED',
      kind: 'task-contract',
      title: 'TaskContract',
      content: CONTRACT,
      createdAt: NOW,
      compacted: false,
      authority: 'CANONICAL',
      freshness: 'IMMUTABLE',
    },
    {
      itemId: 'pinned-acceptance-criteria',
      layer: 'PINNED',
      kind: 'acceptance-criteria',
      title: 'AcceptanceCriteria',
      content: '- A saved value is visible to the next load.\n- The full test suite passes.',
      createdAt: NOW,
      compacted: false,
      authority: 'CANONICAL',
      freshness: 'IMMUTABLE',
    },
    {
      itemId: 'durable-failed-approaches',
      layer: 'DURABLE_TASK_STATE',
      kind: 'failed-approach',
      title: 'Failed approaches (do not repeat)',
      content: '- Clearing the whole cache on save — failed because: broke unrelated reads.',
      createdAt: NOW,
      compacted: false,
      authority: 'CANONICAL',
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

/** Every required canonical fact, still present in the assembled package. */
function preservesCanonicalTruth(items: readonly ContextItem[]): boolean {
  const rendered = items.map((item) => item.content).join('\n');
  return (
    rendered.includes(CONTRACT) &&
    rendered.includes('A saved value is visible to the next load.') &&
    rendered.includes('Clearing the whole cache on save') &&
    rendered.includes('Invalidate the cache entry inside save().')
  );
}

describe('context efficiency benchmark', () => {
  it('single-file bug: bounded selection versus materializing every candidate', async () => {
    const { root, index } = benchmarkRepository();
    const query = buildRetrievalQuery({
      taskId: 'T-bug',
      role: 'EXECUTOR',
      contract: CONTRACT,
      objective: 'settings store cache invalidation stale read',
    });

    // Baseline: what a DIRECT model gets without retrieval.
    //
    // A model with no tools cannot fetch anything, so the alternative to a
    // selected working set is not "a smaller working set" — it is the whole
    // source tree, because nothing else is a principled subset. That is the
    // comparison this scenario measures, and it is the honest one.
    const candidates = rankCandidates(index, query, { maxCandidates: 200 });
    const naiveTokens = index.entries
      .filter((entry) => entry.kind === 'source' || entry.kind === 'test')
      .reduce((sum, entry) => sum + Math.ceil(entry.sizeBytes / 4) + 8, 0);

    const selective = await buildEfficientContext({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel: 'TOP_WORKING_SET',
      canonicalItems: canonical(),
      budget: budget(),
      createdAt: NOW,
      planId: 'bench-bug',
      taskId: 'T-bug',
      index,
      rootDir: root,
      query,
      maxSelectedItems: 6,
    });

    record({
      scenario: 'single-file bug (LOCAL / DIRECT_MODEL)',
      baseline: 'the whole source tree (no retrieval)',
      baselineTokens: naiveTokens,
      strategyTokens: selective.metrics.workingSetTokens,
      detail:
        `${index.size} indexed files, ${candidates.length} ranked candidates → ` +
        `${selective.plan.selectedWorkingItems.length} selected`,
    });

    // The gate: materially less materialized context, outcome preserved.
    expect(selective.metrics.workingSetTokens).toBeLessThan(naiveTokens / 10);
    expect(selective.plan.selectedWorkingItems.map((entry) => entry.path)).toContain(
      'src/settings/settings-store.ts',
    );
    expect(preservesCanonicalTruth(selective.assembled.package.items)).toBe(true);
  });

  it('multi-file feature: a HARNESS package versus the same set materialized', async () => {
    const { root, index } = benchmarkRepository();
    const query = buildRetrievalQuery({
      taskId: 'T-feature',
      role: 'EXECUTOR',
      contract: 'Rework validation across the settings and workflow modules.',
      objective: 'settings workflow validator stages codec',
    });
    const common = {
      strategy: 'SELECTIVE' as const,
      expansionLevel: 'TOP_WORKING_SET' as const,
      canonicalItems: canonical(),
      budget: budget(),
      createdAt: NOW,
      taskId: 'T-feature',
      index,
      rootDir: root,
      query,
      maxSelectedItems: 8,
    };

    const direct = await buildEfficientContext({ ...common, shape: 'MATERIALIZED', planId: 'bench-direct' });
    const harness = await buildEfficientContext({ ...common, shape: 'POINTER', planId: 'bench-harness' });

    record({
      scenario: 'multi-file feature (LOCAL / HARNESS)',
      baseline: 'the same working set, materialized',
      baselineTokens: direct.metrics.workingSetTokens,
      strategyTokens: harness.metrics.workingSetTokens,
      detail: `${direct.metrics.selectedFiles} files materialized → ${harness.metrics.pointerCount} pointers`,
    });

    expect(harness.metrics.workingSetTokens).toBeLessThan(direct.metrics.workingSetTokens / 2);
    expect(harness.metrics.pointerCount).toBeGreaterThan(0);
    // Canonical state travels under BOTH shapes; only the repository content differs.
    expect(preservesCanonicalTruth(direct.assembled.package.items)).toBe(true);
    expect(preservesCanonicalTruth(harness.assembled.package.items)).toBe(true);
  });

  it('test-failure diagnosis: structured compression versus the raw log', () => {
    const raw = [
      ' FAIL  tests/settings-store.test.ts > SettingsStore > round-trips a value',
      'AssertionError: expected undefined to be "b"',
      ...Array.from({ length: 3_000 }, () => '    at Runner.runTest (node_modules/vitest/dist/chunk.js:1:1)'),
      'Tests  1 failed | 240 passed (241)',
    ].join('\n');

    const compressed = compressArtifact({ kind: 'test-output', content: raw });
    expect(compressed).toBeDefined();

    record({
      scenario: 'test-failure diagnosis (mechanical output)',
      baseline: 'the raw verifier log',
      baselineTokens: estimateTokens(raw),
      strategyTokens: estimateTokens(compressed?.text ?? ''),
      detail: `${compressed?.findings.length ?? 0} distinct findings preserved`,
    });

    expect(estimateTokens(compressed?.text ?? '')).toBeLessThan(estimateTokens(raw) / 10);
    // Failure IDENTITY is preserved: the failing test and its assertion.
    expect(compressed?.text).toContain('tests/settings-store.test.ts');
    expect(compressed?.text).toContain('AssertionError');
    expect(compressed?.text).toContain('1 failed');
  });

  it('repair after failure: deduplication of repeated context', () => {
    const architectureRule: ContextItem = {
      itemId: 'rule-1',
      layer: 'COMPACTED_HISTORY',
      kind: 'summary',
      title: 'Architecture rule',
      content: 'Every store mutation must invalidate its cache entry before returning.',
      createdAt: NOW,
      compacted: false,
      dedupeKey: 'rule:cache-invalidation',
      authority: 'DERIVED',
    };
    // The same rule arriving from four different builders across a long task.
    const duplicated = [
      architectureRule,
      { ...architectureRule, itemId: 'rule-2' },
      { ...architectureRule, itemId: 'rule-3' },
      { ...architectureRule, itemId: 'rule-4' },
    ];
    const deduped = deduplicateItems(duplicated);

    record({
      scenario: 'repair after failure (repeated injection)',
      baseline: 'the same rule injected four times',
      baselineTokens: estimateItemsTokens(duplicated),
      strategyTokens: estimateItemsTokens(deduped.items),
      detail: `${deduped.duplicates.length} duplicate(s) removed`,
    });

    expect(deduped.items).toHaveLength(1);
    expect(deduped.items[0]?.content).toBe(architectureRule.content);
  });

  it('architecture-constrained change: the budget never squeezes out canonical state', async () => {
    const { root, index } = benchmarkRepository();
    // A deliberately small runner window: retrieval must yield, not the contract.
    const small = contextBudgetConfigSchema.parse({
      modelContextTokens: 12_000,
      reservedOutputTokens: 1_500,
      reservedReasoningTokens: 500,
      reservedGrowthTokens: 500,
    });
    const allocation = allocateContextBudget(small, defaultContextAllocationPolicy(), 'MATERIALIZED');

    const built = await buildEfficientContext({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel: 'MODULE_CONTEXT',
      canonicalItems: canonical(),
      budget: small,
      createdAt: NOW,
      planId: 'bench-tight',
      taskId: 'T-arch',
      index,
      rootDir: root,
      query: buildRetrievalQuery({
        taskId: 'T-arch',
        role: 'EXECUTOR',
        contract: CONTRACT,
        objective: 'settings workflow billing telemetry validator probe report codec',
      }),
      maxSelectedItems: 30,
    });

    const optionalTokens = built.plan.selectedWorkingItems
      .filter((entry) => !entry.mandatory)
      .reduce((sum, entry) => sum + entry.estimatedTokens, 0);
    const rankedTokens = rankCandidates(
      index,
      buildRetrievalQuery({
        taskId: 'T-arch',
        role: 'EXECUTOR',
        contract: CONTRACT,
        objective: 'settings workflow billing telemetry validator probe report codec',
      }),
      { maxCandidates: 200 },
    ).reduce((sum, candidate) => sum + Math.ceil(candidate.entry.sizeBytes / 4) + 8, 0);

    record({
      scenario: 'architecture-constrained change (tight budget)',
      baseline: 'materialize every ranked candidate',
      baselineTokens: rankedTokens,
      strategyTokens: built.metrics.workingSetTokens,
      detail:
        `${built.plan.excludedCandidates.length} candidate(s) excluded; optional content ` +
        `${optionalTokens}/${allocation.workingSetBudget} allocated tokens`,
    });

    // OPTIONAL content respects the allocation. A MANDATORY reference may
    // exceed it, deliberately: the contract named that file, and a budget
    // heuristic does not get to overrule the contract. When even that will
    // not fit, assembly fails loudly rather than silently omitting it.
    expect(optionalTokens).toBeLessThanOrEqual(allocation.workingSetBudget);
    expect(built.plan.excludedCandidates.length).toBeGreaterThan(0);
    // The whole point: pressure landed on retrieval, not on canonical truth.
    expect(preservesCanonicalTruth(built.assembled.package.items)).toBe(true);
  });

  it('reports the measured results', () => {
    expect(measurements.length).toBeGreaterThanOrEqual(5);
    const lines = [
      '',
      'Context efficiency benchmark — measured this run',
      '='.repeat(78),
    ];
    for (const entry of measurements) {
      lines.push(
        `${entry.scenario}`,
        `  baseline (${entry.baseline}): ${entry.baselineTokens} estimated tokens`,
        `  vNext.7:  ${entry.strategyTokens} estimated tokens  (${entry.reductionPercent}% reduction)`,
        `  ${entry.detail}`,
      );
    }
    lines.push('='.repeat(78));
    // Printed so a CI run reports what it actually measured rather than
    // leaving the claim to a document nobody regenerates.
    console.log(lines.join('\n'));

    // Every scenario must show a real reduction against its OWN baseline.
    for (const entry of measurements) {
      expect(entry.reductionPercent).toBeGreaterThan(0);
    }
  });
});
