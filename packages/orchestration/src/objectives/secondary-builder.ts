import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONTEXT_EXPANSION_LEVELS, CONTEXT_SELECTION_REASONS } from '@specbridge/context';
import type { AgentConfig } from '@specbridge/core';
import { effectiveLocalInputCharacters, sha256Hex } from '@specbridge/core';
import type { LocalModelManager } from '@specbridge/runners';
import { localStructuredInference } from '@specbridge/runners';
import {
  LOCAL_EXECUTION_LIMITS,
  applyValidatedEdits,
  validateEditPaths,
} from '../scheduling/local-execution.js';
import type { BuilderPacketCompiler } from './builder-packet-compiler.js';
import type { ContextProjection } from './state.js';

/**
 * Phase 4's direct-model Objective builder.
 *
 * It is deliberately not an agent harness. The provider receives one
 * bounded request and can return only a strict CREATE/REPLACE document.
 * SpecBridge checks source freshness and path authority, writes the files in
 * the caller-provided isolated worktree, and leaves verification, candidate
 * persistence, evaluation, and integration to the existing Objective
 * runtime.
 */

export const SECONDARY_BUILDER_PACKET_SCHEMA_VERSION = '1.1.0';
export const SECONDARY_BUILDER_RESULT_SCHEMA_VERSION = '1.1.0';
export const SECONDARY_BUILDER_ATTEMPT_SCHEMA_VERSION = '1.1.0';

export const SECONDARY_BUILDER_LIMITS = {
  ...LOCAL_EXECUTION_LIMITS,
  maxSourceFiles: 16,
  maxTests: 6,
  maxReferencePatterns: 4,
  maxDependencyContext: 12,
  maxSourceFileChars: 32_768,
  maxSourceBytes: 262_144,
  maxPacketCharacters: 524_288,
  maxPathChars: 512,
  maxNoteChars: 500,
} as const;

