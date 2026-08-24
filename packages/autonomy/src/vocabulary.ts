/**
 * The stable vocabulary of the Overnight Autonomous Product Runtime
 * (vNext.10).
 *
 * Closed string enums with the same rules as every other SpecBridge
 * vocabulary: members are APPENDED, never removed, renumbered, or
 * repurposed, so persisted autonomy records stay readable across upgrades.
 * Everything here is snapshotted into `contracts/autonomy-contract.json`.
 *
 * The organising idea of this phase, stated once:
 *
 *   Earlier phases made a long-horizon run SURVIVE.
 *   This one makes it NOT NEED A PERSON.
 *
 * Which is a different problem, and it fails in a specific way. A runtime
 * that cannot recover stops honestly. A runtime that recovers but keeps
 * ASKING is worse than useless overnight: the human is asleep, so a question
 * costs eight hours whether it was a good question or not. So the vocabulary
 * below is built around one distinction, repeated in every enum that touches
 * it:
 *
 *   HIGH COMPLEXITY          use stronger intelligence
 *   AUTHORITY BOUNDARY       wake the human
 *
 * There is no enum member anywhere in this file that lets difficulty,
 * risk, diff size, architectural weight, or a pile of failed attempts turn
 * into a human gate. That is not an oversight; it is the specification.
 *
 * Nothing here can be set from spec text, plan text, model output, agent
 * proposals, or repository content.
 */

// ---------------------------------------------------------------------------
// Intent seal
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one MissionSeal.
 *
 * A seal is the durable record that a human authorized a complete product
 * intent and delegated the engineering inside it. It exists so the answer to
 * "may the runtime decide this?" is a stored fact with provenance, not a
 * vibe recovered from a conversation nobody kept.
 *
 * `SUPERSEDED` rather than "edited": a seal is never mutated. Changing what
 * was authorized produces a NEW seal that names its predecessor, so an
 * execution can always say which authorization it ran under.
 */
export const SEAL_STATUSES = [
  /** Drafted from mission state; not yet authorized by a human. */
  'DRAFT',
  /** A human authorized it. The only status delegated execution may use. */
  'SEALED',
  /** A later seal replaced it. Historical, still readable, never executable. */
  'SUPERSEDED',
  /** Explicitly withdrawn by a human. Delegated execution stops immediately. */
  'REVOKED',
] as const;
export type SealStatus = (typeof SEAL_STATUSES)[number];

export const FINAL_SEAL_STATUSES: readonly SealStatus[] = ['SUPERSEDED', 'REVOKED'];

export function isFinalSealStatus(status: SealStatus): boolean {
  return FINAL_SEAL_STATUSES.includes(status);
}

/**
 * The classes of canonical product authority a seal captures.
 *
 * These are the things a human decided and an agent may not re-decide.
 * Derived engineering artifacts (a requirements markdown file, a design
 * document, a task list) are deliberately NOT members: they are COMPILED
 * from these, and re-approving a compilation of already-approved authority
 * is exactly the repeated-approval friction this phase removes.
 */
export const SEALED_AUTHORITY_KINDS = [
  /** The product goal, verbatim. */
  'GOAL',
  /** What the product explicitly will not do. */
  'NON_GOALS',
  /** Recorded human decisions with provenance. */
  'DECISIONS',
  /** Constitution rules: the invariants the product is built under. */
  'CONSTITUTION',
  /** Architecture decision records. */
  'ADRS',
  /** Product engineering contracts and their revisions. */
  'CONTRACTS',
  /** Individual requirements inside those contracts. */
  'REQUIREMENTS',
  /** How the product is judged done. */
  'ACCEPTANCE_CRITERIA',
  /** The spending ceiling and resource policy the run may consume. */
  'RESOURCE_POLICY',
  /** The autonomy/delegation policy in force at seal time. */
  'AUTONOMY_POLICY',
] as const;
export type SealedAuthorityKind = (typeof SEALED_AUTHORITY_KINDS)[number];

/**
 * Authority kinds a seal MUST carry to support unattended execution.
 *
 * A seal without acceptance criteria cannot close; a seal without contracts
 * has nothing for the closure oracle to audit; a seal without an autonomy
 * policy has not actually delegated anything. Missing any of these is a
 * preflight failure the human can fix in the evening, which is the entire
 * point of doing it before they go to bed.
 */
export const REQUIRED_SEAL_AUTHORITY_KINDS: readonly SealedAuthorityKind[] = [
  'GOAL',
  'CONTRACTS',
  'REQUIREMENTS',
  'ACCEPTANCE_CRITERIA',
  'AUTONOMY_POLICY',
];

// ---------------------------------------------------------------------------
// Authority firewall
// ---------------------------------------------------------------------------

/**
 * The kinds of decision an autonomous run actually faces, classified by
 * WHOSE decision it is rather than by how hard it is.
 *
 * The list is long on purpose. Every member that looks obviously
 * engineering-shaped is here because the previous dogfood stopped for a
 * human on it at least once, and naming it is what makes the firewall
 * answer "yours, not mine" without a model being asked to be brave.
 */
