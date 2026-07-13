import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import { readRunRecord } from './run-store.js';

/**
 * Repository-local interactive execution lock.
 *
 * Exactly one interactive task run may be active per repository. The lock
 * lives at `.specbridge/locks/interactive-task.lock` (an ignored runtime
 * path) and is acquired atomically with an exclusive create (`wx`), which is
 * atomic on every platform Node supports, including Windows.
 *
 * A crashed process leaves the lock behind by design: SpecBridge never
 * steals a lock silently. Staleness is *diagnosed* (owner process dead, run
 * already finalized, heartbeat old) and removal always requires the explicit
 * `specbridge run recover-lock --remove` confirmation.
 */

export const INTERACTIVE_LOCK_SCHEMA_VERSION = '1.0.0';

export const interactiveLockSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    runId: z.string().min(1),
    specName: z.string().min(1),
    taskId: z.string().min(1),
    /** Process that acquired the lock; 0 when not meaningful. */
    pid: z.number().int().nonnegative(),
    createdAt: z.string(),
    heartbeatAt: z.string(),
  })
  .passthrough();
export type InteractiveLock = z.infer<typeof interactiveLockSchema>;

export function interactiveLockPath(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, 'locks', 'interactive-task.lock'),
  );
}

export type LockReadResult =
  | { state: 'absent'; path: string }
  | { state: 'held'; path: string; lock: InteractiveLock }
  | { state: 'unreadable'; path: string; problem: string };

