import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { TASK_PLAN_HASH_SEMANTICS_VERSION, readSpecState, resolveWorkspace, stateStage, writeSpecState } from '@specbridge/core';
import { approveStage, evaluateWorkflow } from '@specbridge/workflow';
import { copyFixtureToTemp } from '../helpers.js';
import { approveAllStages, tickingClock } from '../helpers-execution.js';

/**
 * Approval semantics with the v0.4 normalized task-plan hash:
 *
 *   - requirements/design approvals stay exact-byte (any change is stale)
 *   - checkbox-only tasks.md progress keeps the approval effective
 *   - any other tasks.md change (text, ids, hierarchy, refs) is stale
 *   - pre-v0.4 sidecar state (no approvedPlanHash) still validates and
 *     falls back to exact-byte semantics until the next sanctioned write
 */

const SPEC = 'settings-persistence';

function setup(): { root: string; workspace: NonNullable<ReturnType<typeof resolveWorkspace>> } {
  const root = copyFixtureToTemp('v03-ready-feature');
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('fixture has no workspace');
  approveAllStages(workspace, SPEC, tickingClock());
  return { root, workspace };
}

function editFile(root: string, relative: string, edit: (content: string) => string): void {
  const filePath = path.join(root, relative.split('/').join(path.sep));
  writeFileSync(filePath, edit(readFileSync(filePath, 'utf8')), 'utf8');
}

describe('task-plan approval hash semantics', () => {
  it('approving tasks records the exact hash, the plan hash, and the semantics version', () => {
    const { workspace } = setup();
    const state = readSpecState(workspace, SPEC).state;
    expect(state).toBeDefined();
    const tasks = stateStage(state!, 'tasks');
    expect(tasks?.status).toBe('approved');
    expect(tasks?.approvedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tasks?.approvedPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tasks?.hashSemanticsVersion).toBe(TASK_PLAN_HASH_SEMANTICS_VERSION);
    expect(tasks?.hashAlgorithm).toBe('sha256');
    // Other stages stay exact-only.
    expect(stateStage(state!, 'requirements')?.approvedPlanHash).toBeUndefined();
    expect(stateStage(state!, 'design')?.approvedPlanHash).toBeUndefined();
  });

  it('checkbox-only progress keeps the tasks approval effective (with an info diagnostic)', () => {
    const { root, workspace } = setup();
    editFile(root, `.kiro/specs/${SPEC}/tasks.md`, (content) =>
      content.replace('- [ ] 1. Implement the settings store', '- [x] 1. Implement the settings store'),
    );
    const state = readSpecState(workspace, SPEC).state!;
    const evaluation = evaluateWorkflow(workspace, state);
    const tasks = evaluation.stages.find((stage) => stage.stage === 'tasks');
    expect(tasks?.effective).toBe('approved');
    expect(tasks?.checkboxProgressOnly).toBe(true);
    expect(evaluation.health).toBe('ok');
    expect(evaluation.diagnostics.some((d) => d.code === 'APPROVAL_CHECKBOX_PROGRESS')).toBe(true);
  });

  it('task text changes invalidate the plan approval', () => {
    const { root, workspace } = setup();
    editFile(root, `.kiro/specs/${SPEC}/tasks.md`, (content) =>
      content.replace('Implement the settings store', 'Implement the RENAMED store'),
    );
    const evaluation = evaluateWorkflow(workspace, readSpecState(workspace, SPEC).state!);
    expect(evaluation.stages.find((stage) => stage.stage === 'tasks')?.effective).toBe(
      'modified-after-approval',
    );
    expect(evaluation.health).toBe('stale');
  });

  it('task ID changes invalidate the plan approval', () => {
    const { root, workspace } = setup();
    editFile(root, `.kiro/specs/${SPEC}/tasks.md`, (content) =>
      content.replace('- [ ] 2.1 Test the successful save path', '- [ ] 2.9 Test the successful save path'),
    );
    const evaluation = evaluateWorkflow(workspace, readSpecState(workspace, SPEC).state!);
    expect(evaluation.stages.find((stage) => stage.stage === 'tasks')?.effective).toBe(
      'modified-after-approval',
    );
  });

  it('task hierarchy changes invalidate the plan approval', () => {
    const { root, workspace } = setup();
    editFile(root, `.kiro/specs/${SPEC}/tasks.md`, (content) =>
      content.replace('  - [ ] 2.1 Test the successful save path', '- [ ] 2.1 Test the successful save path'),
    );
    const evaluation = evaluateWorkflow(workspace, readSpecState(workspace, SPEC).state!);
    expect(evaluation.stages.find((stage) => stage.stage === 'tasks')?.effective).toBe(
      'modified-after-approval',
    );
  });

  it('requirements and design approvals remain exact-byte (checkbox-like edits are still stale)', () => {
    const { root, workspace } = setup();
    editFile(root, `.kiro/specs/${SPEC}/requirements.md`, (content) => `${content}\nExtra line.\n`);
    editFile(root, `.kiro/specs/${SPEC}/design.md`, (content) => content.replace('Overview', 'OVERVIEW'));
    const evaluation = evaluateWorkflow(workspace, readSpecState(workspace, SPEC).state!);
    expect(evaluation.stages.find((stage) => stage.stage === 'requirements')?.effective).toBe(
      'modified-after-approval',
    );
    expect(evaluation.stages.find((stage) => stage.stage === 'design')?.effective).toBe(
      'modified-after-approval',
    );
  });

  it('revoking the tasks approval clears the plan-hash fields', () => {
    const { workspace } = setup();
    const spec = analyzeSpec(workspace, requireSpec(workspace, SPEC));
    const result = approveStage(workspace, spec, { stage: 'tasks', revoke: true });
    expect(result.ok).toBe(true);
    const tasks = stateStage(readSpecState(workspace, SPEC).state!, 'tasks');
    expect(tasks?.status).toBe('draft');
    expect(tasks?.approvedPlanHash).toBeUndefined();
    expect(tasks?.hashSemanticsVersion).toBeUndefined();
  });

  it('pre-v0.4 sidecar state without a plan hash still validates and stays exact-byte', () => {
    const { root, workspace } = setup();
    // Strip the v0.4 fields, simulating state written by v0.2/v0.3.
    const state = readSpecState(workspace, SPEC).state!;
    const legacyStages = Object.fromEntries(
      Object.entries(state.stages).map(([name, stage]) => {
        const clone = { ...(stage as Record<string, unknown>) };
        delete clone['approvedPlanHash'];
        delete clone['hashAlgorithm'];
        delete clone['hashSemanticsVersion'];
        return [name, clone];
      }),
    );
    writeSpecState(workspace, { ...state, stages: legacyStages as typeof state.stages });

    const reread = readSpecState(workspace, SPEC);
    expect(reread.state).toBeDefined();
    expect(stateStage(reread.state!, 'tasks')?.approvedPlanHash).toBeUndefined();

    // Untouched file: approval holds.
    expect(evaluateWorkflow(workspace, reread.state!).health).toBe('ok');

    // Checkbox flip without a stored plan hash: falls back to exact-byte
    // semantics — stale, exactly as v0.3 behaved.
    editFile(root, `.kiro/specs/${SPEC}/tasks.md`, (content) =>
      content.replace('- [ ] 1. Implement the settings store', '- [x] 1. Implement the settings store'),
    );
    const evaluation = evaluateWorkflow(workspace, readSpecState(workspace, SPEC).state!);
    expect(evaluation.stages.find((stage) => stage.stage === 'tasks')?.effective).toBe(
      'modified-after-approval',
    );
  });
});
