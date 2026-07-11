import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConcreteWorkflowMode, StageName, WorkspaceInfo } from '@specbridge/core';
import { readSpecState, resolveWorkspace, sha256File } from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { ApprovalResult } from '@specbridge/workflow';
import { approveStage, createSpec } from '@specbridge/workflow';
import { emptyTempDir, fixedClock } from '../helpers.js';

/**
 * Approval-workflow tests run against real workspaces created by `spec new`
 * whose first-stage documents are then replaced with valid content, exactly
 * the way a user would work.
 */

const VALID_REQUIREMENTS = `# Requirements Document

## Introduction

Real content for approval tests.

## Requirements

### Requirement 1: Behavior

**User Story:** As a user, I want the feature to act predictably, so that I can rely on it.

#### Acceptance Criteria

1. WHEN the primary action runs, THE SYSTEM SHALL produce the documented result.
2. IF the backend is unavailable, THEN THE SYSTEM SHALL fail with an actionable error.

## Out of Scope

- Everything else.

## Non-Functional Requirements

- Security: only authenticated users can trigger the action.
`;

const VALID_DESIGN = `# Design Document

## Overview

A small design with every commonly expected section.

## Architecture

One module owns the behavior.

## Components and Interfaces

- Component: BehaviorService (interface: run()).

## Failure Handling

- Backend unavailable: return an actionable error.

## Security Considerations

- Authentication required.

## Testing Strategy

- Unit tests plus one integration test.

## Risks and Trade-offs

- None worth noting.
`;

const VALID_TASKS = `# Implementation Plan

- [ ] 1. Implement the behavior service
  - _Requirements: 1.1_
- [ ] 2. Add automated tests for the acceptance criteria
  - _Requirements: 1.1, 1.2_
- [ ] 3. Verify error handling
  - _Requirements: 1.2_
`;

const VALID_BUGFIX = `# Bugfix Document

## Summary

Sessions expire too early.

## Current Behavior

Sessions expire after 5 minutes.

## Expected Behavior

Sessions expire after 30 minutes.

## Unchanged Behavior

- Explicit logout still works immediately.

## Reproduction

1. Log in and wait 6 minutes.

## Evidence

- Failing tests: SessionServiceTest.testTimeout.

## Regression Risks

- Token refresh must not extend beyond the absolute cap.
`;

interface Fixture {
  workspace: WorkspaceInfo;
  approve: (stage: StageName, revoke?: boolean) => ApprovalResult;
  writeStage: (stage: StageName, content: string) => void;
  specName: string;
}

function makeSpec(options: {
  mode?: ConcreteWorkflowMode;
  bugfix?: boolean;
}): Fixture {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro'));
  const initial = resolveWorkspace(root);
  if (initial === undefined) throw new Error('workspace setup failed');
  const specName = 'test-spec';
  createSpec(
    initial,
    {
      name: specName,
      ...(options.bugfix === true ? { specType: 'bugfix' as const } : {}),
      mode: options.mode ?? 'requirements-first',
    },
    fixedClock,
  );
  // Re-resolve so the WorkspaceInfo sees the specs dir the creation added.
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('workspace setup failed');
  const dir = path.join(root, '.kiro', 'specs', specName);
  const writeStage = (stage: StageName, content: string): void => {
    writeFileSync(path.join(dir, `${stage}.md`), content);
  };
  const approve = (stage: StageName, revoke?: boolean): ApprovalResult => {
    const spec = analyzeSpec(workspace, requireSpec(workspace, specName));
    return approveStage(
      workspace,
      spec,
      { stage, ...(revoke === true ? { revoke: true } : {}) },
      { clock: fixedClock },
    );
  };
  return { workspace, approve, writeStage, specName };
}

function expectApproved(result: ApprovalResult): asserts result is ApprovalResult & { ok: true; action: 'approved' } {
  if (!result.ok) throw new Error(`expected approval, got: ${result.message}`);
  if (result.action !== 'approved') throw new Error(`expected approved, got ${result.action}`);
}

