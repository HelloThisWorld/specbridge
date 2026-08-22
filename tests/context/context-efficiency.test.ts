import { describe, expect, it } from 'vitest';
import {
  allocateContextBudget,
  applyExpansion,
  buildContextMetrics,
  buildEfficientContext,
  buildStablePrefix,
  classifyArtifact,
  collapseRepetition,
  componentHashes,
  compressArtifact,
  compressCompilerOutput,
  compressDiff,
  compressTestOutput,
  contextBudgetConfigSchema,
  deduplicateItems,
  defaultContextAllocationPolicy,
  defaultContextExpansionPolicy,
  explainContextSelection,
  fitWorkingSet,
  initialExpansionState,
  isWorthCompressing,
  planContextExpansion,
  removeStaleItems,
  renderContextExplanation,
  withProviderUsage,
} from '@specbridge/context';
import type { ContextItem } from '@specbridge/context';

/**
 * Reduction and budgeting: compression, deduplication, staleness, layer
 * priority, stable prefixes, and bounded expansion. All pure — no fs, no
 * model, no network — so every guarantee here is provable by replay.
 */

const NOW = '2026-08-22T10:00:00.000Z';

let counter = 0;
function item(overrides: Partial<ContextItem> & { layer: ContextItem['layer'] }): ContextItem {
  counter += 1;
  return {
    itemId: `item-${counter}`,
    kind: 'note',
    title: `Item ${counter}`,
    content: 'content',
    createdAt: NOW,
    compacted: false,
    ...overrides,
  };
}

