import { randomUUID } from 'node:crypto';
import type { WorkspaceInfo } from '@specbridge/core';
import type { GitSnapshot } from '@specbridge/evidence';
import { OrchestrationError } from '../errors.js';
import type { FailureCategory } from '../vocabulary.js';
import type { AgentRole } from '../jobs/vocabulary.js';
import type {
  AttemptMetrics,
  CheckpointDecision,
  CheckpointPinnedContext,
  CheckpointRepositoryState,
  CheckpointTestResult,
  ExecutionLedgerEntry,
  FailedApproach,
  TaskAttempt,
  TaskCheckpoint,
} from './state.js';
import {
  TASK_ATTEMPT_SCHEMA_VERSION,
  TASK_CHECKPOINT_SCHEMA_VERSION,
  executionLedgerEntrySchema,
  taskCheckpointSchema,
} from './state.js';
import type { TaskAttemptStatus, TaskCheckpointReason } from './vocabulary.js';
import { isFinalAttemptStatus } from './vocabulary.js';
import {
  listTaskAttempts,
  listTaskCheckpointSeqs,
  nextAttemptNumber,
  readLatestTaskCheckpoint,
  readTaskAttempt,
  updateTaskAttempt,
  writeNewTaskAttempt,
  writeTaskCheckpoint,
} from './store.js';

/**
 * The survival service: durable ExecutionAttempt lifecycle, the
 * CheckpointManager, crash reconciliation, and the ExecutionLedger read
 * model.
 *
 * Design rules, enforced here and exercised by tests:
 *
 *   - an attempt is persisted BEFORE its work runs (status RUNNING), so a
 *     crash always leaves evidence;
 *   - a finished attempt is immutable: finalizing twice, or "resuming" a
 *     final attempt, is refused — continuation means a NEW attempt with
 *     lineage (`resumedFromAttemptId`), never a rewritten old one;
 *   - checkpoints are append-only revisions; the latest is the resume point;
 *   - metrics tolerate unknowns: a provider reporting nothing still runs.
 *
 * This module deliberately takes (workspace, clock) rather than full JobDeps:
 * it manages survival state only. Event-log integration lives with the job
 * service, which already owns event budgeting.
 */

export interface SurvivalDeps {
  workspace: WorkspaceInfo;
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
}

function now(deps: SurvivalDeps): string {
  return (deps.clock ?? (() => new Date()))().toISOString();
}

function newId(deps: SurvivalDeps): string {
  return (deps.idFactory ?? randomUUID)();
}

// ---------------------------------------------------------------------------
// Attempt lifecycle
// ---------------------------------------------------------------------------

export interface BeginTaskAttemptInput {
  jobId: string;
  nodeId: string;
  taskId: string;
  role: AgentRole;
  workerId: string;
  /** Provider identity (runner/profile name); audit and ledger, not policy. */
  provider: string;
  model?: string | undefined;
  runId?: string | undefined;
  providerSessionId?: string | undefined;
  /** The interrupted/failed attempt this one continues from. */
  resumedFromAttemptId?: string | undefined;
  /** vNext.2 scheduling attribution (all optional; recorded, never policy). */
  lane?: string | undefined;
  localSuitability?: string | undefined;
  taskComplexity?: string | undefined;
  taskCategory?: string | undefined;
  schedulingDecisionId?: string | undefined;
  /** Quota/context observations captured at dispatch start. */
  quotaBefore?:
    | { fiveHourRemainingRatio?: number | null | undefined; weeklyRemainingRatio?: number | null | undefined }
    | undefined;
  contextUsageBefore?: number | undefined;
}

