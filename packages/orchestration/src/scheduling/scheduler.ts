import type { JobSchedulerPolicy } from '@specbridge/core';
import type { QuotaForecast } from '../quota/state.js';
import type { SubscriptionAdmission } from './admission.js';
import { assessContextAdmission, assessSubscriptionAdmission } from './admission.js';
import type { WorkloadEstimate } from './profiler.js';
import type { SuitabilityAssessment } from './suitability.js';
import type { ExecutionShapeAssessment } from './execution-shape.js';
import type { LocalExecutionResolution } from './local-resolver.js';
import type { ApiGapBridgePlan } from './api-gap-bridge.js';
import type { TaskSignature } from '../adaptive/signature.js';
import type { LaneDecision, SchedulingReasonCode } from './vocabulary.js';

/**
 * CooldownAwareScheduler (vNext.2): the pure lane-decision core.
 *
 * Given one candidate task's estimate and suitability, the quota forecast
 * (which carries the derived scheduler mode), the dynamic reserve, and
 * context status, decide:
 *
 *   LOCAL         run on the local lane now
 *   SUBSCRIPTION  run on the prepaid strong lane now (possibly compacting
 *                 context first, possibly crossing the coming quota reset)
 *   DEFER         no lane can take it now; wait with a recorded reason and
 *                 the time capacity is expected to return
 *
 * Everything here is a pure function over values — the driver supplies
 * telemetry and estimates, `scheduleNext` folds the routing into its
 * decision, and tests replay any scenario deterministically.
 *
 * Policy shape (the phase's required invariants, in one place):
 *   - LOCAL_SAFE work runs locally whenever a local worker exists — quota
 *     is never spent on work the free lane performs reliably
 *   - LOCAL_TRY work attempts the local lane FIRST in every mode; even in
 *     HARVEST, expiring subscription capacity goes to work that needs
 *     strong intelligence, never to mechanical local-capable work
 *   - STRONG_REQUIRED work admits by expected PRE-RESET BURN (cross-reset
 *     by design), against remaining capacity minus the dynamic reserve,
 *     with the five-hour and weekly windows checked independently
 *   - exhausted modes defer strong work with the reset time attached while
 *     local work keeps flowing — subscription cooldown never suspends the
 *     job globally
 */

export interface LaneRoutingInput {
  estimate: WorkloadEstimate;
  forecast: QuotaForecast;
  /** Dynamic reserve in force (scheduling/reserve.ts). */
  reserveRatio: number;
  /** The stale-telemetry share of that reserve (attribution for reasons). */
  staleReserveExtraRatio?: number | undefined;
  /** A healthy local worker exists (read-only reasoning at minimum). */
  localWorkerAvailable: boolean;
  /** The local EXECUTION path may mutate source (policy + verification). */
  localExecutionAvailable: boolean;
  /** Local attempts were exhausted; strong escalation is mandatory. */
  localEscalationRequired?: boolean | undefined;
  /** Estimated context occupancy ratio for the task, when known. */
  contextUsageRatio?: number | null | undefined;
  policy: JobSchedulerPolicy;
}

export interface LaneRouting {
  lane: LaneDecision;
  reasonCode: SchedulingReasonCode;
  /** Context must be compacted/reconstructed before the dispatch. */
  compactFirst: boolean;
  /** For DEFER: when capacity is expected to return (ISO), when known. */
  deferUntil: string | null;
  admission: SubscriptionAdmission | null;
  detail: string;
}

