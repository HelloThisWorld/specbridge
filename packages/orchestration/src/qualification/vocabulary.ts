/**
 * Dogfood & release-qualification vocabulary (vNext.9).
 *
 * Closed string enums with the same rules as every other orchestration
 * vocabulary: members may be APPENDED, never removed, renumbered, or
 * repurposed, so persisted qualification records stay readable across
 * upgrades.
 *
 * This phase adds no runtime capability. It adds the vocabulary in which
 * SpecBridge states, and an auditor checks, what was actually proven — and
 * by what. The failure mode of a release qualification is not "the run
 * failed"; it is "the run passed and nobody can say what it demonstrated".
 * Every enum here is chosen so that an exaggerated claim has no
 * representation:
 *
 *   a skipped scenario is not a PASS
 *   a simulated resource is not a REAL one
 *   an operator's manual code fix is not "human approval"
 *   a Mission that finished is not by itself a release
 *
 * Nothing here can be set from spec text, model output, agent proposals, or
 * repository content. Scenario results are written by the qualification
 * runner from observed durable state; verdicts are computed from them.
 */

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Which resources a qualification invocation is permitted to use.
 *
 * A profile is a CEILING, never a grant. `full` does not authorize spend:
 * the vNext.5 spend mode, budget, and approval rules apply unchanged, and a
 * `full` run against `apiSpend.mode = DISABLED` legitimately produces zero
 * API usage.
 */
export const QUALIFICATION_PROFILES = [
  /** Deterministic fakes only. No network, no provider, no money. CI-safe. */
  'offline',
  /** Real local compute; strong lanes remain deterministic fakes. */
  'local',
  /** Real local compute and a real subscription runner. Never paid API. */
  'subscription',
  /** Local + subscription + API, still bounded by existing spend policy. */
  'full',
] as const;
export type QualificationProfile = (typeof QUALIFICATION_PROFILES)[number];

/** Profiles that may consume a metered provider account. */
export const PAID_CAPABLE_PROFILES: readonly QualificationProfile[] = ['full'];

/** Profiles that consume no operator resource at all. */
export const OFFLINE_PROFILES: readonly QualificationProfile[] = ['offline'];

// ---------------------------------------------------------------------------
// Scenario taxonomy
// ---------------------------------------------------------------------------

/** The areas of the qualification scenario matrix. */
export const QUALIFICATION_AREAS = [
  'Survival',
  'Context',
  'Local',
  'Quota',
  'API',
  'Reliability',
  'Adaptive',
  'Governance',
  'Mission',
] as const;
export type QualificationArea = (typeof QUALIFICATION_AREAS)[number];

/**
 * HOW a scenario is executed, which decides where it can honestly run.
 *
 * The distinction matters because a matrix that hid it would let a CLI
 * invocation report coverage it never had. `POLICY` scenarios are pure
 * production functions and run anywhere, including from the operator CLI.
 * `RUNTIME` scenarios drive the real job driver against fixture workspaces
 * and deterministic worker doubles, and belong to the automated regression
 * qualification. `REAL_RESOURCE` scenarios cannot be simulated at all.
 */
export const SCENARIO_EXECUTION_KINDS = [
  /** Deterministic production policy functions; no workspace, no processes. */
  'POLICY',
  /** The real driver over a temporary workspace with deterministic doubles. */
  'RUNTIME',
  /** Requires a real provider, a real subscription window, or real money. */
  'REAL_RESOURCE',
] as const;
export type ScenarioExecutionKind = (typeof SCENARIO_EXECUTION_KINDS)[number];

/**
 * The outcome of one qualification scenario.
 *
 * `SKIPPED_WITH_REASON` is deliberately neither a pass nor a failure: a
 * scenario that needs a real subscription window has not been disproved by
 * an offline run, and reporting it either way would be a lie. `NOT_RUN` is
 * the initial state of every scenario in a run.
 */
export const SCENARIO_RESULT_STATUSES = ['PASS', 'FAIL', 'SKIPPED_WITH_REASON', 'NOT_RUN'] as const;
export type ScenarioResultStatus = (typeof SCENARIO_RESULT_STATUSES)[number];

