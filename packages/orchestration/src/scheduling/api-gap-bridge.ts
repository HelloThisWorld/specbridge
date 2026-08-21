import type { ApiExecutionPolicy } from '@specbridge/core';
import type { ApiHarnessBinding } from './api-binding.js';
import type { ApiBudgetAdmission } from './api-budget.js';
import type { ApiCostEstimate } from './api-cost.js';
import type { SubscriptionGapForecast } from './api-gap.js';
import { formatDuration } from './api-gap.js';
import type { ApiApprovalCheck } from './api-approval.js';
import { delaySensitivityRank } from './delay-sensitivity.js';
import type { DelaySensitivityAssessment } from './delay-sensitivity.js';
import type { WorkloadEstimate } from './profiler.js';
import type { SchedulingReasonCode } from './vocabulary.js';

/**
 * ApiGapBridgePlanner (vNext.5): the one place that may conclude "pay".
 *
 * It runs LAST, and only over work both other lanes have already refused:
 *
 *          Task
 *            |
 *      Local suitability  ── capable ──▶  LOCAL
 *            |
 *      Subscription admission ── safe ──▶  SUBSCRIPTION
 *            |
 *      ApiGapBridgePlanner
 *        |      |       |
 *      DEFER  APPROVE  API
 *
 * That position is the primary invariant, not an implementation detail:
 * because the planner is never consulted while LOCAL or SUBSCRIPTION can
 * take the work, it structurally CANNOT evolve into "strong task → compare
 * Claude and the API and pick the better one". There is no comparison here
 * at all. There is only: prepaid capacity is gone, how long for, does that
 * hurt, and may we pay to bridge it.
 *
 * Pure and deterministic — every input is a value the caller gathered, so
 * a decision replays exactly from durable state, months later, in a test.
 *
 * Every path that does NOT spend is written first and explicitly. That
 * ordering is deliberate: the expensive branch should be the one that
 * survived every cheap objection, not the default that nothing blocked.
 */

export type ApiGapBridgeDecision = 'API' | 'DEFER' | 'REQUIRE_APPROVAL';

export interface ApiGapBridgePlan {
  decision: ApiGapBridgeDecision;
  reasonCode: SchedulingReasonCode;
  /** When to reconsider (ISO) for DEFER; null when unknown. */
  deferUntil: string | null;
  gap: SubscriptionGapForecast;
  delaySensitivity: DelaySensitivityAssessment;
  cost: ApiCostEstimate | null;
  budget: ApiBudgetAdmission | null;
  /** The approval that authorized (or failed to authorize) this spend. */
  approval: ApiApprovalCheck | null;
  /** True when the plan reached the point of proposing paid execution. */
  bridgeProposed: boolean;
  detail: string;
}

export interface ApiGapBridgeInput {
  policy: ApiExecutionPolicy;
  binding: ApiHarnessBinding;
  gap: SubscriptionGapForecast;
  delaySensitivity: DelaySensitivityAssessment;
  estimate: WorkloadEstimate;
  /** Cost estimate; null when no binding made estimation worth computing. */
  cost: ApiCostEstimate | null;
  /** Budget admission against durable reservations; null when not assessed. */
  budget: ApiBudgetAdmission | null;
  /** Approval state for this exact task version (MANUAL mode). */
  approval: ApiApprovalCheck | null;
  /** True when the subscription lane could take this work right now. */
  subscriptionAvailable: boolean;
  now: Date;
}

