import { describe, expect, it } from 'vitest';
import { jobSchedulerPolicySchema } from '@specbridge/core';
import type { JobSchedulerPolicy } from '@specbridge/core';
import {
  FakeQuotaTelemetryProvider,
  ManualQuotaTelemetryProvider,
  SubscriptionQuotaManager,
  aggregateBurnObservations,
  assessSubscriptionAdmission,
  buildQuotaForecast,
  classifyLocalSuitability,
  computeDynamicReserve,
  decideLane,
  deriveBurnObservations,
  deriveSchedulerMode,
  estimateWorkload,
  expectedBurnBeforeReset,
  readQuotaTelemetryFile,
  recordQuotaObservation,
  selectReadyCandidate,
} from '@specbridge/orchestration';
import type {
  ExecutionLedgerEntry,
  LaneRouting,
  QuotaForecast,
  WorkloadEstimate,
} from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * vNext.2 Free & Prepaid Optimizer: the pure scheduling core.
 *
 * Every scenario runs on values — fake telemetry snapshots, fixed clocks,
 * explicit estimates — so each policy rule is replayed deterministically:
 * mode derivation (NORMAL/CONSERVE/HARVEST/EXHAUSTED), weekly dominance
 * over harvesting, the dynamic reserve, CROSS-RESET admission (the
 * mandatory 50-minute-task/20-minutes-to-reset case), stale-telemetry
 * conservatism, suitability classification, and lane decisions.
 */

const policy: JobSchedulerPolicy = jobSchedulerPolicySchema.parse({});

const NOW = new Date('2026-08-21T12:00:00.000Z');