export function readInteractiveLock(workspace: WorkspaceInfo): LockReadResult {
  const lockPath = interactiveLockPath(workspace);
  if (!existsSync(lockPath)) return { state: 'absent', path: lockPath };
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (cause) {
    return {
      state: 'unreadable',
      path: lockPath,
      problem: `the lock file could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  try {
    const parsed = interactiveLockSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { state: 'unreadable', path: lockPath, problem: 'the lock file does not match the expected schema' };
    }
    return { state: 'held', path: lockPath, lock: parsed.data };
  } catch {
    return { state: 'unreadable', path: lockPath, problem: 'the lock file is not valid JSON' };
  }
}

export type LockAcquisition =
  | { acquired: true; path: string; lock: InteractiveLock }
  | { acquired: false; path: string; existing?: InteractiveLock; problem: string };

/** Atomically acquire the lock. Never overwrites an existing lock. */
export function acquireInteractiveLock(
  workspace: WorkspaceInfo,
  details: { runId: string; specName: string; taskId: string; clock?: () => Date; pid?: number },
): LockAcquisition {
  const lockPath = interactiveLockPath(workspace);
  const now = (details.clock ?? ((): Date => new Date()))().toISOString();
  const lock: InteractiveLock = {
    schemaVersion: INTERACTIVE_LOCK_SCHEMA_VERSION,
    runId: details.runId,
    specName: details.specName,
    taskId: details.taskId,
    pid: details.pid ?? process.pid,
    createdAt: now,
    heartbeatAt: now,
  };
  mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    // 'wx' fails atomically when the file already exists — the whole point.
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
    return { acquired: true, path: lockPath, lock };
  } catch {
    const existing = readInteractiveLock(workspace);
    return {
      acquired: false,
      path: lockPath,
      ...(existing.state === 'held' ? { existing: existing.lock } : {}),
      problem:
        existing.state === 'held'
          ? `an interactive run is already active (run ${existing.lock.runId}, spec "${existing.lock.specName}", task ${existing.lock.taskId})`
          : 'an interactive lock file already exists but could not be read',
    };
  }
}

/** Refresh the heartbeat of a lock this run holds. No-op when not the owner. */
export function heartbeatInteractiveLock(
  workspace: WorkspaceInfo,
  runId: string,
  clock: () => Date = () => new Date(),
): boolean {
  const read = readInteractiveLock(workspace);
  if (read.state !== 'held' || read.lock.runId !== runId) return false;
  writeFileAtomic(read.path, `${JSON.stringify({ ...read.lock, heartbeatAt: clock().toISOString() }, null, 2)}\n`);
  return true;
}

/**
 * Release the lock held by `runId`. Releasing is idempotent; a lock held by
 * a DIFFERENT run is never touched.
 */
export function releaseInteractiveLock(
  workspace: WorkspaceInfo,
  runId: string,
): { released: boolean; problem?: string } {
  const read = readInteractiveLock(workspace);
  if (read.state === 'absent') return { released: false, problem: 'no lock is held' };
  if (read.state === 'unreadable') {
    return { released: false, problem: `the lock is unreadable (${read.problem}); use "specbridge run recover-lock"` };
  }
  if (read.lock.runId !== runId) {
    return {
      released: false,
      problem: `the lock is held by a different run (${read.lock.runId}); refusing to release it`,
    };
  }
  rmSync(read.path, { force: true });
  return { released: true };
}

export interface LockDiagnosis {
  state: 'absent' | 'active' | 'stale' | 'ambiguous' | 'unreadable';
  path: string;
  lock?: InteractiveLock;
  /** Human-readable findings explaining the state. */
  findings: string[];
  /** True only when explicit removal is considered safe. */
  safeToRemove: boolean;
}

/** Heartbeats older than this are considered evidence of staleness. */
export const LOCK_STALE_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

function processAlive(pid: number): boolean | undefined {
  if (pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // exists, owned by someone else
    return undefined;
  }
}

/**
 * Diagnose the current lock without changing anything.
 *
 * `stale` (safe to remove) requires positive evidence: the referenced run is
 * already finalized, OR the owning process is provably dead, OR the
 * heartbeat is very old AND the owner cannot be confirmed alive. A lock
 * whose owner is alive is `active`; anything short of positive evidence is
 * `ambiguous` and is never removed.
 */
export function diagnoseInteractiveLock(
  workspace: WorkspaceInfo,
  clock: () => Date = () => new Date(),
): LockDiagnosis {
  const read = readInteractiveLock(workspace);
  if (read.state === 'absent') {
    return { state: 'absent', path: read.path, findings: ['No interactive lock is held.'], safeToRemove: false };
  }
  if (read.state === 'unreadable') {
    return {
      state: 'unreadable',
      path: read.path,
      findings: [
        `The lock file exists but is unreadable: ${read.problem}.`,
        'Inspect the file manually; removal requires the explicit --remove confirmation.',
      ],
      // An unreadable lock cannot protect anything, but removal still
      // requires the explicit confirmation flag.
      safeToRemove: true,
    };
  }

  const lock = read.lock;
  const findings: string[] = [];
  const record = readRunRecord(workspace, lock.runId);

  if (record === undefined) {
    findings.push(`The lock references run ${lock.runId}, which has no readable run record.`);
  } else if (record.lifecycleStatus === 'COMPLETED' || record.lifecycleStatus === 'ABORTED') {
    findings.push(
      `The lock references run ${lock.runId}, which is already finalized (${record.lifecycleStatus}); the lock should have been released.`,
    );
    return { state: 'stale', path: read.path, lock, findings, safeToRemove: true };
  } else {
    findings.push(`The lock references run ${lock.runId} (spec "${lock.specName}", task ${lock.taskId}), still awaiting completion.`);
  }

  const alive = processAlive(lock.pid);
  if (alive === false) {
    findings.push(`The owning process (pid ${lock.pid}) is no longer running.`);
    return { state: 'stale', path: read.path, lock, findings, safeToRemove: true };
  }
  if (alive === true) {
    findings.push(`The owning process (pid ${lock.pid}) is still running.`);
    return { state: 'active', path: read.path, lock, findings, safeToRemove: false };
  }

  findings.push(`The owning process (pid ${lock.pid}) cannot be checked on this system.`);
  const heartbeatAge = clock().getTime() - Date.parse(lock.heartbeatAt);
  if (Number.isFinite(heartbeatAge) && heartbeatAge > LOCK_STALE_HEARTBEAT_MS) {
    findings.push(
      `The lock heartbeat is ${Math.round(heartbeatAge / 3_600_000)}h old (threshold ${LOCK_STALE_HEARTBEAT_MS / 3_600_000}h).`,
    );
    return { state: 'stale', path: read.path, lock, findings, safeToRemove: true };
  }
  findings.push('The lock heartbeat is recent; the owner may still be alive.');
  return { state: 'ambiguous', path: read.path, lock, findings, safeToRemove: false };
}

/**
 * Remove a lock previously diagnosed as safe to remove. The fresh
 * re-diagnosis here means a lock that became active again in the meantime
 * is left alone even when the caller confirmed removal.
 */
export function removeDiagnosedLock(
  workspace: WorkspaceInfo,
  clock: () => Date = () => new Date(),
): { removed: boolean; diagnosis: LockDiagnosis } {
  const diagnosis = diagnoseInteractiveLock(workspace, clock);
  if (!diagnosis.safeToRemove) return { removed: false, diagnosis };
  rmSync(diagnosis.path, { force: true });
  return { removed: true, diagnosis };
}
