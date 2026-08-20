import { describe, expect, it } from 'vitest';
import {
  ContextBudgetError,
  ContextLifecycleManager,
  assembleContextPackage,
  assessContextHealth,
  appendDelta,
  contextBudgetConfigSchema,
  defaultContextBudgetConfig,
  emergencyCompact,
  estimateItemsTokens,
  estimateTokens,
  foldDeltasIntoCheckpoint,
  microCompact,
  milestoneCompact,
  passthroughNativeCompaction,
  renderContextPackage,
  usableInputTokens,
} from '@specbridge/context';
import type { ContextItem, ContextLifecycleEvent } from '@specbridge/context';

/**
 * The context lifecycle: budgets, health, assembly, and the three compaction
 * levels. Everything here is pure and deterministic — no fs, no model, no
 * network — because the survival guarantee must be provable by replay.
 */

let counter = 0;
function item(overrides: Partial<ContextItem> & { layer: ContextItem['layer'] }): ContextItem {
  counter += 1;
  return {
    itemId: `item-${String(counter).padStart(4, '0')}`,
    kind: 'note',
    title: `Item ${counter}`,
    content: 'content',
    createdAt: '2026-08-20T10:00:00.000Z',
    compacted: false,
    ...overrides,
  };
}

/** A small deterministic budget so tests exercise pressure cheaply. */
function smallBudget(overrides: Record<string, unknown> = {}) {
  return contextBudgetConfigSchema.parse({
    modelContextTokens: 4_000,
    reservedOutputTokens: 500,
    reservedReasoningTokens: 250,
    reservedGrowthTokens: 250,
    ...overrides,
  });
}

function pinnedContract(): ContextItem {
  return item({
    layer: 'PINNED',
    kind: 'task-contract',
    title: 'TaskContract',
    content: 'Implement workflow validation. AcceptanceCriteria: all workflows validate; tests pass.',
  });
}

