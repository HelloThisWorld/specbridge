import type { ReliabilityPolicy } from '@specbridge/core';
import type { AssessedFailure } from './assessment.js';
import { permitsIntelligenceEscalation } from './vocabulary.js';
import type { BudgetView } from './budget.js';
import { hardBudgetRefusal } from './budget.js';
import { strategyKey } from './health.js';
import type { EvaluationResult, ReliabilityObservation, RecoveryStrategy } from './state.js';
import type {
  ExecutionHealth,
  RecoveryAction,
  RecoveryReasonCode,
  RecoveryStrategyDimension,
} from './vocabulary.js';

/**
 * The Recovery Planner: one pure function that decides what happens after a
 * failed, assessed attempt.
 *
 * Everything about its shape follows from one requirement — the decision
 * must be REPRODUCIBLE. Given the same durable task state, assessment,
 * budget position, policy, and history, it returns the same action, forever.
 * So it reads no clock it was not handed, performs no I/O, consults no
 * model, and holds no state between calls. A recovery policy that depended
 * on free-form model judgment could not be tested, could not be audited, and
 * could be argued with by the very agent it governs.
 *
 * The rules it encodes, stated plainly:
 *
 *   - no retry without a reasoned failure classification
 *   - infrastructure failure is never treated as intelligence failure
 *   - repeated failure must CHANGE STRATEGY, not consume more compute
 *   - a stronger model is not permission to ignore evidence
 *   - a paid lane is not permission to retry indefinitely
 *   - escalation is a REQUEST; the scheduler and spend policy still decide
 *   - when bounded recovery is exhausted, stopping honestly is the outcome
 *
 * The last one deserves saying out loud: a task that ends BLOCKED with a
 * durable explanation of what was tried and why it failed is a SUCCESSFUL
 * governance outcome. The failure mode this phase exists to prevent is not
 * "a task did not get done" — it is "a task did not get done, expensively,
 * repeatedly, and without anyone learning why".
 */

export interface RecoveryResource {
  /** Prepaid subscription capacity can take work right now. */
  subscriptionAvailable: boolean;
  /** Milliseconds until subscription capacity returns, when known. */
  subscriptionReturnsInMs: number | null;
  /** A subscription-capable worker exists in the roster at all. */
  subscriptionWorkerConfigured: boolean;
  /**
   * Paid execution is authorized IN PRINCIPLE (spend mode and approval).
   * This is never sufficient on its own — the budget must also allow it, and
   * the gap-bridge planner still gets the final word at dispatch.
   */
  apiAuthorized: boolean;
  /** The API budget currently has room for another bounded attempt. */
  apiBudgetAvailable: boolean;
  /** A healthy local worker exists. */
  localAvailable: boolean;
  /** A verified-local harness is bound and usable. */
  localHarnessAvailable: boolean;
}

export interface RecoveryPlanInput {
  assessment: AssessedFailure;
  evaluation?: EvaluationResult | undefined;
  health: ExecutionHealth;
  budget: BudgetView;
  policy: ReliabilityPolicy;
  /** The lane the failed attempt ran on. */
  lane: string | null;
  /** The LOCAL execution mode of the failed attempt, when it had one. */
  executionMode: string | null;
  planRevision: number;
  /** Whether the current plan is still believed valid (diagnoser input). */
  planValid: boolean;
  /** Bounded task history, oldest first, INCLUDING the failed attempt. */
  history: readonly ReliabilityObservation[];
  /** Strategy keys already tried and failed on this task. */
  exhaustedStrategies: readonly string[];
  freshContextRestartsUsed: number;
  /** Bounded infrastructure retries already spent on this task. */
  infrastructureRetriesUsed: number;
  /** Context occupancy after the failed attempt, when measured. */
  contextRatio: number | null;
  resource: RecoveryResource;
}

export interface RecoveryPlan {
  action: RecoveryAction;
  reasonCode: RecoveryReasonCode;
  reason: string;
  strategyChange: RecoveryStrategyDimension;
  previousStrategy: RecoveryStrategy;
  nextStrategy: RecoveryStrategy;
  remediation: string[];
  /**
   * Set when the action REQUESTS stronger execution. A requirement, never an
   * authorization: spend policy, quota, and the scheduler decide separately
   * and may refuse.
   */
  requestedCapability?: { kind: 'STRONG' | 'REMOTE'; detail: string };
  /** When the action is WAIT_FOR_RESOURCE, how long the wait is expected to be. */
  waitMs?: number | null;
}

