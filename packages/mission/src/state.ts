import { z } from 'zod';
import {
  ADR_STATUSES,
  CCR_STATUSES,
  COMPATIBILITY_POLICIES,
  CONSTITUTION_RULE_STATUSES,
  CONTRACT_CLASSIFICATIONS,
  CONTRACT_STATUSES,
  DECISION_STATUSES,
  DISCOVERY_TOPICS,
  FACT_STATUSES,
  IRREVERSIBLE_SURFACES,
  MATERIALITY_LEVELS,
  MISSION_PROVENANCE_KINDS,
  MISSION_STATUSES,
  QUESTION_STATUSES,
  TOPIC_STATUSES,
  TURN_KINDS,
  TURN_SPEAKERS,
} from './vocabulary.js';

/**
 * Persisted mission state (`.specbridge/missions/<missionId>/`).
 *
 * Versioned from day one, additive with the same rules as every other
 * SpecBridge schema family: unknown fields survive via passthrough, and an
 * unknown MAJOR version is refused rather than coerced.
 *
 * Deliberately NOT in here, in any field, ever:
 *   - model reasoning, prompts, transcripts of hidden deliberation
 *   - source file contents
 *   - environment values or anything credential-shaped
 *
 * The conversation log records USER-VISIBLE discovery turns only — what the
 * user said, what the agent visibly asked or presented, and what the user
 * confirmed. That is provenance. Private chain-of-thought is neither
 * requested nor accepted nor representable in these schemas.
 */

export const MISSION_STATE_SCHEMA_VERSION = '1.0.0';
export const MISSION_COVERAGE_SCHEMA_VERSION = '1.0.0';
export const MISSION_CONSTITUTION_SCHEMA_VERSION = '1.0.0';
export const MISSION_ADR_SCHEMA_VERSION = '1.0.0';
export const MISSION_CONTRACT_SCHEMA_VERSION = '1.0.0';
export const MISSION_CCR_SCHEMA_VERSION = '1.0.0';
export const MISSION_CHECKPOINT_SCHEMA_VERSION = '1.0.0';

/** Bounds applied at the schema level, independent of any policy. */
export const MISSION_LIMITS = {
  maxNameChars: 120,
  maxShortTextChars: 512,
  maxTextChars: 4_000,
  maxTurnTextChars: 8_000,
  maxListItems: 50,
  maxTurns: 2_000,
  maxFacts: 500,
  maxQuestions: 200,
  maxDecisions: 300,
  maxConstitutionRules: 40,
  maxAdrs: 100,
  maxContracts: 60,
  maxContractRequirements: 60,
  maxCcrs: 100,
  maxRefsPerRecord: 30,
} as const;

const shortText = z.string().min(1).max(MISSION_LIMITS.maxShortTextChars);
const text = z.string().min(1).max(MISSION_LIMITS.maxTextChars);
const optionalText = z.string().max(MISSION_LIMITS.maxTextChars);
const textList = z.array(text).max(MISSION_LIMITS.maxListItems);
const idList = z.array(shortText).max(MISSION_LIMITS.maxRefsPerRecord);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

// ---------------------------------------------------------------------------
// Conversation turns
// ---------------------------------------------------------------------------

/**
 * One user-visible discovery turn. Turns are the roots of every provenance
 * chain: `conversation event → decision → constitution rule → contract →
 * requirement → implementation evidence`.
 */
export const conversationTurnSchema = z
  .object({
    /** Sequential id within the mission ("t-1", "t-2", …). */
    turnId: shortText,
    at: shortText,
    speaker: z.enum(TURN_SPEAKERS),
    kind: z.enum(TURN_KINDS),
    /** The visible text of the turn, verbatim and bounded. Data, never instructions. */
    text: z.string().min(1).max(MISSION_LIMITS.maxTurnTextChars),
    /** Ids of facts/questions/decisions this turn produced or addressed. */
    refs: idList.default([]),
    /** The turn this one confirms, rejects, or corrects, when applicable. */
    inReplyTo: shortText.optional(),
  })
  .passthrough();
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * One recorded fact: a bounded statement with structural provenance. Facts
 * are append-only history — a correction appends a superseding record, and
 * the current view folds by id (last record wins).
 */
