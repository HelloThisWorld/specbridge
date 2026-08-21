import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJob,
  decideApiSpendApproval,
  driveJob,
  listApiSpendApprovals,
  listTaskAttempts,
  readApiBudgetState,
  readExecutionLedger,
  readJobEvents,
  readLatestTaskCheckpoint,
  readSchedulingDecisions,
  requireJobState,
  resumeJob,
  summarizeApiBudget,
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
  passingCommand,
  setupExecutionFixtureV2,
} from '../helpers-execution.js';
import { fixturePath } from '../helpers.js';

/**
 * vNext.5 API Gap Bridge — driver level, fully offline.
 *
 *   quota telemetry   → a scripted deterministic provider
 *   local reasoning   → the REAL fake llama-server child process
 *   LOCAL / DIRECT    → an injected deterministic inference, applied and
 *                       verified by the REAL evidence pipeline
 *   LOCAL / HARNESS   → the REAL DSH SDK driving the REAL fake DSH runtime
 *   API / HARNESS     → the SAME fake DSH runtime behind a profile that is
 *                       VERIFIED REMOTE and priced by a fake price table
 *   SUBSCRIPTION      → the REAL mock runner through the evidence pipeline
 *   time              → a virtual clock; sleeps advance it
 *
 * No network, no API key, no real provider, no real money, no real pricing.
 *
 * What every scenario is really testing: that adding a lane which can spend
 * money changed WHEN work runs and never WHO decides it is done — and that
 * the overwhelmingly common outcome is still "do not spend".
 */

const FAKE_LLAMA = fixturePath('fake-llama', 'fake-llama-server.mjs');
const START = '2026-08-22T09:00:00.000Z';

const TASKS = {
  /** LOCAL_SAFE + ONE_SHOT. */
  oneShot: '- [ ] 1. Summarize the verification results into a report file\n  - _Requirements: 1.1_',
  /** LOCAL_TRY + AGENTIC. */
  agentic:
    '- [ ] 2. Add the simple settings validation and make the failing tests pass\n  - _Requirements: 1.1_',
  /** STRONG_REQUIRED, LOW complexity (so the PLANNER role stays local). */
  strong: '- [ ] 3. Implement the settings store integration\n  - _Requirements: 1.1_',
  strongTwo: '- [ ] 4. Implement the preferences store integration\n  - _Requirements: 1.1_',
  strongThree: '- [ ] 5. Implement the profile store integration\n  - _Requirements: 1.1_',
} as const;

/** A fake operator price table. Real prices are never shipped or fetched. */
const PRICING = {
  inputCostPerMillion: 1,
  outputCostPerMillion: 4,
  cachedInputCostPerMillion: null,
  currency: 'USD',
  source: 'test-fixture-price-table',
};

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

