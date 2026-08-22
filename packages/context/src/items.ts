import { z } from 'zod';
import {
  CONTEXT_AUTHORITY_LEVELS,
  CONTEXT_COMPRESSION_METHODS,
  CONTEXT_FRESHNESS_KINDS,
  CONTEXT_HEALTH_LEVELS,
  CONTEXT_LAYERS,
  CONTEXT_ORIGIN_KINDS,
  CONTEXT_SELECTION_REASONS,
  COMPACTION_LEVELS,
} from './vocabulary.js';
import type { ContextAuthority, ContextFreshness } from './vocabulary.js';

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
 * Where one context item's content came from (vNext.7, additive).
 *
 * Provenance is what makes selected context AUDITABLE rather than merely
 * plausible: a repository excerpt names its path and the content hash it was
 * read at, a compressed artifact names the hashes it was derived from, a
 * diff names its baseline. An agent should not receive untraceable generated
 * context, and a diagnostic should be able to say where every byte came from
 * without printing the bytes.
 *
 * Every field is optional and the schema passes through unknown keys: a
 * pre-vNext.7 item simply carries no provenance, which parses unchanged.
 */
export const contextProvenanceSchema = z
  .object({
    kind: z.enum(CONTEXT_ORIGIN_KINDS),
    /** Workspace-relative path, forward slashes, when the origin is a file. */
    path: shortText.optional(),
    /** SHA-256 of the exact source bytes this content was taken from. */
    contentHash: shortText.optional(),
    /** 1-based inclusive line range, when a section rather than a whole file. */
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    /** Enclosing symbol name, when a symbol range was extracted. */
    symbol: shortText.optional(),
    /**
     * The baseline this content is relative to: a checkpoint id, a Git
     * revision, a prior context generation. A delta without a baseline is
     * not a delta, it is an assertion.
     */
    baselineRef: shortText.optional(),
    /** Run/verification/artifact ids this content was derived from. */
    artifactRefs: z.array(shortText).max(20).default([]),
    /** Content hashes of the sources a DERIVED item was computed from. */
    sourceHashes: z.array(shortText).max(20).default([]),
  })
  .passthrough();
export type ContextProvenance = z.infer<typeof contextProvenanceSchema>;

/**
 * How one item was compressed, and from what (vNext.7, additive).
 *
 * Compression is DERIVED data. The record names its method and its sources
 * so the canonical raw evidence stays retrievable — the prompt receives the
 * compressed representation, never the only copy.
 */
export const contextCompressionSchema = z
  .object({
    method: z.enum(CONTEXT_COMPRESSION_METHODS),
    sourceBytes: z.number().int().min(0),
    compressedBytes: z.number().int().min(0),
    /** Content hashes of the raw artifacts this was compressed from. */
    sourceHashes: z.array(shortText).max(20).default([]),
    /** Run/artifact ids where the canonical raw evidence still lives. */
    sourceRefs: z.array(shortText).max(20).default([]),
    createdAt: shortText,
    /** Model/profile identity when a local model performed the compression. */
    model: shortText.optional(),
  })
  .passthrough();
export type ContextCompression = z.infer<typeof contextCompressionSchema>;

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
    // --- vNext.7 Context Efficiency (all additive, all optional) ----------
    /** Where this content came from, at what hash, over what range. */
    provenance: contextProvenanceSchema.optional(),
    /**
     * How long this content stays true. Absent means CURRENT (see
     * `itemFreshness`) so every pre-vNext.7 item behaves exactly as before:
     * true as assembled, with nothing observed that invalidates it.
     */
    freshness: z.enum(CONTEXT_FRESHNESS_KINDS).optional(),
    /**
     * How much authority this content carries when two items disagree.
     * Absent means DERIVED (see `itemAuthority`) — the conservative middle:
     * a legacy item never outranks canonical state, and never loses to a
     * model claim.
     */
    authority: z.enum(CONTEXT_AUTHORITY_LEVELS).optional(),
    /** Why retrieval selected this item, when retrieval produced it. */
    selectionReason: z.enum(CONTEXT_SELECTION_REASONS).optional(),
    /** Compression record, when this item's content is compressed. */
    compression: contextCompressionSchema.optional(),
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

/**
 * Freshness of one item, with the conservative default for items that
 * predate vNext.7 (or were built without one): CURRENT — true as assembled.
 */
export function itemFreshness(item: Pick<ContextItem, 'freshness'>): ContextFreshness {
  return item.freshness ?? 'CURRENT';
}

/**
 * Authority of one item, defaulting to DERIVED. Deliberately the middle
 * rank: an item that never declared its authority may not outrank a
 * canonical contract, and may not be discarded in favour of a model claim.
 */
export function itemAuthority(item: Pick<ContextItem, 'authority'>): ContextAuthority {
  return item.authority ?? 'DERIVED';
}

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
