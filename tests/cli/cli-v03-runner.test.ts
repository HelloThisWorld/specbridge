import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import {
  EXECUTION_SPEC,
  failingCommand,
  setupExecutionFixture,
} from '../helpers-execution.js';

/**
 * End-to-end CLI tests for the v0.3 runner, generation, execution,
 * acceptance, and run-inspection commands. Everything runs in-process
 * against temp git fixtures with the offline mock runner (plus the fake
 * Claude CLI for doctor coverage). No model, no network.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tick = 0;
async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line) => stderr.push(`${line}\n`),
    now: () => new Date(Date.parse('2026-07-12T12:00:00.000Z') + 1000 * tick++),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('runner commands', () => {
  it('runner list shows every profile with honest status', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'runner', 'list');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mock');
    // v0.6: real disabled-by-default profiles replaced the v0.3 stubs.
    expect(result.stdout).toContain('codex-default');
    expect(result.stdout).toContain('ollama-local');
    expect(result.stdout).toContain('disabled');
    // v0.6.1: the new providers are registered but DISABLED by default.
    expect(result.stdout).toContain('gemini-default');
    expect(result.stdout).toContain('openai-compatible-local');
    expect(result.stdout).toContain('antigravity');
  });

  it('runner doctor mock reports available with exit 0', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'runner', 'doctor', 'mock');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Status: available');
    expect(result.stdout).toContain('No permission-bypass or unrestricted sandbox mode');
  });

  it('runner doctor claude-code (fake CLI) reports full capabilities', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'success';
    try {
      const fixture = setupExecutionFixture({ useFakeClaude: true });
      const result = await cli(fixture.root, 'runner', 'doctor', 'claude-code');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Authenticated');
      expect(result.stdout).toContain('Non-interactive print mode');
      expect(result.stdout).not.toContain('FAKE-SECRET-VALUE');
    } finally {
      delete process.env['FAKE_CLAUDE_SCENARIO'];
    }
  });

  it('runner doctor exits 3 for an unavailable runner', async () => {
    const fixture = setupExecutionFixture();
    // claude-code without the fake executable configured → not installed or
    // whatever the machine has; force a missing binary via config.
    const configPath = path.join(fixture.root, '.specbridge', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    (config['runners'] as Record<string, unknown>)['claude-code'] = {
      command: 'specbridge-no-such-binary-xyz',
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const result = await cli(fixture.root, 'runner', 'doctor', 'claude-code');
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('NOT READY');
  });

  it('runner show prints the effective configuration', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'runner', 'show', 'mock', '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { data: { configuration: { scenario: string } } };
    expect(parsed.data.configuration.scenario).toBe('success');
  });

  it('an invalid config file fails closed with exit 2', async () => {
    const fixture = setupExecutionFixture();
    writeFileSync(
      path.join(fixture.root, '.specbridge', 'config.json'),
      JSON.stringify({ runners: { 'claude-code': { permissionMode: 'bypassPermissions' } } }),
    );
    const result = await cli(fixture.root, 'runner', 'list');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('bypassPermissions');
  });
});

describe('spec generate / refine via CLI', () => {
  it('generates a draft design with the mock runner and never auto-approves', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    await cli(fixture.root, 'spec', 'approve', EXECUTION_SPEC, '--stage', 'requirements');
    const result = await cli(
      fixture.root,
      'spec',
      'generate',
      EXECUTION_SPEC,
      '--stage',
      'design',
      '--runner',
      'mock',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('design.md written');
    expect(result.stdout).toContain('nothing was auto-approved');

    const status = await cli(fixture.root, 'spec', 'status', EXECUTION_SPEC, '--json');
    expect(status.stdout).toContain('"design"');
    const state = JSON.parse(
      readFileSync(path.join(fixture.root, '.specbridge', 'state', 'specs', `${EXECUTION_SPEC}.json`), 'utf8'),
    ) as { stages: { design: { status: string } } };
    expect(state.stages.design.status).toBe('draft');
  });

  it('refuses to generate over an approved stage with revoke guidance', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'spec', 'generate', EXECUTION_SPEC, '--stage', 'design', '--runner', 'mock');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--revoke');
  });

  it('refine requires an instruction (exit 2)', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'spec', 'refine', EXECUTION_SPEC, '--stage', 'tasks');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--instruction');
  });

  it('refine on a draft stage prints a unified diff', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    await cli(fixture.root, 'spec', 'approve', EXECUTION_SPEC, '--stage', 'requirements');
    await cli(fixture.root, 'spec', 'approve', EXECUTION_SPEC, '--stage', 'design');
    const result = await cli(
      fixture.root,
      'spec',
      'refine',
      EXECUTION_SPEC,
      '--stage',
      'tasks',
      '--runner',
      'mock',
      '--instruction',
      'Add explicit failure behavior.',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('@@');
    expect(result.stdout).toContain('+');
  });

  it('generate --dry-run prints the prompt and touches nothing', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    await cli(fixture.root, 'spec', 'approve', EXECUTION_SPEC, '--stage', 'requirements');
    const before = readFileSync(path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'design.md'), 'utf8');
    const result = await cli(fixture.root, 'spec', 'generate', EXECUTION_SPEC, '--stage', 'design', '--runner', 'mock', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('runner was NOT invoked');
    expect(result.stdout).toContain('SpecBridge control instructions');
    expect(readFileSync(path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'design.md'), 'utf8')).toBe(before);
    expect(existsSync(path.join(fixture.root, '.specbridge', 'runs'))).toBe(false);
  });
});

describe('spec run via CLI', () => {
  it('verified run prints the evidence report and exits 0', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'spec', 'run', EXECUTION_SPEC, '--task', '1', '--runner', 'mock');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Result: VERIFIED');
    expect(result.stdout).toContain('Task checkbox updated');
    const tasks = readFileSync(path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'tasks.md'), 'utf8');
    expect(tasks).toContain('- [x] 1. Implement the settings store');
  });

  it('failed verification prints IMPLEMENTED BUT UNVERIFIED and exits 1', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const result = await cli(fixture.root, 'spec', 'run', EXECUTION_SPEC, '--runner', 'mock');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Result: IMPLEMENTED BUT UNVERIFIED');
    expect(result.stdout).toContain('Task checkbox unchanged');
  });

  it('spec run --json emits a machine-readable report with no ANSI codes', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'spec', 'run', EXECUTION_SPEC, '--json');
    expect(result.code).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\[/);
    const parsed = JSON.parse(result.stdout) as {
      data: { report: { evidenceStatus: string; runId: string } };
    };
    expect(parsed.data.report.evidenceStatus).toBe('verified');
  });

  it('dry-run prints the plan without invoking or writing anything', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'spec', 'run', EXECUTION_SPEC, '--task', '2.1', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Dry run');
    expect(result.stdout).toContain('IMPLEMENT THIS TASK ONLY: 2.1');
    expect(existsSync(path.join(fixture.root, '.specbridge', 'runs'))).toBe(false);
  });

  it('a task id that does not exist exits 2 with known ids', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'spec', 'run', EXECUTION_SPEC, '--task', '42');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('42');
  });

  it('--all stops on the first unverified task with a batch summary', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const result = await cli(fixture.root, 'spec', 'run', EXECUTION_SPEC, '--all');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Batch summary');
    expect(result.stdout).toContain('0/1 attempted task(s) verified');
    expect(result.stdout).toContain('Stopped:');
  });
});

describe('manual acceptance via CLI', () => {
  it('requires a non-empty reason', async () => {
    const fixture = setupExecutionFixture();
    const missing = await cli(fixture.root, 'spec', 'accept-task', EXECUTION_SPEC, '--task', '1');
    expect(missing.code).toBe(2);
    const empty = await cli(fixture.root, 'spec', 'accept-task', EXECUTION_SPEC, '--task', '1', '--reason', '  ');
    expect(empty.code).toBe(2);
  });

  it('records manual acceptance distinctly and updates the checkbox', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(
      fixture.root,
      'spec',
      'accept-task',
      EXECUTION_SPEC,
      '--task',
      '3',
      '--reason',
      'Verified manually in the local development environment.',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('MANUALLY ACCEPTED');
    expect(result.stdout).toContain('No automated verification');
    const tasks = readFileSync(path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'tasks.md'), 'utf8');
    expect(tasks).toContain('- [x] 3. Verify the full workflow end to end');

    // The evidence record is manually-accepted, never verified.
    const evidenceDir = path.join(fixture.root, '.specbridge', 'evidence', EXECUTION_SPEC, '3');
    const files = (await import('node:fs')).readdirSync(evidenceDir);
    const record = JSON.parse(readFileSync(path.join(evidenceDir, files[0] as string), 'utf8')) as {
      status: string;
      manualAcceptance: { actor: string; reason: string };
    };
    expect(record.status).toBe('manually-accepted');
    expect(record.manualAcceptance.actor).toBe('local-user');
  });
});

describe('run inspection via CLI', () => {
  it('run list and run show expose the recorded run', async () => {
    const fixture = setupExecutionFixture();
    await cli(fixture.root, 'spec', 'run', EXECUTION_SPEC, '--task', '1');
    const list = await cli(fixture.root, 'run', 'list');
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('task-execution');
    expect(list.stdout).toContain('verified');

    const listJson = await cli(fixture.root, 'run', 'list', '--json');
    const parsed = JSON.parse(listJson.stdout) as { data: { runs: { runId: string }[] } };
    const runId = parsed.data.runs[0]?.runId as string;

    const show = await cli(fixture.root, 'run', 'show', runId);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('Actual changed files');
    expect(show.stdout).toContain('src/mock-change.txt');
    // Raw prompt only with --verbose.
    expect(show.stdout).not.toContain('SpecBridge control instructions');
    const verbose = await cli(fixture.root, 'run', 'show', runId, '--verbose');
    expect(verbose.stdout).toContain('SpecBridge control instructions');
  });

  it('run resume refuses a verified run with exit 1', async () => {
    const fixture = setupExecutionFixture();
    await cli(fixture.root, 'spec', 'run', EXECUTION_SPEC, '--task', '1');
    const listJson = await cli(fixture.root, 'run', 'list', '--json');
    const parsed = JSON.parse(listJson.stdout) as { data: { runs: { runId: string }[] } };
    const runId = parsed.data.runs[0]?.runId as string;
    const resume = await cli(fixture.root, 'run', 'resume', runId);
    expect(resume.code).toBe(1);
    expect(resume.stderr).toContain('verified');
  });

  it('run show for an unknown run exits 2', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'run', 'show', 'nope');
    expect(result.code).toBe(2);
  });
});
