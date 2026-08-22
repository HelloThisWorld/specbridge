import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '@specbridge/core';
import type { AdaptiveSchedulerPolicy } from '@specbridge/core';
import {
  benchmarkSchedulers,
  buildTaskSignature,
  replaySchedulingDecisions,
} from '@specbridge/orchestration';
import type {
  AdaptiveObservation,
  BenchmarkTask,
  CandidateSet,
  ExecutionCandidate,
  QuotaForecast,
  ReplayCase,
  TaskSignature,
} from '@specbridge/orchestration';
import { aggregateProfiles } from '@specbridge/orchestration';

/**
 * The vNext.8 offline scheduler benchmark and historical replay.
 *
 * Both are deterministic and fully offline. What each is allowed to claim is
 * the thing under test as much as the numbers are:
 *
 *   replay     reports DECISIONS — where adaptive would have recommended
 *              something else — and never asserts an outcome for a candidate
 *              that was not executed.
 *   benchmark  reports SIMULATED totals over a synthetic workload whose
 *              outcome probabilities are fixture data, and says so on the
 *              report itself.
 *
 * The fixture world below is deliberately the one the phase describes:
 * DIRECT is fast and weak on agentic work, HARNESS is slower and stronger.
 * None of it is encoded in production policy.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z');
const POLICY: AdaptiveSchedulerPolicy = defaultAgentConfig().orchestration.jobs.scheduler.adaptive;

const AGENTIC: TaskSignature = buildTaskSignature({
  category: 'mechanical-refactor',
  complexity: 'MEDIUM',
  localSuitability: 'LOCAL_TRY',
  executionShape: 'AGENTIC',
  deterministicVerificationAvailable: true,
});

const FORECAST: QuotaForecast = {
  fiveHourRemainingRatio: 0.8,
  fiveHourResetAt: null,
  timeToFiveHourResetMs: 3 * 3_600_000,
  weeklyRemainingRatio: 0.9,
  weeklyResetAt: null,
  timeToWeeklyResetMs: 5 * 86_400_000,
  observedFiveHourBurnRatePerMinute: null,
  projectedBurnUntilFiveHourReset: null,
  schedulerMode: 'NORMAL',
  telemetryFreshness: 'FRESH',
  observedAt: NOW.toISOString(),
  forecastAt: NOW.toISOString(),
};

const DIRECT: ExecutionCandidate = {
  candidateId: 'LOCAL/DIRECT_MODEL/local-llamacpp/qwen-a/LEGACY',
  lane: 'LOCAL',
  executionMode: 'DIRECT_MODEL',
  runner: 'local-llamacpp',
  model: 'qwen-a',
  profile: null,
  contextStrategy: 'LEGACY',
  computeLocality: 'LOCAL',
  heuristicChoice: true,
  handoffOverheadMs: 2_000,
  strategyKey: 'direct',
};

const HARNESS: ExecutionCandidate = {
  candidateId: 'LOCAL/HARNESS/deepseek-harness/qwen-a/LEGACY',
  lane: 'LOCAL',
  executionMode: 'HARNESS',
  runner: 'deepseek-harness',
  model: 'qwen-a',
  profile: null,
  contextStrategy: 'LEGACY',
  computeLocality: 'LOCAL',
  heuristicChoice: false,
  handoffOverheadMs: 30_000,
  strategyKey: 'harness',
};

const CANDIDATES: CandidateSet = { eligible: [DIRECT, HARNESS], rejected: [] };

/** Fixture ground truth: DIRECT is fast and weak here, HARNESS slow and strong. */
const GROUND_TRUTH = {
  [DIRECT.candidateId]: {
    successProbability: 0.2,
    wallTimeMs: 5 * 60_000,
    fiveHourBurnRatio: 0,
    costUsd: 0,
    contextTokens: 25_000,
  },
  [HARNESS.candidateId]: {
    successProbability: 0.85,
    wallTimeMs: 14 * 60_000,
    fiveHourBurnRatio: 0,
    costUsd: 0,
    contextTokens: 120_000,
  },
};

