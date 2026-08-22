import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace } from '@specbridge/core';
import {
  abortInteractiveTask,
  beginInteractiveTask,
  completeInteractiveTask,
} from '@specbridge/execution';
import type { LocalModelManager } from '@specbridge/runners';
import { localStructuredInference } from '@specbridge/runners';
import type { Clock } from '@specbridge/workflow';
import type { ExecutorDispatchResult } from '../driver/executor-dispatch.js';
import { classifyEvidenceFailure, classifyPreflightFailure } from '../driver/executor-dispatch.js';
import { boundRenderedContext } from '../context/packet.js';
import type { JobNode } from '../jobs/state.js';
import type { FailureCategory } from '../vocabulary.js';

/**
 * Local task execution (vNext.2): the LocalModelProvider's source-mutating
 * path, with SpecBridge driving the loop.
 *
 * The local model is a NATIVE MODEL endpoint, not an agent: it has no
 * tools, no shell, and never touches the repository. One bounded structured
 * request returns a complete implementation proposal (full file contents);
 * SpecBridge validates it, applies it, and runs the EXISTING interactive
 * evidence pipeline — repository lock, pre/post Git snapshots, protected
 * paths, trusted verification commands, verified-only completion. What the
 * model claims is a claim; the deterministic pipeline decides.
 *
 * The result shape is exactly the executor-dispatch result, so job-service
 * failure classification, diagnosis, bounded repair, and escalation apply
 * to local attempts unchanged — a local attempt is an ordinary durable
 * ExecutionAttempt on the LOCAL lane, never a parallel runtime.
 *
 * Bounded local retries live in the LANE DECISION (scheduling/scheduler.ts
 * counts prior LOCAL attempts), not here: this module performs exactly one
 * attempt per call.
 */

export const LOCAL_EXECUTION_LIMITS = {
  maxEdits: 20,
  maxFileBytes: 262_144,
  maxTotalBytes: 1_048_576,
  maxSummaryChars: 2_000,
  maxNotes: 20,
} as const;

/** Path prefixes the local executor may never write, whatever it proposes. */
const DENIED_PATH_PREFIXES = ['.git', '.kiro', '.specbridge'] as const;

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export const localExecutorEditSchema = z.object({
  /** Workspace-relative path, forward slashes. */
  path: z.string().min(1).max(512),
  /** COMPLETE new file content. Full-content writes only: small local
   * models corrupt diffs far more often than they corrupt whole files, and
   * a whole file is verifiable structurally before anything is applied. */
  content: z.string().max(LOCAL_EXECUTION_LIMITS.maxFileBytes),
});
export type LocalExecutorEdit = z.infer<typeof localExecutorEditSchema>;

export const localExecutorOutputSchema = z.object({
  decision: z.enum(['IMPLEMENTED', 'ESCALATE']),
  summary: z.string().min(1).max(LOCAL_EXECUTION_LIMITS.maxSummaryChars),
  edits: z.array(localExecutorEditSchema).max(LOCAL_EXECUTION_LIMITS.maxEdits).default([]),
  notes: z.array(z.string().max(500)).max(LOCAL_EXECUTION_LIMITS.maxNotes).default([]),
  escalationReason: z.string().max(1_000).optional(),
});
export type LocalExecutorOutput = z.infer<typeof localExecutorOutputSchema>;

export const LOCAL_EXECUTOR_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'summary', 'edits'],
  properties: {
    decision: { type: 'string', enum: ['IMPLEMENTED', 'ESCALATE'] },
    summary: { type: 'string', maxLength: LOCAL_EXECUTION_LIMITS.maxSummaryChars },
    edits: {
      type: 'array',
      maxItems: LOCAL_EXECUTION_LIMITS.maxEdits,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', maxLength: 512 },
          content: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', maxItems: LOCAL_EXECUTION_LIMITS.maxNotes, items: { type: 'string', maxLength: 500 } },
    escalationReason: { type: 'string', maxLength: 1_000 },
  },
};

