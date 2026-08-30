import { z } from 'zod';
import type { VerificationCommand } from '@specbridge/core';
import { sha256Hex } from '@specbridge/core';
import type { ResearchRecord } from '../research/contracts.js';
import type { ComplexityClass } from '../jobs/vocabulary.js';
import type { SuitabilityAssessment } from '../scheduling/suitability.js';
import type { BuilderPacketCompilationResult } from './builder-packet-compiler.js';
import type { ContextProjection, WorkUnit } from './state.js';
import type { SecondaryBuilderPacket } from './secondary-builder.js';

/**
 * Phase 6 admission policy for the Objective Secondary Builder.
 *
 * Evidence -> WorkReadinessAssessment -> SecondaryEligibilityDecision
 *
 * The assessment is deterministic and provider-neutral. It deliberately
 * describes the delegated WorkUnit, not the parent Objective's coarse
 * complexity and not the current availability or economics of any model.
 */

export const WORK_READINESS_ASSESSMENT_SCHEMA_VERSION = '1.0.0';
export const SECONDARY_ELIGIBILITY_DECISION_SCHEMA_VERSION = '1.0.0';
export const WORK_READINESS_TELEMETRY_SCHEMA_VERSION = '1.0.0';

export const KNOWLEDGE_STATES = [
  'KNOWN',
  'RESOLVED_BY_RESEARCH',
  'UNCERTAIN',
  'EXTERNAL_UNKNOWN',
] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

export const DECISION_ENTROPIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DecisionEntropy = (typeof DECISION_ENTROPIES)[number];

export const IMPLEMENTATION_SPECIFICITIES = ['ABSTRACT', 'BOUNDED', 'CONCRETE'] as const;
export type ImplementationSpecificity = (typeof IMPLEMENTATION_SPECIFICITIES)[number];

export const WORK_READINESS_VERIFICATION_STRENGTHS = ['NONE', 'WEAK', 'STRONG'] as const;
export type WorkReadinessVerificationStrength =
  (typeof WORK_READINESS_VERIFICATION_STRENGTHS)[number];

export const WORK_READINESS_CONTEXT_STATES = ['SUFFICIENT', 'INSUFFICIENT', 'AMBIGUOUS'] as const;
export type WorkReadinessContextState = (typeof WORK_READINESS_CONTEXT_STATES)[number];

export const REPOSITORY_MUTATION_SCOPES = ['BOUNDED', 'BROAD', 'UNKNOWN'] as const;
export type RepositoryMutationScope = (typeof REPOSITORY_MUTATION_SCOPES)[number];

export const DEPENDENCY_READINESS_STATES = ['READY', 'INCOMPLETE', 'STALE', 'AMBIGUOUS'] as const;
export type DependencyReadinessState = (typeof DEPENDENCY_READINESS_STATES)[number];

export const SECONDARY_ELIGIBILITY_STATUSES = [
  'ELIGIBLE',
  'STRONG_REQUIRED',
  'NEEDS_RESEARCH',
  'NEEDS_AUTHORITY',
  'NEEDS_CONTEXT',
  'NOT_READY',
] as const;
export type SecondaryEligibilityStatus = (typeof SECONDARY_ELIGIBILITY_STATUSES)[number];

export const WORK_READINESS_REASON_CODES = [
  'AUTHORITY_UNRESOLVED',
  'CONTRACT_MUTATION_REQUIRED',
  'CONTEXT_INSUFFICIENT',
  'TARGET_AMBIGUOUS',
  'KNOWLEDGE_EXTERNAL_UNKNOWN',
  'KNOWLEDGE_UNCERTAIN',
  'HIGH_DECISION_ENTROPY',
  'ABSTRACT_IMPLEMENTATION',
  'NO_TRUSTED_VERIFICATION',
  'WEAK_TRUSTED_VERIFICATION',
  'DEPENDENCY_NOT_READY',
  'DEPENDENCY_STALE',
  'DEPENDENCY_AMBIGUOUS',
  'BROAD_MUTATION_SCOPE',
  'UNKNOWN_MUTATION_SCOPE',
  'CONCRETE_TARGET',
  'BOUNDED_TARGET',
  'STRONG_VERIFICATION',
  'REFERENCE_PATTERN_AVAILABLE',
  'TEST_COVERAGE_AVAILABLE',
  'RESEARCH_RESOLVED',
  'CONTEXT_SUFFICIENT',
  'DEPENDENCIES_READY',
  'KNOWN_IMPLEMENTATION_FACTS',
  'LOW_DECISION_ENTROPY',
  'MEDIUM_DECISION_ENTROPY',
  'APPROVED_AUTHORITY',
  'PARENT_COMPLEXITY_ADVISORY',
] as const;
export type WorkReadinessReasonCode = (typeof WORK_READINESS_REASON_CODES)[number];