function subscriptionRouting(
  input: LaneRoutingInput,
  baseReason: SchedulingReasonCode,
): LaneRouting {
  const { forecast, policy } = input;
  const mode = forecast.schedulerMode;

  if (mode === 'EXHAUSTED_5H') {
    return {
      lane: 'DEFER',
      reasonCode: 'FIVE_HOUR_EXHAUSTED',
      compactFirst: false,
      deferUntil: forecast.fiveHourResetAt,
      admission: null,
      detail: 'The five-hour subscription window is exhausted; strong work waits for its reset.',
    };
  }
  if (mode === 'EXHAUSTED_WEEKLY') {
    return {
      lane: 'DEFER',
      reasonCode: 'WEEKLY_EXHAUSTED',
      compactFirst: false,
      deferUntil: forecast.weeklyResetAt,
      admission: null,
      detail: 'The weekly subscription window is exhausted; strong work waits for its reset.',
    };
  }

  const admission = assessSubscriptionAdmission({
    estimate: input.estimate,
    forecast,
    reserveRatio: input.reserveRatio,
    policy,
  });
  const context = assessContextAdmission({
    contextUsageRatio: input.contextUsageRatio ?? null,
    policy,
  });

  if (admission.admissible) {
    const reasonCode: SchedulingReasonCode = context.compactFirst
      ? 'COMPACT_BEFORE_EXECUTION'
      : admission.crossesReset
        ? 'CROSS_RESET_ADMITTED'
        : mode === 'HARVEST'
          ? 'HARVEST_EXPIRING_CAPACITY'
          : baseReason;
    return {
      lane: 'SUBSCRIPTION',
      reasonCode,
      compactFirst: context.compactFirst,
      deferUntil: null,
      admission,
      detail: context.compactFirst ? `${context.detail} ${admission.detail}` : admission.detail,
    };
  }

  // Not admissible. Attribute the refusal precisely: weekly scarcity, a
  // stale-telemetry margin that tipped the comparison, CONSERVE's larger
  // reserve, or plainly unsafe pre-reset burn.
  if (admission.refusal === 'weekly') {
    return {
      lane: 'DEFER',
      reasonCode: 'WEEKLY_QUOTA_PRESSURE',
      compactFirst: false,
      deferUntil: forecast.weeklyResetAt,
      admission,
      detail: admission.detail,
    };
  }
  const staleExtra = input.staleReserveExtraRatio ?? 0;
  if (forecast.telemetryFreshness !== 'FRESH' && staleExtra > 0) {
    const withoutStale = assessSubscriptionAdmission({
      estimate: input.estimate,
      forecast,
      reserveRatio: Math.max(0, input.reserveRatio - staleExtra),
      policy,
    });
    if (withoutStale.admissible) {
      return {
        lane: 'DEFER',
        reasonCode: 'STALE_TELEMETRY_CONSERVATIVE',
        compactFirst: false,
        deferUntil: null,
        admission,
        detail: `Quota telemetry is ${forecast.telemetryFreshness}; the stale-telemetry margin defers this work until a fresh observation. ${admission.detail}`,
      };
    }
  }
  return {
    lane: 'DEFER',
    reasonCode: mode === 'CONSERVE' ? 'CONSERVE_QUOTA' : 'PRE_RESET_BURN_UNSAFE',
    compactFirst: false,
    deferUntil: forecast.fiveHourResetAt,
    admission,
    detail: admission.detail,
  };
}

/** Decide the lane for one candidate dispatch. Pure and deterministic. */
export function decideLane(input: LaneRoutingInput): LaneRouting {
  const suitability = input.estimate.localSuitability;
  const localEligible = suitability === 'LOCAL_SAFE' || suitability === 'LOCAL_TRY';

  // Task-level local dispatch runs through the SpecBridge-driven local
  // execution path (structured output + applied edits + deterministic
  // verification) for LOCAL_SAFE and LOCAL_TRY alike — a "safe" task still
  // completes through the same evidence pipeline as any other.
  if (localEligible && input.localExecutionAvailable) {
    // Local-first in EVERY mode: deterministic verification catches an
    // imperfect local result, and expiring subscription capacity is worth
    // more spent on strong work than on work the free lane can attempt.
    return suitability === 'LOCAL_SAFE'
      ? {
          lane: 'LOCAL',
          reasonCode: 'LOCAL_SAFE',
          compactFirst: false,
          deferUntil: null,
          admission: null,
          detail: 'LOCAL_SAFE work runs on the local lane without consuming subscription quota.',
        }
      : {
          lane: 'LOCAL',
          reasonCode: 'LOCAL_TRY_FIRST',
          compactFirst: false,
          deferUntil: null,
          admission: null,
          detail: 'LOCAL_TRY work attempts the local lane first; deterministic verification decides the outcome.',
        };
  }

  const baseReason: SchedulingReasonCode =
    input.localEscalationRequired === true
      ? 'LOCAL_ESCALATION_REQUIRED'
      : localEligible
        ? 'LOCAL_UNAVAILABLE'
        : 'STRONG_REQUIRED';
  return subscriptionRouting(input, baseReason);
}

/**
 * One node's complete lane assessment, precomputed by the driver from
 * durable inputs (suitability, estimate, routing) and consumed by
 * `scheduleNext`. A value object: recomputing it from the same durable
 * state yields the same routing.
 */
export interface NodeLaneRouting {
  suitability: SuitabilityAssessment;
  estimate: WorkloadEstimate;
  routing: LaneRouting;
  /**
   * vNext.4: execution shape and the resolved LOCAL execution mode. Present
   * only when the lane decision was LOCAL — the mode is a property of the
   * lane's execution, never an input to choosing the lane.
   */
  shape?: ExecutionShapeAssessment | undefined;
  localExecution?: LocalExecutionResolution | undefined;
  /**
   * vNext.5: the gap-bridge plan, present ONLY when the subscription lane
   * refused this work for a capacity reason and the planner was therefore
   * consulted. Absent on every LOCAL and SUBSCRIPTION routing by
   * construction — the paid lane is never an alternative to a lane that
   * could run the work.
   */
  apiBridge?: ApiGapBridgePlan | undefined;
  /**
   * vNext.8: the deterministic TaskSignature this node was assessed under.
   *
   * Computed on EVERY pass, including in adaptive HEURISTIC mode, and
   * recorded on the attempt. That is deliberate: a workspace only ever gets
   * comparable history if the grouping key travels with the observation from
   * the start, so switching the adaptive scheduler on later finds data
   * already there rather than starting from nothing. Computing it changes no
   * behavior — it is a pure classification over values the scheduler has
   * already derived.
   */
  signature?: TaskSignature | undefined;
}

