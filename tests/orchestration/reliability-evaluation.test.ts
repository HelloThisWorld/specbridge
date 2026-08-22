import { describe, expect, it } from 'vitest';
import {
  evaluateAcceptanceCriteria,
  evaluateAttempt,
  semanticReviewWarranted,
} from '@specbridge/orchestration';
import type {
  AcceptanceCriterion,
  EvaluateAttemptInput,
  SemanticEvaluationInput,
} from '@specbridge/orchestration';

/**
 * Evaluation decides whether an attempt's WORK is acceptable, and the whole
 * point is that a model's claim never enters that decision.
 *
 * These tests pin the three things that must never drift: a completion claim
 * loses to deterministic evidence, a semantic opinion loses to deterministic
 * evidence, and "we could not tell" stays distinguishable from "the code is
 * wrong".
 */

function baseInput(overrides: Partial<EvaluateAttemptInput> = {}): EvaluateAttemptInput {
  return {
    evaluationId: 'ev-1',
    jobId: 'job-1',
    nodeId: 'n-1',
    taskId: '1.1',
    attemptId: 'at-1',
    lane: 'LOCAL',
    createdAt: '2026-01-01T00:00:00.000Z',
    integrity: {
      terminatedNormally: true,
      workerIdentityMatches: true,
      baselineValid: true,
      taskFingerprintValid: true,
      approvalsStillValid: true,
      protectedPathViolations: [],
      reportValidated: true,
    },
    repository: {
      changedPaths: ['src/a.ts'],
      ambiguousPaths: [],
      headMoved: false,
      taskStillExists: true,
      changeRequired: true,
    },
    verification: {
      configured: true,
      skipped: false,
      ran: true,
      commands: [
        { name: 'typecheck', required: true, passed: true, timedOut: false },
        { name: 'unit-tests', required: true, passed: true, timedOut: false },
      ],
    },
    ...overrides,
  };
}

describe('Test A — a deterministic failure beats a completion claim', () => {
  it('FAILs when the runner reported completion but a trusted test failed', () => {
    const result = evaluateAttempt(
      baseInput({
        verification: {
          configured: true,
          skipped: false,
          ran: true,
          commands: [
            { name: 'typecheck', required: true, passed: true, timedOut: false },
            {
              name: 'unit-tests',
              required: true,
              passed: false,
              timedOut: false,
              detail: 'expected 3 received 4',
            },
          ],
        },
      }),
    );

    expect(result.status).toBe('FAIL');
    const tests = result.deterministicChecks.find((check) => check.name === 'unit-tests');
    expect(tests?.level).toBe('TESTS');
    expect(tests?.outcome).toBe('FAILED');
  });

  it('records the claim/Git discrepancy without letting the claim decide', () => {
    const result = evaluateAttempt(
      baseInput({
        repository: {
          changedPaths: [],
          ambiguousPaths: [],
          headMoved: false,
          taskStillExists: true,
          changeRequired: true,
          claimedChangedPaths: ['src/a.ts', 'src/b.ts'],
        },
      }),
    );

    expect(result.status).toBe('FAIL');
    expect(
      result.deterministicChecks.find((check) => check.name === 'non-empty-change')?.outcome,
    ).toBe('FAILED');
    const claim = result.deterministicChecks.find((check) => check.name === 'claim-consistency');
    expect(claim?.required).toBe(false);
    expect(claim?.detail).toContain('claimed 2 changed file(s)');
  });
});

describe('Test B — a semantic PASS cannot override a deterministic FAIL', () => {
  const semanticPass: SemanticEvaluationInput = {
    ran: true,
    verdict: 'PASS',
    findings: [{ severity: 'note', observation: 'looks reasonable to me' }],
  };

  it('keeps FAIL when compilation fails and the reviewer approves', () => {
    const result = evaluateAttempt(
      baseInput({
        verification: {
          configured: true,
          skipped: false,
          ran: true,
          commands: [{ name: 'typecheck', required: true, passed: false, timedOut: false }],
        },
        semantic: semanticPass,
      }),
    );

    expect(result.status).toBe('FAIL');
    expect(result.semanticReviewRan).toBe(false);
    const semantic = result.semanticChecks[0];
    expect(semantic?.outcome).toBe('NOT_RUN');
    expect(semantic?.detail).toContain('cannot override');
  });

  it('lets a blocking semantic finding fail an otherwise passing attempt', () => {
    const result = evaluateAttempt(
      baseInput({
        semantic: {
          ran: true,
          verdict: 'FAIL',
          findings: [
            { severity: 'blocking', observation: 'introduces a second source of truth for job state' },
          ],
        },
      }),
    );

    expect(result.status).toBe('FAIL');
    expect(result.semanticReviewRan).toBe(true);
    expect(result.semanticChecks[0]?.outcome).toBe('FAILED');
  });

  it('never dispatches a reviewer once deterministic evidence has decided', () => {
    expect(
      semanticReviewWarranted({
        mode: 'always',
        deterministicStatus: 'FAIL',
        uncheckedCriteriaCount: 3,
        highRisk: true,
      }),
    ).toBe(false);
    expect(
      semanticReviewWarranted({
        mode: 'auto',
        deterministicStatus: 'PASS',
        uncheckedCriteriaCount: 1,
        highRisk: false,
      }),
    ).toBe(true);
    expect(
      semanticReviewWarranted({
        mode: 'disabled',
        deterministicStatus: 'PASS',
        uncheckedCriteriaCount: 5,
        highRisk: true,
      }),
    ).toBe(false);
  });
});

