import { describe, expect, it } from 'vitest';
import {
  assessIntent,
  createCheckpoint,
  explainOrchestration,
  finalizeOrchestration,
  isOrchestrationError,
  readOrchestrationEvents,
  recordAction,
  requireOrchestrationState,
  reviewPlan,
  submitPlan,
} from '@specbridge/orchestration';
import type { OrchestrationState } from '@specbridge/orchestration';
import type { OrchestrationFixture, OrchestrationFixtureOptions } from '../helpers-orchestration.js';
import {
  beginReadyRun,
  setupOrchestrationFixture,
  testPlanCandidate,
} from '../helpers-orchestration.js';

/**
 * The bounded observe/decide/act loop: what may be attempted when, how
 * failures route, and how every budget terminates the run explicitly rather
 * than letting it continue forever.
 */

interface ReadyFixture {
  fixture: OrchestrationFixture;
  id: string;
  state: OrchestrationState;
}

/** A run advanced to READY_TO_EXECUTE with an approved plan. */
async function executableRun(options: OrchestrationFixtureOptions = {}): Promise<ReadyFixture> {
  const fixture = setupOrchestrationFixture(options);
  const run = beginReadyRun(fixture, { taskId: '1' });
  assessIntent(fixture.deps, run.orchestrationId, {
    outcome: 'READY',
    summary: 'Implement task 1 exactly as the approved design describes.',
    provenance: [{ fact: 'design.md is approved', source: 'known-from-approved-spec' }],
  });
  const submitted = await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));
  const state = submitted.reviewRequired
    ? reviewPlan(fixture.deps, run.orchestrationId, {
        planHash: submitted.planHash,
        decision: 'approved',
      })
    : submitted.state;
  expect(state.phase).toBe('READY_TO_EXECUTE');
  return { fixture, id: run.orchestrationId, state };
}

const inspect = { action: 'INSPECT' as const, target: 'src/settings.ts', result: 'progressed' as const };

describe('action gating', () => {
  it('refuses a source edit before any plan exists', async () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture, { taskId: '1' });
    assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement task 1.',
      provenance: [{ fact: 'approved', source: 'known-from-approved-spec' }],
    });

    try {
      recordAction(fixture.deps, run.orchestrationId, {
        action: 'EDIT',
        target: 'src/settings.ts',
        result: 'progressed',
      });
      expect.unreachable('edits before a plan must be refused');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      // The phase gate fires first: READY_TO_PLAN does not permit EDIT.
      expect(error.code).toBe('SBO019');
    }
  });

  it('refuses a source edit while the plan is awaiting review', async () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture, { taskId: '1' });
    assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement task 1.',
      provenance: [{ fact: 'approved', source: 'known-from-approved-spec' }],
    });
    await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));

    expect(() =>
      recordAction(fixture.deps, run.orchestrationId, {
        action: 'EDIT',
        target: 'src/settings.ts',
        result: 'progressed',
      }),
    ).toThrow(/not allowed while the orchestration run is AWAITING_PLAN_REVIEW/);
  });

  it('allows inspection before the plan gate', async () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture, { taskId: '1' });
    assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement task 1.',
      provenance: [{ fact: 'approved', source: 'known-from-approved-spec' }],
    });
    const result = recordAction(fixture.deps, run.orchestrationId, inspect);
    expect(result.decision.directive).toBe('CONTINUE');
  });

  it('allows edits once the plan is approved and moves to EXECUTING', async () => {
    const { fixture, id } = await executableRun();
    const result = recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      planStepId: 's1',
      expectedEvidence: 'the settings module exists',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });

    expect(result.state.phase).toBe('EXECUTING');
    expect(result.decision.directive).toBe('CONTINUE');
    expect(result.state.counters.iterations).toBe(1);
  });

  it('refuses every action on a finalized run', async () => {
    const { fixture, id } = await executableRun();
    recordAction(fixture.deps, id, { ...inspect });
    finalizeOrchestration(fixture.deps, id, { outcome: 'aborted', reason: 'user stopped' });

    try {
      recordAction(fixture.deps, id, { ...inspect });
      expect.unreachable('a finalized run records nothing further');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.code).toBe('SBO005');
    }
  });
});

