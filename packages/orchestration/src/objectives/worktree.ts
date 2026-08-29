import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { VerificationCommand, WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace } from '@specbridge/core';
import type { VerificationRunResult } from '@specbridge/evidence';
import { runVerificationCommands } from '@specbridge/evidence';
import { runSafeProcess } from '@specbridge/runners';
import { OrchestrationError } from '../errors.js';
import { jobDir } from '../jobs/store.js';

/**
 * Isolated builder workspaces: one git worktree per (workUnit, attempt).
 *
 * A worktree is a CANDIDATE workspace, never the source of completion
 * truth: builders edit here, SpecBridge computes the diff against the
 * recorded baseline commit (so even a worker that commits locally cannot
 * hide changes), local verification runs here, and the only path into the
 * canonical tree is the single-writer integrator.
 *
 * Hard rules, all tested:
 *   - worktrees live under `.specbridge/jobs/<jobId>/worktrees/` — inside
 *     the sidecar, excluded from evidence snapshots, path-checked
 *   - nothing here ever pushes, merges, or mutates the canonical checkout
 *   - a candidate touching `.kiro/`, `.specbridge/`, or a configured
 *     protected path is refused at collection time (fail closed)
 *   - removal is forced and idempotent; `git worktree prune` reconciles
 *     after crashes
 */

const GIT_TIMEOUT_MS = 60_000;

async function git(
  cwd: string,
  argv: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runSafeProcess({
    executable: 'git',
    argv,
    cwd,
    timeoutMs,
    maxStdoutBytes: 32 * 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  });
  return { ok: result.status === 'ok', stdout: result.stdout, stderr: result.stderr };
}

export interface WorktreeHandle {
  /** Worktree directory name (unique per work-unit attempt). */
  name: string;
  /** Absolute directory of the isolated checkout. */
  dir: string;
  /** Commit the worktree was created from; diffs are computed against it. */
  baselineCommit: string;
}

export function worktreesRootDir(workspace: WorkspaceInfo, jobId: string): string {
  return path.join(jobDir(workspace, jobId), 'worktrees');
}

export interface CreateWorktreeInput {
  workspace: WorkspaceInfo;
  jobId: string;
  workUnitId: string;
  attempt: number;
}

/** Read the canonical baseline without creating or mutating a worktree. */
export async function readCanonicalHead(workspace: WorkspaceInfo): Promise<string> {
  const head = await git(workspace.rootDir, ['rev-parse', 'HEAD']);
  if (!head.ok || head.stdout.trim().length === 0) {
    throw new OrchestrationError('SBO048', 'The repository has no readable HEAD for an investigation baseline.', {
      remediation: ['Initialize git and commit the current state first.'],
      failureCategory: 'BLOCKED_DEPENDENCY',
    });
  }
  return head.stdout.trim();
}