/** Persist a new RUNNING attempt. This happens BEFORE any work is dispatched. */
export function beginTaskAttempt(deps: SurvivalDeps, input: BeginTaskAttemptInput): TaskAttempt {
  const attemptNumber = nextAttemptNumber(deps.workspace, input.jobId, input.nodeId);
  if (input.resumedFromAttemptId !== undefined) {
    const previous = readTaskAttempt(deps.workspace, input.jobId, input.resumedFromAttemptId);
    if (previous === undefined) {
      throw new OrchestrationError(
        'SBO049',
        `Attempt ${input.resumedFromAttemptId} does not exist; a resume must reference a recorded attempt.`,
      );
    }
    if (!isFinalAttemptStatus(previous.status)) {
      throw new OrchestrationError(
        'SBO049',
        `Attempt ${input.resumedFromAttemptId} is still ${previous.status}; reconcile it before resuming.`,
      );
    }
  }
  const attempt: TaskAttempt = {
    schemaVersion: TASK_ATTEMPT_SCHEMA_VERSION,
    // The generated id is used in full: truncating it could alias two ids
    // from a deterministic factory, and append-only storage refuses aliases.
    attemptId: `ta-${String(attemptNumber).padStart(4, '0')}-${newId(deps)}`.slice(0, 64),
    jobId: input.jobId,
    nodeId: input.nodeId,
    taskId: input.taskId,
    role: input.role,
    workerId: input.workerId,
    provider: input.provider,
    model: input.model ?? null,
    status: 'RUNNING',
    attemptNumber,
    startedAt: now(deps),
    checkpointIds: [],
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.providerSessionId !== undefined ? { providerSessionId: input.providerSessionId } : {}),
    ...(input.resumedFromAttemptId !== undefined
      ? { resumedFromAttemptId: input.resumedFromAttemptId }
      : {}),
    ...(input.lane !== undefined ? { lane: input.lane } : {}),
    ...(input.localSuitability !== undefined ? { localSuitability: input.localSuitability } : {}),
    ...(input.taskComplexity !== undefined ? { taskComplexity: input.taskComplexity } : {}),
    ...(input.taskCategory !== undefined ? { taskCategory: input.taskCategory } : {}),
    ...(input.schedulingDecisionId !== undefined
      ? { schedulingDecisionId: input.schedulingDecisionId }
      : {}),
    metrics: {
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      toolCalls: null,
      filesRead: null,
      filesChanged: null,
      costUsd: null,
      fiveHourQuotaBefore: input.quotaBefore?.fiveHourRemainingRatio ?? null,
      fiveHourQuotaAfter: null,
      weeklyQuotaBefore: input.quotaBefore?.weeklyRemainingRatio ?? null,
      weeklyQuotaAfter: null,
      contextUsageBefore: input.contextUsageBefore ?? null,
      contextUsageAfter: null,
      testLoops: null,
    },
  };
  return writeNewTaskAttempt(deps.workspace, attempt);
}

export interface CompleteTaskAttemptInput {
  jobId: string;
  attemptId: string;
  status: Extract<TaskAttemptStatus, 'COMPLETED' | 'FAILED' | 'CANCELLED'>;
  resultSummary?: string | undefined;
  failure?: { category: FailureCategory; message: string } | undefined;
  runId?: string | undefined;
  /** Whatever the provider reported; unknown fields stay null. */
  metrics?: Partial<AttemptMetrics> | undefined;
}

function requireOpenAttempt(deps: SurvivalDeps, jobId: string, attemptId: string): TaskAttempt {
  const attempt = readTaskAttempt(deps.workspace, jobId, attemptId);
  if (attempt === undefined) {
    throw new OrchestrationError('SBO049', `Attempt ${attemptId} of job ${jobId} was not found.`);
  }
  if (isFinalAttemptStatus(attempt.status)) {
    throw new OrchestrationError(
      'SBO049',
      `Attempt ${attemptId} is already ${attempt.status}; finished attempts are immutable history.`,
      { remediation: ['Begin a new attempt (with resumedFromAttemptId lineage) to continue the task.'] },
    );
  }
  return attempt;
}