interface ApiFixture extends ExecutionFixture {
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
  execFileSync('git', ['commit', '-q', '-m', 'test: api gap bridge scenario tasks'], {
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

function apiFixture(options: {
  tasks: string[];
  /** API spend authorization. DISABLED is the product default. */
  spendMode?: 'DISABLED' | 'MANUAL' | 'AUTO_BOUNDED';
  /** Omit to bind the remote profile; pass null to leave the API unbound. */
  apiProfile?: string | null;
  pricing?: Record<string, unknown> | null;
  apiBudget?: Record<string, unknown>;
  apiGap?: Record<string, unknown>;
  localStrategy?: 'DIRECT_ONLY' | 'HARNESS_ONLY' | 'ADAPTIVE';
  scheduler?: Record<string, unknown>;
  startIso?: string;
}): ApiFixture {
  const time = virtualClock(options.startIso ?? START);
  const fixture = setupExecutionFixtureV2({
    useFakeDsh: true,
    verificationCommands: [passingCommand()],
    // A SECOND DSH profile, identical in runtime but attested REMOTE. It is
    // the SAME fake process as the local one — which is exactly the point:
    // economics come from verified configuration, never from the runtime's
    // identity, its name, or its model string.
    extraRunnerProfiles: {
      'dsh-api': {
        runner: 'deepseek-harness',
        enabled: true,
        command: { executable: process.execPath, args: [fixturePath('fake-dsh', 'fake-dsh.mjs')] },
        provider: 'fake-remote-provider',
        model: 'fake-remote-model',
        workspaceBoundary: 'runtime-profile',
        computeLocality: 'loopback-endpoint',
        providerEndpoint: 'https://api.example-provider.test/v1',
        environmentPassthrough: [...FAKE_DSH_PASSTHROUGH, 'EXAMPLE_PROVIDER_API_KEY'],
        timeoutMs: 120_000,
        handshakeTimeoutMs: 30_000,
      },
    },
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
          routing: { classifier: 'disabled' },
          scheduler: {
            localExecution: {
              strategy: options.localStrategy ?? 'ADAPTIVE',
              harnessProfile: 'dsh-local',
              maxHarnessWallTimeMs: 120_000,
            },
            api: {
              spendMode: options.spendMode ?? 'DISABLED',
              harnessProfile:
                options.apiProfile === undefined ? 'dsh-api' : options.apiProfile,
              maxApiWallTimeMs: 120_000,
              pricing: options.pricing === undefined ? PRICING : options.pricing,
              budget: { maxCostPerJobUsd: 10, ...(options.apiBudget ?? {}) },
              gap: options.apiGap ?? {},
            },
            ...(options.scheduler ?? {}),
          },
        },
      },
    },
  });
  installTasks(fixture, options.tasks, time.clock);
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
  fixture: ApiFixture,
  jobId: string,
  extras: { inference?: LocalExecutorInference; onEvent?: (event: DriverEvent) => void } = {},
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

function executors(fixture: ApiFixture, jobId: string) {
  return readExecutionLedger(fixture.workspace, jobId).filter((entry) => entry.role === 'EXECUTOR');
}

function eventTypes(fixture: ApiFixture, jobId: string): string[] {
  return readJobEvents(fixture.workspace, jobId, { limit: 4_000 }).events.map((event) => event.type);
}

function dshSpawns(fixture: ApiFixture): number {
  if (!existsSync(fixture.dshLog)) return 0;
  return readFileSync(fixture.dshLog, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => (JSON.parse(line) as { event: string }).event === 'spawn').length;
}

/** Max is exhausted for `minutes`; the weekly window stays healthy. */
function exhaustFiveHour(fixture: ApiFixture, minutes: number): void {
  fixture.quota.fiveHourRemaining = 0;
  fixture.quota.fiveHourResetAt = new Date(Date.parse(START) + minutes * 60_000).toISOString();
  fixture.quota.weeklyRemaining = 0.8;
  fixture.quota.weeklyResetAt = new Date(Date.parse(START) + 5 * 86_400_000).toISOString();
}

/** The weekly window is spent: prepaid capacity is gone for `hours`. */
function exhaustWeekly(fixture: ApiFixture, hours: number): void {
  fixture.quota.fiveHourRemaining = 0;
  fixture.quota.fiveHourResetAt = new Date(Date.parse(START) + 60 * 60_000).toISOString();
  fixture.quota.weeklyRemaining = 0;
  fixture.quota.weeklyResetAt = new Date(Date.parse(START) + hours * 3_600_000).toISOString();
}

afterEach(() => {
  for (const name of [...FAKE_DSH_PASSTHROUGH]) delete process.env[name];
});

// ---------------------------------------------------------------------------

describe('vNext.5 API lane: the decisions that do not spend', () => {
  it('Test A / Test X: with API unconfigured, behavior is exactly vNext.4 — local work runs, strong work waits, nothing is paid', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = apiFixture({
      tasks: [TASKS.oneShot, TASKS.agentic, TASKS.strong],
      apiProfile: null,
      pricing: null,
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustFiveHour(fixture, 240);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'An upgraded workspace must not start paying.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([
        { path: 'src/verification-report.md', content: '# Verification report\n' },
      ]),
    });

    expect(result.stop.kind).toBe('deferred');
    const ledger = executors(fixture, jobId);
    // Both local modes worked; the strong task waited; nothing was paid.
    expect(new Map(ledger.map((e) => [e.taskId, e.executionMode])).get('1')).toBe('DIRECT_MODEL');
    expect(new Map(ledger.map((e) => [e.taskId, e.executionMode])).get('2')).toBe('HARNESS');
    expect(ledger.every((entry) => entry.lane === 'LOCAL')).toBe(true);
    expect(ledger.filter((entry) => entry.lane === 'API')).toHaveLength(0);
    expect(requireJobState(fixture.workspace, jobId).status).toBe('WAITING_RETRY');
    // No budget file, no reservation, no paid events.
    expect(readApiBudgetState(fixture.workspace, jobId).reservations).toHaveLength(0);
    const types = eventTypes(fixture, jobId);
    expect(types.filter((type) => type.startsWith('api_'))).toHaveLength(0);
  }, 240_000);

  it('Test A: with a bound API profile but DISABLED spend, the task still waits and no paid attempt runs', async () => {
    const fixture = apiFixture({
      tasks: [TASKS.strong],
      spendMode: 'DISABLED',
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'A binding is not an authorization.',
    }).jobId;
    const result = await drive(fixture, jobId);

    expect(result.stop.kind).toBe('deferred');
    expect(executors(fixture, jobId).filter((entry) => entry.lane === 'API')).toHaveLength(0);
    expect(dshSpawns(fixture)).toBe(0);
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    const deferred = decisions.filter((entry) => entry.selectedLane === 'DEFER');
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred.some((entry) => entry.reasonCode === 'API_DISABLED')).toBe(true);
    // The decision explains itself: gap, duration, and why nothing was spent.
    const explained = deferred.find((entry) => entry.apiBridge !== null);
    expect(explained?.apiBridge?.gapReason).toBe('WEEKLY_EXHAUSTED');
    expect(explained?.apiBridge?.spendMode).toBe('DISABLED');
    expect(eventTypes(fixture, jobId)).toContain('api_gap_detected');
  }, 240_000);

  it('Test D: a short five-hour gap defers rather than paying, and local work continues', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = apiFixture({
      tasks: [TASKS.oneShot, TASKS.strong],
      spendMode: 'AUTO_BOUNDED',
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustFiveHour(fixture, 10);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Waiting ten minutes beats paying.',
    }).jobId;
    const result = await drive(fixture, jobId, {
      inference: editInference([
        { path: 'src/verification-report.md', content: '# Verification report\n' },
      ]),
    });

    expect(result.stop.kind).toBe('deferred');
    const ledger = executors(fixture, jobId);
    // Test J: local work is not globally stalled by the deferred strong task.
    expect(ledger.some((entry) => entry.lane === 'LOCAL' && entry.status === 'COMPLETED')).toBe(true);
    expect(ledger.filter((entry) => entry.lane === 'API')).toHaveLength(0);
    expect(summarizeApiBudget(
      readApiBudgetState(fixture.workspace, jobId),
      fixture.config.orchestration.jobs.scheduler.api.budget,
    ).encumberedUsd).toBe(0);
    const types = eventTypes(fixture, jobId);
    expect(types).toContain('api_gap_short_deferred');
  }, 240_000);

  it('Test E / Test G: healthy prepaid capacity wins, including the canonical cross-reset case — API never competes', async () => {
    const fixture = apiFixture({ tasks: [TASKS.strong], spendMode: 'AUTO_BOUNDED' });
    // 50% remaining, reset in 20 minutes, ~50-minute task: the vNext.2
    // cross-reset rule admits it to the SUBSCRIPTION lane.
    fixture.quota.fiveHourRemaining = 0.5;
    fixture.quota.fiveHourResetAt = new Date(Date.parse(START) + 20 * 60_000).toISOString();
    fixture.quota.weeklyRemaining = 0.8;

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Prepaid capacity is preferred, and crossing a reset is normal.',
    }).jobId;
    const result = await drive(fixture, jobId);

    expect(result.stop.kind).toBe('completed');
    const ledger = executors(fixture, jobId);
    expect(ledger.every((entry) => entry.lane === 'SUBSCRIPTION')).toBe(true);
    expect(ledger.filter((entry) => entry.lane === 'API')).toHaveLength(0);
    // No gap ever existed, so the planner was never even consulted.
    expect(eventTypes(fixture, jobId).filter((type) => type.startsWith('api_'))).toHaveLength(0);
  }, 240_000);

  it('Test K: with AUTO_BOUNDED but no pricing, cost is unknown and nothing is spent', async () => {
    const fixture = apiFixture({
      tasks: [TASKS.strong],
      spendMode: 'AUTO_BOUNDED',
      pricing: null,
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Unknown cost is not zero cost.',
    }).jobId;
    const result = await drive(fixture, jobId);

    expect(result.stop.kind).toBe('deferred');
    expect(executors(fixture, jobId).filter((entry) => entry.lane === 'API')).toHaveLength(0);
    expect(dshSpawns(fixture)).toBe(0);
    expect(eventTypes(fixture, jobId)).toContain('api_cost_unknown');
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    expect(decisions.some((entry) => entry.reasonCode === 'API_COST_UNKNOWN')).toBe(true);
  }, 240_000);

  it('Test L: a budget too small for the estimate refuses to dispatch', async () => {
    const fixture = apiFixture({
      tasks: [TASKS.strong],
      spendMode: 'AUTO_BOUNDED',
      apiBudget: { maxCostPerJobUsd: 0.0001 },
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Budget is a guardrail, not telemetry.',
    }).jobId;
    const result = await drive(fixture, jobId);

    expect(result.stop.kind).toBe('deferred');
    expect(executors(fixture, jobId).filter((entry) => entry.lane === 'API')).toHaveLength(0);
    expect(dshSpawns(fixture)).toBe(0);
    expect(eventTypes(fixture, jobId)).toContain('api_budget_exceeded');
  }, 240_000);
});