/** Whether a scenario must hold for the release gate to be satisfiable. */
export const SCENARIO_REQUIREMENTS = [
  /** Must PASS. A FAIL or a skip blocks the release verdict. */
  'REQUIRED',
  /** Must PASS when exercised; an honest skip is tolerated. */
  'REQUIRED_WHEN_EXERCISED',
  /** The final real-product gate. Never satisfiable by a synthetic fixture. */
  'RELEASE_GATE',
] as const;
export type ScenarioRequirement = (typeof SCENARIO_REQUIREMENTS)[number];

// ---------------------------------------------------------------------------
// Fault classes
// ---------------------------------------------------------------------------

/**
 * The fault classes SpecBridge claims to survive, named so a report can say
 * which were actually injected rather than merely hoped for.
 *
 * Every member corresponds to a required fault class of the vNext.9
 * specification and to at least one matrix scenario. Appended, never
 * reordered.
 */
export const FAULT_CLASSES = [
  'WORKER_CRASH',
  'PROCESS_CRASH',
  'SESSION_LOSS',
  'CONTEXT_SATURATION',
  'DERIVED_CONTEXT_CACHE_LOSS',
  'ADAPTIVE_CACHE_LOSS',
  'FIVE_HOUR_EXHAUSTION',
  'FIVE_HOUR_RESET',
  'CROSS_RESET_TASK',
  'HARVEST_WINDOW',
  'WEEKLY_SCARCITY',
  'WEEKLY_EXHAUSTION',
  'API_DISABLED',
  'API_BUDGET_EXHAUSTION',
  'INTERRUPTED_PAID_ATTEMPT',
  'SUBSCRIPTION_RETURNS_MID_API',
  'LOCAL_HARNESS_INFRASTRUCTURE_FAILURE',
  'LOCAL_INTELLIGENCE_FAILURE',
  'FALSE_COMPLETION_CLAIM',
  'REPEATED_IDENTICAL_FAILURE',
  'EDIT_OSCILLATION',
  'HARNESS_RUNAWAY',
  'CONTEXT_MISS',
  'CONTEXT_EXPANSION_EXHAUSTION',
  'VERIFICATION_INFRASTRUCTURE_FAILURE',
  'CONTRACT_VIOLATION',
  'REPLAN_WITHOUT_INTENT_CHANGE',
  'INVALID_CONTRACT_CHANGE',
  'PROTECTED_STATE_MUTATION',
  'REMOTE_MISCLASSIFIED_AS_LOCAL',
  'ADAPTIVE_POLICY_VETO',
  'ADAPTIVE_LOW_CONFIDENCE',
  'ADAPTIVE_DRIFT',
] as const;
export type FaultClass = (typeof FAULT_CLASSES)[number];

/**
 * Where a fault is injected. Injection happens at SpecBridge-controlled
 * boundaries ONLY: telemetry providers, injected inference, injected clocks,
 * the runner registry, and durable state on disk. No member reaches inside a
 * provider process, and none of them exists as a runtime branch in
 * production execution code.
 */
export const FAULT_BOUNDARIES = [
  /** The injected quota telemetry provider (vNext.2 seam). */
  'QUOTA_TELEMETRY',
  /** The injected local executor inference (vNext.2/vNext.4 seam). */
  'LOCAL_INFERENCE',
  /** The runner registry entry a dispatch resolves. */
  'RUNNER_REGISTRY',
  /** A trusted verification command's own process. */
  'VERIFICATION_COMMAND',
  /** Durable state on disk under `.specbridge/` (deletion or corruption). */
  'DURABLE_STATE',
  /** A derived cache under `.specbridge/cache/` (deletion or corruption). */
  'DERIVED_CACHE',
  /** The driver's injected clock and sleep. */
  'CLOCK',
  /** The orchestrating process itself (abort, kill, restart). */
  'PROCESS',
] as const;
export type FaultBoundary = (typeof FAULT_BOUNDARIES)[number];

/** Whether an injection fires once or on every eligible occasion. */
export const FAULT_TRIGGER_MODES = ['ONE_SHOT', 'REPEATED'] as const;
export type FaultTriggerMode = (typeof FAULT_TRIGGER_MODES)[number];

// ---------------------------------------------------------------------------
// Resource attribution
// ---------------------------------------------------------------------------

/**
 * The resources whose reality a qualification report must state explicitly,
 * so "we validated a five-hour reset" can never be read as "we waited five
 * hours" when a fake clock did the work.
 */
