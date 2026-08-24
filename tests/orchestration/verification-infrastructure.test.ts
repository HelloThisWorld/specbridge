import { describe, expect, it } from 'vitest';
import { evaluateDeterministically, isUnavailableStatus } from '@specbridge/orchestration';
import type { DeterministicEvaluationInput } from '@specbridge/orchestration';

/**
 * Regression: an unstartable verifier is not an implementation defect.
 *
 * Found by the vNext.10 StepRelay dogfood, and it is the most expensive of
 * the three defects it surfaced. The builder's candidate recorded:
 *
 *   localVerification: { ran: true, passed: false, commands: [
 *     { name: "test",  status: "spawn-failed" },
 *     { name: "check", status: "spawn-failed" } ] }
 *
 * `gradlew.bat` could not be spawned inside the builder's isolated worktree.
 * The objective evaluation folded that into a plain FAIL, the driver
 * categorised it as VERIFICATION_FAILURE, and the reliability runtime
 * correctly did what that category asks for: it repaired the implementation,
 * then replanned, then repaired again. Three cycles and roughly $12 of
 * provider-reported usage rewriting code that had never been tested.
 *
 * The task-execution path has kept these apart since v0.3 — `executor-dispatch`
 * marks a spawn-failed command `unavailable` because "a command that never
 * started proves nothing about the code". The objective path did not, and the
 * two paths now share one definition of "did not run".
 */

function input(commands: { name: string; status: string }[]): DeterministicEvaluationInput {
  return {
    evaluationId: 'ev-1',
    createdAt: '2026-08-24T01:00:00.000Z',
    workUnit: {
      workUnitId: 'wu-1',
      title: 'control surface',
      goal: 'expose the control surface',
      kind: 'build',
      status: 'CANDIDATE_READY',
      dependsOn: [],
      relevantContractIds: [],
      expectedArtifacts: [],
      expectedAreas: [],
      acceptance: [],
      attempts: [],
    },
    candidate: {
      schemaVersion: '1.0.0',
      candidateId: 'cand-1',
      jobId: 'job-1',
      objectiveNodeId: 'n-1',
      workUnitId: 'wu-1',
      attempt: 1,
      workerId: 'builder-wu-1-a1',
      createdAt: '2026-08-24T01:00:00.000Z',
      baselineCommit: 'abc123',
      contextProjectionHash: 'hash-projection',
      contractSnapshotHash: 'hash-contracts',
      changedFiles: [{ path: 'src/api/Controller.java', changeType: 'added' }],
      localVerification: {
        ran: true,
        passed: false,
        commands: commands.map((command) => ({ ...command, exitCode: null })),
      },
      claims: {
        summary: 'implemented the control surface',
        assumptionsDiscovered: [],
        contractChangeRequests: [],
        knownLimitations: [],
      },
    },
    projection: {
      contentHash: 'hash-projection',
      contractSnapshotHash: 'hash-contracts',
      createdAt: '2026-08-24T01:00:00.000Z',
      contracts: [],
    },
    contracts: [],
    constitutionRules: [],
    constitutionVersion: 1,
    protectedViolations: [],
    patch: '+++ b/src/api/Controller.java\n+class Controller {}\n',
  } as unknown as DeterministicEvaluationInput;
}

describe('unstartable verification', () => {
  it('names the statuses that mean a command never ran', () => {
    expect(isUnavailableStatus('spawn-failed')).toBe(true);
    expect(isUnavailableStatus('not-found')).toBe(true);
    expect(isUnavailableStatus('unavailable')).toBe(true);
    // A command that started and hung DID tell us something, even if little.
    expect(isUnavailableStatus('timeout')).toBe(false);
    expect(isUnavailableStatus('nonzero-exit')).toBe(false);
  });

  it('reports a spawn-failed verifier as COULD NOT RUN, not as failed', () => {
    const record = evaluateDeterministically(
      input([
        { name: 'test', status: 'spawn-failed' },
        { name: 'check', status: 'spawn-failed' },
      ]),
    );

    const check = record.checks.find((entry) => entry.name === 'local-verification');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/could not run/);
    expect(record.reasons.join(' ')).toMatch(/COULD NOT RUN/);
    // The candidate is still not accepted: nothing was proven either way.
    expect(record.verdict).toBe('FAIL');
  });

  it('reports a genuinely failing verifier as failed', () => {
    const record = evaluateDeterministically(
      input([{ name: 'test', status: 'nonzero-exit' }]),
    );
    const check = record.checks.find((entry) => entry.name === 'local-verification');
    expect(check?.detail).toMatch(/^failed:/);
    expect(record.reasons.join(' ')).toMatch(/local verification failed/);
    expect(record.reasons.join(' ')).not.toMatch(/COULD NOT RUN/);
  });

  it('a mix of unstartable and genuinely failing is a real failure', () => {
    const record = evaluateDeterministically(
      input([
        { name: 'test', status: 'spawn-failed' },
        { name: 'check', status: 'nonzero-exit' },
      ]),
    );
    // One command DID run and DID fail. That is evidence about the code.
    expect(record.reasons.join(' ')).toMatch(/local verification failed/);
    expect(record.reasons.join(' ')).not.toMatch(/COULD NOT RUN/);
  });

  it('a passing verifier is unaffected', () => {
    const passing = input([{ name: 'test', status: 'ok' }]);
    passing.candidate.localVerification.passed = true;
    const record = evaluateDeterministically(passing);
    expect(record.checks.find((entry) => entry.name === 'local-verification')?.passed).toBe(true);
  });
});
