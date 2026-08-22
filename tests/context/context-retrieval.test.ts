import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RepositoryContextIndex,
  allocateContextBudget,
  buildEfficientContext,
  buildRetrievalQuery,
  buildRepositoryIndex,
  contextBudgetConfigSchema,
  defaultContextAllocationPolicy,
  extractPathReferences,
  extractSection,
  extractSymbolReferences,
  rankCandidates,
  rerankCandidates,
  selectWorkingSet,
} from '@specbridge/context';
import type { ContextItem, RerankInference } from '@specbridge/context';

/**
 * Deterministic retrieval: the query, the ranking, section selection, the
 * advisory rerank, and the shape-aware selection they feed.
 *
 * The assertions are deliberately about FACTS ("the file the failure named
 * is present") rather than about scores. A test that asserted a score would
 * pass while the property it was protecting silently broke.
 */

const NOW = '2026-08-22T10:00:00.000Z';
const created: string[] = [];

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-retrieval-'));
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

const FILES: Record<string, string> = {
  'src/foo-service.ts': [
    "import { helper } from './helper.js';",
    '',
    'export class FooService {',
    '  load(): string {',
    '    return helper();',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/helper.ts': 'export function helper(): string {\n  return "ok";\n}\n',
  'src/unrelated-widget.ts': 'export function renderWidget(): void {\n  return;\n}\n',
  'src/billing-report.ts': 'export function billingReport(): number {\n  return 1;\n}\n',
  'tests/foo-service.test.ts': [
    "import { FooService } from '../src/foo-service.js';",
    '',
    'it("loads", () => { new FooService().load(); });',
    '',
  ].join('\n'),
  'docs/architecture.md': '# Architecture\n\nFooService loads things.\n',
};

function indexed(files: Record<string, string> = FILES): {
  root: string;
  index: RepositoryContextIndex;
} {
  const root = workspace(files);
  return { root, index: new RepositoryContextIndex(buildRepositoryIndex({ rootDir: root, now: NOW })) };
}

function budget(overrides: Record<string, unknown> = {}) {
  return contextBudgetConfigSchema.parse({
    modelContextTokens: 40_000,
    reservedOutputTokens: 4_000,
    reservedReasoningTokens: 2_000,
    reservedGrowthTokens: 2_000,
    ...overrides,
  });
}

function pinned(content = 'Implement FooService.load caching.'): ContextItem {
  return {
    itemId: 'pinned-task-contract',
    layer: 'PINNED',
    kind: 'task-contract',
    title: 'TaskContract',
    content,
    createdAt: NOW,
    compacted: false,
    authority: 'CANONICAL',
    freshness: 'IMMUTABLE',
  };
}

function currentAction(content = 'Fix the failing FooService test.'): ContextItem {
  return {
    itemId: 'current-action',
    layer: 'CURRENT_ACTION',
    kind: 'next-action',
    title: 'Continue from here',
    content,
    createdAt: NOW,
    compacted: false,
    authority: 'CANONICAL',
  };
}

describe('retrieval query', () => {
  it('extracts literal path references from durable text, stripping line suffixes', () => {
    const paths = extractPathReferences(
      'Failure at src/foo-service.ts:42:7 while loading `packages/context/src/items.ts`.',
    );
    expect(paths).toContain('src/foo-service.ts');
    expect(paths).toContain('packages/context/src/items.ts');
  });

  it('extracts conservative symbol references, including stack-frame leaves', () => {
    const symbols = extractSymbolReferences('TypeError: undefined\n    at FooService.load (x.ts:3)');
    expect(symbols).toContain('FooService');
    expect(symbols).toContain('load');
  });

  it('grounds the query in durable state, never in conversation', () => {
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'DIAGNOSER',
      contract: 'Cache results in src/foo-service.ts.',
      failureText: 'FooService.load returned stale data (tests/foo-service.test.ts:3)',
      changedPaths: ['src/helper.ts'],
    });
    expect(query.contractPaths).toContain('src/foo-service.ts');
    expect(query.failurePaths).toContain('tests/foo-service.test.ts');
    expect(query.changedPaths).toContain('src/helper.ts');
    expect(query.symbols).toContain('FooService');
    expect(query.role).toBe('DIAGNOSER');
  });
});

