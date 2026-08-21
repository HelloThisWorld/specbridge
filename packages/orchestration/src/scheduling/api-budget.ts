import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ApiBudgetPolicy, WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import { jobDir } from '../jobs/store.js';
import { API_BUDGET_RESERVATION_STATES, API_COST_SOURCES } from './vocabulary.js';
import type { ApiBudgetReservationState, ApiCostSource } from './vocabulary.js';

/**
 * ApiBudgetController (vNext.5): a hard guardrail, not telemetry.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. BOUNDED. An attempt whose safe estimated cost exceeds the job, task,
 *      or attempt ceiling is never dispatched. Budget refusal is a
 *      scheduling outcome, not a warning in a log.
 *
 *   2. NO OVERCOMMIT. Budget is RESERVED before dispatch and reconciled
 *      after. Two tasks looking at "$10 remaining" and each needing $7
 *      cannot both proceed: the reservation is a read-modify-write behind
 *      an exclusive lock file, so exactly one wins.
 *
 *   3. CRASH-HONEST. A process that dies mid-attempt leaves a RESERVED
 *      hold. Resume moves it to UNKNOWN, which KEEPS the money charged
 *      against the budget — because the remote provider may well have been
 *      billed, and releasing a hold that might already have been spent is
 *      how accounting silently breaks.
 *
 * Storage lives in the existing job namespace, atomically written like
 * every other job artifact:
 *
 *   .specbridge/jobs/<jobId>/api-budget/reservations.json
 *
 * Deliberately NOT a billing system. It answers one question — "may this
 * attempt spend, and what did it end up holding?" — and leaves cost
 * ANALYSIS to the execution ledger, which is already the factual history.
 */

export const API_BUDGET_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().min(1).max(200);

export const apiBudgetReservationSchema = z
  .object({
    reservationId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    /** The durable attempt this reservation funds; null until dispatch. */
    attemptId: shortText.nullable().default(null),
    state: z.enum(API_BUDGET_RESERVATION_STATES),
    /** The safe estimated cost held at reservation time, in USD. */
    reservedUsd: z.number().min(0),
    /** Observed/computed cost after the attempt, when determinable. */
    reconciledUsd: z.number().min(0).nullable().default(null),
    /** How `reconciledUsd` was determined. */
    costSource: z.enum(API_COST_SOURCES).default('ESTIMATED_PRE_DISPATCH'),
    /** The API profile the reservation was made for (audit). */
    profileName: shortText.nullable().default(null),
    createdAt: shortText,
    updatedAt: shortText,
    detail: z.string().max(1_000).default(''),
  })
  .passthrough();
export type ApiBudgetReservation = z.infer<typeof apiBudgetReservationSchema>;

export const apiBudgetStateSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    reservations: z.array(apiBudgetReservationSchema).max(5_000).default([]),
    updatedAt: shortText,
  })
  .passthrough();
export type ApiBudgetState = z.infer<typeof apiBudgetStateSchema>;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function budgetDir(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(jobDir(workspace, jobId), 'api-budget'));
}

function budgetFile(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(budgetDir(workspace, jobId), 'reservations.json'),
  );
}

function budgetLockFile(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(budgetDir(workspace, jobId), 'reservations.lock'),
  );
}

