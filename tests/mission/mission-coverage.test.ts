import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TOPICS,
  answerQuestion,
  assessMateriality,
  markContractReady,
  readCoverage,
  recordAssessment,
  withdrawQuestion,
} from '@specbridge/mission';
import { coveredMission, setupMissionFixture, startedMission } from '../helpers-mission.js';

describe('materiality / irreversibility analysis', () => {
  it('classifies questions touching irreversible surfaces as blocking', () => {
    const blocking = assessMateriality({
      questionText: 'What is the wire protocol message format for action requests?',
      declaredLevel: 'implementation-detail',
    });
    expect(blocking.level).toBe('blocking');
    expect(blocking.raisedFrom).toBe('implementation-detail');
    expect(blocking.surfaces).toContain('wire-protocol');
    expect(blocking.reasons.join(' ')).toMatch(/wire-protocol/);
  });

  it('leaves genuine implementation detail non-blocking', () => {
    const detail = assessMateriality({
      questionText: 'Should the internal scheduler use a heap or a sorted list?',
      whyItMatters: 'Only affects internal implementation cost.',
      declaredLevel: 'implementation-detail',
    });
    expect(detail.level).toBe('implementation-detail');
    expect(detail.surfaces).toEqual([]);
  });

  it('declared surfaces force blocking even when the text is bland', () => {
    const declared = assessMateriality({
      questionText: 'Which of the two candidate approaches should we take?',
      declaredSurfaces: ['persisted-state'],
      declaredLevel: 'material',
    });
    expect(declared.level).toBe('blocking');
    expect(declared.surfaces).toEqual(['persisted-state']);
  });

  it('never lowers a declared level', () => {
    const cautious = assessMateriality({
      questionText: 'Should logs be JSON or plain text?',
      declaredLevel: 'blocking',
    });
    expect(cautious.level).toBe('blocking');
  });
});

describe('coverage computation', () => {
  it('starts with required topics unresolved and not contract-ready', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const assessed = recordAssessment(fixture.deps, missionId, { facts: [] });
    expect(assessed.coverage.contractReady).toBe(false);
    for (const topic of REQUIRED_TOPICS) {
      expect(assessed.coverage.unresolvedRequiredTopics).toContain(topic);
    }
  });

  it('an implementation-detail question never blocks CONTRACT_READY', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const asked = recordAssessment(fixture.deps, covered.missionId, {
      questions: [
        {
          question: 'Should the internal queue drain in batches of 10 or 100?',
          whyItMatters: 'Minor throughput tuning.',
          topics: ['performance'],
          materiality: 'implementation-detail',
        },
      ],
    });
    expect(asked.coverage.blockingQuestionIds).toEqual([]);
    expect(asked.coverage.contractReady).toBe(true);
    const ready = markContractReady(fixture.deps, covered.missionId);
    expect(ready.mission.status).toBe('CONTRACT_READY');
  });

  it('a blocking question on a resolved topic re-blocks it until answered or withdrawn', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const asked = recordAssessment(fixture.deps, covered.missionId, {
      questions: [
        {
          question: 'Must duplicate action results be safe under at-least-once delivery semantics?',
          whyItMatters: 'Delivery semantics are a compatibility promise.',
          topics: ['failure-semantics'],
        },
      ],
    });
    expect(asked.coverage.contractReady).toBe(false);
    expect(asked.mission.status).toBe('NEEDS_DECISION');
    expect(() => markContractReady(fixture.deps, covered.missionId)).toThrow(/blocking/i);

    const answered = answerQuestion(fixture.deps, covered.missionId, {
      questionId: asked.questionIds[0]!,
      answer: 'Yes: duplicate results must be idempotent no-ops.',
    });
    expect(answered.coverage.contractReady).toBe(true);
    expect(answered.mission.status).toBe('DISCOVERING');
  });

  it('withdrawing the last blocking question restores readiness', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const asked = recordAssessment(fixture.deps, covered.missionId, {
      questions: [
        {
          question: 'Does the persisted state schema need to survive downgrades?',
          whyItMatters: 'Persisted state is irreversible.',
          topics: ['durability'],
        },
      ],
    });
    expect(asked.mission.status).toBe('NEEDS_DECISION');
    const after = withdrawQuestion(fixture.deps, covered.missionId, {
      questionId: asked.questionIds[0]!,
      reason: 'duplicate of Q-001',
    });
    expect(after.status).toBe('DISCOVERING');
    const coverage = readCoverage(fixture.workspace, covered.missionId);
    expect(coverage?.contractReady).toBe(true);
  });

  it('a decision can mark a required topic not applicable', () => {
    const fixture = setupMissionFixture();
    const { missionId, firstTurnId } = startedMission(fixture);
    const assessed = recordAssessment(fixture.deps, missionId, {
      decisions: [
        {
          decision: 'This library has no compatibility promise yet: pre-1.0 evolution.',
          provenance: 'known-from-user',
          sourceTurnId: firstTurnId,
          marksNotApplicable: ['compatibility'],
        },
      ],
    });
    const topic = assessed.coverage.topics.find((entry) => entry.topicId === 'compatibility');
    expect(topic?.status).toBe('not-applicable');
    expect(assessed.coverage.unresolvedRequiredTopics).not.toContain('compatibility');
  });

  it('CONTRACT_READY collapses back the moment the gate no longer holds', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    markContractReady(fixture.deps, covered.missionId);

    const asked = recordAssessment(fixture.deps, covered.missionId, {
      questions: [
        {
          question: 'Is the configuration language YAML or a purpose-built DSL?',
          whyItMatters: 'The configuration language is a public surface users write against.',
          topics: ['configuration-semantics'],
        },
      ],
    });
    expect(asked.mission.status).toBe('NEEDS_DECISION');
    expect(asked.coverage.contractReady).toBe(false);
  });
});
