import { describe, expect, it } from 'vitest';
import { jobPolicySchema } from '@specbridge/core';
import {
  DECISION_AUTHORITY_TABLE,
  JOB_DECISION_KINDS,
  assertAutonomousDecisionAllowed,
  assessComplexity,
  authorityFor,
  isAutonomous,
  mergeComplexity,
  requiresHuman,
} from '@specbridge/orchestration';
import type { ComplexityInput ,
  OrchestrationError} from '@specbridge/orchestration';

/**
 * Complexity assessment is deterministic routing policy: same input, same
 * class, and the recorded signals explain the answer. The decision-authority
 * table is the structural form of "who may decide what".
 */

const policy = jobPolicySchema.parse({}).complexity;

function input(overrides: Partial<ComplexityInput> = {}): ComplexityInput {
  return {
    taskId: '1',
    title: 'Implement the settings store',
    requirementRefs: ['1.1'],
    childCount: 0,
    previousFailureCount: 0,
    previousReplanCount: 0,
    ...overrides,
  };
}

describe('assessComplexity', () => {
  it('classifies a plain implementation task LOW', () => {
    const result = assessComplexity(input(), policy);
    expect(result.class).toBe('LOW');
  });

  it('is deterministic: identical input yields identical output', () => {
    const a = assessComplexity(input(), policy);
    const b = assessComplexity(input(), policy);
    expect(a).toEqual(b);
  });

  it('security-sensitive work forces HIGH regardless of score', () => {
    const result = assessComplexity(
      input({ title: 'Add token authentication to the settings service' }),
      policy,
    );
    expect(result.class).toBe('HIGH');
    expect(result.signals.some((signal) => signal.signal === 'security-impact' && signal.forcesHigh)).toBe(true);
  });

  it('distributed-system semantics force HIGH', () => {
    const result = assessComplexity(
      input({ title: 'Design at-least-once delivery with idempotent consumers' }),
      policy,
    );
    expect(result.class).toBe('HIGH');
  });

  it('public API impact forces HIGH', () => {
    const result = assessComplexity(input({ title: 'Change the public API contract for exports' }), policy);
    expect(result.class).toBe('HIGH');
  });

  it('accumulated structural signals reach MEDIUM without any forced signal', () => {
    const result = assessComplexity(
      input({
        title: 'Wire the store behind concurrent access',
        requirementRefs: ['1.1', '1.2', '2.1', '2.2'],
      }),
      policy,
    );
    expect(result.class).toBe('MEDIUM');
    expect(result.signals.every((signal) => !signal.forcesHigh)).toBe(true);
  });

  it('previous replans raise the class; two force HIGH', () => {
    const once = assessComplexity(input({ previousReplanCount: 1 }), policy);
    expect(once.signals.some((signal) => signal.signal === 'previous-replans')).toBe(true);
    const twice = assessComplexity(input({ previousReplanCount: 2 }), policy);
    expect(twice.class).toBe('HIGH');
  });

  it('scans related spec text, not only the title', () => {
    const result = assessComplexity(
      input({ relatedSpecText: 'The design requires a schema migration of the database.' }),
      policy,
    );
    expect(result.signals.some((signal) => signal.signal === 'persistence-impact')).toBe(true);
  });
});

describe('mergeComplexity', () => {
  it('a classifier proposal may raise the deterministic class', () => {
    expect(mergeComplexity('LOW', 'MEDIUM')).toBe('MEDIUM');
    expect(mergeComplexity('MEDIUM', 'HIGH')).toBe('HIGH');
  });

  it('a classifier proposal can never lower it', () => {
    expect(mergeComplexity('HIGH', 'LOW')).toBe('HIGH');
    expect(mergeComplexity('MEDIUM', 'LOW')).toBe('MEDIUM');
  });

  it('no proposal keeps the deterministic class', () => {
    expect(mergeComplexity('MEDIUM', undefined)).toBe('MEDIUM');
  });
});

describe('decision authority', () => {
  it('covers every decision kind', () => {
    for (const kind of JOB_DECISION_KINDS) {
      expect(DECISION_AUTHORITY_TABLE[kind]).toBeDefined();
    }
  });

  it('repairs and internal implementation decisions are autonomous', () => {
    expect(isAutonomous('compile-repair')).toBe(true);
    expect(isAutonomous('unit-test-repair')).toBe(true);
    expect(isAutonomous('implementation-detail')).toBe(true);
    expect(isAutonomous('internal-refactor')).toBe(true);
    expect(isAutonomous('runtime-replan')).toBe(true);
  });

  it('approved-intent decisions require a human', () => {
    expect(requiresHuman('public-api-change')).toBe(true);
    expect(requiresHuman('architecture-contract-change')).toBe(true);
    expect(requiresHuman('product-behavior-change')).toBe(true);
    expect(requiresHuman('spec-conflict')).toBe(true);
  });

  it('approval is human-only', () => {
    expect(authorityFor('approval')).toBe('human-only');
  });

  it('assertAutonomousDecisionAllowed passes auto and escalate kinds', () => {
    expect(() => assertAutonomousDecisionAllowed('compile-repair')).not.toThrow();
    expect(() => assertAutonomousDecisionAllowed('plan-strategy-disagreement')).not.toThrow();
  });

  it('refuses human-gated kinds with SBO033, whatever options are passed', () => {
    for (const kind of ['public-api-change', 'spec-conflict', 'approval'] as const) {
      try {
        assertAutonomousDecisionAllowed(kind, { policyAllowsNewDependency: true });
        expect.unreachable(`${kind} should have thrown`);
      } catch (error) {
        expect((error as OrchestrationError).code).toBe('SBO033');
      }
    }
  });

  it('new-dependency is policy-gated: refused by default, allowed by explicit policy', () => {
    expect(() => assertAutonomousDecisionAllowed('new-dependency')).toThrowError(/policy/);
    expect(() =>
      assertAutonomousDecisionAllowed('new-dependency', { policyAllowsNewDependency: true }),
    ).not.toThrow();
  });
});
