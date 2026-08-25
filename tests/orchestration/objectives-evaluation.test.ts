import { describe, expect, it } from 'vitest';
import type { ProductContract } from '@specbridge/mission';
import type { CandidateArtifact, ContextProjection, WorkUnit } from '@specbridge/orchestration';
import {
  buildContextProjection,
  evaluateDeterministically,
  screenGuardPatterns,
  semanticEvaluationRequired,
  validateObjectiveOutput,
} from '@specbridge/orchestration';

/**
 * The deterministic evaluation layer — including the StepRelay conflict
 * scenario: a worker proposing `nextState` inside `ActionResult` must be
 * detected as a CONTRACT CONFLICT without any model involved.
 */

const ACTION_RESULT_CONTRACT: ProductContract = {
  schemaVersion: '1.0.0',
  contractId: 'CTR-003',
  revision: 1,
  title: 'Action Result Protocol',
  summary: 'How completed actions report results to the engine.',
  classification: 'public',
  compatibilityPolicy: 'additive-only',
  dependsOn: [],
  requirements: [
    { requirementId: 'R1', statement: 'A result carries the action id and outcome only.', decisionIds: [] },
  ],
  invariants: [
    {
      invariantId: 'I1',
      statement: 'Actions never determine workflow transitions.',
      constitutionRuleIds: ['CON-002'],
      guardPatterns: ['nextState\\s*[:=]'],
    },
  ],
  affectedObjectiveIds: [],
  status: 'active',
  decisionIds: ['DEC-001'],
  turnIds: [],
  recordedAt: '2026-08-10T09:00:00.000Z',
};

const UNIT: WorkUnit = {
  workUnitId: 'wu-1',
  objectiveNodeId: 'n-1',
  parentTaskId: '1',
  kind: 'build',
  title: 'Action result protocol',
  goal: 'Implement the action result protocol.',
  dependsOn: [],
  expectedArtifacts: [],
  relevantContractIds: ['CTR-003'],
  relevantAdrIds: [],
  relevantConstitutionRuleIds: [],
  expectedAreas: ['src/protocol'],
  status: 'CANDIDATE_READY',
  attempt: 1,
  evaluationRefs: [],
};

function projection(): ContextProjection {
  return buildContextProjection({
    jobId: 'job-1',
    objectiveNodeId: 'n-1',
    objective: { taskId: '1', title: 'Event-driven execution', acceptance: [] },
    workUnit: UNIT,
    attempt: 1,
    source: {
      constitutionVersion: 1,
      constitutionRules: [],
      contracts: [ACTION_RESULT_CONTRACT],
      adrs: [],
      decisions: [],
    },
    createdAt: '2026-08-10T10:00:00.000Z',
    maxProjectionChars: 60_000,
  });
}

function candidate(
  proj: ContextProjection,
  partial: Partial<CandidateArtifact> = {},
): CandidateArtifact {
  return {
    schemaVersion: '1.0.0',
    candidateId: 'wu-1-a01',
    jobId: 'job-1',
    objectiveNodeId: 'n-1',
    workUnitId: 'wu-1',
    attempt: 1,
    workerId: 'builder-wu-1-a1',
    createdAt: '2026-08-10T10:10:00.000Z',
    baselineCommit: 'abc123',
    contextProjectionHash: proj.contentHash,
    contractSnapshotHash: proj.contractSnapshotHash,
    changedFiles: [{ path: 'src/protocol/result.ts', changeType: 'added' }],
    patchRef: 'candidates/wu-1-a01.patch',
    localVerification: { ran: true, passed: true, commands: [{ name: 'test', status: 'ok', exitCode: 0 }] },
    claims: {
      summary: 'Implemented the action result protocol.',
      assumptionsDiscovered: [],
      contractChangeRequests: [],
      knownLimitations: [],
    },
    ...partial,
  };
}

const CLEAN_PATCH = [
  'diff --git a/src/protocol/result.ts b/src/protocol/result.ts',
  '+export interface ActionResult {',
  '+  actionId: string;',
  "+  outcome: 'completed' | 'failed';",
  '+}',
].join('\n');

const CONFLICTING_PATCH = [
  'diff --git a/src/protocol/result.ts b/src/protocol/result.ts',
  '+export interface ActionResult {',
  '+  actionId: string;',
  '+  nextState: string; // the action decides where the workflow goes next',
  '+}',
].join('\n');

function evaluate(patch: string, overrides: Parameters<typeof candidate>[1] = {}) {
  const proj = projection();
  return evaluateDeterministically({
    candidate: candidate(proj, overrides),
    workUnit: UNIT,
    projection: proj,
    contracts: [ACTION_RESULT_CONTRACT],
    constitutionRules: [],
    constitutionVersion: 1,
    protectedViolations: [],
    patch,
    createdAt: '2026-08-10T10:11:00.000Z',
    evaluationId: 'wu-1-a01-e01',
  });
}

