import { describe, expect, it } from 'vitest';
import {
  FAILURE_CATEGORIES,
  backoffForAttempt,
  classifyFailure,
  decideNextStep,
  failureFingerprint,
  failurePolicy,
  normalizeFailureOutput,
} from '@specbridge/orchestration';
import type { FailureCategory, OrchestrationBudgets, OrchestrationCounters } from '@specbridge/orchestration';

/**
 * Retry, repair, and replan are decided by policy, never by an agent asking
 * to try again. These tests pin the exact decision for every category.
 */

const BUDGETS: OrchestrationBudgets = {
  maxIterations: 12,
  maxRepairCycles: 3,
  maxReplans: 2,
  maxNoProgressCycles: 2,
  maxTransientRetries: 2,
  maxClarificationRounds: 3,
  maxElapsedMs: 3_600_000,
  maxEvents: 2_000,
};

const COUNTERS: OrchestrationCounters = {
  iterations: 1,
  repairCycles: 0,
  replans: 0,
  transientRetries: 0,
  consecutiveNoProgress: 0,
  clarificationRounds: 0,
  events: 5,
};

const BACKOFF = { baseBackoffMs: 1_000, maxBackoffMs: 30_000 };

function decide(
  category: FailureCategory | undefined,
  overrides: {
    counters?: Partial<OrchestrationCounters>;
    budgets?: Partial<OrchestrationBudgets>;
    elapsedMs?: number;
    stagnated?: boolean;
    readyToVerify?: boolean;
  } = {},
) {
  return decideNextStep(
    {
      failure:
        category === undefined
          ? undefined
          : classifyFailure({
              category,
              message: `${category} occurred`,
              source: 'pnpm test',
              exitCode: 1,
              output: 'assertion failed',
            }),
      counters: { ...COUNTERS, ...(overrides.counters ?? {}) },
      budgets: { ...BUDGETS, ...(overrides.budgets ?? {}) },
      elapsedMs: overrides.elapsedMs ?? 1_000,
      stagnated: overrides.stagnated ?? false,
      progressed: true,
      ...(overrides.readyToVerify !== undefined ? { readyToVerify: overrides.readyToVerify } : {}),
    },
    BACKOFF,
  );
}

describe('failure taxonomy', () => {
  it('defines a policy for every category', () => {
    for (const category of FAILURE_CATEGORIES) {
      const policy = failurePolicy(category);
      expect(policy.category).toBe(category);
      expect(policy.remediation.length).toBeGreaterThan(0);
    }
  });

  it('marks only genuinely transient categories retryable', () => {
    const retryable = FAILURE_CATEGORIES.filter((c) => failurePolicy(c).retryable);
    expect(retryable).toEqual(['TRANSIENT_TRANSPORT', 'TRANSIENT_TOOL']);
  });

  it('never marks verification failure or implementation defect retryable', () => {
    expect(failurePolicy('VERIFICATION_FAILURE').retryable).toBe(false);
    expect(failurePolicy('VERIFICATION_FAILURE').repairable).toBe(true);
    expect(failurePolicy('IMPLEMENTATION_DEFECT').retryable).toBe(false);
    expect(failurePolicy('IMPLEMENTATION_DEFECT').repairable).toBe(true);
  });

  it('treats authentication, permission, safety, and cancellation as terminal', () => {
    for (const category of ['AUTHENTICATION', 'PERMISSION', 'SAFETY_POLICY', 'CANCELLED'] as const) {
      const policy = failurePolicy(category);
      expect(policy.retryable).toBe(false);
      expect(policy.terminal).toBe(true);
    }
  });
});

describe('failure fingerprints', () => {
  it('normalizes volatile output so the same failure hashes the same', () => {
    const a = 'FAIL D:\\work\\repo\\src\\a.ts:12:4 in 1.42s (pid 8123) abc123def456';
    const b = 'FAIL D:\\work\\other\\src\\a.ts:99:1 in 7.10s (pid 4471) fedcba654321';
    expect(normalizeFailureOutput(a)).toBe(normalizeFailureOutput(b));
  });

  it('keeps genuinely different failures distinct', () => {
    const one = failureFingerprint({
      category: 'VERIFICATION_FAILURE',
      source: 'pnpm test',
      exitCode: 1,
      output: 'expected 3 to equal 4',
    });
    const two = failureFingerprint({
      category: 'VERIFICATION_FAILURE',
      source: 'pnpm test',
      exitCode: 1,
      output: 'cannot read property foo of undefined',
    });
    expect(one).not.toBe(two);
  });

  it('distinguishes different verifiers with identical output', () => {
    const base = { category: 'VERIFICATION_FAILURE' as const, exitCode: 1, output: 'failed' };
    expect(failureFingerprint({ ...base, source: 'lint' })).not.toBe(
      failureFingerprint({ ...base, source: 'test' }),
    );
  });
});

