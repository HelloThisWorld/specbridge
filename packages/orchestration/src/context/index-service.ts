import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import type { RepositoryContextIndexState } from '@specbridge/context';
import {
  RepositoryContextIndex,
  buildRepositoryIndex,
  refreshRepositoryIndex,
  workspaceKeyFor,
} from '@specbridge/context';
import type { GitSnapshot } from '@specbridge/evidence';
import {
  clearRepositoryIndexCache,
  readRepositoryIndexCache,
  writeRepositoryIndexCache,
} from './store.js';

/**
 * Workspace-bound repository indexing.
 *
 * The service exists to make one behaviour easy and one behaviour hard:
 *
 *   EASY   incremental refresh. A long-running job changes the repository
 *          constantly, and re-indexing everything before each turn would
 *          make retrieval cost more than the tokens it saves. When the Git
 *          snapshot already names the changed paths — which it does on every
 *          dispatch, because evidence capture needs it anyway — only those
 *          paths are re-read.
 *
 *   HARD   trusting a cache. Any doubt about the persisted index resolves to
 *          a rebuild: wrong format, different workspace, unreadable file,
 *          schema drift. A derived cache is worth exactly its rebuild cost,
 *          and reasoning about a partially trusted one is worth much less
 *          than that.
 *
 * The index is never canonical. Deleting the whole cache directory is a
 * supported operation with no effect on any job, and `ensureRepositoryIndex`
 * is the same code path whether the cache was present, absent, or corrupt.
 */

export interface EnsureIndexInput {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  now: string;
  /**
   * Current repository snapshot. Its dirty entries drive the incremental
   * path; without one the refresh verifies every entry by hash instead.
   */
  gitSnapshot?: GitSnapshot | undefined;
  /** Force a full rebuild regardless of what the cache says. */
  rebuild?: boolean | undefined;
  /** Skip persistence (used by read-only diagnostics). */
  persist?: boolean | undefined;
}

export interface EnsureIndexResult {
  index: RepositoryContextIndex;
  state: RepositoryContextIndexState;
  /** True when the index was built from scratch rather than refreshed. */
  rebuilt: boolean;
  refreshedPaths: string[];
  removedPaths: string[];
  addedPaths: string[];
  /** Wall time of the pass that produced this state. */
  buildMs: number;
}

function efficiencyPolicy(config: AgentConfig) {
  return config.orchestration.jobs.context.efficiency;
}

/**
 * Protected path prefixes the index must never enter.
 *
 * Reuses the EXISTING execution-policy protected paths rather than inventing
 * a second exclusion list. That reuse is the point: an operator who has
 * already declared a directory off-limits to agent writes has declared
 * something about that directory, and a retrieval layer that indexed it
 * anyway would be quietly disagreeing with a decision they already made.
 */
export function indexProtectedPaths(config: AgentConfig): string[] {
  return [...config.execution.protectedPaths];
}

/**
 * Workspace-relative paths the Git snapshot reports as changed, or undefined
 * when the snapshot cannot be trusted to have SEEN the changes.
 *
 * The undefined cases matter more than the happy one. An empty entry list
 * from a snapshot that could not observe anything — Git unavailable, not a
 * repository, a status command that failed — is not evidence that nothing
 * changed; it is an absence of evidence. Treating it as "no changed paths"
 * would run a targeted refresh that touches nothing and leave the index
 * describing a repository that has moved underneath it, which is precisely
 * the stale-content failure this phase exists to prevent.
 *
 * Returning undefined routes the caller to the untargeted refresh, which
 * verifies every entry by size and mtime and re-hashes whatever moved.
 * Slower than targeted, far cheaper than a rebuild, and correct.
 */
export function changedPathsFrom(snapshot: GitSnapshot | undefined): string[] | undefined {
  if (snapshot === undefined) return undefined;
  if (!snapshot.gitAvailable) return undefined;
  const paths = snapshot.entries.map((entry) => entry.path.replace(/\\/g, '/'));
  // A directory-shaped entry means the snapshot summarized rather than
  // enumerated: its contents are unknown, so the scope is unknown too.
  if (paths.some((entry) => entry.endsWith('/'))) return undefined;
  return paths;
}

/**
 * Build or refresh the repository index for a workspace.
 *
 * Cheap on the common path: an unchanged repository with a valid cache costs
 * one file read plus a stat per entry, and no extraction at all.
 */
export function ensureRepositoryIndex(input: EnsureIndexInput): EnsureIndexResult {
  const policy = efficiencyPolicy(input.config);
  const options = {
    rootDir: input.workspace.rootDir,
    now: input.now,
    protectedPaths: indexProtectedPaths(input.config),
    respectGitignore: policy.respectGitignore,
    maxEntries: policy.maxIndexedFiles,
    maxFileBytes: policy.maxIndexedFileBytes,
    baselineRef: input.gitSnapshot?.head ?? null,
  };

  if (input.rebuild === true) {
    const state = buildRepositoryIndex(options);
    if (input.persist !== false && policy.persistIndex) {
      writeRepositoryIndexCache(input.workspace, state);
    }
    return {
      index: new RepositoryContextIndex(state),
      state,
      rebuilt: true,
      refreshedPaths: [],
      removedPaths: [],
      addedPaths: [],
      buildMs: state.buildMs,
    };
  }

  const cached = policy.persistIndex ? readRepositoryIndexCache(input.workspace) : undefined;
  const changedPaths = changedPathsFrom(input.gitSnapshot);
  const refreshed = refreshRepositoryIndex(cached, {
    ...options,
    ...(changedPaths !== undefined ? { changedPaths } : {}),
  });

  if (input.persist !== false && policy.persistIndex) {
    writeRepositoryIndexCache(input.workspace, refreshed.state);
  }
  return {
    index: new RepositoryContextIndex(refreshed.state),
    state: refreshed.state,
    rebuilt: refreshed.rebuilt,
    refreshedPaths: refreshed.refreshedPaths,
    removedPaths: refreshed.removedPaths,
    addedPaths: refreshed.addedPaths,
    buildMs: refreshed.state.buildMs,
  };
}

/**
 * Whether a persisted index describes THIS workspace at all.
 *
 * Exposed for diagnostics: an index carried into a copied or moved workspace
 * is not wrong so much as irrelevant, and saying so is more useful than
 * silently rebuilding without explanation.
 */
export function indexBelongsToWorkspace(
  workspace: WorkspaceInfo,
  state: RepositoryContextIndexState,
): boolean {
  return state.workspaceKey === workspaceKeyFor(workspace.rootDir);
}

/** Discard the derived index. Always safe; job state is untouched. */
export function invalidateRepositoryIndex(workspace: WorkspaceInfo): void {
  clearRepositoryIndexCache(workspace);
}
