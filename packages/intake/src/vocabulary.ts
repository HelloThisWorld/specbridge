/**
 * The stable vocabulary of Zero-Touch Spec Intake.
 *
 * Every member below is a closed string enum snapshotted into
 * `contracts/intake-contract.json`. Values are additive within 1.x: new
 * members may be appended, existing members never change meaning and are
 * never removed, so a persisted intake record stays readable across
 * upgrades.
 *
 * The organising idea: a Spec Intake is the durable record of how ONE
 * submitted product specification became ONE human authorization to build.
 * Everything before the authorization is discovery — grounded in the
 * repository, converging deterministically, and allowed to ask the human
 * only about product authority. Everything after it is the vNext.10
 * unattended runtime, which asks nobody anything.
 *
 * The line between those two halves is `IntakeApproval`. It is the only
 * human authority event in this package, and the seal, the derived stage
 * approvals, the preflight, and the launch all descend from it.
 */

// ---------------------------------------------------------------------------
// Intake lifecycle
// ---------------------------------------------------------------------------

/**
 * Statuses of one spec intake.
 *
 * `READY_FOR_APPROVAL` is a COMPUTED gate exactly like the mission's
 * `CONTRACT_READY`: convergence.ts decides it from durable evidence, and no
 * caller may assert it. `APPROVED` is the one status a model can never
 * produce — it is written only by the CLI human-authority path.
 */
export const INTAKE_STATUSES = [
  /** The source specification is ingested; discovery has not run. */
  'INGESTED',
  /** Repository-grounded discovery is running or has produced open questions. */
  'DISCOVERING',
  /** One or more blocking PRODUCT questions await the human. */
  'AWAITING_PRODUCT_ANSWERS',
  /** Coverage, delta authority, and question gates are all satisfied. */
  'READY_FOR_APPROVAL',
  /** The human authorized the discovered specification. Build may proceed. */
  'APPROVED',
  /** The seal-and-build lifecycle is running. */
  'BUILDING',
  /** The unattended runtime launched and the job reached a terminal state. */
  'BUILT',
  /** The lifecycle stopped needing a person before the unattended launch. */
  'BLOCKED',
  /** Final: the user abandoned this intake. Never auto-restarted. */
  'ABANDONED',
] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const FINAL_INTAKE_STATUSES: readonly IntakeStatus[] = ['ABANDONED'];

