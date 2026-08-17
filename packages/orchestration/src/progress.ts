import { createHash } from 'node:crypto';
import type { ObservationFingerprint } from './state.js';

/**
 * Progress and stagnation detection.
 *
 * "Did anything change?" is answered from deterministic signals — verifier
 * identity, exit code, normalized failure output, the changed-file set, the
 * plan revision, the action category — not from natural-language similarity
 * between two agent summaries.
 */

/**
 * Stable identity of a working-tree change set.
 *
 * Paths and content hashes, sorted. Two edit attempts that end with byte-wise
 * identical trees produce the same fingerprint even if the agent described
 * them differently, which is exactly the case worth catching.
 */
export function diffFingerprint(
  changed: readonly { path: string; contentHash?: string | undefined }[],
): string {
  const canonical = [...changed]
    .map((entry) => `${entry.path}:${entry.contentHash ?? 'no-hash'}`)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Whether an observation is materially the same as the previous one.
 *
 * Same action category, same plan revision, same failure identity, and the
 * same tree — that is a loop, whatever the agent believes it just did. A
 * different plan revision always counts as new: replanning is by definition a
 * change of approach, so it gets a fresh chance to make progress.
 */
export function isMateriallyIdentical(
  previous: ObservationFingerprint | undefined,
  next: ObservationFingerprint,
): boolean {
  if (previous === undefined) return false;
  if (previous.planRevision !== next.planRevision) return false;
  if (previous.actionCategory !== next.actionCategory) return false;
  if (previous.result !== next.result) return false;
  if (previous.failureFingerprint !== next.failureFingerprint) return false;
  if (previous.diffFingerprint !== next.diffFingerprint) return false;
  return true;
}

export interface ProgressAssessment {
  /** True when this observation advanced the world in some observable way. */
  progressed: boolean;
  /** Consecutive no-progress cycles including this observation. */
  consecutiveNoProgress: number;
  /** Whether the configured no-progress bound is now exceeded. */
  stagnated: boolean;
  reason: string;
}

/**
 * Fold one observation into the running progress assessment.
 *
 * Pure: the caller owns the counters, this decides how they move.
 */
export function assessProgress(input: {
  previous: ObservationFingerprint | undefined;
  next: ObservationFingerprint;
  consecutiveNoProgress: number;
  maxNoProgressCycles: number;
}): ProgressAssessment {
  const identical = isMateriallyIdentical(input.previous, input.next);
  const progressed = !identical && input.next.result !== 'no-change';
  const consecutive = progressed ? 0 : input.consecutiveNoProgress + 1;
  const stagnated = consecutive >= input.maxNoProgressCycles;

  let reason: string;
  if (progressed) {
    reason = 'The observation differs from the previous one; the run advanced.';
  } else if (identical) {
    reason =
      'The action category, plan revision, failure identity, and working tree are all unchanged ' +
      'since the previous observation — the same approach produced the same result.';
  } else {
    reason = 'The action produced no observable change.';
  }

  return { progressed, consecutiveNoProgress: consecutive, stagnated, reason };
}
