import { z } from 'zod';
import { estimateItemsTokens } from './budget.js';
import type { ContextItem } from './items.js';
import { CONTEXT_LAYERS } from './vocabulary.js';
import { CONTEXT_STRATEGIES, CONTEXT_SHAPES, CONTEXT_EXPANSION_LEVELS } from './vocabulary.js';

/**
 * Context efficiency metrics.
 *
 * Collected so that the question this phase actually cares about can be
 * answered later from durable records:
 *
 *   what did context COST per SUCCESSFUL task?
 *
 * — not "did we send fewer tokens?". Sending 5K tokens and failing five
 * times is more expensive, in every currency this runtime tracks, than
 * sending 20K once and succeeding. A metric set that only counted input size
 * would score that backwards, so success, attempts, and expansions are
 * recorded beside the sizes and are meant to be read together.
 *
 * Two rules keep the numbers honest:
 *
 *   ESTIMATED ≠ REPORTED   `estimatedContextTokens` is SpecBridge's own
 *                          conservative heuristic. `providerReportedInputTokens`
 *                          is what a provider actually said. Neither ever
 *                          overwrites the other, and a provider that reports
 *                          nothing leaves null — which means UNKNOWN, not zero.
 *   NO INFERRED CACHING    `cachedInputTokens` is populated only from a
 *                          provider's own usage payload. Designing a stable
 *                          prefix makes caching possible; it does not make a
 *                          cache hit observable, and this phase never claims
 *                          a saving it cannot see.
 *
 * Deliberately un-aggregated: raw facts per attempt, so the later adaptive
 * scheduler can ask questions this phase did not think to pre-compute.
 */

export const CONTEXT_METRICS_SCHEMA_VERSION = '1.0.0';

export const contextEfficiencyMetricsSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    strategy: z.enum(CONTEXT_STRATEGIES),
    shape: z.enum(CONTEXT_SHAPES),
    expansionLevel: z.enum(CONTEXT_EXPANSION_LEVELS),
    /** Runner/lane attribution, for cross-lane comparison. */
    lane: z.string().nullable().default(null),
    executionMode: z.string().nullable().default(null),
    runner: z.string().nullable().default(null),
    role: z.string().nullable().default(null),

    // --- composition -----------------------------------------------------
    estimatedContextTokens: z.number().int().min(0),
    pinnedTokens: z.number().int().min(0).default(0),
    durableTokens: z.number().int().min(0).default(0),
    compactedHistoryTokens: z.number().int().min(0).default(0),
    workingSetTokens: z.number().int().min(0).default(0),
    recentDeltaTokens: z.number().int().min(0).default(0),
    currentActionTokens: z.number().int().min(0).default(0),
    totalChars: z.number().int().min(0).default(0),

    // --- retrieval -------------------------------------------------------
    indexedFiles: z.number().int().min(0).nullable().default(null),
    retrievedCandidates: z.number().int().min(0).default(0),
    selectedFiles: z.number().int().min(0).default(0),
    selectedSections: z.number().int().min(0).default(0),
    pointerCount: z.number().int().min(0).default(0),
    excludedCandidates: z.number().int().min(0).default(0),
    localRerankApplied: z.boolean().default(false),

    // --- reduction -------------------------------------------------------
    compressedItems: z.number().int().min(0).default(0),
    compressionSourceChars: z.number().int().min(0).default(0),
    compressionOutputChars: z.number().int().min(0).default(0),
    deduplicatedItems: z.number().int().min(0).default(0),
    deduplicationSavedChars: z.number().int().min(0).default(0),
    staleItemsRemoved: z.number().int().min(0).default(0),
    staleSavedChars: z.number().int().min(0).default(0),

    // --- lifecycle -------------------------------------------------------
    contextExpansions: z.number().int().min(0).default(0),
    nativeCompactions: z.number().int().min(0).nullable().default(null),
    genericCompactions: z.number().int().min(0).default(0),

    // --- provider truth (never estimated) --------------------------------
    /** What the provider REPORTED as input tokens. Null means unknown. */
    providerReportedInputTokens: z.number().int().min(0).nullable().default(null),
    /** Provider-reported cached input tokens. Null means the provider did not say. */
    cachedInputTokens: z.number().int().min(0).nullable().default(null),

    // --- outcome ---------------------------------------------------------
    /** Whether the attempt this context served ultimately verified. */
    success: z.boolean().nullable().default(null),
    /** Stable identity of the reusable prompt prefix, for reuse analysis. */
    stablePrefixHash: z.string().nullable().default(null),
    createdAt: z.string().min(1).max(64),
  })
  .passthrough();
export type ContextEfficiencyMetrics = z.infer<typeof contextEfficiencyMetricsSchema>;

/** Compression ratio, or null when nothing was compressed. */
export function compressionRatio(metrics: ContextEfficiencyMetrics): number | null {
  if (metrics.compressionSourceChars === 0) return null;
  return Math.round((metrics.compressionOutputChars / metrics.compressionSourceChars) * 10_000) / 10_000;
}

