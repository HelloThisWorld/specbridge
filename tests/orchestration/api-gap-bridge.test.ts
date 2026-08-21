import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiExecutionPolicySchema,
  deepseekHarnessProfileSchema,
  defaultResolvedAgentConfig,
  jobSchedulerPolicySchema,
  resolveWorkspace,
} from '@specbridge/core';
import type {
  AgentConfig,
  ApiPricingProfile,
  DeepSeekHarnessProfileConfig,
  WorkspaceInfo,
} from '@specbridge/core';
import {
  applyApiGapBridge,
  assessApiBudget,
  assessDelaySensitivity,
  buildSubscriptionGapForecast,
  checkApiSpendApproval,
  computeObservedApiCost,
  decideApiSpendApproval,
  decideLane,
  estimateApiCost,
  estimateWorkload,
  listApiSpendApprovals,
  planApiGapBridge,
  readApiBudgetState,
  reconcileApiBudget,
  reconcileInterruptedApiReservations,
  releaseApiBudget,
  requestApiSpendApproval,
  reserveApiBudget,
  resolveApiHarnessBinding,
  resolveLocalHarnessBinding,
  selectReadyCandidate,
  subscriptionGapReasonFor,
  summarizeApiBudget,
  taskSpendFingerprint,
} from '@specbridge/orchestration';
import type {
  ApiBudgetState,
  ApiGapBridgePlan,
  DelaySensitivityAssessment,
  JobGraph,
  LaneRoutingInput,
  QuotaForecast,
  SubscriptionGapForecast,
  WorkloadEstimate,
} from '@specbridge/orchestration';

/**
 * vNext.5 API Gap Bridge — the pure policy layer, fully offline.
 *
 * No network, no provider, no API key, no real pricing, no clock. Every
 * scenario is a value in and a decision out, so the economic policy this
 * phase encodes is replayable byte-for-byte, in a test, forever:
 *
 *   Can Local finish it?          → LOCAL
 *   Can prepaid Max execute it?   → SUBSCRIPTION
 *   Will Max return soon enough?  → wait / do other local work
 *   Is it worth bridging, is
 *   spending authorized, is cost
 *   known, is budget available?   → API
 *   otherwise                     → remain durably pending
 *
 * The tests are ordered so that the ones proving SpecBridge does NOT spend
 * come first. That is deliberate: they are the ones that run in production.
 */

const NOW = new Date('2026-08-22T12:00:00.000Z');

const PRICING: ApiPricingProfile = {
  inputCostPerMillion: 1,
  outputCostPerMillion: 4,
  cachedInputCostPerMillion: 0.1,
  currency: 'USD',
  source: 'test-fixture-price-table',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can hold a handle briefly; the OS temp dir is swept anyway.
    }
  }
});

function dshProfile(
  overrides: Partial<DeepSeekHarnessProfileConfig> = {},
): DeepSeekHarnessProfileConfig {
  return deepseekHarnessProfileSchema.parse({
    runner: 'deepseek-harness',
    enabled: true,
    command: { executable: 'dsh-jsonrpc-agent', args: [] },
    provider: 'remote-provider',
    model: 'remote-model',
    workspaceBoundary: 'runtime-profile',
    // Verified REMOTE: an attested, structurally non-loopback endpoint.
    computeLocality: 'loopback-endpoint',
    providerEndpoint: 'https://api.example-provider.test/v1',
    environmentPassthrough: ['EXAMPLE_PROVIDER_API_KEY'],
    ...overrides,
  });
}

function config(
  overrides: {
    api?: Record<string, unknown>;
    localHarnessProfile?: string | null;
    profiles?: Record<string, DeepSeekHarnessProfileConfig>;
  } = {},
): AgentConfig {
  const base = defaultResolvedAgentConfig();
  const scheduler = jobSchedulerPolicySchema.parse({
    ...base.orchestration.jobs.scheduler,
    localExecution: {
      ...base.orchestration.jobs.scheduler.localExecution,
      harnessProfile:
        overrides.localHarnessProfile === undefined ? null : overrides.localHarnessProfile,
    },
    api: apiExecutionPolicySchema.parse({
      spendMode: 'AUTO_BOUNDED',
      harnessProfile: 'dsh-remote',
      pricing: PRICING,
      budget: { maxCostPerJobUsd: 10 },
      ...(overrides.api ?? {}),
    }),
  });
  return {
    ...base,
    runnerProfiles: {
      ...base.runnerProfiles,
      'dsh-remote': dshProfile(),
      'dsh-local': dshProfile({
        provider: 'local-provider',
        model: 'local-qwen',
        providerEndpoint: 'http://127.0.0.1:8080/v1',
        environmentPassthrough: [],
      }),
      ...(overrides.profiles ?? {}),
    },
    orchestration: {
      ...base.orchestration,
      jobs: { ...base.orchestration.jobs, scheduler },
    },
  };
}

function estimate(overrides: Partial<WorkloadEstimate> = {}): WorkloadEstimate {
  return {
    ...estimateWorkload({
      taskId: 'task-1',
      complexity: 'MEDIUM',
      localSuitability: 'STRONG_REQUIRED',
      policy: config().orchestration.jobs.scheduler.estimator,
    }),
    ...overrides,
  };
}

function gap(overrides: Partial<SubscriptionGapForecast> = {}): SubscriptionGapForecast {
  return {
    reason: 'FIVE_HOUR_EXHAUSTED',
    expectedAvailableAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
    timeUntilAvailableMs: 90 * 60_000,
    confidence: 'HIGH',
    detail: 'test gap',
    ...overrides,
  };
}