export const AUTONOMOUS_DECISION_SURFACES = [
  // --- Delegated engineering. The runtime decides. -------------------------
  'implementation-structure',
  'internal-architecture',
  'module-layout',
  'algorithm-choice',
  'internal-api-shape',
  'ui-framework',
  'styling-strategy',
  'state-management',
  'new-feature-rest-shape',
  'database-physical-layout',
  'dependency-choice',
  'build-tooling',
  'testing-tooling',
  'browser-tooling',
  'container-topology',
  'broker-topology',
  'local-script',
  'test-harness',
  'refactor',
  'debug-instrumentation',
  'benchmark-infrastructure',
  'work-decomposition',
  'implementation-plan',
  'recovery-strategy',
  'environment-provisioning',
  'toolchain-provisioning',
  'context-strategy',
  'provider-placement',
  // --- Authority. The human decides. ---------------------------------------
  'sealed-contract-change',
  'product-semantics-change',
  'wire-protocol-change',
  'persistence-compatibility-change',
  'security-boundary-expansion',
  'sealed-requirement-conflict',
  'contract-change-request',
  'human-only-credential',
  'external-irreversible-action',
  'spend-beyond-ceiling',
  'scope-beyond-seal',
] as const;
export type AutonomousDecisionSurface = (typeof AUTONOMOUS_DECISION_SURFACES)[number];

/**
 * The verdict of the authority firewall for one decision.
 *
 * `ESCALATE_INTELLIGENCE` is the member that carries the whole thesis: a
 * decision that is hard is answered with a better reasoner, not with a
 * question. It is a routing instruction to the existing scheduler, and it
 * consumes no human time at all.
 */
export const AUTHORITY_VERDICTS = [
  /** The runtime decides and proceeds. No gate of any kind. */
  'AUTONOMOUS',
  /** The runtime decides, but with stronger intelligence than it has now. */
  'ESCALATE_INTELLIGENCE',
  /** Only a human may decide. The job stops in NEEDS_AUTHORITY. */
  'NEEDS_AUTHORITY',
] as const;
export type AuthorityVerdict = (typeof AUTHORITY_VERDICTS)[number];

/**
 * Why the firewall reached its verdict.
 *
 * Every reason names a STRUCTURAL fact, never a judgment: which sealed
 * artifact was touched, which policy switch is off, which ceiling was
 * crossed. A reason a model could argue with would make the firewall
 * negotiable, which is the one thing it must not be.
 */
export const AUTHORITY_REASONS = [
  /** The sealed intent already contains the answer. */
  'WITHIN_SEALED_INTENT',
  /** Ordinary engineering latitude the autonomy policy delegates. */
  'DELEGATED_BY_POLICY',
  /** Hard for the CURRENT worker; a stronger tier is available. */
  'REQUIRES_STRONGER_INTELLIGENCE',
  /** The autonomy policy leaves this surface with the human. */
  'POLICY_RESERVES_TO_HUMAN',
  /** Would modify an active, sealed product contract. */
  'MODIFIES_SEALED_CONTRACT',
  /** Would change externally observable product semantics. */
  'CHANGES_PRODUCT_SEMANTICS',
  /** Would change a wire/protocol promise. */
  'CHANGES_WIRE_CONTRACT',
  /** Would break a persistence compatibility promise. */
  'CHANGES_PERSISTENCE_COMPATIBILITY',
  /** Would widen a security boundary. */
  'EXPANDS_SECURITY_BOUNDARY',
  /** Two sealed requirements genuinely contradict each other. */
  'SEALED_REQUIREMENTS_CONFLICT',
  /** The work is outside anything the seal authorized. */
  'OUTSIDE_SEALED_SCOPE',
  /** Needs a credential or account action only a person can perform. */
  'REQUIRES_HUMAN_CREDENTIAL',
  /** Would take an irreversible action outside the workspace. */
  'IRREVERSIBLE_EXTERNAL_EFFECT',
  /** Would spend past the authorized monetary ceiling. */
  'EXCEEDS_AUTHORIZED_SPEND',
  /** No seal is bound; delegated authority does not exist for this job. */
  'NO_SEAL_BOUND',
  /** The bound seal is no longer executable (superseded or revoked). */
  'SEAL_NOT_EXECUTABLE',
  /** The autonomy policy changed materially since the seal was made. */
  'AUTONOMY_POLICY_DRIFT',
] as const;
export type AuthorityReason = (typeof AUTHORITY_REASONS)[number];

/**
 * Signals the firewall explicitly REFUSES to treat as human gates.
 *
 * This enum exists to be asserted against. A negative list is unusual, and
 * it earns its place: the failure mode being prevented is subtle drift, in
 * which a plausible-sounding "this looks risky, better ask" creeps back into
 * a code path months later. A test can enumerate this list and prove no
 * member of it can ever produce `NEEDS_AUTHORITY`.
 */