const shortText = z.string().min(1).max(512);
const boundedText = z.string().min(1).max(2_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const workReadinessReasonSchema = z
  .object({
    code: z.enum(WORK_READINESS_REASON_CODES),
    message: boundedText,
    evidenceRefs: z.array(shortText).max(30).default([]),
  })
  .strict();
export type WorkReadinessReason = z.infer<typeof workReadinessReasonSchema>;

export const workReadinessInputIdentitySchema = z
  .object({
    workUnitHash: sha256,
    packetHash: sha256.nullable(),
    packetQualityHash: sha256,
    projectionHash: sha256,
    researchEvidenceHash: sha256,
    verificationPolicyHash: sha256,
    dependencyStateHash: sha256,
  })
  .strict();
export type WorkReadinessInputIdentity = z.infer<typeof workReadinessInputIdentitySchema>;

export const workReadinessAssessmentSchema = z
  .object({
    schemaVersion: z.literal(WORK_READINESS_ASSESSMENT_SCHEMA_VERSION),
    assessmentId: shortText,
    jobId: shortText,
    objectiveNodeId: shortText,
    workUnitId: shortText,
    attempt: z.number().int().min(1),
    parentObjectiveComplexity: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable(),
    knowledgeState: z.enum(KNOWLEDGE_STATES),
    decisionEntropy: z.enum(DECISION_ENTROPIES),
    implementationSpecificity: z.enum(IMPLEMENTATION_SPECIFICITIES),
    verificationStrength: z.enum(WORK_READINESS_VERIFICATION_STRENGTHS),
    contextState: z.enum(WORK_READINESS_CONTEXT_STATES),
    authorityRisk: z.boolean(),
    contractMutationRisk: z.boolean(),
    repositoryMutationScope: z.enum(REPOSITORY_MUTATION_SCOPES),
    dependencyState: z.enum(DEPENDENCY_READINESS_STATES),
    reasons: z.array(workReadinessReasonSchema).min(1).max(40),
    evidenceRefs: z.array(shortText).max(80),
    inputIdentity: workReadinessInputIdentitySchema,
    inputHash: sha256,
    contentHash: sha256,
    assessedAt: shortText,
  })
  .strict();
export type WorkReadinessAssessment = z.infer<typeof workReadinessAssessmentSchema>;

export const secondaryEligibilityDecisionSchema = z
  .object({
    schemaVersion: z.literal(SECONDARY_ELIGIBILITY_DECISION_SCHEMA_VERSION),
    decisionId: shortText,
    jobId: shortText,
    objectiveNodeId: shortText,
    workUnitId: shortText,
    attempt: z.number().int().min(1),
    status: z.enum(SECONDARY_ELIGIBILITY_STATUSES),
    reasons: z.array(workReadinessReasonSchema).min(1).max(40),
    assessmentRef: shortText,
    assessmentHash: sha256,
    contentHash: sha256,
    decidedAt: shortText,
  })
  .strict();
export type SecondaryEligibilityDecision = z.infer<typeof secondaryEligibilityDecisionSchema>;

export const workReadinessRecordSchema = z
  .object({
    assessment: workReadinessAssessmentSchema,
    decision: secondaryEligibilityDecisionSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.assessment.contentHash !== record.decision.assessmentHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision', 'assessmentHash'],
        message: 'must reference the assessment content hash',
      });
    }
    for (const field of ['jobId', 'objectiveNodeId', 'workUnitId', 'attempt'] as const) {
      if (record.assessment[field] !== record.decision[field]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decision', field],
          message: `must match assessment.${field}`,
        });
      }
    }
  });
export type WorkReadinessRecord = z.infer<typeof workReadinessRecordSchema>;

const countRecordSchema = z.record(z.string(), z.number().int().min(0));
export const workReadinessTelemetrySchema = z
  .object({
    schemaVersion: z.literal(WORK_READINESS_TELEMETRY_SCHEMA_VERSION),
    assessmentCount: z.number().int().min(0),
    statusCounts: countRecordSchema,
    reasonCodeDistribution: countRecordSchema,
    decisionEntropyDistribution: countRecordSchema,
    verificationStrengthDistribution: countRecordSchema,
    contextStateDistribution: countRecordSchema,
    generatedAt: shortText,
  })
  .strict();
export type WorkReadinessTelemetry = z.infer<typeof workReadinessTelemetrySchema>;

export interface WorkReadinessInput {
  jobId: string;
  objectiveNodeId: string;
  workUnit: WorkUnit;
  projection: ContextProjection;
  attempt: number;
  parentObjectiveComplexity?: ComplexityClass | undefined;
  packet?: SecondaryBuilderPacket | undefined;
  compilation?: BuilderPacketCompilationResult | undefined;
  verificationCommands: readonly VerificationCommand[];
  dependencyState?: DependencyReadinessState | undefined;
  missingDependencyIds?: readonly string[] | undefined;
  researchRecords?: readonly ResearchRecord[] | undefined;
  relevantResearchIds?: readonly string[] | undefined;
  assessedAt?: string | undefined;
}

