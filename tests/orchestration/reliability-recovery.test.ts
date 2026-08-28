import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '@specbridge/core';
import { assessFailure, buildBudgetView, classifyFailure, planRecovery } from '@specbridge/orchestration';
import type {
  AssessedFailure,
  BudgetView,
  RecoveryPlanInput,
  RecoveryResource,
  ReliabilityObservation,
} from '@specbridge/orchestration';
import type { ReliabilityPolicy } from '@specbridge/core';

/**
 * The Recovery Planner is a pure function, and every test here is a claim
 * about the decision it must reach for a given world. The properties being
 * pinned:
 *
 *   - a failure is never retried without a classification
 *   - infrastructure failure never escalates to "needs a better model"
 *   - repeated failure changes strategy rather than consuming more compute
 *   - a paid lane is never retried into
 *   - escalation is a request, and refusing to spend is an acceptable answer
 */

const POLICY: ReliabilityPolicy = defaultAgentConfig().orchestration.jobs.reliability;

const ALL_AVAILABLE: RecoveryResource = {
  subscriptionAvailable: true,
  subscriptionReturnsInMs: null,
  subscriptionWorkerConfigured: true,
  apiAuthorized: false,
  apiBudgetAvailable: false,
  localAvailable: true,
  localHarnessAvailable: true,
};

function budget(overrides: Partial<BudgetView> = {}): BudgetView {
  const base = buildBudgetView({
    budgets: defaultAgentConfig().orchestration.jobs.budgets as never,
    counters: {
      agentRuns: 2,
      humanWaitMs: 0,
      deadIdleMs: 0,
      localInferenceCalls: 1,
      jobReplans: 0,
      transientRetries: 0,
      clarificationRounds: 0,
      escalations: 0,
      events: 10,
      reportedCostUsd: null,
      reportedTokens: null,
    },
    node: { attempts: [], repairCycles: 0, replans: 0, consecutiveNoProgress: 0 },
    executorAttempts: 1,
    elapsedMs: 60_000,
    local: { used: 1, max: 2 },
  });
  return { ...base, ...overrides };
}

function assess(
  category: Parameters<typeof classifyFailure>[0]['category'],
  overrides: Partial<Parameters<typeof assessFailure>[0]> = {},
): AssessedFailure {
  return assessFailure({
    classified: classifyFailure({ category, message: 'test failure', source: 'unit-tests' }),
    lane: 'LOCAL',
    history: [],
    health: 'DEGRADED',
    ...overrides,
  });
}

function plan(overrides: Partial<RecoveryPlanInput> = {}): ReturnType<typeof planRecovery> {
  const history: ReliabilityObservation[] = [];
  return planRecovery({
    assessment: assess('VERIFICATION_FAILURE'),
    health: 'DEGRADED',
    budget: budget(),
    policy: POLICY,
    lane: 'LOCAL',
    executionMode: 'HARNESS',
    planRevision: 1,
    planValid: true,
    history,
    exhaustedStrategies: [],
    freshContextRestartsUsed: 0,
    infrastructureRetriesUsed: 0,
    contextRatio: 0.3,
    resource: ALL_AVAILABLE,
    ...overrides,
  });
}

describe('Test E — no blind retry', () => {
  it('never returns a bare retry for a deterministic verification failure', () => {
    const decision = plan();
    expect(decision.action).toBe('REPAIR');
    expect(decision.action).not.toBe('RETRY_TRANSIENT');
    expect(decision.strategyChange).toBe('IMPLEMENTATION_APPROACH');
    expect(decision.reasonCode).toBe('VERIFICATION_FAILED_REPAIRABLE');
  });

  it('retries only genuinely transient conditions, and only within budget', () => {
    expect(plan({ assessment: assess('TRANSIENT_TRANSPORT') }).action).toBe('RETRY_TRANSIENT');
    const spent = plan({
      assessment: assess('TRANSIENT_TRANSPORT'),
      budget: budget({ remainingTransientRetries: 0 }),
    });
    expect(spent.action).not.toBe('RETRY_TRANSIENT');
  });
});

