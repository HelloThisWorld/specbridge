import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { askClarification, buildJobGraph, createJob } from '@specbridge/orchestration';
import type { OrchestrationFixture } from '../helpers-orchestration.js';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * `specbridge orchestrate run/jobs/job/…` and `specbridge local-model …` —
 * CLI surface for long-running jobs. Everything here runs in-process,
 * offline, and never invokes a model: `run --dry-run` previews, the rest is
 * read-only inspection or a thin recorded human decision.
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

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function fixtureWithJob(): OrchestrationFixture & { jobId: string } {
  const fixture = setupOrchestrationFixture();
  const job = createJob(
    { workspace: fixture.workspace, config: fixture.config, host: 'test' },
    { specName: fixture.specName, goal: 'Implement the plan.' },
  );
  return { ...fixture, jobId: job.jobId };
}

describe('orchestrate help documents the job surface', () => {
  it('lists run, jobs, job, node-plan, review-plan, answer, cancel-job', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', '--help');
    expect(result.code).toBe(0);
    for (const subcommand of ['run', 'jobs', 'job', 'node-plan', 'review-plan', 'answer', 'cancel-job']) {
      expect(result.stdout).toContain(subcommand);
    }
  });
});

describe('orchestrate run --dry-run', () => {
  it('previews workers, routing, and budgets without creating a job', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', 'run', fixture.specName, '--dry-run', '--json');
    expect(result.code).toBe(0);
    const report = parseJson(result.stdout);
    const data = report['data'] as Record<string, unknown>;
    expect(data['jobsEnabled']).toBe(true);
    const workers = data['workers'] as { workerId: string; repositoryWrite: boolean }[];
    expect(workers.some((worker) => worker.repositoryWrite)).toBe(true);
    expect(data['routing']).toMatchObject({ planner: 'local-first', executor: 'large-agent' });
    // No job was created.
    const listed = await cli(fixture.root, 'orchestrate', 'jobs', '--json');
    expect((parseJson(listed.stdout)['data'] as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it('human-readable dry run names the local model status honestly', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', 'run', fixture.specName, '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('local model: not startable');
    expect(result.stdout).toContain('No job was created');
  });
});

describe('orchestrate jobs / job', () => {
  it('lists jobs with counters and shows one job with its graph', async () => {
    const fixture = fixtureWithJob();
    await buildJobGraph(
      { workspace: fixture.workspace, config: fixture.config, host: 'test' },
      fixture.jobId,
    );

    const listed = await cli(fixture.root, 'orchestrate', 'jobs', '--json');
    expect(listed.code).toBe(0);
    const jobs = (parseJson(listed.stdout)['data'] as { jobs: { jobId: string; status: string }[] }).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobId: fixture.jobId, status: 'READY' });

    const shown = await cli(fixture.root, 'orchestrate', 'job', fixture.jobId, '--json');
    expect(shown.code).toBe(0);
    const data = parseJson(shown.stdout)['data'] as Record<string, unknown>;
    const graph = data['graph'] as { nodes: { taskId: string; status: string }[] };
    expect(graph.nodes.map((node) => node.taskId)).toEqual(['1', '2.1', '2.2', '3']);
    expect(graph.nodes[0]?.status).toBe('READY');

    const text = await cli(fixture.root, 'orchestrate', 'job', fixture.jobId);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Runtime graph');
  });

  it('an unknown job id fails with a stable error, exit 2', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'orchestrate', 'job', 'job-nope');
    expect(result.code).toBe(2);
    // Orchestration refusals surface as stable SBO codes, never stack traces.
    expect(result.stdout).toContain('SBO029');
    expect(result.stdout).toContain('not found');
  });
});

describe('human decisions', () => {
  it('answer records a decision and reports remaining questions', async () => {
    const fixture = fixtureWithJob();
    const deps = { workspace: fixture.workspace, config: fixture.config, host: 'test' };
    await buildJobGraph(deps, fixture.jobId);
    const asked = askClarification(deps, fixture.jobId, [
      { question: 'Which storage backend?', whyItMatters: 'Changes the module layout.' },
    ]);
    const questionId = asked.openQuestions[0]?.id as string;

    const result = await cli(
      fixture.root,
      'orchestrate',
      'answer',
      fixture.jobId,
      questionId,
      'Use',
      'the',
      'file',
      'store.',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 question(s) remain open');
  });

  it('cancel-job finalizes idempotently', async () => {
    const fixture = fixtureWithJob();
    const first = await cli(fixture.root, 'orchestrate', 'cancel-job', fixture.jobId);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('CANCELLED');
    const again = await cli(fixture.root, 'orchestrate', 'cancel-job', fixture.jobId);
    expect(again.code).toBe(0);
  });

  it('review-plan refuses ambiguous flags and missing reviews', async () => {
    const fixture = fixtureWithJob();
    const both = await cli(fixture.root, 'orchestrate', 'review-plan', fixture.jobId, 'n-1', '--approve', '--reject');
    expect(both.code).toBe(2);
    const none = await cli(fixture.root, 'orchestrate', 'review-plan', fixture.jobId, 'n-1');
    expect(none.code).toBe(2);
  });
});

describe('local-model doctor', () => {
  it('reports an unconfigured local model honestly (exit 1, read-only)', async () => {
    const fixture = setupOrchestrationFixture();
    const result = await cli(fixture.root, 'local-model', 'doctor');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('disabled');
    expect(result.stdout).toContain('loopback-only');
    expect(result.stdout).toContain('not startable');
  });

  it('emits a machine-readable report with --json', async () => {
    const fixture = setupOrchestrationFixture({
      extraConfig: {
        localInference: {
          enabled: true,
          executable: process.execPath,
          model: process.execPath,
        },
      },
    });
    const result = await cli(fixture.root, 'local-model', 'doctor', '--json');
    expect(result.code).toBe(0);
    const data = parseJson(result.stdout)['data'] as Record<string, unknown>;
    expect(data['startable']).toBe(true);
    expect(data['binding']).toBe('loopback-only');
    expect(data['localOnly']).toBe(true);
  });
});
