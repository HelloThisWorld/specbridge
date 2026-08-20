import { describe, expect, it } from 'vitest';
import type { ProductContract } from '@specbridge/mission';
import type { WorkUnit } from '@specbridge/orchestration';
import {
  buildContextProjection,
  contractSnapshotHashOf,
  evaluateProjectionFreshness,
} from '@specbridge/orchestration';

function contract(id: string, revision = 1): ProductContract {
  return {
    schemaVersion: '1.0.0',
    contractId: id,
    revision,
    title: `Contract ${id}`,
    summary: `What ${id} promises.`,
    classification: 'public',
    compatibilityPolicy: 'additive-only',
    dependsOn: [],
    requirements: [
      { requirementId: 'R1', statement: `${id} requirement one.`, decisionIds: [] },
    ],
    invariants: [],
    affectedObjectiveIds: [],
    status: 'active',
    decisionIds: ['DEC-001'],
    turnIds: [],
    recordedAt: '2026-08-10T09:00:00.000Z',
  };
}

function workUnit(partial: Partial<WorkUnit> = {}): WorkUnit {
  return {
    workUnitId: 'wu-1',
    objectiveNodeId: 'n-1',
    parentTaskId: '1',
    kind: 'build',
    title: 'Canonical message envelope',
    goal: 'Implement the canonical message envelope.',
    dependsOn: [],
    expectedArtifacts: [],
    relevantContractIds: ['CTR-002'],
    relevantAdrIds: [],
    relevantConstitutionRuleIds: [],
    expectedAreas: ['src/envelope'],
    status: 'READY',
    attempt: 0,
    evaluationRefs: [],
    ...partial,
  };
}

function build(units: Partial<WorkUnit>, contracts: ProductContract[], excerpts: string[] = []) {
  return buildContextProjection({
    jobId: 'job-1',
    objectiveNodeId: 'n-1',
    objective: { taskId: '1', title: 'Event-driven execution', acceptance: ['dispatch works'] },
    workUnit: workUnit(units),
    attempt: 1,
    source: {
      missionId: 'm-1',
      constitutionVersion: 3,
      constitutionRules: [
        {
          ruleId: 'CON-002',
          version: 1,
          statement: 'Actions never determine workflow transitions.',
          status: 'active',
          decisionIds: ['DEC-001'],
          turnIds: [],
          affectedContractIds: [],
          recordedAt: '2026-08-10T09:00:00.000Z',
          guardPatterns: [],
        },
      ],
      contracts,
      adrs: [],
      decisions: [
        {
          decisionId: 'DEC-001',
          decision: 'The workflow definition owns control flow.',
          provenance: 'known-from-user',
          topics: [],
          marksNotApplicable: [],
          status: 'active',
          resultingArtifactIds: [],
          decidedAt: '2026-08-10T09:00:00.000Z',
        },
      ],
    },
    specExcerpts: excerpts,
    createdAt: '2026-08-10T10:00:00.000Z',
    maxProjectionChars: 60_000,
  });
}

describe('the ContextProjector', () => {
  it('is deterministic: identical inputs produce identical content hashes', () => {
    const contracts = [contract('CTR-002'), contract('CTR-004')];
    const first = build({}, contracts);
    const second = build({}, contracts);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contractSnapshotHash).toBe(second.contractSnapshotHash);
  });

  it('projects only declared-relevant contracts — share truth, not context', () => {
    const projection = build({}, [contract('CTR-002'), contract('CTR-004'), contract('CTR-005')]);
    expect(projection.contracts.map((entry) => entry.contractId)).toEqual(['CTR-002']);
    // The constitution travels whole (it is binding for every worker).
    expect(projection.constitution.rules.map((rule) => rule.ruleId)).toEqual(['CON-002']);
    // Decisions arrive only through the relevant contracts' provenance.
    expect(projection.decisions.map((decision) => decision.decisionId)).toEqual(['DEC-001']);
  });

  it('carries no conversation, transcript, or reasoning fields', () => {
    const serialized = JSON.stringify(build({}, [contract('CTR-002')]));
    for (const forbidden of ['transcript', 'chatHistory', 'conversation', 'reasoning', 'chainOfThought']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('bounds the whole document by trimming spec excerpts, never truth', () => {
    const huge = 'x'.repeat(19_000);
    const projection = buildContextProjection({
      jobId: 'job-1',
      objectiveNodeId: 'n-1',
      objective: { taskId: '1', title: 'Objective', acceptance: [] },
      workUnit: workUnit({}),
      attempt: 1,
      source: {
        constitutionVersion: 0,
        constitutionRules: [],
        contracts: [contract('CTR-002')],
        adrs: [],
        decisions: [],
      },
      specExcerpts: [huge, huge, huge],
      createdAt: '2026-08-10T10:00:00.000Z',
      maxProjectionChars: 25_000,
    });
    expect(projection.specExcerpts.length).toBeLessThan(3);
    expect(projection.contracts).toHaveLength(1);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(30_000);
  });

  it('the contract snapshot hash moves with any revision bump', () => {
    const before = contractSnapshotHashOf([{ contractId: 'CTR-002', revision: 1 }], 3);
    const revised = contractSnapshotHashOf([{ contractId: 'CTR-002', revision: 2 }], 3);
    const constitutionBump = contractSnapshotHashOf([{ contractId: 'CTR-002', revision: 1 }], 4);
    expect(before).not.toBe(revised);
    expect(before).not.toBe(constitutionBump);
  });
});

describe('projection staleness', () => {
  it('a projection is fresh while the registry it saw is the registry that exists', () => {
    const projection = build({}, [contract('CTR-002')]);
    const freshness = evaluateProjectionFreshness(projection, {
      contracts: [{ contractId: 'CTR-002', revision: 1 }],
      constitutionVersion: 3,
    });
    expect(freshness.fresh).toBe(true);
  });

  it('a contract revision makes affected projections stale with named reasons', () => {
    const projection = build({}, [contract('CTR-002')]);
    const freshness = evaluateProjectionFreshness(projection, {
      contracts: [{ contractId: 'CTR-002', revision: 2 }],
      constitutionVersion: 3,
    });
    expect(freshness.fresh).toBe(false);
    expect(freshness.reasons.join(' ')).toMatch(/CTR-002 moved from revision 1 to 2/);
  });

  it('a constitution change alone makes projections stale', () => {
    const projection = build({}, [contract('CTR-002')]);
    const freshness = evaluateProjectionFreshness(projection, {
      contracts: [{ contractId: 'CTR-002', revision: 1 }],
      constitutionVersion: 4,
    });
    expect(freshness.fresh).toBe(false);
  });
});
