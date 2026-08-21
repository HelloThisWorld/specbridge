import type { ExecutionLedgerEntry } from '../survival/state.js';

/**
 * Local runtime performance observations (vNext.4).
 *
 * A read model over the ExecutionLedger that answers the one question this
 * phase must be able to answer with data rather than opinion:
 *
 *   For work of this category, does DIRECT_MODEL or HARNESS actually do
 *   better — and how often does either end up spending Max quota anyway?
 *
 * Explicitly NOT a router. Nothing here feeds back into scheduling: vNext.4
 * collects evidence, and a later phase may learn from it. Building the
 * feedback loop now would tune policy on a handful of samples and make
 * every future comparison unreproducible.
 *
 * Unknown stays unknown, everywhere. A provider that reported no tokens
 * contributes to no token average, and a mode with no attempts has null
 * rates rather than a flattering zero.
 */

export interface LocalRuntimeModeStats {
  attempts: number;
  completed: number;
  failed: number;
  /** Attempts whose evidence verified, over attempts that ran. Null when none. */
  verificationPassRate: number | null;
  /** Median wall time over attempts that reported a duration. */
  medianWallTimeMs: number | null;
  /** Median reported input/output tokens; null when nothing reported them. */
  medianInputTokens: number | null;
  medianOutputTokens: number | null;
  /** Median observed tool calls / command runs, when observed. */
  medianToolCalls: number | null;
  medianCommandRuns: number | null;
  /** How many attempts reported each metric (honesty about coverage). */
  reporting: {
    durationMs: number;
    tokens: number;
    toolCalls: number;
    commandRuns: number;
  };
}

export interface LocalRuntimeCategoryStats {
  category: string;
  byMode: Record<string, LocalRuntimeModeStats>;
  /** Tasks in this category that ended up on the subscription lane. */
  strongAttempts: number;
}

export interface LocalRuntimeObservations {
  /** Mode key → stats. Keys: DIRECT_MODEL, HARNESS, and UNATTRIBUTED. */
  byMode: Record<string, LocalRuntimeModeStats>;
  byCategory: LocalRuntimeCategoryStats[];
  /** Distinct tasks that ran locally and later ran on the strong lane. */
  localToStrongEscalations: number;
  /** Distinct tasks observed on the LOCAL lane at all. */
  localTasks: number;
  totalLocalAttempts: number;
}

/** Mode bucket for one entry. Pre-vNext.4 attempts stay UNATTRIBUTED. */
const UNATTRIBUTED = 'UNATTRIBUTED';

function emptyStats(): LocalRuntimeModeStats {
  return {
    attempts: 0,
    completed: 0,
    failed: 0,
    verificationPassRate: null,
    medianWallTimeMs: null,
    medianInputTokens: null,
    medianOutputTokens: null,
    medianToolCalls: null,
    medianCommandRuns: null,
    reporting: { durationMs: 0, tokens: 0, toolCalls: 0, commandRuns: 0 },
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (low === undefined || high === undefined) return null;
  return (low + high) / 2;
}

interface Accumulator {
  stats: LocalRuntimeModeStats;
  durations: number[];
  inputTokens: number[];
  outputTokens: number[];
  toolCalls: number[];
  commandRuns: number[];
}

function accumulate(map: Map<string, Accumulator>, key: string, entry: ExecutionLedgerEntry): void {
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = {
      stats: emptyStats(),
      durations: [],
      inputTokens: [],
      outputTokens: [],
      toolCalls: [],
      commandRuns: [],
    };
    map.set(key, bucket);
  }
  bucket.stats.attempts += 1;
  if (entry.status === 'COMPLETED') bucket.stats.completed += 1;
  if (entry.status === 'FAILED') bucket.stats.failed += 1;
  const metrics = entry.metrics;
  if (metrics.durationMs !== null) bucket.durations.push(metrics.durationMs);
  if (metrics.inputTokens !== null) bucket.inputTokens.push(metrics.inputTokens);
  if (metrics.outputTokens !== null) bucket.outputTokens.push(metrics.outputTokens);
  if (metrics.toolCalls !== null) bucket.toolCalls.push(metrics.toolCalls);
  if (metrics.commandRuns !== null) bucket.commandRuns.push(metrics.commandRuns);
}

function finalize(bucket: Accumulator): LocalRuntimeModeStats {
  const stats = bucket.stats;
  const ran = stats.completed + stats.failed;
  return {
    ...stats,
    // "Verification pass rate" is deliberately computed over attempts that
    // REACHED a verdict: an interrupted attempt says nothing about the
    // model, and counting it as a failure would blame the mode for a crash.
    verificationPassRate: ran > 0 ? stats.completed / ran : null,
    medianWallTimeMs: median(bucket.durations),
    medianInputTokens: median(bucket.inputTokens),
    medianOutputTokens: median(bucket.outputTokens),
    medianToolCalls: median(bucket.toolCalls),
    medianCommandRuns: median(bucket.commandRuns),
    reporting: {
      durationMs: bucket.durations.length,
      tokens: bucket.inputTokens.length,
      toolCalls: bucket.toolCalls.length,
      commandRuns: bucket.commandRuns.length,
    },
  };
}

/**
 * Summarize LOCAL-lane executor attempts by execution mode and category,
 * plus how often local work ended up on the subscription lane anyway.
 */
export function summarizeLocalRuntime(
  entries: readonly ExecutionLedgerEntry[],
): LocalRuntimeObservations {
  const executors = entries.filter((entry) => entry.role === 'EXECUTOR');
  const byMode = new Map<string, Accumulator>();
  const byCategory = new Map<string, { modes: Map<string, Accumulator>; strongAttempts: number }>();
  const localNodes = new Set<string>();
  const strongNodes = new Set<string>();

  for (const entry of executors) {
    const category = entry.taskCategory ?? 'general';
    const categoryBucket = byCategory.get(category) ?? { modes: new Map(), strongAttempts: 0 };
    byCategory.set(category, categoryBucket);
    if (entry.lane !== 'LOCAL') {
      if (entry.lane === 'SUBSCRIPTION') {
        categoryBucket.strongAttempts += 1;
        strongNodes.add(entry.nodeId);
      }
      continue;
    }
    localNodes.add(entry.nodeId);
    const mode = entry.executionMode ?? UNATTRIBUTED;
    accumulate(byMode, mode, entry);
    accumulate(categoryBucket.modes, mode, entry);
  }

  let localToStrongEscalations = 0;
  for (const nodeId of strongNodes) {
    if (localNodes.has(nodeId)) localToStrongEscalations += 1;
  }

  return {
    byMode: Object.fromEntries(
      [...byMode.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, bucket]) => [key, finalize(bucket)]),
    ),
    byCategory: [...byCategory.entries()]
      .filter(([, bucket]) => bucket.modes.size > 0 || bucket.strongAttempts > 0)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([category, bucket]) => ({
        category,
        byMode: Object.fromEntries(
          [...bucket.modes.entries()]
            .sort(([a], [b]) => a.localeCompare(b, 'en'))
            .map(([key, accumulator]) => [key, finalize(accumulator)]),
        ),
        strongAttempts: bucket.strongAttempts,
      })),
    localToStrongEscalations,
    localTasks: localNodes.size,
    totalLocalAttempts: [...byMode.values()].reduce((total, bucket) => total + bucket.stats.attempts, 0),
  };
}
