/**
 * Reliability, evaluation and recovery vocabulary (vNext.6).
 *
 * Closed string enums, additive within 1.x with the same rules as every
 * other orchestration vocabulary: members may be appended, never removed or
 * repurposed, so persisted evaluation results and recovery decisions stay
 * readable across upgrades.
 *
 * The organising idea of this phase, stated once:
 *
 *   Earlier phases answered "can SpecBridge keep running?".
 *   This one answers "should it?" — is the work correct, is the run stuck,
 *   why did it fail, what must change next, and when is more computation no
 *   longer justified.
 *
 * Three deliberate separations run through every enum below:
 *
 *   Evaluation   decides whether an attempt's WORK is acceptable
 *   Assessment   decides what KIND of failure occurred and where it came from
 *   Recovery     decides what SpecBridge does next
 *
 * They are never collapsed. An evaluator that could pick the recovery action
 * would be a model choosing its own retry policy, which is exactly the
 * failure mode this phase exists to prevent. Nothing here can be set from
 * spec text, plan text, model output, or repository content.
 */

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * The verdict of evaluating one ExecutionAttempt.
 *
 *   PASS          every required check that ran passed, and enough of them
 *                 ran to justify completion
 *   FAIL          a required check failed on evidence SpecBridge trusts
 *   INCONCLUSIVE  the evaluation itself could not reach a verdict — the
 *                 test harness was unavailable, the integration environment
 *                 was missing, a semantic criterion could not be checked
 *
 * INCONCLUSIVE is load-bearing and NOT a soft FAIL. "We could not tell" and
 * "the implementation is wrong" demand different recovery: the first repairs
 * infrastructure, the second repairs code. Collapsing them makes SpecBridge
 * repeatedly rewrite correct code because the test runner was broken.
 */
