import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentConfigV2Schema,
  applyConfigMigration,
  planConfigMigration,
  readAgentConfig,
  resolveWorkspace,
  validateRunnerBaseUrl,
} from '@specbridge/core';
import { copyFixtureToTemp } from '../helpers.js';

/** v2 configuration schema safety and the explicit v1 → v2 migration. */

const V2_BASE = { schemaVersion: '2.0.0' };

function workspaceWithConfig(config: unknown): ReturnType<typeof resolveWorkspace> {
  const root = copyFixtureToTemp('standard-feature');
  mkdirSync(path.join(root, '.specbridge'), { recursive: true });
  writeFileSync(path.join(root, '.specbridge', 'config.json'), JSON.stringify(config, null, 2));
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('no workspace');
  return workspace;
}

describe('v2 configuration schema safety', () => {
  it('accepts executable plus argv command configuration', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        'codex-default': {
          runner: 'codex-cli',
          command: { executable: 'codex', args: ['--config', 'x=y'] },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects shell-concatenated command strings', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        'codex-default': { runner: 'codex-cli', command: 'codex exec --json' },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('shell command string');
    }
  });

  it('rejects unknown runner implementations', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: { magic: { runner: 'not-a-registered-runner', enabled: true } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts the loopback Ollama URL (the default)', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: { 'ollama-local': { runner: 'ollama' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const profile = result.data.runnerProfiles['ollama-local'];
      expect(profile?.runner === 'ollama' && profile.baseUrl).toBe('http://127.0.0.1:11434');
      expect(profile?.enabled).toBe(false);
    }
  });

  it('rejects credential-bearing URLs', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        o: { runner: 'ollama', baseUrl: 'http://user:secret@127.0.0.1:11434' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects file: and other unsupported URL schemes', () => {
    for (const baseUrl of ['file:///etc/passwd', 'ftp://127.0.0.1/x', 'gopher://x']) {
      const result = agentConfigV2Schema.safeParse({
        ...V2_BASE,
        runnerProfiles: { o: { runner: 'ollama', baseUrl } },
      });
      expect(result.success, baseUrl).toBe(false);
    }
  });

  it('rejects plain-HTTP remote endpoints by default; allows the labeled override', () => {
    const remote = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: { o: { runner: 'ollama', baseUrl: 'http://ollama.internal:11434' } },
    });
    expect(remote.success).toBe(false);
    const overridden = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        o: { runner: 'ollama', baseUrl: 'http://ollama.internal:11434', allowInsecureHttp: true },
      },
    });
    expect(overridden.success).toBe(true);
  });

  it('accepts explicit remote HTTPS endpoints and classifies them network-backed', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: { o: { runner: 'ollama', baseUrl: 'https://ollama.example.com' } },
    });
    expect(result.success).toBe(true);
    const url = validateRunnerBaseUrl('https://ollama.example.com');
    expect(url.ok).toBe(true);
    expect(url.loopback).toBe(false);
  });

  it('loopback classification covers localhost, 127.0.0.0/8, and [::1]', () => {
    for (const baseUrl of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://127.9.9.9:11434', 'http://[::1]:11434']) {
      const url = validateRunnerBaseUrl(baseUrl);
      expect(url.ok, baseUrl).toBe(true);
      expect(url.loopback, baseUrl).toBe(true);
    }
  });

  it('rejects credential-looking configuration keys (no credential storage)', () => {
    const result = agentConfigV2Schema.safeParse({
      ...V2_BASE,
      runnerProfiles: {
        o: { runner: 'ollama', apiKey: 'sk-super-secret' },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('credential');
    }
  });

  it('rejects unrestricted Codex sandbox modes wherever they hide', () => {
    for (const config of [
      { ...V2_BASE, runnerProfiles: { c: { runner: 'codex-cli', sandbox: 'danger-full-access' } } },
      { ...V2_BASE, notes: { args: ['--dangerously-bypass-approvals-and-sandbox'] } },
      { ...V2_BASE, notes: '--yolo' },
      { ...V2_BASE, runnerProfiles: { c: { runner: 'codex-cli', command: { executable: 'codex', args: ['--skip-git-repo-check'] } } } },
    ]) {
      expect(agentConfigV2Schema.safeParse(config).success, JSON.stringify(config)).toBe(false);
    }
  });

  it('automatic fallback defaults to disabled and fallback chains default empty', () => {
    const result = agentConfigV2Schema.parse({ ...V2_BASE });
    expect(result.runnerPolicy.allowAutomaticFallback).toBe(false);
    expect(result.fallbacks.stageGeneration).toEqual([]);
    expect(result.fallbacks.stageRefinement).toEqual([]);
  });
});

