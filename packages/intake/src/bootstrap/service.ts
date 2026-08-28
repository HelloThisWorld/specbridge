import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, sha256Hex, writeFileAtomic } from '@specbridge/core';
import type { RepositoryContextIndex } from '@specbridge/context';
import {
  buildRetrievalQuery,
  extractSection,
  rankCandidates,
  workspaceKeyFor,
} from '@specbridge/context';
import { ensureRepositoryIndex } from '@specbridge/orchestration';
import { IntakeError } from '../errors.js';
import type { IntakeDeps } from '../deps.js';
import { nowIso } from '../deps.js';
import type { CurrentSystemSnapshot, RepositorySnapshotIdentity } from './state.js';
import { BOOTSTRAP_SCHEMA_VERSION, currentSystemSnapshotSchema } from './state.js';
import type { ResolvedRepository } from './repositories.js';
import { repositoryOfPath, repositoryRelativePath, resolveRepositories } from './repositories.js';
import { synthesizeSystemFindings } from './synthesis.js';

/**
 * Workspace Bootstrap.
 *
 * The lifecycle the product conversation now starts from:
 *
 *   workspace opens → bootstrapWorkspace → CurrentSystemSnapshot
 *        → conversation, with bounded deeper inspection on demand
 *        → spec-draft → formal Spec Intake (unchanged, still the authority)
 *
 * Bootstrap answers "what exists now?". Formal Spec Intake keeps answering
 * "what new product truth is the human asking us to create?" and continues
 * to perform its OWN repository grounding — the double-grounding is
 * intentional: bootstrap helps the conversation, intake governs product
 * authority, and neither substitutes for the other.
 *
 * Everything here composes existing machinery: `resolveRepositories` for
 * the repo set, orchestration's `ensureRepositoryIndex` for the derived
 * index (incremental, protected-path-aware, gitignore-aware), and the
 * deterministic synthesizer for findings. Bootstrap writes exactly one
 * artifact — the snapshot under `.specbridge/bootstrap/` — and touches no
 * mission, contract, or job state whatsoever.
 */

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function bootstrapDir(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(workspace.sidecarDir, 'bootstrap'));
}

export function snapshotFile(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(bootstrapDir(workspace), 'current-system-snapshot.json'),
  );
}

/**
 * Read the persisted snapshot, or undefined when absent or unreadable.
 *
 * Corruption degrades to "no snapshot" — the caller rebuilds — never to
 * partial trust: a half-parsed picture of the system is worse than none.
 */
