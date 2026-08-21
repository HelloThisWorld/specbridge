import type { WorkloadEstimatorPolicy } from '@specbridge/core';
import type { ComplexityClass } from '../jobs/vocabulary.js';
import type { BurnObservation } from '../quota/observations.js';
import { aggregateBurnObservations } from '../quota/observations.js';
import type { LocalSuitabilityClass } from './vocabulary.js';

/**
 * WorkloadProfiler (vNext.2): estimates that make scheduling decisions
 * possible without conflating three DIFFERENT dimensions:
 *
 *   wall time          how long the task occupies a worker
 *   quota burn         how much subscription capacity it consumes
 *   context growth     how much working-context it accumulates
 *
 * A task may run long while burning little quota, burn heavily in minutes,
 * or grow context out of proportion to both. Each dimension is estimated
 * and carried independently.
 *
 * The first version is heuristic-first: complexity-class defaults from
 * configuration, conservatively replaced by ledger history when at least
 * `minHistoricalObservations` comparable measurements exist. Estimates
 * carry explicit confidence and basis — the architecture supports
 * uncertainty rather than pretending precision.
 *
 * Burn-over-time is a profile, not one number: `linear` assumes even burn
 * across the runtime (the documented default), and the profile field is the
 * extension point where measured curves replace the assumption later.
 */

export const BURN_PROFILES = ['linear'] as const;
export type BurnProfile = (typeof BURN_PROFILES)[number];

export type EstimateConfidence = 'low' | 'medium' | 'high';
export type EstimateBasis = 'heuristic' | 'historical';

export interface WorkloadEstimate {
  taskId: string;
  complexity: ComplexityClass;
  /** The intelligence tier the work needs (mirrors the complexity class). */
  intelligenceRequirement: ComplexityClass;
  localSuitability: LocalSuitabilityClass;
  expectedWallTimeMs: number;
  /** Expected FIVE-HOUR-window burn over the whole task, 0..1. */
  expectedFiveHourBurnRatio: number;
  /** Expected WEEKLY-window burn over the whole task, 0..1. */
  expectedWeeklyBurnRatio: number;
  burnProfile: BurnProfile;
  /** Estimated working-context growth over the task, in tokens. */
  expectedContextGrowthTokens: number;
  expectedAgentTurns: number | null;
  expectedToolCalls: number | null;
  expectedTestLoops: number | null;
  /**
   * vNext.5: expected provider token usage for ONE attempt. The API lane's
   * cost estimate is built from these — which is why they live here rather
   * than in a separate API estimator: token usage is a property of the
   * WORKLOAD, and the same task costs roughly the same tokens whichever
   * metered provider runs it.
   *
   * `null` means "not estimable", and null cost is never treated as zero.
   */
  expectedInputTokens: number | null;
  expectedOutputTokens: number | null;
  /** Where the token figures came from, for honest cost attribution. */
  tokenBasis: EstimateBasis | 'unknown';
  /** Probability (0..1) the first attempt fails and a retry is needed. */
  retryProbability: number;
  confidence: EstimateConfidence;
  basis: EstimateBasis;
}

export interface EstimateWorkloadInput {
  taskId: string;
  complexity: ComplexityClass;
  localSuitability: LocalSuitabilityClass;
  /** Coarse category from the suitability classifier (history grouping). */
  taskCategory?: string | undefined;
  policy: WorkloadEstimatorPolicy;
  /** Ledger-derived burn observations, when any exist. */
  observations?: readonly BurnObservation[] | undefined;
  /** Explicit overrides (tests, callers with better information). */
  overrides?:
    | {
        expectedWallTimeMs?: number | undefined;
        expectedFiveHourBurnRatio?: number | undefined;
        /** vNext.5: explicit token expectations (tests, better information). */
        expectedInputTokens?: number | null | undefined;
        expectedOutputTokens?: number | null | undefined;
      }
    | undefined;
}

function heuristicWallTimeMs(complexity: ComplexityClass, policy: WorkloadEstimatorPolicy): number {
  switch (complexity) {
    case 'LOW':
      return policy.lowWallTimeMs;
    case 'MEDIUM':
      return policy.mediumWallTimeMs;
    case 'HIGH':
      return policy.highWallTimeMs;
  }
}

