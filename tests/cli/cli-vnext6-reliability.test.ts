import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import {
  buildJobGraph,
  beginExecutorDispatch,
  completeExecutorDispatch,
  createJob,
  recordCriticVerdict,
  recordPlan,
  requireGraphRevision,
  beginPlanning,
} from '@specbridge/orchestration';
import type { JobDeps } from '@specbridge/orchestration';
import { approveAllStages, passingCommand, setupExecutionFixtureV2 } from '../helpers-execution.js';
import type { ExecutionFixture } from '../helpers-execution.js';

/**
 * `specbridge orchestrate explain-node` — the vNext.6 diagnostics surface.
 *
 * The questions a user must be able to answer about a stuck task WITHOUT
 * running anything, guessing, or reading a log:
 *
 *   Why is this task not complete?
 *   Which checks failed?
 *   What is its execution health, and what failure keeps repeating?
 *   How much repair/retry/replan budget remains?
 *   Why was the current recovery action selected?
 *   What would unblock it?
 *
 * Read-only, offline, no model, no runtime process.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line) => stderr.push(`${line}\n`),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

/** A job with one node that has already failed once, under governance. */
async function failedTaskFixture(): Promise<ExecutionFixture & { jobId: string; nodeId: string }> {
  const fixture = setupExecutionFixtureV2({
    verificationCommands: [passingCommand()],
    extraTopLevel: {
      orchestration: { jobs: { routing: { classifier: 'disabled' } } },
    },
  });
  const tasksPath = path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md');
  writeFileSync(
    tasksPath,
    '# Implementation Plan\n\n- [ ] 1. Implement the settings store integration\n  - _Requirements: 1.1_\n',
    'utf8',
  );
  approveAllStages(fixture.workspace, fixture.specName, fixture.clock);
  execFileSync('git', ['add', '-A'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-q', '-m', 'test: reliability cli fixture'], {
    cwd: fixture.root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });

  const deps: JobDeps = {
    workspace: fixture.workspace,
    config: fixture.config,
    clock: fixture.clock,
    idFactory: fixture.idFactory,
    host: 'test',
  };
  const jobId = createJob(deps, {
    specName: fixture.specName,
    goal: 'Implement the approved settings plan.',
  }).jobId;
  await buildJobGraph(deps, jobId);
  const nodeId = requireGraphRevision(fixture.workspace, jobId, 1).nodes[0]?.nodeId as string;

  beginPlanning(deps, jobId, nodeId);
  await recordPlan(deps, jobId, {
    context: { nodeId, role: 'PLANNER', workerId: 'local', startedAt: fixture.clock().toISOString() },
    candidate: {
      goal: 'Implement the settings store.',
      steps: [{ description: 'Create the persistence module.' }],
      testStrategy: 'Unit tests.',
      verificationStrategy: 'Trusted verification commands.',
    },
    producedByTier: 'LOCAL_SMALL',
  });
  recordCriticVerdict(deps, jobId, {
    context: { nodeId, role: 'CRITIC', workerId: 'local', startedAt: fixture.clock().toISOString() },
    verdict: 'ACCEPT',
    reasons: ['Ordered and verifiable.'],
  });

  beginExecutorDispatch(deps, jobId, { nodeId, mode: 'implement', workerId: 'claude-code' });
  completeExecutorDispatch(deps, jobId, {
    context: {
      nodeId,
      role: 'EXECUTOR',
      workerId: 'claude-code',
      startedAt: fixture.clock().toISOString(),
      runId: 'run-1',
    },
    mode: 'implement',
    evidenceStatus: 'implemented-unverified',
    changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    reliability: {
      verification: {
        configured: true,
        skipped: false,
        ran: true,
        commands: [
          {
            name: 'unit-tests',
            required: true,
            passed: false,
            timedOut: false,
            detail: 'settings.spec.ts > saves settings — expected true',
          },
        ],
      },
    },
  });

  return { ...fixture, jobId, nodeId };
}

describe('specbridge orchestrate explain-node', () => {
  it('answers why the task is not complete, and what would unblock it', async () => {
    const fixture = await failedTaskFixture();
    const result = await cli(fixture.root, 'orchestrate', 'explain-node', fixture.jobId, fixture.nodeId);

    expect(result.code).toBe(0);
    // Each heading corresponds to one of the questions the surface exists for.
    expect(result.stdout).toContain('Why is it not complete?');
    expect(result.stdout).toContain('Which checks failed?');
    expect(result.stdout).toContain('What did SpecBridge decide, and why?');
    expect(result.stdout).toContain('How much budget remains?');
    expect(result.stdout).toContain('What would unblock it?');

    // The verdict, the failing check, and the chosen action are all named.
    expect(result.stdout).toContain('latest evaluation: FAIL');
    expect(result.stdout).toContain('unit-tests');
    expect(result.stdout).toMatch(/REPAIR|REPLAN|RETRY_TRANSIENT|WAIT_FOR_RESOURCE|BLOCK|FAIL_TASK/);
    expect(result.stdout).toContain('health:');
  });

  it('produces the same content machine-readably', async () => {
    const fixture = await failedTaskFixture();
    const result = await cli(
      fixture.root,
      'orchestrate',
      'explain-node',
      fixture.jobId,
      fixture.nodeId,
      '--json',
    );

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: {
        health: string;
        evaluation: { status: string } | null;
        failedChecks: { level: string; name: string; outcome: string }[];
        assessment: { source: string; category: string } | null;
        recovery: { action: string; reasonCode: string } | null;
        remaining: { attempts: number; repairs: number; replans: number };
        costOfFailure: { failedAttempts: number };
      };
    };

    expect(report.schema).toBe('orchestrate-explain-node');
    expect(report.data.evaluation?.status).toBe('FAIL');
    expect(report.data.failedChecks.some((check) => check.name === 'unit-tests')).toBe(true);
    expect(report.data.assessment?.source).toBe('IMPLEMENTATION');
    expect(report.data.recovery?.action).toBeTruthy();
    expect(report.data.recovery?.reasonCode).toBeTruthy();
    expect(report.data.remaining.repairs).toBeGreaterThanOrEqual(0);
    expect(report.data.costOfFailure.failedAttempts).toBeGreaterThan(0);
    expect(['HEALTHY', 'DEGRADED', 'STALLED', 'OSCILLATING', 'RUNAWAY']).toContain(
      report.data.health,
    );
  });

  it('refuses an unknown node with a usage error rather than an empty report', async () => {
    const fixture = await failedTaskFixture();
    const result = await cli(
      fixture.root,
      'orchestrate',
      'explain-node',
      fixture.jobId,
      'no-such-node',
    );

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('does not exist');
  });
});
