import { z } from 'zod';
import type { DesignStage, JsonObject, ResearchReport } from '@specbridge/core';
import type { ModelEvaluationFinding } from './evaluator.js';

const nonEmpty = z.string().trim().min(1);
const source = z.enum([
  'USER',
  'REPOSITORY',
  'RESEARCH',
  'DERIVED',
  'ENGINEERING_DECISION',
  'ASSUMPTION',
]);

export const questionCandidateSchema = z.object({
  id: z.string().trim().optional(),
  question: nonEmpty,
  whyItMatters: nonEmpty,
  options: z.array(nonEmpty).default([]),
  recommendation: nonEmpty.nullable().default(null),
  blocking: z.boolean().default(true),
  repositoryCanAnswer: z.boolean().default(false),
  stableTechnicalFact: z.boolean().default(false),
  engineeringChoice: z.boolean().default(false),
  externalCurrentFact: z.boolean().default(false),
  definesProductBehavior: z.boolean().default(false),
});

export type QuestionCandidate = z.infer<typeof questionCandidateSchema>;

const sourceReferenceSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  url: z.string().url(),
  publisher: nonEmpty.nullable(),
  accessedAt: z.string().datetime(),
  relevantVersion: nonEmpty.nullable(),
});

export const researchReportSchema = z.object({
  id: nonEmpty,
  normalizedQuestion: nonEmpty,
  question: nonEmpty,
  scope: nonEmpty,
  researchedAt: z.string().datetime(),
  freshnessUntil: z.string().datetime().nullable(),
  findings: z.array(
    z.object({
      id: nonEmpty,
      kind: z.enum(['FACT', 'CONSTRAINT', 'OPTION', 'RECOMMENDATION']),
      statement: nonEmpty,
      sourceIds: z.array(nonEmpty),
    }),
  ),
  sources: z.array(sourceReferenceSchema),
  contradictions: z.array(nonEmpty),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  engineeringImplications: z.array(nonEmpty),
  productImplications: z.array(nonEmpty),
  unresolved: z.array(nonEmpty),
});

export function validateResearchReport(report: unknown): ResearchReport {
  return researchReportSchema.parse(report) as ResearchReport;
}

export const modelEvaluationFindingSchema = z.object({
  dimension: z.enum([
    'COMPLETENESS',
    'GROUNDING',
    'PRODUCT_CLARITY',
    'ARCHITECTURE_COHERENCE',
    'TRADE_OFF_QUALITY',
    'RESEARCH_COVERAGE',
    'SECURITY',
    'RELIABILITY',
    'IMPLEMENTATION_READINESS',
    'ACCEPTANCE_COVERAGE',
    'OPEN_RISKS',
  ]),
  severity: z.enum(['WARN', 'FAIL']),
  message: nonEmpty,
  references: z.array(nonEmpty),
});

export function validateModelEvaluationFindings(
  findings: unknown,
): ModelEvaluationFinding[] {
  return z.array(modelEvaluationFindingSchema).parse(findings) as ModelEvaluationFinding[];
}

export const problemFramingSchema = z.object({
  problemStatement: nonEmpty,
  businessContext: nonEmpty,
  actors: z.array(nonEmpty).min(1),
  goals: z.array(nonEmpty).min(1),
  nonGoals: z.array(nonEmpty).min(1),
  successCriteria: z.array(nonEmpty).min(1),
  knownConstraints: z.array(nonEmpty),
  assumptions: z.array(nonEmpty),
  openQuestions: z.array(questionCandidateSchema),
});

export const functionalRequirementSchema = z.object({
  id: z.string().regex(/^FR-\d{3}$/),
  title: nonEmpty,
  description: nonEmpty,
  actor: nonEmpty.nullable().default(null),
  preconditions: z.array(nonEmpty).default([]),
  behavior: nonEmpty,
  failureBehavior: nonEmpty,
  priority: z.enum(['MUST', 'SHOULD', 'COULD']),
  source,
  sourceRefs: z.array(nonEmpty).default([]),
});

