import { describe, expect, it } from 'vitest';
import {
  agentConfigV2Schema,
  resolveAgentConfigFromV2,
} from '@specbridge/core';
import type { AgentConfig } from '@specbridge/core';
import {
  createDefaultRunnerRegistry,
  fallbackEligible,
  runnerError,
  selectRunner,
  transientRetryEligible,
} from '@specbridge/runners';

/** Deterministic, capability-driven runner selection (v0.6). */

function config(overrides: Record<string, unknown> = {}): AgentConfig {
  return resolveAgentConfigFromV2(
    agentConfigV2Schema.parse({
      schemaVersion: '2.0.0',
      runnerProfiles: {
        'claude-code': { runner: 'claude-code', enabled: true },
        'codex-default': { runner: 'codex-cli', enabled: true },
        'ollama-local': { runner: 'ollama', enabled: true, model: 'qwen-fake:7b' },
        mock: { runner: 'mock', enabled: true },
      },
      ...overrides,
    }),
  );
}

describe('selection precedence', () => {
  it('the global default selects claude-code for task execution', () => {
    const resolved = config();
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, { operation: 'task-execution' });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.plan.profile).toBe('claude-code');
      expect(selection.plan.origin).toBe('global-default');
    }
  });

  it('an operation default overrides the global default (Ollama for authoring)', () => {
    const resolved = config({ operationDefaults: { stageGeneration: 'ollama-local' } });
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, { operation: 'stage-generation' });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.plan.profile).toBe('ollama-local');
      expect(selection.plan.origin).toBe('operation-default');
      expect(selection.plan.localExecution).toBe(true);
      expect(selection.plan.networkBacked).toBe(false);
    }
    // Task execution still selects the global claude default.
    const task = selectRunner(registry, resolved, { operation: 'task-execution' });
    expect(task.ok && task.plan.profile).toBe('claude-code');
  });

  it('explicit --runner overrides the operation default (Codex)', () => {
    const resolved = config({ operationDefaults: { stageGeneration: 'ollama-local' } });
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, {
      operation: 'stage-generation',
      explicitProfile: 'codex-default',
    });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.plan.profile).toBe('codex-default');
      expect(selection.plan.origin).toBe('explicit');
      expect(selection.plan.runner).toBe('codex-cli');
    }
  });
});

describe('capability-driven refusals (before any execution)', () => {
  it('ollama task execution is rejected with capabilities and compatible profiles', () => {
    const resolved = config();
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, {
      operation: 'task-execution',
      explicitProfile: 'ollama-local',
    });
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.failure.error.code).toBe('unsupported_operation');
    expect(selection.failure.missingCapabilities).toContain('taskExecution');
    expect(selection.failure.missingCapabilities).toContain('repositoryWrite');
    expect(selection.failure.requiredCapabilities).toEqual([
      'taskExecution',
      'repositoryRead',
      'repositoryWrite',
      'structuredFinalOutput',
      'supportsCancellation',
    ]);
    // 36: compatible configured profiles are suggested.
    expect(selection.failure.compatibleProfiles).toContain('claude-code');
    expect(selection.failure.compatibleProfiles).toContain('codex-default');
    expect(selection.failure.compatibleProfiles).not.toContain('ollama-local');
  });

  it('a disabled profile cannot be selected, even explicitly', () => {
    const resolved = config({
      runnerProfiles: {
        'claude-code': { runner: 'claude-code', enabled: true },
        'codex-default': { runner: 'codex-cli', enabled: false },
        mock: { runner: 'mock', enabled: true },
      },
    });
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, {
      operation: 'stage-generation',
      explicitProfile: 'codex-default',
    });
    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.failure.error.code).toBe('runner_disabled');
  });

  it('an unknown profile is rejected with the configured profile list', () => {
    const resolved = config();
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, {
      operation: 'stage-generation',
      explicitProfile: 'gemini-magic',
    });
    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.failure.error.code).toBe('runner_not_found');
      expect(selection.failure.error.remediation.join(' ')).toContain('claude-code');
    }
  });
});