// ---------------------------------------------------------------------------

describe('vNext.5 API lane: bridging a material gap', () => {
  it('Test I: a weekly exhaustion bridges through the harness, with a checkpoint, a reservation, and trusted verification', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = apiFixture({ tasks: [TASKS.strong], spendMode: 'AUTO_BOUNDED' });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'A 36-hour prepaid outage on critical work is what the bridge is for.',
    }).jobId;
    const result = await drive(fixture, jobId);

    expect(result.stop.kind).toBe('completed');
    const paid = executors(fixture, jobId).filter((entry) => entry.lane === 'API');
    expect(paid).toHaveLength(1);
    const attempt = paid[0];
    expect(attempt?.status).toBe('COMPLETED');
    // Lane, execution mode, runner, provider, model, and locality stay
    // ORTHOGONAL — no compound "API_DSH" value exists anywhere.
    expect(attempt?.executionMode).toBe('HARNESS');
    expect(attempt?.provider).toBe('dsh-api');
    expect(attempt?.model).toBe('fake-remote-model');
    expect(attempt?.computeLocality).toBe('REMOTE');
    expect(attempt?.apiSpendMode).toBe('AUTO_BOUNDED');
    expect(attempt?.gapReason).toBe('WEEKLY_EXHAUSTED');
    expect(attempt?.delaySensitivity).toBe('HIGH');
    expect(attempt?.estimatedGapDurationMs).toBeGreaterThan(24 * 3_600_000);
    // Estimated and observed cost are distinguishable, and neither is faked.
    expect(attempt?.metrics.estimatedCostUsd).toBeGreaterThan(0);
    expect(attempt?.costSource).toBe('ESTIMATED_PRE_DISPATCH');
    expect(attempt?.pricingProfile).toBe('test-fixture-price-table');

    // The paid handoff was preceded by a canonical checkpoint.
    const nodeId = attempt?.nodeId as string;
    const checkpoint = readLatestTaskCheckpoint(fixture.workspace, jobId, nodeId);
    expect(checkpoint).toBeDefined();
    expect(
      listTaskAttempts(fixture.workspace, jobId, { nodeId }).some(
        (entry) => entry.checkpointIds.length > 0,
      ),
    ).toBe(true);

    // Budget was reserved before dispatch and reconciled after.
    const budget = readApiBudgetState(fixture.workspace, jobId);
    expect(budget.reservations).toHaveLength(1);
    expect(budget.reservations[0]?.attemptId).toBe(attempt?.attemptId);
    expect(['COMMITTED', 'UNKNOWN']).toContain(budget.reservations[0]?.state);

    const types = eventTypes(fixture, jobId);
    for (const expected of [
      'api_gap_detected',
      'api_budget_reserved',
      'api_task_dispatched',
      'api_budget_reconciled',
    ]) {
      expect(types).toContain(expected);
    }
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    const bridged = decisions.find((entry) => entry.selectedLane === 'API');
    expect(bridged?.reasonCode).toBe('API_WEEKLY_GAP_BRIDGE');
    expect(bridged?.apiBridge?.criticalPath).toBe(true);
    expect(bridged?.apiBridge?.computeLocality).toBe('REMOTE');
  }, 240_000);

  it('Test U: a paid model claiming success does not complete a task that fails trusted verification', async () => {
    // The runtime reports "done" without changing anything the verification
    // command cares about. A more expensive model has no more authority.
    process.env['FAKE_DSH_SCENARIO'] = 'false-claim';
    const fixture = apiFixture({
      tasks: [TASKS.strong],
      spendMode: 'AUTO_BOUNDED',
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Paid completion is still only a claim.',
    }).jobId;
    await drive(fixture, jobId);

    const paid = executors(fixture, jobId).filter((entry) => entry.lane === 'API');
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((entry) => entry.status !== 'COMPLETED')).toBe(true);
    const job = requireJobState(fixture.workspace, jobId);
    expect(job.status).not.toBe('COMPLETED');
    // And the money it did spend is still accounted for.
    expect(readApiBudgetState(fixture.workspace, jobId).reservations.length).toBeGreaterThan(0);
  }, 240_000);

  it('Test R / Test S / Test O: a crashed paid runtime preserves the attempt, the checkpoint, and a conservatively charged budget', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'crash-mid-run';
    const fixture = apiFixture({
      tasks: [TASKS.strong],
      spendMode: 'AUTO_BOUNDED',
      apiBudget: { maxApiAttemptsPerTask: 1 },
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'A crash must not destroy accounting integrity.',
    }).jobId;
    await drive(fixture, jobId);

    const paid = executors(fixture, jobId).filter((entry) => entry.lane === 'API');
    expect(paid.length).toBeGreaterThan(0);
    // The job survives, the attempt survives, and the reservation is NOT
    // released: remote usage before the crash cannot be ruled out.
    const budget = readApiBudgetState(fixture.workspace, jobId);
    expect(budget.reservations.length).toBeGreaterThan(0);
    expect(budget.reservations.every((entry) => entry.state !== 'RELEASED')).toBe(true);
    const summary = summarizeApiBudget(
      budget,
      fixture.config.orchestration.jobs.scheduler.api.budget,
    );
    expect(summary.encumberedUsd).toBeGreaterThan(0);

    // Restart: everything survives, read fresh from disk.
    resumeJob(fixture.driverDeps, jobId);
    const afterRestart = readApiBudgetState(fixture.workspace, jobId);
    expect(afterRestart.reservations.every((entry) => entry.state !== 'RELEASED')).toBe(true);
    expect(readExecutionLedger(fixture.workspace, jobId).length).toBeGreaterThan(0);
    expect(readSchedulingDecisions(fixture.workspace, jobId).length).toBeGreaterThan(0);
    expect(requireJobState(fixture.workspace, jobId).jobId).toBe(jobId);
  }, 240_000);
});

