import { lstatSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ChangedFileType, ComparisonDescriptor } from '@specbridge/core';
import { runSafeProcess } from '@specbridge/runners';

/**
 * Git comparison resolution: turn a requested comparison (revision range,
 * working tree, or staged changes) into a normalized changed-file list.
 *
 * Security posture:
 *   - git runs as an argv array via runSafeProcess — no shell, ever
 *   - refs are validated before use and may never start with `-`
 *   - `-z` output is used throughout, so UTF-8 paths and spaces survive
 *   - nothing here fetches, commits, or writes anything
 *
 * All diffs run with `--relative` from the workspace root, so paths are
 * workspace-relative and the comparison is scoped to the workspace subtree
 * even when the `.kiro` workspace sits inside a larger repository.
 */

export type ComparisonRequest =
  | { mode: 'diff'; base: string; head: string }
  | { mode: 'working-tree' }
  | { mode: 'staged' };

export interface ComparisonChangedFile {
  /** Repository-relative path, forward slashes. */
  path: string;
  oldPath?: string;
  changeType: ChangedFileType;
  binary: boolean;
  insertions?: number;
  deletions?: number;
  /** The path is a symlink whose target resolves outside the repository. */
  symlinkOutsideRepository: boolean;
}

export type ComparisonFailureReason =
  | 'git-unavailable'
  | 'not-a-repository'
  | 'invalid-ref'
  | 'ref-not-found'
  | 'no-merge-base'
  | 'no-commits';

export interface ResolvedComparison {
  ok: boolean;
  descriptor: ComparisonDescriptor;
  changedFiles: ComparisonChangedFile[];
  /** Present when `ok` is false. */
  failure?: {
    reason: ComparisonFailureReason;
    message: string;
    /** True when the repository is a shallow clone (fetch-depth hint applies). */
    shallow: boolean;
  };
}

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_STDOUT = 64 * 1024 * 1024;

async function git(
  cwd: string,
  argv: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | undefined }> {
  const result = await runSafeProcess({
    executable: 'git',
    argv,
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxStdoutBytes: GIT_MAX_STDOUT,
    maxStderrBytes: 1024 * 1024,
    ...(signal !== undefined ? { signal } : {}),
  });
  return {
    ok: result.status === 'ok',
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.observation.exitCode,
  };
}

/**
 * A ref is acceptable when it cannot be mistaken for a git option and
 * contains no whitespace, control, or glob characters. `~` and `^` stay
 * allowed (HEAD~1, HEAD^2). Existence is checked separately with
 * `git rev-parse --verify`.
 */
export function isSafeGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 256) return false;
  if (ref.startsWith('-')) return false;
  if (/[\s\0:?*[\\]/.test(ref)) return false;
  return true;
}

/** Split `base...head` (or `base..head`) into endpoints. */
export function parseDiffRange(range: string): { base: string; head: string } | undefined {
  const threeDot = range.split('...');
  if (threeDot.length === 2 && threeDot[0] !== undefined && threeDot[1] !== undefined) {
    const base = threeDot[0].trim();
    const head = threeDot[1].trim() === '' ? 'HEAD' : threeDot[1].trim();
    if (base === '') return undefined;
    return { base, head };
  }
  const twoDot = range.split('..');
  if (twoDot.length === 2 && twoDot[0] !== undefined && twoDot[1] !== undefined) {
    const base = twoDot[0].trim();
    const head = twoDot[1].trim() === '' ? 'HEAD' : twoDot[1].trim();
    if (base === '') return undefined;
    return { base, head };
  }
  return undefined;
}

function statusFor(code: string): ChangedFileType | undefined {
  switch (code.charAt(0)) {
    case 'A':
      return 'added';
    case 'M':
    case 'T':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return undefined;
  }
}

/** Parse `git diff --name-status -z` output (NUL-separated tokens). */
export function parseNameStatusZ(raw: string): ComparisonChangedFile[] {
  const changes: ComparisonChangedFile[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (code === undefined || code.length === 0) continue;
    const changeType = statusFor(code);
    if (changeType === undefined) {
      // Unknown status letter: skip its path token defensively.
      i += 1;
      continue;
    }
    if (changeType === 'renamed' || changeType === 'copied') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 2;
      if (oldPath === undefined || newPath === undefined || newPath.length === 0) continue;
      changes.push({
        path: newPath,
        oldPath,
        changeType,
        binary: false,
        symlinkOutsideRepository: false,
      });
    } else {
      const filePath = tokens[i + 1];
      i += 1;
      if (filePath === undefined || filePath.length === 0) continue;
      changes.push({ path: filePath, changeType, binary: false, symlinkOutsideRepository: false });
    }
  }
  return changes;
}