export const LOCAL_EXECUTOR_SYSTEM_PROMPT = [
  'You are the LOCAL EXECUTOR of an engineering runtime. You implement ONE',
  'small, well-specified task by returning complete replacement file',
  'contents. You have no tools, no shell, and no further conversation: this',
  'single JSON response is your entire contribution, and deterministic',
  'compilation and tests will judge it.',
  '',
  'Rules:',
  '- Return decision "IMPLEMENTED" with the complete new content of every',
  '  file you change or create. Whole files only — never fragments, never',
  '  diffs, never placeholders like "rest unchanged".',
  '- Touch as few files as possible. Never edit .git, .kiro, or .specbridge',
  '  paths, task checkboxes, or unrelated code.',
  '- Return decision "ESCALATE" with escalationReason when the task needs',
  '  repository knowledge you do not have, is ambiguous, or exceeds a small',
  '  isolated change. Escalating is correct and cheap; a wrong guess wastes',
  '  a verification cycle.',
  '- The response must be valid JSON for the provided schema.',
].join('\n');

// ---------------------------------------------------------------------------
// Inference seam
// ---------------------------------------------------------------------------

export interface LocalExecutorInferenceRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
}

export type LocalExecutorInferenceResult =
  | {
      ok: true;
      text: string;
      usage?: { inputTokens: number | null; outputTokens: number | null } | undefined;
    }
  | { ok: false; kind: 'unavailable' | 'cancelled' | 'invalid'; problem: string };

/** The injectable inference function (tests provide a deterministic fake). */
export type LocalExecutorInference = (
  request: LocalExecutorInferenceRequest,
) => Promise<LocalExecutorInferenceResult>;

