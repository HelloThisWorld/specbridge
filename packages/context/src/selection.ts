import { z } from 'zod';
import type { ContextBudgetAllocation } from './budget-allocation.js';
import { estimateTokens } from './budget.js';
import type { ContextItem } from './items.js';
import { CONTEXT_LIMITS } from './items.js';
import type { RepositoryContextIndex } from './repo-index.js';
import { resolveFresh } from './repo-index.js';
import type { RankedCandidate } from './retrieval-rank.js';
import type { ContextRetrievalQuery } from './retrieval-query.js';
import { RETRIEVAL_ROLES } from './retrieval-query.js';
import { extractSection } from './retrieval-sections.js';
import type { SectionOptions } from './retrieval-sections.js';
import { defaultFreshnessFor } from './staleness.js';
import {
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_EXPANSION_LEVELS,
  CONTEXT_EXPANSION_LEVEL_DEPTH,
  CONTEXT_SELECTION_REASONS,
  CONTEXT_SHAPES,
  CONTEXT_STRATEGIES,
} from './vocabulary.js';
import type { ContextExpansionLevel, ContextShape } from './vocabulary.js';

/**
 * The ContextSelectionPlan: what was chosen, what was not, and why.
 *
 * This record exists so that context selection is REVIEWABLE. Retrieval that
 * cannot be inspected is retrieval nobody can debug — when an attempt fails
 * for want of a file, the first question is "was it ranked and dropped, was
 * it excluded by policy, or was it never a candidate?", and only a durable
 * plan can answer that.
 *
 * What the plan deliberately does NOT carry is content. It stores paths,
 * content hashes, ranges, reasons, and estimates; the bytes are read fresh
 * at materialization time and verified against those hashes. Persisting the
 * bodies would create a second copy of the repository that goes stale — the
 * exact failure this phase exists to prevent — and would put source into a
 * diagnostic record that is meant to be safe to display.
 */

export const CONTEXT_SELECTION_PLAN_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().min(1).max(CONTEXT_LIMITS.maxShortTextChars);

export const selectedContextItemSchema = z
  .object({
    /** Workspace-relative path, forward slashes. */
    path: shortText,
    /** Content hash the selection was made against. Verified before use. */
    contentHash: shortText,
    reason: z.enum(CONTEXT_SELECTION_REASONS),
    /** Deterministic ranking score; reproducible from the same inputs. */
    score: z.number().int(),
    /** True when policy forbids dropping this item. */
    mandatory: z.boolean().default(false),
    /** 1-based inclusive range when a section rather than the whole file. */
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    symbol: shortText.optional(),
    estimatedTokens: z.number().int().min(0),
    /** Bounded, safe detail behind the reason (a path, a symbol, a count). */
    detail: shortText.optional(),
  })
  .passthrough();
export type SelectedContextItem = z.infer<typeof selectedContextItemSchema>;

/**
 * A high-value POINTER: a repository location the worker is told about and
 * expected to read itself.
 *
 * The whole economics of the harness lane live in this shape. A pointer
 * costs a line; the file it names can cost thousands of tokens, and a
 * tool-capable worker can fetch it in one call at the moment it actually
 * needs it — with content that is current by construction rather than
 * current as of assembly.
 */
export const contextPointerSchema = z
  .object({
    path: shortText,
    reason: z.enum(CONTEXT_SELECTION_REASONS),
    /**
     * True when durable state NAMED this path — the contract, the failure,
     * or the current action. A tool-capable worker is told to read it first;
     * it is not materialized, because the worker can fetch current bytes
     * itself and a copy in the prompt would only be current as of assembly.
     */
    mandatory: z.boolean().default(false),
    /** Declared symbols worth knowing about before opening the file. */
    symbols: z.array(shortText).max(12).default([]),
    /** Size hint so the worker can budget its own read. */
    sizeBytes: z.number().int().min(0),
    contentHash: shortText,
    detail: shortText.optional(),
  })
  .passthrough();
export type ContextPointer = z.infer<typeof contextPointerSchema>;

export const excludedCandidateSchema = z
  .object({
    path: shortText,
    reason: z.enum(CONTEXT_EXCLUSION_REASONS),
    score: z.number().int(),
    detail: shortText.optional(),
  })
  .passthrough();
export type ExcludedCandidate = z.infer<typeof excludedCandidateSchema>;