export const NON_AUTHORITY_SIGNALS = [
  'HIGH_COMPLEXITY',
  'LARGE_DIFF',
  'ARCHITECTURE_HEAVY',
  'REPEATED_FAILURE',
  'RISKY_PLAN',
  'LOW_MODEL_CONFIDENCE',
  'UNFAMILIAR_TECHNOLOGY',
  'LONG_RUNNING',
  'MANY_FILES_TOUCHED',
  'NEW_DEPENDENCY',
] as const;
export type NonAuthoritySignal = (typeof NON_AUTHORITY_SIGNALS)[number];

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/** Lifecycle of one supervised job registration. */
export const SUPERVISION_STATUSES = [
  /** Registered for supervision; no driver has been started yet. */
  'REGISTERED',
  /** A driver holds a live lease and is executing. */
  'ACTIVE',
  /** Waiting on a resource, a backoff, or a scheduled wake time. */
  'SLEEPING',
  /** The previous driver died; a replacement is being started. */
  'RESTARTING',
  /** Final: the job reached a terminal status. */
  'RELEASED',
] as const;
export type SupervisionStatus = (typeof SUPERVISION_STATUSES)[number];

/**
 * Why the supervisor acted.
 *
 * Every member is an OBSERVATION about the world, so the supervisor's
 * behaviour can be replayed from its own log without re-running anything.
 */
export const SUPERVISION_ACTIONS = [
  'LEASE_ACQUIRED',
  'LEASE_RENEWED',
  'LEASE_EXPIRED_RECLAIMED',
  'DRIVER_STARTED',
  'DRIVER_EXITED_CLEANLY',
  'DRIVER_DIED',
  'DRIVER_RESTARTED',
  'ATTEMPT_RECONCILED',
  'WAKE_SCHEDULED',
  'WOKEN_ON_SCHEDULE',
  'WOKEN_ON_RESOURCE_RETURN',
  'PROVIDER_HEALTH_RECHECKED',
  'LOCAL_RUNTIME_RESTARTED',
  'STALE_PROCESS_REAPED',
  'RESTART_BUDGET_EXHAUSTED',
  'SESSION_BUDGET_REACHED',
  'INDEFINITE_WAIT_CLASSIFIED',
  'RELEASED_ON_TERMINAL_STATUS',
  'RELEASED_ON_AUTHORITY_STOP',
] as const;
export type SupervisionAction = (typeof SUPERVISION_ACTIONS)[number];

/**
 * What a supervised job is waiting FOR, when it is waiting.
 *
 * `UNKNOWN_CAPACITY` and `NO_RECOVERY_IDENTIFIED` are separate members on
 * purpose. The first means "we cannot see when it returns, so we will
 * re-check"; the second means "we looked and there is no path back". Only
 * the second may end a run, and collapsing them would let a runtime give up
 * on a five-hour window because it could not read a clock.
 */
export const RESOURCE_WAIT_KINDS = [
  'SUBSCRIPTION_QUOTA_RESET',
  'PROVIDER_COOLDOWN',
  'PROVIDER_RATE_LIMIT',
  'LOCAL_RUNTIME_RESTART',
  'API_BUDGET_WINDOW',
  'ENVIRONMENT_READINESS',
  'TOOLCHAIN_PROVISIONING',
  'EXTERNAL_SERVICE_OUTAGE',
  'UNKNOWN_CAPACITY',
  'NO_RECOVERY_IDENTIFIED',
] as const;
export type ResourceWaitKind = (typeof RESOURCE_WAIT_KINDS)[number];

/** Wait kinds whose end time is genuinely predictable from durable data. */
export const SCHEDULED_RESOURCE_WAIT_KINDS: readonly ResourceWaitKind[] = [
  'SUBSCRIPTION_QUOTA_RESET',
  'PROVIDER_COOLDOWN',
  'PROVIDER_RATE_LIMIT',
  'API_BUDGET_WINDOW',
];

// ---------------------------------------------------------------------------
// Overnight preflight
// ---------------------------------------------------------------------------

/**
 * The capabilities an unattended run may need. Each maps to exactly one
 * probe, and each probe reports what it OBSERVED rather than what it hopes.
 */
export const PREFLIGHT_CAPABILITIES = [
  'WORKSPACE_WRITABLE',
  'REPOSITORY_CLEAN_ENOUGH',
  'GIT_AVAILABLE',
  'DISK_SPACE',
  'PROTECTED_PATHS_CONFIGURED',
  'SEAL_PRESENT',
  'SEAL_COMPLETE',
  'AUTONOMY_POLICY_COMPLETE',
  'SUPERVISOR_CAPABLE',
  'STRONG_WORKER_AVAILABLE',
  'LOCAL_MODEL_STARTABLE',
  'API_FALLBACK_AUTHORIZED',
  'SPEND_CEILING_DECLARED',
  'TRUSTED_VERIFICATION_CONFIGURED',
  'PACKAGE_MANAGER_AVAILABLE',
  'PACKAGE_REGISTRY_REACHABLE',
  'BUILD_TOOLCHAIN_AVAILABLE',
  'CONTAINER_RUNTIME',
  'CONTAINER_COMPOSE',
  'BROWSER_RUNTIME',
  'TOOLSMITH_POLICY_SUFFICIENT',
  'ENVIRONMENT_POLICY_SUFFICIENT',
  'KNOWN_CREDENTIALS_PRESENT',
  'CONTROL_PLANE_REPAIR_CONFIGURED',
] as const;
export type PreflightCapability = (typeof PREFLIGHT_CAPABILITIES)[number];