const boundedText = (max: number) => z.string().min(1).max(max);
const shortText = boundedText(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const secondarySourceContextSchema = z
  .object({
    /** Repository namespace. Paths are unique only within this identity. */
    repositoryId: shortText.default('primary'),
    /** Repository-relative path. */
    path: boundedText(SECONDARY_BUILDER_LIMITS.maxPathChars),
    /** Hash of the complete current file bytes. */
    contentHash: sha256,
    /** Hash of the exact bounded content below (whole file or section). */
    sectionHash: sha256.optional(),
    content: z.string().max(SECONDARY_BUILDER_LIMITS.maxSourceFileChars),
    reason: z.enum(CONTEXT_SELECTION_REASONS).default('EXPLICIT_ACTION_REFERENCE'),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    symbols: z.array(shortText).max(12).default([]),
  })
  .strict();
/** Additive input surface keeps Phase 4's three-field source records valid. */
export type SecondarySourceContext = z.input<typeof secondarySourceContextSchema>;
export type NormalizedSecondarySourceContext = z.output<typeof secondarySourceContextSchema>;

export const secondaryBuilderTargetSchema = z
  .object({
    repositoryId: shortText,
    path: boundedText(SECONDARY_BUILDER_LIMITS.maxPathChars),
    symbols: z.array(shortText).max(12).default([]),
    reason: z.enum(CONTEXT_SELECTION_REASONS),
  })
  .strict();

export const secondaryDependencyContextSchema = z
  .object({
    workUnitId: shortText,
    summary: boundedText(2_000),
    changedFiles: z
      .array(
        z
          .object({ repositoryId: shortText, path: boundedText(SECONDARY_BUILDER_LIMITS.maxPathChars) })
          .strict(),
      )
      .max(60),
    exportedSymbols: z.array(shortText).max(30).default([]),
    verificationPassed: z.literal(true),
  })
  .strict();

export const secondaryBuilderPacketMetricsSchema = z
  .object({
    indexedFilesConsidered: z.number().int().min(0),
    candidateCount: z.number().int().min(0),
    selectedFiles: z.number().int().min(0),
    selectedSections: z.number().int().min(0),
    sourceCharacters: z.number().int().min(0),
    testCharacters: z.number().int().min(0),
    referencePatternCount: z.number().int().min(0),
    dependencyContextCount: z.number().int().min(0),
    budgetUtilization: z.number().min(0),
    mandatoryRefsRetained: z.number().int().min(0),
    expansionDepth: z.number().int().min(0).max(4),
    staleEntriesEncountered: z.number().int().min(0),
    selectionDurationMs: z.number().int().min(0),
    indexReused: z.boolean(),
  })
  .strict();

export const secondaryBuilderPacketQualitySchema = z
  .object({
    explicitTargetResolved: z.boolean(),
    targetAmbiguity: z.boolean(),
    testsFound: z.boolean(),
    verificationHintsAvailable: z.boolean(),
    referencePatternFound: z.boolean(),
    dependencyContextComplete: z.boolean(),
    sourceBudgetUtilization: z.number().min(0),
    contextSufficient: z.boolean(),
  })
  .strict();

const projectedContractSchema = z
  .object({
    contractId: shortText,
    revision: z.number().int().min(1),
    title: shortText,
    summary: boundedText(2_000),
    requirements: z.array(boundedText(2_000)).max(30),
    invariants: z.array(boundedText(2_000)).max(30),
  })
  .strict();

export const secondaryBuilderPacketSchema = z
  .object({
    schemaVersion: z.literal(SECONDARY_BUILDER_PACKET_SCHEMA_VERSION),
    packetId: shortText,
    projectionHash: sha256,
    contractSnapshotHash: sha256,
    sourceContextHash: sha256,
    /** Semantic identity; excludes createdAt and observational metrics. */
    contentHash: sha256,
    packetHash: sha256,
    createdAt: shortText.optional(),
    objective: z
      .object({
        nodeId: shortText,
        taskId: shortText,
        title: boundedText(2_000),
        acceptance: z.array(boundedText(2_000)).max(30),
      })
      .strict(),
    workUnit: z
      .object({
        workUnitId: shortText,
        attempt: z.number().int().min(1),
        kind: z.enum(['build', 'investigation']),
        title: boundedText(2_000),
        goal: boundedText(2_000),
        expectedArtifacts: z.array(boundedText(2_000)).max(30),
        expectedAreas: z.array(shortText).max(30),
      })
      .strict(),
    approvedContext: z
      .object({
        constraints: z.array(boundedText(2_000)).max(40),
        contracts: z.array(projectedContractSchema).max(30),
        adrs: z
          .array(z.object({ adrId: shortText, title: shortText, decision: boundedText(2_000) }).strict())
          .max(30),
        decisions: z
          .array(z.object({ decisionId: shortText, decision: boundedText(2_000) }).strict())
          .max(30),
        priorWorkEvidence: z.array(boundedText(2_000)).max(30),
      })
      .strict(),
    sourceContext: z.array(secondarySourceContextSchema).max(SECONDARY_BUILDER_LIMITS.maxSourceFiles),
    targets: z.array(secondaryBuilderTargetSchema).max(SECONDARY_BUILDER_LIMITS.maxSourceFiles),
    tests: z.array(secondarySourceContextSchema).max(SECONDARY_BUILDER_LIMITS.maxTests),
    referencePatterns: z
      .array(secondarySourceContextSchema)
      .max(SECONDARY_BUILDER_LIMITS.maxReferencePatterns),
    dependencyContext: z
      .array(secondaryDependencyContextSchema)
      .max(SECONDARY_BUILDER_LIMITS.maxDependencyContext),
    priorFailureEvidence: z.array(boundedText(2_000)).max(20),
    retrievalPlanRef: shortText,
    retrievalPlanRefs: z.array(shortText).max(12),
    expansion: z
      .object({
        level: z.enum(CONTEXT_EXPANSION_LEVELS),
        remainingLevels: z.number().int().min(0).max(4),
      })
      .strict(),
    contextMetrics: secondaryBuilderPacketMetricsSchema,
    quality: secondaryBuilderPacketQualitySchema,
    forbiddenChanges: z.array(boundedText(1_000)).max(30),
    verificationHints: z.array(boundedText(1_000)).max(30),
  })
  .strict();
export type SecondaryBuilderPacket = z.infer<typeof secondaryBuilderPacketSchema>;

export const secondaryStructuredEditSchema = z
  .object({
    path: boundedText(SECONDARY_BUILDER_LIMITS.maxPathChars),
    operation: z.enum(['CREATE', 'REPLACE']),
    content: z
      .string()
      .max(SECONDARY_BUILDER_LIMITS.maxFileBytes)
      .refine((value) => !value.includes('\0'), 'binary/NUL content is not supported'),
  })
  .strict();
export type SecondaryStructuredEdit = z.infer<typeof secondaryStructuredEditSchema>;

export const secondaryBuilderResultSchema = z
  .object({
    schemaVersion: z.literal(SECONDARY_BUILDER_RESULT_SCHEMA_VERSION),
    status: z.enum(['EDITS', 'NEEDS_MORE_CONTEXT']).default('EDITS'),
    summary: boundedText(SECONDARY_BUILDER_LIMITS.maxSummaryChars),
    edits: z.array(secondaryStructuredEditSchema).max(SECONDARY_BUILDER_LIMITS.maxEdits),
    notes: z
      .array(z.string().max(SECONDARY_BUILDER_LIMITS.maxNoteChars))
      .max(SECONDARY_BUILDER_LIMITS.maxNotes)
      .optional(),
    needsMoreContextReasons: z
      .array(z.string().min(1).max(SECONDARY_BUILDER_LIMITS.maxNoteChars))
      .min(1)
      .max(8)
      .optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'NEEDS_MORE_CONTEXT' && result.needsMoreContextReasons === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['needsMoreContextReasons'], message: 'required when status is NEEDS_MORE_CONTEXT' });
    }
    if (result.status === 'NEEDS_MORE_CONTEXT' && result.edits.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['edits'], message: 'must be empty when more context is required' });
    }
  });
export type SecondaryBuilderResult = z.infer<typeof secondaryBuilderResultSchema>;

export const SECONDARY_BUILDER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'status', 'summary', 'edits'],
  properties: {
    schemaVersion: { type: 'string', const: SECONDARY_BUILDER_RESULT_SCHEMA_VERSION },
    status: { type: 'string', enum: ['EDITS', 'NEEDS_MORE_CONTEXT'] },
    summary: { type: 'string', minLength: 1, maxLength: SECONDARY_BUILDER_LIMITS.maxSummaryChars },
    edits: {
      type: 'array',
      maxItems: SECONDARY_BUILDER_LIMITS.maxEdits,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'operation', 'content'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: SECONDARY_BUILDER_LIMITS.maxPathChars },
          operation: { type: 'string', enum: ['CREATE', 'REPLACE'] },
          content: { type: 'string', maxLength: SECONDARY_BUILDER_LIMITS.maxFileBytes },
        },
      },
    },
    notes: {
      type: 'array',
      maxItems: SECONDARY_BUILDER_LIMITS.maxNotes,
      items: { type: 'string', maxLength: SECONDARY_BUILDER_LIMITS.maxNoteChars },
    },
    needsMoreContextReasons: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: SECONDARY_BUILDER_LIMITS.maxNoteChars },
    },
  },
};

