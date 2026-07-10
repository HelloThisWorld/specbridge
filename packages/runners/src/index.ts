import type { SpecbridgeConfig } from '@specbridge/core';
import { RunnerRegistry } from './runner.js';
import { MockRunner } from './mock-runner.js';
import { ClaudeCodeRunner } from './claude-code-runner.js';
import { CodexRunner } from './codex-runner.js';
import { OllamaRunnerStub } from './ollama-runner.stub.js';
import { OpenAiCompatibleRunnerStub } from './openai-compatible-runner.stub.js';

export * from './runner.js';
export { MockRunner } from './mock-runner.js';
export { ClaudeCodeRunner } from './claude-code-runner.js';
export { CodexRunner } from './codex-runner.js';
export { OllamaRunnerStub } from './ollama-runner.stub.js';
export { OpenAiCompatibleRunnerStub } from './openai-compatible-runner.stub.js';

/**
 * Build the default registry, honoring `.specbridge/config.json` command
 * overrides (e.g. a custom path to the `claude` binary).
 */
export function createDefaultRunnerRegistry(config?: SpecbridgeConfig): RunnerRegistry {
  const registry = new RunnerRegistry();
  const commandFor = (name: string): { command?: string } => {
    const command = config?.runners?.[name]?.command;
    return command !== undefined ? { command } : {};
  };
  registry.register(new MockRunner());
  registry.register(new ClaudeCodeRunner(commandFor('claude-code')));
  registry.register(new CodexRunner(commandFor('codex')));
  registry.register(new OllamaRunnerStub());
  registry.register(new OpenAiCompatibleRunnerStub());
  return registry;
}
