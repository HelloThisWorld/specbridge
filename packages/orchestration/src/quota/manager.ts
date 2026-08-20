import type { JobSchedulerPolicy } from '@specbridge/core';
import type { QuotaTelemetryFreshness, SchedulerMode } from '../scheduling/vocabulary.js';
import type { QuotaForecast, QuotaWindowSnapshot } from './state.js';
import { quotaForecastSchema, timeToResetMs } from './state.js';
import type { QuotaTelemetryProvider } from './telemetry.js';

/**
 * SubscriptionQuotaManager (vNext.2): turns raw telemetry observations into
 * the QuotaForecast the scheduler consumes.
 *
 * Everything policy-relevant is a pure exported function over VALUES —
 * freshness, mode derivation, forecast assembly — so scheduler behavior is
 * exactly reproducible in tests with a fake clock and fake telemetry. The
 * manager class is a thin composition: provider + policy + clock.
 *
 * Two invariants live here:
 *
 *   - the five-hour and weekly windows are independent constraints; no code
 *     path merges them into one percentage
 *   - weekly scarcity dominates five-hour harvesting: HARVEST is refused
 *     under weekly pressure however imminent the five-hour reset is
 */

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** Freshness of one observation against the configured staleness bound. */
export function assessSnapshotFreshness(
  snapshot: QuotaWindowSnapshot | null,
  now: Date,
  staleMs: number,
): QuotaTelemetryFreshness {
  if (snapshot === null || snapshot.remainingRatio === null) return 'UNKNOWN';
  const observed = Date.parse(snapshot.observedAt);
  if (Number.isNaN(observed)) return 'UNKNOWN';
  return now.getTime() - observed > staleMs ? 'STALE' : 'FRESH';
}

/** Combined freshness: the WEAKEST of the windows that matter. */
export function combineFreshness(
  fiveHour: QuotaTelemetryFreshness,
  weekly: QuotaTelemetryFreshness,
): QuotaTelemetryFreshness {
  if (fiveHour === 'UNKNOWN' && weekly === 'UNKNOWN') return 'UNKNOWN';
  if (fiveHour === 'UNKNOWN' || weekly === 'UNKNOWN') {
    // One observed window still lets conservative scheduling act; the
    // combination is stale-grade, never fresh.
    return 'STALE';
  }
  return fiveHour === 'STALE' || weekly === 'STALE' ? 'STALE' : 'FRESH';
}

// ---------------------------------------------------------------------------
// Scheduler mode derivation
// ---------------------------------------------------------------------------

export interface DeriveModeInput {
  fiveHourRemainingRatio: number | null;
  timeToFiveHourResetMs: number | null;
  weeklyRemainingRatio: number | null;
  freshness: QuotaTelemetryFreshness;
  policy: JobSchedulerPolicy;
}

/**
 * Derive the scheduler mode. Order is policy, expressed once:
 *
 *   1. weekly exhausted        -> EXHAUSTED_WEEKLY  (dominates everything)
 *   2. five-hour exhausted     -> EXHAUSTED_5H
 *   3. weekly pressure         -> CONSERVE          (suppresses HARVEST)
 *   4. reset near + capacity   -> HARVEST           (fresh telemetry only)
 *   5. five-hour low, reset far-> CONSERVE
 *   6. otherwise               -> NORMAL
 *
 * Unknown windows never trigger HARVEST and never count as exhausted: with
 * no telemetry the scheduler stays in NORMAL, carries UNKNOWN freshness,
 * and the reserve policy adds its uncertainty margin instead.
 */
export function deriveSchedulerMode(input: DeriveModeInput): SchedulerMode {
  const { policy } = input;
  const fiveHour = input.fiveHourRemainingRatio;
  const weekly = input.weeklyRemainingRatio;

  if (weekly !== null && weekly <= policy.weeklyExhaustedRatio) return 'EXHAUSTED_WEEKLY';
  if (fiveHour !== null && fiveHour <= policy.fiveHourExhaustedRatio) return 'EXHAUSTED_5H';
  if (weekly !== null && weekly <= policy.weeklyPressureRatio) return 'CONSERVE';

  const resetNear =
    input.timeToFiveHourResetMs !== null && input.timeToFiveHourResetMs <= policy.harvestWindowMs;
  if (
    resetNear &&
    fiveHour !== null &&
    fiveHour >= policy.harvestMinRemainingRatio &&
    input.freshness === 'FRESH'
  ) {
    return 'HARVEST';
  }
  if (fiveHour !== null && fiveHour <= policy.conserveRemainingRatio && !resetNear) {
    return 'CONSERVE';
  }
  return 'NORMAL';
}

