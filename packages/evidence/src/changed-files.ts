import { Buffer } from 'node:buffer';
import { runSafeProcess } from '@specbridge/runners';
import type { GitSnapshot, GitStatusEntry } from './git-snapshot.js';

/**
 * Snapshot comparison: derive what actually changed during an agent run and
 * whether every change can be attributed to the agent.
 *
 * Attribution rules (the heart of the `--allow-dirty` policy):
 *   - a path dirty only in the AFTER snapshot          → change made during
 *     the run (attributed to it)
 *   - a path dirty in both, identical content hash     → pre-existing user
 *     change, untouched: excluded from attribution
 *   - a path dirty in both, different content hash     → the file changed
 *     during the run on top of pre-existing edits; the DELTA is attributed
 *     to the run (hash-exact), with a standing warning that the file also
 *     carries pre-existing changes
 *   - a path dirty only in BEFORE                      → the run reverted or
 *     overwrote pre-existing changes (warned)
 *   - a dirty path whose content could not be hashed   → attribution is NOT
 *     reliable; the path is flagged ambiguous and such a run never
 *     auto-verifies
 */

export type ChangeType = 'added' | 'modified' | 'deleted';

export interface ChangedFileRecord {
  path: string;
  changeType: ChangeType;
  /** The path was already dirty before the runner started. */
  preExisting: boolean;
  /** The content changed during the run (true for every agent change). */
  modifiedDuringRun: boolean;
}

export interface ProtectedViolation {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
}

export interface SnapshotComparison {
  changedFiles: ChangedFileRecord[];
  /** Files changed during the run that cannot be attributed cleanly. */
  ambiguousPaths: string[];
  /** Protected files that changed (`.kiro/**`, config, sidecar state). */
  protectedViolations: ProtectedViolation[];
  /** True when HEAD moved during the run (runners must never commit). */
  headMoved: boolean;
  warnings: string[];
}

function changeTypeFor(entry: GitStatusEntry): ChangeType {
  const status = entry.status;
  if (status === '??' || status.startsWith('A')) return 'added';
  if (status.includes('D')) return 'deleted';
  return 'modified';
}

export function compareSnapshots(before: GitSnapshot, after: GitSnapshot): SnapshotComparison {
  const warnings: string[] = [];
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));

  const changedFiles: ChangedFileRecord[] = [];
  const ambiguousPaths: string[] = [];

  for (const entry of after.entries) {
    const previous = beforeByPath.get(entry.path);
    if (previous === undefined) {
      changedFiles.push({
        path: entry.path,
        changeType: changeTypeFor(entry),
        preExisting: false,
        modifiedDuringRun: true,
      });
      continue;
    }
    const bothDeleted = previous.contentHash === undefined && entry.contentHash === undefined;
    const hashesReliable =
      (previous.contentHash !== undefined && entry.contentHash !== undefined) || bothDeleted;
    const contentUnchanged =
      previous.contentHash === entry.contentHash && previous.status === entry.status;
    if (contentUnchanged) {
      changedFiles.push({
        path: entry.path,
        changeType: changeTypeFor(entry),
        preExisting: true,
        modifiedDuringRun: false,
      });
      continue;
    }
    changedFiles.push({
      path: entry.path,
      changeType: changeTypeFor(entry),
      preExisting: true,
      modifiedDuringRun: true,
    });
    if (hashesReliable) {
      warnings.push(
        `"${entry.path}" changed during the run but also carries pre-existing changes; only the during-run delta is attributed to the task.`,
      );
    } else {
      ambiguousPaths.push(entry.path);
      warnings.push(
        `"${entry.path}" changed during the run but its content could not be hashed; attribution is unreliable.`,
      );
    }
  }

  for (const entry of before.entries) {
    if (afterByPath.has(entry.path)) continue;
    // Dirty before, clean after: the run reverted or overwrote pre-existing
    // changes. The delta is the run's doing; warn loudly about the loss.
    changedFiles.push({
      path: entry.path,
      changeType: 'modified',
      preExisting: true,
      modifiedDuringRun: true,
    });
    warnings.push(
      `"${entry.path}" was modified before the run but clean afterwards; pre-existing changes were overwritten or reverted during the run.`,
    );
  }

  changedFiles.sort((a, b) => a.path.localeCompare(b.path, 'en'));

  const protectedViolations = compareProtectedHashes(before.protectedHashes, after.protectedHashes);

  const headMoved = before.head !== after.head;
  if (headMoved) {
    warnings.push(
      `HEAD moved during the run (${before.head ?? '(none)'} → ${after.head ?? '(none)'}); runners must never create commits.`,
    );
  }

  return { changedFiles, ambiguousPaths, protectedViolations, headMoved, warnings };
}

/** Byte-exact protected-file comparison (`.kiro/**`, config, sidecar state). */
export function compareProtectedHashes(
  beforeProtected: Record<string, string>,
  afterProtected: Record<string, string>,
): ProtectedViolation[] {
  const protectedViolations: ProtectedViolation[] = [];
  for (const [file, hash] of Object.entries(afterProtected)) {
    const previous = beforeProtected[file];
    if (previous === undefined) protectedViolations.push({ path: file, kind: 'added' });
    else if (previous !== hash) protectedViolations.push({ path: file, kind: 'modified' });
  }
  for (const file of Object.keys(beforeProtected)) {
    if (!(file in afterProtected)) protectedViolations.push({ path: file, kind: 'deleted' });
  }
  protectedViolations.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return protectedViolations;
}

/** Files changed by the agent (excludes untouched pre-existing changes). */
export function agentChangedFiles(comparison: SnapshotComparison): ChangedFileRecord[] {
  return comparison.changedFiles.filter((file) => file.modifiedDuringRun);
}

export interface PatchCapture {
  captured: boolean;
  truncated: boolean;
  /** Unified diff of tracked changes against HEAD (untracked files are listed, not diffed). */
  patch?: string;
  byteLength: number;
  note?: string;
}

const PATCH_TIMEOUT_MS = 60_000;

/** Capture `git diff HEAD` subject to a byte limit. Read-only. */
export async function capturePatch(
  workspaceRoot: string,
  maximumPatchBytes: number,
): Promise<PatchCapture> {
  const result = await runSafeProcess({
    executable: 'git',
    argv: ['diff', 'HEAD'],
    cwd: workspaceRoot,
    timeoutMs: PATCH_TIMEOUT_MS,
    maxStdoutBytes: maximumPatchBytes,
    maxStderrBytes: 64 * 1024,
  });
  if (result.status === 'output-limit') {
    return {
      captured: false,
      truncated: true,
      byteLength: Buffer.byteLength(result.stdout, 'utf8'),
      note: `patch exceeded the configured limit of ${maximumPatchBytes} bytes and was not retained; the changed-file list is complete`,
    };
  }
  if (result.status !== 'ok') {
    return {
      captured: false,
      truncated: false,
      byteLength: 0,
      note: `git diff failed: ${result.failureReason ?? result.status}`,
    };
  }
  return {
    captured: true,
    truncated: false,
    patch: result.stdout,
    byteLength: Buffer.byteLength(result.stdout, 'utf8'),
  };
}
