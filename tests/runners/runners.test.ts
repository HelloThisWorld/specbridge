import { describe, expect, it } from 'vitest';
import { isSpecBridgeError } from '@specbridge/core';
import {
  ClaudeCodeRunner,
  MockRunner,
  OllamaRunnerStub,
  OpenAiCompatibleRunnerStub,
  createDefaultRunnerRegistry,
} from '@specbridge/runners';

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

  it('throws a helpful error for unknown runners', () => {
    const registry = createDefaultRunnerRegistry();
    expect(() => registry.get('gpt-magic')).toThrowError(/Registered runners:/);
  });
});

describe('mock runner (offline, deterministic)', () => {
  const input = {
    kind: 'requirements' as const,
    specName: 'notification-preferences',
    prompt: 'draft requirements',
  };

  it('is always available and produces identical output for identical input', async () => {
    const runner = new MockRunner();
    expect(await runner.isAvailable()).toBe(true);
    const first = await runner.generate(input);
    const second = await runner.generate(input);
    expect(first.content).toBe(second.content);
    expect(first.content).toContain('notification-preferences');
  });

  it('produces different output for different input', async () => {
    const runner = new MockRunner();
    const a = await runner.generate(input);
    const b = await runner.generate({ ...input, prompt: 'something else' });
    expect(a.content).not.toBe(b.content);
  });
});

describe('CLI-detection runners', () => {
  it('claude-code runner reports unavailable for a missing binary', async () => {
    const runner = new ClaudeCodeRunner({ command: 'specbridge-no-such-binary-xyz' });
    expect(await runner.isAvailable()).toBe(false);
  });

  it('claude-code generation is honestly NOT_IMPLEMENTED in v0.1', async () => {
    const runner = new ClaudeCodeRunner();
    await expect(
      runner.generate({ kind: 'free-form', specName: 's', prompt: 'p' }),
    ).rejects.toSatisfy(
      (error: unknown) => isSpecBridgeError(error) && error.code === 'NOT_IMPLEMENTED',
    );
  });
});

describe('stub runners are stubs, not fakes', () => {
  it.each([
    ['ollama', new OllamaRunnerStub()],
    ['openai-compatible', new OpenAiCompatibleRunnerStub()],
  ])('%s reports unavailable and rejects generation', async (_name, runner) => {
    expect(await runner.isAvailable()).toBe(false);
    await expect(
      runner.generate({ kind: 'free-form', specName: 's', prompt: 'p' }),
    ).rejects.toSatisfy(
      (error: unknown) => isSpecBridgeError(error) && error.code === 'NOT_IMPLEMENTED',
    );
  });
});
