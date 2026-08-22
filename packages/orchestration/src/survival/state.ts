import { z } from 'zod';
import { FAILURE_CATEGORIES } from '../vocabulary.js';
import { STATE_LIMITS } from '../state.js';
import { AGENT_ROLES } from '../jobs/vocabulary.js';
import { TASK_ATTEMPT_STATUSES, TASK_CHECKPOINT_REASONS } from './vocabulary.js';

/**
 * Survival-runtime state (vNext.1): durable ExecutionAttempts and structured
 * task Checkpoints, persisted under `.specbridge/jobs/<jobId>/`.
 *
 * The invariant this file exists to uphold:
 *
 *   Agents and model sessions are disposable workers.
 *   SpecBridge owns the durable job state.
 *
 * Three concepts, deliberately distinct and never conflated:
 *
 *   Job              (jobs/state.ts)  the long-horizon user objective
 *   Task             (JobNode)        durable intended work, bound to one
 *                                     approved task
 *   ExecutionAttempt (here)           ONE temporary attempt by ONE
 *                                     worker/provider to perform that Task
 *
 * A Task remains valid when every associated agent session disappears; an
 * attempt record survives its worker. Attempts are append-only history:
 * retrying or switching providers creates a NEW attempt, never rewrites a
 * previous one.
 *
 * Deliberately NOT representable here, structurally: model reasoning,
 * prompts, transcripts, conversation history, source file contents, or
 * anything credential-shaped — the same exclusions the job state enforces.
 */

export const TASK_ATTEMPT_SCHEMA_VERSION = '1.0.0';
export const TASK_CHECKPOINT_SCHEMA_VERSION = '1.0.0';

export const SURVIVAL_LIMITS = {
  maxListItems: 50,
  maxChangedFiles: 500,
  maxTextChars: 2_000,
  maxShortTextChars: STATE_LIMITS.maxShortTextChars,
  maxCheckpointsPerTask: 500,
} as const;

const shortText = z.string().min(1).max(SURVIVAL_LIMITS.maxShortTextChars);
const text = z.string().min(1).max(SURVIVAL_LIMITS.maxTextChars);
const textList = z.array(text).max(SURVIVAL_LIMITS.maxListItems);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

// ---------------------------------------------------------------------------
// ExecutionAttempt
// ---------------------------------------------------------------------------

/**
 * Basic execution metrics for one attempt — the ExecutionLedger's raw
 * material. Every field tolerates absence: a provider that reports nothing
 * still executes, and SpecBridge never fabricates a metric it was not given.
 */
export const attemptMetricsSchema = z
  .object({
    durationMs: z.number().int().min(0).nullable().default(null),
    inputTokens: z.number().int().min(0).nullable().default(null),
    outputTokens: z.number().int().min(0).nullable().default(null),
    cachedTokens: z.number().int().min(0).nullable().default(null),
    toolCalls: z.number().int().min(0).nullable().default(null),
    filesRead: z.number().int().min(0).nullable().default(null),
    filesChanged: z.number().int().min(0).nullable().default(null),
    /** Provider-REPORTED cost only; never computed from a price table. */
    costUsd: z.number().min(0).nullable().default(null),
    // vNext.2 quota/context telemetry (additive; every field tolerates
    // absence — telemetry that was not observed is null, never fabricated).
    /** Five-hour window remaining ratio observed at dispatch start. */
    fiveHourQuotaBefore: z.number().min(0).max(1).nullable().default(null),
    /** Five-hour window remaining ratio observed after completion. */
    fiveHourQuotaAfter: z.number().min(0).max(1).nullable().default(null),
    weeklyQuotaBefore: z.number().min(0).max(1).nullable().default(null),
    weeklyQuotaAfter: z.number().min(0).max(1).nullable().default(null),
    /** Estimated context occupancy ratio before/after, when measured. */
    contextUsageBefore: z.number().min(0).nullable().default(null),
    contextUsageAfter: z.number().min(0).nullable().default(null),
    /** Verification/test loops the attempt ran, when reported. */
    testLoops: z.number().int().min(0).nullable().default(null),
    // vNext.4 local agentic runtime telemetry (additive; unobservable stays
    // null — a fabricated zero would corrupt the direct-vs-harness
    // comparison this phase exists to make possible).
    /** Shell/command runs the attempt performed, when observable. */
    commandRuns: z.number().int().min(0).nullable().default(null),
    /** Provider-native context compactions observed during the attempt. */
    compactions: z.number().int().min(0).nullable().default(null),
    // vNext.5 API economics (additive). Estimated and observed cost are
    // separate fields on purpose: an estimate is never overwritten by an
    // invented "actual", and an attempt whose real usage is unknowable
    // keeps a null reconciled cost rather than a fabricated zero.
    /** Safe pre-dispatch cost estimate, in USD. Null outside the API lane. */
    estimatedCostUsd: z.number().min(0).nullable().default(null),
    /** Budget held for this attempt at dispatch time, in USD. */
    reservedCostUsd: z.number().min(0).nullable().default(null),
    /** Observed/computed cost after the attempt. Null means UNKNOWN, not free. */
    reconciledCostUsd: z.number().min(0).nullable().default(null),
  })
  .passthrough();
