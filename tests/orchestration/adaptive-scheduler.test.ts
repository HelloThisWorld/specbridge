import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '@specbridge/core';
import type { AdaptiveSchedulerPolicy } from '@specbridge/core';
import {
  aggregateProfiles,
  buildTaskSignature,
  candidateKey,
  deriveAdaptiveObservations,
  generateCandidates,
  normalize,
  percentile,
  predictCandidate,
  quotaOpportunityCost,
  rankCandidates,
  recencyWeight,
  scoreCandidate,
  strategyKey,
} from '@specbridge/orchestration';
import type {
  AdaptiveObservation,
  ExecutionCandidate,
  ExecutionLedgerEntry,
  GenerateCandidatesInput,
  NodeLaneRouting,
  QuotaForecast,
  TaskSignature,
} from '@specbridge/orchestration';

/**
 * The vNext.8 adaptive layer is a set of pure functions, and every test here
 * is a claim about the decision it must reach for a given history.
 *
 * The properties being pinned, in one list:
 *
 *   - cold start falls back to the heuristic, always
 *   - one success is not a 100% success rate
 *   - within LOCAL, history may choose DIRECT vs HARNESS on the evidence
 *   - hard policy vetoes are absolute: locality, spend, reliability, lane
 *   - infrastructure failure never lowers the intelligence success rate
 *   - INCONCLUSIVE is never trained as failure
 *   - no-progress history costs a candidate its advantage
 *   - a version change withdraws confidence rather than transferring it
 *   - SHADOW records disagreement and fabricates no counterfactual
 *   - hysteresis keeps placement stable under noise
 */

const NOW = new Date('2026-06-01T12:00:00.000Z');
const POLICY: AdaptiveSchedulerPolicy = defaultAgentConfig().orchestration.jobs.scheduler.adaptive;

function policy(overrides: Partial<AdaptiveSchedulerPolicy> = {}): AdaptiveSchedulerPolicy {
  return { ...POLICY, ...overrides } as AdaptiveSchedulerPolicy;
}

const FORECAST: QuotaForecast = {
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
};

function signature(overrides: Partial<Parameters<typeof buildTaskSignature>[0]> = {}): TaskSignature {
  return buildTaskSignature({
    category: 'unit-test',
    complexity: 'MEDIUM',
    localSuitability: 'LOCAL_TRY',
    executionShape: 'ONE_SHOT',
    deterministicVerificationAvailable: true,
    ...overrides,
  });
}

/**
 * Build one synthetic observation. Fixture data only: none of these numbers
 * is a claim about any real provider, and nothing here is hard-coded into
 * production policy.
 */
function observation(overrides: Partial<AdaptiveObservation> = {}): AdaptiveObservation {
  const base: AdaptiveObservation = {
    attemptId: `at-${Math.random().toString(36).slice(2, 10)}`,
    jobId: 'job-1',
    nodeId: 'n1',
    taskId: 't1',
    signatureKey: signature().key,
    taskCategory: 'unit-test',
    taskComplexity: 'MEDIUM',
    candidateKey: 'LOCAL/DIRECT_MODEL/local-llamacpp/qwen-a/LEGACY',
    targetKey: 'LOCAL/DIRECT_MODEL',
    lane: 'LOCAL',
    executionMode: 'DIRECT_MODEL',
    runner: 'local-llamacpp',
    model: 'qwen-a',
    contextStrategy: 'LEGACY',
    runnerVersion: null,
    label: 'VERIFIED_SUCCESS',
    failureSource: null,
    executionHealth: 'HEALTHY',
    recoveryAction: null,
    attemptNumber: 1,
    wallTimeMs: 4 * 60_000,
    inputTokens: 30_000,
    outputTokens: 3_000,
    fiveHourBurnRatio: null,
    costUsd: null,
    contextTokens: 20_000,
    contextExpansions: 0,
    contextInsufficient: false,
    safetyEvent: false,
    observedAt: new Date(NOW.getTime() - 60_000).toISOString(),
  };
  return { ...base, ...overrides };
}

/** N observations for one target, with a stable id so counts are exact. */
function repeat(count: number, overrides: Partial<AdaptiveObservation> = {}): AdaptiveObservation[] {
  return Array.from({ length: count }, (_unused, index) =>
    observation({ attemptId: `at-${overrides.candidateKey ?? 'x'}-${index}`, ...overrides }),
  );
}

const DIRECT_KEY = 'LOCAL/DIRECT_MODEL/local-llamacpp/qwen-a/LEGACY';
const HARNESS_KEY = 'LOCAL/HARNESS/deepseek-harness/qwen-a/LEGACY';

function directObservations(count: number, overrides: Partial<AdaptiveObservation> = {}) {
  return repeat(count, {
    candidateKey: DIRECT_KEY,
    targetKey: 'LOCAL/DIRECT_MODEL',
    executionMode: 'DIRECT_MODEL',
    runner: 'local-llamacpp',
    ...overrides,
  });
}

