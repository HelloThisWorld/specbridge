import type { AssembledContext } from './assembler.js';
import { assembleContextPackage } from './assembler.js';
import type { ContextBudgetConfig } from './budget.js';
import { estimateItemsTokens } from './budget.js';
import type { ContextAllocationPolicy, ContextBudgetAllocation } from './budget-allocation.js';
import { allocateContextBudget, defaultContextAllocationPolicy } from './budget-allocation.js';
import type { CompressionResult } from './compression.js';
import { compressArtifact } from './compression.js';
import type { DuplicateRecord } from './dedupe.js';
import { deduplicateItems } from './dedupe.js';
import type { ContextItem } from './items.js';
import type { ContextEfficiencyMetrics } from './metrics.js';
import { buildContextMetrics } from './metrics.js';
import { buildStablePrefix, componentHashes } from './prefix.js';
import type { RepositoryContextIndex } from './repo-index.js';
import type { RankedCandidate, RankOptions } from './retrieval-rank.js';
import { rankCandidates } from './retrieval-rank.js';
import type { ContextRetrievalQuery } from './retrieval-query.js';
import type { RerankInference } from './retrieval-rerank.js';
import { rerankCandidates } from './retrieval-rerank.js';
import type { SectionOptions } from './retrieval-sections.js';
import type { ContextPointer, ContextSelectionPlan, ExcludedCandidate, SelectedContextItem } from './selection.js';
import {
  CONTEXT_SELECTION_PLAN_SCHEMA_VERSION,
  contextSelectionPlanSchema,
  pointerItem,
  selectWorkingSet,
} from './selection.js';
import type { StaleRecord, StalenessWorld } from './staleness.js';
import { removeStaleItems } from './staleness.js';
import type { ContextExpansionLevel, ContextShape, ContextStrategy } from './vocabulary.js';

/**
 * The context-efficiency pipeline.
 *
 *   durable canonical state ──┐
 *                             ├─→ retrieval → selection plan → shape ──┐
 *   repository index ─────────┘                                        │
 *                                                                      ▼
 *          staleness removal → deduplication → compression → stable prefix
 *                                                                      │
 *                                                                      ▼
 *                                 vNext.1 budget + compaction → ContextPackage
 *
 * Two properties are worth naming explicitly, because they are what make
 * this safe to turn on:
 *
 *   LEGACY IS UNTOUCHED   under `strategy: 'LEGACY'` this function calls the
 *                         existing assembler with the caller's items and does
 *                         nothing else. No retrieval, no compression, no
 *                         dedupe, no reordering. That is the rollback path,
 *                         and it is a single branch rather than a pile of
 *                         disabled flags.
 *   CANONICAL SURVIVES    retrieval only ever produces WORKING_SET items.
 *                         Pinned and durable layers arrive from the caller,
 *                         built deterministically from durable state, and
 *                         every stage below refuses to touch them. Efficiency
 *                         processing cannot drop the contract, the criteria,
 *                         the failed approaches, or the recovery decision.
 */

export interface EfficientContextInput {
  strategy: ContextStrategy;
  shape: ContextShape;
  expansionLevel: ContextExpansionLevel;
  /**
   * Canonical items the caller built from durable state: PINNED,
   * DURABLE_TASK_STATE, CURRENT_ACTION, RECENT_DELTA, COMPACTED_HISTORY.
   * Retrieval never produces these and never removes them.
   */
  canonicalItems: readonly ContextItem[];
  budget: ContextBudgetConfig;
  allocationPolicy?: ContextAllocationPolicy | undefined;
  createdAt: string;
  planId: string;
  taskId: string;
  jobId?: string | undefined;
  nodeId?: string | undefined;
  attemptId?: string | undefined;
  executionLane?: string | null | undefined;
  executionMode?: string | null | undefined;
  runner?: string | null | undefined;

  // --- retrieval (absent under LEGACY) -----------------------------------
  index?: RepositoryContextIndex | undefined;
  rootDir?: string | undefined;
  query?: ContextRetrievalQuery | undefined;
  rankOptions?: RankOptions | undefined;
  sectionOptions?: SectionOptions | undefined;
  maxSelectedItems?: number | undefined;
  maxPointers?: number | undefined;
  /** Advisory local reranker; omitted means deterministic order stands. */
  rerankInference?: RerankInference | undefined;
  onInferenceCall?: (() => void) | undefined;

  // --- reduction ---------------------------------------------------------
  /** World state for staleness checks (current hashes, checkpoint, baseline). */
  stalenessWorld?: StalenessWorld | undefined;
  /** Compress items whose content exceeds this many characters. */
  compressOverChars?: number | undefined;
  /** Layers eligible for compression. Protected layers are never eligible. */
  compressibleLayers?: readonly ContextItem['layer'][] | undefined;