export const contextSelectionPlanSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    planId: shortText,
    jobId: shortText.optional(),
    taskId: shortText,
    nodeId: shortText.optional(),
    attemptId: shortText.optional(),
    strategy: z.enum(CONTEXT_STRATEGIES),
    shape: z.enum(CONTEXT_SHAPES),
    role: z.enum(RETRIEVAL_ROLES),
    expansionLevel: z.enum(CONTEXT_EXPANSION_LEVELS),
    /** Economic lane the package is being built for, when one is assigned. */
    executionLane: shortText.nullable().default(null),
    /** LOCAL execution mode (DIRECT_MODEL / HARNESS), when one applies. */
    executionMode: shortText.nullable().default(null),
    /** Runner/profile identity, for per-runner analysis. */
    runner: shortText.nullable().default(null),
    /** Item ids of the deterministic pinned layer. */
    pinnedItemIds: z.array(shortText).max(200).default([]),
    /** Item ids of the deterministic durable layer. */
    durableItemIds: z.array(shortText).max(200).default([]),
    /** Repository artifacts materialized into the working set. */
    selectedWorkingItems: z.array(selectedContextItemSchema).max(200).default([]),
    /** Repository artifacts named but NOT materialized (harness shapes). */
    pointers: z.array(contextPointerSchema).max(200).default([]),
    /** Item ids carried in the recent-delta layer. */
    recentDeltaItemIds: z.array(shortText).max(200).default([]),
    /** Ranked candidates that did not make it, with their reasons. */
    excludedCandidates: z.array(excludedCandidateSchema).max(200).default([]),
    /** The complete deterministic candidate order, for audit and replay. */
    deterministicOrder: z.array(shortText).max(400).default([]),
    /** True when an advisory local rerank changed the order. */
    localRerankApplied: z.boolean().default(false),
    estimatedTokens: z
      .object({
        pinned: z.number().int().min(0).default(0),
        durable: z.number().int().min(0).default(0),
        compactedHistory: z.number().int().min(0).default(0),
        workingSet: z.number().int().min(0).default(0),
        recentDelta: z.number().int().min(0).default(0),
        currentAction: z.number().int().min(0).default(0),
        total: z.number().int().min(0).default(0),
      })
      .passthrough(),
    budget: z
      .object({
        usableInputTokens: z.number().int().min(0),
        workingSetBudget: z.number().int().min(0),
        pinnedReserve: z.number().int().min(0),
        durableReserve: z.number().int().min(0),
        recoveryReserve: z.number().int().min(0),
        deltaReserve: z.number().int().min(0),
        maxSingleItemTokens: z.number().int().min(0),
      })
      .passthrough(),
    /** Stable identities of the reusable prompt components (observability). */
    componentHashes: z.record(z.string().nullable()).default({}),
    createdAt: shortText,
  })
  .passthrough();
export type ContextSelectionPlan = z.infer<typeof contextSelectionPlanSchema>;

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectWorkingSetInput {
  index: RepositoryContextIndex;
  rootDir: string;
  candidates: readonly RankedCandidate[];
  query: ContextRetrievalQuery;
  shape: ContextShape;
  allocation: ContextBudgetAllocation;
  expansionLevel: ContextExpansionLevel;
  /** Ceiling on materialized items (pointers have their own, larger, bound). */
  maxSelectedItems?: number | undefined;
  maxPointers?: number | undefined;
  sectionOptions?: SectionOptions | undefined;
  createdAt: string;
}

export interface SelectWorkingSetResult {
  selected: SelectedContextItem[];
  pointers: ContextPointer[];
  excluded: ExcludedCandidate[];
  /** WORKING_SET items ready for assembly, with provenance attached. */
  items: ContextItem[];
  /** Paths whose indexed hash no longer matched the file on disk. */
  refreshedPaths: string[];
  workingSetTokens: number;
}

function truncate(value: string, max = CONTEXT_LIMITS.maxShortTextChars): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Turn ranked candidates into the working set for one dispatch.
 *
 * Three things happen here, in this order, and the order is the policy:
 *
 *   1. FRESHNESS. Every candidate is re-read and hash-checked before its
 *      bytes go anywhere. A stale entry is either refreshed from the current
 *      file or excluded — an old body is never shipped under a claim that it
 *      is what the repository says now.
 *   2. SHAPE. A POINTER-shaped package materializes only what a tool-capable
 *      worker genuinely cannot fetch cheaply — the mandatory references —
 *      and names the rest. A MATERIALIZED package carries the bounded
 *      working set, because its worker has no way to fetch anything.
 *   3. BUDGET. Mandatory references are placed first and unconditionally;
 *      the remainder fill the allocated working-set budget in rank order,
 *      and everything past it is recorded as excluded with its reason.
 */