export interface WorkReadinessResult extends WorkReadinessRecord {
  reused: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function semanticWorkUnit(unit: WorkUnit): Record<string, unknown> {
  return {
    workUnitId: unit.workUnitId,
    objectiveNodeId: unit.objectiveNodeId,
    parentTaskId: unit.parentTaskId,
    kind: unit.kind,
    title: unit.title,
    goal: unit.goal,
    dependsOn: [...unit.dependsOn].sort(),
    expectedArtifacts: unit.expectedArtifacts,
    relevantContractIds: [...unit.relevantContractIds].sort(),
    relevantAdrIds: [...unit.relevantAdrIds].sort(),
    relevantConstitutionRuleIds: [...unit.relevantConstitutionRuleIds].sort(),
    expectedAreas: [...unit.expectedAreas].sort(),
    operatorDecision: unit.operatorDecision ?? null,
  };
}

function workText(unit: WorkUnit): string {
  return [unit.title, unit.goal, ...unit.expectedArtifacts, ...unit.expectedAreas].join('\n');
}

function qualityOf(input: WorkReadinessInput): SecondaryBuilderPacket['quality'] | undefined {
  return input.packet?.quality ?? input.compilation?.quality;
}

function relevantResearchRecords(input: WorkReadinessInput): ResearchRecord[] {
  const explicit = new Set(input.relevantResearchIds ?? []);
  const evidenceText = [
    ...input.projection.workEvidence,
    ...(input.packet?.approvedContext.priorWorkEvidence ?? []),
  ].join('\n');
  return [...(input.researchRecords ?? [])]
    .filter((record) =>
      explicit.has(record.researchId)
      || record.lifecycle?.usedBy === input.workUnit.workUnitId
      || (record.lifecycle?.usedBy !== undefined && input.workUnit.dependsOn.includes(record.lifecycle.usedBy))
      || evidenceText.includes(record.researchId),
    )
    .sort((left, right) => left.researchId.localeCompare(right.researchId, 'en'));
}

function researchRecordIdentity(records: readonly ResearchRecord[]): string {
  return sha256Hex(stableStringify(records.map((record) => ({
    researchId: record.researchId,
    status: record.status,
    requestHash: record.requestHash,
    lifecycle: record.lifecycle ?? null,
    report: record.report ?? null,
    failure: record.failure ?? null,
  }))));
}

function compilationQualityIdentity(input: WorkReadinessInput): string {
  const compilation = input.compilation;
  if (compilation === undefined) {
    return sha256Hex(stableStringify({ quality: input.packet?.quality ?? null }));
  }
  return sha256Hex(stableStringify({
    ok: compilation.ok,
    quality: compilation.quality,
    planRefs: [...compilation.planRefs].sort(),
    ...(compilation.ok ? {} : { failure: compilation.failure }),
  }));
}

export function buildWorkReadinessInputIdentity(input: WorkReadinessInput): WorkReadinessInputIdentity {
  const research = relevantResearchRecords(input);
  const dependencyState = dependencyStateOf(input);
  return workReadinessInputIdentitySchema.parse({
    workUnitHash: sha256Hex(stableStringify(semanticWorkUnit(input.workUnit))),
    packetHash: input.packet?.contentHash ?? null,
    packetQualityHash: compilationQualityIdentity(input),
    projectionHash: input.projection.contentHash,
    researchEvidenceHash: researchRecordIdentity(research),
    verificationPolicyHash: sha256Hex(stableStringify(input.verificationCommands.map((command) => ({
      name: command.name,
      argv: command.argv,
      required: command.required,
      timeoutMs: command.timeoutMs,
    })))),
    dependencyStateHash: sha256Hex(stableStringify({
      state: dependencyState,
      missingDependencyIds: [...(input.missingDependencyIds ?? [])].sort(),
      packetDependencies: input.packet?.dependencyContext.map((dependency) => ({
        workUnitId: dependency.workUnitId,
        changedFiles: dependency.changedFiles,
        verificationPassed: dependency.verificationPassed,
      })) ?? [],
    })),
  });
}

function contextStateOf(input: WorkReadinessInput): WorkReadinessContextState {
  if (input.compilation?.ok === false) {
    return input.compilation.failure.kind === 'AMBIGUOUS_TARGET' ? 'AMBIGUOUS' : 'INSUFFICIENT';
  }
  const quality = qualityOf(input);
  if (quality?.targetAmbiguity === true) return 'AMBIGUOUS';
  return quality?.contextSufficient === true ? 'SUFFICIENT' : 'INSUFFICIENT';
}

function dependencyStateOf(input: WorkReadinessInput): DependencyReadinessState {
  if (input.dependencyState !== undefined) return input.dependencyState;
  if ((input.missingDependencyIds?.length ?? 0) > 0) return 'INCOMPLETE';
  if (qualityOf(input)?.dependencyContextComplete === false) return 'INCOMPLETE';
  return 'READY';
}

const EXTERNAL_UNKNOWN_PATTERN =
  /\b(?:unknown|unresolved|determine|investigate|research)\b[^\n]{0,100}\b(?:external|third[- ]party|vendor|library|sdk|protocol|remote api|current api)\b|\b(?:external|third[- ]party|vendor|library|sdk|protocol|remote api|current api)\b[^\n]{0,100}\b(?:unknown|unresolved|semantics?|behavio[u]?r)\b/i;
const UNCERTAIN_PATTERN =
  /\b(?:unresolved|uncertain|unknown which|ambiguous ownership|conflicting evidence|which .{0,60} authoritative|root cause)\b/i;
const HIGH_ENTROPY_PATTERN =
  /\b(?:design|choose|decide|architect|architecture boundary|consistency semantics|transaction strategy|distributed transaction|concurren(?:cy|t)|race condition|compare[- ]and[- ]swap|\bCAS\b|ordering guarantees?|delivery semantics|security[- ]sensitive|root cause|ambiguous ownership|reconcile semantics|replace .{0,50} architecture)\b/i;
const LOW_ENTROPY_PATTERN =
  /\b(?:add (?:a |the )?field|propagat\w*|dto|mapper|mapping|seriali[sz]\w*|controller wiring|wire\w*|fixture|rename|boilerplate|scaffold|existing interface|nearby pattern|validation rule|mechanical|find[- ]and[- ]replace)\b/i;
const ABSTRACT_PATTERN =
  /\b(?:improve|rethink|moderni[sz]e|redesign|refactor the architecture|improve .{0,50} architecture)\b/i;
const BROAD_SCOPE_PATTERN =
  /\b(?:repository[- ]wide|across unrelated modules|all modules|new architecture boundary|replace .{0,60} architecture|architecture[- ]wide migration|system[- ]wide migration|replace event[- ]driven architecture)\b/i;
const AUTHORITY_PATTERN =
  /\b(?:whether .{0,100}(?:visible|retained|allowed|public|compatible)|product behavio[u]?r|compatibility promise|sensitive data visibility|deleted records? remain visible|retention policy|user[- ]facing semantics|choose .{0,60} product|decide .{0,60} product)\b/i;
const CONTRACT_MUTATION_PATTERN =
  /\b(?:change|revise|break|deprecate|replace|relax|tighten)\b[^\n]{0,100}\b(?:contract|public api|api compatibility|compatibility guarantee|wire format)\b|\b(?:contract|public api|api compatibility|compatibility guarantee|wire format)\b[^\n]{0,100}\b(?:change|revision|breaking|deprecat)\b/i;
const STRONG_VERIFICATION_PATTERN =
  /\b(?:test|tests|vitest|jest|pytest|mocha|cargo test|go test|dotnet test|integration|e2e|schema|fixture|verify|verification|snapshot)\b/i;

function resolvedResearch(records: readonly ResearchRecord[]): ResearchRecord[] {
  return records.filter((record) => {
    const report = record.status === 'COMPLETED' ? record.report : undefined;
    if (report === undefined || report.unresolved.length > 0 || report.conflicts.length > 0) return false;
    return report.findings.some(
      (finding) =>
        finding.kind === 'DOMAIN_FACT'
        || finding.kind === 'ENGINEERING_CONSTRAINT'
        || finding.kind === 'COMPATIBILITY_FACT',
    );
  });
}

function knowledgeStateOf(input: WorkReadinessInput, records: readonly ResearchRecord[]): KnowledgeState {
  const text = workText(input.workUnit);
  if (resolvedResearch(records).length > 0) return 'RESOLVED_BY_RESEARCH';
  if (EXTERNAL_UNKNOWN_PATTERN.test(text)) return 'EXTERNAL_UNKNOWN';
  if (UNCERTAIN_PATTERN.test(text)) return 'UNCERTAIN';
  return 'KNOWN';
}

function implementationSpecificityOf(input: WorkReadinessInput): ImplementationSpecificity {
  const text = workText(input.workUnit);
  const quality = qualityOf(input);
  if (quality?.explicitTargetResolved === true) return 'CONCRETE';
  const artifactLooksConcrete = input.workUnit.expectedArtifacts.some(
    (artifact) => /(?:^|\/)[^/]+\.[A-Za-z0-9]+$/.test(artifact) || /\b(?:class|interface|method|function|field|symbol)\b/i.test(artifact),
  );
  if (artifactLooksConcrete && quality?.contextSufficient === true) return 'CONCRETE';
  if (ABSTRACT_PATTERN.test(text) && input.workUnit.expectedAreas.length === 0) return 'ABSTRACT';
  if (
    input.workUnit.expectedAreas.length > 0
    || (input.packet?.targets.length ?? 0) > 0
    || quality?.contextSufficient === true
  ) return 'BOUNDED';
  return 'ABSTRACT';
}

function decisionEntropyOf(
  input: WorkReadinessInput,
  specificity: ImplementationSpecificity,
): DecisionEntropy {
  const text = workText(input.workUnit);
  const quality = qualityOf(input);
  if (HIGH_ENTROPY_PATTERN.test(text)) return 'HIGH';
  if (
    LOW_ENTROPY_PATTERN.test(text)
    && specificity === 'CONCRETE'
    && (quality?.explicitTargetResolved === true || quality?.referencePatternFound === true)
  ) return 'LOW';
  if (
    specificity === 'CONCRETE'
    && quality?.referencePatternFound === true
    && quality.testsFound
  ) return 'LOW';
  return 'MEDIUM';
}

function verificationStrengthOf(input: WorkReadinessInput): WorkReadinessVerificationStrength {
  if (input.verificationCommands.length === 0) return 'NONE';
  const rendered = input.verificationCommands
    .map((command) => `${command.name} ${command.argv.join(' ')}`)
    .join('\n');
  return STRONG_VERIFICATION_PATTERN.test(rendered) ? 'STRONG' : 'WEAK';
}

function repositoryMutationScopeOf(input: WorkReadinessInput): RepositoryMutationScope {
  const text = workText(input.workUnit);
  if (BROAD_SCOPE_PATTERN.test(text)) return 'BROAD';
  const quality = qualityOf(input);
  if (
    quality?.explicitTargetResolved !== true
    && input.workUnit.expectedAreas.length === 0
    && (input.packet?.targets.length ?? 0) === 0
  ) return 'UNKNOWN';
  return 'BOUNDED';
}

function hasApprovedAuthority(input: WorkReadinessInput): boolean {
  return input.workUnit.operatorDecision !== undefined || input.projection.decisions.length > 0;
}

function researchCarriesUnapprovedProductOption(records: readonly ResearchRecord[]): boolean {
  return records.some((record) =>
    record.report !== undefined
    && (
      record.report.classification.includes('PRODUCT_OPTION')
      || record.report.findings.some((finding) => finding.kind === 'PRODUCT_OPTION')
      || (
        record.report.recommendations.length > 0
        && (record.lifecycle?.requestedEffect === 'RECOMMENDATION'
          || record.lifecycle?.requestedEffect === 'HUMAN_DECISION_PREPARED')
      )
    ),
  );
}

function reason(
  code: WorkReadinessReasonCode,
  message: string,
  evidenceRefs: readonly string[] = [],
): WorkReadinessReason {
  return workReadinessReasonSchema.parse({
    code,
    message: message.slice(0, 2_000),
    evidenceRefs: [...new Set(evidenceRefs)].sort().slice(0, 30),
  });
}

function uniqueReasons(reasons: readonly WorkReadinessReason[]): WorkReadinessReason[] {
  const byCode = new Map<WorkReadinessReasonCode, WorkReadinessReason>();
  for (const entry of reasons) if (!byCode.has(entry.code)) byCode.set(entry.code, entry);
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code, 'en'));
}

