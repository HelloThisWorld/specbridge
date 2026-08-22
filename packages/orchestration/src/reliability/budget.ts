import type { JobBudgets, JobCounters, JobNode } from '../jobs/state.js';
import type { BudgetSnapshot } from './state.js';
import { budgetSnapshotSchema } from './state.js';

/**
 * Unified budget governance — as a READ MODEL, never as a second ledger.
 *
 * This module owns no counter. Every number it reports is read from the
 * component that already owns it:
 *
 *   attempts / repairs / replans / retries   JobBudgets + JobNode counters
 *   wall clock, cost, tokens                 JobBudgets + JobCounters
 *   shared LOCAL attempts                    the scheduler policy (vNext.4)
 *   API dollars                              ApiBudgetController (vNext.5)
 *   subscription quota                       QuotaManager (vNext.2)
 *
 * A `ReliabilityBudget` with its own attempt counter would be the classic
 * mistake here: two counters for one bound, diverging the first time a code
 * path updates one and forgets the other, and eventually disagreeing about
 * whether a job may keep spending money. So the hierarchy is expressed by
 * READING, not by re-counting:
 *
 *   Job budget      ->  Task budget      ->  ExecutionAttempt budget
 *
 * The distinction this module DOES add is soft versus hard. Every existing
 * bound is hard — it stops work. Reliability needs to react before that:
 * a task at its last repair should reconsider its approach rather than
 * discover the wall by hitting it. `soft()` answers "should we think now?";
 * `hard()` answers "may we run at all?", and only the second one refuses.
 */

/** The shared LOCAL-lane attempt budget (vNext.4), when the lane applies. */
export interface LocalAttemptBudget {
  used: number;
  max: number;
}

/** The vNext.5 API budget position, read from its owner. */
export interface ApiBudgetPosition {
  /** Remaining authorized dollars, or null when no ceiling is configured. */
  remainingUsd: number | null;
  /** Dollars held by in-flight reservations plus reconciled spend. */
  encumberedUsd: number | null;
  /** False when paid execution is refused for any reason at all. */
  available: boolean;
}

export interface BudgetViewInput {
  budgets: JobBudgets;
  counters: JobCounters;
  node: Pick<JobNode, 'attempts' | 'repairCycles' | 'replans' | 'consecutiveNoProgress'>;
  /** Executor dispatches already made against this task. */
  executorAttempts: number;
  elapsedMs?: number | null | undefined;
  local?: LocalAttemptBudget | undefined;
  api?: ApiBudgetPosition | undefined;
}

/**
 * The complete budget position one recovery decision is made against.
 *
 * Every field is a projection of an owner elsewhere. `remaining*` values may
 * be zero but never negative, so a caller can compare them directly without
 * having to remember which direction each underlying counter runs.
 */
export interface BudgetView {
  attemptsUsed: number;
  attemptsMax: number;
  remainingAttempts: number;
  repairsUsed: number;
  repairsMax: number;
  remainingRepairs: number;
  replansUsed: number;
  replansMax: number;
  remainingReplans: number;
  /** Job-wide replan budget, which can bind before the per-task one does. */
  remainingJobReplans: number;
  transientRetriesUsed: number;
  transientRetriesMax: number;
  remainingTransientRetries: number;
  stagnationCount: number;
  maxNoProgressCycles: number;
  localAttemptsUsed: number | null;
  localAttemptsMax: number | null;
  remainingLocalAttempts: number | null;
  elapsedMs: number | null;
  maxWallClockMs: number;
  remainingWallClockMs: number | null;
  apiRemainingUsd: number | null;
  apiEncumberedUsd: number | null;
  apiAvailable: boolean;
  reportedCostUsd: number | null;
  reportedTokens: number | null;
}

function clampNonNegative(value: number): number {
  return value < 0 ? 0 : value;
}