export const functionalRequirementsSchema = z.object({
  requirements: z.array(functionalRequirementSchema).min(1),
});

export const nonFunctionalRequirementSchema = z.object({
  id: z.string().regex(/^NFR-\d{3}$/),
  category: nonEmpty,
  requirement: nonEmpty,
  target: nonEmpty.nullable().default(null),
  source,
  sourceRefs: z.array(nonEmpty).default([]),
});

export const nonFunctionalRequirementsSchema = z.object({
  requirements: z.array(nonFunctionalRequirementSchema).min(1),
});

export const scaleCapacitySchema = z.object({
  applicable: z.boolean(),
  assumptions: z.array(
    z.object({
      statement: nonEmpty,
      source: z.literal('ASSUMPTION'),
    }),
  ),
  estimates: z.array(
    z.object({
      metric: nonEmpty,
      value: nonEmpty,
      method: nonEmpty,
    }),
  ),
});

const architectureComponentSchema = z.object({
  name: nonEmpty,
  responsibility: nonEmpty,
  requirementIds: z.array(z.string().regex(/^(?:FR|NFR)-\d{3}$/)).min(1),
  ownedData: z.array(nonEmpty),
  inboundInterfaces: z.array(nonEmpty),
  outboundInterfaces: z.array(nonEmpty),
  dependencies: z.array(nonEmpty),
  failureModes: z.array(nonEmpty),
  scalingModel: nonEmpty,
  securityBoundary: nonEmpty,
});

export const architectureSchema = z.object({
  summary: nonEmpty,
  mermaid: nonEmpty,
  components: z.array(architectureComponentSchema).min(1),
});

export const deepDivesSchema = z.object({
  topics: z.array(
    z.object({
      name: nonEmpty,
      risk: nonEmpty,
      design: nonEmpty,
      sequenceDiagram: z.string().optional(),
      failureHandling: z.array(nonEmpty),
      tradeOffs: z.array(nonEmpty),
    }),
  ),
});

export const alternativesSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.string().regex(/^ADR-\d{3}$/),
      decision: nonEmpty,
      context: nonEmpty,
      alternatives: z
        .array(
          z.object({
            name: nonEmpty,
            pros: z.array(nonEmpty),
            cons: z.array(nonEmpty),
          }),
        )
        .min(2),
      rationale: nonEmpty,
      consequences: z.array(nonEmpty),
      revisitTrigger: nonEmpty,
    }),
  ),
});

export const dataDesignSchema = z.object({
  applicable: z.boolean(),
  mermaid: z.string(),
  entities: z.array(
    z.object({
      name: nonEmpty,
      meaning: nonEmpty,
      ownership: nonEmpty,
      tenantBoundary: nonEmpty,
      importantFields: z.array(nonEmpty),
      relationships: z.array(nonEmpty),
      indexes: z.array(nonEmpty),
      lifecycle: nonEmpty,
      retention: nonEmpty,
      consistency: nonEmpty,
    }),
  ),
});

export const apiEventsSchema = z.object({
  apis: z.array(
    z.object({
      operation: nonEmpty,
      purpose: nonEmpty,
      authentication: nonEmpty,
      authorization: nonEmpty,
      request: nonEmpty,
      response: nonEmpty,
      errors: z.array(nonEmpty),
      idempotency: nonEmpty,
      pagination: nonEmpty.nullable().default(null),
    }),
  ),
  events: z.array(
    z.object({
      name: nonEmpty,
      producer: nonEmpty,
      consumers: z.array(nonEmpty),
      schema: nonEmpty,
      ordering: nonEmpty,
      delivery: nonEmpty,
      idempotency: nonEmpty,
      retry: nonEmpty,
      poisonHandling: nonEmpty,
    }),
  ),
});