function assessmentBody(
  assessment: Omit<WorkReadinessAssessment, 'contentHash' | 'assessedAt'>,
): string {
  return stableStringify(assessment);
}

export function assessWorkReadiness(input: WorkReadinessInput): WorkReadinessAssessment {
  const identity = buildWorkReadinessInputIdentity(input);
  const inputHash = sha256Hex(stableStringify(identity));
  const research = relevantResearchRecords(input);
  const quality = qualityOf(input);
  const specificity = implementationSpecificityOf(input);
  const entropy = decisionEntropyOf(input, specificity);
  const verification = verificationStrengthOf(input);
  const contextState = contextStateOf(input);
  const dependencyState = dependencyStateOf(input);
  const mutationScope = repositoryMutationScopeOf(input);
  const knowledgeState = knowledgeStateOf(input, research);
  const approvedAuthority = hasApprovedAuthority(input);
  const text = workText(input.workUnit);
  const researchProductOption = researchCarriesUnapprovedProductOption(research);
  const authorityRisk = (AUTHORITY_PATTERN.test(text) || researchProductOption) && !approvedAuthority;
  const contractMutationRisk = CONTRACT_MUTATION_PATTERN.test(text) && !approvedAuthority;
  const packetRef = input.packet === undefined ? [] : [`builder-packet:${input.packet.contentHash}`];
  const projectionRef = [`projection:${input.projection.contentHash}`];
  const researchRefs = research.map((record) => `research:${record.researchId}`);
  const verificationRefs = input.verificationCommands.map((command) => `verification:${command.name}`);
  const dependencyRefs = input.workUnit.dependsOn.map((dependency) => `dependency:${dependency}`);
  const reasons: WorkReadinessReason[] = [];

  if (authorityRisk) {
    reasons.push(reason(
      'AUTHORITY_UNRESOLVED',
      'The WorkUnit still requires an unapproved product or human-authority decision.',
      [...projectionRef, ...researchRefs],
    ));
  } else if (approvedAuthority) {
    reasons.push(reason(
      'APPROVED_AUTHORITY',
      'Relevant approved product authority is present in the durable projection or operator decision.',
      projectionRef,
    ));
  }
  if (contractMutationRisk) {
    reasons.push(reason(
      'CONTRACT_MUTATION_REQUIRED',
      'The WorkUnit proposes changing a public or product contract without a relevant approved decision.',
      projectionRef,
    ));
  }

  if (knowledgeState === 'RESOLVED_BY_RESEARCH') {
    reasons.push(reason('RESEARCH_RESOLVED', 'Relevant completed research resolved the engineering knowledge gap.', researchRefs));
  } else if (knowledgeState === 'EXTERNAL_UNKNOWN') {
    reasons.push(reason(
      'KNOWLEDGE_EXTERNAL_UNKNOWN',
      'A material external or current fact remains unresolved.',
      [...projectionRef, ...researchRefs],
    ));
  } else if (knowledgeState === 'UNCERTAIN') {
    reasons.push(reason(
      'KNOWLEDGE_UNCERTAIN',
      'Material implementation uncertainty remains in the delegated WorkUnit.',
      [...projectionRef, ...packetRef],
    ));
  } else {
    reasons.push(reason('KNOWN_IMPLEMENTATION_FACTS', 'Implementation facts are known from approved truth and repository evidence.', [...projectionRef, ...packetRef]));
  }

  reasons.push(
    entropy === 'HIGH'
      ? reason('HIGH_DECISION_ENTROPY', 'Several materially different implementation choices or semantics remain open.', packetRef)
      : entropy === 'LOW'
        ? reason('LOW_DECISION_ENTROPY', 'The WorkUnit has one strongly indicated implementation shape.', packetRef)
        : reason('MEDIUM_DECISION_ENTROPY', 'The WorkUnit is bounded but retains ordinary implementation choices.', packetRef),
  );

  reasons.push(
    specificity === 'CONCRETE'
      ? reason('CONCRETE_TARGET', 'The implementation target is explicitly resolved and concrete.', packetRef)
      : specificity === 'BOUNDED'
        ? reason('BOUNDED_TARGET', 'The implementation area is bounded by durable repository evidence.', packetRef)
        : reason('ABSTRACT_IMPLEMENTATION', 'The WorkUnit does not identify a sufficiently bounded implementation target.', packetRef),
  );

  reasons.push(
    verification === 'STRONG'
      ? reason('STRONG_VERIFICATION', 'Trusted machine-checkable tests or verifiers are configured.', verificationRefs)
      : verification === 'WEAK'
        ? reason('WEAK_TRUSTED_VERIFICATION', 'Only weak trusted verification such as compile or lint is configured.', verificationRefs)
        : reason('NO_TRUSTED_VERIFICATION', 'No trusted machine-checkable verification is configured.'),
  );
  if (quality?.testsFound === true) {
    reasons.push(reason('TEST_COVERAGE_AVAILABLE', 'Phase 5 selected relevant tests for the target.', packetRef));
  }
  if (quality?.referencePatternFound === true) {
    reasons.push(reason('REFERENCE_PATTERN_AVAILABLE', 'Phase 5 selected an established implementation pattern.', packetRef));
  }

  reasons.push(
    contextState === 'SUFFICIENT'
      ? reason('CONTEXT_SUFFICIENT', 'Phase 5 reports sufficient, fresh, bounded implementation context.', packetRef)
      : contextState === 'AMBIGUOUS'
        ? reason('TARGET_AMBIGUOUS', 'Phase 5 found more than one materially plausible target.', packetRef)
        : reason('CONTEXT_INSUFFICIENT', 'Phase 5 could not assemble sufficient bounded implementation context.', packetRef),
  );

  if (mutationScope === 'BROAD') {
    reasons.push(reason('BROAD_MUTATION_SCOPE', 'The WorkUnit crosses an architecture-wide or unrelated-module boundary.', packetRef));
  } else if (mutationScope === 'UNKNOWN') {
    reasons.push(reason('UNKNOWN_MUTATION_SCOPE', 'The expected repository mutation surface is not bounded.', packetRef));
  }

  if (dependencyState === 'READY') {
    reasons.push(reason('DEPENDENCIES_READY', 'All declared dependency evidence is verified and current.', dependencyRefs));
  } else if (dependencyState === 'STALE') {
    reasons.push(reason('DEPENDENCY_STALE', 'At least one dependency changed after the readiness inputs were assembled.', dependencyRefs));
  } else if (dependencyState === 'AMBIGUOUS') {
    reasons.push(reason('DEPENDENCY_AMBIGUOUS', 'Dependency evidence cannot be resolved to one current candidate.', dependencyRefs));
  } else {
    reasons.push(reason('DEPENDENCY_NOT_READY', 'At least one declared dependency lacks an accepted verified candidate.', dependencyRefs));
  }

  if (input.parentObjectiveComplexity !== undefined) {
    reasons.push(reason(
      'PARENT_COMPLEXITY_ADVISORY',
      `Parent Objective complexity ${input.parentObjectiveComplexity} is recorded as advisory and does not veto this WorkUnit.`,
    ));
  }

  const evidenceRefs = [...new Set([
    ...projectionRef,
    ...packetRef,
    ...researchRefs,
    ...verificationRefs,
    ...dependencyRefs,
  ])].sort().slice(0, 80);
  const body = {
    schemaVersion: WORK_READINESS_ASSESSMENT_SCHEMA_VERSION,
    assessmentId: `${input.workUnit.workUnitId}-a${String(input.attempt).padStart(2, '0')}-readiness`,
    jobId: input.jobId,
    objectiveNodeId: input.objectiveNodeId,
    workUnitId: input.workUnit.workUnitId,
    attempt: input.attempt,
    parentObjectiveComplexity: input.parentObjectiveComplexity ?? null,
    knowledgeState,
    decisionEntropy: entropy,
    implementationSpecificity: specificity,
    verificationStrength: verification,
    contextState,
    authorityRisk,
    contractMutationRisk,
    repositoryMutationScope: mutationScope,
    dependencyState,
    reasons: uniqueReasons(reasons),
    evidenceRefs,
    inputIdentity: identity,
    inputHash,
  } satisfies Omit<WorkReadinessAssessment, 'contentHash' | 'assessedAt'>;
  return workReadinessAssessmentSchema.parse({
    ...body,
    contentHash: sha256Hex(assessmentBody(body)),
    assessedAt: input.assessedAt ?? new Date().toISOString(),
  });
}

