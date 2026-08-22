import { z } from 'zod';
import { FAILURE_CATEGORIES } from '../vocabulary.js';
import { STATE_LIMITS } from '../state.js';
import {
  ASSESSMENT_BASES,
  EVALUATION_CHECK_LEVELS,
  EVALUATION_CHECK_OUTCOMES,
  EVALUATION_STATUSES,
  EXECUTION_HEALTH_STATES,
  FAILURE_RECOVERABILITIES,
  FAILURE_SCOPES,
  FAILURE_SOURCES,
  RECOVERY_ACTIONS,
  RECOVERY_REASON_CODES,
  RECOVERY_STRATEGY_DIMENSIONS,
  RUNAWAY_SIGNALS,
} from './vocabulary.js';

/**
 * Durable reliability state (vNext.6), persisted under
 * `.specbridge/jobs/<jobId>/reliability/`.
 *
 * Three append-only record types, each answering one question a human will
 * eventually ask about a long-running job:
 *
 *   EvaluationResult   was the work actually correct, and on what evidence?
 *   FailureAssessment  what kind of failure was it, and where did it come from?
 *   RecoveryDecision   what did SpecBridge decide to do next, and why?
 *
 * They are separate records rather than fields on the attempt because they
 * have different lifetimes and different authorities. An attempt is one
 * worker's run; an evaluation is SpecBridge's verdict on it; a recovery
 * decision is SpecBridge's choice about the future. Collapsing them would
 * make it possible for a worker's record to carry its own verdict.
 *
 * Deliberately NOT representable here, structurally: model reasoning,
 * chain-of-thought, prompts, transcripts, conversation history, source file
 * contents, or anything credential-shaped. Every text field is bounded, and
 * findings carry reason codes and evidence references rather than
 * deliberation. This is the same exclusion the job and survival states
 * enforce, and it is why a semantic reviewer's output is a list of
 * structured findings and never a narrative.
 */

export const EVALUATION_RESULT_SCHEMA_VERSION = '1.0.0';
export const FAILURE_ASSESSMENT_SCHEMA_VERSION = '1.0.0';
export const RECOVERY_DECISION_SCHEMA_VERSION = '1.0.0';

export const RELIABILITY_LIMITS = {
  maxChecks: 60,
  maxFindings: 40,
  maxListItems: STATE_LIMITS.maxListItems,
  maxEvidenceRefs: 40,
  maxTextChars: STATE_LIMITS.maxTextChars,
  maxShortTextChars: STATE_LIMITS.maxShortTextChars,
  /** Bounded per-task fingerprint history used by loop detection. */
  maxFingerprintHistory: 12,
} as const;

const shortText = z.string().min(1).max(RELIABILITY_LIMITS.maxShortTextChars);
const text = z.string().min(1).max(RELIABILITY_LIMITS.maxTextChars);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * One check inside an evaluation.
 *
 * `outcome` and `required` are separate because their combination is what
 * produces the verdict: a required check that is UNAVAILABLE yields
 * INCONCLUSIVE, while an optional one merely annotates the record. A check
 * never carries a "score" — it carries what happened and what proves it.
 */
export const evaluationCheckSchema = z
  .object({
    level: z.enum(EVALUATION_CHECK_LEVELS),
    /** Stable identifier of the check itself (verifier name, criterion id). */
    name: shortText,
    outcome: z.enum(EVALUATION_CHECK_OUTCOMES),
    /** False for advisory checks that never by themselves fail a task. */
    required: z.boolean().default(true),
    /** Bounded, safe detail. Never raw model prose, never a stack trace. */
    detail: text.optional(),
    /** Evidence reference (run id, verifier result key, criterion id). */
    evidenceRef: shortText.optional(),
    durationMs: z.number().int().min(0).nullable().default(null),
  })
  .passthrough();
export type EvaluationCheck = z.infer<typeof evaluationCheckSchema>;

/**
 * One structured finding from the bounded semantic reviewer.
 *
 * A finding is a PROPOSAL. It carries a bounded observation, the criterion
 * it relates to, and a severity — never a verdict, and never a patch. The
 * reviewer has no repository write authority and its output cannot overturn
 * a deterministic FAIL; both facts are enforced in code, and the shape here
 * is what makes them enforceable.
 */
