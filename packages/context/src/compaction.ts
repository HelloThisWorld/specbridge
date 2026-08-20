import type { CompactionRecord, ContextItem } from './items.js';
import { estimateItemsTokens, estimateTokens } from './budget.js';
import { isProtectedLayer } from './vocabulary.js';

/**
 * Compaction: large raw context becomes a small structured representation.
 *
 * Three levels, all NORMAL runtime operations:
 *
 *   micro      dedupe repeated observations, compress bulky raw payloads
 *   milestone  drop items whose truth was folded into a durable checkpoint,
 *              collapsing completed history to checkpoint-backed summaries
 *   emergency  keep protected layers plus checkpoint-backed state and the
 *              newest deltas, drop everything else disposable
 *
 * Invariants enforced structurally, exercised by tests:
 *   - PINNED, DURABLE_TASK_STATE, and CURRENT_ACTION items are NEVER dropped
 *     or summarized away by any level
 *   - an unfolded RECENT_DELTA item survives micro compaction
 *   - compaction is deterministic: same input, same output
 *
 * The default summarizer is deterministic and structural. A future local
 * model (or any provider) can plug in through `ContextSummarizer` without
 * changing the runtime architecture; whatever it produces must still respect
 * the layer model — summarizers receive only disposable items.
 */

/** Raw content above this size is compressed by micro compaction. */
export const MICRO_COMPACT_CONTENT_THRESHOLD_CHARS = 4_000;

/** Head/tail window kept when compressing a large raw payload. */
const COMPACT_HEAD_CHARS = 1_200;
const COMPACT_TAIL_CHARS = 800;

/** Item kinds micro compaction may compress (raw bulk, not source of truth). */
export const COMPRESSIBLE_KINDS = [
  'log',
  'tool-result',
  'test-output',
  'shell-output',
  'file-excerpt',
  'diff',
  'turn',
] as const;

/**
 * Pluggable summarization boundary for provider-independent compaction.
 * Implementations receive ONLY disposable items (never pinned or durable
 * state) and must return a single bounded summary item body.
 */
export interface ContextSummarizer {
  /** Stable identity recorded on compaction output (audit). */
  readonly summarizerId: string;
  summarize(items: readonly ContextItem[], targetChars: number): string;
}

/** Deterministic structural summarizer: titles plus bounded lead content. */
export const structuralSummarizer: ContextSummarizer = {
  summarizerId: 'structural-v1',
  summarize(items, targetChars) {
    const lines: string[] = [];
    for (const item of items) {
      const lead = item.content.replace(/\s+/g, ' ').slice(0, 160);
      lines.push(`- [${item.kind}] ${item.title}: ${lead}${item.content.length > 160 ? ' …' : ''}`);
    }
    const body = lines.join('\n');
    return body.length <= targetChars ? body : `${body.slice(0, Math.max(0, targetChars - 2))} …`;
  },
};

export interface CompactionResult {
  items: ContextItem[];
  record: CompactionRecord;
}

function record(
  level: CompactionRecord['level'],
  at: string,
  before: readonly ContextItem[],
  after: readonly ContextItem[],
  extras: { checkpointId?: string; detail?: string } = {},
): CompactionRecord {
  return {
    level,
    at,
    itemsBefore: before.length,
    itemsAfter: after.length,
    estimatedTokensBefore: estimateItemsTokens(before),
    estimatedTokensAfter: estimateItemsTokens(after),
    ...(extras.checkpointId !== undefined ? { checkpointId: extras.checkpointId } : {}),
    ...(extras.detail !== undefined ? { detail: extras.detail } : {}),
  };
}

/** Structured compression of one oversized raw payload. */
function compressContent(content: string): string {
  const head = content.slice(0, COMPACT_HEAD_CHARS);
  const tail = content.slice(-COMPACT_TAIL_CHARS);
  const omitted = content.length - head.length - tail.length;
  const lineCount = content.split('\n').length;
  return [
    head,
    `… [compacted: ${omitted} characters of ${lineCount} total lines omitted; full payload in its source artifact] …`,
    tail,
  ].join('\n');
}

/**
 * Micro compaction.
 *
 * 1. Deduplicate: among items sharing a `dedupeKey`, keep only the LAST
 *    (newest) occurrence — repeated file reads and repeated tool output
 *    collapse to their latest observation.
 * 2. Compress: raw bulk payloads above the threshold become head/tail
 *    structured representations.
 *
 * Protected layers and unfolded RECENT_DELTA items pass through untouched.
 */
