import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import {
  EVIDENCE_STATUS_VALUES,
  SpecBridgeError,
  assertInsideWorkspace,
  writeFileAtomic,
} from '@specbridge/core';

/**
 * Append-only task evidence storage.
 *
 * One JSON file per attempt:
 *   .specbridge/evidence/<spec-name>/<task-id>/<run-id>.json
 *
 * Attempts are never overwritten or deleted — a task's full history stays
 * auditable. A task checkbox may only be updated when a record here reaches
 * `verified` or `manually-accepted`.
 */

export const EVIDENCE_SCHEMA_VERSION = '1.0.0';

export const changedFileRecordSchema = z.object({
  path: z.string().min(1),
  changeType: z.enum(['added', 'modified', 'deleted']),
  preExisting: z.boolean(),
  modifiedDuringRun: z.boolean(),
});

export const evidenceVerificationCommandSchema = z.object({
  name: z.string(),
  argv: z.array(z.string()),
  required: z.boolean(),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
  passed: z.boolean(),
});

export const manualAcceptanceSchema = z.object({
  actor: z.literal('local-user'),
  reason: z.string().min(1),
  acceptedAt: z.string(),
  referencedRunId: z.string().optional(),
});

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Spec-and-task identity captured when the evidence was recorded (added in
 * v0.4; optional so every v0.3 record keeps validating). Verification uses
 * these fields to decide deterministically whether evidence is still fresh:
 * a changed approved hash, plan hash, or task fingerprint means the evidence
 * no longer describes the current spec.
 */
export const evidenceSpecContextSchema = z
  .object({
    /** Approved exact-byte hash of requirements.md/bugfix.md at evidence time. */
    documentHash: z.string().regex(SHA256_HEX).optional(),
    /** Approved exact-byte hash of design.md at evidence time. */
    designHash: z.string().regex(SHA256_HEX).optional(),
    /** Checkbox-normalized plan hash of tasks.md at evidence time. */
    tasksPlanHash: z.string().regex(SHA256_HEX).optional(),
    /** Fingerprint of the task's id, title, and requirement refs. */
    taskFingerprint: z.string().regex(SHA256_HEX).optional(),
    /** Raw checkbox line text of the task at evidence time. */
    taskText: z.string().optional(),
  })
  .passthrough();
export type EvidenceSpecContext = z.infer<typeof evidenceSpecContextSchema>;

export const taskEvidenceRecordSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    runId: z.string().min(1),
    parentRunId: z.string().optional(),
    specName: z.string().min(1),
    taskId: z.string().min(1),
    status: z.enum(EVIDENCE_STATUS_VALUES),
    runner: z.string().min(1),
    sessionId: z.string().optional(),
    repository: z.object({
      headBefore: z.string().optional(),
      headAfter: z.string().optional(),
      branch: z.string().optional(),
      dirtyBefore: z.boolean(),
      dirtyAfter: z.boolean(),
    }),
    changedFiles: z.array(changedFileRecordSchema),
    verificationCommands: z.array(evidenceVerificationCommandSchema),
    verificationSkipped: z.boolean(),
    runnerClaims: z.object({
      outcome: z.string().optional(),
      summary: z.string().optional(),
      changedFiles: z.array(z.string()),
      commandsReported: z.array(z.string()),
      testsReported: z.array(z.object({ name: z.string(), status: z.string() })),
    }),
    violations: z.array(z.string()),
    warnings: z.array(z.string()),
    evaluatedAt: z.string(),
    manualAcceptance: manualAcceptanceSchema.optional(),
    specContext: evidenceSpecContextSchema.optional(),
  })
  .passthrough();

export type TaskEvidenceRecord = z.infer<typeof taskEvidenceRecordSchema>;

/** File-system-safe directory name for a task id like `2.3`. */
export function taskIdDirName(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function evidenceTaskDir(
  workspace: WorkspaceInfo,
  specName: string,
  taskId: string,
): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, 'evidence', specName, taskIdDirName(taskId)),
  );
}

/**
 * Persist one evidence record. Append-only: refuses to overwrite an
 * existing attempt.
 */
export function writeTaskEvidence(
  workspace: WorkspaceInfo,
  record: TaskEvidenceRecord,
): string {
  const validated = taskEvidenceRecordSchema.parse(record);
  const dir = evidenceTaskDir(workspace, validated.specName, validated.taskId);
  const filePath = path.join(dir, `${validated.runId}.json`);
  if (existsSync(filePath)) {
    throw new SpecBridgeError(
      'INVALID_STATE',
      `Evidence for run ${validated.runId} already exists at ${filePath}. ` +
        'Evidence records are append-only; a new attempt needs a new run id.',
    );
  }
  writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`);
  return filePath;
}

export interface EvidenceListResult {
  records: TaskEvidenceRecord[];
  diagnostics: Diagnostic[];
}

/** All evidence records for one task, oldest attempt first (by evaluatedAt). */
export function listTaskEvidence(
  workspace: WorkspaceInfo,
  specName: string,
  taskId: string,
): EvidenceListResult {
  const dir = evidenceTaskDir(workspace, specName, taskId);
  if (!existsSync(dir)) return { records: [], diagnostics: [] };

  const records: TaskEvidenceRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      const result = taskEvidenceRecordSchema.safeParse(parsed);
      if (result.success) {
        records.push(result.data);
      } else {
        diagnostics.push({
          severity: 'warning',
          code: 'EVIDENCE_INVALID_SHAPE',
          message: 'Evidence record does not match the expected schema; ignoring it.',
          file: filePath,
        });
      }
    } catch (cause) {
      diagnostics.push({
        severity: 'warning',
        code: 'EVIDENCE_UNREADABLE',
        message: `Evidence record could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        file: filePath,
      });
    }
  }
  records.sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt, 'en'));
  return { records, diagnostics };
}

/** Every evidence record for a spec, keyed by task id. */
export function listSpecEvidence(
  workspace: WorkspaceInfo,
  specName: string,
): Map<string, TaskEvidenceRecord[]> {
  const specDir = assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, 'evidence', specName),
  );
  const byTask = new Map<string, TaskEvidenceRecord[]>();
  if (!existsSync(specDir)) return byTask;
  for (const entry of readdirSync(specDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const { records } = listTaskEvidenceByDir(workspace, specName, entry.name);
    for (const record of records) {
      const list = byTask.get(record.taskId) ?? [];
      list.push(record);
      byTask.set(record.taskId, list);
    }
  }
  return byTask;
}

function listTaskEvidenceByDir(
  workspace: WorkspaceInfo,
  specName: string,
  dirName: string,
): EvidenceListResult {
  // dirName is already sanitized on disk; reuse the same reader.
  return listTaskEvidence(workspace, specName, dirName);
}
