import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSpecBridgeError } from '@specbridge/core';
import type { RunnerExecutionOptions } from '@specbridge/runners';
import {
  ClaudeCodeRunner,
  MockRunner,
  UnsupportedRunner,
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
  it('registers the documented default runners', () => {
    const registry = createDefaultRunnerRegistry();
    expect(registry.list().map((r) => r.name).sort()).toEqual([
      'claude-code',
      'codex',
      'mock',
      'ollama',
      'openai-compatible',
    ]);
  });

  it('exposes honest runner kinds', () => {
    const registry = createDefaultRunnerRegistry();
    expect(registry.get('mock').kind).toBe('mock');
    expect(registry.get('claude-code').kind).toBe('claude-code');
    expect(registry.get('codex').kind).toBe('unsupported');
    expect(registry.get('ollama').kind).toBe('unsupported');
    expect(registry.get('openai-compatible').kind).toBe('unsupported');
  });

  it('throws a helpful error for unknown runners', () => {
    const registry = createDefaultRunnerRegistry();
    expect(() => registry.get('gpt-magic')).toThrowError(/Registered runners:/);
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

describe('unsupported runners are stubs, not fakes', () => {
  it.each(['ollama', 'openai-compatible'])('%s reports unavailable and refuses to run', async (name) => {
    const runner = new UnsupportedRunner(name, { plannedFor: 'a future release' });
    const detection = await runner.detect({ workspaceRoot: process.cwd() });
    expect(detection.status).toBe('unavailable');
    expect(detection.kind).toBe('unsupported');
    await expect(runner.generateStage(generationInput, executionOptions())).rejects.toSatisfy(
      (error: unknown) => isSpecBridgeError(error) && error.code === 'NOT_IMPLEMENTED',
    );
  });
});