describe('deterministic ranking', () => {
  it('includes an explicitly named path regardless of weaker lexical signals', () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'EXECUTOR',
      // Every lexical token points at billing; only the contract names foo.
      contract: 'Rework billing report totals. See src/foo-service.ts for the shared loader.',
      objective: 'billing billing billing report totals',
    });
    const ranked = rankCandidates(index, query);
    const foo = ranked.find((candidate) => candidate.path === 'src/foo-service.ts');
    expect(foo).toBeDefined();
    expect(foo?.mandatory).toBe(true);
    expect(foo?.eligibleAtDepth).toBe(0);
  });

  it('ranks failure-relevant implementation and test above unrelated files', () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'DIAGNOSER',
      failureText: 'FooService failed to load: expected "ok"',
    });
    const ranked = rankCandidates(index, query);
    const order = ranked.map((candidate) => candidate.path);
    expect(order[0]).toBe('src/foo-service.ts');
    expect(order.indexOf('src/foo-service.ts')).toBeLessThan(order.indexOf('src/unrelated-widget.ts'));
    const foo = ranked.find((candidate) => candidate.path === 'src/foo-service.ts');
    expect(foo?.signals.some((signal) => signal.reason === 'SYMBOL_MATCH')).toBe(true);
  });

  it('is reproducible: the same inputs produce the same order', () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', failureText: 'FooService broken' });
    expect(rankCandidates(index, query).map((c) => [c.path, c.score])).toEqual(
      rankCandidates(index, query).map((c) => [c.path, c.score]),
    );
  });

  it('never ranks a path the caller excluded by policy', () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', failureText: 'FooService broken' });
    const ranked = rankCandidates(index, query, { excludedPaths: ['src/foo-service.ts'] });
    expect(ranked.map((candidate) => candidate.path)).not.toContain('src/foo-service.ts');
  });

  it('bounds how many CHANGED files may be mandatory', () => {
    const { index } = indexed();
    const everyPath = index.entries.map((entry) => entry.path);
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'EXECUTOR',
      // A branch-wide diff: every file is "changed", which says something
      // about the branch and nothing about the task.
      changedPaths: everyPath,
      contract: 'The fix belongs in src/foo-service.ts.',
    });
    const ranked = rankCandidates(index, query, { maxMandatoryChangedFiles: 2 });
    const mandatory = ranked.filter((candidate) => candidate.mandatory).map((c) => c.path);

    // The contract-named path stays mandatory however large the diff is —
    // policy chose it, and a working tree does not overrule policy.
    expect(mandatory).toContain('src/foo-service.ts');
    // But "everything is changed" cannot make everything undroppable.
    expect(mandatory.length).toBeLessThan(everyPath.length);
    // The non-mandatory changed files are still candidates, just droppable.
    expect(ranked.length).toBeGreaterThan(mandatory.length);
  });

  it('gives each agent role a different context shape', () => {
    const { index } = indexed();
    const shared = {
      taskId: 'T1',
      contract: 'Fix caching in src/foo-service.ts.',
      failureText: 'FooService failed to load: expected "ok" (tests/foo-service.test.ts:3)',
    };
    const diagnoser = rankCandidates(index, buildRetrievalQuery({ ...shared, role: 'DIAGNOSER' }));
    const replanner = rankCandidates(index, buildRetrievalQuery({ ...shared, role: 'REPLANNER' }));

    const scoreOf = (ranked: typeof diagnoser, path: string): number =>
      ranked.find((candidate) => candidate.path === path)?.score ?? 0;

    // A diagnoser weights the failing test more; a replanner weights the
    // contract and the dependency structure. Same durable state, different
    // packages — which is the point of role profiles.
    expect(scoreOf(diagnoser, 'tests/foo-service.test.ts')).toBeGreaterThan(
      scoreOf(replanner, 'tests/foo-service.test.ts'),
    );
  });

  it('gates dependency and module proximity behind deeper expansion levels', () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', failureText: 'FooService broken' });
    const ranked = rankCandidates(index, query);
    const helper = ranked.find((candidate) => candidate.path === 'src/helper.ts');
    expect(helper?.eligibleAtDepth).toBeGreaterThanOrEqual(2);
  });
});