/** Finalize a RUNNING attempt. Duration derives from recorded timestamps. */
export function completeTaskAttempt(deps: SurvivalDeps, input: CompleteTaskAttemptInput): TaskAttempt {
  const attempt = requireOpenAttempt(deps, input.jobId, input.attemptId);
  const completedAt = now(deps);
  const derivedDuration = Math.max(0, Date.parse(completedAt) - Date.parse(attempt.startedAt));
  const finalized: TaskAttempt = {
    ...attempt,
    status: input.status,
    completedAt,
    ...(input.resultSummary !== undefined ? { resultSummary: input.resultSummary.slice(0, 2_000) } : {}),
    ...(input.failure !== undefined
      ? { failure: { category: input.failure.category, message: input.failure.message.slice(0, 2_000) } }
      : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    metrics: {
      ...attempt.metrics,
      ...(Number.isFinite(derivedDuration) ? { durationMs: derivedDuration } : {}),
      ...(input.metrics ?? {}),
    },
  };
  return updateTaskAttempt(deps.workspace, finalized);
}

/**
 * Reconcile attempts persisted as RUNNING whose process no longer exists.
 * Called by resume: a fresh process has no live dispatch, so every RUNNING
 * record is, by definition, an interrupted one. The record stays as
 * historical evidence; continuation is a NEW attempt.
 */
export function reconcileInterruptedAttempts(
  deps: SurvivalDeps,
  jobId: string,
  reason = 'process-restart',
): TaskAttempt[] {
  const running = listTaskAttempts(deps.workspace, jobId, { status: 'RUNNING' });
  const reconciled: TaskAttempt[] = [];
  for (const attempt of running) {
    const interrupted: TaskAttempt = {
      ...attempt,
      status: 'INTERRUPTED',
      completedAt: now(deps),
      interruptedReason: reason,
    };
    reconciled.push(updateTaskAttempt(deps.workspace, interrupted));
  }
  return reconciled;
}

// ---------------------------------------------------------------------------
// CheckpointManager
// ---------------------------------------------------------------------------

export interface CreateTaskCheckpointInput {
  jobId: string;
  nodeId: string;
  taskId: string;
  attemptId: string;
  reason: TaskCheckpointReason;
  objective: string;
  pinned: CheckpointPinnedContext;
  completedWork?: string[] | undefined;
  pendingWork?: string[] | undefined;
  importantDecisions?: CheckpointDecision[] | undefined;
  failedApproaches?: FailedApproach[] | undefined;
  changedFiles?: { path: string; note?: string | undefined }[] | undefined;
  repositoryState?: CheckpointRepositoryState | undefined;
  testResults?: CheckpointTestResult[] | undefined;
  knownFailures?: string[] | undefined;
  unresolvedIssues?: string[] | undefined;
  nextActions: string[];
  relevantArtifacts?: string[] | undefined;
  relevantContextReferences?: string[] | undefined;
}

/**
 * Persist one structured checkpoint revision and link it to its attempt.
 *
 * Carry-forward rule: decisions and FAILED APPROACHES accumulate — the new
 * revision starts from the latest checkpoint's record and appends what is
 * new (deduplicated by content). One worker's discovered dead end is never
 * lost because a later worker wrote a narrower checkpoint.
 */
export function createTaskCheckpoint(
  deps: SurvivalDeps,
  input: CreateTaskCheckpointInput,
): TaskCheckpoint {
  const attempt = readTaskAttempt(deps.workspace, input.jobId, input.attemptId);
  if (attempt === undefined) {
    throw new OrchestrationError(
      'SBO050',
      `Attempt ${input.attemptId} was not found; a checkpoint must belong to a recorded attempt.`,
    );
  }
  if (attempt.nodeId !== input.nodeId) {
    throw new OrchestrationError(
      'SBO050',
      `Attempt ${input.attemptId} belongs to node ${attempt.nodeId}, not ${input.nodeId}.`,
    );
  }
  const previous = readLatestTaskCheckpoint(deps.workspace, input.jobId, input.nodeId);
  const seqs = listTaskCheckpointSeqs(deps.workspace, input.jobId, input.nodeId);
  const seq = (seqs[seqs.length - 1] ?? 0) + 1;

  const mergeTexts = (older: readonly string[], newer: readonly string[]): string[] => {
    const merged = [...older];
    for (const entry of newer) if (!merged.includes(entry)) merged.push(entry);
    return merged.slice(-50);
  };
  const previousDecisions = previous?.importantDecisions ?? [];
  const decisions = [...previousDecisions];
  for (const decision of input.importantDecisions ?? []) {
    if (!decisions.some((existing) => existing.decision === decision.decision)) {
      decisions.push(decision);
    }
  }
  const previousFailed = previous?.failedApproaches ?? [];
  const failedApproaches = [...previousFailed];
  for (const failed of input.failedApproaches ?? []) {
    if (!failedApproaches.some((existing) => existing.approach === failed.approach)) {
      failedApproaches.push(failed);
    }
  }

  const checkpoint = taskCheckpointSchema.parse({
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
    checkpointId: `cp-${input.nodeId}-${String(seq).padStart(4, '0')}`,
    jobId: input.jobId,
    nodeId: input.nodeId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    seq,
    reason: input.reason,
    objective: input.objective,
    pinned: input.pinned,
    completedWork: mergeTexts(previous?.completedWork ?? [], input.completedWork ?? []),
    pendingWork: input.pendingWork ?? [],
    importantDecisions: decisions.slice(-50),
    failedApproaches: failedApproaches.slice(-50),
    changedFiles: input.changedFiles ?? [],
    repositoryState: input.repositoryState ?? {},
    testResults: input.testResults ?? [],
    knownFailures: input.knownFailures ?? [],
    unresolvedIssues: input.unresolvedIssues ?? [],
    nextActions: input.nextActions,
    relevantArtifacts: input.relevantArtifacts ?? [],
    relevantContextReferences: input.relevantContextReferences ?? [],
    createdAt: now(deps),
  });
  const stored = writeTaskCheckpoint(deps.workspace, checkpoint).checkpoint;

  // Link the checkpoint to its (still open or already final) attempt record.
  const linked: TaskAttempt = {
    ...attempt,
    checkpointIds: [...attempt.checkpointIds, stored.checkpointId].slice(-50),
  };
  updateTaskAttempt(deps.workspace, linked);
  return stored;
}

/** Summarize a Git snapshot into the bounded checkpoint repository state. */
export function repositoryStateFromSnapshot(snapshot: GitSnapshot): CheckpointRepositoryState {
  return {
    ...(snapshot.branch !== undefined ? { branch: snapshot.branch } : {}),
    ...(snapshot.head !== undefined ? { head: snapshot.head } : {}),
    detached: snapshot.detached,
    clean: snapshot.clean,
    dirtyPaths: snapshot.entries.slice(0, 500).map((entry) => entry.path.slice(0, 512)),
  };
}

// ---------------------------------------------------------------------------
// ExecutionLedger
// ---------------------------------------------------------------------------

export interface ReadExecutionLedgerOptions {
  nodeId?: string | undefined;
}

/** Normalized ledger entries for a job, oldest first. Nulls stay null. */
export function readExecutionLedger(
  workspace: WorkspaceInfo,
  jobId: string,
  options: ReadExecutionLedgerOptions = {},
): ExecutionLedgerEntry[] {
  const attempts = listTaskAttempts(workspace, jobId, { nodeId: options.nodeId });
  return attempts.map((attempt) =>
    executionLedgerEntrySchema.parse({
      attemptId: attempt.attemptId,
      jobId: attempt.jobId,
      nodeId: attempt.nodeId,
      taskId: attempt.taskId,
      role: attempt.role,
      provider: attempt.provider,
      model: attempt.model,
      lane: attempt.lane ?? null,
      status: attempt.status,
      attemptNumber: attempt.attemptNumber,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt ?? null,
      success: attempt.status === 'COMPLETED',
      failureReason: attempt.failure?.category ?? attempt.interruptedReason ?? null,
      localSuitability: attempt.localSuitability ?? null,
      taskComplexity: attempt.taskComplexity ?? null,
      taskCategory: attempt.taskCategory ?? null,
      schedulingDecisionId: attempt.schedulingDecisionId ?? null,
      metrics: attempt.metrics,
    }),
  );
}

export interface ExecutionLedgerSummary {
  totalAttempts: number;
  byProvider: Record<
    string,
    {
      attempts: number;
      completed: number;
      failed: number;
      interrupted: number;
      /** Sums over attempts that REPORTED the metric; null when none did. */
      reportedInputTokens: number | null;
      reportedOutputTokens: number | null;
      reportedCostUsd: number | null;
      totalDurationMs: number | null;
    }
  >;
}

/** Aggregate the ledger without fabricating any unreported metric. */
export function summarizeExecutionLedger(entries: readonly ExecutionLedgerEntry[]): ExecutionLedgerSummary {
  const byProvider: ExecutionLedgerSummary['byProvider'] = {};
  for (const entry of entries) {
    const bucket = (byProvider[entry.provider] ??= {
      attempts: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      reportedInputTokens: null,
      reportedOutputTokens: null,
      reportedCostUsd: null,
      totalDurationMs: null,
    });
    bucket.attempts += 1;
    if (entry.status === 'COMPLETED') bucket.completed += 1;
    if (entry.status === 'FAILED') bucket.failed += 1;
    if (entry.status === 'INTERRUPTED') bucket.interrupted += 1;
    const add = (current: number | null, reported: number | null): number | null =>
      reported === null ? current : (current ?? 0) + reported;
    bucket.reportedInputTokens = add(bucket.reportedInputTokens, entry.metrics.inputTokens);
    bucket.reportedOutputTokens = add(bucket.reportedOutputTokens, entry.metrics.outputTokens);
    bucket.reportedCostUsd = add(bucket.reportedCostUsd, entry.metrics.costUsd);
    bucket.totalDurationMs = add(bucket.totalDurationMs, entry.metrics.durationMs);
  }
  return { totalAttempts: entries.length, byProvider };
}
