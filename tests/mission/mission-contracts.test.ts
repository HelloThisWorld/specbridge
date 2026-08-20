import { describe, expect, it } from 'vitest';
import {
  createContractChangeRequest,
  decideContractChangeRequest,
  isMissionError,
  readAdrs,
  readCcr,
  readConstitution,
  readContract,
  readContractRegistry,
  readContractRevisions,
  readDecisions,
  recordAssessment,
  recordTurn,
  storeAdr,
} from '@specbridge/mission';
import { coveredMission, setupMissionFixture, startedMission } from '../helpers-mission.js';

function confirmedDecision(fixture: ReturnType<typeof setupMissionFixture>, missionId: string): string {
  const turn = recordTurn(fixture.deps, missionId, {
    speaker: 'user',
    kind: 'confirmation',
    text: 'Confirmed: broker semantics stay behind the transport SPI.',
  });
  const assessed = recordAssessment(fixture.deps, missionId, {
    decisions: [
      {
        decision: 'Broker-specific semantics cannot leak into the canonical runtime model.',
        provenance: 'known-from-user',
        sourceTurnId: turn.turn.turnId,
        topics: ['architecture-ownership'],
      },
    ],
  });
  return assessed.decisionIds[0]!;
}

describe('architecture constitution', () => {
  it('records rules with stable ids, versions the constitution, and supersedes in-file', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const decisionId = confirmedDecision(fixture, missionId);

    const first = recordAssessment(fixture.deps, missionId, {
      constitutionRules: [
        { statement: 'Workflow definition is the sole authority for control flow.', decisionIds: [decisionId] },
        { statement: 'Duplicate external results must be safe.', decisionIds: [decisionId] },
      ],
    });
    expect(first.constitutionRuleIds).toEqual(['CON-001', 'CON-002']);
    const v2 = readConstitution(fixture.workspace, missionId);
    expect(v2?.version).toBe(2);

    const superseding = recordAssessment(fixture.deps, missionId, {
      constitutionRules: [
        {
          statement: 'Duplicate AND late external results must be safe.',
          decisionIds: [decisionId],
          supersedesRuleId: 'CON-002',
        },
      ],
    });
    expect(superseding.constitutionRuleIds).toEqual(['CON-003']);
    const constitution = readConstitution(fixture.workspace, missionId);
    const old = constitution?.rules.find((rule) => rule.ruleId === 'CON-002');
    const replacement = constitution?.rules.find((rule) => rule.ruleId === 'CON-003');
    expect(old?.status).toBe('superseded');
    expect(replacement?.supersedes).toBe('CON-002');
    // History stays in the file: superseded rules are never deleted.
    expect(constitution?.rules).toHaveLength(3);
  });

  it('refuses invalid guard patterns', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const decisionId = confirmedDecision(fixture, missionId);
    expect(() =>
      recordAssessment(fixture.deps, missionId, {
        constitutionRules: [
          { statement: 'A rule.', decisionIds: [decisionId], guardPatterns: ['[unclosed'] },
        ],
      }),
    ).toThrow(/not a valid regular expression/);
  });
});

describe('ADRs', () => {
  it('are immutable files whose supersession is derived, never rewritten', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const decisionId = confirmedDecision(fixture, missionId);

    const first = recordAssessment(fixture.deps, missionId, {
      adrs: [
        {
          title: 'Definition-version binding',
          context: 'Running executions may outlive a definition update.',
          decision: 'An execution binds to the definition version it started with.',
          rationale: 'Deterministic replay and no mid-flight semantic changes.',
          decisionIds: [decisionId],
        },
      ],
    });
    expect(first.adrIds).toEqual(['ADR-0001']);

    const second = recordAssessment(fixture.deps, missionId, {
      adrs: [
        {
          title: 'Definition-version binding, revised',
          context: 'Operators asked for opt-in migration of long-running executions.',
          decision: 'Executions bind to their start version; explicit migration is a separate operation.',
          rationale: 'Keeps the default deterministic while allowing operated migration.',
          decisionIds: [decisionId],
          supersedesAdrId: 'ADR-0001',
        },
      ],
    });
    expect(second.adrIds).toEqual(['ADR-0002']);

    const adrs = readAdrs(fixture.workspace, missionId);
    expect(adrs.find((adr) => adr.adrId === 'ADR-0001')?.status).toBe('superseded');
    expect(adrs.find((adr) => adr.adrId === 'ADR-0002')?.status).toBe('accepted');

    // The file itself is immutable: writing the same id again is refused.
    expect(() =>
      storeAdr(fixture.workspace, missionId, {
        ...adrs.find((adr) => adr.adrId === 'ADR-0001')!,
        status: 'accepted',
      }),
    ).toThrow(/immutable/);
  });

  it('require provenance', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    expect(() =>
      recordAssessment(fixture.deps, missionId, {
        adrs: [
          {
            title: 'Ghost ADR',
            context: 'No provenance.',
            decision: 'Something.',
            rationale: 'None.',
          },
        ],
      }),
    ).toThrow(/at least one decision or conversation turn/);
  });
});

