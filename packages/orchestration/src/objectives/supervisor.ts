import type { WorkspaceInfo } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import type { AgentRole } from '../jobs/vocabulary.js';
import type { ObjectiveWorkerRecord, WorkGraph } from './state.js';
import { OBJECTIVE_WORKER_SCHEMA_VERSION } from './state.js';
import { findUnit } from './graph.js';
import { readWorkerRecord, storeWorkerRecord } from './store.js';

/**
 * The AgentSupervisor: worker identity and fail-closed result acceptance.
 *
 * Every worker attempt gets a durable identity record BEFORE it runs:
 * (workerId, agentRole, workUnitId, attempt, contextProjectionHash,
 * contractSnapshotHash, workspaceIdentity, status, budget). A result is
 * accepted only when it presents the identity of the RUNNING record for
 * its work unit and attempt — a result delivered to the wrong identity is
 * rejected even if its content looks valid.
 *
 * Workers never message each other. The only communication path is
 * worker → structured artifact → SpecBridge → another worker's context
 * projection; nothing in this module (or anywhere else) can carry one
 * worker's conversation to another.
 */

export interface BeginWorkerInput {
  workspace: WorkspaceInfo;
  jobId: string;
  objectiveNodeId: string;
  workUnitId: string;
  attempt: number;
  agentRole: AgentRole;
  workerId: string;
  contextProjectionHash: string;
  contractSnapshotHash: string;
  /** "worktree:<name>", "canonical", or "ephemeral". */
  workspaceIdentity: string;
  timeoutMs: number;
  startedAt: string;
}

/** Record a worker attempt as RUNNING. Refuses duplicate live identities. */
export function beginWorker(input: BeginWorkerInput): ObjectiveWorkerRecord {
  const existing = readWorkerRecord(
    input.workspace,
    input.jobId,
    input.objectiveNodeId,
    input.workUnitId,
    input.attempt,
    input.agentRole,
  );
  if (existing !== undefined && existing.status === 'RUNNING') {
    throw new OrchestrationError(
      'SBO042',
      `A ${input.agentRole} worker is already RUNNING for ${input.workUnitId} attempt ${input.attempt}; ` +
        'two workers can never own one work-unit attempt.',
    );
  }
  if (existing !== undefined && existing.status === 'FINISHED') {
    throw new OrchestrationError(
      'SBO042',
      `Attempt ${input.attempt} of ${input.workUnitId} already finished; a new attempt needs a new attempt number.`,
    );
  }
  return storeWorkerRecord(input.workspace, input.jobId, input.objectiveNodeId, {
    schemaVersion: OBJECTIVE_WORKER_SCHEMA_VERSION,
    workerId: input.workerId,
    agentRole: input.agentRole,
    jobId: input.jobId,
    objectiveNodeId: input.objectiveNodeId,
    workUnitId: input.workUnitId,
    attempt: input.attempt,
    contextProjectionHash: input.contextProjectionHash,
    contractSnapshotHash: input.contractSnapshotHash,
    workspaceIdentity: input.workspaceIdentity,
    status: 'RUNNING',
    budget: { timeoutMs: input.timeoutMs },
    startedAt: input.startedAt,
  });
}

export interface WorkerResultIdentity {
  workerId: string;
  agentRole: AgentRole;
  workUnitId: string;
  attempt: number;
  contextProjectionHash: string;
  contractSnapshotHash: string;
}

export type ResultAcceptance =
  | { ok: true; record: ObjectiveWorkerRecord }
  | { ok: false; code: 'SBO042'; problem: string };

/**
 * Decide whether a delivered result may be accepted. Pure with respect to
 * the decision; the caller marks the record afterwards. Every rejection is
 * closed — the specific scenarios below are each exercised by tests:
 *
 *   - unknown work unit / no identity record       → rejected
 *   - identity fields do not match the record      → rejected (wrong worker)
 *   - record is FINISHED                           → rejected (duplicate)
 *   - record is SUPERSEDED                          → rejected (late result)
 *   - projection or contract-snapshot hash mismatch → rejected (stale/forged)
 *   - work unit was superseded in the current graph → rejected
 */
export function acceptWorkerResult(
  workspace: WorkspaceInfo,
  jobId: string,
  objectiveNodeId: string,
  graph: WorkGraph,
  identity: WorkerResultIdentity,
): ResultAcceptance {
  const reject = (problem: string): ResultAcceptance => ({ ok: false, code: 'SBO042', problem });

  const unit = findUnit(graph, identity.workUnitId);
  if (unit === undefined) {
    return reject(`work unit "${identity.workUnitId}" does not exist in graph revision ${graph.revision}`);
  }
  if (unit.status === 'SUPERSEDED') {
    return reject(`work unit ${identity.workUnitId} was superseded; results for it are refused`);
  }
  const record = readWorkerRecord(
    workspace,
    jobId,
    objectiveNodeId,
    identity.workUnitId,
    identity.attempt,
    identity.agentRole,
  );
  if (record === undefined) {
    return reject(
      `no ${identity.agentRole} worker record exists for ${identity.workUnitId} attempt ${identity.attempt}`,
    );
  }
  if (record.status === 'FINISHED') {
    return reject(`attempt ${identity.attempt} of ${identity.workUnitId} already delivered a result (duplicate)`);
  }
  if (record.status === 'SUPERSEDED') {
    return reject(`attempt ${identity.attempt} of ${identity.workUnitId} was superseded (late result)`);
  }
  if (record.workerId !== identity.workerId) {
    return reject(
      `the result presents worker "${identity.workerId}" but attempt ${identity.attempt} belongs to "${record.workerId}"`,
    );
  }
  if (record.contextProjectionHash !== identity.contextProjectionHash) {
    return reject('the result presents a different context projection than the one this attempt was given');
  }
  if (record.contractSnapshotHash !== identity.contractSnapshotHash) {
    return reject('the result presents a different contract snapshot than the one this attempt was given');
  }
  return { ok: true, record };
}

/** Mark a RUNNING worker record finished (or failed). */
export function finishWorker(
  workspace: WorkspaceInfo,
  record: ObjectiveWorkerRecord,
  outcome: 'FINISHED' | 'FAILED',
  finishedAt: string,
): ObjectiveWorkerRecord {
  return storeWorkerRecord(workspace, record.jobId, record.objectiveNodeId, {
    ...record,
    status: outcome,
    finishedAt,
  });
}

/**
 * Supersede every RUNNING record for a work unit (graph revision replaced
 * it, or resume found an interrupted attempt). Late results from these
 * identities are rejected from now on.
 */
export function supersedeWorkers(
  workspace: WorkspaceInfo,
  jobId: string,
  objectiveNodeId: string,
  records: readonly ObjectiveWorkerRecord[],
  workUnitId: string,
  finishedAt: string,
): void {
  for (const record of records) {
    if (record.workUnitId !== workUnitId || record.status !== 'RUNNING') continue;
    storeWorkerRecord(workspace, jobId, objectiveNodeId, {
      ...record,
      status: 'SUPERSEDED',
      finishedAt,
    });
  }
}
