import type {
  DiscoveryDecision,
  DiscoveryQuestion,
  MissionCoverage,
  MissionFact,
  TopicCoverage,
} from './state.js';
import { MISSION_COVERAGE_SCHEMA_VERSION, missionCoverageSchema } from './state.js';
import type { DiscoveryTopic, TopicStatus } from './vocabulary.js';
import { DISCOVERY_TOPICS, REQUIRED_TOPICS } from './vocabulary.js';

/**
 * Deterministic discovery coverage.
 *
 * Coverage is DERIVED — a pure function from the folded facts, questions,
 * and decisions to a per-topic status — never asserted by a model or a
 * caller. It exists to answer two questions honestly:
 *
 *   1. which material product decisions are still unresolved, and
 *   2. may this mission reach CONTRACT_READY?
 *
 * CONTRACT_READY requires BOTH:
 *   - no open question with `blocking` materiality, and
 *   - every REQUIRED topic resolved or explicitly marked not-applicable by
 *     a recorded decision.
 *
 * Nothing else gates: open implementation-detail questions, unknown optional
 * topics, and recorded assumptions are surfaced, not blocking. Discovery is
 * not a fixed questionnaire — the topic taxonomy is how gaps are NAMED, not
 * a form to fill in.
 */

export interface CoverageInput {
  missionId: string;
  facts: readonly MissionFact[];
  questions: readonly DiscoveryQuestion[];
  decisions: readonly DiscoveryDecision[];
  now: Date;
}

export function computeCoverage(input: CoverageInput): MissionCoverage {
  const activeFacts = input.facts.filter((fact) => fact.status === 'active');
  const openQuestions = input.questions.filter((question) => question.status === 'open');
  const activeDecisions = input.decisions.filter((decision) => decision.status === 'active');

  const topics: TopicCoverage[] = DISCOVERY_TOPICS.map((topicId) => {
    const factIds = activeFacts
      .filter((fact) => fact.topics.includes(topicId))
      .map((fact) => fact.factId);
    const openQuestionIds = openQuestions
      .filter((question) => question.topics.includes(topicId))
      .map((question) => question.questionId);
    const decisionIds = activeDecisions
      .filter((decision) => decision.topics.includes(topicId))
      .map((decision) => decision.decisionId);
    const markedNotApplicable = activeDecisions.some((decision) =>
      decision.marksNotApplicable.includes(topicId),
    );

    const status = statusFor({
      markedNotApplicable,
      hasOpenQuestions: openQuestionIds.length > 0,
      hasDecisions: decisionIds.length > 0,
      hasFacts: factIds.length > 0,
    });
    const required = REQUIRED_TOPICS.includes(topicId);
    const blockingHere =
      openQuestions.some(
        (question) => question.topics.includes(topicId) && question.materiality === 'blocking',
      ) ||
      (required && status !== 'resolved' && status !== 'not-applicable');

    return {
      topicId,
      status,
      blocking: blockingHere,
      required,
      factIds: factIds.slice(0, 30),
      openQuestionIds: openQuestionIds.slice(0, 30),
      decisionIds: decisionIds.slice(0, 30),
    };
  });

  const blockingQuestionIds = openQuestions
    .filter((question) => question.materiality === 'blocking')
    .map((question) => question.questionId);
  const unresolvedRequiredTopics = topics
    .filter(
      (topic) =>
        topic.required && topic.status !== 'resolved' && topic.status !== 'not-applicable',
    )
    .map((topic) => topic.topicId as DiscoveryTopic);

  const reasons: string[] = [];
  if (blockingQuestionIds.length > 0) {
    reasons.push(
      `${blockingQuestionIds.length} blocking question(s) are open: ${blockingQuestionIds
        .slice(0, 10)
        .join(', ')}.`,
    );
  }
  if (unresolvedRequiredTopics.length > 0) {
    reasons.push(
      `Required topic(s) unresolved: ${unresolvedRequiredTopics.join(', ')}. ` +
        'Resolve each with a recorded decision, or mark it not applicable with one.',
    );
  }
  const contractReady = blockingQuestionIds.length === 0 && unresolvedRequiredTopics.length === 0;
  if (contractReady) {
    reasons.push('No blocking questions are open and every required topic is addressed.');
  }

  return missionCoverageSchema.parse({
    schemaVersion: MISSION_COVERAGE_SCHEMA_VERSION,
    missionId: input.missionId,
    updatedAt: input.now.toISOString(),
    topics,
    blockingQuestionIds,
    unresolvedRequiredTopics,
    contractReady,
    reasons,
  });
}

function statusFor(input: {
  markedNotApplicable: boolean;
  hasOpenQuestions: boolean;
  hasDecisions: boolean;
  hasFacts: boolean;
}): TopicStatus {
  // A topic can be marked N/A and still carry open questions — the question
  // wins: an open question means the N/A itself is contested.
  if (input.hasOpenQuestions) return 'open';
  if (input.markedNotApplicable) return 'not-applicable';
  if (input.hasDecisions) return 'resolved';
  if (input.hasFacts) return 'open';
  return 'unknown';
}
