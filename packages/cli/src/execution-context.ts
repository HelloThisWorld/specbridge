import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { SpecBridgeError, readAgentConfig } from '@specbridge/core';
import type { RunnerRegistry } from '@specbridge/runners';
import { createDefaultRunnerRegistry } from '@specbridge/runners';
import { createExtensionRunnerFactory } from '@specbridge/extensions';
import type { CliRuntime } from './context.js';

/**
 * Shared setup for every runner-facing command: workspace + validated
 * configuration + runner registry. Configuration is fail-closed here — an
 * invalid config file refuses execution instead of silently using defaults.
 */

export interface ExecutionContext {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  configPath: string;
  configExists: boolean;
  registry: RunnerRegistry;
}

export function loadExecutionContext(runtime: CliRuntime): ExecutionContext {
  const workspace = runtime.workspace();
  const configResult = readAgentConfig(workspace);
  if (configResult.config === undefined) {
    const details = configResult.diagnostics.map((d) => d.message).join(' ');
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Cannot use runners: ${configResult.path} is invalid. ${details} ` +
        'Fix the configuration file (or delete it to fall back to safe defaults).',
    );
  }
  return {
    workspace,
    config: configResult.config,
    configPath: configResult.path,
    configExists: configResult.exists,
    registry: createDefaultRunnerRegistry(configResult.config, {
      extensionRunner: createExtensionRunnerFactory(workspace),
    }),
  };
}

/** Parse `--timeout 90s | 15m | 45000` into milliseconds. */
export function parseTimeout(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
  if (match === null) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Invalid --timeout "${value}". Use a number with an optional unit: 45000, 90s, 15m, 1h.`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const factor = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
  const timeout = amount * factor;
  if (timeout < 1000) {
    throw new SpecBridgeError('INVALID_ARGUMENT', 'The timeout must be at least 1 second.');
  }
  return timeout;
}

export function parsePositiveInt(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SpecBridgeError('INVALID_ARGUMENT', `${flag} must be a positive integer (got "${value}").`);
  }
  return parsed;
}

export function parsePositiveNumber(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SpecBridgeError('INVALID_ARGUMENT', `${flag} must be a positive number (got "${value}").`);
  }
  return parsed;
}
