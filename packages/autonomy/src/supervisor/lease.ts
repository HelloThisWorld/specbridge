import type { JobLease } from './state.js';

/**
 * Lease arithmetic.
 *
 * Pure functions over values, with no I/O and no clock of their own: every
 * one takes `now` as an argument. That is not ceremony — the reason a
 * distributed-ish ownership protocol is testable at all is that its entire
 * decision surface is `(lease, now, ttl)`, and a hidden clock would put half
 * of it out of reach.
 */

export function leaseExpiry(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

/**
 * Whether a lease is still held.
 *
 * A released lease is dead regardless of its expiry, and an expired lease is
 * dead regardless of who wrote it. There is deliberately no "grace period":
 * a lease TTL is already several heartbeats wide, and adding a second fuzzy
 * boundary would only make "is it mine?" harder to answer under exactly the
 * conditions where the answer matters.
 */
export function isLeaseLive(lease: JobLease | undefined, now: Date): boolean {
  if (lease === undefined) return false;
  if (lease.released) return false;
  return Date.parse(lease.expiresAt) > now.getTime();
}

/** Whether this owner currently holds the lease. */
export function holdsLease(lease: JobLease | undefined, ownerId: string, now: Date): boolean {
  return isLeaseLive(lease, now) && lease?.ownerId === ownerId;
}

/**
 * Whether a supervisor may take a lease it does not hold.
 *
 * Only when nobody holds it. A supervisor never preempts a live owner, even
 * one that looks stuck: two drivers mutating one job's durable state is the
 * one failure this protocol exists to prevent, and "it looked stuck" is
 * exactly how that happens.
 */
export function isReclaimable(lease: JobLease | undefined, now: Date): boolean {
  return !isLeaseLive(lease, now);
}

export interface LeaseClaim {
  lease: JobLease;
  /** True when this claim took over from a previous owner that went silent. */
  reclaimed: boolean;
  /** The previous owner, when there was one. Diagnostic only. */
  previousOwnerId?: string | undefined;
}

/**
 * Build the lease record for a new or renewed claim.
 *
 * The generation bump on reclaim is what makes a resurrected zombie owner
 * detectable: an owner that comes back from a long stop-the-world pause and
 * tries to renew a lease it no longer holds finds a higher generation and
 * stands down instead of writing over the new owner's work.
 */
export function claimLease(input: {
  jobId: string;
  ownerId: string;
  existing: JobLease | undefined;
  now: Date;
  ttlMs: number;
  pid?: number | undefined;
  hostname?: string | undefined;
  host?: string | undefined;
  schemaVersion: string;
}): LeaseClaim {
  const at = input.now.toISOString();
  const expiresAt = leaseExpiry(input.now, input.ttlMs);
  const mine = holdsLease(input.existing, input.ownerId, input.now);
  const generation = mine
    ? (input.existing?.generation ?? 1)
    : (input.existing?.generation ?? 0) + 1;
  const lease: JobLease = {
    schemaVersion: input.schemaVersion,
    jobId: input.jobId,
    ownerId: input.ownerId,
    generation,
    acquiredAt: mine ? (input.existing?.acquiredAt ?? at) : at,
    renewedAt: at,
    expiresAt,
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    released: false,
  };
  const previousOwnerId = input.existing?.ownerId;
  return {
    lease,
    reclaimed: !mine && input.existing !== undefined,
    ...(previousOwnerId !== undefined ? { previousOwnerId } : {}),
  };
}

/** Mark a lease released. Idempotent. */
export function releaseLeaseRecord(lease: JobLease, now: Date, reason: string): JobLease {
  return {
    ...lease,
    released: true,
    releasedAt: now.toISOString(),
    releaseReason: reason.slice(0, 4_000),
  };
}

/**
 * Exponential backoff for the next restart, bounded on both ends.
 *
 * Doubling is the standard shape; the interesting decision is that the
 * backoff resets to zero on PROGRESS rather than on a successful start. A
 * driver that starts cleanly and then dies again five seconds later has not
 * earned a fresh budget, and treating a start as success is how a crash loop
 * runs all night at full speed.
 */
export function nextBackoffMs(current: number, floorMs: number, ceilingMs: number): number {
  if (current <= 0) return Math.min(floorMs, ceilingMs);
  return Math.min(current * 2, ceilingMs);
}
