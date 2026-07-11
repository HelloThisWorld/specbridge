import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@specbridge/core';
import { readSpecState, resolveWorkspace } from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { approveStage, createSpec, evaluateWorkflow } from '@specbridge/workflow';
import { copyFixtureToTemp, emptyTempDir, fixedClock } from '../helpers.js';

function workspaceOf(root: string): WorkspaceInfo {
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error(`no workspace at ${root}`);
  return workspace;
}

const VALID_REQUIREMENTS = `# Requirements Document

## Introduction

Stale-approval test content.

## Requirements

### Requirement 1: Behavior

**User Story:** As a user, I want stable behavior, so that approvals mean something.

#### Acceptance Criteria

1. WHEN the action runs, THE SYSTEM SHALL produce the documented result.
2. IF the backend fails, THEN THE SYSTEM SHALL return an actionable error.

## Out of Scope

- Everything else.

## Non-Functional Requirements

- Security: authenticated users only.
`;

describe('approval hash invalidation', () => {
  it('detects a one-byte modification of an approved file (test 34)', () => {
    const root = emptyTempDir();
    mkdirSync(path.join(root, '.kiro'));
    const setup = workspaceOf(root);
    createSpec(setup, { name: 'stale-spec' }, fixedClock);
    const workspace = workspaceOf(root);
    const file = path.join(root, '.kiro', 'specs', 'stale-spec', 'requirements.md');
    writeFileSync(file, VALID_REQUIREMENTS);
    const spec = analyzeSpec(workspace, requireSpec(workspace, 'stale-spec'));
    const approved = approveStage(workspace, spec, { stage: 'requirements' }, { clock: fixedClock });
    expect(approved.ok).toBe(true);

    let state = readSpecState(workspace, 'stale-spec').state;
    if (state === undefined) throw new Error('state missing');
    expect(evaluateWorkflow(workspace, state).health).toBe('ok');

    appendFileSync(file, 'x');
    state = readSpecState(workspace, 'stale-spec').state;
    if (state === undefined) throw new Error('state missing');
    const evaluation = evaluateWorkflow(workspace, state);
    expect(evaluation.health).toBe('stale');
    expect(evaluation.effectiveStatus).toBe('STALE_APPROVAL');
    expect(evaluation.staleStages).toEqual(['requirements']);
    expect(
      evaluation.stages.find((s) => s.stage === 'requirements')?.effective,
    ).toBe('modified-after-approval');
    expect(evaluation.diagnostics.some((d) => d.code === 'APPROVAL_STALE')).toBe(true);
  });

  it('downstream approvals become effectively stale (test 35)', () => {
    const root = copyFixtureToTemp('v02-stale-requirements-approval');
    const workspace = workspaceOf(root);
    const state = readSpecState(workspace, 'payment-retry').state;
    if (state === undefined) throw new Error('fixture state invalid');
    const evaluation = evaluateWorkflow(workspace, state);

    expect(evaluation.health).toBe('stale');
    expect(evaluation.staleStages).toEqual(['requirements']);
    expect(evaluation.invalidatedStages).toEqual(['design']);
    expect(evaluation.stages.find((s) => s.stage === 'design')?.effective).toBe('stale-prerequisite');
    // The draft tasks stage is effectively blocked behind the stale chain.
    expect(evaluation.stages.find((s) => s.stage === 'tasks')?.effective).toBe('blocked');
    expect(evaluation.diagnostics.some((d) => d.code === 'APPROVAL_DEPENDENT_STALE')).toBe(true);
  });

  it('approving on top of a stale prerequisite is blocked', () => {
    const root = copyFixtureToTemp('v02-stale-requirements-approval');
    const workspace = workspaceOf(root);
    const spec = analyzeSpec(workspace, requireSpec(workspace, 'payment-retry'));
    const result = approveStage(workspace, spec, { stage: 'tasks' }, { clock: fixedClock });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('prerequisites-unmet');
      expect(result.stalePrerequisites).toContain('requirements');
      expect(result.message).toContain('changed after approval');
    }
  });

  it('read-only evaluation does not mutate the state file (test 36)', () => {
    const root = copyFixtureToTemp('v02-stale-requirements-approval');
    const workspace = workspaceOf(root);
    const statePath = path.join(root, '.specbridge', 'state', 'specs', 'payment-retry.json');
    const before = readFileSync(statePath);

    const state = readSpecState(workspace, 'payment-retry').state;
    if (state === undefined) throw new Error('fixture state invalid');
    evaluateWorkflow(workspace, state);
    evaluateWorkflow(workspace, state);

    expect(readFileSync(statePath).equals(before)).toBe(true);
  });

  it('reapproval clears the stale status and invalidates dependents persistently (test 37)', () => {
    const root = copyFixtureToTemp('v02-stale-requirements-approval');
    const workspace = workspaceOf(root);
    const spec = analyzeSpec(workspace, requireSpec(workspace, 'payment-retry'));
    const result = approveStage(workspace, spec, { stage: 'requirements' }, { clock: fixedClock });
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'approved') {
      expect(result.reapproved).toBe(true);
      // Design was approved against the old requirements — no longer valid.
      expect(result.invalidated).toEqual(['design']);
    }
    const state = readSpecState(workspace, 'payment-retry').state;
    if (state === undefined) throw new Error('state missing');
    const evaluation = evaluateWorkflow(workspace, state);
    expect(evaluation.health).toBe('ok');
    expect(evaluation.stages.find((s) => s.stage === 'requirements')?.effective).toBe('approved');
    expect(state.stages.design?.status).toBe('draft');
    expect(state.stages.design?.approvedHash).toBeNull();
  });

  it('CRLF file hashes are stable across repeated evaluation (test 38)', () => {
    const root = emptyTempDir();
    mkdirSync(path.join(root, '.kiro'));
    const setup = workspaceOf(root);
    createSpec(setup, { name: 'crlf-spec' }, fixedClock);
    const workspace = workspaceOf(root);
    const file = path.join(root, '.kiro', 'specs', 'crlf-spec', 'requirements.md');
    writeFileSync(file, VALID_REQUIREMENTS.replace(/\n/g, '\r\n'));

    const spec = analyzeSpec(workspace, requireSpec(workspace, 'crlf-spec'));
    const approved = approveStage(workspace, spec, { stage: 'requirements' }, { clock: fixedClock });
    expect(approved.ok).toBe(true);

    const state = readSpecState(workspace, 'crlf-spec').state;
    if (state === undefined) throw new Error('state missing');
    for (let i = 0; i < 3; i += 1) {
      const evaluation = evaluateWorkflow(workspace, state);
      expect(evaluation.health).toBe('ok');
    }
    // The file still has its CRLF endings — approval reads, never rewrites.
    expect(readFileSync(file, 'utf8')).toContain('\r\n');
  });

  it('UTF-8 multibyte content hashes are stable (test 39)', () => {
    const root = emptyTempDir();
    mkdirSync(path.join(root, '.kiro'));
    const setup = workspaceOf(root);
    createSpec(setup, { name: 'utf8-spec' }, fixedClock);
    const workspace = workspaceOf(root);
    const file = path.join(root, '.kiro', 'specs', 'utf8-spec', 'requirements.md');
    writeFileSync(
      file,
      VALID_REQUIREMENTS.replace(
        'Stale-approval test content.',
        'Préférences de notification — уведомления (δοκιμή).',
      ),
    );

    const spec = analyzeSpec(workspace, requireSpec(workspace, 'utf8-spec'));
    const approved = approveStage(workspace, spec, { stage: 'requirements' }, { clock: fixedClock });
    expect(approved.ok).toBe(true);
    const state = readSpecState(workspace, 'utf8-spec').state;
    if (state === undefined) throw new Error('state missing');
    expect(evaluateWorkflow(workspace, state).health).toBe('ok');
  });
});