function describeStrategy(input: {
  lane: string | null;
  executionMode: string | null;
  planRevision: number;
  freshContext: boolean;
}): RecoveryStrategy {
  return {
    lane: input.lane,
    executionMode: input.executionMode,
    planRevision: input.planRevision,
    freshContext: input.freshContext,
    key: strategyKey(input),
  };
}

/**
 * Decide the next recovery action.
 *
 * Evaluated in strict priority order, and the ORDER is the policy. Reading
 * it top to bottom is reading the argument: hard boundaries before budgets,
 * budgets before anything that would spend, human authority before any
 * automatic guess, broken measuring equipment before broken code, cheap
 * changes before expensive ones, and a strategy change before any repetition
 * of one that has already failed.
 */
export function planRecovery(input: RecoveryPlanInput): RecoveryPlan {
  const { assessment, budget, policy } = input;
  const previousStrategy = describeStrategy({
    lane: input.lane,
    executionMode: input.executionMode,
    planRevision: input.planRevision,
    freshContext: false,
  });

  const same = (dimension: RecoveryStrategyDimension = 'SAME'): RecoveryStrategy =>
    dimension === 'SAME' ? previousStrategy : previousStrategy;

  const stop = (
    action: Extract<RecoveryAction, 'BLOCK' | 'FAIL_TASK'>,
    reasonCode: RecoveryReasonCode,
    reason: string,
    remediation: string[],
  ): RecoveryPlan => ({
    action,
    reasonCode,
    reason,
    strategyChange: 'SAME',
    previousStrategy,
    nextStrategy: same(),
    remediation,
  });

  // 1. Hard boundaries. Safety, permission, and authentication failures are
  //    never automatically anything — no budget, lane, or model changes that.
  if (assessment.recoverability === 'TERMINAL') {
    return stop(
      'BLOCK',
      'HARD_BOUNDARY',
      `${assessment.category} is a hard boundary and has no automatic recovery path.`,
      [
        'This boundary is not configurable away.',
        'All evidence and source changes are preserved; resolve the boundary explicitly, then start a new attempt.',
      ],
    );
  }

  // 2. Hard budgets, before anything that could spend. An exhausted task can
  //    never take "one more" attempt, and stopping here is what makes the
  //    bound real rather than advisory.
  const refusal = hardBudgetRefusal(budget);
  if (refusal !== null) {
    return stop(
      'FAIL_TASK',
      'RECOVERY_BUDGET_EXHAUSTED',
      `Recovery stopped: ${refusal.detail}.`,
      [
        'All evidence, attempt history, and source changes are preserved; the task stays incomplete.',
        `Raise the ${refusal.budget} budget explicitly, or change the approach, then start a new attempt.`,
      ],
    );
  }

  // 3. Human authority, before any automatic guess. An inconsistent contract
  //    is not repaired by writing more code against it, however many times.
  if (assessment.source === 'REQUIREMENT_CONTRACT' || assessment.recoverability === 'REQUIRES_HUMAN') {
    return {
      action: 'REQUEST_HUMAN_DECISION',
      reasonCode:
        assessment.source === 'REQUIREMENT_CONTRACT' ? 'CONTRACT_CONFLICT_HUMAN' : 'AMBIGUITY_HUMAN',
      reason:
        assessment.source === 'REQUIREMENT_CONTRACT'
          ? 'The approved contract does not support what the implementation requires; repeated repair cannot resolve a contract conflict.'
          : 'The request is underspecified in a way no safe automatic action resolves.',
      strategyChange: 'SAME',
      previousStrategy,
      nextStrategy: same(),
      remediation: [
        'Answer the recorded question, or amend and re-approve the affected stage.',
        'SpecBridge never changes approved intent on a worker proposal.',
      ],
    };
  }
  if (assessment.source === 'AUTHORIZATION') {
    return stop(
      'BLOCK',
      'HARD_BOUNDARY',
      'Authorization refused the operation; SpecBridge never retries past an authorization boundary.',
      ['Grant the required authorization explicitly, then resume the job.'],
    );
  }
  if (assessment.source === 'BUDGET') {
    return stop(
      'BLOCK',
      'BUDGET_EXPANSION_HUMAN',
      'A configured budget refused the work; continuing requires an explicit budget decision.',
      [
        'Review the preserved evidence and decide explicitly whether to raise the budget or change approach.',
      ],
    );
  }

  // 4. Broken measuring equipment before broken code.
  //
  //    If the machinery that JUDGES the work failed, the implementation was
  //    never actually judged. Repairing code against a verdict that was never
  //    reached is how a reliable system rewrites correct code for hours.
  if (
    assessment.source === 'VERIFICATION_INFRASTRUCTURE' ||
    input.evaluation?.status === 'INCONCLUSIVE'
  ) {
    if (input.infrastructureRetriesUsed < policy.maxInfrastructureRetries) {
      return {
        action: 'RETRY_TRANSIENT',
        reasonCode: 'INFRASTRUCTURE_RETRY',
        reason:
          'The evaluation could not reach a verdict because its own machinery failed; the attempt is repeated ' +
          'rather than the implementation being treated as wrong.',
        strategyChange: 'SAME',
        previousStrategy,
        nextStrategy: same(),
        remediation: ['Check the verification tooling if this recurs; the implementation is not implicated.'],
      };
    }
    return stop(
      'BLOCK',
      'EVALUATION_INFRASTRUCTURE_BROKEN',
      `The verification machinery failed ${input.infrastructureRetriesUsed} time(s) and the task cannot be judged.`,
      [
        'The implementation was never established to be wrong; no code change is implied.',
        'Repair the verification tooling (run `specbridge doctor`), then resume the job.',
      ],
    );
  }

  // 5. Infrastructure that RUNS work, bounded. A crashed runtime says nothing
  //    about the task, so it earns a bounded retry and never an escalation.
  if (assessment.source === 'EXECUTION_INFRASTRUCTURE' || assessment.source === 'PROVIDER') {
    if (input.infrastructureRetriesUsed < policy.maxInfrastructureRetries) {
      return {
        action: 'RETRY_TRANSIENT',
        reasonCode: 'INFRASTRUCTURE_RETRY',
        reason:
          'The execution runtime failed, which is evidence about the installation rather than about the task; ' +
          'a bounded retry runs the same attempt again.',
        strategyChange: 'SAME',
        previousStrategy,
        nextStrategy: same(),
        remediation: ['Inspect runner health with `specbridge runner doctor` if this recurs.'],
      };
    }
    // Bounded infrastructure retries are spent. Switching the EXECUTION
    // MODE is legitimate here (a different runtime may simply work); asking
    // for a stronger MODEL is not, because nothing has failed intellectually.
    const modeChange = localModeChange(input);
    if (modeChange !== null) return modeChange;
    return escalateOrWait(input, previousStrategy, {
      reasonCode: 'LANE_CAPABILITY_REQUIRED',
      detail:
        'The bound execution runtime is repeatedly unavailable; a different execution resource is required.',
      escalationKind: 'STRONG',
    });
  }

  // 6. Genuinely transient conditions, bounded by the existing retry budget.
  if (assessment.source === 'TRANSIENT' && budget.remainingTransientRetries > 0) {
    return {
      action: 'RETRY_TRANSIENT',
      reasonCode: 'TRANSIENT_WITHIN_BUDGET',
      reason: `${assessment.category} is safely retryable; retrying the same idempotent operation.`,
      strategyChange: 'SAME',
      previousStrategy,
      nextStrategy: same(),
      remediation: ['If the condition recurs past its budget, it is not transient.'],
    };
  }

  // 7. RUNAWAY and context degradation. Both say the SESSION went wrong
  //    rather than the code, and both are answered by rebuilding context from
  //    durable state rather than by asking a bigger model the same question.
  const contextDegraded =
    assessment.source === 'CONTEXT' ||
    (input.contextRatio !== null && input.contextRatio >= policy.freshContextRecoveryRatio);
  if (
    (input.health === 'RUNAWAY' || contextDegraded) &&
    input.freshContextRestartsUsed < policy.maxFreshContextRestarts
  ) {
    const next = describeStrategy({
      lane: input.lane,
      executionMode: input.executionMode,
      planRevision: input.planRevision,
      freshContext: true,
    });
    return {
      action: 'RESTART_FRESH_CONTEXT',
      reasonCode:
        input.health === 'RUNAWAY'
          ? 'SESSION_STALLED_FRESH_CONTEXT'
          : assessment.source === 'CONTEXT'
            ? 'CONTEXT_DEGRADED'
            : 'CONTEXT_THRESHOLD_REACHED',
      reason:
        input.health === 'RUNAWAY'
          ? 'The attempt exceeded its own execution bounds; the transient session is discarded and context is rebuilt from the canonical checkpoint.'
          : 'The working context degraded past the point where the attempt could reason reliably; context is rebuilt from durable state.',
      strategyChange: 'CONTEXT',
      previousStrategy,
      nextStrategy: next,
      remediation: [
        'The checkpoint, failed approaches, and acceptance criteria are re-injected deterministically.',
      ],
    };
  }

  // 8. The paid lane, held to a stricter standard than any other.
  //
  //    A deterministic failure on a metered lane has already been paid for
  //    once. Buying the identical experiment a second time is the single most
  //    expensive mistake this system can make, so it is refused by default
  //    and the strategy has to change instead.
  if (input.lane === 'API' && !policy.allowApiDeterministicRetry) {
    const wait = waitIfResourceReturns(input, previousStrategy, 'PAID_DETERMINISTIC_FAILURE_NO_RETRY');
    if (wait !== null) return wait;
    if (canReplan(budget)) {
      return replanPlan(
        input,
        previousStrategy,
        'PAID_DETERMINISTIC_FAILURE_NO_RETRY',
        'A paid attempt failed deterministically; another identical paid attempt would buy the same result, so the strategy changes instead.',
      );
    }
    return {
      action: 'REQUEST_HUMAN_DECISION',
      reasonCode: 'PAID_DETERMINISTIC_FAILURE_NO_RETRY',
      reason:
        'A paid attempt failed deterministically and no replan budget remains; further spending needs an explicit decision.',
      strategyChange: 'SAME',
      previousStrategy,
      nextStrategy: same(),
      remediation: [
        'Review the preserved failure evidence and the recorded cost before authorizing more paid work.',
      ],
    };
  }

  // 9. Stuck. STALLED and OSCILLATING are the states where more of the same
  //    compute is provably wasted, so repetition is not on the menu at all.
  if (input.health === 'STALLED' || input.health === 'OSCILLATING') {
    const stuckReason: RecoveryReasonCode =
      input.health === 'OSCILLATING' ? 'OSCILLATION_REPLAN' : 'NO_PROGRESS_REPLAN';
    const modeChange = localModeChange(input);
    if (modeChange !== null) return modeChange;
    if (canReplan(budget)) {
      return replanPlan(
        input,
        previousStrategy,
        stuckReason,
        input.health === 'OSCILLATING'
          ? 'Attempts are alternating between repository states that have already failed; the plan itself is the problem.'
          : 'Repeated attempts produced an identical result; the current approach cannot succeed.',
      );
    }
    if (permitsIntelligenceEscalation(assessment.source)) {
      return escalateOrWait(input, previousStrategy, {
        reasonCode: 'LOCAL_INTELLIGENCE_EXHAUSTED',
        detail:
          'The task is stuck and no replan budget remains; a stronger implementation attempt is required.',
        escalationKind: 'STRONG',
      });
    }
    return stop(
      'FAIL_TASK',
      'STRATEGIES_EXHAUSTED',
      'The task is stuck, the replan budget is spent, and the failure is not one stronger intelligence would address.',
      [
        'All evidence and failed approaches are preserved.',
        'Inspect the repeating failure fingerprint and decide the approach explicitly.',
      ],
    );
  }

  // 10. Contract mismatch: the code works and still does the wrong thing.
  //
  //     Tests green with acceptance criteria red means the implementation
  //     strategy misread what was approved. Repairing the implementation
  //     would be optimizing a solution to the wrong problem, so replanning
  //     is the correct response even though nothing is "broken".
  if (contractMismatch(input.evaluation) && canReplan(budget)) {
    return replanPlan(
      input,
      previousStrategy,
      'CONTRACT_MISMATCH_REPLAN',
      'Trusted tests passed but the approved acceptance criteria did not hold: the implementation strategy, not the implementation, is wrong.',
    );
  }

  // 11. LOCAL mode change before spending prepaid quota. A direct attempt
  //     that failed for want of repository tools has not shown that local
  //     intelligence is insufficient — it has shown a model with no tools
  //     cannot see the repository.
  const modeChange = localModeChange(input);
  if (modeChange !== null) return modeChange;

  // 12. Bounded LOCAL intelligence, spent. This is the one escalation that
  //     rests on genuine evidence: local attempts were made, verified, and
  //     did not produce a working implementation.
  if (
    input.lane === 'LOCAL' &&
    budget.remainingLocalAttempts !== null &&
    budget.remainingLocalAttempts <= 0 &&
    permitsIntelligenceEscalation(assessment.source)
  ) {
    return escalateOrWait(input, previousStrategy, {
      reasonCode: 'LOCAL_INTELLIGENCE_EXHAUSTED',
      detail:
        'The shared local attempt budget is spent without a verified implementation; stronger intelligence is warranted.',
      escalationKind: 'STRONG',
    });
  }

  // 13. Bounded repair. The ordinary case, and deliberately far down the
  //     list: repair is legitimate only once everything above has been ruled
  //     out, which is what "no repair without diagnosis" means in practice.
  if (assessment.recoverability === 'RECOVERABLE' && budget.remainingRepairs > 0) {
    const next = describeStrategy({
      lane: input.lane,
      executionMode: input.executionMode,
      planRevision: input.planRevision,
      freshContext: false,
    });
    return {
      action: 'REPAIR',
      reasonCode:
        assessment.category === 'VERIFICATION_FAILURE'
          ? 'VERIFICATION_FAILED_REPAIRABLE'
          : 'LOCALIZED_DEFECT_REPAIRABLE',
      reason:
        assessment.category === 'VERIFICATION_FAILURE'
          ? 'A trusted verification command failed; the implementation is repaired against its output rather than rerun unchanged.'
          : 'The failure is a localized implementation defect and the plan remains valid.',
      strategyChange: 'IMPLEMENTATION_APPROACH',
      previousStrategy,
      nextStrategy: next,
      remediation: [
        'The repair attempt receives the failure assessment, the relevant evidence, and the latest checkpoint.',
      ],
    };
  }

  // 14. Repair is spent or illegal; replan if the budget allows.
  if (canReplan(budget)) {
    return replanPlan(
      input,
      previousStrategy,
      budget.remainingRepairs <= 0 ? 'REPEATED_REPAIR_FAILED_REPLAN' : 'PLAN_INVALIDATED_REPLAN',
      budget.remainingRepairs <= 0
        ? 'The repair budget is spent and verification still fails; the approach itself is replaced.'
        : 'The current plan cannot address the observed failure.',
    );
  }

  // 15. Escalation as the last automatic option, and only where the failure
  //     is one a stronger implementation could actually fix.
  if (permitsIntelligenceEscalation(assessment.source)) {
    return escalateOrWait(input, previousStrategy, {
      reasonCode: 'IMPLEMENTATION_NEEDS_STRONGER_INTELLIGENCE',
      detail: 'Bounded repair and replan are spent; a stronger implementation attempt is the remaining option.',
      escalationKind: 'STRONG',
    });
  }

  // 16. Stop honestly. Everything bounded has been tried.
  return stop(
    'FAIL_TASK',
    'STRATEGIES_EXHAUSTED',
    'Every bounded recovery strategy for this task has been tried without verified completion.',
    [
      'All evidence, attempt history, failed approaches, and source changes are preserved.',
      'Inspect `specbridge orchestrate explain-node` for what was tried and what would unblock it.',
    ],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canReplan(budget: BudgetView): boolean {
  return budget.remainingReplans > 0 && budget.remainingJobReplans > 0;
}

/**
 * Whether the evaluation says "the code works and still does the wrong
 * thing" — every test level green, acceptance criteria red.
 */
function contractMismatch(evaluation: EvaluationResult | undefined): boolean {
  if (evaluation === undefined || evaluation.status !== 'FAIL') return false;
  const failedLevels = new Set(
    evaluation.deterministicChecks
      .filter((entry) => entry.required && entry.outcome === 'FAILED')
      .map((entry) => entry.level),
  );
  return failedLevels.size > 0 && [...failedLevels].every((level) => level === 'ACCEPTANCE_CRITERIA');
}

function replanPlan(
  input: RecoveryPlanInput,
  previousStrategy: RecoveryStrategy,
  reasonCode: RecoveryReasonCode,
  reason: string,
): RecoveryPlan {
  return {
    action: 'REPLAN',
    reasonCode,
    reason,
    strategyChange: 'PLAN',
    previousStrategy,
    // A replan deliberately leaves lane and execution mode UNDECIDED.
    //
    // Recovery decides what KIND of next attempt is required; the economic
    // scheduler decides where and when it runs, fresh from live telemetry.
    // Carrying the failed attempt's lane forward here would quietly turn a
    // recovery record into a placement — and on the paid lane it would read
    // as authorization to spend again, which no recovery decision may ever
    // imply. The new plan revision is what makes the next attempt a
    // materially different experiment rather than a repetition.
    nextStrategy: describeStrategy({
      lane: null,
      executionMode: null,
      planRevision: input.planRevision + 1,
      freshContext: false,
    }),
    remediation: [
      'Replanning may change the implementation strategy, decomposition, or order.',
      'It may never change approved intent: a materially different requirement needs contract authority.',
    ],
  };
}

/**
 * A LOCAL to LOCAL execution-mode change, when one is available and not
 * already exhausted.
 *
 * This is deliberately NOT an escalation: it consumes no subscription quota,
 * shares the same bounded local attempt budget, and answers a different
 * question — "does this work need tools?" rather than "does it need a better
 * model?". Confusing the two is what makes a system spend prepaid quota on a
 * task a local harness could have finished.
 */
function localModeChange(input: RecoveryPlanInput): RecoveryPlan | null {
  if (input.lane !== 'LOCAL') return null;
  if (input.executionMode !== 'DIRECT_MODEL') return null;
  if (!input.resource.localHarnessAvailable) return null;
  if (input.budget.remainingLocalAttempts !== null && input.budget.remainingLocalAttempts <= 0) {
    return null;
  }
  const next = describeStrategy({
    lane: 'LOCAL',
    executionMode: 'HARNESS',
    planRevision: input.planRevision,
    freshContext: false,
  });
  // Never repeat a mode we have already tried and failed with on this task.
  if (input.exhaustedStrategies.includes(next.key)) return null;
  return {
    action: 'RETRY_DIFFERENT_LOCAL_MODE',
    reasonCode: 'LOCAL_MODE_CHANGE_REPOSITORY_TOOLS',
    reason:
      'The direct local attempt failed for reasons repository tools address; the local lane switches to its ' +
      'harness mode rather than spending subscription quota.',
    strategyChange: 'EXECUTION_MODE',
    previousStrategy: describeStrategy({
      lane: input.lane,
      executionMode: input.executionMode,
      planRevision: input.planRevision,
      freshContext: false,
    }),
    nextStrategy: next,
    remediation: ['The shared local attempt budget is unchanged; this is a LOCAL to LOCAL transition.'],
  };
}

/**
 * Waiting, when prepaid capacity returns soon enough to be worth it.
 *
 * Resource waiting is a legitimate continuity state, not a task failure — a
 * point worth being explicit about, because the tempting alternative
 * ("something must run, so pay for it") is exactly how a bridge meant for
 * outages becomes a default.
 */
function waitIfResourceReturns(
  input: RecoveryPlanInput,
  previousStrategy: RecoveryStrategy,
  reasonCode: RecoveryReasonCode,
): RecoveryPlan | null {
  const returnsIn = input.resource.subscriptionReturnsInMs;
  if (input.resource.subscriptionAvailable) return null;
  if (returnsIn === null) return null;
  return {
    action: 'WAIT_FOR_RESOURCE',
    reasonCode,
    reason:
      `Prepaid subscription capacity returns in ${Math.round(returnsIn / 60_000)} minute(s); ` +
      'waiting for it beats paying for another attempt.',
    strategyChange: 'SAME',
    previousStrategy,
    nextStrategy: previousStrategy,
    remediation: ['The task stays durably pending and resumes when capacity returns.'],
    waitMs: returnsIn,
  };
}

/**
 * Turn an escalation REQUIREMENT into the honest action available right now.
 *
 * The critical property: this function can request stronger execution, but
 * it cannot authorize any. If prepaid capacity is unavailable and paid
 * execution is not authorized (or its budget refuses), the answer is to wait
 * or to ask a human — never to spend. No recovery path may bypass the spend
 * authorization modes, and this is the single place that could have been
 * tempted to.
 */
function escalateOrWait(
  input: RecoveryPlanInput,
  previousStrategy: RecoveryStrategy,
  request: { reasonCode: RecoveryReasonCode; detail: string; escalationKind: 'STRONG' | 'REMOTE' },
): RecoveryPlan {
  const { resource } = input;

  // Prepaid strong capacity is available: request it. The scheduler still
  // performs the actual placement.
  if (resource.subscriptionAvailable && resource.subscriptionWorkerConfigured) {
    return {
      action: 'ESCALATE_INTELLIGENCE',
      reasonCode: request.reasonCode,
      reason: `${request.detail} Prepaid subscription capacity is available and is the preferred strong lane.`,
      strategyChange: 'INTELLIGENCE',
      previousStrategy,
      nextStrategy: describeStrategy({
        lane: 'SUBSCRIPTION',
        executionMode: null,
        planRevision: input.planRevision,
        freshContext: false,
      }),
      remediation: ['The economic scheduler decides the actual placement and timing.'],
      requestedCapability: { kind: 'STRONG', detail: request.detail.slice(0, 2_000) },
    };
  }

  // Prepaid capacity returns soon: wait rather than pay. Availability
  // continuity is what the paid bridge is for, and a wait that is about to
  // end is not a continuity gap.
  const wait = waitIfResourceReturns(input, previousStrategy, 'RESOURCE_RETURNS_SOON');
  if (wait !== null) return wait;

  // Paid continuation: a REQUEST only. vNext.5 spend authorization and the
  // API budget both still apply, and either may refuse at dispatch.
  if (resource.apiAuthorized && resource.apiBudgetAvailable) {
    return {
      action: 'ESCALATE_LANE',
      reasonCode: 'LANE_CAPABILITY_REQUIRED',
      reason:
        `${request.detail} Prepaid capacity is unavailable with no known return time; a bounded paid ` +
        'continuation is requested, subject to the existing spend authorization and budget.',
      strategyChange: 'LANE',
      previousStrategy,
      nextStrategy: describeStrategy({
        lane: 'API',
        executionMode: 'HARNESS',
        planRevision: input.planRevision,
        freshContext: false,
      }),
      remediation: [
        'This is a requirement, not an authorization: the gap-bridge planner and API budget decide independently.',
      ],
      requestedCapability: { kind: 'REMOTE', detail: request.detail.slice(0, 2_000) },
    };
  }

  if (!resource.apiAuthorized) {
    return {
      action: 'WAIT_FOR_RESOURCE',
      reasonCode: 'PAID_CONTINUATION_UNAUTHORIZED',
      reason:
        `${request.detail} Prepaid capacity is unavailable and paid execution is not authorized; ` +
        'the task waits rather than spending.',
      strategyChange: 'SAME',
      previousStrategy,
      nextStrategy: previousStrategy,
      remediation: [
        'Authorize paid execution explicitly if this work should not wait for the subscription reset.',
      ],
      waitMs: resource.subscriptionReturnsInMs,
    };
  }

  return {
    action: 'WAIT_FOR_RESOURCE',
    reasonCode: 'PAID_BUDGET_REFUSED',
    reason:
      `${request.detail} Prepaid capacity is unavailable and the API budget refuses another paid attempt; ` +
      'the task waits rather than spending beyond its authorized ceiling.',
    strategyChange: 'SAME',
    previousStrategy,
    nextStrategy: previousStrategy,
    remediation: [
      'Raise the API budget explicitly, or let the task wait for prepaid capacity to return.',
    ],
    waitMs: resource.subscriptionReturnsInMs,
  };
}