// ---------------------------------------------------------------------------

describe('vNext.5 manual spend authorization', () => {
  it('Test B / Test V: MANUAL mode requests a bounded approval, spends nothing until it is granted, and a stale approval does not authorize', async () => {
    const fixture = apiFixture({
      tasks: [TASKS.strong],
      spendMode: 'MANUAL',
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Spending is a human decision.',
    }).jobId;
    const first = await drive(fixture, jobId);

    // Nothing was spent, and a bounded request now exists.
    expect(first.stop.kind).toBe('deferred');
    expect(executors(fixture, jobId).filter((entry) => entry.lane === 'API')).toHaveLength(0);
    expect(dshSpawns(fixture)).toBe(0);
    const approvals = listApiSpendApprovals(fixture.workspace, jobId);
    expect(approvals).toHaveLength(1);
    const approval = approvals[0];
    expect(approval?.status).toBe('REQUESTED');
    expect(approval?.maxAuthorizedCostUsd).toBeGreaterThan(0);
    expect(approval?.profileName).toBe('dsh-api');
    // The request explains itself well enough to decide on.
    expect(approval?.rationale).toContain('WEEKLY_EXHAUSTED');
    expect(eventTypes(fixture, jobId)).toContain('api_approval_required');
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    expect(decisions.some((entry) => entry.selectedLane === 'REQUIRE_APPROVAL')).toBe(true);

    // A stale authorization for DIFFERENT work does not authorize this work.
    const fingerprintBefore = approval?.taskFingerprint as string;
    expect(fingerprintBefore).toBeTruthy();

    // Grant it, and the very next pass bridges.
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    decideApiSpendApproval({
      workspace: fixture.workspace,
      jobId,
      approvalId: approval?.approvalId as string,
      decision: 'APPROVED',
      decidedBy: 'operator',
      now: fixture.clock(),
    });
    const second = await drive(fixture, jobId);
    expect(second.stop.kind).toBe('completed');
    const paid = executors(fixture, jobId).filter((entry) => entry.lane === 'API');
    expect(paid).toHaveLength(1);
    expect(paid[0]?.apiApprovalId).toBe(approval?.approvalId);
    // The authorization is single-use.
    expect(listApiSpendApprovals(fixture.workspace, jobId)[0]?.status).toBe('CONSUMED');
  }, 240_000);

  it('a denied request is honored and never re-asked into a spend', async () => {
    const fixture = apiFixture({
      tasks: [TASKS.strong],
      spendMode: 'MANUAL',
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'No means no.',
    }).jobId;
    await drive(fixture, jobId);
    const approval = listApiSpendApprovals(fixture.workspace, jobId)[0];
    decideApiSpendApproval({
      workspace: fixture.workspace,
      jobId,
      approvalId: approval?.approvalId as string,
      decision: 'DENIED',
      decidedBy: 'operator',
      note: 'not worth it',
      now: fixture.clock(),
    });

    const second = await drive(fixture, jobId);
    expect(second.stop.kind).toBe('deferred');
    expect(executors(fixture, jobId).filter((entry) => entry.lane === 'API')).toHaveLength(0);
    expect(dshSpawns(fixture)).toBe(0);
  }, 240_000);
});

