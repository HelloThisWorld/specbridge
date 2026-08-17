/**
 * The stable vocabulary of governed agent orchestration (v1.1).
 *
 * Everything here is a closed string enum, snapshotted into
 * `contracts/orchestration-contract.json`. Values are additive within 1.x:
 * new members may be appended, existing members never change meaning and are
 * never removed, so persisted orchestration state stays readable.
 *
 * The single organising idea: SpecBridge owns *state, policy, and
 * boundaries*; the host coding agent owns *interpretation and edits*; Git and
 * the trusted verification commands own *evidence*. Every enum below belongs
 * to the first column. None of them can be set from spec text, plan text,
 * clarification text, or repository content.
 */

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Phases of one orchestration run.
 *
 * Deliberately minimal: a phase exists only when a run can genuinely be
 * *observed and resumed* in it. Assessment, plan validation, and verification
 * all complete inside a single tool call, so they are transitions rather than
 * phases — a resumed run can never legitimately land in them.
 */
export const ORCHESTRATION_PHASES = [
  /** The run exists; no intent has been assessed yet. */
  'CREATED',
  /** Targeted questions are open; implementation must not start. */
  'NEEDS_CLARIFICATION',
  /** Intent is READY; no valid execution plan exists yet. */
  'READY_TO_PLAN',
  /** A plan exists and policy requires explicit review before mutation. */
  'AWAITING_PLAN_REVIEW',
  /** A valid, reviewed (or review-exempt) plan exists; execution may begin. */
  'READY_TO_EXECUTE',
  /** The bounded observe/decide/act loop is running. */
  'EXECUTING',
  /** A verification failure is being repaired against fresh evidence. */
  'REPAIRING',
  /** The active plan was invalidated; a replacement plan is required. */
  'REPLANNING',
  /** Understandable but cannot proceed; needs an explicit user action. */
  'BLOCKED',
  /** Final: the task was completed through verified evidence. */
  'COMPLETED',
  /** Final: the run ended without completion. */
  'ABORTED',
  /** Final: the user cancelled; never auto-restarted. */
  'CANCELLED',
  /** Final: the request violated a hard product boundary. */
  'REJECTED',
] as const;
export type OrchestrationPhase = (typeof ORCHESTRATION_PHASES)[number];

/** Phases from which no further execution can proceed. */
export const FINAL_ORCHESTRATION_PHASES: readonly OrchestrationPhase[] = [
  'COMPLETED',
  'ABORTED',
  'CANCELLED',
  'REJECTED',
];