function harnessObservations(count: number, overrides: Partial<AdaptiveObservation> = {}) {
  return repeat(count, {
    candidateKey: HARNESS_KEY,
    targetKey: 'LOCAL/HARNESS',
    executionMode: 'HARNESS',
    runner: 'deepseek-harness',
    ...overrides,
  });
}

function profilesFrom(observations: readonly AdaptiveObservation[], p = POLICY) {
  return aggregateProfiles({ observations, policy: p, now: NOW });
}

function localCandidates(overrides: Partial<GenerateCandidatesInput> = {}) {
  const routing = {
    suitability: { class: 'LOCAL_TRY', category: 'unit-test', signals: [] },
    estimate: { retryProbability: 0.4 },
    routing: { lane: 'LOCAL', reasonCode: 'LOCAL_TRY_FIRST' },
    localExecution: { mode: 'DIRECT_MODEL' },
  } as unknown as NodeLaneRouting;
  return generateCandidates({
    routing,
    contextStrategy: 'LEGACY',
    harnessBinding: {
      status: 'BOUND',
      available: true,
      profileName: 'dsh-local',
      runner: 'deepseek-harness',
      model: 'qwen-a',
      locality: 'LOCAL',
      localityEvidence: 'loopback endpoint',
      credentialRisks: [],
      localityOverridden: false,
      problems: [],
      maxWallTimeMs: 900_000,
    },
    localDirectAvailable: true,
    localDirectModel: 'qwen-a',
    localDirectRunner: 'local-llamacpp',
    apiBinding: {
      status: 'UNBOUND',
      available: false,
      profileName: null,
      runner: null,
      model: null,
      locality: 'UNKNOWN',
    } as unknown as GenerateCandidatesInput['apiBinding'],
    subscriptionProvider: 'claude-code',
    exhaustedStrategies: [],
    planRevision: 1,
    ...overrides,
  });
}