function sensitivity(
  overrides: Partial<DelaySensitivityAssessment> = {},
): DelaySensitivityAssessment {
  return {
    level: 'HIGH',
    blockedDependents: 3,
    criticalPath: true,
    readyLocalBacklog: 0,
    readyAlternatives: 0,
    signals: [{ signal: 'critical-path', evidence: 'test' }],
    ...overrides,
  };
}

/** Build a complete planner input, then let each test perturb one thing. */
function plan(
  overrides: {
    config?: AgentConfig;
    gap?: Partial<SubscriptionGapForecast>;
    sensitivity?: Partial<DelaySensitivityAssessment>;
    estimate?: Partial<WorkloadEstimate>;
    pricing?: ApiPricingProfile | null;
    budgetState?: ApiBudgetState;
    approvals?: Parameters<typeof checkApiSpendApproval>[0]['approvals'];
    subscriptionAvailable?: boolean;
  } = {},
): ApiGapBridgePlan {
  const resolved = overrides.config ?? config();
  const apiPolicy = {
    ...resolved.orchestration.jobs.scheduler.api,
    ...(overrides.pricing !== undefined ? { pricing: overrides.pricing } : {}),
  };
  const binding = resolveApiHarnessBinding(resolved);
  const workload = estimate(overrides.estimate ?? {});
  const cost = estimateApiCost({
    estimate: workload,
    pricing: apiPolicy.pricing,
    safetyMultiplier: apiPolicy.gap.costSafetyMultiplier,
  });
  const state: ApiBudgetState = overrides.budgetState ?? {
    schemaVersion: '1.0.0',
    jobId: 'job-1',
    reservations: [],
    updatedAt: NOW.toISOString(),
  };
  return planApiGapBridge({
    policy: apiPolicy,
    binding,
    gap: gap(overrides.gap ?? {}),
    delaySensitivity: sensitivity(overrides.sensitivity ?? {}),
    estimate: workload,
    cost,
    budget: assessApiBudget({
      state,
      policy: apiPolicy.budget,
      taskId: 'task-1',
      safeCostUsd: cost.safeCostUsd,
    }),
    approval:
      overrides.approvals === undefined
        ? null
        : checkApiSpendApproval({
            approvals: overrides.approvals,
            nodeId: 'n1',
            taskFingerprint: 'fp-a',
            profileName: 'dsh-remote',
            safeCostUsd: cost.safeCostUsd,
            now: NOW,
          }),
    subscriptionAvailable: overrides.subscriptionAvailable ?? false,
    now: NOW,
  });
}

function workspaceFixture(): WorkspaceInfo {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-api-budget-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, '.kiro', 'specs'), { recursive: true });
  mkdirSync(path.join(root, '.specbridge'), { recursive: true });
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('workspace not resolved');
  return workspace;
}

// ---------------------------------------------------------------------------
// The lane vocabulary and the economic ordering
// ---------------------------------------------------------------------------

describe('vNext.5 economic lane model', () => {
  it('Test X: decideLane is untouched by vNext.5 — it still knows only LOCAL, SUBSCRIPTION, and DEFER', () => {
    // The paid lane must be structurally unable to compete with the free and
    // prepaid ones. It cannot, because the function that chooses between
    // them has no way to name it.
    const forecast: QuotaForecast = {
      fiveHourRemainingRatio: 0,
      fiveHourResetAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
      timeToFiveHourResetMs: 90 * 60_000,
      weeklyRemainingRatio: 0.5,
      weeklyResetAt: null,
      timeToWeeklyResetMs: null,
      observedFiveHourBurnRatePerMinute: null,
      projectedBurnUntilFiveHourReset: null,
      schedulerMode: 'EXHAUSTED_5H',
      telemetryFreshness: 'FRESH',
      observedAt: NOW.toISOString(),
      forecastAt: NOW.toISOString(),
    };
    const input: LaneRoutingInput = {
      estimate: estimate(),
      forecast,
      reserveRatio: 0.05,
      localWorkerAvailable: false,
      localExecutionAvailable: false,
      policy: config().orchestration.jobs.scheduler,
    };
    const routing = decideLane(input);
    expect(routing.lane).toBe('DEFER');
    expect(routing.reasonCode).toBe('FIVE_HOUR_EXHAUSTED');
    // Only the explicit bridge step can turn a defer into paid work.
    const bridged = applyApiGapBridge(routing, plan());
    expect(bridged.lane).toBe('API');
    expect(routing.lane).toBe('DEFER'); // the original value is untouched
  });

  it('only subscription-CAPACITY defers are eligible for bridging', () => {
    expect(subscriptionGapReasonFor('FIVE_HOUR_EXHAUSTED')).toBe('FIVE_HOUR_EXHAUSTED');
    expect(subscriptionGapReasonFor('WEEKLY_EXHAUSTED')).toBe('WEEKLY_EXHAUSTED');
    expect(subscriptionGapReasonFor('PRE_RESET_BURN_UNSAFE')).toBe('PRE_RESET_BURN_UNSAFE');
    expect(subscriptionGapReasonFor('CONSERVE_QUOTA')).toBe('SUBSCRIPTION_TEMPORARILY_UNAVAILABLE');
    // A local escalation, a compaction requirement, or a routed-strong task
    // is not a quota gap and must never reach the paid planner.
    expect(subscriptionGapReasonFor('LOCAL_ESCALATION_REQUIRED')).toBeUndefined();
    expect(subscriptionGapReasonFor('COMPACT_BEFORE_EXECUTION')).toBeUndefined();
    expect(subscriptionGapReasonFor('LOCAL_SAFE')).toBeUndefined();
  });

  it('free and prepaid ready work is selected before an API-bridged task', () => {
    const routing = (lane: 'LOCAL' | 'API' | 'SUBSCRIPTION') => ({
      lane,
      reasonCode: 'STRONG_REQUIRED' as const,
      compactFirst: false,
      deferUntil: null,
      admission: null,
      detail: '',
    });
    const selection = selectReadyCandidate([
      { nodeId: 'paid', graphIndex: 0, routing: routing('API') },
      { nodeId: 'free', graphIndex: 1, routing: routing('LOCAL') },
    ]);
    expect(selection?.nodeId).toBe('free');
    expect(selection?.reason).toContain('spends no money');
  });

  it('a task awaiting approval is never treated as runnable', () => {
    const selection = selectReadyCandidate([
      {
        nodeId: 'awaiting',
        graphIndex: 0,
        routing: {
          lane: 'REQUIRE_APPROVAL',
          reasonCode: 'API_APPROVAL_REQUIRED',
          compactFirst: false,
          deferUntil: null,
          admission: null,
          detail: '',
        },
      },
    ]);
    expect(selection?.reason).toContain('defers');
  });
});