export const QUALIFICATION_RESOURCES = [
  'LOCAL_DIRECT_MODEL',
  'LOCAL_HARNESS',
  'SUBSCRIPTION_RUNNER',
  'API_PROVIDER',
  'QUOTA_TELEMETRY',
  'FIVE_HOUR_WINDOW',
  'WEEKLY_WINDOW',
  'HARVEST',
  'CONTEXT_COMPACTION',
  'REPOSITORY_CONTEXT_INDEX',
  'ADAPTIVE_PROFILES',
  'PROCESS_RESTART',
  'WORKER_CRASH',
  'SESSION_LOSS',
  'TRUSTED_VERIFICATION',
  'TARGET_REPOSITORY',
] as const;
export type QualificationResource = (typeof QUALIFICATION_RESOURCES)[number];

/**
 * How a resource was exercised.
 *
 * There is no fourth member, and in particular no "EQUIVALENT": a fake clock
 * that advanced five hours produced SIMULATED evidence about a five-hour
 * window, and the report says so.
 */
export const RESOURCE_ATTRIBUTIONS = ['REAL', 'SIMULATED', 'NOT_EXERCISED'] as const;
export type ResourceAttribution = (typeof RESOURCE_ATTRIBUTIONS)[number];

// ---------------------------------------------------------------------------
// Human intervention
// ---------------------------------------------------------------------------

/**
 * Why a human touched a running Mission.
 *
 * The point of the classification is the line between the first two members
 * and the rest. `REQUIRED_BY_POLICY` is the system working: SpecBridge
 * stopped where governance says a human decides. Everything from
 * `RUNTIME_FAILURE` down is the system NOT working, and a report that folded
 * them together would make autonomy unfalsifiable.
 */
export const HUMAN_INTERVENTION_KINDS = [
  /** A governance boundary required a human. Intended, not a failure. */
  'REQUIRED_BY_POLICY',
  /** The Mission genuinely lacked product information only a human had. */
  'MISSING_INFORMATION',
  /** A human had to act because the runtime broke. */
  'RUNTIME_FAILURE',
  /** SpecBridge asked something it should have resolved itself. */
  'UNNECESSARY_CLARIFICATION',
  /** A human had to steer recovery the runtime should have chosen. */
  'MANUAL_RECOVERY',
  /** A human edited generated source. A serious autonomy failure. */
  'MANUAL_CODE_FIX',
  /** A human overrode placement or resource scheduling. */
  'MANUAL_SCHEDULING',
  /** A human re-supplied information canonical artifacts already held. */
  'MANUAL_CONTEXT_REPAIR',
  /** A human edited durable control state. Release-blocking. */
  'MANUAL_STATE_REPAIR',
] as const;
export type HumanInterventionKind = (typeof HUMAN_INTERVENTION_KINDS)[number];

/** Interventions that represent governance working as designed. */
export const GOVERNANCE_INTERVENTION_KINDS: readonly HumanInterventionKind[] = [
  'REQUIRED_BY_POLICY',
  'MISSING_INFORMATION',
];

/**
 * Interventions that mean the autonomous runtime failed to carry that part
 * of the work. Counted separately in the autonomy report, and never reported
 * as approvals.
 */
export const AUTONOMY_FAILURE_INTERVENTION_KINDS: readonly HumanInterventionKind[] = [
  'RUNTIME_FAILURE',
  'UNNECESSARY_CLARIFICATION',
  'MANUAL_RECOVERY',
  'MANUAL_CODE_FIX',
  'MANUAL_SCHEDULING',
  'MANUAL_CONTEXT_REPAIR',
  'MANUAL_STATE_REPAIR',
];

// ---------------------------------------------------------------------------
// Release blockers
// ---------------------------------------------------------------------------

/**
 * Defect classes that make a release verdict FAIL however much code the
 * Mission produced. Every member is a violation of an invariant a previous
 * phase committed to — this list is the roadmap's promises restated as
 * things that must never be observed.
 */
