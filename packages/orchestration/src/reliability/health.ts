import { createHash } from 'node:crypto';
import type { ReliabilityObservation, TaskReliabilityState } from './state.js';
import type { ExecutionHealth, RunawaySignal } from './vocabulary.js';

/**
 * Execution health: one deterministic interpretation of "is this task making
 * progress?", shared by every lane.
 *
 * This module EXTENDS the existing deterministic fingerprinting rather than
 * replacing it. `failureFingerprint` (failure.ts) and `diffFingerprint`
 * (progress.ts) remain the only identity functions; everything here is
 * arithmetic over a bounded window of those two hashes plus the strategy key.
 *
 * What it deliberately does NOT do:
 *
 *   - no natural-language similarity between agent summaries
 *   - no model judgment about whether two approaches "feel" the same
 *   - no reading of agent prose of any kind
 *
 * A worker cannot influence any signal in this file by describing its work
 * differently, which is the entire reason the signals are hashes.
 *
 * The three loop shapes it distinguishes:
 *
 *   repeated failure   the same normalized failure fingerprint recurs
 *   no meaningful diff attempt N and N-1 produce the same tree AND failure
 *   oscillation        attempts alternate between previously seen states
 *                      (A then B then A) with the failure unchanged
 *
 * The third is the one a naive "did the last two attempts match?" check
 * misses entirely, and it is the shape an agent falls into most naturally:
 * fix a symptom, break the other side, revert, repeat.
 */

/**
 * Stable identity of a recovery strategy: the tuple that determines how one
 * attempt materially differs from another.
 *
 * Lane, execution mode, plan revision, and whether context was rebuilt are
 * the four dimensions SpecBridge can actually change between attempts.
 * Anything not in this tuple is not a strategy change — which is exactly the
 * claim the planner needs to be able to refuse.
 */