function budget(overrides: Record<string, unknown> = {}) {
  return contextBudgetConfigSchema.parse({
    modelContextTokens: 20_000,
    reservedOutputTokens: 2_000,
    reservedReasoningTokens: 1_000,
    reservedGrowthTokens: 1_000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

describe('deterministic compression', () => {
  it('does not compress data that is already small', () => {
    expect(isWorthCompressing('short error')).toBe(false);
    expect(compressArtifact({ kind: 'log', content: 'short error' })).toBeUndefined();
  });

  it('collapses a thousand repetitions into one entry with a count', () => {
    const raw = ['Running suite', ...Array.from({ length: 1_000 }, () => 'ERR-42 connection refused')].join('\n');
    const result = collapseRepetition(raw);

    expect(result.text.length).toBeLessThan(raw.length / 10);
    expect(result.text).toContain('ERR-42 connection refused');
    expect(result.text).toContain('×1000');
    // One bounded representation, not a thousand copies.
    expect(result.text.split('ERR-42').length - 1).toBeLessThanOrEqual(3);
    expect(result.findings[0]?.count).toBe(1_000);
  });

  it('extracts failing tests, assertions, locations, and counts from test output', () => {
    const raw = [
      'RUN v3.2.7',
      ...Array.from({ length: 200 }, (_, index) => `  ✓ passing case ${index}`),
      ' FAIL  tests/foo-service.test.ts > FooService > loads cached value',
      'AssertionError: expected "stale" to be "fresh"',
      'Expected: fresh',
      'Received: stale',
      '    at Object.<anonymous> (tests/foo-service.test.ts:12:5)',
      ' FAIL  tests/billing.test.ts > Billing > totals',
      'Tests  2 failed | 200 passed (202)',
    ].join('\n');

    const result = compressTestOutput(raw);
    expect(result.structured).toBe(true);
    expect(result.text).toContain('tests/foo-service.test.ts');
    expect(result.text).toContain('AssertionError');
    expect(result.text).toContain('2 failed');
    expect(result.compressedBytes).toBeLessThan(result.sourceBytes);
    expect(result.referencedPaths).toContain('tests/foo-service.test.ts');
  });

  it('extracts code, file, line, and message from compiler output', () => {
    const raw = [
      ...Array.from(
        { length: 50 },
        (_, index) => `packages/context/src/file${index}.ts(12,5): error TS2345: Argument of type 'x' is not assignable.`,
      ),
      "packages/core/src/a.ts(3,1): error TS2551: Property 'foo' does not exist.",
    ].join('\n');
    const result = compressCompilerOutput(raw);
    expect(result.structured).toBe(true);
    expect(result.findings.some((finding) => finding.key === 'TS2345')).toBe(true);
    expect(result.findings.find((finding) => finding.key === 'TS2345')?.count).toBe(50);
    expect(result.text).toContain('TS2551');
  });

  it('reduces a diff to files, counts, and hunk headers', () => {
    const raw = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 111..222 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,4 +1,6 @@ export class Foo',
      ...Array.from({ length: 100 }, (_, index) => `+  const added${index} = ${index};`),
      ...Array.from({ length: 40 }, (_, index) => `-  const removed${index} = ${index};`),
    ].join('\n');
    const result = compressDiff(raw);
    expect(result.text).toContain('src/foo.ts');
    expect(result.text).toContain('100 insertion(s)');
    expect(result.text).toContain('40 deletion(s)');
    expect(result.text).toContain('export class Foo');
    expect(result.compressedBytes).toBeLessThan(result.sourceBytes / 3);
  });

  it('classifies artifacts from declared kind first, then from content', () => {
    expect(classifyArtifact('test-output', '')).toBe('test-output');
    expect(classifyArtifact('log', 'diff --git a/x b/x\n')).toBe('diff');
    expect(classifyArtifact('log', "a.ts(1,1): error TS1000: x\n")).toBe('compiler-output');
    expect(classifyArtifact('log', 'nothing structured here')).toBe('generic');
  });

  it('is deterministic and preserves failure identity across attempts', () => {
    const failure = (detail: string): string =>
      [
        ' FAIL  tests/foo.test.ts > FooService > loads',
        `AssertionError: ${detail}`,
        ...Array.from({ length: 500 }, () => 'noise line that repeats and repeats'),
      ].join('\n');

    const runOne = compressTestOutput(failure('expected "stale" to be "fresh"'));
    const runTwo = compressTestOutput(failure('expected "stale" to be "fresh"'));
    const different = compressTestOutput(failure('expected 1 to be 2'));

    // Same failure twice: byte-identical compression, so any fingerprint
    // computed over it matches across attempts.
    expect(runTwo.text).toBe(runOne.text);
    // A genuinely different failure still looks different after compression.
    expect(different.text).not.toBe(runOne.text);
    expect(runOne.text).toContain('expected "stale" to be "fresh"');
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('authority-aware deduplication', () => {
  it('drops a byte-identical repeat and keeps one copy', () => {
    const result = deduplicateItems([
      item({ layer: 'WORKING_SET', content: 'the same body', dedupeKey: 'repo:src/a.ts' }),
      item({ layer: 'WORKING_SET', content: 'the same body', dedupeKey: 'repo:src/a.ts' }),
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.duplicates[0]?.kind).toBe('identical-content');
    expect(result.savedChars).toBe('the same body'.length);
  });

  it('keeps the higher-authority representation when two items conflict', () => {
    const canonical = item({
      layer: 'COMPACTED_HISTORY',
      kind: 'summary',
      content: 'The retry limit is 3.',
      dedupeKey: 'fact:retry-limit',
      authority: 'CANONICAL',
    });
    const claim = item({
      layer: 'COMPACTED_HISTORY',
      kind: 'summary',
      content: 'I think the retry limit is 5.',
      dedupeKey: 'fact:retry-limit',
      authority: 'CLAIM',
    });

    const result = deduplicateItems([claim, canonical]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.content).toBe('The retry limit is 3.');
    // The conflicting claim is DROPPED, never merged into a compromise.
    expect(result.items[0]?.content).not.toContain('5');
    expect(result.duplicates[0]?.kind).toBe('lower-authority');
  });

  it('deduplicates by provenance path and range, not only by explicit key', () => {
    const provenance = { kind: 'repository-file' as const, path: 'src/a.ts', contentHash: 'h1', artifactRefs: [], sourceHashes: [] };
    const result = deduplicateItems([
      item({ layer: 'WORKING_SET', content: 'body v1', provenance, authority: 'DERIVED' }),
      item({ layer: 'WORKING_SET', content: 'body v2', provenance, authority: 'TRUSTED' }),
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.content).toBe('body v2');
  });

  it('never deduplicates protected layers by default', () => {
    const result = deduplicateItems([
      item({ layer: 'PINNED', content: 'contract', dedupeKey: 'contract' }),
      item({ layer: 'PINNED', content: 'contract', dedupeKey: 'contract' }),
    ]);
    expect(result.items).toHaveLength(2);
  });

  it('preserves the relative order of surviving items', () => {
    const first = item({ layer: 'WORKING_SET', content: 'alpha' });
    const dup = item({ layer: 'WORKING_SET', content: 'beta', dedupeKey: 'k' });
    const last = item({ layer: 'WORKING_SET', content: 'gamma' });
    const dup2 = item({ layer: 'WORKING_SET', content: 'beta', dedupeKey: 'k' });
    const result = deduplicateItems([first, dup, last, dup2]);
    expect(result.items.map((entry) => entry.content)).toEqual(['alpha', 'gamma', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

describe('staleness invalidation', () => {
  const fileItem = (hash: string): ContextItem =>
    item({
      layer: 'WORKING_SET',
      kind: 'file-excerpt',
      content: 'old file body',
      freshness: 'STALE_IF_REPO_CHANGES',
      provenance: { kind: 'repository-file', path: 'src/a.ts', contentHash: hash, artifactRefs: [], sourceHashes: [] },
    });

  it('removes a file body whose content hash no longer matches', () => {
    const result = removeStaleItems([fileItem('old-hash')], {
      currentHashes: new Map([['src/a.ts', 'new-hash']]),
    });
    expect(result.items).toHaveLength(0);
    expect(result.stale[0]?.reason).toBe('REPOSITORY_CONTENT_CHANGED');
  });

  it('keeps a file body whose hash still matches', () => {
    const result = removeStaleItems([fileItem('same')], {
      currentHashes: new Map([['src/a.ts', 'same']]),
    });
    expect(result.items).toHaveLength(1);
  });

  it('keeps an item whose freshness cannot be checked', () => {
    // No hash supplied for the path: not checkable, so not removed. Removing
    // on suspicion would be its own kind of context miss.
    const result = removeStaleItems([fileItem('old')], { currentHashes: new Map() });
    expect(result.items).toHaveLength(1);
  });

  it('removes a diff whose baseline was superseded', () => {
    const diff = item({
      layer: 'RECENT_DELTA',
      kind: 'diff',
      content: 'old diff',
      provenance: { kind: 'diff', baselineRef: 'abc123', artifactRefs: [], sourceHashes: [] },
    });
    const result = removeStaleItems([diff], { baselineRef: 'def456' });
    expect(result.items).toHaveLength(0);
    expect(result.stale[0]?.reason).toBe('BASELINE_SUPERSEDED');
  });

  it('removes state bound to a checkpoint the task has advanced past', () => {
    const old = item({
      layer: 'COMPACTED_HISTORY',
      kind: 'summary',
      content: 'stale summary',
      freshness: 'STALE_IF_CHECKPOINT_ADVANCES',
      source: 'ckpt-1',
    });
    const result = removeStaleItems([old], { checkpointId: 'ckpt-2' });
    expect(result.items).toHaveLength(0);
    expect(result.stale[0]?.reason).toBe('CHECKPOINT_ADVANCED');
  });

  it('never removes protected layers, whatever their declared freshness', () => {
    const pinned = item({
      layer: 'PINNED',
      kind: 'task-contract',
      content: 'contract',
      freshness: 'STALE_IF_REPO_CHANGES',
      provenance: { kind: 'repository-file', path: 'src/a.ts', contentHash: 'old', artifactRefs: [], sourceHashes: [] },
    });
    const result = removeStaleItems([pinned], { currentHashes: new Map([['src/a.ts', 'new']]) });
    expect(result.items).toHaveLength(1);
  });

  it('removes an item the caller knows was superseded by a newer observation', () => {
    const failing = item({ layer: 'RECENT_DELTA', kind: 'test-output', content: 'FAIL' });
    const result = removeStaleItems([failing], { supersededItemIds: [failing.itemId] });
    expect(result.items).toHaveLength(0);
    expect(result.stale[0]?.reason).toBe('SUPERSEDED_BY_NEWER_OBSERVATION');
  });
});

// ---------------------------------------------------------------------------
// Budget allocation
// ---------------------------------------------------------------------------

describe('layer budget allocation', () => {
  it('reserves space for pinned, durable, recovery, and delta before the working set', () => {
    const allocation = allocateContextBudget(budget(), defaultContextAllocationPolicy(), 'MATERIALIZED');
    expect(allocation.usableInputTokens).toBe(16_000);
    expect(allocation.pinnedReserve).toBeGreaterThan(0);
    expect(allocation.durableReserve).toBeGreaterThan(allocation.pinnedReserve);
    expect(allocation.workingSetBudget).toBeLessThan(allocation.usableInputTokens);
  });

  it('gives a POINTER-shaped package a much smaller working-set ceiling', () => {
    const policy = defaultContextAllocationPolicy();
    const direct = allocateContextBudget(budget(), policy, 'MATERIALIZED');
    const harness = allocateContextBudget(budget(), policy, 'POINTER');
    expect(harness.workingSetBudget).toBeLessThan(direct.workingSetBudget / 2);
  });

  it('drops optional working context first and never the pinned or durable layers', () => {
    const tiny = allocateContextBudget(
      budget({ modelContextTokens: 5_000, reservedOutputTokens: 500, reservedReasoningTokens: 250, reservedGrowthTokens: 250 }),
      defaultContextAllocationPolicy(),
      'MATERIALIZED',
    );
    const items = [
      item({ layer: 'PINNED', kind: 'task-contract', content: 'contract'.repeat(50) }),
      item({ layer: 'DURABLE_TASK_STATE', kind: 'objective', content: 'objective'.repeat(50) }),
      item({ layer: 'WORKING_SET', kind: 'file-excerpt', content: 'a'.repeat(6_000) }),
      item({ layer: 'WORKING_SET', kind: 'file-excerpt', content: 'b'.repeat(6_000) }),
      item({ layer: 'CURRENT_ACTION', kind: 'next-action', content: 'do the thing' }),
    ];
    const fitted = fitWorkingSet(items, tiny);
    const layers = fitted.items.map((entry) => entry.layer);
    expect(layers).toContain('PINNED');
    expect(layers).toContain('DURABLE_TASK_STATE');
    expect(layers).toContain('CURRENT_ACTION');
    expect(fitted.dropped.length).toBeGreaterThan(0);
    expect(fitted.dropped.every((entry) => entry.layer === 'WORKING_SET')).toBe(true);
  });

  it('never drops a mandatory working item, even over budget', () => {
    const tiny = allocateContextBudget(
      budget({ modelContextTokens: 5_000, reservedOutputTokens: 500, reservedReasoningTokens: 250, reservedGrowthTokens: 250 }),
      defaultContextAllocationPolicy(),
      'MATERIALIZED',
    );
    const mandatory = item({ layer: 'WORKING_SET', kind: 'file-excerpt', content: 'm'.repeat(20_000) });
    const optional = item({ layer: 'WORKING_SET', kind: 'file-excerpt', content: 'o'.repeat(2_000) });
    const fitted = fitWorkingSet([mandatory, optional], tiny, (entry) => entry.itemId === mandatory.itemId);
    expect(fitted.items.map((entry) => entry.itemId)).toContain(mandatory.itemId);
    expect(fitted.dropped.map((entry) => entry.itemId)).toContain(optional.itemId);
  });
});

// ---------------------------------------------------------------------------
// Stable prefix
// ---------------------------------------------------------------------------

describe('stable prefix', () => {
  const stable = (): ContextItem[] => [
    item({ layer: 'PINNED', kind: 'task-contract', content: 'Implement caching.', freshness: 'IMMUTABLE' }),
    item({ layer: 'PINNED', kind: 'acceptance-criteria', content: 'Cache hits are logged.', freshness: 'IMMUTABLE' }),
  ];

  it('produces the same identity for two attempts whose contract is unchanged', () => {
    const attemptOne = [
      ...stable(),
      item({ layer: 'RECENT_DELTA', kind: 'test-output', content: 'first failure' }),
    ];
    const attemptTwo = [
      ...stable(),
      item({ layer: 'RECENT_DELTA', kind: 'test-output', content: 'a completely different failure' }),
    ];
    const first = buildStablePrefix(attemptOne);
    const second = buildStablePrefix(attemptTwo);
    expect(second.prefixHash).toBe(first.prefixHash);
  });

  it('changes identity when the contract itself changes', () => {
    const changed = [
      item({ layer: 'PINNED', kind: 'task-contract', content: 'Implement caching DIFFERENTLY.', freshness: 'IMMUTABLE' }),
      item({ layer: 'PINNED', kind: 'acceptance-criteria', content: 'Cache hits are logged.', freshness: 'IMMUTABLE' }),
    ];
    expect(buildStablePrefix(changed).prefixHash).not.toBe(buildStablePrefix(stable()).prefixHash);
  });

  it('never pins repository-tracking content into the stable prefix', () => {
    const withFile = [
      ...stable(),
      item({
        layer: 'PINNED',
        kind: 'file-excerpt',
        content: 'source that changes',
        freshness: 'STALE_IF_REPO_CHANGES',
      }),
    ];
    const prefix = buildStablePrefix(withFile);
    expect(prefix.prefixItems.map((entry) => entry.kind)).not.toContain('file-excerpt');
  });

  it('emits stable components before volatile ones', () => {
    const ordered = buildStablePrefix([
      item({ layer: 'RECENT_DELTA', kind: 'test-output', content: 'failure' }),
      ...stable(),
      item({ layer: 'CURRENT_ACTION', kind: 'next-action', content: 'do it' }),
    ]);
    expect(ordered.items[0]?.kind).toBe('task-contract');
    expect(ordered.items.at(-1)?.kind).toBe('next-action');
  });

  it('names the reusable components without claiming any provider caching', () => {
    const hashes = componentHashes(stable());
    expect(hashes.taskContractHash).toBeTruthy();
    expect(hashes.repositoryRulesHash).toBeNull();
    // Reported cache figures come only from providers, never from us.
    const metrics = buildContextMetrics({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel: 'TOP_WORKING_SET',
      items: stable(),
      createdAt: NOW,
    });
    expect(metrics.cachedInputTokens).toBeNull();
    expect(metrics.providerReportedInputTokens).toBeNull();
    expect(metrics.estimatedContextTokens).toBeGreaterThan(0);
  });

  it('keeps estimated and provider-reported tokens separate', () => {
    const metrics = buildContextMetrics({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel: 'TOP_WORKING_SET',
      items: stable(),
      createdAt: NOW,
    });
    const reported = withProviderUsage(metrics, { inputTokens: 4_242, cachedTokens: 1_000, success: true });
    expect(reported.providerReportedInputTokens).toBe(4_242);
    expect(reported.cachedInputTokens).toBe(1_000);
    // The estimate is NOT overwritten by the report.
    expect(reported.estimatedContextTokens).toBe(metrics.estimatedContextTokens);
  });
});

// ---------------------------------------------------------------------------
// Progressive expansion
// ---------------------------------------------------------------------------

describe('bounded progressive expansion', () => {
  const policy = defaultContextExpansionPolicy();
  const state = () => initialExpansionState({ taskId: 'T1', now: NOW });

  it('does not widen without observed evidence of a context miss', () => {
    const decision = planContextExpansion({ strategy: 'PROGRESSIVE', policy, state: state(), signals: [] });
    expect(decision.expand).toBe(false);
    expect(decision.refusalReason).toBe('NO_EVIDENCE_OF_CONTEXT_MISS');
  });

  it('does not widen under SELECTIVE, whatever the evidence', () => {
    const decision = planContextExpansion({
      strategy: 'SELECTIVE',
      policy,
      state: state(),
      signals: ['WORKER_REPORTED_MISSING_CONTEXT'],
    });
    expect(decision.expand).toBe(false);
    expect(decision.refusalReason).toBe('NOT_PROGRESSIVE_STRATEGY');
  });

  it('widens exactly ONE level on evidence — never to the whole repository', () => {
    const decision = planContextExpansion({
      strategy: 'PROGRESSIVE',
      policy,
      state: state(),
      signals: ['WORKER_REPORTED_MISSING_CONTEXT'],
    });
    expect(decision.expand).toBe(true);
    expect(decision.nextLevel).toBe('ADJACENT_DEPENDENCIES');
    expect(decision.returnToReliability).toBe(false);
  });

  it('stops and returns to the reliability planner when the task budget is spent', () => {
    const spent = { ...state(), expansionsThisTask: policy.maxExpansionsPerTask };
    const decision = planContextExpansion({
      strategy: 'PROGRESSIVE',
      policy,
      state: spent,
      signals: ['WORKER_REPORTED_MISSING_CONTEXT'],
    });
    expect(decision.expand).toBe(false);
    expect(decision.refusalReason).toBe('TASK_BUDGET_EXHAUSTED');
    expect(decision.returnToReliability).toBe(true);
  });

  it('stops when the working set has already grown past its ceiling', () => {
    const grown = {
      ...state(),
      baselineWorkingSetTokens: 1_000,
      lastWorkingSetTokens: 4_000,
    };
    const decision = planContextExpansion({
      strategy: 'PROGRESSIVE',
      policy,
      state: grown,
      signals: ['UNKNOWN_SYMBOL_REFERENCE'],
    });
    expect(decision.expand).toBe(false);
    expect(decision.refusalReason).toBe('GROWTH_CEILING_REACHED');
    expect(decision.returnToReliability).toBe(true);
  });

  it('stops at the configured maximum level rather than widening forever', () => {
    const deep = { ...state(), level: policy.maxLevel };
    const decision = planContextExpansion({
      strategy: 'PROGRESSIVE',
      policy,
      state: deep,
      signals: ['FAILURE_IN_UNSELECTED_FILE'],
    });
    expect(decision.expand).toBe(false);
    expect(decision.refusalReason).toBe('MAX_LEVEL_REACHED');
    expect(decision.returnToReliability).toBe(true);
  });

  it('records the evidence and advances the level when it applies an expansion', () => {
    const decision = planContextExpansion({
      strategy: 'PROGRESSIVE',
      policy,
      state: state(),
      signals: ['SELECTED_ARTIFACT_STALE'],
    });
    const advanced = applyExpansion(state(), decision, {
      signals: ['SELECTED_ARTIFACT_STALE'],
      now: NOW,
      workingSetTokens: 1_200,
    });
    expect(advanced.level).toBe('ADJACENT_DEPENDENCIES');
    expect(advanced.expansionsThisTask).toBe(1);
    expect(advanced.observedSignals).toContain('SELECTED_ARTIFACT_STALE');
    expect(advanced.baselineWorkingSetTokens).toBe(1_200);
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration
// ---------------------------------------------------------------------------

describe('pipeline reduction', () => {
  it('compresses bulky tool output but never repository source', async () => {
    const noisyLog = ['Running', ...Array.from({ length: 800 }, () => 'ERR-9 timeout waiting for socket')].join('\n');
    const sourceBody = Array.from({ length: 200 }, (_, index) => `export const value${index} = ${index};`).join('\n');

    const result = await buildEfficientContext({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel: 'TOP_WORKING_SET',
      canonicalItems: [
        item({ layer: 'PINNED', kind: 'task-contract', content: 'Fix the socket timeout.', authority: 'CANONICAL' }),
        item({ layer: 'RECENT_DELTA', kind: 'test-output', content: noisyLog }),
        item({
          layer: 'WORKING_SET',
          kind: 'file-excerpt',
          content: sourceBody,
          provenance: { kind: 'repository-file', path: 'src/socket.ts', contentHash: 'h', artifactRefs: [], sourceHashes: [] },
        }),
        item({ layer: 'CURRENT_ACTION', kind: 'next-action', content: 'Repair the retry loop.' }),
      ],
      budget: budget(),
      createdAt: NOW,
      planId: 'plan-compress',
      taskId: 'T1',
    });

    const items = result.assembled.package.items;
    const log = items.find((entry) => entry.kind === 'test-output');
    const source = items.find((entry) => entry.provenance?.path === 'src/socket.ts');

    expect(result.compressions).toHaveLength(1);
    expect(log?.compacted).toBe(true);
    expect(log?.compression?.sourceBytes).toBeGreaterThan(log?.compression?.compressedBytes ?? 0);
    expect(log?.compression?.sourceHashes[0]).toBeTruthy();
    // Source is NOT compressed: a lossy version of the file being edited is
    // worse than no saving at all.
    expect(source?.content).toBe(sourceBody);
    expect(source?.compacted).toBe(false);
  });

  it('explains the selection without leaking any source content', async () => {
    const result = await buildEfficientContext({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel: 'TOP_WORKING_SET',
      canonicalItems: [
        item({ layer: 'PINNED', kind: 'task-contract', content: 'Fix caching.', authority: 'CANONICAL' }),
        item({
          layer: 'WORKING_SET',
          kind: 'file-excerpt',
          content: 'const SUPER_SECRET_IMPLEMENTATION_DETAIL = 42;',
          provenance: { kind: 'repository-file', path: 'src/a.ts', contentHash: 'abc123def456', artifactRefs: [], sourceHashes: [] },
        }),
      ],
      budget: budget(),
      createdAt: NOW,
      planId: 'plan-explain',
      taskId: 'T1',
    });

    const explanation = explainContextSelection({
      plan: result.plan,
      items: result.assembled.package.items,
      metrics: result.metrics,
    });
    const rendered = renderContextExplanation(explanation);
    expect(rendered).toContain('Context plan plan-explain');
    expect(rendered).not.toContain('SUPER_SECRET_IMPLEMENTATION_DETAIL');
    expect(JSON.stringify(explanation)).not.toContain('SUPER_SECRET_IMPLEMENTATION_DETAIL');
  });
});
