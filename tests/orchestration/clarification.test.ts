import { describe, expect, it } from 'vitest';
import {
  assessIntent,
  effectiveDecisions,
  isOrchestrationError,
  requestClarification,
  resolveClarification,
} from '@specbridge/orchestration';
import type { OrchestrationFixture } from '../helpers-orchestration.js';
import { beginReadyRun, setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * Clarification: bounded rounds, targeted questions, durable decisions, and
 * the rule that a decision never silently amends an approved specification.
 */

function ambiguousRun(fixture: OrchestrationFixture): string {
  const run = beginReadyRun(fixture, { taskId: '1' });
  assessIntent(fixture.deps, run.orchestrationId, {
    outcome: 'NEEDS_CLARIFICATION',
    summary: 'Implement routing; the mechanism is unspecified.',
  });
  return run.orchestrationId;
}

const ROUTING_QUESTION = {
  question: 'Should action routing use one topic per action, or a shared queue with an action identifier?',
  whyItMatters: 'The two mechanisms produce different broker topology and different worker code.',
  options: ['topic-per-action', 'shared queue + action id'],
};

describe('clarification rounds', () => {
  it('records a targeted question and holds the run in NEEDS_CLARIFICATION', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);

    const state = requestClarification(fixture.deps, id, [ROUTING_QUESTION]);
    expect(state.phase).toBe('NEEDS_CLARIFICATION');
    expect(state.openQuestions).toHaveLength(1);
    expect(state.openQuestions[0]?.round).toBe(1);
    expect(state.counters.clarificationRounds).toBe(1);
  });

  it('refuses a question with no stated justification', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    expect(() =>
      requestClarification(fixture.deps, id, [{ question: 'What should I do?', whyItMatters: '  ' }]),
    ).toThrow(/why the answer changes the implementation/i);
  });

  it('refuses an empty round', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    expect(() => requestClarification(fixture.deps, id, [])).toThrow(/at least one question/i);
  });

  it('refuses more questions than the per-round budget allows', () => {
    const fixture = setupOrchestrationFixture({ policy: { clarification: { maxQuestionsPerRound: 2 } } });
    const id = ambiguousRun(fixture);
    expect(() =>
      requestClarification(fixture.deps, id, [
        { question: 'A?', whyItMatters: 'x' },
        { question: 'B?', whyItMatters: 'y' },
        { question: 'C?', whyItMatters: 'z' },
      ]),
    ).toThrow(/at most 2 questions/);
  });

  it('refuses duplicate questions within a round', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    expect(() =>
      requestClarification(fixture.deps, id, [ROUTING_QUESTION, { ...ROUTING_QUESTION }]),
    ).toThrow(/asked twice/i);
  });

  it('bounds the number of rounds', () => {
    const fixture = setupOrchestrationFixture({ policy: { clarification: { maxRounds: 2 } } });
    const id = ambiguousRun(fixture);

    let state = requestClarification(fixture.deps, id, [
      { question: 'Q1?', whyItMatters: 'changes storage' },
    ]);
    resolveClarification(fixture.deps, id, [
      { questionId: state.openQuestions[0]!.id, answer: 'A1', source: 'known-from-user' },
    ]);
    state = requestClarification(fixture.deps, id, [
      { question: 'Q2?', whyItMatters: 'changes routing' },
    ]);
    resolveClarification(fixture.deps, id, [
      { questionId: state.openQuestions[0]!.id, answer: 'A2', source: 'known-from-user' },
    ]);

    try {
      requestClarification(fixture.deps, id, [{ question: 'Q3?', whyItMatters: 'changes more' }]);
      expect.unreachable('the third round must be refused');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.code).toBe('SBO008');
      expect(error.failureCategory).toBe('BUDGET_EXHAUSTED');
    }
  });

  it('refuses to re-ask a question that was already answered', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    const state = requestClarification(fixture.deps, id, [ROUTING_QUESTION]);
    resolveClarification(fixture.deps, id, [
      { questionId: state.openQuestions[0]!.id, answer: 'shared queue', source: 'known-from-user' },
    ]);
    expect(() => requestClarification(fixture.deps, id, [ROUTING_QUESTION])).toThrow(
      /already answered/i,
    );
  });
});

