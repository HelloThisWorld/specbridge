import type { ComparisonRequest } from '@specbridge/drift';
import { isSafeGitRef, parseDiffRange } from '@specbridge/drift';
import { SpecBridgeError } from '@specbridge/core';

/**
 * Shared comparison-option parsing for `spec verify` and `spec affected`.
 * Exactly one comparison mode may be selected; the default is the working
 * tree (staged + unstaged + untracked changes against HEAD).
 */

export interface ComparisonCliOptions {
  diff?: string;
  base?: string;
  head?: string;
  workingTree?: boolean;
  staged?: boolean;
}

export function resolveComparisonRequest(options: ComparisonCliOptions): ComparisonRequest {
  const modes: string[] = [];
  if (options.diff !== undefined) modes.push('--diff');
  if (options.base !== undefined || options.head !== undefined) modes.push('--base/--head');
  if (options.workingTree === true) modes.push('--working-tree');
  if (options.staged === true) modes.push('--staged');
  if (modes.length > 1) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Choose one comparison mode — ${modes.join(', ')} are mutually exclusive.`,
    );
  }

  if (options.diff !== undefined) {
    const range = parseDiffRange(options.diff);
    if (range === undefined) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `--diff expects "<base>...<head>" (e.g. origin/main...HEAD), got "${options.diff}".`,
      );
    }
    assertRef(range.base, 'base');
    assertRef(range.head, 'head');
    return { mode: 'diff', base: range.base, head: range.head };
  }
  if (options.base !== undefined || options.head !== undefined) {
    if (options.base === undefined) {
      throw new SpecBridgeError('INVALID_ARGUMENT', '--head requires --base <ref>.');
    }
    const head = options.head ?? 'HEAD';
    assertRef(options.base, 'base');
    assertRef(head, 'head');
    return { mode: 'diff', base: options.base, head };
  }
  if (options.staged === true) return { mode: 'staged' };
  return { mode: 'working-tree' };
}

function assertRef(ref: string, role: string): void {
  if (!isSafeGitRef(ref)) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `The ${role} ref "${ref}" is not a valid git ref (refs must not start with "-" or contain whitespace).`,
    );
  }
}