/**
 * The outcome of one capability probe.
 *
 * `SATISFIABLE_AUTONOMOUSLY` is the member that decides whether an operator
 * has to do anything tonight. A missing browser runtime that the Toolsmith
 * is permitted to install is NOT a blocker: it is work. Reporting it as a
 * blocker would train an operator to ignore preflight output, and reporting
 * it as READY would be a lie about what has been verified.
 */
export const PREFLIGHT_OUTCOMES = [
  /** Observed present and usable right now. */
  'READY',
  /** Absent now, and the runtime is authorized and able to provide it. */
  'SATISFIABLE_AUTONOMOUSLY',
  /** Absent, and only a human can supply it. Blocks an unattended launch. */
  'HUMAN_REQUIRED',
  /** Not needed for this mission's declared surfaces. */
  'NOT_APPLICABLE',
  /** The probe itself could not reach a conclusion. Never a pass. */
  'UNKNOWN',
] as const;
export type PreflightOutcome = (typeof PREFLIGHT_OUTCOMES)[number];

/** The overall verdict of an overnight preflight. */
export const PREFLIGHT_VERDICTS = [
  /** Every required capability is READY or autonomously satisfiable. */
  'OVERNIGHT_READY',
  /** At least one capability needs a person before launch. */
  'HUMAN_ACTION_REQUIRED',
  /** A probe could not decide something required. Never launch on this. */
  'INDETERMINATE',
] as const;
export type PreflightVerdict = (typeof PREFLIGHT_VERDICTS)[number];

// ---------------------------------------------------------------------------
// Toolsmith
// ---------------------------------------------------------------------------

/** Lifecycle of one Toolsmith capability request. */
export const TOOLSMITH_REQUEST_STATUSES = [
  'REQUESTED',
  'GRANTED',
  'DENIED',
  'APPLIED',
  'FAILED',
] as const;
export type ToolsmithRequestStatus = (typeof TOOLSMITH_REQUEST_STATUSES)[number];

/**
 * Why the broker denied a Toolsmith request.
 *
 * `WOULD_CREATE_AUTHORITY` is the important one and the reason the broker
 * exists at all: agents may create TOOLS, never AUTHORITY. A request to add
 * a verification command, widen a protected path, or edit the autonomy
 * policy is a request to change what SpecBridge is allowed to do, dressed as
 * a request to install something.
 */
export const TOOLSMITH_DENIAL_REASONS = [
  'CAPABILITY_NOT_ENABLED',
  'TOOLSMITH_DISABLED',
  'GRANT_BUDGET_EXHAUSTED',
  'TARGET_OUTSIDE_WORKSPACE',
  'TARGET_PROTECTED_PATH',
  'REGISTRY_NOT_ALLOWED',
  'REQUIRES_ADMIN_PRIVILEGE',
  'WOULD_CREATE_AUTHORITY',
  'DOWNLOAD_TOO_LARGE',
  'PORTABLE_ALTERNATIVE_REQUIRED',
] as const;
export type ToolsmithDenialReason = (typeof TOOLSMITH_DENIAL_REASONS)[number];

/**
 * Where a provisioned tool lives, in the order the broker prefers.
 *
 * The order is the policy: project-local beats portable beats containerized
 * beats user-local, and MACHINE_GLOBAL has no member at all. A tool that
 * genuinely requires administrator rights is an authority question, not an
 * engineering one, and it leaves through the firewall rather than through
 * this enum.
 */
export const TOOL_INSTALL_SCOPES = [
  'PROJECT_LOCAL',
  'PORTABLE',
  'CONTAINERIZED',
  'USER_LOCAL',
] as const;
export type ToolInstallScope = (typeof TOOL_INSTALL_SCOPES)[number];

// ---------------------------------------------------------------------------
// Environment lifecycle
// ---------------------------------------------------------------------------

/** Kinds of service an EnvironmentPlan can describe. */
export const SERVICE_KINDS = [
  'CONTAINER',
  'COMPOSE_PROJECT',
  'PROCESS',
  'DATABASE',
  'MESSAGE_BROKER',
  'CACHE',
  'APPLICATION_SERVER',
  'FRONTEND_SERVER',
  'WORKER',
] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/**
 * How a service's readiness is decided.
 *
 * `PROCESS_ALIVE` is present and deliberately weak: it exists so a plan can
 * SAY it is only checking liveness, and so the environment report can mark
 * that evidence as shallow. A readiness model with no weak option would push
 * authors to lie with a strong one.
 */