describe('section selection', () => {
  const big = [
    "import { a } from './a.js';",
    '',
    ...Array.from({ length: 200 }, (_, index) => `export function filler${index}(): number { return ${index}; }`),
    'export function targetFunction(): string {',
    '  return "target";',
    '}',
    ...Array.from({ length: 200 }, (_, index) => `export function tail${index}(): number { return ${index}; }`),
  ].join('\n');

  it('returns small files whole', () => {
    const section = extractSection({ content: 'export const a = 1;\n' });
    expect(section.sectioned).toBe(false);
    expect(section.wholeFileReason).toBe('small-enough');
  });

  it('centres a section on a named symbol and keeps the import preamble', () => {
    const section = extractSection({ content: big, symbols: ['targetFunction'] });
    expect(section.sectioned).toBe(true);
    expect(section.symbol).toBe('targetFunction');
    expect(section.content).toContain('targetFunction');
    expect(section.content).toContain("import { a } from './a.js';");
    expect(section.content.length).toBeLessThan(big.length);
  });

  it('returns the whole bounded file rather than inventing a boundary', () => {
    const opaque = 'x'.repeat(20_000);
    const section = extractSection({ content: opaque, symbols: ['nothingHere'] });
    expect(section.sectioned).toBe(false);
    expect(section.wholeFileReason).toBe('no-reliable-structure');
    expect(section.content).toBe(opaque);
  });
});

describe('shape-aware selection', () => {
  it('materializes selected sources for a DIRECT (MATERIALIZED) package', () => {
    const { root, index } = indexed();
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'EXECUTOR',
      contract: 'Fix src/foo-service.ts',
      failureText: 'FooService failed',
    });
    const result = selectWorkingSet({
      index,
      rootDir: root,
      candidates: rankCandidates(index, query),
      query,
      shape: 'MATERIALIZED',
      allocation: allocateContextBudget(budget(), defaultContextAllocationPolicy(), 'MATERIALIZED'),
      expansionLevel: 'TOP_WORKING_SET',
      createdAt: NOW,
    });
    expect(result.selected.map((entry) => entry.path)).toContain('src/foo-service.ts');
    const item = result.items.find((entry) => entry.provenance?.path === 'src/foo-service.ts');
    expect(item?.content).toContain('class FooService');
    expect(item?.provenance?.contentHash).toBeTruthy();
    expect(item?.authority).toBe('TRUSTED');
    expect(item?.freshness).toBe('STALE_IF_REPO_CHANGES');
  });

  it('sends pointers instead of bodies for a HARNESS (POINTER) package', () => {
    const { root, index } = indexed();
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'EXECUTOR',
      // No mandatory reference: nothing forces materialization.
      objective: 'FooService loading behaviour',
      failureText: 'FooService failed',
    });
    const candidates = rankCandidates(index, query);
    const result = selectWorkingSet({
      index,
      rootDir: root,
      candidates,
      query,
      shape: 'POINTER',
      allocation: allocateContextBudget(budget(), defaultContextAllocationPolicy(), 'POINTER'),
      expansionLevel: 'TOP_WORKING_SET',
      createdAt: NOW,
    });
    expect(result.pointers.length).toBeGreaterThan(0);
    expect(result.pointers.map((pointer) => pointer.path)).toContain('src/foo-service.ts');
    expect(result.items.every((item) => !item.content.includes('return helper();'))).toBe(true);
    expect(
      result.excluded.some((entry) => entry.reason === 'HARNESS_READS_REPOSITORY'),
    ).toBe(true);
  });

  it('points at a MANDATORY reference in a POINTER package rather than materializing it', () => {
    const { root, index } = indexed();
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'EXECUTOR',
      contract: 'The change must live in src/foo-service.ts.',
    });
    const result = selectWorkingSet({
      index,
      rootDir: root,
      candidates: rankCandidates(index, query),
      query,
      shape: 'POINTER',
      allocation: allocateContextBudget(budget(), defaultContextAllocationPolicy(), 'POINTER'),
      expansionLevel: 'TOP_WORKING_SET',
      createdAt: NOW,
    });
    // The reference REACHES the worker — it cannot be ranked away — but as a
    // pointer, flagged and placed first. A tool-capable worker reads current
    // bytes; a copy here would only be current as of assembly.
    expect(result.selected).toHaveLength(0);
    expect(result.pointers[0]?.path).toBe('src/foo-service.ts');
    expect(result.pointers[0]?.mandatory).toBe(true);
    expect(result.items.every((item) => !item.content.includes('return helper();'))).toBe(true);
  });

  it('uses CURRENT bytes when the index entry is stale, and reports the refresh', () => {
    const { root, index } = indexed();
    writeFileSync(
      path.join(root, 'src/foo-service.ts'),
      'export class FooService {\n  load(): string { return "REWRITTEN"; }\n}\n',
      'utf8',
    );
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', contract: 'Fix src/foo-service.ts' });
    const result = selectWorkingSet({
      index,
      rootDir: root,
      candidates: rankCandidates(index, query),
      query,
      shape: 'MATERIALIZED',
      allocation: allocateContextBudget(budget(), defaultContextAllocationPolicy(), 'MATERIALIZED'),
      expansionLevel: 'TOP_WORKING_SET',
      createdAt: NOW,
    });
    expect(result.refreshedPaths).toContain('src/foo-service.ts');
    const item = result.items.find((entry) => entry.provenance?.path === 'src/foo-service.ts');
    expect(item?.content).toContain('REWRITTEN');
    expect(item?.content).not.toContain('return helper();');
  });

  it('excludes a file that no longer exists rather than shipping its indexed snapshot', () => {
    const { root, index } = indexed();
    rmSync(path.join(root, 'src/foo-service.ts'));
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', contract: 'Fix src/foo-service.ts' });
    const result = selectWorkingSet({
      index,
      rootDir: root,
      candidates: rankCandidates(index, query),
      query,
      shape: 'MATERIALIZED',
      allocation: allocateContextBudget(budget(), defaultContextAllocationPolicy(), 'MATERIALIZED'),
      expansionLevel: 'TOP_WORKING_SET',
      createdAt: NOW,
    });
    expect(result.selected.map((entry) => entry.path)).not.toContain('src/foo-service.ts');
    expect(
      result.excluded.find((entry) => entry.path === 'src/foo-service.ts')?.reason,
    ).toBe('STALE_INDEX_ENTRY');
  });
});