export const semanticFindingSchema = z
  .object({
    /** Acceptance criterion or contract id this finding relates to, if any. */
    criterionId: shortText.optional(),
    severity: z.enum(['blocking', 'concern', 'note']),
    /** Bounded structured observation. Never chain-of-thought. */
    observation: text,
    /** Repository path the finding points at, when it points at one. */
    path: shortText.optional(),
  })
  .passthrough();
export type SemanticFinding = z.infer<typeof semanticFindingSchema>;

/**
 * The durable verdict on one ExecutionAttempt.
 *
 * Written for every finished attempt, whatever the outcome — a PASS is as
 * much a record as a FAIL, because "why did we believe this task was done?"
 * is a question that gets asked months later.
 */
export const evaluationResultSchema = z
  .object({
    schemaVersion: semver,
    evaluationId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    attemptId: shortText,
    /** The economic lane the evaluated attempt ran on, for cross-lane analysis. */
    lane: shortText.nullable().default(null),
    status: z.enum(EVALUATION_STATUSES),
    /** Deterministic checks, in level order. Always populated. */
    deterministicChecks: z.array(evaluationCheckSchema).max(RELIABILITY_LIMITS.maxChecks).default([]),
    /** Semantic checks. Empty unless a bounded review actually ran. */
    semanticChecks: z.array(evaluationCheckSchema).max(RELIABILITY_LIMITS.maxChecks).default([]),
    /** Structured semantic findings; proposals only, never authority. */
    semanticFindings: z.array(semanticFindingSchema).max(RELIABILITY_LIMITS.maxFindings).default([]),
    /** Acceptance-criteria ids that did not hold. */
    failedCriteria: z.array(shortText).max(RELIABILITY_LIMITS.maxListItems).default([]),
    /** Run ids, verifier keys, patch refs backing this verdict. */
    evidenceRefs: z.array(shortText).max(RELIABILITY_LIMITS.maxEvidenceRefs).default([]),
    /**
     * Normalized failure fingerprints observed during evaluation. These feed
     * no-progress detection directly, which is why they live on the durable
     * record rather than being recomputed from logs.
     */
    failureSignals: z.array(shortText).max(RELIABILITY_LIMITS.maxListItems).default([]),
    /** Ordered, safe explanation of how the status was reached. */
    reasons: z.array(text).max(RELIABILITY_LIMITS.maxListItems).default([]),
    /**
     * True when a semantic review ran AND the deterministic layers had
     * already passed. Recorded so the "semantic never overrides
     * deterministic" invariant is auditable after the fact.
     */
    semanticReviewRan: z.boolean().default(false),
    createdAt: shortText,
  })
  .passthrough();
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

// ---------------------------------------------------------------------------
// Failure assessment
// ---------------------------------------------------------------------------

/**
 * The durable, structured assessment of one failure.
 *
 * `category` keeps the existing stable failure taxonomy unchanged — the
 * vocabulary earlier releases already persist — and `source` adds the
 * orthogonal question this phase needed: whose fault was it. Neither is
 * derived from the other, and `recommendedRecoveryClass` is a HINT the
 * planner may legitimately ignore, never a decision.
 */
export const failureAssessmentSchema = z
  .object({
    schemaVersion: semver,
    assessmentId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    attemptId: shortText,
    lane: shortText.nullable().default(null),
    /** The existing stable failure taxonomy, unchanged. */
    category: z.enum(FAILURE_CATEGORIES),
    source: z.enum(FAILURE_SOURCES),
    scope: z.enum(FAILURE_SCOPES),
    recoverability: z.enum(FAILURE_RECOVERABILITIES),
    /** What this assessment rests on. Not a fabricated confidence number. */
    basis: z.enum(ASSESSMENT_BASES),
    /** Deterministic identity of the failure (see failureFingerprint). */
    fingerprint: shortText,
    /** Identity of the working-tree change set this failure came with. */
    diffFingerprint: shortText.nullable().default(null),
    /** How many attempts on this task have ended with this fingerprint. */
    repeatedCount: z.number().int().min(1).default(1),
    /** Bounded, safe statement of the likely cause. Never model prose. */
    likelyCause: text,
    /** A hint for the planner, which decides independently. */
    recommendedRecoveryClass: z.enum(RECOVERY_ACTIONS).nullable().default(null),
    /** Health at the time of assessment, for the durable record. */
    health: z.enum(EXECUTION_HEALTH_STATES).default('HEALTHY'),
    /** Runaway signals that fired, when the attempt was stopped for one. */
    runawaySignals: z.array(z.enum(RUNAWAY_SIGNALS)).max(RUNAWAY_SIGNALS.length).default([]),
    evidenceRefs: z.array(shortText).max(RELIABILITY_LIMITS.maxEvidenceRefs).default([]),
    createdAt: shortText,
  })
  .passthrough();