export function selectWorkingSet(input: SelectWorkingSetInput): SelectWorkingSetResult {
  const maxSelected = input.maxSelectedItems ?? 12;
  const maxPointers = input.maxPointers ?? 24;
  const depthLimit = CONTEXT_EXPANSION_LEVEL_DEPTH[input.expansionLevel];

  const selected: SelectedContextItem[] = [];
  const pointers: ContextPointer[] = [];
  const excluded: ExcludedCandidate[] = [];
  const items: ContextItem[] = [];
  const refreshedPaths: string[] = [];
  let spent = 0;

  const symbolHints = input.query.symbols;
  const lineHints = lineReferencesFor(input.query);

  for (const candidate of input.candidates) {
    // Expansion gating: a candidate that only becomes eligible at a deeper
    // level waits for the evidence that justifies going there.
    if (!candidate.mandatory && candidate.eligibleAtDepth > depthLimit) {
      excluded.push({
        path: candidate.path,
        reason: 'RANKED_BELOW_CUTOFF',
        score: candidate.score,
        detail: truncate(`eligible at expansion level ${candidate.eligibleAtDepth}`),
      });
      continue;
    }

    const resolved = resolveFresh(input.rootDir, candidate.entry, { withContent: true });
    if (resolved.status === 'missing') {
      excluded.push({
        path: candidate.path,
        reason: 'STALE_INDEX_ENTRY',
        score: candidate.score,
        detail: 'file no longer exists',
      });
      continue;
    }
    if (resolved.status === 'stale') {
      // The index is behind. The CURRENT bytes are what we use; the stale
      // entry is recorded so the caller can refresh the index afterwards.
      refreshedPaths.push(candidate.path);
    }
    const content = resolved.content;
    const currentHash = resolved.currentHash;
    if (content === undefined || currentHash === null) {
      excluded.push({
        path: candidate.path,
        reason: 'TOO_LARGE',
        score: candidate.score,
        detail: 'file exceeds the readable size bound',
      });
      continue;
    }

    // A POINTER-shaped package NAMES everything and materializes nothing.
    //
    // Including the mandatory references. That is the whole economics of the
    // harness lane: the worker can read the file, and the bytes it reads are
    // current by construction, while anything quoted here is only current as
    // of assembly. Mandatory status governs SELECTION — the reference must
    // reach the worker and cannot be ranked away — and the shape governs
    // MATERIALIZATION. A mandatory pointer is placed first and is never
    // dropped by the pointer bound.
    if (input.shape === 'POINTER') {
      if (candidate.mandatory || pointers.length < maxPointers) {
        const pointer = {
          path: candidate.path,
          reason: candidate.primaryReason,
          mandatory: candidate.mandatory,
          symbols: candidate.entry.symbols.slice(0, 12),
          sizeBytes: candidate.entry.sizeBytes,
          contentHash: currentHash,
          detail: truncate(candidate.signals[0]?.detail ?? ''),
        };
        if (candidate.mandatory) pointers.unshift(pointer);
        else pointers.push(pointer);
        excluded.push({
          path: candidate.path,
          reason: 'HARNESS_READS_REPOSITORY',
          score: candidate.score,
          detail: 'named as a pointer; the worker reads current bytes itself',
        });
      } else {
        excluded.push({ path: candidate.path, reason: 'RANKED_BELOW_CUTOFF', score: candidate.score });
      }
      continue;
    }

    if (selected.length >= maxSelected) {
      excluded.push({ path: candidate.path, reason: 'RANKED_BELOW_CUTOFF', score: candidate.score });
      continue;
    }

    const section = extractSection({
      content,
      symbols: symbolHints,
      lines: lineHints.get(candidate.path) ?? [],
      options: input.sectionOptions,
    });
    const tokens = estimateTokens(section.content) + estimateTokens(candidate.path) + 8;

    if (!candidate.mandatory && tokens > input.allocation.maxSingleItemTokens) {
      // Too large to justify against one candidate's evidence — but the
      // worker still gets to know it exists.
      if (pointers.length < maxPointers) {
        pointers.push({
          path: candidate.path,
          reason: candidate.primaryReason,
          mandatory: false,
          symbols: candidate.entry.symbols.slice(0, 12),
          sizeBytes: candidate.entry.sizeBytes,
          contentHash: currentHash,
        });
      }
      excluded.push({
        path: candidate.path,
        reason: 'TOO_LARGE',
        score: candidate.score,
        detail: truncate(`${tokens} tokens exceeds the ${input.allocation.maxSingleItemTokens}-token per-item ceiling`),
      });
      continue;
    }
    if (!candidate.mandatory && spent + tokens > input.allocation.workingSetBudget) {
      if (pointers.length < maxPointers) {
        pointers.push({
          path: candidate.path,
          reason: candidate.primaryReason,
          mandatory: false,
          symbols: candidate.entry.symbols.slice(0, 12),
          sizeBytes: candidate.entry.sizeBytes,
          contentHash: currentHash,
        });
      }
      excluded.push({
        path: candidate.path,
        reason: 'BUDGET_EXHAUSTED',
        score: candidate.score,
        detail: truncate(`${spent}/${input.allocation.workingSetBudget} working-set tokens already allocated`),
      });
      continue;
    }

    selected.push({
      path: candidate.path,
      contentHash: currentHash,
      reason: candidate.primaryReason,
      score: candidate.score,
      mandatory: candidate.mandatory,
      ...(section.startLine !== undefined ? { startLine: section.startLine } : {}),
      ...(section.endLine !== undefined ? { endLine: section.endLine } : {}),
      ...(section.symbol !== undefined ? { symbol: truncate(section.symbol) } : {}),
      estimatedTokens: tokens,
      ...(candidate.signals[0]?.detail !== undefined
        ? { detail: truncate(candidate.signals[0].detail) }
        : {}),
    });
    items.push({
      itemId: `working-${hashPath(candidate.path)}`,
      layer: 'WORKING_SET',
      kind: section.sectioned ? 'file-section' : 'file-excerpt',
      title: section.sectioned
        ? `${candidate.path} (lines ${section.startLine}-${section.endLine}${section.symbol !== undefined ? `, ${section.symbol}` : ''})`
        : candidate.path,
      content: section.content,
      createdAt: input.createdAt,
      source: candidate.path,
      dedupeKey: `repo:${candidate.path}`,
      compacted: false,
      freshness: defaultFreshnessFor('repository-file'),
      authority: 'TRUSTED',
      selectionReason: candidate.primaryReason,
      provenance: {
        kind: section.sectioned ? 'repository-section' : 'repository-file',
        path: candidate.path,
        contentHash: currentHash,
        ...(section.startLine !== undefined ? { startLine: section.startLine } : {}),
        ...(section.endLine !== undefined ? { endLine: section.endLine } : {}),
        ...(section.symbol !== undefined ? { symbol: truncate(section.symbol) } : {}),
        artifactRefs: [],
        sourceHashes: [],
      },
    });
    spent += tokens;
  }

  return { selected, pointers, excluded, items, refreshedPaths, workingSetTokens: spent };
}