describe('advisory local reranking', () => {
  const ordering = (paths: string[]): RerankInference =>
    async () => ({ ok: true, text: JSON.stringify({ ordering: paths }) });

  it('reorders a bounded candidate set and records that it ran', async () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', objective: 'foo helper widget' });
    const candidates = rankCandidates(index, query);
    const reversed = [...candidates].map((candidate) => candidate.path).reverse();
    const result = await rerankCandidates({ query, candidates, inference: ordering(reversed) });
    expect(result.applied).toBe(true);
    expect(result.candidates.map((candidate) => candidate.path)).not.toEqual(
      candidates.map((candidate) => candidate.path),
    );
  });

  it('cannot drop a mandatory candidate', async () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'EXECUTOR',
      contract: 'The fix belongs in src/foo-service.ts.',
      objective: 'widget helper billing',
    });
    const candidates = rankCandidates(index, query);
    // The model returns an ordering that omits the mandatory file entirely.
    const withoutMandatory = candidates
      .filter((candidate) => candidate.path !== 'src/foo-service.ts')
      .map((candidate) => candidate.path);
    const result = await rerankCandidates({ query, candidates, inference: ordering(withoutMandatory) });
    expect(result.candidates.map((candidate) => candidate.path)).toContain('src/foo-service.ts');
    expect(result.candidates[0]?.path).toBe('src/foo-service.ts');
  });

  it('discards invented paths and keeps omitted ones at their deterministic position', async () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', objective: 'foo helper widget' });
    const candidates = rankCandidates(index, query);
    const result = await rerankCandidates({
      query,
      candidates,
      inference: ordering(['src/does-not-exist.ts', 'src/helper.ts']),
    });
    const paths = result.candidates.map((candidate) => candidate.path);
    expect(paths).not.toContain('src/does-not-exist.ts');
    expect(new Set(paths).size).toBe(new Set(candidates.map((c) => c.path)).size);
  });

  it('falls back to the deterministic order when the reranker is unavailable', async () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', objective: 'foo helper' });
    const candidates = rankCandidates(index, query);
    const result = await rerankCandidates({
      query,
      candidates,
      inference: async () => ({ ok: false, problem: 'endpoint unreachable' }),
    });
    expect(result.applied).toBe(false);
    expect(result.candidates.map((c) => c.path)).toEqual(candidates.map((c) => c.path));
  });

  it('never reads file content: the prompt carries metadata only', async () => {
    const { index } = indexed();
    const query = buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', objective: 'foo helper' });
    let seenPrompt = '';
    await rerankCandidates({
      query,
      candidates: rankCandidates(index, query),
      inference: async (request) => {
        seenPrompt = request.userPrompt;
        return { ok: true, text: JSON.stringify({ ordering: [] }) };
      },
    });
    expect(seenPrompt).toContain('src/foo-service.ts');
    expect(seenPrompt).not.toContain('return helper();');
  });
});