export function isFinalIntakeStatus(status: IntakeStatus): boolean {
  return FINAL_INTAKE_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Source documents
// ---------------------------------------------------------------------------

/** How the submitted specification arrived. Provenance, never authority. */
export const SPEC_SOURCE_KINDS = [
  /** A file on disk, read verbatim and stored verbatim. */
  'file',
  /** Text handed over by a plugin or an MCP client (a paste). */
  'text',
  /** Text read from standard input. */
  'stdin',
] as const;
export type SpecSourceKind = (typeof SPEC_SOURCE_KINDS)[number];

/**
 * What one parsed chunk of the source document is, structurally.
 *
 * The distinction that matters is NORMATIVE vs not: a normative chunk states
 * something the product must do, and coverage reconciliation refuses
 * READY_FOR_APPROVAL while any normative chunk is unaccounted for. A
 * narrative or example chunk is evidence, not a promise, and is never a gate.
 */
export const SOURCE_CHUNK_KINDS = [
  /** A statement of required behavior ("must", "shall", imperative bullet). */
  'normative',
  /** A stated non-goal or explicit exclusion. */
  'non-goal',
  /** An enumerated edge case or scenario the product must cover. */
  'scenario',
  /** An illustrative example, sample payload, or code block. */
  'example',
  /** Framing prose: motivation, background, restatement. */
  'narrative',
  /** A heading with no body of its own. */
  'heading',
  /**
   * An instruction to whoever is WRITING or REVIEWING the specification —
   * "ask a product question during discovery", "raise this with the product
   * owner" — rather than a statement of what the product owes anyone.
   *
   * It is neither normative nor narrative, and the difference is load-
   * bearing: filed as normative it becomes a contract requirement no
   * builder can implement, and filed as narrative under a surface-naming
   * heading it becomes one anyway.
   */
  'process-guidance',
] as const;
export type SourceChunkKind = (typeof SOURCE_CHUNK_KINDS)[number];

/**
 * How one normative chunk was accounted for by discovery.
 *
 * `UNACCOUNTED` is the only value that blocks. It exists so a long
 * specification cannot be quietly half-read: a model summary that dropped
 * section 9 leaves nine `UNACCOUNTED` chunks and the gate refuses.
 */
export const CHUNK_COVERAGE_STATES = [
  /** A canonical fact, requirement, criterion, or non-goal carries it. */
  'CARRIED',
  /** An open product question is what this chunk is waiting on. */
  'QUESTIONED',
  /** Existing repository/product truth already satisfies it. */
  'ALREADY_TRUE',
  /** Explicitly out of scope by a recorded decision. */
  'EXCLUDED',
  /** Nothing accounts for it yet. Blocks READY_FOR_APPROVAL. */
  'UNACCOUNTED',
] as const;
export type ChunkCoverageState = (typeof CHUNK_COVERAGE_STATES)[number];

// ---------------------------------------------------------------------------
// Repository grounding
// ---------------------------------------------------------------------------

/**
 * Kinds of existing product truth discovery reads before it asks anything.
 *
 * The list is the answer to "what does SpecBridge already know?", and every
 * member is durable evidence rather than an inference. A question whose
 * answer is present in any of these is refused by the evidence screen.
 */
export const REPOSITORY_EVIDENCE_KINDS = [
  /** A `.kiro/specs/<name>` folder, approved or not. */
  'EXISTING_SPEC',
  /** A prior Mission record in this workspace. */
  'EXISTING_MISSION',
  /** An active revision of a product contract from a prior mission. */
  'SEALED_CONTRACT',
  /** An active Architecture Constitution rule. */
  'CONSTITUTION_RULE',
  /** An accepted ADR. */
  'ADR',
  /** A prior authorized MissionSeal. */
  'PRIOR_SEAL',
  /** A top-level module, package, or subproject directory. */
  'MODULE',
  /** The detected build system / package manager. */
  'BUILD_SYSTEM',
  /** A detected test surface (test directories, test config). */
  'TEST_SURFACE',
  /** A file that names a public interface (SDK, API, protocol, schema). */
  'PUBLIC_INTERFACE',
  /** A steering / guidance document the workspace already carries. */
  'STEERING',
  /** A prior feature intake recorded in the product baseline lineage. */
  'BASELINE_LINEAGE',
] as const;
export type RepositoryEvidenceKind = (typeof REPOSITORY_EVIDENCE_KINDS)[number];

// ---------------------------------------------------------------------------
// Delta authority
// ---------------------------------------------------------------------------

/**
 * How one discovered requirement relates to authority that already exists.
 *
 * This classification is the heart of vNext.10.1. The failure mode it
 * prevents is treating every public thing a new feature adds as a change to
 * an old promise: a new REST endpoint, a new screen, a new workflow file
 * format for a NEW feature is authorized BY THIS INTENT, and calling it a
 * sealed-contract change would put a human gate in front of ordinary
 * product work. The opposite failure — quietly rewriting a promise the
 * product already made — is what `EXISTING_SEALED_CONTRACT_CHANGE` and
 * `CONTRADICTION` exist to catch.
 */
export const DELTA_AUTHORITY_CLASSES = [
  /**
   * A new public product surface this specification itself authorizes.
   * Creates a NEW contract; touches no existing one.
   */
  'NEW_DELEGATED_SURFACE',
  /** Engineering latitude inside the seal. Creates no contract at all. */
  'IMPLEMENTATION_DETAIL',
  /** An existing contract already promises this; nothing changes. */
  'EXISTING_CONTRACT_COMPATIBLE',
  /**
   * Adds capability to an existing contract without changing the meaning of
   * anything already in it. Legal only under an additive-only or evolving
   * compatibility policy.
   */
  'EXISTING_CONTRACT_EXTENSION',
  /**
   * Would change or remove an existing sealed requirement or invariant, or
   * would extend a FROZEN contract. Human authority, always.
   */
  'EXISTING_SEALED_CONTRACT_CHANGE',
  /** Directly contradicts an active contract, invariant, or constitution rule. */
  'CONTRADICTION',
  /**
   * Could not be classified from durable evidence. Becomes a blocking
   * product question rather than a guess.
   */
  'UNKNOWN_PRODUCT_AUTHORITY',
] as const;
export type DeltaAuthorityClass = (typeof DELTA_AUTHORITY_CLASSES)[number];

/**
 * Classes that require explicit human attention BEFORE the single approval.
 *
 * Deliberately short. Everything else is either delegated engineering or a
 * new surface this intent authorizes, and neither needs a separate gate on
 * top of the one approval.
 */
export const AUTHORITY_SENSITIVE_DELTA_CLASSES: readonly DeltaAuthorityClass[] = [
  'EXISTING_SEALED_CONTRACT_CHANGE',
  'CONTRADICTION',
  'UNKNOWN_PRODUCT_AUTHORITY',
];

export function requiresProductAuthority(value: DeltaAuthorityClass): boolean {
  return AUTHORITY_SENSITIVE_DELTA_CLASSES.includes(value);
}

// ---------------------------------------------------------------------------
// Question discipline
// ---------------------------------------------------------------------------

/**
 * Why a candidate question is genuinely the human's to answer.
 *
 * Every admitted question carries exactly one of these. A candidate that
 * cannot be assigned one is refused — "it would be nice to know" is not a
 * reason to wake somebody up, even before the seal.
 */
export const PRODUCT_QUESTION_KINDS = [
  /** What a promised word actually means ("replay", "compatible", "atomic"). */
  'SEMANTIC_DEFINITION',
  /** How strictly an external format or protocol must be matched. */
  'COMPATIBILITY_LEVEL',
  /** Who may see, store, or transmit a sensitive payload. */
  'DATA_VISIBILITY_POLICY',
  /** Two stated requirements cannot both hold. */
  'REQUIREMENT_CONFLICT',
  /** Whether a stated behavior is a promise or an illustration. */
  'PROMISE_OR_ILLUSTRATION',
  /** Whether an existing sealed promise may change. */
  'SEALED_CONTRACT_CHANGE',
  /** What is explicitly out of scope. */
  'SCOPE_BOUNDARY',
  /** What externally observable behavior a failure produces. */
  'OBSERVABLE_FAILURE_SEMANTICS',
] as const;
export type ProductQuestionKind = (typeof PRODUCT_QUESTION_KINDS)[number];

/**
 * Why a candidate question was REFUSED.
 *
 * Refusals are durable and inspectable. That is the point: a phase whose
 * whole claim is "we only ask product questions" has to be able to show the
 * questions it declined to ask, or the claim is unfalsifiable.
 */
export const QUESTION_REFUSAL_REASONS = [
  /** It asks for an engineering decision the seal delegates. */
  'ENGINEERING_DECISION',
  /** Durable repository or product evidence already answers it. */
  'ANSWERED_BY_EVIDENCE',
  /** The submitted specification already answers it. */
  'ANSWERED_BY_SPECIFICATION',
  /** Every valid answer produces the same product authority. */
  'IMMATERIAL_TO_PRODUCT',
  /** An equivalent question is already open. */
  'DUPLICATE',
  /** It is a request for detail, not a decision. */
  'ELABORATION_NOT_DECISION',
] as const;
export type QuestionRefusalReason = (typeof QUESTION_REFUSAL_REASONS)[number];

/**
 * Engineering surfaces a question may NOT be asked about.
 *
 * The mirror image of `NON_AUTHORITY_SIGNALS` in @specbridge/autonomy, and
 * it exists for the same reason: a negative list can be enumerated by a test
 * that proves no member of it ever reaches the human. Each member maps to a
 * delegated surface in the Authority Firewall.
 */
export const ENGINEERING_QUESTION_SURFACES = [
  'framework-choice',
  'library-choice',
  'build-tool-choice',
  'package-naming',
  'module-decomposition',
  'transport-choice',
  'database-schema',
  'broker-topology',
  'test-framework',
  'test-structure',
  'retry-implementation',
  'tooling-creation',
  'file-layout',
  'code-style',
  'deployment-topology',
] as const;
export type EngineeringQuestionSurface = (typeof ENGINEERING_QUESTION_SURFACES)[number];

// ---------------------------------------------------------------------------
// Approval provenance
// ---------------------------------------------------------------------------

/**
 * How a stage approval got its authority.
 *
 * `HUMAN` is the legacy default and is what an absent field means, so every
 * approval recorded before vNext.10.1 keeps reading exactly as it did.
 * `DERIVED_FROM_INTENT_APPROVAL` is a DIFFERENT fact, deliberately not
 * disguised as the first one: the human approved the canonical product
 * truth, and the compiler deterministically projected it into this file.
 *
 * The question "which human decision authorized this artifact?" has an
 * answer under both, and under the second the answer is a record id rather
 * than a timestamp nobody can trace.
 */
export const APPROVAL_MODES = [
  'HUMAN',
  'DERIVED_FROM_INTENT_APPROVAL',
] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * Why a derived approval was refused.
 *
 * A derived approval that cannot prove equivalence must FAIL rather than
 * degrade to a warning: the whole reason it is allowed to skip a human is
 * that the artifact contains nothing the human did not approve.
 */
export const DIVERGENCE_KINDS = [
  /** A normative statement in the artifact traces to no approved element. */
  'UNAPPROVED_AUTHORITY',
  /** An approved element is missing from the projection entirely. */
  'MISSING_AUTHORITY',
  /** The approved canonical truth changed after the approval was recorded. */
  'AUTHORITY_DIGEST_MISMATCH',
  /** The artifact is not a projection of this intake at all. */
  'UNRELATED_ARTIFACT',
] as const;
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

// ---------------------------------------------------------------------------
// The seal-and-build lifecycle
// ---------------------------------------------------------------------------

/**
 * The ordered steps between the human approval and the unattended runtime.
 *
 * This is ONE product operation with several durable transactions behind it.
 * The list is ordered and the ledger is durable precisely so a crash halfway
 * through is answerable: re-entering asks each step whether it already
 * happened, in reality and not just in the ledger, and continues.
 */
export const BUILD_LIFECYCLE_STEPS = [
  /** Move the mission to CONTRACT_READY through the deterministic gate. */
  'CONTRACT_READY',
  /** Compile the contract set into Kiro spec candidates. */
  'SYNTHESIZE',
  /** Prove the projection carries no authority the human did not approve. */
  'VALIDATE_PROJECTION',
  /** Stamp requirements/design/tasks with derived approval provenance. */
  'DERIVE_APPROVALS',
  /** Draft and authorize the MissionSeal from the intake approval. */
  'SEAL',
  /** Run the overnight preflight. */
  'PREFLIGHT',
  /** Resolve the prerequisites the runtime is authorized to provide. */
  'RESOLVE_PREREQUISITES',
  /** Create the orchestration job the unattended runtime will drive. */
  'CREATE_JOB',
  /** Hand the job to the unattended supervisor. */
  'LAUNCH',
] as const;
export type BuildLifecycleStep = (typeof BUILD_LIFECYCLE_STEPS)[number];

export const BUILD_STEP_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  /** Reconciled: durable reality showed the step had already happened. */
  'RECONCILED',
  'FAILED',
  /** Not needed for this intake (e.g. nothing to resolve). */
  'SKIPPED',
] as const;
export type BuildStepStatus = (typeof BUILD_STEP_STATUSES)[number];