export const SECONDARY_BUILDER_SYSTEM_PROMPT = [
  'You are a bounded SECONDARY OBJECTIVE BUILDER, not an agent harness.',
  'You have no shell, git, filesystem, package-manager, test, credential, or tool access.',
  'The packet contains all approved truth and source bytes you may use.',
  'You have been given the repository context selected for this task; do not explore beyond it.',
  'Do not invent files, APIs, symbols, or architecture unsupported by the packet.',
  'If the packet is insufficient to implement safely, return NEEDS_MORE_CONTEXT with bounded reasons and no edits.',
  'Return exactly one JSON document matching the supplied schema.',
  'Return complete UTF-8 file contents using only CREATE or REPLACE.',
  'Never return Markdown, diffs, commands, deletes, renames, symlinks, or authority/config edits.',
  'SpecBridge will validate paths, apply the proposal inside an isolated worktree, and run trusted verification.',
].join('\n');

export interface SecondaryInferenceRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxOutputBytes: number;
  signal?: AbortSignal | undefined;
}

export type SecondaryInferenceResult =
  | {
      ok: true;
      text: string;
      durationMs: number;
      usage?: { inputTokens: number | null; outputTokens: number | null } | undefined;
      model?: string | undefined;
    }
  | {
      ok: false;
      kind: 'unavailable' | 'timeout' | 'cancelled' | 'invalid';
      problem: string;
      durationMs: number;
    };

/** Provider-neutral inference boundary; Objective execution knows no Qwen details. */
export interface SecondaryModelInference {
  readonly profile: string;
  readonly provider: string;
  readonly model?: string | undefined;
  infer(request: SecondaryInferenceRequest): Promise<SecondaryInferenceResult>;
}

/**
 * Narrow, explicit Phase 4 selection surface. Merely configuring
 * `localInference` does not select this backend; a caller must provide this
 * object and (optionally) constrain it to named WorkUnits.
 */
export interface SecondaryObjectiveBuilderSelection {
  selectionReason: string;
  workUnitIds?: readonly string[] | undefined;
  sourceContext?:
    | readonly SecondarySourceContext[]
    | ((input: {
        worktreeRoot: string;
        projection: ContextProjection;
      }) => readonly SecondarySourceContext[] | Promise<readonly SecondarySourceContext[]>);
  /** Optional provider-neutral compiler seam; the managed deterministic compiler is the default. */
  contextCompiler?: BuilderPacketCompiler | undefined;
  /** Deterministic fake/custom provider seam; omitted means managed local. */
  inference?: SecondaryModelInference | undefined;
}