function decisionStatusOf(assessment: WorkReadinessAssessment): SecondaryEligibilityStatus {
  if (assessment.authorityRisk || assessment.contractMutationRisk) return 'NEEDS_AUTHORITY';
  if (assessment.knowledgeState === 'EXTERNAL_UNKNOWN') return 'NEEDS_RESEARCH';
  if (assessment.dependencyState !== 'READY') return 'NOT_READY';
  if (assessment.contextState !== 'SUFFICIENT') return 'NEEDS_CONTEXT';
  if (
    assessment.knowledgeState === 'UNCERTAIN'
    || assessment.decisionEntropy === 'HIGH'
    || assessment.implementationSpecificity === 'ABSTRACT'
    || assessment.verificationStrength !== 'STRONG'
    || assessment.repositoryMutationScope !== 'BOUNDED'
  ) return 'STRONG_REQUIRED';
  return 'ELIGIBLE';
}

const DECISION_REASON_CODES: Readonly<Record<SecondaryEligibilityStatus, readonly WorkReadinessReasonCode[]>> = {
  NEEDS_AUTHORITY: ['AUTHORITY_UNRESOLVED', 'CONTRACT_MUTATION_REQUIRED'],
  NEEDS_RESEARCH: ['KNOWLEDGE_EXTERNAL_UNKNOWN'],
  NOT_READY: ['DEPENDENCY_NOT_READY', 'DEPENDENCY_STALE', 'DEPENDENCY_AMBIGUOUS'],
  NEEDS_CONTEXT: ['CONTEXT_INSUFFICIENT', 'TARGET_AMBIGUOUS'],
  STRONG_REQUIRED: [
    'KNOWLEDGE_UNCERTAIN',
    'HIGH_DECISION_ENTROPY',
    'ABSTRACT_IMPLEMENTATION',
    'NO_TRUSTED_VERIFICATION',
    'WEAK_TRUSTED_VERIFICATION',
    'BROAD_MUTATION_SCOPE',
    'UNKNOWN_MUTATION_SCOPE',
  ],
  ELIGIBLE: [
    'KNOWN_IMPLEMENTATION_FACTS',
    'RESEARCH_RESOLVED',
    'LOW_DECISION_ENTROPY',
    'MEDIUM_DECISION_ENTROPY',
    'CONCRETE_TARGET',
    'BOUNDED_TARGET',
    'STRONG_VERIFICATION',
    'REFERENCE_PATTERN_AVAILABLE',
    'TEST_COVERAGE_AVAILABLE',
    'CONTEXT_SUFFICIENT',
    'DEPENDENCIES_READY',
  ],
};

