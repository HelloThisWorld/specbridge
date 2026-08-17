import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessIntent,
  createCheckpoint,
  finalizeOrchestration,
  recordAction,
  recordActionChecked,
  requestClarification,
  resumeOrchestration,
  reviewPlan,
  submitPlan,
} from '@specbridge/orchestration';
import { git } from '../helpers-execution.js';
import { withPolicy } from '../helpers-orchestration.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';
import {
  beginReadyRun,
  setupOrchestrationFixture,
  testPlanCandidate,
} from '../helpers-orchestration.js';

/**
 * Resume: the same run comes back, with its real identity, its real
 * counters, and an honest verdict on whether its plan still applies.
 */

async function planned(
  fixture: OrchestrationFixture,
  options: { review?: boolean } = {},
): Promise<string> {
  const run = beginReadyRun(fixture, { taskId: '1' });
  assessIntent(fixture.deps, run.orchestrationId, {
    outcome: 'READY',
    summary: 'Implement task 1 as the approved design describes.',
    provenance: [{ fact: 'design approved', source: 'known-from-approved-spec' }],
  });
  const submitted = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
  if (submitted.reviewRequired && options.review !== false) {
    reviewPlan(fixture.deps, run.orchestrationId, {
      planHash: submitted.planHash,
      decision: 'approved',
    });
  }
  return run.orchestrationId;
}

describe('resume preserves real run identity', () => {
  it('returns the same run with its counters intact', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const id = await planned(fixture);
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });

    const report = await resumeOrchestration(fixture.deps, id);
    expect(report.state.orchestrationId).toBe(id);
    expect(report.state.counters.iterations).toBe(1);
    expect(report.state.planRevision).toBe(1);
    expect(report.finalized).toBe(false);
  });

  it('recovers each intermediate phase', async () => {
    const phases: string[] = [];

    // Awaiting clarification.
    const clarifying = setupOrchestrationFixture({ git: true });
    const run = beginReadyRun(clarifying, { taskId: '1' });
    assessIntent(clarifying.deps, run.orchestrationId, {
      outcome: 'NEEDS_CLARIFICATION',
      summary: 'Implement routing; the mechanism is unspecified.',
    });
    requestClarification(clarifying.deps, run.orchestrationId, [
      { question: 'Which routing mechanism?', whyItMatters: 'Changes the worker.' },
    ]);
    phases.push((await resumeOrchestration(clarifying.deps, run.orchestrationId)).state.phase);

    // Awaiting plan review.
    const reviewing = setupOrchestrationFixture({ git: true });
    const reviewId = await planned(reviewing, { review: false });
    phases.push((await resumeOrchestration(reviewing.deps, reviewId)).state.phase);

    // Executing.
    const executing = setupOrchestrationFixture({ git: true });
    const execId = await planned(executing);
    recordAction(executing.deps, execId, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });
    phases.push((await resumeOrchestration(executing.deps, execId)).state.phase);

    // Repairing.
    const repairing = setupOrchestrationFixture({ git: true });
    const repairId = await planned(repairing);
    recordAction(repairing.deps, repairId, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });
    recordAction(repairing.deps, repairId, {
      action: 'VERIFY',
      target: 'pnpm test',
      result: 'failed',
      failure: {
        category: 'VERIFICATION_FAILURE',
        message: 'failed',
        source: 'pnpm test',
        exitCode: 1,
        output: 'expected 3 to equal 4',
      },
    });
    phases.push((await resumeOrchestration(repairing.deps, repairId)).state.phase);

    expect(phases).toEqual(['NEEDS_CLARIFICATION', 'AWAITING_PLAN_REVIEW', 'EXECUTING', 'REPAIRING']);
  });

  it('reports a blocked run with its blocker and remediation', async () => {
    const fixture = setupOrchestrationFixture({
      policy: { execution: { maxIterations: 1 }, planning: { mode: 'auto' } },
    });
    const id = await planned(fixture);
    recordAction(fixture.deps, id, { action: 'INSPECT', target: 'a.ts', result: 'progressed' });
    recordAction(fixture.deps, id, { action: 'INSPECT', target: 'b.ts', result: 'progressed' });

    const report = await resumeOrchestration(fixture.deps, id);
    expect(report.state.phase).toBe('BLOCKED');
    expect(report.explanation.blocker?.category).toBe('BUDGET_EXHAUSTED');
    expect(report.nextAction).toMatch(/\S/);
  });
});

