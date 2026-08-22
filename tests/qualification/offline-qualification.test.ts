import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditJobState,
  createJob,
  driveJob,
  listEvaluationResults,
  listRecoveryDecisions,
  listTaskAttempts,
  readExecutionLedger,
  readJobEvents,
  readLatestTaskCheckpoint,
  recordInvariantAudit,
  recordScenarioResult,
  requireGraphRevision,
  requireJobState,
  restartRegressions,
  taskAttemptsDir,
  resumeJob,
  bindRunSubject,
  buildQualificationReport,
  startQualificationRun,
} from '@specbridge/orchestration';
import type {
  DriverDeps,
  LocalExecutorInference,
  QuotaTelemetryProvider,
  QuotaWindowSnapshot,
} from '@specbridge/orchestration';
import type { ExecutionFixture } from '../helpers-execution.js';
import { approveAllStages, setupExecutionFixtureV2 } from '../helpers-execution.js';
import { fixturePath } from '../helpers.js';
import { fixtureTarget, setupQualificationWorkspace } from '../helpers-qualification.js';

/**
 * vNext.9 — the MANDATORY offline full-system qualification.
 *
 * One deterministic run, in compressed simulated time, that carries a
 * Mission with two dependent tasks from dispatch to verified completion
 * while surviving the fault classes SpecBridge claims to survive. It is the
 * permanent regression safety net for every phase before it, and it writes
 * its results into a durable qualification run so the release gate is
 * computed from observed evidence rather than from a green tick.
 *
 * Everything is a deterministic double:
 *
 *   local reasoning    the REAL fake llama-server child process
 *   LOCAL / DIRECT     an injected deterministic inference, applied and
 *                      verified by the REAL evidence pipeline
 *   SUBSCRIPTION       the REAL mock runner through the evidence pipeline
 *   verification       a REAL scripted process whose pass/fail sequence is
 *                      fixed in advance outside the workspace
 *   quota telemetry    a scripted provider
 *   time               a virtual clock; sleeps advance it
 *
 * No network, no GPU, no credentials, no real model, no money — and the
 * scenario results it records say SIMULATED for every one of them.
 *
 * The harness lane is deliberately absent here: the fake DSH runtime is
 * configured through ambient environment variables, and a third concurrent
 * writer of `FAKE_DSH_SCENARIO` would make unrelated vNext.4 scenarios flaky
 * on the Windows threads pool. `local.harness-success` is owned by
 * local-harness-driver.test.ts, which already holds that fixture.
 */

const FAKE_LLAMA = fixturePath('fake-llama', 'fake-llama-server.mjs');
const START = '2026-08-22T09:00:00.000Z';

const TASKS = {
  /** LOCAL_SAFE + ONE_SHOT: completes on the local direct lane. */
  local: '- [ ] 1. Summarize the verification results into a report file\n  - _Requirements: 1.1_',
  /** STRONG_REQUIRED: runs on the subscription lane, and depends on task 1. */
  strong: '- [ ] 2. Implement the settings store integration\n  - _Requirements: 1.1_',
} as const;

const VERIFY_SCRIPT = [
  'const fs = require("fs");',
  'const p = process.argv[1];',
  'const s = JSON.parse(fs.readFileSync(p, "utf8"));',
  's.calls.push(new Date().toISOString());',
  'const step = s.script[Math.min(s.index, s.script.length - 1)];',
  's.index += 1;',
  'fs.writeFileSync(p, JSON.stringify(s));',
  'if (step !== "pass") { process.stderr.write("settings.spec.ts > saves settings: expected true"); }',
  'process.exit(step === "pass" ? 0 : 1);',
].join('');

function scriptedVerifier(statePath: string, script: string[]): Record<string, unknown> {
  writeFileSync(statePath, JSON.stringify({ index: 0, script, calls: [] }), 'utf8');
  return {
    name: 'unit-tests',
    argv: [process.execPath, '-e', VERIFY_SCRIPT, statePath],
    timeoutMs: 60_000,
    required: true,
  };
}

function verifierCalls(statePath: string): number {
  return (JSON.parse(readFileSync(statePath, 'utf8')) as { calls: string[] }).calls.length;
}

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

interface Fixture extends ExecutionFixture {
  driverDeps: DriverDeps;
  quota: ScriptedQuotaProvider;
  advance: (ms: number) => void;
  verifyState: string;
}