/** Create one detached worktree at the canonical HEAD. */
export async function createWorkerWorktree(input: CreateWorktreeInput): Promise<WorktreeHandle> {
  const name = `${input.workUnitId}-a${String(input.attempt).padStart(2, '0')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
    throw new OrchestrationError('SBO048', `Invalid worktree name "${name}".`);
  }
  const dir = assertInsideWorkspace(
    input.workspace.rootDir,
    path.join(worktreesRootDir(input.workspace, input.jobId), name),
  );

  const baselineCommit = await readCanonicalHead(input.workspace);

  if (existsSync(dir)) {
    // A crashed previous attempt left a checkout behind; reconcile before
    // creating, so the new attempt starts from a clean baseline.
    await removeWorkerWorktree(input.workspace, input.jobId, { dir });
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  const added = await git(input.workspace.rootDir, ['worktree', 'add', '--detach', dir, baselineCommit], 180_000);
  if (!added.ok) {
    throw new OrchestrationError('SBO048', `git worktree add failed: ${added.stderr.slice(0, 500)}`, {
      failureCategory: 'TRANSIENT_TOOL',
    });
  }
  return { name, dir, baselineCommit };
}

/**
 * Apply verified dependency patches into a fresh worktree so a dependent
 * unit builds on top of its prerequisites' candidates. `--3way` lets clean
 * textual merges through; a genuine conflict fails the creation of THIS
 * attempt rather than producing a silently wrong baseline.
 */
export async function applyDependencyPatches(
  handle: WorktreeHandle,
  patches: readonly { workUnitId: string; patch: string }[],
): Promise<void> {
  for (const entry of patches) {
    if (entry.patch.trim().length === 0) continue;
    const result = await runSafeProcess({
      executable: 'git',
      argv: ['apply', '--3way', '--whitespace=nowarn', '-'],
      cwd: handle.dir,
      timeoutMs: GIT_TIMEOUT_MS,
      stdin: entry.patch,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 4 * 1024 * 1024,
    });
    if (result.status !== 'ok') {
      throw new OrchestrationError(
        'SBO048',
        `Applying the verified candidate of ${entry.workUnitId} into the worktree failed: ${result.stderr.slice(0, 400)}`,
        { failureCategory: 'REPOSITORY_DIVERGED' },
      );
    }
  }
}

export interface CollectedChanges {
  changedFiles: { path: string; changeType: 'added' | 'modified' | 'deleted' | 'renamed' }[];
  /** Normalized patch against the baseline commit (binary-safe). */
  patch: string;
  /** Paths that violate the protected-path rules, when any. */
  protectedViolations: string[];
}

function changeTypeOf(status: string): 'added' | 'modified' | 'deleted' | 'renamed' {
  if (status.includes('R')) return 'renamed';
  if (status.includes('D')) return 'deleted';
  if (status.includes('A') || status.includes('?')) return 'added';
  return 'modified';
}

/**
 * Observe what a builder actually changed: `git status`/`git diff` against
 * the recorded baseline, with untracked files staged into the index first
 * so the patch is complete. The worktree is disposable; staging in it is
 * not a mutation of anything canonical.
 */
export async function collectWorktreeChanges(
  handle: WorktreeHandle,
  options: { protectedPaths: readonly string[] },
): Promise<CollectedChanges> {
  const stage = await git(handle.dir, ['add', '-A']);
  if (!stage.ok) {
    throw new OrchestrationError('SBO048', `git add in the worktree failed: ${stage.stderr.slice(0, 400)}`);
  }
  const status = await git(handle.dir, ['diff', '--name-status', '--cached', handle.baselineCommit]);
  if (!status.ok) {
    throw new OrchestrationError('SBO048', `git diff in the worktree failed: ${status.stderr.slice(0, 400)}`);
  }
  const changedFiles: CollectedChanges['changedFiles'] = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const [code, ...paths] = line.split('\t');
    const filePath = paths.at(-1);
    if (code === undefined || filePath === undefined || filePath.length === 0) continue;
    changedFiles.push({ path: filePath.replace(/\\/g, '/'), changeType: changeTypeOf(code) });
  }

  const protectedPrefixes = ['.kiro/', '.specbridge/', ...options.protectedPaths];
  const protectedViolations = changedFiles
    .map((file) => file.path)
    .filter((filePath) =>
      protectedPrefixes.some(
        (prefix) => filePath === prefix.replace(/\/$/, '') || filePath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || filePath.startsWith(prefix),
      ),
    );

  const diff = await git(handle.dir, ['diff', '--binary', '--cached', handle.baselineCommit], 120_000);
  if (!diff.ok) {
    throw new OrchestrationError('SBO048', `git diff --binary in the worktree failed: ${diff.stderr.slice(0, 400)}`);
  }
  return { changedFiles, patch: diff.stdout, protectedViolations };
}

/** Run the TRUSTED configured verification commands inside the worktree. */
export async function runWorktreeVerification(
  handle: WorktreeHandle,
  commands: VerificationCommand[],
  signal?: AbortSignal,
): Promise<VerificationRunResult> {
  return runVerificationCommands(handle.dir, commands, {
    ...(signal !== undefined ? { signal } : {}),
  });
}

/** Remove a worktree. Forced, idempotent, best-effort on the directory. */
export async function removeWorkerWorktree(
  workspace: WorkspaceInfo,
  jobId: string,
  handle: Pick<WorktreeHandle, 'dir'>,
): Promise<void> {
  await git(workspace.rootDir, ['worktree', 'remove', '--force', handle.dir], 120_000);
  try {
    rmSync(handle.dir, { recursive: true, force: true });
  } catch {
    // Held file handles on Windows can defer removal; prune covers it later.
  }
  await git(workspace.rootDir, ['worktree', 'prune']);
  void jobId;
}

/** Reconcile crashed worktrees on resume: prune and clear the directory. */
export async function pruneWorktrees(workspace: WorkspaceInfo, jobId: string): Promise<string[]> {
  const removed: string[] = [];
  const root = worktreesRootDir(workspace, jobId);
  if (existsSync(root)) {
    const { readdirSync } = await import('node:fs');
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      await git(workspace.rootDir, ['worktree', 'remove', '--force', dir], 120_000);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort; prune handles the registry.
      }
      removed.push(entry.name);
    }
  }
  await git(workspace.rootDir, ['worktree', 'prune']);
  return removed;
}
