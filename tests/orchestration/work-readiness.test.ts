import { describe, expect, it } from 'vitest';
import type { VerificationCommand } from '@specbridge/core';
import { sha256Hex } from '@specbridge/core';
import type {
  ContextProjection,
  DependencyReadinessState,
  SecondaryBuilderPacket,
  WorkReadinessInput,
  WorkUnit,
} from '@specbridge/orchestration';
import {
  assessAndDecideWorkReadiness,
  assessWorkReadiness,
  buildSecondaryBuilderPacket,
  contextProjectionSchema,
  decideSecondaryEligibility,
  isWorkReadinessAssessmentFresh,
  readWorkReadinessRecord,
  readWorkReadinessTelemetry,
  readinessToLegacySuitability,
  renderWorkReadiness,
  researchRecordSchema,
  secondaryEligibilityDecisionSchema,
  storeWorkReadinessRecord,
  storeWorkReadinessTelemetry,
  summarizeWorkReadiness,
  workReadinessAssessmentSchema,
  workReadinessRecordSchema,
  workUnitSchema,
} from '@specbridge/orchestration';
import type { ResearchRecord } from '@specbridge/orchestration';
import { setupExecutionFixture } from '../helpers-execution.js';

const NOW = '2026-08-30T00:00:00.000Z';
const LATER = '2026-08-30T01:00:00.000Z';

const strongVerification: VerificationCommand[] = [
  {
    name: 'unit-tests',
    argv: ['pnpm', 'vitest', 'run', 'tests/account-mapper.test.ts'],
    timeoutMs: 600_000,
    required: true,
  },
];

const weakVerification: VerificationCommand[] = [
  {
    name: 'compile',
    argv: ['pnpm', 'typecheck'],
    timeoutMs: 600_000,
    required: true,
  },
];

function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return workUnitSchema.parse({
    workUnitId: 'wu-mapper',
    objectiveNodeId: 'node-1',
    parentTaskId: 'task-1',
    kind: 'build',
    title: 'Propagate displayName through the account DTO mapper and serializer',
    goal: 'Add the approved displayName field following the nearby mapping pattern.',
    dependsOn: [],
    expectedArtifacts: ['src/account/user-dto.ts', 'src/account/user-mapper.ts'],
    relevantContractIds: ['account-api'],
    relevantAdrIds: [],
    relevantConstitutionRuleIds: [],
    expectedAreas: ['src/account'],
    status: 'READY',
    attempt: 0,
    ...overrides,
  });
}

function projectionFor(
  workUnit: WorkUnit,
  options: {
    decisions?: { decisionId: string; decision: string }[];
    workEvidence?: string[];
    projectionSalt?: string;
  } = {},
): ContextProjection {
  const decisions = options.decisions ?? [];
  const workEvidence = options.workEvidence ?? [];
  const salt = options.projectionSalt ?? 'base';
  return contextProjectionSchema.parse({
    schemaVersion: '1.0.0',
    projectionId: `${workUnit.workUnitId}-a01`,
    jobId: 'job-1',
    objectiveNodeId: workUnit.objectiveNodeId,
    workUnitId: workUnit.workUnitId,
    attempt: 1,
    createdAt: NOW,
    constitution: { version: 1, rules: [] },
    objective: {
      taskId: workUnit.parentTaskId,
      title: 'Implement the account identity feature',
      acceptance: ['The approved account contract is preserved.'],
    },
    workUnit: {
      title: workUnit.title,
      goal: workUnit.goal,
      kind: workUnit.kind,
      expectedArtifacts: workUnit.expectedArtifacts,
      expectedAreas: workUnit.expectedAreas,
    },
    contracts: [
      {
        contractId: 'account-api',
        revision: 2,
        title: 'Account API',
        summary: 'The approved account response contract.',
        requirements: ['displayName is an optional string.'],
        invariants: ['Existing null semantics remain unchanged.'],
      },
    ],
    adrs: [],
    decisions,
    specExcerpts: [],
    workEvidence,
    contractSnapshotHash: sha256Hex(`contract-${salt}`),
    contentHash: sha256Hex(JSON.stringify({ workUnit: workUnit.title, decisions, workEvidence, salt })),
  });
}