describe('verification failure enters bounded repair', () => {
  it('routes a failing verifier into REPAIRING rather than a rerun', async () => {
    const { fixture, id } = await executableRun();
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });

    const failed = recordAction(fixture.deps, id, {
      action: 'VERIFY',
      target: 'pnpm test',
      result: 'failed',
      failure: {
        category: 'VERIFICATION_FAILURE',
        message: 'the unit test failed',
        source: 'pnpm test',
        exitCode: 1,
        output: 'expected 3 to equal 4',
      },
    });

    expect(failed.decision.directive).toBe('REPAIR');
    expect(failed.state.phase).toBe('REPAIRING');
    expect(failed.state.counters.repairCycles).toBe(1);
    expect(failed.state.repairTargetFingerprint).toBe(failed.classifiedFailure?.fingerprint);
  });

  it('records a repair against fresh failure evidence and can succeed', async () => {
    const { fixture, id } = await executableRun();
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });
    recordAction(fixture.deps, id, {
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

    // The repair changes the tree, so the next observation is genuinely new.
    const repaired = recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h2' }],
      readyToVerify: true,
    });

    expect(repaired.decision.directive).toBe('VERIFY');
    expect(repaired.progress.progressed).toBe(true);
  });

  it('stops within the repair budget and leaves the task incomplete', async () => {
    const { fixture, id } = await executableRun({
      policy: { execution: { maxRepairCycles: 2, maxNoProgressCycles: 10 } },
    });

    // Three failures with materially different output: the repair budget —
    // not stagnation — must be what stops the run.
    const outputs = ['expected 3 to equal 4', 'expected 5 to equal 6', 'expected 7 to equal 8'];
    let last = recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h0' }],
    });
    for (const [index, output] of outputs.entries()) {
      last = recordAction(fixture.deps, id, {
        action: 'VERIFY',
        target: 'pnpm test',
        result: 'failed',
        changedFiles: [{ path: 'src/settings.ts', contentHash: `h${index + 1}` }],
        failure: {
          category: 'VERIFICATION_FAILURE',
          message: 'failed',
          source: 'pnpm test',
          exitCode: 1,
          output,
        },
      });
    }

    expect(last.decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(last.decision.exhaustedBudget).toBe('maxRepairCycles');
    expect(last.state.phase).toBe('BLOCKED');
    expect(last.state.finalOutcome).toBeUndefined();
    expect(last.state.blocker?.category).toBe('BUDGET_EXHAUSTED');
  });
});