export const READINESS_PROBE_KINDS = [
  /** The process/container exists and has not exited. Weakest evidence. */
  'PROCESS_ALIVE',
  /** A TCP connection is accepted. */
  'TCP_CONNECT',
  /** An HTTP request returns an expected status. */
  'HTTP_STATUS',
  /** An HTTP body matches an expected pattern. */
  'HTTP_BODY',
  /** A command exits zero inside or against the service. */
  'COMMAND_EXIT',
  /** A protocol-level handshake succeeded (SQL ping, broker metadata, …). */
  'PROTOCOL_HANDSHAKE',
  /** The container runtime reports its own healthcheck as healthy. */
  'CONTAINER_HEALTHCHECK',
] as const;
export type ReadinessProbeKind = (typeof READINESS_PROBE_KINDS)[number];

/** Probes that prove the service is answering its actual protocol. */
export const APPLICATION_LEVEL_PROBES: readonly ReadinessProbeKind[] = [
  'HTTP_STATUS',
  'HTTP_BODY',
  'COMMAND_EXIT',
  'PROTOCOL_HANDSHAKE',
  'CONTAINER_HEALTHCHECK',
];

/** Lifecycle of one EnvironmentInstance. */
export const ENVIRONMENT_STATUSES = [
  'PLANNED',
  'PROVISIONING',
  'WAITING_READY',
  'READY',
  'DEGRADED',
  'REPAIRING',
  'FAILED',
  'STOPPED',
] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export const FINAL_ENVIRONMENT_STATUSES: readonly EnvironmentStatus[] = ['FAILED', 'STOPPED'];

/** Per-service state inside an instance. */
export const SERVICE_STATUSES = [
  'PENDING',
  'STARTING',
  'WAITING_READY',
  'READY',
  'UNHEALTHY',
  'RESTARTING',
  'FAILED',
  'STOPPED',
] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** Why an environment failed, named so a repair can be chosen. */
export const ENVIRONMENT_FAILURE_KINDS = [
  'RUNTIME_UNAVAILABLE',
  'IMAGE_PULL_FAILED',
  'PORT_CONFLICT',
  'READINESS_TIMEOUT',
  'SERVICE_CRASHED',
  'DEPENDENCY_UNREADY',
  'CONFIGURATION_INVALID',
  'RESOURCE_EXHAUSTED',
  'UNKNOWN',
] as const;
export type EnvironmentFailureKind = (typeof ENVIRONMENT_FAILURE_KINDS)[number];

// ---------------------------------------------------------------------------
// Browser verification
// ---------------------------------------------------------------------------

/** The interaction steps a browser scenario can be built from. */
export const BROWSER_STEP_KINDS = [
  'NAVIGATE',
  'CLICK',
  'TYPE',
  'FILL_FORM',
  'SUBMIT',
  'WAIT_FOR_SELECTOR',
  'WAIT_FOR_TEXT',
  'EXPECT_SELECTOR',
  'EXPECT_TEXT',
  'EXPECT_ABSENT',
  'EXPECT_URL',
  'EXPECT_NO_CONSOLE_ERRORS',
  'EXPECT_NO_FAILED_REQUESTS',
  'SCREENSHOT',
  'SET_VIEWPORT',
  'RELOAD',
  'SWITCH_CONTEXT',
] as const;
export type BrowserStepKind = (typeof BROWSER_STEP_KINDS)[number];

/** Steps that ASSERT rather than act. Only these can fail a scenario. */
export const BROWSER_ASSERTION_STEPS: readonly BrowserStepKind[] = [
  'EXPECT_SELECTOR',
  'EXPECT_TEXT',
  'EXPECT_ABSENT',
  'EXPECT_URL',
  'EXPECT_NO_CONSOLE_ERRORS',
  'EXPECT_NO_FAILED_REQUESTS',
];

/** Outcome of one browser scenario. */
export const BROWSER_SCENARIO_STATUSES = [
  'PASSED',
  'FAILED',
  'ERRORED',
  'SKIPPED_NO_RUNTIME',
  'NOT_RUN',
] as const;
export type BrowserScenarioStatus = (typeof BROWSER_SCENARIO_STATUSES)[number];

/** Classes of browser evidence retained durably. */
export const BROWSER_EVIDENCE_KINDS = [
  'SCREENSHOT',
  'DOM_SNAPSHOT',
  'CONSOLE_LOG',
  'NETWORK_FAILURES',
  'STEP_TRACE',
  'VIEWPORT_MATRIX',
] as const;
export type BrowserEvidenceKind = (typeof BROWSER_EVIDENCE_KINDS)[number];

// ---------------------------------------------------------------------------
// UX critic
// ---------------------------------------------------------------------------

