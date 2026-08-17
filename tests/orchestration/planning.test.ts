import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { approveStage } from '@specbridge/workflow';
import {
  assessIntent,
  assessPlanChange,
  evaluatePlanFreshness,
  isOrchestrationError,
  refreshPlanBinding,
  reviewPlan,
  submitPlan,
} from '@specbridge/orchestration';
import type { ExecutionPlan, OrchestrationState } from '@specbridge/orchestration';
import { git } from '../helpers-execution.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';
import {
  beginReadyRun,
  setupOrchestrationFixture,
  testPlanCandidate,
} from '../helpers-orchestration.js';

/**
 * Execution planning: plans bind to context, stale plans are refused,
 * review is required by default, and only material changes re-open a review.
 */

function readyRun(fixture: OrchestrationFixture, taskId = '1'): OrchestrationState {
  const run = beginReadyRun(fixture, { taskId });
  const assessed = assessIntent(fixture.deps, run.orchestrationId, {
    outcome: 'READY',
    summary: `Implement task ${taskId} exactly as the approved design describes.`,
    provenance: [{ fact: 'design.md is approved', source: 'known-from-approved-spec' }],
  });
  expect(assessed.state.phase).toBe('READY_TO_PLAN');
  return assessed.state;
}

describe('plan creation and binding', () => {
  it('binds a plan to the task fingerprint, approved hashes, and Git baseline', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);

    const result = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));

    expect(result.plan.revision).toBe(1);
    expect(result.plan.binding.taskId).toBe('1');
    expect(result.plan.binding.taskFingerprint).toMatch(/\S/);
    expect(Object.keys(result.plan.binding.approvedStageHashes).sort()).toEqual([
      'design',
      'requirements',
      'tasks',
    ]);
    expect(result.plan.binding.gitHead).toMatch(/^[0-9a-f]{7,40}$/);
    expect(result.plan.binding.policyFingerprint).toMatch(/\S/);
  });

  it('requires review by default and refuses to execute before it', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    const result = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));

    expect(result.reviewRequired).toBe(true);
    expect(result.state.phase).toBe('AWAITING_PLAN_REVIEW');
  });

  it('goes straight to executable in auto planning mode, but still records a plan', async () => {
    const fixture = setupOrchestrationFixture({ git: true, policy: { planning: { mode: 'auto' } } });
    const run = readyRun(fixture);
    const result = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));

    expect(result.reviewRequired).toBe(false);
    expect(result.state.phase).toBe('READY_TO_EXECUTE');
    expect(result.state.planRevision).toBe(1);
  });

  it('refuses a plan while clarification questions are open', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = beginReadyRun(fixture, { taskId: '1' });
    assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'NEEDS_CLARIFICATION',
      summary: 'Implement routing; the mechanism is unspecified.',
    });

    try {
      await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
      expect.unreachable('planning must wait for clarification');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.code).toBe('SBO007');
      expect(error.failureCategory).toBe('AMBIGUITY');
    }
  });

  it('refuses a plan before intent is assessed', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = beginReadyRun(fixture, { taskId: '1' });
    await expect(
      submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1')),
    ).rejects.toThrow(/Intent must be assessed/);
  });

  it('refuses a plan bound to a task that does not exist', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    await expect(
      submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('99')),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses a plan with no steps and a plan over the step budget', async () => {
    const fixture = setupOrchestrationFixture({ git: true, policy: { planning: { maxPlanSteps: 3 } } });
    const run = readyRun(fixture);

    await expect(
      submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1', { steps: [] })),
    ).rejects.toThrow(/at least one step/);

    await expect(
      submitPlan(
        fixture.deps,
        run.orchestrationId,
        testPlanCandidate('1', {
          steps: Array.from({ length: 4 }, (_, index) => ({ description: `step ${index}` })),
        }),
      ),
    ).rejects.toThrow(/at most 3 steps/);
  });
});

describe('plan review', () => {
  it('records an approved review bound to the exact plan hash', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    const submitted = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));

    const reviewed = reviewPlan(fixture.deps, run.orchestrationId, {
      planHash: submitted.planHash,
      decision: 'approved',
    });

    expect(reviewed.phase).toBe('READY_TO_EXECUTE');
    expect(reviewed.planReview?.decision).toBe('approved');
    expect(reviewed.planReview?.planHash).toBe(submitted.planHash);
    expect(reviewed.planReview?.channel).toBe('user-relayed');
  });

  it('refuses a review whose hash does not match the active plan', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));

    try {
      reviewPlan(fixture.deps, run.orchestrationId, {
        planHash: 'deadbeef',
        decision: 'approved',
      });
      expect.unreachable('a mismatched hash must be refused');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.code).toBe('SBO012');
    }
  });

  it('sends a rejected plan back to planning, never to execution', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    const submitted = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));

    const reviewed = reviewPlan(fixture.deps, run.orchestrationId, {
      planHash: submitted.planHash,
      decision: 'rejected',
      note: 'Wrong subsystem.',
    });
    expect(reviewed.phase).toBe('READY_TO_PLAN');
  });
});