describe('stage approval', () => {
  it('approves valid requirements and records hash + timestamp (tests 21, 27)', () => {
    const fixture = makeSpec({});
    fixture.writeStage('requirements', VALID_REQUIREMENTS);
    const result = fixture.approve('requirements');
    expectApproved(result);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);

    const state = readSpecState(fixture.workspace, fixture.specName).state;
    expect(state?.stages.requirements?.status).toBe('approved');
    expect(state?.stages.requirements?.approvedHash).toBe(result.hash);
    expect(state?.stages.requirements?.approvedAt).toBe('2026-07-12T10:00:00.000Z');
    expect(state?.status).toBe('DESIGN_DRAFT');
    // The hash is of the exact bytes on disk.
    const filePath = path.join(fixture.workspace.rootDir, '.kiro', 'specs', fixture.specName, 'requirements.md');
    expect(sha256File(filePath)).toBe(result.hash);
  });

  it('blocks design approval while requirements are unapproved (test 22)', () => {
    const fixture = makeSpec({});
    fixture.writeStage('design', VALID_DESIGN);
    const result = fixture.approve('design');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('prerequisites-unmet');
      expect(result.failure).toBe('gate');
      expect(result.missingPrerequisites).toEqual(['requirements']);
      expect(result.message).toContain('not approved yet');
    }
  });

  it('design-first workflows approve design before requirements (test 23)', () => {
    const fixture = makeSpec({ mode: 'design-first' });
    // Requirements first must be blocked in a design-first workflow.
    fixture.writeStage('requirements', VALID_REQUIREMENTS);
    const early = fixture.approve('requirements');
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.missingPrerequisites).toEqual(['design']);

    fixture.writeStage('design', VALID_DESIGN);
    expectApproved(fixture.approve('design'));
    expectApproved(fixture.approve('requirements'));
    const state = readSpecState(fixture.workspace, fixture.specName).state;
    expect(state?.status).toBe('TASKS_DRAFT');
  });

  it('quick mode approves the two documents in either order (test 24)', () => {
    const fixture = makeSpec({ mode: 'quick' });
    fixture.writeStage('design', VALID_DESIGN);
    fixture.writeStage('requirements', VALID_REQUIREMENTS);
    expectApproved(fixture.approve('design'));
    expectApproved(fixture.approve('requirements'));
    const state = readSpecState(fixture.workspace, fixture.specName).state;
    expect(state?.status).toBe('READY_FOR_REVIEW');

    expectApproved(fixture.approve('tasks'));
    expect(readSpecState(fixture.workspace, fixture.specName).state?.status).toBe(
      'READY_FOR_IMPLEMENTATION',
    );
  });

  it('bugfix workflows approve bugfix, then design, then tasks (test 25)', () => {
    const fixture = makeSpec({ bugfix: true });
    fixture.writeStage('bugfix', VALID_BUGFIX);

    const designTooEarly = fixture.approve('design');
    expect(designTooEarly.ok).toBe(false);

    expectApproved(fixture.approve('bugfix'));
    fixture.writeStage('design', VALID_DESIGN);
    expectApproved(fixture.approve('design'));
    fixture.writeStage('tasks', VALID_TASKS);
    expectApproved(fixture.approve('tasks'));
    expect(readSpecState(fixture.workspace, fixture.specName).state?.status).toBe(
      'READY_FOR_IMPLEMENTATION',
    );
  });

  it('rejects the requirements stage on a bugfix spec (stage applicability)', () => {
    const fixture = makeSpec({ bugfix: true });
    const result = fixture.approve('requirements');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('stage-not-applicable');
      expect(result.failure).toBe('usage');
      expect(result.message).toContain('bugfix, design, tasks');
    }
  });

  it('tasks approval requires every prerequisite approval (test 26)', () => {
    const fixture = makeSpec({});
    fixture.writeStage('requirements', VALID_REQUIREMENTS);
    fixture.writeStage('tasks', VALID_TASKS);
    expectApproved(fixture.approve('requirements'));
    const result = fixture.approve('tasks');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingPrerequisites).toEqual(['design']);
  });

  it('reapproval updates hash and timestamp (test 28)', () => {
    const fixture = makeSpec({});
    fixture.writeStage('requirements', VALID_REQUIREMENTS);
    const first = fixture.approve('requirements');
    expectApproved(first);

    fixture.writeStage('requirements', `${VALID_REQUIREMENTS}\nExtra line.\n`);
    const laterClock = (): Date => new Date('2026-07-12T11:00:00.000Z');
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, fixture.specName));
    const second = approveStage(fixture.workspace, spec, { stage: 'requirements' }, { clock: laterClock });
    expectApproved(second);
    expect(second.reapproved).toBe(true);
    expect(second.hash).not.toBe(first.hash);
    const state = readSpecState(fixture.workspace, fixture.specName).state;
    expect(state?.stages.requirements?.approvedAt).toBe('2026-07-12T11:00:00.000Z');
    expect(state?.stages.requirements?.approvedHash).toBe(second.hash);
  });

  it('revoking an earlier stage invalidates dependent approvals but keeps files (test 29)', () => {
    const fixture = makeSpec({});
    fixture.writeStage('requirements', VALID_REQUIREMENTS);
    fixture.writeStage('design', VALID_DESIGN);
    fixture.writeStage('tasks', VALID_TASKS);
    expectApproved(fixture.approve('requirements'));
    expectApproved(fixture.approve('design'));
    expectApproved(fixture.approve('tasks'));

    const revoked = fixture.approve('requirements', true);
    expect(revoked.ok).toBe(true);
    if (revoked.ok && revoked.action === 'revoked') {
      expect(revoked.invalidated.sort()).toEqual(['design', 'tasks']);
    }
    const state = readSpecState(fixture.workspace, fixture.specName).state;
    expect(state?.stages.requirements?.status).toBe('draft');
    expect(state?.stages.design?.status).toBe('blocked');
    expect(state?.stages.design?.approvedHash).toBeNull();
    expect(state?.stages.tasks?.status).toBe('blocked');
    expect(state?.status).toBe('REQUIREMENTS_DRAFT');
    // Files still exist untouched.
    const dir = path.join(fixture.workspace.rootDir, '.kiro', 'specs', fixture.specName);
    expect(readFileSync(path.join(dir, 'design.md'), 'utf8')).toBe(VALID_DESIGN);
    expect(readFileSync(path.join(dir, 'tasks.md'), 'utf8')).toBe(VALID_TASKS);
  });

  it('revoking an unapproved stage is a usage error', () => {
    const fixture = makeSpec({});
    const result = fixture.approve('design', true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('nothing-to-revoke');
      expect(result.failure).toBe('usage');
    }
  });

  it('approval never modifies the Markdown files (test 30)', () => {
    const fixture = makeSpec({});
    fixture.writeStage('requirements', VALID_REQUIREMENTS);
    const dir = path.join(fixture.workspace.rootDir, '.kiro', 'specs', fixture.specName);
    const before = ['requirements.md', 'design.md', 'tasks.md'].map((f) =>
      readFileSync(path.join(dir, f)),
    );
    expectApproved(fixture.approve('requirements'));
    const after = ['requirements.md', 'design.md', 'tasks.md'].map((f) =>
      readFileSync(path.join(dir, f)),
    );
    before.forEach((buffer, i) => expect(buffer.equals(after[i] as Buffer)).toBe(true));
  });

  it('a placeholder-heavy stage cannot be approved (test 31)', () => {
    const fixture = makeSpec({});
    // The generated template with its placeholders is left untouched.
    const result = fixture.approve('requirements');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('analysis-errors');
      expect(result.failure).toBe('gate');
      expect(
        result.analysis?.diagnostics.some((d) => d.code === 'REQUIREMENTS_PLACEHOLDER'),
      ).toBe(true);
    }
  });

  it('warnings do not block approval (test 32)', () => {
    const fixture = makeSpec({});
    // Valid but warning-prone: no out-of-scope, no NFR, vague wording.
    fixture.writeStage(
      'requirements',
      `# Requirements Document

## Introduction

Minimal but real.

## Requirements

### Requirement 1: Something

**User Story:** As a user, I want results, so that I benefit.

#### Acceptance Criteria

1. WHEN the action runs, THE SYSTEM SHALL handle the request and record the outcome.
2. IF the backend fails, THEN THE SYSTEM SHALL report an error.
`,
    );
    const result = fixture.approve('requirements');
    expectApproved(result);
    expect(result.analysis.warningCount).toBeGreaterThan(0);
  });

  it('analysis errors block approval (test 33)', () => {
    const fixture = makeSpec({});
    fixture.writeStage(
      'requirements',
      `# Requirements Document

## Introduction

Real intro.

## Requirements

### Requirement 1: No criteria at all
`,
    );
    const result = fixture.approve('requirements');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('analysis-errors');
      expect(result.analysis?.diagnostics.some((d) => d.code === 'REQUIREMENTS_NO_CRITERIA')).toBe(
        true,
      );
    }
  });
});