// ---------------------------------------------------------------------------

describe('vNext.5 subscription return and stickiness', () => {
  it('Test P / Test Q: prepaid capacity returning mid-attempt does not kill it, and the next strong task goes back to the subscription', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = apiFixture({
      tasks: [TASKS.strong, TASKS.strongTwo],
      spendMode: 'AUTO_BOUNDED',
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'A bridge is a bridge, not a new default lane.',
    }).jobId;

    // Prepaid capacity comes back the moment the paid attempt reports its
    // dispatch — i.e. while it is running.
    let restored = false;
    const result = await drive(fixture, jobId, {
      onEvent: (event) => {
        if (!restored && event.kind === 'note' && event.message.includes('api budget reserved')) {
          restored = true;
          fixture.quota.fiveHourRemaining = 0.9;
          fixture.quota.weeklyRemaining = 0.9;
        }
      },
    });

    expect(restored).toBe(true);
    expect(result.stop.kind).toBe('completed');
    const ledger = executors(fixture, jobId);
    const paid = ledger.filter((entry) => entry.lane === 'API');
    // Test P: the in-flight paid attempt was NOT cancelled for the return.
    expect(paid).toHaveLength(1);
    expect(paid[0]?.taskId).toBe('3');
    expect(paid[0]?.status).toBe('COMPLETED');
    expect(paid[0]?.failureReason).toBeNull();

    // Test Q: the next strong task routed straight back to prepaid capacity.
    const followUp = ledger.filter((entry) => entry.taskId === '4');
    expect(followUp.length).toBeGreaterThan(0);
    expect(followUp.every((entry) => entry.lane === 'SUBSCRIPTION')).toBe(true);
    const types = eventTypes(fixture, jobId);
    expect(types).toContain('api_max_returned');
    expect(types).toContain('api_next_task_returned_to_subscription');
  }, 240_000);
});

