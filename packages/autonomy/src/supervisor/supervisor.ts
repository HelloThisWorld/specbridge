import type { SupervisorPolicy } from '@specbridge/core';
import type { JobState } from '@specbridge/orchestration';
import {
  clearOperationalState,
  countAutonomyEvent,
  isOperationalJobStatus,
  readGraphRevision,
  recordJobEvent,
  requireJobState,
} from '@specbridge/orchestration';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, hostOf, jobDepsOf, newId, now, nowIso } from '../deps.js';
import type { SupervisionDecision } from './decide.js';
import { decideSupervision, progressFingerprint } from './decide.js';
import type { DriverHost, DriverRunOutcome } from './host.js';
import { claimLease, holdsLease, isLeaseLive, nextBackoffMs, releaseLeaseRecord } from './lease.js';
import type { JobLease, SupervisedJob, SupervisorState } from './state.js';
import { SUPERVISOR_SCHEMA_VERSION, supervisedJobSchema } from './state.js';
import {
  appendSupervisionLog,
  findSupervisedJob,
  loadSupervisorState,
  readLease,
  safeHostname,
  upsertSupervisedJob,
  writeLease,
  writeSupervisorState,
} from './store.js';

/**
 * The autonomous supervisor.
 *
 * This is the thing that makes "leave it running overnight" mean something.
 * A v1.2 job needed a foreground terminal: if the shell closed, the driver
 * died, and the job sat in whatever status it happened to be in until a
 * person typed `--resume`. Every one of those words is a reason an eight-hour
 * unattended window ends after forty minutes.
 *
 * The supervisor replaces all of it with a loop over durable state:
 *
 *   take the lease  ->  decide  ->  act  ->  heartbeat  ->  repeat
 *
 * and it holds NO in-memory truth. Restart counters, backoff, and progress
 * fingerprints are persisted before they are used, so a supervisor that is
 * itself killed and restarted continues from the same accounting rather than
 * generously granting the crash loop a fresh budget.
 *
 * The decision function is pure and lives next door. This file is the part
 * that touches the world: leases, the clock, the driver host, the job store.
 */

export interface SuperviseOptions {
  /** How the driver is actually run. Injected; see host.ts. */
  host: DriverHost;
  signal?: AbortSignal | undefined;
  /** Injectable sleep. Must resolve early when the signal aborts. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onEvent?: ((event: SupervisionEvent) => void) | undefined;
  /**
   * Stop after this many decision cycles. A TEST BOUND, not a policy one:
   * production supervision ends on a terminal status, an authority stop, the
   * session ceiling, or the abort signal.
   */
  maxCycles?: number | undefined;
  /** Override the generated owner id (deterministic tests). */
  ownerId?: string | undefined;
}

export interface SupervisionEvent {
  kind: 'decision' | 'driver' | 'lease' | 'note';
  message: string;
}

export type SupervisionStop =
  | { kind: 'completed'; status: string }
  | { kind: 'needs-human'; status: string; detail: string }
  | { kind: 'gave-up'; reason: string }
  | { kind: 'released'; reason: string }
  | { kind: 'interrupted' }
  | { kind: 'cycles-exhausted' };