export const RELEASE_BLOCKER_CLASSES = [
  'CANONICAL_STATE_LOSS',
  'UNRECOVERABLE_AFTER_FAULT',
  'PROTECTED_STATE_MUTATION',
  'EVIDENCE_BYPASS',
  'UNAUTHORIZED_API_SPEND',
  'API_BUDGET_BYPASS',
  'REMOTE_REPORTED_AS_LOCAL',
  'QUOTA_POLICY_VIOLATION',
  'UNBOUNDED_RETRY_LOOP',
  'COMPACTION_LOST_CRITICAL_STATE',
  'ADAPTIVE_HARD_POLICY_BYPASS',
  'MANUAL_STATE_REPAIR_REQUIRED',
  'DEPENDENT_WORK_ON_UNVERIFIED_PREDECESSOR',
  'REQUIRED_SCENARIO_FAILED',
  'REQUIRED_SCENARIO_NOT_PROVEN',
] as const;
export type ReleaseBlockerClass = (typeof RELEASE_BLOCKER_CLASSES)[number];

/**
 * The zero-tolerance conditions. Each is counted, and any non-zero count is
 * a FAIL. They are counts rather than booleans so a report cannot round "one
 * unauthorized execution" down to "essentially none".
 */
export const ZERO_TOLERANCE_CONDITIONS = [
  'unauthorizedPaidExecutions',
  'canonicalStateLosses',
  'adaptiveHardPolicyBypasses',
  'evidenceBypassCompletions',
  'unrecoverableInjectedFaults',
  'acceptedProtectedStateMutations',
  'unboundedRetryLoops',
  'manualDurableStateRepairs',
  'dependentsOnFailedPredecessors',
] as const;
export type ZeroToleranceCondition = (typeof ZERO_TOLERANCE_CONDITIONS)[number];

// ---------------------------------------------------------------------------
// Limitations
// ---------------------------------------------------------------------------

/**
 * Serious-but-non-blocking limitation classes. These downgrade a PASS to
 * PASS_WITH_LIMITATIONS; they never produce a FAIL, because correctness and
 * governance are intact by definition when only these are present.
 */
export const LIMITATION_CLASSES = [
  'SUBOPTIMAL_PLACEMENT',
  'HIGHER_THAN_EXPECTED_CONTEXT',
  'SLOW_LOCAL_EXECUTION',
  'EXCESSIVE_BUT_BOUNDED_REPLAN',
  'POOR_ADAPTIVE_CALIBRATION',
  'UNHELPFUL_DIAGNOSTICS',
  'PERFORMANCE_INEFFICIENCY',
  'COVERAGE_NOT_EXERCISED',
] as const;
export type LimitationClass = (typeof LIMITATION_CLASSES)[number];

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * The release verdict.
 *
 * `PASS_WITH_LIMITATIONS` exists so an honest report is not forced to choose
 * between overstating and understating: it means every correctness and
 * governance gate held AND meaningful efficiency or usability limitations
 * remain. It is never available when a zero-tolerance condition was observed
 * or a required scenario is unproven.
 */
export const RELEASE_VERDICTS = ['PASS', 'PASS_WITH_LIMITATIONS', 'FAIL'] as const;
export type ReleaseVerdict = (typeof RELEASE_VERDICTS)[number];

// ---------------------------------------------------------------------------
// Dogfood runs
// ---------------------------------------------------------------------------

/** Lifecycle of one dogfood/qualification run record. */
export const DOGFOOD_RUN_STATUSES = [
  /** Created; preflight recorded; nothing has executed. */
  'PREFLIGHT',
  /** Scenarios and/or a bound Mission are executing. */
  'RUNNING',
  /** Deliberately paused by the operator. NOT a failure. */
  'PAUSED',
  /** Final: the run produced a verdict. */
  'COMPLETED',
  /** Final: the operator abandoned the run. */
  'ABANDONED',
] as const;
export type DogfoodRunStatus = (typeof DOGFOOD_RUN_STATUSES)[number];

/** Statuses from which no further qualification work proceeds. */
export const FINAL_DOGFOOD_RUN_STATUSES: readonly DogfoodRunStatus[] = ['COMPLETED', 'ABANDONED'];

export function isFinalDogfoodRunStatus(status: DogfoodRunStatus): boolean {
  return FINAL_DOGFOOD_RUN_STATUSES.includes(status);
}

/**
 * Whether the target repository of a run is the real product or a
 * deterministic fixture. A run whose target is `FIXTURE` can never satisfy
 * the RELEASE_GATE scenario, structurally.
 */