function decisionBody(
  decision: Omit<SecondaryEligibilityDecision, 'contentHash' | 'decidedAt'>,
): string {
  return stableStringify(decision);
}

export function readinessAssessmentRef(assessment: Pick<WorkReadinessAssessment, 'workUnitId' | 'attempt'>): string {
  return `readiness/${assessment.workUnitId}-a${String(assessment.attempt).padStart(2, '0')}.json`;
}

export function decideSecondaryEligibility(
  assessment: WorkReadinessAssessment,
  decidedAt = new Date().toISOString(),
): SecondaryEligibilityDecision {
  const status = decisionStatusOf(assessment);
  const relevantCodes = new Set(DECISION_REASON_CODES[status]);
  let reasons = assessment.reasons.filter((entry) => relevantCodes.has(entry.code));
  if (reasons.length === 0) reasons = [assessment.reasons[0]!];
  const body = {
    schemaVersion: SECONDARY_ELIGIBILITY_DECISION_SCHEMA_VERSION,
    decisionId: `${assessment.workUnitId}-a${String(assessment.attempt).padStart(2, '0')}-secondary-eligibility`,
    jobId: assessment.jobId,
    objectiveNodeId: assessment.objectiveNodeId,
    workUnitId: assessment.workUnitId,
    attempt: assessment.attempt,
    status,
    reasons,
    assessmentRef: readinessAssessmentRef(assessment),
    assessmentHash: assessment.contentHash,
  } satisfies Omit<SecondaryEligibilityDecision, 'contentHash' | 'decidedAt'>;
  return secondaryEligibilityDecisionSchema.parse({
    ...body,
    contentHash: sha256Hex(decisionBody(body)),
    decidedAt,
  });
}

