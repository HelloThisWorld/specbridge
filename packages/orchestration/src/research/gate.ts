import type { ResearchGateInput, ResearchGateResult } from './contracts.js';
import { researchGateInputSchema } from './contracts.js';

/** Deterministic, explainable, zero-model-call research escalation policy. */
export function evaluateResearchGate(raw: ResearchGateInput): ResearchGateResult {
  const input = researchGateInputSchema.parse(raw);

  if (input.requiresHumanAuthority) {
    return {
      decision: 'ASK_HUMAN',
      reasons: ['the decision requires human product authority; research can inform but cannot decide it'],
    };
  }
  if (input.repositoryAnswerAvailable) {
    return {
      decision: 'ANSWER_DIRECTLY',
      reasons: ['the current repository or system already contains the answer'],
    };
  }
  if (input.priorResearchAvailable) {
    return {
      decision: 'REUSE_EXISTING',
      reasons: ['durable prior research is available, so a repeat provider call is unnecessary'],
    };
  }

  const externalUncertainty = input.dependsOnExternalFacts || input.dependsOnCurrentFacts;
  if (input.engineeringDecisionOnly && !externalUncertainty) {
    return {
      decision: 'ENGINEERING_DECISION',
      reasons: ['this is an engineering choice without material external uncertainty'],
    };
  }
  if (!input.knowledgeGapDeclared) {
    return {
      decision: input.engineeringDecisionOnly ? 'ENGINEERING_DECISION' : 'ANSWER_DIRECTLY',
      reasons: ['the caller did not declare a remaining knowledge gap'],
    };
  }
  if (!externalUncertainty) {
    return {
      decision: input.engineeringDecisionOnly ? 'ENGINEERING_DECISION' : 'ANSWER_DIRECTLY',
      reasons: ['the declared gap does not depend on external or current facts'],
    };
  }
  if (!input.materialToProductOrArchitecture) {
    return {
      decision: 'ANSWER_DIRECTLY',
      reasons: ['the external uncertainty is not material enough to justify research cost'],
    };
  }

  const deep =
    input.requestedDepth === 'DEEP' ||
    (input.repeatedUnknown && input.repeatedUnknownAfterDifferentStrategies);
  return {
    decision: deep ? 'RESEARCH_DEEP' : 'RESEARCH_QUICK',
    reasons: [
      'the caller declared a remaining knowledge gap',
      input.dependsOnCurrentFacts
        ? 'the answer depends on current external facts'
        : 'the answer depends on external facts',
      'the answer is material to product or architecture',
      ...(deep && input.repeatedUnknownAfterDifferentStrategies
        ? ['materially different strategies still produced an unknown result']
        : []),
    ],
  };
}
