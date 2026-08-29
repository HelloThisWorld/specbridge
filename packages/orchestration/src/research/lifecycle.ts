import { z } from 'zod';
import type {
  DecisionBrief,
  ResearchExecutionResult,
  ResearchGateInput,
  ResearchGateResult,
  ResearchLifecycleEffect,
  ResearchReport,
  UnknownClassification,
} from './contracts.js';
import {
  UNKNOWN_CLASSIFICATIONS,
  decisionBriefOptionSchema,
  decisionBriefSchema,
  researchGateInputSchema,
  researchRequestSchema,
} from './contracts.js';
import { findResearchReuse } from './reuse.js';
import { listResearchRecords } from './store.js';
import {
  evaluateAndRecordResearchGate,
  startResearch,
  type ResearchScope,
  type ResearchServiceDeps,
} from './service.js';
import { recordResearchDecisionPreparedTelemetry } from './telemetry.js';

const boundedText = (max: number): z.ZodString => z.string().trim().min(1).max(max);
const boundedTextArray = (maxItems: number, maxText: number) =>
  z.array(boundedText(maxText)).max(maxItems);

export const lifecycleResearchInputSchema = z
  .object({
    phase: z.enum(['CONVERSATION', 'SPEC_DRAFT', 'INTAKE_DECISION', 'RUNTIME_INVESTIGATION']),
    classification: z.enum(UNKNOWN_CLASSIFICATIONS),
    reason: boundedText(1_000),
    requestedEffect: z
      .enum(['EVIDENCE', 'RECOMMENDATION', 'HUMAN_DECISION_PREPARED', 'REPLAN', 'ENGINEERING_CONSTRAINT'])
      .default('EVIDENCE'),
    usedBy: boundedText(256).optional(),
    gate: researchGateInputSchema,
    request: researchRequestSchema.optional(),
    operationId: boundedText(128).optional(),
    jobId: boundedText(128).optional(),
    refreshCurrentFacts: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.request !== undefined
      && (value.gate.requestedDepth ?? 'QUICK') !== value.request.depth
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gate', 'requestedDepth'],
        message: 'gate requestedDepth must match the bounded ResearchRequest depth',
      });
    }
  });
export type LifecycleResearchInput = z.input<typeof lifecycleResearchInputSchema>;

export interface LifecycleResearchResult {
  classification: UnknownClassification;
  gate: ResearchGateResult;
  execution?: ResearchExecutionResult;
}

function classifiedGate(
  classification: UnknownClassification,
  supplied: ResearchGateInput,
  priorResearchAvailable: boolean,
): ResearchGateInput {
  const base = { ...supplied, priorResearchAvailable };
  switch (classification) {
    case 'KNOWN_BY_MODEL': return { ...base, knowledgeGapDeclared: false };
    case 'KNOWN_BY_REPOSITORY': return { ...base, repositoryAnswerAvailable: true };
    case 'KNOWN_BY_PRIOR_RESEARCH': return base;
    case 'ENGINEERING_DECISION':
      return { ...base, dependsOnExternalFacts: false, dependsOnCurrentFacts: false, engineeringDecisionOnly: true };
    case 'PRODUCT_AUTHORITY': return { ...base, requiresHumanAuthority: true };
    case 'EXTERNAL_KNOWLEDGE_GAP': return { ...base, knowledgeGapDeclared: true };
    case 'UNRESOLVED': return { ...base, dependsOnExternalFacts: false, dependsOnCurrentFacts: false };
  }
}

/** One shared lifecycle router. It always searches the durable store before a provider call. */
export async function considerLifecycleResearch(
  deps: ResearchServiceDeps,
  raw: LifecycleResearchInput,
  signal?: AbortSignal,
): Promise<LifecycleResearchResult> {
  const input = lifecycleResearchInputSchema.parse(raw);
  const priorResearchAvailable = input.request === undefined
    ? false
    : findResearchReuse(listResearchRecords(deps.workspace).records, input.request).exact !== undefined;
  const gate = evaluateAndRecordResearchGate(
    deps,
    classifiedGate(input.classification, input.gate, priorResearchAvailable),
    input.phase,
  );
  if (!['RESEARCH_QUICK', 'RESEARCH_DEEP', 'REUSE_EXISTING'].includes(gate.decision) || input.request === undefined) {
    return { classification: input.classification, gate };
  }
  const scope: ResearchScope = {
    ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    lifecycle: {
      phase: input.phase,
      reason: input.reason,
      requestedEffect: input.requestedEffect,
      ...(input.usedBy !== undefined ? { usedBy: input.usedBy } : {}),
    },
    ...(input.refreshCurrentFacts ? { refreshCurrentFacts: true } : {}),
  };
  const execution = await startResearch(deps, input.request, scope, signal);
  return { classification: input.classification, gate, execution };
}