function minutesFromNow(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function snapshot(input: {
  window: 'five-hour' | 'weekly';
  remaining: number;
  resetInMinutes?: number;
  observedMinutesAgo?: number;
}) {
  return {
    window: input.window,
    remainingRatio: input.remaining,
    usedRatio: null,
    resetAt: input.resetInMinutes !== undefined ? minutesFromNow(input.resetInMinutes) : null,
    observedAt: new Date(NOW.getTime() - (input.observedMinutesAgo ?? 1) * 60_000).toISOString(),
    source: 'fake',
  };
}

function forecastOf(input: {
  fiveHourRemaining?: number | null;
  fiveHourResetInMinutes?: number | null;
  weeklyRemaining?: number | null;
  weeklyResetInMinutes?: number | null;
  observedMinutesAgo?: number;
  policyOverrides?: Partial<JobSchedulerPolicy>;
}): QuotaForecast {
  const merged = { ...policy, ...(input.policyOverrides ?? {}) };
  return buildQuotaForecast({
    fiveHour:
      input.fiveHourRemaining === null
        ? null
        : snapshot({
            window: 'five-hour',
            remaining: input.fiveHourRemaining ?? 0.8,
            ...(input.fiveHourResetInMinutes !== undefined && input.fiveHourResetInMinutes !== null
              ? { resetInMinutes: input.fiveHourResetInMinutes }
              : {}),
            ...(input.observedMinutesAgo !== undefined
              ? { observedMinutesAgo: input.observedMinutesAgo }
              : {}),
          }),
    weekly:
      input.weeklyRemaining === null
        ? null
        : snapshot({
            window: 'weekly',
            remaining: input.weeklyRemaining ?? 0.8,
            ...(input.weeklyResetInMinutes !== undefined && input.weeklyResetInMinutes !== null
              ? { resetInMinutes: input.weeklyResetInMinutes }
              : {}),
            ...(input.observedMinutesAgo !== undefined
              ? { observedMinutesAgo: input.observedMinutesAgo }
              : {}),
          }),
    now: NOW,
    policy: merged,
  });
}

function estimateOf(input: {
  wallMinutes: number;
  fiveHourBurn: number;
  suitability?: WorkloadEstimate['localSuitability'];
  complexity?: WorkloadEstimate['complexity'];
}): WorkloadEstimate {
  return {
    taskId: 'task-1',
    complexity: input.complexity ?? 'HIGH',
    intelligenceRequirement: input.complexity ?? 'HIGH',
    localSuitability: input.suitability ?? 'STRONG_REQUIRED',
    expectedWallTimeMs: input.wallMinutes * 60_000,
    expectedFiveHourBurnRatio: input.fiveHourBurn,
    expectedWeeklyBurnRatio: input.fiveHourBurn / policy.estimator.weeklyCapacityFactor,
    burnProfile: 'linear',
    expectedContextGrowthTokens: 50_000,
    expectedAgentTurns: null,
    expectedToolCalls: null,
    expectedTestLoops: null,
    retryProbability: 0.2,
    confidence: 'high',
    basis: 'heuristic',
  };
}

// ---------------------------------------------------------------------------
// Scheduler modes (Tests E, F, G, J + exhaustion)
// ---------------------------------------------------------------------------

describe('scheduler mode derivation', () => {
  it('Test E: healthy five-hour and weekly quota derive NORMAL', () => {
    const forecast = forecastOf({
      fiveHourRemaining: 0.8,
      fiveHourResetInMinutes: 180,
      weeklyRemaining: 0.7,
      weeklyResetInMinutes: 3 * 24 * 60,
    });
    expect(forecast.schedulerMode).toBe('NORMAL');
    expect(forecast.telemetryFreshness).toBe('FRESH');
  });

  it('Test F: low five-hour remaining with a distant reset derives CONSERVE', () => {
    const forecast = forecastOf({
      fiveHourRemaining: 0.12,
      fiveHourResetInMinutes: 120,
      weeklyRemaining: 0.7,
      weeklyResetInMinutes: 3 * 24 * 60,
    });
    expect(forecast.schedulerMode).toBe('CONSERVE');
  });

  it('Test G: significant capacity + imminent reset + healthy weekly derives HARVEST', () => {
    const forecast = forecastOf({
      fiveHourRemaining: 0.5,
      fiveHourResetInMinutes: 20,
      weeklyRemaining: 0.7,
      weeklyResetInMinutes: 3 * 24 * 60,
    });
    expect(forecast.schedulerMode).toBe('HARVEST');
  });

  it('Test J: weekly scarcity SUPPRESSES harvest despite an imminent five-hour reset', () => {
    const forecast = forecastOf({
      fiveHourRemaining: 0.5,
      fiveHourResetInMinutes: 15,
      weeklyRemaining: 0.03,
      weeklyResetInMinutes: 3 * 24 * 60,
    });
    expect(forecast.schedulerMode).not.toBe('HARVEST');
    expect(forecast.schedulerMode).toBe('CONSERVE');
  });

  it('derives EXHAUSTED_5H and EXHAUSTED_WEEKLY, weekly dominating both', () => {
    expect(
      forecastOf({ fiveHourRemaining: 0.005, fiveHourResetInMinutes: 90, weeklyRemaining: 0.6 })
        .schedulerMode,
    ).toBe('EXHAUSTED_5H');
    expect(
      forecastOf({ fiveHourRemaining: 0.6, fiveHourResetInMinutes: 90, weeklyRemaining: 0.005 })
        .schedulerMode,
    ).toBe('EXHAUSTED_WEEKLY');
    expect(
      forecastOf({ fiveHourRemaining: 0.004, fiveHourResetInMinutes: 5, weeklyRemaining: 0.004 })
        .schedulerMode,
    ).toBe('EXHAUSTED_WEEKLY');
  });

  it('Test N: stale telemetry never derives HARVEST', () => {
    const forecast = forecastOf({
      fiveHourRemaining: 0.5,
      fiveHourResetInMinutes: 20,
      weeklyRemaining: 0.7,
      observedMinutesAgo: 60,
    });
    expect(forecast.telemetryFreshness).toBe('STALE');
    expect(forecast.schedulerMode).not.toBe('HARVEST');
  });

  it('derives NORMAL with UNKNOWN freshness when nothing was ever observed', () => {
    const forecast = forecastOf({ fiveHourRemaining: null, weeklyRemaining: null });
    expect(forecast.schedulerMode).toBe('NORMAL');
    expect(forecast.telemetryFreshness).toBe('UNKNOWN');
    expect(forecast.fiveHourRemainingRatio).toBeNull();
  });

  it('exposes the derivation as a pure function too', () => {
    expect(
      deriveSchedulerMode({
        fiveHourRemainingRatio: 0.5,
        timeToFiveHourResetMs: 20 * 60_000,
        weeklyRemainingRatio: 0.7,
        freshness: 'FRESH',
        policy,
      }),
    ).toBe('HARVEST');
  });
});

// ---------------------------------------------------------------------------
// Dynamic reserve (Test M)
// ---------------------------------------------------------------------------

describe('dynamic reserve', () => {
  it('Test M: the reserve shrinks as the reset approaches and bottoms out near it', () => {
    const far = computeDynamicReserve({
      forecast: forecastOf({ fiveHourRemaining: 0.6, fiveHourResetInMinutes: 240, weeklyRemaining: 0.7 }),
      policy: policy.reserve,
      weeklyPressureRatio: policy.weeklyPressureRatio,
    });
    const mid = computeDynamicReserve({
      forecast: forecastOf({ fiveHourRemaining: 0.6, fiveHourResetInMinutes: 90, weeklyRemaining: 0.7 }),
      policy: policy.reserve,
      weeklyPressureRatio: policy.weeklyPressureRatio,
    });
    const near = computeDynamicReserve({
      forecast: forecastOf({ fiveHourRemaining: 0.6, fiveHourResetInMinutes: 10, weeklyRemaining: 0.7 }),
      policy: policy.reserve,
      weeklyPressureRatio: policy.weeklyPressureRatio,
    });
    expect(far.ratio).toBe(policy.reserve.baseRatio);
    expect(mid.ratio).toBeLessThan(far.ratio);
    expect(mid.ratio).toBeGreaterThan(near.ratio);
    expect(near.ratio).toBe(policy.reserve.minRatio);
  });

  it('weekly pressure and stale telemetry each ADD reserve', () => {
    const pressured = computeDynamicReserve({
      forecast: forecastOf({ fiveHourRemaining: 0.6, fiveHourResetInMinutes: 240, weeklyRemaining: 0.05 }),
      policy: policy.reserve,
      weeklyPressureRatio: policy.weeklyPressureRatio,
    });
    expect(pressured.ratio).toBeCloseTo(
      policy.reserve.baseRatio + policy.reserve.weeklyPressureExtraRatio,
      10,
    );
    const stale = computeDynamicReserve({
      forecast: forecastOf({
        fiveHourRemaining: 0.6,
        fiveHourResetInMinutes: 240,
        weeklyRemaining: 0.7,
        observedMinutesAgo: 60,
      }),
      policy: policy.reserve,
      weeklyPressureRatio: policy.weeklyPressureRatio,
    });
    expect(stale.basis.staleTelemetryExtra).toBe(policy.reserve.staleTelemetryExtraRatio);
  });
});

// ---------------------------------------------------------------------------
// Cross-reset admission (Tests H, I)
// ---------------------------------------------------------------------------

describe('cross-reset admission', () => {
  it('Test H (mandatory): 50% remaining, reset in 20m, 50m task burning 35% total STARTS NOW', () => {
    const estimate = estimateOf({ wallMinutes: 50, fiveHourBurn: 0.35 });
    const forecast = forecastOf({
      fiveHourRemaining: 0.5,
      fiveHourResetInMinutes: 20,
      weeklyRemaining: 0.7,
      weeklyResetInMinutes: 3 * 24 * 60,
    });
    // The linear profile puts ~14% of the burn before the reset.
    expect(expectedBurnBeforeReset(estimate, 20 * 60_000)).toBeCloseTo(0.14, 5);

    const reserve = computeDynamicReserve({
      forecast,
      policy: policy.reserve,
      weeklyPressureRatio: policy.weeklyPressureRatio,
    });
    const admission = assessSubscriptionAdmission({
      estimate,
      forecast,
      reserveRatio: reserve.ratio,
      policy,
    });
    expect(admission.admissible).toBe(true);
    expect(admission.crossesReset).toBe(true);
    expect(admission.preResetBurnRatio).toBeCloseTo(0.14, 5);

    // And the full lane decision starts it on the subscription NOW.
    const routing = decideLane({
      estimate,
      forecast,
      reserveRatio: reserve.ratio,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      contextUsageRatio: 0.2,
      policy,
    });
    expect(routing.lane).toBe('SUBSCRIPTION');
    expect(routing.reasonCode).toBe('CROSS_RESET_ADMITTED');
  });

  it('task duration versus time-to-reset is NOT the admission rule', () => {
    // A four-hour task twenty minutes before a reset, burning 3% before it:
    // admissible. Any `duration <= timeToReset` rule would refuse this.
    const estimate = estimateOf({ wallMinutes: 240, fiveHourBurn: 0.36 });
    const forecast = forecastOf({
      fiveHourRemaining: 0.3,
      fiveHourResetInMinutes: 20,
      weeklyRemaining: 0.7,
    });
    const admission = assessSubscriptionAdmission({
      estimate,
      forecast,
      reserveRatio: 0.02,
      policy,
    });
    expect(estimate.expectedWallTimeMs).toBeGreaterThan(20 * 60_000);
    expect(admission.admissible).toBe(true);
    expect(admission.preResetBurnRatio).toBeCloseTo(0.03, 5);
  });

  it('Test I: unsafe pre-reset burn is not admitted', () => {
    const estimate = estimateOf({ wallMinutes: 40, fiveHourBurn: 0.18 });
    const forecast = forecastOf({
      fiveHourRemaining: 0.1,
      fiveHourResetInMinutes: 40,
      weeklyRemaining: 0.7,
    });
    const admission = assessSubscriptionAdmission({
      estimate,
      forecast,
      reserveRatio: 0.02,
      policy,
    });
    expect(admission.admissible).toBe(false);
    expect(admission.refusal).toBe('five-hour');

    const routing = decideLane({
      estimate,
      forecast,
      reserveRatio: 0.02,
      localWorkerAvailable: false,
      localExecutionAvailable: false,
      policy,
    });
    expect(routing.lane).toBe('DEFER');
    expect(routing.deferUntil).toBe(forecast.fiveHourResetAt);
  });

  it('the weekly window is an INDEPENDENT constraint', () => {
    const estimate = estimateOf({ wallMinutes: 30, fiveHourBurn: 0.3 });
    const forecast = forecastOf({
      fiveHourRemaining: 0.9,
      fiveHourResetInMinutes: 200,
      weeklyRemaining: 0.05,
      weeklyResetInMinutes: 2 * 24 * 60,
    });
    const admission = assessSubscriptionAdmission({
      estimate,
      forecast,
      reserveRatio: 0.02,
      policy,
    });
    expect(admission.admissible).toBe(false);
    expect(admission.refusal).toBe('weekly');
  });
});

// ---------------------------------------------------------------------------
// Lane decisions (Tests A, B/C shape, D, K, L, stale)
// ---------------------------------------------------------------------------

describe('lane decisions', () => {
  const healthyForecast = forecastOf({
    fiveHourRemaining: 0.8,
    fiveHourResetInMinutes: 180,
    weeklyRemaining: 0.7,
    weeklyResetInMinutes: 3 * 24 * 60,
  });

  it('Test A: LOCAL_SAFE work routes LOCAL even with Max fully available', () => {
    const routing = decideLane({
      estimate: estimateOf({ wallMinutes: 5, fiveHourBurn: 0.01, suitability: 'LOCAL_SAFE', complexity: 'LOW' }),
      forecast: healthyForecast,
      reserveRatio: 0.2,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      policy,
    });
    expect(routing.lane).toBe('LOCAL');
    expect(routing.reasonCode).toBe('LOCAL_SAFE');
  });

  it('LOCAL_TRY work attempts the local lane first in every mode, HARVEST included', () => {
    const harvest = forecastOf({
      fiveHourRemaining: 0.5,
      fiveHourResetInMinutes: 20,
      weeklyRemaining: 0.7,
    });
    expect(harvest.schedulerMode).toBe('HARVEST');
    const routing = decideLane({
      estimate: estimateOf({ wallMinutes: 10, fiveHourBurn: 0.05, suitability: 'LOCAL_TRY', complexity: 'LOW' }),
      forecast: harvest,
      reserveRatio: 0.02,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      policy,
    });
    expect(routing.lane).toBe('LOCAL');
    expect(routing.reasonCode).toBe('LOCAL_TRY_FIRST');
  });

  it('Test D: STRONG_REQUIRED work routes SUBSCRIPTION without wasting local attempts', () => {
    const routing = decideLane({
      estimate: estimateOf({ wallMinutes: 50, fiveHourBurn: 0.35 }),
      forecast: healthyForecast,
      reserveRatio: 0.2,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      policy,
    });
    expect(routing.lane).toBe('SUBSCRIPTION');
    expect(routing.reasonCode).toBe('STRONG_REQUIRED');
  });

  it('exhausted local attempts escalate with LOCAL_ESCALATION_REQUIRED', () => {
    const routing = decideLane({
      estimate: estimateOf({ wallMinutes: 10, fiveHourBurn: 0.05 }),
      forecast: healthyForecast,
      reserveRatio: 0.2,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      localEscalationRequired: true,
      policy,
    });
    expect(routing.lane).toBe('SUBSCRIPTION');
    expect(routing.reasonCode).toBe('LOCAL_ESCALATION_REQUIRED');
  });

  it('Test K: quota-safe but context-heavy work compacts first, then runs on the subscription', () => {
    const routing = decideLane({
      estimate: estimateOf({ wallMinutes: 50, fiveHourBurn: 0.2 }),
      forecast: healthyForecast,
      reserveRatio: 0.2,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      contextUsageRatio: 0.82,
      policy,
    });
    expect(routing.lane).toBe('SUBSCRIPTION');
    expect(routing.compactFirst).toBe(true);
    expect(routing.reasonCode).toBe('COMPACT_BEFORE_EXECUTION');
  });

  it('Test L: with the five-hour window exhausted, local work runs and strong work defers to the reset', () => {
    const exhausted = forecastOf({
      fiveHourRemaining: 0.0,
      fiveHourResetInMinutes: 90,
      weeklyRemaining: 0.7,
    });
    expect(exhausted.schedulerMode).toBe('EXHAUSTED_5H');
    const local = decideLane({
      estimate: estimateOf({ wallMinutes: 5, fiveHourBurn: 0.01, suitability: 'LOCAL_SAFE', complexity: 'LOW' }),
      forecast: exhausted,
      reserveRatio: 0.02,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      policy,
    });
    expect(local.lane).toBe('LOCAL');
    const strong = decideLane({
      estimate: estimateOf({ wallMinutes: 50, fiveHourBurn: 0.35 }),
      forecast: exhausted,
      reserveRatio: 0.02,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      policy,
    });
    expect(strong.lane).toBe('DEFER');
    expect(strong.reasonCode).toBe('FIVE_HOUR_EXHAUSTED');
    expect(strong.deferUntil).toBe(exhausted.fiveHourResetAt);
  });

  it('stale telemetry defers work its own margin refused, with the stale reason on record', () => {
    const stale = forecastOf({
      fiveHourRemaining: 0.3,
      fiveHourResetInMinutes: 180,
      weeklyRemaining: 0.7,
      observedMinutesAgo: 60,
    });
    expect(stale.telemetryFreshness).toBe('STALE');
    const reserve = computeDynamicReserve({
      forecast: stale,
      policy: policy.reserve,
      weeklyPressureRatio: policy.weeklyPressureRatio,
    });
    // Burn chosen so admission passes WITHOUT the stale extra but fails with it.
    const routing = decideLane({
      estimate: estimateOf({ wallMinutes: 30, fiveHourBurn: 0.06 }),
      forecast: stale,
      reserveRatio: reserve.ratio,
      staleReserveExtraRatio: reserve.basis.staleTelemetryExtra,
      localWorkerAvailable: false,
      localExecutionAvailable: false,
      policy,
    });
    expect(routing.lane).toBe('DEFER');
    expect(routing.reasonCode).toBe('STALE_TELEMETRY_CONSERVATIVE');
  });

  it('local-suitable work with no local worker routes strong with LOCAL_UNAVAILABLE', () => {
    const routing = decideLane({
      estimate: estimateOf({ wallMinutes: 5, fiveHourBurn: 0.02, suitability: 'LOCAL_SAFE', complexity: 'LOW' }),
      forecast: healthyForecast,
      reserveRatio: 0.2,
      localWorkerAvailable: false,
      localExecutionAvailable: false,
      policy,
    });
    expect(routing.lane).toBe('SUBSCRIPTION');
    expect(routing.reasonCode).toBe('LOCAL_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Ready-task selection (Test G tail + harvest packing)
// ---------------------------------------------------------------------------

describe('ready-task selection', () => {
  function candidate(nodeId: string, graphIndex: number, routing: Partial<LaneRouting>): {
    nodeId: string;
    graphIndex: number;
    routing: LaneRouting;
  } {
    return {
      nodeId,
      graphIndex,
      routing: {
        lane: 'SUBSCRIPTION',
        reasonCode: 'STRONG_REQUIRED',
        compactFirst: false,
        deferUntil: null,
        admission: null,
        detail: 'test',
        ...routing,
      },
    };
  }

  it('keeps graph order when everything is runnable and nothing harvests', () => {
    const selection = selectReadyCandidate([
      candidate('n1', 0, { lane: 'LOCAL', reasonCode: 'LOCAL_SAFE' }),
      candidate('n2', 1, {}),
    ]);
    expect(selection?.nodeId).toBe('n1');
  });

  it('skips deferring work in favor of runnable local work (Max cooldown continues locally)', () => {
    const selection = selectReadyCandidate([
      candidate('n1', 0, { lane: 'DEFER', reasonCode: 'FIVE_HOUR_EXHAUSTED' }),
      candidate('n2', 1, { lane: 'LOCAL', reasonCode: 'LOCAL_SAFE' }),
    ]);
    expect(selection?.nodeId).toBe('n2');
  });

  it('prefers admissible strong work while capacity is expiring (HARVEST)', () => {
    const selection = selectReadyCandidate([
      candidate('n1', 0, { lane: 'LOCAL', reasonCode: 'LOCAL_SAFE' }),
      candidate('n2', 1, { lane: 'SUBSCRIPTION', reasonCode: 'HARVEST_EXPIRING_CAPACITY' }),
    ]);
    expect(selection?.nodeId).toBe('n2');
  });

  it('falls back to the first candidate when every ready task defers', () => {
    const selection = selectReadyCandidate([
      candidate('n1', 0, { lane: 'DEFER', reasonCode: 'FIVE_HOUR_EXHAUSTED' }),
      candidate('n2', 1, { lane: 'DEFER', reasonCode: 'FIVE_HOUR_EXHAUSTED' }),
    ]);
    expect(selection?.nodeId).toBe('n1');
  });
});

// ---------------------------------------------------------------------------
// Local suitability classification
// ---------------------------------------------------------------------------

describe('local suitability classification', () => {
  const base = {
    taskId: 't1',
    complexity: 'LOW' as const,
    deterministicVerificationAvailable: true,
    localWorkerAvailable: true,
  };

  it('classifies summarization/extraction work LOCAL_SAFE', () => {
    expect(classifyLocalSuitability({ ...base, title: 'Summarize the failing test logs' }).class).toBe(
      'LOCAL_SAFE',
    );
    expect(classifyLocalSuitability({ ...base, title: 'Extract exported symbols from the module' }).class).toBe(
      'LOCAL_SAFE',
    );
  });

  it('classifies small verifiable code work LOCAL_TRY', () => {
    const assessment = classifyLocalSuitability({
      ...base,
      title: 'Add a simple validation helper for config values',
    });
    expect(assessment.class).toBe('LOCAL_TRY');
  });

  it('LOCAL_TRY demands deterministic verification: without it the work routes strong', () => {
    const assessment = classifyLocalSuitability({
      ...base,
      deterministicVerificationAvailable: false,
      title: 'Add a simple validation helper for config values',
    });
    expect(assessment.class).toBe('STRONG_REQUIRED');
    expect(assessment.signals.some((signal) => signal.signal === 'no-deterministic-verification')).toBe(true);
  });

  it('HIGH complexity always classifies STRONG_REQUIRED', () => {
    const assessment = classifyLocalSuitability({
      ...base,
      complexity: 'HIGH',
      title: 'Simple rename across the architecture boundary',
    });
    expect(assessment.class).toBe('STRONG_REQUIRED');
  });

  it('cross-module architecture work never matches a local category', () => {
    const assessment = classifyLocalSuitability({
      ...base,
      complexity: 'MEDIUM',
      title: 'Redesign the cross-module persistence contract',
    });
    expect(assessment.class).toBe('STRONG_REQUIRED');
  });

  it('exhausted local attempts force STRONG_REQUIRED (bounded retries)', () => {
    const assessment = classifyLocalSuitability({
      ...base,
      title: 'Summarize the failing test logs',
      localAttemptsUsed: 2,
      maxLocalAttempts: 2,
    });
    expect(assessment.class).toBe('STRONG_REQUIRED');
    expect(assessment.signals.some((signal) => signal.signal === 'local-attempts-exhausted')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Workload estimation
// ---------------------------------------------------------------------------

describe('workload estimation', () => {
  it('separates wall time, quota burn, and context growth per complexity class', () => {
    const low = estimateWorkload({
      taskId: 't1',
      complexity: 'LOW',
      localSuitability: 'LOCAL_TRY',
      policy: policy.estimator,
    });
    const high = estimateWorkload({
      taskId: 't2',
      complexity: 'HIGH',
      localSuitability: 'STRONG_REQUIRED',
      policy: policy.estimator,
    });
    expect(low.expectedWallTimeMs).toBe(policy.estimator.lowWallTimeMs);
    expect(high.expectedWallTimeMs).toBe(policy.estimator.highWallTimeMs);
    expect(high.expectedFiveHourBurnRatio).toBe(policy.estimator.highQuotaBurnRatio);
    expect(high.expectedWeeklyBurnRatio).toBeCloseTo(
      policy.estimator.highQuotaBurnRatio / policy.estimator.weeklyCapacityFactor,
      10,
    );
    expect(high.expectedContextGrowthTokens).toBeGreaterThan(low.expectedContextGrowthTokens);
    expect(low.basis).toBe('heuristic');
  });

  it('uses ledger history only at or above the observation floor, and conservatively', () => {
    const observation = (burn: number, minutes: number) => ({
      attemptId: 'a',
      taskId: 't',
      provider: 'claude-code',
      lane: 'SUBSCRIPTION',
      taskCategory: 'general',
      taskComplexity: 'HIGH',
      fiveHourBurnRatio: burn,
      weeklyBurnRatio: null,
      wallTimeMs: minutes * 60_000,
      fiveHourBurnRatioPerMinute: burn / minutes,
      success: true,
      startedAt: NOW.toISOString(),
    });
    const sparse = estimateWorkload({
      taskId: 't1',
      complexity: 'HIGH',
      localSuitability: 'STRONG_REQUIRED',
      policy: policy.estimator,
      observations: [observation(0.01, 5)],
    });
    expect(sparse.basis).toBe('heuristic');

    const informed = estimateWorkload({
      taskId: 't1',
      complexity: 'HIGH',
      localSuitability: 'STRONG_REQUIRED',
      policy: policy.estimator,
      observations: [observation(0.4, 60), observation(0.5, 70), observation(0.45, 65)],
    });
    expect(informed.basis).toBe('historical');
    expect(informed.expectedWallTimeMs).toBe(65 * 60_000);
    expect(informed.expectedFiveHourBurnRatio).toBeCloseTo(0.45, 5);
  });

  it('models burn-before-reset with the linear profile', () => {
    const estimate = estimateOf({ wallMinutes: 50, fiveHourBurn: 0.35 });
    expect(expectedBurnBeforeReset(estimate, 50 * 60_000)).toBeCloseTo(0.35, 5);
    expect(expectedBurnBeforeReset(estimate, 100 * 60_000)).toBeCloseTo(0.35, 5);
    expect(expectedBurnBeforeReset(estimate, 25 * 60_000)).toBeCloseTo(0.175, 5);
    expect(expectedBurnBeforeReset(estimate, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Telemetry providers and burn observations (Test O)
// ---------------------------------------------------------------------------

describe('quota telemetry and burn observations', () => {
  it('the manual provider round-trips observations through the workspace file', async () => {
    const fixture = setupOrchestrationFixture();
    recordQuotaObservation(fixture.workspace, {
      window: 'five-hour',
      remainingRatio: 0.42,
      resetAt: minutesFromNow(90),
      observedAt: NOW.toISOString(),
    });
    recordQuotaObservation(fixture.workspace, {
      window: 'weekly',
      remainingRatio: 0.66,
      observedAt: NOW.toISOString(),
    });
    const provider = new ManualQuotaTelemetryProvider(fixture.workspace);
    const fiveHour = await provider.getFiveHourQuota();
    const weekly = await provider.getWeeklyQuota();
    expect(fiveHour?.remainingRatio).toBe(0.42);
    expect(weekly?.remainingRatio).toBe(0.66);
    expect(readQuotaTelemetryFile(fixture.workspace).fiveHour?.source).toBe('manual-file');
  });

  it('the manager composes provider + policy into a forecast', async () => {
    const provider = new FakeQuotaTelemetryProvider({
      fiveHour: snapshot({ window: 'five-hour', remaining: 0.5, resetInMinutes: 20 }),
      weekly: snapshot({ window: 'weekly', remaining: 0.7, resetInMinutes: 3 * 24 * 60 }),
    });
    const manager = new SubscriptionQuotaManager({ provider, policy, clock: () => NOW });
    const forecast = await manager.forecast();
    expect(forecast.schedulerMode).toBe('HARVEST');
    expect(forecast.timeToFiveHourResetMs).toBe(20 * 60_000);
  });

  it('Test O: ledger entries with quota before/after yield burn, wall time, and rate', () => {
    const entry = (
      before: number,
      after: number,
      durationMs: number,
      overrides: Partial<ExecutionLedgerEntry> = {},
    ): ExecutionLedgerEntry => ({
      attemptId: `at-${before}-${after}`,
      jobId: 'job',
      nodeId: 'n1',
      taskId: 't1',
      role: 'EXECUTOR',
      provider: 'claude-code',
      model: null,
      lane: 'SUBSCRIPTION',
      status: 'COMPLETED',
      attemptNumber: 1,
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      success: true,
      failureReason: null,
      localSuitability: null,
      taskComplexity: 'HIGH',
      taskCategory: 'general',
      schedulingDecisionId: null,
      metrics: {
        durationMs,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        toolCalls: null,
        filesRead: null,
        filesChanged: null,
        costUsd: null,
        fiveHourQuotaBefore: before,
        fiveHourQuotaAfter: after,
        weeklyQuotaBefore: null,
        weeklyQuotaAfter: null,
        contextUsageBefore: null,
        contextUsageAfter: null,
        testLoops: null,
      },
      ...overrides,
    });

    const observations = deriveBurnObservations([
      entry(0.8, 0.6, 20 * 60_000),
      entry(0.6, 0.45, 15 * 60_000),
      // A reset crossed during the attempt: after > before is honest-null.
      entry(0.1, 0.9, 30 * 60_000),
    ]);
    expect(observations).toHaveLength(3);
    expect(observations[0]?.fiveHourBurnRatio).toBeCloseTo(0.2, 5);
    expect(observations[0]?.fiveHourBurnRatioPerMinute).toBeCloseTo(0.01, 5);
    expect(observations[2]?.fiveHourBurnRatio).toBeNull();

    const aggregate = aggregateBurnObservations(observations, { taskComplexity: 'HIGH' });
    expect(aggregate.observations).toBe(3);
    expect(aggregate.medianFiveHourBurnRatio).toBeCloseTo(0.175, 5);
    expect(aggregate.successRate).toBe(1);
  });
});
