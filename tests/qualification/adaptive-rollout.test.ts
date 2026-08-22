import { describe, expect, it } from 'vitest';
import type { AdaptiveSchedulerPolicy, AgentConfig } from '@specbridge/core';
import {
  aggregateProfiles,
  beginTaskAttempt,
  buildTaskSignature,
  completeTaskAttempt,
  createJob,
  deriveAdaptiveObservations,
  generateCandidates,
  loadAdaptiveProfiles,
  rankCandidates,
  readExecutionLedger,
  recordScenarioResult,
  startQualificationRun,
  writeEvaluationResult,
} from '@specbridge/orchestration';
import type {
  GenerateCandidatesInput,
  NodeLaneRouting,
  QuotaForecast,
} from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';
import { fixtureTarget, setupQualificationWorkspace } from '../helpers-qualification.js';

/**
 * vNext.9 — the staged adaptive rollout, and its rollback.
 *
 * The rollout order the phase requires is HEURISTIC, then SHADOW, then
 * ADAPTIVE, and the property that makes it safe is that the FIRST two never
 * change a placement. This scenario walks that order over one accumulating
 * history and pins three things:
 *
 *   in SHADOW, recommendations and disagreements are recorded and the
 *   heuristic choice still executes;
 *
 *   in ADAPTIVE, history may select among candidates hard policy already
 *   declared eligible — and only then;
 *
 *   switching back to HEURISTIC is instant: same job, same durable state, no
 *   migration, and the placement immediately reverts.
 *
 * The rollback claim is the one that matters operationally. If reverting an
 * unstable adaptive scheduler required rebuilding a job, nobody could safely
 * enable it on real work in the first place.
 *
 * The history below is TEST DATA. None of it is encoded in production
 * policy, and the assertions are about the scheduler's reasoning rather than
 * about any real provider.
 */

const NOW = new Date('2026-08-01T09:00:00.000Z');

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

interface Fixture extends OrchestrationFixture {
  jobId: string;
}

function fixtureWith(adaptive: Partial<AdaptiveSchedulerPolicy> = {}): Fixture {
  const base = setupOrchestrationFixture({ policy: { jobs: { scheduler: { adaptive } } } });
  const job = createJob(base.deps, {
    specName: base.specName,
    goal: 'Implement the approved settings-persistence plan.',
  });
  return { ...base, jobId: job.jobId };
}

function adaptivePolicyOf(config: AgentConfig): AdaptiveSchedulerPolicy {
  return config.orchestration.jobs.scheduler.adaptive;
}

const SIGNATURE = buildTaskSignature({
  category: 'unit-test',
  complexity: 'MEDIUM',
  localSuitability: 'LOCAL_TRY',
  executionShape: 'AGENTIC',
  deterministicVerificationAvailable: true,
});

/** Write one attempt exactly as a real dispatch would leave it. */
function writeAttempt(
  fixture: Fixture,
  input: {
    index: number;
    executionMode: 'DIRECT_MODEL' | 'HARNESS';
    provider: string;
    verified: boolean;
    wallTimeMs: number;
  },
): void {
  const startedAt = new Date(NOW.getTime() - (200 - input.index) * 60_000).toISOString();
  const attempt = beginTaskAttempt(
    { workspace: fixture.workspace, clock: () => new Date(startedAt) },
    {
      jobId: fixture.jobId,
      nodeId: `n-${input.index}`,
      taskId: `t-${input.index}`,
      role: 'EXECUTOR',
      workerId: 'w-exec',
      provider: input.provider,
      model: 'qwen',
      lane: 'LOCAL',
      taskSignature: SIGNATURE.key,
      contextStrategy: 'LEGACY',
      executionMode: input.executionMode,
      computeLocality: 'LOCAL',
    },
  );
  const completedAt = new Date(Date.parse(startedAt) + input.wallTimeMs).toISOString();
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
              category: 'VERIFICATION_FAILURE' as const,
              message: 'trusted verifiers failed',
            },
          }),
      metrics: { durationMs: input.wallTimeMs, inputTokens: 20_000 },
    },
  );
  writeEvaluationResult(fixture.workspace, {
    schemaVersion: '1.0.0',
    evaluationId: `ev-${attempt.attemptId}`,
    jobId: fixture.jobId,
    nodeId: `n-${input.index}`,
    taskId: `t-${input.index}`,
    attemptId: attempt.attemptId,
    lane: 'LOCAL',
    status: input.verified ? 'PASS' : 'FAIL',
    deterministicChecks: [],
    semanticChecks: [],
    semanticFindings: [],
    failedCriteria: [],
    evidenceRefs: [],
    failureSignals: [],
    semanticReviewRan: false,
    reasons: ['synthetic rollout history'],
    createdAt: completedAt,
  });
}