export interface SupervisionResult {
  stop: SupervisionStop;
  job: JobState;
  supervised: SupervisedJob;
  cycles: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a job for supervision.
 *
 * Idempotent: re-registering an already-supervised job preserves its restart
 * accounting. A supervisor that reset the counters on every registration
 * would turn "restart the supervisor" into "forgive the crash loop", which
 * is the same bug as not counting at all.
 */
export function registerSupervisedJob(
  deps: AutonomyDeps,
  input: { jobId: string; specName: string; sealId?: string | undefined; ownerId?: string | undefined },
): SupervisedJob {
  const ownerId = input.ownerId ?? newId(deps);
  const state = loadSupervisorState(deps, ownerId);
  const existing = findSupervisedJob(state, input.jobId);
  const supervised = supervisedJobSchema.parse(
    existing ?? {
      jobId: input.jobId,
      specName: input.specName,
      ...(input.sealId !== undefined ? { sealId: input.sealId } : {}),
      status: 'REGISTERED',
      registeredAt: nowIso(deps),
    },
  );
  writeSupervisorState(deps.workspace, {
    ...upsertSupervisedJob(state, supervised),
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    heartbeatAt: nowIso(deps),
  });
  return supervised;
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export interface LeaseAcquisition {
  acquired: boolean;
  lease?: JobLease | undefined;
  /** Present when the lease is held by a live owner that is not us. */
  heldBy?: string | undefined;
}

/**
 * Take (or renew) the lease on one job.
 *
 * Refuses when a LIVE lease belongs to someone else. Two drivers writing one
 * job's durable state is the failure this whole mechanism exists to prevent,
 * and there is deliberately no force flag: an operator who believes a lease
 * is stale can wait for it to expire, which takes at most `leaseTtlMs` and
 * is always correct.
 */
export function acquireJobLease(
  deps: AutonomyDeps,
  jobId: string,
  ownerId: string,
  policy: SupervisorPolicy,
): LeaseAcquisition {
  const at = now(deps);
  const existing = readLease(deps.workspace, jobId);
  if (isLeaseLive(existing, at) && existing?.ownerId !== ownerId) {
    return { acquired: false, ...(existing !== undefined ? { heldBy: existing.ownerId } : {}) };
  }
  const claim = claimLease({
    jobId,
    ownerId,
    existing,
    now: at,
    ttlMs: policy.leaseTtlMs,
    pid: process.pid,
    ...(safeHostname() !== undefined ? { hostname: safeHostname() as string } : {}),
    host: hostOf(deps),
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
  });
  const lease = writeLease(deps.workspace, claim.lease);
  appendSupervisionLog(deps, {
    ownerId,
    jobId,
    action: claim.reclaimed ? 'LEASE_EXPIRED_RECLAIMED' : 'LEASE_ACQUIRED',
    generation: lease.generation,
    ...(claim.previousOwnerId !== undefined
      ? { detail: `previous owner ${claim.previousOwnerId} stopped heartbeating` }
      : {}),
  });
  return { acquired: true, lease };
}

export function renewJobLease(
  deps: AutonomyDeps,
  jobId: string,
  ownerId: string,
  policy: SupervisorPolicy,
): JobLease | undefined {
  const at = now(deps);
  const existing = readLease(deps.workspace, jobId);
  // A supervisor that lost its lease (a long pause, a reclaim) must NOT take
  // it back silently: another owner may already be driving.
  if (existing !== undefined && existing.ownerId !== ownerId && isLeaseLive(existing, at)) {
    return undefined;
  }
  const claim = claimLease({
    jobId,
    ownerId,
    existing,
    now: at,
    ttlMs: policy.leaseTtlMs,
    pid: process.pid,
    host: hostOf(deps),
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
  });
  return writeLease(deps.workspace, claim.lease);
}

export function releaseJobLease(
  deps: AutonomyDeps,
  jobId: string,
  ownerId: string,
  reason: string,
): void {
  const existing = readLease(deps.workspace, jobId);
  if (existing === undefined || existing.ownerId !== ownerId) return;
  writeLease(deps.workspace, releaseLeaseRecord(existing, now(deps), reason));
  appendSupervisionLog(deps, { ownerId, jobId, action: 'RELEASED_ON_TERMINAL_STATUS', detail: reason });
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Supervise one job until a terminal product state, an authority stop, or a
 * bound is reached.
 *
 * The interesting property is what this function does NOT need: no
 * conversation, no foreground terminal, no operator, and no memory of
 * previous cycles beyond what is on disk. Kill it at any point and start it
 * again and it continues from the same place with the same budgets.
 */
export async function superviseJob(
  deps: AutonomyDeps,
  jobId: string,
  options: SuperviseOptions,
): Promise<SupervisionResult> {
  const policy = autonomyPolicyOf(deps).supervisor;
  if (!policy.enabled) {
    throw new AutonomyError('SBA001', 'The supervisor is disabled by `autonomy.supervisor.enabled`.', {
      remediation: ['Run `specbridge autonomy setup --mode overnight`, or drive the job in the foreground.'],
    });
  }
  const ownerId = options.ownerId ?? `sup-${newId(deps)}`.slice(0, 60);
  const sleep = options.sleep ?? defaultSleep;
  const emit = (kind: SupervisionEvent['kind'], message: string): void => {
    options.onEvent?.({ kind, message });
  };

  const acquisition = acquireJobLease(deps, jobId, ownerId, policy);
  if (!acquisition.acquired) {
    throw new AutonomyError(
      'SBA008',
      `Job ${jobId} is already supervised by ${acquisition.heldBy ?? 'another process'}.`,
      {
        remediation: [
          'Inspect it with `specbridge autonomy status`.',
          `Wait for the lease to expire (at most ${Math.round(policy.leaseTtlMs / 1_000)}s) if that owner is gone.`,
        ],
        details: { jobId, heldBy: acquisition.heldBy ?? null },
      },
    );
  }
  emit('lease', `lease acquired by ${ownerId} (generation ${acquisition.lease?.generation ?? 1})`);

  const sessionStartedAt = nowIso(deps);
  let job = requireJobState(deps.workspace, jobId);
  let supervised = registerSupervisedJob(deps, {
    jobId,
    specName: job.specName,
    ownerId,
  });
  recordJobEvent(jobDepsOf(deps), jobId, 'supervisor_attached', {
    ownerId,
    host: options.host.label,
  });

  let cycles = 0;
  let stop: SupervisionStop | undefined;
  const maxCycles = options.maxCycles ?? Number.MAX_SAFE_INTEGER;

  try {
    while (cycles < maxCycles) {
      cycles += 1;
      if (options.signal?.aborted === true) {
        stop = { kind: 'interrupted' };
        break;
      }

      job = requireJobState(deps.workspace, jobId);
      const fingerprint = fingerprintOf(deps, job);
      const decision = decideSupervision({
        now: now(deps),
        policy,
        status: job.status,
        ...(job.operationalWait !== undefined ? { wait: job.operationalWait } : {}),
        ...(job.retryAt !== undefined ? { retryAt: job.retryAt } : {}),
        supervised,
        driverRunning: false,
        progressFingerprint: fingerprint,
        sessionStartedAt,
      });
      emit('decision', `${decision.action}: ${decision.reason}`);

      const outcome = await applyDecision(deps, {
        jobId,
        ownerId,
        policy,
        decision,
        supervised,
        fingerprint,
        options,
        sleep,
        emit,
      });
      supervised = outcome.supervised;
      if (outcome.stop !== undefined) {
        stop = outcome.stop;
        break;
      }
      renewJobLease(deps, jobId, ownerId, policy);
      persistSupervised(deps, ownerId, supervised);
    }
  } finally {
    persistSupervised(deps, ownerId, supervised);
    releaseJobLease(deps, jobId, ownerId, stop?.kind ?? 'supervision ended');
    recordJobEvent(jobDepsOf(deps), jobId, 'supervisor_detached', {
      ownerId,
      stop: stop?.kind ?? 'unknown',
      cycles,
    });
  }

  job = requireJobState(deps.workspace, jobId);
  return { stop: stop ?? { kind: 'cycles-exhausted' }, job, supervised, cycles };
}

interface ApplyResult {
  supervised: SupervisedJob;
  stop?: SupervisionStop | undefined;
}

async function applyDecision(
  deps: AutonomyDeps,
  input: {
    jobId: string;
    ownerId: string;
    policy: SupervisorPolicy;
    decision: SupervisionDecision;
    supervised: SupervisedJob;
    fingerprint: string;
    options: SuperviseOptions;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    emit: (kind: SupervisionEvent['kind'], message: string) => void;
  },
): Promise<ApplyResult> {
  const { decision, jobId, ownerId, policy } = input;
  switch (decision.action) {
    case 'RELEASE': {
      const job = requireJobState(deps.workspace, jobId);
      appendSupervisionLog(deps, {
        ownerId,
        jobId,
        action: job.status === 'COMPLETED' ? 'RELEASED_ON_TERMINAL_STATUS' : 'SESSION_BUDGET_REACHED',
        detail: decision.reason,
      });
      return {
        supervised: { ...input.supervised, status: 'RELEASED', releasedAt: nowIso(deps), releaseReason: decision.reason },
        stop:
          job.status === 'COMPLETED'
            ? { kind: 'completed', status: job.status }
            : { kind: 'released', reason: decision.reason },
      };
    }
    case 'WAIT_FOR_HUMAN': {
      const job = requireJobState(deps.workspace, jobId);
      appendSupervisionLog(deps, {
        ownerId,
        jobId,
        action: 'RELEASED_ON_AUTHORITY_STOP',
        detail: decision.reason,
      });
      return {
        supervised: { ...input.supervised, status: 'RELEASED', releasedAt: nowIso(deps), releaseReason: decision.reason },
        stop: {
          kind: 'needs-human',
          status: decision.status,
          detail: job.authorityRequest?.question ?? decision.reason,
        },
      };
    }
    case 'GIVE_UP': {
      appendSupervisionLog(deps, {
        ownerId,
        jobId,
        action:
          input.supervised.consecutiveRestarts >= policy.maxConsecutiveRestarts ||
          input.supervised.restarts >= policy.maxRestarts
            ? 'RESTART_BUDGET_EXHAUSTED'
            : 'INDEFINITE_WAIT_CLASSIFIED',
        detail: decision.reason,
      });
      return {
        supervised: { ...input.supervised, status: 'RELEASED', releasedAt: nowIso(deps), releaseReason: decision.reason },
        stop: { kind: 'gave-up', reason: decision.reason },
      };
    }
    case 'SLEEP_UNTIL': {
      const waitMs = Math.max(0, Date.parse(decision.wakeAt) - now(deps).getTime());
      appendSupervisionLog(deps, { ownerId, jobId, action: 'WAKE_SCHEDULED', detail: decision.reason });
      // Sleep in bounded slices so the lease stays fresh across a long wait:
      // a five-hour quota window must not look like a dead owner for four of
      // those hours.
      await sleepInSlices(deps, {
        totalMs: waitMs,
        sliceMs: policy.heartbeatIntervalMs,
        jobId,
        ownerId,
        policy,
        sleep: input.sleep,
        signal: input.options.signal,
      });
      appendSupervisionLog(deps, { ownerId, jobId, action: 'WOKEN_ON_SCHEDULE', detail: decision.wakeAt });
      const job = requireJobState(deps.workspace, jobId);
      if (isOperationalJobStatus(job.status)) {
        clearOperationalState(jobDepsOf(deps), jobId, { resolution: 'the scheduled wait elapsed' });
      }
      return { supervised: { ...input.supervised, status: 'SLEEPING' } };
    }
    case 'RECHECK_AFTER': {
      await input.sleep(decision.afterMs, input.options.signal);
      return { supervised: { ...input.supervised, status: 'SLEEPING' } };
    }
    case 'START_DRIVER':
    case 'RESTART_DRIVER': {
      if (decision.action === 'RESTART_DRIVER' && decision.backoffMs > 0) {
        await input.sleep(decision.backoffMs, input.options.signal);
      }
      const job = requireJobState(deps.workspace, jobId);
      if (isOperationalJobStatus(job.status)) {
        clearOperationalState(jobDepsOf(deps), jobId, {
          resolution: 'the supervisor is resuming the driver',
        });
      }
      appendSupervisionLog(deps, {
        ownerId,
        jobId,
        action: decision.action === 'START_DRIVER' ? 'DRIVER_STARTED' : 'DRIVER_RESTARTED',
        detail: decision.reason,
      });
      if (decision.action === 'RESTART_DRIVER') {
        countAutonomyEvent(jobDepsOf(deps), jobId, 'driverRestarts', 'driver_restarted', {
          reason: decision.reason.slice(0, 300),
          restarts: input.supervised.restarts + 1,
        });
      }
      const outcome = await input.options.host.run({
        jobId,
        ...(input.options.signal !== undefined ? { signal: input.options.signal } : {}),
        onEvent: (event) => input.emit('driver', `${event.kind}: ${event.message}`),
      });
      return { supervised: foldDriverOutcome(deps, input, outcome, decision.action) };
    }
    default: {
      return { supervised: input.supervised };
    }
  }
}

/**
 * Fold a driver exit back into supervision accounting.
 *
 * The progress comparison is the whole point. A driver that exited after
 * moving the job forward gets its backoff reset and its consecutive-restart
 * count cleared, because whatever it hit was survivable. A driver that
 * exited having changed nothing gets a doubled backoff and a strike, because
 * restarting it immediately would reproduce the same failure at full speed
 * for the rest of the night.
 */
function foldDriverOutcome(
  deps: AutonomyDeps,
  input: {
    jobId: string;
    ownerId: string;
    policy: SupervisorPolicy;
    supervised: SupervisedJob;
    fingerprint: string;
  },
  outcome: DriverRunOutcome,
  action: 'START_DRIVER' | 'RESTART_DRIVER',
): SupervisedJob {
  const after = fingerprintOf(deps, requireJobState(deps.workspace, input.jobId));
  const madeProgress = after !== input.fingerprint;
  const starts = input.supervised.starts + 1;
  const restarts = input.supervised.restarts + (action === 'RESTART_DRIVER' ? 1 : 0);
  const unclean = outcome.kind === 'crashed';

  appendSupervisionLog(deps, {
    ownerId: input.ownerId,
    jobId: input.jobId,
    action: unclean ? 'DRIVER_DIED' : 'DRIVER_EXITED_CLEANLY',
    detail:
      outcome.kind === 'crashed'
        ? outcome.error
        : outcome.kind === 'exited'
          ? `stop=${outcome.stop.kind}`
          : 'aborted',
  });

  if (madeProgress) {
    return supervisedJobSchema.parse({
      ...input.supervised,
      status: 'ACTIVE',
      starts,
      restarts,
      consecutiveRestarts: 0,
      backoffMs: 0,
      lastProgressFingerprint: after,
      lastProgressAt: nowIso(deps),
      nextAttemptAt: undefined,
      lastAction: unclean ? 'DRIVER_DIED' : 'DRIVER_EXITED_CLEANLY',
      lastActionAt: nowIso(deps),
    });
  }

  const backoffMs = nextBackoffMs(
    input.supervised.backoffMs,
    input.policy.restartBackoffMs,
    input.policy.maxRestartBackoffMs,
  );
  return supervisedJobSchema.parse({
    ...input.supervised,
    status: 'RESTARTING',
    starts,
    restarts,
    consecutiveRestarts: input.supervised.consecutiveRestarts + 1,
    backoffMs,
    lastProgressFingerprint: after,
    nextAttemptAt: new Date(now(deps).getTime() + backoffMs).toISOString(),
    lastAction: unclean ? 'DRIVER_DIED' : 'DRIVER_EXITED_CLEANLY',
    lastActionAt: nowIso(deps),
  });
}

async function sleepInSlices(
  deps: AutonomyDeps,
  input: {
    totalMs: number;
    sliceMs: number;
    jobId: string;
    ownerId: string;
    policy: SupervisorPolicy;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal | undefined;
  },
): Promise<void> {
  let remaining = input.totalMs;
  while (remaining > 0) {
    if (input.signal?.aborted === true) return;
    const slice = Math.min(remaining, Math.max(1, input.sliceMs));
    await input.sleep(slice, input.signal);
    remaining -= slice;
    const renewed = renewJobLease(deps, input.jobId, input.ownerId, input.policy);
    if (renewed === undefined) return;
    appendSupervisionLog(deps, {
      ownerId: input.ownerId,
      jobId: input.jobId,
      action: 'LEASE_RENEWED',
      generation: renewed.generation,
    });
  }
}

function persistSupervised(deps: AutonomyDeps, ownerId: string, supervised: SupervisedJob): void {
  const state: SupervisorState = loadSupervisorState(deps, ownerId);
  writeSupervisorState(deps.workspace, {
    ...upsertSupervisedJob(state, supervised),
    ownerId,
    heartbeatAt: nowIso(deps),
  });
}

/**
 * The job's current progress fingerprint, read fresh from durable state.
 *
 * Graph reads are best-effort: a job whose graph revision is unreadable
 * still has a status and counters, and refusing to fingerprint would make an
 * unreadable graph a supervision failure rather than the job-level failure
 * it actually is.
 */
function fingerprintOf(deps: AutonomyDeps, job: JobState): string {
  let completedNodes = 0;
  let totalAttempts = 0;
  try {
    const graph = readGraphRevision(deps.workspace, job.jobId, job.graphRevision);
    if (graph !== undefined) {
      for (const node of graph.nodes) {
        if (node.status === 'COMPLETED') completedNodes += 1;
        totalAttempts += node.attempts.length;
      }
    }
  } catch {
    // Fingerprints are a progress signal, not evidence.
  }
  return progressFingerprint({
    status: job.status,
    graphRevision: job.graphRevision,
    completedNodes,
    totalAttempts,
    agentRuns: job.counters.agentRuns,
  });
}

/** Whether this owner still holds the lease on a job. */
export function stillOwns(deps: AutonomyDeps, jobId: string, ownerId: string): boolean {
  return holdsLease(readLease(deps.workspace, jobId), ownerId, now(deps));
}
