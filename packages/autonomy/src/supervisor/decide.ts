import type { SupervisorPolicy } from '@specbridge/core';
import type { JobStatus } from '@specbridge/orchestration';
import { isFinalJobStatus, isOperationalJobStatus, requiresHumanAttention } from '@specbridge/orchestration';
import type { SupervisedJob } from './state.js';
import type { ResourceWaitKind } from '../vocabulary.js';
import { SCHEDULED_RESOURCE_WAIT_KINDS } from '../vocabulary.js';

/**
 * The supervision decision function.
 *
 * Pure, total, and the single place where "what should the supervisor do
 * next" is decided. The loop around it does I/O; this decides. Splitting
 * them is what makes a fifteen-hour unattended behaviour testable in
 * milliseconds: every interesting scenario is a struct.
 *
 * The ordering below is the policy, and the first three cases carry the
 * whole vNext.10 argument about who gets woken up:
 *
 *   A FINAL job releases. Nothing to supervise.
 *   A HUMAN-ATTENTION job releases too — and this is the important one. The
 *     supervisor does NOT sit on a job waiting for a person, because a held
 *     lease means "I am working on this", and it is not. Releasing makes the
 *     stop visible to `mission report` and to whatever wakes the human.
 *   An OPERATIONAL job never releases. It sleeps, re-checks, or gives up
 *     honestly, and the difference between those three is the difference
 *     between an overnight run that finishes and one that does not.
 */

export type SupervisionDecision =
  | { action: 'START_DRIVER'; reason: string }
  | { action: 'RESTART_DRIVER'; reason: string; backoffMs: number }
  | { action: 'SLEEP_UNTIL'; reason: string; wakeAt: string }
  | { action: 'RECHECK_AFTER'; reason: string; afterMs: number }
  | { action: 'WAIT_FOR_HUMAN'; reason: string; status: JobStatus }
  | { action: 'RELEASE'; reason: string }
  | { action: 'GIVE_UP'; reason: string };

export interface SupervisionInput {
  now: Date;
  policy: SupervisorPolicy;
  status: JobStatus;
  /** The job's operational wait, when it is in an operational status. */
  wait?:
    | { kind: string; wakeAt?: string | undefined; startedAt: string; checks: number }
    | undefined;
  /** The job's `retryAt`, when it has one. */
  retryAt?: string | undefined;
  supervised: SupervisedJob;
  /** A driver is currently running under this supervisor. */
  driverRunning: boolean;
  /** The current progress fingerprint, read fresh from durable job state. */
  progressFingerprint: string;
  /** When this supervision session started; bounds the whole run. */
  sessionStartedAt: string;
}

export function decideSupervision(input: SupervisionInput): SupervisionDecision {
  const nowMs = input.now.getTime();

  if (isFinalJobStatus(input.status)) {
    return { action: 'RELEASE', reason: `job reached ${input.status}` };
  }

  if (requiresHumanAttention(input.status)) {
    return {
      action: 'WAIT_FOR_HUMAN',
      status: input.status,
      reason:
        input.status === 'NEEDS_AUTHORITY'
          ? 'the job needs product authority a human holds'
          : `the job is ${input.status} and cannot proceed without a person`,
    };
  }

  // The session ceiling is not a failure: the job is left resumable, and a
  // fresh supervisor picks it up. Checked before restart budgets so a long
  // healthy run ends by choice rather than by exhausting something.
  const sessionMs = nowMs - Date.parse(input.sessionStartedAt);
  if (Number.isFinite(sessionMs) && sessionMs >= input.policy.maxSessionMs) {
    return {
      action: 'RELEASE',
      reason: `supervision session reached its ${Math.round(input.policy.maxSessionMs / 3_600_000)}h ceiling; the job is resumable`,
    };
  }

  if (input.driverRunning) {
    return { action: 'RECHECK_AFTER', reason: 'driver is running', afterMs: input.policy.pollIntervalMs };
  }

  if (isOperationalJobStatus(input.status)) {
    return decideOperational(input, nowMs);
  }

  // The job is schedulable and nothing is driving it.
  if (input.supervised.starts === 0) {
    return { action: 'START_DRIVER', reason: 'no driver has run for this job yet' };
  }

  const madeProgress =
    input.supervised.lastProgressFingerprint !== undefined &&
    input.supervised.lastProgressFingerprint !== input.progressFingerprint;

  if (!madeProgress && input.supervised.consecutiveRestarts >= input.policy.maxConsecutiveRestarts) {
    return {
      action: 'GIVE_UP',
      reason:
        `${input.supervised.consecutiveRestarts} consecutive driver restarts produced no progress ` +
        '(restarting again would only repeat the same failure)',
    };
  }
  if (input.supervised.restarts >= input.policy.maxRestarts) {
    return {
      action: 'GIVE_UP',
      reason: `the driver restart budget of ${input.policy.maxRestarts} is exhausted`,
    };
  }

  const nextAttemptMs =
    input.supervised.nextAttemptAt !== undefined ? Date.parse(input.supervised.nextAttemptAt) : NaN;
  if (Number.isFinite(nextAttemptMs) && nextAttemptMs > nowMs) {
    return {
      action: 'RECHECK_AFTER',
      reason: 'backing off before the next driver start',
      afterMs: Math.min(nextAttemptMs - nowMs, input.policy.pollIntervalMs),
    };
  }

  return {
    action: 'RESTART_DRIVER',
    reason: madeProgress
      ? 'the previous driver exited after making progress; continuing'
      : 'the previous driver exited without reaching a terminal status',
    backoffMs: input.supervised.backoffMs,
  };
}