export type FailureAssessment = z.infer<typeof failureAssessmentSchema>;

// ---------------------------------------------------------------------------
// Recovery decision
// ---------------------------------------------------------------------------

/**
 * The bounded budget picture a recovery decision was made against.
 *
 * Snapshotted onto the decision rather than looked up later, because "how
 * much budget remained when we decided to escalate?" cannot be reconstructed
 * from a counter that has since moved. Null means genuinely unknown, and is
 * never rendered as zero.
 */
export const budgetSnapshotSchema = z
  .object({
    attemptsUsed: z.number().int().min(0),
    attemptsMax: z.number().int().min(0),
    repairsUsed: z.number().int().min(0),
    repairsMax: z.number().int().min(0),
    replansUsed: z.number().int().min(0),
    replansMax: z.number().int().min(0),
    transientRetriesUsed: z.number().int().min(0),
    transientRetriesMax: z.number().int().min(0),
    stagnationCount: z.number().int().min(0).default(0),
    /** Shared LOCAL-lane attempts used on this task (vNext.4 budget). */
    localAttemptsUsed: z.number().int().min(0).nullable().default(null),
    localAttemptsMax: z.number().int().min(0).nullable().default(null),
    elapsedMs: z.number().int().min(0).nullable().default(null),
    maxWallClockMs: z.number().int().min(0).nullable().default(null),
    /** vNext.5 API budget, read from its owner — never counted here. */
    apiRemainingUsd: z.number().nullable().default(null),
    apiEncumberedUsd: z.number().min(0).nullable().default(null),
    /** Provider-reported figures only; null when nothing was reported. */
    reportedCostUsd: z.number().min(0).nullable().default(null),
    reportedTokens: z.number().int().min(0).nullable().default(null),
  })
  .passthrough();
export type BudgetSnapshot = z.infer<typeof budgetSnapshotSchema>;

/**
 * The strategy identity of an attempt: the tuple that determines how one
 * attempt materially differs from another.
 *
 * Two attempts sharing a strategy key and a failure fingerprint are the same
 * experiment run twice — which is precisely what the recovery planner must
 * refuse to authorize a third time.
 */
export const recoveryStrategySchema = z
  .object({
    lane: shortText.nullable().default(null),
    executionMode: shortText.nullable().default(null),
    planRevision: z.number().int().min(0).default(0),
    /** Whether the next attempt starts from a rebuilt context. */
    freshContext: z.boolean().default(false),
    /** Stable digest of the four fields above, for equality comparison. */
    key: shortText,
  })
  .passthrough();
export type RecoveryStrategy = z.infer<typeof recoveryStrategySchema>;

/**
 * The durable record of one recovery decision.
 *
 * Persisted BEFORE the next attempt starts, so a crash between deciding and
 * acting leaves the decision on record rather than leaving a restarted
 * process to invent a different, unexplained transition.
 */
