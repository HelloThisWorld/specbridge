import { z } from 'zod';
import type { FailureSource } from '../reliability/vocabulary.js';
import { FAILURE_SOURCES } from '../reliability/vocabulary.js';

export const RESEARCH_RECORD_SCHEMA_VERSION = '1.1.0';
export const RESEARCH_TELEMETRY_SCHEMA_VERSION = '1.1.0';
export const RESEARCH_USE_SCHEMA_VERSION = '1.0.0';

export const RESEARCH_LIFECYCLE_PHASES = [
  'CONVERSATION',
  'SPEC_DRAFT',
  'INTAKE_DECISION',
  'RUNTIME_INVESTIGATION',
] as const;
export type ResearchLifecyclePhase = (typeof RESEARCH_LIFECYCLE_PHASES)[number];

export const RESEARCH_LIFECYCLE_EFFECTS = [
  'EVIDENCE',
  'RECOMMENDATION',
  'HUMAN_DECISION_PREPARED',
  'REPLAN',
  'ENGINEERING_CONSTRAINT',
] as const;
export type ResearchLifecycleEffect = (typeof RESEARCH_LIFECYCLE_EFFECTS)[number];

export const RESEARCH_DEPTHS = ['QUICK', 'DEEP'] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

export const RESEARCH_GATE_DECISIONS = [
  'ANSWER_DIRECTLY',
  'REUSE_EXISTING',
  'ENGINEERING_DECISION',
  'ASK_HUMAN',
  'RESEARCH_QUICK',
  'RESEARCH_DEEP',
] as const;
export type ResearchGateDecision = (typeof RESEARCH_GATE_DECISIONS)[number];

export const RESEARCH_FINDING_KINDS = [
  'DOMAIN_FACT',
  'ENGINEERING_CONSTRAINT',
  'COMPATIBILITY_FACT',
  'PRODUCT_OPTION',
  'UNRESOLVED_CONFLICT',
] as const;
export type ResearchFindingKind = (typeof RESEARCH_FINDING_KINDS)[number];

export const RESEARCH_RECORD_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'INCONCLUSIVE',
  'FAILED',
  'CANCELLED',
] as const;
export type ResearchRecordStatus = (typeof RESEARCH_RECORD_STATUSES)[number];

export const RESEARCH_FAILURE_CLASSIFICATIONS = [
  'INVALID_REQUEST',
  'DISABLED',
  'PROVIDER_UNAVAILABLE',
  'AUTHENTICATION',
  'NETWORK',
  'TIMEOUT',
  'MALFORMED_RESPONSE',
  'INCONCLUSIVE_RESEARCH',
  'BUDGET_EXHAUSTED',
  'CANCELLED',
] as const;
export type ResearchFailureClassification =
  (typeof RESEARCH_FAILURE_CLASSIFICATIONS)[number];

export const RESEARCH_PROVIDER_HEALTH_STATUSES = [
  'HEALTHY',
  'DEGRADED',
  'UNAVAILABLE',
  'AUTH_FAILED',
  'UNKNOWN',
] as const;
export type ResearchProviderHealthStatus =
  (typeof RESEARCH_PROVIDER_HEALTH_STATUSES)[number];

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const boundedText = (max: number): z.ZodString => z.string().trim().min(1).max(max);
const boundedTextArray = (maxItems: number, maxText: number) =>
  z.array(boundedText(maxText)).max(maxItems);

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{12,}/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{12,}\b/i,
  /\b(?:api[-_ ]?key|auth[-_ ]?token|access[-_ ]?token|password|secret)\s*[:=]\s*\S{8,}/i,
];

function containsCredentialMaterial(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return SECRET_PATTERNS.some((pattern) => pattern.test(serialized));
}

export const researchRequestSchema = z
  .object({
    researchId: idSchema,
    depth: z.enum(RESEARCH_DEPTHS),
    question: boundedText(4_000),
    topicTags: z
      .array(z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/))
      .max(16)
      .default([]),
    context: z
      .object({
        knownFacts: boundedTextArray(20, 2_000).default([]),
        observedFailures: boundedTextArray(10, 2_000).default([]),
        failedStrategies: boundedTextArray(10, 2_000).default([]),
        constraints: boundedTextArray(20, 2_000).default([]),
        /** References only; never repository bodies or transcripts. */
        contextRefs: z.array(boundedText(512)).max(20).default([]),
      })
      .strict()
      .default({}),
    expectedOutput: z
      .object({
        questionsToAnswer: boundedTextArray(12, 1_000).min(1),
      })
      .strict(),
    sourcePolicy: z
      .object({
        preferPrimarySources: z.boolean().default(true),
        requireSources: z.boolean().default(true),
      })
      .strict()
      .default({}),
    freshness: z
      .object({
        currentFactSensitive: z.boolean().default(false),
        subjectVersion: boundedText(128).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((request, ctx) => {
    const size = Buffer.byteLength(JSON.stringify(request), 'utf8');
    if (size > 64 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bounded research request exceeds 64 KiB' });
    }
    if (containsCredentialMaterial(request)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'research request appears to contain credential material; only bounded non-secret context is allowed',
      });
    }
  });
export type ResearchRequest = z.infer<typeof researchRequestSchema>;

export const researchSourceRefSchema = z
  .object({
    refId: idSchema,
    url: z
      .string()
      .max(2_048)
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      }, 'source URLs must use http or https')
      .optional(),
    title: boundedText(500).optional(),
    providerSourceId: boundedText(256).optional(),
    attribution: boundedText(500).optional(),
  })
  .strict();