describe('Test J — infrastructure failure is not intelligence failure', () => {
  const crashed = assess('CAPABILITY_UNAVAILABLE', {
    harnessFailureKind: 'INFRASTRUCTURE',
  });

  it('classifies a crashed runtime as EXECUTION_INFRASTRUCTURE', () => {
    expect(crashed.source).toBe('EXECUTION_INFRASTRUCTURE');
    expect(crashed.basis).toBe('PROVIDER_SIGNAL');
  });

  it('answers with a bounded infrastructure retry, never an escalation', () => {
    const decision = plan({ assessment: crashed, infrastructureRetriesUsed: 0 });
    expect(decision.action).toBe('RETRY_TRANSIENT');
    expect(decision.reasonCode).toBe('INFRASTRUCTURE_RETRY');
    expect(decision.reason).toContain('installation');
  });

  it('changes execution mode rather than model once those retries are spent', () => {
    const decision = plan({
      assessment: crashed,
      executionMode: 'DIRECT_MODEL',
      infrastructureRetriesUsed: POLICY.maxInfrastructureRetries,
    });
    expect(decision.action).toBe('RETRY_DIFFERENT_LOCAL_MODE');
  });
});

describe('Test K — bounded local intelligence escalates', () => {
  it('requests strong execution when the shared local budget is spent', () => {
    const decision = plan({
      assessment: assess('IMPLEMENTATION_DEFECT'),
      lane: 'LOCAL',
      executionMode: 'HARNESS',
      budget: budget({ remainingLocalAttempts: 0, remainingRepairs: 0, remainingReplans: 0 }),
    });
    expect(decision.action).toBe('ESCALATE_INTELLIGENCE');
    expect(decision.requestedCapability?.kind).toBe('STRONG');
    expect(decision.nextStrategy.lane).toBe('SUBSCRIPTION');
  });

  it('prefers a local mode change over spending prepaid quota', () => {
    const decision = plan({
      assessment: assess('IMPLEMENTATION_DEFECT'),
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
      budget: budget({ remainingLocalAttempts: 1 }),
    });
    expect(decision.action).toBe('RETRY_DIFFERENT_LOCAL_MODE');
    expect(decision.nextStrategy.lane).toBe('LOCAL');
    expect(decision.nextStrategy.executionMode).toBe('HARNESS');
  });
});

describe('Test L — a subscription failure does not reach for the API', () => {
  it('repairs on the subscription lane while Max is available', () => {
    const decision = plan({
      assessment: assess('VERIFICATION_FAILURE', { lane: 'SUBSCRIPTION' }),
      lane: 'SUBSCRIPTION',
      executionMode: null,
      resource: { ...ALL_AVAILABLE, apiAuthorized: true, apiBudgetAvailable: true },
    });
    expect(decision.action).toBe('REPAIR');
    expect(decision.nextStrategy.lane).toBe('SUBSCRIPTION');
  });

  it('replans on the subscription lane rather than paying, once repair is spent', () => {
    const decision = plan({
      assessment: assess('VERIFICATION_FAILURE', { lane: 'SUBSCRIPTION' }),
      lane: 'SUBSCRIPTION',
      executionMode: null,
      budget: budget({ remainingRepairs: 0 }),
      resource: { ...ALL_AVAILABLE, apiAuthorized: true, apiBudgetAvailable: true },
    });
    expect(decision.action).toBe('REPLAN');
    // A replan leaves placement to the economic scheduler, so it records no
    // lane at all. What matters here is that it never REQUESTS paid capacity
    // while prepaid capacity is available.
    expect(decision.nextStrategy.lane).toBeNull();
    expect(decision.requestedCapability).toBeUndefined();
  });
});

describe('Test M — a paid deterministic failure is never blindly retried', () => {
  const apiFailure = assess('VERIFICATION_FAILURE', { lane: 'API' });

  it('changes strategy instead of buying the same experiment twice', () => {
    const decision = plan({
      assessment: apiFailure,
      lane: 'API',
      executionMode: 'HARNESS',
      resource: {
        ...ALL_AVAILABLE,
        subscriptionAvailable: false,
        subscriptionReturnsInMs: null,
        apiAuthorized: true,
        apiBudgetAvailable: true,
      },
    });
    expect(decision.action).toBe('REPLAN');
    expect(decision.reasonCode).toBe('PAID_DETERMINISTIC_FAILURE_NO_RETRY');
    expect(decision.nextStrategy.lane).not.toBe('API');
  });

  it('waits for prepaid capacity rather than paying again when it returns soon', () => {
    const decision = plan({
      assessment: apiFailure,
      lane: 'API',
      executionMode: 'HARNESS',
      resource: {
        ...ALL_AVAILABLE,
        subscriptionAvailable: false,
        subscriptionReturnsInMs: 12 * 60_000,
        apiAuthorized: true,
        apiBudgetAvailable: true,
      },
    });
    expect(decision.action).toBe('WAIT_FOR_RESOURCE');
  });

  it('asks a human before spending again once no replan budget remains', () => {
    const decision = plan({
      assessment: apiFailure,
      lane: 'API',
      executionMode: 'HARNESS',
      budget: budget({ remainingReplans: 0 }),
      resource: {
        ...ALL_AVAILABLE,
        subscriptionAvailable: false,
        subscriptionReturnsInMs: null,
        apiAuthorized: true,
        apiBudgetAvailable: true,
      },
    });
    expect(decision.action).toBe('REQUEST_HUMAN_DECISION');
  });
});

