import { describe, expect, it } from 'vitest';
import { overnightAutonomyPreset } from '@specbridge/core';
import type { DriverHost, DriverRunOutcome, SupervisedJob } from '@specbridge/autonomy';
import {
  acquireJobLease,
  claimLease,
  decideSupervision,
  holdsLease,
  isLeaseLive,
  isReclaimable,
  nextBackoffMs,
  progressFingerprint,
  releaseLeaseRecord,
} from '@specbridge/autonomy';

/**
 * Supervisor tests.
 *
 * Split deliberately: lease arithmetic and the supervision decision are pure
 * and get exhaustive coverage here, because they are where every unattended
 * failure mode is actually decided. The loop that wires them to the world is
 * exercised end-to-end in the zero-touch certification, where a fake
 * `DriverHost` can crash on demand.
 */

const POLICY = overnightAutonomyPreset().supervisor;

function supervised(overrides: Partial<SupervisedJob> = {}): SupervisedJob {
  return {
    jobId: 'job-1',
    specName: 'ready-feature',
    status: 'ACTIVE',
    registeredAt: '2026-08-20T21:00:00.000Z',
    starts: 1,
    restarts: 0,
    consecutiveRestarts: 0,
    backoffMs: 0,
    ...overrides,
  } as SupervisedJob;
}

const T0 = new Date('2026-08-20T22:00:00.000Z');

