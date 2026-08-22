import { z } from 'zod';
import type { ContextBudgetConfig } from './budget.js';
import { estimateItemsTokens, usableInputTokens } from './budget.js';
import type { ContextItem } from './items.js';
import { CONTEXT_LAYERS, isProtectedLayer } from './vocabulary.js';
import type { ContextLayer, ContextShape } from './vocabulary.js';

/**
 * Intentional budget allocation across the context layers.
 *
 * The vNext.1 budget answered one question — does the whole package fit? —
 * which is necessary but not sufficient. Without per-layer intent, a
 * generous repository retrieval can fill the window with plausible working
 * context and squeeze out the durable state that cannot be recovered any
 * other way. The failure is quiet: the package fits, the health is green,
 * and the worker has lost the checkpoint.
 *
 * So space is RESERVED before it is spent:
 *
 *   total usable input
 *   ├── pinned reserve            contract, criteria, invariants
 *   ├── durable-state reserve     checkpoint-backed truth
 *   ├── recovery/evaluation       current failure, assessment, decision
 *   ├── recent-delta budget       newest raw signal
 *   ├── working-set budget        retrieved repository context ← the flexible one
 *   └── tool/output headroom      already withheld by the budget config
 *
 * The reserves are FLOORS, not quotas: a layer that needs less leaves the
 * remainder to the working set. What a reserve guarantees is that the
 * working set can never take the last token a pinned item needed.
 */

export const contextAllocationPolicySchema = z
  .object({
    /** Share of usable input guaranteed to PINNED items. */
    pinnedReserveRatio: z.number().min(0).max(1).default(0.12),
    /** Share guaranteed to DURABLE_TASK_STATE. */
    durableReserveRatio: z.number().min(0).max(1).default(0.18),
    /** Share guaranteed to current failure/recovery context. */
    recoveryReserveRatio: z.number().min(0).max(1).default(0.1),
    /** Share guaranteed to RECENT_DELTA. */
    deltaReserveRatio: z.number().min(0).max(1).default(0.1),
    /** Ceiling on the retrieved WORKING_SET, as a share of usable input. */
    workingSetMaxRatio: z.number().min(0).max(1).default(0.45),
    /**
     * Ceiling on the working set when the worker reads the repository
     * itself. Much smaller on purpose: a harness receives pointers, and a
     * package that also materializes the bodies pays for them twice.
     */
    pointerShapeWorkingSetMaxRatio: z.number().min(0).max(1).default(0.15),
    /** Ceiling on one working-set item, as a share of the working-set budget. */
    maxSingleItemRatio: z.number().min(0.05).max(1).default(0.4),
  })
  .passthrough()
  .refine(
    (policy) =>
      policy.pinnedReserveRatio +
        policy.durableReserveRatio +
        policy.recoveryReserveRatio +
        policy.deltaReserveRatio <=
      0.85,
    {
      message:
        'Context layer reserves must leave room for retrieved working context: their sum must not exceed 0.85 of usable input.',
    },
  );
export type ContextAllocationPolicy = z.infer<typeof contextAllocationPolicySchema>;

export function defaultContextAllocationPolicy(): ContextAllocationPolicy {
  return contextAllocationPolicySchema.parse({});
}

export interface ContextBudgetAllocation {
  usableInputTokens: number;
  pinnedReserve: number;
  durableReserve: number;
  recoveryReserve: number;
  deltaReserve: number;
  /** Tokens the retrieved working set may occupy. */
  workingSetBudget: number;
  /** Ceiling on any single working-set item. */
  maxSingleItemTokens: number;
}

/**
 * Compute the allocation for one dispatch.
 *
 * `shape` is load-bearing: a POINTER-shaped package (a tool-capable harness)
 * gets a much smaller working-set ceiling than a MATERIALIZED one, because
 * its worker can fetch current bytes itself and the prompt's job is to carry
 * what the repository cannot tell it.
 */
export function allocateContextBudget(
  budget: ContextBudgetConfig,
  policy: ContextAllocationPolicy,
  shape: ContextShape = 'MATERIALIZED',
): ContextBudgetAllocation {
  const usable = usableInputTokens(budget);
  const workingSetRatio =
    shape === 'POINTER' ? policy.pointerShapeWorkingSetMaxRatio : policy.workingSetMaxRatio;
  const workingSetBudget = Math.floor(usable * workingSetRatio);
  return {
    usableInputTokens: usable,
    pinnedReserve: Math.floor(usable * policy.pinnedReserveRatio),
    durableReserve: Math.floor(usable * policy.durableReserveRatio),
    recoveryReserve: Math.floor(usable * policy.recoveryReserveRatio),
    deltaReserve: Math.floor(usable * policy.deltaReserveRatio),
    workingSetBudget,
    maxSingleItemTokens: Math.max(200, Math.floor(workingSetBudget * policy.maxSingleItemRatio)),
  };
}

