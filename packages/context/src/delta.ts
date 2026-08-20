import type { ContextItem } from './items.js';

/**
 * Recent-delta management.
 *
 * The recent delta preserves the latest high-value RAW information — the
 * newest diff, the latest test failure, the most recent tool result — so a
 * worker keeps precise signal even while older history compacts. Deltas
 * survive micro compaction untouched until they are FOLDED into a durable
 * checkpoint; from then on they are droppable like any other history.
 *
 * The log is bounded: adding beyond capacity evicts the oldest FOLDED delta
 * first, and only then the oldest unfolded one — recent unfolded signal
 * outlives incorporated history.
 */

export interface DeltaLogConfig {
  /** Maximum deltas retained (oldest evicted first). */
  maxItems: number;
}

export function appendDelta(
  deltas: readonly ContextItem[],
  next: ContextItem,
  config: DeltaLogConfig,
): ContextItem[] {
  if (next.layer !== 'RECENT_DELTA') {
    throw new Error(`appendDelta accepts RECENT_DELTA items only, got ${next.layer}.`);
  }
  const appended = [...deltas, next];
  while (appended.length > Math.max(1, config.maxItems)) {
    const foldedIndex = appended.findIndex((item) => item.foldedIntoCheckpointId !== undefined);
    appended.splice(foldedIndex === -1 ? 0 : foldedIndex, 1);
  }
  return appended;
}

/** Mark every current delta as folded into the given durable checkpoint. */
export function foldDeltasIntoCheckpoint(
  deltas: readonly ContextItem[],
  checkpointId: string,
): ContextItem[] {
  return deltas.map((item) =>
    item.foldedIntoCheckpointId !== undefined ? item : { ...item, foldedIntoCheckpointId: checkpointId },
  );
}

/** Deltas not yet incorporated into any durable checkpoint. */
export function unfoldedDeltas(deltas: readonly ContextItem[]): ContextItem[] {
  return deltas.filter((item) => item.foldedIntoCheckpointId === undefined);
}