describe('lease arithmetic', () => {
  it('a fresh lease is live and belongs to its owner', () => {
    const claim = claimLease({
      jobId: 'job-1',
      ownerId: 'sup-a',
      existing: undefined,
      now: T0,
      ttlMs: 90_000,
      schemaVersion: '1.0.0',
    });
    expect(claim.reclaimed).toBe(false);
    expect(claim.lease.generation).toBe(1);
    expect(isLeaseLive(claim.lease, T0)).toBe(true);
    expect(holdsLease(claim.lease, 'sup-a', T0)).toBe(true);
    expect(holdsLease(claim.lease, 'sup-b', T0)).toBe(false);
  });

  it('an expired lease is reclaimable and bumps the generation', () => {
    const first = claimLease({
      jobId: 'job-1',
      ownerId: 'sup-a',
      existing: undefined,
      now: T0,
      ttlMs: 90_000,
      schemaVersion: '1.0.0',
    }).lease;
    const later = new Date(T0.getTime() + 120_000);
    expect(isLeaseLive(first, later)).toBe(false);
    expect(isReclaimable(first, later)).toBe(true);

    const second = claimLease({
      jobId: 'job-1',
      ownerId: 'sup-b',
      existing: first,
      now: later,
      ttlMs: 90_000,
      schemaVersion: '1.0.0',
    });
    expect(second.reclaimed).toBe(true);
    expect(second.previousOwnerId).toBe('sup-a');
    expect(second.lease.generation).toBe(2);
  });

  it('a live lease held by someone else is never reclaimable', () => {
    const lease = claimLease({
      jobId: 'job-1',
      ownerId: 'sup-a',
      existing: undefined,
      now: T0,
      ttlMs: 90_000,
      schemaVersion: '1.0.0',
    }).lease;
    const soon = new Date(T0.getTime() + 30_000);
    expect(isReclaimable(lease, soon)).toBe(false);
  });

  it('a released lease is dead even before it expires', () => {
    const lease = claimLease({
      jobId: 'job-1',
      ownerId: 'sup-a',
      existing: undefined,
      now: T0,
      ttlMs: 90_000,
      schemaVersion: '1.0.0',
    }).lease;
    const released = releaseLeaseRecord(lease, T0, 'job completed');
    expect(isLeaseLive(released, T0)).toBe(false);
    expect(isReclaimable(released, T0)).toBe(true);
  });

  it('renewing preserves the acquisition time and the generation', () => {
    const first = claimLease({
      jobId: 'job-1',
      ownerId: 'sup-a',
      existing: undefined,
      now: T0,
      ttlMs: 90_000,
      schemaVersion: '1.0.0',
    }).lease;
    const renewed = claimLease({
      jobId: 'job-1',
      ownerId: 'sup-a',
      existing: first,
      now: new Date(T0.getTime() + 20_000),
      ttlMs: 90_000,
      schemaVersion: '1.0.0',
    });
    expect(renewed.reclaimed).toBe(false);
    expect(renewed.lease.generation).toBe(1);
    expect(renewed.lease.acquiredAt).toBe(first.acquiredAt);
    expect(Date.parse(renewed.lease.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
  });

  it('backoff doubles from the floor and stops at the ceiling', () => {
    expect(nextBackoffMs(0, 5_000, 60_000)).toBe(5_000);
    expect(nextBackoffMs(5_000, 5_000, 60_000)).toBe(10_000);
    expect(nextBackoffMs(40_000, 5_000, 60_000)).toBe(60_000);
    expect(nextBackoffMs(60_000, 5_000, 60_000)).toBe(60_000);
  });
});

describe('supervision decision', () => {
  const base = {
    now: T0,
    policy: POLICY,
    driverRunning: false,
    progressFingerprint: 'READY:1:0:0:0',
    sessionStartedAt: '2026-08-20T21:00:00.000Z',
  };

  it('releases a completed job', () => {
    const decision = decideSupervision({ ...base, status: 'COMPLETED', supervised: supervised() });
    expect(decision.action).toBe('RELEASE');
  });

  it('releases rather than holding a job that needs a human', () => {
    for (const status of ['NEEDS_AUTHORITY', 'NEEDS_CLARIFICATION', 'BLOCKED'] as const) {
      const decision = decideSupervision({ ...base, status, supervised: supervised() });
      expect(decision.action, status).toBe('WAIT_FOR_HUMAN');
    }
  });

  it('starts a driver for a job that has never run', () => {
    const decision = decideSupervision({
      ...base,
      status: 'READY',
      supervised: supervised({ starts: 0, status: 'REGISTERED' }),
    });
    expect(decision.action).toBe('START_DRIVER');
  });

  it('sleeps until a known wake time rather than polling', () => {
    const wakeAt = new Date(T0.getTime() + 4 * 3_600_000).toISOString();
    const decision = decideSupervision({
      ...base,
      status: 'WAITING_RESOURCE',
      wait: { kind: 'SUBSCRIPTION_QUOTA_RESET', wakeAt, startedAt: T0.toISOString(), checks: 0 },
      supervised: supervised(),
    });
    expect(decision.action).toBe('SLEEP_UNTIL');
    if (decision.action === 'SLEEP_UNTIL') expect(decision.wakeAt).toBe(wakeAt);
  });

  it('restarts the driver as soon as a scheduled wait has elapsed', () => {
    const wakeAt = new Date(T0.getTime() - 1_000).toISOString();
    const decision = decideSupervision({
      ...base,
      status: 'WAITING_RESOURCE',
      wait: { kind: 'SUBSCRIPTION_QUOTA_RESET', wakeAt, startedAt: T0.toISOString(), checks: 1 },
      supervised: supervised(),
    });
    expect(decision.action).toBe('RESTART_DRIVER');
  });

  it('re-checks an open-ended wait instead of sleeping blind', () => {
    const decision = decideSupervision({
      ...base,
      status: 'RECOVERING_PROVIDER',
      wait: { kind: 'UNKNOWN_CAPACITY', startedAt: T0.toISOString(), checks: 2 },
      supervised: supervised(),
    });
    expect(decision.action).toBe('RECHECK_AFTER');
    if (decision.action === 'RECHECK_AFTER') expect(decision.afterMs).toBe(POLICY.pollIntervalMs);
  });

  it('classifies an open-ended wait honestly once it exceeds the ceiling', () => {
    const started = new Date(T0.getTime() - POLICY.maxIndefiniteWaitMs - 1_000).toISOString();
    const decision = decideSupervision({
      ...base,
      status: 'RECOVERING_PROVIDER',
      wait: { kind: 'UNKNOWN_CAPACITY', startedAt: started, checks: 99 },
      supervised: supervised(),
    });
    expect(decision.action).toBe('GIVE_UP');
    if (decision.action === 'GIVE_UP') expect(decision.reason).toMatch(/no observable return/);
  });

  it('gives up immediately when no recovery path exists at all', () => {
    const decision = decideSupervision({
      ...base,
      status: 'WAITING_RESOURCE',
      wait: { kind: 'NO_RECOVERY_IDENTIFIED', startedAt: T0.toISOString(), checks: 1 },
      supervised: supervised(),
    });
    expect(decision.action).toBe('GIVE_UP');
    if (decision.action === 'GIVE_UP') expect(decision.reason).toMatch(/dishonest/);
  });

  it('stops restarting when consecutive restarts produced no progress', () => {
    const decision = decideSupervision({
      ...base,
      status: 'READY',
      supervised: supervised({
        consecutiveRestarts: POLICY.maxConsecutiveRestarts,
        lastProgressFingerprint: base.progressFingerprint,
      }),
    });
    expect(decision.action).toBe('GIVE_UP');
    if (decision.action === 'GIVE_UP') expect(decision.reason).toMatch(/no progress/);
  });

  it('keeps restarting while progress is being made, however many times', () => {
    const decision = decideSupervision({
      ...base,
      status: 'READY',
      supervised: supervised({
        consecutiveRestarts: POLICY.maxConsecutiveRestarts,
        restarts: POLICY.maxConsecutiveRestarts,
        lastProgressFingerprint: 'READY:1:0:0:0-older',
      }),
    });
    expect(decision.action).toBe('RESTART_DRIVER');
  });

  it('honours the total restart budget even when progress is being made', () => {
    const decision = decideSupervision({
      ...base,
      status: 'READY',
      supervised: supervised({
        restarts: POLICY.maxRestarts,
        lastProgressFingerprint: 'something-older',
      }),
    });
    expect(decision.action).toBe('GIVE_UP');
    if (decision.action === 'GIVE_UP') expect(decision.reason).toMatch(/restart budget/);
  });

  it('waits out the backoff before restarting again', () => {
    const decision = decideSupervision({
      ...base,
      status: 'READY',
      supervised: supervised({
        restarts: 2,
        consecutiveRestarts: 1,
        backoffMs: 20_000,
        nextAttemptAt: new Date(T0.getTime() + 10_000).toISOString(),
        lastProgressFingerprint: base.progressFingerprint,
      }),
    });
    expect(decision.action).toBe('RECHECK_AFTER');
  });

  it('ends the session at its ceiling, leaving the job resumable', () => {
    const decision = decideSupervision({
      ...base,
      status: 'READY',
      sessionStartedAt: new Date(T0.getTime() - POLICY.maxSessionMs - 1_000).toISOString(),
      supervised: supervised(),
    });
    expect(decision.action).toBe('RELEASE');
    if (decision.action === 'RELEASE') expect(decision.reason).toMatch(/resumable/);
  });

  it('does nothing but wait while a driver is running', () => {
    const decision = decideSupervision({
      ...base,
      status: 'RUNNING',
      driverRunning: true,
      supervised: supervised(),
    });
    expect(decision.action).toBe('RECHECK_AFTER');
  });
});

describe('progress fingerprint', () => {
  it('changes when work moves and not otherwise', () => {
    const a = progressFingerprint({
      status: 'RUNNING',
      graphRevision: 1,
      completedNodes: 2,
      totalAttempts: 5,
      agentRuns: 9,
    });
    const same = progressFingerprint({
      status: 'RUNNING',
      graphRevision: 1,
      completedNodes: 2,
      totalAttempts: 5,
      agentRuns: 9,
    });
    const moved = progressFingerprint({
      status: 'RUNNING',
      graphRevision: 1,
      completedNodes: 3,
      totalAttempts: 6,
      agentRuns: 11,
    });
    expect(same).toBe(a);
    expect(moved).not.toBe(a);
  });
});

describe('driver host contract', () => {
  it('a host reports a crash as an outcome rather than throwing', async () => {
    const host: DriverHost = {
      label: 'test',
      async run(): Promise<DriverRunOutcome> {
        return { kind: 'crashed', error: 'simulated driver defect' };
      },
    };
    await expect(host.run({ jobId: 'job-1' })).resolves.toEqual({
      kind: 'crashed',
      error: 'simulated driver defect',
    });
  });
});

describe('lease persistence', () => {
  it('refuses to take a lease a live owner already holds', async () => {
    const { setupAutonomyFixture } = await import('../helpers-autonomy.js');
    const fixture = setupAutonomyFixture();
    const first = acquireJobLease(fixture.deps, 'job-1', 'sup-a', POLICY);
    expect(first.acquired).toBe(true);

    const second = acquireJobLease(fixture.deps, 'job-1', 'sup-b', POLICY);
    expect(second.acquired).toBe(false);
    expect(second.heldBy).toBe('sup-a');
  });
});