/** First production adapter: the existing managed, loopback-only llama.cpp endpoint. */
export function managedLocalSecondaryModelInference(
  manager: LocalModelManager,
  config: AgentConfig,
): SecondaryModelInference {
  const local = config.localInference;
  return {
    profile: 'localInference',
    provider: local.provider,
    ...(local.model !== null ? { model: path.basename(local.model) } : {}),
    async infer(request) {
      const startedAt = Date.now();
      const started = await manager.ensureStarted(request.signal);
      if (!started.ok) {
        return {
          ok: false,
          kind: started.kind === 'cancelled' ? 'cancelled' : 'unavailable',
          problem: started.problem,
          durationMs: Date.now() - startedAt,
        };
      }
      manager.touch();
      const result = await localStructuredInference({
        baseUrl: started.baseUrl,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        jsonSchema: request.jsonSchema,
        schemaName: request.schemaName,
        temperature: local.temperature,
        timeoutMs: local.requestTimeoutMs,
        maxOutputBytes: Math.min(local.maxOutputBytes, request.maxOutputBytes),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      if (!result.ok) {
        return {
          ok: false,
          kind:
            result.kind === 'timeout'
              ? 'timeout'
              : result.kind === 'cancelled'
                ? 'cancelled'
                : result.kind === 'invalid-response' || result.kind === 'empty-response'
                  ? 'invalid'
                  : 'unavailable',
          problem: result.problem,
          durationMs: result.durationMs,
        };
      }
      return {
        ok: true,
        text: result.text,
        durationMs: result.durationMs,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(local.model !== null ? { model: path.basename(local.model) } : {}),
      };
    },
  };
}

export const SECONDARY_BUILDER_FAILURES = [
  'INFERENCE_UNAVAILABLE',
  'INVALID_STRUCTURED_OUTPUT',
  'EMPTY_EDIT_SET',
  'FORBIDDEN_EDIT',
  'STALE_APPROVED_PROJECTION',
  'STALE_SOURCE_CONTEXT',
  'APPLY_FAILURE',
  'VERIFICATION_FAILURE',
  'TIMEOUT',
  'CONTEXT_TOO_LARGE',
  'INSUFFICIENT_CONTEXT',
  'AMBIGUOUS_TARGET',
  'CANCELLED',
] as const;
export type SecondaryBuilderFailureKind = (typeof SECONDARY_BUILDER_FAILURES)[number];

export const SECONDARY_BUILDER_ATTEMPT_STATUSES = [
  'PREPARED',
  'INFERENCE_COMPLETED',
  'PROPOSAL_VALIDATED',
  'EDITS_APPLIED',
  'VERIFICATION_FAILED',
  'CONTEXT_INSUFFICIENT',
  'CANDIDATE_READY',
  'FAILED',
] as const;

/**
 * Durable record used for diagnosis and resume. It stores the exact bounded
 * packet and proposal, but never hidden reasoning or provider credentials.
 */
export const secondaryBuilderAttemptSchema = z
  .object({
    schemaVersion: z.literal(SECONDARY_BUILDER_ATTEMPT_SCHEMA_VERSION),
    attemptId: shortText,
    jobId: shortText,
    objectiveNodeId: shortText,
    workUnitId: shortText,
    attempt: z.number().int().min(1),
    status: z.enum(SECONDARY_BUILDER_ATTEMPT_STATUSES),
    builderBackend: z.literal('SECONDARY_DIRECT_MODEL'),
    selectionReason: boundedText(2_000),
    inferenceProfile: shortText,
    provider: shortText,
    model: shortText.optional(),
    packetHash: sha256,
    sourceContextHash: sha256,
    packet: secondaryBuilderPacketSchema,
    rawOutput: z.string().max(LOCAL_EXECUTION_LIMITS.maxTotalBytes).optional(),
    proposal: secondaryBuilderResultSchema.optional(),
    appliedFiles: z.array(shortText).max(SECONDARY_BUILDER_LIMITS.maxEdits).default([]),
    telemetry: z
      .object({
        inputCharacters: z.number().int().min(0),
        outputBytes: z.number().int().min(0),
        sourceFiles: z.number().int().min(0),
        editedFiles: z.number().int().min(0),
        durationMs: z.number().int().min(0),
        inputTokens: z.number().int().min(0).nullable(),
        outputTokens: z.number().int().min(0).nullable(),
      })
      .strict()
      .optional(),
    verification: z
      .object({
        ran: z.boolean(),
        passed: z.boolean(),
        commands: z
          .array(
            z
              .object({
                name: shortText,
                status: shortText,
                exitCode: z.number().int().nullable(),
                stdoutTail: z.string().max(16_384),
                stderrTail: z.string().max(16_384),
              })
              .strict(),
          )
          .max(30),
      })
      .strict()
      .optional(),
    failure: z
      .object({ kind: z.enum(SECONDARY_BUILDER_FAILURES), problem: boundedText(2_000) })
      .strict()
      .optional(),
    createdAt: shortText,
    updatedAt: shortText,
  })
  .passthrough();
export type SecondaryBuilderAttempt = z.infer<typeof secondaryBuilderAttemptSchema>;

export interface SecondaryBuilderTelemetry {
  inputCharacters: number;
  outputBytes: number;
  sourceFiles: number;
  editedFiles: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type SecondaryBuilderExecutionResult =
  | {
      ok: true;
      proposal: SecondaryBuilderResult;
      appliedFiles: string[];
      telemetry: SecondaryBuilderTelemetry;
    }
  | {
      ok: false;
      failure: { kind: SecondaryBuilderFailureKind; problem: string };
      rawOutput?: string | undefined;
      proposal?: SecondaryBuilderResult | undefined;
      appliedFiles: string[];
      telemetry: SecondaryBuilderTelemetry;
    };

export type SecondaryBuilderExecutionEvent =
  | { stage: 'INFERENCE_COMPLETED'; rawOutput: string; telemetry: SecondaryBuilderTelemetry }
  | { stage: 'PROPOSAL_VALIDATED'; proposal: SecondaryBuilderResult; telemetry: SecondaryBuilderTelemetry }
  | { stage: 'EDITS_APPLIED'; proposal: SecondaryBuilderResult; appliedFiles: string[]; telemetry: SecondaryBuilderTelemetry };

export interface ExecuteSecondaryBuilderInput {
  /** The isolated Objective worktree root — never the canonical workspace. */
  worktreeRoot: string;
  packet: SecondaryBuilderPacket;
  inference: SecondaryModelInference;
  maximumInputCharacters: number;
  maxOutputBytes: number;
  protectedPaths?: readonly string[] | undefined;
  /** Roots for explicitly justified secondary repositories in a cross-repo packet. */
  repositoryRoots?: Readonly<Record<string, string>> | undefined;
  signal?: AbortSignal | undefined;
  /** Synchronous durability hook called before mutation and after application. */
  onExecutionEvent?: ((event: SecondaryBuilderExecutionEvent) => void) | undefined;
}

function stableStringify(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stable(item)]),
      );
    }
    return entry;
  };
  return JSON.stringify(stable(value));
}

function packetBody(packet: Omit<SecondaryBuilderPacket, 'packetHash' | 'contentHash'>): string {
  const { createdAt: _createdAt, contextMetrics: _contextMetrics, ...semantic } = packet;
  return stableStringify(semantic);
}

export function sourceContextHashOf(sourceContext: readonly SecondarySourceContext[]): string {
  const normalized = z.array(secondarySourceContextSchema).parse(sourceContext);
  return sha256Hex(
    stableStringify(
      normalized
        .map((entry) => ({
          repositoryId: entry.repositoryId,
          path: entry.path.replace(/\\/g, '/'),
          contentHash: entry.contentHash,
          sectionHash: entry.sectionHash ?? sha256Hex(entry.content),
          startLine: entry.startLine ?? null,
          endLine: entry.endLine ?? null,
        }))
        .sort((left, right) => `${left.repositoryId}:${left.path}`.localeCompare(`${right.repositoryId}:${right.path}`)),
    ),
  );
}

