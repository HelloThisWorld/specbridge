import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import {
  buildJobGraph,
  createJob,
  listApiSpendApprovals,
  requestApiSpendApproval,
  taskSpendFingerprint,
} from '@specbridge/orchestration';
import { approveAllStages, passingCommand, setupExecutionFixtureV2 } from '../helpers-execution.js';
import type { ExecutionFixture } from '../helpers-execution.js';
import { fixturePath } from '../helpers.js';

/**
 * `specbridge orchestrate scheduler` / `api-approve` / `api-deny` — the
 * vNext.5 diagnostics and the human spend-authorization surface.
 *
 * The questions this surface must answer WITHOUT running anything:
 *
 *   Is the API lane able to spend my money at all?
 *   Which profile would it use, and is that profile really remote?
 *   What has it spent, and what is left?
 *   Why is a task waiting instead of using it?
 *
 * Read-only, offline, no model, no runtime process, no charge.
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

async function apiFixture(
  options: {
    spendMode?: 'DISABLED' | 'MANUAL' | 'AUTO_BOUNDED';
    apiProfile?: string | null;
    pricing?: Record<string, unknown> | null;
    apiProfileOverrides?: Record<string, unknown>;
  } = {},
): Promise<ExecutionFixture & { jobId: string; nodeId: string }> {
  const fixture = setupExecutionFixtureV2({
    useFakeDsh: true,
    verificationCommands: [passingCommand()],
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
        environmentPassthrough: ['EXAMPLE_PROVIDER_API_KEY'],
        ...(options.apiProfileOverrides ?? {}),
      },
    },
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
            api: {
              spendMode: options.spendMode ?? 'AUTO_BOUNDED',
              harnessProfile: options.apiProfile === undefined ? 'dsh-api' : options.apiProfile,
              pricing:
                options.pricing === undefined
                  ? {
                      inputCostPerMillion: 1,
                      outputCostPerMillion: 4,
                      currency: 'USD',
                      source: 'test-fixture-price-table',
                    }
                  : options.pricing,
              budget: { maxCostPerJobUsd: 10 },
            },
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
      '- [ ] 1. Implement the settings store integration',
      '  - _Requirements: 1.1_',
      '',
    ].join('\n'),
    'utf8',
  );
  approveAllStages(fixture.workspace, fixture.specName, fixture.clock);
  execFileSync('git', ['add', '-A'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-q', '-m', 'test: api diagnostics tasks'], {
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
  const jobId = createJob(deps, { specName: fixture.specName, goal: 'API diagnostics.' }).jobId;
  const graph = await buildJobGraph(deps, jobId);
  return { ...fixture, jobId, nodeId: graph.graph.nodes[0]?.nodeId as string };
}

interface SchedulerReport {
  data: {
    api: {
      enabled: boolean;
      spendMode: string;
      pricingConfigured: boolean;
      pricingSource: string | null;
      binding: Record<string, unknown>;
      budget: Record<string, unknown>;
      approvals: { approvalId: string; status: string }[];
      waitReasons: unknown[];
    };
  };
}

describe('orchestrate scheduler reports the API gap bridge', () => {
  it('answers "can this spend my money, on what, and how much is left"', async () => {
    const fixture = await apiFixture();
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId, '--json');
    expect(result.code).toBe(0);
    const api = (JSON.parse(result.stdout) as SchedulerReport).data.api;

    expect(api.enabled).toBe(true);
    expect(api.spendMode).toBe('AUTO_BOUNDED');
    expect(api.binding['status']).toBe('BOUND');
    expect(api.binding['profile']).toBe('dsh-api');
    expect(api.binding['runner']).toBe('deepseek-harness');
    expect(api.binding['provider']).toBe('fake-remote-provider');
    expect(api.binding['model']).toBe('fake-remote-model');
    // Verified REMOTE — the economic identity, derived from configuration
    // and never from the profile name or the model string.
    expect(api.binding['computeLocality']).toBe('REMOTE');
    expect(api.pricingConfigured).toBe(true);
    expect(api.pricingSource).toBe('test-fixture-price-table');
    expect(api.budget['remainingUsd']).toBe(10);
    expect(api.budget['encumberedUsd']).toBe(0);
    // Credential NAMES only; never a value.
    expect(api.binding['credentialSources']).toEqual(['EXAMPLE_PROVIDER_API_KEY']);
  });

  it('shows a configured API lane that is not authorized to spend', async () => {
    const fixture = await apiFixture({ spendMode: 'DISABLED' });
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId, '--json');
    const api = (JSON.parse(result.stdout) as SchedulerReport).data.api;
    expect(api.enabled).toBe(false);
    expect(api.spendMode).toBe('DISABLED');
    expect(api.binding['status']).toBe('BOUND');
  });

  it('shows a verified-LOCAL profile as refused for the paid lane', async () => {
    const fixture = await apiFixture({
      apiProfileOverrides: {
        providerEndpoint: 'http://127.0.0.1:9090/v1',
        environmentPassthrough: [],
      },
    });
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId, '--json');
    const api = (JSON.parse(result.stdout) as SchedulerReport).data.api;
    expect(api.binding['status']).toBe('LOCAL_COMPUTE');
    expect(api.binding['available']).toBe(false);
    expect(api.enabled).toBe(false);
  });

  it('shows a loopback profile carrying paid credentials as unverifiable for EITHER lane', async () => {
    // Structurally loopback, but handed a paid-provider credential name. It
    // is not provably free (the runtime could authenticate outward) and not
    // provably metered either — so it qualifies for neither economy.
    const fixture = await apiFixture({
      apiProfileOverrides: { providerEndpoint: 'http://127.0.0.1:9090/v1' },
    });
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId, '--json');
    const api = (JSON.parse(result.stdout) as SchedulerReport).data.api;
    expect(api.binding['status']).toBe('NOT_VERIFIED_REMOTE');
    expect(api.binding['computeLocality']).toBe('UNKNOWN');
    expect(api.binding['available']).toBe(false);
  });

  it('warns plainly when pricing is unconfigured, because that forbids automatic spend', async () => {
    const fixture = await apiFixture({ pricing: null });
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('NOT CONFIGURED — automatic spend is refused');
  });

  it('reports nothing configured when no API is bound', async () => {
    const fixture = await apiFixture({ apiProfile: null, spendMode: 'DISABLED' });
    const result = await cli(fixture.root, 'orchestrate', 'scheduler', fixture.jobId, '--json');
    const api = (JSON.parse(result.stdout) as SchedulerReport).data.api;
    expect(api.binding['status']).toBe('NOT_CONFIGURED');
    expect(api.enabled).toBe(false);
  });
});

describe('orchestrate api-approve / api-deny', () => {
  async function withPendingApproval() {
    const fixture = await apiFixture({ spendMode: 'MANUAL' });
    const node = { nodeId: fixture.nodeId, parentTaskId: '1', title: 'Implement the settings store integration', taskFingerprint: 'tf', planRevision: 0, dependsOn: [] };
    const { approval } = requestApiSpendApproval({
      workspace: fixture.workspace,
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: '1',
      taskFingerprint: taskSpendFingerprint(node),
      profileName: 'dsh-api',
      maxAuthorizedCostUsd: 2.5,
      estimatedCostUsd: 1.6,
      rationale: 'Weekly quota exhausted for 36 hours; this task blocks the job.',
      approvalId: 'aa-cli-1',
      now: fixture.clock(),
      ttlMs: 3_600_000,
    });
    return { fixture, approval };
  }

  it('approves a bounded spend and records who decided', async () => {
    const { fixture, approval } = await withPendingApproval();
    const result = await cli(
      fixture.root,
      'orchestrate',
      'api-approve',
      fixture.jobId,
      approval.approvalId,
      '--by',
      'operator',
      '--json',
    );
    expect(result.code).toBe(0);
    const decided = listApiSpendApprovals(fixture.workspace, fixture.jobId)[0];
    expect(decided?.status).toBe('APPROVED');
    expect(decided?.decidedBy).toBe('operator');
    expect(decided?.maxAuthorizedCostUsd).toBe(2.5);
  });

  it('lets a human authorize LESS than was requested, but never more', async () => {
    const { fixture, approval } = await withPendingApproval();
    const lower = await cli(
      fixture.root,
      'orchestrate',
      'api-approve',
      fixture.jobId,
      approval.approvalId,
      '--max-cost',
      '1',
    );
    expect(lower.code).toBe(0);
    expect(listApiSpendApprovals(fixture.workspace, fixture.jobId)[0]?.maxAuthorizedCostUsd).toBe(1);

    const { fixture: second, approval: secondApproval } = await withPendingApproval();
    const higher = await cli(
      second.root,
      'orchestrate',
      'api-approve',
      second.jobId,
      secondApproval.approvalId,
      '--max-cost',
      '99',
    );
    expect(higher.code).not.toBe(0);
    expect(`${higher.stdout}${higher.stderr}`).toContain('never more');
    expect(listApiSpendApprovals(second.workspace, second.jobId)[0]?.status).toBe('REQUESTED');
  });

  it('denies a request without spending anything', async () => {
    const { fixture, approval } = await withPendingApproval();
    const result = await cli(
      fixture.root,
      'orchestrate',
      'api-deny',
      fixture.jobId,
      approval.approvalId,
      '--note',
      'wait for the reset',
    );
    expect(result.code).toBe(0);
    const decided = listApiSpendApprovals(fixture.workspace, fixture.jobId)[0];
    expect(decided?.status).toBe('DENIED');
    expect(decided?.decisionNote).toBe('wait for the reset');
  });

  it('refuses an unknown approval id', async () => {
    const fixture = await apiFixture({ spendMode: 'MANUAL' });
    const result = await cli(fixture.root, 'orchestrate', 'api-approve', fixture.jobId, 'aa-missing');
    expect(result.code).not.toBe(0);
  });
});
