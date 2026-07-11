import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@specbridge/core';
import { readSpecState, writeSpecState } from '@specbridge/core';
import { listTaskEvidence, writeTaskEvidence } from '@specbridge/drift';
import { emptyTempDir, testWorkflowState } from '../helpers.js';

function tempWorkspace(): WorkspaceInfo {
  const rootDir = emptyTempDir();
  return {
    rootDir,
    kiroDir: path.join(rootDir, '.kiro'),
    sidecarDir: path.join(rootDir, '.specbridge'),
    sidecarExists: false,
  };
}

describe('sidecar state and evidence storage', () => {
  it('round-trips spec state through .specbridge/state/specs/<name>.json', () => {
    const workspace = tempWorkspace();
    const state = testWorkflowState({
      specName: 'notification-preferences',
      workflowMode: 'requirements-first',
      status: 'DESIGN_DRAFT',
      stages: {
        requirements: {
          status: 'approved',
          approvedAt: '2026-07-01T10:00:00.000Z',
          approvedHash: 'a'.repeat(64),
        },
        design: { status: 'draft' },
      },
    });
    const statePath = writeSpecState(workspace, state);
    expect(statePath).toContain(path.join('.specbridge', 'state', 'specs'));

    const read = readSpecState(workspace, 'notification-preferences');
    expect(read.exists).toBe(true);
    expect(read.diagnostics).toEqual([]);
    expect(read.state).toMatchObject({
      specName: 'notification-preferences',
      workflowMode: 'requirements-first',
      status: 'DESIGN_DRAFT',
      schemaVersion: '1.0.0',
    });
    expect(read.state?.stages.requirements?.approvedHash).toBe('a'.repeat(64));
  });

  it('degrades invalid sidecar state to a diagnostic instead of crashing', () => {
    const workspace = tempWorkspace();
    writeSpecState(workspace, testWorkflowState({ specName: 'broken' }));
    writeFileSync(path.join(workspace.sidecarDir, 'state', 'specs', 'broken.json'), '{not json');
    const read = readSpecState(workspace, 'broken');
    expect(read.state).toBeUndefined();
    expect(read.diagnostics[0]?.code).toBe('SIDECAR_STATE_INVALID_JSON');
  });

  it('missing state is not an error', () => {
    const read = readSpecState(tempWorkspace(), 'never-written');
    expect(read.exists).toBe(false);
    expect(read.state).toBeUndefined();
    expect(read.diagnostics).toEqual([]);
  });

  it('round-trips task evidence and sanitizes file names', () => {
    const workspace = tempWorkspace();
    const file = writeTaskEvidence(workspace, 'my-spec', {
      taskId: '2.3',
      status: 'verified',
      changedFiles: ['src/notifications/service.ts'],
      commands: [{ command: 'npm test', exitCode: 0 }],
      verifiedAt: '2026-07-03T12:00:00Z',
    });
    expect(path.basename(file)).toBe('2.3.json');

    writeTaskEvidence(workspace, 'my-spec', { taskId: 'weird/id: with spaces', status: 'recorded' });

    const { evidence, diagnostics } = listTaskEvidence(workspace, 'my-spec');
    expect(diagnostics).toEqual([]);
    expect(evidence.map((e) => e.taskId).sort()).toEqual(['2.3', 'weird/id: with spaces']);
  });

  it('returns empty evidence for specs with no evidence directory', () => {
    const { evidence, diagnostics } = listTaskEvidence(tempWorkspace(), 'nothing');
    expect(evidence).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});
