import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { EXECUTION_SPEC, setupExecutionFixture, setupExecutionFixtureV2 } from '../helpers-execution.js';
import { startFakeOllama } from '../helpers-fake-ollama.js';

/**
 * End-to-end CLI tests for the v0.6 runner platform: profiles, matrix,
 * doctor, models, conformance, config doctor/migrate, runner plans, and
 * capability rejections. Fully offline via fake providers.
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
    now: () => new Date(Date.parse('2026-07-13T12:00:00.000Z') + 1000 * tick++),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

afterEach(() => {
  delete process.env['FAKE_CODEX_SCENARIO'];
});

describe('runner matrix and list', () => {
  it('runner matrix is generated from registered metadata', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'runner', 'matrix');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Runner Capability Matrix');
    expect(result.stdout).toContain('claude-code');
    expect(result.stdout).toContain('codex-default');
    expect(result.stdout).toContain('ollama-local');
    const json = await cli(fixture.root, 'runner', 'matrix', '--json');
    const parsed = JSON.parse(json.stdout) as {
      data: { rows: { profile: string; execute: boolean; local: boolean }[] };
    };
    const ollama = parsed.data.rows.find((row) => row.profile === 'ollama-local');
    expect(ollama?.execute).toBe(false);
    expect(ollama?.local).toBe(true);
    const codex = parsed.data.rows.find((row) => row.profile === 'codex-default');
    expect(codex?.execute).toBe(true);
    const markdown = await cli(fixture.root, 'runner', 'matrix', '--markdown');
    expect(markdown.stdout).toContain('| Profile | Support | Author | Refine | Execute | Resume | Local |');
  });

  it('runner list --json includes capabilities, operations, and boundaries', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'runner', 'list', '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      data: {
        profiles: {
          profile: string;
          implementation: string;
          category: string;
          enabled: boolean;
          supportedOperations: string[];
          networkBacked: boolean;
        }[];
      };
    };
    const ollama = parsed.data.profiles.find((profile) => profile.profile === 'ollama-local');
    expect(ollama?.implementation).toBe('ollama');
    expect(ollama?.category).toBe('model-api');
    expect(ollama?.enabled).toBe(false);
    expect(ollama?.supportedOperations).not.toContain('task-execution');
    expect(ollama?.networkBacked).toBe(false);
  });
});

describe('runner show and doctor', () => {
  it('runner show prints redacted configuration and operation compatibility', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'runner', 'show', 'ollama-local');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('model-api');
    expect(result.stdout).toContain('task-execution');
    expect(result.stdout).toContain('missing:');
    expect(result.stdout).toContain('authoring only');
  });

  it('runner doctor for a disabled codex profile reports disabled with exit 3', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'runner', 'doctor', 'codex-default');
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('NOT READY');
    expect(result.stdout).toContain('disabled');
  });

  it('runner doctor for the fake codex reports available and never echoes secrets', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'mock' });
    const result = await cli(fixture.root, 'runner', 'doctor', 'codex-default');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Status: available');
    expect(result.stdout).toContain('Machine-readable event output');
    expect(result.stdout).not.toContain('FAKE-CODEX-SECRET');
  });

  it('runner test without --network proposes and sends nothing', async () => {
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'mock' });
    const result = await cli(fixture.root, 'runner', 'test', 'codex-default');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No request was sent');
    expect(result.stdout).toContain('--network');
  });

  it('runner models lists fake ollama models without inference', async () => {
    const server = await startFakeOllama({});
    try {
      const fixture = setupExecutionFixtureV2({
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
      });
      const result = await cli(fixture.root, 'runner', 'models', 'ollama-local');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('qwen-fake:7b');
      expect(result.stdout).toContain('Q4_K_M');
      expect(result.stdout).toContain('nothing is selected automatically');
      expect(server.chatCalls()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('runner models for codex is honestly unsupported', async () => {
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'mock' });
    const result = await cli(fixture.root, 'runner', 'models', 'codex-default', '--json');
    const parsed = JSON.parse(result.stdout) as { data: { supported: boolean } };
    expect(parsed.data.supported).toBe(false);
  });
});

describe('runner conformance CLI', () => {
  it('mock conformance passes fully offline', async () => {
    const fixture = setupExecutionFixture();
    const result = await cli(fixture.root, 'runner', 'conformance', 'mock', '--network');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('production confirmed');
  }, 120_000);

  it('without --network, provider checks are skipped and reported', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'mock' });
    const result = await cli(fixture.root, 'runner', 'conformance', 'codex-default');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('skipped');
    expect(result.stdout).toContain('--network');
  }, 120_000);
});

describe('config doctor and migrate', () => {
  it('config doctor reports a v1 schema with an available migration (read-only)', async () => {
    const fixture = setupExecutionFixture();
    const configPath = path.join(fixture.root, '.specbridge', 'config.json');
    const bytesBefore = readFileSync(configPath, 'utf8');
    const result = await cli(fixture.root, 'config', 'doctor');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Schema: 1.0.0');
    expect(result.stdout).toContain('config migrate --dry-run');
    expect(result.stdout).toContain('no credential values stored');
    expect(readFileSync(configPath, 'utf8')).toBe(bytesBefore);
  });

  it('config migrate --dry-run writes nothing and shows mappings', async () => {
    const fixture = setupExecutionFixture({ useFakeClaude: true, defaultRunner: 'claude-code' });
    const configPath = path.join(fixture.root, '.specbridge', 'config.json');
    const bytesBefore = readFileSync(configPath, 'utf8');
    const result = await cli(fixture.root, 'config', 'migrate', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1.0.0 → 2.0.0');
    expect(result.stdout).toContain('behavior unchanged');
    expect(result.stdout).toContain('DISABLED');
    expect(result.stdout).toContain('nothing was written');
    expect(readFileSync(configPath, 'utf8')).toBe(bytesBefore);
  });

  it('config migrate --apply migrates atomically with a backup; doctor confirms', async () => {
    const fixture = setupExecutionFixture({ useFakeClaude: true, defaultRunner: 'claude-code' });
    const configPath = path.join(fixture.root, '.specbridge', 'config.json');
    const original = readFileSync(configPath, 'utf8');
    const result = await cli(fixture.root, 'config', 'migrate', '--apply');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Migration applied atomically');
    const backupPath = path.join(fixture.root, '.specbridge', 'config.v1.backup.json');
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf8')).toBe(original);
    const migrated = JSON.parse(readFileSync(configPath, 'utf8')) as {
      schemaVersion: string;
      defaultRunner: string;
      runnerProfiles: Record<string, { enabled?: boolean }>;
    };
    expect(migrated.schemaVersion).toBe('2.0.0');
    expect(migrated.defaultRunner).toBe('claude-code');
    expect(migrated.runnerProfiles['codex-default']?.enabled).toBe(false);
    expect(migrated.runnerProfiles['ollama-local']?.enabled).toBe(false);
    const doctor = await cli(fixture.root, 'config', 'doctor');
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('Schema: 2.0.0');
    // The claude runner still works after migration (regression).
    process.env['FAKE_CLAUDE_SCENARIO'] = 'success';
    try {
      const doctorClaude = await cli(fixture.root, 'runner', 'doctor', 'claude-code');
      expect(doctorClaude.code).toBe(0);
    } finally {
      delete process.env['FAKE_CLAUDE_SCENARIO'];
    }
  });
});

describe('spec run capability rejection via CLI', () => {
  it('spec run --runner ollama-local is rejected with capabilities and suggestions', async () => {
    const server = await startFakeOllama({});
    try {
      const fixture = setupExecutionFixtureV2({
        ollamaBaseUrl: server.baseUrl,
        useFakeCodex: true,
        defaultRunner: 'mock',
      });
      const result = await cli(
        fixture.root,
        'spec',
        'run',
        EXECUTION_SPEC,
        '--task',
        '1',
        '--runner',
        'ollama-local',
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Cannot perform task-execution');
      expect(result.stderr).toContain('Required capabilities:');
      expect(result.stderr).toContain('taskExecution');
      expect(result.stderr).toContain('Compatible configured profiles:');
      expect(result.stderr).toContain('codex-default');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe('spec generate with runner plan', () => {
  it('--dry-run shows the ollama runner plan with the data boundary and sends nothing', async () => {
    const server = await startFakeOllama({});
    try {
      const fixture = setupExecutionFixtureV2({
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
        approve: false,
      });
      // Initialize workflow state so generation gates pass.
      const { analyzeSpec, requireSpec } = await import('@specbridge/compat-kiro');
      const { approveStage } = await import('@specbridge/workflow');
      const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
      const approved = approveStage(fixture.workspace, spec, { stage: 'requirements' }, { clock: fixture.clock });
      if (!approved.ok) throw new Error(approved.message);
      const again = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
      approveStage(fixture.workspace, again, { stage: 'requirements', revoke: true }, { clock: fixture.clock });

      const result = await cli(
        fixture.root,
        'spec',
        'generate',
        EXECUTION_SPEC,
        '--stage',
        'requirements',
        '--runner',
        'ollama-local',
        '--dry-run',
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Runner plan');
      expect(result.stdout).toContain('Profile: ollama-local');
      expect(result.stdout).toContain('Category: model-api');
      expect(result.stdout).toContain('Network-backed: no');
      expect(result.stdout).toContain('Model: qwen-fake:7b');
      expect(result.stdout).toContain('○ Task execution');
      expect(result.stdout).toContain('.kiro/steering/product.md');
      // Dry run sent NOTHING — not even a probe.
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