describe('no-progress detection', () => {
  it('detects materially identical repair attempts and replans', async () => {
    const { fixture, id } = await executableRun({
      policy: { execution: { maxNoProgressCycles: 2, maxRepairCycles: 10 }, planning: { mode: 'auto' } },
    });

    const identicalFailure = {
      category: 'VERIFICATION_FAILURE' as const,
      message: 'failed',
      source: 'pnpm test',
      exitCode: 1,
      output: 'expected 3 to equal 4',
    };
    const identicalTree = [{ path: 'src/settings.ts', contentHash: 'same' }];

    // Execution must actually start before verification can be requested.
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: identicalTree,
    });
    recordAction(fixture.deps, id, {
      action: 'VERIFY',
      target: 'pnpm test',
      result: 'failed',
      changedFiles: identicalTree,
      failure: identicalFailure,
    });
    const second = recordAction(fixture.deps, id, {
      action: 'VERIFY',
      target: 'pnpm test',
      result: 'failed',
      changedFiles: identicalTree,
      failure: identicalFailure,
    });

    expect(second.progress.progressed).toBe(false);
    expect(second.progress.consecutiveNoProgress).toBe(1);

    const third = recordAction(fixture.deps, id, {
      action: 'VERIFY',
      target: 'pnpm test',
      result: 'failed',
      changedFiles: identicalTree,
      failure: identicalFailure,
    });

    expect(third.progress.stagnated).toBe(true);
    expect(third.decision.directive).toBe('REPLAN');
    expect(third.state.phase).toBe('REPLANNING');
  });

  it('blocks when stagnation persists and the replan budget is gone', async () => {
    const { fixture, id } = await executableRun({
      policy: {
        planning: { mode: 'auto', maxReplans: 0 },
        execution: { maxNoProgressCycles: 2, maxRepairCycles: 10 },
      },
    });
    const failure = {
      category: 'VERIFICATION_FAILURE' as const,
      message: 'failed',
      source: 'pnpm test',
      exitCode: 1,
      output: 'same failure every time',
    };
    const tree = [{ path: 'src/settings.ts', contentHash: 'same' }];

    recordAction(fixture.deps, id, { action: 'EDIT', target: 'src/settings.ts', result: 'progressed', changedFiles: tree });
    recordAction(fixture.deps, id, { action: 'VERIFY', target: 'pnpm test', result: 'failed', changedFiles: tree, failure });
    recordAction(fixture.deps, id, { action: 'VERIFY', target: 'pnpm test', result: 'failed', changedFiles: tree, failure });
    const third = recordAction(fixture.deps, id, {
      action: 'VERIFY',
      target: 'pnpm test',
      result: 'failed',
      changedFiles: tree,
      failure,
    });

    expect(third.decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(third.state.phase).toBe('BLOCKED');
  });

  it('a new plan revision resets stagnation: replanning is a genuine change', async () => {
    const { fixture, id } = await executableRun({
      policy: { planning: { mode: 'auto' }, execution: { maxNoProgressCycles: 2, maxRepairCycles: 10 } },
    });
    const failure = {
      category: 'VERIFICATION_FAILURE' as const,
      message: 'failed',
      source: 'pnpm test',
      exitCode: 1,
      output: 'identical',
    };
    const tree = [{ path: 'src/settings.ts', contentHash: 'same' }];
    recordAction(fixture.deps, id, { action: 'EDIT', target: 'src/settings.ts', result: 'progressed', changedFiles: tree });
    recordAction(fixture.deps, id, { action: 'VERIFY', target: 'pnpm test', result: 'failed', changedFiles: tree, failure });
    const second = recordAction(fixture.deps, id, {
      action: 'VERIFY',
      target: 'pnpm test',
      result: 'failed',
      changedFiles: tree,
      failure,
    });
    expect(second.progress.consecutiveNoProgress).toBe(1);

    const replanned = await submitPlan(
      fixture.deps,
      id,
      testPlanCandidate('1', { goal: 'A materially different approach.' }),
    );
    expect(replanned.state.counters.consecutiveNoProgress).toBe(0);
  });
});

