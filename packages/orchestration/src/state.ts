import { z } from 'zod';
import {
  ACTION_CATEGORIES,
  FAILURE_CATEGORIES,
  INTENT_OUTCOMES,
  OBSERVATION_RESULTS,
  ORCHESTRATION_PHASES,
  PLAN_STALENESS_REASONS,
  PROVENANCE_KINDS,
} from './vocabulary.js';

/**
 * Persisted orchestration state (`.specbridge/orchestration/<id>/state.json`).
 *
 * Versioned from day one. Unknown fields survive via passthrough so a newer
 * SpecBridge writing an additive field does not make the record unreadable to
 * an older one, and an unknown MAJOR version is refused rather than coerced.
 *
 * What is deliberately NOT in here:
 *   - model reasoning of any kind, in any field
 *   - prompts, transcripts, or conversation history
 *   - source file contents
 *   - environment values or anything credential-shaped
 *
 * Records are structured *decisions and provenance*, which are auditable, not
 * private chain-of-thought, which is neither auditable nor safe to retain.
 */

export const ORCHESTRATION_STATE_SCHEMA_VERSION = '1.0.0';

/** Bounds applied at the schema level, independent of policy bounds. */
export const STATE_LIMITS = {
  maxGoalChars: 4_000,
  maxTextChars: 2_000,
  maxShortTextChars: 512,
  maxListItems: 50,
  maxDecisions: 100,
  maxQuestions: 40,
  maxInteractiveRuns: 200,
} as const;

const shortText = z.string().max(STATE_LIMITS.maxShortTextChars);
const text = z.string().max(STATE_LIMITS.maxTextChars);
const textList = z.array(text).max(STATE_LIMITS.maxListItems);

/**
 * One clarification question. Targeted by construction: a question must name
 * the decision it unblocks and why the answer changes the implementation.
 */
export const clarificationQuestionSchema = z
  .object({
    id: shortText,
    question: text,
    /** Why this cannot be inferred safely — the justification for asking. */
    whyItMatters: text,
    /** Candidate answers, when the choice is genuinely closed. */
    options: z.array(text).max(10).default([]),
    /** Spec stage / task this question concerns, when applicable. */
    relatedTaskId: shortText.optional(),
    askedAt: shortText,
    round: z.number().int().min(1),
    /**
     * Contract change requests this question is waiting on, when it is one
     * of those.
     *
     * A question that says "CCR-001 awaits a human decision" is ANSWERED by
     * that decision — there is no second answer to give. Recorded so a resume
     * can ask whether it happened; without it the link lives only in the
     * question's prose and nothing can reconcile it, so approving the change
     * request leaves the job wedged on a question it already satisfied.
     */
    awaitingCcrIds: z.array(shortText).max(20).optional(),
  })
  .passthrough();
export type ClarificationQuestion = z.infer<typeof clarificationQuestionSchema>;

/**
 * One resolved decision. This is the durable artefact of a clarification:
 * the question, the answer, and where the answer came from — never the
 * deliberation that produced it.
 */
export const clarificationDecisionSchema = z
  .object({
    id: shortText,
    questionId: shortText,
    question: text,
    answer: text,
    /** Structural provenance, not a confidence number. */
    source: z.enum(PROVENANCE_KINDS),
    relatedSpecName: shortText.optional(),
    relatedTaskId: shortText.optional(),
    decidedAt: shortText,
    /** The decision this one replaces, when a user changed their mind. */
    supersedes: shortText.optional(),
    /** What this decision changes about the implementation. */
    impact: text.optional(),
  })
  .passthrough();
export type ClarificationDecision = z.infer<typeof clarificationDecisionSchema>;

/**
 * The recorded result of assessing intent.
 *
 * Natural-language understanding comes from the host agent; this record is
 * the *structured* result, which the deterministic core then validates and
 * may override (an agent cannot talk its way past a structural blocker).
 */
export const intentAssessmentSchema = z
  .object({
    outcome: z.enum(INTENT_OUTCOMES),
    /** What the user asked for, restated in one bounded line. */
    summary: text,
    /** Machine-checkable reasons, never free-form reasoning. */
    reasons: textList.default([]),
    /** Facts relied on, with provenance. */
    provenance: z
      .array(
        z
          .object({
            fact: text,
            source: z.enum(PROVENANCE_KINDS),
            reference: shortText.optional(),
          })
          .passthrough(),
      )
      .max(STATE_LIMITS.maxListItems)
      .default([]),
    assessedAt: shortText,
    /** Present when the deterministic core overrode the submitted outcome. */
    overriddenFrom: z.enum(INTENT_OUTCOMES).optional(),
    overrideReason: text.optional(),
  })
  .passthrough();