describe('Test C — tests pass but the approved contract fails', () => {
  const criteria: AcceptanceCriterion[] = [
    {
      id: 'AC-1',
      text: 'the lane decision must be recorded on the attempt',
      check: { kind: 'pattern-present', value: 'recordLaneDecision' },
    },
    {
      id: 'AC-2',
      text: 'no change outside packages/orchestration',
      check: { kind: 'changed-within', value: 'packages/orchestration' },
    },
  ];

  it('FAILs the task when a deterministic acceptance criterion does not hold', () => {
    const criteriaResult = evaluateAcceptanceCriteria(criteria, {
      existingPaths: new Set(['packages/orchestration/src/a.ts']),
      changedPaths: ['packages/orchestration/src/a.ts'],
      addedLines: ['  const x = 1;'],
      verifierResults: new Map([['unit-tests', true]]),
    });

    expect(criteriaResult.failedCriteria).toEqual(['AC-1']);

    const result = evaluateAttempt(
      baseInput({
        criteriaChecks: criteriaResult.checks,
        failedCriteria: criteriaResult.failedCriteria,
      }),
    );

    expect(result.status).toBe('FAIL');
    expect(result.failedCriteria).toEqual(['AC-1']);
    // Every verification command passed; the contract is what failed.
    expect(
      result.deterministicChecks
        .filter((check) => check.required && check.outcome === 'FAILED')
        .every((check) => check.level === 'ACCEPTANCE_CRITERIA'),
    ).toBe(true);
  });

  it('passes when every structural criterion holds', () => {
    const criteriaResult = evaluateAcceptanceCriteria(criteria, {
      existingPaths: new Set(['packages/orchestration/src/a.ts']),
      changedPaths: ['packages/orchestration/src/a.ts'],
      addedLines: ['  recordLaneDecision(deps, jobId, input);'],
      verifierResults: new Map([['unit-tests', true]]),
    });

    const result = evaluateAttempt(
      baseInput({
        criteriaChecks: criteriaResult.checks,
        failedCriteria: criteriaResult.failedCriteria,
      }),
    );
    expect(result.status).toBe('PASS');
  });

  it('marks a criterion with no machine-checkable form unchecked, never passed', () => {
    const criteriaResult = evaluateAcceptanceCriteria(
      [{ id: 'AC-9', text: 'the design should remain coherent' }],
      {
        existingPaths: new Set(),
        changedPaths: [],
        addedLines: [],
        verifierResults: new Map(),
      },
    );

    expect(criteriaResult.uncheckedCriteria).toEqual(['AC-9']);
    const check = criteriaResult.checks[0];
    expect(check?.outcome).toBe('NOT_RUN');
    expect(check?.required).toBe(false);
  });
});

describe('Test D — evaluation infrastructure failure is INCONCLUSIVE, not FAIL', () => {
  it('returns INCONCLUSIVE when a required test command could not run', () => {
    const result = evaluateAttempt(
      baseInput({
        verification: {
          configured: true,
          skipped: false,
          ran: true,
          commands: [
            { name: 'typecheck', required: true, passed: true, timedOut: false },
            {
              name: 'integration-tests',
              required: true,
              passed: false,
              timedOut: false,
              unavailable: true,
              detail: 'the integration environment is unavailable',
            },
          ],
        },
      }),
    );

    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.reasons.join(' ')).toContain('was not judged wrong');
  });

  it('returns INCONCLUSIVE when a required verifier timed out', () => {
    const result = evaluateAttempt(
      baseInput({
        verification: {
          configured: true,
          skipped: false,
          ran: true,
          commands: [{ name: 'unit-tests', required: true, passed: false, timedOut: true }],
        },
      }),
    );
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('returns INCONCLUSIVE rather than PASS when nothing is configured to verify with', () => {
    const result = evaluateAttempt(
      baseInput({
        verification: { configured: false, skipped: false, ran: false, commands: [] },
      }),
    );
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('returns INCONCLUSIVE when the attempt did not terminate normally', () => {
    const result = evaluateAttempt(
      baseInput({
        integrity: {
          terminatedNormally: false,
          workerIdentityMatches: true,
          baselineValid: true,
          taskFingerprintValid: true,
          approvalsStillValid: true,
          protectedPathViolations: [],
          reportValidated: false,
          terminationDetail: 'the harness process exited before reporting',
        },
      }),
    );
    expect(result.status).toBe('INCONCLUSIVE');
  });
});

describe('execution integrity gates everything above it', () => {
  it('FAILs on a protected-path modification whatever the verifiers say', () => {
    const result = evaluateAttempt(
      baseInput({
        integrity: {
          terminatedNormally: true,
          workerIdentityMatches: true,
          baselineValid: true,
          taskFingerprintValid: true,
          approvalsStillValid: true,
          protectedPathViolations: ['.specbridge/config.json'],
          reportValidated: true,
        },
      }),
    );
    expect(result.status).toBe('FAIL');
    expect(
      result.deterministicChecks.find((check) => check.name === 'protected-paths')?.outcome,
    ).toBe('FAILED');
  });

  it('FAILs when the attempt ran on a worker other than the assigned one', () => {
    const result = evaluateAttempt(
      baseInput({
        integrity: {
          terminatedNormally: true,
          workerIdentityMatches: false,
          baselineValid: true,
          taskFingerprintValid: true,
          approvalsStillValid: true,
          protectedPathViolations: [],
          reportValidated: true,
        },
      }),
    );
    expect(result.status).toBe('FAIL');
  });

  it('orders the recorded checks deterministically, level 0 first', () => {
    const result = evaluateAttempt(baseInput());
    const levels = result.deterministicChecks.map((check) => check.level);
    expect(levels[0]).toBe('EXECUTION_INTEGRITY');
    expect(levels).toContain('REPOSITORY_INTEGRITY');
    expect(levels.indexOf('REPOSITORY_INTEGRITY')).toBeLessThan(levels.lastIndexOf('TESTS'));
  });
});