// ---------------------------------------------------------------------------
// Bindings must be mutually honest
// ---------------------------------------------------------------------------

describe('vNext.5 API harness binding', () => {
  it('Test W: a remote API binding fails the LOCAL locality check, and a verified-local profile is refused for the paid lane', () => {
    const remoteBoundToApi = config();
    expect(resolveApiHarnessBinding(remoteBoundToApi).status).toBe('BOUND');
    expect(resolveApiHarnessBinding(remoteBoundToApi).locality).toBe('REMOTE');

    // The same remote profile bound to the LOCAL lane is refused outright.
    const remoteBoundToLocal = config({ localHarnessProfile: 'dsh-remote' });
    const localBinding = resolveLocalHarnessBinding(remoteBoundToLocal);
    expect(localBinding.status).toBe('REMOTE_COMPUTE');
    expect(localBinding.available).toBe(false);

    // And a verified-LOCAL profile bound to the API lane is refused too:
    // paying a metered rate to a loopback endpoint is a configuration
    // mistake with an invoice, not a continuity bridge.
    const localBoundToApi = config({ api: { harnessProfile: 'dsh-local' } });
    const apiBinding = resolveApiHarnessBinding(localBoundToApi);
    expect(apiBinding.status).toBe('LOCAL_COMPUTE');
    expect(apiBinding.available).toBe(false);
    expect(apiBinding.problems[0]).toContain('never serve the metered API lane');
  });

  it('refuses one profile serving both economies', () => {
    const shared = config({ localHarnessProfile: 'dsh-remote', api: { harnessProfile: 'dsh-remote' } });
    const binding = resolveApiHarnessBinding(shared);
    expect(binding.status).toBe('BOUND_TO_LOCAL_LANE');
    expect(binding.available).toBe(false);
  });

  it('an unverified (UNKNOWN) profile qualifies for neither lane by default', () => {
    const profiles = {
      'dsh-unknown': dshProfile({ computeLocality: 'unconfirmed', providerEndpoint: null }),
    };
    const boundToApi = config({ profiles, api: { harnessProfile: 'dsh-unknown' } });
    const apiBinding = resolveApiHarnessBinding(boundToApi);
    expect(apiBinding.status).toBe('NOT_VERIFIED_REMOTE');
    expect(apiBinding.available).toBe(false);

    const boundToLocal = config({ profiles, localHarnessProfile: 'dsh-unknown' });
    const localBinding = resolveLocalHarnessBinding(boundToLocal);
    expect(localBinding.status).toBe('NOT_VERIFIED_LOCAL');
    expect(localBinding.available).toBe(false);
  });

  it('installation and binding are separate from authorization', () => {
    // Bound and verified — but spend is DISABLED, so nothing may be spent.
    const disabled = config({ api: { spendMode: 'DISABLED' } });
    const binding = resolveApiHarnessBinding(disabled);
    expect(binding.available).toBe(true);
    expect(binding.spendMode).toBe('DISABLED');
    expect(plan({ config: disabled }).decision).toBe('DEFER');
  });

  it('records credential SOURCES for the paid lane without reading values', () => {
    const binding = resolveApiHarnessBinding(config());
    expect(binding.credentialSources).toEqual(['EXAMPLE_PROVIDER_API_KEY']);
    // Names only — nothing in the record resembles a value.
    expect(JSON.stringify(binding)).not.toContain('sk-');
  });
});

// ---------------------------------------------------------------------------
// The decisions that do NOT spend
// ---------------------------------------------------------------------------