describe('guard-pattern screening (the nextState scenario)', () => {
  it('detects nextState inside ActionResult as a structural violation', () => {
    const hits = screenGuardPatterns(CONFLICTING_PATCH, [ACTION_RESULT_CONTRACT], []);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe('CTR-003/I1');
    expect(hits[0]?.contractId).toBe('CTR-003');
    expect(hits[0]?.line).toMatch(/nextState/);
  });

  it('a clean candidate produces no hits', () => {
    expect(screenGuardPatterns(CLEAN_PATCH, [ACTION_RESULT_CONTRACT], [])).toEqual([]);
  });

  it('only ADDED lines are screened — pre-existing occurrences do not trigger', () => {
    const removal = ['diff --git a/x b/x', '-  nextState: string;', '+  outcome: string;'].join('\n');
    expect(screenGuardPatterns(removal, [ACTION_RESULT_CONTRACT], [])).toEqual([]);
  });
});

describe('deterministic evaluation', () => {
  it('passes a clean, verified, in-scope candidate', () => {
    const record = evaluate(CLEAN_PATCH);
    expect(record.verdict).toBe('PASS');
    expect(record.checks.every((check) => check.passed)).toBe(true);
  });

  it('returns CONFLICT with the affected contract and an authority decision kind', () => {
    const record = evaluate(CONFLICTING_PATCH);
    expect(record.verdict).toBe('CONFLICT');
    expect(record.affectedContractIds).toContain('CTR-003');
    expect(record.decisionKind).toBe('architecture-contract-change');
    expect(record.reasons.join(' ')).toMatch(/nextState/);
  });

  it('fails on failed local verification, empty changes, hash mismatches, protected paths, and off-scope changes', () => {
    const failedVerify = evaluate(CLEAN_PATCH, {
      localVerification: { ran: true, passed: false, commands: [{ name: 'test', status: 'nonzero-exit', exitCode: 1 }] },
    });
    expect(failedVerify.verdict).toBe('FAIL');
    expect(failedVerify.reasons.join(' ')).toMatch(/local verification failed/);

    const empty = evaluate(CLEAN_PATCH, { changedFiles: [] });
    expect(empty.verdict).toBe('FAIL');
    expect(empty.reasons.join(' ')).toMatch(/no changes/);

    const forged = evaluate(CLEAN_PATCH, { contextProjectionHash: 'forged' });
    expect(forged.verdict).toBe('FAIL');
    expect(forged.checks.find((check) => check.name === 'identity-binding')?.passed).toBe(false);

    const proj = projection();
    const protectedRecord = evaluateDeterministically({
      candidate: candidate(proj),
      workUnit: UNIT,
      projection: proj,
      contracts: [ACTION_RESULT_CONTRACT],
      constitutionRules: [],
      constitutionVersion: 1,
      protectedViolations: ['.kiro/specs/steprelay/tasks.md'],
      patch: CLEAN_PATCH,
      createdAt: '2026-08-10T10:11:00.000Z',
      evaluationId: 'wu-1-a01-e02',
    });
    expect(protectedRecord.verdict).toBe('FAIL');
    expect(protectedRecord.reasons.join(' ')).toMatch(/protected path/);

    const offScope = evaluate(CLEAN_PATCH, {
      changedFiles: [{ path: 'unrelated/elsewhere.ts', changeType: 'added' }],
    });
    expect(offScope.verdict).toBe('FAIL');
    expect(offScope.reasons.join(' ')).toMatch(/outside the declared expected areas/);
  });

  it('a stale projection (contract revised mid-flight) fails deterministically', () => {
    const proj = projection();
    const record = evaluateDeterministically({
      candidate: candidate(proj),
      workUnit: UNIT,
      projection: proj,
      contracts: [{ ...ACTION_RESULT_CONTRACT, revision: 2 }],
      constitutionRules: [],
      constitutionVersion: 1,
      protectedViolations: [],
      patch: CLEAN_PATCH,
      createdAt: '2026-08-10T10:11:00.000Z',
      evaluationId: 'wu-1-a01-e03',
    });
    expect(record.verdict).toBe('FAIL');
    expect(record.checks.find((check) => check.name === 'projection-freshness')?.passed).toBe(false);
    expect(record.reasons.join(' ')).toMatch(/stale context/);
  });
});