/** Read the durable budget state. A missing file is an empty budget. */
export function readApiBudgetState(workspace: WorkspaceInfo, jobId: string): ApiBudgetState {
  const file = budgetFile(workspace, jobId);
  if (!existsSync(file)) {
    return {
      schemaVersion: API_BUDGET_SCHEMA_VERSION,
      jobId,
      reservations: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
  // Unparseable JSON and a schema mismatch are the SAME failure here, and
  // both must be loud: silently treating either as "nothing is reserved"
  // would be the single most expensive bug this module could have.
  const parsed = (() => {
    try {
      return apiBudgetStateSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return { success: false } as const;
    }
  })();
  if (!parsed.success) {
    // Budget state is money. A corrupt file is refused loudly rather than
    // silently reset to "nothing is reserved" — which would be the single
    // most expensive possible failure mode of this module.
    throw new OrchestrationError(
      'SBO049',
      `The API budget state for job ${jobId} is unreadable; refusing to treat it as an empty budget.`,
      {
        remediation: [
          `Inspect ${file} and repair or remove it deliberately before allowing further API spend.`,
        ],
      },
    );
  }
  return parsed.data;
}

/**
 * Run one read-modify-write of the budget state under an exclusive lock.
 *
 * The lock is a `wx` create, exactly as the interactive run lock does it:
 * it fails atomically when the file already exists, so a concurrent
 * reservation cannot interleave. Sequential callers are the normal case
 * today; correctness under the runtime's existing parallel paths is the
 * reason this is not a plain read-then-write.
 */
function withBudgetLock<T>(
  workspace: WorkspaceInfo,
  jobId: string,
  now: string,
  mutate: (state: ApiBudgetState) => { state: ApiBudgetState; result: T },
): T {
  const dir = budgetDir(workspace, jobId);
  mkdirSync(dir, { recursive: true });
  const lockPath = budgetLockFile(workspace, jobId);
  try {
    writeFileSync(lockPath, `${JSON.stringify({ jobId, at: now })}\n`, { flag: 'wx' });
  } catch {
    throw new OrchestrationError(
      'SBO049',
      `The API budget for job ${jobId} is locked by another operation; the reservation was not made.`,
      {
        remediation: [
          'Retry once the other operation finishes.',
          `If no other process is running, remove the stale lock at ${lockPath}.`,
        ],
      },
    );
  }
  try {
    const current = readApiBudgetState(workspace, jobId);
    const { state, result } = mutate(current);
    const validated = apiBudgetStateSchema.parse({ ...state, updatedAt: now });
    writeFileAtomic(budgetFile(workspace, jobId), `${JSON.stringify(validated, null, 2)}\n`);
    return result;
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // A lock we cannot remove is reported by the next acquisition attempt.
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface ApiBudgetSummary {
  /** Held for attempts still running. */
  reservedUsd: number;
  /** Reconciled spend of finished attempts. */
  committedUsd: number;
  /**
   * Held for attempts whose real usage could not be determined. Counted
   * against the budget exactly like committed spend.
   */
  unknownUsd: number;
  /** reserved + committed + unknown: everything the budget considers spent. */
  encumberedUsd: number;
  /** Job ceiling minus encumbered; null when no job ceiling is configured. */
  remainingUsd: number | null;
  /** API attempts recorded for this job (any state except RELEASED). */
  attempts: number;
  /**
   * True when at least one cost is UNKNOWN, so the committed total is a
   * floor rather than an exact figure.
   */
  hasUnknownCost: boolean;
}

/** Effective cost a reservation charges the budget, by state. */
function encumbered(reservation: ApiBudgetReservation): number {
  switch (reservation.state) {
    case 'RESERVED':
      return reservation.reservedUsd;
    case 'COMMITTED':
      // Reconciled cost replaces the hold. A committed reservation with no
      // reconciled figure keeps its hold: the estimate is the best floor.
      return reservation.reconciledUsd ?? reservation.reservedUsd;
    case 'UNKNOWN':
      return reservation.reconciledUsd ?? reservation.reservedUsd;
    case 'RELEASED':
      return 0;
  }
}

/** Aggregate the durable budget state. Pure over the given records. */
export function summarizeApiBudget(
  state: ApiBudgetState,
  policy: ApiBudgetPolicy,
  options: { taskId?: string | undefined } = {},
): ApiBudgetSummary {
  const relevant =
    options.taskId === undefined
      ? state.reservations
      : state.reservations.filter((entry) => entry.taskId === options.taskId);
  let reservedUsd = 0;
  let committedUsd = 0;
  let unknownUsd = 0;
  let hasUnknownCost = false;
  let attempts = 0;
  for (const entry of relevant) {
    if (entry.state !== 'RELEASED') attempts += 1;
    if (entry.state === 'RESERVED') reservedUsd += entry.reservedUsd;
    else if (entry.state === 'COMMITTED') committedUsd += encumbered(entry);
    else if (entry.state === 'UNKNOWN') {
      unknownUsd += encumbered(entry);
      hasUnknownCost = true;
    }
    if (entry.state === 'COMMITTED' && entry.costSource === 'UNKNOWN') hasUnknownCost = true;
  }
  const encumberedUsd = round(reservedUsd + committedUsd + unknownUsd);
  const ceiling =
    options.taskId === undefined ? policy.maxCostPerJobUsd : policy.maxCostPerTaskUsd;
  return {
    reservedUsd: round(reservedUsd),
    committedUsd: round(committedUsd),
    unknownUsd: round(unknownUsd),
    encumberedUsd,
    remainingUsd: ceiling === null ? null : round(Math.max(0, ceiling - encumberedUsd)),
    attempts,
    hasUnknownCost,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Admission + reservation
// ---------------------------------------------------------------------------

export type ApiBudgetRefusal =
  | 'ATTEMPT_CEILING'
  | 'TASK_CEILING'
  | 'JOB_CEILING'
  | 'TASK_ATTEMPTS'
  | 'JOB_ATTEMPTS'
  | 'COST_UNKNOWN';

export interface ApiBudgetAdmission {
  admissible: boolean;
  refusal?: ApiBudgetRefusal | undefined;
  job: ApiBudgetSummary;
  task: ApiBudgetSummary;
  detail: string;
}

export interface AssessApiBudgetInput {
  state: ApiBudgetState;
  policy: ApiBudgetPolicy;
  taskId: string;
  /** The SAFE (multiplied) estimated cost. Null means cost is unknown. */
  safeCostUsd: number | null;
}

/**
 * Would one more API attempt fit inside every configured ceiling? Pure.
 *
 * A null `safeCostUsd` is refused outright: automatic spend requires a
 * number, and "unknown" is not a small number.
 */
export function assessApiBudget(input: AssessApiBudgetInput): ApiBudgetAdmission {
  const { policy } = input;
  const job = summarizeApiBudget(input.state, policy);
  const task = summarizeApiBudget(input.state, policy, { taskId: input.taskId });
  const refuse = (refusal: ApiBudgetRefusal, detail: string): ApiBudgetAdmission => ({
    admissible: false,
    refusal,
    job,
    task,
    detail,
  });

  if (task.attempts >= policy.maxApiAttemptsPerTask) {
    return refuse(
      'TASK_ATTEMPTS',
      `Task ${input.taskId} already used its ${policy.maxApiAttemptsPerTask} bounded API attempt(s); paid work does not retry indefinitely.`,
    );
  }
  if (job.attempts >= policy.maxApiAttemptsPerJob) {
    return refuse(
      'JOB_ATTEMPTS',
      `The job already used its ${policy.maxApiAttemptsPerJob} bounded API attempt(s).`,
    );
  }
  if (input.safeCostUsd === null) {
    return refuse(
      'COST_UNKNOWN',
      'The cost of this attempt cannot be estimated, so no budget reservation can be made. ' +
        'Unknown cost is never treated as zero.',
    );
  }
  const cost = input.safeCostUsd;
  if (policy.maxCostPerAttemptUsd !== null && cost > policy.maxCostPerAttemptUsd) {
    return refuse(
      'ATTEMPT_CEILING',
      `The safe estimate $${cost.toFixed(4)} exceeds the $${policy.maxCostPerAttemptUsd} per-attempt ceiling.`,
    );
  }
  if (task.remainingUsd !== null && cost > task.remainingUsd) {
    return refuse(
      'TASK_CEILING',
      `The safe estimate $${cost.toFixed(4)} exceeds the $${task.remainingUsd.toFixed(4)} remaining of task ${input.taskId}'s budget.`,
    );
  }
  if (job.remainingUsd !== null && cost > job.remainingUsd) {
    return refuse(
      'JOB_CEILING',
      `The safe estimate $${cost.toFixed(4)} exceeds the $${job.remainingUsd.toFixed(4)} remaining of the job's API budget.`,
    );
  }
  return {
    admissible: true,
    job,
    task,
    detail:
      `The safe estimate $${cost.toFixed(4)} fits every configured ceiling ` +
      `(job remaining ${job.remainingUsd === null ? 'unbounded' : `$${job.remainingUsd.toFixed(4)}`}).`,
  };
}

export interface ReserveApiBudgetInput {
  workspace: WorkspaceInfo;
  jobId: string;
  nodeId: string;
  taskId: string;
  policy: ApiBudgetPolicy;
  safeCostUsd: number | null;
  profileName: string | null;
  now: Date;
  reservationId: string;
  detail?: string | undefined;
}

export type ReserveApiBudgetResult =
  | { ok: true; reservation: ApiBudgetReservation; admission: ApiBudgetAdmission }
  | { ok: false; admission: ApiBudgetAdmission };

/**
 * Reserve budget for one API attempt, atomically.
 *
 * Admission is re-evaluated INSIDE the lock against the freshly read state,
 * not against whatever the planner saw a moment ago. That is the entire
 * defence against two concurrent tasks each reserving the same last dollar.
 */
export function reserveApiBudget(input: ReserveApiBudgetInput): ReserveApiBudgetResult {
  const now = input.now.toISOString();
  return withBudgetLock<ReserveApiBudgetResult>(input.workspace, input.jobId, now, (state) => {
    const admission = assessApiBudget({
      state,
      policy: input.policy,
      taskId: input.taskId,
      safeCostUsd: input.safeCostUsd,
    });
    if (!admission.admissible || input.safeCostUsd === null) {
      return { state, result: { ok: false, admission } };
    }
    const reservation: ApiBudgetReservation = {
      reservationId: input.reservationId,
      jobId: input.jobId,
      nodeId: input.nodeId,
      taskId: input.taskId,
      attemptId: null,
      state: 'RESERVED',
      reservedUsd: input.safeCostUsd,
      reconciledUsd: null,
      costSource: 'ESTIMATED_PRE_DISPATCH',
      profileName: input.profileName,
      createdAt: now,
      updatedAt: now,
      detail: (input.detail ?? admission.detail).slice(0, 1_000),
    };
    return {
      state: { ...state, reservations: [...state.reservations, reservation] },
      result: { ok: true, reservation, admission },
    };
  });
}

function updateReservation(
  workspace: WorkspaceInfo,
  jobId: string,
  reservationId: string,
  now: Date,
  update: (entry: ApiBudgetReservation) => ApiBudgetReservation,
): ApiBudgetReservation {
  const iso = now.toISOString();
  return withBudgetLock<ApiBudgetReservation>(workspace, jobId, iso, (state) => {
    const index = state.reservations.findIndex((entry) => entry.reservationId === reservationId);
    const existing = state.reservations[index];
    if (index < 0 || existing === undefined) {
      throw new OrchestrationError(
        'SBO049',
        `API budget reservation ${reservationId} of job ${jobId} was not found.`,
      );
    }
    const updated = apiBudgetReservationSchema.parse({ ...update(existing), updatedAt: iso });
    const reservations = [...state.reservations];
    reservations[index] = updated;
    return { state: { ...state, reservations }, result: updated };
  });
}

/** Attach the durable attempt id to a reservation once the dispatch starts. */
export function bindApiBudgetReservation(
  workspace: WorkspaceInfo,
  jobId: string,
  reservationId: string,
  attemptId: string,
  now: Date,
): ApiBudgetReservation {
  return updateReservation(workspace, jobId, reservationId, now, (entry) => ({
    ...entry,
    attemptId,
  }));
}

export interface ReconcileApiBudgetInput {
  workspace: WorkspaceInfo;
  jobId: string;
  reservationId: string;
  /** Observed/computed cost; null when the real cost is not determinable. */
  observedCostUsd: number | null;
  costSource: ApiCostSource;
  now: Date;
  detail?: string | undefined;
}

/**
 * Reconcile a finished attempt's reservation against what it actually cost.
 *
 * An observed cost COMMITS the reservation at the observed figure — the
 * estimate is not overwritten anywhere, it simply stops being the number
 * the budget charges. A null observed cost is NOT a release: the
 * reservation moves to UNKNOWN and keeps its hold, because a paid attempt
 * that cannot report its usage is not evidence that it was free.
 */
export function reconcileApiBudget(input: ReconcileApiBudgetInput): ApiBudgetReservation {
  return updateReservation(
    input.workspace,
    input.jobId,
    input.reservationId,
    input.now,
    (entry) => {
      const determinable =
        input.observedCostUsd !== null && input.costSource !== 'UNKNOWN';
      const state: ApiBudgetReservationState = determinable ? 'COMMITTED' : 'UNKNOWN';
      return {
        ...entry,
        state,
        reconciledUsd: input.observedCostUsd,
        costSource: input.costSource,
        detail: (
          input.detail ??
          (determinable
            ? `Reconciled at $${(input.observedCostUsd ?? 0).toFixed(4)} (${input.costSource}).`
            : 'The attempt’s real cost could not be determined; the reservation stays charged.')
        ).slice(0, 1_000),
      };
    },
  );
}

/**
 * Release a reservation that provably never spent — the attempt was refused
 * BEFORE any dispatch reached the provider. Never call this for an attempt
 * that started: use `reconcileApiBudget`, which fails toward UNKNOWN.
 */
export function releaseApiBudget(
  workspace: WorkspaceInfo,
  jobId: string,
  reservationId: string,
  now: Date,
  detail: string,
): ApiBudgetReservation {
  return updateReservation(workspace, jobId, reservationId, now, (entry) => {
    if (entry.attemptId !== null) {
      throw new OrchestrationError(
        'SBO049',
        `Reservation ${reservationId} is bound to attempt ${entry.attemptId} and cannot be released; ` +
          'an attempt that started may have spent remotely and must be reconciled instead.',
      );
    }
    return {
      ...entry,
      state: 'RELEASED',
      reconciledUsd: 0,
      costSource: 'ESTIMATED_PRE_DISPATCH',
      detail: detail.slice(0, 1_000),
    };
  });
}

/**
 * Reconcile reservations left RESERVED by a process that disappeared.
 *
 * Called by resume, for the same reason attempts are reconciled there: a
 * fresh process has no live dispatch, so every RESERVED hold belonged to a
 * dead one. Holds move to UNKNOWN and STAY CHARGED — conservative by
 * construction, because SpecBridge cannot know whether the provider was
 * billed before the crash, and guessing "no" in that situation is how a
 * budget silently becomes fiction.
 */
export function reconcileInterruptedApiReservations(
  workspace: WorkspaceInfo,
  jobId: string,
  now: Date,
  reason = 'process-restart',
): ApiBudgetReservation[] {
  const iso = now.toISOString();
  if (!existsSync(budgetFile(workspace, jobId))) return [];
  return withBudgetLock<ApiBudgetReservation[]>(workspace, jobId, iso, (state) => {
    const reconciled: ApiBudgetReservation[] = [];
    const reservations = state.reservations.map((entry) => {
      if (entry.state !== 'RESERVED') return entry;
      const updated: ApiBudgetReservation = {
        ...entry,
        state: 'UNKNOWN',
        costSource: 'UNKNOWN',
        updatedAt: iso,
        detail:
          `The owning attempt was interrupted (${reason}); remote usage cannot be ruled out, so ` +
          'this reservation stays charged against the budget.',
      };
      reconciled.push(updated);
      return updated;
    });
    return { state: { ...state, reservations }, result: reconciled };
  });
}