describe('plan freshness', () => {
  const baseBinding = {
    taskId: '1',
    taskFingerprint: 'fp-1',
    approvedStageHashes: { design: 'aaa' },
    gitHead: 'head-1',
    policyFingerprint: 'policy-1',
  };
  // Only the binding participates in freshness, so a partial plan is enough.
  const basePlan = { binding: baseBinding } as unknown as ExecutionPlan;

  it('is fresh when nothing changed', () => {
    expect(evaluatePlanFreshness(basePlan, baseBinding).fresh).toBe(true);
  });

  it('detects a changed task fingerprint', () => {
    const result = evaluatePlanFreshness(basePlan, { ...baseBinding, taskFingerprint: 'fp-2' });
    expect(result.fresh).toBe(false);
    expect(result.reasons).toContain('task-fingerprint-changed');
  });

  it('detects a changed approved stage', () => {
    const result = evaluatePlanFreshness(basePlan, {
      ...baseBinding,
      approvedStageHashes: { design: 'bbb' },
    });
    expect(result.reasons).toContain('approved-stage-changed');
  });

  it('detects a stage approved after planning', () => {
    const result = evaluatePlanFreshness(basePlan, {
      ...baseBinding,
      approvedStageHashes: { design: 'aaa', tasks: 'ccc' },
    });
    expect(result.reasons).toContain('approved-stage-changed');
  });

  it('detects a moved repository baseline', () => {
    const result = evaluatePlanFreshness(basePlan, { ...baseBinding, gitHead: 'head-2' });
    expect(result.reasons).toContain('repository-baseline-changed');
  });

  it('detects a changed policy', () => {
    const result = evaluatePlanFreshness(basePlan, { ...baseBinding, policyFingerprint: 'policy-2' });
    expect(result.reasons).toContain('policy-changed');
  });

  it('marks a plan stale and moves the run to REPLANNING when the task changes', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    const submitted = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
    reviewPlan(fixture.deps, run.orchestrationId, {
      planHash: submitted.planHash,
      decision: 'approved',
    });

    // Edit tasks.md so the selected task's text changes, then re-approve so
    // the only difference the harness sees is the task itself.
    const tasksPath = path.join(fixture.workspace.kiroDir, 'specs', fixture.specName, 'tasks.md');
    const original = readFileSync(tasksPath, 'utf8');
    writeFileSync(tasksPath, original.replace(/^(- \[ \] 1\..*)$/m, '$1 (revised scope)'), 'utf8');
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, fixture.specName));
    approveStage(fixture.workspace, spec, { stage: 'tasks' }, { clock: fixture.clock });

    const refreshed = await refreshPlanBinding(fixture.deps, run.orchestrationId);
    expect(refreshed.freshness.fresh).toBe(false);
    expect(refreshed.state.phase).toBe('REPLANNING');
    expect(refreshed.state.planStaleReasons.length).toBeGreaterThan(0);
  });

  it('marks a plan stale when the repository baseline moves', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    const submitted = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
    reviewPlan(fixture.deps, run.orchestrationId, {
      planHash: submitted.planHash,
      decision: 'approved',
    });

    writeFileSync(path.join(fixture.root, 'unrelated.txt'), 'new commit\n', 'utf8');
    git(fixture.root, 'add', '.');
    git(fixture.root, 'commit', '-q', '-m', 'move HEAD');

    const refreshed = await refreshPlanBinding(fixture.deps, run.orchestrationId);
    expect(refreshed.freshness.reasons).toContain('repository-baseline-changed');
    expect(refreshed.state.phase).toBe('REPLANNING');
  });
});