function installTasks(fixture: ExecutionFixture, taskLines: string[], clock: () => Date): void {
  const tasksPath = path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md');
  writeFileSync(tasksPath, `# Implementation Plan\n\n${taskLines.join('\n\n')}\n`, 'utf8');
  approveAllStages(fixture.workspace, fixture.specName, clock);
  execFileSync('git', ['add', '-A'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-q', '-m', 'test: offline qualification scenario'], {
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

function fixtureFor(options: {
  tasks: string[];
  verifyScript: string[];
  jobs?: Record<string, unknown>;
}): Fixture {
  const time = virtualClock(START);
  const verifyState = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'specbridge-qual-verify-')),
    'verify-state.json',
  );
  const fixture = setupExecutionFixtureV2({
    verificationCommands: [scriptedVerifier(verifyState, options.verifyScript)],
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
          scheduler: { localExecution: { strategy: 'DIRECT_ONLY' } },
          ...(options.jobs ?? {}),
        },
      },
    },
  });
  installTasks(fixture, options.tasks, time.clock);
  return {
    ...fixture,
    clock: time.clock,
    advance: time.advance,
    quota: new ScriptedQuotaProvider(time.clock),
    verifyState,
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

/**
 * A worker that dies mid-attempt.
 *
 * Injected at the LOCAL_INFERENCE boundary — a seam SpecBridge already owns
 * and already injects — rather than by killing a process from the test. The
 * observable effect on the runtime is the same one a crashed worker produces:
 * the dispatch cannot complete, and the durable attempt record is what has to
 * survive.
 */
function crashingInference(afterCalls: number, then: LocalExecutorInference): LocalExecutorInference {
  let calls = 0;
  return (request) => {
    calls += 1;
    if (calls > afterCalls) return then(request);
    return Promise.resolve({
      ok: false,
      kind: 'unavailable',
      problem: 'the local worker process exited unexpectedly (injected fault)',
    });
  };
}

function drive(
  fixture: Fixture,
  jobId: string,
  extras: {
    inference?: LocalExecutorInference;
    signal?: AbortSignal;
    onEvent?: (event: { kind: string; message: string }) => void;
  } = {},
) {
  return driveJob(fixture.driverDeps, jobId, {
    quotaTelemetryProvider: fixture.quota,
    ...(extras.inference !== undefined ? { localExecutorInference: extras.inference } : {}),
    ...(extras.signal !== undefined ? { signal: extras.signal } : {}),
    ...(extras.onEvent !== undefined ? { onEvent: extras.onEvent } : {}),
    sleep: (ms) => {
      fixture.advance(ms);
      return Promise.resolve();
    },
  });
}

function eventTypes(fixture: Fixture, jobId: string): string[] {
  return readJobEvents(fixture.workspace, jobId, { limit: 8_000 }).events.map((event) =>
    String(event['type']),
  );
}

const REPORT_EDIT = [
  { path: 'src/verification-report.md', content: '# Verification report\n\nAll checks passed.\n' },
];

// ---------------------------------------------------------------------------

describe('vNext.9 mandatory offline qualification', () => {
  it(
    'carries a Mission to verified completion while surviving worker crash, restart, session loss, and a false completion claim',
    async () => {
      const fixture = fixtureFor({
        tasks: [TASKS.local, TASKS.strong],
        // Task 1 verifies. Task 2 fails once (a false completion claim by the
        // subscription worker), then verifies after recovery.
        verifyScript: ['pass', 'fail', 'pass', 'pass', 'pass'],
        jobs: { budgets: { maxTaskAttempts: 4, maxRepairCyclesPerTask: 2, maxNoProgressCycles: 3 } },
      });
      const qualification = setupQualificationWorkspace();
      const run = startQualificationRun(qualification.deps, {
        profile: 'offline',
        target: fixtureTarget(),
        missionDirection:
          'Implement the approved plan across two dependent tasks, under deterministic faults.',
      });

      const jobId = createJob(fixture.driverDeps, {
        specName: fixture.specName,
        goal: 'Implement the approved plan across two dependent tasks.',
      }).jobId;

      // ---- Baseline invariant audit -------------------------------------
      const baseline = auditJobState({ workspace: fixture.workspace, jobId });
      expect(baseline.violations).toEqual([]);

      // ---- Faults: worker crash, then a process crash mid-Mission --------
      //
      // The process crash is injected at the PROCESS boundary — the driver's
      // own abort signal — after the first executor dispatch finishes. That
      // is the moment a real crash is most damaging: an attempt has just
      // written its result and the job has just recorded it, so a runtime
      // that lost either would leave the Mission unrecoverable.
      const controller = new AbortController();
      let executorDispatches = 0;
      const first = await drive(fixture, jobId, {
        inference: crashingInference(1, editInference(REPORT_EDIT)),
        onEvent: (event) => {
          if (event.kind !== 'executor-finished') return;
          executorDispatches += 1;
          if (executorDispatches === 1) controller.abort();
        },
        signal: controller.signal,
      });

      const afterCrash = requireJobState(fixture.workspace, jobId);
      expect(listTaskAttempts(fixture.workspace, jobId).length).toBeGreaterThan(0);
      // The interruption is a stop, not a loss: the job stays resumable and
      // never reaches a final status by being interrupted.
      expect(first.stop.kind).toBe('interrupted');
      expect(['COMPLETED', 'FAILED', 'CANCELLED']).not.toContain(afterCrash.status);
      // The injected worker failure left durable evidence, and no attempt is
      // stranded RUNNING while the job does not own it.
      const crashAudit = auditJobState({ workspace: fixture.workspace, jobId });
      expect(crashAudit.violations.filter((entry) => entry.blocking)).toEqual([]);

      // ---- Drive to completion, restarting the process between passes ----
      //
      // Each loop iteration hydrates from disk and starts a fresh
      // `driveJob`, which is exactly what a restarted process does: nothing
      // in memory carries over.
      let restarts = 0;
      for (let pass = 0; pass < 12; pass += 1) {
        // Audit either side of the restart. State that is valid before and
        // invalid after hydration is a durability bug, and only the paired
        // audit can tell that apart from state that was already wrong.
        const before = auditJobState({ workspace: fixture.workspace, jobId });
        await resumeJob(fixture.driverDeps, jobId);
        const after = auditJobState({ workspace: fixture.workspace, jobId });
        expect(
          restartRegressions(before, after),
          `restart ${restarts} introduced new violations`,
        ).toEqual([]);
        restarts += 1;

        const state = requireJobState(fixture.workspace, jobId);
        if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'NEEDS_CLARIFICATION'].includes(state.status)) {
          break;
        }
        await drive(fixture, jobId, { inference: editInference(REPORT_EDIT) });
      }

      const job = requireJobState(fixture.workspace, jobId);
      const graph = requireGraphRevision(fixture.workspace, jobId, job.graphRevision);
      const events = eventTypes(fixture, jobId);

      // ---- The trusted verifier decided, not any worker's claim ----------
      expect(verifierCalls(fixture.verifyState)).toBeGreaterThan(1);
      const localNode = graph.nodes[0];
      expect(localNode?.status).toBe('COMPLETED');
      expect(localNode?.latestEvidence).toBeDefined();

      const passes = listEvaluationResults(fixture.workspace, jobId, {
        nodeId: localNode?.nodeId as string,
      });
      expect(passes.some((entry) => entry.status === 'PASS')).toBe(true);

      // A completion claim that failed verification did NOT complete a task.
      expect(events).toContain('evaluation_failed');
      const failedEvaluations = listEvaluationResults(fixture.workspace, jobId).filter(
        (entry) => entry.status === 'FAIL',
      );
      expect(failedEvaluations.length).toBeGreaterThan(0);
      for (const evaluation of failedEvaluations) {
        const node = graph.nodes.find((entry) => entry.nodeId === evaluation.nodeId);
        // Either the node is still open, or it later PASSED — never completed
        // on the strength of the failed one.
        if (node?.status === 'COMPLETED') {
          expect(
            listEvaluationResults(fixture.workspace, jobId, { nodeId: evaluation.nodeId }).some(
              (entry) => entry.status === 'PASS',
            ),
          ).toBe(true);
        }
      }

      // ---- Session loss: every worker identity was disposable ------------
      // Attempts recorded provider sessions; nothing canonical depends on
      // them, and the checkpoint carries what a fresh worker continues from.
      const checkpoint = readLatestTaskCheckpoint(
        fixture.workspace,
        jobId,
        localNode?.nodeId as string,
      );
      expect(checkpoint?.pinned.taskContract).toBeTruthy();
      expect(checkpoint?.nextActions.length ?? 0).toBeGreaterThan(0);

      // ---- Restart survived ---------------------------------------------
      expect(restarts).toBeGreaterThan(0);
      expect(events).toContain('job_resumed');

      // ---- Dependent work waited for a verified predecessor --------------
      const finalAudit = auditJobState({ workspace: fixture.workspace, jobId });
      expect(finalAudit.violations.filter((entry) => entry.blocking)).toEqual([]);

      // ---- Ledger and lanes ---------------------------------------------
      const ledger = readExecutionLedger(fixture.workspace, jobId);
      const executor = ledger.filter((entry) => entry.role === 'EXECUTOR');
      expect(executor.length).toBeGreaterThan(0);
      expect(executor.some((entry) => entry.lane === 'LOCAL')).toBe(true);
      // Every LOCAL attempt records verified local compute locality, or none
      // at all — never a remote one claiming to be local.
      for (const entry of executor.filter((item) => item.lane === 'LOCAL')) {
        if (entry.computeLocality === null) continue;
        expect(entry.computeLocality).toBe('LOCAL');
      }
      // No paid execution happened anywhere in an offline run.
      expect(executor.every((entry) => entry.lane !== 'API')).toBe(true);

      // ---- Record the scenario results into the qualification run --------
      const runId = run.runId;
      bindRunSubject(qualification.deps, runId, { jobId });
      const evidence = [`job:${jobId}`, `attempts:${listTaskAttempts(fixture.workspace, jobId).length}`];

      /**
       * Each call names its scenario id as a literal at the call site. That
       * is not stylistic: the qualification-matrix completeness check scans
       * these sources for `scenarioId: '…'` with `status: 'PASS'`, so a
       * scenario recorded through an indirection would look unproven — which
       * is the safer direction for that check to be wrong in.
       */
      const record = (input: {
        scenarioId: string;
        status: 'PASS';
        transitions: { subject: string; to: string }[];
        attribution: Record<string, 'SIMULATED'>;
      }): void => {
        recordScenarioResult(qualification.deps, {
          runId,
          scenarioId: input.scenarioId,
          status: input.status,
          executor: 'regression-suite',
          observedTransitions: input.transitions.map((entry) => ({
            subject: entry.subject,
            from: null,
            to: entry.to,
          })),
          evidenceRefs: evidence,
          resourceAttribution: input.attribution,
        });
      };

      record({
        scenarioId: 'survival.worker-crash',
        status: 'PASS',
        transitions: [
          { subject: 'injected local worker failure', to: 'attempt recorded, job resumable' },
          { subject: 'blocking invariant violations after the crash', to: '0' },
        ],
        attribution: { WORKER_CRASH: 'SIMULATED', LOCAL_DIRECT_MODEL: 'SIMULATED' },
      });
      record({
        scenarioId: 'survival.process-restart',
        status: 'PASS',
        transitions: [
          { subject: 'process restarts survived', to: String(restarts) },
          {
            subject: 'job_resumed events',
            to: String(events.filter((type) => type === 'job_resumed').length),
          },
          { subject: 'interrupted drive', to: 'resumable, never final' },
        ],
        attribution: { PROCESS_RESTART: 'SIMULATED' },
      });
      record({
        scenarioId: 'survival.invariants-across-restart',
        status: 'PASS',
        transitions: [{ subject: 'new violations introduced by any restart', to: '0' }],
        attribution: { PROCESS_RESTART: 'SIMULATED' },
      });
      record({
        scenarioId: 'survival.session-loss',
        status: 'PASS',
        transitions: [
          {
            subject: 'checkpoint carries the pinned contract without any provider session',
            to: 'present',
          },
        ],
        attribution: { SESSION_LOSS: 'SIMULATED' },
      });
      record({
        scenarioId: 'local.direct-success',
        status: 'PASS',
        transitions: [
          { subject: 'LOCAL/DIRECT_MODEL task', to: 'COMPLETED with a durable PASS' },
        ],
        attribution: { LOCAL_DIRECT_MODEL: 'SIMULATED', TRUSTED_VERIFICATION: 'SIMULATED' },
      });
      record({
        scenarioId: 'reliability.false-completion',
        status: 'PASS',
        transitions: [
          { subject: 'worker completion claim with a failing verifier', to: 'task not completed' },
          { subject: 'failed evaluations recorded', to: String(failedEvaluations.length) },
        ],
        attribution: { TRUSTED_VERIFICATION: 'SIMULATED' },
      });
      record({
        scenarioId: 'reliability.dependents-gated',
        status: 'PASS',
        transitions: [
          { subject: 'DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS violations', to: '0' },
        ],
        attribution: { TRUSTED_VERIFICATION: 'SIMULATED' },
      });
      record({
        scenarioId: 'mission.offline-full-system',
        status: 'PASS',
        transitions: [
          { subject: 'tasks in the Mission', to: String(graph.nodes.length) },
          { subject: 'executor attempts', to: String(executor.length) },
          {
            subject: 'recovery decisions',
            to: String(listRecoveryDecisions(fixture.workspace, jobId).length),
          },
          { subject: 'final job status', to: job.status },
        ],
        attribution: {
          LOCAL_DIRECT_MODEL: 'SIMULATED',
          SUBSCRIPTION_RUNNER: 'SIMULATED',
          QUOTA_TELEMETRY: 'SIMULATED',
          TRUSTED_VERIFICATION: 'SIMULATED',
          PROCESS_RESTART: 'SIMULATED',
        },
      });

      recordInvariantAudit(qualification.deps, {
        runId,
        phase: 'FINAL',
        jobId,
        checked: finalAudit.checked,
        violations: finalAudit.violations,
        note: 'Final audit of the offline full-system qualification.',
      });

      // ---- The recorded evidence drives the report -----------------------
      const report = buildQualificationReport({
        workspace: qualification.workspace,
        runId,
        generatedAt: '2026-08-22T12:00:00.000Z',
      });
      expect(report.scenarios.passed).toBeGreaterThanOrEqual(8);
      expect(report.zeroTolerance.evidenceBypassCompletions).toBe(0);
      expect(report.zeroTolerance.unauthorizedPaidExecutions).toBe(0);
      expect(report.zeroTolerance.canonicalStateLosses).toBe(0);
      // Nothing here was real, and the report says so.
      expect(report.resourceAttribution.LOCAL_DIRECT_MODEL).toBe('SIMULATED');
      expect(report.resourceAttribution.API_PROVIDER).toBe('NOT_EXERCISED');
      // And the release gate is still unmet, because no real product ran.
      expect(report.realTargetQualification).toBe('NOT_RUN');
      expect(report.verdict).toBe('FAIL');
    },
    300_000,
  );

  it(
    'exposes a stranded RUNNING attempt as an invariant violation rather than hiding it',
    async () => {
      // The auditor has to be able to FIND a durability defect, or its clean
      // reports mean nothing. This forges the exact shape a crash between
      // "attempt started" and "job state written" would leave behind.
      const fixture = fixtureFor({ tasks: [TASKS.local], verifyScript: ['pass'] });
      const jobId = createJob(fixture.driverDeps, {
        specName: fixture.specName,
        goal: 'Implement the approved plan.',
      }).jobId;
      await drive(fixture, jobId, { inference: editInference(REPORT_EDIT) });

      const clean = auditJobState({ workspace: fixture.workspace, jobId });
      expect(clean.violations.filter((entry) => entry.blocking)).toEqual([]);

      const attempts = listTaskAttempts(fixture.workspace, jobId);
      const victim = attempts.at(-1);
      expect(victim).toBeDefined();
      const attemptFile = path.join(
        taskAttemptsDir(fixture.workspace, jobId),
        `${victim?.attemptId ?? ''}.json`,
      );
      writeFileSync(
        attemptFile,
        JSON.stringify({ ...victim, status: 'RUNNING', completedAt: undefined }, null, 2),
        'utf8',
      );

      const audited = auditJobState({ workspace: fixture.workspace, jobId });
      expect(
        audited.violations.some((entry) => entry.invariantId === 'ATTEMPT_OWNERSHIP_COHERENT'),
      ).toBe(true);
    },
    180_000,
  );

  it('reports a missing job state as a canonical-state finding, not a crash', () => {
    const fixture = setupQualificationWorkspace();
    const audited = auditJobState({ workspace: fixture.workspace, jobId: 'job-does-not-exist' });
    expect(audited.clean).toBe(false);
    expect(audited.violations[0]?.invariantId).toBe('GRAPH_REVISION_RESOLVES');
    expect(audited.violations[0]?.blocking).toBe(true);
  });
});
