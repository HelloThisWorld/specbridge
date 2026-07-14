import { describe, expect, it } from 'vitest';
import type {
  AgentRunner,
  RunnerCapabilitySet,
  RunnerDetectionContext,
  RunnerDetectionResult,
  RunnerExecutionOptions,
  StageGenerationInput,
  StageGenerationResult,
  TaskExecutionInput,
  TaskExecutionResult,
} from '@specbridge/runners';
import {
  NORMALIZED_EXECUTION_OUTCOMES,
  NORMALIZED_RUNNER_EVENT_TYPES,
  RUNNER_CAPABILITY_KEYS,
  RUNNER_CATEGORIES,
  RUNNER_ERROR_CODES,
  RUNNER_OPERATIONS,
  RUNNER_OPERATION_REQUIREMENTS,
  RUNNER_SUPPORT_LEVELS,
  RunnerRegistry,
  capabilitySet,
  checkOperationSupport,
  composeNormalizedResult,
  normalizedExecutionResultSchema,
  normalizedRunnerErrorSchema,
  normalizedRunnerEventSchema,
  runnerCapabilitiesSchema,
  runnerError,
  selectRunner,
  supportedOperations,
} from '@specbridge/runners';
import { defaultResolvedAgentConfig } from '@specbridge/core';

/**
 * Contract snapshot tests (v0.6 freeze).
 *
 * These arrays and unions are the PUBLIC adapter contract v0.6.1 builds on.
 * A failing test here means an accidental breaking change — do not "fix"
 * the snapshot without a deliberate contract-version decision.
 */

describe('frozen contract discriminators', () => {
  it('runner categories are stable', () => {
    expect([...RUNNER_CATEGORIES]).toEqual(['agent-cli', 'model-api', 'mock', 'experimental']);
  });

  it('support-level values are stable', () => {
    expect([...RUNNER_SUPPORT_LEVELS]).toEqual([
      'production',
      'preview',
      'experimental',
      'unavailable',
      'incompatible',
    ]);
  });

  it('operation names are stable', () => {
    expect([...RUNNER_OPERATIONS]).toEqual([
      'stage-generation',
      'stage-refinement',
      'task-execution',
      'task-resume',
      'model-list',
      'runner-test',
    ]);
  });

  it('capability keys are stable (17 keys, no single supported boolean)', () => {
    expect([...RUNNER_CAPABILITY_KEYS]).toEqual([
      'stageGeneration',
      'stageRefinement',
      'taskExecution',
      'taskResume',
      'structuredFinalOutput',
      'streamingEvents',
      'repositoryRead',
      'repositoryWrite',
      'sandbox',
      'toolRestriction',
      'usageReporting',
      'costReporting',
      'localOnly',
      'requiresNetwork',
      'supportsSystemPrompt',
      'supportsJsonSchema',
      'supportsCancellation',
    ]);
    expect(RUNNER_CAPABILITY_KEYS).not.toContain('supported');
  });

  it('normalized outcome values are stable', () => {
    expect([...NORMALIZED_EXECUTION_OUTCOMES]).toEqual([
      'completed',
      'blocked',
      'failed',
      'cancelled',
      'timed-out',
      'permission-denied',
      'malformed-output',
      'no-change',
      'unavailable',
      'incompatible',
      'authentication-required',
      'quota-exceeded',
      'rate-limited',
    ]);
  });

  it('normalized error codes are stable', () => {
    expect([...RUNNER_ERROR_CODES]).toEqual([
      'runner_not_found',
      'runner_disabled',
      'runner_incompatible',
      'executable_not_found',
      'endpoint_unreachable',
      'authentication_required',
      'permission_denied',
      'sandbox_unavailable',
      'structured_output_unsupported',
      'structured_output_invalid',
      'model_not_found',
      'quota_exceeded',
      'rate_limited',
      'network_error',
      'process_failed',
      'api_error',
      'cancelled',
      'timed_out',
      'output_limit_exceeded',
      'repository_diverged',
      'protected_path_modified',
      'verification_failed',
      'invalid_configuration',
      'unsupported_operation',
    ]);
  });

  it('normalized event types are stable', () => {
    expect([...NORMALIZED_RUNNER_EVENT_TYPES]).toEqual([
      'runner.started',
      'runner.completed',
      'session.started',
      'turn.started',
      'turn.completed',
      'message.delta',
      'message.completed',
      'tool.started',
      'tool.completed',
      'tool.failed',
      'command.started',
      'command.completed',
      'file.changed',
      'plan.updated',
      'usage.updated',
      'warning',
      'error',
    ]);
  });

  it('operation capability requirements are stable', () => {
    expect(RUNNER_OPERATION_REQUIREMENTS['stage-generation'].required).toEqual([
      'stageGeneration',
      'structuredFinalOutput',
      'supportsCancellation',
    ]);
    expect(RUNNER_OPERATION_REQUIREMENTS['task-execution'].required).toEqual([
      'taskExecution',
      'repositoryRead',
      'repositoryWrite',
      'structuredFinalOutput',
      'supportsCancellation',
    ]);
    // At least one safe execution boundary for task execution/resume.
    expect(RUNNER_OPERATION_REQUIREMENTS['task-execution'].anyOf).toEqual([
      ['sandbox', 'toolRestriction'],
    ]);
    expect(RUNNER_OPERATION_REQUIREMENTS['task-resume'].required).toEqual([
      'taskResume',
      'taskExecution',
      'structuredFinalOutput',
      'supportsCancellation',
    ]);
  });
});