describe('budgets terminate explicitly', () => {
  it('stops at the iteration budget without completing the task', async () => {
    const { fixture, id } = await executableRun({
      policy: { execution: { maxIterations: 3 }, planning: { mode: 'auto' } },
    });

    let last = recordAction(fixture.deps, id, { ...inspect, target: 'a.ts' });
    last = recordAction(fixture.deps, id, { ...inspect, target: 'b.ts' });
    last = recordAction(fixture.deps, id, { ...inspect, target: 'c.ts' });
    last = recordAction(fixture.deps, id, { ...inspect, target: 'd.ts' });

    expect(last.decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(last.decision.exhaustedBudget).toBe('maxIterations');
    expect(last.state.phase).toBe('BLOCKED');
    expect(last.state.finalOutcome).toBeUndefined();
  });

  it('preserves the full event history when a budget stops the run', async () => {
    const { fixture, id } = await executableRun({
      policy: { execution: { maxIterations: 2 }, planning: { mode: 'auto' } },
    });
    recordAction(fixture.deps, id, { ...inspect, target: 'a.ts' });
    recordAction(fixture.deps, id, { ...inspect, target: 'b.ts' });
    recordAction(fixture.deps, id, { ...inspect, target: 'c.ts' });

    const page = readOrchestrationEvents(fixture.workspace, id, { limit: 200 });
    expect(page.events.some((event) => event['type'] === 'budget_exhausted')).toBe(true);
    expect(page.events.filter((event) => event['type'] === 'action_recorded').length).toBe(3);
  });
});

describe('transient retry', () => {
  it('retries a transient failure with backoff and no duplicate mutation', async () => {
    const { fixture, id } = await executableRun({ policy: { planning: { mode: 'auto' } } });

    const first = recordAction(fixture.deps, id, {
      action: 'TEST',
      target: 'pnpm test',
      result: 'failed',
      failure: {
        category: 'TRANSIENT_TOOL',
        message: 'the test runner crashed on startup',
        source: 'pnpm test',
        exitCode: 137,
      },
    });
    expect(first.decision.directive).toBe('RETRY');
    expect(first.decision.backoffMs).toBeGreaterThan(0);
    expect(first.state.counters.transientRetries).toBe(1);
    // A retry does not count as a repair, and changes nothing in the tree.
    expect(first.state.counters.repairCycles).toBe(0);
  });

  it('stops once the transient budget is exhausted', async () => {
    const { fixture, id } = await executableRun({
      policy: { planning: { mode: 'auto' }, retry: { maxTransientRetries: 1 } },
    });
    const transient = {
      category: 'TRANSIENT_TRANSPORT' as const,
      message: 'connection reset',
      source: 'probe',
    };
    recordAction(fixture.deps, id, { action: 'INSPECT', target: 'probe', result: 'failed', failure: transient });
    const second = recordAction(fixture.deps, id, {
      action: 'INSPECT',
      target: 'probe',
      result: 'failed',
      failure: transient,
    });

    expect(second.decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(second.decision.exhaustedBudget).toBe('maxTransientRetries');
  });
});

describe('completion authority', () => {
  it('refuses to complete without a verified evidence status', async () => {
    const { fixture, id } = await executableRun();
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });

    for (const status of [undefined, 'implemented-unverified', 'failed', 'no-change', 'blocked']) {
      try {
        finalizeOrchestration(fixture.deps, id, {
          outcome: 'completed',
          reason: 'agent believes it is done',
          ...(status !== undefined ? { evidenceStatus: status } : {}),
        });
        expect.unreachable(`completion must be refused for evidenceStatus=${String(status)}`);
      } catch (error) {
        if (!isOrchestrationError(error)) throw error;
        expect(error.code).toBe('SBO022');
        expect(error.failureCategory).toBe('SAFETY_POLICY');
      }
    }

    expect(requireOrchestrationState(fixture.workspace, id).phase).toBe('EXECUTING');
  });

  it('completes only on verified evidence from task_complete', async () => {
    const { fixture, id } = await executableRun();
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });

    const completed = finalizeOrchestration(fixture.deps, id, {
      outcome: 'completed',
      reason: 'verified',
      evidenceStatus: 'verified',
      interactiveRunId: 'run-000001',
    });
    expect(completed.phase).toBe('COMPLETED');
    expect(completed.finalOutcome).toBe('COMPLETED');
  });

  it('accepts a manual acceptance as the other documented verified path', async () => {
    const { fixture, id } = await executableRun();
    recordAction(fixture.deps, id, { ...inspect });
    const completed = finalizeOrchestration(fixture.deps, id, {
      outcome: 'completed',
      reason: 'manually accepted by the user',
      evidenceStatus: 'manually-accepted',
    });
    expect(completed.phase).toBe('COMPLETED');
  });

  it('finalization is idempotent and never re-runs', async () => {
    const { fixture, id } = await executableRun();
    recordAction(fixture.deps, id, { ...inspect });
    const first = finalizeOrchestration(fixture.deps, id, { outcome: 'aborted', reason: 'stop' });
    const second = finalizeOrchestration(fixture.deps, id, { outcome: 'aborted', reason: 'stop again' });
    expect(second.finalizedAt).toBe(first.finalizedAt);
    expect(second.phase).toBe('ABORTED');
  });
});