  // --- assembly ----------------------------------------------------------
  checkpointId?: string | undefined;
  checkpointSummaryItem?: ContextItem | undefined;
  genericCompactionsSoFar?: number | undefined;
  contextExpansionsSoFar?: number | undefined;
}

export interface EfficientContextResult {
  assembled: AssembledContext;
  plan: ContextSelectionPlan;
  metrics: ContextEfficiencyMetrics;
  /** Deterministic candidate ranking, before any advisory rerank. */
  deterministicCandidates: RankedCandidate[];
  duplicates: DuplicateRecord[];
  stale: StaleRecord[];
  compressions: CompressionResult[];
  /** Indexed paths whose recorded hash no longer matched the file on disk. */
  refreshedPaths: string[];
}

const DEFAULT_COMPRESSIBLE_LAYERS: readonly ContextItem['layer'][] = [
  'WORKING_SET',
  'RECENT_DELTA',
  'COMPACTED_HISTORY',
];

function emptyPlan(input: EfficientContextInput, allocation: ContextBudgetAllocation, items: readonly ContextItem[]): ContextSelectionPlan {
  return contextSelectionPlanSchema.parse({
    schemaVersion: CONTEXT_SELECTION_PLAN_SCHEMA_VERSION,
    planId: input.planId,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    taskId: input.taskId,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    strategy: input.strategy,
    shape: input.shape,
    role: input.query?.role ?? 'EXECUTOR',
    expansionLevel: input.expansionLevel,
    executionLane: input.executionLane ?? null,
    executionMode: input.executionMode ?? null,
    runner: input.runner ?? null,
    pinnedItemIds: items.filter((item) => item.layer === 'PINNED').map((item) => item.itemId),
    durableItemIds: items.filter((item) => item.layer === 'DURABLE_TASK_STATE').map((item) => item.itemId),
    recentDeltaItemIds: items.filter((item) => item.layer === 'RECENT_DELTA').map((item) => item.itemId),
    estimatedTokens: tokensByLayer(items),
    budget: {
      usableInputTokens: allocation.usableInputTokens,
      workingSetBudget: allocation.workingSetBudget,
      pinnedReserve: allocation.pinnedReserve,
      durableReserve: allocation.durableReserve,
      recoveryReserve: allocation.recoveryReserve,
      deltaReserve: allocation.deltaReserve,
      maxSingleItemTokens: allocation.maxSingleItemTokens,
    },
    componentHashes: componentHashes(items) as unknown as Record<string, string | null>,
    createdAt: input.createdAt,
  });
}

function tokensByLayer(items: readonly ContextItem[]): ContextSelectionPlan['estimatedTokens'] {
  const of = (layer: ContextItem['layer']): number =>
    estimateItemsTokens(items.filter((item) => item.layer === layer));
  return {
    pinned: of('PINNED'),
    durable: of('DURABLE_TASK_STATE'),
    compactedHistory: of('COMPACTED_HISTORY'),
    workingSet: of('WORKING_SET'),
    recentDelta: of('RECENT_DELTA'),
    currentAction: of('CURRENT_ACTION'),
    total: estimateItemsTokens(items),
  };
}

/**
 * Build one efficient ContextPackage.
 *
 * Async only because the optional local rerank is; with no reranker
 * configured every stage is synchronous and deterministic, which is what
 * makes selection replayable in tests.
 */
