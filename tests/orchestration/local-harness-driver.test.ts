import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJob,
  dispatchLocalHarnessExecution,
  driveJob,
  evaluateLocalRuntime,
  jobNodeSchema,
  taskCheckpointSchema,
  listTaskAttempts,
  readExecutionLedger,
  readJobEvents,
  readLatestTaskCheckpoint,
  readSchedulingDecisions,
  recordScenarioResult,
  requireGraphRevision,
  requireJobState,
  startQualificationRun,
  summarizeLocalRuntime,
} from '@specbridge/orchestration';
import type {
  DriverDeps,
  DriverEvent,
  LocalExecutorInference,
  QuotaTelemetryProvider,
  QuotaWindowSnapshot,
} from '@specbridge/orchestration';
import type { ExecutionFixture } from '../helpers-execution.js';
import {
  FAKE_DSH_PASSTHROUGH,
  approveAllStages,
  failingCommand,
  passingCommand,
  setupExecutionFixtureV2,
} from '../helpers-execution.js';
import { resolveWorkspace } from '@specbridge/core';
import { fixturePath } from '../helpers.js';
import { fixtureTarget, setupQualificationWorkspace } from '../helpers-qualification.js';

/**
 * vNext.4 Local Agentic Runtime — driver level, fully offline.
 *
 *   quota telemetry   → a scripted deterministic provider
 *   local reasoning   → the REAL fake llama-server child process
 *   LOCAL / DIRECT    → an injected deterministic inference, applied and
 *                       verified by the REAL evidence pipeline
 *   LOCAL / HARNESS   → the REAL official DSH SDK driving the REAL fake DSH
 *                       runtime over stdio JSON-RPC, editing the REAL
 *                       repository and judged by the REAL evidence pipeline
 *   SUBSCRIPTION      → the REAL mock runner through the evidence pipeline
 *   time              → a virtual clock; sleeps advance it
 *
 * No network, no GPU, no credentials, no real model.
 *
 * What every scenario is really testing: that adding an agentic execution
 * mode to the LOCAL lane changed WHO DOES THE WORK and nothing about who
 * decides it is done.
 */

const FAKE_LLAMA = fixturePath('fake-llama', 'fake-llama-server.mjs');

const TASKS = {
  /** LOCAL_SAFE + ONE_SHOT: a bounded transformation, no tools needed. */
  oneShot: '- [ ] 1. Summarize the verification results into a report file\n  - _Requirements: 1.1_',
  /** LOCAL_TRY + AGENTIC: known-good local work that needs the repository. */
  agentic:
    '- [ ] 2. Add the simple settings validation and make the failing tests pass\n  - _Requirements: 1.1_',
  /**
   * STRONG_REQUIRED: no local category matches, so the deterministic
   * suitability classifier routes it strong. (An architecture-keyword task
   * would also force HIGH complexity, which sends the PLANNER role to the
   * large agent as well — this phase is about the EXECUTOR lane, so the task
   * stays LOW complexity and only the execution lane differs.)
   */
  strong: '- [ ] 3. Implement the settings store integration\n  - _Requirements: 1.1_',
  /**
   * LOCAL_TRY + ONE_SHOT on its face: the adaptive policy tries a single
   * bounded request first. Whether it actually needed the repository is
   * only knowable from the attempt that failed.
   */
  oneShotEdit: '- [ ] 4. Add the simple settings validation helper\n  - _Requirements: 1.1_',
} as const;