export const TERMINAL_BUILD_STEP_STATUSES: readonly BuildStepStatus[] = [
  'COMPLETED',
  'RECONCILED',
  'SKIPPED',
];

export function isStepSettled(status: BuildStepStatus): boolean {
  return TERMINAL_BUILD_STEP_STATUSES.includes(status);
}

/** How the whole seal-and-build operation ended. */
export const BUILD_OUTCOMES = [
  /** The unattended runtime launched. */
  'LAUNCHED',
  /** The unattended runtime ran and the job reached a terminal state. */
  'COMPLETED',
  /** A prerequisite only a person can satisfy stopped the launch. */
  'HUMAN_PREREQUISITE_REQUIRED',
  /** A lifecycle step failed for a reason the runtime could not resolve. */
  'FAILED',
  /** The run stopped on a genuine product-authority question. */
  'NEEDS_AUTHORITY',
] as const;
export type BuildOutcome = (typeof BUILD_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Append-only intake event types (`.specbridge/intake/<id>/events.jsonl`). */
export const INTAKE_EVENT_TYPES = [
  'intake_created',
  'source_ingested',
  'status_changed',
  'grounding_completed',
  'delta_analysis_completed',
  'question_opened',
  'question_refused',
  'question_answered',
  'coverage_reconciled',
  'ready_for_approval',
  'intake_approved',
  'build_step_started',
  'build_step_completed',
  'build_step_failed',
  'projection_validated',
  'projection_diverged',
  'derived_approval_recorded',
  'seal_created',
  'preflight_completed',
  'prerequisite_resolved',
  'job_created',
  'unattended_launched',
  'build_finished',
  'baseline_recorded',
  'intake_abandoned',
] as const;
export type IntakeEventType = (typeof INTAKE_EVENT_TYPES)[number];
