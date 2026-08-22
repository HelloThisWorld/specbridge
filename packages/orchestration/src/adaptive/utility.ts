import type { AdaptiveSchedulerPolicy } from '@specbridge/core';
import type { QuotaForecast } from '../quota/state.js';
import type { CandidatePrediction } from './prediction.js';

/**
 * ExpectedUtility (vNext.8): one transparent score per candidate.
 *
 * The formula, stated once and unit-tested:
 *
 *   U = successWeight        * P(verified)
 *     - latencyPenalty       * norm(expectedTotalWallTime,  wallTimeScaleMs)
 *     - failedWorkPenalty    * failedWork
 *     - quotaPressurePenalty * quotaOpportunityCost
 *     - apiCostPenalty       * norm(expectedCostPerCompletion, apiCostScaleUsd)
 *     - contextCostPenalty   * norm(contextPerCompletion,   contextTokenScale)
 *     - handoffPenalty       * norm(handoffOverhead,        wallTimeScaleMs)
 *
 * Two properties matter more than the exact coefficients.
 *
 * NORMALIZATION. Seconds, dollars, tokens, and quota percentages are never
 * added in their own units. Each raw quantity passes through
 *
 *   norm(x, k) = x / (x + k)
 *
 * a saturating map into [0,1) with a documented, configurable scale `k`.
 * Saturating rather than linear on purpose: the difference between a
 * two-minute and a twenty-minute task is decision-relevant, the difference
 * between four hours and five is not, and a linear penalty would let one
 * outlier dominate every other consideration.
 *
 * QUALITY DOMINATES CHEAPNESS. At the default weights the success term
 * spans 1.0 while every penalty combined saturates below it, so a candidate
 * that is materially less likely to finish cannot win on savings. A target
 * that is 10% cheaper and 30% less likely to complete loses, which is the
 * behavior the phase requires and the behavior the tests assert.
 *
 * What utility CANNOT do is as important as what it does: it ranks
 * candidates the hard policy layer already declared eligible. It never
 * chooses a lane, authorizes spending, relaxes a quota bound, or resurrects
 * a strategy reliability has retired. Those decisions happened before any
 * number in this file existed.
 */

export interface UtilityComponent {
  /** Component name, stable and printable. */
  name: string;
  /** The raw quantity in its own unit; null when unknown. */
  raw: number | null;
  unit: string;
  /** The normalized [0,1] (or [-1,1] for quota) value that was weighted. */
  normalized: number;
  weight: number;
  /** Signed contribution to the score. */
  contribution: number;
  detail: string;
}

export interface UtilityScore {
  candidateId: string;
  score: number;
  components: UtilityComponent[];
}

/**
 * Saturating normalization: `x / (x + k)`, mapping [0,inf) into [0,1).
 * A null or negative input normalizes to 0 — an unknown quantity is not
 * penalized, because guessing a penalty is the same error as guessing a
 * value.
 */
export function normalize(value: number | null, scale: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  const k = Math.max(1e-9, scale);
  return value / (value + k);
}

/**
 * QuotaOpportunityCost: a dimensionless pressure index in [-1, 1].
 *
 * NOT money, and deliberately not convertible to it. SpecBridge has no
 * exchange rate between a percentage of a prepaid subscription window and a
 * dollar, and inventing one would put a fabricated number at the centre of
 * every economic comparison. This is a ranking pressure only.
 *
 *   negative  prepaid capacity is about to EXPIRE unused (HARVEST). Spending
 *             it is worth more than saving it, so subscription work scores
 *             better while the window is closing.
 *   positive  capacity is SCARCE — low remaining with a distant reset, or
 *             weekly pressure. Spending it costs more than its face value.
 *
 * Zero for every non-subscription lane: LOCAL and API consume no
 * subscription quota, and pretending they exert pressure on it would let a
 * quota term influence a decision it has nothing to do with.
 *
 * The hard quota rules are NOT here and cannot be expressed here. Admission,
 * the dynamic reserve, exhaustion, and weekly suppression of HARVEST all ran
 * in the scheduler before this function was called; a candidate that reaches
 * it has already been admitted. This only decides how attractive an
 * already-permitted subscription dispatch is relative to its alternatives.
 */