describe('clarification decisions', () => {
  it('unblocks planning once every open question is answered', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    const asked = requestClarification(fixture.deps, id, [ROUTING_QUESTION]);

    const result = resolveClarification(fixture.deps, id, [
      {
        questionId: asked.openQuestions[0]!.id,
        answer: 'Shared queue with an action identifier.',
        source: 'known-from-user',
        impact: 'Worker routes on the action id rather than subscribing per topic.',
      },
    ]);

    expect(result.state.phase).toBe('READY_TO_PLAN');
    expect(result.state.openQuestions).toHaveLength(0);
    expect(result.state.decisions).toHaveLength(1);
    expect(result.state.decisions[0]?.source).toBe('known-from-user');
  });

  it('stays in NEEDS_CLARIFICATION while any question is unanswered', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    const asked = requestClarification(fixture.deps, id, [
      ROUTING_QUESTION,
      { question: 'Is retry at-least-once?', whyItMatters: 'Changes idempotency requirements.' },
    ]);

    const result = resolveClarification(fixture.deps, id, [
      { questionId: asked.openQuestions[0]!.id, answer: 'shared queue', source: 'known-from-user' },
    ]);
    expect(result.state.phase).toBe('NEEDS_CLARIFICATION');
    expect(result.state.openQuestions).toHaveLength(1);
  });

  it('refuses to resolve a clarification with inferred provenance', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    const asked = requestClarification(fixture.deps, id, [ROUTING_QUESTION]);

    try {
      resolveClarification(fixture.deps, id, [
        { questionId: asked.openQuestions[0]!.id, answer: 'probably topics', source: 'inferred' },
      ]);
      expect.unreachable('an inference cannot resolve an ambiguity');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.failureCategory).toBe('AMBIGUITY');
      expect(error.message).toMatch(/that is the ambiguity it was meant to remove/i);
    }
  });

  it('refuses an answer to a question that was never asked', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    expect(() =>
      resolveClarification(fixture.deps, id, [
        { questionId: 'made-up', answer: 'yes', source: 'known-from-user' },
      ]),
    ).toThrow(/No open clarification question/);
  });

  it('supersedes an earlier decision when the user changes their mind', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    const first = requestClarification(fixture.deps, id, [ROUTING_QUESTION]);
    const resolved = resolveClarification(fixture.deps, id, [
      { questionId: first.openQuestions[0]!.id, answer: 'topic per action', source: 'known-from-user' },
    ]);
    const originalId = resolved.state.decisions[0]!.id;

    const second = requestClarification(fixture.deps, id, [
      { question: 'Confirm the final routing mechanism?', whyItMatters: 'It changes the worker.' },
    ]);
    const updated = resolveClarification(fixture.deps, id, [
      {
        questionId: second.openQuestions[0]!.id,
        answer: 'shared queue with action id',
        source: 'known-from-user',
        supersedes: originalId,
      },
    ]);

    expect(updated.state.decisions).toHaveLength(2);
    const effective = effectiveDecisions(updated.state.decisions);
    expect(effective).toHaveLength(1);
    expect(effective[0]?.answer).toBe('shared queue with action id');
  });

  it('flags a decision whose impact means the specification must change', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    const asked = requestClarification(fixture.deps, id, [ROUTING_QUESTION]);
    const result = resolveClarification(fixture.deps, id, [
      {
        questionId: asked.openQuestions[0]!.id,
        answer: 'Neither — route through a new dispatcher.',
        source: 'known-from-user',
        impact: 'This contradicts the approved design; the design stage must be re-authored.',
      },
    ]);

    expect(result.requiresSpecChange).toHaveLength(1);
  });

  it('persists no reasoning field on a decision record', () => {
    const fixture = setupOrchestrationFixture();
    const id = ambiguousRun(fixture);
    const asked = requestClarification(fixture.deps, id, [ROUTING_QUESTION]);
    const result = resolveClarification(fixture.deps, id, [
      { questionId: asked.openQuestions[0]!.id, answer: 'shared queue', source: 'known-from-user' },
    ]);
    const keys = Object.keys(result.state.decisions[0] ?? {});
    for (const forbidden of ['reasoning', 'thinking', 'chainOfThought', 'transcript']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
