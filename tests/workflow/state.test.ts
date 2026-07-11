import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@specbridge/core';
import {
  readSpecState,
  resolveWorkspace,
  specWorkflowStateSchema,
} from '@specbridge/core';
import { analyzeSpec, discoverSpecs, requireSpec } from '@specbridge/compat-kiro';
import { approveStage, auditSidecarState, createSpec } from '@specbridge/workflow';
import { copyFixtureToTemp, emptyTempDir, fixedClock } from '../helpers.js';

function workspaceOf(root: string): WorkspaceInfo {
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error(`no workspace at ${root}`);
  return workspace;
}

describe('sidecar state lifecycle', () => {
  it('spec new creates a state file that validates against the schema (tests 14, 15)', () => {
    const root = emptyTempDir();
    mkdirSync(path.join(root, '.kiro'));
    const workspace = workspaceOf(root);
    const result = createSpec(workspace, { name: 'fresh-spec' }, fixedClock);

    const raw = JSON.parse(readFileSync(result.statePath, 'utf8')) as unknown;
    const parsed = specWorkflowStateSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schemaVersion).toBe('1.0.0');
      expect(parsed.data.origin).toBe('created-by-specbridge');
      expect(parsed.data.createdAt).toBe('2026-07-12T10:00:00.000Z');
    }
  });

  it('initial states are correct for every mode (test 16)', () => {
    const root = emptyTempDir();
    mkdirSync(path.join(root, '.kiro'));
    const workspace = workspaceOf(root);

    const requirementsFirst = createSpec(workspace, { name: 'a-req', mode: 'requirements-first' }, fixedClock);
    expect(requirementsFirst.plan.state.status).toBe('REQUIREMENTS_DRAFT');
    expect(requirementsFirst.plan.state.stages.requirements?.status).toBe('draft');
    expect(requirementsFirst.plan.state.stages.design?.status).toBe('blocked');
    expect(requirementsFirst.plan.state.stages.tasks?.status).toBe('blocked');

    const designFirst = createSpec(workspace, { name: 'a-design', mode: 'design-first' }, fixedClock);
    expect(designFirst.plan.state.status).toBe('DESIGN_DRAFT');
    expect(designFirst.plan.state.stages.design?.status).toBe('draft');
    expect(designFirst.plan.state.stages.requirements?.status).toBe('blocked');

    const quick = createSpec(workspace, { name: 'a-quick', mode: 'quick' }, fixedClock);
    expect(quick.plan.state.status).toBe('READY_FOR_REVIEW');
    expect(quick.plan.state.stages.requirements?.status).toBe('draft');
    expect(quick.plan.state.stages.design?.status).toBe('draft');
    expect(quick.plan.state.stages.tasks?.status).toBe('blocked');

    const bugfix = createSpec(workspace, { name: 'a-bugfix', specType: 'bugfix' }, fixedClock);
    expect(bugfix.plan.state.status).toBe('BUGFIX_DRAFT');
    expect(bugfix.plan.state.stages.bugfix?.status).toBe('draft');
  });

  it('an existing Kiro spec works with no sidecar state at all (test 17)', () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const workspace = workspaceOf(root);
    const spec = analyzeSpec(workspace, requireSpec(workspace, 'user-authentication'));
    expect(spec.classification.type).toBe('feature');
    expect(spec.classification.workflowMode).toBe('unknown');
    expect(spec.state).toBeUndefined();
    const stateRead = readSpecState(workspace, 'user-authentication');
    expect(stateRead.exists).toBe(false);
    expect(stateRead.diagnostics).toEqual([]);
  });

  it('the first approval initializes state for an existing Kiro spec (test 18)', () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const workspace = workspaceOf(root);
    const spec = analyzeSpec(workspace, requireSpec(workspace, 'user-authentication'));

    const result = approveStage(workspace, spec, { stage: 'requirements' }, { clock: fixedClock });
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'approved') {
      expect(result.initialized).toBe(true);
      expect(result.state.origin).toBe('existing-kiro-workspace');
      expect(result.state.workflowMode).toBe('requirements-first');
      expect(result.state.specType).toBe('feature');
    }
    const stateRead = readSpecState(workspace, 'user-authentication');
    expect(stateRead.state?.stages.requirements?.status).toBe('approved');
  });

  it('design-first is inferred when design is approved first on an unmanaged spec', () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const workspace = workspaceOf(root);
    const spec = analyzeSpec(workspace, requireSpec(workspace, 'user-authentication'));
    const result = approveStage(workspace, spec, { stage: 'design' }, { clock: fixedClock });
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'approved') {
      expect(result.state.workflowMode).toBe('design-first');
    }
  });

  it('approving tasks first on an unmanaged spec is refused with guidance', () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const workspace = workspaceOf(root);
    const spec = analyzeSpec(workspace, requireSpec(workspace, 'user-authentication'));
    const result = approveStage(workspace, spec, { stage: 'tasks' }, { clock: fixedClock });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('initialization-unsupported');
      expect(result.message).toContain('Approve "requirements" or "design" first');
    }
    // No state file was created by the refused command.
    expect(readSpecState(workspace, 'user-authentication').exists).toBe(false);
  });

  it('invalid sidecar state degrades to diagnostics, never a crash (test 19)', () => {
    const root = copyFixtureToTemp('v02-invalid-sidecar');
    const workspace = workspaceOf(root);

    const broken = readSpecState(workspace, 'broken-state');
    expect(broken.state).toBeUndefined();
    expect(broken.diagnostics[0]?.code).toBe('SIDECAR_STATE_INVALID_JSON');

    const wrongShape = readSpecState(workspace, 'wrong-shape');
    expect(wrongShape.state).toBeUndefined();
    expect(wrongShape.diagnostics[0]?.code).toBe('SIDECAR_STATE_INVALID_SHAPE');

    const legacy = readSpecState(workspace, 'legacy-shape');
    expect(legacy.state).toBeUndefined();
    expect(legacy.diagnostics[0]?.code).toBe('SIDECAR_STATE_LEGACY');

    // Analysis still works: the spec is treated as unmanaged.
    const spec = analyzeSpec(workspace, requireSpec(workspace, 'broken-state'));
    expect(spec.classification.type).toBe('feature');
  });

  it('orphan sidecar state is detected by the audit (test 20)', () => {
    const root = copyFixtureToTemp('v02-orphan-sidecar');
    const workspace = workspaceOf(root);
    const audit = auditSidecarState(workspace, discoverSpecs(workspace));
    expect(audit.orphanStates).toEqual(['ghost-spec']);
    expect(audit.unmanagedSpecs).toEqual(['real-spec']);
    expect(audit.diagnostics.some((d) => d.code === 'SIDECAR_STATE_ORPHAN')).toBe(true);
  });
});
