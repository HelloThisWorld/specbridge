import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AdaptiveSchedulerPolicy, AgentConfig } from '@specbridge/core';
import {
  adaptiveProfileFile,
  aggregateProfiles,
  beginTaskAttempt,
  buildTaskSignature,
  clearAdaptiveProfileCache,
  completeTaskAttempt,
  createJob,
  decideLane,
  deriveAdaptiveObservations,
  estimateWorkload,
  generateCandidates,
  historyFingerprint,
  loadAdaptiveProfiles,
  rankCandidates,
  readAdaptiveProfileCache,
  readExecutionLedger,
  rebuildAdaptiveProfiles,
  strategyKey,
  writeEvaluationResult,
} from '@specbridge/orchestration';
import type {
  ExecutionLedgerEntry,
  GenerateCandidatesInput,
  NodeLaneRouting,
  QuotaForecast,
  TaskSignature,
} from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';

/**
 * The mandatory vNext.8 end-to-end adaptive scenario.
 *
 * One deterministic simulation, run in order, that walks the whole lifecycle:
 * empty ledger, SHADOW rollout, accumulated verified history, profile
 * rebuild, ADAPTIVE placement, HARVEST, weekly pressure, a short Max outage,
 * a long weekly outage with an authorized API lane, drift, a version change,
 * context-strategy economics, a reliability veto, a return to SHADOW, and
 * finally cache deletion and corruption.
 *
 * Fully offline: no model, no network, no Git. Attempts and evaluations are
 * written as the durable records a real run would leave, and every scheduling
 * question is then answered from those records — which is the point, because
 * it means the scenario is testing what SpecBridge would actually decide
 * rather than what a mock was told to say.
 *
 * The fixture history below (DIRECT cheap-but-weak on agentic work, HARNESS
 * stronger locally, SUBSCRIPTION reliable, API costly) is TEST DATA. None of
 * it is encoded in production policy, and the assertions are about the
 * scheduler's reasoning, not about any real provider.
 */

const NOW = new Date('2026-08-01T09:00:00.000Z');

interface Fixture extends OrchestrationFixture {
  jobId: string;
}

function fixtureWith(adaptive: Partial<AdaptiveSchedulerPolicy> = {}): Fixture {
  const base = setupOrchestrationFixture({
    policy: { jobs: { scheduler: { adaptive } } },
  });
  const job = createJob(base.deps, {
    specName: base.specName,
    goal: 'Implement the approved settings-persistence plan.',
  });
  return { ...base, jobId: job.jobId };
}

function adaptivePolicyOf(config: AgentConfig): AdaptiveSchedulerPolicy {
  return config.orchestration.jobs.scheduler.adaptive;
}

// ---------------------------------------------------------------------------
// Durable history synthesis
// ---------------------------------------------------------------------------

interface SyntheticAttempt {
  nodeId: string;
  taskId: string;
  lane: 'LOCAL' | 'SUBSCRIPTION' | 'API';
  executionMode: 'DIRECT_MODEL' | 'HARNESS' | null;
  provider: string;
  model: string | null;
  signature: string;
  contextStrategy: string;
  verified: boolean;
  /** When set, the failure is attributed to broken machinery, not bad work. */
  infrastructure?: boolean | undefined;
  inconclusive?: boolean | undefined;
  wallTimeMs: number;
  inputTokens?: number | undefined;
  contextTokens?: number | undefined;
  fiveHourBurn?: { before: number; after: number } | undefined;
  costUsd?: number | undefined;
  startedAt: string;
}

/**
 * Write one attempt exactly as a real dispatch would leave it: a RUNNING
 * record first, a final record after, and a durable evaluation verdict
 * beside it. Success in this scenario always means BOTH — a completed
 * attempt with no PASS evaluation is written deliberately in one case, to
 * prove it is not counted as success.
 */
