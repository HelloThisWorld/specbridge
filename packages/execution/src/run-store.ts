import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import {
  EVIDENCE_STATUS_VALUES,
  EXECUTION_OUTCOMES,
  INTERACTIVE_LIFECYCLE_STATUSES,
  RUN_KINDS,
  SpecBridgeError,
  assertInsideWorkspace,
  writeFileAtomic,
} from '@specbridge/core';

/**
 * Run records live under `.specbridge/runs/<run-id>/`.
 *
 * Every runner invocation — task execution, resume, stage generation, stage
 * refinement — gets its own directory with a versioned `run.json` plus raw
 * artifacts (prompt, raw output, git snapshots, verification results,
 * evidence, report). Run directories are append-only history; SpecBridge
 * never deletes or rewrites completed runs.
 */

export const RUN_RECORD_SCHEMA_VERSION = '1.0.0';

export const runRecordSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    runId: z.string().min(1),
    kind: z.enum(RUN_KINDS),
    specName: z.string().min(1),
    stage: z.enum(['requirements', 'bugfix', 'design', 'tasks']).optional(),
    taskId: z.string().optional(),
    runner: z.string().min(1),
    sessionId: z.string().optional(),
    parentRunId: z.string().optional(),
    createdAt: z.string(),
    finishedAt: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    outcome: z.enum(EXECUTION_OUTCOMES).optional(),
    evidenceStatus: z.enum(EVIDENCE_STATUS_VALUES).optional(),
    /** Stage generation/refinement: whether the candidate was applied to .kiro. */
    applied: z.boolean().optional(),
    resumeSupported: z.boolean().default(false),
    promptVersion: z.string().optional(),
    warnings: z.array(z.string()).default([]),
    /** Interactive runs (v0.5): lifecycle state of the run. */
    lifecycleStatus: z.enum(INTERACTIVE_LIFECYCLE_STATUSES).optional(),
    /** Interactive runs (v0.5): the host driving the run (e.g. "mcp"). */
    host: z.string().optional(),
    /** Interactive runs (v0.5): reason recorded when the run was aborted. */
    abortReason: z.string().optional(),
  })
  .passthrough();

export type RunRecord = z.infer<typeof runRecordSchema>;

export function runsRootDir(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, 'runs');
}

export function runDir(workspace: WorkspaceInfo, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new SpecBridgeError('INVALID_ARGUMENT', `Invalid run id "${runId}".`);
  }
  return assertInsideWorkspace(workspace.rootDir, path.join(runsRootDir(workspace), runId));
}

export function runArtifactPath(workspace: WorkspaceInfo, runId: string, fileName: string): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(runDir(workspace, runId), fileName));
}

/** Create the run directory and its initial `run.json`. */
export function createRun(workspace: WorkspaceInfo, record: RunRecord): string {
  const validated = runRecordSchema.parse(record);
  const dir = runDir(workspace, validated.runId);
  if (existsSync(dir)) {
    throw new SpecBridgeError(
      'INVALID_STATE',
      `Run directory already exists: ${dir}. Run ids must be unique.`,
    );
  }
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'run.json'), `${JSON.stringify(validated, null, 2)}\n`);
  return dir;
}

export function readRunRecord(workspace: WorkspaceInfo, runId: string): RunRecord | undefined {
  const filePath = path.join(runDir(workspace, runId), 'run.json');
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    const result = runRecordSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Merge a patch into `run.json`. Unknown existing fields survive. */
export function updateRunRecord(
  workspace: WorkspaceInfo,
  runId: string,
  patch: Partial<RunRecord> & Record<string, unknown>,
): RunRecord {
  const current = readRunRecord(workspace, runId);
  if (current === undefined) {
    throw new SpecBridgeError('INVALID_STATE', `Run ${runId} has no readable run.json.`);
  }
  const next = runRecordSchema.parse({ ...current, ...patch });
  writeFileAtomic(
    path.join(runDir(workspace, runId), 'run.json'),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}

export interface RunListResult {
  runs: RunRecord[];
  diagnostics: Diagnostic[];
}

/** All runs, newest first. Unreadable records degrade to diagnostics. */
export function listRuns(workspace: WorkspaceInfo): RunListResult {
  const root = runsRootDir(workspace);
  if (!existsSync(root)) return { runs: [], diagnostics: [] };
  const runs: RunRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = readRunRecord(workspace, entry.name);
    if (record !== undefined) {
      runs.push(record);
    } else {
      diagnostics.push({
        severity: 'warning',
        code: 'RUN_RECORD_UNREADABLE',
        message: `Run directory ${entry.name} has no readable run.json; ignoring it.`,
        file: path.join(root, entry.name),
      });
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt, 'en') || b.runId.localeCompare(a.runId, 'en'));
  return { runs, diagnostics };
}

/** Latest run for a spec/task pair (for `parentRunId` lineage). */
export function latestRunForTask(
  workspace: WorkspaceInfo,
  specName: string,
  taskId: string,
): RunRecord | undefined {
  return listRuns(workspace).runs.find(
    (run) => run.specName === specName && run.taskId === taskId,
  );
}

/** Write an artifact file inside the run directory. */
export function writeRunArtifact(
  workspace: WorkspaceInfo,
  runId: string,
  fileName: string,
  content: string,
): string {
  const filePath = runArtifactPath(workspace, runId, fileName);
  writeFileAtomic(filePath, content);
  return filePath;
}

/** Append one JSON line to `events.jsonl` (auditable run timeline). */
export function appendRunEvent(
  workspace: WorkspaceInfo,
  runId: string,
  event: { at: string; type: string } & Record<string, unknown>,
): void {
  const filePath = runArtifactPath(workspace, runId, 'events.jsonl');
  appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

/** Read a JSON artifact from a run directory, or undefined. */
export function readRunArtifactJson(
  workspace: WorkspaceInfo,
  runId: string,
  fileName: string,
): unknown {
  const filePath = path.join(runDir(workspace, runId), fileName);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Read a text artifact from a run directory, or undefined. */
export function readRunArtifactText(
  workspace: WorkspaceInfo,
  runId: string,
  fileName: string,
): string | undefined {
  const filePath = path.join(runDir(workspace, runId), fileName);
  if (!existsSync(filePath)) return undefined;
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}
