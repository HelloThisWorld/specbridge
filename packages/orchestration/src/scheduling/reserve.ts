import type { DynamicReservePolicy } from '@specbridge/core';
import type { QuotaForecast } from '../quota/state.js';

/**
 * DynamicReserve (vNext.2): the slice of the current five-hour window the
 * scheduler will not spend on newly admitted work.
 *
 * Never one permanent fixed percentage. The reserve interpolates with the
 * time to reset:
 *
 *   timeToReset >= farResetMs   -> baseRatio
 *   timeToReset <= nearResetMs  -> minRatio
 *   in between                  -> linear interpolation
 *
 * because unused capacity has DECLINING future value as the reset
 * approaches: protecting 20% ten minutes before it expires protects
 * nothing. Weekly pressure and stale/unknown telemetry ADD reserve —
 * uncertainty always tightens admission, never loosens it. All thresholds
 * come from configuration (`orchestration.jobs.scheduler.reserve`).
 */

export interface DynamicReserveResult {
  /** The five-hour reserve ratio applied to admission. */
  ratio: number;
  /** How the value was formed, for decision records and debugging. */
  basis: {
    timeComponent: number;
    weeklyPressureExtra: number;
    staleTelemetryExtra: number;
  };
}

export interface ComputeReserveInput {
  forecast: Pick<
    QuotaForecast,
    'timeToFiveHourResetMs' | 'weeklyRemainingRatio' | 'telemetryFreshness'
  >;
  policy: DynamicReservePolicy;
  /** Weekly remaining at or under this ratio counts as pressure. */
  weeklyPressureRatio: number;
}

/** Compute the dynamic reserve. Pure and deterministic. */
export function computeDynamicReserve(input: ComputeReserveInput): DynamicReserveResult {
  const { policy, forecast } = input;

  let timeComponent: number;
  const timeToReset = forecast.timeToFiveHourResetMs;
  if (timeToReset === null) {
    // Unknown reset timing: the conservative end of the interpolation.
    timeComponent = policy.baseRatio;
  } else if (timeToReset >= policy.farResetMs) {
    timeComponent = policy.baseRatio;
  } else if (timeToReset <= policy.nearResetMs) {
    timeComponent = policy.minRatio;
  } else {
    const span = policy.farResetMs - policy.nearResetMs;
    const progress = (timeToReset - policy.nearResetMs) / span;
    timeComponent = policy.minRatio + (policy.baseRatio - policy.minRatio) * progress;
  }

  const weeklyPressureExtra =
    forecast.weeklyRemainingRatio !== null &&
    forecast.weeklyRemainingRatio <= input.weeklyPressureRatio
      ? policy.weeklyPressureExtraRatio
      : 0;
  const staleTelemetryExtra =
    forecast.telemetryFreshness === 'FRESH' ? 0 : policy.staleTelemetryExtraRatio;

  return {
    ratio: Math.min(0.95, timeComponent + weeklyPressureExtra + staleTelemetryExtra),
    basis: { timeComponent, weeklyPressureExtra, staleTelemetryExtra },
  };
}