function heuristicBurnRatio(complexity: ComplexityClass, policy: WorkloadEstimatorPolicy): number {
  switch (complexity) {
    case 'LOW':
      return policy.lowQuotaBurnRatio;
    case 'MEDIUM':
      return policy.mediumQuotaBurnRatio;
    case 'HIGH':
      return policy.highQuotaBurnRatio;
  }
}

/**
 * Coarse per-attempt token heuristics by complexity (vNext.5).
 *
 * Deliberately generous rather than optimistic: these numbers feed a
 * SPENDING decision, and an underestimate is the failure mode that costs
 * real money. An agentic attempt re-reads files across many turns, so
 * input dominates output by roughly an order of magnitude.
 *
 * They are heuristics and are labeled as such on every estimate; measured
 * ledger history replaces them as soon as enough comparable observations
 * exist.
 */
function heuristicTokenUsage(complexity: ComplexityClass): {
  inputTokens: number;
  outputTokens: number;
} {
  switch (complexity) {
    case 'LOW':
      return { inputTokens: 120_000, outputTokens: 12_000 };
    case 'MEDIUM':
      return { inputTokens: 400_000, outputTokens: 30_000 };
    case 'HIGH':
      return { inputTokens: 900_000, outputTokens: 60_000 };
  }
}

/** Coarse context-growth heuristic by complexity (tokens over the task). */
function heuristicContextGrowthTokens(complexity: ComplexityClass): number {
  switch (complexity) {
    case 'LOW':
      return 20_000;
    case 'MEDIUM':
      return 60_000;
    case 'HIGH':
      return 120_000;
  }
}

function heuristicRetryProbability(
  complexity: ComplexityClass,
  suitability: LocalSuitabilityClass,
): number {
  if (suitability === 'LOCAL_TRY') return 0.4;
  switch (complexity) {
    case 'LOW':
      return 0.1;
    case 'MEDIUM':
      return 0.25;
    case 'HIGH':
      return 0.4;
  }
}

/**
 * Estimate one task's workload. Pure and deterministic.
 *
 * History replaces heuristics CONSERVATIVELY: only with enough comparable
 * observations (same complexity class; category refines when it also has
 * enough), and the estimate takes the LARGER of history and heuristic for
 * burn — sparse optimistic samples must not talk admission into risk.
 */
