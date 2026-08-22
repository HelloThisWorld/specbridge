import { describe, expect, it } from 'vitest';
import { assessHealth, detectOscillation, detectRunaway, strategyKey } from '@specbridge/orchestration';
import type { AttemptActivity, ReliabilityObservation, RunawayThresholds } from '@specbridge/orchestration';

/**
 * No-progress, oscillation, and runaway detection.
 *
 * Every signal here is arithmetic over two hashes and a strategy key. None
 * of it reads agent prose, so no worker can influence its own health state by
 * describing its work differently — which is the reason the signals are
 * hashes rather than summaries.
 */

const THRESHOLDS = { sameFailureThreshold: 2, sameDiffThreshold: 2, oscillationThreshold: 3 };

function observation(
  index: number,
  failure: string | null,
  diff: string | null,
): ReliabilityObservation {
  return {
    attemptId: `at-${index}`,
    attemptNumber: index,
    failureFingerprint: failure,
    diffFingerprint: diff,
    strategyKey: 'sk-1',
    evaluationStatus: failure === null ? 'PASS' : 'FAIL',
    lane: 'LOCAL',
    at: `2026-01-0${index}T00:00:00.000Z`,
  };
}

const IDLE_ACTIVITY: AttemptActivity = {
  toolCalls: 5,
  commandRuns: 2,
  durationMs: 1_000,
  contextUsageAfter: 0.2,
  testLoops: 1,
  emptyDiff: false,
};

const RUNAWAY_THRESHOLDS: RunawayThresholds = {
  maxToolCallsPerAttempt: 100,
  maxCommandRunsPerAttempt: 50,
  maxAttemptWallTimeMs: 600_000,
  maxContextUsageRatio: 0.95,
  maxTestLoopsPerAttempt: 10,
};

describe('Test F — the same failure fingerprint twice is stagnation', () => {
  it('counts repeated fingerprints across materially different attempts', () => {
    const window = [
      observation(1, 'fp-same', 'diff-a'),
      observation(2, 'fp-same', 'diff-b'),
    ];
    const assessment = assessHealth({ window, thresholds: THRESHOLDS });

    expect(assessment.repeatedFailureCount).toBe(2);
    expect(assessment.health).toBe('STALLED');
    expect(assessment.reasons.join(' ')).toContain('recurred 2 times');
  });

  it('stays DEGRADED while each attempt fails differently', () => {
    const window = [
      observation(1, 'fp-a', 'diff-a'),
      observation(2, 'fp-b', 'diff-b'),
      observation(3, 'fp-c', 'diff-c'),
    ];
    const assessment = assessHealth({ window, thresholds: THRESHOLDS });

    // Failing productively is not the same as being stuck: three attempts
    // that each eliminate a different hypothesis are making progress.
    expect(assessment.health).toBe('DEGRADED');
  });
});

describe('Test G — the same diff plus the same failure is STALLED', () => {
  it('reports STALLED when two attempts end byte-identical', () => {
    const window = [
      observation(1, 'fp-same', 'diff-same'),
      observation(2, 'fp-same', 'diff-same'),
    ];
    const assessment = assessHealth({ window, thresholds: THRESHOLDS });

    expect(assessment.sameDiffRun).toBe(2);
    expect(assessment.health).toBe('STALLED');
    expect(assessment.reasons.join(' ')).toContain('identical working tree');
  });

  it('does not report STALLED when the tree matches but the failure moved on', () => {
    const window = [
      observation(1, 'fp-a', 'diff-same'),
      observation(2, 'fp-b', 'diff-same'),
    ];
    const assessment = assessHealth({ window, thresholds: THRESHOLDS });

    expect(assessment.sameDiffRun).toBe(0);
    expect(assessment.health).toBe('DEGRADED');
  });
});

