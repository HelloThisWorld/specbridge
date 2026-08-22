import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createJob,
  driveJob,
  listEvaluationResults,
  listFailureAssessments,
  listRecoveryDecisions,
  readExecutionLedger,
  readJobEvents,
  readLatestTaskCheckpoint,
  readTaskReliabilityState,
  requireGraphRevision,
  requireJobState,
  resumeJob,
  summarizeExecutionLedger,
} from '@specbridge/orchestration';
import type {
  DriverDeps,
  DriverEvent,
  LocalExecutorInference,
  QuotaTelemetryProvider,
  QuotaWindowSnapshot,
} from '@specbridge/orchestration';
import type { ExecutionFixture } from '../helpers-execution.js';
import { approveAllStages, setupExecutionFixtureV2 } from '../helpers-execution.js';
import { fixturePath } from '../helpers.js';

/**
 * vNext.6 — the mandatory long-horizon reliability scenario, end to end.
 *
 *   quota telemetry   → a scripted deterministic provider
 *   local reasoning   → the REAL fake llama-server child process
 *   LOCAL / DIRECT    → an injected deterministic inference, applied and
 *                       verified by the REAL evidence pipeline
 *   SUBSCRIPTION      → the REAL mock runner through the evidence pipeline
 *   verification      → a REAL scripted process whose pass/fail sequence is
 *                       fixed in advance by a state file outside the workspace
 *   time              → a virtual clock; sleeps advance it
 *
 * The harness lane is deliberately NOT used here. The fake DSH runtime is
 * configured through ambient process environment variables, and on Windows
 * this suite runs on the threads pool — one process, shared `process.env`.
 * A third concurrent writer of `FAKE_DSH_SCENARIO` would make unrelated
 * vNext.4 scenarios flaky, and a reliability suite that introduces
 * nondeterminism into the suite it shares a process with would be a poor
 * advertisement for itself. The harness lane's own reliability behaviour is
 * covered in local-harness-driver.test.ts, which already owns that fixture.
 *
 * No network, no GPU, no credentials, no real model, no real money.
 *
 * What this scenario is really testing is one claim: a long-running job that
 * keeps failing does not keep doing the same thing. Every failure is
 * evaluated, assessed, and answered with a decision that is written down —
 * and when the same experiment would be repeated, it is refused.
 *
 * Steps of the scenario specification that are proved DETERMINISTICALLY at a
 * lower level, and asserted there rather than duplicated here:
 *
 *   contract failure -> REPLAN     reliability-runtime.test.ts (Test C) and
 *                                  reliability-recovery.test.ts
 *   paid retry refusal             reliability-recovery.test.ts (Test M)
 *   API budget veto over recovery  reliability-recovery.test.ts (Test S)
 *   semantic review authority      reliability-evaluation.test.ts (Test B)
 *
 * Keeping them there is deliberate: a driver-level test cannot pin a policy
 * decision as precisely as a pure-function test can, and a scenario that
 * asserted everything twice would fail for reasons unrelated to the claim it
 * exists to make.
 */

const FAKE_LLAMA = fixturePath('fake-llama', 'fake-llama-server.mjs');
const START = '2026-08-22T09:00:00.000Z';

const TASKS = {
  /** LOCAL_SAFE + ONE_SHOT: Task A, which succeeds on the local lane. */
  oneShot: '- [ ] 1. Summarize the verification results into a report file\n  - _Requirements: 1.1_',
  /** STRONG_REQUIRED, LOW complexity: Task B, which runs on the subscription lane. */
  strong: '- [ ] 2. Implement the settings store integration\n  - _Requirements: 1.1_',
} as const;