/**
 * Priority order under budget pressure, lowest number dropped LAST.
 *
 * This is the §46 ordering expressed as data. It intentionally protects the
 * same three layers vNext.1 already protects — nothing here weakens an
 * existing guarantee — and adds a defensible ordering among the rest:
 * current failure state before older working context, working context before
 * history that a checkpoint already made durable.
 */
export const LAYER_DROP_PRIORITY: Readonly<Record<ContextLayer, number>> = Object.freeze({
  PINNED: 0,
  DURABLE_TASK_STATE: 1,
  CURRENT_ACTION: 2,
  RECENT_DELTA: 3,
  WORKING_SET: 4,
  COMPACTED_HISTORY: 5,
});

export interface LayerUsage {
  layer: ContextLayer;
  items: number;
  estimatedTokens: number;
}

/** Per-layer occupancy of a package, in layer order. */
export function layerUsage(items: readonly ContextItem[]): LayerUsage[] {
  return CONTEXT_LAYERS.map((layer) => {
    const inLayer = items.filter((item) => item.layer === layer);
    return { layer, items: inLayer.length, estimatedTokens: estimateItemsTokens(inLayer) };
  });
}

export interface FitResult {
  items: ContextItem[];
  /** Items removed to satisfy the working-set budget, most recent last. */
  dropped: ContextItem[];
  workingSetTokens: number;
}

/**
 * Trim the WORKING_SET to its allocated budget, dropping the lowest-value
 * items first.
 *
 * Only the working set is touched. It is the one layer that is genuinely
 * regenerable — every item in it can be retrieved again from the repository
 * — which is exactly why it is the layer that absorbs pressure. Items the
 * caller marked mandatory are never dropped here; when even the mandatory
 * set does not fit, that is a real signal (the task is too large for this
 * runner) and it is reported rather than absorbed.
 */
export function fitWorkingSet(
  items: readonly ContextItem[],
  allocation: ContextBudgetAllocation,
  isMandatory: (item: ContextItem) => boolean = () => false,
): FitResult {
  const working = items.filter((item) => item.layer === 'WORKING_SET');
  const others = items.filter((item) => item.layer !== 'WORKING_SET');
  const kept: ContextItem[] = [];
  const dropped: ContextItem[] = [];

  // Mandatory items are placed first and unconditionally: policy named them,
  // and a budget heuristic does not overrule the contract.
  const mandatory = working.filter((item) => isMandatory(item));
  const optional = working.filter((item) => !isMandatory(item));
  let spent = 0;
  for (const item of mandatory) {
    kept.push(item);
    spent += estimateItemsTokens([item]);
  }
  for (const item of optional) {
    const cost = estimateItemsTokens([item]);
    if (spent + cost > allocation.workingSetBudget) {
      dropped.push(item);
      continue;
    }
    kept.push(item);
    spent += cost;
  }

  // Restore original relative order so the stable prefix does not move.
  const keptIds = new Set(kept.map((item) => item.itemId));
  const orderedWorking = working.filter((item) => keptIds.has(item.itemId));
  const rebuilt: ContextItem[] = [];
  let workingIndex = 0;
  for (const item of items) {
    if (item.layer !== 'WORKING_SET') {
      rebuilt.push(item);
      continue;
    }
    if (keptIds.has(item.itemId)) {
      rebuilt.push(orderedWorking[workingIndex] as ContextItem);
      workingIndex += 1;
    }
  }
  void others;
  return { items: rebuilt, dropped, workingSetTokens: spent };
}

/**
 * Whether the protected layers alone already exceed their reserves.
 *
 * A true answer is a genuine control-plane signal, NOT something for the
 * context layer to fix: durable state that outgrows its reserve means the
 * task has accumulated more canonical truth than this runner's window can
 * hold, and the answers to that are a bigger runner, a decomposition, or a
 * milestone compaction — all of them decisions that belong upstream.
 */
export function protectedLayersOverReserve(
  items: readonly ContextItem[],
  allocation: ContextBudgetAllocation,
): boolean {
  const protectedTokens = estimateItemsTokens(items.filter((item) => isProtectedLayer(item.layer)));
  return protectedTokens > allocation.pinnedReserve + allocation.durableReserve + allocation.recoveryReserve;
}
