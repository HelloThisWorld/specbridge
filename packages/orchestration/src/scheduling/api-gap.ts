import type { QuotaForecast } from '../quota/state.js';
import type {
  GapForecastConfidence,
  SchedulingReasonCode,
  SubscriptionGapReason,
} from './vocabulary.js';

/**
 * SubscriptionGapForecast (vNext.5): how long prepaid strong capacity is
 * expected to be unavailable, and how confident that answer is.
 *
 * Gap DURATION is the central input to API admission, and it is a
 * different question from gap CAUSE:
 *
 *   twelve minutes  → wait; the reset arrives before a handoff pays off
 *   ninety minutes  → a candidate, if the work is delay-sensitive
 *   two days        → the scenario the API gap bridge exists for
 *   unknown         → be MORE careful, never less
 *
 * Nothing here fabricates availability. When no reset timestamp is
 * observed, `expectedAvailableAt` stays null, `timeUntilAvailableMs` stays
 * null, and confidence is UNKNOWN — which the planner treats as a reason
 * for caution, not as permission to assume a long outage worth paying for.
 */

export interface SubscriptionGapForecast {
  reason: SubscriptionGapReason;
  /** When subscription capacity is expected to return (ISO); null if unknown. */
  expectedAvailableAt: string | null;
  /** Milliseconds until that return; null when unknown. Never fabricated. */
  timeUntilAvailableMs: number | null;
  confidence: GapForecastConfidence;
  detail: string;
}

/**
 * Map the lane scheduler's DEFER reason code onto a gap cause. Returns
 * undefined for defers that are NOT about subscription capacity — those
 * must never reach the paid lane, because paying to bridge a gap that does
 * not exist is exactly the failure mode this phase guards against.
 */
export function subscriptionGapReasonFor(
  reasonCode: SchedulingReasonCode,
): SubscriptionGapReason | undefined {
  switch (reasonCode) {
    case 'FIVE_HOUR_EXHAUSTED':
      return 'FIVE_HOUR_EXHAUSTED';
    case 'WEEKLY_EXHAUSTED':
      return 'WEEKLY_EXHAUSTED';
    case 'PRE_RESET_BURN_UNSAFE':
      return 'PRE_RESET_BURN_UNSAFE';
    case 'CONSERVE_QUOTA':
    case 'WEEKLY_QUOTA_PRESSURE':
    case 'STALE_TELEMETRY_CONSERVATIVE':
      return 'SUBSCRIPTION_TEMPORARILY_UNAVAILABLE';
    default:
      return undefined;
  }
}

export interface BuildSubscriptionGapForecastInput {
  reason: SubscriptionGapReason;
  forecast: QuotaForecast;
  /**
   * When the lane scheduler already computed a return time for this defer
   * (LaneRouting.deferUntil), it wins: it is the reset the refusal actually
   * pointed at.
   */
  deferUntil?: string | null | undefined;
  now: Date;
}

/** Build the gap forecast for one deferred strong task. Pure. */
export function buildSubscriptionGapForecast(
  input: BuildSubscriptionGapForecastInput,
): SubscriptionGapForecast {
  const { reason, forecast, now } = input;

  // A missing subscription WORKER is not a timed window: no reset returns
  // a worker that was never configured.
  if (reason === 'SUBSCRIPTION_WORKER_UNAVAILABLE') {
    return {
      reason,
      expectedAvailableAt: null,
      timeUntilAvailableMs: null,
      confidence: 'UNKNOWN',
      detail:
        'No subscription worker is available; this is a configuration gap, not a quota window, ' +
        'so no return time exists.',
    };
  }

  const preferred =
    input.deferUntil ??
    (reason === 'WEEKLY_EXHAUSTED' ? forecast.weeklyResetAt : forecast.fiveHourResetAt);
  if (preferred === null) {
    return {
      reason,
      expectedAvailableAt: null,
      timeUntilAvailableMs: null,
      confidence: 'UNKNOWN',
      detail:
        'Subscription capacity is unavailable and no reset time has been observed; the gap ' +
        'duration is unknown and is not guessed.',
    };
  }
  const parsed = Date.parse(preferred);
  if (Number.isNaN(parsed)) {
    return {
      reason,
      expectedAvailableAt: null,
      timeUntilAvailableMs: null,
      confidence: 'UNKNOWN',
      detail: `The recorded reset time "${preferred}" is not a parseable timestamp; the gap duration is unknown.`,
    };
  }

  const timeUntilAvailableMs = Math.max(0, parsed - now.getTime());
  // Telemetry freshness is exactly what separates "observed" from "derived
  // from a stale reading": a reset time from a stale snapshot may already
  // have passed unobserved.
  const confidence: GapForecastConfidence =
    forecast.telemetryFreshness === 'FRESH' ? 'HIGH' : 'MEDIUM';
  return {
    reason,
    expectedAvailableAt: new Date(parsed).toISOString(),
    timeUntilAvailableMs,
    confidence,
    detail:
      `Subscription capacity (${reason}) is expected back in ${formatDuration(timeUntilAvailableMs)} ` +
      `at ${new Date(parsed).toISOString()} (telemetry ${forecast.telemetryFreshness}).`,
  };
}

/** Human-readable duration for decision details. Deterministic. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes}m`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