describe('Test H — edit oscillation', () => {
  it('detects A then B then A with the failure unchanged', () => {
    const window = [
      observation(1, 'fp-same', 'diff-a'),
      observation(2, 'fp-same', 'diff-b'),
      observation(3, 'fp-same', 'diff-a'),
    ];

    expect(detectOscillation(window, 3)).toBe(true);
    const assessment = assessHealth({ window, thresholds: THRESHOLDS });
    expect(assessment.health).toBe('OSCILLATING');
    expect(assessment.reasons.join(' ')).toContain('no fixed point');
  });

  it('does not call a revisit oscillation when the failure changed', () => {
    // Reproducing an earlier tree while failing differently is new
    // information about the problem, not a loop.
    const window = [
      observation(1, 'fp-a', 'diff-a'),
      observation(2, 'fp-b', 'diff-b'),
      observation(3, 'fp-c', 'diff-a'),
    ];
    expect(detectOscillation(window, 3)).toBe(false);
  });

  it('does not call straight repetition oscillation — that is STALLED', () => {
    const window = [
      observation(1, 'fp-same', 'diff-a'),
      observation(2, 'fp-same', 'diff-a'),
      observation(3, 'fp-same', 'diff-a'),
    ];
    expect(detectOscillation(window, 3)).toBe(false);
    expect(assessHealth({ window, thresholds: THRESHOLDS }).health).toBe('STALLED');
  });
});

describe('Test I — runaway attempts are stopped, not tolerated', () => {
  it('fires on the tool-call ceiling', () => {
    const signals = detectRunaway(
      { ...IDLE_ACTIVITY, toolCalls: 100 },
      RUNAWAY_THRESHOLDS,
    );
    expect(signals).toContain('TOOL_CALL_BUDGET');
  });

  it('fires on wall time and on unsafe context growth', () => {
    expect(
      detectRunaway({ ...IDLE_ACTIVITY, durationMs: 600_000 }, RUNAWAY_THRESHOLDS),
    ).toContain('WALL_TIME_BUDGET');
    expect(
      detectRunaway({ ...IDLE_ACTIVITY, contextUsageAfter: 0.99 }, RUNAWAY_THRESHOLDS),
    ).toContain('CONTEXT_GROWTH');
  });

  it('fires on a repeated test/command loop', () => {
    expect(detectRunaway({ ...IDLE_ACTIVITY, testLoops: 12 }, RUNAWAY_THRESHOLDS)).toContain(
      'REPEATED_COMMAND_LOOP',
    );
  });

  it('never fires on metrics the runtime did not report', () => {
    // An unobservable attempt must not be stopped for the ABSENCE of
    // evidence that it overran — only for evidence that it did.
    const unobservable: AttemptActivity = {
      toolCalls: null,
      commandRuns: null,
      durationMs: null,
      contextUsageAfter: null,
      testLoops: null,
      emptyDiff: false,
    };
    expect(detectRunaway(unobservable, RUNAWAY_THRESHOLDS)).toEqual([]);
  });

  it('outranks every other health state', () => {
    const window = [observation(1, 'fp-a', 'diff-a')];
    const assessment = assessHealth({
      window,
      thresholds: THRESHOLDS,
      runawaySignals: ['TOOL_CALL_BUDGET'],
    });
    expect(assessment.health).toBe('RUNAWAY');
  });
});

describe('strategy identity', () => {
  it('is stable for the same tuple and distinct across every dimension', () => {
    const base = { lane: 'LOCAL', executionMode: 'HARNESS', planRevision: 2, freshContext: false };
    expect(strategyKey(base)).toBe(strategyKey({ ...base }));
    expect(strategyKey(base)).not.toBe(strategyKey({ ...base, lane: 'SUBSCRIPTION' }));
    expect(strategyKey(base)).not.toBe(strategyKey({ ...base, executionMode: 'DIRECT_MODEL' }));
    expect(strategyKey(base)).not.toBe(strategyKey({ ...base, planRevision: 3 }));
    expect(strategyKey(base)).not.toBe(strategyKey({ ...base, freshContext: true }));
  });
});

describe('a passing attempt resets health', () => {
  it('reports HEALTHY even over a history of failures', () => {
    const window = [
      observation(1, 'fp-same', 'diff-same'),
      observation(2, 'fp-same', 'diff-same'),
      observation(3, null, null),
    ];
    expect(assessHealth({ window, thresholds: THRESHOLDS, passed: true }).health).toBe('HEALTHY');
  });
});
