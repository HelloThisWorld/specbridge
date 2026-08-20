/**
 * Survival-runtime vocabulary (vNext.1). Closed enums, additive within 1.x
 * with the same rules as every other orchestration vocabulary: members may
 * be appended, never removed or repurposed, so persisted attempt and
 * checkpoint records stay readable across upgrades.
 */

// ---------------------------------------------------------------------------
// Execution attempts
// ---------------------------------------------------------------------------

/**
 * Statuses of one durable ExecutionAttempt.
 *
 * The RUNNING → INTERRUPTED transition is the crash-recovery contract: an
 * attempt persisted as RUNNING whose process later proves absent is
 * reconciled to INTERRUPTED — visibly, never silently — and a NEW attempt
 * continues the task. A resumed task never pretends to be the same
 * transient execution.
 */
export const TASK_ATTEMPT_STATUSES = [
  /** The dispatch is (or was, before a crash) in flight. */
  'RUNNING',
  /** The attempt finished and its task work was accepted by the evidence path. */
  'COMPLETED',
  /** The attempt finished without acceptance; failure details recorded. */
  'FAILED',
  /** The owning process/session disappeared; reconciled at resume. */
  'INTERRUPTED',
  /** The user (or a shutdown) cancelled the attempt deliberately. */
  'CANCELLED',
] as const;
export type TaskAttemptStatus = (typeof TASK_ATTEMPT_STATUSES)[number];

/** Statuses that end an attempt's own lifecycle. */
export const FINAL_TASK_ATTEMPT_STATUSES: readonly TaskAttemptStatus[] = [
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'CANCELLED',
];

export function isFinalAttemptStatus(status: TaskAttemptStatus): boolean {
  return FINAL_TASK_ATTEMPT_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * Why a checkpoint was created. Reasons are observability, not behavior:
 * every checkpoint carries the same structure whatever triggered it. The
 * quota/provider-switch/budget triggers of later phases will appear here as
 * additive members — the mechanism is already in place.
 */
export const TASK_CHECKPOINT_REASONS = [
  /** A meaningful unit of work completed (subtask, implementation, tests). */
  'milestone',
  /** Execution is about to hand off to another worker/provider. */
  'handoff',
  /** Execution is shutting down deliberately. */
  'shutdown',
  /** Durable state refresh before a context is discarded or rebuilt. */
  'pre-compaction',
  /** Context approached its safe upper bound; state persisted before rebuild. */
  'emergency-compaction',
  /** Recovery persisted what was reconstructible after an interruption. */
  'recovery',
  /** An explicit caller-requested checkpoint. */
  'manual',
] as const;
export type TaskCheckpointReason = (typeof TASK_CHECKPOINT_REASONS)[number];