export const EVALUATION_STATUSES = ['PASS', 'FAIL', 'INCONCLUSIVE'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

/**
 * The deterministic-first evaluation stack, in the order it is evaluated.
 *
 *   EXECUTION_INTEGRITY   is this attempt trustworthy at all? (identity,
 *                         baseline, termination, checkpoint currency)
 *   REPOSITORY_INTEGRITY  what does Git actually say changed?
 *   BUILD_STATIC          compile / typecheck / lint / schema validation
 *   TESTS                 unit / integration / regression / contract tests
 *   ACCEPTANCE_CRITERIA   the durable TaskContract's criteria
 *   SEMANTIC_REVIEW       bounded judgment, ONLY where the levels above
 *                         cannot decide
 *
 * The order is the policy. A level never runs while an earlier level has
 * already produced a trusted FAIL, and SEMANTIC_REVIEW can never overturn
 * one: "the tests fail but the reviewer likes it" is not a passing task.
 */
export const EVALUATION_CHECK_LEVELS = [
  'EXECUTION_INTEGRITY',
  'REPOSITORY_INTEGRITY',
  'BUILD_STATIC',
  'TESTS',
  'ACCEPTANCE_CRITERIA',
  'SEMANTIC_REVIEW',
] as const;
export type EvaluationCheckLevel = (typeof EVALUATION_CHECK_LEVELS)[number];

/** Numeric depth of each level, for ordering and reporting (Level 0..5). */
export const EVALUATION_CHECK_LEVEL_DEPTH: Readonly<Record<EvaluationCheckLevel, number>> =
  Object.freeze({
    EXECUTION_INTEGRITY: 0,
    REPOSITORY_INTEGRITY: 1,
    BUILD_STATIC: 2,
    TESTS: 3,
    ACCEPTANCE_CRITERIA: 4,
    SEMANTIC_REVIEW: 5,
  });

/** Levels whose evidence is deterministic and therefore authoritative. */
export const DETERMINISTIC_CHECK_LEVELS: readonly EvaluationCheckLevel[] = [
  'EXECUTION_INTEGRITY',
  'REPOSITORY_INTEGRITY',
  'BUILD_STATIC',
  'TESTS',
  'ACCEPTANCE_CRITERIA',
];

export function isDeterministicLevel(level: EvaluationCheckLevel): boolean {
  return DETERMINISTIC_CHECK_LEVELS.includes(level);
}

/**
 * How one individual check turned out.
 *
 * `UNAVAILABLE` and `TIMED_OUT` are separate from `FAILED` on purpose: a
 * test suite that could not run has proved nothing about the code, and
 * silently promoting "not run" to "passed" is the single most dangerous
 * shortcut an evaluation layer can take.
 */
export const EVALUATION_CHECK_OUTCOMES = [
  'PASSED',
  'FAILED',
  'NOT_RUN',
  'UNAVAILABLE',
  'TIMED_OUT',
] as const;
export type EvaluationCheckOutcome = (typeof EVALUATION_CHECK_OUTCOMES)[number];

/** Outcomes that mean the check could not deliver a verdict either way. */
export const INDETERMINATE_CHECK_OUTCOMES: readonly EvaluationCheckOutcome[] = [
  'NOT_RUN',
  'UNAVAILABLE',
  'TIMED_OUT',
];

export function isIndeterminate(outcome: EvaluationCheckOutcome): boolean {
  return INDETERMINATE_CHECK_OUTCOMES.includes(outcome);
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

/**
 * The closed set of machine-checkable acceptance-criterion forms.
 *
 * Deliberately few. A richer expression language would become a place for
 * approved intent to drift into executable configuration that nobody
 * reviews; these five structural predicates cover the criteria that can
 * honestly be checked from bytes, and every other criterion is reported
 * unchecked rather than quietly assumed to hold.
 *
 *   path-exists      a repository path must be present after the attempt
 *   path-absent      a repository path must be gone
 *   pattern-present  a regular expression must match an added diff line
 *   pattern-absent   a regular expression must NOT match any added diff line
 *   changed-within   every changed path must fall inside a declared area
 *   verifier-passed  a named trusted verification command must have passed
 */
export const ACCEPTANCE_CRITERION_CHECK_KINDS = [
  'path-exists',
  'path-absent',
  'pattern-present',
  'pattern-absent',
  'changed-within',
  'verifier-passed',
] as const;
export type AcceptanceCriterionCheckKind = (typeof ACCEPTANCE_CRITERION_CHECK_KINDS)[number];

// ---------------------------------------------------------------------------
// Failure assessment
// ---------------------------------------------------------------------------

/**
 * WHERE a failure came from — orthogonal to the FailureCategory, which says
 * WHAT went wrong.
 *
 * A category answers "what kind of thing failed"; a source answers "whose
 * fault is it", and only the source determines whether more intelligence
 * could possibly help. The distinction this enum exists for:
 *
 *   EXECUTION_INFRASTRUCTURE   a crashed harness proves nothing about the
 *                              task, and escalating to a stronger model to
 *                              "answer" it spends quota on a question
 *                              nobody asked
 *   IMPLEMENTATION             the model did the work badly — the only
 *                              source for which stronger intelligence is a
 *                              rational response
 *
 * VERIFICATION_INFRASTRUCTURE is kept separate from EXECUTION_INFRASTRUCTURE
 * because the recovery differs: a broken runner means the attempt never
 * happened, while a broken test harness means the attempt may have been
 * perfectly good and the verdict is INCONCLUSIVE.
 */
export const FAILURE_SOURCES = [
  /** The implementation is wrong: the model did the work badly or not at all. */
  'IMPLEMENTATION',
  /** The approved contract/requirement is itself inconsistent or incomplete. */
  'REQUIREMENT_CONTRACT',
  /** The runtime that executes work failed (harness, sandbox, process, CLI). */
  'EXECUTION_INFRASTRUCTURE',
  /** The model provider failed or refused (rate limit, outage, model gone). */
  'PROVIDER',
  /** Working context degraded: polluted, stale, truncated, or over budget. */
  'CONTEXT',
  /** The machinery that JUDGES work failed (test runner, verifier, tooling). */
  'VERIFICATION_INFRASTRUCTURE',
  /** The repository moved, diverged, or is in a state the attempt cannot use. */
  'REPOSITORY_STATE',
  /** A configured budget refused the work. */
  'BUDGET',
  /** Credentials, permissions, or spend authorization refused the work. */
  'AUTHORIZATION',
  /** A genuinely transient condition that repeating may resolve. */
  'TRANSIENT',
  /** Not determinable from the evidence available. Never guessed. */
  'UNKNOWN',
] as const;
export type FailureSource = (typeof FAILURE_SOURCES)[number];

/**
 * Sources for which "use a stronger model" is NEVER a valid inference.
 *
 * This list is the structural form of the rule that infrastructure failure
 * is not intelligence failure. The recovery planner consults it before any
 * escalation may even be considered.
 */
export const NON_INTELLIGENCE_FAILURE_SOURCES: readonly FailureSource[] = [
  'EXECUTION_INFRASTRUCTURE',
  'PROVIDER',
  'VERIFICATION_INFRASTRUCTURE',
  'REPOSITORY_STATE',
  'BUDGET',
  'AUTHORIZATION',
  'TRANSIENT',
];

export function permitsIntelligenceEscalation(source: FailureSource): boolean {
  return !NON_INTELLIGENCE_FAILURE_SOURCES.includes(source);
}

/** Sources that describe broken machinery rather than a wrong implementation. */
export const INFRASTRUCTURE_FAILURE_SOURCES: readonly FailureSource[] = [
  'EXECUTION_INFRASTRUCTURE',
  'PROVIDER',
  'VERIFICATION_INFRASTRUCTURE',
];

export function isInfrastructureSource(source: FailureSource): boolean {
  return INFRASTRUCTURE_FAILURE_SOURCES.includes(source);
}

/**
 * How far the failure's blast radius reaches. Determines what has to be
 * re-evaluated, not merely what to report.
 */
export const FAILURE_SCOPES = ['ATTEMPT', 'TASK', 'JOB', 'WORKSPACE'] as const;
export type FailureScope = (typeof FAILURE_SCOPES)[number];

/**
 * Whether, and on what terms, this failure can be recovered from.
 *
 *   RECOVERABLE            the same strategy may legitimately be retried
 *   REQUIRES_NEW_STRATEGY  retrying unchanged is provably pointless
 *   REQUIRES_HUMAN         no automatic action is legitimate
 *   TERMINAL               nothing recovers this run
 */
export const FAILURE_RECOVERABILITIES = [
  'RECOVERABLE',
  'REQUIRES_NEW_STRATEGY',
  'REQUIRES_HUMAN',
  'TERMINAL',
] as const;
export type FailureRecoverability = (typeof FAILURE_RECOVERABILITIES)[number];

/**
 * What the assessment is grounded in.
 *
 * This deliberately replaces a numeric "confidence" score, which a model
 * would happily invent and which no test could ever check. What matters is
 * whether the conclusion rests on checkable evidence or on a claim.
 *
 *   DETERMINISTIC_EVIDENCE  Git state, exit codes, verifier output
 *   PROVIDER_SIGNAL         a structured error code from the runtime
 *   ATTEMPT_HISTORY         repetition across durable attempt records
 *   MODEL_DIAGNOSIS         a DIAGNOSER's structured proposal — a claim
 *   ABSENT                  nothing to ground it in; source stays UNKNOWN
 */
export const ASSESSMENT_BASES = [
  'DETERMINISTIC_EVIDENCE',
  'PROVIDER_SIGNAL',
  'ATTEMPT_HISTORY',
  'MODEL_DIAGNOSIS',
  'ABSENT',
] as const;
export type AssessmentBasis = (typeof ASSESSMENT_BASES)[number];

// ---------------------------------------------------------------------------
// Execution health
// ---------------------------------------------------------------------------

/**
 * One deterministic interpretation of progress health, shared by every lane.
 *
 *   HEALTHY      attempts are changing the world in different ways
 *   DEGRADED     failing, but each attempt is still materially different
 *   STALLED      repeated attempts produce the same diff AND the same failure
 *   OSCILLATING  attempts alternate between previously seen states (A to B to A)
 *   RUNAWAY      an attempt exceeded its own bounds and must be stopped
 *
 * DEGRADED exists so that "failing" and "stuck" are not the same word. A
 * task can fail three times productively — each attempt eliminating a real
 * hypothesis — and that is not stagnation. STALLED and OSCILLATING are the
 * states where more of the same compute is provably wasted, and they are the
 * only ones that force a strategy change.
 */
export const EXECUTION_HEALTH_STATES = [
  'HEALTHY',
  'DEGRADED',
  'STALLED',
  'OSCILLATING',
  'RUNAWAY',
] as const;
export type ExecutionHealth = (typeof EXECUTION_HEALTH_STATES)[number];

/** Health states in which repeating the current strategy is not legitimate. */
export const STRATEGY_CHANGE_HEALTH_STATES: readonly ExecutionHealth[] = [
  'STALLED',
  'OSCILLATING',
  'RUNAWAY',
];

export function requiresStrategyChange(health: ExecutionHealth): boolean {
  return STRATEGY_CHANGE_HEALTH_STATES.includes(health);
}

/**
 * Why an attempt was judged RUNAWAY. Every signal is a bound SpecBridge set
 * and can observe — never a subjective reading of what the agent "seems" to
 * be doing.
 */
export const RUNAWAY_SIGNALS = [
  /** Observed tool calls exceeded the configured per-attempt ceiling. */
  'TOOL_CALL_BUDGET',
  /** The attempt exceeded its wall-clock bound. */
  'WALL_TIME_BUDGET',
  /** Context occupancy grew past the safe bound during the attempt. */
  'CONTEXT_GROWTH',
  /** The same command/test cycle repeated beyond the configured ceiling. */
  'REPEATED_COMMAND_LOOP',
  /** Repeated edits left the tree byte-identical. */
  'NO_OP_EDIT_LOOP',
] as const;
export type RunawaySignal = (typeof RUNAWAY_SIGNALS)[number];

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * What SpecBridge does after a failed, assessed attempt.
 *
 * Every action is a SpecBridge decision. A worker may propose a diagnosis
 * and may propose a repair; it may never select the action, expand a budget,
 * authorize spending, or declare a task complete. The arrow in this system
 * points one way, and this enum is where that is enforced.
 *
 * Ordered from cheapest and most local to most expensive and most final.
 */
export const RECOVERY_ACTIONS = [
  /** Repeat the same operation: transient/infrastructure conditions only. */
  'RETRY_TRANSIENT',
  /** Goal and plan remain valid; fix the implementation against evidence. */
  'REPAIR',
  /** Discard the polluted transient session; rebuild context from durable state. */
  'RESTART_FRESH_CONTEXT',
  /**
   * vNext.7: the attempt failed for want of CONTEXT, not intelligence.
   *
   * Distinct from RESTART_FRESH_CONTEXT, which rebuilds the SAME context
   * because the session degraded. This one widens retrieval by exactly one
   * bounded level because something the worker genuinely needed was never
   * selected. Conflating the two would answer a missing file by re-sending
   * the same package, which is the retry-without-a-change this phase exists
   * to refuse.
   */
  'EXPAND_CONTEXT',
  /** Stay on LOCAL, change how it spends compute (DIRECT_MODEL vs HARNESS). */
  'RETRY_DIFFERENT_LOCAL_MODE',
  /** The implementation strategy is invalid; produce a new one. */
  'REPLAN',
  /** Request stronger intelligence. A REQUEST — the scheduler still places it. */
  'ESCALATE_INTELLIGENCE',
  /** Request a different economic lane. Also a request, never a placement. */
  'ESCALATE_LANE',
  /** Nothing can legitimately run now; wait for capacity to return. */
  'WAIT_FOR_RESOURCE',
  /** A human must decide before anything else may run. */
  'REQUEST_HUMAN_DECISION',
  /** Stop: a prerequisite is unsatisfied. Recoverable, not final. */
  'BLOCK',
  /** Stop: bounded recovery is exhausted and the task did not complete. */
  'FAIL_TASK',
] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

/** Actions that produce another bounded mutation attempt. */
export const MUTATING_RECOVERY_ACTIONS: readonly RecoveryAction[] = [
  'RETRY_TRANSIENT',
  'REPAIR',
  'RESTART_FRESH_CONTEXT',
  'EXPAND_CONTEXT',
  'RETRY_DIFFERENT_LOCAL_MODE',
  'REPLAN',
  'ESCALATE_INTELLIGENCE',
  'ESCALATE_LANE',
];

/** Actions that stop automatic continuation entirely. */
export const TERMINAL_RECOVERY_ACTIONS: readonly RecoveryAction[] = ['BLOCK', 'FAIL_TASK'];

export function isMutatingRecovery(action: RecoveryAction): boolean {
  return MUTATING_RECOVERY_ACTIONS.includes(action);
}

export function isTerminalRecovery(action: RecoveryAction): boolean {
  return TERMINAL_RECOVERY_ACTIONS.includes(action);
}

/**
 * WHY the recovery planner chose what it chose. Every decision records
 * exactly one primary reason code, so "why did we retry / replan / escalate
 * / stop?" is answerable from durable records rather than from prose logs.
 */
export const RECOVERY_REASON_CODES = [
  // --- retry / repair ------------------------------------------------------
  /** A genuinely transient condition, within the bounded transient budget. */
  'TRANSIENT_WITHIN_BUDGET',
  /** The runtime failed, not the work; a bounded infrastructure retry applies. */
  'INFRASTRUCTURE_RETRY',
  /** Localized implementation defect, plan still valid, repair budget remains. */
  'LOCALIZED_DEFECT_REPAIRABLE',
  /** A trusted verifier failed; repair against its output rather than rerun it. */
  'VERIFICATION_FAILED_REPAIRABLE',
  // --- context -------------------------------------------------------------
  /** Symptoms point at context degradation rather than at the implementation. */
  'CONTEXT_DEGRADED',
  /** Context occupancy reached the configured recovery threshold. */
  'CONTEXT_THRESHOLD_REACHED',
  /** The attempt stalled inside its session; a fresh context gets one chance. */
  'SESSION_STALLED_FRESH_CONTEXT',
  /**
   * vNext.7: observed evidence says a required repository artifact was never
   * in the package. Retrieval widens one level; intelligence is untouched,
   * because nothing has been shown about it.
   */
  'CONTEXT_INSUFFICIENT_EXPAND',
  /**
   * vNext.7: context was widened as far as its budget allows and the work
   * still fails. More context is no longer the answer, and the decision
   * returns to the ordinary strategy-change path.
   */
  'CONTEXT_EXPANSION_EXHAUSTED',
  // --- local mode ----------------------------------------------------------
  /** A DIRECT_MODEL attempt failed for want of repository tools, not brains. */
  'LOCAL_MODE_CHANGE_REPOSITORY_TOOLS',
  // --- replan --------------------------------------------------------------
  /** Repeated repairs failed with a stable contract: the strategy is wrong. */
  'REPEATED_REPAIR_FAILED_REPLAN',
  /** Attempts produce the same diff and the same failure: no progress. */
  'NO_PROGRESS_REPLAN',
  /** Attempts alternate between previously seen states. */
  'OSCILLATION_REPLAN',
  /** The plan's assumptions were invalidated by observed repository state. */
  'PLAN_INVALIDATED_REPLAN',
  /** Deterministic acceptance criteria failed while tests passed. */
  'CONTRACT_MISMATCH_REPLAN',
  // --- escalation ----------------------------------------------------------
  /** Bounded local intelligence was spent without a verified implementation. */
  'LOCAL_INTELLIGENCE_EXHAUSTED',
  /** The failure is an implementation failure and stronger work is justified. */
  'IMPLEMENTATION_NEEDS_STRONGER_INTELLIGENCE',
  /** A capability the current lane lacks is required. */
  'LANE_CAPABILITY_REQUIRED',
  // --- waiting -------------------------------------------------------------
  /** Prepaid capacity returns soon enough that waiting beats any alternative. */
  'RESOURCE_RETURNS_SOON',
  /** Paid continuation is not authorized; the task waits rather than spends. */
  'PAID_CONTINUATION_UNAUTHORIZED',
  /** Paid continuation is authorized in principle but the budget refused it. */
  'PAID_BUDGET_REFUSED',
  /** A paid attempt failed deterministically; another identical one is refused. */
  'PAID_DETERMINISTIC_FAILURE_NO_RETRY',
  // --- human ---------------------------------------------------------------
  /** The approved contract is inconsistent with what implementation requires. */
  'CONTRACT_CONFLICT_HUMAN',
  /** The request is genuinely ambiguous; guessing is not permitted. */
  'AMBIGUITY_HUMAN',
  /** Continuing needs a budget expansion only a human may authorize. */
  'BUDGET_EXPANSION_HUMAN',
  // --- stop ----------------------------------------------------------------
  /** The recovery budget for this task is spent. */
  'RECOVERY_BUDGET_EXHAUSTED',
  /** The failure category admits no automatic recovery at all. */
  'NO_AUTOMATIC_RECOVERY_PATH',
  /** A hard safety, permission, or authentication boundary was reached. */
  'HARD_BOUNDARY',
  /** Every recovery strategy available to this task has been tried and failed. */
  'STRATEGIES_EXHAUSTED',
  /** The evaluation could not reach a verdict and its infrastructure is broken. */
  'EVALUATION_INFRASTRUCTURE_BROKEN',
] as const;
export type RecoveryReasonCode = (typeof RECOVERY_REASON_CODES)[number];

/**
 * The strategy dimension a recovery decision changes. Recorded on every
 * decision as `previousStrategy` to `nextStrategy`, so "did anything
 * actually change?" is answerable deterministically rather than from a
 * description someone wrote.
 *
 * A strategy is the tuple that determines HOW the next attempt differs. Two
 * attempts with the same strategy key and the same failure fingerprint are,
 * by definition, the same experiment run twice.
 */
export const RECOVERY_STRATEGY_DIMENSIONS = [
  'SAME',
  'IMPLEMENTATION_APPROACH',
  'EXECUTION_MODE',
  'CONTEXT',
  'PLAN',
  'INTELLIGENCE',
  'LANE',
] as const;
export type RecoveryStrategyDimension = (typeof RECOVERY_STRATEGY_DIMENSIONS)[number];
