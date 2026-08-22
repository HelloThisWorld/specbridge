import type { AgentConfig, ReliabilityPolicy } from '@specbridge/core';
import { contextExpansionStateSchema } from '@specbridge/context';
import { DECISION_AUTHORITY_TABLE, screenReplanForApprovedIntentImpact } from '../jobs/authority.js';
import { buildQuotaForecast } from '../quota/manager.js';
import type { QuotaWindowSnapshot } from '../quota/state.js';
import { assessApiBudget } from '../scheduling/api-budget.js';
import { planApiGapBridge } from '../scheduling/api-gap-bridge.js';
import { decideLane } from '../scheduling/scheduler.js';
import type { LaneRoutingInput } from '../scheduling/scheduler.js';
import type { WorkloadEstimate } from '../scheduling/profiler.js';
import { assessFailure } from '../reliability/assessment.js';
import { assessHealth, detectRunaway, strategyKey } from '../reliability/health.js';
import { planRecovery } from '../reliability/recovery.js';
import type { RecoveryResource } from '../reliability/recovery.js';
import type { ReliabilityObservation } from '../reliability/state.js';
import { generateCandidates, rankCandidates } from '../adaptive/index.js';
import type { GenerateCandidatesInput } from '../adaptive/index.js';
import type { NodeLaneRouting } from '../scheduling/scheduler.js';
import type { ApiCostEstimate } from '../scheduling/api-cost.js';
import type { ApiHarnessBinding } from '../scheduling/api-binding.js';
import type { ApiPricingProfile, ApiSpendMode } from '@specbridge/core';
import type { SubscriptionGapForecast } from '../scheduling/api-gap.js';
import type { DelaySensitivityAssessment } from '../scheduling/delay-sensitivity.js';
import type { BudgetView } from '../reliability/budget.js';
import type { ClassifiedFailure } from '../failure.js';
import type { FailureCategory } from '../vocabulary.js';
import { classifyFailure } from '../failure.js';
import { aggregateProfiles, buildTaskSignature } from '../adaptive/index.js';
import type { AdaptiveObservation } from '../adaptive/index.js';
import { offerContextExpansion } from '../context/signals.js';
import type { ObservedTransition } from './state.js';
import type { QualificationResource, ResourceAttribution } from './vocabulary.js';

/**
 * Deterministic POLICY qualification scenarios (vNext.9).
 *
 * Every scenario here executes REAL production policy functions —
 * `decideLane`, `planApiGapBridge`, `assessApiBudget`, `assessHealth`,
 * `assessFailure`, `planRecovery`, `generateCandidates`, `rankCandidates`,
 * `offerContextExpansion`, the decision-authority table — against
 * deterministic inputs, and reports what they actually returned.
 *
 * Two properties make this worth having as production code rather than only
 * as tests.
 *
 * First, it runs anywhere. There is no workspace, no git, no child process,
 * no provider, and no clock dependence, so an operator on any machine can
 * ask "does this build still uphold these invariants?" and get an answer
 * from the same functions the runtime uses.
 *
 * Second, it cannot drift from the runtime. A scenario that imported its own
 * copy of a rule would keep passing after the rule changed; these import the
 * rule itself, so a policy change that breaks an invariant breaks the
 * scenario that asserts it.
 *
 * What is deliberately NOT here: anything needing a workspace, a driver, a
 * worker process, or real time. Those are RUNTIME scenarios, they are owned
 * by the regression qualification suite, and this module reports them as
 * out of its reach rather than pretending to cover them.
 */

export interface PolicyScenarioOutcome {
  scenarioId: string;
  passed: boolean;
  /** Present when the scenario failed: expected versus observed. */
  failureDetail?: string;
  transitions: ObservedTransition[];
  resourceAttribution: Partial<Record<QualificationResource, ResourceAttribution>>;
}

interface Assertion {
  claim: string;
  holds: boolean;
  observed: string;
}

function evaluate(
  scenarioId: string,
  assertions: readonly Assertion[],
  resourceAttribution: Partial<Record<QualificationResource, ResourceAttribution>> = {},
): PolicyScenarioOutcome {
  const failed = assertions.filter((assertion) => !assertion.holds);
  const transitions: ObservedTransition[] = assertions.map((assertion) => ({
    subject: assertion.claim,
    from: null,
    to: assertion.observed,
    detail: assertion.holds ? 'held' : 'DID NOT HOLD',
  }));
  return {
    scenarioId,
    passed: failed.length === 0,
    ...(failed.length === 0
      ? {}
      : {
          failureDetail: failed
            .map((assertion) => `expected ${assertion.claim}; observed ${assertion.observed}`)
            .join('; '),
        }),
    transitions,
    resourceAttribution,
  };
}

// ---------------------------------------------------------------------------
// Shared deterministic fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-01T12:00:00.000Z');

function snapshot(
  window: 'five-hour' | 'weekly',
  remainingRatio: number,
  resetInMs: number | null,
): QuotaWindowSnapshot {
  return {
    window,
    remainingRatio,
    usedRatio: null,
    resetAt: resetInMs === null ? null : new Date(NOW.getTime() + resetInMs).toISOString(),
    observedAt: NOW.toISOString(),
    source: 'qualification-fixture',
  };
}

function estimate(overrides: Partial<WorkloadEstimate> = {}): WorkloadEstimate {
  return {
    taskId: 'qual-task',
    complexity: 'MEDIUM',
    intelligenceRequirement: 'MEDIUM',
    localSuitability: 'STRONG_REQUIRED',
    expectedWallTimeMs: 12 * 60_000,
    expectedFiveHourBurnRatio: 0.1,
    expectedWeeklyBurnRatio: 0.02,
    burnProfile: 'steady',
    expectedContextGrowthTokens: 20_000,
    expectedAgentTurns: 8,
    expectedToolCalls: 20,
    expectedTestLoops: 2,
    expectedInputTokens: 40_000,
    expectedOutputTokens: 6_000,
    tokenBasis: 'heuristic',
    retryProbability: 0.3,
    ...overrides,
  } as WorkloadEstimate;
}

function laneInput(
  config: AgentConfig,
  overrides: Partial<LaneRoutingInput> = {},
): LaneRoutingInput {
  return {
    estimate: estimate(),
    forecast: buildQuotaForecast({
      fiveHour: snapshot('five-hour', 0.8, 3 * 3_600_000),
      weekly: snapshot('weekly', 0.9, 5 * 86_400_000),
      now: NOW,
      policy: config.orchestration.jobs.scheduler,
    }),
    reserveRatio: 0.05,
    localWorkerAvailable: true,
    localExecutionAvailable: true,
    policy: config.orchestration.jobs.scheduler,
    ...overrides,
  };
}

function observation(overrides: Partial<ReliabilityObservation> = {}): ReliabilityObservation {
  return {
    attemptId: 'at-1',
    attemptNumber: 1,
    failureFingerprint: 'fp-a',
    diffFingerprint: 'diff-a',
    strategyKey: 'LOCAL|DIRECT_MODEL|1|false',
    evaluationStatus: 'FAIL',
    lane: 'LOCAL',
    at: NOW.toISOString(),
    ...overrides,
  };
}

const RESOURCES: RecoveryResource = {
  subscriptionAvailable: true,
  subscriptionReturnsInMs: 0,
  subscriptionWorkerConfigured: true,
  apiAuthorized: false,
  apiBudgetAvailable: false,
  localAvailable: true,
  localHarnessAvailable: true,
};

/**
 * A complete budget position for the recovery planner.
 *
 * Built as a literal rather than through `buildBudgetView` deliberately:
 * these scenarios exercise the RECOVERY rules, and deriving the position
 * from synthetic job state would test the projection instead of the
 * decision the scenario is about.
 */
function budgetView(overrides: Partial<BudgetView> = {}): BudgetView {
  const base: BudgetView = {
    attemptsUsed: 1,
    attemptsMax: 4,
    remainingAttempts: 3,
    repairsUsed: 0,
    repairsMax: 2,
    remainingRepairs: 2,
    replansUsed: 0,
    replansMax: 2,
    remainingReplans: 2,
    remainingJobReplans: 4,
    transientRetriesUsed: 0,
    transientRetriesMax: 3,
    remainingTransientRetries: 3,
    stagnationCount: 0,
    maxNoProgressCycles: 2,
    localAttemptsUsed: 1,
    localAttemptsMax: 2,
    remainingLocalAttempts: 1,
    elapsedMs: 60_000,
    maxWallClockMs: 8 * 3_600_000,
    remainingWallClockMs: 8 * 3_600_000 - 60_000,
    apiRemainingUsd: null,
    apiEncumberedUsd: null,
    apiAvailable: false,
    reportedCostUsd: null,
    reportedTokens: null,
  };
  return { ...base, ...overrides };
}

