import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  beginTaskAttempt,
  buildJobGraph,
  completeTaskAttempt,
  createJob,
  createTaskCheckpoint,
  driveJob,
  readExecutionLedger,
  readJobEvents,
  readSchedulingDecisions,
  requireGraphRevision,
  requireJobState,
} from '@specbridge/orchestration';
import type {
  DriverDeps,
  DriverEvent,
  LocalExecutorInference,
  QuotaTelemetryProvider,
  QuotaWindowSnapshot,
} from '@specbridge/orchestration';
import type { ExecutionFixture } from '../helpers-execution.js';
import { approveAllStages, setupExecutionFixture } from '../helpers-execution.js';
import { fixturePath } from '../helpers.js';

/**
 * vNext.2 quota-aware scheduling, driver level and fully offline:
 *
 *   quota telemetry  → a scripted deterministic provider (always fresh,
 *                      test-controlled remaining/reset per window)
 *   local reasoning  → the REAL fake llama-server child process
 *   local EXECUTION  → an injected deterministic inference (structured
 *                      edits applied + verified by the REAL pipeline)
 *   strong execution → the REAL mock runner through the evidence pipeline
 *   time             → a virtual clock; sleeps advance it
 *
 * These are the phase's driver-level scenarios: lane routing end-to-end,
 * bounded local escalation, Max-cooldown local continuation with a durable
 * defer, and the long-horizon NORMAL → CONSERVE → HARVEST → cross-reset
 * admission flow with restart continuation.
 */

const FAKE_LLAMA = fixturePath('fake-llama', 'fake-llama-server.mjs');