export type AttemptMetrics = z.infer<typeof attemptMetricsSchema>;

/**
 * One durable execution attempt: one disposable worker run against one Task.
 *
 * Written when the dispatch STARTS (status RUNNING) so that a process crash
 * leaves evidence; finalized when it ends; reconciled to INTERRUPTED by
 * resume when the owning process disappeared. Historical attempts are part
 * of the durable execution record — they are never overwritten or deleted.
 */
export const taskAttemptSchema = z
  .object({
    schemaVersion: semver,
    attemptId: shortText,
    jobId: shortText,
    /** Runtime graph node this attempt executes (the Task's runtime identity). */
    nodeId: shortText,
    /** The approved task id (stable across graph revisions). */
    taskId: shortText,
    role: z.enum(AGENT_ROLES),
    /** Worker identity as the scheduler assigned it. */
    workerId: shortText,
    /**
     * Provider identity (runner/profile name). Identity is recorded for the
     * ledger and for audit — runtime logic branches on capabilities, never
     * on this value.
     */
    provider: shortText,
    /** Model identity when known; null when the provider does not say. */
    model: shortText.nullable().default(null),
    status: z.enum(TASK_ATTEMPT_STATUSES),
    /** 1-based position within this task's attempt history. */
    attemptNumber: z.number().int().min(1),
    startedAt: shortText,
    completedAt: shortText.optional(),
    /** Bounded outcome summary — a claim, never evidence. */
    resultSummary: text.optional(),
    failure: z
      .object({
        category: z.enum(FAILURE_CATEGORIES),
        message: text,
      })
      .passthrough()
      .optional(),
    /** Why an INTERRUPTED attempt was reconciled (e.g. "process-restart"). */
    interruptedReason: shortText.optional(),
    /** Task checkpoints persisted during this attempt, oldest first. */
    checkpointIds: z.array(shortText).max(SURVIVAL_LIMITS.maxListItems).default([]),
    /** Execution run id (`.specbridge/runs/<id>`) when the evidence path ran. */
    runId: shortText.optional(),
    /** The interrupted/failed attempt this one continues from (lineage). */
    resumedFromAttemptId: shortText.optional(),
    /** Provider session reference — WORKING MEMORY only, never canonical. */
    providerSessionId: shortText.optional(),
    /** Scheduling lane (vNext.2: LOCAL / SUBSCRIPTION), when assigned. */
    lane: shortText.optional(),
    // vNext.2 scheduling attribution (additive; audit and ledger inputs,
    // never runtime policy — policy reads live configuration and telemetry).
    /** Deterministic local-suitability class the scheduler assigned. */
    localSuitability: shortText.optional(),
    /** Complexity class the task carried when the attempt was scheduled. */
    taskComplexity: shortText.optional(),
    /** Coarse task category from the suitability classifier. */
    taskCategory: shortText.optional(),
    /** The SchedulingDecision that routed this attempt, when one exists. */
    schedulingDecisionId: shortText.optional(),
    // vNext.4 local execution attribution (additive; absent on pre-vNext.4
    // attempts and on every SUBSCRIPTION attempt).
    /** LOCAL execution mode: DIRECT_MODEL or HARNESS. Orthogonal to lane. */
    executionMode: shortText.optional(),
    /** Deterministic execution shape the resolver classified. */
    executionShape: shortText.optional(),
    /** Verified compute locality of the runner that executed this attempt. */
    computeLocality: shortText.optional(),
    // vNext.5 API-lane attribution (additive; absent on every LOCAL and
    // SUBSCRIPTION attempt and on every pre-vNext.5 record). Each field is
    // ORTHOGONAL: `lane` says whether this was paid, `provider`/`model` say
    // which intelligence ran it, `executionMode`/`computeLocality` say how
    // and where. Nothing is ever collapsed into a compound value.
    /** The spend authorization mode in force when the attempt was dispatched. */
    apiSpendMode: shortText.optional(),
    /** Why subscription capacity was unavailable (the gap's cause). */
    gapReason: shortText.optional(),
    /** When subscription capacity was expected back, when known. */
    subscriptionAvailableAt: shortText.optional(),
    /** Expected gap duration in milliseconds, when known. */
    estimatedGapDurationMs: z.number().int().min(0).nullable().default(null).optional(),
    /** How the recorded cost was determined (see API_COST_SOURCES). */
    costSource: shortText.optional(),
    /** Operator pricing profile the estimate used, for attribution. */
    pricingProfile: shortText.optional(),
    /** The budget reservation funding this attempt. */
    apiBudgetReservationId: shortText.optional(),
    /** The bounded human authorization this attempt consumed, when one applied. */
    apiApprovalId: shortText.optional(),
    /** Deterministic delay-sensitivity level that justified paid bridging. */
    delaySensitivity: shortText.optional(),
    metrics: attemptMetricsSchema.default({}),
  })
  .passthrough();
