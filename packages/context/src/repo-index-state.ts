import { z } from 'zod';
import { CONTEXT_LIMITS } from './items.js';

/**
 * The RepositoryContextIndex: a derived, rebuildable map of what the
 * workspace contains, so retrieval can answer one question cheaply —
 *
 *   which repository artifacts are likely relevant to this Task right now?
 *
 * Three properties define what this is and, more importantly, what it is
 * NOT:
 *
 *   DERIVED       it is computed from the repository plus canonical
 *                 SpecBridge state, and it is never either of them. Deleting
 *                 it loses nothing; corrupting it is answered by rebuilding,
 *                 never by trusting it.
 *   BOUNDED       it stores metadata — paths, hashes, sizes, declared
 *                 symbols, import specifiers — and never file bodies. An
 *                 index that cached content would become a second, stale
 *                 copy of the repository, which is the exact failure mode
 *                 §8 exists to prevent.
 *   OFFLINE       no network, no hosted service, no vector database, no
 *                 embedding model. Everything here is a deterministic
 *                 function of bytes on disk.
 *
 * It is deliberately NOT a code-intelligence platform. Symbol and import
 * extraction is conservative and pattern-based; where a language's structure
 * cannot be read safely, the entry simply carries fewer signals and ranking
 * falls back to path and token evidence. Under-claiming here is correct:
 * a wrong symbol edge silently mis-ranks retrieval, and no test would catch
 * it.
 */

export const REPOSITORY_INDEX_SCHEMA_VERSION = '1.0.0';

/**
 * Format version of the DERIVED index payload.
 *
 * Distinct from `schemaVersion`, which is the persisted-record contract.
 * This one changes whenever the extraction logic changes in a way that makes
 * old entries incomparable — a new symbol rule, a different tokenizer. A
 * mismatch triggers a REBUILD rather than a migration: migrating a
 * disposable cache is work with no payoff, and the rebuild is the same code
 * path that already has to be correct.
 */
export const REPOSITORY_INDEX_FORMAT_VERSION = 1;

export const REPOSITORY_INDEX_LIMITS = {
  /** Ceiling on indexed files. Beyond it the index records truncation. */
  maxEntries: 40_000,
  /** Files larger than this are recorded as skipped, never read. */
  maxFileBytes: 524_288,
  maxSymbolsPerEntry: 60,
  maxImportsPerEntry: 60,
  maxTokensPerEntry: 24,
  maxSkippedRecorded: 200,
  maxPathChars: 512,
} as const;

const pathText = z.string().min(1).max(REPOSITORY_INDEX_LIMITS.maxPathChars);
const shortText = z.string().min(1).max(CONTEXT_LIMITS.maxShortTextChars);

/**
 * Coarse role of a file. Deliberately coarse: ranking needs "is this a test
 * for that source" and "is this build noise", not a taxonomy.
 */
export const REPOSITORY_FILE_KINDS = ['source', 'test', 'config', 'doc', 'data', 'other'] as const;
export type RepositoryFileKind = (typeof REPOSITORY_FILE_KINDS)[number];

/** Why a path present in the workspace is absent from the index. */
export const REPOSITORY_SKIP_REASONS = [
  'ignored-directory',
  'gitignored',
  'binary',
  'too-large',
  'protected-path',
  'credential-shaped',
  'unreadable',
  'entry-limit',
] as const;
export type RepositorySkipReason = (typeof REPOSITORY_SKIP_REASONS)[number];

/**
 * One indexed repository artifact.
 *
 * `contentHash` is the freshness mechanism, not `mtimeMs`. The stat fields
 * are recorded for diagnostics and for cheap change detection, but a
 * decision that content is current is ALWAYS a hash comparison: a restored
 * backup, a checkout, or a clock skew can all produce a plausible timestamp
 * over different bytes, and shipping an old file body while claiming it is
 * current is the most damaging thing a context layer can do.
 */
