import type { ExecutionLedgerEntry } from '../survival/state.js';

/**
 * Historical burn observations (vNext.2): normalized measurements derived
 * from the ExecutionLedger wherever an attempt recorded quota-before AND
 * quota-after snapshots.
 *
 * This is deliberately NOT a predictive model. It persists nothing of its
 * own — attempts are the source of truth — and simply normalizes what was
 * measured so the profiler (and later phases) can consult real burn rates:
 * quota consumed, wall time, burn per minute, success, grouped by task
 * category. Sparse data stays sparse: aggregation reports counts, and the
 * profiler refuses to overfit below its configured observation floor.
 */

export interface BurnObservation {
  attemptId: string;
  taskId: string;
  provider: string;
  lane: string | null;
  taskCategory: string | null;
  taskComplexity: string | null;
  /** Five-hour window ratio consumed during the attempt (>= 0). */
  fiveHourBurnRatio: number | null;
  /** Weekly window ratio consumed during the attempt (>= 0). */
  weeklyBurnRatio: number | null;
  wallTimeMs: number | null;
  /** Five-hour burn per minute, when both burn and duration are known. */
  fiveHourBurnRatioPerMinute: number | null;
  /**
   * vNext.5: provider-reported token usage, when the runner reported it.
   * Carried here so API cost estimation reads the SAME observation stream
   * the quota profiler already builds, instead of growing a second
   * estimator with its own idea of history.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  success: boolean;
  startedAt: string;
}

function ratioDelta(before: unknown, after: unknown): number | null {
  if (typeof before !== 'number' || typeof after !== 'number') return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  // A reset during the attempt makes after > before; the burn across the
  // boundary is not derivable from two endpoint observations, so the honest
  // answer is "unknown", never a negative or fabricated number.
  const delta = before - after;
  return delta >= 0 ? delta : null;
}

/** Derive burn observations from ledger entries. Unknown stays null. */
export function deriveBurnObservations(entries: readonly ExecutionLedgerEntry[]): BurnObservation[] {
  const observations: BurnObservation[] = [];
  for (const entry of entries) {
    const metrics = entry.metrics as Record<string, unknown>;
    const fiveHourBurn = ratioDelta(metrics['fiveHourQuotaBefore'], metrics['fiveHourQuotaAfter']);
    const weeklyBurn = ratioDelta(metrics['weeklyQuotaBefore'], metrics['weeklyQuotaAfter']);
    const wallTimeMs = entry.metrics.durationMs;
    const inputTokens = entry.metrics.inputTokens;
    const outputTokens = entry.metrics.outputTokens;
    if (
      fiveHourBurn === null &&
      weeklyBurn === null &&
      wallTimeMs === null &&
      inputTokens === null &&
      outputTokens === null
    ) {
      continue;
    }
    const burnPerMinute =
      fiveHourBurn !== null && wallTimeMs !== null && wallTimeMs > 0
        ? fiveHourBurn / (wallTimeMs / 60_000)
        : null;
    observations.push({
      attemptId: entry.attemptId,
      taskId: entry.taskId,
      provider: entry.provider,
      lane: entry.lane,
      taskCategory: typeof entry.taskCategory === 'string' ? entry.taskCategory : null,
      taskComplexity: typeof entry.taskComplexity === 'string' ? entry.taskComplexity : null,
      fiveHourBurnRatio: fiveHourBurn,
      weeklyBurnRatio: weeklyBurn,
      wallTimeMs,
      fiveHourBurnRatioPerMinute: burnPerMinute,
      inputTokens,
      outputTokens,
      cachedTokens: entry.metrics.cachedTokens,
      success: entry.success,
      startedAt: entry.startedAt,
    });
  }
  return observations;
}

export interface BurnAggregate {
  observations: number;
  medianFiveHourBurnRatio: number | null;
  medianWallTimeMs: number | null;
  medianFiveHourBurnRatioPerMinute: number | null;
  /** vNext.5: median reported token usage, when any observation reported it. */
  medianInputTokens: number | null;
  medianOutputTokens: number | null;
  /** How many observations actually reported token usage (sparsity is visible). */
  tokenObservations: number;
  successRate: number | null;
  /**
   * vNext.8: the CONSERVATIVE tail of the same measurements.
   *
   * Admission has always compared a median-shaped estimate multiplied by a
   * configured safety factor, with the multiplier standing in for
   * uncertainty nobody had measured yet. These are that measurement. They
   * are offered beside the medians rather than replacing them: an estimate
   * used for planning and an estimate used for refusing to spend prepaid
   * capacity are different numbers, and collapsing them would make one of
   * the two wrong.
   */
  p90FiveHourBurnRatio: number | null;
  p90WallTimeMs: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (sorted.length % 2 === 1) return high ?? null;
  return low !== undefined && high !== undefined ? (low + high) / 2 : null;
}

/** Nearest-rank P90 over the sample. Null for an empty sample. */
function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** Aggregate observations (optionally filtered) without fabricating gaps. */
export function aggregateBurnObservations(
  observations: readonly BurnObservation[],
  filter?: { taskComplexity?: string | undefined; taskCategory?: string | undefined; lane?: string | undefined },
): BurnAggregate {
  const relevant = observations.filter(
    (observation) =>
      (filter?.taskComplexity === undefined || observation.taskComplexity === filter.taskComplexity) &&
      (filter?.taskCategory === undefined || observation.taskCategory === filter.taskCategory) &&
      (filter?.lane === undefined || observation.lane === filter.lane),
  );
  const burns = relevant
    .map((observation) => observation.fiveHourBurnRatio)
    .filter((value): value is number => value !== null);
  const walls = relevant
    .map((observation) => observation.wallTimeMs)
    .filter((value): value is number => value !== null);
  const rates = relevant
    .map((observation) => observation.fiveHourBurnRatioPerMinute)
    .filter((value): value is number => value !== null);
  const inputs = relevant
    .map((observation) => observation.inputTokens)
    .filter((value): value is number => value !== null);
  const outputs = relevant
    .map((observation) => observation.outputTokens)
    .filter((value): value is number => value !== null);
  return {
    observations: relevant.length,
    medianFiveHourBurnRatio: median(burns),
    medianWallTimeMs: median(walls),
    medianFiveHourBurnRatioPerMinute: median(rates),
    medianInputTokens: median(inputs),
    medianOutputTokens: median(outputs),
    tokenObservations: Math.max(inputs.length, outputs.length),
    successRate:
      relevant.length > 0
        ? relevant.filter((observation) => observation.success).length / relevant.length
        : null,
    p90FiveHourBurnRatio: p90(burns),
    p90WallTimeMs: p90(walls),
  };
}

/**
 * The overall observed five-hour burn rate (ratio per minute) across recent
 * subscription-lane attempts — the forecast's `currentObservedBurnRate`.
 */
export function observedFiveHourBurnRate(observations: readonly BurnObservation[]): number | null {
  const rates = observations
    .filter((observation) => observation.lane === 'SUBSCRIPTION' || observation.lane === null)
    .map((observation) => observation.fiveHourBurnRatioPerMinute)
    .filter((value): value is number => value !== null)
    .slice(-10);
  return median(rates);
}