export type IntentAssessment = z.infer<typeof intentAssessmentSchema>;

/** The context an execution plan is bound to; staleness is measured against it. */
export const planBindingSchema = z
  .object({
    taskId: shortText,
    taskFingerprint: shortText,
    /** Approved stage hashes at plan time, keyed by stage name. */
    approvedStageHashes: z.record(shortText).default({}),
    /** Git HEAD at plan time; absent in a repository with no commits. */
    gitHead: shortText.optional(),
    /** Fingerprint of the orchestration policy the plan was made under. */
    policyFingerprint: z.string().max(4_000),
  })
  .passthrough();
export type PlanBinding = z.infer<typeof planBindingSchema>;

export const planStepSchema = z
  .object({
    id: shortText,
    description: text,
    /** Expected implementation area. Planning information, not a fact. */
    expectedAreas: z.array(shortText).max(20).default([]),
    /** What observable evidence would show this step succeeded. */
    expectedEvidence: text.optional(),
    status: z.enum(['pending', 'in-progress', 'done', 'skipped']).default('pending'),
  })
  .passthrough();
export type PlanStep = z.infer<typeof planStepSchema>;

export const EXECUTION_PLAN_SCHEMA_VERSION = '1.0.0';

/**
 * An execution plan: how the *already approved* task will be approached in
 * the *current* repository state. Distinct from `tasks.md`, which defines
 * which tasks exist and is a `.kiro` artefact under human approval.
 */
export const executionPlanSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    planId: shortText,
    revision: z.number().int().min(1),
    specName: shortText,
    createdAt: shortText,
    binding: planBindingSchema,
    goal: text,
    nonGoals: textList.default([]),
    constraints: textList.default([]),
    /** Repository facts the plan relies on, with provenance. */
    relevantEvidence: textList.default([]),
    /** Explicitly labelled assumptions — never presented as facts. */
    assumptions: textList.default([]),
    openQuestions: textList.default([]),
    expectedAreas: z.array(shortText).max(STATE_LIMITS.maxListItems).default([]),
    steps: z.array(planStepSchema).min(1).max(200),
    testStrategy: text,
    verificationStrategy: text,
    rollbackConsiderations: text.optional(),
    /** Conditions that should trigger an explicit replan. */
    replanTriggers: textList.default([]),
    /** The plan this revision supersedes. */
    supersedes: shortText.optional(),
    /** Why the previous plan was replaced. */
    replanReason: text.optional(),
  })
  .passthrough();
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

export const planReviewSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    /** Hash of the exact plan reviewed — a later plan cannot inherit it. */
    planHash: shortText,
    planRevision: z.number().int().min(1),
    reviewedAt: shortText,
    /**
     * How the review reached SpecBridge. `user-relayed` means a host agent
     * reported the user's decision: contract-enforced, not hard-enforced.
     * See docs/orchestration/enforcement-boundaries.md.
     */
    channel: z.enum(['user-relayed', 'cli']).default('user-relayed'),
    note: text.optional(),
  })
  .passthrough();
export type PlanReview = z.infer<typeof planReviewSchema>;

/** Deterministic identity of the observed world after an action. */
export const observationFingerprintSchema = z
  .object({
    /** Identity of the last classified failure, when there was one. */
    failureFingerprint: shortText.optional(),
    /** Identity of the working-tree change set. */
    diffFingerprint: shortText.optional(),
    changedFileCount: z.number().int().min(0).default(0),
    actionCategory: z.enum(ACTION_CATEGORIES),
    planRevision: z.number().int().min(0),
    result: z.enum(OBSERVATION_RESULTS),
  })
  .passthrough();
export type ObservationFingerprint = z.infer<typeof observationFingerprintSchema>;

export const orchestrationBlockerSchema = z
  .object({
    category: z.enum(FAILURE_CATEGORIES),
    code: shortText,
    message: text,
    remediation: textList.default([]),
    at: shortText,
  })
  .passthrough();
export type OrchestrationBlocker = z.infer<typeof orchestrationBlockerSchema>;

