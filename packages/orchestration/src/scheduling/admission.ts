import type { JobSchedulerPolicy } from '@specbridge/core';
import type { QuotaForecast } from '../quota/state.js';
import type { WorkloadEstimate } from './profiler.js';
import { expectedBurnBeforeReset } from './profiler.js';

/**
 * Subscription admission (vNext.2) — the cross-reset rule, made structural.
 *
 * Admission never asks "can the whole task finish before the quota reset?".
 * It asks:
 *
 *   How much quota will this task probably consume BEFORE the current
 *   window resets — and does that fit inside remaining capacity minus the
 *   dynamic reserve?
 *
 * The post-reset continuation is evaluated separately against a full fresh
 * window. A 50-minute task twenty minutes before a reset is therefore
 * admitted whenever its ~pre-reset slice fits — it starts now and continues
 * across the reset. `taskDuration <= timeToReset` appears nowhere in this
 * module, by requirement.
 *
 * Safety: expected burns are multiplied by the configurable
 * `burnSafetyMultiplier` before comparison — a conservative margin standing
 * in for the P90-style uncertainty later phases may measure. The five-hour
 * and weekly windows are checked INDEPENDENTLY; both must pass.
 */

export interface SubscriptionAdmissionInput {
  estimate: WorkloadEstimate;
  forecast: QuotaForecast;
  /** The dynamic five-hour reserve ratio in force. */
  reserveRatio: number;
  policy: JobSchedulerPolicy;
}

export interface SubscriptionAdmission {
  admissible: boolean;
  /** Expected five-hour burn before the coming reset (unmultiplied). */
  preResetBurnRatio: number;
  /** Expected five-hour burn after the reset (the continuation's share). */
  postResetBurnRatio: number;
  /** True when the task's expected runtime crosses the five-hour reset. */
  crossesReset: boolean;
  /** Which constraint failed, when not admissible. */
  refusal?: 'five-hour' | 'weekly' | undefined;
  detail: string;
}

/** Assess subscription admission for one estimated task. Pure. */
export function assessSubscriptionAdmission(
  input: SubscriptionAdmissionInput,
): SubscriptionAdmission {
  const { estimate, forecast, policy } = input;
  const safety = policy.burnSafetyMultiplier;

  const timeToReset = forecast.timeToFiveHourResetMs;
  const crossesReset = timeToReset !== null && estimate.expectedWallTimeMs > timeToReset;
  const preResetBurn =
    timeToReset === null
      ? estimate.expectedFiveHourBurnRatio
      : expectedBurnBeforeReset(estimate, timeToReset);
  const postResetBurn = Math.max(0, estimate.expectedFiveHourBurnRatio - preResetBurn);

  // Five-hour constraint: the pre-reset slice must fit inside remaining
  // capacity minus the dynamic reserve. An unobserved window admits (there
  // is nothing to compare against); the caller's freshness policy already
  // made the reserve conservative for that case.
  if (forecast.fiveHourRemainingRatio !== null) {
    const available = Math.max(0, forecast.fiveHourRemainingRatio - input.reserveRatio);
    const required = preResetBurn * safety;
    if (required > available) {
      return {
        admissible: false,
        preResetBurnRatio: preResetBurn,
        postResetBurnRatio: postResetBurn,
        crossesReset,
        refusal: 'five-hour',
        detail:
          `Pre-reset burn ${(preResetBurn * 100).toFixed(1)}% x${safety} safety exceeds ` +
          `${(forecast.fiveHourRemainingRatio * 100).toFixed(1)}% remaining minus ` +
          `${(input.reserveRatio * 100).toFixed(1)}% reserve.`,
      };
    }
  }

  // Post-reset continuation: evaluated against a FULL fresh window. Only a
  // task whose continuation could not fit even a complete window is refused
  // here — an ordinary cross-reset task passes trivially.
  if (postResetBurn * safety > 1) {
    return {
      admissible: false,
      preResetBurnRatio: preResetBurn,
      postResetBurnRatio: postResetBurn,
      crossesReset,
      refusal: 'five-hour',
      detail: `The post-reset continuation alone (${(postResetBurn * 100).toFixed(1)}% x${safety}) exceeds a full five-hour window.`,
    };
  }

  // Weekly constraint: the WHOLE task burns against the weekly window (its
  // reset is days away at task scale). Independent of the five-hour check.
  if (forecast.weeklyRemainingRatio !== null) {
    const weeklyRequired = estimate.expectedWeeklyBurnRatio * safety;
    if (weeklyRequired > forecast.weeklyRemainingRatio) {
      return {
        admissible: false,
        preResetBurnRatio: preResetBurn,
        postResetBurnRatio: postResetBurn,
        crossesReset,
        refusal: 'weekly',
        detail:
          `Expected weekly burn ${(estimate.expectedWeeklyBurnRatio * 100).toFixed(1)}% x${safety} ` +
          `exceeds ${(forecast.weeklyRemainingRatio * 100).toFixed(1)}% weekly remaining.`,
      };
    }
  }

  return {
    admissible: true,
    preResetBurnRatio: preResetBurn,
    postResetBurnRatio: postResetBurn,
    crossesReset,
    detail: crossesReset
      ? `Admitted across the reset: ~${(preResetBurn * 100).toFixed(1)}% burns before it, the task continues after.`
      : `Admitted: expected burn ${(estimate.expectedFiveHourBurnRatio * 100).toFixed(1)}% fits current capacity.`,
  };
}

// ---------------------------------------------------------------------------
// Context admission
// ---------------------------------------------------------------------------

export interface ContextAdmissionInput {
  /** Current estimated context occupancy ratio (0..1+) for the task. */
  contextUsageRatio: number | null;
  policy: JobSchedulerPolicy;
}

export interface ContextAdmission {
  ok: boolean;
  /** True when compaction/reconstruction must run before the dispatch. */
  compactFirst: boolean;
  detail: string;
}

/**
 * Context admission: quota capacity AND context capacity are both required.
 * A dispatch into a nearly exhausted context is refused-with-remedy: the
 * remedy is the vNext.1 checkpoint → compact → reconstruct path, after
 * which the dispatch proceeds. Unknown occupancy admits without compaction
 * (reconstruction itself budgets the package it builds).
 */
export function assessContextAdmission(input: ContextAdmissionInput): ContextAdmission {
  if (input.contextUsageRatio === null) {
    return { ok: true, compactFirst: false, detail: 'Context occupancy unknown; reconstruction will budget the package.' };
  }
  if (input.contextUsageRatio >= input.policy.contextCompactBeforeDispatchRatio) {
    return {
      ok: true,
      compactFirst: true,
      detail:
        `Context occupancy ${(input.contextUsageRatio * 100).toFixed(0)}% is at or above the ` +
        `${(input.policy.contextCompactBeforeDispatchRatio * 100).toFixed(0)}% pre-dispatch threshold; ` +
        'checkpoint + compact + reconstruct runs before the dispatch.',
    };
  }
  return { ok: true, compactFirst: false, detail: 'Context occupancy is healthy.' };
}
