import type { CompactionRecord, ContextItem, ContextPackage } from './items.js';
import { CONTEXT_PACKAGE_SCHEMA_VERSION, contextPackageSchema } from './items.js';
import type { ContextBudgetConfig } from './budget.js';
import {
  ContextBudgetError,
  assessContextHealth,
  computeContextUsage,
  estimateItemTokens,
  estimateItemsTokens,
  usableInputTokens,
} from './budget.js';
import type { ContextSummarizer } from './compaction.js';
import { emergencyCompact, microCompact } from './compaction.js';
import { CONTEXT_LAYERS, isProtectedLayer } from './vocabulary.js';

/**
 * Context assembly: durable state in, one bounded ContextPackage out.
 *
 * Assembly is deterministic. Items are emitted in layer order (PINNED first,
 * CURRENT_ACTION last) with stable relative order inside each layer. When
 * the estimate exceeds the budget, pre-compaction runs in escalating steps:
 *
 *   1. micro compact (dedupe, compress bulk)
 *   2. with a persisted checkpoint: EMERGENCY compact — protected layers,
 *      the checkpoint summary, and the newest deltas survive; dropped
 *      history is summarized. Nothing is discarded unless its truth is
 *      already durable.
 *   3. without a checkpoint: only regenerable context may go — WORKING_SET
 *      oldest-first, then deltas already folded into a checkpoint.
 *
 * If the package still exceeds the budget, assembly FAILS EXPLICITLY
 * (ContextBudgetError). An incomplete or misleading context is never
 * produced silently, and pinned context is never dropped.
 */

export interface AssembleContextInput {
  items: readonly ContextItem[];
  budget: ContextBudgetConfig;
  createdAt: string;
  jobId?: string | undefined;
  taskId?: string | undefined;
  attemptId?: string | undefined;
  /**
   * Durable checkpoint backing this assembly. Required before emergency
   * compaction may drop anything: nothing is discarded unless its truth is
   * already persisted.
   */
  checkpointId?: string | undefined;
  checkpointSummaryItem?: ContextItem | undefined;
  summarizer?: ContextSummarizer | undefined;
  /** Compaction records carried over from earlier passes (observability). */
  priorCompactions?: readonly CompactionRecord[] | undefined;
}

/** Stable layer-ordered arrangement with insertion order inside layers. */
function inLayerOrder(items: readonly ContextItem[]): ContextItem[] {
  const ordered: ContextItem[] = [];
  for (const layer of CONTEXT_LAYERS) {
    for (const item of items) if (item.layer === layer) ordered.push(item);
  }
  return ordered;
}

/**
 * Without a checkpoint, only REGENERABLE context may be dropped: the working
 * set (rebuildable from the repository) oldest-first, then deltas whose
 * truth already lives in a durable checkpoint. Anything else would be silent
 * information loss, which assembly refuses by design.
 */
function dropRegenerable(
  items: ContextItem[],
  budgetTokens: number,
): { items: ContextItem[]; dropped: number } {
  const phaseOf = (item: ContextItem): number => {
    if (item.layer === 'WORKING_SET') return 0;
    if (item.layer === 'RECENT_DELTA' && item.foldedIntoCheckpointId !== undefined) return 1;
    return -1;
  };
  let current = [...items];
  let dropped = 0;
  for (const phase of [0, 1]) {
    while (estimateItemsTokens(current) > budgetTokens) {
      const index = current.findIndex((item) => phaseOf(item) === phase);
      if (index === -1) break;
      current = [...current.slice(0, index), ...current.slice(index + 1)];
      dropped += 1;
    }
    if (estimateItemsTokens(current) <= budgetTokens) break;
  }
  return { items: current, dropped };
}

export interface AssembledContext {
  package: ContextPackage;
  /** Compaction passes applied during THIS assembly. */
  compactions: CompactionRecord[];
}

export function assembleContextPackage(input: AssembleContextInput): AssembledContext {
  const budgetTokens = usableInputTokens(input.budget);
  const compactions: CompactionRecord[] = [];
  let items = inLayerOrder(input.items);

  // Step 1: micro compaction whenever the raw estimate does not fit.
  if (estimateItemsTokens(items) > budgetTokens) {
    const micro = microCompact(items, input.createdAt);
    items = inLayerOrder(micro.items);
    compactions.push(micro.record);
  }

  if (estimateItemsTokens(items) > budgetTokens) {
    if (input.checkpointId !== undefined) {
      // Step 2: over budget IS emergency territory (the emergency threshold
      // sits below 100% of usable input), and a persisted checkpoint means
      // nothing dropped here is the only copy.
      const emergency = emergencyCompact({
        items,
        at: input.createdAt,
        checkpointId: input.checkpointId,
        checkpointSummaryItem: input.checkpointSummaryItem,
        summarizer: input.summarizer,
      });
      items = inLayerOrder(emergency.items);
      compactions.push(emergency.record);
    } else {
      // Step 3: no checkpoint — only regenerable context may be dropped.
      const tokensBefore = estimateItemsTokens(items);
      const dropped = dropRegenerable(items, budgetTokens);
      if (dropped.dropped > 0) {
        compactions.push({
          level: 'micro',
          at: input.createdAt,
          itemsBefore: items.length,
          itemsAfter: dropped.items.length,
          estimatedTokensBefore: tokensBefore,
          estimatedTokensAfter: estimateItemsTokens(dropped.items),
          detail: `dropped ${dropped.dropped} regenerable item(s) (working set / checkpoint-folded deltas)`,
        });
        items = dropped.items;
      }
    }
  }

  const estimated = estimateItemsTokens(items);
  if (estimated > budgetTokens) {
    const protectedTokens = estimateItemsTokens(items.filter((item) => isProtectedLayer(item.layer)));
    throw new ContextBudgetError(
      `The context cannot be assembled within the ${budgetTokens}-token usable budget: ` +
        `${estimated} tokens remain after compaction (${protectedTokens} of them in protected layers). ` +
        (input.checkpointId === undefined
          ? 'No durable checkpoint was provided, so emergency compaction could not discard anything. ' +
            'Persist a checkpoint and retry, or raise the model context budget.'
          : 'Reduce pinned/durable state at its source, or raise the model context budget.'),
    );
  }

  const usage = computeContextUsage(input.budget, estimated);
  const pkg = contextPackageSchema.parse({
    schemaVersion: CONTEXT_PACKAGE_SCHEMA_VERSION,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    createdAt: input.createdAt,
    items,
    usage,
    health: assessContextHealth(input.budget, estimated),
    compactions: [...(input.priorCompactions ?? []), ...compactions],
  });
  return { package: pkg, compactions };
}

/** Estimate one prospective addition against the current package health. */
export function wouldExceedBudget(
  budget: ContextBudgetConfig,
  currentEstimatedTokens: number,
  candidate: Pick<ContextItem, 'title' | 'content'>,
): boolean {
  return (
    currentEstimatedTokens + estimateItemTokens(candidate) > usableInputTokens(budget)
  );
}