describe('vNext.5 gap-bridge refusals', () => {
  it('Test A: API disabled means the task waits durably, with no paid dispatch', () => {
    const result = plan({ config: config({ api: { spendMode: 'DISABLED' } }) });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_DISABLED');
    expect(result.bridgeProposed).toBe(false);
  });

  it('Test D: a short gap on non-urgent work defers, and costs nothing', () => {
    const result = plan({
      gap: { timeUntilAvailableMs: 10 * 60_000 },
      sensitivity: { level: 'LOW', criticalPath: false, blockedDependents: 0 },
    });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_GAP_SHORT_DEFER');
  });

  it('Test E: while subscription capacity is available, the paid lane is not considered at all', () => {
    const result = plan({ subscriptionAvailable: true });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_MAX_RETURNED_NEXT_TASK_SUBSCRIPTION');
  });

  it('Test H: an unsafe pre-reset burn with a short reset defers to the reset, never to the API', () => {
    const result = plan({
      gap: { reason: 'PRE_RESET_BURN_UNSAFE', timeUntilAvailableMs: 12 * 60_000 },
      sensitivity: { level: 'LOW', criticalPath: false, blockedDependents: 0 },
    });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_GAP_SHORT_DEFER');
    expect(result.deferUntil).not.toBeNull();
  });

  it('Test K: unknown cost never authorizes automatic spend, and is never treated as zero', () => {
    const result = plan({ pricing: null });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_COST_UNKNOWN');
    expect(result.cost?.estimatedCostUsd).toBeNull();
    expect(result.cost?.safeCostUsd).toBeNull();
    // The refusal happened AFTER the gap was judged worth bridging: the
    // reason a user sees is the true one, not a generic "not now".
    expect(result.bridgeProposed).toBe(true);
    expect(result.detail).toContain('would justify bridging');
  });

  it('Test L: a safe estimate above the remaining budget does not dispatch', () => {
    const expensive = config({ api: { budget: { maxCostPerJobUsd: 0.01 } } });
    const result = plan({ config: expensive });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_BUDGET_EXCEEDED');
  });

  it('mechanical local-capable work stays local even during a total outage', () => {
    const result = plan({
      estimate: { localSuitability: 'LOCAL_SAFE' },
      gap: { reason: 'WEEKLY_EXHAUSTED', timeUntilAvailableMs: 36 * 3_600_000 },
    });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_STRONG_TASK_ONLY');
  });

  it('prefers ready local work over paying to bridge a non-critical task', () => {
    const result = plan({
      sensitivity: {
        level: 'HIGH',
        criticalPath: false,
        blockedDependents: 2,
        readyLocalBacklog: 3,
      },
    });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_LOCAL_BACKLOG_FIRST');
  });

  it('refuses a paid start that prepaid capacity would mostly absorb anyway', () => {
    // Max back in 8 minutes; the task needs 70. Starting paid work buys a
    // few minutes of head start for the price of the whole attempt.
    const result = plan({
      gap: { timeUntilAvailableMs: 8 * 60_000 },
      estimate: { expectedWallTimeMs: 70 * 60_000 },
      sensitivity: { level: 'MEDIUM', criticalPath: false, blockedDependents: 1 },
      config: config({ api: { gap: { shortGapDeferMs: 0, minDelaySensitivity: 'MEDIUM' } } }),
    });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_WASTEFUL_NEAR_RESET');
  });

  it('an unknown reset time increases caution rather than justifying spend', () => {
    const deferPolicy = config({ api: { gap: { unknownResetBehavior: 'DEFER' } } });
    const deferred = plan({
      config: deferPolicy,
      gap: { expectedAvailableAt: null, timeUntilAvailableMs: null, confidence: 'UNKNOWN' },
    });
    expect(deferred.decision).toBe('DEFER');

    // Under the default the unknown escalates to a human, never to a charge.
    const escalated = plan({
      gap: { expectedAvailableAt: null, timeUntilAvailableMs: null, confidence: 'UNKNOWN' },
    });
    expect(escalated.decision).toBe('REQUIRE_APPROVAL');
    expect(escalated.reasonCode).toBe('API_APPROVAL_REQUIRED');
  });

  it('an explicit human denial stands even under AUTO_BOUNDED', () => {
    const denied = [
      {
        schemaVersion: '1.0.0',
        approvalId: 'aa-1',
        jobId: 'job-1',
        nodeId: 'n1',
        taskId: 'task-1',
        taskFingerprint: 'fp-a',
        profileName: 'dsh-remote',
        maxAuthorizedCostUsd: 5,
        currency: 'USD' as const,
        estimatedCostUsd: 1,
        status: 'DENIED' as const,
        rationale: '',
        requestedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        decidedAt: NOW.toISOString(),
        decidedBy: 'operator',
        decisionNote: 'not worth it',
        consumedByAttemptId: null,
      },
    ];
    const result = plan({ approvals: denied });
    expect(result.decision).toBe('DEFER');
    expect(result.reasonCode).toBe('API_APPROVAL_REQUIRED');
    expect(result.detail).toContain('explicitly denied');
  });
});

// ---------------------------------------------------------------------------
// The decisions that DO spend
// ---------------------------------------------------------------------------