interface PacketOptions {
  contextSufficient?: boolean;
  targetAmbiguity?: boolean;
  explicitTargetResolved?: boolean;
  testsFound?: boolean;
  referencePatternFound?: boolean;
  dependencyContextComplete?: boolean;
  sourceSalt?: string;
}

function packetFor(projection: ContextProjection, options: PacketOptions = {}): SecondaryBuilderPacket {
  const sourceSalt = options.sourceSalt ?? 'base';
  const sourceContent = `export interface UserDto { displayName?: string } // ${sourceSalt}\n`;
  const testContent = 'export const expected = { displayName: "Ada" };\n';
  const referenceContent = 'export const map = (source: Source): Target => ({ value: source.value });\n';
  return buildSecondaryBuilderPacket({
    projection,
    sourceContext: [
      {
        path: 'src/account/user-dto.ts',
        contentHash: sha256Hex(sourceContent),
        content: sourceContent,
      },
    ],
    tests: [
      {
        path: 'tests/account/user-mapper.test.ts',
        contentHash: sha256Hex(testContent),
        content: testContent,
      },
    ],
    referencePatterns: [
      {
        path: 'src/account/reference-mapper.ts',
        contentHash: sha256Hex(referenceContent),
        content: referenceContent,
        reason: 'REFERENCE_PATTERN',
      },
    ],
    verificationHints: ['unit-tests'],
    quality: {
      explicitTargetResolved: options.explicitTargetResolved ?? true,
      targetAmbiguity: options.targetAmbiguity ?? false,
      testsFound: options.testsFound ?? true,
      verificationHintsAvailable: true,
      referencePatternFound: options.referencePatternFound ?? true,
      dependencyContextComplete: options.dependencyContextComplete ?? true,
      sourceBudgetUtilization: 0.2,
      contextSufficient: options.contextSufficient ?? true,
    },
    createdAt: NOW,
  });
}

interface InputOptions extends PacketOptions {
  unit?: Partial<WorkUnit>;
  decisions?: { decisionId: string; decision: string }[];
  workEvidence?: string[];
  projectionSalt?: string;
  parentComplexity?: 'LOW' | 'MEDIUM' | 'HIGH';
  verificationCommands?: VerificationCommand[];
  dependencyState?: DependencyReadinessState;
  missingDependencyIds?: string[];
  researchRecords?: ResearchRecord[];
  relevantResearchIds?: string[];
  assessedAt?: string;
}

function readinessInput(options: InputOptions = {}): WorkReadinessInput {
  const workUnit = unit(options.unit);
  const projection = projectionFor(workUnit, {
    ...(options.decisions !== undefined ? { decisions: options.decisions } : {}),
    ...(options.workEvidence !== undefined ? { workEvidence: options.workEvidence } : {}),
    ...(options.projectionSalt !== undefined ? { projectionSalt: options.projectionSalt } : {}),
  });
  return {
    jobId: 'job-1',
    objectiveNodeId: workUnit.objectiveNodeId,
    workUnit,
    projection,
    attempt: 1,
    parentObjectiveComplexity: options.parentComplexity ?? 'MEDIUM',
    packet: packetFor(projection, options),
    verificationCommands: options.verificationCommands ?? strongVerification,
    ...(options.dependencyState !== undefined ? { dependencyState: options.dependencyState } : {}),
    ...(options.missingDependencyIds !== undefined ? { missingDependencyIds: options.missingDependencyIds } : {}),
    ...(options.researchRecords !== undefined ? { researchRecords: options.researchRecords } : {}),
    ...(options.relevantResearchIds !== undefined ? { relevantResearchIds: options.relevantResearchIds } : {}),
    assessedAt: options.assessedAt ?? NOW,
  };
}