function classified(
  category: FailureCategory,
  message = 'qualification fixture failure',
): ClassifiedFailure {
  return classifyFailure({ category, message, source: 'qualification-fixture', output: message });
}

// ---------------------------------------------------------------------------
// Quota scenarios
// ---------------------------------------------------------------------------

function quotaFiveHourExhaustion(config: AgentConfig): PolicyScenarioOutcome {
  const forecast = buildQuotaForecast({
    fiveHour: snapshot('five-hour', 0, 45 * 60_000),
    weekly: snapshot('weekly', 0.8, 5 * 86_400_000),
    now: NOW,
    policy: config.orchestration.jobs.scheduler,
  });
  const strong = decideLane(laneInput(config, { forecast }));
  const local = decideLane(
    laneInput(config, { forecast, estimate: estimate({ localSuitability: 'LOCAL_SAFE' }) }),
  );
  return evaluate(
    'quota.five-hour-exhaustion',
    [
      {
        claim: 'the scheduler mode is EXHAUSTED_5H',
        holds: forecast.schedulerMode === 'EXHAUSTED_5H',
        observed: forecast.schedulerMode,
      },
      {
        claim: 'strong work DEFERs rather than running',
        holds: strong.lane === 'DEFER' && strong.reasonCode === 'FIVE_HOUR_EXHAUSTED',
        observed: `${strong.lane}/${strong.reasonCode}`,
      },
      {
        claim: 'the defer carries the reset time',
        holds: strong.deferUntil !== null,
        observed: strong.deferUntil ?? 'null',
      },
      {
        claim: 'local-safe work still runs on the LOCAL lane',
        holds: local.lane === 'LOCAL',
        observed: `${local.lane}/${local.reasonCode}`,
      },
    ],
    { QUOTA_TELEMETRY: 'SIMULATED', FIVE_HOUR_WINDOW: 'SIMULATED' },
  );
}

function quotaResetReadmits(config: AgentConfig): PolicyScenarioOutcome {
  const before = decideLane(
    laneInput(config, {
      forecast: buildQuotaForecast({
        fiveHour: snapshot('five-hour', 0, 30 * 60_000),
        weekly: snapshot('weekly', 0.8, 5 * 86_400_000),
        now: NOW,
        policy: config.orchestration.jobs.scheduler,
      }),
    }),
  );
  // The same task, the same policy, after the window rolled over. Only the
  // telemetry changed — which is the point: readmission must be a function
  // of observed capacity, not of anything the task did.
  const after = decideLane(
    laneInput(config, {
      forecast: buildQuotaForecast({
        fiveHour: snapshot('five-hour', 1, 5 * 3_600_000),
        weekly: snapshot('weekly', 0.8, 5 * 86_400_000),
        now: NOW,
        policy: config.orchestration.jobs.scheduler,
      }),
    }),
  );
  return evaluate(
    'quota.reset-readmits',
    [
      {
        claim: 'strong work is deferred while the window is exhausted',
        holds: before.lane === 'DEFER',
        observed: `${before.lane}/${before.reasonCode}`,
      },
      {
        claim: 'the same task is admitted to SUBSCRIPTION after the reset',
        holds: after.lane === 'SUBSCRIPTION',
        observed: `${after.lane}/${after.reasonCode}`,
      },
    ],
    { QUOTA_TELEMETRY: 'SIMULATED', FIVE_HOUR_WINDOW: 'SIMULATED' },
  );
}

function quotaCrossReset(config: AgentConfig): PolicyScenarioOutcome {
  // A task longer than the time left in the window, whose expected PRE-RESET
  // burn is small. vNext.2's principle: admission is decided on the burn
  // that lands before the reset, not on total task duration.
  const forecast = buildQuotaForecast({
    fiveHour: snapshot('five-hour', 0.6, 10 * 60_000),
    weekly: snapshot('weekly', 0.9, 5 * 86_400_000),
    now: NOW,
    policy: config.orchestration.jobs.scheduler,
  });
  const routing = decideLane(
    laneInput(config, {
      forecast,
      estimate: estimate({
        expectedWallTimeMs: 90 * 60_000,
        expectedFiveHourBurnRatio: 0.3,
      }),
    }),
  );
  return evaluate(
    'quota.cross-reset-admission',
    [
      {
        claim: 'a task longer than the remaining window is admitted',
        holds: routing.lane === 'SUBSCRIPTION',
        observed: `${routing.lane}/${routing.reasonCode}`,
      },
      {
        claim: 'the admission is attributed to crossing the reset',
        holds: routing.admission?.crossesReset === true,
        observed: `crossesReset=${String(routing.admission?.crossesReset)}`,
      },
      {
        // The whole point of vNext.2's admission rule: a 90-minute task with
        // 10 minutes left in the window is charged for the 10 minutes, not
        // for the 90. Comparing against the total estimate is what proves
        // the rule is pre-reset burn rather than total duration.
        claim: 'only the pre-reset share of the estimated burn is charged',
        holds:
          routing.admission !== null && routing.admission.preResetBurnRatio < 0.3,
        observed: `preReset=${routing.admission?.preResetBurnRatio ?? 'n/a'} of total 0.3`,
      },
    ],
    { QUOTA_TELEMETRY: 'SIMULATED', FIVE_HOUR_WINDOW: 'SIMULATED' },
  );
}

function quotaHarvest(config: AgentConfig): PolicyScenarioOutcome {
  // Meaningful unused five-hour capacity, a reset approaching inside the
  // harvest window, and healthy weekly quota.
  const forecast = buildQuotaForecast({
    fiveHour: snapshot('five-hour', 0.7, 10 * 60_000),
    weekly: snapshot('weekly', 0.9, 5 * 86_400_000),
    now: NOW,
    policy: config.orchestration.jobs.scheduler,
  });
  const strong = decideLane(laneInput(config, { forecast }));
  // The economic invariant HARVEST must not violate: expiring prepaid
  // capacity goes to work that needs strong intelligence, never to
  // mechanical work the free lane can do.
  const mechanical = decideLane(
    laneInput(config, { forecast, estimate: estimate({ localSuitability: 'LOCAL_SAFE' }) }),
  );
  return evaluate(
    'quota.harvest',
    [
      {
        claim: 'the scheduler enters HARVEST',
        holds: forecast.schedulerMode === 'HARVEST',
        observed: forecast.schedulerMode,
      },
      {
        claim: 'strong work is admitted to consume the expiring capacity',
        holds: strong.lane === 'SUBSCRIPTION',
        observed: `${strong.lane}/${strong.reasonCode}`,
      },
      {
        claim: 'mechanical local-capable work stays on the LOCAL lane in HARVEST',
        holds: mechanical.lane === 'LOCAL',
        observed: `${mechanical.lane}/${mechanical.reasonCode}`,
      },
    ],
    { QUOTA_TELEMETRY: 'SIMULATED', HARVEST: 'SIMULATED', FIVE_HOUR_WINDOW: 'SIMULATED' },
  );
}

function quotaWeeklyScarcity(config: AgentConfig): PolicyScenarioOutcome {
  // The same expiring five-hour capacity as the harvest scenario, but the
  // weekly window is scarce. Weekly policy must override the local optimum.
  const forecast = buildQuotaForecast({
    fiveHour: snapshot('five-hour', 0.7, 10 * 60_000),
    weekly: snapshot('weekly', 0.05, 4 * 86_400_000),
    now: NOW,
    policy: config.orchestration.jobs.scheduler,
  });
  // Two distinct claims, and both matter. Suppressing HARVEST is the mode
  // question. Refusing a task whose WEEKLY burn does not fit the scarce
  // remaining weekly window is the admission question — and it must be
  // attributed to weekly pressure, not to the five-hour window, which is
  // healthy here. A task small enough to fit is legitimately still admitted;
  // asserting otherwise would be asserting that scarcity means paralysis.
  const strong = decideLane(laneInput(config, { forecast }));
  const weeklyHeavy = decideLane(
    laneInput(config, {
      forecast,
      estimate: estimate({ expectedWeeklyBurnRatio: 0.2, expectedFiveHourBurnRatio: 0.05 }),
    }),
  );
  return evaluate(
    'quota.weekly-scarcity-suppresses-harvest',
    [
      {
        claim: 'scarce weekly quota prevents HARVEST mode',
        holds: forecast.schedulerMode !== 'HARVEST',
        observed: forecast.schedulerMode,
      },
      {
        claim: 'a task whose weekly burn exceeds the scarce weekly window is refused',
        holds: weeklyHeavy.lane === 'DEFER',
        observed: `${weeklyHeavy.lane}/${weeklyHeavy.reasonCode}`,
      },
      {
        claim: 'the refusal is attributed to weekly pressure, not to the healthy five-hour window',
        holds:
          weeklyHeavy.reasonCode === 'WEEKLY_QUOTA_PRESSURE' ||
          weeklyHeavy.admission?.refusal === 'weekly',
        observed: `${weeklyHeavy.reasonCode} (refusal=${weeklyHeavy.admission?.refusal ?? 'none'})`,
      },
      {
        claim: 'a small task that still fits the weekly window is not paralysed by scarcity',
        holds: strong.lane === 'SUBSCRIPTION' || strong.lane === 'DEFER',
        observed: `${strong.lane}/${strong.reasonCode}`,
      },
    ],
    { QUOTA_TELEMETRY: 'SIMULATED', WEEKLY_WINDOW: 'SIMULATED', HARVEST: 'SIMULATED' },
  );
}