export function quotaOpportunityCost(input: {
  lane: string;
  forecast: QuotaForecast;
}): { value: number; detail: string } {
  if (input.lane !== 'SUBSCRIPTION') {
    return { value: 0, detail: 'Non-subscription lane: no subscription quota pressure applies.' };
  }
  const forecast = input.forecast;
  const fiveHour = clamp01(forecast.fiveHourRemainingRatio ?? 1);
  const weekly = clamp01(forecast.weeklyRemainingRatio ?? 1);
  const mode = forecast.schedulerMode;

  if (mode === 'HARVEST') {
    // Capacity that expires unused is worth nothing. The more of it there
    // is, the more valuable spending it becomes.
    return {
      value: -fiveHour,
      detail:
        `HARVEST: ${(fiveHour * 100).toFixed(0)}% of the five-hour window expires at the coming ` +
        'reset, so admitted strong work is worth more now than later.',
    };
  }
  let value = 0;
  const notes: string[] = [];
  if (mode === 'CONSERVE') {
    value += 1 - fiveHour;
    notes.push(`CONSERVE: only ${(fiveHour * 100).toFixed(0)}% of the five-hour window remains`);
  } else {
    value += (1 - fiveHour) * 0.25;
    notes.push(`five-hour window ${(fiveHour * 100).toFixed(0)}% remaining`);
  }
  if (weekly < 1) {
    value += (1 - weekly) * 0.5;
    notes.push(`weekly window ${(weekly * 100).toFixed(0)}% remaining`);
  }
  return { value: Math.min(1, value), detail: notes.join('; ') };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export interface ScoreCandidateInput {
  prediction: CandidatePrediction;
  policy: AdaptiveSchedulerPolicy;
  forecast: QuotaForecast;
}

/**
 * Score one candidate. Pure, deterministic, and fully itemized: every
 * component records its raw value, its unit, its normalized form, its
 * weight, and its signed contribution, so a diagnostic can explain a
 * decision as a sentence rather than as a bare number.
 */
export function scoreCandidate(input: ScoreCandidateInput): UtilityScore {
  const { prediction, policy } = input;
  const weights = policy.weights;
  const components: UtilityComponent[] = [];

  // --- verified success --------------------------------------------------
  const successNormalized = prediction.verifiedSuccessProbability;
  components.push({
    name: 'verifiedSuccess',
    raw: successNormalized,
    unit: 'probability',
    normalized: successNormalized,
    weight: weights.successWeight,
    contribution: weights.successWeight * successNormalized,
    detail:
      `${(successNormalized * 100).toFixed(0)}% smoothed probability of verified completion ` +
      `(${prediction.sampleCount} sample(s), ${prediction.level}, confidence ${prediction.confidence})`,
  });

  // --- latency to a verified completion ----------------------------------
  const latencyNormalized = normalize(prediction.expectedTotalWallTimeMs, policy.wallTimeScaleMs);
  components.push({
    name: 'latency',
    raw: prediction.expectedTotalWallTimeMs,
    unit: 'ms',
    normalized: latencyNormalized,
    weight: weights.latencyPenalty,
    contribution: -weights.latencyPenalty * latencyNormalized,
    detail:
      prediction.expectedTotalWallTimeMs === null
        ? 'No wall-time history or heuristic; latency is unpriced rather than guessed.'
        : `${Math.round(prediction.expectedTotalWallTimeMs / 60_000)} min expected to a verified ` +
          `completion across ${prediction.expectedAttempts.toFixed(1)} attempt(s)`,
  });

  // --- failed work -------------------------------------------------------
  //
  // Resources consumed by attempts that will NOT verify, amplified by the
  // observed no-progress rates. A target that eventually succeeds after
  // stalling and oscillating has been more expensive than its eventual
  // success rate suggests, and this is where that shows up.
  const riskMultiplier =
    1 +
    (prediction.stagnationRate ?? 0) +
    (prediction.oscillationRate ?? 0) +
    (prediction.runawayRate ?? 0);
  const failedWorkNormalized = Math.min(
    1,
    normalize(prediction.expectedFailedWallTimeMs, policy.failedWorkScaleMs) * riskMultiplier,
  );
  components.push({
    name: 'failedWork',
    raw: prediction.expectedFailedWallTimeMs,
    unit: 'ms',
    normalized: failedWorkNormalized,
    weight: weights.failedWorkPenalty,
    contribution: -weights.failedWorkPenalty * failedWorkNormalized,
    detail:
      prediction.expectedFailedWallTimeMs === null
        ? 'No failed-work history; the retry burden is unpriced rather than guessed.'
        : `${Math.round(prediction.expectedFailedWallTimeMs / 60_000)} min expected on attempts ` +
          `that do not verify, x${riskMultiplier.toFixed(2)} for observed no-progress rates ` +
          `(stalled ${formatRate(prediction.stagnationRate)}, oscillating ` +
          `${formatRate(prediction.oscillationRate)}, runaway ${formatRate(prediction.runawayRate)})`,
  });

  // --- subscription quota opportunity cost -------------------------------
  const quota = quotaOpportunityCost({
    lane: prediction.candidate.lane,
    forecast: input.forecast,
  });
  components.push({
    name: 'quotaOpportunityCost',
    raw: quota.value,
    unit: 'pressure index (-1..1, not money)',
    normalized: quota.value,
    weight: weights.quotaPressurePenalty,
    contribution: -weights.quotaPressurePenalty * quota.value,
    detail: quota.detail,
  });

  // --- metered cost per verified completion ------------------------------
  const costPerCompletion =
    prediction.expectedApiCostUsd === null
      ? null
      : prediction.expectedApiCostUsd * prediction.expectedAttempts;
  const costNormalized = normalize(costPerCompletion, policy.apiCostScaleUsd);
  components.push({
    name: 'apiCost',
    raw: costPerCompletion,
    unit: 'USD',
    normalized: costNormalized,
    weight: weights.apiCostPenalty,
    contribution: -weights.apiCostPenalty * costNormalized,
    detail:
      costPerCompletion === null
        ? 'No observed metered cost for this target (unpriced here; current pricing governs spending).'
        : `$${costPerCompletion.toFixed(4)} expected per verified completion`,
  });

  // --- context cost per verified completion ------------------------------
  //
  // Priced per COMPLETION, not per prompt. A strategy that sends a smaller
  // package and then needs two more attempts and an expansion has not saved
  // anything, and pricing the initial prompt size alone would score that
  // backwards.
  const contextPerCompletion =
    prediction.expectedContextTokens === null
      ? null
      : prediction.expectedContextTokens *
        prediction.expectedAttempts *
        (1 + (prediction.contextExpansionRate ?? 0));
  const contextNormalized = normalize(contextPerCompletion, policy.contextTokenScale);
  components.push({
    name: 'contextCost',
    raw: contextPerCompletion,
    unit: 'tokens',
    normalized: contextNormalized,
    weight: weights.contextCostPenalty,
    contribution: -weights.contextCostPenalty * contextNormalized,
    detail:
      contextPerCompletion === null
        ? 'No context-size history for this target.'
        : `${Math.round(contextPerCompletion).toLocaleString('en-US')} tokens per verified ` +
          `completion (expansion rate ${formatRate(prediction.contextExpansionRate)}, ` +
          `context-miss rate ${formatRate(prediction.contextMissRate)})`,
  });

  // --- handoff / startup overhead ----------------------------------------
  const handoffNormalized = normalize(
    prediction.candidate.handoffOverheadMs,
    policy.wallTimeScaleMs,
  );
  components.push({
    name: 'handoff',
    raw: prediction.candidate.handoffOverheadMs,
    unit: 'ms',
    normalized: handoffNormalized,
    weight: weights.handoffPenalty,
    contribution: -weights.handoffPenalty * handoffNormalized,
    detail: `${Math.round(prediction.candidate.handoffOverheadMs / 1_000)}s fixed startup overhead`,
  });

  const score = components.reduce((sum, component) => sum + component.contribution, 0);
  return { candidateId: prediction.candidate.candidateId, score, components };
}

function formatRate(value: number | null): string {
  return value === null ? 'unknown' : `${(value * 100).toFixed(0)}%`;
}

/**
 * Render a score breakdown a human can read.
 *
 * A diagnostic that prints `score = 0.713` explains nothing, and a decision
 * nobody can explain is a decision nobody can review. This produces the
 * comparison itself: which components differ, by how much, and in whose
 * favour.
 */
export function explainComparison(
  winner: { prediction: CandidatePrediction; score: UtilityScore },
  runnerUp: { prediction: CandidatePrediction; score: UtilityScore } | undefined,
): string[] {
  const lines: string[] = [];
  const label = describeCandidate(winner.prediction);
  if (runnerUp === undefined) {
    lines.push(`${label} is the only eligible candidate.`);
  } else {
    const other = describeCandidate(runnerUp.prediction);
    lines.push(
      `${label} scores ${winner.score.score.toFixed(3)} against ${other} at ` +
        `${runnerUp.score.score.toFixed(3)} (margin ${(winner.score.score - runnerUp.score.score).toFixed(3)}).`,
    );
    lines.push(
      `verified success: ${(winner.prediction.verifiedSuccessProbability * 100).toFixed(0)}% vs ` +
        `${(runnerUp.prediction.verifiedSuccessProbability * 100).toFixed(0)}%`,
    );
    if (
      winner.prediction.expectedTotalWallTimeMs !== null &&
      runnerUp.prediction.expectedTotalWallTimeMs !== null
    ) {
      lines.push(
        `time to verified completion: ${Math.round(winner.prediction.expectedTotalWallTimeMs / 60_000)}m vs ` +
          `${Math.round(runnerUp.prediction.expectedTotalWallTimeMs / 60_000)}m (retries included)`,
      );
    }
    lines.push(
      `expected attempts: ${winner.prediction.expectedAttempts.toFixed(1)} vs ` +
        `${runnerUp.prediction.expectedAttempts.toFixed(1)}`,
    );
    if (winner.prediction.candidate.lane === runnerUp.prediction.candidate.lane) {
      lines.push(`economic lane: both ${winner.prediction.candidate.lane}`);
    }
  }
  lines.push(
    `confidence: ${winner.prediction.confidence} ` +
      `(${winner.prediction.sampleCount} sample(s) at ${winner.prediction.level})`,
  );
  return lines;
}

export function describeCandidate(prediction: CandidatePrediction): string {
  const candidate = prediction.candidate;
  const parts: string[] = [candidate.lane];
  if (candidate.executionMode !== null) parts.push(candidate.executionMode);
  if (candidate.runner !== null) parts.push(candidate.runner);
  return parts.join('/');
}
