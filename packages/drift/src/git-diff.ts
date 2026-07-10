import { execa } from 'execa';
import { SpecBridgeError } from '@specbridge/core';

/**
 * Git diff collection and parsing. Deterministic: the parser is pure, and
 * the collector only runs `git diff --name-status` with caller-supplied
 * ranges (never with content taken from spec files).
 */

export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'unknown';

export interface ChangedFile {
  /** Repo-relative path, forward slashes. */
  path: string;
  status: ChangeStatus;
  /** Original path for renames/copies. */
  oldPath?: string;
}

function statusFor(code: string): ChangeStatus {
  switch (code.charAt(0)) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type-changed';
    default:
      return 'unknown';
  }
}

/** Parse `git diff --name-status` output (tab-separated, one entry per line). */
export function parseNameStatus(output: string): ChangedFile[] {
  const changes: ChangedFile[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split('\t');
    const code = parts[0];
    if (code === undefined || code.length === 0) continue;
    const status = statusFor(code);
    if (status === 'renamed' || status === 'copied') {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath === undefined || newPath === undefined) continue;
      changes.push({ path: newPath, status, oldPath });
    } else {
      const filePath = parts[1];
      if (filePath === undefined) continue;
      changes.push({ path: filePath, status });
    }
  }
  return changes;
}

export interface CollectDiffOptions {
  /** e.g. `origin/main...HEAD`. Mutually exclusive with `workingTree`. */
  diffRange?: string;
  /** Diff the working tree against HEAD. */
  workingTree?: boolean;
}

/** Run git and return the changed files. Requires a git work tree at `cwd`. */
export async function collectChangedFiles(
  cwd: string,
  options: CollectDiffOptions,
): Promise<ChangedFile[]> {
  const args = ['diff', '--name-status'];
  if (options.diffRange !== undefined && options.workingTree === true) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      'Pass either a diff range or workingTree, not both.',
    );
  }
  if (options.diffRange !== undefined) {
    args.push(options.diffRange);
  } else if (options.workingTree === true) {
    args.push('HEAD');
  } else {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      'collectChangedFiles needs a diff range (e.g. origin/main...HEAD) or workingTree: true.',
    );
  }
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new SpecBridgeError(
      'IO_ERROR',
      `git ${args.join(' ')} failed with exit code ${String(result.exitCode)}: ${result.stderr}`,
    );
  }
  return parseNameStatus(result.stdout);
}