describe('vNext.5 gap-bridge selection', () => {
  it('Test C: a 90-minute gap on critical work with known cost and healthy budget selects API', () => {
    const result = plan();
    expect(result.decision).toBe('API');
    expect(result.reasonCode).toBe('API_GAP_BRIDGE_SELECTED');
    expect(result.cost?.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.budget?.admissible).toBe(true);
  });

  it('Test I: a weekly exhaustion (36 hours) is a materially larger gap and bridges', () => {
    const result = plan({
      gap: { reason: 'WEEKLY_EXHAUSTED', timeUntilAvailableMs: 36 * 3_600_000 },
    });
    expect(result.decision).toBe('API');
    expect(result.reasonCode).toBe('API_WEEKLY_GAP_BRIDGE');
  });

  it('a weekly gap is not treated like a five-hour cooldown of the same policy shape', () => {
    // Identical inputs except the gap CAUSE: a weekly outage bridges even
    // with local work ready, because the wait is measured in days.
    const shared = { sensitivity: { readyLocalBacklog: 4, criticalPath: false, level: 'HIGH' as const } };
    const fiveHour = plan({ ...shared, gap: { reason: 'FIVE_HOUR_EXHAUSTED' } });
    const weekly = plan({
      ...shared,
      gap: { reason: 'WEEKLY_EXHAUSTED', timeUntilAvailableMs: 36 * 3_600_000 },
    });
    expect(fiveHour.decision).toBe('DEFER');
    expect(weekly.decision).toBe('API');
  });

  it('Test B: MANUAL mode concludes bridging would help and asks, without spending', () => {
    const result = plan({ config: config({ api: { spendMode: 'MANUAL' } }) });
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.reasonCode).toBe('API_APPROVAL_REQUIRED');
    // The request explains WHY: the gap, its duration, the sensitivity, the
    // estimated cost. That is what makes an approval a decision, not a click.
    expect(result.detail).toContain('FIVE_HOUR_EXHAUSTED');
    expect(result.detail).toContain('1.5h');
    expect(result.detail).toContain('delay sensitivity is HIGH');
    expect(result.detail).toMatch(/\$\d/);
  });

  it('MANUAL mode with a valid bounded approval proceeds', () => {
    const approved = [
      {
        schemaVersion: '1.0.0',
        approvalId: 'aa-1',
        jobId: 'job-1',
        nodeId: 'n1',
        taskId: 'task-1',
        taskFingerprint: 'fp-a',
        profileName: 'dsh-remote',
        maxAuthorizedCostUsd: 5,
        currency: 'USD' as const,
        estimatedCostUsd: 1,
        status: 'APPROVED' as const,
        rationale: '',
        requestedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        decidedAt: NOW.toISOString(),
        decidedBy: 'operator',
        decisionNote: null,
        consumedByAttemptId: null,
      },
    ];
    const result = plan({ config: config({ api: { spendMode: 'MANUAL' } }), approvals: approved });
    expect(result.decision).toBe('API');
    expect(result.approval?.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

describe('vNext.5 cost estimation', () => {
  it('prices a workload from the configured table and applies the safety multiplier', () => {
    const cost = estimateApiCost({
      estimate: {
        expectedInputTokens: 1_000_000,
        expectedOutputTokens: 100_000,
        tokenBasis: 'heuristic',
        confidence: 'low',
      },
      pricing: PRICING,
      safetyMultiplier: 1.5,
    });
    // 1M input at $1/M + 100k output at $4/M = $1.40
    expect(cost.estimatedCostUsd).toBeCloseTo(1.4, 4);
    expect(cost.safeCostUsd).toBeCloseTo(2.1, 4);
    expect(cost.costSource).toBe('ESTIMATED_PRE_DISPATCH');
    expect(cost.pricingSource).toBe('test-fixture-price-table');
  });

  it('reports UNKNOWN rather than zero when pricing or token data is missing', () => {
    const noPricing = estimateApiCost({
      estimate: { expectedInputTokens: 1000, expectedOutputTokens: 100, tokenBasis: 'heuristic', confidence: 'low' },
      pricing: null,
      safetyMultiplier: 1.5,
    });
    expect(noPricing.estimatedCostUsd).toBeNull();
    expect(noPricing.costSource).toBe('UNKNOWN');

    const noTokens = estimateApiCost({
      estimate: { expectedInputTokens: null, expectedOutputTokens: null, tokenBasis: 'unknown', confidence: 'low' },
      pricing: PRICING,
      safetyMultiplier: 1.5,
    });
    expect(noTokens.estimatedCostUsd).toBeNull();
  });

  it('distinguishes provider-reported cost from cost computed over a price table', () => {
    const reported = computeObservedApiCost({
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.42 },
      pricing: PRICING,
    });
    expect(reported.source).toBe('PROVIDER_REPORTED');
    expect(reported.costUsd).toBeCloseTo(0.42, 4);

    const computed = computeObservedApiCost({
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      pricing: PRICING,
    });
    expect(computed.source).toBe('COMPUTED_FROM_USAGE');
    expect(computed.costUsd).toBeCloseTo(1.4, 4);
    expect(computed.detail).toContain('price table');
  });

  it('Test O: an interrupted attempt records UNKNOWN cost, never $0', () => {
    const interrupted = computeObservedApiCost({ pricing: PRICING, interrupted: true });
    expect(interrupted.costUsd).toBeNull();
    expect(interrupted.source).toBe('UNKNOWN');
    expect(interrupted.detail).toContain('cannot be ruled out');
  });

  it('prices cached input at the cached rate without double-counting it', () => {
    const cached = computeObservedApiCost({
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 },
      pricing: PRICING,
    });
    // 100k uncached at $1/M + 900k cached at $0.10/M = $0.19
    expect(cached.costUsd).toBeCloseTo(0.19, 4);
  });

  it('the workload profiler supplies token expectations with an honest basis', () => {
    const workload = estimateWorkload({
      taskId: 't',
      complexity: 'HIGH',
      localSuitability: 'STRONG_REQUIRED',
      policy: config().orchestration.jobs.scheduler.estimator,
    });
    expect(workload.expectedInputTokens).toBeGreaterThan(0);
    expect(workload.tokenBasis).toBe('heuristic');
  });
});

// ---------------------------------------------------------------------------
// Budget: reservation, reconciliation, crash integrity
// ---------------------------------------------------------------------------

describe('vNext.5 API budget controller', () => {
  const budgetPolicy = {
    maxCostPerJobUsd: 10,
    maxCostPerTaskUsd: null,
    maxCostPerAttemptUsd: null,
    maxApiAttemptsPerTask: 2,
    maxApiAttemptsPerJob: 20,
  };

  it('Test M: two eligible tasks cannot both reserve the same remaining budget', () => {
    const workspace = workspaceFixture();
    const reserve = (nodeId: string, id: string) =>
      reserveApiBudget({
        workspace: workspace,
        jobId: 'job-1',
        nodeId,
        taskId: nodeId,
        policy: budgetPolicy,
        safeCostUsd: 7,
        profileName: 'dsh-remote',
        now: NOW,
        reservationId: id,
      });
    const first = reserve('n1', 'ar-1');
    const second = reserve('n2', 'ar-2');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.admission.refusal).toBe('JOB_CEILING');
    // No $14 overcommit against a $10 ceiling.
    const summary = summarizeApiBudget(readApiBudgetState(workspace, 'job-1'), budgetPolicy);
    expect(summary.encumberedUsd).toBe(7);
    expect(summary.remainingUsd).toBe(3);
  });

  it('Test N: reserving $5 and observing $3 reconciles correctly without losing history', () => {
    const workspace = workspaceFixture();
    const reserved = reserveApiBudget({
      workspace: workspace,
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: 'task-1',
      policy: budgetPolicy,
      safeCostUsd: 5,
      profileName: 'dsh-remote',
      now: NOW,
      reservationId: 'ar-1',
    });
    expect(reserved.ok).toBe(true);
    const reconciled = reconcileApiBudget({
      workspace: workspace,
      jobId: 'job-1',
      reservationId: 'ar-1',
      observedCostUsd: 3,
      costSource: 'COMPUTED_FROM_USAGE',
      now: NOW,
    });
    expect(reconciled.state).toBe('COMMITTED');
    // The estimate is preserved alongside the reconciled figure: an audit
    // can still see what was authorized versus what was spent.
    expect(reconciled.reservedUsd).toBe(5);
    expect(reconciled.reconciledUsd).toBe(3);
    expect(reconciled.costSource).toBe('COMPUTED_FROM_USAGE');
    const summary = summarizeApiBudget(readApiBudgetState(workspace, 'job-1'), budgetPolicy);
    expect(summary.committedUsd).toBe(3);
    expect(summary.remainingUsd).toBe(7);
  });

  it('Test O: a crash leaves the hold charged as UNKNOWN, never silently released', () => {
    const workspace = workspaceFixture();
    reserveApiBudget({
      workspace: workspace,
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: 'task-1',
      policy: budgetPolicy,
      safeCostUsd: 4,
      profileName: 'dsh-remote',
      now: NOW,
      reservationId: 'ar-1',
    });
    const reconciled = reconcileInterruptedApiReservations(workspace, 'job-1', NOW);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.state).toBe('UNKNOWN');
    const summary = summarizeApiBudget(readApiBudgetState(workspace, 'job-1'), budgetPolicy);
    expect(summary.unknownUsd).toBe(4);
    expect(summary.encumberedUsd).toBe(4);
    expect(summary.hasUnknownCost).toBe(true);
    // And the committed total is honestly labeled as a floor.
    expect(summary.committedUsd).toBe(0);
  });

  it('refuses to release a reservation bound to an attempt that started', () => {
    const workspace = workspaceFixture();
    reserveApiBudget({
      workspace: workspace,
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: 'task-1',
      policy: budgetPolicy,
      safeCostUsd: 4,
      profileName: 'dsh-remote',
      now: NOW,
      reservationId: 'ar-1',
    });
    // Never dispatched: releasing is legitimate.
    const released = releaseApiBudget(workspace, 'job-1', 'ar-1', NOW, 'refused before dispatch');
    expect(released.state).toBe('RELEASED');
    expect(summarizeApiBudget(readApiBudgetState(workspace, 'job-1'), budgetPolicy).encumberedUsd).toBe(0);
  });

  it('bounds API attempts per task independently of cost', () => {
    const state: ApiBudgetState = {
      schemaVersion: '1.0.0',
      jobId: 'job-1',
      reservations: [1, 2].map((n) => ({
        reservationId: `ar-${n}`,
        jobId: 'job-1',
        nodeId: 'n1',
        taskId: 'task-1',
        attemptId: `ta-${n}`,
        state: 'COMMITTED' as const,
        reservedUsd: 0.01,
        reconciledUsd: 0.01,
        costSource: 'COMPUTED_FROM_USAGE' as const,
        profileName: 'dsh-remote',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        detail: '',
      })),
      updatedAt: NOW.toISOString(),
    };
    const admission = assessApiBudget({
      state,
      policy: budgetPolicy,
      taskId: 'task-1',
      safeCostUsd: 0.01,
    });
    expect(admission.admissible).toBe(false);
    expect(admission.refusal).toBe('TASK_ATTEMPTS');
  });

  it('a null safe cost is refused, because unknown is not a small number', () => {
    const admission = assessApiBudget({
      state: { schemaVersion: '1.0.0', jobId: 'job-1', reservations: [], updatedAt: NOW.toISOString() },
      policy: budgetPolicy,
      taskId: 'task-1',
      safeCostUsd: null,
    });
    expect(admission.admissible).toBe(false);
    expect(admission.refusal).toBe('COST_UNKNOWN');
  });

  it('refuses to read a corrupt budget file as an empty budget', () => {
    const workspace = workspaceFixture();
    reserveApiBudget({
      workspace: workspace,
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: 'task-1',
      policy: budgetPolicy,
      safeCostUsd: 4,
      profileName: 'dsh-remote',
      now: NOW,
      reservationId: 'ar-1',
    });
    const file = path.join(
      workspace.sidecarDir,
      'jobs',
      'job-1',
      'api-budget',
      'reservations.json',
    );
    expect(readFileSync(file, 'utf8')).toContain('ar-1');
    writeFileSync(file, '{ not json at all', 'utf8');
    expect(() => readApiBudgetState(workspace, 'job-1')).toThrow(/unreadable/);
  });
});

