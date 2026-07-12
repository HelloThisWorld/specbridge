import type { AgentConfig } from '@specbridge/core';
import { SpecBridgeError, defaultAgentConfig } from '@specbridge/core';
import type { AgentRunner } from './contract.js';
import { MockRunner } from './mock-runner.js';
import { ClaudeCodeRunner } from './claude-code/runner.js';
import { UnsupportedRunner } from './unsupported-runner.js';

export class RunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  register(runner: AgentRunner): void {
    this.runners.set(runner.name, runner);
  }

  get(name: string): AgentRunner {
    const runner = this.runners.get(name);
    if (runner === undefined) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Unknown runner "${name}". Registered runners: ${[...this.runners.keys()].join(', ')}.`,
      );
    }
    return runner;
  }

  has(name: string): boolean {
    return this.runners.has(name);
  }

  list(): AgentRunner[] {
    return [...this.runners.values()];
  }
}

/**
 * Build the default registry from validated configuration. Unsupported
 * runners are registered as honest stubs so `runner list` can explain them
 * instead of hiding them.
 */
export function createDefaultRunnerRegistry(config?: AgentConfig): RunnerRegistry {
  const resolved = config ?? defaultAgentConfig();
  const registry = new RunnerRegistry();
  registry.register(new MockRunner(resolved.runners.mock));
  registry.register(new ClaudeCodeRunner(resolved.runners['claude-code']));
  registry.register(
    new UnsupportedRunner('codex', {
      detectCommand: commandOverride(resolved, 'codex') ?? 'codex',
      plannedFor: 'a future release (see docs/roadmap.md)',
    }),
  );
  registry.register(
    new UnsupportedRunner('ollama', { plannedFor: 'a future release (see docs/roadmap.md)' }),
  );
  registry.register(
    new UnsupportedRunner('openai-compatible', {
      plannedFor: 'a future release (see docs/roadmap.md)',
    }),
  );
  return registry;
}

function commandOverride(config: AgentConfig, name: string): string | undefined {
  const entry = config.runners[name];
  if (entry === undefined || typeof entry !== 'object') return undefined;
  const command = (entry as { command?: unknown }).command;
  return typeof command === 'string' && command.length > 0 ? command : undefined;
}