describe('semantic evaluation policy', () => {
  const proj = projection();
  const clean = candidate(proj);
  const passRecord = evaluate(CLEAN_PATCH);

  it('disabled: never; always: every candidate', () => {
    expect(semanticEvaluationRequired('disabled', UNIT, clean, passRecord)).toBe(false);
    expect(semanticEvaluationRequired('always', UNIT, clean, passRecord)).toBe(true);
  });

  it('auto: investigations always; build units only when the candidate declares judgment calls', () => {
    expect(semanticEvaluationRequired('auto', { ...UNIT, kind: 'investigation' }, clean, passRecord)).toBe(true);
    expect(semanticEvaluationRequired('auto', UNIT, clean, passRecord)).toBe(false);
    const withAssumptions = candidate(proj, {
      claims: { ...clean.claims, assumptionsDiscovered: ['assumed at-least-once delivery'] },
    });
    expect(semanticEvaluationRequired('auto', UNIT, withAssumptions, passRecord)).toBe(true);
  });

  it('a deterministic CONFLICT is already an authority question — no semantic pass on top', () => {
    const conflictRecord = evaluate(CONFLICTING_PATCH);
    expect(semanticEvaluationRequired('always', UNIT, clean, conflictRecord)).toBe(false);
  });
});

describe('objective agent output contracts', () => {
  it('validates complete responses only — no substring mining, no silent repair', () => {
    expect(validateObjectiveOutput('EVALUATOR', 'Sure! {"verdict":"PASS"}').ok).toBe(false);
    expect(validateObjectiveOutput('EVALUATOR', '{"verdict":"PASS"}').ok).toBe(true);
    expect(validateObjectiveOutput('EVALUATOR', '{"verdict":"MAYBE"}').ok).toBe(false);
  });

  it('worker outputs cannot smuggle authority: unknown fields are ignored, never honored', () => {
    const smuggled = validateObjectiveOutput(
      'BUILDER',
      JSON.stringify({
        outcome: 'CANDIDATE_COMPLETE',
        summary: 'done',
        approveMyOwnWork: true,
        disableVerification: true,
        commandsToRun: ['rm -rf /'],
      }),
    );
    expect(smuggled.ok).toBe(true);
    if (smuggled.ok) {
      const keys = Object.keys(smuggled.output);
      expect(keys).not.toContain('approveMyOwnWork');
      expect(keys).not.toContain('disableVerification');
      expect(keys).not.toContain('commandsToRun');
    }
  });
});


describe('the scope check compares paths, not the prose an area was written in', () => {
  /** Evaluate one candidate against areas written the way models write them. */
  function evaluateWithAreas(areas: string[], changed: string[]) {
    const proj = projection();
    return evaluateDeterministically({
      candidate: {
        ...candidate(proj, {}),
        changedFiles: changed.map((path) => ({ path, changeType: 'modified' as const })),
      },
      workUnit: { ...UNIT, expectedAreas: areas },
      projection: proj,
      contracts: [ACTION_RESULT_CONTRACT],
      constitutionRules: [],
      constitutionVersion: 1,
      protectedViolations: [],
      patch: 'diff --git a/settings.gradle.kts b/settings.gradle.kts',
      createdAt: '2026-08-10T10:11:00.000Z',
      evaluationId: 'wu-1-a01-e01',
    });
  }

  it('accepts a candidate whose files match an area described in words', () => {
    // The DECOMPOSER contract lets an area be free text, and models use it:
    // these three are verbatim from the vNext.10.1 dogfood. Compared
    // literally, no real path can ever match them, so the check refused the
    // builder three times running on an identical verdict and forced a
    // replan — for changes that were exactly what the areas described.
    const record = evaluateWithAreas(
      [
        'settings.gradle.kts (root multi-project registration)',
        'the new demo module directory and its build.gradle.kts',
        'docs/STATUS.md (boundary statement, if status tracking applies)',
      ],
      [
        'README.md',
        'docs/STATUS.md',
        'settings.gradle.kts',
        'steprelay-demo/build.gradle.kts',
      ],
    );
    const scope = record.checks.find((check) => check.name === 'scope');
    expect(scope?.passed).toBe(true);
  });

  it('still refuses a candidate that touches nothing the areas name', () => {
    const record = evaluateWithAreas(
      ['src/protocol (the result envelope)'],
      ['docs/README.md', 'infra/terraform/main.tf'],
    );
    const scope = record.checks.find((check) => check.name === 'scope');
    expect(scope?.passed).toBe(false);
  });

  it('does not judge scope at all when no area names a path', () => {
    // A check that cannot make its comparison must not fail the work.
    const record = evaluateWithAreas(
      ['wherever the workflow engine keeps its state machine'],
      ['src/engine/machine.ts'],
    );
    const scope = record.checks.find((check) => check.name === 'scope');
    expect(scope?.passed).toBe(true);
    expect(scope?.detail).toContain('not judged');
  });
});