// ---------------------------------------------------------------------------
// Forecast assembly
// ---------------------------------------------------------------------------

export interface BuildForecastInput {
  fiveHour: QuotaWindowSnapshot | null;
  weekly: QuotaWindowSnapshot | null;
  now: Date;
  policy: JobSchedulerPolicy;
  /** Ledger-derived observed burn rate (five-hour ratio per minute). */
  observedFiveHourBurnRatePerMinute?: number | null | undefined;
}

export function buildQuotaForecast(input: BuildForecastInput): QuotaForecast {
  const { now, policy } = input;
  const fiveHourFreshness = assessSnapshotFreshness(input.fiveHour, now, policy.telemetryStaleMs);
  const weeklyFreshness = assessSnapshotFreshness(input.weekly, now, policy.telemetryStaleMs);
  const freshness = combineFreshness(fiveHourFreshness, weeklyFreshness);

  // A stale/unknown window's VALUES still flow into the forecast — the
  // conservative handling is expressed through freshness-aware mode and
  // reserve policy, never by silently pretending stale data is current.
  const fiveHourRemaining = input.fiveHour?.remainingRatio ?? null;
  const weeklyRemaining = input.weekly?.remainingRatio ?? null;
  const timeToFiveHour = timeToResetMs(input.fiveHour?.resetAt ?? null, now);
  const timeToWeekly = timeToResetMs(input.weekly?.resetAt ?? null, now);
  const burnRate = input.observedFiveHourBurnRatePerMinute ?? null;
  const projected =
    burnRate !== null && timeToFiveHour !== null
      ? Math.min(1, burnRate * (timeToFiveHour / 60_000))
      : null;

  const schedulerMode = deriveSchedulerMode({
    fiveHourRemainingRatio: fiveHourRemaining,
    timeToFiveHourResetMs: timeToFiveHour,
    weeklyRemainingRatio: weeklyRemaining,
    freshness,
    policy,
  });

  const observedTimes = [input.fiveHour?.observedAt, input.weekly?.observedAt]
    .filter((value): value is string => typeof value === 'string')
    .sort();

  return quotaForecastSchema.parse({
    fiveHourRemainingRatio: fiveHourRemaining,
    fiveHourResetAt: input.fiveHour?.resetAt ?? null,
    timeToFiveHourResetMs: timeToFiveHour,
    weeklyRemainingRatio: weeklyRemaining,
    weeklyResetAt: input.weekly?.resetAt ?? null,
    timeToWeeklyResetMs: timeToWeekly,
    observedFiveHourBurnRatePerMinute: burnRate,
    projectedBurnUntilFiveHourReset: projected,
    schedulerMode,
    telemetryFreshness: freshness,
    observedAt: observedTimes[0] ?? null,
    forecastAt: now.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface SubscriptionQuotaManagerOptions {
  provider: QuotaTelemetryProvider;
  policy: JobSchedulerPolicy;
  clock?: (() => Date) | undefined;
  /** Supplies the ledger-derived burn rate, when observations exist. */
  burnRateSupplier?: (() => number | null) | undefined;
}

/**
 * The runtime composition: read both windows from the provider, derive the
 * forecast. Stateless between calls apart from its collaborators — every
 * scheduling pass re-reads telemetry so a refreshed observation takes
 * effect immediately.
 */
export class SubscriptionQuotaManager {
  constructor(private readonly options: SubscriptionQuotaManagerOptions) {}

  get source(): string {
    return this.options.provider.source;
  }

  async snapshot(): Promise<{ fiveHour: QuotaWindowSnapshot | null; weekly: QuotaWindowSnapshot | null }> {
    const [fiveHour, weekly] = await Promise.all([
      this.options.provider.getFiveHourQuota(),
      this.options.provider.getWeeklyQuota(),
    ]);
    return { fiveHour, weekly };
  }

  async forecast(): Promise<QuotaForecast> {
    const { fiveHour, weekly } = await this.snapshot();
    const now = (this.options.clock ?? (() => new Date()))();
    return buildQuotaForecast({
      fiveHour,
      weekly,
      now,
      policy: this.options.policy,
      observedFiveHourBurnRatePerMinute: this.options.burnRateSupplier?.() ?? null,
    });
  }
}