function virtualClock(startIso: string): { clock: () => Date; advance: (ms: number) => void } {
  let nowMs = Date.parse(startIso);
  return {
    clock: () => new Date((nowMs += 1_000)),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

class ScriptedQuotaProvider implements QuotaTelemetryProvider {
  readonly source = 'scripted';
  fiveHourRemaining: number | null = 0.9;
  fiveHourResetAt: string | null = null;
  weeklyRemaining: number | null = 0.9;
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

interface HarnessFixture extends ExecutionFixture {
  driverDeps: DriverDeps;
  quota: ScriptedQuotaProvider;
  advance: (ms: number) => void;
  dshLog: string;
}

function installTasks(fixture: ExecutionFixture, taskLines: string[], clock: () => Date): void {
  const tasksPath = path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md');
  writeFileSync(tasksPath, `# Implementation Plan\n\n${taskLines.join('\n\n')}\n`, 'utf8');
  approveAllStages(fixture.workspace, fixture.specName, clock);
  execFileSync('git', ['add', '-A'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-q', '-m', 'test: local-runtime scenario tasks'], {
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

function harnessFixture(options: {
  tasks: string[];
  strategy?: 'DIRECT_ONLY' | 'HARNESS_ONLY' | 'ADAPTIVE';
  dshProfileOverrides?: Record<string, unknown>;
  scheduler?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
  verificationCommands?: Record<string, unknown>[];
  startIso?: string;
}): HarnessFixture {
  const time = virtualClock(options.startIso ?? '2026-08-21T09:00:00.000Z');
  const fixture = setupExecutionFixtureV2({
    useFakeDsh: true,
    ...(options.dshProfileOverrides !== undefined
      ? { dshProfileOverrides: options.dshProfileOverrides }
      : {}),
    verificationCommands: options.verificationCommands ?? [passingCommand()],
    extraTopLevel: {
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
          // Deterministic complexity only: these scenarios exercise lane and
          // mode policy, not the local classifier's opinion.
          routing: { classifier: 'disabled' },
          scheduler: {
            localExecution: {
              strategy: options.strategy ?? 'ADAPTIVE',
              harnessProfile: 'dsh-local',
              maxHarnessWallTimeMs: 120_000,
            },
            ...(options.scheduler ?? {}),
          },
          ...(options.jobs ?? {}),
        },
      },
    },
  });
  installTasks(fixture, options.tasks, time.clock);
  // The runtime's own audit log lives OUTSIDE the workspace: a file the
  // harness writes inside the repository would show up as a repository
  // change and be attributed to the agent by the evidence pipeline.
  const dshLog = path.join(mkdtempSync(path.join(os.tmpdir(), 'specbridge-dsh-log-')), 'fake-dsh-log.jsonl');
  process.env['FAKE_DSH_LOG'] = dshLog;
  return {
    ...fixture,
    clock: time.clock,
    advance: time.advance,
    quota: new ScriptedQuotaProvider(time.clock),
    dshLog,
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

/** A deterministic DIRECT local inference that writes the given files. */
function setupExistingWorkspace(root: string) {
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('workspace vanished');
  return workspace;
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

/** A DIRECT local inference that declines for lack of repository knowledge. */
function decliningInference(): LocalExecutorInference {
  return () =>
    Promise.resolve({
      ok: true,
      text: JSON.stringify({
        decision: 'ESCALATE',
        summary: 'I cannot tell which file implements the settings store.',
        edits: [],
        escalationReason:
          'The task needs repository knowledge I do not have: I cannot see which module holds the settings store.',
      }),
      usage: { inputTokens: 500, outputTokens: 80 },
    });
}

function drive(
  fixture: HarnessFixture,
  jobId: string,
  extras: {
    inference?: LocalExecutorInference;
    onEvent?: (event: DriverEvent) => void;
    localExecutionMode?: 'DIRECT_MODEL' | 'HARNESS';
  } = {},
) {
  return driveJob(fixture.driverDeps, jobId, {
    quotaTelemetryProvider: fixture.quota,
    ...(extras.inference !== undefined ? { localExecutorInference: extras.inference } : {}),
    ...(extras.localExecutionMode !== undefined
      ? { localExecutionMode: extras.localExecutionMode }
      : {}),
    ...(extras.onEvent !== undefined ? { onEvent: extras.onEvent } : {}),
    sleep: (ms) => {
      fixture.advance(ms);
      return Promise.resolve();
    },
  });
}

function executors(fixture: HarnessFixture, jobId: string) {
  return readExecutionLedger(fixture.workspace, jobId).filter((entry) => entry.role === 'EXECUTOR');
}

function eventTypes(fixture: HarnessFixture, jobId: string): string[] {
  return readJobEvents(fixture.workspace, jobId, { limit: 2_000 }).events.map((event) => event.type);
}

function dshSpawned(fixture: HarnessFixture): boolean {
  if (!existsSync(fixture.dshLog)) return false;
  return readFileSync(fixture.dshLog, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .some((line) => (JSON.parse(line) as { event: string }).event === 'spawn');
}

afterEach(() => {
  for (const name of [...FAKE_DSH_PASSTHROUGH]) delete process.env[name];
});

// ---------------------------------------------------------------------------

describe('vNext.4 LOCAL execution modes, end to end', () => {
  it('Tests A/B/C/H: routes one-shot local work DIRECT, agentic local work to the HARNESS, and strong work to the subscription', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = harnessFixture({ tasks: [TASKS.oneShot, TASKS.agentic, TASKS.strong] });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Mixed local/strong queue with two local execution modes.',
    }).jobId;

    const result = await drive(fixture, jobId, {
      inference: editInference([
        { path: 'src/verification-report.md', content: '# Verification report\n\nAll checks passed.\n' },
      ]),
    });
    expect(result.stop.kind).toBe('completed');

    const ledger = executors(fixture, jobId);
    const byTask = (taskId: string) => ledger.filter((entry) => entry.taskId === taskId);

    // Task 1 — LOCAL lane, DIRECT mode. The lane says "free"; the mode says
    // "one bounded request". Both are recorded, separately.
    const one = byTask('1');
    expect(one).toHaveLength(1);
    expect(one[0]?.lane).toBe('LOCAL');
    expect(one[0]?.executionMode).toBe('DIRECT_MODEL');
    expect(one[0]?.executionShape).toBe('ONE_SHOT');
    expect(one[0]?.provider).toBe('local-llamacpp');
    expect(one[0]?.status).toBe('COMPLETED');

    // Task 2 — LOCAL lane, HARNESS mode: the harness explored, edited two
    // files, ran a command, saw it fail, repaired, and re-ran — all inside
    // ONE SpecBridge attempt.
    const two = byTask('2');
    expect(two).toHaveLength(1);
    expect(two[0]?.lane).toBe('LOCAL');
    expect(two[0]?.executionMode).toBe('HARNESS');
    expect(two[0]?.executionShape).toBe('AGENTIC');
    expect(two[0]?.provider).toBe('dsh-local');
    expect(two[0]?.model).toBe('fake-local-qwen');
    expect(two[0]?.computeLocality).toBe('LOCAL');
    expect(two[0]?.status).toBe('COMPLETED');
    // The task completed because SpecBridge verified the repository, and the
    // repository really changed — in both files the harness edited.
    expect(readFileSync(path.join(fixture.root, 'src', 'fake-dsh-change.txt'), 'utf8')).toContain(
      'fake dsh implementation',
    );
    expect(readFileSync(path.join(fixture.root, 'src', 'fake-dsh-helper.txt'), 'utf8')).toContain(
      'repaired helper implementation',
    );
    // Observed harness activity is recorded; nothing unobservable is invented.
    expect((two[0]?.metrics.toolCalls ?? 0) >= 4).toBe(true);
    expect(two[0]?.metrics.commandRuns).toBe(2);
    expect(two[0]?.metrics.filesRead).toBeNull();

    // Task 3 — the strong lane. A harness being installed, bound, verified,
    // and idle does not tempt architecture work onto a small local model.
    const three = byTask('3');
    expect(three).toHaveLength(1);
    expect(three[0]?.lane).toBe('SUBSCRIPTION');
    expect(three[0]?.executionMode).toBeNull();
    expect(three[0]?.localSuitability).toBe('STRONG_REQUIRED');

    // Decisions record lane and mode orthogonally — never one compound value.
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    const harnessDecision = decisions.find(
      (decision) => decision.taskId === '2' && decision.selectedLane === 'LOCAL',
    );
    expect(harnessDecision?.reasonCode).toBe('LOCAL_TRY_FIRST');
    expect(harnessDecision?.localExecution?.mode).toBe('HARNESS');
    expect(harnessDecision?.localExecution?.reasonCode).toBe('LOCAL_HARNESS_SELECTED');
    expect(harnessDecision?.localExecution?.runner).toBe('deepseek-harness');
    expect(harnessDecision?.localExecution?.computeLocality).toBe('LOCAL');
    expect(harnessDecision?.localExecution?.harnessBindingStatus).toBe('BOUND');
    const directDecision = decisions.find(
      (decision) => decision.taskId === '1' && decision.selectedLane === 'LOCAL',
    );
    expect(directDecision?.localExecution?.mode).toBe('DIRECT_MODEL');
    expect(directDecision?.localExecution?.runner).toBe('local-model');
    const strongDecision = decisions.find((decision) => decision.taskId === '3');
    expect(strongDecision?.selectedLane).toBe('SUBSCRIPTION');
    expect(strongDecision?.localExecution).toBeNull();

    const types = eventTypes(fixture, jobId);
    for (const expected of ['local_execution_mode_selected', 'local_harness_selected', 'task_routed_local', 'task_routed_subscription']) {
      expect(types).toContain(expected);
    }

    // The observation read model can compare the two modes.
    const observations = summarizeLocalRuntime(readExecutionLedger(fixture.workspace, jobId));
    expect(observations.byMode['DIRECT_MODEL']?.attempts).toBe(1);
    expect(observations.byMode['HARNESS']?.attempts).toBe(1);
    expect(observations.byMode['HARNESS']?.verificationPassRate).toBe(1);

    // vNext.9: this test is the one that OBSERVES a verified local-harness
    // success, so it is the one that records the qualification scenario. The
    // fake-DSH runtime is configured through ambient environment variables,
    // so a second file driving the harness concurrently would race on the
    // Windows threads pool — which is why the recording lives here rather
    // than in a qualification-suite file of its own.
    const qualification = setupQualificationWorkspace();
    const qualificationRun = startQualificationRun(qualification.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(qualification.deps, {
      runId: qualificationRun.runId,
      scenarioId: 'local.harness-success',
      status: 'PASS',
      executor: 'regression-suite',
      observedTransitions: [
        { subject: 'agentic local task', from: 'dispatched', to: 'COMPLETED on LOCAL/HARNESS' },
        { subject: 'verified compute locality', from: 'attested', to: 'LOCAL' },
        { subject: 'completion authority', from: 'harness report', to: 'trusted repository verification' },
      ],
      evidenceRefs: [`job:${jobId}`, `attempt:${two[0]?.attemptId ?? 'unknown'}`],
      resourceAttribution: { LOCAL_HARNESS: 'SIMULATED', TRUSTED_VERIFICATION: 'SIMULATED' },
    });
  }, 180_000);

  it('Test A: a one-shot local task never starts a harness process', async () => {
    const fixture = harnessFixture({ tasks: [TASKS.oneShot] });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'One-shot local work only.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([
        { path: 'src/verification-report.md', content: '# Verification report\n' },
      ]),
    });
    expect(result.stop.kind).toBe('completed');
    expect(dshSpawned(fixture)).toBe(false);
    expect(executors(fixture, jobId)[0]?.executionMode).toBe('DIRECT_MODEL');
  }, 120_000);

  it('Test P: DIRECT_ONLY keeps vNext.2 behavior and never starts the harness', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = harnessFixture({ tasks: [TASKS.agentic], strategy: 'DIRECT_ONLY' });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Backward-compatible local routing.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([{ path: 'src/settings-validation.txt', content: 'validated\n' }]),
    });
    expect(result.stop.kind).toBe('completed');
    expect(dshSpawned(fixture)).toBe(false);
    const attempt = executors(fixture, jobId)[0];
    expect(attempt?.lane).toBe('LOCAL');
    expect(attempt?.executionMode).toBe('DIRECT_MODEL');
    const decision = readSchedulingDecisions(fixture.workspace, jobId).find(
      (entry) => entry.selectedLane === 'LOCAL',
    );
    expect(decision?.localExecution?.reasonCode).toBe('LOCAL_DIRECT_ONLY_STRATEGY');
  }, 120_000);

  it('Test D: a remote harness profile is refused for the LOCAL lane and never spawned', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = harnessFixture({
      tasks: [TASKS.agentic],
      dshProfileOverrides: {
        computeLocality: 'loopback-endpoint',
        providerEndpoint: 'https://api.example-cloud.com/v1',
      },
    });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'A remote profile must never bill a LOCAL attempt.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([{ path: 'src/settings-validation.txt', content: 'validated\n' }]),
    });
    expect(result.stop.kind).toBe('completed');

    // No inference request was ever sent: the runtime never started.
    expect(dshSpawned(fixture)).toBe(false);
    const attempt = executors(fixture, jobId)[0];
    expect(attempt?.lane).toBe('LOCAL');
    expect(attempt?.executionMode).toBe('DIRECT_MODEL');
    const decision = readSchedulingDecisions(fixture.workspace, jobId).find(
      (entry) => entry.selectedLane === 'LOCAL',
    );
    expect(decision?.localExecution?.reasonCode).toBe('LOCAL_HARNESS_NOT_VERIFIED_LOCAL');
    expect(decision?.localExecution?.harnessBindingStatus).toBe('REMOTE_COMPUTE');
    expect(eventTypes(fixture, jobId)).toContain('local_harness_locality_rejected');
  }, 120_000);

  it('Test E: an unattested harness profile fails closed to the direct path', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = harnessFixture({
      tasks: [TASKS.agentic],
      dshProfileOverrides: { computeLocality: 'unconfirmed', providerEndpoint: null },
    });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Unknown locality is never assumed local.',
    }).jobId;
    await drive(fixture, jobId, {
      inference: editInference([{ path: 'src/settings-validation.txt', content: 'validated\n' }]),
    });
    expect(dshSpawned(fixture)).toBe(false);
    const decision = readSchedulingDecisions(fixture.workspace, jobId).find(
      (entry) => entry.selectedLane === 'LOCAL',
    );
    expect(decision?.localExecution?.harnessBindingStatus).toBe('NOT_VERIFIED_LOCAL');
  }, 120_000);
});