function rank(input: {
  mode: 'HEURISTIC' | 'SHADOW' | 'ADAPTIVE';
  observations: readonly AdaptiveObservation[];
  candidates?: ReturnType<typeof generateCandidates> | undefined;
  p?: AdaptiveSchedulerPolicy | undefined;
  prior?: number | undefined;
  forecast?: QuotaForecast | undefined;
}) {
  const effective = input.p ?? POLICY;
  return rankCandidates({
    mode: input.mode,
    candidates: input.candidates ?? localCandidates(),
    signature: signature(),
    profiles: profilesFrom(input.observations, effective),
    policy: effective,
    forecast: input.forecast ?? FORECAST,
    priorSuccessProbability: input.prior ?? 0.6,
    heuristicWallTimeMs: 10 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Statistics primitives
// ---------------------------------------------------------------------------

describe('adaptive statistics primitives', () => {
  it('percentile uses nearest rank and reports null for an empty sample', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it('recency weight halves at the half-life and never exceeds one', () => {
    expect(recencyWeight(0, 1_000)).toBe(1);
    expect(recencyWeight(-5_000, 1_000)).toBe(1);
    expect(recencyWeight(1_000, 1_000)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(2_000, 1_000)).toBeCloseTo(0.25, 10);
  });

  it('normalization saturates and treats unknown as unpenalized', () => {
    expect(normalize(null, 100)).toBe(0);
    expect(normalize(0, 100)).toBe(0);
    expect(normalize(100, 100)).toBeCloseTo(0.5, 10);
    expect(normalize(1e12, 100)).toBeLessThan(1);
    expect(normalize(1e12, 100)).toBeGreaterThan(0.999);
  });
});

// ---------------------------------------------------------------------------
// Outcome labelling
// ---------------------------------------------------------------------------

describe('observed outcome labelling', () => {
  function ledgerEntry(overrides: Partial<ExecutionLedgerEntry> = {}): ExecutionLedgerEntry {
    return {
      attemptId: 'at-1',
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: 't1',
      role: 'EXECUTOR',
      provider: 'local-llamacpp',
      model: 'qwen-a',
      lane: 'LOCAL',
      status: 'COMPLETED',
      attemptNumber: 1,
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      success: true,
      failureReason: null,
      localSuitability: 'LOCAL_TRY',
      taskComplexity: 'MEDIUM',
      taskCategory: 'unit-test',
      schedulingDecisionId: null,
      executionMode: 'DIRECT_MODEL',
      executionShape: 'ONE_SHOT',
      computeLocality: 'LOCAL',
      apiSpendMode: null,
      gapReason: null,
      subscriptionAvailableAt: null,
      estimatedGapDurationMs: null,
      costSource: null,
      pricingProfile: null,
      apiBudgetReservationId: null,
      apiApprovalId: null,
      delaySensitivity: null,
      evaluationStatus: 'PASS',
      evaluationId: 'ev-1',
      failureSource: null,
      failureFingerprint: null,
      executionHealth: 'HEALTHY',
      recoveryAction: null,
      recoveryReasonCode: null,
      recoveryDecisionId: null,
      strategyChange: null,
      taskSignature: signature().key,
      contextStrategy: 'LEGACY',
      runnerVersion: null,
      metrics: {
        durationMs: 60_000,
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
        estimatedCostUsd: null,
        reservedCostUsd: null,
        reconciledCostUsd: null,
      },
      ...overrides,
    } as ExecutionLedgerEntry;
  }

  it('success requires verified evidence, not a worker claim', () => {
    const [verified] = deriveAdaptiveObservations({ entries: [ledgerEntry()] });
    expect(verified?.label).toBe('VERIFIED_SUCCESS');

    const [claimed] = deriveAdaptiveObservations({
      entries: [ledgerEntry({ evaluationStatus: null, evaluationId: null })],
    });
    expect(claimed?.label).toBe('UNVERIFIED_SUCCESS');
  });

  it('separates infrastructure failure from implementation failure', () => {
    const [infra] = deriveAdaptiveObservations({
      entries: [
        ledgerEntry({
          status: 'FAILED',
          success: false,
          evaluationStatus: 'FAIL',
          failureSource: 'EXECUTION_INFRASTRUCTURE',
        }),
      ],
    });
    expect(infra?.label).toBe('INFRASTRUCTURE_FAILURE');

    const [implementation] = deriveAdaptiveObservations({
      entries: [
        ledgerEntry({
          status: 'FAILED',
          success: false,
          evaluationStatus: 'FAIL',
          failureSource: 'IMPLEMENTATION',
        }),
      ],
    });
    expect(implementation?.label).toBe('IMPLEMENTATION_FAILURE');
  });

  it('INCONCLUSIVE and INTERRUPTED are neither success nor failure', () => {
    const [inconclusive] = deriveAdaptiveObservations({
      entries: [ledgerEntry({ status: 'FAILED', success: false, evaluationStatus: 'INCONCLUSIVE' })],
    });
    expect(inconclusive?.label).toBe('INCONCLUSIVE');

    const [censored] = deriveAdaptiveObservations({
      entries: [ledgerEntry({ status: 'INTERRUPTED', success: false, evaluationStatus: null })],
    });
    expect(censored?.label).toBe('CENSORED');
  });

  it('only executed EXECUTOR attempts become evidence', () => {
    const derived = deriveAdaptiveObservations({
      entries: [
        ledgerEntry({ attemptId: 'at-planner', role: 'PLANNER' }),
        ledgerEntry({ attemptId: 'at-running', status: 'RUNNING', success: false }),
        ledgerEntry({ attemptId: 'at-real' }),
      ],
    });
    expect(derived.map((entry) => entry.attemptId)).toEqual(['at-real']);
  });
});

// ---------------------------------------------------------------------------
// Aggregation and smoothing
// ---------------------------------------------------------------------------

describe('performance profiles', () => {
  it('Test P: infrastructure failures do not lower the intelligence success rate', () => {
    const observations = [
      ...directObservations(6, { label: 'VERIFIED_SUCCESS' }),
      ...directObservations(4, {
        label: 'INFRASTRUCTURE_FAILURE',
        failureSource: 'EXECUTION_INFRASTRUCTURE',
      }).map((entry, index) => ({ ...entry, attemptId: `crash-${index}` })),
    ];
    const set = profilesFrom(observations);
    const profile = [...set.profiles.values()].find(
      (entry) => entry.level === 'EXACT' && entry.targetPart === DIRECT_KEY,
    );
    expect(profile).toBeDefined();
    expect(profile?.verifiedSuccesses).toBe(6);
    expect(profile?.infrastructureFailures).toBe(4);
    expect(profile?.implementationFailures).toBe(0);
    // The intelligence question was resolved 6 times, all successfully; the
    // crashes are visible, counted, and priced elsewhere.
    expect(profile?.weightedIntelligenceAttempts).toBeCloseTo(
      profile?.weightedVerifiedSuccesses ?? 0,
      6,
    );
    expect(profile?.infrastructureFailureRate).toBeCloseTo(0.4, 6);
  });

  it('excludes INCONCLUSIVE from both sides of the intelligence rate', () => {
    const set = profilesFrom([
      ...directObservations(3, { label: 'VERIFIED_SUCCESS' }),
      ...directObservations(5, { label: 'INCONCLUSIVE' }).map((entry, index) => ({
        ...entry,
        attemptId: `inc-${index}`,
      })),
    ]);
    const profile = [...set.profiles.values()].find(
      (entry) => entry.level === 'EXACT' && entry.targetPart === DIRECT_KEY,
    );
    expect(profile?.inconclusive).toBe(5);
    expect(profile?.weightedIntelligenceAttempts).toBeCloseTo(
      profile?.weightedVerifiedSuccesses ?? 0,
      6,
    );
  });

  it('counts censored attempts and prices their wasted wall time', () => {
    const set = profilesFrom([
      ...directObservations(2, { label: 'VERIFIED_SUCCESS' }),
      ...directObservations(2, { label: 'CENSORED', wallTimeMs: 5 * 60_000 }).map(
        (entry, index) => ({ ...entry, attemptId: `cut-${index}` }),
      ),
    ]);
    const profile = [...set.profiles.values()].find(
      (entry) => entry.level === 'EXACT' && entry.targetPart === DIRECT_KEY,
    );
    expect(profile?.censored).toBe(2);
    expect(profile?.failedWallTimeMs).toBe(10 * 60_000);
  });

  it('Test S: safety-class failures survive the age cutoff', () => {
    const ancient = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();
    const set = profilesFrom([
      ...directObservations(3),
      ...directObservations(1, {
        label: 'IMPLEMENTATION_FAILURE',
        failureSource: 'AUTHORIZATION',
        safetyEvent: true,
        observedAt: ancient,
      }).map((entry) => ({ ...entry, attemptId: 'violation' })),
      ...directObservations(1, { label: 'IMPLEMENTATION_FAILURE', observedAt: ancient }).map(
        (entry) => ({ ...entry, attemptId: 'ordinary-old' }),
      ),
    ]);
    const profile = [...set.profiles.values()].find(
      (entry) => entry.level === 'EXACT' && entry.targetPart === DIRECT_KEY,
    );
    // The ordinary ancient failure aged out; the safety event did not.
    expect(profile?.safetyEvents).toBe(1);
    expect(set.droppedByAge).toBe(1);
  });

  it('Test R: recency lets recent poor performance outweigh old strong performance', () => {
    const old = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();
    const recent = new Date(NOW.getTime() - 86_400_000).toISOString();
    const set = profilesFrom([
      ...directObservations(10, { label: 'VERIFIED_SUCCESS', observedAt: old }).map(
        (entry, index) => ({ ...entry, attemptId: `old-${index}` }),
      ),
      ...directObservations(10, { label: 'IMPLEMENTATION_FAILURE', observedAt: recent }).map(
        (entry, index) => ({ ...entry, attemptId: `new-${index}` }),
      ),
    ]);
    const profile = [...set.profiles.values()].find(
      (entry) => entry.level === 'EXACT' && entry.targetPart === DIRECT_KEY,
    );
    // Raw counts are level; weighted evidence is dominated by the recent
    // failures, so the smoothed estimate must fall well below one half.
    expect(profile?.verifiedSuccesses).toBe(10);
    expect(profile?.implementationFailures).toBe(10);
    expect(profile?.weightedVerifiedSuccesses).toBeLessThan(
      (profile?.weightedIntelligenceAttempts ?? 0) / 2,
    );
  });

  it('Test Q: a model version change is detected as drift', () => {
    const set = profilesFrom([
      ...directObservations(4, { model: 'qwen-a' }).map((entry, index) => ({
        ...entry,
        attemptId: `a-${index}`,
        observedAt: new Date(NOW.getTime() - 10 * 86_400_000 + index * 1_000).toISOString(),
      })),
      ...directObservations(4, { model: 'qwen-b' }).map((entry, index) => ({
        ...entry,
        attemptId: `b-${index}`,
        observedAt: new Date(NOW.getTime() - 86_400_000 + index * 1_000).toISOString(),
      })),
    ]);
    const profile = [...set.profiles.values()].find(
      (entry) => entry.level === 'EXACT' && entry.targetPart === DIRECT_KEY,
    );
    expect(profile?.drift.detected).toBe(true);
    expect(profile?.drift.signals).toContain('RUNTIME_IDENTITY_CHANGED');
  });
});

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

describe('candidate prediction', () => {
  function candidate(overrides: Partial<ExecutionCandidate> = {}): ExecutionCandidate {
    return {
      candidateId: DIRECT_KEY,
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      runner: 'local-llamacpp',
      model: 'qwen-a',
      profile: null,
      contextStrategy: 'LEGACY',
      computeLocality: 'LOCAL',
      heuristicChoice: true,
      handoffOverheadMs: 2_000,
      strategyKey: 'k',
      ...overrides,
    };
  }

  it('Test A: cold start yields NONE confidence and the prior as the estimate', () => {
    const prediction = predictCandidate({
      candidate: candidate(),
      signature: signature(),
      profiles: profilesFrom([]),
      policy: POLICY,
      priorSuccessProbability: 0.6,
    });
    expect(prediction.level).toBe('HEURISTIC_PRIOR');
    expect(prediction.confidence).toBe('NONE');
    expect(prediction.sampleCount).toBe(0);
    expect(prediction.verifiedSuccessProbability).toBeCloseTo(0.6, 10);
  });

  it('Test B: one success out of one attempt is not near-certainty', () => {
    const prediction = predictCandidate({
      candidate: candidate(),
      signature: signature(),
      profiles: profilesFrom(directObservations(1)),
      policy: POLICY,
      priorSuccessProbability: 0.6,
    });
    // (1 + 4*0.6) / (1 + 4) = 0.68 — a nudge, not a verdict.
    expect(prediction.verifiedSuccessProbability).toBeGreaterThan(0.6);
    expect(prediction.verifiedSuccessProbability).toBeLessThan(0.75);
    expect(prediction.confidence).toBe('LOW');
  });

  it('the smoothing formula matches its documented definition', () => {
    const observations = [
      ...directObservations(8, { label: 'VERIFIED_SUCCESS', observedAt: NOW.toISOString() }),
      ...directObservations(2, {
        label: 'IMPLEMENTATION_FAILURE',
        observedAt: NOW.toISOString(),
      }).map((entry, index) => ({ ...entry, attemptId: `f-${index}` })),
    ];
    const prediction = predictCandidate({
      candidate: candidate(),
      signature: signature(),
      profiles: profilesFrom(observations),
      policy: POLICY,
      priorSuccessProbability: 0.5,
    });
    // Weights are ~1 at zero age: (8 + 4*0.5) / (10 + 4) = 10/14.
    expect(prediction.verifiedSuccessProbability).toBeCloseTo(10 / 14, 4);
    expect(prediction.observedSuccessRate).toBeCloseTo(0.8, 6);
  });

  it('sparse exact data falls back to the coarser profile and records the level', () => {
    // Exact key present but thin; the category-level bucket is well populated
    // by observations under a DIFFERENT model of the same runner.
    const observations = [
      ...directObservations(1, { model: 'qwen-a' }),
      ...directObservations(10, { model: 'qwen-z' }).map((entry, index) => ({
        ...entry,
        attemptId: `z-${index}`,
        candidateKey: 'LOCAL/DIRECT_MODEL/local-llamacpp/qwen-z/LEGACY',
      })),
    ];
    const prediction = predictCandidate({
      candidate: candidate(),
      signature: signature(),
      profiles: profilesFrom(observations),
      policy: policy({ minimumComparableSamples: 4 }),
      priorSuccessProbability: 0.5,
    });
    expect(prediction.level).toBe('TARGET_CATEGORY');
    expect(prediction.sampleCount).toBe(11);
    expect(prediction.notes.join(' ')).toContain('coarser task-category profile');
  });

  it('Test Q: a changed runner is cold start, not transferred confidence', () => {
    const prediction = predictCandidate({
      candidate: candidate({ runner: 'some-other-runner' }),
      signature: signature(),
      profiles: profilesFrom(directObservations(20)),
      policy: POLICY,
      priorSuccessProbability: 0.5,
    });
    expect(['CHANGED', 'UNKNOWN']).toContain(prediction.identityMatch);
    expect(prediction.confidence).not.toBe('HIGH');
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

describe('expected utility', () => {
  it('quota opportunity cost is zero off the subscription lane', () => {
    expect(quotaOpportunityCost({ lane: 'LOCAL', forecast: FORECAST }).value).toBe(0);
    expect(quotaOpportunityCost({ lane: 'API', forecast: FORECAST }).value).toBe(0);
  });

  it('HARVEST makes expiring subscription capacity a bonus, scarcity a penalty', () => {
    const harvest = quotaOpportunityCost({
      lane: 'SUBSCRIPTION',
      forecast: { ...FORECAST, schedulerMode: 'HARVEST', fiveHourRemainingRatio: 0.6 },
    });
    expect(harvest.value).toBeLessThan(0);

    const conserve = quotaOpportunityCost({
      lane: 'SUBSCRIPTION',
      forecast: { ...FORECAST, schedulerMode: 'CONSERVE', fiveHourRemainingRatio: 0.1 },
    });
    expect(conserve.value).toBeGreaterThan(0);
  });

  it('quality dominates cheapness: 30% less likely beats 10% cheaper', () => {
    const strong = predictCandidate({
      candidate: {
        candidateId: HARNESS_KEY,
        lane: 'LOCAL',
        executionMode: 'HARNESS',
        runner: 'deepseek-harness',
        model: 'qwen-a',
        profile: null,
        contextStrategy: 'LEGACY',
        computeLocality: 'LOCAL',
        heuristicChoice: false,
        handoffOverheadMs: 30_000,
        strategyKey: 'h',
      },
      signature: signature(),
      profiles: profilesFrom(harnessObservations(20, { wallTimeMs: 12 * 60_000 })),
      policy: POLICY,
      priorSuccessProbability: 0.5,
    });
    const weak = predictCandidate({
      candidate: {
        candidateId: DIRECT_KEY,
        lane: 'LOCAL',
        executionMode: 'DIRECT_MODEL',
        runner: 'local-llamacpp',
        model: 'qwen-a',
        profile: null,
        contextStrategy: 'LEGACY',
        computeLocality: 'LOCAL',
        heuristicChoice: true,
        handoffOverheadMs: 2_000,
        strategyKey: 'd',
      },
      signature: signature(),
      profiles: profilesFrom([
        ...directObservations(10, { label: 'VERIFIED_SUCCESS', wallTimeMs: 3 * 60_000 }),
        ...directObservations(10, {
          label: 'IMPLEMENTATION_FAILURE',
          wallTimeMs: 3 * 60_000,
        }).map((entry, index) => ({ ...entry, attemptId: `wf-${index}` })),
      ]),
      policy: POLICY,
      priorSuccessProbability: 0.5,
    });
    const strongScore = scoreCandidate({ prediction: strong, policy: POLICY, forecast: FORECAST });
    const weakScore = scoreCandidate({ prediction: weak, policy: POLICY, forecast: FORECAST });
    expect(strong.verifiedSuccessProbability).toBeGreaterThan(weak.verifiedSuccessProbability + 0.3);
    expect(strongScore.score).toBeGreaterThan(weakScore.score);
  });

  it('Test O: no-progress history costs a candidate its apparent advantage', () => {
    const healthy = profilesFrom(harnessObservations(20, { wallTimeMs: 10 * 60_000 }));
    const stalling = profilesFrom(
      harnessObservations(20, { wallTimeMs: 10 * 60_000 }).map((entry, index) => ({
        ...entry,
        attemptId: `s-${index}`,
        executionHealth: index % 2 === 0 ? 'STALLED' : 'OSCILLATING',
      })),
    );
    const base = {
      candidate: {
        candidateId: HARNESS_KEY,
        lane: 'LOCAL' as const,
        executionMode: 'HARNESS' as const,
        runner: 'deepseek-harness',
        model: 'qwen-a',
        profile: null,
        contextStrategy: 'LEGACY' as const,
        computeLocality: 'LOCAL' as const,
        heuristicChoice: false,
        handoffOverheadMs: 30_000,
        strategyKey: 'h',
      },
      signature: signature(),
      policy: POLICY,
      priorSuccessProbability: 0.5,
    };
    const healthyScore = scoreCandidate({
      prediction: predictCandidate({ ...base, profiles: healthy }),
      policy: POLICY,
      forecast: FORECAST,
    });
    const stallingScore = scoreCandidate({
      prediction: predictCandidate({ ...base, profiles: stalling }),
      policy: POLICY,
      forecast: FORECAST,
    });
    // Identical eventual success and wall time; only the no-progress history
    // differs, and it must make the candidate strictly less attractive.
    expect(stallingScore.score).toBeLessThan(healthyScore.score);
    const failedWork = stallingScore.components.find((entry) => entry.name === 'failedWork');
    expect(failedWork?.detail).toContain('no-progress');
  });
});

// ---------------------------------------------------------------------------
// Candidate generation and hard-policy vetoes
// ---------------------------------------------------------------------------

describe('candidate generation stays inside hard policy', () => {
  it('Test E/H: a DEFER routing yields no executable candidate', () => {
    const set = localCandidates({
      routing: {
        suitability: { class: 'STRONG_REQUIRED', category: 'general', signals: [] },
        estimate: {},
        routing: { lane: 'DEFER', reasonCode: 'API_GAP_SHORT_DEFER' },
      } as unknown as NodeLaneRouting,
    });
    expect(set.eligible).toHaveLength(0);
    expect(set.rejected.map((entry) => entry.code)).toContain('LANE_NOT_ELIGIBLE');
  });

  it('Test F: an unverified-locality harness is rejected, never ranked', () => {
    const set = localCandidates({
      harnessBinding: {
        status: 'BOUND',
        available: true,
        profileName: 'dsh-remote',
        runner: 'deepseek-harness',
        model: 'qwen-a',
        locality: 'REMOTE',
        localityEvidence: 'remote endpoint',
        credentialRisks: [],
        localityOverridden: false,
        problems: [],
        maxWallTimeMs: 900_000,
      },
    });
    expect(set.eligible.map((entry) => entry.executionMode)).toEqual(['DIRECT_MODEL']);
    const veto = set.rejected.find((entry) => entry.code === 'REMOTE_NOT_LOCAL');
    expect(veto).toBeDefined();
    expect(veto?.detail).toContain('cannot make remote compute local');
  });

  it('a SUBSCRIPTION routing never produces an API candidate', () => {
    const set = localCandidates({
      routing: {
        suitability: { class: 'STRONG_REQUIRED', category: 'general', signals: [] },
        estimate: {},
        routing: { lane: 'SUBSCRIPTION', reasonCode: 'STRONG_REQUIRED' },
      } as unknown as NodeLaneRouting,
    });
    expect(set.eligible.map((entry) => entry.lane)).toEqual(['SUBSCRIPTION']);
  });

  it('Test X: a strategy vNext.6 already retired is vetoed, not ranked', () => {
    const forbidden = strategyKey({
      lane: 'LOCAL',
      executionMode: 'HARNESS',
      planRevision: 1,
      freshContext: false,
    });
    const set = localCandidates({ exhaustedStrategies: [forbidden] });
    expect(set.eligible.map((entry) => entry.executionMode)).toEqual(['DIRECT_MODEL']);
    expect(set.rejected.map((entry) => entry.code)).toContain('RELIABILITY_STRATEGY_FORBIDDEN');
  });

  it('candidate keys keep every dimension orthogonal', () => {
    expect(
      candidateKey({
        lane: 'LOCAL',
        executionMode: 'HARNESS',
        runner: 'deepseek-harness',
        model: null,
        contextStrategy: 'SELECTIVE',
      }),
    ).toBe('LOCAL/HARNESS/deepseek-harness/-/SELECTIVE');
  });
});

// ---------------------------------------------------------------------------
// Ranking and modes
// ---------------------------------------------------------------------------

describe('candidate ranking and rollout modes', () => {
  /**
   * Deterministic even spread of `successes` successes across `total`
   * attempts. Interleaved rather than blocked on purpose: a fixture that
   * puts every success first and every failure last describes a target whose
   * performance collapsed halfway through the window, and the drift detector
   * is right to say so. Steady-state history has to look steady.
   */
  function isSuccessAt(index: number, total: number, successes: number): boolean {
    return (
      Math.floor((index * successes) / total) < Math.floor(((index + 1) * successes) / total)
    );
  }

  function history(input: {
    build: (count: number, overrides: Partial<AdaptiveObservation>) => AdaptiveObservation[];
    prefix: string;
    total: number;
    successes: number;
    wallTimeMs: number;
    failureOverrides?: Partial<AdaptiveObservation> | undefined;
    overrides?: Partial<AdaptiveObservation> | undefined;
  }): AdaptiveObservation[] {
    return input
      .build(input.total, { wallTimeMs: input.wallTimeMs, ...(input.overrides ?? {}) })
      .map((entry, index) => {
        const success = isSuccessAt(index, input.total, input.successes);
        return {
          ...entry,
          ...(success ? {} : (input.failureOverrides ?? {})),
          attemptId: `${input.prefix}-${index}`,
          label: success ? ('VERIFIED_SUCCESS' as const) : ('IMPLEMENTATION_FAILURE' as const),
          // Spread across three recent days so recency weights stay near 1
          // and the drift windows compare like with like.
          observedAt: new Date(
            NOW.getTime() - 3 * 86_400_000 + index * 3_600_000,
          ).toISOString(),
        };
      });
  }

  /** Simple work: DIRECT succeeds cheaply, HARNESS succeeds but is far slower. */
  const SIMPLE_HISTORY = [
    ...history({
      build: directObservations,
      prefix: 'sd',
      total: 20,
      successes: 20,
      wallTimeMs: 3 * 60_000,
    }),
    ...history({
      build: harnessObservations,
      prefix: 'sh',
      total: 20,
      successes: 20,
      wallTimeMs: 30 * 60_000,
    }),
  ];

  /** Agentic work: DIRECT mostly fails on context, HARNESS mostly verifies. */
  const AGENTIC_HISTORY = [
    ...history({
      build: directObservations,
      prefix: 'ad',
      total: 20,
      successes: 4,
      wallTimeMs: 5 * 60_000,
      failureOverrides: { contextInsufficient: true, failureSource: 'CONTEXT' },
    }),
    ...history({
      build: harnessObservations,
      prefix: 'ah',
      total: 20,
      successes: 17,
      wallTimeMs: 14 * 60_000,
    }),
  ];

  it('Test A: cold start falls back to the heuristic', () => {
    const result = rank({ mode: 'ADAPTIVE', observations: [] });
    expect(result.adaptiveApplied).toBe(false);
    expect(result.confidence).toBe('NONE');
    expect(result.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');
    expect(['COLD_START', 'AGREES_WITH_HEURISTIC']).toContain(result.fallbackReason);
  });

  it('Test C: DIRECT wins a simple task and the heuristic already agrees', () => {
    const result = rank({ mode: 'ADAPTIVE', observations: SIMPLE_HISTORY });
    expect(result.recommendedCandidate?.executionMode).toBe('DIRECT_MODEL');
    expect(result.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');
    expect(result.fallbackReason).toBe('AGREES_WITH_HEURISTIC');
    expect(result.disagreement).toBe(false);
  });

  it('Test D: HARNESS wins an agentic task and adaptive applies it', () => {
    const result = rank({ mode: 'ADAPTIVE', observations: AGENTIC_HISTORY });
    expect(result.recommendedCandidate?.executionMode).toBe('HARNESS');
    expect(result.adaptiveApplied).toBe(true);
    expect(result.selectedCandidate?.executionMode).toBe('HARNESS');
    expect(result.fallbackReason).toBeNull();
    expect(result.confidence === 'MEDIUM' || result.confidence === 'HIGH').toBe(true);
  });

  it('Test T: SHADOW records the disagreement and executes the heuristic', () => {
    const result = rank({ mode: 'SHADOW', observations: AGENTIC_HISTORY });
    expect(result.recommendedCandidate?.executionMode).toBe('HARNESS');
    expect(result.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');
    expect(result.adaptiveApplied).toBe(false);
    expect(result.disagreement).toBe(true);
    expect(result.wouldApplyInAdaptiveMode).toBe(true);
    expect(result.fallbackReason).toBe('MODE_SHADOW');
    // No counterfactual outcome is claimed anywhere in the explanation.
    const prose = result.explanation.join(' ');
    expect(prose).toContain('was NOT run');
    expect(prose).not.toMatch(/would have (succeeded|passed|verified)/i);
  });

  it('HEURISTIC mode never applies a recommendation', () => {
    const result = rank({ mode: 'HEURISTIC', observations: AGENTIC_HISTORY });
    expect(result.adaptiveApplied).toBe(false);
    expect(result.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');
    expect(result.fallbackReason).toBe('MODE_HEURISTIC');
  });

  it('Test U: a recommendation below the confidence floor falls back', () => {
    const result = rank({
      mode: 'ADAPTIVE',
      observations: AGENTIC_HISTORY,
      p: policy({ minimumConfidence: 'HIGH', minimumSamplesForAdaptiveDecision: 200 }),
    });
    expect(result.adaptiveApplied).toBe(false);
    expect(result.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');
    expect(result.fallbackReason).toBe('INSUFFICIENT_SAMPLES');
  });

  it('Test V: a tiny utility advantage does not move a stable placement', () => {
    // Same success and near-identical timings: the margin cannot clear
    // hysteresis, so the incumbent stands.
    const observations = [
      ...directObservations(20, { label: 'VERIFIED_SUCCESS', wallTimeMs: 10 * 60_000 }),
      ...harnessObservations(20, { label: 'VERIFIED_SUCCESS', wallTimeMs: 10 * 60_000 - 1_000 }),
    ];
    const result = rank({ mode: 'ADAPTIVE', observations });
    expect(result.adaptiveApplied).toBe(false);
    expect(Math.abs(result.utilityMargin ?? 1)).toBeLessThan(POLICY.minimumUtilityImprovement);
    expect(['UTILITY_MARGIN_TOO_SMALL', 'AGREES_WITH_HEURISTIC']).toContain(result.fallbackReason);
  });

  it('Test W: every candidate vetoed leaves nothing to rank', () => {
    const result = rankCandidates({
      mode: 'ADAPTIVE',
      candidates: {
        eligible: [],
        rejected: [
          {
            candidateId: 'API/HARNESS/deepseek-harness/-/LEGACY',
            lane: 'API',
            executionMode: 'HARNESS',
            runner: 'deepseek-harness',
            code: 'API_BUDGET_EXCEEDED',
            detail: 'The safe cost estimate exceeds the authorized job budget.',
          },
        ],
      },
      signature: signature(),
      profiles: profilesFrom([]),
      policy: POLICY,
      forecast: FORECAST,
      priorSuccessProbability: 0.5,
    });
    expect(result.selectedCandidate).toBeNull();
    expect(result.fallbackReason).toBe('ALL_PREFERRED_CANDIDATES_VETOED');
    expect(result.explanation.join(' ')).toContain('API_BUDGET_EXCEEDED');
  });

  it('a single eligible candidate is never presented as a ranking', () => {
    const result = rank({
      mode: 'ADAPTIVE',
      observations: SIMPLE_HISTORY,
      candidates: localCandidates({ localDirectAvailable: false }),
    });
    expect(result.fallbackReason).toBe('SINGLE_CANDIDATE');
    expect(result.adaptiveApplied).toBe(false);
  });

  it('the score breakdown explains the choice in words, not just a number', () => {
    const result = rank({ mode: 'ADAPTIVE', observations: AGENTIC_HISTORY });
    const prose = result.explanation.join('\n');
    expect(prose).toContain('verified success:');
    expect(prose).toContain('expected attempts:');
    expect(prose).toContain('confidence:');
    const winner = result.ranked[0];
    expect(winner?.score.components.map((entry) => entry.name)).toEqual([
      'verifiedSuccess',
      'latency',
      'failedWork',
      'quotaOpportunityCost',
      'apiCost',
      'contextCost',
      'handoff',
    ]);
  });

  it('ranking is deterministic across repeated evaluation', () => {
    const first = rank({ mode: 'ADAPTIVE', observations: AGENTIC_HISTORY });
    const second = rank({ mode: 'ADAPTIVE', observations: AGENTIC_HISTORY });
    expect(second.ranked.map((entry) => entry.score.score)).toEqual(
      first.ranked.map((entry) => entry.score.score),
    );
    expect(second.selectedCandidate?.candidateId).toBe(first.selectedCandidate?.candidateId);
  });

  it('Test N: a context-thrifty strategy with frequent misses does not win on prompt size', () => {
    // SELECTIVE-style history: small initial context, frequent expansion and
    // context-driven failure. PROGRESSIVE-style: larger context, verifies.
    const thrifty = directObservations(20, {
      contextTokens: 8_000,
      contextExpansions: 2,
      label: 'IMPLEMENTATION_FAILURE',
      contextInsufficient: true,
      failureSource: 'CONTEXT',
    }).map((entry, index) => ({ ...entry, attemptId: `thin-${index}` }));
    const generous = harnessObservations(20, {
      contextTokens: 26_000,
      contextExpansions: 0,
      label: 'VERIFIED_SUCCESS',
    });
    const result = rank({ mode: 'ADAPTIVE', observations: [...thrifty, ...generous] });
    expect(result.recommendedCandidate?.executionMode).toBe('HARNESS');
    const winner = result.ranked[0];
    const contextComponent = winner?.score.components.find((entry) => entry.name === 'contextCost');
    // Context is priced per verified completion, not per prompt.
    expect(contextComponent?.detail).toContain('per verified');
  });
});