export const decisionPreparationInputSchema = z
  .object({
    questionId: boundedText(128),
    question: boundedText(4_000),
    context: boundedTextArray(20, 2_000).default([]),
    options: z.array(decisionBriefOptionSchema).max(8).default([]),
    recommendation: z
      .object({ optionId: boundedText(128), rationale: boundedTextArray(12, 1_000).min(1) })
      .strict()
      .optional(),
    repositoryEvidenceRefs: boundedTextArray(20, 512).default([]),
    research: lifecycleResearchInputSchema.optional(),
  })
  .strict();
export type DecisionPreparationInput = z.input<typeof decisionPreparationInputSchema>;

function outcomeOf(execution: ResearchExecutionResult | undefined): DecisionBrief['researchOutcome'] {
  if (execution === undefined) return 'NOT_NEEDED';
  if (execution.ok) {
    if (execution.reused) return 'REUSED';
    return execution.report.status === 'COMPLETED' ? 'COMPLETED' : 'INCONCLUSIVE';
  }
  return execution.failure.classification === 'BUDGET_EXHAUSTED' ? 'BUDGET_LIMITED' : 'UNAVAILABLE';
}

function reportContext(report: ResearchReport | undefined): string[] {
  if (report === undefined) return [];
  return [
    ...report.findings.slice(0, 12).map((finding) =>
      `${finding.kind === 'PRODUCT_OPTION' ? 'Research option (not a decision)' : 'Research evidence'}: ${finding.statement}`.slice(0, 2_000)),
    ...report.unresolved.slice(0, 4).map((item) => `Research unresolved: ${item}`),
    ...report.conflicts.slice(0, 4).map((item) => `Research conflict: ${item}`),
  ].slice(0, 20);
}

/** Prepare evidence for a human. This service has no answer or approval operation. */
export async function prepareDecisionBrief(
  deps: ResearchServiceDeps,
  raw: DecisionPreparationInput,
  signal?: AbortSignal,
): Promise<DecisionBrief> {
  const input = decisionPreparationInputSchema.parse(raw);
  const researchInput = input.research;
  const result = researchInput === undefined
    ? undefined
    : await considerLifecycleResearch(
        deps,
        {
          ...researchInput,
          phase: 'INTAKE_DECISION',
          classification: researchInput.classification === 'PRODUCT_AUTHORITY'
            ? 'EXTERNAL_KNOWLEDGE_GAP'
            : researchInput.classification,
          requestedEffect: 'HUMAN_DECISION_PREPARED',
          usedBy: researchInput.usedBy ?? input.questionId,
          gate: { ...researchInput.gate, requiresHumanAuthority: false },
        },
        signal,
      );
  const execution = result?.execution;
  const report = execution?.ok === true ? execution.report : undefined;
  if (report !== undefined) recordResearchDecisionPreparedTelemetry(deps.workspace, deps.clock?.() ?? new Date());
  return decisionBriefSchema.parse({
    questionId: input.questionId,
    question: input.question,
    context: [...input.context, ...reportContext(report)].slice(0, 24),
    options: input.options,
    ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
    researchRefs: execution?.ok === true ? [execution.record.researchId] : [],
    repositoryEvidenceRefs: input.repositoryEvidenceRefs,
    requiresHumanDecision: true,
    researchOutcome: outcomeOf(execution),
  });
}

export function renderResearchEvidence(report: ResearchReport): string {
  return [
    `Research ${report.researchId} (${report.status}, ${report.depth})`,
    ...report.findings.map((finding) => `- [${finding.kind}] ${finding.statement}`),
    ...report.recommendations.map((item) => `- Recommendation only: ${item}`),
    ...report.unresolved.map((item) => `- Unresolved: ${item}`),
    ...report.conflicts.map((item) => `- Conflict: ${item}`),
    '- Authority: EVIDENCE_ONLY; this report cannot approve product behavior or prove completion.',
  ].join('\n').slice(0, 16_000);
}

export function lifecycleEffectForClassification(classification: UnknownClassification): ResearchLifecycleEffect {
  return classification === 'PRODUCT_AUTHORITY'
    ? 'HUMAN_DECISION_PREPARED'
    : classification === 'ENGINEERING_DECISION'
      ? 'ENGINEERING_CONSTRAINT'
      : 'EVIDENCE';
}