export async function buildEfficientContext(
  input: EfficientContextInput,
): Promise<EfficientContextResult> {
  const allocationPolicy = input.allocationPolicy ?? defaultContextAllocationPolicy();
  const allocation = allocateContextBudget(input.budget, allocationPolicy, input.shape);

  // ---------------------------------------------------------------------
  // LEGACY: the vNext.6 path, verbatim.
  // ---------------------------------------------------------------------
  if (input.strategy === 'LEGACY') {
    const assembled = assembleContextPackage({
      items: input.canonicalItems,
      budget: input.budget,
      createdAt: input.createdAt,
      jobId: input.jobId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      checkpointId: input.checkpointId,
      checkpointSummaryItem: input.checkpointSummaryItem,
    });
    const plan = emptyPlan(input, allocation, assembled.package.items);
    return {
      assembled,
      plan,
      metrics: buildContextMetrics({
        strategy: 'LEGACY',
        shape: input.shape,
        expansionLevel: input.expansionLevel,
        items: assembled.package.items,
        createdAt: input.createdAt,
        lane: input.executionLane,
        executionMode: input.executionMode,
        runner: input.runner,
        role: input.query?.role ?? null,
        genericCompactions: (input.genericCompactionsSoFar ?? 0) + assembled.compactions.length,
        contextExpansions: input.contextExpansionsSoFar ?? 0,
      }),
      deterministicCandidates: [],
      duplicates: [],
      stale: [],
      compressions: [],
      refreshedPaths: [],
    };
  }

  // ---------------------------------------------------------------------
  // 1. Retrieval. Produces WORKING_SET items and pointers only.
  // ---------------------------------------------------------------------
  let deterministicCandidates: RankedCandidate[] = [];
  let candidates: RankedCandidate[] = [];
  let selected: SelectedContextItem[] = [];
  let pointers: ContextPointer[] = [];
  let excluded: ExcludedCandidate[] = [];
  let workingItems: ContextItem[] = [];
  let refreshedPaths: string[] = [];
  let localRerankApplied = false;

  const canRetrieve =
    input.index !== undefined && input.rootDir !== undefined && input.query !== undefined;

  if (canRetrieve) {
    const index = input.index as RepositoryContextIndex;
    const query = input.query as ContextRetrievalQuery;
    deterministicCandidates = rankCandidates(index, query, input.rankOptions ?? {});
    candidates = deterministicCandidates;

    if (input.rerankInference !== undefined) {
      const reranked = await rerankCandidates({
        query,
        candidates: deterministicCandidates,
        inference: input.rerankInference,
        ...(input.onInferenceCall !== undefined ? { onInferenceCall: input.onInferenceCall } : {}),
      });
      candidates = reranked.candidates;
      localRerankApplied = reranked.applied;
    }

    const selection = selectWorkingSet({
      index,
      rootDir: input.rootDir as string,
      candidates,
      query,
      shape: input.shape,
      allocation,
      expansionLevel: input.expansionLevel,
      maxSelectedItems: input.maxSelectedItems,
      maxPointers: input.maxPointers,
      sectionOptions: input.sectionOptions,
      createdAt: input.createdAt,
    });
    selected = selection.selected;
    pointers = selection.pointers;
    excluded = selection.excluded;
    workingItems = selection.items;
    refreshedPaths = selection.refreshedPaths;

    const pointerBlock = pointerItem(pointers, input.createdAt);
    if (pointerBlock !== undefined) workingItems = [...workingItems, pointerBlock];
  }

  // ---------------------------------------------------------------------
  // 2. Staleness. Remove what has stopped being true, before anything else
  //    spends budget on it.
  //
  //    Applied to the CARRIED-OVER items only. The items retrieval just
  //    produced were read from disk and hash-verified microseconds ago, so
  //    they are current by construction — re-checking them against the
  //    INDEX would let a lagging index invalidate content that is provably
  //    fresher than the index itself, which is the precise inversion this
  //    layer exists to prevent.
  // ---------------------------------------------------------------------
  const staleness = removeStaleItems(input.canonicalItems, input.stalenessWorld ?? {});

  // The caller's own WORKING_SET items (a diff, the current test output) are
  // preserved: retrieval ADDS repository context, it does not replace what
  // the control plane already decided the worker needs.
  let items: ContextItem[] = [...staleness.items, ...workingItems];

  // ---------------------------------------------------------------------
  // 3. Deduplication. Highest authority survives; conflicts are never merged.
  // ---------------------------------------------------------------------
  const deduped = deduplicateItems(items);
  items = deduped.items;

  // ---------------------------------------------------------------------
  // 4. Deterministic compression of large mechanical output.
  // ---------------------------------------------------------------------
  const compressibleLayers = input.compressibleLayers ?? DEFAULT_COMPRESSIBLE_LAYERS;
  const compressions: CompressionResult[] = [];
  items = items.map((item) => {
    if (item.compacted || !compressibleLayers.includes(item.layer)) return item;
    // A repository excerpt is not "mechanical output": compressing source
    // would hand the worker a lossy version of the very thing it must edit.
    if (item.provenance?.kind === 'repository-file' || item.provenance?.kind === 'repository-section') {
      return item;
    }
    const result = compressArtifact({
      kind: item.kind,
      content: item.content,
      minChars: input.compressOverChars,
    });
    if (result === undefined || result.compressedBytes >= result.sourceBytes) return item;
    compressions.push(result);
    return {
      ...item,
      content: result.text,
      compacted: true,
      authority: item.authority ?? 'DERIVED',
      compression: {
        method: result.method,
        sourceBytes: result.sourceBytes,
        compressedBytes: result.compressedBytes,
        sourceHashes: [result.sourceHash],
        sourceRefs: item.source !== undefined ? [item.source] : [],
        createdAt: input.createdAt,
      },
      provenance: item.provenance ?? {
        kind: 'derived',
        artifactRefs: item.source !== undefined ? [item.source] : [],
        sourceHashes: [result.sourceHash],
      },
    } satisfies ContextItem;
  });

  // ---------------------------------------------------------------------
  // 5. Stable prefix ordering, then the existing vNext.1 assembly.
  // ---------------------------------------------------------------------
  const prefix = buildStablePrefix(items);
  const assembled = assembleContextPackage({
    items: prefix.items,
    budget: input.budget,
    createdAt: input.createdAt,
    jobId: input.jobId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    checkpointId: input.checkpointId,
    checkpointSummaryItem: input.checkpointSummaryItem,
  });

  const finalItems = assembled.package.items;
  const survivingPaths = new Set(
    finalItems
      .map((item) => item.provenance?.path)
      .filter((path): path is string => path !== undefined),
  );
  // A selected item that assembly's own compaction dropped is reported as
  // excluded rather than silently listed as selected — the plan must
  // describe the package that was actually built.
  const droppedBySelection = selected.filter((entry) => !survivingPaths.has(entry.path));
  const finalSelected = selected.filter((entry) => survivingPaths.has(entry.path));
  const finalExcluded: ExcludedCandidate[] = [
    ...excluded,
    ...droppedBySelection.map((entry) => ({
      path: entry.path,
      reason: 'BUDGET_EXHAUSTED' as const,
      score: entry.score,
      detail: 'dropped by budget compaction during assembly',
    })),
  ];

  const plan = contextSelectionPlanSchema.parse({
    schemaVersion: CONTEXT_SELECTION_PLAN_SCHEMA_VERSION,
    planId: input.planId,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    taskId: input.taskId,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    strategy: input.strategy,
    shape: input.shape,
    role: input.query?.role ?? 'EXECUTOR',
    expansionLevel: input.expansionLevel,
    executionLane: input.executionLane ?? null,
    executionMode: input.executionMode ?? null,
    runner: input.runner ?? null,
    pinnedItemIds: finalItems.filter((item) => item.layer === 'PINNED').map((item) => item.itemId),
    durableItemIds: finalItems
      .filter((item) => item.layer === 'DURABLE_TASK_STATE')
      .map((item) => item.itemId),
    selectedWorkingItems: finalSelected,
    pointers,
    recentDeltaItemIds: finalItems
      .filter((item) => item.layer === 'RECENT_DELTA')
      .map((item) => item.itemId),
    excludedCandidates: finalExcluded.slice(0, 200),
    deterministicOrder: deterministicCandidates.slice(0, 400).map((candidate) => candidate.path),
    localRerankApplied,
    estimatedTokens: tokensByLayer(finalItems),
    budget: {
      usableInputTokens: allocation.usableInputTokens,
      workingSetBudget: allocation.workingSetBudget,
      pinnedReserve: allocation.pinnedReserve,
      durableReserve: allocation.durableReserve,
      recoveryReserve: allocation.recoveryReserve,
      deltaReserve: allocation.deltaReserve,
      maxSingleItemTokens: allocation.maxSingleItemTokens,
    },
    componentHashes: componentHashes(finalItems) as unknown as Record<string, string | null>,
    createdAt: input.createdAt,
  });

  const metrics = buildContextMetrics({
    strategy: input.strategy,
    shape: input.shape,
    expansionLevel: input.expansionLevel,
    items: finalItems,
    createdAt: input.createdAt,
    lane: input.executionLane,
    executionMode: input.executionMode,
    runner: input.runner,
    role: input.query?.role ?? null,
    indexedFiles: input.index?.size ?? null,
    retrievedCandidates: deterministicCandidates.length,
    selectedFiles: finalSelected.length,
    selectedSections: finalSelected.filter((entry) => entry.startLine !== undefined).length,
    pointerCount: pointers.length,
    excludedCandidates: finalExcluded.length,
    localRerankApplied,
    compressedItems: compressions.length,
    compressionSourceChars: compressions.reduce((sum, entry) => sum + entry.sourceBytes, 0),
    compressionOutputChars: compressions.reduce((sum, entry) => sum + entry.compressedBytes, 0),
    deduplicatedItems: deduped.duplicates.length,
    deduplicationSavedChars: deduped.savedChars,
    staleItemsRemoved: staleness.stale.length,
    staleSavedChars: staleness.savedChars,
    contextExpansions: input.contextExpansionsSoFar ?? 0,
    genericCompactions: (input.genericCompactionsSoFar ?? 0) + assembled.compactions.length,
    stablePrefixHash: prefix.prefixHash,
  });

  return {
    assembled,
    plan,
    metrics,
    deterministicCandidates,
    duplicates: deduped.duplicates,
    stale: staleness.stale,
    compressions,
    refreshedPaths,
  };
}
