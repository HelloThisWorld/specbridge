/**
 * The stable vocabulary of long-running orchestration jobs (v1.2).
 *
 * Everything here is a closed string enum, snapshotted into
 * `contracts/orchestration-contract.json` alongside the v1.1 run vocabulary.
 * Values are additive within 1.x: new members may be appended, existing
 * members never change meaning and are never removed, so persisted job state
 * stays readable across upgrades.
 *
 * The organising idea extends v1.1 unchanged: SpecBridge owns *state, policy,
 * scheduling, budgets, and boundaries*; workers (a local model, Claude Code)
 * own *proposals and edits*; Git and the trusted verification commands own
 * *evidence*. A job is the persistent thing; every agent invocation is an
 * ephemeral, bounded worker run. No enum below can be set from spec text,
 * plan text, model output, or repository content.
 */

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/**
 * Statuses of one persistent orchestration job.
 *
 * A status exists only when a job can genuinely be *observed and resumed* in
 * it after a process interruption. Verification is deliberately NOT a status:
 * it happens inside the existing task-completion pipeline, whose own run
 * records and locks already make an interrupted verification observable and
 * recoverable. Duplicating that state here would create two sources of truth.
 */
export const JOB_STATUSES = [
  /** The job exists; no runtime execution graph has been built yet. */
  'CREATED',
  /** The runtime execution graph (or a node plan) is being produced. */
  'PLANNING',
  /** Work is schedulable; nothing is dispatched right now. */
  'READY',
  /** A worker dispatch is in flight for the current node. */
  'RUNNING',
  /** A failure is being diagnosed before any repair or replan. */
  'DIAGNOSING',
  /** A repair dispatch is addressing a diagnosed defect against fresh evidence. */
  'REPAIRING',
  /** The active plan or graph was invalidated; a replacement is being produced. */
  'REPLANNING',
  /** A transient failure occurred; the job resumes at `retryAt`. */
  'WAITING_RETRY',
  /** A human decision is required that cannot safely be inferred. */
  'NEEDS_CLARIFICATION',
  /** Cannot proceed; needs an explicit user action. Recoverable, not final. */
  'BLOCKED',
  /** Final: every scheduled node completed through verified evidence. */
  'COMPLETED',
  /** Final: the job ended without completion. */
  'FAILED',
  /** Final: the user cancelled; never auto-restarted. */
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses from which no further scheduling can proceed. */
export const FINAL_JOB_STATUSES: readonly JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function isFinalJobStatus(status: JobStatus): boolean {
  return FINAL_JOB_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Runtime graph nodes
// ---------------------------------------------------------------------------

/**
 * Statuses of one runtime execution-graph node.
 *
 * A node is one unit of approved work — it binds to exactly one approved
 * task from `tasks.md`. Runtime refinement (the 4a/4b/4c breakdown, added
 * internal prerequisites, reordered internals) lives in the node's execution
 * plan revisions, which are the v1.1 `ExecutionPlan` documents with full
 * supersession lineage — not in extra graph nodes, which would create a
 * parallel plan model with weaker evidence attribution.
 */
export const JOB_NODE_STATUSES = [
  /** Dependencies are not yet satisfied. */
  'PENDING',
  /** Dependencies satisfied; the node can be scheduled. */
  'READY',
  /** A worker dispatch for this node is in flight. */
  'RUNNING',
  /** A repair cycle is addressing a diagnosed failure on this node. */
  'REPAIRING',
  /** The node cannot proceed without an explicit action. */
  'BLOCKED',
  /** The node's task completed through the trusted evidence path. */
  'COMPLETED',
  /** The node ended without completion. */
  'FAILED',
  /** The node was replaced by a successor in a later graph revision. */
  'SUPERSEDED',
] as const;
export type JobNodeStatus = (typeof JOB_NODE_STATUSES)[number];

/** Node statuses that end the node's own lifecycle. */
export const FINAL_JOB_NODE_STATUSES: readonly JobNodeStatus[] = [
  'COMPLETED',
  'FAILED',
  'SUPERSEDED',
];

export function isFinalNodeStatus(status: JobNodeStatus): boolean {
  return FINAL_JOB_NODE_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Agent roles and worker tiers
// ---------------------------------------------------------------------------

/**
 * Logical agent roles. A role is what a worker is asked to *do*, never who
 * the worker *is*: the same llama.cpp endpoint serves several roles with
 * different prompts, and Claude Code serves several with different packets.
 * Scheduling logic branches on roles and capabilities, never on provider
 * names.
 */
export const AGENT_ROLES = [
  /** Assess task complexity and routing signals. Read-only. */
  'CLASSIFIER',
  /** Propose an execution plan for one approved task. Read-only. */
  'PLANNER',
  /** Review a candidate plan: accept, revise, or escalate. Read-only. */
  'CRITIC',
  /** Classify a failure and recommend repair or replan. Read-only. */
  'DIAGNOSER',
  /** Propose a replacement plan when assumptions were invalid. Read-only. */
  'REPLANNER',
  /** Implement source changes for one approved task. The only writing role. */
  'EXECUTOR',
  // Objective-runtime roles (additive; appended, never reordered).
  /** Propose a work graph decomposing one approved objective. Read-only. */
  'DECOMPOSER',
  /** Implement one work unit inside an ISOLATED worktree, never the canonical tree. */
  'BUILDER',
  /** Judge one candidate artifact against the approved contract projection. Read-only. */
  'EVALUATOR',
  /** Synthesize several valid artifacts/reports into one structured result. Read-only. */
  'AGGREGATOR',
  /** Reconcile candidate changes during canonical integration (single writer path). */
  'INTEGRATOR',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Roles that may mutate the CANONICAL repository source. BUILDER is
 * deliberately not here: builders write only inside isolated per-attempt
 * worktrees, and their output enters the canonical tree exclusively through
 * the single-writer integration path.
 */
export const WRITING_ROLES: readonly AgentRole[] = ['EXECUTOR', 'INTEGRATOR'];

/** Roles whose writes are confined to an isolated candidate workspace. */
export const WORKTREE_WRITING_ROLES: readonly AgentRole[] = ['BUILDER'];

/**
 * Reasoning tiers. `LOCAL_SMALL` is a locally-served model suitable for
 * bounded, schema-constrained reasoning; `LARGE_AGENT` is a full coding agent
 * (Claude Code) suitable for complex reasoning and implementation.
 */
export const REASONING_TIERS = ['LOCAL_SMALL', 'LARGE_AGENT'] as const;
export type ReasoningTier = (typeof REASONING_TIERS)[number];

/**
 * Cost tiers. `LOCAL` consumes an unpriced local resource (never claimed to
 * be free); `PAID` consumes a metered provider account.
 */
export const COST_TIERS = ['LOCAL', 'PAID'] as const;
export type CostTier = (typeof COST_TIERS)[number];

// ---------------------------------------------------------------------------
// Complexity
// ---------------------------------------------------------------------------

/**
 * Normalized complexity classes. This is ROUTING POLICY, not a claim about
 * intelligence: it decides which tier attempts which work first, from
 * deterministic signals a test can replay exactly.
 */
export const COMPLEXITY_CLASSES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ComplexityClass = (typeof COMPLEXITY_CLASSES)[number];

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/**
 * Why reasoning moved from the local tier to the large agent. Every
 * escalation records one of these — a paid worker is never selected silently.
 */
export const ESCALATION_REASONS = [
  /** Deterministic complexity assessment classified the work HIGH. */
  'COMPLEXITY_HIGH',
  /** Policy routes this role to the large agent directly. */
  'ROLE_POLICY',
  /** No local worker is configured, enabled, or healthy. */
  'LOCAL_WORKER_UNAVAILABLE',
  /** Local structured output stayed invalid after the bounded correction. */
  'INVALID_LOCAL_OUTPUT',
  /** The local critic explicitly requested escalation. */
  'CRITIC_ESCALATED',
  /** Planner and critic materially disagree on the approach. */
  'PLANNER_CRITIC_DISAGREEMENT',
  /** Competing local plans diverged materially. */
  'COMPETING_PLANS_DIVERGED',
  /** The required context exceeds the configured local model limits. */
  'CONTEXT_LIMIT_EXCEEDED',
  /** Local reasoning failed repeatedly on this node. */
  'REPEATED_LOCAL_FAILURE',
  /** The work impacts architecture-sensitive areas. */
  'ARCHITECTURE_IMPACT',
  /** No-progress detection fired; a stronger reasoner is warranted. */
  'NO_PROGRESS',
  /** Replan budget pressure: the next replan must count. */
  'REPLAN_BUDGET_PRESSURE',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

// ---------------------------------------------------------------------------
// Decision authority
// ---------------------------------------------------------------------------

/**
 * Kinds of decisions an autonomous job may face. The authority table in
 * authority.ts maps each to who may make it. Represented structurally so the
 * rules are enforced by code and visible in one place — never buried in a
 * prompt a model could argue with.
 */
export const JOB_DECISION_KINDS = [
  'compile-repair',
  'unit-test-repair',
  'implementation-detail',
  'internal-refactor',
  'runtime-replan',
  'plan-strategy-disagreement',
  'new-dependency',
  'public-api-change',
  'architecture-contract-change',
  'product-behavior-change',
  'spec-conflict',
  'approval',
] as const;
export type JobDecisionKind = (typeof JOB_DECISION_KINDS)[number];

/**
 * Who may make a decision.
 *
 * - `auto`       the job may proceed without any escalation
 * - `escalate`   the large agent must reason about it (still no human gate)
 * - `policy`     configuration decides between auto and human
 * - `human`      an explicit human decision is required
 * - `human-only` a human is the ONLY possible authority; no configuration,
 *                policy, worker, or model can ever hold it (approvals)
 */
export const DECISION_AUTHORITIES = ['auto', 'escalate', 'policy', 'human', 'human-only'] as const;
export type DecisionAuthority = (typeof DECISION_AUTHORITIES)[number];

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * The closed set of directives a scheduler decision can carry. The driver
 * does not choose these; it executes them. Every directive is either an
 * instruction to run exactly one bounded worker, an instruction to wait, or
 * a terminal report.
 */
export const SCHEDULER_DIRECTIVES = [
  /** Build the initial runtime execution graph (deterministic, no model). */
  'BUILD_GRAPH',
  /** Run one read-only reasoning role against the current node. */
  'RUN_ROLE',
  /** Dispatch the executor for the current node through the evidence path. */
  'DISPATCH_EXECUTOR',
  /** Wait until `retryAt`, then reschedule. */
  'WAIT_RETRY',
  /** A human decision is required before anything else may run. */
  'AWAIT_HUMAN',
  /** The job is complete; nothing remains. */
  'JOB_COMPLETE',
  /** The job cannot proceed; an explicit blocker is recorded. */
  'JOB_BLOCKED',
  /** The job is already final; nothing may run. */
  'JOB_FINAL',
] as const;
export type SchedulerDirective = (typeof SCHEDULER_DIRECTIVES)[number];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Append-only job event types (`.specbridge/jobs/<id>/events.jsonl`). */
export const JOB_EVENT_TYPES = [
  'job_created',
  'job_resumed',
  'graph_created',
  'graph_revised',
  'node_ready',
  'worker_selected',
  'worker_escalated',
  'local_model_started',
  'local_model_stopped',
  'planning_started',
  'plan_created',
  'plan_reviewed',
  'critic_completed',
  'classification_completed',
  'execution_started',
  'execution_finished',
  'verification_failed',
  'diagnosis_completed',
  'repair_started',
  'replan_started',
  'node_completed',
  'node_failed',
  'node_superseded',
  'waiting_retry',
  'clarification_requested',
  'clarification_resolved',
  'repository_reconciled',
  'checkpoint_created',
  'budget_exhausted',
  'job_blocked',
  'job_completed',
  'job_failed',
  'job_cancelled',
  // Objective-runtime events (additive; semantic, never per-tool-call).
  'workgraph_proposed',
  'workgraph_created',
  'workgraph_revised',
  'worker_started',
  'candidate_ready',
  'candidate_failed',
  'evaluation_passed',
  'evaluation_failed',
  'contract_conflict_detected',
  'contract_change_requested',
  'needs_decision',
  'projection_stale',
  'workunit_superseded',
  'aggregation_completed',
  'integration_ready',
  'integration_started',
  'integration_failed',
  'objective_verified',
  // Survival-runtime events (vNext.1; additive, never reordered).
  'attempt_started',
  'attempt_completed',
  'attempt_interrupted',
  'task_checkpoint_created',
  'task_resumed',
  'context_threshold_reached',
  'context_compacted',
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];
