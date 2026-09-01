import { SpecBridgeError, stableId } from '@specbridge/core';
import type { ProductDecision, ResearchReport } from '@specbridge/core';
import type { QuestionCandidate } from './schemas.js';

export type AuthorityRoute =
  | 'USE_REPOSITORY'
  | 'ANSWER_DIRECTLY'
  | 'ENGINEERING_DECISION'
  | 'RESEARCH'
  | 'ASK_HUMAN';

export function routeQuestion(candidate: QuestionCandidate): AuthorityRoute {
  if (candidate.repositoryCanAnswer) return 'USE_REPOSITORY';
  if (candidate.stableTechnicalFact) return 'ANSWER_DIRECTLY';
  if (candidate.definesProductBehavior) return 'ASK_HUMAN';
  if (candidate.externalCurrentFact) return 'RESEARCH';
  if (candidate.engineeringChoice) return 'ENGINEERING_DECISION';
  return 'ENGINEERING_DECISION';
}

export function toProductDecision(candidate: QuestionCandidate): ProductDecision {
  const route = routeQuestion(candidate);
  const authority =
    route === 'ASK_HUMAN'
      ? 'HUMAN'
      : route === 'RESEARCH'
        ? 'RESEARCH'
        : route === 'USE_REPOSITORY'
          ? 'REPOSITORY'
          : 'ENGINEERING';
  const autoAnswer =
    authority === 'ENGINEERING' && candidate.recommendation !== null
      ? candidate.recommendation
      : authority === 'REPOSITORY'
        ? 'Resolve from repository evidence before review.'
        : null;
  return {
    id: candidate.id ?? stableId('DEC', candidate.question),
    question: candidate.question,
    whyItMatters: candidate.whyItMatters,
    options: candidate.options,
    recommendation: candidate.recommendation,
    authority,
    blocking: candidate.blocking,
    status: autoAnswer === null ? 'OPEN' : 'DECIDED',
    answer: autoAnswer,
    source:
      authority === 'HUMAN'
        ? 'USER'
        : authority === 'RESEARCH'
          ? 'RESEARCH'
          : authority === 'REPOSITORY'
            ? 'REPOSITORY'
            : 'ENGINEERING_DECISION',
  };
}

export interface ResearchGateInput {
  question: string;
  scope?: string;
  relevantVersion?: string | null;
  repositoryEvidenceAvailable: boolean;
  priorReports: ResearchReport[];
  currentOrVersionDependent: boolean;
  modelUncertain: boolean;
  highImpactCompatibility: boolean;
  externalPlatformRestriction: boolean;
  currentPricingLawOrStandard: boolean;
  contradictoryAuthoritativeSources: boolean;
  routineTechnicalFact: boolean;
  engineeringChoice: boolean;
  definesProductBehavior: boolean;
}

export type ResearchGateDecision =
  | 'ANSWER_DIRECTLY'
  | 'USE_REPOSITORY'
  | 'REUSE_RESEARCH'
  | 'RESEARCH'
  | 'ASK_HUMAN'
  | 'ENGINEERING_DECISION';

function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function researchGate(input: ResearchGateInput): {
  decision: ResearchGateDecision;
  reusableReportId: string | null;
} {
  if (input.repositoryEvidenceAvailable) {
    return { decision: 'USE_REPOSITORY', reusableReportId: null };
  }
  if (input.definesProductBehavior) {
    return { decision: 'ASK_HUMAN', reusableReportId: null };
  }
  const normalized = normalizeQuestion(input.question);
  const reusable = input.priorReports.find(
    (report) =>
      report.normalizedQuestion === normalized &&
      (input.scope === undefined || report.scope === input.scope) &&
      (input.relevantVersion === undefined ||
        input.relevantVersion === null ||
        report.sources.some((source) => source.relevantVersion === input.relevantVersion)) &&
      (report.freshnessUntil === null || Date.parse(report.freshnessUntil) > Date.now()),
  );
  if (reusable !== undefined) {
    return { decision: 'REUSE_RESEARCH', reusableReportId: reusable.id };
  }
  if (
    input.currentOrVersionDependent ||
    input.modelUncertain ||
    input.highImpactCompatibility ||
    input.externalPlatformRestriction ||
    input.currentPricingLawOrStandard ||
    input.contradictoryAuthoritativeSources
  ) {
    return { decision: 'RESEARCH', reusableReportId: null };
  }
  if (input.engineeringChoice) {
    return { decision: 'ENGINEERING_DECISION', reusableReportId: null };
  }
  if (input.routineTechnicalFact) {
    return { decision: 'ANSWER_DIRECTLY', reusableReportId: null };
  }
  return { decision: 'ENGINEERING_DECISION', reusableReportId: null };
}

export interface ResearchRequest {
  question: string;
  scope: string;
  preferOfficialSources: boolean;
  relevantVersion: string | null;
}

export interface ResearchProvider {
  available(): Promise<boolean>;
  research(request: ResearchRequest): Promise<ResearchReport>;
}

export async function performResearch(
  provider: ResearchProvider,
  request: ResearchRequest,
): Promise<ResearchReport> {
  if (!(await provider.available())) {
    throw new SpecBridgeError(
      'RESEARCH_PROVIDER_UNAVAILABLE',
      'The selected research provider is not available.',
    );
  }
  const report = await provider.research(request);
  const expected = normalizeQuestion(request.question);
  if (report.normalizedQuestion !== expected) {
    throw new SpecBridgeError(
      'RESEARCH_REPORT_MISMATCH',
      'ResearchReport does not answer the normalized request question.',
      { expected, received: report.normalizedQuestion },
    );
  }
  return report;
}