export function readCurrentSystemSnapshot(
  workspace: WorkspaceInfo,
): CurrentSystemSnapshot | undefined {
  const file = snapshotFile(workspace);
  if (!existsSync(file)) return undefined;
  try {
    return currentSystemSnapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

function persistSnapshot(workspace: WorkspaceInfo, snapshot: CurrentSystemSnapshot): void {
  mkdirSync(bootstrapDir(workspace), { recursive: true });
  writeFileAtomic(snapshotFile(workspace), `${JSON.stringify(snapshot, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export interface SnapshotFreshness {
  status: 'FRESH' | 'STALE' | 'ABSENT';
  reasons: string[];
}

/**
 * Whether the persisted snapshot still describes the current repositories.
 *
 * Cheap and honest: baselines are re-read and compared per repository, so
 * one repository moving marks the snapshot stale without erasing which
 * repository the other evidence belonged to. A HEAD comparison cannot see
 * uncommitted edits — `bootstrapWorkspace` additionally consults the index
 * refresh (hash-verified) for exactly that reason — so a FRESH verdict here
 * means "same committed baselines", and the one place that REUSES a
 * snapshot demands the stronger check too.
 */
export function assessSnapshotFreshness(
  workspace: WorkspaceInfo,
  snapshot: CurrentSystemSnapshot | undefined,
): SnapshotFreshness {
  if (snapshot === undefined) return { status: 'ABSENT', reasons: ['no snapshot exists'] };
  const reasons: string[] = [];
  if (snapshot.workspaceKey !== workspaceKeyFor(workspace.rootDir)) {
    reasons.push('the snapshot describes a different workspace root');
  }
  if (snapshot.schemaVersion.split('.')[0] !== BOOTSTRAP_SCHEMA_VERSION.split('.')[0]) {
    reasons.push('the snapshot schema is from an incompatible version');
  }
  let resolution;
  try {
    resolution = resolveRepositories(workspace);
  } catch (cause) {
    return {
      status: 'STALE',
      reasons: [
        `the repository set can no longer be resolved: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    };
  }
  const current = new Map(resolution.repositories.map((repo) => [repo.repositoryId, repo]));
  for (const recorded of snapshot.repositories) {
    const live = current.get(recorded.repositoryId);
    if (live === undefined) {
      reasons.push(`repository "${recorded.repositoryId}" is no longer part of the workspace`);
      continue;
    }
    if ((live.gitHead ?? null) !== (recorded.gitHead ?? null)) {
      reasons.push(`repository "${recorded.repositoryId}" moved from ${recorded.gitHead ?? 'no-git'} to ${live.gitHead ?? 'no-git'}`);
    }
  }
  for (const live of resolution.repositories) {
    if (!snapshot.repositories.some((recorded) => recorded.repositoryId === live.repositoryId)) {
      reasons.push(`repository "${live.repositoryId}" was added after the snapshot`);
    }
  }
  return reasons.length === 0 ? { status: 'FRESH', reasons: [] } : { status: 'STALE', reasons };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  /** Force index rebuild and snapshot regeneration. */
  rebuild?: boolean | undefined;
}

export interface BootstrapResult {
  snapshot: CurrentSystemSnapshot;
  /** True when a valid existing snapshot was reused without regeneration. */
  reused: boolean;
  /** True when the repository index was rebuilt from scratch. */
  indexRebuilt: boolean;
  /** Paths the incremental index refresh re-read (changed on disk). */
  refreshedPaths: number;
}

/**
 * Build — or cheaply revalidate — the CurrentSystemSnapshot.
 *
 *   1. resolve the repository set (manifest, detected children, or root);
 *   2. ensure/refresh the RepositoryContextIndex (existing machinery:
 *      incremental, hash-verified, bounded, exclusion-aware);
 *   3. reuse the persisted snapshot only when baselines match AND the
 *      refresh found no changed bytes — repository bytes win over cache;
 *   4. otherwise synthesize deterministically, validate by schema, persist
 *      atomically.
 *
 * The operation is read-only toward everything except `.specbridge/bootstrap/`.
 * It cannot create, revise, or delete product authority by construction:
 * no mission store API is imported here at all except reads.
 */
export function bootstrapWorkspace(
  deps: IntakeDeps,
  options: BootstrapOptions = {},
): BootstrapResult {
  const workspace = deps.workspace;
  const resolution = resolveRepositories(workspace);

  const ensured = ensureRepositoryIndex({
    workspace,
    config: deps.config,
    now: nowIso(deps),
    // Bootstrap has no Git snapshot to name additions, so the refresh walks
    // for them: a snapshot that missed a brand-new capability file would
    // claim currency over a repository it has not actually seen.
    discoverAdditions: true,
    ...(options.rebuild === true ? { rebuild: true } : {}),
  });

  const changedBytes =
    ensured.rebuilt ||
    ensured.refreshedPaths.length > 0 ||
    ensured.addedPaths.length > 0 ||
    ensured.removedPaths.length > 0;

  const existing = readCurrentSystemSnapshot(workspace);
  if (options.rebuild !== true && existing !== undefined && !changedBytes) {
    const freshness = assessSnapshotFreshness(workspace, existing);
    if (freshness.status === 'FRESH') {
      return {
        snapshot: existing,
        reused: true,
        indexRebuilt: ensured.rebuilt,
        refreshedPaths: ensured.refreshedPaths.length,
      };
    }
  }

  const synthesized = synthesizeSystemFindings({
    workspace,
    repositories: resolution.repositories,
    index: ensured.index,
    notes: resolution.notes,
  });

  const repositories: RepositorySnapshotIdentity[] = resolution.repositories.map((repo) => ({
    repositoryId: repo.repositoryId,
    relPath: repo.relPath,
    ...(repo.role !== undefined ? { role: repo.role } : {}),
    gitHead: repo.gitHead,
    indexedFiles: countIndexed(ensured.index, resolution.repositories, repo),
  }));

  const material = {
    repositories,
    mode: synthesized.mode,
    architecture: synthesized.architecture,
    capabilities: synthesized.capabilities,
    publicSurfaces: synthesized.publicSurfaces,
    domainObjects: synthesized.domainObjects,
    implementationPatterns: synthesized.implementationPatterns,
    constraints: synthesized.constraints,
    uncertainties: synthesized.uncertainties,
    existingProductTruth: synthesized.existingProductTruth,
  };
  const contentHash = sha256Hex(JSON.stringify(material)).slice(0, 64);

  const snapshot = currentSystemSnapshotSchema.parse({
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    snapshotId: `snap-${contentHash.slice(0, 12)}`,
    workspaceKey: workspaceKeyFor(workspace.rootDir),
    createdAt: nowIso(deps),
    ...material,
    indexStats: {
      entries: ensured.state.entries.length,
      truncated: ensured.state.truncated,
      skipped: Object.values(ensured.state.skippedCounts).reduce((sum, count) => sum + count, 0),
    },
    contentHash,
  });

  persistSnapshot(workspace, snapshot);
  return {
    snapshot,
    reused: false,
    indexRebuilt: ensured.rebuilt,
    refreshedPaths: ensured.refreshedPaths.length,
  };
}

function countIndexed(
  index: RepositoryContextIndex,
  repositories: readonly ResolvedRepository[],
  repo: ResolvedRepository,
): number {
  let count = 0;
  for (const entry of index.entries) {
    if (repositoryOfPath(repositories, entry.path)?.repositoryId === repo.repositoryId) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Reading, with honesty about staleness
// ---------------------------------------------------------------------------

export interface SnapshotReadResult {
  snapshot: CurrentSystemSnapshot | undefined;
  freshness: SnapshotFreshness;
}

/**
 * Read the snapshot AND say whether it is still current.
 *
 * The pair is deliberate: a stale snapshot is still useful background, but
 * it must never be silently presented as the present tense. Callers render
 * the freshness verdict next to the content.
 */
export function readWorkspaceSnapshot(workspace: WorkspaceInfo): SnapshotReadResult {
  const snapshot = readCurrentSystemSnapshot(workspace);
  return { snapshot, freshness: assessSnapshotFreshness(workspace, snapshot) };
}

// ---------------------------------------------------------------------------
// Bounded on-demand inspection
// ---------------------------------------------------------------------------

export interface InspectOptions {
  question: string;
  /** Restrict results to one repository of the snapshot. */
  repositoryId?: string | undefined;
  /** Sections to materialize (bounded by the context policy). */
  maxSections?: number | undefined;
}

export interface InspectedSection {
  repositoryId: string;
  /** Repository-relative path. */
  path: string;
  content: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  symbol?: string | undefined;
  contentHash: string;
  sectioned: boolean;
}

export interface InspectResult {
  sections: InspectedSection[];
  /** Further candidate paths, named but not read. */
  pointers: { repositoryId: string; path: string }[];
}

/**
 * Bounded deeper inspection for the conversation.
 *
 * Reuses the EXISTING retrieval mechanisms end to end — the repository
 * index, the deterministic ranking, and the section extractor — rather
 * than growing a second file-search implementation. Only indexed paths are
 * ever read, so every scan exclusion (protected paths, credential-shaped
 * names, binaries, size bounds) is inherited; and output is bounded by the
 * same context-efficiency policy the execution runtime obeys.
 */
export function inspectWorkspace(deps: IntakeDeps, options: InspectOptions): InspectResult {
  const question = options.question.trim();
  if (question.length === 0 || question.length > 2_000) {
    throw new IntakeError('SBI018', 'An inspection question must be 1–2000 characters.');
  }
  const policy = deps.config.orchestration.jobs.context.efficiency;
  const maxSections = Math.min(
    Math.max(1, options.maxSections ?? 5),
    policy.maxSelectedItems,
  );

  const workspace = deps.workspace;
  const resolution = resolveRepositories(workspace);
  const ensured = ensureRepositoryIndex({
    workspace,
    config: deps.config,
    now: nowIso(deps),
  });

  const query = buildRetrievalQuery({
    taskId: 'workspace-inspect',
    role: 'PLANNER',
    objective: question,
  });
  const ranked = rankCandidates(ensured.index, query, {
    maxCandidates: policy.maxCandidates,
  });

  const scoped = ranked.filter((candidate) => {
    if (options.repositoryId === undefined) return true;
    return (
      repositoryOfPath(resolution.repositories, candidate.path)?.repositoryId ===
      options.repositoryId
    );
  });

  const sections: InspectedSection[] = [];
  const pointers: { repositoryId: string; path: string }[] = [];
  for (const candidate of scoped) {
    const entry = ensured.index.get(candidate.path);
    if (entry === undefined) continue;
    const repo = repositoryOfPath(resolution.repositories, entry.path);
    const repositoryId = repo?.repositoryId ?? 'workspace';
    if (sections.length >= maxSections) {
      if (pointers.length < policy.maxPointers) {
        pointers.push({
          repositoryId,
          path: repo !== undefined ? repositoryRelativePath(repo, entry.path) : entry.path,
        });
      }
      continue;
    }
    let body: string;
    try {
      body = readFileSync(
        assertInsideWorkspace(workspace.rootDir, entry.path),
        'utf8',
      );
    } catch {
      continue;
    }
    if (body.length > policy.maxIndexedFileBytes) body = body.slice(0, policy.maxIndexedFileBytes);
    const section = extractSection({
      content: body,
      symbols: query.symbols,
      options: {
        wholeFileUnderChars: policy.wholeFileUnderChars,
        targetSectionChars: policy.targetSectionChars,
      },
    });
    sections.push({
      repositoryId,
      path: repo !== undefined ? repositoryRelativePath(repo, entry.path) : entry.path,
      content: section.content,
      ...(section.startLine !== undefined ? { startLine: section.startLine } : {}),
      ...(section.endLine !== undefined ? { endLine: section.endLine } : {}),
      ...(section.symbol !== undefined ? { symbol: section.symbol } : {}),
      contentHash: entry.contentHash,
      sectioned: section.sectioned,
    });
  }
  return { sections, pointers };
}