describe('contract registry', () => {
  it('stores immutable revisions and folds the registry to the highest revision', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const registry = readContractRegistry(fixture.workspace, covered.missionId);
    expect(registry).toHaveLength(1);
    expect(registry[0]?.contractId).toBe('CTR-001');
    expect(registry[0]?.revision).toBe(1);
    expect(registry[0]?.requirements[0]?.requirementId).toBe('R1');
    expect(registry[0]?.invariants[0]?.invariantId).toBe('I1');
  });
});

describe('contract change requests', () => {
  it('a request against a public additive-only contract lands NEEDS_HUMAN', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const created = createContractChangeRequest(fixture.deps, covered.missionId, {
      contractId: covered.contractId,
      problem: 'The current contract cannot represent negative acknowledgement.',
      proposal: 'Add nack(message, requeuePolicy) to the transport SPI.',
      affected: ['runtime', 'kafka adapter', 'rabbitmq adapter', 'tests', 'sdk'],
      raisedBy: 'worker-builder-wu-2',
      originJobId: 'job-000001',
      originWorkUnitId: 'wu-2',
    });
    expect(created.ccr.ccrId).toBe('CCR-001');
    expect(created.ccr.status).toBe('NEEDS_HUMAN');
    expect(created.material).toBe(true);
  });

  it('rejection records the decision and changes nothing else', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const created = createContractChangeRequest(fixture.deps, covered.missionId, {
      contractId: covered.contractId,
      problem: 'Missing nack semantics in the contract.',
      proposal: 'Add nack.',
      raisedBy: 'cli',
    });
    const decided = decideContractChangeRequest(fixture.deps, covered.missionId, {
      ccrId: created.ccr.ccrId,
      decision: 'rejected',
      note: 'Requeue-by-timeout is the chosen model.',
    });
    expect(decided.ccr.status).toBe('REJECTED');
    expect(decided.contract).toBeUndefined();
    expect(readContractRevisions(fixture.workspace, covered.missionId)).toHaveLength(1);
  });

  it('approval creates the next immutable revision with lineage and a provenance decision', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const created = createContractChangeRequest(fixture.deps, covered.missionId, {
      contractId: covered.contractId,
      problem: 'The contract cannot represent negative acknowledgement.',
      proposal: 'A transport must support nack(message, requeuePolicy).',
      raisedBy: 'worker-builder-wu-2',
    });
    const decided = decideContractChangeRequest(fixture.deps, covered.missionId, {
      ccrId: created.ccr.ccrId,
      decision: 'approved',
      note: 'Needed for RabbitMQ parity.',
    });
    expect(decided.ccr.status).toBe('APPROVED');
    expect(decided.ccr.resultingRevision).toBe(2);
    expect(decided.contract?.revision).toBe(2);
    expect(decided.contract?.supersedesRevision).toBe(1);
    expect(decided.contract?.changeRequestId).toBe(created.ccr.ccrId);
    // The proposal landed as an appended requirement with decision provenance.
    const appended = decided.contract?.requirements.at(-1);
    expect(appended?.statement).toMatch(/nack/);
    expect(appended?.decisionIds.length).toBeGreaterThan(0);
    const decision = readDecisions(fixture.workspace, covered.missionId).find(
      (candidate) => candidate.decisionId === appended?.decisionIds[0],
    );
    expect(decision?.decision).toMatch(/CCR-001/);

    // Both revisions remain readable; the registry view is the new one.
    expect(readContractRevisions(fixture.workspace, covered.missionId)).toHaveLength(2);
    expect(readContract(fixture.workspace, covered.missionId, covered.contractId)?.revision).toBe(2);
    expect(readContract(fixture.workspace, covered.missionId, covered.contractId, 1)?.revision).toBe(1);
  });

  it('a decided request cannot be decided again', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const created = createContractChangeRequest(fixture.deps, covered.missionId, {
      contractId: covered.contractId,
      problem: 'Problem.',
      proposal: 'Proposal.',
      raisedBy: 'cli',
    });
    decideContractChangeRequest(fixture.deps, covered.missionId, {
      ccrId: created.ccr.ccrId,
      decision: 'rejected',
    });
    try {
      decideContractChangeRequest(fixture.deps, covered.missionId, {
        ccrId: created.ccr.ccrId,
        decision: 'approved',
      });
      expect.unreachable('a decided CCR is final');
    } catch (error) {
      if (!isMissionError(error)) throw error;
      expect(error.code).toBe('SBM013');
    }
    expect(readCcr(fixture.workspace, covered.missionId, created.ccr.ccrId)?.status).toBe('REJECTED');
  });

  it('a request against an unknown contract is refused', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    expect(() =>
      createContractChangeRequest(fixture.deps, covered.missionId, {
        contractId: 'CTR-999',
        problem: 'Problem.',
        proposal: 'Proposal.',
        raisedBy: 'cli',
      }),
    ).toThrow(/does not exist/);
  });
});