export const DOGFOOD_TARGET_KINDS = ['REAL_REPOSITORY', 'FIXTURE'] as const;
export type DogfoodTargetKind = (typeof DOGFOOD_TARGET_KINDS)[number];

// ---------------------------------------------------------------------------
// State invariants
// ---------------------------------------------------------------------------

/**
 * The durable-state invariants audited at qualification checkpoints, before
 * and after every restart and every injected fault.
 *
 * Each id names a property of persisted state that must hold AT REST. They
 * are deliberately about state rather than behaviour: behaviour is covered
 * by scenarios, and an invariant that needed the runtime running could not
 * be checked after a crash, which is exactly when it matters most.
 */
export const STATE_INVARIANT_IDS = [
  /** No attempt is RUNNING unless the job is genuinely mid-dispatch. */
  'ATTEMPT_OWNERSHIP_COHERENT',
  /** Every COMPLETED node has a durable trusted-evidence reference. */
  'COMPLETED_TASK_HAS_EVIDENCE',
  /** Every COMPLETED node has a recorded evaluation verdict. */
  'COMPLETED_TASK_HAS_EVALUATION',
  /** Reserved, committed, and released API budget sum coherently. */
  'API_BUDGET_RECONCILES',
  /** No API-lane attempt exists without a recorded spend authority. */
  'NO_API_SPEND_WITHOUT_AUTHORITY',
  /** Every LOCAL-lane attempt records verified local compute locality. */
  'LOCAL_ATTEMPTS_VERIFIED_LOCAL',
  /** Every recovery decision references an attempt that exists. */
  'RECOVERY_REFERENCES_REAL_ATTEMPTS',
  /** Checkpoint sequence numbers are dense, increasing, and attributed. */
  'CHECKPOINT_LINEAGE_VALID',
  /** No node ran while a required predecessor was unverified. */
  'DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS',
  /** Every attempt references a node present in some graph revision. */
  'ATTEMPTS_REFERENCE_KNOWN_NODES',
  /** The job's graph revision pointer resolves to a persisted revision. */
  'GRAPH_REVISION_RESOLVES',
] as const;
export type StateInvariantId = (typeof STATE_INVARIANT_IDS)[number];

/**
 * Invariants whose violation is a canonical-state or governance defect
 * rather than a tolerable inconsistency. A violation of any of these maps
 * directly onto a release blocker.
 */
export const BLOCKING_STATE_INVARIANTS: readonly StateInvariantId[] = [
  'COMPLETED_TASK_HAS_EVIDENCE',
  'COMPLETED_TASK_HAS_EVALUATION',
  'API_BUDGET_RECONCILES',
  'NO_API_SPEND_WITHOUT_AUTHORITY',
  'LOCAL_ATTEMPTS_VERIFIED_LOCAL',
  'DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS',
  'GRAPH_REVISION_RESOLVES',
];

/** Where in a run an invariant audit was taken. */
export const INVARIANT_AUDIT_PHASES = [
  'BASELINE',
  'CHECKPOINT',
  'BEFORE_RESTART',
  'AFTER_RESTART',
  'AFTER_FAULT',
  'FINAL',
] as const;
export type InvariantAuditPhase = (typeof INVARIANT_AUDIT_PHASES)[number];

// ---------------------------------------------------------------------------
// Dogfood defects
// ---------------------------------------------------------------------------

/**
 * Where a dogfood failure actually came from.
 *
 * "The model failed" is not a member, and that is the point: every failure
 * has to be attributed to a layer that can be fixed, and a catch-all would
 * absorb exactly the runtime defects this phase exists to find.
 */
export const DEFECT_SOURCES = [
  /** The implementation the intelligence produced was wrong. */
  'MODEL_IMPLEMENTATION',
  /** SpecBridge lost, corrupted, or mis-transitioned durable state. */
  'RUNTIME_STATE',
  /** A scheduler or authorization rule was applied incorrectly. */
  'POLICY',
  /** Retrieval omitted something the task provably required. */
  'CONTEXT_RETRIEVAL',
  /** A provider, harness, or worker process broke. */
  'INFRASTRUCTURE',
  /** The verification/evaluation machinery itself was unavailable or wrong. */
  'EVALUATION_INFRASTRUCTURE',
  /** The dogfood configuration or environment was wrong. */
  'CONFIGURATION',
] as const;
export type DefectSource = (typeof DEFECT_SOURCES)[number];