/** What a UX critic finding is about. */
export const UX_FINDING_KINDS = [
  'OVERLAPPING_ELEMENTS',
  'CLIPPED_CONTENT',
  'UNREADABLE_LAYOUT',
  'BROKEN_RESPONSIVE',
  'DEAD_INTERACTION',
  'MISSING_LOADING_STATE',
  'MISSING_ERROR_STATE',
  'MISSING_EMPTY_STATE',
  'INCONSISTENT_UX',
  'UNUSABLE_CONTROL',
  'VISUAL_REGRESSION',
  'AESTHETIC_PREFERENCE',
] as const;
export type UxFindingKind = (typeof UX_FINDING_KINDS)[number];

/**
 * How much a finding matters.
 *
 * Only `MATERIAL` can create work, and `AESTHETIC_PREFERENCE` findings are
 * forced to `COSMETIC` by the service whatever severity the critic claimed.
 * That single rule is what keeps a subjective reviewer from becoming an
 * unbounded repair loop at 3am.
 */
export const UX_FINDING_SEVERITIES = ['MATERIAL', 'MINOR', 'COSMETIC'] as const;
export type UxFindingSeverity = (typeof UX_FINDING_SEVERITIES)[number];

/**
 * The critic's verdict on one scenario's UI.
 *
 * There is no `PASS`. The strongest thing a critic may say is
 * `NO_MATERIAL_FINDINGS`, which asserts the absence of problems it looked
 * for and nothing about whether the product works. Naming it `PASS` would
 * eventually let someone read it as evidence, and it is not evidence.
 */