export const orchestrationCountersSchema = z
  .object({
    iterations: z.number().int().min(0).default(0),
    repairCycles: z.number().int().min(0).default(0),
    replans: z.number().int().min(0).default(0),
    transientRetries: z.number().int().min(0).default(0),
    consecutiveNoProgress: z.number().int().min(0).default(0),
    clarificationRounds: z.number().int().min(0).default(0),
    events: z.number().int().min(0).default(0),
  })
  .passthrough();
export type OrchestrationCounters = z.infer<typeof orchestrationCountersSchema>;

/**
 * The budget snapshot a run is executing under.
 *
 * Recorded at start so a resumed run enforces the bounds it was created with,
 * and can say honestly that the configured policy changed rather than quietly
 * applying different limits than the ones the plan was reviewed under.
 */
export const orchestrationBudgetsSchema = z
  .object({
    maxIterations: z.number().int().min(1),
    maxRepairCycles: z.number().int().min(0),
    maxReplans: z.number().int().min(0),
    maxNoProgressCycles: z.number().int().min(1),
    maxTransientRetries: z.number().int().min(0),
    maxClarificationRounds: z.number().int().min(1),
    maxElapsedMs: z.number().int().min(1),
    maxEvents: z.number().int().min(1),
  })
  .passthrough();
export type OrchestrationBudgets = z.infer<typeof orchestrationBudgetsSchema>;

export const orchestrationStateSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    orchestrationId: shortText,
    specName: shortText,
    taskId: shortText.optional(),
    phase: z.enum(ORCHESTRATION_PHASES),
    /** The user's stated goal, verbatim and bounded. Data, not instructions. */
    goal: z.string().max(STATE_LIMITS.maxGoalChars),
    createdAt: shortText,
    updatedAt: shortText,
    /** Label of the host driving the run (e.g. "mcp", "cli"). */
    host: shortText,
    planningMode: z.enum(['review', 'auto', 'disabled']),
    policyFingerprint: z.string().max(4_000),
    budgets: orchestrationBudgetsSchema,
    counters: orchestrationCountersSchema.default({}),
    intent: intentAssessmentSchema.optional(),
    openQuestions: z.array(clarificationQuestionSchema).max(STATE_LIMITS.maxQuestions).default([]),
    decisions: z.array(clarificationDecisionSchema).max(STATE_LIMITS.maxDecisions).default([]),
    /** Revision number of the active plan; 0 when none exists. */
    planRevision: z.number().int().min(0).default(0),
    activePlanId: shortText.optional(),
    activePlanHash: shortText.optional(),
    planReview: planReviewSchema.optional(),
    planStaleReasons: z.array(z.enum(PLAN_STALENESS_REASONS)).max(10).default([]),
    /** Interactive execution runs this orchestration has driven, in order. */
    interactiveRunIds: z.array(shortText).max(STATE_LIMITS.maxInteractiveRuns).default([]),
    activeInteractiveRunId: shortText.optional(),
    lastObservation: observationFingerprintSchema.optional(),
    /** Fingerprint of the failure the current repair cycle is addressing. */
    repairTargetFingerprint: shortText.optional(),
    blocker: orchestrationBlockerSchema.optional(),
    /** Set exactly once, when the run reaches a final phase. */
    finalizedAt: shortText.optional(),
    finalOutcome: shortText.optional(),
  })
  .passthrough();
export type OrchestrationState = z.infer<typeof orchestrationStateSchema>;

export const ORCHESTRATION_CHECKPOINT_SCHEMA_VERSION = '1.0.0';

/**
 * A compact structured checkpoint. Deliberately small: it captures what a
 * *fresh* session needs in order to continue honestly — never a transcript,
 * and never a claim to remember the previous session's reasoning.
 */
export const orchestrationCheckpointSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    orchestrationId: shortText,
    createdAt: shortText,
    specName: shortText,
    taskId: shortText.optional(),
    phase: z.enum(ORCHESTRATION_PHASES),
    planRevision: z.number().int().min(0),
    completedSteps: z.array(shortText).max(200).default([]),
    unresolvedSteps: z.array(shortText).max(200).default([]),
    observations: textList.default([]),
    latestVerifier: text.optional(),
    counters: orchestrationCountersSchema,
    budgets: orchestrationBudgetsSchema,
    blocker: orchestrationBlockerSchema.optional(),
    /** The exact next safe action, in one line. */
    nextAction: text,
  })
  .passthrough();
export type OrchestrationCheckpoint = z.infer<typeof orchestrationCheckpointSchema>;