describe('cancellation', () => {
  it('never restarts automatically after cancellation', async () => {
    const { fixture, id } = await executableRun({ policy: { planning: { mode: 'auto' } } });
    const cancelled = recordAction(fixture.deps, id, {
      action: 'INSPECT',
      target: 'src',
      result: 'failed',
      failure: { category: 'CANCELLED', message: 'the user cancelled', source: 'host' },
    });

    expect(cancelled.decision.directive).toBe('STOP_FINAL');
    expect(cancelled.state.phase).toBe('CANCELLED');
    expect(cancelled.state.finalOutcome).toBe('CANCELLED');
    expect(() => recordAction(fixture.deps, id, { ...inspect })).toThrow(/CANCELLED/);
  });

  it('preserves the recorded evidence after cancellation', async () => {
    const { fixture, id } = await executableRun({ policy: { planning: { mode: 'auto' } } });
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });
    recordAction(fixture.deps, id, {
      action: 'INSPECT',
      target: 'src',
      result: 'failed',
      failure: { category: 'CANCELLED', message: 'cancelled', source: 'host' },
    });

    const page = readOrchestrationEvents(fixture.workspace, id, { limit: 100 });
    expect(page.events.some((event) => event['type'] === 'action_recorded')).toBe(true);
    expect(page.events.some((event) => event['type'] === 'execution_cancelled')).toBe(true);
  });
});

describe('checkpoints', () => {
  it('writes a compact structured checkpoint with the exact next action', async () => {
    const { fixture, id } = await executableRun();
    recordAction(fixture.deps, id, {
      action: 'EDIT',
      target: 'src/settings.ts',
      result: 'progressed',
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });

    const checkpoint = createCheckpoint(fixture.deps, id, {
      observations: ['The settings module exists but is not wired up.'],
      latestVerifier: 'pnpm test (not yet run)',
      nextAction: 'Wire the settings module into the app entry point, then call task_complete.',
    });

    expect(checkpoint.phase).toBe('EXECUTING');
    expect(checkpoint.planRevision).toBe(1);
    expect(checkpoint.unresolvedSteps.length).toBeGreaterThan(0);
    expect(checkpoint.nextAction).toMatch(/task_complete/);
    // Compact by construction: no transcript field exists to fill.
    expect(Object.keys(checkpoint)).not.toContain('transcript');
    expect(JSON.stringify(checkpoint).length).toBeLessThan(4_000);
  });
});

describe('explainability', () => {
  it('explains exactly why execution has not started', async () => {
    const fixture = setupOrchestrationFixture();
    const run = beginReadyRun(fixture, { taskId: '1' });
    assessIntent(fixture.deps, run.orchestrationId, {
      outcome: 'READY',
      summary: 'Implement task 1.',
      provenance: [{ fact: 'approved', source: 'known-from-approved-spec' }],
    });
    await submitPlan(fixture.deps, run.orchestrationId, testPlanCandidate('1'));

    const explanation = explainOrchestration(
      requireOrchestrationState(fixture.workspace, run.orchestrationId),
    );
    expect(explanation.executionBlockedBecause).toMatch(/has not been reviewed/);
    expect(explanation.nextAction).toMatch(/orchestration_review_plan/);
    expect(explanation.planReviewed).toBe(false);
  });

  it('reports which budget was exhausted', async () => {
    const { fixture, id } = await executableRun({
      policy: { execution: { maxIterations: 1 }, planning: { mode: 'auto' } },
    });
    recordAction(fixture.deps, id, { ...inspect });
    recordAction(fixture.deps, id, { ...inspect, target: 'other.ts' });

    const explanation = explainOrchestration(requireOrchestrationState(fixture.workspace, id));
    expect(explanation.exhaustedBudgets).toContain('iterations');
    expect(explanation.blocker?.category).toBe('BUDGET_EXHAUSTED');
  });
});
