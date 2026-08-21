import { describe, expect, it } from 'vitest';
import type { AgentConfig, DeepSeekHarnessProfileConfig } from '@specbridge/core';
import {
  COMPUTE_LOCALITIES,
  LOCAL_EXECUTION_MODES,
  LOCAL_EXECUTION_STRATEGIES,
  deepseekHarnessProfileSchema,
  defaultResolvedAgentConfig,
  jobSchedulerPolicySchema,
} from '@specbridge/core';
import { verifyDshComputeLocality } from '@specbridge/runners';
import {
  LOCAL_EXECUTION_MODE_REASONS,
  LOCAL_EXECUTION_SHAPES,
  buildQuotaForecast,
  classifyLocalExecutionShape,
  decideLane,
  estimateWorkload,
  resolveLocalExecutionMode,
  resolveLocalHarnessBinding,
  summarizeLocalRuntime,
} from '@specbridge/orchestration';
import type { ExecutionLedgerEntry, LocalHarnessBinding } from '@specbridge/orchestration';

/**
 * vNext.4 Local Agentic Runtime — deterministic unit level.
 *
 * Everything here is pure policy: compute-locality verification, the LOCAL
 * harness binding, execution-shape classification, mode resolution, and the
 * observation read model. No process, no network, no model, no clock.
 *
 * The invariant these tests exist to protect, stated once:
 *
 *   Economic lane  !=  Execution mode  !=  Harness  !=  Model  !=  Locality
 *
 * A harness is not a location. A model name is not a location. Only verified
 * evidence is a location — and without it, the LOCAL lane refuses.
 */

function harnessProfile(
  overrides: Partial<DeepSeekHarnessProfileConfig> = {},
): DeepSeekHarnessProfileConfig {
  return deepseekHarnessProfileSchema.parse({
    runner: 'deepseek-harness',
    enabled: true,
    command: { executable: 'dsh-jsonrpc-agent', args: [] },
    provider: 'local-llamacpp',
    model: 'qwen3-coder-30b',
    workspaceBoundary: 'runtime-profile',
    computeLocality: 'loopback-endpoint',
    providerEndpoint: 'http://127.0.0.1:8080/v1',
    ...overrides,
  });
}

function configWith(options: {
  profile?: DeepSeekHarnessProfileConfig | undefined;
  profileName?: string | undefined;
  strategy?: 'DIRECT_ONLY' | 'HARNESS_ONLY' | 'ADAPTIVE' | undefined;
  harnessProfile?: string | null | undefined;
  allowUnverifiedLocality?: boolean | undefined;
  localInferenceEnabled?: boolean | undefined;
} = {}): AgentConfig {
  const base = defaultResolvedAgentConfig();
  const name = options.profileName ?? 'dsh-local';
  const scheduler = jobSchedulerPolicySchema.parse({
    ...base.orchestration.jobs.scheduler,
    localExecution: {
      strategy: options.strategy ?? 'ADAPTIVE',
      harnessProfile:
        options.harnessProfile === undefined ? name : options.harnessProfile,
      allowUnverifiedLocality: options.allowUnverifiedLocality ?? false,
    },
  });
  return {
    ...base,
    runnerProfiles: {
      ...base.runnerProfiles,
      ...(options.profile !== undefined ? { [name]: options.profile } : {}),
    },
    localInference: {
      ...base.localInference,
      enabled: options.localInferenceEnabled ?? false,
    },
    orchestration: {
      ...base.orchestration,
      jobs: { ...base.orchestration.jobs, scheduler },
    },
  };
}

function bound(binding: Partial<LocalHarnessBinding> = {}): LocalHarnessBinding {
  return {
    status: 'BOUND',
    available: true,
    profileName: 'dsh-local',
    runner: 'deepseek-harness',
    model: 'qwen3-coder-30b',
    locality: 'LOCAL',
    localityEvidence: 'loopback',
    credentialRisks: [],
    localityOverridden: false,
    problems: [],
    maxWallTimeMs: 1_800_000,
    ...binding,
  };
}

