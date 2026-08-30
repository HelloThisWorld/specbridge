import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executionTelemetryReportFile } from '@specbridge/autonomy';
import { createJob } from '@specbridge/orchestration';
import { runCli } from '../../packages/cli/src/cli';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

async function cli(cwd: string, ...argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (value) => stdout.push(value),
    err: (line) => stderr.push(`${line}\n`),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('specbridge report job', () => {
  it('prints versioned JSON without persisting when requested', async () => {
    const fixture = setupOrchestrationFixture();
    const job = createJob(
      { workspace: fixture.workspace, config: fixture.config, host: 'test' },
      { specName: fixture.specName, goal: 'Inspect telemetry.' },
    );
    const reportFile = executionTelemetryReportFile(fixture.workspace, job.jobId);

    const result = await cli(fixture.root, 'report', 'job', job.jobId, '--json', '--no-persist');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1.1.0',
      jobId: job.jobId,
      outcome: { authoritativeJobStatus: 'CREATED' },
      human: { zeroTouchAfterSeal: true },
    });
    expect(existsSync(reportFile)).toBe(false);
  });

  it('renders a concise report and persists the JSON artifact by default', async () => {
    const fixture = setupOrchestrationFixture();
    const job = createJob(
      { workspace: fixture.workspace, config: fixture.config, host: 'test' },
      { specName: fixture.specName, goal: 'Persist telemetry.' },
    );

    const result = await cli(fixture.root, 'report', 'job', job.jobId);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Job ${job.jobId} — WAITING`);
    expect(result.stdout).toContain('StrongBuilderAvoidanceRatio');
    expect(result.stdout).toContain('Report: .specbridge/reports/');
    expect(existsSync(executionTelemetryReportFile(fixture.workspace, job.jobId))).toBe(true);
  });
});
