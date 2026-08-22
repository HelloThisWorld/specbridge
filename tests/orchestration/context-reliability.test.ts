import { describe, expect, it } from 'vitest';
import { planRecovery } from '@specbridge/orchestration';
import type { AssessedFailure, RecoveryPlanInput } from '@specbridge/orchestration';
import { assessFailure } from '@specbridge/orchestration';
import { classifyFailure } from '@specbridge/orchestration';
import { reliabilityPolicySchema } from '@specbridge/core';
import {
  ContextLifecycleManager,
  appendDelta,
  buildEfficientContext,
  compressTestOutput,
  contextBudgetConfigSchema,
  estimateItemsTokens,
  foldDeltasIntoCheckpoint,
  itemsInLayer,
  unfoldedDeltas,
} from '@specbridge/context';
import type { ContextItem } from '@specbridge/context';

/**
 * Where vNext.7 meets vNext.6 and vNext.1: context-miss attribution, the
 * bounded-widening recovery decision, delta baselines, and the guarantee
 * that selective retrieval and compression do not weaken the survival
 * properties the first phase established.
 */

const NOW = '2026-08-22T10:00:00.000Z';

function policy() {
  return reliabilityPolicySchema.parse({});
}

function budgetView() {
  return {
    remainingAttempts: 5,
    remainingRepairs: 3,
    remainingReplans: 2,
    remainingJobReplans: 4,
    remainingTransientRetries: 2,
    remainingLocalAttempts: 2,
    remainingWallClockMs: 3_600_000,
    stagnationCount: 0,
    apiRemainingUsd: null,
    apiEncumberedUsd: null,
    exhausted: [],
  } as unknown as RecoveryPlanInput['budget'];
}

function resource(overrides: Record<string, unknown> = {}): RecoveryPlanInput['resource'] {
  return {
    subscriptionAvailable: true,
    subscriptionReturnsInMs: null,
    subscriptionWorkerConfigured: true,
    apiAuthorized: false,
    apiBudgetAvailable: false,
    localAvailable: true,
    localHarnessAvailable: false,
    ...overrides,
  };
}

function assessed(overrides: Partial<AssessedFailure> = {}): AssessedFailure {
  return assessFailure({
    classified: classifyFailure({
      category: 'VERIFICATION_FAILURE',
      message: 'The trusted verifier failed.',
      source: 'test',
      exitCode: 1,
      output: 'FAIL settings-store.test.ts',
    }),
    history: [],
    health: 'DEGRADED',
    ...overrides,
  } as never);
}