export function microCompact(items: readonly ContextItem[], at: string): CompactionResult {
  const keptByDedupeKey = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.dedupeKey !== undefined && !isProtectedLayer(item.layer)) {
      keptByDedupeKey.set(item.dedupeKey, index);
    }
  });

  const next: ContextItem[] = [];
  items.forEach((item, index) => {
    if (
      item.dedupeKey !== undefined &&
      !isProtectedLayer(item.layer) &&
      keptByDedupeKey.get(item.dedupeKey) !== index
    ) {
      return; // superseded by a newer observation of the same thing
    }
    const compressible =
      !isProtectedLayer(item.layer) &&
      !(item.layer === 'RECENT_DELTA' && item.foldedIntoCheckpointId === undefined) &&
      !item.compacted &&
      (COMPRESSIBLE_KINDS as readonly string[]).includes(item.kind) &&
      item.content.length > MICRO_COMPACT_CONTENT_THRESHOLD_CHARS;
    if (compressible) {
      next.push({ ...item, content: compressContent(item.content), compacted: true });
      return;
    }
    next.push(item);
  });

  return { items: next, record: record('micro', at, items, next) };
}

export interface MilestoneCompactInput {
  items: readonly ContextItem[];
  at: string;
  /** The durable checkpoint this milestone folded state into. */
  checkpointId: string;
  /**
   * A checkpoint-backed summary item (built by the caller from the durable
   * checkpoint) that replaces the folded history in COMPACTED_HISTORY.
   */
  checkpointSummaryItem?: ContextItem | undefined;
}

/**
 * Milestone compaction: a meaningful unit of work completed and a durable
 * checkpoint was persisted. Every disposable item folded into a checkpoint
 * is dropped — its truth now lives in durable state — and the caller's
 * checkpoint summary takes their place in COMPACTED_HISTORY.
 */
export function milestoneCompact(input: MilestoneCompactInput): CompactionResult {
  const next: ContextItem[] = [];
  for (const item of input.items) {
    if (isProtectedLayer(item.layer)) {
      next.push(item);
      continue;
    }
    if (item.foldedIntoCheckpointId !== undefined) continue;
    next.push(item);
  }
  if (input.checkpointSummaryItem !== undefined) {
    next.push(input.checkpointSummaryItem);
  }
  return {
    items: next,
    record: record('milestone', input.at, input.items, next, { checkpointId: input.checkpointId }),
  };
}

export interface EmergencyCompactInput {
  items: readonly ContextItem[];
  at: string;
  /**
   * The durable checkpoint persisted BEFORE this compaction ran. Emergency
   * compaction never runs against unpersisted state: the caller checkpoints
   * first, then compacts, so nothing dropped here is the only copy.
   */
  checkpointId: string;
  checkpointSummaryItem?: ContextItem | undefined;
  /** Newest N RECENT_DELTA items to preserve (default 3). */
  keepNewestDeltas?: number | undefined;
  summarizer?: ContextSummarizer | undefined;
  /** Ceiling for the summary of dropped disposable history. */
  summaryTargetChars?: number | undefined;
}

/**
 * Emergency compaction: the context approached its safe upper bound.
 *
 * Keeps, in order: every protected-layer item, the checkpoint summary, one
 * bounded structural summary of everything dropped, and the newest deltas.
 * Everything else disposable is dropped — it is either regenerable
 * (WORKING_SET), already durable (folded items), or summarized.
 */
export function emergencyCompact(input: EmergencyCompactInput): CompactionResult {
  const keepDeltas = Math.max(0, input.keepNewestDeltas ?? 3);
  const summarizer = input.summarizer ?? structuralSummarizer;

  const deltas = input.items.filter((item) => item.layer === 'RECENT_DELTA');
  const newestDeltas = new Set(deltas.slice(-keepDeltas).map((item) => item.itemId));

  const kept: ContextItem[] = [];
  const dropped: ContextItem[] = [];
  for (const item of input.items) {
    if (isProtectedLayer(item.layer)) {
      kept.push(item);
      continue;
    }
    if (item.layer === 'RECENT_DELTA' && newestDeltas.has(item.itemId)) {
      kept.push(item);
      continue;
    }
    dropped.push(item);
  }

  if (input.checkpointSummaryItem !== undefined) {
    kept.push(input.checkpointSummaryItem);
  }
  if (dropped.length > 0) {
    const summaryBody = summarizer.summarize(dropped, input.summaryTargetChars ?? 4_000);
    kept.push({
      itemId: `emergency-summary-${input.checkpointId}-${estimateTokens(summaryBody)}`,
      layer: 'COMPACTED_HISTORY',
      kind: 'summary',
      title: `Compacted history (${dropped.length} items; durable state in checkpoint ${input.checkpointId})`,
      content: summaryBody,
      createdAt: input.at,
      source: input.checkpointId,
      compacted: true,
    });
  }

  return {
    items: kept,
    record: record('emergency', input.at, input.items, kept, {
      checkpointId: input.checkpointId,
      detail: `dropped ${dropped.length} disposable item(s); kept ${keepDeltas} newest delta(s); summarizer ${summarizer.summarizerId}`,
    }),
  };
}
