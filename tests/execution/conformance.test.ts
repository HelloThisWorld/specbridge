import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RegisteredRunnerProfile, RunnerConformanceResult } from '@specbridge/runners';
import {
  ClaudeCodeRunner,
  CodexCliRunner,
  MockRunner,
  OllamaRunner,
  runRunnerConformance,
} from '@specbridge/runners';
import type { RunnerProfileConfig } from '@specbridge/core';
import { EXECUTION_CONFORMANCE_GROUPS } from '@specbridge/execution';
import { FAKE_CLAUDE_PATH, FAKE_CODEX_PATH } from '../helpers-execution.js';
import { startFakeOllama } from '../helpers-fake-ollama.js';

/**
 * Conformance suites run against fake providers (real child processes and a
 * real loopback HTTP server) — this is the CI-facing proof behind the
 * production support level of each v0.6.0 runner.
 */

afterEach(() => {
  delete process.env['FAKE_CLAUDE_SCENARIO'];
  delete process.env['FAKE_CODEX_SCENARIO'];
});

function conformanceContext(profile: RegisteredRunnerProfile) {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-conf-'));
  return {
    profile,
    workspaceRoot,
    runDir: path.join(workspaceRoot, '.specbridge-conformance-runs'),
    invocationsAllowed: true,
    timeoutMs: 60_000,
  };
}

function groupsOf(result: RunnerConformanceResult): Record<string, { applicable: boolean; passed: boolean }> {
  return Object.fromEntries(
    result.groups.map((group) => [group.group, { applicable: group.applicable, passed: group.passed }]),
  );
}

describe('runner conformance suites (fake providers, full invocation)', () => {
  it('mock passes every applicable group including task execution and resume', async () => {
    const runner = new MockRunner({ changeFile: 'src/mock-change.txt' });
    const result = await runRunnerConformance(
      conformanceContext({
        name: 'mock',
        config: { runner: 'mock', enabled: true, scenario: 'success', changeFile: 'src/mock-change.txt' } as RunnerProfileConfig,
        runner,
      }),
      EXECUTION_CONFORMANCE_GROUPS,
    );
    expect(result.failedChecks).toBe(0);
    expect(result.productionConfirmed).toBe(true);
    const groups = groupsOf(result);
    expect(groups['task-execution']?.applicable).toBe(true);
    expect(groups['resume']?.applicable).toBe(true);
  }, 120_000);

  it('claude-code (fake CLI) passes every applicable group', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'success';
    const config = {
      runner: 'claude-code',
      enabled: true,
      command: process.execPath,
      commandArgs: [FAKE_CLAUDE_PATH],
      timeoutMs: 60_000,
      maxTurns: 5,
    };
    const runner = new ClaudeCodeRunner(config as never);
    const result = await runRunnerConformance(
      conformanceContext({ name: 'claude-code', config: config as RunnerProfileConfig, runner }),
      EXECUTION_CONFORMANCE_GROUPS,
    );
    expect(result.failedChecks).toBe(0);
    expect(result.productionConfirmed).toBe(true);
    const groups = groupsOf(result);
    expect(groups['detection']?.applicable).toBe(true);
    expect(groups['stage-generation']?.applicable).toBe(true);
    expect(groups['task-execution']?.applicable).toBe(true);
    expect(groups['resume']?.applicable).toBe(true);
  }, 240_000);

  it('codex-cli (fake CLI) passes every applicable group', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const config = {
      runner: 'codex-cli',
      enabled: true,
      command: { executable: process.execPath, args: [FAKE_CODEX_PATH] },
      timeoutMs: 60_000,
    };
    const runner = new CodexCliRunner(config as never);
    const result = await runRunnerConformance(
      conformanceContext({ name: 'codex-default', config: config as RunnerProfileConfig, runner }),
      EXECUTION_CONFORMANCE_GROUPS,
    );
    expect(result.failedChecks).toBe(0);
    expect(result.productionConfirmed).toBe(true);
    const groups = groupsOf(result);
    expect(groups['task-execution']?.applicable).toBe(true);
    expect(groups['resume']?.applicable).toBe(true);
  }, 240_000);

  it('ollama (fake server) passes the applicable AUTHORING groups only', async () => {
    const server = await startFakeOllama({ chatBehaviors: ['valid'] });
    try {
      const config = {
        runner: 'ollama',
        enabled: true,
        baseUrl: server.baseUrl,
        model: 'qwen-fake:7b',
        temperature: 0,
        timeoutMs: 30_000,
        maximumInputCharacters: 500_000,
        maximumOutputBytes: 2_097_152,
        allowInsecureHttp: false,
      };
      const runner = new OllamaRunner(config as never);
      const result = await runRunnerConformance(
        conformanceContext({ name: 'ollama-local', config: config as RunnerProfileConfig, runner }),
        EXECUTION_CONFORMANCE_GROUPS,
      );
      expect(result.failedChecks).toBe(0);
      expect(result.productionConfirmed).toBe(true);
      const groups = groupsOf(result);
      expect(groups['stage-generation']?.applicable).toBe(true);
      expect(groups['stage-refinement']?.applicable).toBe(true);
      // Task execution and resume are NOT applicable to a model-API runner —
      // it can never be marked task-execution capable.
      expect(groups['task-execution']?.applicable).toBe(false);
      expect(groups['resume']?.applicable).toBe(false);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('without invocations, provider checks are skipped and production stays unconfirmed', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const config = {
      runner: 'codex-cli',
      enabled: true,
      command: { executable: process.execPath, args: [FAKE_CODEX_PATH] },
      timeoutMs: 60_000,
    };
    const runner = new CodexCliRunner(config as never);
    const context = conformanceContext({
      name: 'codex-default',
      config: config as RunnerProfileConfig,
      runner,
    });
    const result = await runRunnerConformance(
      { ...context, invocationsAllowed: false },
      EXECUTION_CONFORMANCE_GROUPS,
    );
    expect(result.failedChecks).toBe(0);
    expect(result.skippedChecks).toBeGreaterThan(0);
    expect(result.productionConfirmed).toBe(false);
    // Detection ran (read-only, no model request needed).
    const detection = result.groups.find((group) => group.group === 'detection');
    expect(detection?.passed).toBe(true);
    expect(detection?.skipped).toBe(0);
  }, 120_000);

  it('applicable conformance groups are selected from declared capabilities', async () => {
    const server = await startFakeOllama({});
    try {
      const config = {
        runner: 'ollama',
        enabled: true,
        baseUrl: server.baseUrl,
        model: 'qwen-fake:7b',
        temperature: 0,
        timeoutMs: 30_000,
        maximumInputCharacters: 500_000,
        maximumOutputBytes: 2_097_152,
        allowInsecureHttp: false,
      };
      const runner = new OllamaRunner(config as never);
      const context = conformanceContext({
        name: 'ollama-local',
        config: config as RunnerProfileConfig,
        runner,
      });
      const result = await runRunnerConformance(
        { ...context, invocationsAllowed: false },
        EXECUTION_CONFORMANCE_GROUPS,
      );
      const taskGroup = result.groups.find((group) => group.group === 'task-execution');
      expect(taskGroup?.applicable).toBe(false);
      expect(taskGroup?.reason).toContain('taskExecution');
    } finally {
      await server.close();
    }
  });
});
