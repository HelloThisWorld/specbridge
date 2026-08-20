import { describe, expect, it } from 'vitest';
import {
  MISSION_STATUSES,
  abandonMission,
  allowedMissionTransitions,
  answerQuestion,
  assertMissionTransition,
  beginMission,
  canMissionTransition,
  listMissions,
  markContractReady,
  recordAssessment,
  recordTurn,
  requireMissionState,
  readMissionEvents,
} from '@specbridge/mission';
import { coveredMission, setupMissionFixture, startedMission } from '../helpers-mission.js';

describe('mission state machine', () => {
  it('refuses every transition not in the table', () => {
    for (const from of MISSION_STATUSES) {
      for (const to of MISSION_STATUSES) {
        const allowed = allowedMissionTransitions(from).includes(to);
        expect(canMissionTransition(from, to)).toBe(allowed);
        if (!allowed) {
          expect(() => assertMissionTransition(from, to)).toThrow();
        }
      }
    }
  });

  it('ABANDONED is final and has no outgoing transitions', () => {
    expect(allowedMissionTransitions('ABANDONED')).toEqual([]);
  });

  it('CONTRACT_READY is not reachable from IDEA directly', () => {
    expect(canMissionTransition('IDEA', 'CONTRACT_READY')).toBe(false);
  });
});

describe('mission lifecycle', () => {
  it('begins in IDEA and opens discovery on the first turn', () => {
    const fixture = setupMissionFixture();
    const mission = beginMission(fixture.deps, { name: 'steprelay', goal: 'Build StepRelay.' });
    expect(mission.status).toBe('IDEA');
    expect(mission.missionId).toMatch(/^m-/);

    const { mission: after } = recordTurn(fixture.deps, mission.missionId, {
      speaker: 'user',
      kind: 'statement',
      text: 'Build StepRelay: a lightweight workflow engine.',
    });
    expect(after.status).toBe('DISCOVERING');
    expect(after.counters.turns).toBe(1);
  });

  it('a blocking question moves discovery to NEEDS_DECISION; answering it moves back', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const asked = recordAssessment(fixture.deps, missionId, {
      questions: [
        {
          question: 'May an action decide the next workflow state, or does the definition own control flow?',
          whyItMatters: 'It fixes the canonical model and the public API of every action.',
          topics: ['canonical-model'],
          affectedSurfaces: ['cross-module-architecture'],
        },
      ],
    });
    expect(asked.mission.status).toBe('NEEDS_DECISION');
    expect(asked.coverage.blockingQuestionIds).toContain(asked.questionIds[0]);

    const { mission } = answerQuestion(fixture.deps, missionId, {
      questionId: asked.questionIds[0]!,
      answer: 'The workflow definition owns control flow; actions never decide transitions.',
    });
    expect(mission.status).toBe('DISCOVERING');
    expect(mission.counters.openQuestions).toBe(0);
  });

  it('markContractReady enforces the coverage gate and is idempotent once it holds', () => {
    const bare = setupMissionFixture();
    const { missionId: uncovered } = startedMission(bare);
    expect(() => markContractReady(bare.deps, uncovered)).toThrow(/CONTRACT_READY/);

    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const first = markContractReady(fixture.deps, covered.missionId);
    expect(first.mission.status).toBe('CONTRACT_READY');
    expect(first.coverage.contractReady).toBe(true);
    // Idempotent repeat: no second transition, same status.
    const again = markContractReady(fixture.deps, covered.missionId);
    expect(again.mission.status).toBe('CONTRACT_READY');
  });

  it('abandon is final, idempotent, and blocks every later operation', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const abandoned = abandonMission(fixture.deps, missionId, 'direction changed');
    expect(abandoned.status).toBe('ABANDONED');
    expect(abandoned.abandonReason).toBe('direction changed');

    // Idempotent repeat.
    expect(abandonMission(fixture.deps, missionId, 'again').status).toBe('ABANDONED');

    // Read-only afterwards.
    expect(() =>
      recordTurn(fixture.deps, missionId, { speaker: 'user', kind: 'statement', text: 'more' }),
    ).toThrow(/read-only/);
    expect(() => recordAssessment(fixture.deps, missionId, { facts: [] })).toThrow(/read-only|ABANDONED/);
  });

  it('lists missions newest first and records events append-only', () => {
    const fixture = setupMissionFixture();
    const a = beginMission(fixture.deps, { name: 'alpha', goal: 'First.' });
    const b = beginMission(fixture.deps, { name: 'beta', goal: 'Second.' });
    const listed = listMissions(fixture.workspace);
    expect(listed.missions.map((mission) => mission.missionId)).toEqual([b.missionId, a.missionId]);

    const events = readMissionEvents(fixture.workspace, a.missionId, { limit: 10 });
    expect(events.events.map((event) => event.type)).toContain('mission_created');
    const state = requireMissionState(fixture.workspace, a.missionId);
    expect(state.counters.events).toBeGreaterThan(0);
  });
});