describe('pipeline: strategies', () => {
  const canonical = (): ContextItem[] => [pinned(), currentAction()];

  it('LEGACY performs no retrieval and no compression', async () => {
    const { root, index } = indexed();
    const result = await buildEfficientContext({
      strategy: 'LEGACY',
      shape: 'MATERIALIZED',
      expansionLevel: 'TOP_WORKING_SET',
      canonicalItems: canonical(),
      budget: budget(),
      createdAt: NOW,
      planId: 'plan-legacy',
      taskId: 'T1',
      index,
      rootDir: root,
      query: buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', contract: 'Fix src/foo-service.ts' }),
    });
    expect(result.plan.selectedWorkingItems).toHaveLength(0);
    expect(result.metrics.strategy).toBe('LEGACY');
    expect(result.assembled.package.items.map((item) => item.itemId)).toEqual([
      'pinned-task-contract',
      'current-action',
    ]);
  });

  it('SELECTIVE builds a bounded working set with provenance and a plan', async () => {
    const { root, index } = indexed();
    const result = await buildEfficientContext({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel: 'TOP_WORKING_SET',
      canonicalItems: canonical(),
      budget: budget(),
      createdAt: NOW,
      planId: 'plan-selective',
      taskId: 'T1',
      index,
      rootDir: root,
      query: buildRetrievalQuery({
        taskId: 'T1',
        role: 'EXECUTOR',
        contract: 'Fix src/foo-service.ts',
        failureText: 'FooService failed',
      }),
    });
    expect(result.plan.selectedWorkingItems.map((entry) => entry.path)).toContain('src/foo-service.ts');
    expect(result.plan.strategy).toBe('SELECTIVE');
    expect(result.plan.componentHashes['taskContractHash']).toBeTruthy();
    // Canonical layers survive selection untouched.
    const ids = result.assembled.package.items.map((item) => item.itemId);
    expect(ids).toContain('pinned-task-contract');
    expect(ids).toContain('current-action');
    // The plan records references, never bodies.
    expect(JSON.stringify(result.plan)).not.toContain('return helper();');
  });

  it('produces materially less materialized context for POINTER than MATERIALIZED', async () => {
    // A realistic file size matters here: on a toy repository a pointer line
    // can genuinely cost more than the file it points at, and asserting the
    // opposite would be asserting a fixture artifact rather than the policy.
    const body = (name: string): string =>
      [
        `import { helper } from './helper.js';`,
        '',
        `export class ${name} {`,
        ...Array.from(
          { length: 60 },
          (_, index) => `  method${index}(): string { return helper() + "${name}-${index}"; }`,
        ),
        '}',
        '',
      ].join('\n');
    const { root, index } = indexed({
      'src/foo-service.ts': body('FooService'),
      'src/helper.ts': body('Helper'),
      'src/unrelated-widget.ts': body('Widget'),
      'src/billing-report.ts': body('BillingReport'),
      'tests/foo-service.test.ts': "import { FooService } from '../src/foo-service.js';\nit('loads', () => {});\n",
    });
    const query = buildRetrievalQuery({
      taskId: 'T1',
      role: 'EXECUTOR',
      objective: 'FooService helper widget billing loading',
    });
    const common = {
      strategy: 'SELECTIVE' as const,
      expansionLevel: 'TOP_WORKING_SET' as const,
      canonicalItems: canonical(),
      budget: budget(),
      createdAt: NOW,
      taskId: 'T1',
      index,
      rootDir: root,
      query,
    };
    const direct = await buildEfficientContext({ ...common, shape: 'MATERIALIZED', planId: 'p-direct' });
    const harness = await buildEfficientContext({ ...common, shape: 'POINTER', planId: 'p-harness' });

    expect(harness.metrics.workingSetTokens).toBeLessThan(direct.metrics.workingSetTokens);
    expect(harness.metrics.pointerCount).toBeGreaterThan(0);
    expect(direct.metrics.selectedFiles).toBeGreaterThan(harness.metrics.selectedFiles);
  });

  it('is deterministic with the reranker disabled', async () => {
    const { root, index } = indexed();
    const build = async () =>
      buildEfficientContext({
        strategy: 'SELECTIVE',
        shape: 'MATERIALIZED',
        expansionLevel: 'TOP_WORKING_SET',
        canonicalItems: canonical(),
        budget: budget(),
        createdAt: NOW,
        planId: 'plan-repeat',
        taskId: 'T1',
        index,
        rootDir: root,
        query: buildRetrievalQuery({ taskId: 'T1', role: 'EXECUTOR', failureText: 'FooService failed' }),
      });
    const first = await build();
    const second = await build();
    expect(second.plan).toEqual(first.plan);
  });
});