describe('public schemas validate and stay provider-independent', () => {
  it('capabilities schema validates the documented shape', () => {
    const result = runnerCapabilitiesSchema.safeParse({
      schemaVersion: '1.0.0',
      runner: 'codex-cli',
      category: 'agent-cli',
      supportLevel: 'production',
      capabilities: capabilitySet(['stageGeneration', 'supportsCancellation']),
    });
    expect(result.success).toBe(true);
  });

  it('normalized event schema validates and enforces payload safety', () => {
    const good = normalizedRunnerEventSchema.safeParse({
      schemaVersion: '1.0.0',
      type: 'command.completed',
      timestamp: '2026-01-01T00:00:00.000Z',
      runner: 'codex-cli',
      profile: 'codex-default',
      runId: 'run-1',
      attemptId: 'attempt-001',
      providerEventType: 'item.completed:command_execution',
      payload: { exitCode: 0, durationMs: 1234 },
    });
    expect(good.success).toBe(true);
    // Nested objects (arbitrary provider payloads) are rejected.
    const nested = normalizedRunnerEventSchema.safeParse({
      schemaVersion: '1.0.0',
      type: 'error',
      timestamp: 't',
      runner: 'r',
      profile: 'p',
      runId: 'run',
      attemptId: 'a',
      payload: { deep: { object: true } },
    });
    expect(nested.success).toBe(false);
    // Oversized payloads are rejected (size-limited events).
    const oversized = normalizedRunnerEventSchema.safeParse({
      schemaVersion: '1.0.0',
      type: 'warning',
      timestamp: 't',
      runner: 'r',
      profile: 'p',
      runId: 'run',
      attemptId: 'a',
      payload: { text: 'x'.repeat(40 * 1024) },
    });
    expect(oversized.success).toBe(false);
  });

  it('normalized result schema is strict — provider-specific fields do not leak in', () => {
    const base = {
      schemaVersion: '1.0.0',
      runner: 'codex-cli',
      profile: 'codex-default',
      category: 'agent-cli',
      supportLevel: 'production',
      operation: 'task-execution',
      outcome: 'completed',
      summary: 'done',
      usage: {
        model: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        requestCount: null,
        durationMs: 1000,
      },
      cost: { currency: null, amount: null, source: 'unavailable' },
    };
    expect(normalizedExecutionResultSchema.safeParse(base).success).toBe(true);
    expect(
      normalizedExecutionResultSchema.safeParse({ ...base, codexThreadId: 'leak' }).success,
    ).toBe(false);
    expect(
      normalizedExecutionResultSchema.safeParse({ ...base, ollamaEndpoint: 'leak' }).success,
    ).toBe(false);
  });

  it('normalized errors default retryable safely and never carry stacks', () => {
    const auth = runnerError({ code: 'authentication_required', message: 'not logged in' });
    expect(auth.retryable).toBe(false);
    const network = runnerError({ code: 'network_error', message: 'connection reset' });
    expect(network.retryable).toBe(true);
    expect(JSON.stringify(auth)).not.toContain('stack');
    expect(normalizedRunnerErrorSchema.safeParse(auth).success).toBe(true);
  });

  it('contract snapshots are deterministic', () => {
    const first = JSON.stringify({
      categories: RUNNER_CATEGORIES,
      levels: RUNNER_SUPPORT_LEVELS,
      operations: RUNNER_OPERATIONS,
      capabilities: RUNNER_CAPABILITY_KEYS,
      outcomes: NORMALIZED_EXECUTION_OUTCOMES,
      errors: RUNNER_ERROR_CODES,
      requirements: RUNNER_OPERATION_REQUIREMENTS,
    });
    const second = JSON.stringify({
      categories: RUNNER_CATEGORIES,
      levels: RUNNER_SUPPORT_LEVELS,
      operations: RUNNER_OPERATIONS,
      capabilities: RUNNER_CAPABILITY_KEYS,
      outcomes: NORMALIZED_EXECUTION_OUTCOMES,
      errors: RUNNER_ERROR_CODES,
      requirements: RUNNER_OPERATION_REQUIREMENTS,
    });
    expect(first).toBe(second);
  });
});