export const UX_CRITIQUE_VERDICTS = [
  'NO_MATERIAL_FINDINGS',
  'MATERIAL_FINDINGS',
  'NOT_RUN',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type UxCritiqueVerdict = (typeof UX_CRITIQUE_VERDICTS)[number];

// ---------------------------------------------------------------------------
// Contract closure
// ---------------------------------------------------------------------------

/**
 * Closure state of ONE sealed requirement, invariant, or acceptance
 * criterion.
 *
 * The taxonomy is the whole vNext.10 completion guarantee. The previous
 * dogfood declared a product complete with seven approved requirements
 * unimplemented, and it did so because "the task list is finished" and "the
 * contract is satisfied" were the same fact in the runtime. Here they cannot
 * be: `IMPLEMENTED` and `VERIFIED` are different members, and only the
 * second one closes anything.
 */
export const CLOSURE_STATUSES = [
  /** Nothing claims to implement this item. */
  'NOT_STARTED',
  /** Work exists and is in flight. */
  'IN_PROGRESS',
  /** Implementation exists and is attributed, but nothing has proven it. */
  'IMPLEMENTED',
  /** Trusted evidence demonstrates the item holds. The only closing state. */
  'VERIFIED',
  /** A human explicitly waived it, with a recorded reason. */
  'WAIVED',
  /** Explicitly out of scope for this seal, by recorded decision. */
  'NOT_APPLICABLE',
] as const;
export type ClosureStatus = (typeof CLOSURE_STATUSES)[number];

/** Statuses that satisfy the closure oracle. */
export const CLOSING_STATUSES: readonly ClosureStatus[] = ['VERIFIED', 'WAIVED', 'NOT_APPLICABLE'];

export function isClosingStatus(status: ClosureStatus): boolean {
  return CLOSING_STATUSES.includes(status);
}

/**
 * What kind of evidence closed a contract item.
 *
 * `AGENT_ASSERTION` is deliberately a member AND deliberately excluded from
 * `CLOSING_EVIDENCE_KINDS`. It exists so an audit can record that an agent
 * claimed something, and show that the claim closed nothing.
 */
export const CLOSURE_EVIDENCE_KINDS = [
  'TRUSTED_VERIFICATION',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'SYSTEM_SCENARIO',
  'BROWSER_SCENARIO',
  'ACCEPTANCE_CRITERION_CHECK',
  'REPRODUCIBILITY_RUN',
  'HUMAN_WAIVER',
  'AGENT_ASSERTION',
] as const;
export type ClosureEvidenceKind = (typeof CLOSURE_EVIDENCE_KINDS)[number];

/** Evidence kinds that may move an item to VERIFIED. */
export const CLOSING_EVIDENCE_KINDS: readonly ClosureEvidenceKind[] = [
  'TRUSTED_VERIFICATION',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'SYSTEM_SCENARIO',
  'BROWSER_SCENARIO',
  'ACCEPTANCE_CRITERION_CHECK',
  'REPRODUCIBILITY_RUN',
];

export function isClosingEvidence(kind: ClosureEvidenceKind): boolean {
  return CLOSING_EVIDENCE_KINDS.includes(kind);
}

/** The phases of the automatic gap-closure lifecycle, in order. */
export const CLOSURE_PHASES = [
  'IMPLEMENTATION',
  'CONTRACT_CLOSURE_AUDIT',
  'GAP_IMPLEMENTATION',
  'SYSTEM_SCENARIO_QUALIFICATION',
  'RELEASE_QUALIFICATION',
  'REPRODUCIBILITY',
  'FINAL_CONTRACT_AUDIT',
  'COMPLETE',
] as const;
export type ClosurePhase = (typeof CLOSURE_PHASES)[number];

/** What the closure oracle decided the runtime should do next. */
export const CLOSURE_DIRECTIVES = [
  /** Keep implementing planned work; closure is not in scope yet. */
  'CONTINUE_IMPLEMENTATION',
  /** Generate work for the named unclosed items. */
  'GENERATE_GAP_WORK',
  /** Run mission-level system acceptance scenarios. */
  'RUN_SYSTEM_SCENARIOS',
  /** Run the release qualification. */
  'RUN_RELEASE_QUALIFICATION',
  /** Run the clean-environment reproducibility qualification. */
  'RUN_REPRODUCIBILITY',
  /** Every sealed item closed on trusted evidence. COMPLETED is available. */
  'COMPLETE',
  /** Closure cannot be reached inside the remaining budget. */
  'BUDGET_EXHAUSTED',
  /** Closure requires product authority. */
  'NEEDS_AUTHORITY',
] as const;
export type ClosureDirective = (typeof CLOSURE_DIRECTIVES)[number];

/** Why a contract item could not be closed. */
export const CLOSURE_GAP_KINDS = [
  'NO_IMPLEMENTATION',
  'NO_EVIDENCE',
  'EVIDENCE_FAILED',
  'EVIDENCE_STALE',
  'EVIDENCE_UNTRUSTED',
  'SCENARIO_MISSING',
  'SCENARIO_FAILED',
  'CRITIC_MATERIAL_FINDING',
  'REPRODUCIBILITY_FAILED',
] as const;
export type ClosureGapKind = (typeof CLOSURE_GAP_KINDS)[number];

// ---------------------------------------------------------------------------
// Control-plane self-repair
// ---------------------------------------------------------------------------

/** Classes of control-plane defect a product job can legitimately detect. */
export const CONTROL_PLANE_DEFECT_KINDS = [
  'RUNNER_CONTRACT_MISMATCH',
  'RUNNER_OUTPUT_PARSE_FAILURE',
  'PROVIDER_CLI_INCOMPATIBILITY',
  'STATE_MACHINE_DEADLOCK',
  'SCHEDULER_STARVATION',
  'DURABLE_STATE_SCHEMA_REJECTION',
  'EVIDENCE_PIPELINE_FAILURE',
  'CONTEXT_ASSEMBLY_FAILURE',
] as const;
export type ControlPlaneDefectKind = (typeof CONTROL_PLANE_DEFECT_KINDS)[number];

/** Stages of one governed control-plane repair, in order. */
export const CONTROL_PLANE_REPAIR_STAGES = [
  'DETECTED',
  'PRODUCT_JOB_CHECKPOINTED',
  'ISOLATED',
  'DIAGNOSED',
  'PATCHED',
  'REGRESSION_TEST_ADDED',
  'FOCUSED_TESTS_PASSED',
  'FULL_QUALIFICATION_PASSED',
  'ARTIFACT_REBUILT',
  'ARTIFACT_VERIFIED',
  'CANARY_PASSED',
  'ACTIVATED',
  'PRODUCT_JOB_RESUMED',
] as const;
export type ControlPlaneRepairStage = (typeof CONTROL_PLANE_REPAIR_STAGES)[number];

/** Outcome of one governed control-plane repair. */
export const CONTROL_PLANE_REPAIR_STATUSES = [
  'IN_PROGRESS',
  'SUCCEEDED',
  'ABANDONED',
  'REJECTED_WEAKENS_INVARIANT',
  'FAILED_QUALIFICATION',
  'FAILED_CANARY',
] as const;
export type ControlPlaneRepairStatus = (typeof CONTROL_PLANE_REPAIR_STATUSES)[number];

/**
 * Invariant classes a control-plane repair may never weaken to make its own
 * failing product task pass.
 *
 * A repair that touches any of these is REJECTED, not reviewed. The list is
 * short because it is meant to be memorable and enforced mechanically, and
 * every member is something a sufficiently frustrated agent would otherwise
 * find attractive at 4am.
 */
export const PROTECTED_CONTROL_PLANE_INVARIANTS = [
  'PERMISSION_BYPASS',
  'PROTECTED_PATH_ENFORCEMENT',
  'VERIFICATION_AUTHORITY',
  'APPROVAL_AUTHORITY',
  'SPEND_AUTHORIZATION',
  'EVIDENCE_REQUIREMENT',
  'AUTHORITY_FIREWALL',
  'COMPLETION_ORACLE',
] as const;
export type ProtectedControlPlaneInvariant = (typeof PROTECTED_CONTROL_PLANE_INVARIANTS)[number];

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Autonomy counters.
 *
 * Named as an enum so the report, the certification, and the CLI cannot
 * drift on what is being counted. `humanInterventionsAfterSeal` is the
 * product metric; everything else is context for it.
 */
export const AUTONOMY_COUNTERS = [
  'humanInterventionsAfterSeal',
  'humanAuthorityEscalations',
  'autonomousRecoveryCount',
  'providerFailovers',
  'providerFailures',
  'quotaWaits',
  'contextRollovers',
  'toolsmithActions',
  'selfCreatedTools',
  'toolchainRepairs',
  'environmentRepairs',
  'controlPlaneRepairs',
  'gapClosureCycles',
  'systemQualificationCycles',
  'browserScenariosRun',
  'uxCritiquesRun',
  'driverRestarts',
  'supervisorWakeups',
] as const;
export type AutonomyCounter = (typeof AUTONOMY_COUNTERS)[number];

/**
 * Measurements that are UNKNOWN when nothing reported them.
 *
 * These are stored as `number | null` and rendered as "n/a", never as 0. A
 * provider that reports no cost has not reported a cost of zero, and an
 * autonomy report that printed "$0.00" would be inventing a fact about
 * money.
 */
export const AUTONOMY_MEASUREMENTS = [
  'elapsedWallTimeMs',
  'reportedTokens',
  'reportedCostUsd',
  'contractClosureRatio',
] as const;
export type AutonomyMeasurement = (typeof AUTONOMY_MEASUREMENTS)[number];

// ---------------------------------------------------------------------------
// Zero-touch certification
// ---------------------------------------------------------------------------

/**
 * The fault classes the zero-touch certification injects.
 *
 * Each maps to a required scenario in the certification matrix. They are
 * deliberately vNext.10-specific and do NOT reuse the vNext.9 `FAULT_CLASSES`
 * enum: that one describes faults a long-horizon run must SURVIVE, this one
 * describes faults an unattended run must survive WITHOUT ASKING. The same
 * word would hide the difference that matters.
 */
export const ZERO_TOUCH_FAULTS = [
  'STRONG_PROVIDER_UNAVAILABLE',
  'STRONG_QUOTA_EXHAUSTED',
  'LOCAL_RUNTIME_CRASH',
  'INVALID_STRUCTURED_OUTPUT',
  'CONTEXT_EXHAUSTION',
  'WORKER_PROCESS_TERMINATED',
  'DRIVER_PROCESS_TERMINATED',
  'CONTAINER_SERVICE_CRASH',
  'DELAYED_SERVICE_READINESS',
  'MISSING_PROJECT_DEPENDENCY',
  'MISSING_BROWSER_RUNTIME',
  'FAILING_IMPLEMENTATION_TEST',
  'WRONG_STRATEGY_REQUIRES_REPLAN',
  'TRANSIENT_NETWORK_FAILURE',
  'CONTROL_PLANE_RUNNER_DEFECT',
  'SEALED_CONTRACT_CHANGE_REQUIRED',
] as const;
export type ZeroTouchFault = (typeof ZERO_TOUCH_FAULTS)[number];

/**
 * The expected outcome of one certification scenario.
 *
 * Exactly two are legitimate, and the certification proves BOTH directions:
 * `SELF_RECOVERED` for every engineering-operational fault, and
 * `NEEDS_AUTHORITY` for the one deliberately constructed authority case. A
 * suite that only proved the first would certify a runtime that never asks —
 * including when it should.
 */
export const ZERO_TOUCH_EXPECTATIONS = ['SELF_RECOVERED', 'NEEDS_AUTHORITY'] as const;
export type ZeroTouchExpectation = (typeof ZERO_TOUCH_EXPECTATIONS)[number];

/** The observed outcome of one certification scenario. */
export const ZERO_TOUCH_OUTCOMES = [
  /** The runtime recovered on its own and kept going. */
  'SELF_RECOVERED',
  /** The runtime stopped for authority, correctly. */
  'NEEDS_AUTHORITY',
  /** The runtime asked a human for something it should have handled. */
  'ASKED_HUMAN',
  /** The runtime stopped in a non-recoverable operational state. */
  'STUCK',
  /** The runtime took authority it did not have. The worst outcome. */
  'SELF_AUTHORIZED',
  /** The scenario could not run here, with a recorded reason. */
  'SKIPPED_WITH_REASON',
  'NOT_RUN',
] as const;
export type ZeroTouchOutcome = (typeof ZERO_TOUCH_OUTCOMES)[number];

/** Outcomes that fail the certification whatever else passed. */
export const CERTIFICATION_FAILING_OUTCOMES: readonly ZeroTouchOutcome[] = [
  'ASKED_HUMAN',
  'STUCK',
  'SELF_AUTHORIZED',
];

/** The overall certification verdict. */
export const CERTIFICATION_VERDICTS = ['CERTIFIED', 'NOT_CERTIFIED', 'INCOMPLETE'] as const;
export type CertificationVerdict = (typeof CERTIFICATION_VERDICTS)[number];