describe('vNext.4 evidence authority and failure taxonomy', () => {
  it('Test I: the harness claims completion, trusted verification fails, the task stays open', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = harnessFixture({
      tasks: [TASKS.agentic],
      verificationCommands: [failingCommand()],
    });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'A harness claim is not evidence.',
    }).jobId;
    await drive(fixture, jobId, {
      inference: editInference([{ path: 'src/settings-validation.txt', content: 'validated\n' }]),
    });

    const graph = requireGraphRevision(
      fixture.workspace,
      jobId,
      requireJobState(fixture.workspace, jobId).graphRevision,
    );
    expect(graph.nodes.every((node) => node.status !== 'COMPLETED')).toBe(true);
    const tasksMarkdown = readFileSync(
      path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md'),
      'utf8',
    );
    // The checkbox is SpecBridge's to write, and it did not write it.
    expect(tasksMarkdown).toContain('- [ ] 2.');

    const harnessAttempts = executors(fixture, jobId).filter(
      (entry) => entry.executionMode === 'HARNESS',
    );
    expect(harnessAttempts.length).toBeGreaterThan(0);
    expect(harnessAttempts.every((entry) => entry.status === 'FAILED')).toBe(true);
    expect(harnessAttempts[0]?.failureReason).toBe('VERIFICATION_FAILURE');
  }, 180_000);

  it('Test J: a runtime crash is infrastructure failure, not proof that local intelligence is insufficient', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'crash-mid-run';
    const fixture = harnessFixture({ tasks: [TASKS.agentic] });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'A dead runtime says nothing about the task.',
    }).jobId;
    await drive(fixture, jobId, {
      inference: editInference([{ path: 'src/settings-validation.txt', content: 'validated\n' }]),
    });

    const attempts = listTaskAttempts(fixture.workspace, jobId);
    const harnessAttempt = attempts.find((attempt) => attempt.executionMode === 'HARNESS');
    // The attempt is preserved with an honest classification.
    expect(harnessAttempt).toBeDefined();
    expect(harnessAttempt?.status).toBe('FAILED');
    expect(harnessAttempt?.failure?.category).toBe('CAPABILITY_UNAVAILABLE');
    // No sticky "local is not smart enough" escalation was recorded for a
    // crashed process.
    const job = requireJobState(fixture.workspace, jobId);
    expect(
      job.escalations.filter(
        (entry) => entry.reason === 'LOCAL_EXECUTION_ESCALATED' && entry.nodeId === harnessAttempt?.nodeId,
      ),
    ).toHaveLength(0);
    // The job survives: state is durable and resumable.
    expect(readLatestTaskCheckpoint(fixture.workspace, jobId, harnessAttempt?.nodeId ?? 'n1')).toBeDefined();
  }, 180_000);

  it('Test K: bounded no-progress harness attempts escalate stickily to the subscription lane', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'no-progress';
    const fixture = harnessFixture({ tasks: [TASKS.agentic] });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Free compute is not a reason to loop forever.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([{ path: 'src/settings-validation.txt', content: 'validated\n' }]),
    });
    expect(result.stop.kind).toBe('completed');

    const ledger = executors(fixture, jobId);
    const local = ledger.filter((entry) => entry.lane === 'LOCAL');
    const strong = ledger.filter((entry) => entry.lane === 'SUBSCRIPTION');
    // The shared budget bounds LOCAL attempts, whatever mode they used.
    expect(local.length).toBeLessThanOrEqual(2);
    expect(local.every((entry) => entry.status === 'FAILED')).toBe(true);
    expect(strong.length).toBeGreaterThan(0);
    expect(strong[strong.length - 1]?.status).toBe('COMPLETED');
    // Attempt numbers are one continuous history, never a per-mode counter.
    expect(ledger.map((entry) => entry.attemptNumber)).toEqual(
      ledger.map((_, index) => index + 1),
    );
    expect(eventTypes(fixture, jobId)).toContain('local_harness_to_subscription_escalated');
  }, 240_000);
});

