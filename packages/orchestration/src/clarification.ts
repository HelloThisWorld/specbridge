import type { OrchestrationPolicy } from '@specbridge/core';
import { OrchestrationError } from './errors.js';
import type { ClarificationDecision, ClarificationQuestion, OrchestrationState } from './state.js';
import { clarificationDecisionSchema, clarificationQuestionSchema } from './state.js';
import type { ProvenanceKind } from './vocabulary.js';

/**
 * Clarification: bounded, targeted questions and the durable decisions they
 * produce.
 *
 * Two rules shape everything here.
 *
 * First, a question must earn its place. A generic questionnaire wastes the
 * user's attention and teaches them to skim; only a question whose answer
 * *changes the implementation* is worth asking, so `whyItMatters` is required
 * and empty/duplicate questions are refused.
 *
 * Second, a decision is not a specification. Resolving "use a shared queue
 * with an action identifier" records what the user chose and why the
 * orchestration believed it — it does not amend an approved `.kiro` document.
 * When the answer genuinely changes the spec, the honest outcome is to
 * re-author the stage and re-enter the normal human approval lifecycle, and
 * `decisionRequiresSpecChange` says so explicitly.
 */

export interface QuestionCandidate {
  question: string;
  whyItMatters: string;
  options?: string[];
  relatedTaskId?: string | undefined;
}

export interface RecordedQuestions {
  questions: ClarificationQuestion[];
  round: number;
}

