/**
 * The stable vocabulary of Mission Discovery.
 *
 * Everything here is a closed string enum, snapshotted into
 * `contracts/mission-contract.json`. Values are additive within 1.x: new
 * members may be appended, existing members never change meaning and are
 * never removed, so persisted mission state stays readable across upgrades.
 *
 * The organising idea: a Mission is the durable record of how a high-level
 * product direction became an approved specification — every material fact,
 * question, decision, invariant, and contract, with provenance back to the
 * visible conversation that produced it. SpecBridge owns the lifecycle,
 * validation, coverage, and materiality analysis; a model may PROPOSE facts,
 * questions, and artifacts, but no enum below can ever be set from spec
 * text, model output, or repository content without passing the structural
 * validation in the mission service.
 */

// ---------------------------------------------------------------------------
// Mission lifecycle
// ---------------------------------------------------------------------------

/**
 * Statuses of one mission. Fail-closed: the transition table in
 * state-machine.ts is the only way between them.
 *
 * `CONTRACT_READY` is a *computed* gate, not a claim: it is reachable only
 * when the deterministic coverage analysis finds no open blocking question
 * and no unaddressed required topic. A new material question re-opens
 * discovery — the status moves backwards rather than papering over a gap.
 */
export const MISSION_STATUSES = [
  /** The mission exists; discovery has not started. */
  'IDEA',
  /** Active discovery: facts, questions, and decisions are being gathered. */
  'DISCOVERING',
  /** One or more blocking decisions await the human. */
  'NEEDS_DECISION',
  /** Coverage is sufficient; the product contract set can be compiled. */
  'CONTRACT_READY',
  /** Kiro spec candidates are being synthesized from the contract set. */
  'SPEC_SYNTHESIS',
  /** Spec candidates exist and await the existing human approval workflow. */
  'SPEC_REVIEW',
  /** Every synthesized stage is approved; the mission is executable. */
  'APPROVED',
  /** Final: the user abandoned the mission. Never auto-restarted. */
  'ABANDONED',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const FINAL_MISSION_STATUSES: readonly MissionStatus[] = ['ABANDONED'];

export function isFinalMissionStatus(status: MissionStatus): boolean {
  return FINAL_MISSION_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Conversation provenance
// ---------------------------------------------------------------------------

/** Who produced one visible discovery turn. There is no third speaker. */
export const TURN_SPEAKERS = ['user', 'agent'] as const;
export type TurnSpeaker = (typeof TURN_SPEAKERS)[number];

/**
 * What kind of visible exchange a turn records. These are the units a
 * decision's lineage is reconstructed from — never hidden reasoning, which
 * is deliberately not representable here.
 */
export const TURN_KINDS = [
  /** The user stated a direction, requirement, constraint, or fact. */
  'statement',
  /** The agent asked the user a material question. */
  'question',
  /** The agent restated its understanding for confirmation. */
  'interpretation',
  /** The user confirmed an interpretation or proposal. */
  'confirmation',
  /** The user rejected an interpretation or proposal. */
  'rejection',
  /** The user corrected a previously recorded fact or decision. */
  'correction',
  /** The agent presented compiled artifacts (constitution, contracts, …). */
  'presentation',
] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

/**
 * Structural provenance of a mission fact or decision. Deliberately the
 * same categories as the orchestration provenance model (SpecBridge does
 * not use numeric model confidence anywhere), plus `known-from-prior-decision`
 * for facts derived from an earlier confirmed decision.
 */
export const MISSION_PROVENANCE_KINDS = [
  'known-from-user',
  'known-from-approved-spec',
  'known-from-repository-evidence',
  'known-from-configuration',
  'known-from-prior-decision',
  'inferred',
  'unknown',
  'conflicting',
] as const;
export type MissionProvenanceKind = (typeof MISSION_PROVENANCE_KINDS)[number];

/**
 * Provenance values that may NOT by themselves support a recorded DECISION.
 * A decision is a durable commitment; an inference is a hypothesis. The
 * mission service refuses decisions carrying these unless they reference a
 * confirming user turn.
 */
export const UNSAFE_DECISION_PROVENANCE: readonly MissionProvenanceKind[] = [
  'inferred',
  'unknown',
  'conflicting',
];

// ---------------------------------------------------------------------------
// Discovery coverage topics
// ---------------------------------------------------------------------------

/**
 * The closed topic taxonomy coverage is computed over. Facts, questions,
 * and decisions are tagged with topics; coverage is derived, never asserted.
 *
 * Not every project needs every topic — `REQUIRED_TOPICS` below is the
 * minimum floor, and a topic can be explicitly resolved as not-applicable
 * by a recorded decision.
 */
export const DISCOVERY_TOPICS = [
  'goal',
  'non-goals',
  'use-cases',
  'system-boundaries',
  'architecture-ownership',
  'canonical-model',
  'concurrency-semantics',
  'failure-semantics',
  'retry-semantics',
  'timeout-semantics',
  'idempotency',
  'durability',
  'crash-recovery',
  'distributed-ownership',
  'protocol-identity',
  'public-api',
  'configuration-semantics',
  'persistence-model',
  'extension-seams',
  'compatibility',
  'evolution-rules',
  'observability',
  'security',
  'performance',
] as const;
export type DiscoveryTopic = (typeof DISCOVERY_TOPICS)[number];

/**
 * Topics that must be resolved (or explicitly marked not-applicable by a
 * recorded decision) before a mission may reach CONTRACT_READY. Everything
 * else is coverage information: surfaced, tracked, never a silent gate.
 */
export const REQUIRED_TOPICS: readonly DiscoveryTopic[] = [
  'goal',
  'use-cases',
  'system-boundaries',
  'canonical-model',
  'public-api',
  'failure-semantics',
  'compatibility',
];

/** Computed per-topic coverage status. */
export const TOPIC_STATUSES = [
  /** Nothing recorded touches this topic. */
  'unknown',
  /** Questions are open, or facts exist without a resolving decision. */
  'open',
  /** At least one active decision resolves the topic. */
  'resolved',
  /** A recorded decision explicitly marked the topic not applicable. */
  'not-applicable',
] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

// ---------------------------------------------------------------------------
// Materiality and irreversibility
// ---------------------------------------------------------------------------

/**
 * How much an unresolved question matters. Only `blocking` prevents
 * CONTRACT_READY; implementation-detail questions are recorded, surfaced,
 * and explicitly NOT allowed to stall discovery.
 */
export const MATERIALITY_LEVELS = ['blocking', 'material', 'implementation-detail'] as const;
export type MaterialityLevel = (typeof MATERIALITY_LEVELS)[number];

/**
 * The surfaces whose answers are materially irreversible: changing them
 * later would break users, data, or promises rather than code. A question
 * touching any of these classifies `blocking` — whatever the proposer
 * declared — via the deterministic screen in materiality.ts.
 */
export const IRREVERSIBLE_SURFACES = [
  'public-api',
  'wire-protocol',
  'persisted-state',
  'configuration-language',
  'sdk-contract',
  'extension-spi',
  'compatibility-promise',
  'security-boundary',
  'failure-delivery-semantics',
  'cross-module-architecture',
] as const;
export type IrreversibleSurface = (typeof IRREVERSIBLE_SURFACES)[number];

// ---------------------------------------------------------------------------
// Discovery record statuses
// ---------------------------------------------------------------------------

export const FACT_STATUSES = ['active', 'superseded', 'retracted'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const QUESTION_STATUSES = ['open', 'answered', 'withdrawn'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const DECISION_STATUSES = ['active', 'superseded'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Durable product artifacts
// ---------------------------------------------------------------------------

export const CONSTITUTION_RULE_STATUSES = ['active', 'superseded'] as const;
export type ConstitutionRuleStatus = (typeof CONSTITUTION_RULE_STATUSES)[number];

/**
 * ADR files are immutable once written; effective status is DERIVED — an
 * ADR is superseded exactly when a later ADR names it in `supersedes`.
 * History is never rewritten.
 */
export const ADR_STATUSES = ['accepted', 'superseded'] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

export const CONTRACT_STATUSES = ['draft', 'active', 'superseded'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** Public contracts are promises to users; internal ones are to the team. */
export const CONTRACT_CLASSIFICATIONS = ['public', 'internal'] as const;
export type ContractClassification = (typeof CONTRACT_CLASSIFICATIONS)[number];

/** How a contract may evolve once its first revision is active. */
export const COMPATIBILITY_POLICIES = [
  /** No changes of any kind without a new major product decision. */
  'frozen',
  /** New capability may be appended; nothing existing changes meaning. */
  'additive-only',
  /** Breaking revisions allowed through the versioned change process. */
  'evolving',
  /** Internal contract with no external promise. */
  'internal',
] as const;
export type CompatibilityPolicy = (typeof COMPATIBILITY_POLICIES)[number];

// ---------------------------------------------------------------------------
// Contract change requests
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one ContractChangeRequest. Workers and models may CREATE a
 * request (it lands as PROPOSED or NEEDS_HUMAN by materiality); only an
 * explicit human decision can move it to APPROVED or REJECTED. There is no
 * API on any agent-reachable surface that performs that transition.
 */
export const CCR_STATUSES = [
  'PROPOSED',
  'NEEDS_HUMAN',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
] as const;
export type CcrStatus = (typeof CCR_STATUSES)[number];

export const FINAL_CCR_STATUSES: readonly CcrStatus[] = ['APPROVED', 'REJECTED', 'SUPERSEDED'];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Append-only mission event types (`.specbridge/missions/<id>/events.jsonl`). */
export const MISSION_EVENT_TYPES = [
  'mission_created',
  'status_changed',
  'turn_recorded',
  'fact_recorded',
  'fact_superseded',
  'fact_retracted',
  'question_opened',
  'question_answered',
  'question_withdrawn',
  'decision_recorded',
  'decision_superseded',
  'coverage_updated',
  'constitution_rule_recorded',
  'constitution_rule_superseded',
  'adr_recorded',
  'contract_recorded',
  'contract_revised',
  'synthesis_started',
  'synthesis_completed',
  'spec_approval_observed',
  'ccr_created',
  'ccr_decided',
  'ccr_applied',
  'checkpoint_created',
  'mission_abandoned',
] as const;
export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];
