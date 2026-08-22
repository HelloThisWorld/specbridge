import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  RepositoryContextIndexState,
  RepositoryIndexEntry,
  RepositorySkipRecord,
} from './repo-index-state.js';
import {
  REPOSITORY_INDEX_FORMAT_VERSION,
  REPOSITORY_INDEX_LIMITS,
  REPOSITORY_INDEX_SCHEMA_VERSION,
  isIndexReusable,
  repositoryContextIndexSchema,
} from './repo-index-state.js';
import type { ScanOptions } from './repo-index-scan.js';
import {
  buildEntry,
  isBinaryPath,
  isCredentialShapedPath,
  linkEntries,
  scanWorkspace,
} from './repo-index-scan.js';

/**
 * RepositoryContextIndex: build, refresh, verify, query.
 *
 * The lifecycle this file implements, stated once:
 *
 *   repository baseline → index → file changes → invalidate affected
 *   entries → incrementally refresh
 *
 * Two rules give the index its safety properties, and both are enforced
 * here rather than left to callers:
 *
 *   1. Freshness is decided by CONTENT HASH, never by a timestamp. A stat is
 *      used only to find CANDIDATES for re-hashing cheaply; whether an entry
 *      is current is always a hash comparison against the bytes on disk.
 *
 *   2. A stale entry is never returned as current. `resolveFresh` re-reads
 *      the file and reports the mismatch, so an old body can never be shipped
 *      under a claim that it is what the repository says now.
 *
 * The index is disposable. Every operation here is safe to run against a
 * missing, empty, or corrupt cache: the answer is always "rebuild", and job
 * state is never involved.
 */

export interface BuildIndexOptions extends Omit<ScanOptions, 'indexedAt'> {
  /** ISO timestamp for the produced state. */
  now: string;
  /** Repository baseline (Git revision) when the caller knows one. */
  baselineRef?: string | null | undefined;
  /** Wall-clock source, injectable so performance records stay testable. */
  elapsedMs?: (() => number) | undefined;
}

/** Stable digest binding an index to one absolute workspace root. */
export function workspaceKeyFor(rootDir: string): string {
  return createHash('sha256').update(path.resolve(rootDir)).digest('hex').slice(0, 32);
}

/** Full build: walk the workspace, extract signals, resolve edges. */
export function buildRepositoryIndex(options: BuildIndexOptions): RepositoryContextIndexState {
  const startedAt = Date.now();
  const scan = scanWorkspace({ ...options, indexedAt: options.now });
  const entries = linkEntries(scan.entries);
  return repositoryContextIndexSchema.parse({
    schemaVersion: REPOSITORY_INDEX_SCHEMA_VERSION,
    formatVersion: REPOSITORY_INDEX_FORMAT_VERSION,
    workspaceKey: workspaceKeyFor(options.rootDir),
    builtAt: options.now,
    updatedAt: options.now,
    baselineRef: options.baselineRef ?? null,
    entries,
    skipped: scan.skipped satisfies RepositorySkipRecord[],
    truncated: scan.truncated,
    skippedCounts: scan.skippedCounts,
    buildMs: options.elapsedMs?.() ?? Math.max(0, Date.now() - startedAt),
  });
}

export interface RefreshIndexOptions extends BuildIndexOptions {
  /**
   * Paths the caller already knows changed (from `git status`, from an
   * attempt's changed-file record). When supplied, only these are re-read
   * and the rest of the index is carried forward — the incremental path a
   * long-running job takes between turns.
   *
   * When omitted, every entry is re-verified by hash. That is the honest
   * fallback for "we do not know what changed", and it is still far cheaper
   * than a rebuild because extraction only runs for entries that moved.
   */
  changedPaths?: readonly string[] | undefined;
  /** Paths known to be deleted (skips the stat that would fail anyway). */
  deletedPaths?: readonly string[] | undefined;
}

export interface RefreshResult {
  state: RepositoryContextIndexState;
  /** Entries re-read because their bytes changed. */
  refreshedPaths: string[];
  /** Entries dropped because the file is gone or newly excluded. */
  removedPaths: string[];
  /** Paths added to the index by this refresh. */
  addedPaths: string[];
  /** True when the refresh fell back to a full rebuild. */
  rebuilt: boolean;
}

/**
 * Incrementally refresh an index.
 *
 * Falls back to a full rebuild when the cache cannot be trusted — a format
 * mismatch, a different workspace, a truncated previous walk. Rebuilding a
 * derived cache is cheap; reasoning about a half-trusted one is not.
 */