describe('a finalized run never masquerades as a continuation', () => {
  it('reports the recorded outcome and refuses to continue', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const id = await planned(fixture);
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });
    finalizeOrchestration(fixture.deps, id, {
      outcome: 'completed',
      reason: 'verified',
      evidenceStatus: 'verified',
    });

    const report = await resumeOrchestration(fixture.deps, id);
    expect(report.finalized).toBe(true);
    expect(report.state.phase).toBe('COMPLETED');
    expect(report.warnings.join(' ')).toMatch(/cannot be continued/i);
    expect(report.nextAction).toMatch(/Start a new run/i);
  });

  it('reports a cancelled run as final too', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const id = await planned(fixture);
    finalizeOrchestration(fixture.deps, id, { outcome: 'cancelled', reason: 'user cancelled' });

    const report = await resumeOrchestration(fixture.deps, id);
    expect(report.finalized).toBe(true);
    expect(report.state.phase).toBe('CANCELLED');
  });
});

describe('resume detects a stale plan', () => {
  it('refuses an obsolete plan after the repository moved', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const id = await planned(fixture);

    writeFileSync(path.join(fixture.root, 'unrelated.txt'), 'moved\n', 'utf8');
    git(fixture.root, 'add', '.');
    git(fixture.root, 'commit', '-q', '-m', 'move HEAD during interruption');

    const report = await resumeOrchestration(fixture.deps, id);
    expect(report.planStale).toBe(true);
    expect(report.planStaleReasons).toContain('repository-baseline-changed');
    expect(report.nextAction).toMatch(/replacement execution plan/i);
    expect(report.planStaleExplanations.join(' ')).toMatch(/repository moved/i);
    // Inspecting a run must not change it: the phase is reported, not moved.
    expect(report.state.phase).toBe('READY_TO_EXECUTE');
  });

  it('refuses to execute the stale plan when execution is actually attempted', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const id = await planned(fixture);

    writeFileSync(path.join(fixture.root, 'unrelated.txt'), 'moved\n', 'utf8');
    git(fixture.root, 'add', '.');
    git(fixture.root, 'commit', '-q', '-m', 'move HEAD during interruption');

    // The transition happens at the moment it matters — the first mutating
    // action — not when someone merely looks at the run.
    await expect(
      recordActionChecked(fixture.deps, id, {
        action: 'EDIT',
        target: 'src/settings.ts',
        result: 'progressed',
        changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
      }),
    ).rejects.toThrow(/not allowed while the orchestration run is REPLANNING/);

    const after = await resumeOrchestration(fixture.deps, id);
    expect(after.state.phase).toBe('REPLANNING');
    expect(after.state.planStaleReasons).toContain('repository-baseline-changed');
  });

  it('surfaces a changed policy without silently applying it', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const id = await planned(fixture);

    const changed = {
      ...fixture.deps,
      config: withPolicy(fixture.config, { execution: { maxIterations: 99 } }),
    };
    const report = await resumeOrchestration(changed, id);

    expect(report.policyChanged).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/policy changed/i);
    // The run still enforces the budgets it started with.
    expect(report.state.budgets.maxIterations).toBe(12);
  });
});

describe('resume reconciles the interactive execution run', () => {
  it('warns when the recorded interactive run no longer exists', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const id = await planned(fixture);
    const { attachInteractiveRun } = await import('@specbridge/orchestration');
    attachInteractiveRun(fixture.deps, id, 'run-that-vanished');

    const report = await resumeOrchestration(fixture.deps, id);
    expect(report.activeInteractiveRun?.runId).toBe('run-that-vanished');
    expect(report.warnings.join(' ')).toMatch(/no longer exists/i);
  });
});

describe('checkpoints are recovered, not reasoning', () => {
  it('returns the recorded checkpoint with the exact next action', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    const id = await planned(fixture);
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });
    createCheckpoint(fixture.deps, id, {
      observations: ['The module exists but is not wired up.'],
      nextAction: 'Wire the module into the entry point, then call task_complete.',
    });

    const report = await resumeOrchestration(fixture.deps, id);
    expect(report.checkpoint?.nextAction).toMatch(/task_complete/);
    // Nothing in the recovered state can carry the previous session's
    // deliberation: there is no field for it.
    const serialized = JSON.stringify(report.checkpoint);
    expect(serialized).not.toMatch(/reasoning|chainOfThought|transcript/i);
  });
});