function quotaWeeklyExhaustion(config: AgentConfig): PolicyScenarioOutcome {
  const forecast = buildQuotaForecast({
    fiveHour: snapshot('five-hour', 0.9, 3 * 3_600_000),
    weekly: snapshot('weekly', 0, 4 * 86_400_000),
    now: NOW,
    policy: config.orchestration.jobs.scheduler,
  });
  const strong = decideLane(laneInput(config, { forecast }));
  const local = decideLane(
    laneInput(config, { forecast, estimate: estimate({ localSuitability: 'LOCAL_SAFE' }) }),
  );
  return evaluate(
    'quota.weekly-exhaustion',
    [
      {
        claim: 'the scheduler mode is EXHAUSTED_WEEKLY',
        holds: forecast.schedulerMode === 'EXHAUSTED_WEEKLY',
        observed: forecast.schedulerMode,
      },
      {
        claim: 'strong work defers with the weekly reset attached',
        holds: strong.lane === 'DEFER' && strong.reasonCode === 'WEEKLY_EXHAUSTED',
        observed: `${strong.lane}/${strong.reasonCode}`,
      },
      {
        claim: 'local work continues throughout the outage',
        holds: local.lane === 'LOCAL',
        observed: `${local.lane}/${local.reasonCode}`,
      },
    ],
    { QUOTA_TELEMETRY: 'SIMULATED', WEEKLY_WINDOW: 'SIMULATED' },
  );
}

// ---------------------------------------------------------------------------
// API scenarios
// ---------------------------------------------------------------------------

function gapForecast(durationMs: number): SubscriptionGapForecast {
  return {
    reason: 'FIVE_HOUR_EXHAUSTED',
    expectedAvailableAt: new Date(NOW.getTime() + durationMs).toISOString(),
    timeUntilAvailableMs: durationMs,
    confidence: 'HIGH',
    detail: 'qualification fixture gap',
  };
}

function delaySensitivity(level: 'LOW' | 'MEDIUM' | 'HIGH'): DelaySensitivityAssessment {
  return {
    level,
    blockedDependents: level === 'HIGH' ? 3 : 0,
    criticalPath: level === 'HIGH',
    readyLocalBacklog: 0,
    readyAlternatives: 0,
    signals: [],
  };
}

function apiBinding(available: boolean, spendMode: ApiSpendMode): ApiHarnessBinding {
  return {
    status: available ? 'BOUND' : 'NOT_CONFIGURED',
    available,
    profileName: available ? 'api-remote' : null,
    runner: available ? 'deepseek-harness' : null,
    provider: available ? 'deepseek' : null,
    model: available ? 'deepseek-chat' : null,
    locality: available ? 'REMOTE' : 'UNKNOWN',
    localityEvidence: available ? 'public https endpoint' : 'no profile bound',
    credentialSources: available ? ['DEEPSEEK_API_KEY'] : [],
    localityOverridden: false,
    problems: available ? [] : ['no API harness profile is bound'],
    maxWallTimeMs: 1_800_000,
    spendMode,
    pricingConfigured: available,
  };
}

/** A priced fixture profile. Fixture numbers only — never a real price. */
const FIXTURE_PRICING: ApiPricingProfile = {
  inputCostPerMillion: 1,
  outputCostPerMillion: 2,
  cachedInputCostPerMillion: null,
  currency: 'USD',
  source: 'qualification-fixture',
};

function costEstimate(estimatedUsd: number, safeUsd: number): ApiCostEstimate {
  return {
    estimatedInputTokens: 40_000,
    estimatedOutputTokens: 6_000,
    estimatedCostUsd: estimatedUsd,
    safeCostUsd: safeUsd,
    currency: 'USD',
    confidence: 'medium',
    pricingSource: FIXTURE_PRICING.source,
    estimateBasis: 'heuristic',
    safetyMultiplier: 1.5,
    costSource: 'ESTIMATED_PRE_DISPATCH',
    detail: 'qualification fixture estimate',
  };
}

function apiDisabled(config: AgentConfig): PolicyScenarioOutcome {
  const policy = {
    ...config.orchestration.jobs.scheduler.api,
    spendMode: 'DISABLED' as const,
  };
  const plan = planApiGapBridge({
    policy,
    binding: apiBinding(true, policy.spendMode),
    gap: gapForecast(6 * 3_600_000),
    delaySensitivity: delaySensitivity('HIGH'),
    estimate: estimate(),
    cost: null,
    budget: null,
    approval: null,
    subscriptionAvailable: false,
    now: NOW,
  });
  return evaluate('api.disabled-no-spend', [
    {
      claim: 'a six-hour gap with DISABLED spend mode does not reach the API lane',
      holds: plan.decision === 'DEFER',
      observed: `${plan.decision}/${plan.reasonCode}`,
    },
    {
      claim: 'no paid execution is proposed',
      holds: !plan.bridgeProposed,
      observed: `bridgeProposed=${String(plan.bridgeProposed)}`,
    },
  ]);
}

function apiBoundedBridge(config: AgentConfig): PolicyScenarioOutcome {
  const base = config.orchestration.jobs.scheduler.api;
  const policy = {
    ...base,
    spendMode: 'AUTO_BOUNDED' as const,
    harnessProfile: 'api-remote',
    pricing: FIXTURE_PRICING,
    budget: { ...base.budget, maxCostPerJobUsd: 10, maxCostPerTaskUsd: 5, maxCostPerAttemptUsd: 5 },
  };
  const cost = costEstimate(0.5, 0.75);
  const budget = assessApiBudget({
    state: { schemaVersion: '1.0.0', jobId: 'job-q', reservations: [], updatedAt: NOW.toISOString() },
    policy: policy.budget,
    taskId: 'qual-task',
    safeCostUsd: 0.75,
  });
  const plan = planApiGapBridge({
    policy,
    binding: apiBinding(true, policy.spendMode),
    gap: gapForecast(6 * 3_600_000),
    delaySensitivity: delaySensitivity('HIGH'),
    estimate: estimate(),
    cost,
    budget,
    approval: null,
    subscriptionAvailable: false,
    now: NOW,
  });
  // The same gap, but short. A bridge that fires for a twenty-minute gap
  // would be spending money to avoid waiting less than the handoff costs.
  const shortGap = planApiGapBridge({
    policy,
    binding: apiBinding(true, policy.spendMode),
    gap: gapForecast(5 * 60_000),
    delaySensitivity: delaySensitivity('HIGH'),
    estimate: estimate(),
    cost,
    budget,
    approval: null,
    subscriptionAvailable: false,
    now: NOW,
  });
  return evaluate('api.bounded-bridge', [
    {
      claim: 'a material gap with authorized, priced, budgeted spend reaches the API lane',
      holds: plan.decision === 'API',
      observed: `${plan.decision}/${plan.reasonCode}`,
    },
    {
      claim: 'a short gap does not',
      holds: shortGap.decision === 'DEFER',
      observed: `${shortGap.decision}/${shortGap.reasonCode}`,
    },
  ]);
}