// ---------------------------------------------------------------------------
// Bounded, fingerprinted approvals
// ---------------------------------------------------------------------------

describe('vNext.5 spend approvals', () => {
  const node = {
    nodeId: 'n1',
    parentTaskId: 'task-1',
    title: 'Implement the settings store integration',
    taskFingerprint: 'tf-original',
    planRevision: 1,
    dependsOn: [],
  };

  it('Test V: a materially changed task invalidates an existing approval', () => {
    const workspace = workspaceFixture();
    const fingerprintA = taskSpendFingerprint(node);
    requestApiSpendApproval({
      workspace: workspace,
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: 'task-1',
      taskFingerprint: fingerprintA,
      profileName: 'dsh-remote',
      maxAuthorizedCostUsd: 5,
      estimatedCostUsd: 3,
      rationale: 'weekly gap',
      approvalId: 'aa-1',
      now: NOW,
      ttlMs: 3_600_000,
    });
    decideApiSpendApproval({
      workspace: workspace,
      jobId: 'job-1',
      approvalId: 'aa-1',
      decision: 'APPROVED',
      decidedBy: 'operator',
      now: NOW,
    });

    const approvals = listApiSpendApprovals(workspace, 'job-1');
    const stillValid = checkApiSpendApproval({
      approvals,
      nodeId: 'n1',
      taskFingerprint: fingerprintA,
      profileName: 'dsh-remote',
      safeCostUsd: 3,
      now: NOW,
    });
    expect(stillValid.valid).toBe(true);

    // The plan is revised: the same task id, materially different work.
    const fingerprintB = taskSpendFingerprint({ ...node, planRevision: 2 });
    expect(fingerprintB).not.toBe(fingerprintA);
    const stale = checkApiSpendApproval({
      approvals,
      nodeId: 'n1',
      taskFingerprint: fingerprintB,
      profileName: 'dsh-remote',
      safeCostUsd: 3,
      now: NOW,
    });
    expect(stale.valid).toBe(false);
    expect(stale.reason).toBe('FINGERPRINT_CHANGED');
  });

  it('an approval is bounded by cost, profile, and expiry — not a blanket yes', () => {
    const workspace = workspaceFixture();
    const fingerprint = taskSpendFingerprint(node);
    requestApiSpendApproval({
      workspace: workspace,
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: 'task-1',
      taskFingerprint: fingerprint,
      profileName: 'dsh-remote',
      maxAuthorizedCostUsd: 5,
      estimatedCostUsd: 3,
      rationale: 'gap',
      approvalId: 'aa-1',
      now: NOW,
      ttlMs: 3_600_000,
    });
    decideApiSpendApproval({
      workspace: workspace,
      jobId: 'job-1',
      approvalId: 'aa-1',
      decision: 'APPROVED',
      decidedBy: 'operator',
      now: NOW,
    });
    const approvals = listApiSpendApprovals(workspace, 'job-1');
    const check = (overrides: Record<string, unknown>) =>
      checkApiSpendApproval({
        approvals,
        nodeId: 'n1',
        taskFingerprint: fingerprint,
        profileName: 'dsh-remote',
        safeCostUsd: 3,
        now: NOW,
        ...overrides,
      });
    expect(check({ safeCostUsd: 9 }).reason).toBe('COST_EXCEEDS_AUTHORIZATION');
    expect(check({ safeCostUsd: null }).reason).toBe('COST_EXCEEDS_AUTHORIZATION');
    expect(check({ profileName: 'other-profile' }).reason).toBe('PROFILE_CHANGED');
    expect(check({ now: new Date(NOW.getTime() + 7_200_000) }).reason).toBe('EXPIRED');
  });

  it('does not re-ask while a live request for the same work is open', () => {
    const workspace = workspaceFixture();
    const fingerprint = taskSpendFingerprint(node);
    const request = () =>
      requestApiSpendApproval({
        workspace: workspace,
        jobId: 'job-1',
        nodeId: 'n1',
        taskId: 'task-1',
        taskFingerprint: fingerprint,
        profileName: 'dsh-remote',
        maxAuthorizedCostUsd: 5,
        estimatedCostUsd: 3,
        rationale: 'gap',
        approvalId: `aa-${Math.random()}`.replace('.', ''),
        now: NOW,
        ttlMs: 3_600_000,
      });
    expect(request().created).toBe(true);
    expect(request().created).toBe(false);
    expect(listApiSpendApprovals(workspace, 'job-1')).toHaveLength(1);
  });

  it('a decided approval is immutable', () => {
    const workspace = workspaceFixture();
    requestApiSpendApproval({
      workspace: workspace,
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: 'task-1',
      taskFingerprint: 'fp',
      profileName: 'dsh-remote',
      maxAuthorizedCostUsd: 5,
      estimatedCostUsd: 3,
      rationale: 'gap',
      approvalId: 'aa-1',
      now: NOW,
      ttlMs: 3_600_000,
    });
    decideApiSpendApproval({
      workspace: workspace,
      jobId: 'job-1',
      approvalId: 'aa-1',
      decision: 'APPROVED',
      decidedBy: 'operator',
      now: NOW,
    });
    expect(() =>
      decideApiSpendApproval({
        workspace: workspace,
        jobId: 'job-1',
        approvalId: 'aa-1',
        decision: 'DENIED',
        decidedBy: 'someone-else',
        now: NOW,
      }),
    ).toThrow(/already APPROVED/);
  });
});