function completedResearch(options: { productOption?: boolean; id?: string } = {}): ResearchRecord {
  const researchId = options.id ?? 'research-api-semantics';
  const productOption = options.productOption ?? false;
  const question = productOption
    ? 'Which deleted-record visibility behavior should the product choose?'
    : 'What exact constraint does the current vendor API require?';
  const kind = productOption ? 'PRODUCT_OPTION' : 'ENGINEERING_CONSTRAINT';
  return researchRecordSchema.parse({
    schemaVersion: '1.1.0',
    researchId,
    provider: 'deterministic-fixture',
    depth: 'QUICK',
    status: 'COMPLETED',
    requestHash: sha256Hex(`${researchId}-request`),
    normalizedQuestionHash: sha256Hex(question.toLowerCase()),
    topicTags: ['vendor-api'],
    request: {
      researchId,
      depth: 'QUICK',
      question,
      topicTags: ['vendor-api'],
      context: {},
      expectedOutput: { questionsToAnswer: ['Resolve the material fact.'] },
      sourcePolicy: {},
      freshness: {},
    },
    lifecycle: {
      phase: 'RUNTIME_INVESTIGATION',
      reason: 'The dependent WorkUnit needed external evidence.',
      requestedEffect: productOption ? 'HUMAN_DECISION_PREPARED' : 'ENGINEERING_CONSTRAINT',
      usedBy: 'wu-mapper',
    },
    report: {
      researchId,
      provider: 'deterministic-fixture',
      depth: 'QUICK',
      status: 'COMPLETED',
      question,
      findings: [
        {
          findingId: `${researchId}-finding`,
          statement: productOption
            ? 'Option A is recommended, but remains a product choice.'
            : 'The vendor requires a stable idempotency key per request.',
          kind,
          confidence: 'HIGH',
          sourceRefs: [],
        },
      ],
      sourceRefs: [],
      recommendations: productOption ? ['Choose option A.'] : [],
      unresolved: [],
      conflicts: [],
      classification: [kind],
      startedAt: NOW,
      completedAt: LATER,
    },
    createdAt: NOW,
    updatedAt: LATER,
  });
}

function decision(options: InputOptions = {}) {
  const input = readinessInput(options);
  const assessment = assessWorkReadiness(input);
  return { input, assessment, decision: decideSecondaryEligibility(assessment, NOW) };
}