describe('replanning materiality', () => {
  const plan = (overrides: Partial<ExecutionPlan> = {}): ExecutionPlan =>
    ({
      goal: 'Add persistence',
      nonGoals: ['no migration'],
      constraints: ['no new dependency'],
      expectedAreas: ['src/settings'],
      testStrategy: 'unit tests',
      verificationStrategy: 'pnpm test',
      assumptions: [],
      relevantEvidence: [],
      openQuestions: [],
      binding: { taskId: '1' },
      steps: [
        { id: 's1', description: 'add module', expectedAreas: [], status: 'pending' },
        { id: 's2', description: 'wire it up', expectedAreas: [], status: 'pending' },
      ],
      ...overrides,
    }) as ExecutionPlan;

  it('treats step reordering as immaterial', () => {
    const reordered = plan({
      steps: [
        { id: 's2', description: 'wire it up', expectedAreas: [], status: 'pending' },
        { id: 's1', description: 'add module', expectedAreas: [], status: 'pending' },
      ],
    } as Partial<ExecutionPlan>);
    const assessment = assessPlanChange(plan(), reordered);
    expect(assessment.materiality).toBe('immaterial');
    expect(assessment.immaterialChanges).toContain('steps-reordered');
  });

  it('treats added evidence and assumptions as immaterial', () => {
    const assessment = assessPlanChange(
      plan(),
      plan({ relevantEvidence: ['found the module'], assumptions: ['tests run offline'] }),
    );
    expect(assessment.materiality).toBe('immaterial');
  });

  it('treats a changed goal as material', () => {
    expect(assessPlanChange(plan(), plan({ goal: 'Add caching instead' })).materiality).toBe('material');
  });

  it('treats a changed subsystem as material', () => {
    const assessment = assessPlanChange(plan(), plan({ expectedAreas: ['src/network'] }));
    expect(assessment.materiality).toBe('material');
    expect(assessment.materialChanges).toContain('expected-areas-changed');
  });

  it('treats a changed verification strategy as material', () => {
    const assessment = assessPlanChange(plan(), plan({ verificationStrategy: 'manual smoke test' }));
    expect(assessment.materialChanges).toContain('verification-strategy-changed');
  });

  it('treats a violated non-goal as material', () => {
    expect(assessPlanChange(plan(), plan({ nonGoals: [] })).materiality).toBe('material');
  });

  it('treats a new dependency constraint as material', () => {
    const assessment = assessPlanChange(plan(), plan({ constraints: ['add a new dependency'] }));
    expect(assessment.materialChanges).toContain('constraints-changed');
  });

  it('treats different steps as material', () => {
    const assessment = assessPlanChange(
      plan(),
      plan({
        steps: [{ id: 's1', description: 'rewrite the broker', expectedAreas: [], status: 'pending' }],
      } as Partial<ExecutionPlan>),
    );
    expect(assessment.materialChanges).toContain('steps-changed');
  });
});

describe('replan budget and review invalidation', () => {
  it('a material replan invalidates the previous approval', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    const first = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
    reviewPlan(fixture.deps, run.orchestrationId, {
      planHash: first.planHash,
      decision: 'approved',
    });

    const second = await submitPlan(
      fixture.deps,
      run.orchestrationId,
      testPlanCandidate('1', {
        goal: 'Take a completely different approach.',
        replanReason: 'The expected API does not exist.',
      }),
    );

    expect(second.materiality?.materiality).toBe('material');
    expect(second.reviewRequired).toBe(true);
    expect(second.state.phase).toBe('AWAITING_PLAN_REVIEW');
    expect(second.state.planReview).toBeUndefined();
    expect(second.state.counters.replans).toBe(1);
  });

  it('an immaterial replan keeps the existing approval', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const run = readyRun(fixture);
    const first = await submitPlan(
      fixture.deps,
      run.orchestrationId,
      testPlanCandidate('1', {
        steps: [{ description: 'step one' }, { description: 'step two' }],
      }),
    );
    reviewPlan(fixture.deps, run.orchestrationId, {
      planHash: first.planHash,
      decision: 'approved',
    });

    const second = await submitPlan(
      fixture.deps,
      run.orchestrationId,
      testPlanCandidate('1', {
        steps: [{ description: 'step two' }, { description: 'step one' }],
        relevantEvidence: ['the module already exists'],
      }),
    );

    expect(second.materiality?.materiality).toBe('immaterial');
    expect(second.reviewRequired).toBe(false);
    expect(second.state.phase).toBe('READY_TO_EXECUTE');
  });

  it('bounds the number of replans', async () => {
    const fixture = setupOrchestrationFixture({ git: true, policy: { planning: { mode: 'auto', maxReplans: 1 } } });
    const run = readyRun(fixture);
    await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
    await submitPlan(
      fixture.deps,
      run.orchestrationId,
      testPlanCandidate('1', { goal: 'Second approach' }),
    );

    try {
      await submitPlan(
        fixture.deps,
        run.orchestrationId,
        testPlanCandidate('1', { goal: 'Third approach' }),
      );
      expect.unreachable('the replan budget must stop a third plan');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.code).toBe('SBO013');
      expect(error.failureCategory).toBe('BUDGET_EXHAUSTED');
    }
  });
});
