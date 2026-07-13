import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { runTypeForKind } from '@specbridge/core';
import type { GitSnapshot, TaskEvidenceRecord, VerificationRunResult } from '@specbridge/evidence';
import type { RunRecord } from '@specbridge/execution';
import { readRunArtifactJson } from '@specbridge/execution';

/**
 * Safe run views.
 *
 * Run directories retain everything for local auditing — prompts, raw
 * runner output, full verification logs. None of that crosses the MCP
 * boundary: these views expose lifecycle facts, Git summaries, verification
 * outcomes, and artifact NAMES, never raw prompts, raw stdout/stderr,
 * command output, or environment values.
 */

export const runSummaryShape = z.object({
  runId: z.string(),
  kind: z.string(),
  runType: z.enum([
    'runner-execution',
    'runner-authoring',
    'interactive-execution',
    'interactive-authoring',
    'deterministic-verification',
  ]),
  specName: z.string(),
  taskId: z.string().optional(),
  stage: z.string().optional(),
  runner: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().optional(),
  outcome: z.string().optional(),
  evidenceStatus: z.string().optional(),
  lifecycleStatus: z.string().optional(),
  host: z.string().optional(),
  abortReason: z.string().optional(),
  parentRunId: z.string().optional(),
});
export type RunSummaryView = z.infer<typeof runSummaryShape>;

export function toRunSummary(record: RunRecord): RunSummaryView {
  return {
    runId: record.runId,
    kind: record.kind,
    runType: runTypeForKind(record.kind),
    specName: record.specName,
    ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
    ...(record.stage !== undefined ? { stage: record.stage } : {}),
    runner: record.runner,
    createdAt: record.createdAt,
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
    ...(record.evidenceStatus !== undefined ? { evidenceStatus: record.evidenceStatus } : {}),
    ...(record.lifecycleStatus !== undefined ? { lifecycleStatus: record.lifecycleStatus } : {}),
    ...(record.host !== undefined ? { host: record.host } : {}),
    ...(record.abortReason !== undefined ? { abortReason: record.abortReason } : {}),
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
  };
}

export const gitSummaryShape = z.object({
  head: z.string().optional(),
  branch: z.string().optional(),
  clean: z.boolean().optional(),
  dirtyPaths: z.number().int().optional(),
});

export const runDetailShape = z.object({
  summary: runSummaryShape,
  gitBefore: gitSummaryShape.optional(),
  gitAfter: gitSummaryShape.optional(),
  changedFiles: z
    .array(
      z.object({
        path: z.string(),
        changeType: z.string(),
        preExisting: z.boolean(),
        modifiedDuringRun: z.boolean(),
      }),
    )
    .optional(),
  verification: z
    .object({
      ran: z.boolean(),
      skipped: z.boolean(),
      configured: z.boolean(),
      passed: z.boolean(),
      commands: z.array(
        z.object({
          name: z.string(),
          required: z.boolean(),
          passed: z.boolean(),
          exitCode: z.number().nullable(),
          durationMs: z.number(),
        }),
      ),
    })
    .optional(),
  violations: z.array(z.string()).optional(),
  warnings: z.array(z.string()),
  artifacts: z.array(z.string()).describe('Artifact file names inside the run directory'),
  artifactsDir: z.string().describe('Repository-relative run directory'),
});
export type RunDetailView = z.infer<typeof runDetailShape>;

function toGitSummary(snapshot: GitSnapshot | undefined): z.infer<typeof gitSummaryShape> | undefined {
  if (snapshot === undefined) return undefined;
  return {
    ...(snapshot.head !== undefined ? { head: snapshot.head } : {}),
    ...(snapshot.branch !== undefined ? { branch: snapshot.branch } : {}),
    clean: snapshot.clean,
    dirtyPaths: snapshot.entries.length,
  };
}

export function buildRunDetail(
  workspace: WorkspaceInfo,
  record: RunRecord,
  artifactNames: string[],
): RunDetailView {
  const before = readRunArtifactJson(workspace, record.runId, 'git-before.json') as
    | GitSnapshot
    | undefined;
  const after = readRunArtifactJson(workspace, record.runId, 'git-after.json') as
    | GitSnapshot
    | undefined;
  const evidence = readRunArtifactJson(workspace, record.runId, 'evidence.json') as
    | TaskEvidenceRecord
    | undefined;
  const verification = readRunArtifactJson(workspace, record.runId, 'verification.json') as
    | VerificationRunResult
    | undefined;

  const gitBefore = toGitSummary(before);
  const gitAfter = toGitSummary(after);

  return {
    summary: toRunSummary(record),
    ...(gitBefore !== undefined ? { gitBefore } : {}),
    ...(gitAfter !== undefined ? { gitAfter } : {}),
    ...(evidence !== undefined
      ? {
          changedFiles: evidence.changedFiles.map((file) => ({
            path: file.path,
            changeType: file.changeType,
            preExisting: file.preExisting,
            modifiedDuringRun: file.modifiedDuringRun,
          })),
          violations: evidence.violations,
        }
      : {}),
    ...(verification !== undefined
      ? {
          verification: {
            ran: verification.ran,
            skipped: verification.skipped,
            configured: verification.configured,
            passed: verification.passed,
            commands: verification.commands.map((command) => ({
              name: command.name,
              required: command.required,
              passed: command.passed,
              exitCode: command.exitCode ?? null,
              durationMs: command.durationMs,
            })),
          },
        }
      : {}),
    warnings: record.warnings,
    artifacts: artifactNames,
    artifactsDir: `.specbridge/runs/${record.runId}`,
  };
}
