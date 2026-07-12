import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentConfigSchema, defaultAgentConfig, readAgentConfig, resolveWorkspace } from '@specbridge/core';
import { copyFixtureToTemp } from '../helpers.js';

/** Versioned runner configuration: safety validation and v0.2 compatibility. */

describe('agent configuration schema', () => {
  it('a v0.2 config file upgrades safely with defaults for every new field', () => {
    const result = agentConfigSchema.safeParse({
      defaultRunner: 'mock',
      runners: { 'claude-code': { command: '/usr/local/bin/claude' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.defaultRunner).toBe('mock');
    expect(result.data.runners['claude-code'].command).toBe('/usr/local/bin/claude');
    expect(result.data.runners['claude-code'].permissionMode).toBe('acceptEdits');
    expect(result.data.runners['claude-code'].maxTurns).toBe(30);
    expect(result.data.verification.commands).toEqual([]);
    expect(result.data.execution.requireCleanWorkingTree).toBe(true);
  });

  it('a full valid claude runner configuration parses', () => {
    const result = agentConfigSchema.safeParse({
      schemaVersion: '1.0.0',
      defaultRunner: 'claude-code',
      runners: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          model: 'claude-sonnet-5',
          effort: 'high',
          maxTurns: 20,
          maxBudgetUsd: 5,
          timeoutMs: 900_000,
          permissionMode: 'plan',
          tools: ['Read', 'Grep'],
          allowedBashRules: ['Bash(git status *)'],
        },
      },
      verification: {
        commands: [{ name: 'test', argv: ['pnpm', 'test'], timeoutMs: 600_000, required: true }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid permission mode', () => {
    const result = agentConfigSchema.safeParse({
      runners: { 'claude-code': { permissionMode: 'yolo' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects bypassPermissions no matter where it hides', () => {
    for (const config of [
      { runners: { 'claude-code': { permissionMode: 'bypassPermissions' } } },
      { runners: { 'claude-code': { tools: ['bypassPermissions'] } } },
      { somethingElse: { nested: 'bypassPermissions' } },
    ]) {
      const result = agentConfigSchema.safeParse(config);
      expect(result.success, JSON.stringify(config)).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('bypassPermissions');
      }
    }
  });

  it('rejects dangerously-skip-permissions fragments anywhere', () => {
    const result = agentConfigSchema.safeParse({
      runners: { 'claude-code': { commandArgs: ['--dangerously-skip-permissions'] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain(
        'dangerously-skip-permissions',
      );
    }
  });

  it('validates verification argv arrays', () => {
    const good = agentConfigSchema.safeParse({
      verification: { commands: [{ name: 'test', argv: ['pnpm', 'test'] }] },
    });
    expect(good.success).toBe(true);
    const emptyArgv = agentConfigSchema.safeParse({
      verification: { commands: [{ name: 'test', argv: [] }] },
    });
    expect(emptyArgv.success).toBe(false);
  });

  it('rejects shell-string verification commands', () => {
    const result = agentConfigSchema.safeParse({
      verification: { commands: [{ name: 'test', argv: ['pnpm test'] }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('argv array');
    }
  });

  it('rejects null bytes in commands', () => {
    const result = agentConfigSchema.safeParse({
      verification: { commands: [{ name: 'test', argv: ['pnpm\0test', 'x'] }] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects path traversal in protected paths and mock change file', () => {
    expect(
      agentConfigSchema.safeParse({ execution: { protectedPaths: ['../outside'] } }).success,
    ).toBe(false);
    expect(
      agentConfigSchema.safeParse({ runners: { mock: { changeFile: '../escape.txt' } } }).success,
    ).toBe(false);
  });

  it('defaults never enable anything dangerous', () => {
    const config = defaultAgentConfig();
    expect(config.runners['claude-code'].permissionMode).toBe('acceptEdits');
    expect(JSON.stringify(config)).not.toContain('bypass');
    expect(JSON.stringify(config)).not.toContain('dangerously');
    expect(config.execution.requireCleanWorkingTree).toBe(true);
    expect(config.execution.stopOnUnverifiedTask).toBe(true);
  });
});

describe('readAgentConfig (fail-closed)', () => {
  it('missing file yields safe defaults', () => {
    const root = copyFixtureToTemp('standard-feature');
    const workspace = resolveWorkspace(root);
    if (workspace === undefined) throw new Error('no workspace');
    const result = readAgentConfig(workspace);
    expect(result.exists).toBe(false);
    expect(result.config).toBeDefined();
  });

  it('an invalid config file yields NO config and an error diagnostic', () => {
    const root = copyFixtureToTemp('standard-feature');
    mkdirSync(path.join(root, '.specbridge'), { recursive: true });
    writeFileSync(
      path.join(root, '.specbridge', 'config.json'),
      JSON.stringify({ verification: { commands: [{ name: 't', argv: ['pnpm test'] }] } }),
    );
    const workspace = resolveWorkspace(root);
    if (workspace === undefined) throw new Error('no workspace');
    const result = readAgentConfig(workspace);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics[0]?.severity).toBe('error');
  });
});