function unbound(status: LocalHarnessBinding['status']): LocalHarnessBinding {
  return bound({ status, available: false, problems: [`binding is ${status}`], locality: 'UNKNOWN' });
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('vNext.4 vocabulary stays orthogonal', () => {
  it('keeps lane, mode, shape, and locality as separate closed enums', () => {
    expect([...LOCAL_EXECUTION_MODES]).toEqual(['DIRECT_MODEL', 'HARNESS']);
    expect([...LOCAL_EXECUTION_SHAPES]).toEqual(['ONE_SHOT', 'AGENTIC']);
    expect([...COMPUTE_LOCALITIES]).toEqual(['LOCAL', 'REMOTE', 'UNKNOWN']);
    expect([...LOCAL_EXECUTION_STRATEGIES]).toEqual(['DIRECT_ONLY', 'HARNESS_ONLY', 'ADAPTIVE']);
    // No compound value may exist: "LOCAL_DSH"-style members would make
    // "was it local?" and "did it use a harness?" unanswerable separately.
    for (const mode of LOCAL_EXECUTION_MODES) {
      expect(mode.includes('DSH')).toBe(false);
      expect(mode.includes('DEEPSEEK')).toBe(false);
    }
    for (const reason of LOCAL_EXECUTION_MODE_REASONS) {
      expect(reason.startsWith('LOCAL_')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Compute locality
// ---------------------------------------------------------------------------

describe('compute-locality verification (fail closed)', () => {
  it('verifies a literal loopback endpoint as LOCAL', () => {
    const assessment = verifyDshComputeLocality({ config: harnessProfile() });
    expect(assessment.locality).toBe('LOCAL');
    expect(assessment.rejections).toEqual([]);
  });

  it('accepts the whole 127.0.0.0/8 block and ::1, but not a wildcard bind', () => {
    for (const endpoint of ['http://127.0.0.1:1234', 'http://127.5.6.7:9', 'http://[::1]:8080/v1', 'http://localhost:11434']) {
      expect(verifyDshComputeLocality({ config: harnessProfile({ providerEndpoint: endpoint }) }).locality).toBe('LOCAL');
    }
    const wildcard = verifyDshComputeLocality({
      config: harnessProfile({ providerEndpoint: 'http://0.0.0.0:8080' }),
    });
    expect(wildcard.locality).toBe('UNKNOWN');
    expect(wildcard.rejections).toContain('endpoint-wildcard');
  });

  it('Test D: a remote endpoint is REMOTE even when the model is called "qwen"', () => {
    const assessment = verifyDshComputeLocality({
      config: harnessProfile({
        model: 'qwen3-coder-plus',
        providerEndpoint: 'https://api.example-cloud.com/v1',
      }),
    });
    expect(assessment.locality).toBe('REMOTE');
    expect(assessment.rejections).toContain('endpoint-remote');
  });

  it('Test E: an unattested profile is UNKNOWN, never guessed local', () => {
    const assessment = verifyDshComputeLocality({
      config: harnessProfile({ computeLocality: 'unconfirmed' }),
    });
    expect(assessment.locality).toBe('UNKNOWN');
    expect(assessment.rejections).toEqual(['not-attested']);
  });

  it('treats an attested-but-unstated or unparseable endpoint as UNKNOWN', () => {
    expect(
      verifyDshComputeLocality({ config: harnessProfile({ providerEndpoint: null }) }).rejections,
    ).toContain('endpoint-missing');
    expect(
      verifyDshComputeLocality({ config: harnessProfile({ providerEndpoint: 'not a url' }) }).rejections,
    ).toContain('endpoint-unparseable');
  });

  it('accepts the SpecBridge-managed local model server as evidence, and nothing less', () => {
    const config = harnessProfile({ computeLocality: 'managed-local-model', providerEndpoint: null });
    expect(verifyDshComputeLocality({ config, managedLocalModelAvailable: true }).locality).toBe('LOCAL');
    const without = verifyDshComputeLocality({ config, managedLocalModelAvailable: false });
    expect(without.locality).toBe('UNKNOWN');
    expect(without.rejections).toContain('managed-model-unavailable');
  });

  it('Test U: paid-provider credential passthrough disqualifies a local binding (names only)', () => {
    const assessment = verifyDshComputeLocality({
      config: harnessProfile({ environmentPassthrough: ['HOME', 'OPENAI_API_KEY'] }),
    });
    expect(assessment.locality).toBe('UNKNOWN');
    expect(assessment.rejections).toContain('credential-risk');
    expect(assessment.credentialRisks).toEqual(['OPENAI_API_KEY']);
    // The NAME is reported; no value is ever read or echoed.
    expect(assessment.evidence).not.toContain(process.env['OPENAI_API_KEY'] ?? ' never');
  });

  it('does not treat an innocuous passthrough name as a credential', () => {
    const assessment = verifyDshComputeLocality({
      config: harnessProfile({ environmentPassthrough: ['FAKE_DSH_SCENARIO', 'NO_COLOR'] }),
    });
    expect(assessment.credentialRisks).toEqual([]);
    expect(assessment.locality).toBe('LOCAL');
  });
});

// ---------------------------------------------------------------------------
// LOCAL harness binding
// ---------------------------------------------------------------------------

describe('LOCAL harness binding', () => {
  it('is NOT_CONFIGURED by default: installing or enabling a harness binds nothing', () => {
    const binding = resolveLocalHarnessBinding(
      configWith({ profile: harnessProfile(), harnessProfile: null }),
    );
    expect(binding.status).toBe('NOT_CONFIGURED');
    expect(binding.available).toBe(false);
  });

  it('binds an enabled, complete, attested, verified-local profile', () => {
    const binding = resolveLocalHarnessBinding(configWith({ profile: harnessProfile() }));
    expect(binding.status).toBe('BOUND');
    expect(binding.available).toBe(true);
    expect(binding.locality).toBe('LOCAL');
    expect(binding.runner).toBe('deepseek-harness');
    expect(binding.model).toBe('qwen3-coder-30b');
  });

  it('Test D: refuses a remote profile for the LOCAL lane, override or not', () => {
    const remote = harnessProfile({ providerEndpoint: 'https://api.example-cloud.com/v1' });
    expect(resolveLocalHarnessBinding(configWith({ profile: remote })).status).toBe('REMOTE_COMPUTE');
    // The experimental override exists for "cannot be proven", never for
    // "proven to bill money".
    const forced = resolveLocalHarnessBinding(
      configWith({ profile: remote, allowUnverifiedLocality: true }),
    );
    expect(forced.status).toBe('REMOTE_COMPUTE');
    expect(forced.available).toBe(false);
  });

  it('Test E: unknown locality fails closed, and the override is explicit and recorded', () => {
    const unknown = harnessProfile({ computeLocality: 'unconfirmed' });
    const refused = resolveLocalHarnessBinding(configWith({ profile: unknown }));
    expect(refused.status).toBe('NOT_VERIFIED_LOCAL');
    expect(refused.available).toBe(false);

    const overridden = resolveLocalHarnessBinding(
      configWith({ profile: unknown, allowUnverifiedLocality: true }),
    );
    expect(overridden.status).toBe('BOUND');
    expect(overridden.localityOverridden).toBe(true);
    expect(overridden.problems[0]).toContain('allowUnverifiedLocality');
  });

  it('names every other refusal instead of failing silently', () => {
    expect(resolveLocalHarnessBinding(configWith({})).status).toBe('PROFILE_MISSING');
    expect(
      resolveLocalHarnessBinding(configWith({ profile: harnessProfile({ enabled: false }) })).status,
    ).toBe('PROFILE_DISABLED');
    expect(
      resolveLocalHarnessBinding(configWith({ profile: harnessProfile({ model: null }) })).status,
    ).toBe('PROFILE_INCOMPLETE');
    expect(
      resolveLocalHarnessBinding(
        configWith({ profile: harnessProfile({ workspaceBoundary: 'unconfirmed' }) }),
      ).status,
    ).toBe('BOUNDARY_UNCONFIRMED');
    expect(resolveLocalHarnessBinding(configWith({ harnessProfile: 'mock' })).status).toBe(
      'PROFILE_NOT_HARNESS',
    );
  });
});

// ---------------------------------------------------------------------------
// Execution shape
// ---------------------------------------------------------------------------

describe('execution-shape classification', () => {
  const shape = (title: string, extra: Record<string, unknown> = {}) =>
    classifyLocalExecutionShape({ taskId: '1', title, complexity: 'LOW', ...extra }).shape;

  it('classifies bounded transformations as ONE_SHOT', () => {
    expect(shape('Summarize the failing test log')).toBe('ONE_SHOT');
    expect(shape('Update the default timeout constant in src/config.ts')).toBe('ONE_SHOT');
    expect(shape('Add a validation helper', { taskCategory: 'validation' })).toBe('ONE_SHOT');
    expect(shape('Rank candidate files by relevance', { taskCategory: 'ranking' })).toBe('ONE_SHOT');
  });

  it('classifies tool-dependent work as AGENTIC', () => {
    expect(shape('Find where the settings store is initialized and fix the ordering')).toBe('AGENTIC');
    expect(shape('Wire up the exporter across the reporting and CLI packages')).toBe('AGENTIC');
    expect(shape('Make the failing integration tests pass')).toBe('AGENTIC');
    expect(shape('Update every caller of readConfig')).toBe('AGENTIC');
  });

  it('is independent of local suitability: shape asks about TOOLS, not difficulty', () => {
    // A LOCAL_SAFE-category task that still has to go looking.
    const assessment = classifyLocalExecutionShape({
      taskId: '2',
      title: 'Summarize the logs emitted across the worker modules',
      taskCategory: 'summarization',
      complexity: 'LOW',
    });
    expect(assessment.shape).toBe('AGENTIC');
    expect(assessment.signals[0]?.signal).toContain('agentic:');
  });

  it('lets recorded evidence override every keyword table', () => {
    const assessment = classifyLocalExecutionShape({
      taskId: '3',
      title: 'Update the default timeout constant',
      complexity: 'LOW',
      priorDirectFailureNeedsRepository: true,
    });
    expect(assessment.shape).toBe('AGENTIC');
    expect(assessment.signals[0]?.signal).toBe('prior-direct-failure-needs-repository');
  });

  it('is deterministic', () => {
    const once = classifyLocalExecutionShape({ taskId: '4', title: 'Refactor the reporting module', complexity: 'MEDIUM' });
    const twice = classifyLocalExecutionShape({ taskId: '4', title: 'Refactor the reporting module', complexity: 'MEDIUM' });
    expect(once).toEqual(twice);
  });
});

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

describe('local execution resolver', () => {
  const resolve = (options: Record<string, unknown>) =>
    resolveLocalExecutionMode({
      strategy: 'ADAPTIVE',
      suitability: 'LOCAL_TRY',
      shape: classifyLocalExecutionShape({ taskId: '1', title: 'Add a small validation helper', complexity: 'LOW' }),
      directAvailable: true,
      binding: bound(),
      localAttemptsUsed: 0,
      maxLocalAttempts: 2,
      ...options,
    } as Parameters<typeof resolveLocalExecutionMode>[0]);

  it('Test A: one-shot local work resolves to DIRECT_MODEL', () => {
    const resolution = resolve({});
    expect(resolution.mode).toBe('DIRECT_MODEL');
    expect(resolution.reasonCode).toBe('LOCAL_DIRECT_SELECTED');
    expect(resolution.harness).toBeNull();
  });

  it('Test B: agentic local work with a verified-local binding resolves to HARNESS', () => {
    const resolution = resolve({
      shape: classifyLocalExecutionShape({
        taskId: '2',
        title: 'Find the settings initialization and make the failing tests pass',
        complexity: 'LOW',
      }),
    });
    expect(resolution.mode).toBe('HARNESS');
    expect(resolution.reasonCode).toBe('LOCAL_HARNESS_SELECTED');
    expect(resolution.harness?.profileName).toBe('dsh-local');
    expect(resolution.harness?.locality).toBe('LOCAL');
  });

  it('Test P: DIRECT_ONLY keeps the vNext.2 path for agentic work too', () => {
    const resolution = resolve({
      strategy: 'DIRECT_ONLY',
      shape: classifyLocalExecutionShape({ taskId: '3', title: 'Wire up the exporter across packages', complexity: 'LOW' }),
    });
    expect(resolution.mode).toBe('DIRECT_MODEL');
    expect(resolution.reasonCode).toBe('LOCAL_DIRECT_ONLY_STRATEGY');
  });

  it('Test Q: HARNESS_ONLY forces the harness for eligible local task work', () => {
    const resolution = resolve({ strategy: 'HARNESS_ONLY' });
    expect(resolution.mode).toBe('HARNESS');
    expect(resolution.reasonCode).toBe('LOCAL_HARNESS_FORCED');
  });

  it('falls back to DIRECT when a preferred harness is unavailable, with the reason recorded', () => {
    const agentic = classifyLocalExecutionShape({
      taskId: '4',
      title: 'Explore the repository and fix the failing suite',
      complexity: 'LOW',
    });
    const missing = resolve({ shape: agentic, binding: unbound('NOT_CONFIGURED') });
    expect(missing.mode).toBe('DIRECT_MODEL');
    expect(missing.reasonCode).toBe('LOCAL_HARNESS_UNAVAILABLE');

    const unverified = resolve({ shape: agentic, binding: unbound('NOT_VERIFIED_LOCAL') });
    expect(unverified.mode).toBe('DIRECT_MODEL');
    expect(unverified.reasonCode).toBe('LOCAL_HARNESS_NOT_VERIFIED_LOCAL');

    const remote = resolve({ shape: agentic, binding: unbound('REMOTE_COMPUTE') });
    expect(remote.reasonCode).toBe('LOCAL_HARNESS_NOT_VERIFIED_LOCAL');
  });

  it('Test F: a recorded direct failure moves the SAME local budget to the harness', () => {
    const resolution = resolve({ directToHarnessEscalated: true, localAttemptsUsed: 1 });
    expect(resolution.mode).toBe('HARNESS');
    expect(resolution.reasonCode).toBe('LOCAL_DIRECT_TO_HARNESS_ESCALATION');
  });

  it('Test G: the local attempt budget is SHARED across modes, never doubled', () => {
    for (const strategy of ['DIRECT_ONLY', 'HARNESS_ONLY', 'ADAPTIVE'] as const) {
      const spent = resolve({ strategy, localAttemptsUsed: 2, maxLocalAttempts: 2 });
      expect(spent.outcome).toBe('LOCAL_UNAVAILABLE');
      expect(spent.mode).toBeNull();
      expect(spent.detail).toContain('2/2');
    }
    // One attempt left is one attempt, whichever mode already ran.
    expect(resolve({ localAttemptsUsed: 1, maxLocalAttempts: 2 }).outcome).toBe('RESOLVED');
  });

  it('Test 17: an explicit override chooses a mode but never bypasses locality', () => {
    const forced = resolve({ override: 'HARNESS', shape: classifyLocalExecutionShape({ taskId: '5', title: 'Summarize the log', complexity: 'LOW' }) });
    expect(forced.mode).toBe('HARNESS');
    expect(forced.reasonCode).toBe('LOCAL_HARNESS_FORCED');

    const refused = resolve({ override: 'HARNESS', binding: unbound('NOT_VERIFIED_LOCAL') });
    expect(refused.mode).toBe('DIRECT_MODEL');
    expect(refused.reasonCode).toBe('LOCAL_HARNESS_NOT_VERIFIED_LOCAL');

    const directOverride = resolve({
      override: 'DIRECT_MODEL',
      shape: classifyLocalExecutionShape({ taskId: '6', title: 'Explore the repository and repair the suite', complexity: 'LOW' }),
    });
    expect(directOverride.mode).toBe('DIRECT_MODEL');
  });

  it('uses the harness when the direct path is missing, and gives up when neither exists', () => {
    expect(resolve({ directAvailable: false }).mode).toBe('HARNESS');
    const nothing = resolve({ directAvailable: false, binding: unbound('NOT_CONFIGURED') });
    expect(nothing.outcome).toBe('LOCAL_UNAVAILABLE');
  });

  it('Test R: the adaptive matrix resolves as documented', () => {
    const rows: { title: string; category?: string; expected: string }[] = [
      { title: 'Summarize the failing test logs', category: 'summarization', expected: 'DIRECT_MODEL' },
      { title: 'Update the retry constant in src/config.ts', expected: 'DIRECT_MODEL' },
      { title: 'Implement the exporter across the reporting and CLI packages', expected: 'HARNESS' },
      { title: 'Investigate why the settings store loses values and fix it', expected: 'HARNESS' },
      { title: 'Make the failing regression tests pass', expected: 'HARNESS' },
    ];
    for (const row of rows) {
      const resolution = resolve({
        shape: classifyLocalExecutionShape({
          taskId: 'x',
          title: row.title,
          complexity: 'LOW',
          ...(row.category !== undefined ? { taskCategory: row.category } : {}),
        }),
      });
      expect(`${row.title} → ${resolution.mode}`).toBe(`${row.title} → ${row.expected}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

describe('local runtime observations', () => {
  const entry = (overrides: Partial<ExecutionLedgerEntry> & { attemptId: string }): ExecutionLedgerEntry =>
    ({
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: '1',
      role: 'EXECUTOR',
      provider: 'local-llamacpp',
      model: null,
      lane: 'LOCAL',
      status: 'COMPLETED',
      attemptNumber: 1,
      startedAt: '2026-08-21T10:00:00.000Z',
      completedAt: '2026-08-21T10:01:00.000Z',
      success: true,
      failureReason: null,
      localSuitability: 'LOCAL_TRY',
      taskComplexity: 'LOW',
      taskCategory: 'simple-change',
      schedulingDecisionId: null,
      executionMode: 'DIRECT_MODEL',
      executionShape: 'ONE_SHOT',
      computeLocality: 'LOCAL',
      metrics: {
        durationMs: 1_000,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        toolCalls: null,
        filesRead: null,
        filesChanged: null,
        costUsd: null,
        fiveHourQuotaBefore: null,
        fiveHourQuotaAfter: null,
        weeklyQuotaBefore: null,
        weeklyQuotaAfter: null,
        contextUsageBefore: null,
        contextUsageAfter: null,
        testLoops: null,
        commandRuns: null,
        compactions: null,
      },
      ...overrides,
    }) as ExecutionLedgerEntry;

  it('Test T: compares modes without inventing a metric nobody reported', () => {
    const observations = summarizeLocalRuntime([
      entry({ attemptId: 'a1' }),
      entry({ attemptId: 'a2', status: 'FAILED', success: false, failureReason: 'VERIFICATION_FAILURE' }),
      entry({
        attemptId: 'a3',
        nodeId: 'n2',
        taskId: '2',
        provider: 'dsh-local',
        executionMode: 'HARNESS',
        executionShape: 'AGENTIC',
        metrics: {
          ...entry({ attemptId: 'tmp' }).metrics,
          durationMs: 9_000,
          inputTokens: 4_000,
          outputTokens: 900,
          toolCalls: 6,
          commandRuns: 2,
        },
      }),
      entry({ attemptId: 'a4', nodeId: 'n3', taskId: '3', lane: 'SUBSCRIPTION', provider: 'claude-code', executionMode: null }),
    ]);

    expect(observations.byMode['DIRECT_MODEL']?.attempts).toBe(2);
    expect(observations.byMode['DIRECT_MODEL']?.verificationPassRate).toBe(0.5);
    expect(observations.byMode['DIRECT_MODEL']?.medianWallTimeMs).toBe(1_000);
    // Nothing reported tokens or tool calls for the direct attempts.
    expect(observations.byMode['DIRECT_MODEL']?.medianInputTokens).toBeNull();
    expect(observations.byMode['DIRECT_MODEL']?.medianToolCalls).toBeNull();
    expect(observations.byMode['DIRECT_MODEL']?.reporting.tokens).toBe(0);

    expect(observations.byMode['HARNESS']?.attempts).toBe(1);
    expect(observations.byMode['HARNESS']?.medianWallTimeMs).toBe(9_000);
    expect(observations.byMode['HARNESS']?.medianToolCalls).toBe(6);
    expect(observations.byMode['HARNESS']?.medianCommandRuns).toBe(2);

    expect(observations.totalLocalAttempts).toBe(3);
    expect(observations.localTasks).toBe(2);
    // A subscription attempt on a node that never ran locally is not an
    // escalation; it is simply strong work.
    expect(observations.localToStrongEscalations).toBe(0);
  });

  it('counts a local task that later ran on the subscription lane as an escalation', () => {
    const observations = summarizeLocalRuntime([
      entry({ attemptId: 'a1', status: 'FAILED', success: false }),
      entry({ attemptId: 'a2', lane: 'SUBSCRIPTION', provider: 'claude-code', executionMode: null, attemptNumber: 2 }),
    ]);
    expect(observations.localToStrongEscalations).toBe(1);
    expect(observations.byCategory[0]?.strongAttempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lane-before-mode ordering (HARVEST regression)
// ---------------------------------------------------------------------------

describe('Test O: the lane decision is untouched by vNext.4', () => {
  const policy = jobSchedulerPolicySchema.parse({});
  const forecastAt = (options: {
    fiveHourRemaining: number;
    resetInMs: number;
    weeklyRemaining: number;
  }) => {
    const now = new Date('2026-08-21T09:00:00.000Z');
    return buildQuotaForecast({
      fiveHour: {
        window: 'five-hour',
        remainingRatio: options.fiveHourRemaining,
        usedRatio: null,
        resetAt: new Date(now.getTime() + options.resetInMs).toISOString(),
        observedAt: now.toISOString(),
        source: 'test',
      },
      weekly: {
        window: 'weekly',
        remainingRatio: options.weeklyRemaining,
        usedRatio: null,
        resetAt: new Date(now.getTime() + 86_400_000).toISOString(),
        observedAt: now.toISOString(),
        source: 'test',
      },
      now,
      policy,
    });
  };
  const route = (suitability: 'LOCAL_TRY' | 'STRONG_REQUIRED', forecast: ReturnType<typeof forecastAt>) =>
    decideLane({
      estimate: estimateWorkload({
        taskId: '1',
        complexity: 'LOW',
        localSuitability: suitability,
        taskCategory: 'general',
        policy: policy.estimator,
        observations: [],
      }),
      forecast,
      reserveRatio: 0.1,
      localWorkerAvailable: true,
      localExecutionAvailable: true,
      policy,
    });

  it('still HARVESTs expiring capacity for strong work, harness or no harness', () => {
    // A bound, verified, idle local harness is irrelevant here: the lane
    // decision cannot see it, which is exactly the guarantee.
    const harvest = forecastAt({ fiveHourRemaining: 0.6, resetInMs: 20 * 60_000, weeklyRemaining: 0.8 });
    expect(harvest.schedulerMode).toBe('HARVEST');
    const strong = route('STRONG_REQUIRED', harvest);
    expect(strong.lane).toBe('SUBSCRIPTION');
    expect(strong.reasonCode).toBe('HARVEST_EXPIRING_CAPACITY');
  });

  it('still sends local-capable work local during HARVEST', () => {
    const harvest = forecastAt({ fiveHourRemaining: 0.6, resetInMs: 20 * 60_000, weeklyRemaining: 0.8 });
    const local = route('LOCAL_TRY', harvest);
    expect(local.lane).toBe('LOCAL');
    expect(local.reasonCode).toBe('LOCAL_TRY_FIRST');
  });

  it('still defers strong work when the five-hour window is exhausted, and keeps local work running', () => {
    const exhausted = forecastAt({ fiveHourRemaining: 0, resetInMs: 3 * 3_600_000, weeklyRemaining: 0.8 });
    expect(exhausted.schedulerMode).toBe('EXHAUSTED_5H');
    expect(route('STRONG_REQUIRED', exhausted).lane).toBe('DEFER');
    expect(route('LOCAL_TRY', exhausted).lane).toBe('LOCAL');
  });

  it('carries no execution-mode input at all: mode is resolved AFTER the lane', () => {
    const harvest = forecastAt({ fiveHourRemaining: 0.6, resetInMs: 20 * 60_000, weeklyRemaining: 0.8 });
    const routing = route('LOCAL_TRY', harvest);
    // The lane routing object is mode-free; NodeLaneRouting adds the mode
    // later, and only for the LOCAL lane.
    expect(Object.keys(routing).sort()).toEqual(
      ['admission', 'compactFirst', 'deferUntil', 'detail', 'lane', 'reasonCode'].sort(),
    );
  });
});
