import type { ContextItem } from './items.js';
import { itemFreshness } from './items.js';
import { isProtectedLayer } from './vocabulary.js';
import type { ContextFreshness } from './vocabulary.js';

/**
 * Staleness: removing context that has stopped being true.
 *
 * Stale context is worse than absent context. An agent that receives the
 * body of a file it already edited will reason about code that no longer
 * exists, and — because the content looks exactly as authoritative as fresh
 * content — nothing in its reasoning will flag the problem. The same is true
 * of a test failure that has since passed, a diff against a superseded
 * baseline, and a recovery recommendation a newer decision replaced.
 *
 * So invalidation is structural and it runs BEFORE dispatch, never as a
 * cleanup afterwards. Each item declares what would make it untrue
 * (`freshness`), and this module compares that declaration against the
 * current world: file hashes now, the current task identity, the current
 * checkpoint, the current baseline.
 *
 * Protected layers are never dropped here. Pinned and durable items are
 * rebuilt deterministically from canonical state on every assembly, so their
 * currency is a property of the builder rather than something to garbage
 * collect — and dropping one would breach the invariant that canonical truth
 * always survives context processing.
 */

export const STALENESS_REASONS = [
  'REPOSITORY_CONTENT_CHANGED',
  'REPOSITORY_FILE_MISSING',
  'TASK_IDENTITY_CHANGED',
  'CHECKPOINT_ADVANCED',
  'BASELINE_SUPERSEDED',
  'SUPERSEDED_BY_NEWER_OBSERVATION',
  'EPHEMERAL_CONSUMED',
] as const;
export type StalenessReason = (typeof STALENESS_REASONS)[number];

export interface StaleRecord {
  itemId: string;
  reason: StalenessReason;
  freshness: ContextFreshness;
  /** The path/artifact whose change invalidated the item, when there is one. */
  subject?: string | undefined;
  /** Estimated characters removed. */
  savedChars: number;
}

export interface StalenessWorld {
  /**
   * Current content hash per workspace-relative path. A path present with a
   * DIFFERENT hash invalidates; a path present in the map with no entry (an
   * explicit null) means the file is gone.
   */
  currentHashes?: ReadonlyMap<string, string | null> | undefined;
  /** The task identity items must match to stay current. */
  taskId?: string | undefined;
  /** The latest durable checkpoint id. */
  checkpointId?: string | undefined;
  /** The current repository baseline (Git revision) for diffs. */
  baselineRef?: string | undefined;
  /**
   * Item ids known to be superseded by a newer observation of the same
   * thing — supplied by the caller, which is the only layer that can know
   * (a rerun that now passes, a decision that replaced an earlier one).
   */
  supersededItemIds?: readonly string[] | undefined;
  /** Drop EPHEMERAL items that were carried over from a previous package. */
  dropCarriedEphemeral?: boolean | undefined;
}

export interface StalenessResult {
  items: ContextItem[];
  stale: StaleRecord[];
  savedChars: number;
}

/**
 * Decide whether one item has stopped being true.
 *
 * Returns the reason when it has, undefined when it has not. Deliberately
 * conservative: an item whose freshness cannot be CHECKED (no hash supplied
 * for its path, no checkpoint known) is kept. Removing context on a
 * suspicion would be its own kind of context miss, and the freshness check
 * at selection time (`resolveFresh`) is the layer that actually re-reads
 * bytes.
 */
export function stalenessOf(
  item: ContextItem,
  world: StalenessWorld,
): { reason: StalenessReason; subject?: string | undefined } | undefined {
  if (isProtectedLayer(item.layer)) return undefined;

  const freshness = itemFreshness(item);
  if (freshness === 'IMMUTABLE') return undefined;

  if ((world.supersededItemIds ?? []).includes(item.itemId)) {
    return { reason: 'SUPERSEDED_BY_NEWER_OBSERVATION' };
  }

  if (freshness === 'EPHEMERAL' && world.dropCarriedEphemeral === true) {
    return { reason: 'EPHEMERAL_CONSUMED' };
  }

  const provenance = item.provenance;

  if (freshness === 'STALE_IF_REPO_CHANGES' && provenance?.path !== undefined) {
    const current = world.currentHashes?.get(provenance.path);
    if (current === undefined) return undefined; // Not checkable; keep it.
    if (current === null) {
      return { reason: 'REPOSITORY_FILE_MISSING', subject: provenance.path };
    }
    if (provenance.contentHash !== undefined && provenance.contentHash !== current) {
      return { reason: 'REPOSITORY_CONTENT_CHANGED', subject: provenance.path };
    }
    return undefined;
  }

  if (freshness === 'STALE_IF_TASK_CHANGES') {
    if (world.taskId === undefined || provenance?.baselineRef === undefined) return undefined;
    if (provenance.baselineRef !== world.taskId) {
      return { reason: 'TASK_IDENTITY_CHANGED', subject: provenance.baselineRef };
    }
    return undefined;
  }

  if (freshness === 'STALE_IF_CHECKPOINT_ADVANCES') {
    if (world.checkpointId === undefined) return undefined;
    const boundTo = provenance?.baselineRef ?? item.foldedIntoCheckpointId ?? item.source;
    if (boundTo !== undefined && boundTo !== world.checkpointId) {
      return { reason: 'CHECKPOINT_ADVANCED', subject: boundTo };
    }
    return undefined;
  }

  // A diff is always relative to a baseline; a diff whose baseline moved is
  // describing a change nobody can locate any more.
  if (provenance?.kind === 'diff' && world.baselineRef !== undefined) {
    if (provenance.baselineRef !== undefined && provenance.baselineRef !== world.baselineRef) {
      return { reason: 'BASELINE_SUPERSEDED', subject: provenance.baselineRef };
    }
  }

  return undefined;
}

/** Remove every item that has stopped being true, recording each removal. */
export function removeStaleItems(
  items: readonly ContextItem[],
  world: StalenessWorld,
): StalenessResult {
  const kept: ContextItem[] = [];
  const stale: StaleRecord[] = [];
  for (const item of items) {
    const verdict = stalenessOf(item, world);
    if (verdict === undefined) {
      kept.push(item);
      continue;
    }
    stale.push({
      itemId: item.itemId,
      reason: verdict.reason,
      freshness: itemFreshness(item),
      subject: verdict.subject,
      savedChars: item.content.length,
    });
  }
  return {
    items: kept,
    stale,
    savedChars: stale.reduce((sum, record) => sum + record.savedChars, 0),
  };
}

/**
 * The freshness an item of a given origin should declare.
 *
 * Centralised so every builder in the codebase makes the same choice, and so
 * "what invalidates this?" is answered once per origin kind rather than at
 * each of a dozen construction sites.
 */
export function defaultFreshnessFor(originKind: string): ContextFreshness {
  switch (originKind) {
    case 'repository-file':
    case 'repository-section':
    case 'repository-pointer':
      return 'STALE_IF_REPO_CHANGES';
    case 'diff':
      return 'STALE_IF_REPO_CHANGES';
    case 'checkpoint':
      return 'STALE_IF_CHECKPOINT_ADVANCES';
    case 'verification-run':
      return 'CURRENT';
    case 'tool-result':
      return 'EPHEMERAL';
    case 'policy':
      return 'IMMUTABLE';
    case 'durable-state':
      return 'STALE_IF_CHECKPOINT_ADVANCES';
    default:
      return 'CURRENT';
  }
}