// ---------------------------------------------------------------------------

describe('vNext.5 mandatory long-horizon scenario', () => {
  it('runs a whole job through healthy quota, a short gap, a weekly outage, a paid bridge, budget exhaustion, and a restart', async () => {
    // The scenario this phase exists to make possible, start to finish.
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = apiFixture({
      tasks: [TASKS.oneShot, TASKS.agentic, TASKS.strong, TASKS.strongTwo, TASKS.strongThree],
      spendMode: 'AUTO_BOUNDED',
      apiBudget: { maxCostPerJobUsd: 10 },
      // A short quota wait is HELD (slept through on the virtual clock)
      // rather than ending the run, so one driver invocation spans the whole
      // horizon exactly as a real long-running job would.
      scheduler: { maxQuotaHoldMs: 3_600_000 },
    });

    // ---- 4-7. Max healthy: A → LOCAL/DIRECT, B → LOCAL/HARNESS, C → SUBSCRIPTION.
    fixture.quota.fiveHourRemaining = 0.9;
    fixture.quota.fiveHourResetAt = new Date(Date.parse(START) + 3 * 3_600_000).toISOString();
    fixture.quota.weeklyRemaining = 0.9;

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Long-horizon continuity across prepaid and paid capacity.',
    }).jobId;
    // Each local dispatch writes a DISTINCT artifact: a byte-identical
    // rewrite would honestly classify as no-change and escalate.
    let localCalls = 0;
    const inference: LocalExecutorInference = () => {
      localCalls += 1;
      return Promise.resolve({
        ok: true,
        text: JSON.stringify({
          decision: 'IMPLEMENTED',
          summary: `Local implementation #${localCalls}.`,
          edits: [
            { path: `docs/local-work-${localCalls}.txt`, content: `local artifact ${localCalls}\n` },
          ],
        }),
        usage: { inputTokens: 700, outputTokens: 300 },
      });
    };

    // The whole horizon is choreographed from driver events inside ONE run,
    // so the scheduler sees capacity change underneath it exactly as it
    // would over a real multi-day job.
    const shortGapSeen: string[] = [];
    const onEvent = (event: DriverEvent): void => {
      // 8-10. After the third task (C, on SUBSCRIPTION) finishes, the
      // five-hour window empties with a 10-minute reset.
      if (event.kind === 'executor-finished' && event.message.startsWith('task 3:')) {
        exhaustFiveHour(fixture, 10);
        fixture.quota.fiveHourResetAt = new Date(
          fixture.clock().getTime() + 10 * 60_000,
        ).toISOString();
      }
      // 11. The short gap must NOT be bridged.
      if (event.kind === 'waiting' && event.message.includes('quota:')) {
        shortGapSeen.push(event.message);
        // 12. Time passes and the five-hour window resets.
        fixture.quota.fiveHourRemaining = 0.85;
        fixture.quota.fiveHourResetAt = new Date(
          fixture.clock().getTime() + 5 * 3_600_000,
        ).toISOString();
      }
      // 14. Once D/E are done on prepaid capacity, the WEEKLY window empties
      // for 36 hours — the gap this whole phase exists to bridge.
      if (event.kind === 'executor-finished' && event.message.startsWith('task 4:')) {
        exhaustWeekly(fixture, 36);
        fixture.quota.weeklyResetAt = new Date(
          fixture.clock().getTime() + 36 * 3_600_000,
        ).toISOString();
      }
    };
    const result = await drive(fixture, jobId, { inference, onEvent });
    expect(result.stop.kind).toBe('completed');

    const finalLedger = executors(fixture, jobId);
    const laneOf = (taskId: string) =>
      finalLedger.filter((entry) => entry.taskId === taskId).map((entry) => entry.lane);
    // 6. A → LOCAL/DIRECT, B → LOCAL/HARNESS, C → SUBSCRIPTION.
    expect(laneOf('1')).toContain('LOCAL');
    expect(laneOf('2')).toContain('LOCAL');
    expect(laneOf('3')).toContain('SUBSCRIPTION');
    const modes = new Map(finalLedger.map((entry) => [entry.taskId, entry.executionMode]));
    expect(modes.get('1')).toBe('DIRECT_MODEL');
    expect(modes.get('2')).toBe('HARNESS');

    // 11. The 10-minute gap was waited out, never bridged.
    expect(shortGapSeen.length).toBeGreaterThan(0);
    expect(eventTypes(fixture, jobId)).toContain('api_gap_short_deferred');
    // 13. E returned to prepaid capacity once the window reset.
    expect(laneOf('4')).toContain('SUBSCRIPTION');

    const paid = finalLedger.filter((entry) => entry.lane === 'API');
    expect(paid).toHaveLength(1);
    expect(paid[0]?.taskId).toBe('5');
    expect(paid[0]?.status).toBe('COMPLETED');
    expect(paid[0]?.computeLocality).toBe('REMOTE');
    expect(paid[0]?.gapReason).toBe('WEEKLY_EXHAUSTED');

    // Every lane is represented exactly where it should be, and LOCAL never
    // silently became paid nor the reverse.
    const lanes = new Set(finalLedger.map((entry) => entry.lane));
    expect(lanes).toEqual(new Set(['LOCAL', 'SUBSCRIPTION', 'API']));
    expect(
      finalLedger
        .filter((entry) => entry.lane === 'LOCAL')
        .every((entry) => entry.computeLocality !== 'REMOTE'),
    ).toBe(true);

    // ---- 25-26. Budget reconciled, cost history recorded.
    const budget = readApiBudgetState(fixture.workspace, jobId);
    expect(budget.reservations).toHaveLength(1);
    const summary = summarizeApiBudget(
      budget,
      fixture.config.orchestration.jobs.scheduler.api.budget,
    );
    expect(summary.attempts).toBe(1);
    expect(summary.encumberedUsd).toBeGreaterThan(0);

    // ---- 39. Everything survives a restart, read fresh from disk.
    resumeJob(fixture.driverDeps, jobId);
    expect(readExecutionLedger(fixture.workspace, jobId).length).toBe(finalLedger.length);
    expect(readApiBudgetState(fixture.workspace, jobId).reservations).toHaveLength(1);
    expect(readSchedulingDecisions(fixture.workspace, jobId).length).toBeGreaterThan(0);
    expect(readLatestTaskCheckpoint(fixture.workspace, jobId, paid[0]?.nodeId as string)).toBeDefined();
    const job = requireJobState(fixture.workspace, jobId);
    expect(job.status).toBe('COMPLETED');

    // ---- 42. No regression: the decision record can answer every question.
    const decisions = readSchedulingDecisions(fixture.workspace, jobId);
    const apiDecision = decisions.find((entry) => entry.selectedLane === 'API');
    expect(apiDecision?.apiBridge?.gapReason).toBe('WEEKLY_EXHAUSTED');
    expect(apiDecision?.apiBridge?.estimatedGapDurationMs).toBeGreaterThan(0);
    expect(apiDecision?.apiBridge?.estimatedCostUsd).toBeGreaterThan(0);
    expect(apiDecision?.apiBridge?.spendMode).toBe('AUTO_BOUNDED');
    expect(apiDecision?.apiBridge?.apiProfile).toBe('dsh-api');
    expect(decisions.some((entry) => entry.selectedLane === 'LOCAL')).toBe(true);
    expect(decisions.some((entry) => entry.selectedLane === 'SUBSCRIPTION')).toBe(true);
  }, 600_000);

  it('Test 33-35: an exhausted API budget refuses further paid work while local work continues', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'agentic-repair';
    const fixture = apiFixture({
      tasks: [TASKS.strong, TASKS.oneShot],
      spendMode: 'AUTO_BOUNDED',
      // One paid attempt for the whole job, then the budget is spent.
      apiBudget: { maxApiAttemptsPerJob: 1 },
      scheduler: { maxQuotaHoldMs: 0 },
    });
    exhaustWeekly(fixture, 36);

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'A spent budget stops paid work without stopping the job.',
    }).jobId;
    await drive(fixture, jobId, {
      inference: editInference([
        { path: 'src/verification-report.md', content: '# Verification report\n' },
      ]),
    });

    const ledger = executors(fixture, jobId);
    expect(ledger.filter((entry) => entry.lane === 'API')).toHaveLength(1);
    // Local work still ran to completion during the paid outage.
    expect(
      ledger.some((entry) => entry.lane === 'LOCAL' && entry.status === 'COMPLETED'),
    ).toBe(true);
    const summary = summarizeApiBudget(
      readApiBudgetState(fixture.workspace, jobId),
      fixture.config.orchestration.jobs.scheduler.api.budget,
    );
    expect(summary.attempts).toBe(1);
  }, 300_000);
});