export function refreshRepositoryIndex(
  previous: RepositoryContextIndexState | undefined,
  options: RefreshIndexOptions,
): RefreshResult {
  const workspaceKey = workspaceKeyFor(options.rootDir);
  if (previous === undefined || !isIndexReusable(previous, { workspaceKey })) {
    return {
      state: buildRepositoryIndex(options),
      refreshedPaths: [],
      removedPaths: [],
      addedPaths: [],
      rebuilt: true,
    };
  }

  const startedAt = Date.now();
  const byPath = new Map(previous.entries.map((entry) => [entry.path, entry]));
  const refreshedPaths: string[] = [];
  const removedPaths: string[] = [];
  const addedPaths: string[] = [];

  for (const deleted of options.deletedPaths ?? []) {
    if (byPath.delete(normalize(deleted))) removedPaths.push(normalize(deleted));
  }

  if (options.changedPaths !== undefined) {
    // Targeted refresh: only the paths the caller named are touched. Every
    // other entry keeps its previously verified hash, which is exactly the
    // property that keeps a per-turn refresh from costing a full scan.
    for (const raw of options.changedPaths) {
      const relativePath = normalize(raw);
      if (relativePath === '' || relativePath.startsWith('..')) continue;
      if (isCredentialShapedPath(relativePath) || isBinaryPath(relativePath)) {
        if (byPath.delete(relativePath)) removedPaths.push(relativePath);
        continue;
      }
      const existing = byPath.get(relativePath);
      const rebuiltEntry = safeBuildEntry(options.rootDir, relativePath, options.now, options.maxFileBytes);
      if (rebuiltEntry === undefined) {
        if (byPath.delete(relativePath)) removedPaths.push(relativePath);
        continue;
      }
      if (existing === undefined) {
        if (byPath.size >= (options.maxEntries ?? REPOSITORY_INDEX_LIMITS.maxEntries)) continue;
        byPath.set(relativePath, rebuiltEntry);
        addedPaths.push(relativePath);
        continue;
      }
      if (existing.contentHash !== rebuiltEntry.contentHash) {
        byPath.set(relativePath, rebuiltEntry);
        refreshedPaths.push(relativePath);
      } else {
        // Same bytes: keep the entry, but record that we looked. The stat
        // may legitimately have moved (a touch, a checkout of identical
        // content) without the content having changed at all.
        byPath.set(relativePath, { ...existing, mtimeMs: rebuiltEntry.mtimeMs });
      }
    }
  } else {
    // Untargeted refresh: verify every entry by hash, cheaply skipping the
    // re-read where size AND mtime both still match. The skip is a
    // PERFORMANCE shortcut over an entry we already hashed once — never a
    // claim of freshness on its own, which is why a mismatch on either
    // field forces the re-read rather than a heuristic.
    for (const entry of previous.entries) {
      const absolute = path.join(options.rootDir, entry.path);
      let size: number;
      let mtimeMs: number;
      try {
        const stat = statSync(absolute);
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        byPath.delete(entry.path);
        removedPaths.push(entry.path);
        continue;
      }
      if (size === entry.sizeBytes && mtimeMs === entry.mtimeMs) continue;
      const rebuiltEntry = safeBuildEntry(options.rootDir, entry.path, options.now, options.maxFileBytes);
      if (rebuiltEntry === undefined) {
        byPath.delete(entry.path);
        removedPaths.push(entry.path);
        continue;
      }
      byPath.set(entry.path, rebuiltEntry);
      if (rebuiltEntry.contentHash !== entry.contentHash) refreshedPaths.push(entry.path);
    }
  }

  const relinked =
    refreshedPaths.length + removedPaths.length + addedPaths.length > 0
      ? linkEntries([...byPath.values()])
      : [...byPath.values()];
  const ordered = [...relinked].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  return {
    state: repositoryContextIndexSchema.parse({
      ...previous,
      updatedAt: options.now,
      baselineRef: options.baselineRef ?? previous.baselineRef,
      entries: ordered,
      buildMs: options.elapsedMs?.() ?? Math.max(0, Date.now() - startedAt),
    }),
    refreshedPaths,
    removedPaths,
    addedPaths,
    rebuilt: false,
  };
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeBuildEntry(
  rootDir: string,
  relativePath: string,
  now: string,
  maxFileBytes: number | undefined,
): RepositoryIndexEntry | undefined {
  const limit = maxFileBytes ?? REPOSITORY_INDEX_LIMITS.maxFileBytes;
  try {
    if (statSync(path.join(rootDir, relativePath)).size > limit) return undefined;
  } catch {
    return undefined;
  }
  return buildEntry(rootDir, relativePath, now);
}

// ---------------------------------------------------------------------------
// Freshness at the point of use
// ---------------------------------------------------------------------------

export type EntryFreshnessStatus = 'current' | 'stale' | 'missing';

export interface ResolvedEntry {
  entry: RepositoryIndexEntry;
  status: EntryFreshnessStatus;
  /** The CURRENT content hash on disk; null when the file is gone. */
  currentHash: string | null;
  /** The current bytes, when the caller asked for content and it was read. */
  content?: string | undefined;
}

/**
 * Read one indexed path and decide whether the index still describes it.
 *
 * This is the guarantee behind §8, and it deliberately runs against the FILE
 * rather than against the index: an entry is "current" only when the bytes
 * on disk hash to what was recorded. When they do not, the caller receives
 * `stale` plus the CURRENT content — never the indexed metadata dressed up
 * as present-day truth.
 *
 * Bounded by construction: this runs for the handful of SELECTED items, not
 * for the repository. Retrieval ranking never reads a file body.
 */
export function resolveFresh(
  rootDir: string,
  entry: RepositoryIndexEntry,
  options: { withContent?: boolean | undefined; maxBytes?: number | undefined } = {},
): ResolvedEntry {
  const absolute = path.join(rootDir, entry.path);
  let bytes: Buffer;
  try {
    if (statSync(absolute).size > (options.maxBytes ?? REPOSITORY_INDEX_LIMITS.maxFileBytes)) {
      return { entry, status: 'stale', currentHash: null };
    }
    bytes = readFileSync(absolute);
  } catch {
    return { entry, status: 'missing', currentHash: null };
  }
  const currentHash = createHash('sha256').update(bytes).digest('hex');
  const status: EntryFreshnessStatus = currentHash === entry.contentHash ? 'current' : 'stale';
  return {
    entry,
    status,
    currentHash,
    ...(options.withContent === true ? { content: bytes.toString('utf8') } : {}),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Lookup helpers over an index state. Pure, allocation-light, no I/O. */
export class RepositoryContextIndex {
  private readonly byPath: Map<string, RepositoryIndexEntry>;
  private readonly importersOf: Map<string, string[]>;
  private readonly bySymbol: Map<string, string[]>;
  private readonly byBasename: Map<string, string[]>;
  private readonly testsBySource: Map<string, string[]>;
  private readonly byModule: Map<string, string[]>;

  /**
   * Every lookup this class offers is O(1) after construction.
   *
   * That is a hard requirement rather than an optimization: ranking runs on
   * EVERY dispatch of a long-horizon job, and a single linear scan hidden
   * behind one of these accessors turns proximity expansion — which calls
   * several of them per anchor — into an O(anchors x files) pass that is
   * measurably slow on a real repository. The reverse maps are built once,
   * here, from the same entries the forward maps use.
   */
  constructor(readonly state: RepositoryContextIndexState) {
    this.byPath = new Map(state.entries.map((entry) => [entry.path, entry]));
    this.importersOf = new Map();
    this.bySymbol = new Map();
    this.byBasename = new Map();
    this.testsBySource = new Map();
    this.byModule = new Map();
    for (const entry of state.entries) {
      for (const target of entry.importPaths) {
        push(this.importersOf, target, entry.path);
      }
      for (const symbol of entry.symbols) {
        push(this.bySymbol, symbol.toLowerCase(), entry.path);
      }
      push(this.byBasename, basename(entry.path).toLowerCase(), entry.path);
      push(this.byModule, entry.module, entry.path);
      if (entry.kind === 'test') {
        for (const target of entry.testTargets) push(this.testsBySource, target, entry.path);
      }
    }
  }

  get entries(): readonly RepositoryIndexEntry[] {
    return this.state.entries;
  }

  get size(): number {
    return this.state.entries.length;
  }

  get(relativePath: string): RepositoryIndexEntry | undefined {
    return this.byPath.get(normalize(relativePath));
  }

  has(relativePath: string): boolean {
    return this.byPath.has(normalize(relativePath));
  }

  /** Files this file imports (repository-internal edges only). */
  dependenciesOf(relativePath: string): string[] {
    return [...(this.get(relativePath)?.importPaths ?? [])];
  }

  /** Files that import this file. */
  dependentsOf(relativePath: string): string[] {
    return [...(this.importersOf.get(normalize(relativePath)) ?? [])];
  }

  /** Files declaring a symbol with this exact name (case-insensitive). */
  declaring(symbol: string): string[] {
    return [...(this.bySymbol.get(symbol.toLowerCase()) ?? [])];
  }

  /** Files whose basename matches exactly (case-insensitive). */
  namedExactly(fileName: string): string[] {
    return [...(this.byBasename.get(fileName.toLowerCase()) ?? [])];
  }

  /** Tests that most likely cover this source file. */
  testsFor(relativePath: string): string[] {
    return [...(this.testsBySource.get(normalize(relativePath)) ?? [])];
  }

  /** Source files a test file most likely covers. */
  sourcesFor(relativePath: string): string[] {
    return [...(this.get(relativePath)?.testTargets ?? [])];
  }

  /** Entries in the same module/package directory. */
  siblingsIn(module: string): string[] {
    return [...(this.byModule.get(module) ?? [])];
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else if (!bucket.includes(value)) bucket.push(value);
}

function basename(relativePath: string): string {
  const at = relativePath.lastIndexOf('/');
  return at === -1 ? relativePath : relativePath.slice(at + 1);
}
