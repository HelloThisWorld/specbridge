import { z } from 'zod';
import { CONTEXT_HEALTH_LEVELS, CONTEXT_LAYERS, COMPACTION_LEVELS } from './vocabulary.js';

/**
 * Context items and packages.
 *
 * A context item is one bounded, attributable piece of assembled context.
 * A context package is the complete, budget-checked set of items a worker
 * receives — assembled deterministically from durable SpecBridge state, never
 * replayed from a previous agent conversation.
 *
 * Versioned from day one, additive with the repository's usual rules:
 * unknown fields survive via passthrough; an unknown MAJOR version is
 * refused rather than coerced.
 */

export const CONTEXT_PACKAGE_SCHEMA_VERSION = '1.0.0';

export const CONTEXT_LIMITS = {
  /** Hard ceiling on one item's content. Larger payloads live in artifacts. */
  maxItemContentChars: 200_000,
  maxShortTextChars: 512,
  maxItemsPerPackage: 500,
  maxCompactionRecords: 200,
} as const;

const shortText = z.string().min(1).max(CONTEXT_LIMITS.maxShortTextChars);

/**
 * One bounded piece of context.
 *
 * `kind` is a free-form short label ('task-contract', 'decision',
 * 'failed-approach', 'file-excerpt', 'diff', 'test-result', 'tool-result',
 * 'log', 'summary', …) used by compaction policy; it is descriptive, never
 * authoritative — the LAYER carries the protection semantics.
 */
export const contextItemSchema = z
  .object({
    itemId: shortText,
    layer: z.enum(CONTEXT_LAYERS),
    kind: shortText,
    title: shortText,
    content: z.string().max(CONTEXT_LIMITS.maxItemContentChars),
    createdAt: shortText,
    /** Where the content came from (a checkpoint id, run id, file path, …). */
    source: shortText.optional(),
    /**
     * Items sharing a dedupe key are the same logical thing observed more
     * than once (the same file read twice, the same test run repeated).
     * Micro-compaction keeps only the newest item per key.
     */
    dedupeKey: shortText.optional(),
    /**
     * Set when the information in this item has been incorporated into the
     * given durable checkpoint. Folded items are droppable at milestone and
     * emergency compaction — their truth now lives in durable state.
     */
    foldedIntoCheckpointId: shortText.optional(),
    /** True when micro-compaction already produced this structured form. */
    compacted: z.boolean().default(false),
  })
  .passthrough();
export type ContextItem = z.infer<typeof contextItemSchema>;

/** One recorded compaction pass (kept on the package for observability). */
export const compactionRecordSchema = z
  .object({
    level: z.enum(COMPACTION_LEVELS),
    at: shortText,
    itemsBefore: z.number().int().min(0),
    itemsAfter: z.number().int().min(0),
    estimatedTokensBefore: z.number().int().min(0),
    estimatedTokensAfter: z.number().int().min(0),
    /** Checkpoint the pass folded state into, when one was involved. */
    checkpointId: shortText.optional(),
    detail: z.string().max(2_000).optional(),
  })
  .passthrough();
export type CompactionRecord = z.infer<typeof compactionRecordSchema>;

/** Budget usage snapshot embedded in every assembled package. */
export const contextUsageSchema = z
  .object({
    estimatedTokens: z.number().int().min(0),
    usableInputTokens: z.number().int().min(1),
    modelContextTokens: z.number().int().min(1),
    /** estimatedTokens / usableInputTokens, rounded to 4 decimal places. */
    ratio: z.number().min(0),
  })
  .passthrough();
export type ContextUsage = z.infer<typeof contextUsageSchema>;

/**
 * The assembled, budget-checked context a worker receives.
 *
 * A package is DERIVED state: it is rebuilt deterministically from durable
 * SpecBridge state whenever needed, so losing one loses nothing.
 */
export const contextPackageSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText.optional(),
    taskId: shortText.optional(),
    attemptId: shortText.optional(),
    createdAt: shortText,
    items: z.array(contextItemSchema).max(CONTEXT_LIMITS.maxItemsPerPackage),
    usage: contextUsageSchema,
    health: z.enum(CONTEXT_HEALTH_LEVELS),
    /** Compaction passes applied while producing this package. */
    compactions: z.array(compactionRecordSchema).max(CONTEXT_LIMITS.maxCompactionRecords).default([]),
  })
  .passthrough();
export type ContextPackage = z.infer<typeof contextPackageSchema>;

/** Items of one layer, in stable insertion order. */
export function itemsInLayer(items: readonly ContextItem[], layer: ContextItem['layer']): ContextItem[] {
  return items.filter((item) => item.layer === layer);
}

/** Render a package into one prompt-ready text block, layer by layer. */
export function renderContextPackage(pkg: ContextPackage): string {
  const sections: string[] = [];
  for (const layer of CONTEXT_LAYERS) {
    const layerItems = itemsInLayer(pkg.items, layer);
    if (layerItems.length === 0) continue;
    sections.push(`## ${layer}`);
    for (const item of layerItems) {
      sections.push(`### ${item.title}`, item.content);
    }
  }
  return sections.join('\n\n');
}