/**
 * Decide what to do with a job that is waiting on the world.
 *
 * The split between a scheduled wait and an open-ended one is the reason
 * this function exists separately. A quota window that resets at 04:00 is a
 * SLEEP: there is nothing to learn before then, and polling it burns a
 * laptop all night for no information. A provider that is simply down has no
 * known return, so it is a RECHECK — and, eventually, an honest admission
 * that no recovery could be identified, which is a legitimate way for an
 * unattended run to end and a lie if it were reported as anything else.
 */
function decideOperational(input: SupervisionInput, nowMs: number): SupervisionDecision {
  const wakeAt = input.wait?.wakeAt ?? input.retryAt;
  if (wakeAt !== undefined) {
    const wakeMs = Date.parse(wakeAt);
    if (Number.isFinite(wakeMs)) {
      if (wakeMs > nowMs) {
        return {
          action: 'SLEEP_UNTIL',
          reason: `waiting for ${input.wait?.kind ?? 'a resource'} until ${wakeAt}`,
          wakeAt,
        };
      }
      return {
        action: 'RESTART_DRIVER',
        reason: `the wait for ${input.wait?.kind ?? 'a resource'} elapsed`,
        backoffMs: 0,
      };
    }
  }

  const kind = input.wait?.kind as ResourceWaitKind | undefined;
  if (kind === 'NO_RECOVERY_IDENTIFIED') {
    return {
      action: 'GIVE_UP',
      reason:
        'no path back to any authorized compute could be identified; waiting longer would not ' +
        'change that and reporting progress would be dishonest',
    };
  }

  const startedMs = input.wait !== undefined ? Date.parse(input.wait.startedAt) : NaN;
  const waitedMs = Number.isFinite(startedMs) ? nowMs - startedMs : 0;
  if (
    kind !== undefined &&
    !SCHEDULED_RESOURCE_WAIT_KINDS.includes(kind) &&
    waitedMs >= input.policy.maxIndefiniteWaitMs
  ) {
    return {
      action: 'GIVE_UP',
      reason:
        `${Math.round(waitedMs / 60_000)} minutes of waiting on "${kind}" with no observable ` +
        'return; classifying it honestly rather than waiting indefinitely',
    };
  }

  return {
    action: 'RECHECK_AFTER',
    reason: `re-checking ${kind ?? 'the blocked resource'} (check ${(input.wait?.checks ?? 0) + 1})`,
    afterMs: input.policy.pollIntervalMs,
  };
}

/**
 * A compact fingerprint of "has anything moved".
 *
 * Deliberately coarse: node completion counts, graph revision, attempt
 * count, and status. It answers a yes/no question about forward motion, and
 * a finer fingerprint would answer "did any byte change", which is true on
 * every heartbeat and therefore useless for detecting a crash loop.
 */
export function progressFingerprint(input: {
  status: string;
  graphRevision: number;
  completedNodes: number;
  totalAttempts: number;
  agentRuns: number;
}): string {
  return [
    input.status,
    input.graphRevision,
    input.completedNodes,
    input.totalAttempts,
    input.agentRuns,
  ].join(':');
}