/** Read an explicit caller-selected file set; this is selection, not Phase 5 retrieval. */
export function captureSecondarySourceContext(
  worktreeRoot: string,
  relativePaths: readonly string[],
): SecondarySourceContext[] {
  if (relativePaths.length > SECONDARY_BUILDER_LIMITS.maxSourceFiles) {
    throw new Error(`source context exceeds ${SECONDARY_BUILDER_LIMITS.maxSourceFiles} files`);
  }
  const pathFailures = validateEditPaths(
    { rootDir: worktreeRoot },
    relativePaths.map((filePath) => ({ path: filePath, content: '' })),
    [],
  );
  if (pathFailures.length > 0) {
    throw new Error(pathFailures.map((failure) => `${failure.path}: ${failure.problem}`).join('; '));
  }
  let totalBytes = 0;
  const entries = relativePaths.map((relativePath) => {
    const normalized = relativePath.replace(/\\/g, '/');
    const target = path.join(worktreeRoot, normalized);
    if (!existsSync(target) || !lstatSync(target).isFile()) {
      throw new Error(`source context path "${normalized}" is not a regular file`);
    }
    const content = readFileSync(target, 'utf8');
    totalBytes += Buffer.byteLength(content, 'utf8');
    return secondarySourceContextSchema.parse({
      path: normalized,
      contentHash: sha256Hex(content),
      content,
    });
  });
  if (totalBytes > SECONDARY_BUILDER_LIMITS.maxSourceBytes) {
    throw new Error(`source context exceeds the ${SECONDARY_BUILDER_LIMITS.maxSourceBytes}-byte bound`);
  }
  return entries;
}

export function buildSecondaryBuilderPacket(input: {
  projection: ContextProjection;
  sourceContext: readonly SecondarySourceContext[];
  forbiddenChanges?: readonly string[] | undefined;
  verificationHints?: readonly string[] | undefined;
  targets?: readonly z.input<typeof secondaryBuilderTargetSchema>[] | undefined;
  tests?: readonly SecondarySourceContext[] | undefined;
  referencePatterns?: readonly SecondarySourceContext[] | undefined;
  dependencyContext?: readonly z.input<typeof secondaryDependencyContextSchema>[] | undefined;
  priorFailureEvidence?: readonly string[] | undefined;
  retrievalPlanRefs?: readonly string[] | undefined;
  expansionLevel?: (typeof CONTEXT_EXPANSION_LEVELS)[number] | undefined;
  contextMetrics?: z.input<typeof secondaryBuilderPacketMetricsSchema> | undefined;
  quality?: z.input<typeof secondaryBuilderPacketQualitySchema> | undefined;
  createdAt?: string | undefined;
}): SecondaryBuilderPacket {
  const sourceContext = z.array(secondarySourceContextSchema).parse(input.sourceContext);
  const tests = z.array(secondarySourceContextSchema).parse(input.tests ?? []);
  const referencePatterns = z.array(secondarySourceContextSchema).parse(input.referencePatterns ?? []);
  const allSourceContext = [...sourceContext, ...tests, ...referencePatterns];
  const sourceBytes = allSourceContext.reduce(
    (total, entry) => total + Buffer.byteLength(entry.content, 'utf8'),
    0,
  );
  if (sourceBytes > SECONDARY_BUILDER_LIMITS.maxSourceBytes) {
    throw new Error(`source context exceeds the ${SECONDARY_BUILDER_LIMITS.maxSourceBytes}-byte bound`);
  }
  const base = {
    schemaVersion: SECONDARY_BUILDER_PACKET_SCHEMA_VERSION,
    packetId: `${input.projection.projectionId}-secondary`,
    projectionHash: input.projection.contentHash,
    contractSnapshotHash: input.projection.contractSnapshotHash,
    sourceContextHash: sourceContextHashOf(allSourceContext),
    objective: {
      nodeId: input.projection.objectiveNodeId,
      taskId: input.projection.objective.taskId,
      title: input.projection.objective.title,
      acceptance: input.projection.objective.acceptance,
    },
    workUnit: {
      workUnitId: input.projection.workUnitId,
      attempt: input.projection.attempt,
      kind: input.projection.workUnit.kind,
      title: input.projection.workUnit.title,
      goal: input.projection.workUnit.goal,
      expectedArtifacts: input.projection.workUnit.expectedArtifacts,
      expectedAreas: input.projection.workUnit.expectedAreas,
    },
    approvedContext: {
      constraints: input.projection.constitution.rules.map((rule) => `${rule.ruleId}: ${rule.statement}`),
      contracts: input.projection.contracts.map((contract) => ({ ...contract })),
      adrs: input.projection.adrs.map((adr) => ({ ...adr })),
      decisions: input.projection.decisions.map((decision) => ({ ...decision })),
      priorWorkEvidence: [...input.projection.workEvidence],
    },
    sourceContext,
    targets: z.array(secondaryBuilderTargetSchema).parse(
      input.targets ?? sourceContext.map((entry) => ({
        repositoryId: entry.repositoryId,
        path: entry.path,
        symbols: entry.symbols,
        reason: entry.reason,
      })),
    ),
    tests,
    referencePatterns,
    dependencyContext: z.array(secondaryDependencyContextSchema).parse(input.dependencyContext ?? []),
    priorFailureEvidence: [...(input.priorFailureEvidence ?? [])].slice(0, 20),
    retrievalPlanRef: input.retrievalPlanRefs?.[0] ?? 'manual-source-selection',
    retrievalPlanRefs: [...(input.retrievalPlanRefs ?? ['manual-source-selection'])].slice(0, 12),
    expansion: {
      level: input.expansionLevel ?? 'MINIMAL_BOOTSTRAP',
      remainingLevels: Math.max(0, 4 - CONTEXT_EXPANSION_LEVELS.indexOf(input.expansionLevel ?? 'MINIMAL_BOOTSTRAP')),
    },
    contextMetrics: secondaryBuilderPacketMetricsSchema.parse(input.contextMetrics ?? {
      indexedFilesConsidered: sourceContext.length,
      candidateCount: sourceContext.length,
      selectedFiles: allSourceContext.length,
      selectedSections: allSourceContext.filter((entry) => entry.startLine !== undefined).length,
      sourceCharacters: sourceContext.reduce((sum, entry) => sum + entry.content.length, 0),
      testCharacters: tests.reduce((sum, entry) => sum + entry.content.length, 0),
      referencePatternCount: referencePatterns.length,
      dependencyContextCount: input.dependencyContext?.length ?? 0,
      budgetUtilization: sourceBytes / SECONDARY_BUILDER_LIMITS.maxSourceBytes,
      mandatoryRefsRetained: sourceContext.length,
      expansionDepth: CONTEXT_EXPANSION_LEVELS.indexOf(input.expansionLevel ?? 'MINIMAL_BOOTSTRAP'),
      staleEntriesEncountered: 0,
      selectionDurationMs: 0,
      indexReused: false,
    }),
    quality: secondaryBuilderPacketQualitySchema.parse(input.quality ?? {
      explicitTargetResolved: sourceContext.length > 0,
      targetAmbiguity: false,
      testsFound: tests.length > 0,
      verificationHintsAvailable: (input.verificationHints?.length ?? 0) > 0,
      referencePatternFound: referencePatterns.length > 0,
      dependencyContextComplete: true,
      sourceBudgetUtilization: sourceBytes / SECONDARY_BUILDER_LIMITS.maxSourceBytes,
      contextSufficient: sourceContext.length > 0,
    }),
    forbiddenChanges: [
      'Do not modify .git, .kiro, .specbridge, .codex, .claude, credentials, approvals, contracts, mission state, or closure state.',
      'Do not delete, rename, chmod, create symlinks, emit commands, or request tools.',
      ...(input.forbiddenChanges ?? []),
    ],
    verificationHints: [...(input.verificationHints ?? [])],
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  };
  const contentHash = sha256Hex(packetBody(base as Omit<SecondaryBuilderPacket, 'packetHash' | 'contentHash'>));
  const packet = secondaryBuilderPacketSchema.parse({ ...base, contentHash, packetHash: contentHash });
  if (JSON.stringify(packet).length > SECONDARY_BUILDER_LIMITS.maxPacketCharacters) {
    throw new Error(`secondary builder packet exceeds ${SECONDARY_BUILDER_LIMITS.maxPacketCharacters} characters`);
  }
  return packet;
}

