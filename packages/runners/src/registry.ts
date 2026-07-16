import type { AgentConfig, ExtensionRunnerProfileConfig, RunnerProfileConfig } from '@specbridge/core';
import { SpecBridgeError, defaultResolvedAgentConfig } from '@specbridge/core';
import type { AgentRunner } from './contract.js';
import { MockRunner } from './mock-runner.js';
import { ClaudeCodeRunner } from './claude-code/runner.js';
import { CodexCliRunner } from './codex-cli/runner.js';
import { GeminiCliRunner } from './gemini-cli/runner.js';
import { OllamaRunner } from './ollama/runner.js';
import { OpenAiCompatibleRunner } from './openai-compatible/runner.js';
import { AntigravityCliRunner } from './antigravity-cli/runner.js';

/**
 * Profile-based runner registry (v0.6).
 *
 * A runner IMPLEMENTATION (claude-code, codex-cli, ollama, mock) is code; a
 * runner PROFILE is one named configuration of an implementation
 * (claude-code, codex-default, codex-fast, ollama-local, …). The registry
 * maps profile names to instantiated adapters.
 *
 * Deterministic: listing preserves configuration order (built-ins first),
 * names are unique, and no global mutable state leaks across instances.
 * Disabled profiles ARE registered — `runner list`/`doctor` must explain
 * them — and refused at selection time.
 */

export interface RegisteredRunnerProfile {
  /** Unique profile name (e.g. "codex-default"). */
  name: string;
  /** Validated profile configuration (never contains credentials). */
  config: RunnerProfileConfig;
  /** The adapter instance configured for this profile. */
  runner: AgentRunner;
}

export class RunnerRegistry {
  private readonly profiles = new Map<string, RegisteredRunnerProfile>();

  registerProfile(profile: RegisteredRunnerProfile): void {
    if (this.profiles.has(profile.name)) {
      throw new SpecBridgeError(
        'INVALID_STATE',
        `Runner profile "${profile.name}" is already registered. Profile names must be unique.`,
      );
    }
    if (profile.runner.name !== profile.config.runner) {
      throw new SpecBridgeError(
        'INVALID_STATE',
        `Profile "${profile.name}" is configured for runner "${profile.config.runner}" but the adapter implements "${profile.runner.name}".`,
      );
    }
    this.profiles.set(profile.name, profile);
  }

  getProfile(name: string): RegisteredRunnerProfile {
    const profile = this.profiles.get(name);
    if (profile === undefined) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Unknown runner profile "${name}". Configured profiles: ${[...this.profiles.keys()].join(', ')}.`,
      );
    }
    return profile;
  }

  /** The adapter for a profile name (v0.3-compatible accessor). */
  get(name: string): AgentRunner {
    return this.getProfile(name).runner;
  }

  has(name: string): boolean {
    return this.profiles.has(name);
  }

  /** All profiles in deterministic registration order. */
  listProfiles(): RegisteredRunnerProfile[] {
    return [...this.profiles.values()];
  }

  /** All adapters in deterministic registration order (v0.3-compatible). */
  list(): AgentRunner[] {
    return this.listProfiles().map((profile) => profile.runner);
  }
}

/**
 * v0.7.1: factory for extension-backed runners. Implemented by
 * @specbridge/extensions and injected by the CLI/MCP layer so this package
 * never depends on the extension host. The frozen AgentRunner contract is
 * unchanged — an extension runner is just another adapter behind it.
 */
export type ExtensionRunnerFactory = (config: ExtensionRunnerProfileConfig) => AgentRunner;

export interface InstantiateRunnerOptions {
  extensionRunner?: ExtensionRunnerFactory;
}

/** Instantiate the registered adapter for a profile configuration. */
export function instantiateRunner(
  config: RunnerProfileConfig,
  options: InstantiateRunnerOptions = {},
): AgentRunner {
  switch (config.runner) {
    case 'claude-code':
      return new ClaudeCodeRunner(config);
    case 'codex-cli':
      return new CodexCliRunner(config);
    case 'gemini-cli':
      return new GeminiCliRunner(config);
    case 'ollama':
      return new OllamaRunner(config);
    case 'openai-compatible':
      return new OpenAiCompatibleRunner(config);
    case 'antigravity-cli':
      return new AntigravityCliRunner(config);
    case 'mock':
      return new MockRunner(config);
    case 'extension': {
      if (options.extensionRunner === undefined) {
        throw new SpecBridgeError(
          'INVALID_STATE',
          `Runner profile uses extension "${config.extensionId}", but no extension runner ` +
            'factory is available in this context.',
        );
      }
      return options.extensionRunner(config);
    }
  }
}

/**
 * Build the default registry from the resolved configuration: one profile
 * entry per configured profile (built-ins are always present; new-provider
 * built-ins default to disabled and are never selected implicitly).
 */
export function createDefaultRunnerRegistry(
  config?: AgentConfig,
  options: InstantiateRunnerOptions = {},
): RunnerRegistry {
  const resolved = config ?? defaultResolvedAgentConfig();
  const registry = new RunnerRegistry();
  for (const [name, profileConfig] of Object.entries(resolved.runnerProfiles)) {
    if (profileConfig.runner === 'extension') {
      // Extension profiles register only when explicitly enabled AND an
      // extension runner factory exists in this context. A disabled or
      // unresolvable extension profile is simply absent from the registry —
      // never a crash, never an automatic fallback.
      if (profileConfig.enabled !== true || options.extensionRunner === undefined) {
        continue;
      }
    }
    registry.registerProfile({
      name,
      config: profileConfig,
      runner: instantiateRunner(profileConfig, options),
    });
  }
  return registry;
}