export const recoveryDecisionSchema = z
  .object({
    schemaVersion: semver,
    decisionId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    /** The attempt whose failure this decision responds to. */
    attemptId: shortText,
    /** The assessment this decision was made from. */
    assessmentId: shortText.optional(),
    /** The evaluation this decision was made from, when one exists. */
    evaluationId: shortText.optional(),
    action: z.enum(RECOVERY_ACTIONS),
    reasonCode: z.enum(RECOVERY_REASON_CODES),
    /** Bounded, safe explanation. Written by policy, never by a model. */
    reason: text,
    failureFingerprint: shortText.nullable().default(null),
    health: z.enum(EXECUTION_HEALTH_STATES),
    /** What dimension of strategy this decision changes. */
    strategyChange: z.enum(RECOVERY_STRATEGY_DIMENSIONS),
    previousStrategy: recoveryStrategySchema.optional(),
    nextStrategy: recoveryStrategySchema.optional(),
    budgetSnapshot: budgetSnapshotSchema,
    evidenceRefs: z.array(shortText).max(RELIABILITY_LIMITS.maxEvidenceRefs).default([]),
    /**
     * What a human would need to do to unblock this task, when the action
     * stops automatic continuation. Bounded and actionable.
     */
    remediation: z.array(text).max(RELIABILITY_LIMITS.maxListItems).default([]),
    /**
     * Set when the action REQUESTS stronger execution. It is a requirement,
     * not an authorization: spend policy and the scheduler still decide
     * independently, and this field never bypasses either.
     */
    requestedCapability: z
      .object({
        /** 'STRONG' asks for stronger intelligence; 'REMOTE' asks for a paid lane. */
        kind: z.enum(['STRONG', 'REMOTE']),
        detail: text,
      })
      .passthrough()
      .optional(),
    /** True when the decision was persisted but its attempt has not run yet. */
    applied: z.boolean().default(false),
    createdAt: shortText,
  })
  .passthrough();
export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;

// ---------------------------------------------------------------------------
// Per-task reliability history
// ---------------------------------------------------------------------------

/**
 * One historical observation used by loop detection.
 *
 * Deliberately tiny and deliberately deterministic: two hashes, a strategy
 * key, and an outcome. Loop detection reads nothing else — no summaries, no
 * model similarity, nothing a worker could influence by describing its work
 * differently.
 */
export const reliabilityObservationSchema = z
  .object({
    attemptId: shortText,
    attemptNumber: z.number().int().min(1),
    failureFingerprint: shortText.nullable().default(null),
    diffFingerprint: shortText.nullable().default(null),
    strategyKey: shortText.nullable().default(null),
    evaluationStatus: z.enum(EVALUATION_STATUSES).nullable().default(null),
    lane: shortText.nullable().default(null),
    at: shortText,
  })
  .passthrough();
export type ReliabilityObservation = z.infer<typeof reliabilityObservationSchema>;

/**
 * Bounded per-task reliability history: the rolling window loop detection
 * and the recovery planner read.
 *
 * Bounded by construction (`maxFingerprintHistory`) so a long-running task
 * cannot grow this file without limit, and old entries roll off the front.
 * The counters beside the window are cumulative and never roll off — they
 * are what the later adaptive scheduler will need.
 */
export const taskReliabilityStateSchema = z
  .object({
    schemaVersion: semver,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    health: z.enum(EXECUTION_HEALTH_STATES).default('HEALTHY'),
    /** Rolling window, oldest first. */
    observations: z
      .array(reliabilityObservationSchema)
      .max(RELIABILITY_LIMITS.maxFingerprintHistory)
      .default([]),
    /** Strategy keys already tried and failed on this task. */
    exhaustedStrategies: z.array(shortText).max(RELIABILITY_LIMITS.maxListItems).default([]),
    /** Cumulative counters — the raw material for cost-of-failure analysis. */
    evaluationsFailed: z.number().int().min(0).default(0),
    evaluationsInconclusive: z.number().int().min(0).default(0),
    stagnationEvents: z.number().int().min(0).default(0),
    oscillationEvents: z.number().int().min(0).default(0),
    runawayEvents: z.number().int().min(0).default(0),
    freshContextRestarts: z.number().int().min(0).default(0),
    /** Wall time and spend consumed by attempts that did NOT complete. */
    failedAttemptMs: z.number().int().min(0).default(0),
    failedAttemptTokens: z.number().int().min(0).nullable().default(null),
    failedAttemptCostUsd: z.number().min(0).nullable().default(null),
    /** The decision the task is currently acting on, when one is pending. */
    pendingDecisionId: shortText.optional(),
    updatedAt: shortText,
  })
  .passthrough();
export type TaskReliabilityState = z.infer<typeof taskReliabilityStateSchema>;

export const TASK_RELIABILITY_SCHEMA_VERSION = '1.0.0';