/** Line citations the query carries, grouped by path (stack frames, tsc). */
function lineReferencesFor(query: ContextRetrievalQuery): Map<string, number[]> {
  return new Map(Object.entries(query.lineHints ?? {}));
}

function hashPath(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }
  return `${value.split('/').pop() ?? 'file'}-${(hash >>> 0).toString(36)}`;
}

/**
 * Render pointers as ONE bounded context item.
 *
 * One item rather than many, deliberately: a list of twenty pointers is one
 * fact ("here is where to look"), and splitting it into twenty items would
 * make it twenty candidates for independent dropping under budget pressure.
 */
export function pointerItem(
  pointers: readonly ContextPointer[],
  createdAt: string,
): ContextItem | undefined {
  if (pointers.length === 0) return undefined;
  const lines = [
    'These repository locations are the highest-value starting points for this task.',
    'Read them with your own tools — the bytes on disk are current; anything quoted in this prompt is only current as of assembly.',
    '',
    ...pointers.map((pointer) => {
      const symbols = pointer.symbols.length > 0 ? ` — declares ${pointer.symbols.slice(0, 6).join(', ')}` : '';
      const named = pointer.mandatory ? ' [named by durable task state — read this first]' : '';
      return `- ${pointer.path} (${pointer.sizeBytes} bytes, selected because ${pointer.reason})${named}${symbols}`;
    }),
  ];
  return {
    itemId: 'working-repository-pointers',
    layer: 'WORKING_SET',
    kind: 'repository-pointers',
    title: `Recommended starting locations (${pointers.length})`,
    content: lines.join('\n'),
    createdAt,
    source: 'context-selection',
    compacted: false,
    freshness: 'STALE_IF_REPO_CHANGES',
    authority: 'DERIVED',
    provenance: {
      kind: 'repository-pointer',
      artifactRefs: [],
      sourceHashes: pointers.map((pointer) => pointer.contentHash).slice(0, 20),
    },
  };
}