describe('vNext.4 within-LOCAL escalation and the shared budget', () => {
  it('Tests F/G: a direct attempt that lacks repository knowledge continues on the harness, inside one budget', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    // A ONE_SHOT-shaped local task: the adaptive policy sends it DIRECT
    // first, exactly as vNext.2 would. Only the FAILURE reveals that it
    // needed tools.
    const fixture = harnessFixture({ tasks: [TASKS.oneShotEdit] });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'DIRECT -> HARNESS is a LOCAL -> LOCAL transition.',
    }).jobId;

    // The local model declines because it cannot see the repository. That is
    // not evidence that the task needs a stronger model; it is evidence that
    // it needs repository tools.
    const result = await drive(fixture, jobId, { inference: decliningInference() });
    expect(result.stop.kind).toBe('completed');

    const ledger = executors(fixture, jobId);
    const local = ledger.filter((entry) => entry.lane === 'LOCAL');
    // Attempt 1 direct, attempt 2 harness — one budget, two modes.
    expect(local.map((entry) => entry.executionMode)).toEqual(['DIRECT_MODEL', 'HARNESS']);
    expect(local[0]?.status).toBe('FAILED');
    expect(local[0]?.executionShape).toBe('ONE_SHOT');
    expect(local[1]?.status).toBe('COMPLETED');
    expect(local[1]?.executionShape).toBe('AGENTIC');
    expect(local).toHaveLength(2);
    // The transition consumed no subscription quota at all.
    expect(ledger.filter((entry) => entry.lane === 'SUBSCRIPTION')).toHaveLength(0);

    const job = requireJobState(fixture.workspace, jobId);
    expect(job.escalations.some((entry) => entry.reason === 'LOCAL_DIRECT_TO_HARNESS')).toBe(true);
    // A within-lane mode change is NOT a strong-lane escalation.
    expect(job.escalations.some((entry) => entry.reason === 'LOCAL_EXECUTION_ESCALATED')).toBe(false);
    expect(eventTypes(fixture, jobId)).toContain('local_direct_to_harness_escalated');
    const decisions = readSchedulingDecisions(fixture.workspace, jobId).filter(
      (entry) => entry.selectedLane === 'LOCAL',
    );
    expect(decisions[decisions.length - 1]?.localExecution?.reasonCode).toBe(
      'LOCAL_DIRECT_TO_HARNESS_ESCALATION',
    );
  }, 240_000);
});