export type TaskAttempt = z.infer<typeof taskAttemptSchema>;

// ---------------------------------------------------------------------------
// Task checkpoints
// ---------------------------------------------------------------------------

/** One recorded execution decision (implementation truth, not clarification). */
export const checkpointDecisionSchema = z
  .object({
    decision: text,
    rationale: text.optional(),
    at: shortText.optional(),
    decidedBy: shortText.optional(),
  })
  .passthrough();
export type CheckpointDecision = z.infer<typeof checkpointDecisionSchema>;

/**
 * One approach that was tried and did not work. The single most valuable
 * thing one worker can leave the next: the next attempt must not waste
 * context and execution time rediscovering the same failure.
 */
export const failedApproachSchema = z
  .object({
    approach: text,
    reason: text,
    at: shortText.optional(),
    /** Evidence reference (run id, test name) backing the failure claim. */
    evidenceRef: shortText.optional(),
  })
  .passthrough();
export type FailedApproach = z.infer<typeof failedApproachSchema>;

export const checkpointTestResultSchema = z
  .object({
    name: shortText,
    status: z.enum(['passed', 'failed', 'skipped', 'unknown']),
    summary: text.optional(),
  })
  .passthrough();
export type CheckpointTestResult = z.infer<typeof checkpointTestResultSchema>;

/**
 * Repository grounding: enough Git/workspace state that a future worker can
 * answer "what state am I continuing from?" without the previous agent
 * conversation. A checkpoint never REQUIRES a commit — it records what is.
 */
export const checkpointRepositoryStateSchema = z
  .object({
    branch: shortText.optional(),
    head: shortText.optional(),
    detached: z.boolean().optional(),
    clean: z.boolean().optional(),
    /** Paths dirty at checkpoint time (bounded; the diff itself lives in runs/). */
    dirtyPaths: z.array(shortText).max(SURVIVAL_LIMITS.maxChangedFiles).default([]),
    /** Reference to a stored diff artifact, when one exists. */
    diffRef: shortText.optional(),
    /** The commit execution started from, when known. */
    baselineHead: shortText.optional(),
  })
  .passthrough();
export type CheckpointRepositoryState = z.infer<typeof checkpointRepositoryStateSchema>;

/**
 * Pinned context: what must NEVER disappear because of compaction. When any
 * worker's context is rebuilt, these fields are re-injected
 * deterministically — they are immune to summarization by construction,
 * because reconstruction reads them from here, not from any conversation.
 */
export const checkpointPinnedContextSchema = z
  .object({
    /** The task contract: what this task IS, verbatim and bounded. */
    taskContract: text,
    acceptanceCriteria: textList.default([]),
    /** Architecture/repository rules constraining every attempt. */
    constraints: textList.default([]),
    /** Critical invariants that override any convenient shortcut. */
    invariants: textList.default([]),
  })
  .passthrough();
export type CheckpointPinnedContext = z.infer<typeof checkpointPinnedContextSchema>;

/**
 * A structured task checkpoint: the durable handoff document. NOT a
 * natural-language summary — a schema another worker (or another provider)
 * can continue from without the previous worker's conversation.
 *
 * Checkpoints are append-only revisions per task; the latest one is the
 * resume point, and history is never rewritten.
 */