function validatePacketIdentity(packet: SecondaryBuilderPacket): string | undefined {
  const { packetHash: claimed, contentHash, ...body } = packet;
  const actual = sha256Hex(packetBody(body));
  if (actual !== claimed || actual !== contentHash) return 'the packet semantic hash does not match its contents';
  if (sourceContextHashOf([...packet.sourceContext, ...packet.tests, ...packet.referencePatterns]) !== packet.sourceContextHash) {
    return 'the source-context manifest hash does not match the packet';
  }
  return undefined;
}

function validateSourceFreshness(
  worktreeRoot: string,
  packet: SecondaryBuilderPacket,
  protectedPaths: readonly string[],
  repositoryRoots: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const allSources = [...packet.sourceContext, ...packet.tests, ...packet.referencePatterns];
  for (const repositoryId of new Set(allSources.map((source) => source.repositoryId))) {
    const repositoryRoot = repositoryRoots[repositoryId] ?? (repositoryId === 'primary' ? worktreeRoot : undefined);
    if (repositoryRoot === undefined) {
      problems.push(`${repositoryId}: repository root is unavailable`);
      continue;
    }
    const pathFailures = validateEditPaths(
      { rootDir: repositoryRoot },
      allSources
        .filter((entry) => entry.repositoryId === repositoryId)
        .map((entry) => ({ path: entry.path, content: '' })),
      protectedPaths,
    );
    problems.push(...pathFailures.map((failure) => `${repositoryId}:${failure.path}: ${failure.problem}`));
  }
  if (problems.length > 0) return problems;
  for (const source of allSources) {
    const repositoryRoot = repositoryRoots[source.repositoryId] ?? (source.repositoryId === 'primary' ? worktreeRoot : undefined);
    if (repositoryRoot === undefined) {
      problems.push(`${source.repositoryId}:${source.path}: repository root is unavailable`);
      continue;
    }
    const normalizedPath = source.path.replace(/\\/g, '/');
    const resolvedRoot = path.resolve(repositoryRoot);
    const target = path.resolve(resolvedRoot, normalizedPath);
    if (
      path.isAbsolute(normalizedPath) ||
      normalizedPath === '..' ||
      normalizedPath.startsWith('../') ||
      (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`))
    ) {
      problems.push(`${source.repositoryId}:${source.path}: source path escapes its repository`);
      continue;
    }
    try {
      if (!lstatSync(target).isFile()) {
        problems.push(`${source.path}: source is not a regular file`);
        continue;
      }
      const current = readFileSync(target, 'utf8');
      if (sha256Hex(source.content) !== (source.sectionHash ?? sha256Hex(source.content))) {
        problems.push(`${source.repositoryId}:${source.path}: selected section hash does not match packet content`);
      }
      if (sha256Hex(current) !== source.contentHash || (source.startLine === undefined && current !== source.content)) {
        problems.push(`${source.path}: repository bytes changed after source context was assembled`);
      }
    } catch {
      problems.push(`${source.path}: source no longer exists or cannot be read`);
    }
  }
  return problems;
}

function emptyTelemetry(packet: SecondaryBuilderPacket): SecondaryBuilderTelemetry {
  return {
    inputCharacters: 0,
    outputBytes: 0,
    sourceFiles: packet.sourceContext.length + packet.tests.length + packet.referencePatterns.length,
    editedFiles: 0,
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
  };
}

function failure(
  packet: SecondaryBuilderPacket,
  kind: SecondaryBuilderFailureKind,
  problem: string,
  extra: Partial<Omit<Extract<SecondaryBuilderExecutionResult, { ok: false }>, 'ok' | 'failure'>> = {},
): SecondaryBuilderExecutionResult {
  return {
    ok: false,
    failure: { kind, problem },
    appliedFiles: extra.appliedFiles ?? [],
    telemetry: extra.telemetry ?? emptyTelemetry(packet),
    ...(extra.rawOutput !== undefined ? { rawOutput: extra.rawOutput } : {}),
    ...(extra.proposal !== undefined ? { proposal: extra.proposal } : {}),
  };
}

/** Execute one direct-model proposal. No correction retry and no heuristic parsing. */
export async function executeSecondaryObjectiveBuilder(
  input: ExecuteSecondaryBuilderInput,
): Promise<SecondaryBuilderExecutionResult> {
  const parsedPacket = secondaryBuilderPacketSchema.safeParse(input.packet);
  if (!parsedPacket.success) {
    return failure(input.packet, 'INVALID_STRUCTURED_OUTPUT', `invalid builder packet: ${parsedPacket.error.message}`);
  }
  const packet = parsedPacket.data;
  const identityProblem = validatePacketIdentity(packet);
  if (identityProblem !== undefined) return failure(packet, 'STALE_SOURCE_CONTEXT', identityProblem);
  const stale = validateSourceFreshness(
    input.worktreeRoot,
    packet,
    input.protectedPaths ?? [],
    input.repositoryRoots ?? {},
  );
  if (stale.length > 0) return failure(packet, 'STALE_SOURCE_CONTEXT', stale.slice(0, 5).join('; '));

  const userPrompt = renderSecondaryBuilderPrompt(packet);
  const inputCharacters = SECONDARY_BUILDER_SYSTEM_PROMPT.length + userPrompt.length;
  if (inputCharacters > input.maximumInputCharacters) {
    return failure(
      packet,
      'CONTEXT_TOO_LARGE',
      `secondary builder input is ${inputCharacters} characters; limit is ${input.maximumInputCharacters}`,
      { telemetry: { ...emptyTelemetry(packet), inputCharacters } },
    );
  }
  if (input.signal?.aborted === true) return failure(packet, 'CANCELLED', 'secondary builder was cancelled');

  let inferred: SecondaryInferenceResult;
  try {
    inferred = await input.inference.infer({
      systemPrompt: SECONDARY_BUILDER_SYSTEM_PROMPT,
      userPrompt,
      jsonSchema: SECONDARY_BUILDER_JSON_SCHEMA,
      schemaName: 'SECONDARY_BUILDER_RESULT',
      maxOutputBytes: input.maxOutputBytes,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (cause) {
    return failure(
      packet,
      'INFERENCE_UNAVAILABLE',
      `secondary inference threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      { telemetry: { ...emptyTelemetry(packet), inputCharacters } },
    );
  }
  if (!inferred.ok) {
    const kind: SecondaryBuilderFailureKind =
      inferred.kind === 'timeout'
        ? 'TIMEOUT'
        : inferred.kind === 'cancelled'
          ? 'CANCELLED'
          : inferred.kind === 'invalid'
            ? 'INVALID_STRUCTURED_OUTPUT'
            : 'INFERENCE_UNAVAILABLE';
    return failure(packet, kind, inferred.problem, {
      telemetry: { ...emptyTelemetry(packet), inputCharacters, durationMs: inferred.durationMs },
    });
  }

  const outputBytes = Buffer.byteLength(inferred.text, 'utf8');
  let telemetry: SecondaryBuilderTelemetry = {
    inputCharacters,
    outputBytes,
    sourceFiles: packet.sourceContext.length + packet.tests.length + packet.referencePatterns.length,
    editedFiles: 0,
    durationMs: inferred.durationMs,
    inputTokens: inferred.usage?.inputTokens ?? null,
    outputTokens: inferred.usage?.outputTokens ?? null,
  };
  input.onExecutionEvent?.({ stage: 'INFERENCE_COMPLETED', rawOutput: inferred.text, telemetry });
  if (outputBytes > input.maxOutputBytes) {
    return failure(packet, 'INVALID_STRUCTURED_OUTPUT', `response exceeds the ${input.maxOutputBytes}-byte limit`, {
      rawOutput: inferred.text.slice(0, input.maxOutputBytes),
      telemetry,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(inferred.text);
  } catch (cause) {
    return failure(packet, 'INVALID_STRUCTURED_OUTPUT', `response is not one JSON document: ${cause instanceof Error ? cause.message : String(cause)}`, {
      rawOutput: inferred.text,
      telemetry,
    });
  }
  const parsed = secondaryBuilderResultSchema.safeParse(raw);
  if (!parsed.success) {
    return failure(packet, 'INVALID_STRUCTURED_OUTPUT', parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '), {
      rawOutput: inferred.text,
      telemetry,
    });
  }
  const proposal = parsed.data;
  telemetry = { ...telemetry, editedFiles: proposal.edits.length };
  input.onExecutionEvent?.({ stage: 'PROPOSAL_VALIDATED', proposal, telemetry });
  if (proposal.status === 'NEEDS_MORE_CONTEXT') {
    return failure(
      packet,
      'INSUFFICIENT_CONTEXT',
      `secondary builder requested more context: ${proposal.needsMoreContextReasons?.join('; ') ?? proposal.summary}`,
      { rawOutput: inferred.text, proposal, telemetry },
    );
  }
  if (proposal.edits.length === 0) {
    return failure(packet, 'EMPTY_EDIT_SET', 'an implementation WorkUnit must propose at least one edit', {
      rawOutput: inferred.text,
      proposal,
      telemetry,
    });
  }
  const totalBytes = proposal.edits.reduce((sum, edit) => sum + Buffer.byteLength(edit.content, 'utf8'), 0);
  const oversizedFile = proposal.edits.find(
    (edit) => Buffer.byteLength(edit.content, 'utf8') > SECONDARY_BUILDER_LIMITS.maxFileBytes,
  );
  if (oversizedFile !== undefined) {
    return failure(packet, 'INVALID_STRUCTURED_OUTPUT', `${oversizedFile.path} exceeds ${SECONDARY_BUILDER_LIMITS.maxFileBytes} bytes`, {
      rawOutput: inferred.text,
      proposal,
      telemetry,
    });
  }
  if (totalBytes > SECONDARY_BUILDER_LIMITS.maxTotalBytes) {
    return failure(packet, 'INVALID_STRUCTURED_OUTPUT', `total edit size ${totalBytes} exceeds ${SECONDARY_BUILDER_LIMITS.maxTotalBytes} bytes`, {
      rawOutput: inferred.text,
      proposal,
      telemetry,
    });
  }
  const pathFailures = validateEditPaths(
    { rootDir: input.worktreeRoot },
    proposal.edits,
    input.protectedPaths ?? [],
  );
  if (pathFailures.length > 0) {
    return failure(
      packet,
      'FORBIDDEN_EDIT',
      pathFailures.slice(0, 8).map((entry) => `${entry.path}: ${entry.problem}`).join('; '),
      { rawOutput: inferred.text, proposal, telemetry },
    );
  }
  const operationFailures = proposal.edits.flatMap((edit) => {
    const target = path.join(input.worktreeRoot, edit.path.replace(/\\/g, '/'));
    const present = existsSync(target);
    if (edit.operation === 'CREATE' && present) return [`${edit.path}: CREATE target already exists`];
    if (edit.operation === 'REPLACE' && !present) return [`${edit.path}: REPLACE target does not exist`];
    if (present && !lstatSync(target).isFile()) return [`${edit.path}: target is not a regular file`];
    return [];
  });
  if (operationFailures.length > 0) {
    const problem = operationFailures.slice(0, 8).join('; ');
    return failure(packet, 'FORBIDDEN_EDIT', problem, { rawOutput: inferred.text, proposal, telemetry });
  }
  let appliedFiles: string[];
  try {
    appliedFiles = applyValidatedEdits({ rootDir: input.worktreeRoot }, proposal.edits);
  } catch (cause) {
    return failure(packet, 'APPLY_FAILURE', cause instanceof Error ? cause.message : String(cause), {
      rawOutput: inferred.text,
      proposal,
      telemetry,
    });
  }
  input.onExecutionEvent?.({ stage: 'EDITS_APPLIED', proposal, appliedFiles, telemetry });
  return { ok: true, proposal, appliedFiles, telemetry };
}

/** Explicit, stable prompt sections keep requirements distinct from examples. */
export function renderSecondaryBuilderPrompt(packet: SecondaryBuilderPacket): string {
  const renderSources = (entries: readonly NormalizedSecondarySourceContext[]): string =>
    entries.length === 0
      ? '(none)'
      : entries
          .map((entry) =>
            [
              `--- ${entry.repositoryId}:${entry.path}${entry.startLine !== undefined ? ` lines ${entry.startLine}-${entry.endLine}` : ''} ---`,
              `Selected because: ${entry.reason}`,
              entry.content,
            ].join('\n'),
          )
          .join('\n\n');
  return [
    'PACKET IDENTITY',
    stableStringify({ workUnitId: packet.workUnit.workUnitId, packetHash: packet.packetHash }),
    'TASK',
    `${packet.workUnit.title}\n${packet.workUnit.goal}`,
    'REQUIRED BEHAVIOR',
    [...packet.objective.acceptance, ...packet.approvedContext.contracts.flatMap((contract) => contract.requirements)].join('\n- '),
    'TARGETS',
    packet.targets.map((target) => `${target.repositoryId}:${target.path} (${target.reason})`).join('\n'),
    'CURRENT SOURCE',
    renderSources(packet.sourceContext),
    'RELEVANT TESTS',
    renderSources(packet.tests),
    'REFERENCE PATTERNS (examples only; not requirements)',
    renderSources(packet.referencePatterns),
    'DEPENDENCY CONTEXT',
    packet.dependencyContext.map((dependency) => `${dependency.workUnitId}: ${dependency.summary}`).join('\n') || '(none)',
    'CONSTRAINTS',
    packet.approvedContext.constraints.join('\n'),
    'DO NOT CHANGE',
    packet.forbiddenChanges.join('\n'),
    'PRIOR FAILURE EVIDENCE',
    packet.priorFailureEvidence.join('\n') || '(none)',
    'VERIFICATION HINTS',
    packet.verificationHints.join('\n') || '(none configured)',
    'OUTPUT CONTRACT',
    'Return exactly one SECONDARY_BUILDER_RESULT JSON document. Use status EDITS with complete CREATE/REPLACE contents, or NEEDS_MORE_CONTEXT with no edits when the supplied evidence is insufficient.',
  ].join('\n\n');
}

/** Effective production ceiling retains the existing localInference semantics. */
export function secondaryBuilderInputCeiling(config: AgentConfig): number {
  return effectiveLocalInputCharacters(config.localInference);
}