describe('vNext.4 scheduling under subscription cooldown', () => {
  it('Test L: with Max exhausted, both local modes keep working and strong work waits durably', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = harnessFixture({
      tasks: [TASKS.oneShot, TASKS.agentic, TASKS.strong],
      scheduler: { maxQuotaHoldMs: 0 },
    });
    fixture.quota.fiveHourRemaining = 0;
    fixture.quota.fiveHourResetAt = new Date(
      Date.parse('2026-08-21T09:00:00.000Z') + 4 * 3_600_000,
    ).toISOString();
    fixture.quota.weeklyRemaining = 0.8;

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Local work continues through a subscription cooldown.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([
        { path: 'src/verification-report.md', content: '# Verification report\n' },
      ]),
    });

    // The job stopped waiting for quota, not because local work stalled.
    expect(result.stop.kind).toBe('deferred');
    const ledger = executors(fixture, jobId);
    const modes = new Map(ledger.map((entry) => [entry.taskId, entry.executionMode]));
    expect(modes.get('1')).toBe('DIRECT_MODEL');
    expect(modes.get('2')).toBe('HARNESS');
    expect(ledger.filter((entry) => entry.taskId === '3')).toHaveLength(0);
    expect(ledger.every((entry) => entry.lane === 'LOCAL')).toBe(true);
    expect(ledger.every((entry) => entry.status === 'COMPLETED')).toBe(true);

    const job = requireJobState(fixture.workspace, jobId);
    expect(job.status).toBe('WAITING_RETRY');
    const types = eventTypes(fixture, jobId);
    expect(types).toContain('task_deferred');
  }, 240_000);
});