describe('retry decisions', () => {
  it('retries a transient failure with bounded exponential backoff', () => {
    const first = decide('TRANSIENT_TRANSPORT');
    expect(first.directive).toBe('RETRY');
    expect(first.backoffMs).toBe(1_000);

    const second = decide('TRANSIENT_TRANSPORT', { counters: { transientRetries: 1 } });
    expect(second.directive).toBe('RETRY');
    expect(second.backoffMs).toBe(2_000);
  });

  it('stops when the transient retry budget is exhausted', () => {
    const decision = decide('TRANSIENT_TOOL', { counters: { transientRetries: 2 } });
    expect(decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(decision.exhaustedBudget).toBe('maxTransientRetries');
  });

  it('sends a verification failure into repair, never a rerun', () => {
    const decision = decide('VERIFICATION_FAILURE');
    expect(decision.directive).toBe('REPAIR');
    expect(decision.reason).toMatch(/rather than rerunning/i);
  });

  it('stops when the repair budget is exhausted and leaves the task incomplete', () => {
    const decision = decide('VERIFICATION_FAILURE', { counters: { repairCycles: 3 } });
    expect(decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(decision.exhaustedBudget).toBe('maxRepairCycles');
    expect(decision.remediation.join(' ')).toMatch(/preserved/i);
  });

  it('clarifies ambiguity instead of retrying it', () => {
    const decision = decide('AMBIGUITY');
    expect(decision.directive).toBe('CLARIFY');
    expect(decision.backoffMs).toBe(0);
  });

  it('never retries authentication, permission, or safety failures', () => {
    for (const category of ['AUTHENTICATION', 'PERMISSION', 'SAFETY_POLICY'] as const) {
      const decision = decide(category);
      expect(decision.directive).toBe('BLOCK');
      expect(decision.backoffMs).toBe(0);
    }
  });

  it('never restarts after cancellation, even with budget left', () => {
    const decision = decide('CANCELLED', { counters: { transientRetries: 0, iterations: 0 } });
    expect(decision.directive).toBe('STOP_FINAL');
    expect(decision.reason).toMatch(/never restarted automatically/i);
  });

  it('replans on stagnation while a replan budget remains', () => {
    const decision = decide(undefined, { stagnated: true, counters: { replans: 0 } });
    expect(decision.directive).toBe('REPLAN');
    expect(decision.failureCategory).toBe('NO_PROGRESS');
  });

  it('blocks on stagnation once the replan budget is gone', () => {
    const decision = decide(undefined, {
      stagnated: true,
      counters: { replans: 2, consecutiveNoProgress: 2 },
    });
    expect(decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(decision.exhaustedBudget).toBe('maxNoProgressCycles');
  });

  it('stops when the iteration budget is reached', () => {
    const decision = decide(undefined, { counters: { iterations: 12 } });
    expect(decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(decision.exhaustedBudget).toBe('maxIterations');
  });

  it('stops when the wall-clock budget is reached', () => {
    const decision = decide(undefined, { elapsedMs: 3_600_001 });
    expect(decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
    expect(decision.exhaustedBudget).toBe('maxElapsedMs');
  });

  it('checks budgets before continuing, so an exhausted run cannot take one more step', () => {
    // A clean observation with no failure still stops when out of iterations.
    const decision = decide(undefined, { counters: { iterations: 99 } });
    expect(decision.directive).toBe('STOP_BUDGET_EXHAUSTED');
  });

  it('routes a ready implementation to verification rather than completion', () => {
    const decision = decide(undefined, { readyToVerify: true });
    expect(decision.directive).toBe('VERIFY');
    expect(decision.remediation.join(' ')).toMatch(/task_complete/);
  });

  it('continues when nothing failed and nothing is asserted ready', () => {
    expect(decide(undefined).directive).toBe('CONTINUE');
  });

  it('replans on stale context and repository divergence', () => {
    expect(decide('STALE_CONTEXT').directive).toBe('REPLAN');
    expect(decide('REPOSITORY_DIVERGED').directive).toBe('REPLAN');
  });

  it('blocks a protected-path violation outright', () => {
    expect(decide('PROTECTED_PATH').directive).toBe('BLOCK');
  });

  it('caps backoff at the configured maximum', () => {
    expect(backoffForAttempt(0, BACKOFF)).toBe(0);
    expect(backoffForAttempt(1, BACKOFF)).toBe(1_000);
    expect(backoffForAttempt(10, BACKOFF)).toBe(30_000);
  });
});