/** Parse `git diff --numstat -z` output into per-path line counts. */
export function parseNumstatZ(
  raw: string,
): Map<string, { insertions?: number; deletions?: number; binary: boolean }> {
  const stats = new Map<string, { insertions?: number; deletions?: number; binary: boolean }>();
  // -z numstat: `ins\tdel\t<path>\0` or, for renames, `ins\tdel\t\0old\0new\0`.
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.length === 0) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
    if (match === null) continue;
    const insertions = match[1] === '-' ? undefined : Number(match[1]);
    const deletions = match[2] === '-' ? undefined : Number(match[2]);
    const binary = match[1] === '-' && match[2] === '-';
    let filePath = match[3] ?? '';
    if (filePath.length === 0) {
      // Rename form: the next two tokens are old and new path.
      const newPath = tokens[i + 2];
      i += 2;
      if (newPath === undefined) continue;
      filePath = newPath;
    }
    stats.set(filePath, {
      ...(insertions !== undefined ? { insertions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
      binary,
    });
  }
  return stats;
}

function mergeNumstat(
  files: ComparisonChangedFile[],
  stats: Map<string, { insertions?: number; deletions?: number; binary: boolean }>,
): void {
  for (const file of files) {
    const stat = stats.get(file.path);
    if (stat === undefined) continue;
    if (stat.insertions !== undefined) file.insertions = stat.insertions;
    if (stat.deletions !== undefined) file.deletions = stat.deletions;
    file.binary = stat.binary;
  }
}

/** git-style binary sniff: a NUL byte in the first 8000 bytes. */
function sniffBinary(absolutePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(8000);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Detect symlinks whose resolved target escapes the repository root. */
function flagSymlinkEscapes(repoRoot: string, files: ComparisonChangedFile[]): void {
  const resolvedRoot = (() => {
    try {
      return realpathSync(repoRoot);
    } catch {
      return path.resolve(repoRoot);
    }
  })();
  for (const file of files) {
    if (file.changeType === 'deleted') continue;
    const absolute = path.join(repoRoot, file.path.split('/').join(path.sep));
    try {
      const stats = lstatSync(absolute);
      if (!stats.isSymbolicLink()) continue;
      const target = realpathSync(absolute);
      const relative = path.relative(resolvedRoot, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        file.symlinkOutsideRepository = true;
      }
    } catch {
      // Missing/broken links cannot leak content; ignore.
    }
  }
}

function sortFiles(files: ComparisonChangedFile[]): ComparisonChangedFile[] {
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

async function isShallow(repoRoot: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(repoRoot, ['rev-parse', '--is-shallow-repository'], signal);
  return result.ok && result.stdout.trim() === 'true';
}

async function resolveSha(
  repoRoot: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], signal);
  return result.ok ? result.stdout.trim() : undefined;
}

export interface ResolveComparisonOptions {
  signal?: AbortSignal;
}

/**
 * Resolve a comparison request against a repository. Never throws for git
 * or ref problems — failures come back structured so the rule engine can
 * emit SBV021 with actionable remediation.
 */