function observation(overrides: Partial<AdaptiveObservation>): AdaptiveObservation {
  return {
    attemptId: 'a',
    jobId: 'job',
    nodeId: 'n',
    taskId: 't',
    signatureKey: AGENTIC.key,
    taskCategory: AGENTIC.category,
    taskComplexity: AGENTIC.complexity,
    candidateKey: DIRECT.candidateId,
    targetKey: 'LOCAL/DIRECT_MODEL',
    lane: 'LOCAL',
    executionMode: 'DIRECT_MODEL',
    runner: 'local-llamacpp',
    model: 'qwen-a',
    contextStrategy: 'LEGACY',
    runnerVersion: null,
    label: 'VERIFIED_SUCCESS',
    failureSource: null,
    executionHealth: 'HEALTHY',
    recoveryAction: null,
    attemptNumber: 1,
    wallTimeMs: 5 * 60_000,
    inputTokens: 25_000,
    outputTokens: 2_000,
    fiveHourBurnRatio: null,
    costUsd: null,
    contextTokens: 25_000,
    contextExpansions: 0,
    contextInsufficient: false,
    safetyEvent: false,
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** History matching the fixture world, evenly interleaved and recent. */
function history(): AdaptiveObservation[] {
  const spread = (index: number): string =>
    new Date(NOW.getTime() - 3 * 86_400_000 + index * 3_600_000).toISOString();
  const evenly = (index: number, total: number, successes: number): boolean =>
    Math.floor((index * successes) / total) < Math.floor(((index + 1) * successes) / total);

  const direct = Array.from({ length: 20 }, (_unused, index) =>
    observation({
      attemptId: `d-${index}`,
      label: evenly(index, 20, 4) ? 'VERIFIED_SUCCESS' : 'IMPLEMENTATION_FAILURE',
      observedAt: spread(index),
    }),
  );
  const harness = Array.from({ length: 20 }, (_unused, index) =>
    observation({
      attemptId: `h-${index}`,
      candidateKey: HARNESS.candidateId,
      targetKey: 'LOCAL/HARNESS',
      executionMode: 'HARNESS',
      runner: 'deepseek-harness',
      wallTimeMs: 14 * 60_000,
      inputTokens: 120_000,
      contextTokens: 120_000,
      label: evenly(index, 20, 17) ? 'VERIFIED_SUCCESS' : 'IMPLEMENTATION_FAILURE',
      observedAt: spread(index),
    }),
  );
  return [...direct, ...harness];
}

describe('vNext.8 offline scheduler benchmark', () => {
  it('reports simulated totals for both schedulers and labels them as simulated', () => {
    const tasks: BenchmarkTask[] = Array.from({ length: 40 }, (_unused, index) => ({
      id: `task-${index}`,
      signature: AGENTIC,
      candidates: CANDIDATES,
      forecast: FORECAST,
      priorSuccessProbability: 0.6,
      outcomes: GROUND_TRUTH,
      maxAttempts: 3,
    }));

    const report = benchmarkSchedulers({
      tasks,
      history: history(),
      policy: POLICY,
      now: NOW,
    });

    expect(report.simulated).toBe(true);
    expect(report.disclaimer).toContain('not a claim about real-world savings');

    // The adaptive scheduler routes this workload to the candidate the
    // fixture world actually rewards, so it completes more tasks and wastes
    // less work getting there.
    expect(report.adaptive.completedTasks).toBeGreaterThan(report.heuristic.completedTasks);
    expect(report.adaptive.failedAttempts).toBeLessThan(report.heuristic.failedAttempts);
    expect(report.adaptive.simulatedFailedWallTimeMs).toBeLessThan(
      report.heuristic.simulatedFailedWallTimeMs,
    );
    expect(report.adaptive.attemptsPerCompletedTask).toBeLessThan(
      report.heuristic.attemptsPerCompletedTask ?? Number.POSITIVE_INFINITY,
    );
    // Neither scheduler is allowed to spend money on a LOCAL workload.
    expect(report.adaptive.simulatedApiCostUsd).toBe(0);
    expect(report.heuristic.simulatedApiCostUsd).toBe(0);
  });

  it('with no history the adaptive scheduler matches the heuristic exactly', () => {
    const tasks: BenchmarkTask[] = Array.from({ length: 25 }, (_unused, index) => ({
      id: `cold-${index}`,
      signature: AGENTIC,
      candidates: CANDIDATES,
      forecast: FORECAST,
      priorSuccessProbability: 0.6,
      outcomes: GROUND_TRUTH,
      maxAttempts: 3,
    }));
    const report = benchmarkSchedulers({ tasks, history: [], policy: POLICY, now: NOW });
    // Cold start must reproduce the deterministic scheduler exactly: this is
    // the regression guard on "adaptive never changes behavior it has no
    // evidence for". `heuristicFallbacks` is bookkeeping only the adaptive
    // side keeps, so it is compared separately rather than expected to match.
    const { heuristicFallbacks: adaptiveFallbacks, ...adaptiveWork } = report.adaptive;
    const { heuristicFallbacks: _heuristicFallbacks, ...heuristicWork } = report.heuristic;
    expect(adaptiveWork).toEqual(heuristicWork);
    expect(adaptiveFallbacks).toBe(tasks.length);
  });

  it('the benchmark is deterministic across runs', () => {
    const tasks: BenchmarkTask[] = Array.from({ length: 12 }, (_unused, index) => ({
      id: `det-${index}`,
      signature: AGENTIC,
      candidates: CANDIDATES,
      forecast: FORECAST,
      priorSuccessProbability: 0.6,
      outcomes: GROUND_TRUTH,
      maxAttempts: 3,
    }));
    const first = benchmarkSchedulers({ tasks, history: history(), policy: POLICY, now: NOW });
    const second = benchmarkSchedulers({ tasks, history: history(), policy: POLICY, now: NOW });
    expect(second).toEqual(first);
  });
});

describe('vNext.8 historical replay', () => {
  it('reports recommendation disagreement and claims no counterfactual outcome', () => {
    const cases: ReplayCase[] = Array.from({ length: 10 }, (_unused, index) => ({
      id: `case-${index}`,
      signature: AGENTIC,
      candidates: CANDIDATES,
      forecast: FORECAST,
      priorSuccessProbability: 0.6,
      heuristicWallTimeMs: 10 * 60_000,
    }));
    const profiles = aggregateProfiles({ observations: history(), policy: POLICY, now: NOW });
    const report = replaySchedulingDecisions({ cases, profiles, policy: POLICY });

    expect(report.analysis).toBe('RECOMMENDATION_ONLY');
    expect(report.cases).toBe(10);
    expect(report.disagreements).toBe(10);
    expect(report.wouldHaveApplied).toBe(10);
    expect(report.disclaimer).toContain('says nothing about whether they would have succeeded');
    // The report exposes decisions only — no field can hold an outcome for
    // an unexecuted candidate.
    for (const outcome of report.outcomes) {
      expect(outcome.recommendedCandidateId).toBe(HARNESS.candidateId);
      expect(outcome.heuristicCandidateId).toBe(DIRECT.candidateId);
      expect(Object.keys(outcome)).not.toContain('wouldHaveSucceeded');
    }
  });

  it('a cold-start replay reports agreement and a cold-start fallback', () => {
    const cases: ReplayCase[] = [
      {
        id: 'cold',
        signature: AGENTIC,
        candidates: CANDIDATES,
        forecast: FORECAST,
        priorSuccessProbability: 0.6,
      },
    ];
    const profiles = aggregateProfiles({ observations: [], policy: POLICY, now: NOW });
    const report = replaySchedulingDecisions({ cases, profiles, policy: POLICY });
    expect(report.wouldHaveApplied).toBe(0);
    expect(report.confidence['NONE']).toBe(1);
  });
});