/**
 * Fold a gap-bridge plan into the lane routing that produced it (vNext.5).
 *
 * `decideLane` is deliberately left untouched by this phase: it still
 * knows only LOCAL, SUBSCRIPTION, and DEFER, and it still cannot be talked
 * into a paid lane. The bridge is applied strictly AFTER it, and only to a
 * routing it already refused — so the economic ordering is enforced by the
 * call graph, not by a comment.
 */
export function applyApiGapBridge(routing: LaneRouting, plan: ApiGapBridgePlan): LaneRouting {
  if (routing.lane !== 'DEFER') return routing;
  switch (plan.decision) {
    case 'API':
      return {
        ...routing,
        lane: 'API',
        reasonCode: plan.reasonCode,
        compactFirst: routing.compactFirst,
        deferUntil: null,
        detail: plan.detail,
      };
    case 'REQUIRE_APPROVAL':
      return {
        ...routing,
        lane: 'REQUIRE_APPROVAL',
        reasonCode: plan.reasonCode,
        deferUntil: null,
        detail: plan.detail,
      };
    case 'DEFER':
      return {
        ...routing,
        reasonCode: plan.reasonCode,
        deferUntil: plan.deferUntil ?? routing.deferUntil,
        detail: plan.detail,
      };
  }
}

// ---------------------------------------------------------------------------
// Ready-task selection
// ---------------------------------------------------------------------------

export interface ReadyCandidate {
  nodeId: string;
  /** Position in graph order (dependency-safe deterministic tie-break). */
  graphIndex: number;
  routing: LaneRouting;
}

export interface ReadySelection {
  nodeId: string;
  reason: string;
}

/**
 * Choose which READY node dispatches next. Every candidate has its
 * dependencies satisfied, so any order is dependency-safe; the selection
 * only optimizes lane utilization:
 *
 *   - work that can RUN NOW beats work that would defer (subscription
 *     cooldown must never idle the job while local-eligible work waits)
 *   - in HARVEST, admissible strong work beats local work: it consumes
 *     capacity that is about to expire, while local work costs the same
 *     whenever it runs
 *   - vNext.5: FREE work beats PAID work. A ready LOCAL or SUBSCRIPTION
 *     task runs before an API-bridged one, so the paid attempt happens only
 *     once the zero-cost and prepaid work in this pass is under way
 *   - otherwise graph order stands (the vNext.1 behavior)
 */
export function selectReadyCandidate(candidates: readonly ReadyCandidate[]): ReadySelection | undefined {
  if (candidates.length === 0) return undefined;
  const inGraphOrder = [...candidates].sort((a, b) => a.graphIndex - b.graphIndex);
  const first = inGraphOrder[0];
  if (first === undefined) return undefined;
  // REQUIRE_APPROVAL waits exactly like DEFER: nothing dispatches until a
  // human decides, so it must never be treated as runnable work.
  const runnable = inGraphOrder.filter(
    (candidate) => candidate.routing.lane !== 'DEFER' && candidate.routing.lane !== 'REQUIRE_APPROVAL',
  );
  if (runnable.length === 0) {
    return { nodeId: first.nodeId, reason: 'Every ready task defers; the first in graph order carries the wait.' };
  }
  const unpaid = runnable.filter((candidate) => candidate.routing.lane !== 'API');
  if (unpaid.length > 0 && unpaid.length !== runnable.length) {
    const chosen = unpaid[0];
    if (chosen !== undefined) {
      return {
        nodeId: chosen.nodeId,
        reason:
          'Free or prepaid work runs before paid bridging: the API-bridged task keeps its place ' +
          'and this pass spends no money.',
      };
    }
  }
  const harvestStrong = runnable.find(
    (candidate) =>
      candidate.routing.lane === 'SUBSCRIPTION' &&
      (candidate.routing.reasonCode === 'HARVEST_EXPIRING_CAPACITY' ||
        candidate.routing.reasonCode === 'CROSS_RESET_ADMITTED'),
  );
  if (harvestStrong !== undefined) {
    return {
      nodeId: harvestStrong.nodeId,
      reason: 'HARVEST: admissible strong work consumes five-hour capacity that would otherwise expire.',
    };
  }
  const chosen = runnable[0];
  if (chosen === undefined) return undefined;
  return {
    nodeId: chosen.nodeId,
    reason:
      chosen.nodeId === first.nodeId
        ? 'First ready task in graph order.'
        : `Task ${first.nodeId} defers (${first.routing.reasonCode}); the first runnable ready task proceeds instead.`,
  };
}