describe('network-backed selection policy', () => {
  const remote = (extra: Record<string, unknown> = {}) =>
    config({
      defaultRunner: 'ollama-remote',
      runnerProfiles: {
        'claude-code': { runner: 'claude-code', enabled: true },
        'ollama-remote': {
          runner: 'ollama',
          enabled: true,
          baseUrl: 'https://ollama.example.com',
          model: 'qwen-fake:7b',
        },
        mock: { runner: 'mock', enabled: true },
      },
      ...extra,
    });

  it('a network-backed profile is never selected implicitly via the global default', () => {
    const resolved = remote();
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, { operation: 'stage-generation' });
    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.failure.error.message).toContain('never selected implicitly');
    }
  });

  it('explicit selection and operation defaults are sufficient for network-backed profiles', () => {
    const resolved = remote({ operationDefaults: { stageGeneration: 'ollama-remote' } });
    const registry = createDefaultRunnerRegistry(resolved);
    const viaOperationDefault = selectRunner(registry, resolved, { operation: 'stage-generation' });
    expect(viaOperationDefault.ok).toBe(true);
    if (viaOperationDefault.ok) {
      expect(viaOperationDefault.plan.networkBacked).toBe(true);
      expect(viaOperationDefault.plan.endpoint).toBe('https://ollama.example.com');
    }
    const viaExplicit = selectRunner(registry, resolved, {
      operation: 'stage-generation',
      explicitProfile: 'ollama-remote',
    });
    expect(viaExplicit.ok).toBe(true);
  });

  it('allowNetworkRunners=false refuses network-backed profiles outright', () => {
    const resolved = remote({
      operationDefaults: { stageGeneration: 'ollama-remote' },
      runnerPolicy: { allowNetworkRunners: false },
    });
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, { operation: 'stage-generation' });
    expect(selection.ok).toBe(false);
  });
});

describe('fallback policy (bounded, explicit, auditable)', () => {
  it('fallback applies only to authoring operations', () => {
    expect(fallbackEligible('task-execution', 'failed', undefined).eligible).toBe(false);
    expect(fallbackEligible('task-resume', 'failed', undefined).eligible).toBe(false);
    expect(fallbackEligible('stage-generation', 'failed', undefined).eligible).toBe(true);
  });

  it('never falls back after authentication, permission, config, quota, or cancellation', () => {
    const cases = [
      runnerError({ code: 'authentication_required', message: 'x' }),
      runnerError({ code: 'permission_denied', message: 'x' }),
      runnerError({ code: 'invalid_configuration', message: 'x' }),
      runnerError({ code: 'quota_exceeded', message: 'x' }),
      runnerError({ code: 'sandbox_unavailable', message: 'x' }),
      runnerError({ code: 'unsupported_operation', message: 'x' }),
    ];
    for (const error of cases) {
      expect(fallbackEligible('stage-generation', 'failed', error).eligible, error.code).toBe(false);
    }
    expect(fallbackEligible('stage-generation', 'cancelled', undefined).eligible).toBe(false);
    expect(fallbackEligible('stage-generation', 'permission-denied', undefined).eligible).toBe(false);
  });

  it('real results (completed/blocked) never trigger fallback', () => {
    expect(fallbackEligible('stage-generation', 'completed', undefined).eligible).toBe(false);
    expect(fallbackEligible('stage-generation', 'blocked', undefined).eligible).toBe(false);
  });

  it('transient transport retries are bounded to two', () => {
    const network = runnerError({ code: 'network_error', message: 'x' });
    expect(transientRetryEligible('stage-generation', network, 0).eligible).toBe(true);
    expect(transientRetryEligible('stage-generation', network, 1).eligible).toBe(true);
    expect(transientRetryEligible('stage-generation', network, 2).eligible).toBe(false);
    const auth = runnerError({ code: 'authentication_required', message: 'x' });
    expect(transientRetryEligible('stage-generation', auth, 0).eligible).toBe(false);
  });

  it('the selection plan carries the explicitly configured fallback chain only', () => {
    const resolved = config({
      operationDefaults: { stageGeneration: 'ollama-local' },
      fallbacks: { stageGeneration: ['ollama-local', 'codex-default'] },
    });
    const registry = createDefaultRunnerRegistry(resolved);
    const selection = selectRunner(registry, resolved, { operation: 'stage-generation' });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.plan.fallbackChain).toEqual(['codex-default']);
    }
    const noChain = selectRunner(registry, resolved, { operation: 'stage-refinement' });
    expect(noChain.ok && noChain.plan.fallbackChain).toEqual([]);
  });
});