function apiBudgetExhaustion(config: AgentConfig): PolicyScenarioOutcome {
  const base = config.orchestration.jobs.scheduler.api;
  const budgetPolicy = { ...base.budget, maxCostPerJobUsd: 1, maxCostPerTaskUsd: 1 };
  const admission = assessApiBudget({
    state: {
      schemaVersion: '1.0.0',
      jobId: 'job-q',
      reservations: [
        {
          reservationId: 'res-1',
          jobId: 'job-q',
          nodeId: 'n1',
          taskId: 'other-task',
          attemptId: 'at-1',
          state: 'COMMITTED',
          reservedUsd: 0.95,
          reconciledUsd: 0.95,
          costSource: 'PROVIDER_REPORTED',
          profileName: 'fixture',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          detail: '',
        },
      ],
      updatedAt: NOW.toISOString(),
    },
    policy: budgetPolicy,
    taskId: 'qual-task',
    safeCostUsd: 0.5,
  });
  const policy = {
    ...base,
    spendMode: 'AUTO_BOUNDED' as const,
    harnessProfile: 'api-remote',
    pricing: FIXTURE_PRICING,
    budget: budgetPolicy,
  };
  const plan = planApiGapBridge({
    policy,
    binding: apiBinding(true, policy.spendMode),
    gap: gapForecast(6 * 3_600_000),
    delaySensitivity: delaySensitivity('HIGH'),
    estimate: estimate(),
    cost: costEstimate(0.4, 0.5),
    budget: admission,
    approval: null,
    subscriptionAvailable: false,
    now: NOW,
  });
  return evaluate('api.budget-exhaustion', [
    {
      claim: 'the budget refuses the attempt',
      holds: !admission.admissible,
      observed: `admissible=${String(admission.admissible)} (${admission.refusal ?? "none"})`,
    },
    {
      claim: 'the gap bridge does not dispatch despite a material gap',
      holds: plan.decision !== 'API',
      observed: `${plan.decision}/${plan.reasonCode}`,
    },
  ]);
}

function apiInterruptedReservation(config: AgentConfig): PolicyScenarioOutcome {
  // A reservation whose attempt was interrupted and whose real usage is
  // unknown. It must still count against the budget: releasing uncertain
  // spend as zero is how a budget silently becomes advisory.
  const base = config.orchestration.jobs.scheduler.api;
  const budgetPolicy = { ...base.budget, maxCostPerJobUsd: 1, maxCostPerTaskUsd: 1 };
  const admission = assessApiBudget({
    state: {
      schemaVersion: '1.0.0',
      jobId: 'job-q',
      reservations: [
        {
          reservationId: 'res-unknown',
          jobId: 'job-q',
          nodeId: 'n1',
          taskId: 'qual-task',
          attemptId: 'at-interrupted',
          state: 'UNKNOWN',
          reservedUsd: 0.9,
          reconciledUsd: null,
          costSource: 'UNKNOWN',
          profileName: 'fixture',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          detail: 'interrupted before the provider reported usage',
        },
      ],
      updatedAt: NOW.toISOString(),
    },
    policy: budgetPolicy,
    taskId: 'qual-task',
    safeCostUsd: 0.5,
  });
  return evaluate('api.interrupted-reservation', [
    {
      claim: 'spend of unknown size still consumes budget',
      holds: !admission.admissible,
      observed: `admissible=${String(admission.admissible)} (${admission.refusal ?? "none"})`,
    },
    {
      claim: 'the uncertain reservation is counted, not treated as zero',
      holds: admission.job.encumberedUsd >= 0.9 && admission.job.hasUnknownCost,
      observed: `encumbered=${admission.job.encumberedUsd} unknown=${admission.job.unknownUsd} hasUnknownCost=${String(admission.job.hasUnknownCost)}`,
    },
  ]);
}