// ---------------------------------------------------------------------------
// Delay sensitivity and gap forecasting
// ---------------------------------------------------------------------------

describe('vNext.5 delay sensitivity', () => {
  function graph(nodes: { id: string; dependsOn?: string[]; status?: string }[]): JobGraph {
    return {
      schemaVersion: '1.0.0',
      jobId: 'job-1',
      revision: 1,
      createdAt: NOW.toISOString(),
      nodes: nodes.map((node) => ({
        nodeId: node.id,
        parentTaskId: node.id,
        title: node.id,
        taskFingerprint: `tf-${node.id}`,
        dependsOn: node.dependsOn ?? [],
        status: node.status ?? 'PENDING',
        planRevision: 0,
        planApproved: false,
        humanReviewRequired: false,
        complexitySignals: [],
        attempts: [],
        repairCycles: 0,
        replans: 0,
        consecutiveNoProgress: 0,
      })),
    } as unknown as JobGraph;
  }

  it('a task the whole job waits on is HIGH', () => {
    const assessment = assessDelaySensitivity({
      graph: graph([
        { id: 'a', status: 'READY' },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['b'] },
      ]),
      nodeId: 'a',
      readyRunnableNodeIds: [],
    });
    expect(assessment.level).toBe('HIGH');
    expect(assessment.blockedDependents).toBe(2);
    expect(assessment.criticalPath).toBe(true);
  });

  it('a task nothing waits on, with other work ready, is LOW', () => {
    const assessment = assessDelaySensitivity({
      graph: graph([
        { id: 'a', status: 'READY' },
        { id: 'b', status: 'READY' },
      ]),
      nodeId: 'a',
      readyLocalNodeIds: ['b'],
      readyRunnableNodeIds: ['b'],
    });
    expect(assessment.level).toBe('LOW');
    expect(assessment.criticalPath).toBe(false);
    expect(assessment.readyLocalBacklog).toBe(1);
  });

  it('the critical-path exception records the local work it outranks', () => {
    const assessment = assessDelaySensitivity({
      graph: graph([
        { id: 'a', status: 'READY' },
        { id: 'b', dependsOn: ['a'] },
        { id: 'local', status: 'READY' },
      ]),
      nodeId: 'a',
      readyLocalNodeIds: ['local'],
      readyRunnableNodeIds: ['local'],
    });
    expect(assessment.readyLocalBacklog).toBe(1);
    expect(assessment.blockedDependents).toBe(1);
  });

  it('absent a graph, it assumes waiting is cheap rather than urgent', () => {
    const assessment = assessDelaySensitivity({ graph: undefined, nodeId: 'a' });
    expect(assessment.level).toBe('LOW');
  });
});