describe('context budget and health', () => {
  it('reserves headroom: usable input is smaller than the model window', () => {
    const budget = smallBudget();
    expect(usableInputTokens(budget)).toBe(3_000);
  });

  it('token estimation is deterministic and conservative', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('maps usage onto the closed health vocabulary at the configured thresholds', () => {
    const budget = smallBudget(); // usable 3000
    expect(assessContextHealth(budget, 1_000)).toBe('HEALTHY'); // 33%
    expect(assessContextHealth(budget, 1_800)).toBe('PREPARE'); // 60%
    expect(assessContextHealth(budget, 2_200)).toBe('PROACTIVE_COMPACT'); // 73%
    expect(assessContextHealth(budget, 2_600)).toBe('FORCE_COMPACT'); // 87%
    expect(assessContextHealth(budget, 2_800)).toBe('OVERFLOW'); // 93%
  });

  it('thresholds are configurable but must stay ordered', () => {
    expect(() =>
      contextBudgetConfigSchema.parse({
        proactiveCompactionThreshold: 0.9,
        emergencyCompactionThreshold: 0.7,
      }),
    ).toThrow();
    const custom = contextBudgetConfigSchema.parse({ proactiveCompactionThreshold: 0.6 });
    expect(custom.proactiveCompactionThreshold).toBe(0.6);
  });

  it('defaults follow the initial policy (~55/70/85/90)', () => {
    const budget = defaultContextBudgetConfig();
    expect(budget.prepareThreshold).toBe(0.55);
    expect(budget.proactiveCompactionThreshold).toBe(0.7);
    expect(budget.emergencyCompactionThreshold).toBe(0.85);
    expect(budget.hardStopThreshold).toBe(0.9);
  });
});

describe('micro compaction', () => {
  it('collapses repeated observations to the newest and compresses bulk', () => {
    const items = [
      pinnedContract(),
      item({ layer: 'WORKING_SET', kind: 'file-excerpt', dedupeKey: 'file:src/a.ts', content: 'old read' }),
      item({ layer: 'WORKING_SET', kind: 'file-excerpt', dedupeKey: 'file:src/a.ts', content: 'new read' }),
      item({ layer: 'COMPACTED_HISTORY', kind: 'log', content: `line\n`.repeat(2_000) }),
    ];
    const result = microCompact(items, '2026-08-20T10:01:00.000Z');
    const files = result.items.filter((entry) => entry.dedupeKey === 'file:src/a.ts');
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toBe('new read');
    const log = result.items.find((entry) => entry.kind === 'log');
    expect(log?.compacted).toBe(true);
    expect(log?.content.length).toBeLessThan(3_000);
    expect(log?.content).toContain('[compacted:');
    expect(result.record.estimatedTokensAfter).toBeLessThan(result.record.estimatedTokensBefore);
  });

  it('never touches pinned items and preserves unfolded recent deltas raw', () => {
    const bulky = `x`.repeat(20_000);
    const items = [
      item({ layer: 'PINNED', kind: 'log', content: bulky }),
      item({ layer: 'RECENT_DELTA', kind: 'test-output', content: bulky }),
      item({ layer: 'RECENT_DELTA', kind: 'test-output', content: bulky, foldedIntoCheckpointId: 'cp-1' }),
    ];
    const result = microCompact(items, '2026-08-20T10:01:00.000Z');
    expect(result.items[0]?.content).toBe(bulky); // pinned untouched
    expect(result.items[1]?.content).toBe(bulky); // unfolded delta untouched
    expect(result.items[2]?.compacted).toBe(true); // folded delta compressible
  });
});

describe('milestone compaction', () => {
  it('drops only checkpoint-folded items and installs the checkpoint summary', () => {
    const summary = item({
      layer: 'COMPACTED_HISTORY',
      kind: 'summary',
      title: 'Checkpoint cp-7',
      content: 'Completed: validation module. Next: wire the service.',
    });
    const items = [
      pinnedContract(),
      item({ layer: 'RECENT_DELTA', kind: 'diff', foldedIntoCheckpointId: 'cp-7' }),
      item({ layer: 'RECENT_DELTA', kind: 'diff' }), // not folded — must survive
      item({ layer: 'WORKING_SET', kind: 'file-excerpt', foldedIntoCheckpointId: 'cp-7' }),
    ];
    const result = milestoneCompact({
      items,
      at: '2026-08-20T10:02:00.000Z',
      checkpointId: 'cp-7',
      checkpointSummaryItem: summary,
    });
    expect(result.items.map((entry) => entry.layer)).toEqual([
      'PINNED',
      'RECENT_DELTA',
      'COMPACTED_HISTORY',
    ]);
    expect(result.record.checkpointId).toBe('cp-7');
  });
});

describe('emergency compaction', () => {
  it('keeps protected layers, newest deltas, and a summary of the dropped rest', () => {
    const items = [
      pinnedContract(),
      item({ layer: 'DURABLE_TASK_STATE', kind: 'failed-approach', title: 'Failed approach', content: 'Approach X failed because Y.' }),
      ...Array.from({ length: 10 }, () => item({ layer: 'WORKING_SET', kind: 'file-excerpt' })),
      ...Array.from({ length: 6 }, (_, index) => item({ layer: 'RECENT_DELTA', kind: 'diff', title: `Delta ${index}` })),
      item({ layer: 'CURRENT_ACTION', kind: 'next-action', title: 'Next', content: 'Wire the service.' }),
    ];
    const result = emergencyCompact({
      items,
      at: '2026-08-20T10:03:00.000Z',
      checkpointId: 'cp-9',
      keepNewestDeltas: 2,
    });
    const layers = result.items.map((entry) => entry.layer);
    expect(layers).toContain('PINNED');
    expect(layers).toContain('DURABLE_TASK_STATE');
    expect(layers).toContain('CURRENT_ACTION');
    expect(result.items.filter((entry) => entry.layer === 'RECENT_DELTA')).toHaveLength(2);
    expect(result.items.filter((entry) => entry.layer === 'WORKING_SET')).toHaveLength(0);
    const summary = result.items.find((entry) => entry.kind === 'summary');
    expect(summary?.content).toContain('file-excerpt');
    expect(result.record.detail).toContain('dropped');
  });
});

describe('context assembly (Test C: compaction under budget)', () => {
  it('assembles synthetic history exceeding the budget into a bounded package', () => {
    const budget = smallBudget();
    const failed = item({
      layer: 'DURABLE_TASK_STATE',
      kind: 'failed-approach',
      title: 'FailedApproaches',
      content: 'Approach X failed because Y (do not retry blindly).',
    });
    const delta = item({ layer: 'RECENT_DELTA', kind: 'test-output', title: 'Latest failure', content: 'expected 3, got 2' });
    const items: ContextItem[] = [
      pinnedContract(),
      failed,
      // Far more raw history than the 3000-token budget can hold:
      ...Array.from({ length: 30 }, (_, index) =>
        item({ layer: 'WORKING_SET', kind: 'log', title: `Log ${index}`, content: `entry\n`.repeat(500) }),
      ),
      delta,
      item({ layer: 'CURRENT_ACTION', kind: 'next-action', title: 'Next action', content: 'Continue wiring.' }),
    ];
    expect(estimateItemsTokens(items)).toBeGreaterThan(usableInputTokens(budget));

    const assembled = assembleContextPackage({
      items,
      budget,
      createdAt: '2026-08-20T10:04:00.000Z',
      checkpointId: 'cp-1',
    });
    const pkg = assembled.package;
    expect(pkg.usage.estimatedTokens).toBeLessThanOrEqual(usableInputTokens(budget));
    // Pinned, durable (failed approaches), the newest delta, and the current
    // action all survived; the package fits.
    const rendered = renderContextPackage(pkg);
    expect(rendered).toContain('TaskContract');
    expect(rendered).toContain('Approach X failed because Y');
    expect(rendered).toContain('expected 3, got 2');
    expect(rendered).toContain('Continue wiring.');
    expect(pkg.compactions.length).toBeGreaterThan(0);
    // Layer order is deterministic: PINNED before CURRENT_ACTION.
    expect(rendered.indexOf('## PINNED')).toBeLessThan(rendered.indexOf('## CURRENT_ACTION'));
  });

  it('fails explicitly instead of silently dropping pinned context', () => {
    const budget = smallBudget();
    const items = [
      item({ layer: 'PINNED', kind: 'task-contract', content: 'x'.repeat(20_000) }),
      pinnedContract(),
    ];
    expect(() =>
      assembleContextPackage({ items, budget, createdAt: '2026-08-20T10:05:00.000Z', checkpointId: 'cp-1' }),
    ).toThrow(ContextBudgetError);
  });

  it('without a persisted checkpoint, emergency discard is refused, not silent', () => {
    const budget = smallBudget();
    const items = [
      pinnedContract(),
      // Durable state is protected; without a checkpoint the assembler may
      // not discard it, so an over-budget durable layer must fail loudly.
      ...Array.from({ length: 40 }, () =>
        item({ layer: 'DURABLE_TASK_STATE', kind: 'decision', content: 'd'.repeat(2_000) }),
      ),
    ];
    expect(() =>
      assembleContextPackage({ items, budget, createdAt: '2026-08-20T10:06:00.000Z' }),
    ).toThrow(/checkpoint|budget/i);
  });
});

describe('delta log', () => {
  it('evicts folded deltas before unfolded ones and appendDelta rejects other layers', () => {
    const folded = foldDeltasIntoCheckpoint(
      [item({ layer: 'RECENT_DELTA', title: 'old folded' })],
      'cp-1',
    );
    let deltas = folded;
    deltas = appendDelta(deltas, item({ layer: 'RECENT_DELTA', title: 'fresh 1' }), { maxItems: 2 });
    deltas = appendDelta(deltas, item({ layer: 'RECENT_DELTA', title: 'fresh 2' }), { maxItems: 2 });
    expect(deltas.map((entry) => entry.title)).toEqual(['fresh 1', 'fresh 2']);
    expect(() => appendDelta(deltas, item({ layer: 'WORKING_SET' }), { maxItems: 2 })).toThrow();
  });
});

describe('ContextLifecycleManager (Test D: repeated compaction cycles)', () => {
  it('sustains cumulative context of >5x the window across repeated compactions', () => {
    const budget = smallBudget(); // usable 3000, window 4000
    const events: ContextLifecycleEvent[] = [];
    const manager = new ContextLifecycleManager({
      budget,
      clock: () => new Date('2026-08-20T10:07:00.000Z'),
      onEvent: (event) => events.push(event),
    });

    manager.add(pinnedContract());
    manager.add(
      item({
        layer: 'DURABLE_TASK_STATE',
        kind: 'failed-approach',
        title: 'FailedApproaches',
        content: 'Approach X failed because Y.',
      }),
    );
    manager.add(
      item({
        layer: 'DURABLE_TASK_STATE',
        kind: 'decision',
        title: 'ImportantDecisions',
        content: 'Chose zod schemas over ad-hoc JSON.',
      }),
    );
    manager.add(item({ layer: 'CURRENT_ACTION', kind: 'next-action', title: 'Next', content: 'Keep implementing.' }));

    // Simulate a long execution: every cycle produces bulky working context
    // and a delta; every few cycles a checkpoint milestone folds them away.
    let checkpointSeq = 0;
    for (let cycle = 0; cycle < 40; cycle += 1) {
      manager.add(
        item({
          layer: 'WORKING_SET',
          kind: 'log',
          title: `Cycle ${cycle} output`,
          content: `cycle ${cycle} `.repeat(300), // ~700 tokens each
          dedupeKey: `cycle-log-${cycle % 5}`,
        }),
      );
      manager.add(
        item({ layer: 'RECENT_DELTA', kind: 'diff', title: `Delta ${cycle}`, content: `diff of cycle ${cycle}` }),
      );
      if (manager.health() === 'PROACTIVE_COMPACT' || manager.health() === 'FORCE_COMPACT' || manager.health() === 'OVERFLOW') {
        checkpointSeq += 1;
        const checkpointId = `cp-${checkpointSeq}`;
        // Milestone: durable state is (conceptually) persisted, then folded.
        manager.milestoneCompact(checkpointId);
        const assembled = manager.assemble({ checkpointId });
        expect(assembled.package.usage.estimatedTokens).toBeLessThanOrEqual(manager.usableBudgetTokens());
      }
    }

    // Cumulative pressure exceeded five windows even though the live context
    // always stayed within one.
    expect(manager.cumulativeTokens()).toBeGreaterThan(5 * budget.modelContextTokens);
    expect(checkpointSeq).toBeGreaterThanOrEqual(3);

    // After many compactions the critical state is STILL intact.
    const final = manager.assemble({ checkpointId: `cp-${checkpointSeq}` });
    const rendered = renderContextPackage(final.package);
    expect(rendered).toContain('Implement workflow validation'); // TaskContract
    expect(rendered).toContain('AcceptanceCriteria');
    expect(rendered).toContain('Approach X failed because Y.'); // failed approach
    expect(rendered).toContain('Chose zod schemas'); // decision
    expect(rendered).toContain('Keep implementing.'); // current action
    expect(events.some((event) => event.type === 'context_threshold_reached')).toBe(true);
    expect(events.filter((event) => event.type === 'context_compacted').length).toBeGreaterThanOrEqual(3);
  });

  it('emergency pressure is a normal operation, not a failure (Test E)', () => {
    const budget = smallBudget();
    const manager = new ContextLifecycleManager({ budget, clock: () => new Date('2026-08-20T10:08:00.000Z') });
    manager.add(pinnedContract());
    manager.add(item({ layer: 'CURRENT_ACTION', kind: 'next-action', title: 'Next', content: 'Continue.' }));
    // Rapid growth far beyond the emergency threshold in one burst.
    for (let index = 0; index < 20; index += 1) {
      manager.add(
        item({ layer: 'WORKING_SET', kind: 'tool-result', title: `Burst ${index}`, content: 'y'.repeat(4_000) }),
      );
    }
    expect(manager.health()).toBe('OVERFLOW');
    // Checkpoint (simulated as persisted), then assembly compacts and continues.
    const assembled = manager.assemble({ checkpointId: 'cp-emergency' });
    expect(assembled.package.usage.estimatedTokens).toBeLessThanOrEqual(manager.usableBudgetTokens());
    expect(assembled.package.compactions.some((record) => record.level === 'emergency')).toBe(true);
    expect(manager.health()).not.toBe('OVERFLOW');
    const rendered = renderContextPackage(assembled.package);
    expect(rendered).toContain('TaskContract');
    expect(rendered).toContain('Continue.');
  });
});

describe('native compaction boundary', () => {
  it('passthrough adapters report their mode honestly and never claim canonical state', async () => {
    const automatic = passthroughNativeCompaction('claude-code', 'automatic');
    expect(automatic.supportsNativeCompaction()).toBe(true);
    const compacted = await automatic.compact({ providerId: 'claude-code', sessionId: 's-1' });
    expect(compacted.ok).toBe(true);
    expect(compacted.detail).toContain('own session working memory');

    const none = passthroughNativeCompaction('local-model', 'none');
    expect(none.supportsNativeCompaction()).toBe(false);
    const refused = await none.compact({ providerId: 'local-model', sessionId: 's-2' });
    expect(refused.ok).toBe(false);
    const resumed = await none.resume({ providerId: 'local-model', sessionId: 's-2' });
    expect(resumed.detail).toContain('SpecBridge durable state');
  });
});