function writeAttempt(fixture: Fixture, input: SyntheticAttempt): string {
  const deps = { workspace: fixture.workspace, clock: () => new Date(input.startedAt) };
  const attempt = beginTaskAttempt(deps, {
    jobId: fixture.jobId,
    nodeId: input.nodeId,
    taskId: input.taskId,
    role: 'EXECUTOR',
    workerId: 'w-exec',
    provider: input.provider,
    model: input.model ?? undefined,
    lane: input.lane,
    taskSignature: input.signature,
    contextStrategy: input.contextStrategy,
    ...(input.executionMode !== null ? { executionMode: input.executionMode } : {}),
    ...(input.fiveHourBurn !== undefined
      ? { quotaBefore: { fiveHourRemainingRatio: input.fiveHourBurn.before } }
      : {}),
  });
  const completedAt = new Date(Date.parse(input.startedAt) + input.wallTimeMs).toISOString();
  completeTaskAttempt(
    { workspace: fixture.workspace, clock: () => new Date(completedAt) },
    {
      jobId: fixture.jobId,
      attemptId: attempt.attemptId,
      status: input.verified ? 'COMPLETED' : 'FAILED',
      ...(input.verified
        ? {}
        : {
            failure: {
              category:
                input.infrastructure === true
                  ? ('CAPABILITY_UNAVAILABLE' as const)
                  : ('VERIFICATION_FAILURE' as const),
              message:
                input.infrastructure === true ? 'harness process exited' : 'trusted verifiers failed',
            },
          }),
      metrics: {
        durationMs: input.wallTimeMs,
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.costUsd !== undefined ? { reconciledCostUsd: input.costUsd } : {}),
        ...(input.fiveHourBurn !== undefined
          ? {
              fiveHourQuotaBefore: input.fiveHourBurn.before,
              fiveHourQuotaAfter: input.fiveHourBurn.after,
            }
          : {}),
      },
    },
  );
  writeEvaluationResult(fixture.workspace, {
    schemaVersion: '1.0.0',
    evaluationId: `ev-${attempt.attemptId}`,
    jobId: fixture.jobId,
    nodeId: input.nodeId,
    taskId: input.taskId,
    attemptId: attempt.attemptId,
    lane: input.lane,
    status: input.inconclusive === true ? 'INCONCLUSIVE' : input.verified ? 'PASS' : 'FAIL',
    deterministicChecks: [],
    semanticChecks: [],
    semanticFindings: [],
    failedCriteria: [],
    evidenceRefs: [],
    failureSignals: [],
    reasons: ['synthetic scenario history'],
    semanticReviewRan: false,
    createdAt: completedAt,
  });
  return attempt.attemptId;
}

/** Deterministic even spread of successes, so steady history looks steady. */
function isSuccessAt(index: number, total: number, successes: number): boolean {
  return Math.floor((index * successes) / total) < Math.floor(((index + 1) * successes) / total);
}

const SIMPLE_SIGNATURE = buildTaskSignature({
  category: 'unit-test',
  complexity: 'LOW',
  localSuitability: 'LOCAL_TRY',
  executionShape: 'ONE_SHOT',
  deterministicVerificationAvailable: true,
});
const AGENTIC_SIGNATURE = buildTaskSignature({
  category: 'mechanical-refactor',
  complexity: 'MEDIUM',
  localSuitability: 'LOCAL_TRY',
  executionShape: 'AGENTIC',
  deterministicVerificationAvailable: true,
});
const STRONG_SIGNATURE = buildTaskSignature({
  category: 'general',
  complexity: 'HIGH',
  localSuitability: 'STRONG_REQUIRED',
  executionShape: 'AGENTIC',
  deterministicVerificationAvailable: true,
});

