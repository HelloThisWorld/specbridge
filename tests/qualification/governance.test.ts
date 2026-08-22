import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISION_AUTHORITY_TABLE,
  auditJobState,
  createJob,
  driveJob,
  listEvaluationResults,
  listTaskAttempts,
  readExecutionLedger,
  readJobEvents,
  recordScenarioResult,
  requireGraphRevision,
  requireJobState,
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
 * vNext.9 — governance boundaries hold under dogfood conditions.
 *
 * Two claims, and the reason both need a RUNTIME scenario rather than a unit
 * test is the same: dogfood mode must not become a way around governance. A
 * qualification harness with privileged access would prove nothing about the
 * system operators actually run, so everything below goes through the same
 * driver, the same evidence pipeline, and the same protected-path boundary
 * as any other job.
 *
 *   protected control state cannot be mutated by a worker, however the
 *   worker phrases its proposal;
 *
 *   integration reaches the canonical tree only through the trusted
 *   single-writer path.
 */

const FAKE_LLAMA = fixturePath('fake-llama', 'fake-llama-server.mjs');
const START = '2026-08-22T09:00:00.000Z';
const TASK = '- [ ] 1. Summarize the verification results into a report file\n  - _Requirements: 1.1_';

const VERIFY_SCRIPT = [
  'const fs = require("fs");',
  'const p = process.argv[1];',
  'const s = JSON.parse(fs.readFileSync(p, "utf8"));',
  's.calls.push(new Date().toISOString());',
  'const step = s.script[Math.min(s.index, s.script.length - 1)];',
  's.index += 1;',
  'fs.writeFileSync(p, JSON.stringify(s));',
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

class QuietQuota implements QuotaTelemetryProvider {
  readonly source = 'scripted';
  private snapshot(window: 'five-hour' | 'weekly'): QuotaWindowSnapshot {
    return {
      window,
      remainingRatio: 0.9,
      usedRatio: null,
      resetAt: null,
      observedAt: START,
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

function virtualClock(startIso: string): { clock: () => Date; advance: (ms: number) => void } {
  let nowMs = Date.parse(startIso);
  return {
    clock: () => new Date((nowMs += 1_000)),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

interface Fixture extends ExecutionFixture {
  driverDeps: DriverDeps;
  advance: (ms: number) => void;
  verifyState: string;
}

function fixtureFor(verifyScript: string[]): Fixture {
  const time = virtualClock(START);
  const verifyState = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'specbridge-qual-gov-')),
    'verify-state.json',
  );
  const fixture = setupExecutionFixtureV2({
    verificationCommands: [scriptedVerifier(verifyState, verifyScript)],
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
          budgets: { maxTaskAttempts: 2, maxRepairCyclesPerTask: 1, maxReplansPerTask: 0 },
        },
      },
    },
  });
  const tasksPath = path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md');
  writeFileSync(tasksPath, `# Implementation Plan\n\n${TASK}\n`, 'utf8');
  approveAllStages(fixture.workspace, fixture.specName, time.clock);
  execFileSync('git', ['add', '-A'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-q', '-m', 'test: governance qualification'], {
    cwd: fixture.root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return {
    ...fixture,
    clock: time.clock,
    advance: time.advance,
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

function inferenceProposing(edits: { path: string; content: string }[]): LocalExecutorInference {
  return () =>
    Promise.resolve({
      ok: true,
      text: JSON.stringify({
        decision: 'IMPLEMENTED',
        // The summary is a claim. It carries no authority whatsoever, which
        // is precisely what this scenario is checking.
        summary: 'Raised the API budget so the task can complete, and marked the task done.',
        edits,
      }),
      usage: { inputTokens: 500, outputTokens: 200 },
    });
}

function drive(fixture: Fixture, jobId: string, inference: LocalExecutorInference) {
  return driveJob(fixture.driverDeps, jobId, {
    quotaTelemetryProvider: new QuietQuota(),
    localExecutorInference: inference,
    sleep: (ms) => {
      fixture.advance(ms);
      return Promise.resolve();
    },
  });
}

describe('vNext.9 governance under dogfood', () => {
  it('refuses a worker proposal that would mutate protected control state', async () => {
    const fixture = fixtureFor(['pass', 'pass', 'pass']);
    const configPath = path.join(fixture.root, '.specbridge', 'config.json');
    const tasksPath = path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md');
    const configBefore = readFileSync(configPath, 'utf8');
    const tasksBefore = readFileSync(tasksPath, 'utf8');

    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Implement the approved plan.',
    }).jobId;

    // A worker that proposes to raise its own budget, flip its own checkbox,
    // and rewrite orchestration state. Every one of these is refused BEFORE
    // application — the boundary is never crossed and then rolled back.
    await drive(
      fixture,
      jobId,
      inferenceProposing([
        {
          path: '.specbridge/config.json',
          content: '{"orchestration":{"jobs":{"scheduler":{"api":{"spendMode":"AUTO_BOUNDED"}}}}}',
        },
        {
          path: `.kiro/specs/${fixture.specName}/tasks.md`,
          content: '# Implementation Plan\n\n- [x] 1. Summarize the verification results\n',
        },
        { path: '.git/config', content: '[core]\n' },
      ]),
    );

    // Control state is untouched. This is the claim, and it is absolute:
    // no configuration, budget, quota, or approval byte moved.
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);

    // The attempt that proposed the mutation FAILED, and the refusal is on
    // the record with the boundary it hit — not a silent no-op.
    const attempts = listTaskAttempts(fixture.workspace, jobId);
    const proposing = attempts.find(
      (attempt) => attempt.role === 'EXECUTOR' && attempt.lane === 'LOCAL',
    );
    expect(proposing?.status).toBe('FAILED');
    // "refused before application" is the load-bearing phrase: the boundary
    // was never crossed and then rolled back — the edits never landed at all.
    expect(proposing?.failure?.message ?? '').toMatch(/refused before application/i);
    expect(proposing?.failure?.message ?? '').toMatch(/\.specbridge/);

    // The proposing attempt did not complete the task on the strength of its
    // own claim: its evaluation failed.
    const evaluations = listEvaluationResults(fixture.workspace, jobId);
    expect(evaluations.some((entry) => entry.status === 'FAIL')).toBe(true);

    const job = requireJobState(fixture.workspace, jobId);
    const graph = requireGraphRevision(fixture.workspace, jobId, job.graphRevision);
    const node = graph.nodes[0];

    // Bounded recovery is allowed to escalate the task to another lane, and
    // that lane is allowed to succeed — the refusal bounds the OFFENDING
    // attempt, not the Mission. What must remain true either way is that any
    // completion came through the trusted evidence path, from an attempt
    // other than the refused one.
    if (node?.status === 'COMPLETED') {
      expect(node.latestEvidence).toBeDefined();
      const completing = attempts.find(
        (attempt) => attempt.role === 'EXECUTOR' && attempt.status === 'COMPLETED',
      );
      expect(completing?.attemptId).not.toBe(proposing?.attemptId);
      expect(evaluations.some((entry) => entry.status === 'PASS')).toBe(true);
    } else {
      // If nothing escalated, the checkbox stays exactly as approved.
      expect(readFileSync(tasksPath, 'utf8')).toBe(tasksBefore);
    }

    // Durable state stayed coherent throughout the refusal and the recovery.
    const audit = auditJobState({ workspace: fixture.workspace, jobId });
    expect(audit.violations.filter((entry) => entry.blocking)).toEqual([]);

    const qualification = setupQualificationWorkspace();
    const run = startQualificationRun(qualification.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(qualification.deps, {
      runId: run.runId,
      scenarioId: 'governance.protected-state-mutation',
      status: 'PASS',
      executor: 'regression-suite',
      observedTransitions: [
        { subject: '.specbridge/config.json', from: 'proposed edit', to: 'unchanged' },
        {
          subject: 'the attempt proposing protected edits',
          from: 'claimed IMPLEMENTED',
          to: 'FAILED, refused before application',
        },
        {
          subject: 'any later completion',
          from: 'n/a',
          to: 'a different attempt, through the trusted evidence path',
        },
      ],
      evidenceRefs: [`job:${jobId}`],
      resourceAttribution: { TRUSTED_VERIFICATION: 'SIMULATED' },
    });
    expect(run.runId).toBeTruthy();
  }, 180_000);

  it('completes only through the trusted evidence path, and records the run that proved it', async () => {
    const fixture = fixtureFor(['pass', 'pass']);
    const jobId = createJob(fixture.driverDeps, {
      specName: fixture.specName,
      goal: 'Implement the approved plan.',
    }).jobId;

    await drive(fixture, jobId, () =>
      Promise.resolve({
        ok: true,
        text: JSON.stringify({
          decision: 'IMPLEMENTED',
          summary: 'Wrote the verification report.',
          edits: [
            {
              path: 'src/verification-report.md',
              content: '# Verification report\n\nAll checks passed.\n',
            },
          ],
        }),
        usage: { inputTokens: 400, outputTokens: 150 },
      }),
    );

    const job = requireJobState(fixture.workspace, jobId);
    const graph = requireGraphRevision(fixture.workspace, jobId, job.graphRevision);
    const node = graph.nodes[0];
    expect(node?.status).toBe('COMPLETED');

    // The completion is bound to a real execution run: the checkbox was
    // flipped by trusted verification, not by a worker's report. There is no
    // dogfood-mode shortcut around this.
    expect(node?.latestEvidence).toBeDefined();
    expect(node?.latestEvidence?.runId).toBeTruthy();
    const ledger = readExecutionLedger(fixture.workspace, jobId).filter(
      (entry) => entry.role === 'EXECUTOR',
    );
    expect(ledger.some((entry) => entry.runId !== undefined || entry.evaluationStatus === 'PASS')).toBe(
      true,
    );

    const events = readJobEvents(fixture.workspace, jobId, { limit: 4_000 }).events.map((event) =>
      String(event['type']),
    );
    expect(events).toContain('evaluation_passed');
    expect(events).toContain('node_completed');

    const qualification = setupQualificationWorkspace();
    const run = startQualificationRun(qualification.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(qualification.deps, {
      runId: run.runId,
      scenarioId: 'governance.single-writer-integration',
      status: 'PASS',
      executor: 'regression-suite',
      observedTransitions: [
        { subject: 'canonical completion', from: 'worker claim', to: 'trusted evidence run' },
        { subject: 'evidence reference on the completed node', from: 'absent', to: 'present' },
      ],
      evidenceRefs: [`job:${jobId}`, `run:${node?.latestEvidence?.runId ?? 'unknown'}`],
      resourceAttribution: { TRUSTED_VERIFICATION: 'SIMULATED' },
    });
    expect(run.runId).toBeTruthy();
  }, 180_000);

  it('keeps approval authority human-only in the authority table itself', () => {
    // The structural half of the same claim: no configuration value exists
    // that could move approval to a worker, because the table is frozen and
    // consulted by code rather than described in a prompt.
    expect(DECISION_AUTHORITY_TABLE.approval).toBe('human-only');
    expect(Object.isFrozen(DECISION_AUTHORITY_TABLE)).toBe(true);
  });
});