function normalizeQuestion(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Validate and bound a round of questions.
 *
 * Refuses: empty rounds, over-budget rounds, questions without justification,
 * duplicates within the round, and repeats of an already-answered question
 * (asking again after an answer is how a loop masquerades as diligence).
 */
export function buildClarificationRound(
  state: OrchestrationState,
  candidates: readonly QuestionCandidate[],
  policy: OrchestrationPolicy,
  options: { askedAt: string; idFactory: () => string },
): RecordedQuestions {
  if (candidates.length === 0) {
    throw new OrchestrationError('SBO007', 'A clarification round needs at least one question.', {
      remediation: ['If nothing is genuinely unclear, assess intent as READY instead.'],
    });
  }
  if (candidates.length > policy.clarification.maxQuestionsPerRound) {
    throw new OrchestrationError(
      'SBO021',
      `A clarification round may ask at most ${policy.clarification.maxQuestionsPerRound} questions ` +
        `(received ${candidates.length}). Ask only the questions whose answers change the implementation.`,
      { remediation: ['Drop questions whose answers would not change what you build.'] },
    );
  }

  const nextRound = state.counters.clarificationRounds + 1;
  if (nextRound > policy.clarification.maxRounds) {
    throw new OrchestrationError(
      'SBO008',
      `All ${policy.clarification.maxRounds} clarification rounds are used; the request is still ambiguous.`,
      {
        remediation: [
          'Resolve the ambiguity in the specification itself and re-approve the affected stage.',
          'Raise orchestration.clarification.maxRounds explicitly if more rounds are genuinely useful.',
        ],
        failureCategory: 'BUDGET_EXHAUSTED',
      },
    );
  }

  const answered = new Set(state.decisions.map((decision) => normalizeQuestion(decision.question)));
  const seen = new Set<string>();
  const questions: ClarificationQuestion[] = [];

  for (const candidate of candidates) {
    const text = candidate.question.trim();
    const why = candidate.whyItMatters.trim();
    if (text.length === 0) {
      throw new OrchestrationError('SBO007', 'A clarification question must not be empty.');
    }
    if (Buffer.byteLength(text, 'utf8') > policy.clarification.maxQuestionBytes) {
      throw new OrchestrationError(
        'SBO021',
        `A clarification question may be at most ${policy.clarification.maxQuestionBytes} bytes.`,
        { remediation: ['Ask one specific thing per question.'] },
      );
    }
    if (why.length === 0) {
      throw new OrchestrationError(
        'SBO007',
        `Question "${text.slice(0, 60)}" has no justification. ` +
          'Every question must state why the answer changes the implementation.',
        { remediation: ['Drop the question, or explain what it would change.'] },
      );
    }
    const normalized = normalizeQuestion(text);
    if (seen.has(normalized)) {
      throw new OrchestrationError(
        'SBO007',
        `Question "${text.slice(0, 60)}" is asked twice in the same round.`,
      );
    }
    if (answered.has(normalized)) {
      throw new OrchestrationError(
        'SBO007',
        `Question "${text.slice(0, 60)}" was already answered in this run; re-asking it makes no progress.`,
        { remediation: ['Read the recorded decision, or supersede it with an explicit new decision.'] },
      );
    }
    seen.add(normalized);
    questions.push(
      clarificationQuestionSchema.parse({
        id: options.idFactory(),
        question: text,
        whyItMatters: why,
        options: (candidate.options ?? []).slice(0, 10),
        ...(candidate.relatedTaskId !== undefined ? { relatedTaskId: candidate.relatedTaskId } : {}),
        askedAt: options.askedAt,
        round: nextRound,
      }),
    );
  }

  return { questions, round: nextRound };
}

export interface DecisionCandidate {
  questionId: string;
  answer: string;
  /** Where the answer came from. `known-from-user` for a direct answer. */
  source: ProvenanceKind;
  impact?: string | undefined;
  /** Id of an earlier decision this one replaces. */
  supersedes?: string | undefined;
}

/**
 * Turn answered questions into durable decision records.
 *
 * Only questions that are actually open can be answered, and an answer whose
 * provenance is `inferred`, `unknown`, or `conflicting` is refused outright:
 * the entire point of asking was to replace an inference with a decision.
 */
export function buildClarificationDecisions(
  state: OrchestrationState,
  candidates: readonly DecisionCandidate[],
  policy: OrchestrationPolicy,
  options: { decidedAt: string; idFactory: () => string },
): ClarificationDecision[] {
  if (candidates.length === 0) {
    throw new OrchestrationError('SBO007', 'At least one decision is required.');
  }
  const open = new Map(state.openQuestions.map((question) => [question.id, question]));
  const known = new Set(state.decisions.map((decision) => decision.id));
  const decisions: ClarificationDecision[] = [];

  for (const candidate of candidates) {
    const question = open.get(candidate.questionId);
    if (question === undefined) {
      throw new OrchestrationError(
        'SBO007',
        `No open clarification question with id "${candidate.questionId}".`,
        {
          remediation: [
            `Open question ids: ${[...open.keys()].join(', ') || '(none)'}.`,
            'Ask the question first with an explicit clarification round.',
          ],
        },
      );
    }
    const answer = candidate.answer.trim();
    if (answer.length === 0) {
      throw new OrchestrationError('SBO007', 'A clarification answer must not be empty.');
    }
    if (Buffer.byteLength(answer, 'utf8') > policy.clarification.maxAnswerBytes) {
      throw new OrchestrationError(
        'SBO021',
        `A clarification answer may be at most ${policy.clarification.maxAnswerBytes} bytes.`,
      );
    }
    if (candidate.source === 'inferred' || candidate.source === 'unknown' || candidate.source === 'conflicting') {
      throw new OrchestrationError(
        'SBO007',
        `A clarification cannot be resolved with "${candidate.source}" provenance — that is the ambiguity it was meant to remove.`,
        {
          remediation: [
            'Record the user\'s actual decision (known-from-user), or the approved spec text that settles it.',
          ],
          failureCategory: 'AMBIGUITY',
        },
      );
    }
    if (candidate.supersedes !== undefined && !known.has(candidate.supersedes)) {
      throw new OrchestrationError(
        'SBO007',
        `Decision "${candidate.supersedes}" does not exist and cannot be superseded.`,
      );
    }
    decisions.push(
      clarificationDecisionSchema.parse({
        id: options.idFactory(),
        questionId: question.id,
        question: question.question,
        answer,
        source: candidate.source,
        relatedSpecName: state.specName,
        ...(question.relatedTaskId !== undefined ? { relatedTaskId: question.relatedTaskId } : {}),
        decidedAt: options.decidedAt,
        ...(candidate.supersedes !== undefined ? { supersedes: candidate.supersedes } : {}),
        ...(candidate.impact !== undefined ? { impact: candidate.impact } : {}),
      }),
    );
  }
  return decisions;
}

/**
 * Whether a decision should be routed back through spec re-authoring instead
 * of being treated as settled.
 *
 * A clarification decision never overrides an approved `.kiro` document. When
 * the answer changes what the spec says, the correct outcome is to re-author
 * the stage and re-enter the human approval lifecycle.
 */
export function decisionRequiresSpecChange(decision: ClarificationDecision): boolean {
  return decision.source === 'known-from-user' && decision.impact !== undefined
    ? /\b(spec|requirement|design|acceptance criteri|contract|behaviou?r change)\b/i.test(
        decision.impact,
      )
    : false;
}

/** Decisions that are still in force (not superseded by a later decision). */
export function effectiveDecisions(
  decisions: readonly ClarificationDecision[],
): ClarificationDecision[] {
  const superseded = new Set(
    decisions.map((decision) => decision.supersedes).filter((id): id is string => id !== undefined),
  );
  return decisions.filter((decision) => !superseded.has(decision.id));
}