/** Per-layer token composition of an item list, keyed by layer name. */
export function composition(items: readonly ContextItem[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const layer of CONTEXT_LAYERS) {
    result[layer] = estimateItemsTokens(items.filter((item) => item.layer === layer));
  }
  return result;
}

export interface ContextMetricsInput {
  strategy: ContextEfficiencyMetrics['strategy'];
  shape: ContextEfficiencyMetrics['shape'];
  expansionLevel: ContextEfficiencyMetrics['expansionLevel'];
  items: readonly ContextItem[];
  createdAt: string;
  lane?: string | null | undefined;
  executionMode?: string | null | undefined;
  runner?: string | null | undefined;
  role?: string | null | undefined;
  indexedFiles?: number | null | undefined;
  retrievedCandidates?: number | undefined;
  selectedFiles?: number | undefined;
  selectedSections?: number | undefined;
  pointerCount?: number | undefined;
  excludedCandidates?: number | undefined;
  localRerankApplied?: boolean | undefined;
  compressedItems?: number | undefined;
  compressionSourceChars?: number | undefined;
  compressionOutputChars?: number | undefined;
  deduplicatedItems?: number | undefined;
  deduplicationSavedChars?: number | undefined;
  staleItemsRemoved?: number | undefined;
  staleSavedChars?: number | undefined;
  contextExpansions?: number | undefined;
  genericCompactions?: number | undefined;
  stablePrefixHash?: string | null | undefined;
}

/**
 * Build the metrics record for one assembled package.
 *
 * Everything provider-reported is deliberately absent here and filled in
 * later, by the layer that actually receives a usage payload. A builder that
 * could invent an input-token count would eventually be asked to.
 */
export function buildContextMetrics(input: ContextMetricsInput): ContextEfficiencyMetrics {
  const layers = composition(input.items);
  return contextEfficiencyMetricsSchema.parse({
    schemaVersion: CONTEXT_METRICS_SCHEMA_VERSION,
    strategy: input.strategy,
    shape: input.shape,
    expansionLevel: input.expansionLevel,
    lane: input.lane ?? null,
    executionMode: input.executionMode ?? null,
    runner: input.runner ?? null,
    role: input.role ?? null,
    estimatedContextTokens: estimateItemsTokens(input.items),
    pinnedTokens: layers['PINNED'] ?? 0,
    durableTokens: layers['DURABLE_TASK_STATE'] ?? 0,
    compactedHistoryTokens: layers['COMPACTED_HISTORY'] ?? 0,
    workingSetTokens: layers['WORKING_SET'] ?? 0,
    recentDeltaTokens: layers['RECENT_DELTA'] ?? 0,
    currentActionTokens: layers['CURRENT_ACTION'] ?? 0,
    totalChars: input.items.reduce((sum, item) => sum + item.content.length, 0),
    indexedFiles: input.indexedFiles ?? null,
    retrievedCandidates: input.retrievedCandidates ?? 0,
    selectedFiles: input.selectedFiles ?? 0,
    selectedSections: input.selectedSections ?? 0,
    pointerCount: input.pointerCount ?? 0,
    excludedCandidates: input.excludedCandidates ?? 0,
    localRerankApplied: input.localRerankApplied ?? false,
    compressedItems: input.compressedItems ?? 0,
    compressionSourceChars: input.compressionSourceChars ?? 0,
    compressionOutputChars: input.compressionOutputChars ?? 0,
    deduplicatedItems: input.deduplicatedItems ?? 0,
    deduplicationSavedChars: input.deduplicationSavedChars ?? 0,
    staleItemsRemoved: input.staleItemsRemoved ?? 0,
    staleSavedChars: input.staleSavedChars ?? 0,
    contextExpansions: input.contextExpansions ?? 0,
    genericCompactions: input.genericCompactions ?? 0,
    stablePrefixHash: input.stablePrefixHash ?? null,
    createdAt: input.createdAt,
  });
}

/**
 * Record what a provider actually reported.
 *
 * Separate from construction on purpose: this is the ONLY way reported
 * figures enter the record, and it never touches the estimate beside them.
 */
export function withProviderUsage(
  metrics: ContextEfficiencyMetrics,
  usage: {
    inputTokens?: number | null | undefined;
    cachedTokens?: number | null | undefined;
    success?: boolean | null | undefined;
    nativeCompactions?: number | null | undefined;
  },
): ContextEfficiencyMetrics {
  return {
    ...metrics,
    providerReportedInputTokens: usage.inputTokens ?? metrics.providerReportedInputTokens,
    cachedInputTokens: usage.cachedTokens ?? metrics.cachedInputTokens,
    nativeCompactions: usage.nativeCompactions ?? metrics.nativeCompactions,
    success: usage.success ?? metrics.success,
  };
}