describe('Test P — repeated repair failure replans', () => {
  it('replans once the repair budget is spent', () => {
    const decision = plan({ budget: budget({ remainingRepairs: 0 }) });
    expect(decision.action).toBe('REPLAN');
    expect(decision.reasonCode).toBe('REPEATED_REPAIR_FAILED_REPLAN');
    expect(decision.nextStrategy.planRevision).toBe(2);
  });

  it('replans on STALLED even with repair budget left', () => {
    const decision = plan({
      health: 'STALLED',
      assessment: assess('VERIFICATION_FAILURE', { health: 'STALLED' }),
      executionMode: 'HARNESS',
    });
    expect(decision.action).toBe('REPLAN');
    expect(decision.reasonCode).toBe('NO_PROGRESS_REPLAN');
  });

  it('replans on OSCILLATING with the oscillation reason recorded', () => {
    const decision = plan({
      health: 'OSCILLATING',
      assessment: assess('VERIFICATION_FAILURE', { health: 'OSCILLATING' }),
      executionMode: 'HARNESS',
    });
    expect(decision.action).toBe('REPLAN');
    expect(decision.reasonCode).toBe('OSCILLATION_REPLAN');
  });
});

describe('Test Q — approved intent stays human authority', () => {
  it('routes a contract conflict to a human, never to more code', () => {
    const decision = plan({
      assessment: assess('AMBIGUITY'),
    });
    expect(decision.action).toBe('REQUEST_HUMAN_DECISION');
    expect(decision.remediation.join(' ')).toContain('never changes approved intent');
  });

  it('says explicitly that replanning may not change approved intent', () => {
    const decision = plan({ budget: budget({ remainingRepairs: 0 }) });
    expect(decision.action).toBe('REPLAN');
    expect(decision.remediation.join(' ')).toContain('never change approved intent');
  });
});

describe('Test R — budget exhaustion stops honestly', () => {
  it('fails the task when every execution attempt is spent', () => {
    const decision = plan({ budget: budget({ remainingAttempts: 0 }) });
    expect(decision.action).toBe('FAIL_TASK');
    expect(decision.reasonCode).toBe('RECOVERY_BUDGET_EXHAUSTED');
    expect(decision.remediation.join(' ')).toContain('preserved');
  });

  it('blocks on a hard boundary without consuming any budget', () => {
    const decision = plan({ assessment: assess('PROTECTED_PATH') });
    expect(decision.action).toBe('BLOCK');
    expect(decision.reasonCode).toBe('HARD_BOUNDARY');
  });

  it('stops when stuck with no replan budget and no stronger option', () => {
    const decision = plan({
      health: 'STALLED',
      assessment: assess('REPOSITORY_DIVERGED', { health: 'STALLED' }),
      executionMode: 'HARNESS',
      budget: budget({ remainingReplans: 0 }),
    });
    expect(decision.action).toBe('FAIL_TASK');
    expect(decision.reasonCode).toBe('STRATEGIES_EXHAUSTED');
  });
});

