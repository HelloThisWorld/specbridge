import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Diagnostic } from '@specbridge/core';
import { runSafeProcess } from '@specbridge/runners';

/**
 * Pre-run and post-run repository snapshots.
 *
 * A snapshot records everything evidence evaluation needs to compare the
 * *actual* repository state around an agent run:
 *
 *   - HEAD commit and branch (a moved HEAD after a run is a violation:
 *     runners must never commit)
 *   - `git status --porcelain` entries with working-content hashes, so
 *     changes made *during* a run are distinguishable from pre-existing
 *     dirty files even under `--allow-dirty`
 *   - content hashes of every protected file (`.kiro/**`,
 *     `.specbridge/config.json`, `.specbridge/state/**`), so a protected
 *     write is detected byte-exactly even if git would not show it
 *
 * Snapshots are read-only. Symlinks are recorded but never followed, so a
 * link pointing outside the repository cannot leak or attribute content.
 */

export const GIT_SNAPSHOT_SCHEMA_VERSION = '1.0.0';

export interface GitStatusEntry {
  /** Repository-relative path with forward slashes. */
  path: string;
  /** Two-character porcelain XY status (e.g. ` M`, `??`, `A `). */
  status: string;
  /** SHA-256 of current working content; absent for deletions and non-files. */
  contentHash?: string;
}

export interface GitSnapshot {
  schemaVersion: string;
  capturedAt: string;
  gitAvailable: boolean;
  /** Current commit; absent in a repository with no commits yet. */
  head?: string;
  branch?: string;
  detached: boolean;
  clean: boolean;
  entries: GitStatusEntry[];
  /** Path prefixes excluded from `entries` (SpecBridge's own run artifacts). */
  excludedPrefixes: string[];
  /** Protected file path → SHA-256 of exact bytes. */
  protectedHashes: Record<string, string>;
  diagnostics: Diagnostic[];
}

/**
 * Prefixes always excluded from status entries: SpecBridge's own sidecar.
 * Run artifacts, evidence, and state are SpecBridge writes, and the user may
 * edit config.json between runs — none of that is agent work. Integrity of
 * `.specbridge/config.json` and `.specbridge/state/**` during a run is still
 * guarded byte-exactly through `protectedHashes`.
 */
export const SNAPSHOT_EXCLUDED_PREFIXES = ['.specbridge/'];

const GIT_TIMEOUT_MS = 30_000;