function virtualClock(startIso: string): { clock: () => Date; advance: (ms: number) => void } {
  let nowMs = Date.parse(startIso);
  return {
    clock: () => new Date((nowMs += 1_000)),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/** Scripted telemetry: observations are always fresh; tests mutate state. */
class ScriptedQuotaProvider implements QuotaTelemetryProvider {
  readonly source = 'scripted';
  fiveHourRemaining: number | null = null;
  fiveHourResetAt: string | null = null;
  weeklyRemaining: number | null = null;
  weeklyResetAt: string | null = null;

  constructor(private readonly clock: () => Date) {}

  private snapshot(window: 'five-hour' | 'weekly'): QuotaWindowSnapshot | null {
    const remaining = window === 'five-hour' ? this.fiveHourRemaining : this.weeklyRemaining;
    if (remaining === null) return null;
    return {
      window,
      remainingRatio: remaining,
      usedRatio: null,
      resetAt: window === 'five-hour' ? this.fiveHourResetAt : this.weeklyResetAt,
      observedAt: this.clock().toISOString(),
      source: this.source,
    };
  }

  getFiveHourQuota(): Promise<QuotaWindowSnapshot | null> {
    return Promise.resolve(this.snapshot('five-hour'));
  }

  getWeeklyQuota(): Promise<QuotaWindowSnapshot | null> {
    return Promise.resolve(this.snapshot('weekly'));
  }
}

interface QuotaDriverFixture extends ExecutionFixture {
  driverDeps: DriverDeps;
  quota: ScriptedQuotaProvider;
  advance: (ms: number) => void;
}

/** Rewrite the fixture tasks, re-approve, and commit so the tree is clean. */
function installTasks(fixture: ExecutionFixture, taskLines: string[], clock: () => Date): void {
  const tasksPath = path.join(
    fixture.root,
    '.kiro',
    'specs',
    fixture.specName,
    'tasks.md',
  );
  writeFileSync(tasksPath, `# Implementation Plan\n\n${taskLines.join('\n\n')}\n`, 'utf8');
  approveAllStages(fixture.workspace, fixture.specName, clock);
  execFileSync('git', ['add', '-A'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-q', '-m', 'test: lane-scenario tasks'], {
    cwd: fixture.root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function quotaFixture(options: {
  tasks: string[];
  jobs?: Record<string, unknown>;
  startIso?: string;
}): QuotaDriverFixture {
  const time = virtualClock(options.startIso ?? '2026-08-21T09:00:00.000Z');
  const fixture = setupExecutionFixture({
    git: true,
    extraConfig: {
      localInference: {
        enabled: true,
        executable: process.execPath,
        executableArgs: [FAKE_LLAMA],
        model: FAKE_LLAMA,
        startupTimeoutMs: 30_000,
        requestTimeoutMs: 30_000,
      },
      orchestration: {
        jobs: {
          // Deterministic complexity only: the fake local classifier always
          // proposes MEDIUM, which would (correctly, conservatively) push
          // every LOCAL_TRY candidate to the strong lane. These scenarios
          // exercise lane policy, so complexity stays deterministic.
          routing: { classifier: 'disabled' },
          ...(options.jobs ?? {}),
        },
      },
    },
  });
  installTasks(fixture, options.tasks, time.clock);
  const quota = new ScriptedQuotaProvider(time.clock);
  return {
    ...fixture,
    clock: time.clock,
    advance: time.advance,
    quota,
    driverDeps: {
      workspace: fixture.workspace,
      config: fixture.config,
      registry: fixture.registry,
      clock: time.clock,
      idFactory: fixture.idFactory,
      host: 'test',
    },
  };
}

function editInference(edits: { path: string; content: string }[]): LocalExecutorInference {
  return () =>
    Promise.resolve({
      ok: true,
      text: JSON.stringify({
        decision: 'IMPLEMENTED',
        summary: 'Local implementation of the selected task.',
        edits,
      }),
      usage: { inputTokens: 700, outputTokens: 300 },
    });
}

function drive(
  fixture: QuotaDriverFixture,
  jobId: string,
  extras: {
    inference?: LocalExecutorInference;
    onEvent?: (event: DriverEvent) => void;
  } = {},
) {
  return driveJob(fixture.driverDeps, jobId, {
    quotaTelemetryProvider: fixture.quota,
    ...(extras.inference !== undefined ? { localExecutorInference: extras.inference } : {}),
    ...(extras.onEvent !== undefined ? { onEvent: extras.onEvent } : {}),
    sleep: (ms) => {
      fixture.advance(ms);
      return Promise.resolve();
    },
  });
}

function eventTypes(fixture: QuotaDriverFixture, jobId: string): string[] {
  return readJobEvents(fixture.workspace, jobId, { limit: 2_000 }).events.map(
    (event) => event.type,
  );
}

describe('quota-aware driver scheduling', () => {
  it('routes LOCAL_TRY work to the local lane and strong work to the subscription, end to end', async () => {
    const fixture = quotaFixture({
      tasks: [
        '- [ ] 1. Add a simple validation helper module\n  - _Requirements: 1.1_',
        '- [ ] 2. Implement the settings store integration\n  - _Requirements: 1.1_',
      ],
    });
    fixture.quota.fiveHourRemaining = 0.8;
    fixture.quota.fiveHourResetAt = new Date(Date.parse('2026-08-21T09:00:00.000Z') + 3 * 3_600_000).toISOString();
    fixture.quota.weeklyRemaining = 0.7;
    fixture.quota.weeklyResetAt = new Date(Date.parse('2026-08-21T09:00:00.000Z') + 3 * 86_400_000).toISOString();

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Lane routing scenario.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([
        { path: 'src/validation-helper.txt', content: 'validation helper implementation\n' },
      ]),
    });

    expect(result.stop.kind).toBe('completed');
    expect(readFileSync(path.join(fixture.root, 'src', 'validation-helper.txt'), 'utf8')).toContain(
      'validation helper',
    );

    // The ledger attributes every attempt to its lane, with quota context.
    const ledger = readExecutionLedger(fixture.workspace, jobId);
    const executors = ledger.filter((entry) => entry.role === 'EXECUTOR');
    const local = executors.filter((entry) => entry.lane === 'LOCAL');
    const subscription = executors.filter((entry) => entry.lane === 'SUBSCRIPTION');
    expect(local).toHaveLength(1);
    expect(local[0]?.taskId).toBe('1');
    expect(local[0]?.status).toBe('COMPLETED');
    expect(local[0]?.localSuitability).toBe('LOCAL_TRY');
    expect(local[0]?.provider).toBe('local-llamacpp');
    expect(subscription).toHaveLength(1);
    expect(subscription[0]?.taskId).toBe('2');
    expect(subscription[0]?.metrics.fiveHourQuotaBefore).toBe(0.8);
    expect(subscription[0]?.metrics.fiveHourQuotaAfter).toBe(0.8);
    // The LOCAL_TRY task consumed zero subscription attempts.
    expect(executors.filter((entry) => entry.taskId === '1' && entry.lane !== 'LOCAL')).toHaveLength(0);

    // Structured decisions + lifecycle events exist for every routing.
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    expect(decisions.some((decision) => decision.selectedLane === 'LOCAL' && decision.reasonCode === 'LOCAL_TRY_FIRST')).toBe(true);
    expect(decisions.some((decision) => decision.selectedLane === 'SUBSCRIPTION' && decision.reasonCode === 'STRONG_REQUIRED')).toBe(true);
    const types = eventTypes(fixture, jobId);
    for (const expected of [
      'quota_snapshot_updated',
      'scheduling_decision_created',
      'local_suitability_classified',
      'workload_estimated',
      'task_routed_local',
      'task_routed_subscription',
      'job_completed',
    ]) {
      expect(types).toContain(expected);
    }
  });

  it('stops bounded local attempts and escalates to the subscription lane, history preserved', async () => {
    const fixture = quotaFixture({
      tasks: ['- [ ] 1. Add a simple validation helper module\n  - _Requirements: 1.1_'],
    });
    fixture.quota.fiveHourRemaining = 0.9;
    fixture.quota.weeklyRemaining = 0.9;

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Local escalation scenario.',
    }).jobId;
    // The local model returns a syntactically valid but EMPTY implementation
    // every time: the evidence pipeline classifies it (no repository change),
    // diagnosis recommends repair, and the bounded local budget runs out.
    const result = await drive(fixture, jobId, { inference: editInference([]) });

    expect(result.stop.kind).toBe('completed');
    const ledger = readExecutionLedger(fixture.workspace, jobId).filter(
      (entry) => entry.role === 'EXECUTOR',
    );
    const localAttempts = ledger.filter((entry) => entry.lane === 'LOCAL');
    const strongAttempts = ledger.filter((entry) => entry.lane === 'SUBSCRIPTION');
    expect(localAttempts).toHaveLength(2);
    expect(localAttempts.every((entry) => entry.status === 'FAILED')).toBe(true);
    expect(strongAttempts).toHaveLength(1);
    expect(strongAttempts[0]?.status).toBe('COMPLETED');
    // Attempt numbers show one continuous history, not a reset counter.
    expect(ledger.map((entry) => entry.attemptNumber)).toEqual([1, 2, 3]);

    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    expect(
      decisions.some(
        (decision) =>
          decision.selectedLane === 'SUBSCRIPTION' &&
          decision.reasonCode === 'LOCAL_ESCALATION_REQUIRED',
      ),
    ).toBe(true);
    const types = eventTypes(fixture, jobId);
    expect(types.filter((type) => type === 'local_attempt_failed').length).toBeGreaterThanOrEqual(2);
  });

  it('Test L: five-hour exhaustion defers strong work durably while local work overtakes and completes', async () => {
    const startIso = '2026-08-21T09:00:00.000Z';
    const fixture = quotaFixture({
      startIso,
      tasks: [
        '- [ ] 1. Implement the settings store integration\n  - _Requirements: 1.1_',
        '- [ ] 2. Summarize the build log findings report\n  - _Requirements: 1.2_',
      ],
    });
    const reset = new Date(Date.parse(startIso) + 90 * 60_000).toISOString();
    fixture.quota.fiveHourRemaining = 0;
    fixture.quota.fiveHourResetAt = reset;
    fixture.quota.weeklyRemaining = 0.8;

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Cooldown continuation scenario.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([
        { path: 'docs/build-log-summary.txt', content: 'build log findings summary\n' },
      ]),
    });

    // The driver stops resumable-deferred, never blocked: strong work is
    // durably pending with the reset time, local work already completed.
    expect(result.stop.kind).toBe('deferred');
    expect(result.job.status).toBe('WAITING_RETRY');
    expect(result.job.retryAt).toBe(reset);

    const graph = requireGraphRevision(fixture.workspace, jobId, result.job.graphRevision);
    const strongNode = graph.nodes.find((node) => node.parentTaskId === '1');
    const localNode = graph.nodes.find((node) => node.parentTaskId === '2');
    expect(localNode?.status).toBe('COMPLETED');
    expect(strongNode?.status).toBe('READY');
    const ledger = readExecutionLedger(fixture.workspace, jobId).filter(
      (entry) => entry.role === 'EXECUTOR',
    );
    expect(ledger.filter((entry) => entry.taskId === '1')).toHaveLength(0);
    expect(ledger.find((entry) => entry.taskId === '2')?.lane).toBe('LOCAL');

    const types = eventTypes(fixture, jobId);
    expect(types).toContain('quota_exhausted');
    expect(types).toContain('task_deferred');
    expect(types).toContain('task_routed_local');
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    expect(
      decisions.some(
        (decision) => decision.selectedLane === 'DEFER' && decision.reasonCode === 'FIVE_HOUR_EXHAUSTED',
      ),
    ).toBe(true);

    // The reset arrives; a FRESH driver run (restart semantics: everything
    // derives from durable state + telemetry) completes the strong task.
    fixture.advance(95 * 60_000);
    fixture.quota.fiveHourRemaining = 1;
    fixture.quota.fiveHourResetAt = new Date(Date.parse(reset) + 5 * 3_600_000).toISOString();
    const resumed = await drive(fixture, jobId, { inference: editInference([]) });
    expect(resumed.stop.kind).toBe('completed');
    const finalLedger = readExecutionLedger(fixture.workspace, jobId).filter(
      (entry) => entry.role === 'EXECUTOR' && entry.taskId === '1',
    );
    expect(finalLedger).toHaveLength(1);
    expect(finalLedger[0]?.lane).toBe('SUBSCRIPTION');
    expect(finalLedger[0]?.status).toBe('COMPLETED');
  });

  it('Test J (driver): weekly scarcity suppresses HARVEST and defers to the weekly reset', async () => {
    const startIso = '2026-08-21T09:00:00.000Z';
    const fixture = quotaFixture({
      startIso,
      tasks: ['- [ ] 1. Implement the settings store integration\n  - _Requirements: 1.1_'],
      jobs: {
        scheduler: { estimator: { lowWallTimeMs: 50 * 60_000, lowQuotaBurnRatio: 0.35 } },
      },
    });
    const weeklyReset = new Date(Date.parse(startIso) + 3 * 86_400_000).toISOString();
    fixture.quota.fiveHourRemaining = 0.5;
    fixture.quota.fiveHourResetAt = new Date(Date.parse(startIso) + 15 * 60_000).toISOString();
    fixture.quota.weeklyRemaining = 0.03;
    fixture.quota.weeklyResetAt = weeklyReset;

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Weekly dominance scenario.',
    }).jobId;
    const result = await drive(fixture, jobId);

    expect(result.stop.kind).toBe('deferred');
    expect(result.job.retryAt).toBe(weeklyReset);
    const types = eventTypes(fixture, jobId);
    expect(types).not.toContain('harvest_entered');
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    const defer = decisions.find((decision) => decision.selectedLane === 'DEFER');
    expect(defer?.reasonCode).toBe('WEEKLY_QUOTA_PRESSURE');
    expect(defer?.schedulerMode).toBe('CONSERVE');
  });

  it('long horizon: NORMAL → CONSERVE → HARVEST, cross-reset admission, continuation past the reset', async () => {
    const startIso = '2026-08-21T09:00:00.000Z';
    const startMs = Date.parse(startIso);
    const fixture = quotaFixture({
      startIso,
      tasks: [
        '- [ ] 1. Summarize the module layout findings\n  - _Requirements: 1.1_',
        '- [ ] 2. Implement the settings store integration\n  - _Requirements: 1.1_',
        '- [ ] 3. Add a simple validation helper module\n  - _Requirements: 1.1_',
        '- [ ] 4. Implement the persistence layer integration\n  - _Requirements: 1.2_',
      ],
      jobs: {
        scheduler: { estimator: { lowWallTimeMs: 50 * 60_000, lowQuotaBurnRatio: 0.35 } },
      },
    });
    // T0: healthy — NORMAL.
    fixture.quota.fiveHourRemaining = 0.8;
    fixture.quota.fiveHourResetAt = new Date(startMs + 4 * 3_600_000).toISOString();
    fixture.quota.weeklyRemaining = 0.8;
    fixture.quota.weeklyResetAt = new Date(startMs + 4 * 86_400_000).toISOString();

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Long-horizon mixed-resource scenario.',
    }).jobId;

    // Choreography driven by driver events:
    //   after task 2 completes on the subscription → capacity drops (CONSERVE)
    //   after task 3 completes locally → reset approaches with 50% left (HARVEST)
    //   after task 4 is dispatched → the reset happens mid-execution
    let harvestArmed = false;
    const onEvent = (event: DriverEvent): void => {
      if (event.kind === 'executor-finished' && event.message.startsWith('task 2:')) {
        fixture.quota.fiveHourRemaining = 0.12;
        fixture.quota.fiveHourResetAt = new Date(fixture.clock().getTime() + 2 * 3_600_000).toISOString();
      }
      if (event.kind === 'executor-finished' && event.message.startsWith('task 3:')) {
        fixture.quota.fiveHourRemaining = 0.5;
        fixture.quota.fiveHourResetAt = new Date(fixture.clock().getTime() + 20 * 60_000).toISOString();
        harvestArmed = true;
      }
      if (harvestArmed && event.kind === 'executor-started' && event.message.includes('task 4')) {
        // The five-hour window resets while task 4 is executing.
        fixture.quota.fiveHourRemaining = 0.95;
        fixture.quota.fiveHourResetAt = new Date(fixture.clock().getTime() + 5 * 3_600_000).toISOString();
      }
    };

    // Each local dispatch produces a DISTINCT artifact: a byte-identical
    // re-write would honestly classify as no-change and escalate.
    let localCalls = 0;
    const inference: LocalExecutorInference = () => {
      localCalls += 1;
      return Promise.resolve({
        ok: true,
        text: JSON.stringify({
          decision: 'IMPLEMENTED',
          summary: `Local implementation #${localCalls}.`,
          edits: [{ path: `docs/local-work-${localCalls}.txt`, content: `local artifact ${localCalls}\n` }],
        }),
      });
    };
    const result = await drive(fixture, jobId, { inference, onEvent });

    expect(result.stop.kind).toBe('completed');
    expect(result.job.status).toBe('COMPLETED');

    // Lanes: 1 and 3 local, 2 and 4 subscription.
    const ledger = readExecutionLedger(fixture.workspace, jobId).filter(
      (entry) => entry.role === 'EXECUTOR' && entry.status === 'COMPLETED',
    );
    const laneByTask = new Map(ledger.map((entry) => [entry.taskId, entry.lane]));
    expect(laneByTask.get('1')).toBe('LOCAL');
    expect(laneByTask.get('2')).toBe('SUBSCRIPTION');
    expect(laneByTask.get('3')).toBe('LOCAL');
    expect(laneByTask.get('4')).toBe('SUBSCRIPTION');

    // Mode lifecycle: NORMAL start, CONSERVE after the drop, HARVEST near
    // the reset, and the cross-reset admission for task 4.
    const events = readJobEvents(fixture.workspace, jobId, { limit: 2_000 }).events;
    const modeChanges = events
      .filter((event) => event.type === 'scheduler_mode_changed')
      .map((event) => (event as { to?: string }).to);
    expect(modeChanges).toContain('CONSERVE');
    expect(modeChanges).toContain('HARVEST');
    expect(events.some((event) => event.type === 'harvest_entered')).toBe(true);
    const crossReset = events.find((event) => event.type === 'cross_reset_admitted');
    expect(crossReset).toBeDefined();
    const crossPayload = crossReset as { preResetBurnRatio?: number } | undefined;
    expect(crossPayload?.preResetBurnRatio).toBeGreaterThan(0.12);
    expect(crossPayload?.preResetBurnRatio).toBeLessThan(0.15);

    // The decision record shows the admitted task crossing the reset, and
    // the quota-before/after observations straddle it (before 0.5, after
    // 0.95 — a reset mid-attempt, honestly recorded, never a fabricated burn).
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    const harvestDecision = decisions.find(
      (decision) => decision.taskId === '4' && decision.selectedLane === 'SUBSCRIPTION',
    );
    expect(harvestDecision?.crossesReset).toBe(true);
    expect(harvestDecision?.schedulerMode).toBe('HARVEST');
    const task4 = readExecutionLedger(fixture.workspace, jobId).find(
      (entry) => entry.taskId === '4' && entry.role === 'EXECUTOR',
    );
    expect(task4?.metrics.fiveHourQuotaBefore).toBe(0.5);
    expect(task4?.metrics.fiveHourQuotaAfter).toBe(0.95);

    // Restart reconstruction: a fresh read of durable state answers the
    // scheduler questions without any in-memory survivor.
    const finalJob = requireJobState(fixture.workspace, jobId);
    expect(finalJob.status).toBe('COMPLETED');
    expect(readSchedulingDecisions(fixture.workspace, jobId).length).toBeGreaterThanOrEqual(4);
  });

  it('Test K (driver): heavy durable context triggers compact-before-dispatch, then the task runs', async () => {
    const fixture = quotaFixture({
      tasks: ['- [ ] 1. Implement the settings store integration\n  - _Requirements: 1.1_'],
      jobs: {
        // A small context budget plus a low pre-dispatch threshold so a
        // realistic checkpoint size crosses it deterministically.
        context: {
          defaultModelContextTokens: 3_000,
          reservedOutputTokens: 400,
          reservedReasoningTokens: 100,
          reservedGrowthTokens: 100,
        },
        scheduler: { contextCompactBeforeDispatchRatio: 0.3 },
      },
    });
    fixture.quota.fiveHourRemaining = 0.9;
    fixture.quota.weeklyRemaining = 0.9;

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Context admission scenario.',
    }).jobId;
    // Simulate a previous worker session that accumulated heavy durable
    // task state: a recorded attempt plus a fat structured checkpoint.
    await buildJobGraph(fixture.driverDeps, jobId);
    const survivalDeps = {
      workspace: fixture.workspace,
      clock: fixture.clock,
      idFactory: fixture.idFactory,
    };
    const seeded = beginTaskAttempt(survivalDeps, {
      jobId,
      nodeId: 'n-1',
      taskId: '1',
      role: 'EXECUTOR',
      workerId: 'previous-session',
      provider: 'previous-session',
    });
    createTaskCheckpoint(survivalDeps, {
      jobId,
      nodeId: 'n-1',
      taskId: '1',
      attemptId: seeded.attemptId,
      reason: 'shutdown',
      objective: 'Continue the settings store integration from durable state.',
      pinned: {
        taskContract: `Task 1: Implement the settings store integration. ${'Detail. '.repeat(120)}`,
        acceptanceCriteria: Array.from({ length: 10 }, (_, index) => `Criterion ${index}: ${'x'.repeat(80)}`),
        constraints: Array.from({ length: 10 }, (_, index) => `Constraint ${index}: ${'y'.repeat(80)}`),
        invariants: [],
      },
      completedWork: Array.from({ length: 10 }, (_, index) => `Completed step ${index}: ${'z'.repeat(60)}`),
      nextActions: ['Finish wiring the persistence module.'],
    });
    completeTaskAttempt(survivalDeps, {
      jobId,
      attemptId: seeded.attemptId,
      status: 'FAILED',
      failure: { category: 'TRANSIENT_TOOL', message: 'previous session ended' },
    });

    const result = await drive(fixture, jobId);
    expect(result.stop.kind).toBe('completed');

    const types = eventTypes(fixture, jobId);
    expect(types).toContain('context_compaction_before_dispatch');
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    const dispatchDecision = decisions.find((decision) => decision.selectedLane === 'SUBSCRIPTION');
    expect(dispatchDecision?.reasonCode).toBe('COMPACT_BEFORE_EXECUTION');
    expect(dispatchDecision?.contextStatus?.compactFirst).toBe(true);
    expect(dispatchDecision?.contextStatus?.usageRatio ?? 0).toBeGreaterThanOrEqual(0.3);
    // The dispatched attempt carries the context observation and lineage.
    const attempt = readExecutionLedger(fixture.workspace, jobId).find(
      (entry) => entry.role === 'EXECUTOR' && entry.status === 'COMPLETED',
    );
    expect(attempt?.metrics.contextUsageBefore ?? 0).toBeGreaterThanOrEqual(0.3);
  });
});