export const repositoryIndexEntrySchema = z
  .object({
    /** Workspace-relative path, forward slashes. */
    path: pathText,
    kind: z.enum(REPOSITORY_FILE_KINDS),
    /** Coarse language tag derived from the extension ('ts', 'py', 'md', …). */
    language: shortText,
    /** Owning module/package directory, workspace-relative ('' at the root). */
    module: z.string().max(REPOSITORY_INDEX_LIMITS.maxPathChars),
    sizeBytes: z.number().int().min(0),
    lineCount: z.number().int().min(0),
    /** SHA-256 of the exact file bytes. THE freshness mechanism. */
    contentHash: shortText,
    /** Last-modified epoch millis. Diagnostics and fast change detection only. */
    mtimeMs: z.number().min(0),
    /** Declared/exported symbols, conservatively extracted. May be empty. */
    symbols: z.array(shortText).max(REPOSITORY_INDEX_LIMITS.maxSymbolsPerEntry).default([]),
    /** Raw import specifiers as written. May be empty. */
    imports: z.array(shortText).max(REPOSITORY_INDEX_LIMITS.maxImportsPerEntry).default([]),
    /** Import specifiers resolved to workspace-relative paths, where resolvable. */
    importPaths: z.array(pathText).max(REPOSITORY_INDEX_LIMITS.maxImportsPerEntry).default([]),
    /** Lowercased path/filename tokens used by deterministic ranking. */
    tokens: z.array(shortText).max(REPOSITORY_INDEX_LIMITS.maxTokensPerEntry).default([]),
    /**
     * For a test file: the source paths it most likely covers. Derived from
     * naming convention and import edges, never from execution.
     */
    testTargets: z.array(pathText).max(REPOSITORY_INDEX_LIMITS.maxImportsPerEntry).default([]),
    indexedAt: shortText,
  })
  .passthrough();
export type RepositoryIndexEntry = z.infer<typeof repositoryIndexEntrySchema>;

export const repositorySkipRecordSchema = z
  .object({ path: pathText, reason: z.enum(REPOSITORY_SKIP_REASONS) })
  .passthrough();
export type RepositorySkipRecord = z.infer<typeof repositorySkipRecordSchema>;

/**
 * The persisted index.
 *
 * `workspaceKey` binds it to one workspace root: a cache found under a
 * different root is not adopted, it is rebuilt. `baselineRef` records the
 * repository state it was built against (a Git revision when one is known),
 * so a diagnostic can say what the index is a picture OF rather than merely
 * when it was taken.
 */
export const repositoryContextIndexSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Extraction-format version; a mismatch means rebuild, never migrate. */
    formatVersion: z.number().int().min(1),
    /** Stable digest of the absolute workspace root this index describes. */
    workspaceKey: shortText,
    builtAt: shortText,
    updatedAt: shortText,
    /** Repository baseline (Git HEAD) when the caller knew one. */
    baselineRef: shortText.nullable().default(null),
    entries: z.array(repositoryIndexEntrySchema).max(REPOSITORY_INDEX_LIMITS.maxEntries),
    /** Bounded sample of skipped paths, for `explain`-style diagnostics. */
    skipped: z
      .array(repositorySkipRecordSchema)
      .max(REPOSITORY_INDEX_LIMITS.maxSkippedRecorded)
      .default([]),
    /** True when the entry ceiling stopped the walk before it finished. */
    truncated: z.boolean().default(false),
    /** Counts by skip reason across the WHOLE walk, not only the sample. */
    skippedCounts: z.record(z.number().int().min(0)).default({}),
    /** Wall time of the pass that produced this state, in milliseconds. */
    buildMs: z.number().int().min(0).default(0),
  })
  .passthrough();
export type RepositoryContextIndexState = z.infer<typeof repositoryContextIndexSchema>;

/**
 * Whether a persisted index may be adopted as-is.
 *
 * Deliberately strict and deliberately cheap: any doubt resolves to REBUILD.
 * The index is derived state whose rebuild cost is bounded and whose
 * incorrect adoption cost is a wrong edit against a file that no longer
 * looks like that.
 */
export function isIndexReusable(
  state: RepositoryContextIndexState,
  expected: { workspaceKey: string },
): boolean {
  return (
    state.formatVersion === REPOSITORY_INDEX_FORMAT_VERSION &&
    state.workspaceKey === expected.workspaceKey &&
    state.schemaVersion.split('.')[0] === REPOSITORY_INDEX_SCHEMA_VERSION.split('.')[0]
  );
}