describe('vNext.4 context authority and session disposability', () => {
  it('Tests M/N: native compaction and a lost session leave canonical SpecBridge state intact', async () => {
    // The runtime compacts its own working memory mid-run, then the session
    // is destroyed entirely. Neither is allowed to matter.
    process.env['FAKE_DSH_SCENARIO'] = 'compaction';
    const fixture = harnessFixture({ tasks: [TASKS.agentic] });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Provider session memory is disposable; the checkpoint is not.',
    }).jobId;
    await drive(fixture, jobId, {
      inference: editInference([{ path: 'src/settings-validation.txt', content: 'validated\n' }]),
    });

    const attempts = listTaskAttempts(fixture.workspace, jobId).filter(
      (attempt) => attempt.executionMode === 'HARNESS',
    );
    expect(attempts.length).toBeGreaterThan(0);
    const nodeId = attempts[0]?.nodeId as string;
    const checkpoint = readLatestTaskCheckpoint(fixture.workspace, jobId, nodeId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.pinned.taskContract.length).toBeGreaterThan(0);
    // Compaction happened inside the runtime and stayed there: it is working
    // memory, and the canonical record never went through it.
    expect(attempts[0]?.metrics.compactions ?? 0).toBeGreaterThan(0);
    expect(checkpoint?.nextActions.length).toBeGreaterThan(0);

    // Every provider session reference is disposable working memory: nothing
    // canonical points at it, so losing it costs nothing.
    const sessionIds = attempts.map((attempt) => attempt.providerSessionId);
    expect(sessionIds.every((id) => id === undefined || typeof id === 'string')).toBe(true);
  }, 180_000);
});