export function estimateWorkload(input: EstimateWorkloadInput): WorkloadEstimate {
  const { policy } = input;
  let wallTimeMs = heuristicWallTimeMs(input.complexity, policy);
  let fiveHourBurn = heuristicBurnRatio(input.complexity, policy);
  let basis: EstimateBasis = 'heuristic';
  let confidence: EstimateConfidence = input.complexity === 'LOW' ? 'medium' : 'low';

  // Only SUBSCRIPTION-lane history (or pre-vNext.2 unlabeled history) may
  // inform these estimates: they exist for subscription admission, and a
  // seconds-long LOCAL attempt says nothing about strong-lane burn.
  const observations = (input.observations ?? []).filter(
    (observation) => observation.lane === 'SUBSCRIPTION' || observation.lane === null,
  );
  if (observations.length > 0) {
    const byCategory =
      input.taskCategory !== undefined
        ? aggregateBurnObservations(observations, {
            taskComplexity: input.complexity,
            taskCategory: input.taskCategory,
          })
        : {
            observations: 0,
            medianFiveHourBurnRatio: null,
            medianWallTimeMs: null,
            medianFiveHourBurnRatioPerMinute: null,
            medianInputTokens: null,
            medianOutputTokens: null,
            tokenObservations: 0,
            successRate: null,
          };
    const byComplexity = aggregateBurnObservations(observations, {
      taskComplexity: input.complexity,
    });
    const aggregate =
      byCategory.observations >= policy.minHistoricalObservations ? byCategory : byComplexity;
    if (aggregate.observations >= policy.minHistoricalObservations) {
      if (aggregate.medianWallTimeMs !== null) {
        wallTimeMs = Math.round(Math.max(aggregate.medianWallTimeMs, wallTimeMs * 0.25));
        basis = 'historical';
      }
      if (aggregate.medianFiveHourBurnRatio !== null) {
        fiveHourBurn = Math.min(1, Math.max(aggregate.medianFiveHourBurnRatio, fiveHourBurn * 0.5));
        basis = 'historical';
      }
      if (basis === 'historical') confidence = 'medium';
    }
  }

  if (input.overrides?.expectedWallTimeMs !== undefined) {
    wallTimeMs = input.overrides.expectedWallTimeMs;
    confidence = 'high';
  }
  if (input.overrides?.expectedFiveHourBurnRatio !== undefined) {
    fiveHourBurn = input.overrides.expectedFiveHourBurnRatio;
    confidence = 'high';
  }

  // The LOCAL lane consumes no subscription quota at all.
  if (input.localSuitability === 'LOCAL_SAFE') fiveHourBurn = Math.min(fiveHourBurn, 0.02);

  // vNext.5 token usage. History comes from metered/agentic attempts — the
  // API and LOCAL HARNESS lanes are the ones whose runners actually report
  // token counts — and only when enough observations exist. The estimate
  // takes the LARGER of history and heuristic, for the same reason burn
  // does: a few cheap samples must not talk a spending decision into risk.
  const heuristicTokens = heuristicTokenUsage(input.complexity);
  let expectedInputTokens: number | null = heuristicTokens.inputTokens;
  let expectedOutputTokens: number | null = heuristicTokens.outputTokens;
  let tokenBasis: EstimateBasis | 'unknown' = 'heuristic';
  const meteredObservations = (input.observations ?? []).filter(
    (observation) => observation.lane === 'API' || observation.lane === 'LOCAL',
  );
  if (meteredObservations.length > 0) {
    const tokenAggregate = aggregateBurnObservations(meteredObservations, {
      taskComplexity: input.complexity,
    });
    if (tokenAggregate.tokenObservations >= policy.minHistoricalObservations) {
      if (tokenAggregate.medianInputTokens !== null) {
        expectedInputTokens = Math.round(
          Math.max(tokenAggregate.medianInputTokens, heuristicTokens.inputTokens * 0.5),
        );
        tokenBasis = 'historical';
      }
      if (tokenAggregate.medianOutputTokens !== null) {
        expectedOutputTokens = Math.round(
          Math.max(tokenAggregate.medianOutputTokens, heuristicTokens.outputTokens * 0.5),
        );
        tokenBasis = 'historical';
      }
    }
  }
  if (input.overrides?.expectedInputTokens !== undefined) {
    expectedInputTokens = input.overrides.expectedInputTokens;
  }
  if (input.overrides?.expectedOutputTokens !== undefined) {
    expectedOutputTokens = input.overrides.expectedOutputTokens;
  }

  return {
    taskId: input.taskId,
    complexity: input.complexity,
    intelligenceRequirement: input.complexity,
    localSuitability: input.localSuitability,
    expectedWallTimeMs: Math.max(1, Math.round(wallTimeMs)),
    expectedFiveHourBurnRatio: Math.min(1, Math.max(0, fiveHourBurn)),
    expectedWeeklyBurnRatio: Math.min(1, Math.max(0, fiveHourBurn / policy.weeklyCapacityFactor)),
    burnProfile: 'linear',
    expectedContextGrowthTokens: heuristicContextGrowthTokens(input.complexity),
    expectedAgentTurns: null,
    expectedToolCalls: null,
    expectedTestLoops: null,
    expectedInputTokens,
    expectedOutputTokens,
    tokenBasis,
    retryProbability: heuristicRetryProbability(input.complexity, input.localSuitability),
    confidence,
    basis,
  };
}

/**
 * Burn expected BEFORE a reset that is `timeToResetMs` away, under the
 * estimate's burn profile. With the linear profile:
 *
 *   burnBeforeReset = totalBurn * min(1, timeToReset / wallTime)
 *
 * This is the quantity cross-reset admission compares — never the task's
 * total duration against the time to reset.
 */
export function expectedBurnBeforeReset(
  estimate: Pick<WorkloadEstimate, 'expectedFiveHourBurnRatio' | 'expectedWallTimeMs' | 'burnProfile'>,
  timeToResetMs: number,
): number {
  if (timeToResetMs <= 0) return 0;
  const fraction = Math.min(1, timeToResetMs / Math.max(1, estimate.expectedWallTimeMs));
  return estimate.expectedFiveHourBurnRatio * fraction;
}
