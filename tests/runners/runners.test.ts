import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunnerExecutionOptions } from '@specbridge/runners';
import {
  ClaudeCodeRunner,
  MockRunner,
  createDefaultRunnerRegistry,
} from '@specbridge/runners';

function executionOptions(): RunnerExecutionOptions {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'specbridge-runner-test-'));
  return { workspaceRoot: dir, runDir: path.join(dir, 'run'), timeoutMs: 5000 };
}

const generationInput = {
  specName: 'notification-preferences',
  stage: 'requirements' as const,
  intent: 'generate' as const,
  prompt: 'draft requirements',
  promptVersion: '1.0.0',
  toolPolicy: 'read-only' as const,
};

describe('runner registry', () => {
  it('registers the documented default profiles in deterministic order', () => {
    const registry = createDefaultRunnerRegistry();
    expect(registry.listProfiles().map((profile) => profile.name)).toEqual([
      'claude-code',
      'codex-default',
      'gemini-default',
      'ollama-local',
      'openai-compatible-local',
      'antigravity',
      'mock',
    ]);
  });

  it('exposes honest runner implementations per profile', () => {
    const registry = createDefaultRunnerRegistry();
    expect(registry.get('mock').kind).toBe('mock');
    expect(registry.get('claude-code').kind).toBe('claude-code');
    expect(registry.get('codex-default').kind).toBe('codex-cli');
    expect(registry.get('ollama-local').kind).toBe('ollama');
    // Deferred providers are NOT registered as placeholders.
    expect(registry.has('openai-compatible')).toBe(false);
    expect(registry.has('gemini')).toBe(false);
  });

  it('new-provider profiles default to DISABLED', () => {
    const registry = createDefaultRunnerRegistry();
    expect(registry.getProfile('codex-default').config.enabled).toBe(false);
    expect(registry.getProfile('ollama-local').config.enabled).toBe(false);
    expect(registry.getProfile('claude-code').config.enabled).toBe(true);
  });

  it('throws a helpful error for unknown profiles', () => {
    const registry = createDefaultRunnerRegistry();
    expect(() => registry.get('gpt-magic')).toThrowError(/Configured profiles:/);
  });
});

describe('mock runner (offline, deterministic)', () => {
  it('is always available and produces identical output for identical input', async () => {
    const runner = new MockRunner();
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('available');
    expect(detection.authentication).toBe('not-applicable');

    const first = await runner.generateStage(generationInput, executionOptions());
    const second = await runner.generateStage(generationInput, executionOptions());
    expect(first.outcome).toBe('completed');
    expect(first.report?.markdown).toBe(second.report?.markdown);
    expect(first.report?.markdown).toContain('Notification Preferences');
  });

  it('produces different output for different input', async () => {
    const runner = new MockRunner();
    const a = await runner.generateStage(generationInput, executionOptions());
    const b = await runner.generateStage(
      { ...generationInput, prompt: 'something else' },
      executionOptions(),
    );
    expect(a.report?.markdown).not.toBe(b.report?.markdown);
  });

  it('reports malformed output honestly instead of repairing it', async () => {
    const runner = new MockRunner({ scenario: 'malformed-output' });
    const result = await runner.generateStage(generationInput, executionOptions());
    expect(result.outcome).toBe('malformed-output');
    expect(result.report).toBeUndefined();
    expect(result.rawStdout.length).toBeGreaterThan(0);
  });
});

describe('claude-code runner detection', () => {
  it('reports unavailable for a missing executable', async () => {
    const runner = new ClaudeCodeRunner({ command: 'specbridge-no-such-binary-xyz' });
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('unavailable');
    expect(detection.diagnostics.some((d) => d.code === 'RUNNER_EXECUTABLE_NOT_FOUND')).toBe(true);
  });

  it('reports misconfigured when disabled', async () => {
    const runner = new ClaudeCodeRunner({ enabled: false });
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('misconfigured');
  });
});

describe('capability metadata (v0.6)', () => {
  it('every registered runner reports category and a complete capability set', async () => {
    const registry = createDefaultRunnerRegistry();
    for (const profile of registry.listProfiles()) {
      expect(profile.runner.category).toBeDefined();
      expect(Object.keys(profile.runner.declaredCapabilities)).toHaveLength(17);
    }
    const mockDetection = await registry.get('mock').detect({ workspaceRoot: process.cwd() });
    expect(mockDetection.category).toBe('mock');
    expect(mockDetection.supportLevel).toBe('production');
    expect(mockDetection.networkBacked).toBe(false);
  });
});