export function isFinalPhase(phase: OrchestrationPhase): boolean {
  return FINAL_ORCHESTRATION_PHASES.includes(phase);
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/**
 * Semantic outcome of assessing what the user asked for.
 *
 * These four are kept strictly distinct because they demand different user
 * actions: answer a question, change the request, satisfy a prerequisite, or
 * proceed. Blurring them is how a harness ends up "helpfully" guessing.
 */
export const INTENT_OUTCOMES = [
  /** Sufficiently specified and compatible with every current gate. */
  'READY',
  /** A user decision is required that cannot safely be inferred. */
  'NEEDS_CLARIFICATION',
  /** Not an allowed operation, or violates a hard product boundary. */
  'REJECTED',
  /** Understandable, but an external prerequisite is unsatisfied. */
  'BLOCKED',
] as const;
export type IntentOutcome = (typeof INTENT_OUTCOMES)[number];

/**
 * Structural provenance of a fact the orchestration relied on.
 *
 * SpecBridge deliberately does NOT use a numeric model-confidence score: a
 * number invented by a model is not a safety mechanism. What matters is
 * *where a fact came from*, which is checkable.
 */
export const PROVENANCE_KINDS = [
  'known-from-user',
  'known-from-approved-spec',
  'known-from-repository-evidence',
  'known-from-configuration',
  'inferred',
  'unknown',
  'conflicting',
] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/**
 * Provenance values that may NOT by themselves justify starting
 * implementation. An inference is a hypothesis; an unknown is a gap; a
 * conflict is a contradiction. Each needs a user decision or spec change.
 */
export const UNSAFE_PROVENANCE_KINDS: readonly ProvenanceKind[] = [
  'inferred',
  'unknown',
  'conflicting',
];

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The bounded taxonomy of actions an orchestrated agent may record.
 *
 * This is an *operational* record — what category of thing was attempted,
 * against what target, expecting what evidence. It is explicitly not a place
 * to store reasoning: see docs/orchestration/react-tao-execution.md.
 */
export const ACTION_CATEGORIES = [
  /** Read repository state: files, tests, structure, dependencies. */
  'INSPECT',
  /** Mutate source files inside the approved task scope. */
  'EDIT',
  /** Run tests through the host's own tooling (evidence is still claims). */
  'TEST',
  /** Request trusted verification through the existing task_complete path. */
  'VERIFY',
  /** Declare the active plan invalid and request a replacement. */
  'REPLAN',
  /** Stop and ask the user a targeted question. */
  'REQUEST_CLARIFICATION',
  /** End the run without completion. */
  'ABORT',
  /** Assert the implementation is ready for the completion gate. */
  'COMPLETE',
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/** Actions that mutate repository source and therefore need a valid plan. */
export const MUTATING_ACTION_CATEGORIES: readonly ActionCategory[] = ['EDIT'];

/** How one recorded action turned out, as observed rather than as claimed. */
export const OBSERVATION_RESULTS = [
  /** The action produced the expected evidence. */
  'progressed',
  /** The action completed but produced no new information. */
  'no-change',
  /** The action failed; a failure classification accompanies it. */
  'failed',
] as const;
export type ObservationResult = (typeof OBSERVATION_RESULTS)[number];

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

/**
 * Stable failure categories. Retryability, replan eligibility, clarification
 * eligibility, and termination are derived from these by policy — never by an
 * agent deciding to "just try again".
 */
export const FAILURE_CATEGORIES = [
  /** Transport/process hiccup before any mutation; safely retryable. */
  'TRANSIENT_TRANSPORT',
  /** Tooling hiccup that is safe to repeat (idempotent read/probe). */
  'TRANSIENT_TOOL',
  /** A trusted verification command failed. Repair, never blind retry. */
  'VERIFICATION_FAILURE',
  /** The implementation is wrong. Repair, never retry. */
  'IMPLEMENTATION_DEFECT',
  /** The request is underspecified. Clarify, never retry. */
  'AMBIGUITY',
  /** A required dependency or prerequisite is unavailable. */
  'BLOCKED_DEPENDENCY',
  /** A required runner/tool capability is not available. */
  'CAPABILITY_UNAVAILABLE',
  /** Credentials are missing or rejected. Never auto-retried. */
  'AUTHENTICATION',
  /** An operation was denied by permission policy. Never auto-retried. */
  'PERMISSION',
  /** A SpecBridge safety boundary was hit. Never auto-retried. */
  'SAFETY_POLICY',
  /** The bound spec/task/plan context is no longer current. */
  'STALE_CONTEXT',
  /** The repository moved underneath the run (HEAD, protected state). */
  'REPOSITORY_DIVERGED',
  /** A protected path was modified. */
  'PROTECTED_PATH',
  /** Repeated actions produced materially identical state. */
  'NO_PROGRESS',
  /** A configured budget was exhausted. */
  'BUDGET_EXHAUSTED',
  /** The user cancelled. Never auto-restarted. */
  'CANCELLED',
  /** The configuration itself is invalid. */
  'INVALID_CONFIGURATION',
  /** An unexpected internal fault; reported without leaking internals. */
  'INTERNAL',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * The deterministic directive returned after each recorded observation. The
 * host agent does not choose this; it reads it.
 */
export const NEXT_STEP_DIRECTIVES = [
  /** Continue the bounded loop with the next plan step. */
  'CONTINUE',
  /** Retry the same transient operation after the given backoff. */
  'RETRY',
  /** Ask for trusted verification through task_complete. */
  'VERIFY',
  /** Enter (or continue) a bounded repair cycle against fresh evidence. */
  'REPAIR',
  /** The active plan is invalid; submit a replacement. */
  'REPLAN',
  /** Stop and ask the user the recorded question(s). */
  'CLARIFY',
  /** Stop: a prerequisite is unsatisfied. */
  'BLOCK',
  /** Stop: a budget is exhausted. Evidence is preserved. */
  'STOP_BUDGET_EXHAUSTED',
  /** Stop: the run reached a final phase. */
  'STOP_FINAL',
] as const;
export type NextStepDirective = (typeof NEXT_STEP_DIRECTIVES)[number];

/** Whether a plan change is material enough to invalidate a prior review. */
export const PLAN_CHANGE_MATERIALITY = ['material', 'immaterial'] as const;
export type PlanChangeMateriality = (typeof PLAN_CHANGE_MATERIALITY)[number];

/** Why a plan stopped being valid for the current context. */
export const PLAN_STALENESS_REASONS = [
  'task-fingerprint-changed',
  'approved-stage-changed',
  'repository-baseline-changed',
  'policy-changed',
  'superseded',
] as const;
export type PlanStalenessReason = (typeof PLAN_STALENESS_REASONS)[number];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Append-only orchestration event types (`events.jsonl`). */
export const ORCHESTRATION_EVENT_TYPES = [
  'orchestration_started',
  'intent_assessed',
  'clarification_requested',
  'clarification_resolved',
  'plan_created',
  'plan_reviewed',
  'plan_invalidated',
  'execution_started',
  'action_recorded',
  'observation_recorded',
  'verification_failed',
  'repair_started',
  'replan_started',
  'checkpoint_created',
  'execution_blocked',
  'execution_completed',
  'execution_aborted',
  'execution_cancelled',
  'budget_exhausted',
] as const;
export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];

/**
 * How strongly a given orchestration rule is actually enforced.
 *
 * Recorded and documented explicitly so no skill instruction is ever
 * mistaken for a security boundary.
 *
 * - `hard-enforced`     SpecBridge code refuses the operation outright.
 * - `contract-enforced` The MCP/CLI contract requires structured evidence
 *                       (a hash, an explicit decision) that a host cannot
 *                       fabricate without lying in a recorded field.
 * - `skill-guided`      Instructional only. The host can bypass it.
 */
export const ENFORCEMENT_LEVELS = ['hard-enforced', 'contract-enforced', 'skill-guided'] as const;
export type EnforcementLevel = (typeof ENFORCEMENT_LEVELS)[number];
