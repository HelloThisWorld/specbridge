import path from 'node:path';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import {
  abortInteractiveTask,
  beginInteractiveTask,
  completeInteractiveTask,
} from '@specbridge/execution';
import { runSafeProcess } from '@specbridge/runners';
import type { RunnerRegistry } from '@specbridge/runners';
import type { Clock } from '@specbridge/workflow';
import type { FailureCategory } from '../vocabulary.js';
import { jobDir } from '../jobs/store.js';
import { fence } from '../agents/prompts.js';
import type { CandidateArtifact, WorkUnit } from './state.js';
import { runLargeObjectiveRole } from './workers.js';

/**
 * The canonical INTEGRATOR: the ONE writer that turns verified candidate
 * artifacts into canonical repository changes.
 *
 * Integration runs INSIDE the existing interactive-run bracket — the same
 * begin → mutate → complete pipeline the MCP task tools use — so the
 * repository lock, the pre/post git snapshots, protected-path enforcement,
 * trusted verification, and verified-only checkbox completion are all the
 * UNCHANGED evidence machinery. This module adds no second completion path:
 * it applies patches and reports; evidence decides.
 *
 * Authority boundaries:
 *   - only verified candidates arrive here (the driver enforces structural
 *     aggregation first)
 *   - patch application is deterministic (`git apply --3way`); when a patch
 *     genuinely conflicts, ONE bounded INTEGRATOR reconciliation dispatch
 *     may make minimal integration edits — inside the same run bracket, so
 *     everything it does is snapshotted and verified like any other change
 *   - a failed integration aborts the run: source changes are preserved for
 *     diagnosis, nothing completes, and the objective fails honestly
 */

export interface IntegrationCandidate {
  unit: WorkUnit;
  candidate: CandidateArtifact;
  /** The stored normalized patch; investigations have none. */
  patch: string | undefined;
}

export interface IntegrateObjectiveInput {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  /** Optional for source compatibility; the worker can reconstruct it from config. */
  registry?: RunnerRegistry | undefined;
  jobId: string;
  specName: string;
  /** The approved objective's task id (the checkbox the pipeline may flip). */
  taskId: string;
  objectiveNodeId: string;
  /** Verified candidates in dependency order. */
  candidates: readonly IntegrationCandidate[];
  allowDirty: boolean;
  runnerProfile: string | undefined;
  clock?: Clock | undefined;
  idFactory?: (() => string) | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /** Bounded reconciliation dispatch timeout. */
  reconcileTimeoutMs?: number | undefined;
}

export interface IntegrationSuccess {
  ok: true;
  runId: string;
  evidenceStatus: string;
  changedFiles: { path: string; contentHash?: string | undefined }[];
}

export interface IntegrationFailure {
  ok: false;
  category: FailureCategory;
  message: string;
  source: string;
  runId?: string | undefined;
  output?: string | undefined;
}

export type IntegrationResult = IntegrationSuccess | IntegrationFailure;

/** Apply one candidate patch to the canonical tree. Deterministic. */
async function applyPatch(
  workspaceRoot: string,
  patch: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await runSafeProcess({
    executable: 'git',
    argv: ['apply', '--3way', '--whitespace=nowarn', '-'],
    cwd: workspaceRoot,
    timeoutMs: 120_000,
    stdin: patch,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  });
  return { ok: result.status === 'ok', stderr: result.stderr };
}

