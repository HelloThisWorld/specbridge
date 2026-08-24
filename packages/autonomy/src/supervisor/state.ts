import { z } from 'zod';
import { SUPERVISION_ACTIONS, SUPERVISION_STATUSES } from '../vocabulary.js';

/**
 * Durable supervisor state.
 *
 * The supervisor exists to answer one question a foreground terminal cannot:
 * *who owns this job right now, and is that owner still alive?* Everything
 * here is in service of that.
 *
 * The lease is the whole mechanism, and it is deliberately boring: an owner
 * id, an expiry, and a generation counter. No locks, no daemons talking to
 * each other, no assumption that a process gets to run cleanup code before
 * it dies — because the failure being handled is precisely the one where it
 * does not. A dead owner stops renewing; the lease expires; the next
 * supervisor reclaims it and bumps the generation. That is the entire
 * protocol, and it works identically whether the previous owner exited
 * cleanly, was killed, or the machine lost power.
 */

export const SUPERVISOR_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

/**
 * One job's lease.
 *
 * `pid` and `hostname` are DIAGNOSTIC, never authoritative. A pid can be
 * recycled and a hostname can be shared, so liveness is decided by
 * `expiresAt` alone — the fields are there so an operator inspecting a stuck
 * job can find the process, not so the runtime can trust them.
 */
export const jobLeaseSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    /** Identity of the owning supervisor. Stable for one supervisor process. */
    ownerId: shortText,
    /** Incremented on every reclaim. Detects a resurrected zombie owner. */
    generation: z.number().int().min(1),
    acquiredAt: shortText,
    renewedAt: shortText,
    /** Liveness deadline. The ONLY field that decides ownership. */
    expiresAt: shortText,
    pid: z.number().int().min(0).optional(),
    hostname: shortText.optional(),
    /** Host label of the process that took the lease (e.g. "cli"). */
    host: shortText.optional(),
    released: z.boolean().default(false),
    releasedAt: shortText.optional(),
    releaseReason: text.optional(),
  })
  .passthrough();
export type JobLease = z.infer<typeof jobLeaseSchema>;

/**
 * One supervised job's registration.
 *
 * Restart accounting lives here rather than on the job because it is about
 * the SUPERVISOR's behaviour, not the job's work: a job that has been
 * restarted four times has not failed four times, and folding the two
 * together would make the autonomy report say the product was harder than
 * it was.
 */
export const supervisedJobSchema = z
  .object({
    jobId: shortText,
    specName: shortText,
    sealId: shortText.optional(),
    status: z.enum(SUPERVISION_STATUSES),
    registeredAt: shortText,
    /** Total driver starts, including the first. */
    starts: z.number().int().min(0).default(0),
    /** Restarts after an unclean exit. */
    restarts: z.number().int().min(0).default(0),
    /** Restarts since the last observed forward progress. */
    consecutiveRestarts: z.number().int().min(0).default(0),
    /**
     * A progress fingerprint from the last driver exit. The supervisor
     * compares fingerprints rather than counting completions: "did anything
     * change" is the question that distinguishes a slow job from a crash
     * loop, and a job can make real progress without completing a node.
     */
    lastProgressFingerprint: shortText.optional(),
    lastProgressAt: shortText.optional(),
    /** Earliest instant the supervisor may start a driver again. */
    nextAttemptAt: shortText.optional(),
    /** Current backoff, doubled on each unproductive restart. */
    backoffMs: z.number().int().min(0).default(0),
    lastAction: z.enum(SUPERVISION_ACTIONS).optional(),
    lastActionAt: shortText.optional(),
    lastDetail: text.optional(),
    releasedAt: shortText.optional(),
    releaseReason: text.optional(),
  })
  .passthrough();
export type SupervisedJob = z.infer<typeof supervisedJobSchema>;

export const supervisorStateSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Identity of the supervisor process that last wrote this file. */
    ownerId: shortText,
    startedAt: shortText,
    heartbeatAt: shortText,
    pid: z.number().int().min(0).optional(),
    hostname: shortText.optional(),
    jobs: z.array(supervisedJobSchema).max(200).default([]),
  })
  .passthrough();
export type SupervisorState = z.infer<typeof supervisorStateSchema>;

/** One append-only supervision log line. */
export const supervisionLogEntrySchema = z
  .object({
    at: shortText,
    ownerId: shortText,
    jobId: shortText.optional(),
    action: z.enum(SUPERVISION_ACTIONS),
    detail: text.optional(),
    generation: z.number().int().min(0).optional(),
  })
  .passthrough();
export type SupervisionLogEntry = z.infer<typeof supervisionLogEntrySchema>;