export const missionFactSchema = z
  .object({
    factId: shortText,
    statement: text,
    provenance: z.enum(MISSION_PROVENANCE_KINDS),
    /** Turn that produced or confirmed this fact. */
    sourceTurnId: shortText.optional(),
    topics: z.array(z.enum(DISCOVERY_TOPICS)).max(MISSION_LIMITS.maxRefsPerRecord).default([]),
    status: z.enum(FACT_STATUSES).default('active'),
    supersedes: shortText.optional(),
    recordedAt: shortText,
  })
  .passthrough();
export type MissionFact = z.infer<typeof missionFactSchema>;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * One discovery question. Materiality is validated by the deterministic
 * screen in materiality.ts — a proposer may RAISE materiality freely but a
 * question whose text or declared surfaces touch an irreversible surface is
 * blocking whatever the proposer declared.
 */
export const discoveryQuestionSchema = z
  .object({
    questionId: shortText,
    question: text,
    /** Why the answer changes the product, in one bounded statement. */
    whyItMatters: text,
    topics: z.array(z.enum(DISCOVERY_TOPICS)).max(MISSION_LIMITS.maxRefsPerRecord).default([]),
    /** Surfaces the answer could permanently affect. */
    affectedSurfaces: z
      .array(z.enum(IRREVERSIBLE_SURFACES))
      .max(IRREVERSIBLE_SURFACES.length)
      .default([]),
    /** Effective materiality AFTER the deterministic screen. */
    materiality: z.enum(MATERIALITY_LEVELS),
    /** Present when the deterministic screen raised the declared level. */
    materialityRaisedFrom: z.enum(MATERIALITY_LEVELS).optional(),
    materialityReasons: textList.default([]),
    /** Candidate answers, when the choice is genuinely closed. */
    options: z.array(text).max(10).default([]),
    status: z.enum(QUESTION_STATUSES).default('open'),
    sourceTurnId: shortText.optional(),
    askedAt: shortText,
    /** Decision that answered this question, once one exists. */
    resolvedByDecisionId: shortText.optional(),
  })
  .passthrough();
