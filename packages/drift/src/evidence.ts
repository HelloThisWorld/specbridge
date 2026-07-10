import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';

/**
 * Task evidence records live in `.specbridge/evidence/<spec>/<task>.json`.
 *
 * A task is never considered done just because an agent said so; evidence
 * (changed files, command exit codes, explicit human approval) must exist
 * before SpecBridge marks a checkbox complete.
 */

export const taskEvidenceSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(['recorded', 'verified', 'rejected']),
    changedFiles: z.array(z.string()).optional(),
    commands: z
      .array(
        z.object({
          command: z.string(),
          exitCode: z.number(),
        }),
      )
      .optional(),
    approvedBy: z.string().optional(),
    notes: z.string().optional(),
    verifiedAt: z.string().optional(),
  })
  .passthrough();

export type TaskEvidence = z.infer<typeof taskEvidenceSchema>;

/** File-system-safe name for a task id like `2.3`. */
export function evidenceFileName(taskId: string): string {
  return `${taskId.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
}

export function evidenceDir(workspace: WorkspaceInfo, specName: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, 'evidence', specName),
  );
}

export interface EvidenceReadResult {
  evidence: TaskEvidence[];
  diagnostics: Diagnostic[];
}

/** Read all evidence records for a spec. Invalid records degrade to diagnostics. */
export function listTaskEvidence(workspace: WorkspaceInfo, specName: string): EvidenceReadResult {
  const dir = evidenceDir(workspace, specName);
  if (!existsSync(dir)) return { evidence: [], diagnostics: [] };

  const evidence: TaskEvidence[] = [];
  const diagnostics: Diagnostic[] = [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));

  for (const name of entries) {
    const filePath = path.join(dir, name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      const result = taskEvidenceSchema.safeParse(parsed);
      if (result.success) {
        evidence.push(result.data);
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
        message: cause instanceof Error ? cause.message : String(cause),
        file: filePath,
      });
    }
  }
  return { evidence, diagnostics };
}

/** Persist one evidence record atomically. */
export function writeTaskEvidence(
  workspace: WorkspaceInfo,
  specName: string,
  evidence: TaskEvidence,
): string {
  const filePath = path.join(evidenceDir(workspace, specName), evidenceFileName(evidence.taskId));
  writeFileAtomic(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return filePath;
}