export type ResearchSourceRef = z.infer<typeof researchSourceRefSchema>;

export const researchFindingSchema = z
  .object({
    findingId: idSchema,
    statement: boundedText(4_000),
    kind: z.enum(RESEARCH_FINDING_KINDS),
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    sourceRefs: z.array(idSchema).max(16).default([]),
  })
  .strict();
export type ResearchFinding = z.infer<typeof researchFindingSchema>;

export const researchUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    providerReportedCost: z.number().nonnegative().optional(),
    subagentCount: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'usage must contain a provider-reported field');
export type ResearchUsage = z.infer<typeof researchUsageSchema>;

export const researchReportSchema = z
  .object({
    researchId: idSchema,
    provider: idSchema,
    depth: z.enum(RESEARCH_DEPTHS),
    status: z.enum(['COMPLETED', 'INCONCLUSIVE']),
    question: boundedText(4_000),
    findings: z.array(researchFindingSchema).max(64),
    sourceRefs: z.array(researchSourceRefSchema).max(64),
    recommendations: boundedTextArray(32, 2_000),
    unresolved: boundedTextArray(32, 2_000),
    conflicts: boundedTextArray(32, 2_000),
    classification: z.array(z.enum(RESEARCH_FINDING_KINDS)).max(5),
    usage: researchUsageSchema.optional(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > 256 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bounded research report exceeds 256 KiB' });
    }
    const sourceIds = new Set(report.sourceRefs.map((ref) => ref.refId));
    for (const [index, finding] of report.findings.entries()) {
      for (const ref of finding.sourceRefs) {
        if (!sourceIds.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['findings', index, 'sourceRefs'],
            message: `unknown source reference "${ref}"`,
          });
        }
      }
    }
    if (report.status === 'COMPLETED' && report.findings.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['findings'], message: 'completed research needs a finding' });
    }
  });
export type ResearchReport = z.infer<typeof researchReportSchema>;

export const researchFailureSchema = z
  .object({
    classification: z.enum(RESEARCH_FAILURE_CLASSIFICATIONS),
    failureSource: z.enum(FAILURE_SOURCES) as z.ZodType<FailureSource>,
    message: boundedText(2_000),
    retryable: z.boolean(),
  })
  .strict();
export type ResearchFailure = z.infer<typeof researchFailureSchema>;