describe('vNext.5 subscription gap forecast', () => {
  const forecast = (overrides: Partial<QuotaForecast> = {}): QuotaForecast => ({
    fiveHourRemainingRatio: 0,
    fiveHourResetAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
    timeToFiveHourResetMs: 90 * 60_000,
    weeklyRemainingRatio: 0.4,
    weeklyResetAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
    timeToWeeklyResetMs: 2 * 86_400_000,
    observedFiveHourBurnRatePerMinute: null,
    projectedBurnUntilFiveHourReset: null,
    schedulerMode: 'EXHAUSTED_5H',
    telemetryFreshness: 'FRESH',
    observedAt: NOW.toISOString(),
    forecastAt: NOW.toISOString(),
    ...overrides,
  });

  it('reads the five-hour reset for a five-hour gap and the weekly reset for a weekly one', () => {
    const fiveHour = buildSubscriptionGapForecast({
      reason: 'FIVE_HOUR_EXHAUSTED',
      forecast: forecast(),
      now: NOW,
    });
    expect(fiveHour.timeUntilAvailableMs).toBe(90 * 60_000);
    expect(fiveHour.confidence).toBe('HIGH');

    const weekly = buildSubscriptionGapForecast({
      reason: 'WEEKLY_EXHAUSTED',
      forecast: forecast(),
      now: NOW,
    });
    expect(weekly.timeUntilAvailableMs).toBe(2 * 86_400_000);
  });

  it('never fabricates a return time it was not given', () => {
    const unknown = buildSubscriptionGapForecast({
      reason: 'FIVE_HOUR_EXHAUSTED',
      forecast: forecast({ fiveHourResetAt: null, timeToFiveHourResetMs: null }),
      now: NOW,
    });
    expect(unknown.expectedAvailableAt).toBeNull();
    expect(unknown.timeUntilAvailableMs).toBeNull();
    expect(unknown.confidence).toBe('UNKNOWN');
  });

  it('a missing subscription worker is a configuration gap with no reset', () => {
    const missing = buildSubscriptionGapForecast({
      reason: 'SUBSCRIPTION_WORKER_UNAVAILABLE',
      forecast: forecast(),
      now: NOW,
    });
    expect(missing.timeUntilAvailableMs).toBeNull();
    expect(missing.detail).toContain('configuration gap');
  });

  it('stale telemetry lowers confidence in the reset time', () => {
    const stale = buildSubscriptionGapForecast({
      reason: 'FIVE_HOUR_EXHAUSTED',
      forecast: forecast({ telemetryFreshness: 'STALE' }),
      now: NOW,
    });
    expect(stale.confidence).toBe('MEDIUM');
  });
});
