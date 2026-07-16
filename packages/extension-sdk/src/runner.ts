import { z } from 'zod';

/**
 * Protocol-level mirror of the frozen v0.6.0 SpecBridge runner adapter
 * contract. Runner extensions implement these JSON payloads; on the host
 * side an extension-runner proxy translates them into the frozen
 * `AgentRunner` contract without modifying it.
 *
 * The value lists below mirror frozen v0.6.0 vocabulary and must never
 * change independently of it.
 */
export const RUNNER_EXECUTION_OUTCOMES = [
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'timed-out',
  'permission-denied',
  'malformed-output',
  'no-change',
] as const;

export type RunnerExecutionOutcome = (typeof RUNNER_EXECUTION_OUTCOMES)[number];

/** Mirror of the frozen 17-key RunnerCapabilitySet. */
export const RUNNER_CAPABILITY_SET_KEYS = [
  'stageGeneration',
  'stageRefinement',
  'taskExecution',
  'taskResume',
  'structuredFinalOutput',
  'streamingEvents',
  'repositoryRead',
  'repositoryWrite',
  'sandbox',
  'toolRestriction',
  'usageReporting',
  'costReporting',
  'localOnly',
  'requiresNetwork',
  'supportsSystemPrompt',
  'supportsJsonSchema',
  'supportsCancellation',
] as const;

export type RunnerCapabilitySetKey = (typeof RUNNER_CAPABILITY_SET_KEYS)[number];

const capabilityShape = Object.fromEntries(
  RUNNER_CAPABILITY_SET_KEYS.map((key) => [key, z.boolean()]),
) as Record<RunnerCapabilitySetKey, z.ZodBoolean>;

export const runnerCapabilitySetMirrorSchema = z.object(capabilityShape).strict();

export type RunnerCapabilitySetMirror = z.infer<typeof runnerCapabilitySetMirrorSchema>;

export const runnerDiagnosticSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'error']),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2000),
  })
  .strict();

export const runnerDetectInputSchema = z
  .object({
    probeCapabilities: z.boolean().optional(),
    timeoutMs: z.number().int().min(1).optional(),
    /** Present only when repositoryRead or repositoryWrite was granted. */
    workspaceRoot: z.string().min(1).max(1000).optional(),
  })
  .strict();

export type RunnerDetectInput = z.infer<typeof runnerDetectInputSchema>;

export const runnerDetectOutputSchema = z
  .object({
    available: z.boolean(),
    version: z.string().min(1).max(100).optional(),
    authentication: z.enum(['authenticated', 'unauthenticated', 'unknown', 'not-applicable']),
    capabilitySet: runnerCapabilitySetMirrorSchema,
    networkBacked: z.boolean(),
    diagnostics: z.array(runnerDiagnosticSchema).max(100),
  })
  .strict();

export type RunnerDetectOutput = z.infer<typeof runnerDetectOutputSchema>;

const MAX_PROMPT_CHARS = 1024 * 1024;
const MAX_RAW_OUTPUT_CHARS = 2 * 1024 * 1024;

/** Execution options serialized over the protocol (never an AbortSignal). */
export const runnerExecutionEnvelopeSchema = z
  .object({
    timeoutMs: z.number().int().min(1),
    model: z.string().min(1).max(200).optional(),
    maxTurns: z.number().int().min(1).optional(),
    maxBudgetUsd: z.number().min(0).optional(),
    /** Present only when repositoryRead or repositoryWrite was granted. */
    workspaceRoot: z.string().min(1).max(1000).optional(),
    /** Present only when repositoryWrite was granted. */
    runDir: z.string().min(1).max(1000).optional(),
  })
  .strict();

export type RunnerExecutionEnvelope = z.infer<typeof runnerExecutionEnvelopeSchema>;

export const runnerStageInputSchema = z
  .object({
    specName: z.string().min(1).max(200),
    stage: z.string().min(1).max(40),
    intent: z.enum(['generate', 'refine']),
    prompt: z.string().max(MAX_PROMPT_CHARS),
    promptVersion: z.string().min(1).max(40),
    toolPolicy: z.enum(['read-only', 'inspect-only', 'implementation']),
    correction: z
      .object({
        previousOutput: z.string().max(MAX_RAW_OUTPUT_CHARS),
        problems: z.string().max(10_000),
      })
      .strict()
      .optional(),
    execution: runnerExecutionEnvelopeSchema,
  })
  .strict();

export type RunnerStageInput = z.infer<typeof runnerStageInputSchema>;

export const runnerTaskInputSchema = z
  .object({
    specName: z.string().min(1).max(200),
    taskId: z.string().min(1).max(100),
    prompt: z.string().max(MAX_PROMPT_CHARS),
    promptVersion: z.string().min(1).max(40),
    toolPolicy: z.literal('implementation'),
    sessionId: z.string().min(1).max(200).optional(),
    execution: runnerExecutionEnvelopeSchema,
  })
  .strict();

export type RunnerTaskInput = z.infer<typeof runnerTaskInputSchema>;

/** Mirrors the frozen RunnerUsage fields (durationMs is host-measured). */
export const runnerUsageMirrorSchema = z
  .object({
    model: z.string().max(200).nullable().optional(),
    inputTokens: z.number().int().min(0).nullable().optional(),
    cachedInputTokens: z.number().int().min(0).nullable().optional(),
    outputTokens: z.number().int().min(0).nullable().optional(),
    reasoningTokens: z.number().int().min(0).nullable().optional(),
    requestCount: z.number().int().min(0).nullable().optional(),
  })
  .strict();

/** Provider-reported cost only; SpecBridge never computes cost from pricing. */
export const runnerCostMirrorSchema = z
  .object({
    currency: z.string().max(10).nullable().optional(),
    amount: z.number().min(0).nullable().optional(),
  })
  .strict();

const runnerResultBaseShape = {
  outcome: z.enum(RUNNER_EXECUTION_OUTCOMES),
  failureReason: z.string().min(1).max(2000).optional(),
  rawStdout: z.string().max(MAX_RAW_OUTPUT_CHARS),
  rawStderr: z.string().max(MAX_RAW_OUTPUT_CHARS),
  sessionId: z.string().min(1).max(200).optional(),
  durationMs: z.number().int().min(0),
  warnings: z.array(z.string().min(1).max(1000)).max(100),
  /** Structured report claim — JSON matching the frozen report schemas. */
  report: z.record(z.unknown()).optional(),
  usage: runnerUsageMirrorSchema.optional(),
  cost: runnerCostMirrorSchema.optional(),
  invalidStructuredOutput: z.string().max(MAX_RAW_OUTPUT_CHARS).optional(),
};

export const runnerStageOutputSchema = z.object(runnerResultBaseShape).strict();
export type RunnerStageOutput = z.infer<typeof runnerStageOutputSchema>;

export const runnerTaskOutputSchema = z
  .object({
    ...runnerResultBaseShape,
    resumeSupported: z.boolean(),
  })
  .strict();
export type RunnerTaskOutput = z.infer<typeof runnerTaskOutputSchema>;

export const runnerModelListOutputSchema = z
  .object({
    supported: z.boolean(),
    models: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            sizeBytes: z.number().int().min(0).optional(),
            family: z.string().min(1).max(100).optional(),
            parameterSize: z.string().min(1).max(40).optional(),
            quantization: z.string().min(1).max(40).optional(),
            modifiedAt: z.string().min(1).max(60).optional(),
            location: z.enum(['local', 'remote', 'unknown']).optional(),
          })
          .strict(),
      )
      .max(500),
    detail: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type RunnerModelListOutput = z.infer<typeof runnerModelListOutputSchema>;