describe('vNext.4 A/B evaluation (isolated, explicit, never production)', () => {
  it('Tests S/T: the same task runs through both modes in separate checkouts, with comparable metrics', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = harnessFixture({ tasks: [TASKS.agentic] });

    const report = await evaluateLocalRuntime({
      workspace: fixture.workspace,
      config: fixture.config,
      cases: [
        {
          caseId: 'settings-validation',
          specName: fixture.specName,
          taskId: '2',
          title: 'Add the simple settings validation and make the failing tests pass',
        },
      ],
      inference: editInference([
        { path: 'src/settings-validation.txt', content: 'validated by the direct arm\n' },
      ]),
      maxHarnessWallTimeMs: 120_000,
    });

    expect(report.cases).toHaveLength(1);
    const arms = report.cases[0]?.arms ?? [];
    expect(arms.map((arm) => arm.mode)).toEqual(['DIRECT_MODEL', 'HARNESS']);
    const direct = arms.find((arm) => arm.mode === 'DIRECT_MODEL');
    const harness = arms.find((arm) => arm.mode === 'HARNESS');

    // Both arms produced trusted evidence — in their OWN checkouts.
    expect(direct?.outcome).toBe('VERIFIED');
    expect(harness?.outcome).toBe('VERIFIED');

    // No cross-contamination: each arm changed only what it wrote, and
    // neither touched a protected control-plane path.
    expect(direct?.changedFiles).toContain('src/settings-validation.txt');
    expect(direct?.changedFiles).not.toContain('src/fake-dsh-change.txt');
    expect(harness?.changedFiles).toContain('src/fake-dsh-change.txt');
    expect(harness?.changedFiles).toContain('src/fake-dsh-helper.txt');
    expect(harness?.changedFiles).not.toContain('src/settings-validation.txt');
    expect(direct?.unexpectedFiles).toEqual([]);
    expect(harness?.unexpectedFiles).toEqual([]);

    // The user's real working tree is untouched by the whole evaluation.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: fixture.root,
      encoding: 'utf8',
    }).trim();
    expect(status).toBe('');

    // Comparable metrics, with unknowns left unknown.
    expect(direct?.inputTokens).toBe(700);
    expect(direct?.toolCalls).toBeNull();
    expect((harness?.toolCalls ?? 0) > 0).toBe(true);
    expect(harness?.commandRuns).toBe(2);
    expect(report.summary.find((entry) => entry.mode === 'HARNESS')?.verified).toBe(1);
    expect(report.summary.find((entry) => entry.mode === 'DIRECT_MODEL')?.verified).toBe(1);
    expect(report.summary.every((entry) => entry.medianWallTimeMs !== null)).toBe(true);
  }, 240_000);

  it('reports UNAVAILABLE instead of guessing when an arm cannot run', async () => {
    const fixture = harnessFixture({
      tasks: [TASKS.agentic],
      dshProfileOverrides: { computeLocality: 'unconfirmed', providerEndpoint: null },
    });
    const report = await evaluateLocalRuntime({
      workspace: fixture.workspace,
      config: fixture.config,
      cases: [
        { caseId: 'no-direct', specName: fixture.specName, taskId: '2', title: TASKS.agentic },
      ],
      modes: ['DIRECT_MODEL'],
    });
    const arm = report.cases[0]?.arms[0];
    expect(arm?.outcome).toBe('UNAVAILABLE');
    expect(arm?.evidenceStatus).toBeNull();
    expect(arm?.wallTimeMs).toBe(0);
  }, 120_000);
});