/** Plan whether a subscription gap justifies one bounded paid attempt. Pure. */
export function planApiGapBridge(input: ApiGapBridgeInput): ApiGapBridgePlan {
  const { policy, binding, gap, delaySensitivity, estimate } = input;
  const gapPolicy = policy.gap;
  const defer = (
    reasonCode: SchedulingReasonCode,
    detail: string,
    bridgeProposed = false,
  ): ApiGapBridgePlan => ({
    decision: 'DEFER',
    reasonCode,
    deferUntil: gap.expectedAvailableAt,
    gap,
    delaySensitivity,
    cost: input.cost,
    budget: input.budget,
    approval: input.approval,
    bridgeProposed,
    detail,
  });

  // ---- Cheap refusals, in the order that costs least to check -------------

  // The subscription lane is fine. This should be unreachable (the planner
  // runs only after a subscription refusal), and it is asserted anyway: a
  // future caller wiring the planner in earlier must not silently gain a
  // paid lane that competes with prepaid capacity.
  if (input.subscriptionAvailable) {
    return defer(
      'API_MAX_RETURNED_NEXT_TASK_SUBSCRIPTION',
      'Subscription capacity can take this work; the paid lane is not considered while prepaid ' +
        'strong compute is available.',
    );
  }

  if (policy.spendMode === 'DISABLED') {
    return defer(
      'API_DISABLED',
      'Paid API execution is not authorized (spend mode DISABLED); the task stays durably pending ' +
        'until subscription capacity returns.',
    );
  }

  if (!binding.available) {
    return defer(
      'API_BINDING_UNAVAILABLE',
      `No usable API binding: ${binding.status}${binding.problems[0] !== undefined ? ` — ${binding.problems[0]}` : '.'}`,
    );
  }

  // Strong work only. Mechanical, local-capable work stays local even
  // during a total subscription outage: paying a metered provider to
  // summarize a log is the exact waste this lane must not normalize.
  if (gapPolicy.strongTasksOnly && estimate.localSuitability !== 'STRONG_REQUIRED') {
    return defer(
      'API_STRONG_TASK_ONLY',
      `The paid lane takes strong work only; this task is ${estimate.localSuitability} and belongs ` +
        'on the local lane.',
    );
  }

  // ---- Gap shape ---------------------------------------------------------

  const timeUntil = gap.timeUntilAvailableMs;
  const materialByReason = gap.reason === 'WEEKLY_EXHAUSTED';

  if (timeUntil === null) {
    // Unknown return time. Caution INCREASES: an unknown gap is not
    // evidence of a long outage, and "we do not know" must never become
    // "therefore probably worth paying for".
    if (gapPolicy.unknownResetBehavior === 'DEFER') {
      return defer(
        'API_GAP_SHORT_DEFER',
        'Subscription capacity is unavailable with no known return time; policy defers rather ' +
          'than spending against an unknown gap.',
      );
    }
    return approvalPath(
      input,
      'Subscription capacity is unavailable with no known return time. Policy escalates unknown ' +
        'availability to a human rather than spending automatically.',
    );
  }

  if (!materialByReason && timeUntil <= gapPolicy.shortGapDeferMs) {
    return defer(
      'API_GAP_SHORT_DEFER',
      `Prepaid capacity returns in ${formatDuration(timeUntil)}, at or under the ` +
        `${formatDuration(gapPolicy.shortGapDeferMs)} short-gap threshold; waiting is cheaper than ` +
        'a paid handoff.',
    );
  }

  // Delay sensitivity. A long gap on work nothing waits for is still a
  // wait: the objective is a productive JOB, not one task executing every
  // second.
  if (
    delaySensitivityRank(delaySensitivity.level) <
    delaySensitivityRank(gapPolicy.minDelaySensitivity)
  ) {
    return defer(
      'API_DELAY_TOLERABLE',
      `Delay sensitivity is ${delaySensitivity.level} (policy requires at least ` +
        `${gapPolicy.minDelaySensitivity}): ${delaySensitivity.signals[0]?.evidence ?? 'nothing waits on this task'}.`,
    );
  }

  // Ready local backlog. Doing useful free work first beats paying to keep
  // one blocked task moving — unless the task is genuinely on the critical
  // path, which is the documented exception.
  if (
    gapPolicy.preferReadyLocalBacklog &&
    delaySensitivity.readyLocalBacklog > 0 &&
    !delaySensitivity.criticalPath &&
    !materialByReason
  ) {
    return defer(
      'API_LOCAL_BACKLOG_FIRST',
      `${delaySensitivity.readyLocalBacklog} local task(s) are ready to run at zero marginal cost; ` +
        'the job stays productive without paying to bridge this task.',
    );
  }

  // Wasteful start. Paying to begin work that prepaid capacity would
  // finish anyway spends money for a few minutes of head start.
  const wastefulThreshold = estimate.expectedWallTimeMs * gapPolicy.wastefulStartRatio;
  if (timeUntil <= wastefulThreshold && delaySensitivity.level !== 'HIGH') {
    return defer(
      'API_WASTEFUL_NEAR_RESET',
      `Prepaid capacity returns in ${formatDuration(timeUntil)}, inside the first ` +
        `${Math.round(gapPolicy.wastefulStartRatio * 100)}% of this task's expected ` +
        `${formatDuration(estimate.expectedWallTimeMs)} runtime; most of the work would run on ` +
        'prepaid capacity anyway.',
    );
  }

  const material = materialByReason || timeUntil >= gapPolicy.materialGapMs;
  if (!material) {
    return defer(
      'API_GAP_SHORT_DEFER',
      `The ${formatDuration(timeUntil)} gap is under the ${formatDuration(gapPolicy.materialGapMs)} ` +
        'materiality threshold; the task waits for prepaid capacity.',
    );
  }

  // ---- Cost and budget: the gate that stands between "worth it" and "pay" -

  const cost = input.cost;
  if (cost === null || cost.safeCostUsd === null) {
    return defer(
      'API_COST_UNKNOWN',
      `A ${formatDuration(timeUntil)} gap would justify bridging, but the cost of doing so cannot ` +
        `be estimated: ${cost?.detail ?? 'no cost estimate was produced'} Unknown cost never ` +
        'authorizes automatic spend.',
      true,
    );
  }

  const budget = input.budget;
  if (budget !== null && !budget.admissible) {
    return {
      ...defer(
        budget.refusal === 'TASK_ATTEMPTS' || budget.refusal === 'JOB_ATTEMPTS'
          ? 'API_ATTEMPTS_EXHAUSTED'
          : budget.refusal === 'COST_UNKNOWN'
            ? 'API_COST_UNKNOWN'
            : 'API_BUDGET_EXCEEDED',
        budget.detail,
        true,
      ),
    };
  }

  // ---- Authorization -----------------------------------------------------

  const bridgeReason: SchedulingReasonCode =
    gap.reason === 'WEEKLY_EXHAUSTED' ? 'API_WEEKLY_GAP_BRIDGE' : 'API_GAP_BRIDGE_SELECTED';
  const justification =
    `Subscription capacity (${gap.reason}) is out for ${formatDuration(timeUntil)}; ` +
    `delay sensitivity is ${delaySensitivity.level} ` +
    `(${delaySensitivity.blockedDependents} blocked dependent(s)` +
    `${delaySensitivity.criticalPath ? ', critical path' : ''}); ` +
    `one bounded paid attempt on "${binding.profileName ?? 'the bound profile'}" is estimated at ` +
    `$${(cost.estimatedCostUsd ?? 0).toFixed(4)} (safe $${cost.safeCostUsd.toFixed(4)}).`;

  if (policy.spendMode === 'MANUAL') {
    return approvalPath(input, justification);
  }

  // AUTO_BOUNDED. Even here an explicit DENIAL by a human stands: an
  // operator who said no to this exact work is not overridden by policy.
  if (input.approval?.reason === 'DENIED') {
    return defer(
      'API_APPROVAL_REQUIRED',
      `Paid execution for this task was explicitly denied: ${input.approval.detail}`,
      true,
    );
  }

  if (gapPolicy.minGapForAutoBoundedMs > timeUntil && !materialByReason) {
    return defer(
      'API_GAP_SHORT_DEFER',
      `AUTO_BOUNDED requires a gap of at least ${formatDuration(gapPolicy.minGapForAutoBoundedMs)}; ` +
        `this gap is ${formatDuration(timeUntil)}.`,
    );
  }

  return {
    decision: 'API',
    reasonCode: bridgeReason,
    deferUntil: null,
    gap,
    delaySensitivity,
    cost,
    budget,
    approval: input.approval,
    bridgeProposed: true,
    detail: `API gap bridge selected. ${justification}`,
  };
}

