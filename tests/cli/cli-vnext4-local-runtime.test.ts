import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { buildJobGraph, createJob } from '@specbridge/orchestration';
import { approveAllStages, passingCommand, setupExecutionFixtureV2 } from '../helpers-execution.js';
import type { ExecutionFixture } from '../helpers-execution.js';

/**
 * `specbridge orchestrate scheduler` — the vNext.4 diagnostics.
 *
 * The questions this surface must answer without running anything:
 *
 *   Which LOCAL mode would this task use, and why?
 *   Is the configured harness profile actually verified LOCAL?
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

async function schedulerFixture(dshProfileOverrides: Record<string, unknown> = {}): Promise<
  ExecutionFixture & { jobId: string }
> {
  const fixture = setupExecutionFixtureV2({
    useFakeDsh: true,
    dshProfileOverrides,
    verificationCommands: [passingCommand()],
    extraTopLevel: {
      localInference: {
        enabled: true,
        executable: process.execPath,
        executableArgs: ['--version'],
        model: process.execPath,
      },
      orchestration: {
        jobs: {
          routing: { classifier: 'disabled' },
          scheduler: {
            localExecution: { strategy: 'ADAPTIVE', harnessProfile: 'dsh-local' },
          },
        },
      },
    },
  });
  const tasksPath = path.join(fixture.root, '.kiro', 'specs', fixture.specName, 'tasks.md');
  writeFileSync(
    tasksPath,
    [
      '# Implementation Plan',
      '',
      '- [ ] 1. Summarize the verification results into a report file',
      '  - _Requirements: 1.1_',
      '',
      '- [ ] 2. Add the simple settings validation and make the failing tests pass',
      '  - _Requirements: 1.1_',
      '',
    ].join('\n'),
    'utf8',
  );
  approveAllStages(fixture.workspace, fixture.specName, fixture.clock);
  execFileSync('git', ['add', '-A'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-q', '-m', 'test: scheduler diagnostics tasks'], {
    cwd: fixture.root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  const deps = {
    workspace: fixture.workspace,
    config: fixture.config,
    clock: fixture.clock,
    idFactory: fixture.idFactory,
    host: 'test',
  };
  const jobId = createJob(deps, { specName: fixture.specName, goal: 'Diagnostics.' }).jobId;
  await buildJobGraph(deps, jobId);
  return { ...fixture, jobId };
}

describe('orchestrate scheduler reports the local execution plan', () => {
  it('answers "which mode, and why" for every ready task, with the binding verified', async () => {
    const fixture = await schedulerFixture();
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId, '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      data: {
        localExecution: {
          strategy: string;
          directAvailable: boolean;
          binding: Record<string, unknown>;
          readyTaskModes: { taskId: string; shape: string | null; executionMode: string | null; reasonCode: string | null }[];
        };
      };
    };
    const local = report.data.localExecution;
    expect(local.strategy).toBe('ADAPTIVE');
    expect(local.binding['status']).toBe('BOUND');
    expect(local.binding['computeLocality']).toBe('LOCAL');
    expect(local.binding['profile']).toBe('dsh-local');
    expect(local.binding['runner']).toBe('deepseek-harness');
    expect(local.binding['credentialRisks']).toEqual([]);

    const preview = local.readyTaskModes.find((entry) => entry.taskId === '1');
    expect(preview?.shape).toBe('ONE_SHOT');
    expect(preview?.executionMode).toBe('DIRECT_MODEL');
    expect(preview?.reasonCode).toBe('LOCAL_DIRECT_SELECTED');
  });

  it('shows a remote profile as refused for the LOCAL lane', async () => {
    const fixture = await schedulerFixture({
      computeLocality: 'loopback-endpoint',
      providerEndpoint: 'https://api.example-cloud.com/v1',
    });
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId, '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      data: { localExecution: { binding: Record<string, unknown> } };
    };
    expect(report.data.localExecution.binding['status']).toBe('REMOTE_COMPUTE');
    expect(report.data.localExecution.binding['computeLocality']).toBe('REMOTE');
    expect(String(report.data.localExecution.binding['localityEvidence'])).toContain('not a loopback');
  });

  it('prints the binding and the per-task modes in the human report too', async () => {
    const fixture = await schedulerFixture();
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Local execution (vNext.4)');
    expect(result.stdout).toContain('strategy ADAPTIVE');
    expect(result.stdout).toContain('compute LOCAL');
    expect(result.stdout).toMatch(/ONE_SHOT → DIRECT_MODEL/);
  });
});