export const researchRecordSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default(RESEARCH_RECORD_SCHEMA_VERSION),
    researchId: idSchema,
    provider: idSchema,
    depth: z.enum(RESEARCH_DEPTHS),
    status: z.enum(RESEARCH_RECORD_STATUSES),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    normalizedQuestionHash: z.string().regex(/^[a-f0-9]{64}$/),
    topicTags: z.array(z.string().min(1).max(64)).max(16),
    request: researchRequestSchema,
    scope: z
      .object({ operationId: idSchema.optional(), jobId: idSchema.optional() })
      .strict()
      .optional(),
    lifecycle: z
      .object({
        phase: z.enum(RESEARCH_LIFECYCLE_PHASES),
        reason: boundedText(1_000),
        requestedEffect: z.enum(RESEARCH_LIFECYCLE_EFFECTS).default('EVIDENCE'),
        usedBy: boundedText(256).optional(),
      })
      .strict()
      .optional(),
    report: researchReportSchema.optional(),
    failure: researchFailureSchema.optional(),
    providerRefs: z
      .object({ threadId: idSchema.optional(), runId: idSchema.optional() })
      .strict()
      .optional(),
    usage: researchUsageSchema.optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.request.researchId !== record.researchId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'researchId'], message: 'must match record researchId' });
    }
    if (record.report !== undefined && record.report.researchId !== record.researchId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report', 'researchId'], message: 'must match record researchId' });
    }
    if (record.request.depth !== record.depth) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'depth'], message: 'must match record depth' });
    }
    if (record.topicTags.join('\u0000') !== record.request.topicTags.join('\u0000')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['topicTags'], message: 'must match request topicTags' });
    }
    if (record.report !== undefined) {
      if (record.report.provider !== record.provider) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report', 'provider'], message: 'must match record provider' });
      }
      if (record.report.depth !== record.depth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report', 'depth'], message: 'must match record depth' });
      }
      if (record.report.question !== record.request.question) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report', 'question'], message: 'must match request question' });
      }
    }
    if (record.status === 'COMPLETED' || record.status === 'INCONCLUSIVE') {
      if (record.report === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report'], message: `${record.status} records require a report` });
      } else if (record.report.status !== record.status) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report', 'status'], message: 'must match record status' });
      }
      if (record.failure !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failure'], message: `${record.status} records cannot carry a failure` });
      }
    } else if (record.status === 'FAILED' || record.status === 'CANCELLED') {
      if (record.failure === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failure'], message: `${record.status} records require a failure` });
      }
      if (record.report !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report'], message: `${record.status} records cannot carry a report` });
      }
    } else if (record.report !== undefined || record.failure !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${record.status} records cannot carry a final report or failure`,
      });
    }
  });
export type ResearchRecord = z.infer<typeof researchRecordSchema>;

export const researchUseRecordSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default(RESEARCH_USE_SCHEMA_VERSION),
    useId: idSchema,
    researchId: idSchema,
    phase: z.enum(RESEARCH_LIFECYCLE_PHASES),
    reason: boundedText(1_000),
    useKind: z.enum(['NEW', 'REUSED']),
    effect: z.enum(RESEARCH_LIFECYCLE_EFFECTS),
    usedBy: boundedText(256).optional(),
    authority: z.literal('EVIDENCE_ONLY'),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ResearchUseRecord = z.infer<typeof researchUseRecordSchema>;

export const researchProviderHealthSchema = z
  .object({
    provider: idSchema,
    status: z.enum(RESEARCH_PROVIDER_HEALTH_STATUSES),
    checkedAt: z.string().datetime({ offset: true }),
    latencyMs: z.number().int().nonnegative().optional(),
    detail: z.string().min(1).max(1_000).optional(),
  })
  .strict();
export type ResearchProviderHealth = z.infer<typeof researchProviderHealthSchema>;

export type ResearchExecutionResult =
  | { ok: true; reused: boolean; record: ResearchRecord; report: ResearchReport }
  | { ok: false; failure: ResearchFailure; record?: ResearchRecord };

export type ResearchProviderExecutionResult =
  | {
      ok: true;
      report: ResearchReport;
      providerRefs?: { threadId?: string; runId?: string };
    }
  | {
      ok: false;
      failure: ResearchFailure;
      providerRefs?: { threadId?: string; runId?: string };
    };

export interface ResearchBridge {
  providerId(): string;
  health(signal?: AbortSignal): Promise<ResearchProviderHealth>;
  investigate(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchProviderExecutionResult>;
}

export const researchGateInputSchema = z
  .object({
    knowledgeGapDeclared: z.boolean(),
    dependsOnExternalFacts: z.boolean(),
    dependsOnCurrentFacts: z.boolean(),
    materialToProductOrArchitecture: z.boolean(),
    repositoryAnswerAvailable: z.boolean(),
    priorResearchAvailable: z.boolean(),
    engineeringDecisionOnly: z.boolean(),
    requiresHumanAuthority: z.boolean(),
    repeatedUnknown: z.boolean().default(false),
    repeatedUnknownAfterDifferentStrategies: z.boolean().default(false),
    requestedDepth: z.enum(RESEARCH_DEPTHS).optional(),
  })
  .strict();
export type ResearchGateInput = z.infer<typeof researchGateInputSchema>;

export interface ResearchGateResult {
  decision: ResearchGateDecision;
  reasons: string[];
}

export const UNKNOWN_CLASSIFICATIONS = [
  'KNOWN_BY_MODEL',
  'KNOWN_BY_REPOSITORY',
  'KNOWN_BY_PRIOR_RESEARCH',
  'ENGINEERING_DECISION',
  'EXTERNAL_KNOWLEDGE_GAP',
  'PRODUCT_AUTHORITY',
  'UNRESOLVED',
] as const;
export type UnknownClassification = (typeof UNKNOWN_CLASSIFICATIONS)[number];

export const decisionBriefOptionSchema = z
  .object({
    id: idSchema,
    label: boundedText(200),
    description: boundedText(1_500),
    consequences: boundedTextArray(12, 1_000).default([]),
  })
  .strict();

export const decisionBriefSchema = z
  .object({
    questionId: idSchema,
    question: boundedText(4_000),
    context: boundedTextArray(24, 2_000).default([]),
    options: z.array(decisionBriefOptionSchema).max(8).default([]),
    recommendation: z
      .object({
        optionId: idSchema,
        rationale: boundedTextArray(12, 1_000).min(1),
      })
      .strict()
      .optional(),
    researchRefs: z.array(idSchema).max(20).default([]),
    repositoryEvidenceRefs: boundedTextArray(20, 512).default([]),
    requiresHumanDecision: z.literal(true),
    researchOutcome: z
      .enum(['NOT_NEEDED', 'REUSED', 'COMPLETED', 'INCONCLUSIVE', 'UNAVAILABLE', 'BUDGET_LIMITED'])
      .default('NOT_NEEDED'),
  })
  .strict()
  .superRefine((brief, ctx) => {
    if (
      brief.recommendation !== undefined &&
      !brief.options.some((option) => option.id === brief.recommendation?.optionId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendation', 'optionId'],
        message: 'must identify an option in this brief',
      });
    }
  });
export type DecisionBrief = z.infer<typeof decisionBriefSchema>;