/**
 * A minimal test adapter registered WITHOUT changing core orchestration:
 * proves v0.6.1 can add providers against the frozen contract.
 */
class MinimalTestRunner implements AgentRunner {
  readonly name = 'minimal-test';
  readonly kind = 'mock';
  readonly category = 'experimental';
  readonly declaredCapabilities: RunnerCapabilitySet = capabilitySet([
    'stageGeneration',
    'stageRefinement',
    'structuredFinalOutput',
    'supportsCancellation',
    'localOnly',
  ]);

  detect(_context: RunnerDetectionContext): Promise<RunnerDetectionResult> {
    return Promise.resolve({
      runner: this.name,
      kind: this.kind,
      status: 'available',
      authentication: 'not-applicable',
      capabilities: [],
      diagnostics: [],
      category: this.category,
      capabilitySet: this.declaredCapabilities,
      supportLevel: 'experimental',
      networkBacked: false,
    });
  }

  generateStage(
    input: StageGenerationInput,
    _execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult> {
    return Promise.resolve({
      runner: this.name,
      outcome: 'completed',
      rawStdout: '',
      rawStderr: '',
      durationMs: 1,
      warnings: [],
      report: {
        schemaVersion: '1.0.0',
        stage: input.stage,
        markdown: '# Minimal',
        summary: 'minimal adapter output',
        assumptions: [],
        openQuestions: [],
        referencedFiles: [],
      },
    });
  }

  executeTask(
    _input: TaskExecutionInput,
    _execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return Promise.resolve({
      runner: this.name,
      outcome: 'failed',
      failureReason: 'not supported',
      rawStdout: '',
      rawStderr: '',
      durationMs: 1,
      warnings: [],
      resumeSupported: false,
    });
  }
}

describe('adapter extensibility without core changes', () => {
  it('a new adapter registers, selects, and normalizes through the frozen contract', async () => {
    const registry = new RunnerRegistry();
    const runner = new MinimalTestRunner();
    registry.registerProfile({
      name: 'minimal',
      // A v0.6.1 adapter ships its own profile schema; the registry only
      // requires the profile's runner name to match the adapter identity.
      config: { runner: 'minimal-test', enabled: true } as never,
      runner: runner as unknown as AgentRunner,
    });
    expect(registry.has('minimal')).toBe(true);
    // Capability-derived operations (model-list/runner-test additionally
    // need the adapter method at the profile-listing level).
    expect(supportedOperations(runner.declaredCapabilities)).toEqual([
      'stage-generation',
      'stage-refinement',
      'model-list',
      'runner-test',
    ]);
    // Capability gating works against the new adapter with no core edits.
    expect(checkOperationSupport('task-execution', runner.declaredCapabilities).supported).toBe(false);
    const result = await runner.generateStage(
      {
        specName: 's',
        stage: 'requirements',
        intent: 'generate',
        prompt: 'p',
        promptVersion: '1',
        toolPolicy: 'read-only',
      },
      { workspaceRoot: process.cwd(), runDir: process.cwd(), timeoutMs: 1000 },
    );
    const normalized = composeNormalizedResult(
      { profile: 'minimal', category: runner.category, supportLevel: 'experimental', operation: 'stage-generation' },
      result,
    );
    expect(normalized.outcome).toBe('completed');
    expect(normalizedExecutionResultSchema.safeParse(normalized).success).toBe(true);
  });

  it('registry-config mismatches are rejected (profile-to-runner validation)', () => {
    const registry = new RunnerRegistry();
    expect(() =>
      registry.registerProfile({
        name: 'wrong',
        config: { runner: 'claude-code', enabled: true } as never,
        runner: new MinimalTestRunner() as unknown as AgentRunner,
      }),
    ).toThrowError(/configured for runner/);
  });

  it('duplicate profile names are rejected', () => {
    const registry = new RunnerRegistry();
    const profile = {
      name: 'dup',
      config: { runner: 'mock', enabled: true, scenario: 'success', changeFile: 'x.txt' } as never,
      runner: new MinimalTestRunner() as unknown as AgentRunner,
    };
    // First registration must not throw for the mismatch guard in this test:
    // use a mock-named runner instead.
    const registryB = new RunnerRegistry();
    void registryB;
    expect(() => {
      registry.registerProfile({ ...profile, runner: { ...profile.runner, name: 'mock' } as never });
      registry.registerProfile({ ...profile, runner: { ...profile.runner, name: 'mock' } as never });
    }).toThrowError(/must be unique/);
  });

  it('selection over a custom registry stays deterministic', () => {
    const config = defaultResolvedAgentConfig();
    const registry = new RunnerRegistry();
    // No profiles at all: selection fails closed with runner_not_found.
    const selection = selectRunner(registry, config, { operation: 'stage-generation' });
    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.failure.error.code).toBe('runner_not_found');
    }
  });
});
