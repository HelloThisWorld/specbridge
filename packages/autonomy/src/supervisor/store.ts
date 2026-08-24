import os from 'node:os';
import type { WorkspaceInfo } from '@specbridge/core';
import type { AutonomyDeps } from '../deps.js';
import { nowIso } from '../deps.js';
import {
  appendJsonl,
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  readJsonl,
  writeJsonRecord,
} from '../store.js';
import type { JobLease, SupervisedJob, SupervisionLogEntry, SupervisorState } from './state.js';
import {
  SUPERVISOR_SCHEMA_VERSION,
  jobLeaseSchema,
  supervisedJobSchema,
  supervisionLogEntrySchema,
  supervisorStateSchema,
} from './state.js';
import type { SupervisionAction } from '../vocabulary.js';

/** Supervisor persistence under `.specbridge/autonomy/supervisor/`. */

export function supervisorDir(workspace: WorkspaceInfo): string {
  return autonomyPath(workspace, 'supervisor');
}

export function supervisorStateFile(workspace: WorkspaceInfo): string {
  return autonomyPath(workspace, 'supervisor', 'state.json');
}

export function leaseFile(workspace: WorkspaceInfo, jobId: string): string {
  assertAutonomyId('job', jobId);
  return autonomyPath(workspace, 'supervisor', 'leases', `${jobId}.json`);
}

export function supervisionLogFile(workspace: WorkspaceInfo): string {
  return autonomyPath(workspace, 'supervisor', 'log.jsonl');
}

export function readLease(workspace: WorkspaceInfo, jobId: string): JobLease | undefined {
  return readJsonRecord(leaseFile(workspace, jobId), (raw) => jobLeaseSchema.parse(raw));
}

export function writeLease(workspace: WorkspaceInfo, lease: JobLease): JobLease {
  const validated = jobLeaseSchema.parse(lease);
  writeJsonRecord(leaseFile(workspace, validated.jobId), validated);
  return validated;
}

export function listLeases(workspace: WorkspaceInfo): JobLease[] {
  return listJsonRecords(autonomyPath(workspace, 'supervisor', 'leases'), (raw) =>
    jobLeaseSchema.parse(raw),
  );
}

export function readSupervisorState(workspace: WorkspaceInfo): SupervisorState | undefined {
  return readJsonRecord(supervisorStateFile(workspace), (raw) => supervisorStateSchema.parse(raw));
}

export function writeSupervisorState(
  workspace: WorkspaceInfo,
  state: SupervisorState,
): SupervisorState {
  const validated = supervisorStateSchema.parse(state);
  writeJsonRecord(supervisorStateFile(workspace), validated);
  return validated;
}

/**
 * Read the registry, creating an empty one owned by this process if absent.
 *
 * The registry is a CONVENIENCE index, not authority: the leases are the
 * ownership record, and a lost or corrupt `state.json` costs the supervisor
 * its restart counters, not its correctness. That is why this function is
 * happy to invent one rather than failing — an unattended run must not stop
 * because a bookkeeping file went missing.
 */
export function loadSupervisorState(deps: AutonomyDeps, ownerId: string): SupervisorState {
  const existing = readSupervisorState(deps.workspace);
  if (existing !== undefined) return existing;
  return supervisorStateSchema.parse({
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    ownerId,
    startedAt: nowIso(deps),
    heartbeatAt: nowIso(deps),
    pid: process.pid,
    hostname: safeHostname(),
    jobs: [],
  });
}

/**
 * The machine name, for diagnostics only.
 *
 * Wrapped because a platform that refuses to report one must not prevent
 * supervision from starting: ownership is decided by the lease expiry, and
 * this string only helps a person find the process afterwards.
 */
export function safeHostname(): string | undefined {
  try {
    return os.hostname().slice(0, 200);
  } catch {
    return undefined;
  }
}

export function upsertSupervisedJob(
  state: SupervisorState,
  job: SupervisedJob,
): SupervisorState {
  const jobs = state.jobs.filter((entry) => entry.jobId !== job.jobId);
  jobs.push(supervisedJobSchema.parse(job));
  return { ...state, jobs };
}

export function findSupervisedJob(
  state: SupervisorState,
  jobId: string,
): SupervisedJob | undefined {
  return state.jobs.find((entry) => entry.jobId === jobId);
}

export function appendSupervisionLog(
  deps: AutonomyDeps,
  entry: { ownerId: string; jobId?: string | undefined; action: SupervisionAction; detail?: string | undefined; generation?: number | undefined },
): SupervisionLogEntry {
  const validated = supervisionLogEntrySchema.parse({
    at: nowIso(deps),
    ownerId: entry.ownerId,
    ...(entry.jobId !== undefined ? { jobId: entry.jobId } : {}),
    action: entry.action,
    ...(entry.detail !== undefined ? { detail: entry.detail.slice(0, 4_000) } : {}),
    ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
  });
  appendJsonl(supervisionLogFile(deps.workspace), validated);
  return validated;
}

export function readSupervisionLog(
  workspace: WorkspaceInfo,
  limit = 500,
): SupervisionLogEntry[] {
  return readJsonl(
    supervisionLogFile(workspace),
    (raw) => supervisionLogEntrySchema.parse(raw),
    limit,
  ).entries;
}