export async function integrateObjective(input: IntegrateObjectiveInput): Promise<IntegrationResult> {
  const interactiveDeps = {
    workspace: input.workspace,
    config: input.config,
    ...(input.clock !== undefined ? { clock: input.clock } : {}),
    ...(input.idFactory !== undefined ? { idFactory: input.idFactory } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    host: 'orchestrator-integrator',
  };

  const started = await beginInteractiveTask(interactiveDeps, {
    specName: input.specName,
    taskId: input.taskId,
    allowDirty: input.allowDirty,
  });
  if (started.kind === 'blocked') {
    return {
      ok: false,
      category: started.code === 'lock-held' ? 'BLOCKED_DEPENDENCY' : 'STALE_CONTEXT',
      message: started.message,
      source: `integration:begin:${started.code}`,
    };
  }
  const runId = started.runId;
  input.onProgress?.(`integration run ${runId} started for objective task ${input.taskId}`);

  const abort = async (reason: string): Promise<void> => {
    try {
      await abortInteractiveTask(interactiveDeps, { runId, reason: reason.slice(0, 500) });
    } catch {
      // Abort is best-effort cleanup; the failure below is the real result.
    }
  };

  // Clear conflict residue a DEAD prior integration left in the git index.
  //
  // Abort deliberately never resets the working tree — what a failed run
  // changed is evidence. But unmerged INDEX entries are machinery residue,
  // not evidence, and they poison every later apply: the dogfood's
  // reconciliation worker found wu-3's content "already fully present and
  // internally consistent in the workspace" while the patch failed purely
  // because four paths sat unmerged from a run the timeout had killed.
  // Staging those paths keeps the workspace byte-for-byte as found and
  // clears only the flags. The run lock serializes writers, so unmerged
  // entries at integration start can never belong to a live run.
  {
    const unmerged = await runSafeProcess({
      executable: 'git',
      argv: ['ls-files', '-u'],
      cwd: input.workspace.rootDir,
      timeoutMs: 60_000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    if (unmerged.status === 'ok' && unmerged.stdout.trim().length > 0) {
      const paths = [...new Set(
        unmerged.stdout.trim().split('\n').map((line) => line.split('\t').pop() ?? '').filter(Boolean),
      )];
      input.onProgress?.(
        `clearing conflict residue a dead prior integration left in the index: ${paths.join(', ').slice(0, 200)}`,
      );
      await runSafeProcess({
        executable: 'git',
        argv: ['add', '--', ...paths],
        cwd: input.workspace.rootDir,
        timeoutMs: 60_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });
    }
  }

  const applied: string[] = [];
  for (const entry of input.candidates) {
    if (entry.patch === undefined || entry.patch.trim().length === 0) continue;
    const result = await applyPatch(input.workspace.rootDir, entry.patch);
    if (result.ok) {
      applied.push(entry.unit.workUnitId);
      input.onProgress?.(`applied candidate of ${entry.unit.workUnitId}`);
      continue;
    }

    // A genuine conflict between compatible-in-principle candidates: one
    // bounded INTEGRATOR reconciliation dispatch, inside the run bracket.
    input.onProgress?.(
      `candidate of ${entry.unit.workUnitId} did not apply cleanly; attempting one bounded reconciliation`,
    );
    if (input.runnerProfile === undefined) {
      await abort(`candidate patch of ${entry.unit.workUnitId} conflicts and no integrator runner is configured`);
      return {
        ok: false,
        category: 'IMPLEMENTATION_DEFECT',
        message: `The verified candidate of ${entry.unit.workUnitId} no longer applies to the canonical tree: ${result.stderr.slice(0, 400)}`,
        source: 'integration:apply',
        runId,
      };
    }
    const packet = [
      `The verified candidate change of work unit ${entry.unit.workUnitId} (goal: ${entry.unit.goal}) failed to apply to this repository.`,
      'Apply the INTENT of the patch below with minimal integration edits. Change nothing beyond what the patch intends.',
      'Do not touch .kiro/ or .specbridge/. Do not run git commands that rewrite history, push, or merge.',
      '',
      'Patch that failed to apply:',
      fence(entry.patch, 24_000),
      '',
      'git apply reported:',
      fence(result.stderr.slice(0, 4_000), 4_000),
    ].join('\n');
    const reconcile = await runLargeObjectiveRole({
      workspace: input.workspace,
      config: input.config,
      registry: input.registry,
      runnerProfile: input.runnerProfile,
      role: 'BUILDER',
      packet,
      cwd: input.workspace.rootDir,
      scratchDir: path.join(jobDir(input.workspace, input.jobId), 'scratch'),
      timeoutMs: input.reconcileTimeoutMs ?? 600_000,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!reconcile.ok || reconcile.output.outcome !== 'CANDIDATE_COMPLETE') {
      await abort(`reconciliation of ${entry.unit.workUnitId} failed`);
      return {
        ok: false,
        category: 'IMPLEMENTATION_DEFECT',
        message:
          `Candidate ${entry.unit.workUnitId} conflicts with the integrated state and reconciliation failed` +
          `${reconcile.ok ? ` (${reconcile.output.summary.slice(0, 200)})` : ` (${reconcile.problem.slice(0, 200)})`}.`,
        source: 'integration:reconcile',
        runId,
      };
    }
    applied.push(`${entry.unit.workUnitId} (reconciled)`);
  }

  const changedPaths = [
    ...new Set(
      input.candidates.flatMap((entry) => entry.candidate.changedFiles.map((file) => file.path)),
    ),
  ];
  const completion = await completeInteractiveTask(interactiveDeps, {
    runId,
    summary:
      `Canonical integration of ${applied.length} verified candidate(s) for objective task ${input.taskId}: ` +
      `${applied.join(', ') || 'no source-changing candidates'}.`,
    reportedChangedFiles: changedPaths.slice(0, 200),
  });
  if (completion.kind === 'blocked') {
    return {
      ok: false,
      category: 'STALE_CONTEXT',
      message: completion.message,
      source: `integration:complete:${completion.code}`,
      runId,
    };
  }
  if (completion.outcome === 'verified') {
    return {
      ok: true,
      runId,
      evidenceStatus: completion.report.evidenceStatus,
      changedFiles: completion.report.changedFiles.map((file) => ({
        path: file.path,
        contentHash: file.changeType,
      })),
    };
  }
  const category: FailureCategory =
    completion.outcome === 'protected-path-violation'
      ? 'SAFETY_POLICY'
      : completion.outcome === 'repository-diverged'
        ? 'REPOSITORY_DIVERGED'
        : completion.outcome === 'no-change'
          ? 'IMPLEMENTATION_DEFECT'
          : 'VERIFICATION_FAILURE';
  const failedVerifiers = completion.report.verification.commands
    .filter((command) => !command.passed)
    .map((command) => `${command.name}: ${command.status}\n${command.stdoutTail}\n${command.stderrTail}`)
    .join('\n');
  return {
    ok: false,
    category,
    message: `Integration verification did not pass (outcome ${completion.outcome}).`,
    source: 'integration:verify',
    runId,
    ...(failedVerifiers.length > 0 ? { output: failedVerifiers.slice(0, 16_384) } : {}),
  };
}