export async function resolveComparison(
  repoRoot: string,
  request: ComparisonRequest,
  options: ResolveComparisonOptions = {},
): Promise<ResolvedComparison> {
  const signal = options.signal;
  const descriptor: ComparisonDescriptor = {
    mode: request.mode,
    base: request.mode === 'diff' ? request.base : null,
    head: request.mode === 'diff' ? request.head : null,
    baseSha: null,
    headSha: null,
    label:
      request.mode === 'diff'
        ? `${request.base}...${request.head}`
        : request.mode === 'working-tree'
          ? 'working tree vs HEAD'
          : 'staged changes vs HEAD',
  };

  const failed = (
    reason: ComparisonFailureReason,
    message: string,
    shallow = false,
  ): ResolvedComparison => ({
    ok: false,
    descriptor,
    changedFiles: [],
    failure: { reason, message, shallow },
  });

  const inside = await git(repoRoot, ['rev-parse', '--is-inside-work-tree'], signal);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return failed(
      'not-a-repository',
      `${repoRoot} is not a usable git work tree; drift verification needs the repository history.`,
    );
  }

  if (request.mode === 'diff') {
    for (const [role, ref] of [
      ['base', request.base],
      ['head', request.head],
    ] as const) {
      if (!isSafeGitRef(ref)) {
        return failed(
          'invalid-ref',
          `The ${role} ref "${ref}" is not a valid git ref (refs must not start with "-" or contain whitespace).`,
        );
      }
    }
    const baseSha = await resolveSha(repoRoot, request.base, signal);
    const headSha = await resolveSha(repoRoot, request.head, signal);
    const shallow = await isShallow(repoRoot, signal);
    if (baseSha === undefined || headSha === undefined) {
      const missing = baseSha === undefined ? request.base : request.head;
      return failed(
        'ref-not-found',
        `Git ref "${missing}" cannot be resolved in this clone.` +
          (shallow
            ? ' The clone is shallow — check out with full history (actions/checkout@v4 with fetch-depth: 0) or fetch the missing ref explicitly.'
            : ' Fetch it first (SpecBridge never fetches automatically).'),
        shallow,
      );
    }
    descriptor.baseSha = baseSha;
    descriptor.headSha = headSha;

    const mergeBase = await git(repoRoot, ['merge-base', baseSha, headSha], signal);
    if (!mergeBase.ok) {
      return failed(
        'no-merge-base',
        `No merge base exists between ${request.base} and ${request.head} in this clone.` +
          (shallow
            ? ' The clone is shallow — check out with full history (actions/checkout@v4 with fetch-depth: 0).'
            : ''),
        shallow,
      );
    }

    const nameStatus = await git(
      repoRoot,
      ['diff', '--relative', '--name-status', '-z', '-M', `${baseSha}...${headSha}`],
      signal,
    );
    if (!nameStatus.ok) {
      return failed('ref-not-found', `git diff failed: ${nameStatus.stderr.trim()}`);
    }
    const files = parseNameStatusZ(nameStatus.stdout);
    const numstat = await git(
      repoRoot,
      ['diff', '--relative', '--numstat', '-z', '-M', `${baseSha}...${headSha}`],
      signal,
    );
    if (numstat.ok) mergeNumstat(files, parseNumstatZ(numstat.stdout));
    flagSymlinkEscapes(repoRoot, files);
    return { ok: true, descriptor, changedFiles: sortFiles(files) };
  }

  // Working tree and staged modes need a HEAD to compare against.
  const headSha = await resolveSha(repoRoot, 'HEAD', signal);
  if (headSha === undefined) {
    return failed(
      'no-commits',
      'The repository has no commits yet; there is nothing to compare the working tree against.',
    );
  }
  descriptor.headSha = headSha;
  descriptor.baseSha = headSha;

  if (request.mode === 'staged') {
    const nameStatus = await git(repoRoot, ['diff', '--relative', '--name-status', '-z', '-M', '--cached'], signal);
    if (!nameStatus.ok) {
      return failed('git-unavailable', `git diff --cached failed: ${nameStatus.stderr.trim()}`);
    }
    const files = parseNameStatusZ(nameStatus.stdout);
    const numstat = await git(repoRoot, ['diff', '--relative', '--numstat', '-z', '-M', '--cached'], signal);
    if (numstat.ok) mergeNumstat(files, parseNumstatZ(numstat.stdout));
    flagSymlinkEscapes(repoRoot, files);
    return { ok: true, descriptor, changedFiles: sortFiles(files) };
  }

  // Working tree: staged + unstaged (diff against HEAD) plus untracked files.
  const nameStatus = await git(repoRoot, ['diff', '--relative', '--name-status', '-z', '-M', 'HEAD'], signal);
  if (!nameStatus.ok) {
    return failed('git-unavailable', `git diff HEAD failed: ${nameStatus.stderr.trim()}`);
  }
  const files = parseNameStatusZ(nameStatus.stdout);
  const numstat = await git(repoRoot, ['diff', '--relative', '--numstat', '-z', '-M', 'HEAD'], signal);
  if (numstat.ok) mergeNumstat(files, parseNumstatZ(numstat.stdout));

  const untracked = await git(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    signal,
  );
  if (untracked.ok) {
    const known = new Set(files.map((file) => file.path));
    for (const token of untracked.stdout.split('\0')) {
      if (token.length === 0 || known.has(token)) continue;
      const absolute = path.join(repoRoot, token.split('/').join(path.sep));
      files.push({
        path: token,
        changeType: 'untracked',
        binary: sniffBinary(absolute),
        symlinkOutsideRepository: false,
      });
    }
  }
  flagSymlinkEscapes(repoRoot, files);
  return { ok: true, descriptor, changedFiles: sortFiles(files) };
}