async function git(
  workspaceRoot: string,
  argv: string[],
): Promise<{ ok: boolean; stdout: string; reason?: string }> {
  const result = await runSafeProcess({
    executable: 'git',
    argv,
    cwd: workspaceRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    maxStdoutBytes: 64 * 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  if (result.status !== 'ok') {
    return { ok: false, stdout: result.stdout, reason: result.failureReason ?? result.status };
  }
  return { ok: true, stdout: result.stdout };
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

function hashFileIfRegular(absolutePath: string): string | undefined {
  try {
    const stats = lstatSync(absolutePath);
    if (!stats.isFile()) return undefined; // symlinks and directories are never followed
    return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  } catch {
    return undefined;
  }
}

/** Parse `git status --porcelain -z` output (NUL-separated, rename pairs). */
export function parsePorcelainStatus(raw: string): { path: string; status: string }[] {
  const entries: { path: string; status: string }[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.length === 0) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    if (filePath.length === 0) continue;
    entries.push({ path: filePath, status });
    // Renames/copies carry the original path as the next NUL token.
    if (status.startsWith('R') || status.startsWith('C')) i += 1;
  }
  return entries;
}

function isExcluded(relativePath: string, excludedPrefixes: string[]): boolean {
  return excludedPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

/** Recursively hash regular files under `dir` (never following symlinks). */
function hashProtectedTree(
  workspaceRoot: string,
  relativeDir: string,
  into: Record<string, string>,
): void {
  const absoluteDir = path.join(workspaceRoot, relativeDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    if (entry.isDirectory()) {
      hashProtectedTree(workspaceRoot, relative, into);
    } else if (entry.isFile()) {
      const hash = hashFileIfRegular(path.join(workspaceRoot, relative));
      if (hash !== undefined) into[toPosix(relative)] = hash;
    }
  }
}

export interface CaptureSnapshotOptions {
  clock?: () => Date;
  /** Additional excluded prefixes (forward slashes, workspace-relative). */
  extraExcludedPrefixes?: string[];
}

export async function captureGitSnapshot(
  workspaceRoot: string,
  options: CaptureSnapshotOptions = {},
): Promise<GitSnapshot> {
  const now = options.clock?.() ?? new Date();
  const diagnostics: Diagnostic[] = [];
  const excludedPrefixes = [
    ...SNAPSHOT_EXCLUDED_PREFIXES,
    ...(options.extraExcludedPrefixes ?? []),
  ];

  const inside = await git(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    diagnostics.push({
      severity: 'error',
      code: 'GIT_UNAVAILABLE',
      message: `The workspace is not a usable git work tree (${inside.reason ?? 'rev-parse returned unexpected output'}).`,
    });
    return {
      schemaVersion: GIT_SNAPSHOT_SCHEMA_VERSION,
      capturedAt: now.toISOString(),
      gitAvailable: false,
      detached: false,
      clean: false,
      entries: [],
      excludedPrefixes,
      protectedHashes: {},
      diagnostics,
    };
  }

  let head: string | undefined;
  const headResult = await git(workspaceRoot, ['rev-parse', 'HEAD']);
  if (headResult.ok) {
    head = headResult.stdout.trim();
  } else {
    diagnostics.push({
      severity: 'warning',
      code: 'GIT_NO_HEAD',
      message: 'The repository has no commits yet (HEAD cannot be resolved).',
    });
  }

  let branch: string | undefined;
  let detached = false;
  const branchResult = await git(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchResult.ok) {
    const name = branchResult.stdout.trim();
    if (name === 'HEAD') detached = true;
    else branch = name;
  }

  const statusResult = await git(workspaceRoot, ['status', '--porcelain', '-z']);
  if (!statusResult.ok) {
    diagnostics.push({
      severity: 'error',
      code: 'GIT_STATUS_FAILED',
      message: `"git status" failed: ${statusResult.reason ?? 'unknown error'}.`,
    });
  }
  const rawEntries = statusResult.ok ? parsePorcelainStatus(statusResult.stdout) : [];

  const entries: GitStatusEntry[] = [];
  for (const rawEntry of rawEntries) {
    if (isExcluded(rawEntry.path, excludedPrefixes)) continue;
    // An untracked directory entry (`?? dir/`) hides its contents; expand it
    // so individual files get hashes and precise attribution.
    if (rawEntry.status === '??' && rawEntry.path.endsWith('/')) {
      const expanded: Record<string, string> = {};
      hashProtectedTree(workspaceRoot, rawEntry.path.slice(0, -1).split('/').join(path.sep), expanded);
      const files = Object.keys(expanded).sort();
      if (files.length === 0) {
        entries.push({ path: rawEntry.path, status: rawEntry.status });
      }
      for (const file of files) {
        if (isExcluded(file, excludedPrefixes)) continue;
        const hash = expanded[file];
        entries.push({
          path: file,
          status: '??',
          ...(hash !== undefined ? { contentHash: hash } : {}),
        });
      }
      continue;
    }
    const hash = hashFileIfRegular(path.join(workspaceRoot, rawEntry.path.split('/').join(path.sep)));
    entries.push({
      path: rawEntry.path,
      status: rawEntry.status,
      ...(hash !== undefined ? { contentHash: hash } : {}),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));

  const protectedHashes: Record<string, string> = {};
  hashProtectedTree(workspaceRoot, '.kiro', protectedHashes);
  const configHash = hashFileIfRegular(path.join(workspaceRoot, '.specbridge', 'config.json'));
  if (configHash !== undefined) protectedHashes['.specbridge/config.json'] = configHash;
  hashProtectedTree(workspaceRoot, path.join('.specbridge', 'state'), protectedHashes);

  return {
    schemaVersion: GIT_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: now.toISOString(),
    gitAvailable: statusResult.ok,
    ...(head !== undefined ? { head } : {}),
    ...(branch !== undefined ? { branch } : {}),
    detached,
    clean: entries.length === 0,
    entries,
    excludedPrefixes,
    protectedHashes: sortRecord(protectedHashes),
    diagnostics,
  };
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}