/**
 * A history in which the HARNESS mode is clearly better than DIRECT on this
 * signature — the situation where adaptive placement has something to say.
 */
function accumulateHistory(fixture: Fixture): void {
  let index = 0;
  for (let i = 0; i < 24; i += 1) {
    index += 1;
    writeAttempt(fixture, {
      index,
      executionMode: 'HARNESS',
      provider: 'deepseek-harness',
      verified: true,
      wallTimeMs: 90_000,
    });
  }
  for (let i = 0; i < 24; i += 1) {
    index += 1;
    writeAttempt(fixture, {
      index,
      executionMode: 'DIRECT_MODEL',
      provider: 'local-llamacpp',
      // Direct mode fails most of the time on agentic work here.
      verified: i % 6 === 0,
      wallTimeMs: 20_000,
    });
  }
}

function candidateInput(): GenerateCandidatesInput {
  const routing = {
    suitability: { class: 'LOCAL_TRY', category: 'unit-test', signals: [] },
    estimate: { retryProbability: 0.4 },
    routing: { lane: 'LOCAL', reasonCode: 'LOCAL_TRY_FIRST' },
    // The heuristic prefers DIRECT for this task.
    localExecution: { mode: 'DIRECT_MODEL' },
  } as unknown as NodeLaneRouting;
  return {
    routing,
    contextStrategy: 'LEGACY',
    harnessBinding: {
      status: 'BOUND',
      available: true,
      profileName: 'dsh-local',
      runner: 'deepseek-harness',
      model: 'qwen',
      locality: 'LOCAL',
      localityEvidence: 'loopback endpoint',
      credentialRisks: [],
      localityOverridden: false,
      problems: [],
      maxWallTimeMs: 900_000,
    } as unknown as GenerateCandidatesInput['harnessBinding'],
    localDirectAvailable: true,
    localDirectModel: 'qwen',
    localDirectRunner: 'local-llamacpp',
    apiBinding: {
      status: 'NOT_CONFIGURED',
      available: false,
      profileName: null,
      runner: null,
      model: null,
      locality: 'UNKNOWN',
    } as unknown as GenerateCandidatesInput['apiBinding'],
    subscriptionProvider: 'claude-code',
    exhaustedStrategies: [],
    planRevision: 1,
  };
}

function rank(fixture: Fixture, mode: 'HEURISTIC' | 'SHADOW' | 'ADAPTIVE') {
  const policy = adaptivePolicyOf(fixture.config);
  const observations = deriveAdaptiveObservations({
    entries: readExecutionLedger(fixture.workspace, fixture.jobId),
  });
  return rankCandidates({
    mode,
    candidates: generateCandidates(candidateInput()),
    signature: SIGNATURE,
    profiles: aggregateProfiles({ observations, policy, now: NOW }),
    policy,
    forecast: FORECAST,
    priorSuccessProbability: 0.6,
    heuristicWallTimeMs: 10 * 60_000,
  });
}