/** Project every owning component's counters into one comparable view. */
export function buildBudgetView(input: BudgetViewInput): BudgetView {
  const elapsedMs = input.elapsedMs ?? null;
  const localUsed = input.local?.used ?? null;
  const localMax = input.local?.max ?? null;
  return {
    attemptsUsed: input.executorAttempts,
    attemptsMax: input.budgets.maxTaskAttempts,
    remainingAttempts: clampNonNegative(input.budgets.maxTaskAttempts - input.executorAttempts),
    repairsUsed: input.node.repairCycles,
    repairsMax: input.budgets.maxRepairCyclesPerTask,
    remainingRepairs: clampNonNegative(input.budgets.maxRepairCyclesPerTask - input.node.repairCycles),
    replansUsed: input.node.replans,
    replansMax: input.budgets.maxReplansPerTask,
    remainingReplans: clampNonNegative(input.budgets.maxReplansPerTask - input.node.replans),
    remainingJobReplans: clampNonNegative(input.budgets.maxJobReplans - input.counters.jobReplans),
    transientRetriesUsed: input.counters.transientRetries,
    transientRetriesMax: input.budgets.maxTransientRetries,
    remainingTransientRetries: clampNonNegative(
      input.budgets.maxTransientRetries - input.counters.transientRetries,
    ),
    stagnationCount: input.node.consecutiveNoProgress,
    maxNoProgressCycles: input.budgets.maxNoProgressCycles,
    localAttemptsUsed: localUsed,
    localAttemptsMax: localMax,
    remainingLocalAttempts:
      localUsed === null || localMax === null ? null : clampNonNegative(localMax - localUsed),
    elapsedMs,
    maxWallClockMs: input.budgets.maxWallClockMs,
    remainingWallClockMs:
      elapsedMs === null ? null : clampNonNegative(input.budgets.maxWallClockMs - elapsedMs),
    apiRemainingUsd: input.api?.remainingUsd ?? null,
    apiEncumberedUsd: input.api?.encumberedUsd ?? null,
    apiAvailable: input.api?.available ?? false,
    reportedCostUsd: input.counters.reportedCostUsd,
    reportedTokens: input.counters.reportedTokens,
  };
}

/** Which budget, if any, HARD-refuses another attempt of any kind. */
export function hardBudgetRefusal(view: BudgetView): { budget: string; detail: string } | null {
  if (view.remainingAttempts <= 0) {
    return {
      budget: 'maxTaskAttempts',
      detail: `all ${view.attemptsMax} execution attempts for this task are spent`,
    };
  }
  if (view.remainingWallClockMs !== null && view.remainingWallClockMs <= 0) {
    return {
      budget: 'maxWallClockMs',
      detail: `the job reached its ${view.maxWallClockMs}ms wall-clock budget`,
    };
  }
  return null;
}

/**
 * Whether a budget is close enough to its bound that recovery should prefer
 * thinking over running.
 *
 * A SOFT threshold never refuses anything — it makes the planner favour
 * replanning over one more repair, because the last repair in a budget is
 * the one most worth spending on a different idea rather than the same one.
 */
export function softBudgetPressure(view: BudgetView): string[] {
  const pressure: string[] = [];
  if (view.remainingRepairs <= 1 && view.repairsMax > 0) pressure.push('repair budget nearly spent');
  if (view.remainingAttempts <= 1) pressure.push('attempt budget nearly spent');
  if (view.remainingReplans <= 0 && view.replansMax > 0) pressure.push('replan budget spent');
  if (
    view.remainingLocalAttempts !== null &&
    view.remainingLocalAttempts <= 0 &&
    view.localAttemptsMax !== null
  ) {
    pressure.push('shared local attempt budget spent');
  }
  if (
    view.remainingWallClockMs !== null &&
    view.remainingWallClockMs <= view.maxWallClockMs * 0.1
  ) {
    pressure.push('wall-clock budget nearly spent');
  }
  return pressure;
}

/** Freeze the view onto a durable decision record. */
export function snapshotBudget(view: BudgetView): BudgetSnapshot {
  return budgetSnapshotSchema.parse({
    attemptsUsed: view.attemptsUsed,
    attemptsMax: view.attemptsMax,
    repairsUsed: view.repairsUsed,
    repairsMax: view.repairsMax,
    replansUsed: view.replansUsed,
    replansMax: view.replansMax,
    transientRetriesUsed: view.transientRetriesUsed,
    transientRetriesMax: view.transientRetriesMax,
    stagnationCount: view.stagnationCount,
    localAttemptsUsed: view.localAttemptsUsed,
    localAttemptsMax: view.localAttemptsMax,
    elapsedMs: view.elapsedMs,
    maxWallClockMs: view.maxWallClockMs,
    apiRemainingUsd: view.apiRemainingUsd,
    apiEncumberedUsd: view.apiEncumberedUsd,
    reportedCostUsd: view.reportedCostUsd,
    reportedTokens: view.reportedTokens,
  });
}
