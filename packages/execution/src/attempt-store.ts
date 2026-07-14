import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { SpecBridgeError, assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import type {
  NormalizedExecutionResult,
  NormalizedRunnerError,
  NormalizedRunnerEvent,
  RunnerCapabilitySet,
  RunnerCategory,
  RunnerOperation,
  RunnerSupportLevel,
  StageGenerationResult,
  TaskExecutionResult,
} from '@specbridge/runners';
import {
  normalizedExecutionResultSchema,
  runnerCapabilitySetSchema,
} from '@specbridge/runners';
import { runDir } from './run-store.js';

/**
 * Append-only per-invocation attempt records (v0.6).
 *
 * Every runner invocation — including structured-output correction retries,
 * transient transport retries, and authoring fallback attempts — gets its
 * own directory under `.specbridge/runs/<run-id>/attempts/<attempt-id>/`.
 * Attempts are never overwritten or deleted; failed attempts stay available
 * for inspection after a fallback succeeds.
 *
 * Never stored here: API keys, tokens, environment dumps, credential file
 * contents, or provider reasoning content (adapters redact before returning).
 */

export const ATTEMPT_RECORD_SCHEMA_VERSION = '1.0.0';

export const attemptRecordSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    /** 1-based position within the run. */
    attemptNumber: z.number().int().min(1),
    profile: z.string().min(1),
    runner: z.string().min(1),
    category: z.string().min(1),
    supportLevel: z.string().min(1),
    operation: z.string().min(1),
    /** Why this attempt exists: initial | correction-retry | transport-retry | fallback. */
    attemptKind: z.enum(['initial', 'correction-retry', 'transport-retry', 'fallback']),
    /** The attempt this one retries/falls back from. */
    parentAttemptId: z.string().optional(),
    /** Transport boundary: local process, loopback endpoint, or network. */
    boundary: z.enum(['local-process', 'loopback-endpoint', 'network-endpoint', 'in-process']),
    model: z.string().nullable().default(null),
    capabilitySnapshot: runnerCapabilitySetSchema,
    createdAt: z.string().min(1),
    finishedAt: z.string().optional(),
    outcome: z.string().optional(),
    errorCode: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export interface AttemptMetadata {
  runId: string;
  profile: string;
  runner: string;
  category: RunnerCategory;
  supportLevel: RunnerSupportLevel;
  operation: RunnerOperation;
  attemptKind: AttemptRecord['attemptKind'];
  parentAttemptId?: string;
  boundary: AttemptRecord['boundary'];
  model: string | null;
  capabilitySnapshot: RunnerCapabilitySet;
  createdAt: string;
}

export function attemptsDir(workspace: WorkspaceInfo, runId: string): string {
  return path.join(runDir(workspace, runId), 'attempts');
}

export function attemptDir(workspace: WorkspaceInfo, runId: string, attemptId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(attemptId)) {
    throw new SpecBridgeError('INVALID_ARGUMENT', `Invalid attempt id "${attemptId}".`);
  }
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(attemptsDir(workspace, runId), attemptId),
  );
}

function nextAttemptNumber(workspace: WorkspaceInfo, runId: string): number {
  const root = attemptsDir(workspace, runId);
  if (!existsSync(root)) return 1;
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length + 1;
}

/** Create the next attempt directory (append-only; never reuses an id). */
export function createAttempt(workspace: WorkspaceInfo, metadata: AttemptMetadata): AttemptRecord {
  const attemptNumber = nextAttemptNumber(workspace, metadata.runId);
  const attemptId = `attempt-${String(attemptNumber).padStart(3, '0')}`;
  const dir = attemptDir(workspace, metadata.runId, attemptId);
  if (existsSync(dir)) {
    throw new SpecBridgeError('INVALID_STATE', `Attempt directory already exists: ${dir}.`);
  }
  mkdirSync(dir, { recursive: true });
  const record = attemptRecordSchema.parse({
    schemaVersion: ATTEMPT_RECORD_SCHEMA_VERSION,
    runId: metadata.runId,
    attemptId,
    attemptNumber,
    profile: metadata.profile,
    runner: metadata.runner,
    category: metadata.category,
    supportLevel: metadata.supportLevel,
    operation: metadata.operation,
    attemptKind: metadata.attemptKind,
    ...(metadata.parentAttemptId !== undefined ? { parentAttemptId: metadata.parentAttemptId } : {}),
    boundary: metadata.boundary,
    model: metadata.model,
    capabilitySnapshot: metadata.capabilitySnapshot,
    createdAt: metadata.createdAt,
  });
  writeFileAtomic(path.join(dir, 'attempt.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function writeAttemptArtifact(
  workspace: WorkspaceInfo,
  runId: string,
  attemptId: string,
  fileName: string,
  content: string,
): string {
  const filePath = assertInsideWorkspace(
    workspace.rootDir,
    path.join(attemptDir(workspace, runId, attemptId), fileName),
  );
  writeFileAtomic(filePath, content);
  return filePath;
}

export interface FinalizeAttemptInput {
  finishedAt: string;
  outcome: string;
  durationMs: number;
  result: StageGenerationResult | TaskExecutionResult;
  normalized: NormalizedExecutionResult;
}

/**
 * Record the finished attempt: updates attempt.json (merge; append-only at
 * the directory level) and writes the per-attempt artifacts.
 */
export function finalizeAttempt(
  workspace: WorkspaceInfo,
  record: AttemptRecord,
  input: FinalizeAttemptInput,
): void {
  const dir = attemptDir(workspace, record.runId, record.attemptId);
  const errorCode = (input.result.error as NormalizedRunnerError | undefined)?.code;
  const next = attemptRecordSchema.parse({
    ...record,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ...(errorCode !== undefined ? { errorCode } : {}),
  });
  writeFileAtomic(path.join(dir, 'attempt.json'), `${JSON.stringify(next, null, 2)}\n`);

  writeAttemptArtifact(workspace, record.runId, record.attemptId, 'raw-stdout.log', input.result.rawStdout);
  writeAttemptArtifact(workspace, record.runId, record.attemptId, 'raw-stderr.log', input.result.rawStderr);
  const events = input.result.normalizedEvents as NormalizedRunnerEvent[] | undefined;
  if (events !== undefined && events.length > 0) {
    writeAttemptArtifact(
      workspace,
      record.runId,
      record.attemptId,
      'normalized-events.jsonl',
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
  }
  writeAttemptArtifact(
    workspace,
    record.runId,
    record.attemptId,
    'normalized-result.json',
    `${JSON.stringify(normalizedExecutionResultSchema.parse(input.normalized), null, 2)}\n`,
  );
  if (input.result.process !== undefined) {
    writeAttemptArtifact(
      workspace,
      record.runId,
      record.attemptId,
      'process.json',
      `${JSON.stringify(input.result.process, null, 2)}\n`,
    );
  }
}

/** All attempt records for a run, in attempt order. */
export function listAttempts(workspace: WorkspaceInfo, runId: string): AttemptRecord[] {
  const root = attemptsDir(workspace, runId);
  if (!existsSync(root)) return [];
  const records: AttemptRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'attempt.json');
    if (!existsSync(file)) continue;
    try {
      const parsed = attemptRecordSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // Unreadable attempts are surfaced by run inspection, not dropped here.
    }
  }
  records.sort((a, b) => a.attemptNumber - b.attemptNumber);
  return records;
}