describe('Test S — API spend policy still governs recovery', () => {
  const stuck = {
    assessment: assess('IMPLEMENTATION_DEFECT'),
    lane: 'LOCAL' as const,
    executionMode: 'HARNESS',
    budget: budget({ remainingLocalAttempts: 0, remainingRepairs: 0, remainingReplans: 0 }),
  };

  it('waits instead of spending when paid execution is not authorized', () => {
    const decision = plan({
      ...stuck,
      resource: {
        ...ALL_AVAILABLE,
        subscriptionAvailable: false,
        subscriptionReturnsInMs: null,
        apiAuthorized: false,
        apiBudgetAvailable: false,
      },
    });
    expect(decision.action).toBe('WAIT_FOR_RESOURCE');
    expect(decision.reasonCode).toBe('PAID_CONTINUATION_UNAUTHORIZED');
  });

  it('waits instead of spending when the API budget refuses', () => {
    const decision = plan({
      ...stuck,
      resource: {
        ...ALL_AVAILABLE,
        subscriptionAvailable: false,
        subscriptionReturnsInMs: null,
        apiAuthorized: true,
        apiBudgetAvailable: false,
      },
    });
    expect(decision.action).toBe('WAIT_FOR_RESOURCE');
    expect(decision.reasonCode).toBe('PAID_BUDGET_REFUSED');
  });

  it('records an API escalation as a REQUEST that authorizes nothing', () => {
    const decision = plan({
      ...stuck,
      resource: {
        ...ALL_AVAILABLE,
        subscriptionAvailable: false,
        subscriptionReturnsInMs: null,
        apiAuthorized: true,
        apiBudgetAvailable: true,
      },
    });
    expect(decision.action).toBe('ESCALATE_LANE');
    expect(decision.requestedCapability?.kind).toBe('REMOTE');
    expect(decision.remediation.join(' ')).toContain('not an authorization');
  });
});

describe('Test T — waiting for prepaid capacity is a real outcome', () => {
  it('waits when Max returns shortly rather than escalating anywhere', () => {
    const decision = plan({
      assessment: assess('IMPLEMENTATION_DEFECT'),
      lane: 'LOCAL',
      executionMode: 'HARNESS',
      budget: budget({ remainingLocalAttempts: 0, remainingRepairs: 0, remainingReplans: 0 }),
      resource: {
        ...ALL_AVAILABLE,
        subscriptionAvailable: false,
        subscriptionReturnsInMs: 8 * 60_000,
        apiAuthorized: true,
        apiBudgetAvailable: true,
      },
    });
    expect(decision.action).toBe('WAIT_FOR_RESOURCE');
    expect(decision.reasonCode).toBe('RESOURCE_RETURNS_SOON');
    expect(decision.waitMs).toBe(8 * 60_000);
  });
});

describe('broken measuring equipment before broken code', () => {
  it('retries rather than repairing when the verifier itself failed', () => {
    const decision = plan({
      assessment: assess('VERIFICATION_FAILURE', { verificationInfrastructureBroken: true }),
    });
    expect(decision.action).toBe('RETRY_TRANSIENT');
    expect(decision.reasonCode).toBe('INFRASTRUCTURE_RETRY');
    expect(decision.reason).toContain('rather than the implementation being treated as wrong');
  });

  it('blocks with no code change implied once those retries are spent', () => {
    const decision = plan({
      assessment: assess('VERIFICATION_FAILURE', { verificationInfrastructureBroken: true }),
      infrastructureRetriesUsed: POLICY.maxInfrastructureRetries,
    });
    expect(decision.action).toBe('BLOCK');
    expect(decision.reasonCode).toBe('EVALUATION_INFRASTRUCTURE_BROKEN');
    expect(decision.remediation.join(' ')).toContain('no code change is implied');
  });
});

describe('context degradation rebuilds context rather than blaming the code', () => {
  it('restarts with a fresh context when occupancy passes the threshold', () => {
    const decision = plan({ contextRatio: 0.9 });
    expect(decision.action).toBe('RESTART_FRESH_CONTEXT');
    expect(decision.strategyChange).toBe('CONTEXT');
    expect(decision.nextStrategy.freshContext).toBe(true);
  });

  it('restarts with a fresh context after a RUNAWAY attempt', () => {
    const decision = plan({
      health: 'RUNAWAY',
      assessment: assess('IMPLEMENTATION_DEFECT', {
        health: 'RUNAWAY',
        runawaySignals: ['TOOL_CALL_BUDGET'],
      }),
    });
    expect(decision.action).toBe('RESTART_FRESH_CONTEXT');
    expect(decision.reasonCode).toBe('SESSION_STALLED_FRESH_CONTEXT');
  });

  it('stops restarting once the bounded restart budget is spent', () => {
    const decision = plan({
      contextRatio: 0.9,
      freshContextRestartsUsed: POLICY.maxFreshContextRestarts,
    });
    expect(decision.action).not.toBe('RESTART_FRESH_CONTEXT');
  });
});

describe('reproducibility', () => {
  it('returns the identical decision for identical input', () => {
    const input: Partial<RecoveryPlanInput> = {
      health: 'STALLED',
      assessment: assess('VERIFICATION_FAILURE', { health: 'STALLED' }),
      executionMode: 'HARNESS',
    };
    expect(JSON.stringify(plan(input))).toBe(JSON.stringify(plan(input)));
  });
});