/**
 * A REAL verification command whose outcome sequence is fixed in advance.
 *
 * State lives in a JSON file OUTSIDE the workspace: a counter inside the
 * repository would be a repository change and would be attributed to the
 * agent by the evidence pipeline.
 */
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
  execFileSync('git', ['commit', '-q', '-m', 'test: long-horizon reliability scenario'], {
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
  scheduler?: Record<string, unknown>;
}): Fixture {
  const time = virtualClock(START);
  const verifyState = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'specbridge-verify-')),
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
          scheduler: {
            // No harness binding: the local lane runs its direct mode, and
            // strong work goes to the subscription runner. Nothing in this
            // file touches the shared fake-DSH environment.
            localExecution: { strategy: 'DIRECT_ONLY' },
            ...(options.scheduler ?? {}),
          },
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

function drive(fixture: Fixture, jobId: string, extras: { inference?: LocalExecutorInference; onEvent?: (event: DriverEvent) => void } = {}) {
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

function eventTypes(fixture: Fixture, jobId: string): string[] {
  return readJobEvents(fixture.workspace, jobId, { limit: 4_000 }).events.map((event) =>
    String(event['type']),
  );
}

function executorEntries(fixture: Fixture, jobId: string) {
  return readExecutionLedger(fixture.workspace, jobId).filter((entry) => entry.role === 'EXECUTOR');
}

// ---------------------------------------------------------------------------

describe('vNext.6 long-horizon reliability scenario', () => {
  it(
    'evaluates every attempt, refuses to repeat a failed experiment, and survives a restart',
    async () => {
      const fixture = fixtureFor({
        tasks: [TASKS.oneShot, TASKS.strong],
        // Task A verifies. Task B then fails its trusted verifier repeatedly,
        // whatever the harness believes about its own work.
        verifyScript: ['pass', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail'],
        jobs: { budgets: { maxTaskAttempts: 4, maxRepairCyclesPerTask: 2, maxNoProgressCycles: 2 } },
      });

      const jobId = createJob(fixture.driverDeps, {
        specName: fixture.specName,
        goal: 'Implement the approved plan across two dependent tasks.',
      }).jobId;

      // ---- Phase 1: Task A on LOCAL / DIRECT_MODEL, verified -------------
      await drive(fixture, jobId, {
        inference: editInference([
          { path: 'src/verification-report.md', content: '# Verification report\n\nAll checks passed.\n' },
        ]),
      });

      const afterFirst = requireJobState(fixture.workspace, jobId);
      const graphA = requireGraphRevision(fixture.workspace, jobId, afterFirst.graphRevision);
      const nodeA = graphA.nodes[0];
      expect(nodeA?.status).toBe('COMPLETED');

      // A completed task carries a durable PASS verdict, not merely a status.
      const passEvaluations = listEvaluationResults(fixture.workspace, jobId, {
        nodeId: nodeA?.nodeId as string,
      });
      expect(passEvaluations.some((entry) => entry.status === 'PASS')).toBe(true);
      expect(eventTypes(fixture, jobId)).toContain('evaluation_passed');

      // ---- Phase 2: Task B fails, repeatedly, and the runtime notices ----
      // The driver stops at each governance boundary (diagnose, replan,
      // block); resuming continues from durable state, exactly as a restarted
      // process would.
      for (let pass = 0; pass < 8; pass += 1) {
        const state = requireJobState(fixture.workspace, jobId);
        if (state.status === 'COMPLETED' || state.status === 'FAILED' || state.status === 'CANCELLED') break;
        if (state.status === 'BLOCKED' || state.status === 'NEEDS_CLARIFICATION') break;
        await drive(fixture, jobId, {
          inference: editInference([
            { path: 'src/verification-report.md', content: '# Verification report\n\nAll checks passed.\n' },
          ]),
        });
      }

      const job = requireJobState(fixture.workspace, jobId);
      const graph = requireGraphRevision(fixture.workspace, jobId, job.graphRevision);
      const nodeB = graph.nodes.find((node) => node.parentTaskId !== nodeA?.parentTaskId);
      expect(nodeB).toBeDefined();
      const nodeBId = nodeB?.nodeId as string;

      // The trusted verifier ran for real, and its failures are what decided
      // the outcome — not the harness's report of its own success.
      expect(verifierCalls(fixture.verifyState)).toBeGreaterThan(1);

      // Task B never completed on a claim.
      expect(nodeB?.status).not.toBe('COMPLETED');

      const evaluations = listEvaluationResults(fixture.workspace, jobId, { nodeId: nodeBId });
      expect(evaluations.length).toBeGreaterThan(0);
      expect(evaluations.every((entry) => entry.status !== 'PASS')).toBe(true);

      // ---- Every failure was assessed BEFORE anything else ran -----------
      const assessments = listFailureAssessments(fixture.workspace, jobId, { nodeId: nodeBId });
      const decisions = listRecoveryDecisions(fixture.workspace, jobId, { nodeId: nodeBId });
      expect(assessments.length).toBeGreaterThan(0);
      expect(decisions.length).toBe(assessments.length);

      // No retry without a reasoned classification: every decision names the
      // fingerprint it responded to and the health it was made under.
      for (const decision of decisions) {
        expect(decision.failureFingerprint).toBeTruthy();
        expect(decision.reasonCode).toBeTruthy();
        expect(decision.reason.length).toBeGreaterThan(0);
      }

      // ---- Repetition was detected and answered with a strategy change ---
      const reliability = readTaskReliabilityState(fixture.workspace, jobId, nodeBId);
      expect(reliability).toBeDefined();
      expect(reliability?.observations.length).toBeGreaterThan(0);
      const events = eventTypes(fixture, jobId);

      const actions = decisions.map((entry) => entry.action);

      // The exact governed sequence. This is the scenario's central claim,
      // and it is pinned rather than sampled:
      //
      //   attempt 1 fails            -> REPAIR      (health DEGRADED)
      //   attempt 2 repeats it       -> REPLAN      (health STALLED)
      //   attempt 3 still repeats it -> REPLAN      (strategy changes again)
      //   budget spent               -> FAIL_TASK   (honest stop)
      //
      // The second decision is the one that matters most: the same diff and
      // the same failure produced a STRATEGY CHANGE, not a third repair.
      expect(actions).toEqual(['REPAIR', 'REPLAN', 'REPLAN', 'FAIL_TASK']);
      expect(decisions.map((entry) => entry.reasonCode)).toEqual([
        'VERIFICATION_FAILED_REPAIRABLE',
        'NO_PROGRESS_REPLAN',
        'NO_PROGRESS_REPLAN',
        'RECOVERY_BUDGET_EXHAUSTED',
      ]);
      expect(decisions.map((entry) => entry.health)).toEqual([
        'DEGRADED',
        'STALLED',
        'STALLED',
        'STALLED',
      ]);
      // Repetition was answered by changing the plan, never by repeating it.
      expect(decisions[1]?.strategyChange).toBe('PLAN');
      expect(reliability?.health).toBe('STALLED');
      expect(reliability?.stagnationEvents).toBeGreaterThan(0);
      expect(events).toContain('execution_stalled');

      // A bare transient retry is never the answer to a deterministic
      // verification failure.
      const bareRetries = decisions.filter(
        (entry) => entry.action === 'RETRY_TRANSIENT' && entry.reasonCode === 'TRANSIENT_WITHIN_BUDGET',
      );
      expect(bareRetries).toHaveLength(0);

      // ---- The timeline explains itself ----------------------------------
      expect(events).toContain('evaluation_failed');
      expect(events).toContain('failure_assessed');
      expect(events).toContain('recovery_decided');

      // ---- The ledger records what the failures cost ---------------------
      const summary = summarizeExecutionLedger(readExecutionLedger(fixture.workspace, jobId));
      expect(summary.reliability.evaluationsFailed).toBeGreaterThan(0);
      expect(summary.reliability.failedAttempts).toBeGreaterThan(0);
      expect(Object.keys(summary.reliability.recoveryActions).length).toBeGreaterThan(0);
      expect(Object.keys(summary.reliability.failureSources)).toContain('IMPLEMENTATION');

      const executor = executorEntries(fixture, jobId);
      const bEntries = executor.filter((entry) => entry.nodeId === nodeBId);
      expect(bEntries.length).toBeGreaterThan(0);
      expect(bEntries.every((entry) => entry.evaluationStatus !== null)).toBe(true);
      expect(bEntries.some((entry) => entry.recoveryAction !== null)).toBe(true);

      // ---- Phase 3: simulate a process crash, then restart ---------------
      // Nothing in memory survives. `resumeJob` reconciles reality from disk.
      const resumed = await resumeJob(fixture.driverDeps, jobId);
      expect(resumed.job.jobId).toBe(jobId);

      // Everything the runtime reasoned with is still there.
      expect(listEvaluationResults(fixture.workspace, jobId, { nodeId: nodeBId }).length).toBe(
        evaluations.length,
      );
      expect(listFailureAssessments(fixture.workspace, jobId, { nodeId: nodeBId }).length).toBe(
        assessments.length,
      );
      const decisionsAfter = listRecoveryDecisions(fixture.workspace, jobId, { nodeId: nodeBId });
      expect(decisionsAfter.map((entry) => entry.decisionId)).toEqual(
        decisions.map((entry) => entry.decisionId),
      );
      expect(decisionsAfter.map((entry) => entry.action)).toEqual(actions);

      // Budget accounting and the failure history survive with them.
      const stateAfter = readTaskReliabilityState(fixture.workspace, jobId, nodeBId);
      expect(stateAfter?.observations.length).toBe(reliability?.observations.length);
      expect(stateAfter?.health).toBe(reliability?.health);

      // The canonical checkpoint — the thing a fresh worker continues from —
      // still carries the pinned contract, immune to any compaction because
      // it is re-read from here rather than remembered.
      const checkpoint = readLatestTaskCheckpoint(fixture.workspace, jobId, nodeA?.nodeId as string);
      expect(checkpoint?.pinned.taskContract).toBeTruthy();
    },
    240_000,
  );

  it(
    'stops honestly when bounded recovery is exhausted, with a durable explanation',
    async () => {
      const fixture = fixtureFor({
        tasks: [TASKS.strong],
        verifyScript: ['fail'],
        // A deliberately tiny recovery budget: the point is the SHAPE of the
        // ending, not how long it takes to get there.
        jobs: {
          budgets: {
            maxTaskAttempts: 2,
            maxRepairCyclesPerTask: 1,
            maxReplansPerTask: 0,
            maxJobReplans: 0,
            maxNoProgressCycles: 2,
          },
        },
      });

      const jobId = createJob(fixture.driverDeps, {
        specName: fixture.specName,
        goal: 'Implement the approved plan.',
      }).jobId;

      for (let pass = 0; pass < 8; pass += 1) {
        const state = requireJobState(fixture.workspace, jobId);
        if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'NEEDS_CLARIFICATION'].includes(state.status)) {
          break;
        }
        await drive(fixture, jobId);
      }

      const job = requireJobState(fixture.workspace, jobId);
      // A bounded, explained stop is the correct outcome — not an endless
      // retry loop, and not a task quietly marked done.
      expect(['BLOCKED', 'FAILED', 'NEEDS_CLARIFICATION']).toContain(job.status);

      const graph = requireGraphRevision(fixture.workspace, jobId, job.graphRevision);
      expect(graph.nodes.every((node) => node.status !== 'COMPLETED')).toBe(true);

      // The explanation is durable: what was tried, why it failed, and what
      // would unblock it.
      const decisions = listRecoveryDecisions(fixture.workspace, jobId);
      expect(decisions.length).toBeGreaterThan(0);
      const last = decisions.at(-1);
      expect(last?.remediation.length ?? 0).toBeGreaterThan(0);
      expect(last?.budgetSnapshot).toBeDefined();

      if (job.blocker !== undefined) {
        expect(job.blocker.remediation.length).toBeGreaterThan(0);
        expect(job.blocker.message.length).toBeGreaterThan(0);
      }

      // Attempts stopped: the bound is real, not advisory.
      const executor = executorEntries(fixture, jobId);
      expect(executor.length).toBeLessThanOrEqual(job.budgets.maxTaskAttempts);
    },
    180_000,
  );
});