export const taskCheckpointSchema = z
  .object({
    schemaVersion: semver,
    checkpointId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    /** The attempt that persisted this checkpoint. */
    attemptId: shortText,
    /** 1-based, strictly increasing per task. */
    seq: z.number().int().min(1),
    reason: z.enum(TASK_CHECKPOINT_REASONS),
    /** What this task is trying to achieve right now. */
    objective: text,
    pinned: checkpointPinnedContextSchema,
    completedWork: textList.default([]),
    pendingWork: textList.default([]),
    importantDecisions: z.array(checkpointDecisionSchema).max(SURVIVAL_LIMITS.maxListItems).default([]),
    failedApproaches: z.array(failedApproachSchema).max(SURVIVAL_LIMITS.maxListItems).default([]),
    changedFiles: z
      .array(
        z
          .object({ path: shortText, note: shortText.optional() })
          .passthrough(),
      )
      .max(SURVIVAL_LIMITS.maxChangedFiles)
      .default([]),
    repositoryState: checkpointRepositoryStateSchema.default({}),
    testResults: z.array(checkpointTestResultSchema).max(SURVIVAL_LIMITS.maxListItems).default([]),
    knownFailures: textList.default([]),
    unresolvedIssues: textList.default([]),
    /** The exact next actions, in order. Resume continues from here. */
    nextActions: z.array(text).min(1).max(SURVIVAL_LIMITS.maxListItems),
    /** Artifact references (run ids, agent results, candidate refs). */
    relevantArtifacts: z.array(shortText).max(SURVIVAL_LIMITS.maxListItems).default([]),
    /** Context references worth re-retrieving (paths, docs), never content. */
    relevantContextReferences: z.array(shortText).max(SURVIVAL_LIMITS.maxListItems).default([]),
    createdAt: shortText,
  })
  .passthrough();
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;

// ---------------------------------------------------------------------------
// Execution ledger
// ---------------------------------------------------------------------------

/**
 * One normalized ledger entry derived from a durable attempt record. The
 * ledger is a READ model: attempts are the source of truth, and entries
 * tolerate unknown metrics — missing provider data never blocks execution
 * and never becomes a fabricated number.
 */
export const executionLedgerEntrySchema = z
  .object({
    attemptId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    role: z.enum(AGENT_ROLES),
    provider: shortText,
    model: shortText.nullable(),
    lane: shortText.nullable(),
    status: z.enum(TASK_ATTEMPT_STATUSES),
    attemptNumber: z.number().int().min(1),
    startedAt: shortText,
    completedAt: shortText.nullable(),
    success: z.boolean(),
    failureReason: shortText.nullable(),
    // vNext.2 scheduling attribution (additive; null when never assigned).
    localSuitability: shortText.nullable().default(null),
    taskComplexity: shortText.nullable().default(null),
    taskCategory: shortText.nullable().default(null),
    schedulingDecisionId: shortText.nullable().default(null),
    // vNext.4 local execution attribution (additive; null when unassigned).
    executionMode: shortText.nullable().default(null),
    executionShape: shortText.nullable().default(null),
    computeLocality: shortText.nullable().default(null),
    // vNext.5 API economics (additive; null on every unpaid attempt). These
    // are what makes later analysis possible without a second database:
    // cost per successful task, cost by task type, bridge success rate, and
    // money spent versus subscription wait avoided all derive from here.
    apiSpendMode: shortText.nullable().default(null),
    gapReason: shortText.nullable().default(null),
    subscriptionAvailableAt: shortText.nullable().default(null),
    estimatedGapDurationMs: z.number().int().min(0).nullable().default(null),
    costSource: shortText.nullable().default(null),
    pricingProfile: shortText.nullable().default(null),
    apiBudgetReservationId: shortText.nullable().default(null),
    apiApprovalId: shortText.nullable().default(null),
    delaySensitivity: shortText.nullable().default(null),
    // vNext.6 reliability attribution (additive; null on every pre-vNext.6
    // record and on any attempt the reliability layer did not govern).
    //
    // These are the raw facts a later adaptive scheduler needs in order to
    // compute what failure actually COSTS: attempts per successful task,
    // failed-token and failed-quota ratios, dollars spent on attempts that
    // never verified, time to recovery, replan success rate. Collected now,
    // deliberately un-aggregated — an analytics store that decided in advance
    // which questions were worth asking would foreclose the ones that turn
    // out to matter.
    /** Verdict on this attempt: PASS / FAIL / INCONCLUSIVE. */
    evaluationStatus: shortText.nullable().default(null),
    evaluationId: shortText.nullable().default(null),
    /** WHERE the failure came from, orthogonal to `failureReason`. */
    failureSource: shortText.nullable().default(null),
    /** Deterministic failure identity, for cross-attempt repetition analysis. */
    failureFingerprint: shortText.nullable().default(null),
    /** Deterministic progress health at the time of the failure. */
    executionHealth: shortText.nullable().default(null),
    /** The recovery action SpecBridge chose after this attempt. */
    recoveryAction: shortText.nullable().default(null),
    recoveryReasonCode: shortText.nullable().default(null),
    recoveryDecisionId: shortText.nullable().default(null),
    /** Which dimension of strategy the recovery changed, if any. */
    strategyChange: shortText.nullable().default(null),
    metrics: attemptMetricsSchema,
  })
  .passthrough();
export type ExecutionLedgerEntry = z.infer<typeof executionLedgerEntrySchema>;
