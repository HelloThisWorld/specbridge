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
  // -------------------------------------------------------------------------
  // Autonomous operational statuses (vNext.10; appended, never reordered).
  //
  // Every one of these exists because the previous long-horizon dogfood
  // proved that folding operational failure into BLOCKED makes an
  // unattended run stop for a human who can do nothing useful. They share
  // one property that BLOCKED deliberately lacks: the runtime knows what it
  // is waiting for, and the supervisor may leave the status on its own when
  // that reason disappears. None of them is final, and none of them is a
  // request for a human.
  // -------------------------------------------------------------------------
  /**
   * A named resource is unavailable and expected back: a subscription quota
   * window, a provider cooldown, a rate limit. `retryAt` carries the earliest
   * legal resume, and the supervisor wakes the job without any `--resume`.
   */
  'WAITING_RESOURCE',
  /**
   * A provider or local inference process is being restarted, failed over,
   * or re-probed. The work itself is fine; the thing that was going to do it
   * is not, and SpecBridge is fixing that.
   */
  'RECOVERING_PROVIDER',
  /**
   * A missing or broken ENGINEERING tool is being provisioned under the
   * Toolsmith capability broker: a package manager, a build toolchain, a
   * browser runtime, a project-local script. Never the product's own code.
   */
  'REPAIRING_TOOLCHAIN',
  /**
   * A local product runtime environment (compose project, broker, database,
   * app server) is being provisioned, restarted, or repaired. Distinct from
   * REPAIRING_TOOLCHAIN on purpose: a Kafka broker that will not become
   * healthy is a different problem from a missing `pnpm`, and telemetry that
   * merged them could not say which one an overnight run actually hit.
   */
  'REPAIRING_ENVIRONMENT',
  /**
   * A recoverable SpecBridge/runner defect is being repaired through the
   * governed control-plane repair path, with the product job checkpointed
   * and suspended. The narrowest and most heavily gated of these statuses.
   */
  'REPAIRING_CONTROL_PLANE',
  /**
   * Planned implementation is done and the job is in the closure lifecycle:
   * contract-closure audit, system-scenario qualification, reproducibility,
   * final audit. Work can still be GENERATED from here — QUALIFYING is not
   * a victory lap, it is the phase that decides whether COMPLETED is even
   * available.
   */
  'QUALIFYING',
  /**
   * Continuing genuinely requires PRODUCT AUTHORITY the sealed Mission does
   * not contain. Deliberately NOT ordinary BLOCKED, and deliberately not
   * reachable from complexity, risk, diff size, or repeated failure: this
   * status is the one thing an unattended run is allowed to stop a human
   * for, so its meaning must stay narrow enough to be worth waking up to.
   */
  'NEEDS_AUTHORITY',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Statuses in which the runtime is recovering from an OPERATIONAL problem.
 *
 * The defining property: a supervisor may leave the status by itself when
 * the underlying condition clears. Nothing here is a human request, and
 * `humanInterventionsAfterSeal` must never be incremented for any of them.
 */
export const OPERATIONAL_JOB_STATUSES: readonly JobStatus[] = [
  'WAITING_RESOURCE',
  'RECOVERING_PROVIDER',
  'REPAIRING_TOOLCHAIN',
  'REPAIRING_ENVIRONMENT',
  'REPAIRING_CONTROL_PLANE',
  'WAITING_RETRY',
];

export function isOperationalJobStatus(status: JobStatus): boolean {
  return OPERATIONAL_JOB_STATUSES.includes(status);
}

/**
 * Statuses that genuinely require a person before anything else may run.
 *
 * `BLOCKED` is here because a blocker names an external prerequisite only a
 * human can satisfy. `NEEDS_CLARIFICATION` is here because an unanswered
 * question stalls the job. `NEEDS_AUTHORITY` is here because that is its
 * entire purpose. Nothing else is: an unattended run that stops in any
 * other non-final status has a supervisor bug, not a governance event.
 */
export const HUMAN_ATTENTION_JOB_STATUSES: readonly JobStatus[] = [
  'NEEDS_AUTHORITY',
  'NEEDS_CLARIFICATION',
  'BLOCKED',
];