describe('vNext.9 adaptive rollout and rollback', () => {
  it('records recommendations in SHADOW without changing placement, then applies them in ADAPTIVE, then reverts instantly', () => {
    const fixture = fixtureWith({ mode: 'SHADOW' });
    accumulateHistory(fixture);

    // ---- Phase A: HEURISTIC — the deterministic scheduler decides alone --
    const heuristic = rank(fixture, 'HEURISTIC');
    expect(heuristic.adaptiveApplied).toBe(false);
    expect(heuristic.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');

    // ---- Phase B: SHADOW — recommendations recorded, placement unchanged -
    const shadow = rank(fixture, 'SHADOW');
    expect(shadow.adaptiveApplied).toBe(false);
    // The heuristic choice still executes, whatever ranking prefers.
    expect(shadow.selectedCandidate?.candidateId).toBe(heuristic.selectedCandidate?.candidateId);
    // A recommendation exists and is explainable.
    expect(shadow.recommendedCandidate).not.toBeNull();
    expect(shadow.explanation.length).toBeGreaterThan(0);
    // The history says HARNESS; the scheduler disagrees with itself and says
    // so, which is exactly what SHADOW is for.
    expect(shadow.recommendedCandidate?.executionMode).toBe('HARNESS');
    expect(shadow.disagreement).toBe(true);
    // No counterfactual outcome is fabricated anywhere in the result.
    expect(JSON.stringify(shadow)).not.toMatch(/wouldHaveSucceeded|counterfactual|regret/i);

    // ---- Phase C: ADAPTIVE — history may now select ----------------------
    const adaptive = rank(fixture, 'ADAPTIVE');
    expect(adaptive.adaptiveApplied).toBe(true);
    expect(adaptive.selectedCandidate?.executionMode).toBe('HARNESS');
    // The selection is still inside the candidate set hard policy produced:
    // a LOCAL routing never yielded a SUBSCRIPTION or API candidate.
    expect(adaptive.ranked.every((entry) => entry.prediction.candidate.lane === 'LOCAL')).toBe(true);

    // ---- Phase D: instant rollback ---------------------------------------
    // The SAME job, the SAME durable state, one configuration value. No
    // migration, no rebuild, no loss — and the placement reverts at once.
    const rolledBack = rank(fixture, 'HEURISTIC');
    expect(rolledBack.adaptiveApplied).toBe(false);
    expect(rolledBack.selectedCandidate?.candidateId).toBe(heuristic.selectedCandidate?.candidateId);
    // The ledger the adaptive layer read is untouched by the rollback: the
    // history survives, so re-enabling later starts from evidence, not zero.
    expect(readExecutionLedger(fixture.workspace, fixture.jobId).length).toBe(48);

    const qualification = setupQualificationWorkspace();
    const run = startQualificationRun(qualification.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(qualification.deps, {
      runId: run.runId,
      scenarioId: 'adaptive.shadow-diagnostics',
      status: 'PASS',
      executor: 'regression-suite',
      observedTransitions: [
        { subject: 'SHADOW placement', from: 'heuristic DIRECT_MODEL', to: 'heuristic DIRECT_MODEL' },
        { subject: 'SHADOW recommendation', from: 'none', to: 'HARNESS (disagreement recorded)' },
      ],
      evidenceRefs: [`job:${fixture.jobId}`],
      resourceAttribution: { ADAPTIVE_PROFILES: 'SIMULATED' },
    });
    recordScenarioResult(qualification.deps, {
      runId: run.runId,
      scenarioId: 'adaptive.mode-rollback',
      status: 'PASS',
      executor: 'regression-suite',
      observedTransitions: [
        { subject: 'ADAPTIVE placement', from: 'DIRECT_MODEL', to: 'HARNESS' },
        { subject: 'rollback to HEURISTIC', from: 'HARNESS', to: 'DIRECT_MODEL' },
        { subject: 'durable ledger entries after rollback', from: '48', to: '48' },
      ],
      evidenceRefs: [`job:${fixture.jobId}`],
      resourceAttribution: { ADAPTIVE_PROFILES: 'SIMULATED' },
    });
    expect(run.runId).toBeTruthy();
  });

  it('reverts to the heuristic when the accumulated history is too sparse to be trusted', () => {
    const fixture = fixtureWith({ mode: 'ADAPTIVE' });
    // Three observations is not evidence.
    for (let index = 1; index <= 3; index += 1) {
      writeAttempt(fixture, {
        index,
        executionMode: 'HARNESS',
        provider: 'deepseek-harness',
        verified: true,
        wallTimeMs: 60_000,
      });
    }
    const sparse = rank(fixture, 'ADAPTIVE');
    expect(sparse.adaptiveApplied).toBe(false);
    expect(sparse.fallbackReason).not.toBeNull();
    expect(sparse.selectedCandidate?.executionMode).toBe('DIRECT_MODEL');
  });

  it('loads profiles without a cache and reports how it obtained them', () => {
    const fixture = fixtureWith({ mode: 'ADAPTIVE' });
    accumulateHistory(fixture);
    const loaded = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    expect(loaded.source).toBe('rebuilt');
    expect(loaded.observations.length).toBe(48);
    // A second load answers from the cache, and reports that honestly.
    const cached = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: adaptivePolicyOf(fixture.config),
      now: NOW,
    });
    expect(cached.source).toBe('cache');
    expect(cached.fingerprint).toBe(loaded.fingerprint);
  });
});