export const reliabilitySchema = z.object({
  failureScenarios: z
    .array(
      z.object({
        scenario: nonEmpty,
        expectedBehavior: nonEmpty,
        detection: nonEmpty,
        recovery: nonEmpty,
      }),
    )
    .min(1),
});

export const securitySchema = z.object({
  controls: z
    .array(
      z.object({
        area: nonEmpty,
        threat: nonEmpty,
        control: nonEmpty,
        verification: nonEmpty,
      }),
    )
    .min(1),
  aiRisks: z.array(
    z.object({
      risk: nonEmpty,
      boundary: nonEmpty,
      mitigation: nonEmpty,
    }),
  ),
});

export const observabilitySchema = z.object({
  technicalMetrics: z.array(nonEmpty),
  businessMetrics: z.array(nonEmpty),
  logs: z.array(nonEmpty),
  traces: z.array(nonEmpty),
  auditEvents: z.array(nonEmpty),
  slos: z.array(nonEmpty),
  alerts: z.array(nonEmpty),
  dashboards: z.array(nonEmpty),
  costMonitoring: z.array(nonEmpty),
  workingSignals: z.array(nonEmpty).min(1),
  failureSignals: z.array(nonEmpty).min(1),
});

export const deploymentMigrationSchema = z.object({
  runtimeTopology: nonEmpty,
  environments: z.array(nonEmpty),
  configuration: z.array(nonEmpty),
  secrets: z.array(nonEmpty),
  deploymentModel: nonEmpty,
  migrationSequencing: z.array(nonEmpty),
  rollback: nonEmpty,
  backupRestore: nonEmpty,
  healthChecks: z.array(nonEmpty),
  brownfield: z.object({
    currentState: nonEmpty,
    targetState: nonEmpty,
    compatibilityConstraints: z.array(nonEmpty),
    stages: z.array(nonEmpty),
    dataMigration: nonEmpty,
    rollback: nonEmpty,
    legacyRemoval: z.array(nonEmpty),
  }),
});

export const acceptanceCriterionSchema = z.object({
  id: z.string().regex(/^AC-\d{3}$/),
  requirementIds: z.array(z.string().regex(/^(?:FR|NFR)-\d{3}$/)).min(1),
  given: nonEmpty,
  when: nonEmpty,
  then: nonEmpty,
  requiredEvidence: nonEmpty,
});

export const testingAcceptanceSchema = z.object({
  unit: z.array(nonEmpty),
  integration: z.array(nonEmpty),
  contract: z.array(nonEmpty),
  security: z.array(nonEmpty),
  tenantIsolation: z.array(nonEmpty),
  migration: z.array(nonEmpty),
  failure: z.array(nonEmpty),
  load: z.array(nonEmpty),
  endToEnd: z.array(nonEmpty),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  implementationGuidance: z.object({
    sequencing: z.array(nonEmpty),
    dependencies: z.array(nonEmpty),
    migrationBoundaries: z.array(nonEmpty),
    architecturalInvariants: z.array(nonEmpty),
    parallelizationBoundaries: z.array(nonEmpty),
    highRiskAreas: z.array(nonEmpty),
  }),
});

const stageSchemas: Record<DesignStage, z.ZodTypeAny> = {
  'problem-framing': problemFramingSchema,
  'functional-requirements': functionalRequirementsSchema,
  'non-functional-requirements': nonFunctionalRequirementsSchema,
  'scale-capacity': scaleCapacitySchema,
  architecture: architectureSchema,
  'critical-deep-dives': deepDivesSchema,
  alternatives: alternativesSchema,
  'data-design': dataDesignSchema,
  'api-events': apiEventsSchema,
  reliability: reliabilitySchema,
  security: securitySchema,
  observability: observabilitySchema,
  'deployment-migration': deploymentMigrationSchema,
  'testing-acceptance': testingAcceptanceSchema,
};

export function validateStageOutput(stage: DesignStage, output: unknown): JsonObject {
  return stageSchemas[stage].parse(output) as JsonObject;
}