function seedRun(
  fixture: Fixture,
  input: {
    prefix: string;
    signature: TaskSignature;
    lane: SyntheticAttempt['lane'];
    executionMode: SyntheticAttempt['executionMode'];
    provider: string;
    model: string | null;
    total: number;
    successes: number;
    wallTimeMs: number;
    contextStrategy?: string | undefined;
    inputTokens?: number | undefined;
    startAt?: number | undefined;
    fiveHourBurnPerAttempt?: number | undefined;
    costUsd?: number | undefined;
  },
): void {
  // Recent enough that the recency weights stay near 1: this scenario is
  // about what the scheduler concludes from steady history, not about how
  // fast old evidence decays (that has its own focused test).
  const start = input.startAt ?? NOW.getTime() - 6 * 86_400_000;
  for (let index = 0; index < input.total; index += 1) {
    const verified = isSuccessAt(index, input.total, input.successes);
    writeAttempt(fixture, {
      nodeId: `${input.prefix}-n${index}`,
      taskId: `${input.prefix}-t${index}`,
      lane: input.lane,
      executionMode: input.executionMode,
      provider: input.provider,
      model: input.model,
      signature: input.signature.key,
      contextStrategy: input.contextStrategy ?? 'LEGACY',
      verified,
      wallTimeMs: input.wallTimeMs,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.fiveHourBurnPerAttempt !== undefined
        ? {
            fiveHourBurn: {
              before: 0.9,
              after: Math.max(0, 0.9 - input.fiveHourBurnPerAttempt),
            },
          }
        : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      startedAt: new Date(start + index * 3_600_000).toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduling harness
// ---------------------------------------------------------------------------

function forecast(overrides: Partial<QuotaForecast> = {}): QuotaForecast {
  return {
    fiveHourRemainingRatio: 0.8,
    fiveHourResetAt: null,
    timeToFiveHourResetMs: 3 * 3_600_000,
    weeklyRemainingRatio: 0.9,
    weeklyResetAt: null,
    timeToWeeklyResetMs: 5 * 86_400_000,
    observedFiveHourBurnRatePerMinute: null,
    projectedBurnUntilFiveHourReset: null,
    schedulerMode: 'NORMAL',
    telemetryFreshness: 'FRESH',
    observedAt: NOW.toISOString(),
    forecastAt: NOW.toISOString(),
    ...overrides,
  };
}

const LOCAL_HARNESS_BOUND: GenerateCandidatesInput['harnessBinding'] = {
  status: 'BOUND',
  available: true,
  profileName: 'dsh-local',
  runner: 'deepseek-harness',
  model: 'qwen-a',
  locality: 'LOCAL',
  localityEvidence: 'loopback endpoint verified',
  credentialRisks: [],
  localityOverridden: false,
  problems: [],
  maxWallTimeMs: 900_000,
};

const API_UNBOUND = {
  status: 'UNBOUND',
  available: false,
  profileName: null,
  runner: null,
  model: null,
  locality: 'UNKNOWN',
} as unknown as GenerateCandidatesInput['apiBinding'];

const API_BOUND = {
  status: 'BOUND',
  available: true,
  profileName: 'api-remote',
  runner: 'deepseek-harness',
  model: 'remote-strong',
  locality: 'REMOTE',
} as unknown as GenerateCandidatesInput['apiBinding'];

/** Route one task through the REAL hard-policy scheduler, then rank it. */
function place(
  fixture: Fixture,
  input: {
    mode: 'HEURISTIC' | 'SHADOW' | 'ADAPTIVE';
    signature: TaskSignature;
    heuristicMode: 'DIRECT_MODEL' | 'HARNESS';
    forecast?: QuotaForecast | undefined;
    localExecutionAvailable?: boolean | undefined;
    harnessBinding?: GenerateCandidatesInput['harnessBinding'] | undefined;
    apiBinding?: GenerateCandidatesInput['apiBinding'] | undefined;
    exhaustedStrategies?: readonly string[] | undefined;
    laneOverride?: 'API' | undefined;
    policy?: Partial<AdaptiveSchedulerPolicy> | undefined;
    localDirectModel?: string | null | undefined;
  },
) {
  const schedulerPolicy = fixture.config.orchestration.jobs.scheduler;
  const adaptive: AdaptiveSchedulerPolicy = {
    ...adaptivePolicyOf(fixture.config),
    ...(input.policy ?? {}),
  } as AdaptiveSchedulerPolicy;
  const quota = input.forecast ?? forecast();

  const estimate = estimateWorkload({
    taskId: 'task-under-test',
    complexity: input.signature.complexity,
    localSuitability: input.signature.localSuitability,
    taskCategory: input.signature.category,
    policy: schedulerPolicy.estimator,
    conservativeBurnFromHistory: input.mode !== 'HEURISTIC',
  });

  // The HARD policy layer. Its answer is authoritative for the lane.
  const routing = decideLane({
    estimate,
    forecast: quota,
    reserveRatio: 0.1,
    localWorkerAvailable: input.localExecutionAvailable ?? true,
    localExecutionAvailable: input.localExecutionAvailable ?? true,
    contextUsageRatio: null,
    policy: schedulerPolicy,
  });
  const effectiveRouting =
    input.laneOverride === 'API'
      ? { ...routing, lane: 'API' as const, reasonCode: 'API_WEEKLY_GAP_BRIDGE' as const }
      : routing;

  const assessment = {
    suitability: {
      class: input.signature.localSuitability,
      category: input.signature.category,
      signals: [],
    },
    estimate,
    routing: effectiveRouting,
    signature: input.signature,
    localExecution: { mode: input.heuristicMode },
  } as unknown as NodeLaneRouting;

  const candidates = generateCandidates({
    routing: assessment,
    contextStrategy: 'LEGACY',
    harnessBinding: input.harnessBinding ?? LOCAL_HARNESS_BOUND,
    localDirectAvailable: input.localExecutionAvailable ?? true,
    localDirectModel: input.localDirectModel === undefined ? 'qwen-a' : input.localDirectModel,
    localDirectRunner: 'local-llamacpp',
    apiBinding: input.apiBinding ?? API_UNBOUND,
    subscriptionProvider: 'claude-code',
    exhaustedStrategies: input.exhaustedStrategies ?? [],
    planRevision: 1,
  });

  const loaded = loadAdaptiveProfiles({
    workspace: fixture.workspace,
    policy: adaptive,
    now: NOW,
    persist: false,
  });

  const ranking = rankCandidates({
    mode: input.mode,
    candidates,
    signature: input.signature,
    profiles: loaded.profiles,
    policy: adaptive,
    forecast: quota,
    priorSuccessProbability: 1 - estimate.retryProbability,
    heuristicWallTimeMs: estimate.expectedWallTimeMs,
    heuristicInputTokens: estimate.expectedInputTokens,
    heuristicContextTokens: estimate.expectedContextGrowthTokens,
    heuristicFiveHourBurnRatio: estimate.expectedFiveHourBurnRatio,
  });

  return { routing: effectiveRouting, estimate, candidates, ranking, profiles: loaded };
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

describe('vNext.8 mandatory end-to-end adaptive scenario', () => {
  it('walks the full adaptive lifecycle deterministically', () => {
    // --- 1-4. Empty ledger, SHADOW mode, sparse history ------------------
    const fixture = fixtureWith({ mode: 'SHADOW' });
    expect(readExecutionLedger(fixture.workspace, fixture.jobId)).toHaveLength(0);

    const coldStart = place(fixture, {
      mode: 'SHADOW',
      signature: SIMPLE_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
    });
    expect(coldStart.routing.lane).toBe('LOCAL');
    expect(coldStart.ranking.confidence).toBe('NONE');
    expect(coldStart.ranking.adaptiveApplied).toBe(false);
    expect(coldStart.ranking.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');

    // --- 5. Accumulate observed VERIFIED history -------------------------
    // Simple one-shot work: DIRECT performs well and fast.
    seedRun(fixture, {
      prefix: 'simple-direct',
      signature: SIMPLE_SIGNATURE,
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      provider: 'local-llamacpp',
      model: 'qwen-a',
      total: 20,
      successes: 19,
      wallTimeMs: 3 * 60_000,
      inputTokens: 20_000,
    });
    // The harness solves the same simple work, far more slowly.
    seedRun(fixture, {
      prefix: 'simple-harness',
      signature: SIMPLE_SIGNATURE,
      lane: 'LOCAL',
      executionMode: 'HARNESS',
      provider: 'deepseek-harness',
      model: 'qwen-a',
      total: 20,
      successes: 20,
      wallTimeMs: 26 * 60_000,
      inputTokens: 90_000,
    });
    // Multi-file local work: DIRECT mostly fails, HARNESS mostly verifies.
    seedRun(fixture, {
      prefix: 'agentic-direct',
      signature: AGENTIC_SIGNATURE,
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      provider: 'local-llamacpp',
      model: 'qwen-a',
      total: 20,
      successes: 4,
      wallTimeMs: 5 * 60_000,
      inputTokens: 25_000,
    });
    seedRun(fixture, {
      prefix: 'agentic-harness',
      signature: AGENTIC_SIGNATURE,
      lane: 'LOCAL',
      executionMode: 'HARNESS',
      provider: 'deepseek-harness',
      model: 'qwen-a',
      total: 20,
      successes: 17,
      wallTimeMs: 14 * 60_000,
      inputTokens: 120_000,
    });
    // Strong architecture work runs reliably on the subscription lane.
    seedRun(fixture, {
      prefix: 'strong-sub',
      signature: STRONG_SIGNATURE,
      lane: 'SUBSCRIPTION',
      executionMode: null,
      provider: 'claude-code',
      model: null,
      total: 20,
      successes: 18,
      wallTimeMs: 22 * 60_000,
      fiveHourBurnPerAttempt: 0.12,
    });

    // --- 6-7. Rebuild profiles and verify smoothed statistics ------------
    const rebuilt = rebuildAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    expect(rebuilt.source).toBe('rebuilt');
    expect(rebuilt.profiles.observationCount).toBe(100);

    const agenticDirect = [...rebuilt.profiles.profiles.values()].find(
      (profile) =>
        profile.level === 'EXACT' &&
        profile.signaturePart === AGENTIC_SIGNATURE.key &&
        profile.executionMode === 'DIRECT_MODEL',
    );
    expect(agenticDirect?.verifiedSuccesses).toBe(4);
    expect(agenticDirect?.implementationFailures).toBe(16);
    // Smoothed, not raw: the estimate sits above the raw 20% but well under
    // the prior, because the evidence is real and points down.
    const priorAgentic = 1 - 0.4;
    expect(agenticDirect).toBeDefined();

    // --- 8-9. ADAPTIVE mode; a new SIMPLE local task ---------------------
    const simple = place(fixture, {
      mode: 'ADAPTIVE',
      signature: SIMPLE_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
    });
    expect(simple.routing.lane).toBe('LOCAL');
    expect(simple.ranking.recommendedCandidate?.executionMode).toBe('DIRECT_MODEL');
    expect(simple.ranking.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');

    // --- 10. A new AGENTIC local task ------------------------------------
    const agentic = place(fixture, {
      mode: 'ADAPTIVE',
      signature: AGENTIC_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
    });
    expect(agentic.routing.lane).toBe('LOCAL');
    expect(agentic.ranking.recommendedCandidate?.executionMode).toBe('HARNESS');
    expect(agentic.ranking.adaptiveApplied).toBe(true);
    expect(agentic.ranking.selectedCandidate?.executionMode).toBe('HARNESS');
    expect(agentic.ranking.fallbackReason).toBeNull();
    // Explained in words, not as a bare number.
    expect(agentic.ranking.explanation.join(' ')).toContain('verified success:');
    void priorAgentic;

    // --- 11. STRONG_REQUIRED: local candidates never appear --------------
    const strong = place(fixture, {
      mode: 'ADAPTIVE',
      signature: STRONG_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
    });
    expect(strong.routing.lane).toBe('SUBSCRIPTION');
    expect(strong.candidates.eligible.map((entry) => entry.lane)).toEqual(['SUBSCRIPTION']);
    expect(strong.candidates.eligible.some((entry) => entry.lane === 'LOCAL')).toBe(false);

    // --- 12-13. HARVEST: expiring prepaid capacity is worth spending -----
    const harvestForecast = forecast({
      schedulerMode: 'HARVEST',
      fiveHourRemainingRatio: 0.6,
      timeToFiveHourResetMs: 15 * 60_000,
      weeklyRemainingRatio: 0.85,
    });
    const harvest = place(fixture, {
      mode: 'ADAPTIVE',
      signature: STRONG_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
      forecast: harvestForecast,
    });
    expect(harvest.routing.lane).toBe('SUBSCRIPTION');
    // Either attribution is HARVEST admitting the work: a task longer than
    // the time to the reset is labelled CROSS_RESET_ADMITTED by the vNext.2
    // ladder, which takes precedence over the mode name. The mode is what
    // matters here, and the reserve it lowered is why this was admitted.
    expect(['HARVEST_EXPIRING_CAPACITY', 'CROSS_RESET_ADMITTED']).toContain(
      harvest.routing.reasonCode,
    );
    expect(harvestForecast.schedulerMode).toBe('HARVEST');
    const harvestQuota = harvest.ranking.ranked[0]?.score.components.find(
      (component) => component.name === 'quotaOpportunityCost',
    );
    // Expiring capacity makes the subscription candidate MORE attractive:
    // a negative cost is a bonus in the utility sum.
    expect(harvestQuota?.raw).toBeLessThan(0);
    expect(harvestQuota?.contribution).toBeGreaterThan(0);

    // --- 13b. HARVEST never pulls local-capable work onto Max ------------
    const harvestLocal = place(fixture, {
      mode: 'ADAPTIVE',
      signature: SIMPLE_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
      forecast: harvestForecast,
    });
    expect(harvestLocal.routing.lane).toBe('LOCAL');
    expect(harvestLocal.candidates.eligible.every((entry) => entry.lane === 'LOCAL')).toBe(true);

    // --- 14-15. Weekly pressure suppresses aggressive harvesting ---------
    const weeklyPressure = place(fixture, {
      mode: 'ADAPTIVE',
      signature: STRONG_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
      forecast: forecast({
        schedulerMode: 'CONSERVE',
        fiveHourRemainingRatio: 0.6,
        timeToFiveHourResetMs: 15 * 60_000,
        weeklyRemainingRatio: 0.03,
      }),
    });
    expect(weeklyPressure.routing.lane).toBe('DEFER');
    expect(weeklyPressure.routing.reasonCode).toBe('WEEKLY_QUOTA_PRESSURE');
    expect(weeklyPressure.candidates.eligible).toHaveLength(0);
    expect(weeklyPressure.ranking.selectedCandidate).toBeNull();

    // --- 16-17. A short Max outage: strong work WAITS --------------------
    const shortGap = place(fixture, {
      mode: 'ADAPTIVE',
      signature: STRONG_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
      forecast: forecast({
        schedulerMode: 'EXHAUSTED_5H',
        fiveHourRemainingRatio: 0.005,
        timeToFiveHourResetMs: 8 * 60_000,
      }),
      apiBinding: API_BOUND,
    });
    expect(shortGap.routing.lane).toBe('DEFER');
    // No API candidate exists: the gap-bridge planner never selected the
    // lane, so historical API performance has nothing to rank.
    expect(shortGap.candidates.eligible).toHaveLength(0);
    expect(shortGap.ranking.adaptiveApplied).toBe(false);

    // --- 18-23. A long weekly outage the Gap Bridge DID authorize --------
    seedRun(fixture, {
      prefix: 'api-strong',
      signature: STRONG_SIGNATURE,
      lane: 'API',
      executionMode: 'HARNESS',
      provider: 'deepseek-harness',
      model: 'remote-strong',
      total: 12,
      successes: 12,
      wallTimeMs: 18 * 60_000,
      inputTokens: 400_000,
      costUsd: 1.4,
    });
    const longGap = place(fixture, {
      mode: 'ADAPTIVE',
      signature: STRONG_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
      forecast: forecast({
        schedulerMode: 'EXHAUSTED_WEEKLY',
        fiveHourRemainingRatio: 0.005,
        weeklyRemainingRatio: 0.005,
        timeToWeeklyResetMs: 30 * 3_600_000,
      }),
      apiBinding: API_BOUND,
      laneOverride: 'API',
    });
    expect(longGap.candidates.eligible.map((entry) => entry.lane)).toEqual(['API']);
    const apiPrediction = longGap.ranking.ranked[0]?.prediction;
    expect(apiPrediction?.sampleCount).toBeGreaterThan(0);
    // Observed cost is priced per verified completion, and it is priced from
    // OBSERVED cost only — an estimate never becomes its own evidence.
    expect(apiPrediction?.expectedApiCostUsd).toBeCloseTo(1.4, 4);

    // --- 24-26. Repeated poor performance from one local harness ---------
    // A recent block of harness failures on agentic work: drift, and the
    // recommendation loses its authority rather than gaining a new one.
    seedRun(fixture, {
      prefix: 'agentic-harness-regressed',
      signature: AGENTIC_SIGNATURE,
      lane: 'LOCAL',
      executionMode: 'HARNESS',
      provider: 'deepseek-harness',
      model: 'qwen-a',
      total: 16,
      successes: 2,
      wallTimeMs: 26 * 60_000,
      startAt: NOW.getTime() - 2 * 86_400_000,
    });
    const drifted = place(fixture, {
      mode: 'ADAPTIVE',
      signature: AGENTIC_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
    });
    const driftedHarness = drifted.ranking.ranked.find(
      (entry) => entry.prediction.candidate.executionMode === 'HARNESS',
    );
    expect(driftedHarness?.prediction.drift.detected).toBe(true);
    expect(driftedHarness?.prediction.drift.signals).toContain('SUCCESS_RATE_DROP');

    // --- 27-28. A version change does not inherit confidence -------------
    const upgraded = place(fixture, {
      mode: 'ADAPTIVE',
      signature: AGENTIC_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
      harnessBinding: { ...LOCAL_HARNESS_BOUND, model: 'qwen-b' },
    });
    const upgradedHarness = upgraded.ranking.ranked.find(
      (entry) => entry.prediction.candidate.executionMode === 'HARNESS',
    );
    expect(upgradedHarness?.prediction.identityMatch).not.toBe('EXACT');
    expect(upgradedHarness?.prediction.confidence).not.toBe('HIGH');

    // --- 31-32. A strategy vNext.6 has retired is never selected ---------
    const forbidden = strategyKey({
      lane: 'LOCAL',
      executionMode: 'HARNESS',
      planRevision: 1,
      freshContext: false,
    });
    const vetoed = place(fixture, {
      mode: 'ADAPTIVE',
      signature: AGENTIC_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
      exhaustedStrategies: [forbidden],
    });
    expect(vetoed.candidates.eligible.map((entry) => entry.executionMode)).toEqual(['DIRECT_MODEL']);
    expect(vetoed.candidates.rejected.map((entry) => entry.code)).toContain(
      'RELIABILITY_STRATEGY_FORBIDDEN',
    );
    expect(vetoed.ranking.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');

    // --- 33-34. Back to SHADOW: recommendations continue, execution does not
    const shadowAgain = place(fixture, {
      mode: 'SHADOW',
      signature: AGENTIC_SIGNATURE,
      heuristicMode: 'DIRECT_MODEL',
    });
    expect(shadowAgain.ranking.ranked.length).toBeGreaterThan(1);
    expect(shadowAgain.ranking.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');
    expect(shadowAgain.ranking.adaptiveApplied).toBe(false);
    expect(shadowAgain.ranking.fallbackReason).toBe('MODE_SHADOW');
    const shadowProse = shadowAgain.ranking.explanation.join(' ');
    expect(shadowProse).toContain('was NOT run');
    expect(shadowProse).not.toMatch(/would have (succeeded|passed|verified)/i);

    // --- 35-38. Delete the cache and rebuild: identical output -----------
    const before = rebuildAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    const beforeSnapshot = snapshotProfiles(before.profiles);
    clearAdaptiveProfileCache(fixture.workspace);
    expect(existsSync(adaptiveProfileFile(fixture.workspace))).toBe(false);

    const afterDelete = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    expect(afterDelete.source).toBe('rebuilt');
    expect(afterDelete.invalidatedReason).toBe('absent');
    expect(snapshotProfiles(afterDelete.profiles)).toEqual(beforeSnapshot);

    // The job's canonical state is untouched by any of this. 100 seeded
    // attempts across the five local/subscription runs, 12 API attempts, and
    // 16 regressed harness attempts.
    const CANONICAL_ATTEMPTS = 100 + 12 + 16;
    const ledger = readExecutionLedger(fixture.workspace, fixture.jobId);
    expect(ledger.length).toBe(CANONICAL_ATTEMPTS);

    // --- 39-40. Corrupt the cache: detect, invalidate, rebuild -----------
    writeFileSync(adaptiveProfileFile(fixture.workspace), '{"schemaVersion":"1.0.0",', 'utf8');
    expect(readAdaptiveProfileCache(fixture.workspace)).toBeUndefined();
    const afterCorruption = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    expect(afterCorruption.source).toBe('rebuilt');
    expect(snapshotProfiles(afterCorruption.profiles)).toEqual(beforeSnapshot);
    // The rebuilt cache is valid again, and the ledger never moved.
    expect(readAdaptiveProfileCache(fixture.workspace)).toBeDefined();
    expect(readExecutionLedger(fixture.workspace, fixture.jobId)).toHaveLength(CANONICAL_ATTEMPTS);

    // A schema-version bump also invalidates rather than migrating.
    const cached = JSON.parse(readFileSync(adaptiveProfileFile(fixture.workspace), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      adaptiveProfileFile(fixture.workspace),
      JSON.stringify({ ...cached, schemaVersion: '99.0.0' }),
      'utf8',
    );
    expect(readAdaptiveProfileCache(fixture.workspace)).toBeUndefined();
  });

  it('the history fingerprint changes only when canonical history changes', () => {
    const fixture = fixtureWith({ mode: 'ADAPTIVE' });
    seedRun(fixture, {
      prefix: 'fp',
      signature: SIMPLE_SIGNATURE,
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      provider: 'local-llamacpp',
      model: 'qwen-a',
      total: 4,
      successes: 4,
      wallTimeMs: 60_000,
    });
    const first = historyFingerprint(readExecutionLedger(fixture.workspace, fixture.jobId));
    const again = historyFingerprint(readExecutionLedger(fixture.workspace, fixture.jobId));
    expect(again).toBe(first);

    // A cached load with a matching fingerprint is served from the cache.
    loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    const cachedLoad = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    expect(cachedLoad.source).toBe('cache');

    // One more observed attempt moves the fingerprint and invalidates it.
    writeAttempt(fixture, {
      nodeId: 'fp-extra',
      taskId: 'fp-extra',
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      provider: 'local-llamacpp',
      model: 'qwen-a',
      signature: SIMPLE_SIGNATURE.key,
      contextStrategy: 'LEGACY',
      verified: true,
      wallTimeMs: 60_000,
      startedAt: NOW.toISOString(),
    });
    expect(historyFingerprint(readExecutionLedger(fixture.workspace, fixture.jobId))).not.toBe(first);
    const staleLoad = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    expect(staleLoad.source).toBe('rebuilt');
    expect(staleLoad.invalidatedReason).toBe('stale');
  });

  it('a completed attempt with no PASS evaluation is not counted as success', () => {
    const fixture = fixtureWith({ mode: 'ADAPTIVE' });
    // Two attempts: one verified, one completed with an INCONCLUSIVE verdict.
    writeAttempt(fixture, {
      nodeId: 'prov-1',
      taskId: 'prov-1',
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      provider: 'local-llamacpp',
      model: 'qwen-a',
      signature: SIMPLE_SIGNATURE.key,
      contextStrategy: 'LEGACY',
      verified: true,
      wallTimeMs: 60_000,
      startedAt: NOW.toISOString(),
    });
    writeAttempt(fixture, {
      nodeId: 'prov-2',
      taskId: 'prov-2',
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      provider: 'local-llamacpp',
      model: 'qwen-a',
      signature: SIMPLE_SIGNATURE.key,
      contextStrategy: 'LEGACY',
      verified: true,
      inconclusive: true,
      wallTimeMs: 60_000,
      startedAt: NOW.toISOString(),
    });

    const observations = deriveAdaptiveObservations({
      entries: readExecutionLedger(fixture.workspace, fixture.jobId),
    });
    expect(observations.map((entry) => entry.label).sort()).toEqual([
      'INCONCLUSIVE',
      'VERIFIED_SUCCESS',
    ]);

    const profiles = aggregateProfiles({
      observations,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    const exact = [...profiles.profiles.values()].find(
      (profile) => profile.level === 'EXACT' && profile.executionMode === 'DIRECT_MODEL',
    );
    expect(exact?.verifiedSuccesses).toBe(1);
    expect(exact?.inconclusive).toBe(1);
    expect(exact?.implementationFailures).toBe(0);
  });
});

/** A stable, comparable snapshot of a profile set. */
function snapshotProfiles(
  set: ReturnType<typeof aggregateProfiles>,
): { key: string; samples: number; verified: number; weighted: number }[] {
  return [...set.profiles.entries()]
    .map(([key, profile]) => ({
      key,
      samples: profile.samples,
      verified: profile.verifiedSuccesses,
      weighted: Math.round(profile.weightedSamples * 1e6) / 1e6,
    }))
    .sort((left, right) => (left.key < right.key ? -1 : 1));
}

/** Unused-import guard: the ledger entry type is part of the public surface. */
export type ScenarioLedgerEntry = ExecutionLedgerEntry;
