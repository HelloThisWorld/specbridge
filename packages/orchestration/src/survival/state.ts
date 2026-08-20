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
    /** Scheduling lane, when a later phase assigns one. */
    lane: shortText.optional(),
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
    metrics: attemptMetricsSchema,
  })
  .passthrough();
export type ExecutionLedgerEntry = z.infer<typeof executionLedgerEntrySchema>;