export function isWorkReadinessAssessmentFresh(
  assessment: WorkReadinessAssessment,
  input: WorkReadinessInput,
): boolean {
  const identity = buildWorkReadinessInputIdentity(input);
  return assessment.inputHash === sha256Hex(stableStringify(identity));
}

export function assessAndDecideWorkReadiness(
  input: WorkReadinessInput,
  previous?: WorkReadinessRecord | undefined,
): WorkReadinessResult {
  const parsedPrevious = previous === undefined
    ? undefined
    : workReadinessRecordSchema.safeParse({
        assessment: previous.assessment,
        decision: previous.decision,
      });
  if (
    parsedPrevious?.success === true
    && isWorkReadinessAssessmentFresh(parsedPrevious.data.assessment, input)
  ) {
    return { ...parsedPrevious.data, reused: true };
  }
  const assessment = assessWorkReadiness(input);
  const decision = decideSecondaryEligibility(assessment, input.assessedAt);
  return { assessment, decision, reused: false };
}

function emptyCount<T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

export function summarizeWorkReadiness(
  records: readonly WorkReadinessRecord[],
  generatedAt = new Date().toISOString(),
): WorkReadinessTelemetry {
  const statuses = emptyCount(SECONDARY_ELIGIBILITY_STATUSES);
  const reasons = emptyCount(WORK_READINESS_REASON_CODES);
  const entropies = emptyCount(DECISION_ENTROPIES);
  const verification = emptyCount(WORK_READINESS_VERIFICATION_STRENGTHS);
  const contexts = emptyCount(WORK_READINESS_CONTEXT_STATES);
  for (const record of records) {
    statuses[record.decision.status] += 1;
    entropies[record.assessment.decisionEntropy] += 1;
    verification[record.assessment.verificationStrength] += 1;
    contexts[record.assessment.contextState] += 1;
    for (const entry of record.decision.reasons) reasons[entry.code] += 1;
  }
  return workReadinessTelemetrySchema.parse({
    schemaVersion: WORK_READINESS_TELEMETRY_SCHEMA_VERSION,
    assessmentCount: records.length,
    statusCounts: statuses,
    reasonCodeDistribution: reasons,
    decisionEntropyDistribution: entropies,
    verificationStrengthDistribution: verification,
    contextStateDistribution: contexts,
    generatedAt,
  });
}