/**
 * The MANUAL outcome. Nothing dispatches: the task stays durably pending
 * with a bounded, fingerprinted request on record for a human to decide.
 */
function approvalPath(input: ApiGapBridgeInput, justification: string): ApiGapBridgePlan {
  const check = input.approval;
  if (check?.valid === true) {
    return {
      decision: 'API',
      reasonCode:
        input.gap.reason === 'WEEKLY_EXHAUSTED' ? 'API_WEEKLY_GAP_BRIDGE' : 'API_GAP_BRIDGE_SELECTED',
      deferUntil: null,
      gap: input.gap,
      delaySensitivity: input.delaySensitivity,
      cost: input.cost,
      budget: input.budget,
      approval: check,
      bridgeProposed: true,
      detail: `Authorized paid execution. ${check.detail} ${justification}`,
    };
  }
  if (check?.reason === 'DENIED') {
    return {
      decision: 'DEFER',
      reasonCode: 'API_APPROVAL_REQUIRED',
      deferUntil: input.gap.expectedAvailableAt,
      gap: input.gap,
      delaySensitivity: input.delaySensitivity,
      cost: input.cost,
      budget: input.budget,
      approval: check,
      bridgeProposed: true,
      detail: `Paid execution for this task was explicitly denied: ${check.detail}`,
    };
  }
  return {
    decision: 'REQUIRE_APPROVAL',
    reasonCode: 'API_APPROVAL_REQUIRED',
    deferUntil: null,
    gap: input.gap,
    delaySensitivity: input.delaySensitivity,
    cost: input.cost,
    budget: input.budget,
    approval: check,
    bridgeProposed: true,
    detail:
      `API execution would preserve continuity, but spending requires explicit authorization. ` +
      `${justification}${check?.detail !== undefined ? ` ${check.detail}` : ''}`,
  };
}