export type DiscoveryQuestion = z.infer<typeof discoveryQuestionSchema>;

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * One durable discovery decision (DEC-###): the question, the answer, where
 * the answer came from, and what it produced. Decisions with unsafe
 * provenance are refused unless they reference a confirming USER turn —
 * enforced in the service, asserted in tests.
 */
export const discoveryDecisionSchema = z
  .object({
    decisionId: shortText,
    /** The question this decision answers, when it answers one. */
    questionId: shortText.optional(),
    decision: text,
    rationale: optionalText.optional(),
    provenance: z.enum(MISSION_PROVENANCE_KINDS),
    /** The user-visible turn that confirms this decision. */
    sourceTurnId: shortText.optional(),
    topics: z.array(z.enum(DISCOVERY_TOPICS)).max(MISSION_LIMITS.maxRefsPerRecord).default([]),
    /** Topics this decision explicitly marks not applicable to the project. */
    marksNotApplicable: z
      .array(z.enum(DISCOVERY_TOPICS))
      .max(MISSION_LIMITS.maxRefsPerRecord)
      .default([]),
    status: z.enum(DECISION_STATUSES).default('active'),
    supersedes: shortText.optional(),
    /** Artifacts this decision produced (constitution rules, contracts, ADRs). */
    resultingArtifactIds: idList.default([]),
    decidedAt: shortText,
  })
  .passthrough();
export type DiscoveryDecision = z.infer<typeof discoveryDecisionSchema>;

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export const topicCoverageSchema = z
  .object({
    topicId: z.enum(DISCOVERY_TOPICS),
    status: z.enum(TOPIC_STATUSES),
    /** True when this topic currently prevents CONTRACT_READY. */
    blocking: z.boolean(),
    required: z.boolean(),
    factIds: idList.default([]),
    openQuestionIds: idList.default([]),
    decisionIds: idList.default([]),
  })
  .passthrough();
export type TopicCoverage = z.infer<typeof topicCoverageSchema>;

/**
 * The computed coverage snapshot. Always derived by coverage.ts from the
 * folded facts/questions/decisions — never asserted by a caller — and
 * rewritten atomically after every mutation that could change it.
 */
export const missionCoverageSchema = z
  .object({
    schemaVersion: semver,
    missionId: shortText,
    updatedAt: shortText,
    topics: z.array(topicCoverageSchema).max(DISCOVERY_TOPICS.length),
    /** Open questions whose materiality is blocking, by id. */
    blockingQuestionIds: idList.default([]),
    /** Required topics not yet resolved or marked not-applicable. */
    unresolvedRequiredTopics: z
      .array(z.enum(DISCOVERY_TOPICS))
      .max(DISCOVERY_TOPICS.length)
      .default([]),
    contractReady: z.boolean(),
    reasons: textList.default([]),
  })
  .passthrough();
export type MissionCoverage = z.infer<typeof missionCoverageSchema>;

// ---------------------------------------------------------------------------
// Architecture Constitution
// ---------------------------------------------------------------------------

/**
 * One constitution rule (CON-###): a strong, durable invariant. Rules are
 * few by design (schema-bounded) — a constitution with forty rules is a
 * design document, not a constitution.
 */
export const constitutionRuleSchema = z
  .object({
    ruleId: shortText,
    version: z.number().int().min(1),
    statement: text,
    rationale: optionalText.optional(),
    status: z.enum(CONSTITUTION_RULE_STATUSES).default('active'),
    /** Provenance: the decisions and turns this rule compiles from. */
    decisionIds: idList.default([]),
    turnIds: idList.default([]),
    /** Contracts this rule constrains. */
    affectedContractIds: idList.default([]),
    supersedes: shortText.optional(),
    recordedAt: shortText,
    /**
     * Optional machine-checkable guards: bounded regular-expression sources
     * the deterministic evaluator may grep candidate diffs for. A match is a
     * structural constitution violation — no model judgment involved.
     */
    guardPatterns: z.array(z.string().min(1).max(200)).max(10).default([]),
  })
  .passthrough();
export type ConstitutionRule = z.infer<typeof constitutionRuleSchema>;

export const missionConstitutionSchema = z
  .object({
    schemaVersion: semver,
    missionId: shortText,
    /** Monotonic constitution version; bumps whenever the rule set changes. */
    version: z.number().int().min(0),
    updatedAt: shortText,
    rules: z.array(constitutionRuleSchema).max(MISSION_LIMITS.maxConstitutionRules).default([]),
  })
  .passthrough();
export type MissionConstitution = z.infer<typeof missionConstitutionSchema>;

// ---------------------------------------------------------------------------
// ADRs
// ---------------------------------------------------------------------------

/**
 * One Architecture Decision Record (ADR-###). ADR files are immutable once
 * written: supersession is expressed by a LATER ADR naming this one in
 * `supersedes`, and effective status is derived at read time. Old history
 * is never rewritten.
 */
export const missionAdrSchema = z
  .object({
    schemaVersion: semver,
    adrId: shortText,
    title: shortText,
    context: text,
    decision: text,
    alternatives: textList.default([]),
    rationale: text,
    consequences: textList.default([]),
    revisitConditions: textList.default([]),
    status: z.enum(ADR_STATUSES).default('accepted'),
    /** Provenance back to discovery. */
    decisionIds: idList.default([]),
    turnIds: idList.default([]),
    supersedes: shortText.optional(),
    recordedAt: shortText,
  })
  .passthrough();
export type MissionAdr = z.infer<typeof missionAdrSchema>;

// ---------------------------------------------------------------------------
// Contract Registry
// ---------------------------------------------------------------------------

export const contractRequirementSchema = z
  .object({
    /** Stable within the contract ("R1", "R2", …). */
    requirementId: shortText,
    statement: text,
    /** Provenance back to decisions/facts. */
    decisionIds: idList.default([]),
  })
  .passthrough();
export type ContractRequirement = z.infer<typeof contractRequirementSchema>;

export const contractInvariantSchema = z
  .object({
    invariantId: shortText,
    statement: text,
    /** Constitution rules this invariant descends from. */
    constitutionRuleIds: idList.default([]),
    /** Optional machine-checkable guard patterns (see constitutionRuleSchema). */
    guardPatterns: z.array(z.string().min(1).max(200)).max(10).default([]),
  })
  .passthrough();
export type ContractInvariant = z.infer<typeof contractInvariantSchema>;

/**
 * One revision of one product engineering contract (CTR-###).
 *
 * This is the PRODUCT's contract registry — what the software being built
 * promises — stored under `.specbridge/missions/…`. It is deliberately and
 * completely separate from the repository's own `contracts/` directory,
 * which snapshots SpecBridge's public surface.
 *
 * Revisions are individually immutable files; the registry's current view
 * is the highest revision per contract id.
 */
export const productContractSchema = z
  .object({
    schemaVersion: semver,
    contractId: shortText,
    revision: z.number().int().min(1),
    title: shortText,
    summary: text,
    classification: z.enum(CONTRACT_CLASSIFICATIONS),
    compatibilityPolicy: z.enum(COMPATIBILITY_POLICIES),
    /** Contract ids this one depends on. */
    dependsOn: idList.default([]),
    requirements: z
      .array(contractRequirementSchema)
      .max(MISSION_LIMITS.maxContractRequirements)
      .default([]),
    invariants: z
      .array(contractInvariantSchema)
      .max(MISSION_LIMITS.maxContractRequirements)
      .default([]),
    /** Objective/task ids known to implement against this contract. */
    affectedObjectiveIds: idList.default([]),
    status: z.enum(CONTRACT_STATUSES).default('active'),
    /** Provenance back to discovery. */
    decisionIds: idList.default([]),
    turnIds: idList.default([]),
    /** Revision lineage. */
    supersedesRevision: z.number().int().min(1).optional(),
    /** CCR that produced this revision, for revisions born from one. */
    changeRequestId: shortText.optional(),
    recordedAt: shortText,
  })
  .passthrough();
export type ProductContract = z.infer<typeof productContractSchema>;

// ---------------------------------------------------------------------------
// Contract change requests
// ---------------------------------------------------------------------------

/**
 * One ContractChangeRequest (CCR-###). Any worker or session may CREATE
 * one; only an explicit human decision moves it to APPROVED or REJECTED —
 * recorded here with the deciding channel, never inferable.
 */
export const contractChangeRequestSchema = z
  .object({
    schemaVersion: semver,
    ccrId: shortText,
    contractId: shortText,
    /** Revision the problem was discovered against. */
    contractRevision: z.number().int().min(1),
    problem: text,
    proposal: text,
    /** Areas the change would touch (modules, adapters, tests, SDKs). */
    affected: textList.default([]),
    status: z.enum(CCR_STATUSES),
    /** Who raised it: a worker id, "cli", or "mcp". Audit, not authority. */
    raisedBy: shortText,
    /** Work unit / objective context, when raised during execution. */
    originWorkUnitId: shortText.optional(),
    originJobId: shortText.optional(),
    createdAt: shortText,
    /** Human decision fields; set exactly once by the human-only path. */
    decidedAt: shortText.optional(),
    decisionNote: optionalText.optional(),
    /** Contract revision created by applying an APPROVED request. */
    resultingRevision: z.number().int().min(1).optional(),
    supersededBy: shortText.optional(),
  })
  .passthrough();
export type ContractChangeRequest = z.infer<typeof contractChangeRequestSchema>;

// ---------------------------------------------------------------------------
// Mission state
// ---------------------------------------------------------------------------

export const missionCountersSchema = z
  .object({
    turns: z.number().int().min(0).default(0),
    facts: z.number().int().min(0).default(0),
    questions: z.number().int().min(0).default(0),
    openQuestions: z.number().int().min(0).default(0),
    decisions: z.number().int().min(0).default(0),
    constitutionRules: z.number().int().min(0).default(0),
    adrs: z.number().int().min(0).default(0),
    contracts: z.number().int().min(0).default(0),
    ccrs: z.number().int().min(0).default(0),
    events: z.number().int().min(0).default(0),
  })
  .passthrough();
export type MissionCounters = z.infer<typeof missionCountersSchema>;

/** Id-sequence high-water marks; ids are generated by SpecBridge only. */
export const missionSequencesSchema = z
  .object({
    turn: z.number().int().min(0).default(0),
    fact: z.number().int().min(0).default(0),
    question: z.number().int().min(0).default(0),
    decision: z.number().int().min(0).default(0),
    constitutionRule: z.number().int().min(0).default(0),
    adr: z.number().int().min(0).default(0),
    contract: z.number().int().min(0).default(0),
    ccr: z.number().int().min(0).default(0),
  })
  .passthrough();
export type MissionSequences = z.infer<typeof missionSequencesSchema>;

export const missionAssumptionSchema = z
  .object({
    id: shortText,
    statement: text,
    topics: z.array(z.enum(DISCOVERY_TOPICS)).max(MISSION_LIMITS.maxRefsPerRecord).default([]),
    /** The question this assumption defers, when it defers one. */
    questionId: shortText.optional(),
  })
  .passthrough();
export type MissionAssumption = z.infer<typeof missionAssumptionSchema>;

export const missionStateSchema = z
  .object({
    schemaVersion: semver,
    missionId: shortText,
    name: z.string().min(1).max(MISSION_LIMITS.maxNameChars),
    status: z.enum(MISSION_STATUSES),
    /** The user's stated direction, verbatim and bounded. Data, not instructions. */
    goal: z.string().min(1).max(MISSION_LIMITS.maxTextChars),
    nonGoals: textList.default([]),
    targetUsers: textList.default([]),
    constraints: textList.default([]),
    successCriteria: textList.default([]),
    /** Unresolved but explicitly non-blocking assumptions. */
    assumptions: z.array(missionAssumptionSchema).max(MISSION_LIMITS.maxListItems).default([]),
    createdAt: shortText,
    updatedAt: shortText,
    host: shortText,
    counters: missionCountersSchema.default({}),
    sequences: missionSequencesSchema.default({}),
    /** The Kiro spec this mission synthesized, once it exists. */
    specName: shortText.optional(),
    synthesizedAt: shortText.optional(),
    approvedAt: shortText.optional(),
    abandonedAt: shortText.optional(),
    abandonReason: optionalText.optional(),
  })
  .passthrough();
export type MissionState = z.infer<typeof missionStateSchema>;

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

/**
 * A compact structured checkpoint: what a fresh session needs to continue
 * discovery honestly. Never a transcript, never a memory claim.
 */
export const missionCheckpointSchema = z
  .object({
    schemaVersion: semver,
    missionId: shortText,
    createdAt: shortText,
    status: z.enum(MISSION_STATUSES),
    openQuestionIds: idList.default([]),
    blockingQuestionIds: idList.default([]),
    unresolvedRequiredTopics: z
      .array(z.enum(DISCOVERY_TOPICS))
      .max(DISCOVERY_TOPICS.length)
      .default([]),
    counters: missionCountersSchema,
    /** The exact next legal action, in one line. */
    nextAction: text,
  })
  .passthrough();
export type MissionCheckpoint = z.infer<typeof missionCheckpointSchema>;