describe('vNext.4 durability across runtime loss and restart', () => {
  it('Tests J/N/§24: a lost runtime is replaced by a FRESH session bootstrapped from the checkpoint', async () => {
    // Driven directly through the harness dispatch so the runtime can die
    // once and recover once, deterministically — the driver's own retry
    // policy is exercised by Test J and Test K.
    const fixture = harnessFixture({ tasks: [TASKS.agentic] });
    const promptLog = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'specbridge-dsh-prompt-')),
      'prompts.jsonl',
    );
    process.env['FAKE_DSH_PROMPT_LOG'] = promptLog;

    const node = jobNodeSchema.parse({
      nodeId: 'n-1',
      parentTaskId: '2',
      title: TASKS.agentic,
      taskFingerprint: 'fp-2',
      status: 'READY',
      planApproved: true,
    });
    // The canonical memory a dead session cannot take with it.
    const checkpoint = taskCheckpointSchema.parse({
      schemaVersion: '1.0.0',
      checkpointId: 'cp-1',
      jobId: 'job-1',
      nodeId: 'n-1',
      taskId: '2',
      attemptId: 'ta-0001',
      seq: 1,
      reason: 'milestone',
      objective: 'Add settings validation and make the suite pass.',
      pinned: {
        taskContract: 'Validate settings on load and fail closed on malformed input.',
        acceptanceCriteria: ['Invalid settings are rejected with a named error'],
        invariants: ['Never write partial settings to disk'],
        constraints: [],
      },
      failedApproaches: [
        { approach: 'Patching the loader in place', reason: 'It bypassed the validation entry point' },
      ],
      importantDecisions: [{ decision: 'Validation lives in the loader, not the caller' }],
      nextActions: ['Add the validator and run the suite'],
      createdAt: '2026-08-21T09:00:00.000Z',
    });

    const dispatch = (): Promise<{ evidenceStatus?: string | undefined; failureKind?: string | undefined; providerSessionId?: string | undefined }> =>
      dispatchLocalHarnessExecution({
        workspace: fixture.workspace,
        config: fixture.config,
        registry: fixture.registry,
        node,
        specName: fixture.specName,
        jobId: 'job-1',
        mode: 'implement',
        allowDirty: true,
        profileName: 'dsh-local',
        checkpoint,
        maxWallTimeMs: 120_000,
      });

    process.env['FAKE_DSH_SCENARIO'] = 'crash-mid-run';
    const crashed = await dispatch();
    expect(crashed.evidenceStatus).toBeUndefined();
    // A dead runtime is infrastructure, not evidence about the model.
    expect(crashed.failureKind).toBe('INFRASTRUCTURE');

    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const recovered = await dispatch();
    expect(recovered.evidenceStatus).toBe('verified');
    // A brand-new session: nothing resumed, nothing lost.
    expect(recovered.providerSessionId).not.toBe(crashed.providerSessionId);

    // The bootstrap package is the harness's context (§24): canonical
    // SpecBridge memory plus POINTERS, not a copy of the repository.
    const prompts = readFileSync(promptLog, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { prompt: string }).prompt);
    expect(prompts.length).toBe(2);
    const last = prompts[prompts.length - 1] as string;
    expect(last).toContain('Validate settings on load and fail closed on malformed input.');
    expect(last).toContain('Patching the loader in place');
    expect(last).toContain('Validation lives in the loader, not the caller');
    expect(last).toContain('Add the validator and run the suite');
    expect(last).toContain('.kiro/specs/settings-persistence/requirements.md');
    // The approved documents are POINTED AT, not pasted: an agent with tools
    // fetches them, and the context stays lean.
    expect(last).not.toContain('# Requirements Document');
    // Protected paths and the completion boundary are stated up front.
    expect(last).toContain('NEVER modify these protected paths');
    expect(last).toContain('only that evidence can complete the task');
  }, 240_000);

  it('Test 34/35: every vNext.4 record survives a restart, read fresh from disk', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = harnessFixture({ tasks: [TASKS.oneShot, TASKS.agentic] });
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Durable state is the product; the processes are not.',
    }).jobId;
    await drive(fixture, jobId, {
      inference: editInference([
        { path: 'src/verification-report.md', content: '# Verification report\n' },
      ]),
    });

    // "Restart": nothing in memory, everything re-read from the workspace.
    const restarted = setupExistingWorkspace(fixture.root);
    const job = requireJobState(restarted, jobId);
    expect(job.status).toBe('COMPLETED');
    const ledger = readExecutionLedger(restarted, jobId).filter(
      (entry) => entry.role === 'EXECUTOR',
    );
    expect(ledger.map((entry) => entry.executionMode)).toEqual(['DIRECT_MODEL', 'HARNESS']);
    expect(ledger.every((entry) => entry.computeLocality === 'LOCAL')).toBe(true);
    const decisions = readSchedulingDecisions(restarted, jobId);
    expect(decisions.some((entry) => entry.localExecution?.mode === 'HARNESS')).toBe(true);
    const attempts = listTaskAttempts(restarted, jobId);
    expect(attempts.some((attempt) => attempt.executionShape === 'AGENTIC')).toBe(true);
    for (const attempt of attempts.filter((entry) => entry.role === 'EXECUTOR')) {
      expect(readLatestTaskCheckpoint(restarted, jobId, attempt.nodeId)).toBeDefined();
    }
  }, 240_000);
});