/** The production inference: the managed llama.cpp endpoint. */
export function managedLocalInference(
  manager: LocalModelManager,
  config: AgentConfig,
  signal?: AbortSignal,
): LocalExecutorInference {
  return async (request) => {
    const started = await manager.ensureStarted(signal);
    if (!started.ok) {
      return {
        ok: false,
        kind: started.kind === 'cancelled' ? 'cancelled' : 'unavailable',
        problem: started.problem,
      };
    }
    manager.touch();
    const local = config.localInference;
    const result = await localStructuredInference({
      baseUrl: started.baseUrl,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      jsonSchema: request.jsonSchema,
      schemaName: request.schemaName,
      temperature: local.temperature,
      timeoutMs: local.requestTimeoutMs,
      maxOutputBytes: local.maxOutputBytes,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        kind: result.kind === 'cancelled' ? 'cancelled' : 'unavailable',
        problem: result.problem,
      };
    }
    return { ok: true, text: result.text, ...(result.usage !== undefined ? { usage: result.usage } : {}) };
  };
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

export interface EditValidationFailure {
  path: string;
  problem: string;
}

/** Validate proposed edit paths structurally BEFORE anything is written. */
export function validateEditPaths(
  workspace: WorkspaceInfo,
  edits: readonly LocalExecutorEdit[],
  protectedPaths: readonly string[],
): EditValidationFailure[] {
  const failures: EditValidationFailure[] = [];
  let totalBytes = 0;
  for (const edit of edits) {
    const normalized = edit.path.replace(/\\/g, '/');
    if (path.isAbsolute(normalized) || normalized.includes('..')) {
      failures.push({ path: edit.path, problem: 'paths must be workspace-relative without ".."' });
      continue;
    }
    const denied = DENIED_PATH_PREFIXES.find(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
    if (denied !== undefined) {
      failures.push({ path: edit.path, problem: `"${denied}" paths may never be edited by the local executor` });
      continue;
    }
    const protectedHit = protectedPaths.find(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix.replace(/\/$/, '')}/`),
    );
    if (protectedHit !== undefined) {
      failures.push({ path: edit.path, problem: `"${protectedHit}" is a protected path` });
      continue;
    }
    try {
      assertInsideWorkspace(workspace.rootDir, path.join(workspace.rootDir, normalized));
    } catch {
      failures.push({ path: edit.path, problem: 'path escapes the workspace' });
      continue;
    }
    totalBytes += Buffer.byteLength(edit.content, 'utf8');
  }
  if (totalBytes > LOCAL_EXECUTION_LIMITS.maxTotalBytes) {
    failures.push({
      path: '(total)',
      problem: `total edit size ${totalBytes} exceeds the ${LOCAL_EXECUTION_LIMITS.maxTotalBytes}-byte bound`,
    });
  }
  return failures;
}

function applyEdits(workspace: WorkspaceInfo, edits: readonly LocalExecutorEdit[]): string[] {
  const written: string[] = [];
  for (const edit of edits) {
    const normalized = edit.path.replace(/\\/g, '/');
    const target = assertInsideWorkspace(
      workspace.rootDir,
      path.join(workspace.rootDir, normalized),
    );
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, edit.content, 'utf8');
    written.push(normalized);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface LocalExecutionInput {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  node: JobNode;
  specName: string;
  mode: 'implement' | 'repair';
  allowDirty: boolean;
  /** The inference implementation (managed endpoint or a test fake). */
  inference: LocalExecutorInference;
  /** Bounded correction retries for invalid structured output. */
  maxCorrections?: number | undefined;
  clock?: Clock | undefined;
  idFactory?: (() => string) | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /** Called before each inference request (local budget accounting). */
  onInferenceCall?: (() => void) | undefined;
  /**
   * vNext.7: selected repository context, already rendered.
   *
   * A direct model has no tools, so the interactive packet alone — steering,
   * approved documents, the task plan — tells it WHAT to build and nothing
   * about what the code currently looks like. Before this existed the model
   * had to invent whole files from the spec; with it, the bounded working
   * set the retrieval layer selected travels with the request.
   *
   * Absent means the vNext.2 behaviour, byte-identical.
   */
  repositoryContext?: string | undefined;
  /** Selection plan id, recorded on the run for explainability. */
  contextPlanId?: string | undefined;
}

export interface LocalExecutionResult extends ExecutorDispatchResult {
  /** True when the LOCAL lane declined and strong execution is required. */
  escalated: boolean;
  /** The model's own escalation reason, when it declined. */
  escalationReason?: string | undefined;
}

function failureResult(
  category: FailureCategory,
  message: string,
  source: string,
  escalated: boolean,
): LocalExecutionResult {
  return {
    evidenceStatus: undefined,
    runId: undefined,
    failure: { category, message, source },
    escalated,
  };
}

/**
 * Run ONE local execution attempt through the interactive evidence path.
 *
 * begin (lock + baseline snapshot) → bounded structured inference →
 * validate + apply edits → complete (trusted verification + evidence) —
 * with an abort on every path that cannot reach completion, so the lock
 * never leaks and nothing half-applied masquerades as a finished run.
 */
export async function dispatchLocalExecution(
  input: LocalExecutionInput,
): Promise<LocalExecutionResult> {
  const deps = {
    workspace: input.workspace,
    config: input.config,
    ...(input.clock !== undefined ? { clock: input.clock } : {}),
    ...(input.idFactory !== undefined ? { idFactory: input.idFactory } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    host: 'local-executor',
  };

  const begin = await beginInteractiveTask(deps, {
    specName: input.specName,
    taskId: input.node.parentTaskId,
    allowDirty: input.allowDirty,
    runVerificationOnComplete: true,
  });
  if (begin.kind === 'blocked') {
    return failureResult(
      classifyPreflightFailure(begin.code),
      begin.message,
      `preflight:${begin.code}`,
      false,
    );
  }
  input.onProgress?.(`local executor: run ${begin.runId} started for task ${begin.task.id}`);

  const abort = async (reason: string): Promise<void> => {
    try {
      await abortInteractiveTask(deps, { runId: begin.runId, reason: reason.slice(0, 500) });
    } catch {
      // Abort is best-effort cleanup; the lock recovery path exists for the rest.
    }
  };

  // Bounded packet: the interactive context is deterministic and already
  // carries steering, approved documents, and the task plan. It is truncated
  // to the local input budget — a small model with half the context and the
  // full contract beats a failed oversized request.
  const local = input.config.localInference;
  const failureFeedback =
    input.mode === 'repair' && input.node.latestFailure !== undefined
      ? [
          '',
          '## Previous attempt failed',
          `Category: ${input.node.latestFailure.category}`,
          `Detail: ${input.node.latestFailure.message.slice(0, 2_000)}`,
          input.node.latestDiagnosis !== undefined
            ? `Diagnosis recommends: ${input.node.latestDiagnosis.recommendedAction}`
            : '',
          'Fix the diagnosed defect; do not restart the approach.',
        ].join('\n')
      : '';
  // The input budget is shared between the approved-document packet and the
  // selected repository context. Source leads on the split: a model that can
  // see the code it must change and half the design document outperforms one
  // with the whole document and no code, and the approved documents are the
  // part a repair attempt least needs re-read in full.
  const repositoryContext = input.repositoryContext ?? '';
  const overhead = LOCAL_EXECUTOR_SYSTEM_PROMPT.length + failureFeedback.length + 500;
  const budget = Math.max(4_000, local.maximumInputCharacters - overhead);
  const contextShare = repositoryContext === '' ? 0 : Math.min(repositoryContext.length, Math.floor(budget * 0.6));
  const documentShare = Math.max(1_000, budget - contextShare);
  // The repository block is bounded on an EXCERPT boundary, never mid-file:
  // a truncated function with no marker is the same failure that section
  // extraction exists to avoid, and reintroducing it at the last step would
  // be perverse. The approved-document packet is prose and truncates safely.
  const packet = [
    begin.contextMarkdown.slice(0, documentShare),
    repositoryContext === '' ? '' : boundRenderedContext(repositoryContext, contextShare),
    failureFeedback,
  ]
    .filter((part) => part !== '')
    .join('\n\n');

  let userPrompt = packet;
  const maxCorrections = input.maxCorrections ?? 1;
  let output: LocalExecutorOutput | undefined;
  let usage: { inputTokens: number | null; outputTokens: number | null } | undefined;
  let lastProblem = 'no inference attempt ran';
  for (let attempt = 0; attempt <= maxCorrections; attempt += 1) {
    if (input.signal?.aborted === true) {
      await abort('cancelled before inference');
      return failureResult('CANCELLED', 'The local execution was cancelled.', 'local-executor', false);
    }
    input.onInferenceCall?.();
    const result = await input.inference({
      systemPrompt: LOCAL_EXECUTOR_SYSTEM_PROMPT,
      userPrompt,
      jsonSchema: LOCAL_EXECUTOR_JSON_SCHEMA,
      schemaName: 'LOCAL_EXECUTOR',
    });
    if (!result.ok) {
      await abort(`local inference failed: ${result.problem.slice(0, 200)}`);
      return failureResult(
        result.kind === 'cancelled' ? 'CANCELLED' : 'CAPABILITY_UNAVAILABLE',
        `Local inference failed: ${result.problem}`,
        'local-executor',
        result.kind !== 'cancelled',
      );
    }
    usage = result.usage ?? usage;
    try {
      const parsed = localExecutorOutputSchema.safeParse(JSON.parse(result.text));
      if (parsed.success) {
        output = parsed.data;
        break;
      }
      lastProblem = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
    } catch (cause) {
      lastProblem = `the response is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    userPrompt = `${packet}\n\nYour previous response was invalid (${lastProblem.slice(0, 300)}). Return ONLY valid JSON for the schema.`;
  }
  if (output === undefined) {
    await abort(`invalid local executor output: ${lastProblem.slice(0, 200)}`);
    return failureResult(
      'CAPABILITY_UNAVAILABLE',
      `The local executor output stayed invalid after ${maxCorrections} bounded correction(s): ${lastProblem}`,
      'local-executor',
      true,
    );
  }

  if (output.decision === 'ESCALATE') {
    await abort(`local executor escalated: ${(output.escalationReason ?? output.summary).slice(0, 200)}`);
    return {
      evidenceStatus: undefined,
      runId: undefined,
      failure: {
        category: 'CAPABILITY_UNAVAILABLE',
        message: `The local executor declined the task: ${output.escalationReason ?? output.summary}`,
        source: 'local-executor',
      },
      escalated: true,
      escalationReason: output.escalationReason ?? output.summary,
    };
  }

  const pathFailures = validateEditPaths(input.workspace, output.edits, begin.protectedPaths);
  if (pathFailures.length > 0) {
    const detail = pathFailures
      .slice(0, 5)
      .map((failure) => `${failure.path}: ${failure.problem}`)
      .join('; ');
    await abort(`unsafe local edit proposal: ${detail.slice(0, 200)}`);
    // Nothing was written. The proposal is refused and the task escalates to
    // the strong lane; the protected-path boundary itself was never crossed.
    return failureResult(
      'CAPABILITY_UNAVAILABLE',
      `The local executor proposed unsafe edits (refused before application): ${detail}`,
      'local-executor',
      true,
    );
  }

  let written: string[];
  try {
    written = applyEdits(input.workspace, output.edits);
  } catch (cause) {
    await abort(`edit application failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return failureResult(
      'IMPLEMENTATION_DEFECT',
      `Applying the local edits failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      'local-executor',
      false,
    );
  }
  input.onProgress?.(`local executor: applied ${written.length} file(s); verifying`);

  const completion = await completeInteractiveTask(deps, {
    runId: begin.runId,
    summary: `[local-executor] ${output.summary}`.slice(0, 2_000),
    reportedChangedFiles: written,
  });
  if (completion.kind === 'blocked') {
    await abort(`completion blocked: ${completion.message.slice(0, 200)}`);
    return failureResult(
      classifyPreflightFailure(completion.code),
      completion.message,
      `completion:${completion.code}`,
      false,
    );
  }

  const report = completion.report;
  const verified = report.evidenceStatus === 'verified' || report.evidenceStatus === 'manually-accepted';
  const changedFiles = report.changedFiles.map((file) => ({
    path: file.path,
    contentHash: file.changeType,
  }));
  const usageOut =
    usage !== undefined
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: null }
      : undefined;
  if (verified) {
    return {
      evidenceStatus: report.evidenceStatus,
      runId: report.runId,
      changedFiles,
      ...(usageOut !== undefined ? { usage: usageOut } : {}),
      escalated: false,
    };
  }
  const category = classifyEvidenceFailure(report.evidenceStatus);
  const verificationOutput = report.verification.commands
    .filter((command) => !command.passed)
    .map((command) => `${command.name}: ${command.status}\n${command.stdoutTail}\n${command.stderrTail}`)
    .join('\n');
  return {
    evidenceStatus: report.evidenceStatus,
    runId: report.runId,
    failure: {
      category,
      message:
        report.failureReason ??
        `The local attempt ended with evidence status "${report.evidenceStatus}".`,
      source:
        category === 'VERIFICATION_FAILURE'
          ? (report.verification.commands.find((command) => !command.passed)?.name ?? 'verification')
          : 'local-executor',
      ...(verificationOutput.length > 0 ? { output: verificationOutput.slice(0, 16_384) } : {}),
    },
    changedFiles,
    ...(usageOut !== undefined ? { usage: usageOut } : {}),
    escalated: false,
  };
}