export function requiresHumanAttention(status: JobStatus): boolean {
  return HUMAN_ATTENTION_JOB_STATUSES.includes(status);
}

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
  // vNext.2 (additive, never reordered).
  /** The local EXECUTOR declined or exhausted its bounded attempts. */
  'LOCAL_EXECUTION_ESCALATED',
  // vNext.4 (additive, never reordered).
  /**
   * A LOCAL direct attempt failed for reasons repository tools address
   * (missing repository knowledge, no edit produced, a test/fix loop is
   * needed). This is a LOCAL → LOCAL transition to the harness mode, NOT a
   * strong-lane escalation: it consumes no subscription quota and shares the
   * same bounded local attempt budget.
   */
  'LOCAL_DIRECT_TO_HARNESS',
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
  /** Wait for subscription quota capacity to return (vNext.2). */
  'WAIT_QUOTA',
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
  /** A person fixed an environmental cause and continued the job. */
  'job_unblocked',
  /** Self-diagnosis on resume repaired state a previous incident broke. */
  'self_heal_applied',
  'job_completed',
  'job_failed',
  'job_cancelled',
  // Objective-runtime events (additive; semantic, never per-tool-call).
  'workgraph_proposed',
  'workgraph_created',
  'workgraph_revised',
  'worker_started',
  'candidate_ready',
  /** A stored candidate re-entered evaluation, but its artifacts were gone; the unit rebuilds. */
  'candidate_resume_missing',
  /** A blocking semantic reason re-adjudicated a settled deterministic check; one re-ask issued. */
  'evaluation_contradiction_screened',
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
  // Quota-scheduler events (vNext.2; additive, never reordered).
  'quota_snapshot_updated',
  'scheduler_mode_changed',
  'workload_estimated',
  'local_suitability_classified',
  'scheduling_decision_created',
  'task_routed_local',
  'task_routed_subscription',
  'task_deferred',
  'harvest_entered',
  'harvest_exited',
  'dynamic_reserve_changed',
  'cross_reset_admitted',
  'local_attempt_failed',
  'local_escalation_triggered',
  'quota_telemetry_stale',
  'quota_exhausted',
  'context_compaction_before_dispatch',
  // Local agentic runtime events (vNext.4; additive, never reordered).
  'local_execution_mode_selected',
  'local_harness_selected',
  'local_harness_unavailable',
  'local_harness_locality_rejected',
  'local_direct_to_harness_escalated',
  'local_harness_to_subscription_escalated',
  'local_runtime_evaluation_recorded',
  // API gap bridge events (vNext.5; additive, never reordered). These are
  // deliberately SEMANTIC — the money-shaped moments of a job's timeline —
  // and never duplicate the low-level runner events the harness already
  // emits for its own turns and tool calls.
  'api_gap_detected',
  'api_gap_short_deferred',
  'api_approval_required',
  'api_approval_granted',
  'api_approval_denied',
  'api_budget_reserved',
  'api_budget_exceeded',
  'api_budget_reconciled',
  'api_budget_exhausted',
  'api_task_dispatched',
  'api_attempt_failed',
  'api_cost_unknown',
  'api_max_returned',
  'api_next_task_returned_to_subscription',
  // Reliability / evaluation / recovery events (vNext.6; additive, never
  // reordered). Deliberately SEMANTIC — the moments where SpecBridge judged
  // work or changed its mind — and deliberately few: `evaluation_passed`,
  // `evaluation_failed`, `repair_started`, `replan_started`, and
  // `budget_exhausted` already exist above and are REUSED rather than
  // duplicated under reliability-flavoured names.
  'evaluation_started',
  'evaluation_inconclusive',
  'semantic_review_completed',
  'failure_assessed',
  'execution_stalled',
  'execution_oscillating',
  'execution_runaway',
  'recovery_decided',
  'fresh_context_selected',
  'local_mode_recovery_selected',
  'lane_escalation_requested',
  'resource_wait_selected',
  'recovery_budget_exhausted',
  'task_blocked_after_recovery',
  'dependents_gated_on_evaluation',
  // Context-efficiency events (vNext.7; additive, never reordered). Semantic
  // again: the moments where SpecBridge chose what a worker would see, found
  // its picture of the repository out of date, or widened retrieval because
  // evidence said the package was insufficient. The per-file selection detail
  // lives on the durable ContextSelectionPlan, not in the event stream.
  'context_index_built',
  'context_index_refreshed',
  'context_selected',
  'context_stale_artifact_detected',
  'context_insufficient',
  'context_expanded',
  'context_expansion_exhausted',
  // Adaptive compute scheduler events (vNext.8; additive, never reordered).
  // Semantic, and deliberately few: these are the moments where observed
  // history changed (or declined to change) a placement, or where derived
  // analytics were rebuilt. The per-candidate arithmetic lives on the
  // durable AdaptiveSchedulingDecision, not in the event stream — a scheduler
  // that emitted an event per score would drown the timeline it exists to
  // explain.
  'adaptive_prediction_created',
  'adaptive_candidate_selected',
  'adaptive_candidate_vetoed',
  'adaptive_shadow_disagreement',
  'adaptive_fallback_to_heuristic',
  'adaptive_drift_detected',
  'adaptive_profile_rebuilt',
  'adaptive_cache_invalidated',
  // Overnight autonomous runtime events (vNext.10; additive, never
  // reordered). Semantic again, and deliberately about AUTHORITY and
  // OPERATIONAL OWNERSHIP: the moments where a human's delegated intent was
  // bound to a job, where the runtime took a decision instead of asking,
  // where it recovered without help, and the single moment where it stopped
  // because the decision was genuinely not its to make. The per-check
  // detail lives on the durable autonomy records, not in this stream.
  'autonomy_seal_bound',
  'autonomy_policy_drift_detected',
  'authority_delegated',
  'authority_escalated',
  'authority_resolved',
  'supervisor_attached',
  'supervisor_lease_reclaimed',
  'supervisor_detached',
  'driver_restarted',
  'resource_wait_started',
  'resource_wait_ended',
  'provider_recovery_started',
  'provider_recovery_completed',
  'toolchain_repair_started',
  'toolchain_repair_completed',
  'toolsmith_grant_issued',
  'toolsmith_grant_denied',
  'environment_provision_started',
  'environment_ready',
  'environment_failed',
  'environment_repaired',
  'environment_torn_down',
  'browser_scenario_started',
  'browser_scenario_completed',
  'ux_critique_completed',
  'control_plane_defect_detected',
  'control_plane_repair_started',
  'control_plane_repair_completed',
  'context_rollover',
  'closure_audit_completed',
  'gap_work_generated',
  'gap_repair_completed',
  'system_qualification_started',
  'system_qualification_completed',
  'release_qualification_completed',
  'reproducibility_completed',
  // Research-augmented lifecycle (vNext.10.2 Phase 3). These events record
  // evidence flow and fallback only; none grants product or completion authority.
  'runtime_research_eligible',
  'research_degraded',
  'research_fallback_started',
  'research_used',
  'research_replan_caused',
  // Secondary Objective Builder (vNext.10.2 Phase 4). Raw proposal and
  // verification detail live in the durable attempt artifact.
  'secondary_builder_attempted',
  'secondary_candidate_succeeded',
  // Phase 6 admission evidence. This records eligibility only; it never
  // selects an execution lane or model.
  'secondary_readiness_assessed',
  // Phase 7 builder routing and bounded repair/fallback evidence.
  'builder_routing_decided',
  'builder_routing_attempt_completed',
  'builder_routing_candidate_finalized',
  // Phase 8 resource-scoped continuation. Per-unit waits are durable on the
  // WorkGraph; these events make episode boundaries and useful work visible.
  'resource_cooldown_started',
  'resource_cooldown_observed',
  'work_unit_resource_wait_started',
  'work_unit_resource_wait_ended',
  'resource_wait_entered',
  'useful_work_during_cooldown',
  'resource_recovered',
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];
