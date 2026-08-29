import { z } from 'zod';
import type { FailureSource, ReliabilityObservation } from '../reliability/index.js';
import type { FailureCategory } from '../vocabulary.js';

export const investigationPacketSchema = z.object({
  investigationId: z.string().min(1).max(128),
  goal: z.string().min(1).max(4_000),
  knownFacts: z.array(z.string().min(1).max(2_000)).max(20).default([]),
  relevantContracts: z.array(z.string().min(1).max(2_000)).max(20).default([]),
  currentSystemRefs: z.array(z.string().min(1).max(512)).max(20).default([]),
  failureFingerprint: z.string().min(1).max(256).optional(),
  observedFailures: z.array(z.string().min(1).max(2_000)).max(10).default([]),
  failedStrategies: z.array(z.string().min(1).max(512)).max(10).default([]),
  sourceRefs: z.array(z.string().min(1).max(512)).max(20).default([]),
  constraints: z.array(z.string().min(1).max(2_000)).max(20).default([]),
  questionsToAnswer: z.array(z.string().min(1).max(1_000)).min(1).max(12),
  topicTags: z.array(z.string().min(1).max(64)).max(16).default([]),
  currentFactSensitive: z.boolean().default(false),
  subjectVersion: z.string().min(1).max(128).optional(),
}).strict();
export type InvestigationPacket = z.infer<typeof investigationPacketSchema>;

const ORDINARY_FAILURES: readonly FailureCategory[] = [
  'AUTHENTICATION', 'PERMISSION', 'BUDGET_EXHAUSTED', 'VERIFICATION_FAILURE',
  'IMPLEMENTATION_DEFECT', 'BLOCKED_DEPENDENCY', 'CAPABILITY_UNAVAILABLE',
  'INVALID_CONFIGURATION', 'PROTECTED_PATH', 'STALE_CONTEXT', 'REPOSITORY_DIVERGED',
];
const NON_RESEARCH_SOURCES: readonly FailureSource[] = [
  'AUTHORIZATION', 'BUDGET', 'EXECUTION_INFRASTRUCTURE',
  'VERIFICATION_INFRASTRUCTURE', 'REPOSITORY_STATE', 'TRANSIENT',
];

export interface RuntimeResearchTriggerInput {
  explicitExternalKnowledgeGap: boolean;
  externalAssumptionContradiction: boolean;
  unknownToolingOrPlatformBehavior: boolean;
  repositoryAnswerAvailable: boolean;
  productAuthorityAmbiguity: boolean;
  insufficientRepositoryContext: boolean;
  failureCategory?: FailureCategory;
  failureSource?: FailureSource;
  failureFingerprint?: string | null;
  observations: readonly Pick<ReliabilityObservation, 'failureFingerprint' | 'strategyKey'>[];
}
export interface RuntimeResearchTriggerResult {
  eligible: boolean;
  depth: 'QUICK' | 'DEEP';
  reason: string;
  repeatedCount: number;
  materiallyDistinctStrategies: string[];
}

/** Durable, deterministic runtime eligibility; vague worker prose is not an input. */
export function evaluateRuntimeResearchTrigger(input: RuntimeResearchTriggerInput): RuntimeResearchTriggerResult {
  const fingerprint = input.failureFingerprint ?? null;
  const matching = fingerprint === null ? [] : input.observations.filter((entry) => entry.failureFingerprint === fingerprint);
  const strategies = [...new Set(matching.map((entry) => entry.strategyKey).filter((key): key is string => key !== null))];
  const repeatedAfterDistinctStrategies = matching.length >= 2 && strategies.length >= 2;
  const refusedReason = input.productAuthorityAmbiguity
    ? 'product authority ambiguity belongs to the human decision path'
    : input.insufficientRepositoryContext
      ? 'insufficient selected repository context belongs to context expansion'
      : input.repositoryAnswerAvailable
        ? 'repository evidence already answers the question'
        : input.failureCategory !== undefined && ORDINARY_FAILURES.includes(input.failureCategory)
          ? `${input.failureCategory} has a deterministic non-research recovery path`
          : input.failureSource !== undefined && NON_RESEARCH_SOURCES.includes(input.failureSource)
            ? `${input.failureSource} is not an external knowledge failure`
            : undefined;
  if (refusedReason !== undefined) {
    return { eligible: false, depth: 'QUICK', reason: refusedReason, repeatedCount: matching.length, materiallyDistinctStrategies: strategies };
  }
  if (repeatedAfterDistinctStrategies) {
    return { eligible: true, depth: 'DEEP', reason: 'the same durable failure fingerprint persisted after materially distinct strategies', repeatedCount: matching.length, materiallyDistinctStrategies: strategies };
  }
  if (input.explicitExternalKnowledgeGap || input.externalAssumptionContradiction || input.unknownToolingOrPlatformBehavior) {
    return {
      eligible: true,
      depth: 'QUICK',
      reason: input.explicitExternalKnowledgeGap
        ? 'an explicit material external knowledge gap was declared'
        : input.externalAssumptionContradiction
          ? 'observed runtime behavior contradicts the recorded external-system assumption'
          : 'material tooling or platform behavior is unknown and not repository-resolvable',
      repeatedCount: matching.length,
      materiallyDistinctStrategies: strategies,
    };
  }
  return { eligible: false, depth: 'QUICK', reason: 'no evidence-backed external knowledge trigger is present', repeatedCount: matching.length, materiallyDistinctStrategies: strategies };
}
