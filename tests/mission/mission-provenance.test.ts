import { describe, expect, it } from 'vitest';
import {
  isMissionError,
  readConstitution,
  readContract,
  readDecisions,
  readFacts,
  readMissionEvents,
  readTurns,
  recordAssessment,
  recordTurn,
  requireMissionState,
} from '@specbridge/mission';
import { setupMissionFixture, startedMission } from '../helpers-mission.js';

describe('conversation provenance', () => {
  it('persists user-visible turns verbatim, bounded, with lineage refs', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const question = recordTurn(fixture.deps, missionId, {
      speaker: 'agent',
      kind: 'question',
      text: 'Should the engine bind executions to a definition version?',
    });
    const answer = recordTurn(fixture.deps, missionId, {
      speaker: 'user',
      kind: 'confirmation',
      text: 'Yes — an execution binds to the definition version it started with.',
      inReplyTo: question.turn.turnId,
    });
    const page = readTurns(fixture.workspace, missionId, { limit: 10 });
    expect(page.turns.map((turn) => turn.turnId)).toEqual(['t-1', 't-2', 't-3']);
    expect(page.turns[2]?.inReplyTo).toBe(question.turn.turnId);
    expect(answer.turn.speaker).toBe('user');
  });

  it('refuses a turn replying to a turn that does not exist', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    expect(() =>
      recordTurn(fixture.deps, missionId, {
        speaker: 'user',
        kind: 'confirmation',
        text: 'Confirmed.',
        inReplyTo: 't-999',
      }),
    ).toThrow(/does not exist/);
  });
});

describe('decision provenance governance', () => {
  it('refuses a decision on inferred, unknown, or conflicting provenance', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    for (const provenance of ['inferred', 'unknown', 'conflicting'] as const) {
      try {
        recordAssessment(fixture.deps, missionId, {
          decisions: [{ decision: 'Topic-per-action is probably intended.', provenance }],
        });
        expect.unreachable('unsafe provenance cannot carry a decision');
      } catch (error) {
        if (!isMissionError(error)) throw error;
        expect(error.code).toBe('SBM007');
      }
    }
  });

  it('a known-from-user decision must reference a USER turn — an agent turn is refused', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const agentTurn = recordTurn(fixture.deps, missionId, {
      speaker: 'agent',
      kind: 'interpretation',
      text: 'I believe the user wants at-least-once delivery.',
    });

    expect(() =>
      recordAssessment(fixture.deps, missionId, {
        decisions: [
          { decision: 'Delivery is at-least-once.', provenance: 'known-from-user' },
        ],
      }),
    ).toThrow(/references no conversation turn/);

    expect(() =>
      recordAssessment(fixture.deps, missionId, {
        decisions: [
          {
            decision: 'Delivery is at-least-once.',
            provenance: 'known-from-user',
            sourceTurnId: agentTurn.turn.turnId,
          },
        ],
      }),
    ).toThrow(/agent turn/);
  });

  it('a decision confirmed by a user turn records the full lineage chain', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const confirm = recordTurn(fixture.deps, missionId, {
      speaker: 'user',
      kind: 'confirmation',
      text: 'Confirmed: actions never determine workflow transitions.',
    });
    const assessed = recordAssessment(fixture.deps, missionId, {
      decisions: [
        {
          decision: 'Actions never determine workflow transitions.',
          provenance: 'known-from-user',
          sourceTurnId: confirm.turn.turnId,
          topics: ['canonical-model', 'architecture-ownership'],
        },
      ],
    });
    const decisionId = assessed.decisionIds[0]!;

    const withRule = recordAssessment(fixture.deps, missionId, {
      constitutionRules: [
        {
          statement: 'Actions never determine workflow transitions.',
          decisionIds: [decisionId],
        },
      ],
    });
    const ruleId = withRule.constitutionRuleIds[0]!;

    const withContract = recordAssessment(fixture.deps, missionId, {
      contracts: [
        {
          title: 'Action Result Protocol',
          summary: 'How completed actions report results to the engine.',
          classification: 'public',
          compatibilityPolicy: 'additive-only',
          requirements: [{ statement: 'A result carries the action id and outcome only.' }],
          invariants: [{ statement: 'A result cannot carry a next-state directive.', constitutionRuleIds: [ruleId] }],
          decisionIds: [decisionId],
        },
      ],
    });

    // Reconstruct: turn → decision → rule → contract.
    const decision = readDecisions(fixture.workspace, missionId).find((d) => d.decisionId === decisionId);
    expect(decision?.sourceTurnId).toBe(confirm.turn.turnId);
    const constitution = readConstitution(fixture.workspace, missionId);
    const rule = constitution?.rules.find((candidate) => candidate.ruleId === ruleId);
    expect(rule?.decisionIds).toContain(decisionId);
    const contract = readContract(fixture.workspace, missionId, withContract.contractIds[0]!);
    expect(contract?.decisionIds).toContain(decisionId);
    expect(contract?.invariants[0]?.constitutionRuleIds).toContain(ruleId);
  });

  it('constitution rules and contracts refuse missing or superseded decision provenance', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    expect(() =>
      recordAssessment(fixture.deps, missionId, {
        constitutionRules: [{ statement: 'A rule without provenance.', decisionIds: [] }],
      }),
    ).toThrow(/at least one recorded decision/);
    expect(() =>
      recordAssessment(fixture.deps, missionId, {
        constitutionRules: [{ statement: 'A rule citing a ghost.', decisionIds: ['DEC-999'] }],
      }),
    ).toThrow(/does not exist or is superseded/);
  });
});