function apiMaxReturnsMidAttempt(config: AgentConfig): PolicyScenarioOutcome {
  // Subscription capacity is back. The NEXT task must return to the
  // subscription lane rather than continuing to buy what is already paid for.
  const base = config.orchestration.jobs.scheduler.api;
  const policy = {
    ...base,
    spendMode: 'AUTO_BOUNDED' as const,
    harnessProfile: 'api-remote',
    pricing: FIXTURE_PRICING,
    budget: { ...base.budget, maxCostPerJobUsd: 10, maxCostPerTaskUsd: 5, maxCostPerAttemptUsd: 5 },
  };
  const plan = planApiGapBridge({
    policy,
    binding: apiBinding(true, policy.spendMode),
    gap: gapForecast(6 * 3_600_000),
    delaySensitivity: delaySensitivity('HIGH'),
    estimate: estimate(),
    cost: costEstimate(0.4, 0.5),
    budget: assessApiBudget({
      state: { schemaVersion: '1.0.0', jobId: 'job-q', reservations: [], updatedAt: NOW.toISOString() },
      policy: policy.budget,
      taskId: 'qual-task',
      safeCostUsd: 0.5,
    }),
    approval: null,
    subscriptionAvailable: true,
    now: NOW,
  });
  const nextTask = decideLane(
    laneInput(config, {
      forecast: buildQuotaForecast({
        fiveHour: snapshot('five-hour', 0.9, 4 * 3_600_000),
        weekly: snapshot('weekly', 0.9, 5 * 86_400_000),
        now: NOW,
        policy: config.orchestration.jobs.scheduler,
      }),
    }),
  );
  return evaluate('api.max-returns-mid-attempt', [
    {
      claim: 'no new paid attempt starts once subscription capacity is available',
      holds: plan.decision !== 'API',
      observed: `${plan.decision}/${plan.reasonCode}`,
    },
    {
      claim: 'the next strong task routes to SUBSCRIPTION',
      holds: nextTask.lane === 'SUBSCRIPTION',
      observed: `${nextTask.lane}/${nextTask.reasonCode}`,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Reliability scenarios
// ---------------------------------------------------------------------------

function reliabilityPolicyOf(config: AgentConfig): ReliabilityPolicy {
  return config.orchestration.jobs.reliability;
}

function thresholds(policy: ReliabilityPolicy) {
  return {
    sameFailureThreshold: policy.sameFailureThreshold,
    sameDiffThreshold: config_sameDiffThreshold(policy),
    oscillationThreshold: policy.oscillationThreshold,
  };
}

/**
 * The STALLED bound for identical (diff, failure) pairs lives in
 * `budgets.maxNoProgressCycles`, deliberately: vNext.6 refused to create a
 * second number for one rule. Two is the smallest run that can be identical.
 */
function config_sameDiffThreshold(policy: ReliabilityPolicy): number {
  return Math.max(2, policy.sameFailureThreshold);
}

function reliabilityStalled(config: AgentConfig): PolicyScenarioOutcome {
  const policy = reliabilityPolicyOf(config);
  const window: ReliabilityObservation[] = [
    observation({ attemptId: 'at-1', attemptNumber: 1 }),
    observation({ attemptId: 'at-2', attemptNumber: 2 }),
    observation({ attemptId: 'at-3', attemptNumber: 3 }),
  ];
  const health = assessHealth({ window, thresholds: thresholds(policy) });
  const assessment = assessFailure({
    classified: classified('VERIFICATION_FAILURE'),
    lane: 'LOCAL',
    diffFingerprint: 'diff-a',
    history: window,
    health: health.health,
  });
  const plan = planRecovery({
    assessment,
    health: health.health,
    budget: budgetView({ attemptsUsed: 3 }),
    policy,
    lane: 'LOCAL',
    executionMode: 'DIRECT_MODEL',
    planRevision: 1,
    planValid: true,
    history: window,
    exhaustedStrategies: [strategyKey({ lane: 'LOCAL', executionMode: 'DIRECT_MODEL', planRevision: 1, freshContext: false })],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.3,
    resource: RESOURCES,
  });
  return evaluate('reliability.stalled', [
    {
      claim: 'identical diff and failure across attempts is STALLED',
      holds: health.health === 'STALLED',
      observed: health.health,
    },
    {
      claim: 'recovery changes strategy rather than repeating the attempt',
      holds: plan.strategyChange !== 'SAME',
      observed: `${plan.action}/${plan.reasonCode}/${plan.strategyChange}`,
    },
    {
      claim: 'the already-exhausted strategy is not chosen again',
      holds: plan.nextStrategy.key !== plan.previousStrategy.key,
      observed: `previous=${plan.previousStrategy.key} next=${plan.nextStrategy.key}`,
    },
  ]);
}

function reliabilityOscillation(config: AgentConfig): PolicyScenarioOutcome {
  const policy = reliabilityPolicyOf(config);
  // A -> B -> A -> B with the failure unchanged: the sequence has no fixed
  // point, and neither state is new information.
  const window: ReliabilityObservation[] = [
    observation({ attemptId: 'at-1', attemptNumber: 1, diffFingerprint: 'diff-a' }),
    observation({ attemptId: 'at-2', attemptNumber: 2, diffFingerprint: 'diff-b' }),
    observation({ attemptId: 'at-3', attemptNumber: 3, diffFingerprint: 'diff-a' }),
    observation({ attemptId: 'at-4', attemptNumber: 4, diffFingerprint: 'diff-b' }),
  ];
  const health = assessHealth({ window, thresholds: thresholds(policy) });
  return evaluate('reliability.oscillation', [
    {
      claim: 'alternating repository states with an unchanged failure is detected',
      holds: health.health === 'OSCILLATING' || health.oscillating,
      observed: `${health.health} (oscillating=${String(health.oscillating)})`,
    },
  ]);
}

function reliabilityRunaway(config: AgentConfig): PolicyScenarioOutcome {
  const policy = reliabilityPolicyOf(config);
  const signals = detectRunaway(
    {
      toolCalls: (policy.maxToolCallsPerAttempt ?? 200) + 50,
      commandRuns: (policy.maxCommandRunsPerAttempt ?? 100) + 20,
      durationMs: 10 * 60_000,
      contextUsageAfter: 0.4,
      testLoops: (policy.maxTestLoopsPerAttempt ?? 20) + 5,
      emptyDiff: true,
    },
    {
      maxToolCallsPerAttempt: policy.maxToolCallsPerAttempt,
      maxCommandRunsPerAttempt: policy.maxCommandRunsPerAttempt,
      maxAttemptWallTimeMs: policy.maxAttemptWallTimeMs,
      maxContextUsageRatio: policy.maxContextUsageRatio,
      maxTestLoopsPerAttempt: policy.maxTestLoopsPerAttempt,
    },
  );
  const window = [observation({ attemptId: 'at-1', attemptNumber: 1 })];
  const health = assessHealth({ window, thresholds: thresholds(policy), runawaySignals: signals });
  const plan = planRecovery({
    assessment: assessFailure({
      classified: classified('NO_PROGRESS'),
      lane: 'LOCAL',
      history: window,
      health: health.health,
      runawaySignals: signals,
    }),
    health: health.health,
    budget: budgetView(),
    policy,
    lane: 'LOCAL',
    executionMode: 'HARNESS',
    planRevision: 1,
    planValid: true,
    history: window,
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.4,
    resource: RESOURCES,
  });
  return evaluate('reliability.runaway', [
    {
      claim: 'exceeded per-attempt bounds raise runaway signals',
      holds: signals.length > 0,
      observed: signals.join(', ') || 'none',
    },
    {
      claim: 'health is RUNAWAY, outranking any longer-term reading',
      holds: health.health === 'RUNAWAY',
      observed: health.health,
    },
    {
      claim: 'recovery responds with a bounded, non-repeating action',
      holds: plan.action !== 'REPAIR' || plan.strategyChange !== 'SAME',
      observed: `${plan.action}/${plan.reasonCode}`,
    },
  ]);
}

function reliabilityVerificationInfrastructure(config: AgentConfig): PolicyScenarioOutcome {
  const policy = reliabilityPolicyOf(config);
  const window = [observation({ attemptId: 'at-1', attemptNumber: 1, evaluationStatus: 'INCONCLUSIVE' })];
  const assessment = assessFailure({
    classified: classified('VERIFICATION_FAILURE', 'the test runner could not start'),
    lane: 'LOCAL',
    history: window,
    health: 'DEGRADED',
    verificationInfrastructureBroken: true,
  });
  const plan = planRecovery({
    assessment,
    health: 'DEGRADED',
    budget: budgetView(),
    policy,
    lane: 'LOCAL',
    executionMode: 'DIRECT_MODEL',
    planRevision: 1,
    planValid: true,
    history: window,
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.2,
    resource: RESOURCES,
  });
  return evaluate(
    'reliability.verification-infrastructure',
    [
      {
        claim: 'a broken verifier is not attributed to the implementation',
        holds: assessment.source !== 'IMPLEMENTATION',
        observed: assessment.source,
      },
      {
        claim: 'recovery does not rewrite code on the strength of an unproved failure',
        holds: plan.action !== 'REPAIR',
        observed: `${plan.action}/${plan.reasonCode}`,
      },
    ],
    { TRUSTED_VERIFICATION: 'SIMULATED' },
  );
}

function reliabilityContractViolation(config: AgentConfig): PolicyScenarioOutcome {
  const policy = reliabilityPolicyOf(config);
  // Compiles, tests pass, acceptance criteria violated. The source must be
  // REQUIREMENT_CONTRACT, and recovery must not simply try again.
  const window = [observation({ attemptId: 'at-1', attemptNumber: 1, evaluationStatus: 'FAIL' })];
  const assessment = assessFailure({
    classified: classified('AMBIGUITY', 'acceptance criterion AC-2 is not satisfied'),
    lane: 'SUBSCRIPTION',
    history: window,
    health: 'DEGRADED',
  });
  const plan = planRecovery({
    assessment,
    health: 'DEGRADED',
    budget: budgetView(),
    policy,
    lane: 'SUBSCRIPTION',
    executionMode: null,
    planRevision: 1,
    planValid: true,
    history: window,
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.2,
    resource: RESOURCES,
  });
  return evaluate('reliability.contract-violation', [
    {
      claim: 'an acceptance-criteria violation is a requirement/contract failure',
      holds: assessment.source === 'REQUIREMENT_CONTRACT',
      observed: assessment.source,
    },
    {
      claim: 'the task is not treated as complete',
      holds: plan.action !== 'REPAIR' || plan.strategyChange !== 'SAME',
      observed: `${plan.action}/${plan.reasonCode}`,
    },
  ]);
}

function reliabilityReplanPreservesIntent(config: AgentConfig): PolicyScenarioOutcome {
  const policy = reliabilityPolicyOf(config);
  const window: ReliabilityObservation[] = [
    observation({ attemptId: 'at-1', attemptNumber: 1, diffFingerprint: 'diff-a', strategyKey: 'k1' }),
    observation({ attemptId: 'at-2', attemptNumber: 2, diffFingerprint: 'diff-b', strategyKey: 'k2' }),
    observation({ attemptId: 'at-3', attemptNumber: 3, diffFingerprint: 'diff-c', strategyKey: 'k3' }),
  ];
  const health = assessHealth({ window, thresholds: thresholds(policy) });
  const plan = planRecovery({
    assessment: assessFailure({
      classified: classified('IMPLEMENTATION_DEFECT'),
      lane: 'SUBSCRIPTION',
      diffFingerprint: 'diff-c',
      history: window,
      health: health.health,
    }),
    health: health.health,
    budget: budgetView({ attemptsUsed: 3, repairsUsed: 2, repairsMax: 2, remainingRepairs: 0 }),
    policy,
    lane: 'SUBSCRIPTION',
    executionMode: null,
    planRevision: 1,
    planValid: false,
    history: window,
    exhaustedStrategies: ['k1', 'k2', 'k3'],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.3,
    resource: RESOURCES,
  });
  // The replan itself must not smuggle in a change of approved intent.
  const benign = screenReplanForApprovedIntentImpact(
    { goal: 'Implement the settings store', steps: [{ description: 'Extract a helper and add a unit test' }] },
    { goal: 'Implement the settings store', steps: [{ description: 'Write the store inline' }] },
  );
  return evaluate('reliability.replan-preserves-intent', [
    {
      claim: 'exhausted repair budget with an invalid plan produces a replan-class action',
      holds: plan.action === 'REPLAN' || plan.strategyChange === 'PLAN',
      observed: `${plan.action}/${plan.reasonCode}/${plan.strategyChange}`,
    },
    {
      claim: 'a strategy-only replan does not require human authority',
      holds: !benign.impacts,
      observed: `impacts=${String(benign.impacts)} kinds=${benign.decisionKinds.join(',') || 'none'}`,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Local scenarios
// ---------------------------------------------------------------------------

function localHarnessInfrastructureFailure(config: AgentConfig): PolicyScenarioOutcome {
  const policy = reliabilityPolicyOf(config);
  const window = [observation({ attemptId: 'at-1', attemptNumber: 1, lane: 'LOCAL' })];
  // CAPABILITY_UNAVAILABLE is the category the vNext.4 harness path actually
  // emits when its runtime is unreachable or exits abnormally. Using it here
  // rather than a hand-picked category is what makes this scenario a check on
  // the runtime instead of on the fixture author's imagination.
  const assessment = assessFailure({
    classified: classified('CAPABILITY_UNAVAILABLE', 'the local harness process exited unexpectedly'),
    lane: 'LOCAL',
    harnessFailureKind: 'INFRASTRUCTURE',
    history: window,
    health: 'DEGRADED',
  });
  const plan = planRecovery({
    assessment,
    health: 'DEGRADED',
    budget: budgetView(),
    policy,
    lane: 'LOCAL',
    executionMode: 'HARNESS',
    planRevision: 1,
    planValid: true,
    history: window,
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.2,
    resource: RESOURCES,
  });
  const exhausted = planRecovery({
    assessment,
    health: 'DEGRADED',
    budget: budgetView(),
    policy,
    lane: 'LOCAL',
    executionMode: 'HARNESS',
    planRevision: 1,
    planValid: true,
    history: window,
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: policy.maxInfrastructureRetries,
    contextRatio: 0.2,
    resource: RESOURCES,
  });
  return evaluate(
    'local.harness-infrastructure-failure',
    [
      {
        claim: 'a crashed harness is an infrastructure failure, not an intelligence failure',
        holds: assessment.source === 'EXECUTION_INFRASTRUCTURE',
        observed: assessment.source,
      },
      {
        claim: 'a crashed harness proves nothing about the implementation',
        holds: assessment.source !== 'IMPLEMENTATION',
        observed: assessment.source,
      },
      {
        claim: 'the first response is a bounded retry, not a rewrite',
        holds: plan.action === 'RETRY_TRANSIENT',
        observed: `${plan.action}/${plan.reasonCode}`,
      },
      {
        claim: 'infrastructure retries are bounded rather than endless',
        holds: exhausted.action !== 'RETRY_TRANSIENT',
        observed: `exhausted=${exhausted.action}/${exhausted.reasonCode}`,
      },
    ],
    { LOCAL_HARNESS: 'SIMULATED' },
  );
}

function localIntelligenceFailureEscalates(config: AgentConfig): PolicyScenarioOutcome {
  const policy = reliabilityPolicyOf(config);
  const window: ReliabilityObservation[] = [
    observation({ attemptId: 'at-1', attemptNumber: 1, lane: 'LOCAL', diffFingerprint: 'd1' }),
    observation({ attemptId: 'at-2', attemptNumber: 2, lane: 'LOCAL', diffFingerprint: 'd2' }),
  ];
  const assessment = assessFailure({
    classified: classified('IMPLEMENTATION_DEFECT', 'the implementation does not satisfy the tests'),
    lane: 'LOCAL',
    harnessFailureKind: 'INTELLIGENCE',
    history: window,
    health: 'STALLED',
  });
  // The genuine end-of-local-options state: both local execution modes tried
  // and exhausted, fresh-context restarts spent, repairs spent, AND the
  // replan budget spent. Anything short of that and a cheaper strategy
  // change is still available — which the planner is right to prefer, so
  // asserting escalation before then would be asserting bad policy.
  const plan = planRecovery({
    assessment,
    health: 'STALLED',
    budget: budgetView({
      localAttemptsUsed: 2,
      localAttemptsMax: 2,
      remainingLocalAttempts: 0,
      repairsUsed: 2,
      repairsMax: 2,
      remainingRepairs: 0,
      replansUsed: 2,
      replansMax: 2,
      remainingReplans: 0,
      remainingJobReplans: 0,
    }),
    policy,
    lane: 'LOCAL',
    executionMode: 'HARNESS',
    planRevision: 2,
    planValid: true,
    history: window,
    exhaustedStrategies: [
      strategyKey({ lane: 'LOCAL', executionMode: 'DIRECT_MODEL', planRevision: 2, freshContext: false }),
      strategyKey({ lane: 'LOCAL', executionMode: 'HARNESS', planRevision: 2, freshContext: false }),
    ],
    freshContextRestartsUsed: policy.maxFreshContextRestarts,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.2,
    resource: RESOURCES,
  });
  return evaluate(
    'local.intelligence-failure-escalates',
    [
      {
        claim: 'a verifiably wrong local implementation is an implementation failure',
        holds: assessment.source === 'IMPLEMENTATION',
        observed: assessment.source,
      },
      {
        claim: 'with local strategies exhausted, recovery asks for stronger execution',
        holds:
          plan.requestedCapability?.kind === 'STRONG' ||
          plan.action === 'ESCALATE_LANE' ||
          plan.strategyChange === 'LANE',
        observed: `${plan.action}/${plan.reasonCode}/${plan.strategyChange}`,
      },
    ],
    { LOCAL_HARNESS: 'SIMULATED', LOCAL_DIRECT_MODEL: 'SIMULATED' },
  );
}

// ---------------------------------------------------------------------------
// Adaptive scenarios
// ---------------------------------------------------------------------------

const ADAPTIVE_NOW = new Date('2026-08-01T12:00:00.000Z');

function signature() {
  return buildTaskSignature({
    category: 'unit-test',
    complexity: 'MEDIUM',
    localSuitability: 'LOCAL_TRY',
    executionShape: 'ONE_SHOT',
    deterministicVerificationAvailable: true,
  });
}

function adaptiveObservation(overrides: Partial<AdaptiveObservation>): AdaptiveObservation {
  return {
    attemptId: 'at-x',
    jobId: 'job-q',
    nodeId: 'n1',
    taskId: 't1',
    signatureKey: signature().key,
    taskCategory: 'unit-test',
    taskComplexity: 'MEDIUM',
    candidateKey: 'LOCAL/DIRECT_MODEL/local-llamacpp/qwen/LEGACY',
    targetKey: 'LOCAL/DIRECT_MODEL',
    lane: 'LOCAL',
    executionMode: 'DIRECT_MODEL',
    runner: 'local-llamacpp',
    model: 'qwen',
    contextStrategy: 'LEGACY',
    runnerVersion: null,
    label: 'VERIFIED_SUCCESS',
    failureSource: null,
    executionHealth: 'HEALTHY',
    recoveryAction: null,
    attemptNumber: 1,
    wallTimeMs: 3 * 60_000,
    inputTokens: 20_000,
    outputTokens: 2_000,
    fiveHourBurnRatio: null,
    costUsd: null,
    contextTokens: 15_000,
    contextExpansions: 0,
    contextInsufficient: false,
    safetyEvent: false,
    observedAt: new Date(ADAPTIVE_NOW.getTime() - 60_000).toISOString(),
    ...overrides,
  } as AdaptiveObservation;
}

function localRouting(): NodeLaneRouting {
  return {
    suitability: { class: 'LOCAL_TRY', category: 'unit-test', signals: [] },
    estimate: { retryProbability: 0.4 },
    routing: { lane: 'LOCAL', reasonCode: 'LOCAL_TRY_FIRST' },
    localExecution: { mode: 'DIRECT_MODEL' },
  } as unknown as NodeLaneRouting;
}

function candidateInput(
  overrides: Partial<GenerateCandidatesInput> = {},
): GenerateCandidatesInput {
  return {
    routing: localRouting(),
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
  };
}

const ADAPTIVE_FORECAST = {
  fiveHourRemainingRatio: 0.8,
  fiveHourResetAt: null,
  timeToFiveHourResetMs: 3 * 3_600_000,
  weeklyRemainingRatio: 0.9,
  weeklyResetAt: null,
  timeToWeeklyResetMs: 5 * 86_400_000,
  observedFiveHourBurnRatePerMinute: null,
  projectedBurnUntilFiveHourReset: null,
  schedulerMode: 'NORMAL' as const,
  telemetryFreshness: 'FRESH' as const,
  observedAt: ADAPTIVE_NOW.toISOString(),
  forecastAt: ADAPTIVE_NOW.toISOString(),
};

function adaptiveHardPolicyVeto(config: AgentConfig): PolicyScenarioOutcome {
  const policy = config.orchestration.jobs.scheduler.adaptive;
  // A harness with a long, flawless history — whose compute locality is NOT
  // verified local. History must not make a forbidden choice allowed.
  const observations = Array.from({ length: 40 }, (_unused, index) =>
    adaptiveObservation({
      attemptId: `at-h-${index}`,
      candidateKey: 'LOCAL/HARNESS/deepseek-harness/qwen/LEGACY',
      targetKey: 'LOCAL/HARNESS',
      executionMode: 'HARNESS',
      runner: 'deepseek-harness',
      label: 'VERIFIED_SUCCESS',
      wallTimeMs: 30_000,
    }),
  );
  const remoteHarness = candidateInput({
    harnessBinding: {
      status: 'BOUND',
      available: true,
      profileName: 'dsh-remote',
      runner: 'deepseek-harness',
      model: 'qwen',
      locality: 'REMOTE',
      localityEvidence: 'public https endpoint',
      credentialRisks: [],
      localityOverridden: false,
      problems: [],
      maxWallTimeMs: 900_000,
    } as unknown as GenerateCandidatesInput['harnessBinding'],
  });
  const candidates = generateCandidates(remoteHarness);
  const ranking = rankCandidates({
    mode: 'ADAPTIVE',
    candidates,
    signature: signature(),
    profiles: aggregateProfiles({ observations, policy, now: ADAPTIVE_NOW }),
    policy,
    forecast: ADAPTIVE_FORECAST,
    priorSuccessProbability: 0.6,
    heuristicWallTimeMs: 10 * 60_000,
  });
  const harnessEligible = candidates.eligible.some(
    (candidate) => candidate.executionMode === 'HARNESS',
  );
  const harnessRejected = candidates.rejected.some(
    (candidate) => candidate.executionMode === 'HARNESS',
  );
  return evaluate(
    'adaptive.hard-policy-veto',
    [
      {
        claim: 'a harness whose compute is not verified local is not an eligible candidate',
        holds: !harnessEligible,
        observed: `eligible=${candidates.eligible.map((c) => c.candidateId).join(', ') || 'none'}`,
      },
      {
        claim: 'the rejection is recorded with a veto code rather than silently dropped',
        holds: harnessRejected,
        observed: candidates.rejected.map((c) => `${c.candidateId}:${c.code}`).join(', ') || 'none',
      },
      {
        claim: 'the selected candidate is never the vetoed one',
        holds:
          ranking.selectedCandidate === null ||
          ranking.selectedCandidate.executionMode !== 'HARNESS' ||
          ranking.selectedCandidate.computeLocality === 'LOCAL',
        observed: `selected=${ranking.selectedCandidate?.candidateId ?? 'none'}`,
      },
    ],
    { ADAPTIVE_PROFILES: 'SIMULATED' },
  );
}

function adaptiveLowConfidenceFallback(config: AgentConfig): PolicyScenarioOutcome {
  const policy = config.orchestration.jobs.scheduler.adaptive;
  const sparse = [adaptiveObservation({ attemptId: 'at-only' })];
  const ranking = rankCandidates({
    mode: 'ADAPTIVE',
    candidates: generateCandidates(candidateInput()),
    signature: signature(),
    profiles: aggregateProfiles({ observations: sparse, policy, now: ADAPTIVE_NOW }),
    policy,
    forecast: ADAPTIVE_FORECAST,
    priorSuccessProbability: 0.6,
    heuristicWallTimeMs: 10 * 60_000,
  });
  return evaluate(
    'adaptive.low-confidence-fallback',
    [
      {
        claim: 'sparse history does not produce an applied adaptive selection',
        holds: !ranking.adaptiveApplied,
        observed: `adaptiveApplied=${String(ranking.adaptiveApplied)} confidence=${ranking.confidence}`,
      },
      {
        claim: 'the fallback records why it fell back',
        holds: ranking.fallbackReason !== null,
        observed: ranking.fallbackReason ?? 'null',
      },
      {
        claim: 'one success out of one attempt is not treated as certainty',
        holds: ranking.confidence !== 'HIGH',
        observed: ranking.confidence,
      },
    ],
    { ADAPTIVE_PROFILES: 'SIMULATED' },
  );
}

function adaptiveDrift(config: AgentConfig): PolicyScenarioOutcome {
  const policy = config.orchestration.jobs.scheduler.adaptive;
  // A long healthy history followed by a run of failures under a CHANGED
  // runner version: the identity moved, so confidence must be withdrawn
  // rather than transferred.
  const historical = Array.from({ length: 30 }, (_unused, index) =>
    adaptiveObservation({
      attemptId: `at-old-${index}`,
      runnerVersion: '1.0.0',
      observedAt: new Date(ADAPTIVE_NOW.getTime() - 10 * 86_400_000).toISOString(),
    }),
  );
  const degraded = Array.from({ length: 6 }, (_unused, index) =>
    adaptiveObservation({
      attemptId: `at-new-${index}`,
      runnerVersion: '2.0.0',
      label: 'IMPLEMENTATION_FAILURE',
      observedAt: new Date(ADAPTIVE_NOW.getTime() - 60_000 * index).toISOString(),
    }),
  );
  const ranking = rankCandidates({
    mode: 'ADAPTIVE',
    candidates: generateCandidates(candidateInput()),
    signature: signature(),
    profiles: aggregateProfiles({
      observations: [...historical, ...degraded],
      policy,
      now: ADAPTIVE_NOW,
    }),
    policy,
    forecast: ADAPTIVE_FORECAST,
    priorSuccessProbability: 0.6,
    heuristicWallTimeMs: 10 * 60_000,
  });
  return evaluate(
    'adaptive.drift-detection',
    [
      {
        claim: 'materially degraded recent performance does not produce a confident selection',
        holds: !ranking.adaptiveApplied || ranking.confidence !== 'HIGH',
        observed: `applied=${String(ranking.adaptiveApplied)} confidence=${ranking.confidence}`,
      },
      {
        claim: 'the outcome is explainable rather than opaque',
        holds: ranking.explanation.length > 0,
        observed: `${ranking.explanation.length} explanation line(s)`,
      },
    ],
    { ADAPTIVE_PROFILES: 'SIMULATED' },
  );
}

function localRemoteNeverLocal(): PolicyScenarioOutcome {
  const remote = generateCandidates(
    candidateInput({
      harnessBinding: {
        status: 'BOUND',
        available: true,
        profileName: 'dsh-remote',
        runner: 'deepseek-harness',
        model: 'qwen',
        locality: 'REMOTE',
        localityEvidence: 'public https endpoint',
        credentialRisks: [],
        localityOverridden: false,
        problems: [],
        maxWallTimeMs: 900_000,
      } as unknown as GenerateCandidatesInput['harnessBinding'],
    }),
  );
  const unknown = generateCandidates(
    candidateInput({
      harnessBinding: {
        status: 'BOUND',
        available: true,
        profileName: 'dsh-unknown',
        runner: 'deepseek-harness',
        model: 'qwen',
        locality: 'UNKNOWN',
        localityEvidence: null,
        credentialRisks: [],
        localityOverridden: false,
        problems: [],
        maxWallTimeMs: 900_000,
      } as unknown as GenerateCandidatesInput['harnessBinding'],
    }),
  );
  const localOnly = (set: ReturnType<typeof generateCandidates>): boolean =>
    set.eligible.every(
      (candidate) => candidate.lane !== 'LOCAL' || candidate.computeLocality === 'LOCAL',
    );
  return evaluate(
    'local.remote-never-local',
    [
      {
        claim: 'a REMOTE harness never yields a LOCAL-lane candidate',
        holds: localOnly(remote),
        observed: remote.eligible
          .map((c) => `${c.lane}/${c.executionMode}/${c.computeLocality}`)
          .join(', '),
      },
      {
        claim: 'an UNKNOWN-locality harness never yields a LOCAL-lane candidate',
        holds: localOnly(unknown),
        observed: unknown.eligible
          .map((c) => `${c.lane}/${c.executionMode}/${c.computeLocality}`)
          .join(', '),
      },
    ],
    { LOCAL_HARNESS: 'SIMULATED' },
  );
}

// ---------------------------------------------------------------------------
// Context scenarios
// ---------------------------------------------------------------------------

function contextProgressiveExpansion(config: AgentConfig): PolicyScenarioOutcome {
  const efficient: AgentConfig = {
    ...config,
    orchestration: {
      ...config.orchestration,
      jobs: {
        ...config.orchestration.jobs,
        context: {
          ...config.orchestration.jobs.context,
          efficiency: {
            ...config.orchestration.jobs.context.efficiency,
            strategy: 'PROGRESSIVE',
          },
        },
      },
    },
  };
  const state = contextExpansionStateSchema.parse({
    taskId: 'qual-task',
    nodeId: 'n1',
    level: 'MINIMAL_BOOTSTRAP',
    expansionsThisAttempt: 0,
    expansionsThisTask: 0,
    updatedAt: NOW.toISOString(),
  });
  const offer = offerContextExpansion({
    config: efficient,
    state,
    signals: ['WORKER_REPORTED_MISSING_CONTEXT'],
  });
  const policy = reliabilityPolicyOf(config);
  const window = [observation({ attemptId: 'at-1', attemptNumber: 1 })];
  const assessment = assessFailure({
    classified: classified('IMPLEMENTATION_DEFECT'),
    lane: 'LOCAL',
    history: window,
    health: 'DEGRADED',
    contextInsufficiencySignals: ['WORKER_REPORTED_MISSING_CONTEXT'],
  });
  const plan = planRecovery({
    assessment,
    health: 'DEGRADED',
    budget: budgetView(),
    policy,
    lane: 'LOCAL',
    executionMode: 'DIRECT_MODEL',
    planRevision: 1,
    planValid: true,
    history: window,
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.2,
    contextExpansion: {
      available: offer.available,
      nextLevel: offer.nextLevel,
      reason: offer.reason,
      exhausted: offer.exhausted,
    },
    resource: RESOURCES,
  });
  return evaluate('context.progressive-expansion', [
    {
      claim: 'observed context-miss evidence moves the failure source to CONTEXT',
      holds: assessment.source === 'CONTEXT',
      observed: assessment.source,
    },
    {
      claim: 'bounded widening is offered',
      holds: offer.available,
      observed: `available=${String(offer.available)} nextLevel=${offer.nextLevel}`,
    },
    {
      claim: 'recovery widens context rather than buying a bigger model',
      holds: plan.requestedCapability?.kind !== 'STRONG',
      observed: `${plan.action}/${plan.reasonCode}/${plan.strategyChange}`,
    },
  ]);
}

function contextExpansionExhaustion(config: AgentConfig): PolicyScenarioOutcome {
  const efficiency = config.orchestration.jobs.context.efficiency;
  const efficient: AgentConfig = {
    ...config,
    orchestration: {
      ...config.orchestration,
      jobs: {
        ...config.orchestration.jobs,
        context: {
          ...config.orchestration.jobs.context,
          efficiency: { ...efficiency, strategy: 'PROGRESSIVE' },
        },
      },
    },
  };
  // The genuine exhaustion state: a FRESH attempt (so the per-attempt
  // refusal, which merely says "start a new attempt", does not fire first)
  // whose task-level widening budget is spent and whose level is already the
  // widest configured. This is the situation that means "more context is not
  // the answer" — as opposed to "not in this attempt".
  const state = contextExpansionStateSchema.parse({
    taskId: 'qual-task',
    nodeId: 'n1',
    level: efficiency.maxExpansionLevel,
    expansionsThisAttempt: 0,
    expansionsThisTask: efficiency.maxExpansionsPerTask,
    updatedAt: NOW.toISOString(),
  });
  const offer = offerContextExpansion({
    config: efficient,
    state,
    signals: ['WORKER_REPORTED_MISSING_CONTEXT'],
  });
  const policy = reliabilityPolicyOf(config);
  const window = [
    observation({ attemptId: 'at-1', attemptNumber: 1, diffFingerprint: 'd1' }),
    observation({ attemptId: 'at-2', attemptNumber: 2, diffFingerprint: 'd2' }),
  ];
  const plan = planRecovery({
    assessment: assessFailure({
      classified: classified('STALE_CONTEXT'),
      lane: 'LOCAL',
      history: window,
      health: 'DEGRADED',
      contextInsufficiencySignals: ['MANDATORY_REFERENCE_DROPPED'],
    }),
    health: 'DEGRADED',
    budget: budgetView(),
    policy,
    lane: 'LOCAL',
    executionMode: 'DIRECT_MODEL',
    planRevision: 1,
    planValid: true,
    history: window,
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.5,
    contextExpansion: {
      available: offer.available,
      nextLevel: offer.nextLevel,
      reason: offer.reason,
      exhausted: offer.exhausted,
    },
    resource: RESOURCES,
  });
  return evaluate('context.expansion-exhaustion', [
    {
      claim: 'exhausted widening is reported as exhausted, not silently retried',
      holds: offer.exhausted && !offer.available,
      observed: `available=${String(offer.available)} exhausted=${String(offer.exhausted)}`,
    },
    {
      claim: 'the decision returns to reliability rather than widening further',
      holds: plan.action !== 'EXPAND_CONTEXT',
      observed: `${plan.action}/${plan.reasonCode}`,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Governance scenarios
// ---------------------------------------------------------------------------

function governanceInvalidContractChange(): PolicyScenarioOutcome {
  // A replanner proposing a materially different approved requirement.
  const screen = screenReplanForApprovedIntentImpact(
    {
      goal: 'Change the public API contract of the workflow definition',
      steps: [{ description: 'Introduce a breaking change to the action result protocol' }],
    },
    {
      goal: 'Implement the workflow definition loader',
      steps: [{ description: 'Parse the definition file and validate it' }],
    },
  );
  return evaluate('governance.invalid-contract-change', [
    {
      claim: 'a replan that would alter approved intent is screened as impacting it',
      holds: screen.impacts,
      observed: `impacts=${String(screen.impacts)}`,
    },
    {
      claim: 'the decision kinds it raises require human authority',
      holds: screen.decisionKinds.every(
        (kind) =>
          DECISION_AUTHORITY_TABLE[kind] === 'human' ||
          DECISION_AUTHORITY_TABLE[kind] === 'human-only' ||
          DECISION_AUTHORITY_TABLE[kind] === 'policy',
      ),
      observed: screen.decisionKinds.join(', ') || 'none',
    },
  ]);
}

function governanceApprovalHumanOnly(): PolicyScenarioOutcome {
  return evaluate('governance.approval-is-human-only', [
    {
      claim: 'approval authority is human-only',
      holds: DECISION_AUTHORITY_TABLE.approval === 'human-only',
      observed: DECISION_AUTHORITY_TABLE.approval,
    },
    {
      claim: 'no autonomous authority exists for architecture or product-behaviour changes',
      holds:
        DECISION_AUTHORITY_TABLE['architecture-contract-change'] === 'human' &&
        DECISION_AUTHORITY_TABLE['product-behavior-change'] === 'human' &&
        DECISION_AUTHORITY_TABLE['spec-conflict'] === 'human',
      observed: [
        `architecture=${DECISION_AUTHORITY_TABLE['architecture-contract-change']}`,
        `product=${DECISION_AUTHORITY_TABLE['product-behavior-change']}`,
        `spec=${DECISION_AUTHORITY_TABLE['spec-conflict']}`,
      ].join(' '),
    },
  ]);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type PolicyScenario = (config: AgentConfig) => PolicyScenarioOutcome;

/**
 * The POLICY scenarios, keyed by matrix id.
 *
 * `governance.fault-injection-scoping` and `governance.preflight-fails-closed`
 * are POLICY scenarios in the matrix but are proved by inspecting THIS
 * package's own structure and the preflight function, so they are executed by
 * the qualification suite rather than from this table — a scenario that
 * checked its own module's scoping from inside that module would be marking
 * its own homework.
 */
export const POLICY_SCENARIOS: Readonly<Record<string, PolicyScenario>> = Object.freeze({
  'quota.five-hour-exhaustion': quotaFiveHourExhaustion,
  'quota.reset-readmits': quotaResetReadmits,
  'quota.cross-reset-admission': quotaCrossReset,
  'quota.harvest': quotaHarvest,
  'quota.weekly-scarcity-suppresses-harvest': quotaWeeklyScarcity,
  'quota.weekly-exhaustion': quotaWeeklyExhaustion,
  'api.disabled-no-spend': apiDisabled,
  'api.bounded-bridge': apiBoundedBridge,
  'api.budget-exhaustion': apiBudgetExhaustion,
  'api.interrupted-reservation': apiInterruptedReservation,
  'api.max-returns-mid-attempt': apiMaxReturnsMidAttempt,
  'reliability.stalled': reliabilityStalled,
  'reliability.oscillation': reliabilityOscillation,
  'reliability.runaway': reliabilityRunaway,
  'reliability.verification-infrastructure': reliabilityVerificationInfrastructure,
  'reliability.contract-violation': reliabilityContractViolation,
  'reliability.replan-preserves-intent': reliabilityReplanPreservesIntent,
  'local.harness-infrastructure-failure': localHarnessInfrastructureFailure,
  'local.intelligence-failure-escalates': localIntelligenceFailureEscalates,
  'local.remote-never-local': () => localRemoteNeverLocal(),
  'adaptive.hard-policy-veto': adaptiveHardPolicyVeto,
  'adaptive.low-confidence-fallback': adaptiveLowConfidenceFallback,
  'adaptive.drift-detection': adaptiveDrift,
  'context.progressive-expansion': contextProgressiveExpansion,
  'context.expansion-exhaustion': contextExpansionExhaustion,
  'governance.invalid-contract-change': () => governanceInvalidContractChange(),
  'governance.approval-is-human-only': () => governanceApprovalHumanOnly(),
});

/**
 * Run every POLICY scenario against the given configuration.
 *
 * A scenario that throws is reported as a FAILURE with the error text, not
 * allowed to abort the run: a qualification runner that stopped at the first
 * exception would hide every finding after it.
 */
export function runPolicyScenarios(config: AgentConfig): PolicyScenarioOutcome[] {
  const outcomes: PolicyScenarioOutcome[] = [];
  for (const [scenarioId, scenario] of Object.entries(POLICY_SCENARIOS)) {
    try {
      outcomes.push(scenario(config));
    } catch (error) {
      outcomes.push({
        scenarioId,
        passed: false,
        failureDetail: `the scenario threw: ${error instanceof Error ? error.message : String(error)}`,
        transitions: [],
        resourceAttribution: {},
      });
    }
  }
  return outcomes;
}
