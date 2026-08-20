import { z } from 'zod';
import { QUOTA_TELEMETRY_FRESHNESS, QUOTA_WINDOWS, SCHEDULER_MODES } from '../scheduling/vocabulary.js';

/**
 * Subscription quota state (vNext.2).
 *
 * Two INDEPENDENT rolling windows — five-hour and weekly — are modeled
 * separately and never combined into one percentage. Every value is an
 * OBSERVATION with a timestamp and a source: SpecBridge never fabricates
 * quota numbers, and unknown stays null rather than becoming a guess.
 *
 * Ratios are fractions of the window's full capacity in [0, 1]. The
 * provider-facing CLI accepts percentages for humans; everything persisted
 * and computed here is a ratio.
 */

export const QUOTA_SNAPSHOT_SCHEMA_VERSION = '1.0.0';

const isoText = z.string().min(1).max(64);
const ratio = z.number().min(0).max(1);

/**
 * One observation of one quota window. `remainingRatio` is the load-bearing
 * field; `usedRatio` is recorded when the source reports it (they need not
 * sum to 1 while a window is partially observed).
 */
export const quotaWindowSnapshotSchema = z
  .object({
    window: z.enum(QUOTA_WINDOWS),
    remainingRatio: ratio.nullable().default(null),
    usedRatio: ratio.nullable().default(null),
    /** When this window's capacity fully refreshes. Null when unknown. */
    resetAt: isoText.nullable().default(null),
    /** When this observation was made — freshness derives from this. */
    observedAt: isoText,
    /** Where the observation came from (adapter identity, for audit). */
    source: z.string().min(1).max(200),
  })
  .passthrough();
export type QuotaWindowSnapshot = z.infer<typeof quotaWindowSnapshotSchema>;

/** The persisted shape of the manual telemetry file. */
export const quotaTelemetryFileSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default(QUOTA_SNAPSHOT_SCHEMA_VERSION),
    fiveHour: quotaWindowSnapshotSchema.nullable().default(null),
    weekly: quotaWindowSnapshotSchema.nullable().default(null),
  })
  .passthrough();
export type QuotaTelemetryFile = z.infer<typeof quotaTelemetryFileSchema>;

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

/**
 * The forecast the scheduler consumes: both windows, timing, freshness, the
 * observed burn rate where derivable, and the derived scheduler mode. A
 * VALUE, not a service — pure scheduling functions take it as input, so
 * every decision is exactly reproducible in tests.
 *
 * The initial forecast is heuristic (no predictive model): timing comes from
 * the snapshots, and `observedFiveHourBurnRatePerMinute` comes from ledger
 * history when quota-before/after observations exist.
 */
export const quotaForecastSchema = z
  .object({
    /** Five-hour window remaining, 0..1; null when unobserved. */
    fiveHourRemainingRatio: ratio.nullable(),
    fiveHourResetAt: isoText.nullable(),
    /** Milliseconds until the five-hour reset; null when unknown. */
    timeToFiveHourResetMs: z.number().int().min(0).nullable(),
    weeklyRemainingRatio: ratio.nullable(),
    weeklyResetAt: isoText.nullable(),
    timeToWeeklyResetMs: z.number().int().min(0).nullable(),
    /** Ledger-derived five-hour burn per minute; null without observations. */
    observedFiveHourBurnRatePerMinute: z.number().min(0).nullable(),
    /** Projected additional burn until the five-hour reset at that rate. */
    projectedBurnUntilFiveHourReset: ratio.nullable(),
    schedulerMode: z.enum(SCHEDULER_MODES),
    telemetryFreshness: z.enum(QUOTA_TELEMETRY_FRESHNESS),
    /** Oldest relevant observation timestamp; null when nothing observed. */
    observedAt: isoText.nullable(),
    /** The forecast's own clock reading. */
    forecastAt: isoText,
  })
  .passthrough();
export type QuotaForecast = z.infer<typeof quotaForecastSchema>;

/** Milliseconds from `now` to a snapshot's reset; null when unknown/past-less. */
export function timeToResetMs(resetAt: string | null, now: Date): number | null {
  if (resetAt === null) return null;
  const parsed = Date.parse(resetAt);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - now.getTime());
}