describe('Phase 6 WorkReadinessAssessment', () => {
  it('admits concrete mechanical DTO propagation even under a HIGH parent Objective', () => {
    const result = decision({ parentComplexity: 'HIGH' });
    expect(result.assessment).toMatchObject({
      knowledgeState: 'KNOWN',
      decisionEntropy: 'LOW',
      implementationSpecificity: 'CONCRETE',
      verificationStrength: 'STRONG',
      contextState: 'SUFFICIENT',
      authorityRisk: false,
      contractMutationRisk: false,
      repositoryMutationScope: 'BOUNDED',
      dependencyState: 'READY',
      parentObjectiveComplexity: 'HIGH',
    });
    expect(result.decision.status).toBe('ELIGIBLE');
    expect(result.assessment.reasons.some((reason) => reason.code === 'PARENT_COMPLEXITY_ADVISORY')).toBe(true);
  });

  it('does not confuse a 20-file mechanical propagation with high decision entropy', () => {
    const expectedArtifacts = Array.from({ length: 20 }, (_, index) => `src/generated/dto-${index}.ts`);
    const result = decision({
      unit: {
        title: 'Mechanically propagate the approved field through generated DTO mappers',
        goal: 'Follow the existing mapper pattern in every listed generated DTO.',
        expectedArtifacts,
        expectedAreas: ['src/generated'],
      },
    });
    expect(result.assessment.decisionEntropy).toBe('LOW');
    expect(result.assessment.repositoryMutationScope).toBe('BOUNDED');
    expect(result.decision.status).toBe('ELIGIBLE');
  });

  it('requires strong reasoning for a tiny concurrency change with unresolved semantics', () => {
    const result = decision({
      unit: {
        title: 'Adjust three lines in the delivery CAS loop',
        goal: 'Choose ordering and duplicate-delivery semantics for the concurrency race.',
        expectedArtifacts: ['src/delivery/cas.ts'],
        expectedAreas: ['src/delivery'],
      },
    });
    expect(result.assessment.decisionEntropy).toBe('HIGH');
    expect(result.decision.status).toBe('STRONG_REQUIRED');
    expect(result.decision.reasons.map((reason) => reason.code)).toContain('HIGH_DECISION_ENTROPY');
  });

  it('maps Phase 5 ambiguous and insufficient context to NEEDS_CONTEXT', () => {
    const ambiguous = decision({ targetAmbiguity: true, contextSufficient: false });
    expect(ambiguous.assessment.contextState).toBe('AMBIGUOUS');
    expect(ambiguous.decision.status).toBe('NEEDS_CONTEXT');
    expect(ambiguous.decision.reasons[0]?.code).toBe('TARGET_AMBIGUOUS');

    const insufficient = decision({ contextSufficient: false, explicitTargetResolved: false });
    expect(insufficient.assessment.contextState).toBe('INSUFFICIENT');
    expect(insufficient.decision.status).toBe('NEEDS_CONTEXT');
    expect(insufficient.decision.reasons[0]?.code).toBe('CONTEXT_INSUFFICIENT');
  });

  it('never admits work with no trusted verification and conservatively refuses weak verification', () => {
    const none = decision({ verificationCommands: [] });
    expect(none.assessment.verificationStrength).toBe('NONE');
    expect(none.decision.status).toBe('STRONG_REQUIRED');
    expect(none.decision.reasons.map((reason) => reason.code)).toContain('NO_TRUSTED_VERIFICATION');

    const weak = decision({ verificationCommands: weakVerification });
    expect(weak.assessment.verificationStrength).toBe('WEAK');
    expect(weak.decision.status).toBe('STRONG_REQUIRED');
    expect(weak.decision.reasons.map((reason) => reason.code)).toContain('WEAK_TRUSTED_VERIFICATION');
  });

  it('gives human authority and unauthorized contract mutation highest precedence', () => {
    const authority = decision({
      parentComplexity: 'LOW',
      unit: {
        title: 'Implement deleted-record rendering',
        goal: 'Decide whether deleted records remain visible to users.',
      },
      contextSufficient: false,
    });
    expect(authority.assessment.authorityRisk).toBe(true);
    expect(authority.decision.status).toBe('NEEDS_AUTHORITY');

    const contract = decision({
      unit: {
        title: 'Revise account compatibility',
        goal: 'Change the existing API compatibility contract and public API guarantee.',
      },
    });
    expect(contract.assessment.contractMutationRisk).toBe(true);
    expect(contract.decision.status).toBe('NEEDS_AUTHORITY');
    expect(contract.decision.reasons.map((reason) => reason.code)).toContain('CONTRACT_MUTATION_REQUIRED');
  });

  it('distinguishes unresolved external knowledge from strong-reasoning work', () => {
    const result = decision({
      unit: {
        title: 'Implement the vendor API adapter',
        goal: 'Research the unknown current external API semantics before implementing the adapter.',
        expectedArtifacts: ['src/vendor/adapter.ts'],
        expectedAreas: ['src/vendor'],
      },
    });
    expect(result.assessment.knowledgeState).toBe('EXTERNAL_UNKNOWN');
    expect(result.decision.status).toBe('NEEDS_RESEARCH');
  });

  it('allows completed engineering research to make the same bounded work eligible', () => {
    const research = completedResearch();
    const result = decision({
      unit: {
        title: 'Implement the vendor API adapter',
        goal: 'Implement the now-resolved external API constraint in the existing adapter.',
        expectedArtifacts: ['src/vendor/adapter.ts'],
        expectedAreas: ['src/vendor'],
      },
      researchRecords: [research],
    });
    expect(result.assessment.knowledgeState).toBe('RESOLVED_BY_RESEARCH');
    expect(result.decision.status).toBe('ELIGIBLE');
    expect(result.assessment.evidenceRefs).toContain(`research:${research.researchId}`);
  });

  it('does not let a research recommendation substitute for product approval', () => {
    const research = completedResearch({ productOption: true });
    const unapproved = decision({ researchRecords: [research] });
    expect(unapproved.assessment.authorityRisk).toBe(true);
    expect(unapproved.decision.status).toBe('NEEDS_AUTHORITY');

    const approved = decision({
      researchRecords: [research],
      decisions: [{ decisionId: 'decision-visible', decision: 'Approved: deleted records remain visible.' }],
    });
    expect(approved.assessment.authorityRisk).toBe(false);
    expect(approved.decision.status).toBe('ELIGIBLE');
  });

  it('reports incomplete, stale, and ambiguous dependencies as NOT_READY', () => {
    for (const dependencyState of ['INCOMPLETE', 'STALE', 'AMBIGUOUS'] as const) {
      const result = decision({
        unit: { dependsOn: ['wu-schema'] },
        dependencyState,
      });
      expect(result.assessment.dependencyState).toBe(dependencyState);
      expect(result.decision.status).toBe('NOT_READY');
      expect(result.decision.reasons.length).toBeGreaterThan(0);
    }
  });

  it('refuses abstract tasks and broad architecture refactors without using file count', () => {
    const abstract = decision({
      unit: {
        title: 'Improve the workflow engine architecture',
        goal: 'Rethink the workflow engine architecture.',
        expectedArtifacts: [],
        expectedAreas: [],
      },
      explicitTargetResolved: false,
      contextSufficient: true,
    });
    expect(abstract.assessment.implementationSpecificity).toBe('ABSTRACT');
    expect(abstract.decision.status).toBe('STRONG_REQUIRED');

    const broad = decision({
      unit: {
        title: 'Replace event-driven architecture with synchronous request flow',
        goal: 'Perform a repository-wide replacement across unrelated modules.',
      },
    });
    expect(broad.assessment.repositoryMutationScope).toBe('BROAD');
    expect(broad.assessment.decisionEntropy).toBe('HIGH');
    expect(broad.decision.status).toBe('STRONG_REQUIRED');
  });
});