describe('version-transparent reading (v1 stays fully supported)', () => {
  it('a v1 configuration remains readable before explicit migration', () => {
    const workspace = workspaceWithConfig({
      schemaVersion: '1.0.0',
      defaultRunner: 'claude-code',
      runners: {
        'claude-code': { command: '/usr/local/bin/claude', maxTurns: 12, permissionMode: 'plan' },
        mock: { scenario: 'blocked' },
      },
      verification: { commands: [{ name: 'test', argv: ['pnpm', 'test'] }] },
    });
    const read = readAgentConfig(workspace as never);
    expect(read.config).toBeDefined();
    expect(read.needsMigration).toBe(true);
    expect(read.sourceSchemaVersion).toBe('1.0.0');
    const claude = read.config?.runnerProfiles['claude-code'];
    expect(claude?.runner).toBe('claude-code');
    expect(claude?.runner === 'claude-code' && claude.command).toBe('/usr/local/bin/claude');
    expect(claude?.runner === 'claude-code' && claude.maxTurns).toBe(12);
    // New profiles exist but stay DISABLED — nothing is silently enabled.
    expect(read.config?.runnerProfiles['codex-default']?.enabled).toBe(false);
    expect(read.config?.runnerProfiles['ollama-local']?.enabled).toBe(false);
    expect(read.config?.verification.commands[0]?.argv).toEqual(['pnpm', 'test']);
  });

  it('a v2 configuration reads without migration', () => {
    const workspace = workspaceWithConfig({
      schemaVersion: '2.0.0',
      defaultRunner: 'mock',
      runnerProfiles: { mock: { runner: 'mock' } },
    });
    const read = readAgentConfig(workspace as never);
    expect(read.config).toBeDefined();
    expect(read.needsMigration).toBe(false);
    expect(read.config?.defaultRunner).toBe('mock');
  });

  it('unknown profile references fail closed', () => {
    const workspace = workspaceWithConfig({
      schemaVersion: '2.0.0',
      defaultRunner: 'does-not-exist',
    });
    const read = readAgentConfig(workspace as never);
    expect(read.config).toBeUndefined();
    expect(read.diagnostics[0]?.message).toContain('does-not-exist');
  });
});

describe('explicit configuration migration', () => {
  const V1_CONFIG = {
    schemaVersion: '1.0.0',
    defaultRunner: 'claude-code',
    runners: {
      'claude-code': { command: 'claude', maxTurns: 25, model: 'claude-sonnet-5' },
      mock: { scenario: 'success' },
      codex: { command: 'my-codex' },
    },
    verification: { commands: [{ name: 'test', argv: ['pnpm', 'test'], timeoutMs: 60_000, required: true }] },
    execution: { requireCleanWorkingTree: false },
    customField: { keep: 'me' },
  };

  it('dry-run planning writes nothing and preserves Claude behavior', () => {
    const workspace = workspaceWithConfig(V1_CONFIG);
    const configPath = path.join(workspace!.sidecarDir, 'config.json');
    const bytesBefore = readFileSync(configPath, 'utf8');
    const planned = planConfigMigration(JSON.parse(bytesBefore));
    expect(planned.kind).toBe('plan');
    if (planned.kind !== 'plan') return;
    // Nothing was written by planning.
    expect(readFileSync(configPath, 'utf8')).toBe(bytesBefore);
    expect(planned.plan.fromVersion).toBe('1.0.0');
    expect(planned.plan.toVersion).toBe('2.0.0');
    const migrated = planned.plan.migrated as {
      defaultRunner: string;
      runnerProfiles: Record<string, Record<string, unknown>>;
      verification: unknown;
      execution: Record<string, unknown>;
      customField: unknown;
    };
    // 19: Claude default preserved. 20/21: codex/ollama disabled.
    expect(migrated.defaultRunner).toBe('claude-code');
    expect(migrated.runnerProfiles['claude-code']?.['maxTurns']).toBe(25);
    expect(migrated.runnerProfiles['claude-code']?.['model']).toBe('claude-sonnet-5');
    expect(migrated.runnerProfiles['codex-default']?.['enabled']).toBe(false);
    expect(migrated.runnerProfiles['codex-default']?.['command']).toEqual({
      executable: 'my-codex',
      args: [],
    });
    expect(migrated.runnerProfiles['ollama-local']?.['enabled']).toBe(false);
    // 23: trusted verification preserved; execution preserved; unknown kept.
    expect(migrated.verification).toEqual(V1_CONFIG.verification);
    expect(migrated.execution['requireCleanWorkingTree']).toBe(false);
    expect(migrated.customField).toEqual({ keep: 'me' });
    // 22: no credential value anywhere.
    const serialized = JSON.stringify(migrated).toLowerCase();
    for (const needle of ['apikey', 'api_key', 'token', 'secret', 'password', 'credential']) {
      expect(serialized).not.toContain(needle);
    }
  });

  it('applied migration is atomic, creates a recoverable backup, and validates', () => {
    const workspace = workspaceWithConfig(V1_CONFIG);
    const configPath = path.join(workspace!.sidecarDir, 'config.json');
    const original = readFileSync(configPath, 'utf8');
    const planned = planConfigMigration(JSON.parse(original));
    if (planned.kind !== 'plan') throw new Error('expected a plan');
    const applied = applyConfigMigration(workspace!, planned.plan);
    expect(readFileSync(applied.backupPath, 'utf8')).toBe(original);
    const after = readAgentConfig(workspace!);
    expect(after.config).toBeDefined();
    expect(after.needsMigration).toBe(false);
    expect(after.config?.defaultRunner).toBe('claude-code');
    expect(after.config?.runnerProfiles['codex-default']?.enabled).toBe(false);
    expect(after.config?.runnerProfiles['ollama-local']?.enabled).toBe(false);
    expect(after.config?.verification.commands[0]?.argv).toEqual(['pnpm', 'test']);
  });

  it('an invalid file cannot be migrated and stays intact', () => {
    const workspace = workspaceWithConfig({ schemaVersion: '1.0.0', runners: 'nonsense' });
    const configPath = path.join(workspace!.sidecarDir, 'config.json');
    const original = readFileSync(configPath, 'utf8');
    const planned = planConfigMigration(JSON.parse(original));
    expect(planned.kind).toBe('invalid');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('an already-v2 file reports already-current', () => {
    const planned = planConfigMigration({ schemaVersion: '2.0.0' });
    expect(planned.kind).toBe('already-current');
  });
});
