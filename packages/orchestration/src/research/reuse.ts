import { sha256Hex } from '@specbridge/core';
import type { ResearchRecord, ResearchRequest } from './contracts.js';

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}
function normalizedRequest(request: ResearchRequest): unknown {
  const normalize = (values: readonly string[]): string[] => values.map(normalizeText);
  return {
    depth: request.depth,
    question: normalizeText(request.question),
    context: {
      knownFacts: normalize(request.context.knownFacts),
      observedFailures: normalize(request.context.observedFailures),
      failedStrategies: normalize(request.context.failedStrategies),
      constraints: normalize(request.context.constraints),
      contextRefs: normalize(request.context.contextRefs),
    },
    expectedOutput: { questionsToAnswer: normalize(request.expectedOutput.questionsToAnswer) },
    sourcePolicy: request.sourcePolicy,
    freshness: request.freshness,
  };
}

export function researchRequestHash(request: ResearchRequest): string {
  return sha256Hex(JSON.stringify(normalizedRequest(request)));
}

export function normalizedQuestionHash(question: string): string {
  return sha256Hex(normalizeText(question));
}

export interface ResearchReuseMatch {
  exact?: ResearchRecord;
  candidates: ResearchRecord[];
}

/** Exact hashes reuse automatically; explicit tag overlap only yields candidates. */
export function findResearchReuse(
  records: readonly ResearchRecord[],
  request: ResearchRequest,
): ResearchReuseMatch {
  const reusable = records.filter(
    (record) =>
      (record.status === 'COMPLETED' || record.status === 'INCONCLUSIVE') &&
      record.report !== undefined,
  );
  const requestHash = researchRequestHash(request);
  const exact = reusable.find((record) => record.requestHash === requestHash);
  const tags = new Set(request.topicTags.map((tag) => tag.toLocaleLowerCase('en-US')));
  const candidates =
    tags.size === 0
      ? []
      : reusable.filter(
          (record) =>
            record.requestHash !== requestHash &&
            record.topicTags.some((tag) => tags.has(tag.toLocaleLowerCase('en-US'))),
        );
  return { ...(exact !== undefined ? { exact } : {}), candidates };
}