describe('Phase 6 readiness identity, persistence, compatibility, and qualification', () => {
  it('is deterministic and excludes timestamps from semantic assessment and decision hashes', () => {
    const firstInput = readinessInput({ assessedAt: NOW });
    const secondInput = { ...firstInput, assessedAt: LATER };
    const first = assessWorkReadiness(firstInput);
    const second = assessWorkReadiness(secondInput);
    expect(first.assessedAt).not.toBe(second.assessedAt);
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.contentHash).toBe(second.contentHash);
    expect(decideSecondaryEligibility(first, NOW).contentHash)
      .toBe(decideSecondaryEligibility(second, LATER).contentHash);
    expect(workReadinessAssessmentSchema.parse(first)).toEqual(first);
    expect(secondaryEligibilityDecisionSchema.parse(decideSecondaryEligibility(first, NOW)).status)
      .toBe('ELIGIBLE');
  });

  it('invalidates freshness when packet, contract projection, dependency, verification, or research changes', () => {
    const originalInput = readinessInput();
    const original = assessWorkReadiness(originalInput);
    const packetChanged = readinessInput({ sourceSalt: 'changed' });
    const contractChanged = readinessInput({ projectionSalt: 'contract-r3' });
    const dependencyChanged = readinessInput({ dependencyState: 'STALE' });
    const verificationChanged = readinessInput({ verificationCommands: weakVerification });
    const researchChanged = readinessInput({ researchRecords: [completedResearch()] });
    for (const changed of [packetChanged, contractChanged, dependencyChanged, verificationChanged, researchChanged]) {
      expect(isWorkReadinessAssessmentFresh(original, changed)).toBe(false);
    }
  });

  it('reuses a fresh durable assessment without invoking a model or changing timestamps', () => {
    const input = readinessInput();
    const initial = assessAndDecideWorkReadiness(input);
    const reused = assessAndDecideWorkReadiness({ ...input, assessedAt: LATER }, initial);
    expect(initial.reused).toBe(false);
    expect(reused.reused).toBe(true);
    expect(reused.assessment).toEqual(initial.assessment);
    expect(reused.decision).toEqual(initial.decision);
  });

  it('persists inspectable records and aggregate telemetry under Objective runtime state', () => {
    const fixture = setupExecutionFixture({ git: false });
    const input = readinessInput();
    const result = assessAndDecideWorkReadiness(input);
    const record = workReadinessRecordSchema.parse({
      assessment: result.assessment,
      decision: result.decision,
    });
    storeWorkReadinessRecord(fixture.workspace, 'job-1', 'node-1', record);
    storeWorkReadinessTelemetry(
      fixture.workspace,
      'job-1',
      'node-1',
      summarizeWorkReadiness([record], NOW),
    );
    expect(readWorkReadinessRecord(fixture.workspace, 'job-1', 'node-1', 'wu-mapper', 1))
      .toEqual(record);
    expect(readWorkReadinessTelemetry(fixture.workspace, 'job-1', 'node-1')).toMatchObject({
      assessmentCount: 1,
      statusCounts: { ELIGIBLE: 1 },
      decisionEntropyDistribution: { LOW: 1 },
      verificationStrengthDistribution: { STRONG: 1 },
      contextStateDistribution: { SUFFICIENT: 1 },
    });
    expect(renderWorkReadiness(record)).toContain('Secondary Eligibility: ELIGIBLE');
    expect(renderWorkReadiness(record)).toContain('STRONG_VERIFICATION');
  });

  it('bridges Objective readiness to legacy suitability without changing non-Objective policy', () => {
    const eligible = assessAndDecideWorkReadiness(readinessInput());
    const hard = assessAndDecideWorkReadiness(readinessInput({
      unit: {
        title: 'Choose concurrency semantics',
        goal: 'Design ordering guarantees for a race condition.',
      },
    }));
    expect(readinessToLegacySuitability(eligible).class).toBe('LOCAL_TRY');
    expect(readinessToLegacySuitability(hard).class).toBe('STRONG_REQUIRED');
  });

  it('qualifies a realistic 15-WorkUnit mixed graph across every admission outcome', () => {
    const research = completedResearch();
    const scenarios: InputOptions[] = [
      {},
      { unit: { workUnitId: 'wu-serializer', title: 'Add serializer field following the existing pattern' } },
      { unit: { workUnitId: 'wu-controller', title: 'Add controller wiring following the nearby pattern' } },
      { unit: { workUnitId: 'wu-fixtures', title: 'Update deterministic fixtures mechanically' } },
      { unit: { workUnitId: 'wu-algorithm', title: 'Implement a bounded local algorithm', goal: 'Implement the precise bounded algorithm in the resolved target.' } },
      { unit: { workUnitId: 'wu-race', title: 'Adjust a concurrency race', goal: 'Choose CAS ordering and duplicate delivery semantics.' } },
      { unit: { workUnitId: 'wu-abstract', title: 'Improve the workflow architecture', goal: 'Rethink the workflow architecture.', expectedArtifacts: [], expectedAreas: [] }, explicitTargetResolved: false },
      { unit: { workUnitId: 'wu-no-tests' }, verificationCommands: [] },
      { unit: { workUnitId: 'wu-external', goal: 'Research unknown current external API semantics.' } },
      { unit: { workUnitId: 'wu-authority', goal: 'Decide whether deleted records remain visible.' } },
      { unit: { workUnitId: 'wu-contract', goal: 'Change the public API compatibility contract.' } },
      { unit: { workUnitId: 'wu-ambiguous' }, targetAmbiguity: true, contextSufficient: false },
      { unit: { workUnitId: 'wu-context' }, contextSufficient: false, explicitTargetResolved: false },
      { unit: { workUnitId: 'wu-dependency', dependsOn: ['wu-schema'] }, dependencyState: 'INCOMPLETE' },
      { unit: { workUnitId: 'wu-researched', goal: 'Implement the resolved vendor constraint.' }, researchRecords: [research], relevantResearchIds: [research.researchId] },
    ];
    const records = scenarios.map((scenario) => {
      const result = assessAndDecideWorkReadiness(readinessInput(scenario));
      return { assessment: result.assessment, decision: result.decision };
    });
    const telemetry = summarizeWorkReadiness(records, NOW);
    expect(telemetry.assessmentCount).toBe(15);
    expect(telemetry.statusCounts).toEqual({
      ELIGIBLE: 6,
      STRONG_REQUIRED: 3,
      NEEDS_RESEARCH: 1,
      NEEDS_AUTHORITY: 2,
      NEEDS_CONTEXT: 2,
      NOT_READY: 1,
    });
    expect(records.every((record) => record.decision.reasons.length > 0)).toBe(true);
  });
});
