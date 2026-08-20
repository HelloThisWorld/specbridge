import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@specbridge/core';
import type { WorkGraph } from '@specbridge/orchestration';
import {
  acceptWorkerResult,
  beginWorker,
  finishWorker,
  readWorkerRecord,
  readWorkerRecords,
  singleUnitGraph,
  storeWorkGraph,
  supersedeWorkers,
  transitionUnit,
  reviseWorkGraphSuperseding,
} from '@specbridge/orchestration';
import { emptyTempDir } from '../helpers.js';

/**
 * The §security battery for worker identity: a result delivered to the
 * wrong identity is rejected even when its content looks valid. Every
 * scenario here is a direct exercise of the fail-closed acceptance guard.
 */

function fixture() {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro', 'specs'), { recursive: true });
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('no workspace');
  const graph: WorkGraph = storeWorkGraph(
    workspace,
    'job-1',
    singleUnitGraph({
      jobId: 'job-1',
      node: { nodeId: 'n-1', parentTaskId: '1', taskFingerprint: 'fp', title: 'Objective' },
      relevantContractIds: ['CTR-001'],
      createdAt: '2026-08-10T10:00:00.000Z',
      reason: 'test',
    }),
  );
  return { workspace, graph };
}

const IDENTITY = {
  workerId: 'builder-wu-1-a1',
  agentRole: 'BUILDER' as const,
  workUnitId: 'wu-1',
  attempt: 1,
  contextProjectionHash: 'hash-projection',
  contractSnapshotHash: 'hash-contracts',
};

function begin(workspace: ReturnType<typeof resolveWorkspace> & object) {
  return beginWorker({
    workspace,
    jobId: 'job-1',
    objectiveNodeId: 'n-1',
    workUnitId: 'wu-1',
    attempt: 1,
    agentRole: 'BUILDER',
    workerId: IDENTITY.workerId,
    contextProjectionHash: IDENTITY.contextProjectionHash,
    contractSnapshotHash: IDENTITY.contractSnapshotHash,
    workspaceIdentity: 'worktree:wu-1-a01',
    timeoutMs: 60_000,
    startedAt: '2026-08-10T10:00:00.000Z',
  });
}

describe('worker identity — fail closed', () => {
  it('accepts exactly the RUNNING record’s own identity', () => {
    const { workspace, graph } = fixture();
    begin(workspace);
    const accepted = acceptWorkerResult(workspace, 'job-1', 'n-1', graph, IDENTITY);
    expect(accepted.ok).toBe(true);
  });

  it('rejects a result for a work unit that does not exist', () => {
    const { workspace, graph } = fixture();
    begin(workspace);
    const rejected = acceptWorkerResult(workspace, 'job-1', 'n-1', graph, {
      ...IDENTITY,
      workUnitId: 'wu-999',
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problem).toMatch(/does not exist/);
  });

  it('rejects a result with no worker record (never dispatched)', () => {
    const { workspace, graph } = fixture();
    const rejected = acceptWorkerResult(workspace, 'job-1', 'n-1', graph, IDENTITY);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problem).toMatch(/no BUILDER worker record/);
  });

  it('rejects a result presenting the wrong worker id, even with valid content', () => {
    const { workspace, graph } = fixture();
    begin(workspace);
    const rejected = acceptWorkerResult(workspace, 'job-1', 'n-1', graph, {
      ...IDENTITY,
      workerId: 'builder-impostor',
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problem).toMatch(/belongs to/);
  });

  it('rejects a duplicate result after the attempt finished', () => {
    const { workspace, graph } = fixture();
    const record = begin(workspace);
    finishWorker(workspace, record, 'FINISHED', '2026-08-10T10:05:00.000Z');
    const rejected = acceptWorkerResult(workspace, 'job-1', 'n-1', graph, IDENTITY);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problem).toMatch(/duplicate/);
  });

  it('rejects a late result from a superseded attempt', () => {
    const { workspace, graph } = fixture();
    begin(workspace);
    supersedeWorkers(
      workspace,
      'job-1',
      'n-1',
      readWorkerRecords(workspace, 'job-1', 'n-1'),
      'wu-1',
      '2026-08-10T10:06:00.000Z',
    );
    const rejected = acceptWorkerResult(workspace, 'job-1', 'n-1', graph, IDENTITY);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problem).toMatch(/late result/);
  });

  it('rejects a result whose projection or contract snapshot hash differs', () => {
    const { workspace, graph } = fixture();
    begin(workspace);
    const staleProjection = acceptWorkerResult(workspace, 'job-1', 'n-1', graph, {
      ...IDENTITY,
      contextProjectionHash: 'hash-other',
    });
    expect(staleProjection.ok).toBe(false);
    if (!staleProjection.ok) expect(staleProjection.problem).toMatch(/different context projection/);

    const staleContracts = acceptWorkerResult(workspace, 'job-1', 'n-1', graph, {
      ...IDENTITY,
      contractSnapshotHash: 'hash-other',
    });
    expect(staleContracts.ok).toBe(false);
    if (!staleContracts.ok) expect(staleContracts.problem).toMatch(/different contract snapshot/);
  });

  it('rejects a result for a work unit superseded in the current graph', () => {
    const { workspace, graph } = fixture();
    begin(workspace);
    let revised = transitionUnit(graph, 'wu-1', 'BUILDING');
    revised = transitionUnit(revised, 'wu-1', 'READY');
    revised = reviseWorkGraphSuperseding(revised, {
      supersedeWorkUnitId: 'wu-1',
      reason: 'replaced',
      createdAt: '2026-08-10T10:07:00.000Z',
    });
    const rejected = acceptWorkerResult(workspace, 'job-1', 'n-1', revised, IDENTITY);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problem).toMatch(/superseded/);
  });

  it('two workers can never own one work-unit attempt', () => {
    const { workspace } = fixture();
    begin(workspace);
    expect(() => begin(workspace)).toThrow(/already RUNNING/);
    // And a FINISHED attempt cannot be re-begun either.
    const record = readWorkerRecord(workspace, 'job-1', 'n-1', 'wu-1', 1, 'BUILDER');
    finishWorker(workspace, record!, 'FINISHED', '2026-08-10T10:08:00.000Z');
    expect(() => begin(workspace)).toThrow(/already finished/);
  });
});