/** Inspect-only rendering. It exposes categories and evidence, never hidden reasoning. */
export function renderWorkReadiness(record: WorkReadinessRecord): string {
  const { assessment, decision } = record;
  return [
    `WorkUnit ${assessment.workUnitId}`,
    '',
    `Secondary Eligibility: ${decision.status}`,
    '',
    'Readiness:',
    `knowledge: ${assessment.knowledgeState}`,
    `decision entropy: ${assessment.decisionEntropy}`,
    `specificity: ${assessment.implementationSpecificity}`,
    `verification: ${assessment.verificationStrength}`,
    `context: ${assessment.contextState}`,
    `mutation scope: ${assessment.repositoryMutationScope}`,
    `authority risk: ${assessment.authorityRisk ? 'yes' : 'no'}`,
    `contract mutation risk: ${assessment.contractMutationRisk ? 'yes' : 'no'}`,
    `dependencies: ${assessment.dependencyState}`,
    '',
    'Why:',
    ...decision.reasons.map((entry) => `- ${entry.code}: ${entry.message}`),
  ].join('\n');
}

/**
 * Compatibility bridge only. The vNext.2 classifier remains the task-level
 * policy for non-Objective flows; Objective callers may translate a Phase 6
 * decision without re-applying the old parent-complexity heuristics.
 */
export function readinessToLegacySuitability(record: WorkReadinessRecord): SuitabilityAssessment {
  return {
    class: record.decision.status === 'ELIGIBLE' ? 'LOCAL_TRY' : 'STRONG_REQUIRED',
    category: 'objective-secondary-readiness',
    signals: record.decision.reasons.map((entry) => ({
      signal: entry.code.toLowerCase().replaceAll('_', '-'),
      evidence: entry.message,
    })),
  };
}