export function strategyKey(input: {
  lane?: string | null | undefined;
  executionMode?: string | null | undefined;
  planRevision?: number | undefined;
  freshContext?: boolean | undefined;
}): string {
  const canonical = [
    input.lane ?? 'no-lane',
    input.executionMode ?? 'no-mode',
    String(input.planRevision ?? 0),
    input.freshContext === true ? 'fresh' : 'continued',
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export interface HealthThresholds {
  /** Occurrences of one failure fingerprint that count as repeated failure. */
  sameFailureThreshold: number;
  /** Consecutive equal (diff, failure) pairs that count as STALLED. */
  sameDiffThreshold: number;
  /** Alternating distinct states within the window that count as OSCILLATING. */
  oscillationThreshold: number;
}

export interface HealthAssessment {
  health: ExecutionHealth;
  /** Highest occurrence count of any single failure fingerprint in the window. */
  repeatedFailureCount: number;
  /** Consecutive attempts ending in the same (diff, failure) pair. */
  sameDiffRun: number;
  /** True when the window alternates between previously seen diff states. */
  oscillating: boolean;
  /** Runaway signals that fired for the current attempt, if any. */
  runawaySignals: RunawaySignal[];
  /** Ordered, safe explanation of how the health state was reached. */
  reasons: string[];
}

/**
 * Observed activity of one attempt, as far as the runtime reported it.
 *
 * Every field is nullable and every null means UNKNOWN. A runtime that
 * reports nothing must never look like a runtime that reported zero — an
 * invented zero would make an unobservable attempt permanently immune to
 * runaway detection, which is the opposite of what this exists for.
 */
export interface AttemptActivity {
  toolCalls: number | null;
  commandRuns: number | null;
  durationMs: number | null;
  /** Context occupancy ratio after the attempt, when measured. */
  contextUsageAfter: number | null;
  /** Verification/test loops the attempt ran, when reported. */
  testLoops: number | null;
  /** True when the attempt produced no repository change at all. */
  emptyDiff: boolean;
}

export interface RunawayThresholds {
  /** Tool calls one attempt may make. Null disables the check. */
  maxToolCallsPerAttempt: number | null;
  /** Command runs one attempt may make. Null disables the check. */
  maxCommandRunsPerAttempt: number | null;
  /** Wall-clock bound for one attempt. Null disables the check. */
  maxAttemptWallTimeMs: number | null;
  /** Context occupancy that counts as unsafe growth. Null disables the check. */
  maxContextUsageRatio: number | null;
  /** Repeated test/verify loops inside one attempt. Null disables the check. */
  maxTestLoopsPerAttempt: number | null;
}

/**
 * Which bounds the attempt exceeded.
 *
 * Every signal is a bound SpecBridge set and can observe. Unknown metrics
 * produce no signal: SpecBridge stops an attempt for evidence that it
 * overran, never for the absence of evidence that it did not.
 */
export function detectRunaway(
  activity: AttemptActivity,
  thresholds: RunawayThresholds,
  previous: readonly ReliabilityObservation[] = [],
): RunawaySignal[] {
  const signals: RunawaySignal[] = [];
  if (
    thresholds.maxToolCallsPerAttempt !== null &&
    activity.toolCalls !== null &&
    activity.toolCalls >= thresholds.maxToolCallsPerAttempt
  ) {
    signals.push('TOOL_CALL_BUDGET');
  }
  if (
    thresholds.maxAttemptWallTimeMs !== null &&
    activity.durationMs !== null &&
    activity.durationMs >= thresholds.maxAttemptWallTimeMs
  ) {
    signals.push('WALL_TIME_BUDGET');
  }
  if (
    thresholds.maxContextUsageRatio !== null &&
    activity.contextUsageAfter !== null &&
    activity.contextUsageAfter >= thresholds.maxContextUsageRatio
  ) {
    signals.push('CONTEXT_GROWTH');
  }
  // A tool loop is supplemental to attempt-level no-progress detection, and
  // depends only on counts the runner already normalizes — never on private
  // harness internals.
  const loopCeiling = thresholds.maxTestLoopsPerAttempt;
  if (loopCeiling !== null) {
    const loops = activity.testLoops ?? null;
    const commands = activity.commandRuns ?? null;
    if ((loops !== null && loops >= loopCeiling) || (commands !== null && commands >= loopCeiling * 4)) {
      signals.push('REPEATED_COMMAND_LOOP');
    }
  }
  if (
    thresholds.maxCommandRunsPerAttempt !== null &&
    activity.commandRuns !== null &&
    activity.commandRuns >= thresholds.maxCommandRunsPerAttempt &&
    !signals.includes('REPEATED_COMMAND_LOOP')
  ) {
    signals.push('REPEATED_COMMAND_LOOP');
  }
  // An attempt that did substantial work and changed nothing, twice running,
  // is editing in circles rather than converging.
  if (activity.emptyDiff && (activity.toolCalls ?? 0) > 0) {
    const priorEmpty = previous.at(-1)?.diffFingerprint === null;
    if (priorEmpty) signals.push('NO_OP_EDIT_LOOP');
  }
  return signals;
}

/**
 * Whether the window alternates between previously seen repository states
 * while the failure stays the same.
 *
 * The shape being caught, concretely:
 *
 *   attempt 1   diff A   failure F
 *   attempt 2   diff B   failure F
 *   attempt 3   diff A   failure F
 *
 * Attempt 3 revisits a state that already failed, so the sequence has no
 * fixed point. Consecutive-pair comparison sees three "different" attempts
 * and reports progress; this sees the cycle.
 *
 * A revisited state only counts while the failure identity is unchanged: if
 * attempt 3 reproduces diff A but now fails differently, that is genuinely
 * new information and not a loop.
 */
export function detectOscillation(
  window: readonly ReliabilityObservation[],
  threshold: number,
): boolean {
  const scored = window.filter((entry) => entry.diffFingerprint !== null);
  if (scored.length < Math.max(3, threshold)) return false;
  const recent = scored.slice(-Math.max(3, threshold + 1));
  const seen = new Map<string, number>();
  let revisits = 0;
  let previous: string | undefined;
  for (const entry of recent) {
    const diff = entry.diffFingerprint as string;
    const priorCount = seen.get(diff) ?? 0;
    // A revisit only counts when the state is not simply repeated back to
    // back (that is STALLED, a different diagnosis) and the failure identity
    // has not changed (a new failure is new information).
    if (priorCount > 0 && previous !== diff) revisits += 1;
    seen.set(diff, priorCount + 1);
    previous = diff;
  }
  if (revisits < 1) return false;
  const failures = new Set(recent.map((entry) => entry.failureFingerprint ?? 'none'));
  const distinctStates = seen.size;
  // Alternation needs at least two distinct states and a stable failure.
  return distinctStates >= 2 && distinctStates < recent.length && failures.size === 1;
}

/**
 * Fold one new observation into the task's health state.
 *
 * Pure: the caller owns persistence, this decides what the window means.
 * Evaluated in strict priority order so the outcome is fully determined by
 * the inputs, and so a RUNAWAY attempt is never reported as merely STALLED.
 */
export function assessHealth(input: {
  /** History INCLUDING the newest observation, oldest first. */
  window: readonly ReliabilityObservation[];
  thresholds: HealthThresholds;
  /** Runaway signals for the newest attempt, when any fired. */
  runawaySignals?: readonly RunawaySignal[];
  /** True when the newest attempt's evaluation passed. */
  passed?: boolean;
}): HealthAssessment {
  const window = input.window;
  const runawaySignals = [...(input.runawaySignals ?? [])];
  const reasons: string[] = [];

  const counts = new Map<string, number>();
  for (const entry of window) {
    if (entry.failureFingerprint === null) continue;
    counts.set(entry.failureFingerprint, (counts.get(entry.failureFingerprint) ?? 0) + 1);
  }
  const repeatedFailureCount = counts.size === 0 ? 0 : Math.max(...counts.values());

  // Consecutive attempts ending in the same (diff, failure) pair, counted
  // backwards from the newest. Both hashes must match: a different tree with
  // the same failure is still new information about the problem.
  let sameDiffRun = 0;
  for (let index = window.length - 1; index > 0; index -= 1) {
    const current = window[index];
    const previous = window[index - 1];
    if (current === undefined || previous === undefined) break;
    if (current.failureFingerprint === null || current.diffFingerprint === null) break;
    if (
      current.failureFingerprint !== previous.failureFingerprint ||
      current.diffFingerprint !== previous.diffFingerprint
    ) {
      break;
    }
    sameDiffRun += 1;
  }
  if (sameDiffRun > 0) sameDiffRun += 1; // count both ends of each matched pair

  const oscillating = detectOscillation(window, input.thresholds.oscillationThreshold);

  // 1. RUNAWAY first: an attempt that overran its own bounds is stopped
  //    whatever the window says about longer-term progress.
  if (runawaySignals.length > 0) {
    reasons.push(
      `The attempt exceeded its bounds (${runawaySignals.join(', ')}); it was stopped rather than allowed to continue.`,
    );
    return { health: 'RUNAWAY', repeatedFailureCount, sameDiffRun, oscillating, runawaySignals, reasons };
  }

  // 2. A passing evaluation is healthy by definition: whatever the history,
  //    the task just advanced.
  if (input.passed === true) {
    reasons.push('The latest attempt passed evaluation.');
    return { health: 'HEALTHY', repeatedFailureCount, sameDiffRun, oscillating, runawaySignals, reasons };
  }

  // 3. STALLED before OSCILLATING: identical repetition is the stronger and
  //    more specific claim, and both call for a strategy change anyway.
  if (sameDiffRun >= input.thresholds.sameDiffThreshold) {
    reasons.push(
      `${sameDiffRun} consecutive attempts produced an identical working tree and an identical failure; ` +
        'the same approach is producing the same result.',
    );
    return { health: 'STALLED', repeatedFailureCount, sameDiffRun, oscillating, runawaySignals, reasons };
  }

  if (oscillating) {
    reasons.push(
      'Attempts are alternating between repository states that have already failed, with the failure unchanged; ' +
        'the sequence has no fixed point.',
    );
    return { health: 'OSCILLATING', repeatedFailureCount, sameDiffRun, oscillating, runawaySignals, reasons };
  }

  if (repeatedFailureCount >= input.thresholds.sameFailureThreshold) {
    reasons.push(
      `The same normalized failure recurred ${repeatedFailureCount} times; attempts differ but none addresses it.`,
    );
    return { health: 'STALLED', repeatedFailureCount, sameDiffRun, oscillating, runawaySignals, reasons };
  }

  if (window.some((entry) => entry.failureFingerprint !== null)) {
    reasons.push('Attempts are failing, but each one is materially different from the last.');
    return { health: 'DEGRADED', repeatedFailureCount, sameDiffRun, oscillating, runawaySignals, reasons };
  }

  reasons.push('No failures recorded in the current window.');
  return { health: 'HEALTHY', repeatedFailureCount, sameDiffRun, oscillating, runawaySignals, reasons };
}

/** Append one observation to the bounded window, rolling the oldest off. */
export function appendObservation(
  state: TaskReliabilityState,
  observation: ReliabilityObservation,
  maxWindow: number,
): ReliabilityObservation[] {
  const next = [...state.observations, observation];
  return next.length > maxWindow ? next.slice(next.length - maxWindow) : next;
}