function planInput(overrides: Partial<RecoveryPlanInput> = {}): RecoveryPlanInput {
  return {
    assessment: assessed(),
    health: 'DEGRADED',
    budget: budgetView(),
    policy: policy(),
    lane: 'LOCAL',
    executionMode: 'DIRECT_MODEL',
    planRevision: 1,
    planValid: true,
    history: [],
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: null,
    resource: resource(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §28 / §95 — context miss is not intelligence failure
// ---------------------------------------------------------------------------

describe('context-miss attribution', () => {
  it('observed context insufficiency moves the failure SOURCE to CONTEXT', () => {
    const withoutSignals = assessed();
    const withSignals = assessed({
      contextInsufficiencySignals: ['WORKER_REPORTED_MISSING_CONTEXT'],
    } as never);

    expect(withoutSignals.source).toBe('IMPLEMENTATION');
    expect(withSignals.source).toBe('CONTEXT');
    expect(withSignals.basis).toBe('DETERMINISTIC_EVIDENCE');
    // The stable failure CATEGORY is untouched: what went wrong has not
    // changed, only whose fault it was.
    expect(withSignals.category).toBe(withoutSignals.category);
  });

  it('broken verification machinery still outranks a context signal', () => {
    const both = assessed({
      contextInsufficiencySignals: ['WORKER_REPORTED_MISSING_CONTEXT'],
      verificationInfrastructureBroken: true,
    } as never);
    // Nothing was judged, so nothing about context or code is established.
    expect(both.source).toBe('VERIFICATION_INFRASTRUCTURE');
  });

  it('widens context instead of escalating intelligence', () => {
    const plan = planRecovery(
      planInput({
        assessment: assessed({
          contextInsufficiencySignals: ['FAILURE_IN_UNSELECTED_FILE'],
        } as never),
        contextExpansion: {
          available: true,
          nextLevel: 'ADJACENT_DEPENDENCIES',
          reason: 'Observed context insufficiency; retrieval widens one level.',
          exhausted: false,
        },
      }),
    );

    expect(plan.action).toBe('EXPAND_CONTEXT');
    expect(plan.reasonCode).toBe('CONTEXT_INSUFFICIENT_EXPAND');
    expect(plan.strategyChange).toBe('CONTEXT');
    // Critically: prepaid quota was NOT spent on a question about the model.
    expect(plan.nextStrategy.lane).toBe('LOCAL');
    expect(plan.requestedCapability).toBeUndefined();
  });

  it('changes strategy — not context — once widening is exhausted', () => {
    const plan = planRecovery(
      planInput({
        assessment: assessed({
          contextInsufficiencySignals: ['UNKNOWN_SYMBOL_REFERENCE'],
        } as never),
        contextExpansion: {
          available: false,
          nextLevel: 'MODULE_CONTEXT',
          reason: 'Context has been widened as far as its budget allows.',
          exhausted: true,
        },
      }),
    );
    expect(plan.action).toBe('REPLAN');
    expect(plan.reasonCode).toBe('CONTEXT_EXPANSION_EXHAUSTED');
  });

  it('leaves vNext.6 recovery untouched when no context signal is observed', () => {
    const plan = planRecovery(planInput());
    expect(plan.action).toBe('REPAIR');
    expect(plan.reasonCode).toBe('VERIFICATION_FAILED_REPAIRABLE');
  });

  it('a hard boundary still outranks an available context expansion', () => {
    const plan = planRecovery(
      planInput({
        assessment: assessed({
          classified: classifyFailure({
            category: 'SAFETY_POLICY',
            message: 'A protected path was modified.',
            source: 'preflight',
          }),
          contextInsufficiencySignals: ['WORKER_REPORTED_MISSING_CONTEXT'],
        } as never),
        contextExpansion: {
          available: true,
          nextLevel: 'ADJACENT_DEPENDENCIES',
          reason: 'available',
          exhausted: false,
        },
      }),
    );
    expect(plan.action).toBe('BLOCK');
    expect(plan.reasonCode).toBe('HARD_BOUNDARY');
  });
});

// ---------------------------------------------------------------------------
// §97 — compression preserves failure identity across attempts
// ---------------------------------------------------------------------------

describe('failure identity through compression', () => {
  const noisy = (assertion: string): string =>
    [
      ' FAIL  tests/settings-store.test.ts > SettingsStore > round-trips a value',
      `AssertionError: ${assertion}`,
      ...Array.from({ length: 1_500 }, () => '    at Runner.runTest (chunk.js:1:1)'),
      'Tests  1 failed | 12 passed (13)',
    ].join('\n');

  it('two attempts with the same failure keep the same fingerprint after compression', () => {
    const first = compressTestOutput(noisy('expected undefined to be "b"'));
    const second = compressTestOutput(noisy('expected undefined to be "b"'));

    const fingerprintOf = (text: string): string =>
      classifyFailure({
        category: 'VERIFICATION_FAILURE',
        message: 'verifier failed',
        source: 'test',
        exitCode: 1,
        output: text,
      }).fingerprint;

    // Same raw failure → identical compression → identical fingerprint, so
    // vNext.6 no-progress detection still recognises the repetition.
    expect(second.text).toBe(first.text);
    expect(fingerprintOf(second.text)).toBe(fingerprintOf(first.text));

    // A genuinely different failure remains distinguishable.
    const different = compressTestOutput(noisy('expected 1 to be 2'));
    expect(fingerprintOf(different.text)).not.toBe(fingerprintOf(first.text));
  });
});

// ---------------------------------------------------------------------------
// §99 — every delta is traceable to a baseline
// ---------------------------------------------------------------------------

describe('delta baselines', () => {
  const delta = (id: string, baselineRef: string): ContextItem => ({
    itemId: id,
    layer: 'RECENT_DELTA',
    kind: 'diff',
    title: `Diff ${id}`,
    content: 'diff --git a/x b/x\n+added\n',
    createdAt: NOW,
    compacted: false,
    provenance: { kind: 'diff', baselineRef, artifactRefs: [], sourceHashes: [] },
  });

  it('a delta names what it is a change RELATIVE TO', () => {
    const items = [delta('d1', 'abc123'), delta('d2', 'abc123')];
    for (const item of items) {
      expect(item.provenance?.baselineRef).toBeTruthy();
    }
  });

  it('folded deltas collapse into the checkpoint that made them durable', () => {
    let deltas: ContextItem[] = [];
    for (let index = 0; index < 3; index += 1) {
      deltas = appendDelta(deltas, delta(`d${index}`, 'abc123'), { maxItems: 10 });
    }
    expect(unfoldedDeltas(deltas)).toHaveLength(3);

    const folded = foldDeltasIntoCheckpoint(deltas, 'ckpt-7');
    expect(unfoldedDeltas(folded)).toHaveLength(0);
    for (const item of folded) expect(item.foldedIntoCheckpointId).toBe('ckpt-7');
  });
});

// ---------------------------------------------------------------------------
// §104 — repeated compaction still survives selective retrieval
// ---------------------------------------------------------------------------

describe('AutoCompact regression under selective retrieval', () => {
  function smallBudget() {
    return contextBudgetConfigSchema.parse({
      modelContextTokens: 16_000,
      reservedOutputTokens: 1_000,
      reservedReasoningTokens: 500,
      reservedGrowthTokens: 500,
    });
  }

  const pinned: ContextItem = {
    itemId: 'pinned-task-contract',
    layer: 'PINNED',
    kind: 'task-contract',
    title: 'TaskContract',
    content: 'Implement workflow validation. AcceptanceCriteria: all workflows validate.',
    createdAt: NOW,
    compacted: false,
    authority: 'CANONICAL',
    freshness: 'IMMUTABLE',
  };
  const failedApproach: ContextItem = {
    itemId: 'durable-failed-approaches',
    layer: 'DURABLE_TASK_STATE',
    kind: 'failed-approach',
    title: 'Failed approaches (do not repeat)',
    content: '- Regex validation — failed because: cannot express nested stages.',
    createdAt: NOW,
    compacted: false,
    authority: 'CANONICAL',
  };

  it('cumulative context far beyond the window still preserves canonical truth', () => {
    const manager = new ContextLifecycleManager({ budget: smallBudget(), clock: () => new Date(NOW) });
    manager.add(pinned);
    manager.add(failedApproach);

    // Drive many multiples of the window through the lifecycle.
    for (let round = 0; round < 80; round += 1) {
      manager.add({
        itemId: `delta-${round}`,
        layer: 'RECENT_DELTA',
        kind: 'test-output',
        title: `Verification round ${round}`,
        content: `FAIL round-${round}.test.ts\n${'noise line of verifier output\n'.repeat(400)}`,
        createdAt: NOW,
        compacted: false,
      });
      if (round % 5 === 4) {
        manager.milestoneCompact(`ckpt-${round}`, {
          itemId: `checkpoint-summary-${round}`,
          layer: 'COMPACTED_HISTORY',
          kind: 'summary',
          title: `Durable checkpoint ${round}`,
          content: `Rounds up to ${round} folded into durable state.`,
          createdAt: NOW,
          compacted: true,
        });
      }
      manager.assemble({ checkpointId: `ckpt-${round}` });
    }

    expect(manager.cumulativeTokens()).toBeGreaterThan(manager.usableBudgetTokens() * 5);
    const rendered = manager.currentItems().map((item) => item.content).join('\n');
    expect(rendered).toContain('Implement workflow validation.');
    expect(rendered).toContain('Regex validation');
    expect(manager.compactionHistory().length).toBeGreaterThan(3);
  });

  it('a compressed, deduplicated package still fits and still carries the contract', async () => {
    const noisy = `FAIL x.test.ts\n${'    at Runner.runTest (chunk.js:1:1)\n'.repeat(3_000)}`;
    const result = await buildEfficientContext({
      strategy: 'SELECTIVE',
      shape: 'MATERIALIZED',
      expansionLevel: 'TOP_WORKING_SET',
      canonicalItems: [
        pinned,
        failedApproach,
        {
          itemId: 'delta-noise',
          layer: 'RECENT_DELTA',
          kind: 'test-output',
          title: 'Latest verification output',
          content: noisy,
          createdAt: NOW,
          compacted: false,
        },
        {
          itemId: 'current-action',
          layer: 'CURRENT_ACTION',
          kind: 'next-action',
          title: 'Continue from here',
          content: 'Repair the validator.',
          createdAt: NOW,
          compacted: false,
          authority: 'CANONICAL',
        },
      ],
      budget: smallBudget(),
      createdAt: NOW,
      planId: 'plan-compact',
      taskId: 'T1',
      checkpointId: 'ckpt-1',
    });

    const items = result.assembled.package.items;
    expect(estimateItemsTokens(items)).toBeLessThanOrEqual(result.plan.budget.usableInputTokens);
    const rendered = items.map((item) => item.content).join('\n');
    expect(rendered).toContain('Implement workflow validation.');
    expect(rendered).toContain('Regex validation');
    expect(itemsInLayer(items, 'RECENT_DELTA')[0]?.compacted).toBe(true);
  });
});