describe('fact history', () => {
  it('rejects an over-capacity fact batch before writing any partial records', () => {
    const fixture = setupMissionFixture();
    const { missionId, firstTurnId } = startedMission(fixture);
    recordAssessment(fixture.deps, missionId, {
      facts: Array.from({ length: 499 }, (_, index) => ({
        statement: `Bounded fact ${index + 1}.`,
        provenance: 'known-from-user' as const,
        sourceTurnId: firstTurnId,
      })),
    });
    const factsBefore = readFacts(fixture.workspace, missionId);
    const stateBefore = requireMissionState(fixture.workspace, missionId);
    const eventsBefore = readMissionEvents(fixture.workspace, missionId, { limit: 2_000 });

    expect(() =>
      recordAssessment(fixture.deps, missionId, {
        facts: [
          { statement: 'Fact 500.', provenance: 'known-from-user', sourceTurnId: firstTurnId },
          { statement: 'Fact 501.', provenance: 'known-from-user', sourceTurnId: firstTurnId },
        ],
      }),
    ).toThrow(/would exceed.*500-fact bound/i);

    expect(readFacts(fixture.workspace, missionId)).toEqual(factsBefore);
    expect(requireMissionState(fixture.workspace, missionId)).toEqual(stateBefore);
    expect(readMissionEvents(fixture.workspace, missionId, { limit: 2_000 })).toEqual(
      eventsBefore,
    );
  });

  it('supersession appends; the current view folds; history is preserved', () => {
    const fixture = setupMissionFixture();
    const { missionId, firstTurnId } = startedMission(fixture);
    const first = recordAssessment(fixture.deps, missionId, {
      facts: [
        {
          statement: 'The engine targets Kafka only.',
          provenance: 'known-from-user',
          sourceTurnId: firstTurnId,
          topics: ['system-boundaries'],
        },
      ],
    });
    const factId = first.factIds[0]!;
    const corrected = recordAssessment(fixture.deps, missionId, {
      facts: [
        {
          statement: 'The engine is broker-neutral; Kafka is only the first adapter.',
          provenance: 'known-from-user',
          sourceTurnId: firstTurnId,
          topics: ['system-boundaries'],
          supersedesFactId: factId,
        },
      ],
    });
    const facts = readFacts(fixture.workspace, missionId);
    const old = facts.find((fact) => fact.factId === factId);
    const replacement = facts.find((fact) => fact.factId === corrected.factIds[0]);
    expect(old?.status).toBe('superseded');
    expect(replacement?.status).toBe('active');
    expect(replacement?.supersedes).toBe(factId);
  });
});

describe('no hidden reasoning is persisted', () => {
  it('mission records carry no chain-of-thought-shaped fields', () => {
    const fixture = setupMissionFixture();
    const { missionId, firstTurnId } = startedMission(fixture);
    recordAssessment(fixture.deps, missionId, {
      facts: [{ statement: 'A fact.', provenance: 'known-from-user', sourceTurnId: firstTurnId }],
      questions: [{ question: 'A question about the public api surface?', whyItMatters: 'It is irreversible.' }],
    });
    const everything = JSON.stringify({
      facts: readFacts(fixture.workspace, missionId),
      turns: readTurns(fixture.workspace, missionId, { limit: 100 }),
      decisions: readDecisions(fixture.workspace, missionId),
    });
    for (const forbidden of ['chainOfThought', 'reasoningTrace', 'transcript', 'promptText', 'deliberation']) {
      expect(everything).not.toContain(forbidden);
    }
  });
});
