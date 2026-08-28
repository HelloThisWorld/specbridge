import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace } from '@specbridge/core';
import { IntakeError } from '../errors.js';
import { readGitHead } from '../grounding.js';
import type { RepositoryManifest } from './state.js';
import { BOOTSTRAP_LIMITS, repositoryManifestSchema } from './state.js';

/**
 * Repository-set resolution for Workspace Bootstrap.
 *
 * Three shapes, in precedence order:
 *
 *   1. An explicit manifest (`.specbridge/repositories.json`) names the
 *      repositories, their workspace-relative paths, and optional roles.
 *   2. No manifest, and direct children of the workspace root are git
 *      repositories: each child repo is a repository, plus the root itself
 *      when it is one too.
 *   3. Neither: the workspace root is the single repository (with or
 *      without git) — which is exactly today's behaviour, unchanged.
 *
 * Multi-repo support is deliberately BOUNDED to directories inside the
 * workspace root. `assertInsideWorkspace` guards every read and write
 * boundary in SpecBridge; supporting external sibling roots would mean
 * weakening it everywhere, so an out-of-root manifest path fails closed
 * with a message that says so. The supported layout for a multi-repository
 * project is one workspace directory containing the repository roots.
 */

export interface ResolvedRepository {
  repositoryId: string;
  /** Workspace-relative path, forward slashes; '' for the root itself. */
  relPath: string;
  role?: string | undefined;
  /** Absolute directory. Always inside the workspace root. */
  absDir: string;
  /** Git HEAD, or null when not a git repository / no commits. */
  gitHead: string | null;
  /** True when the directory carries a `.git`. */
  isGitRepository: boolean;
}

export interface RepositoryResolution {
  repositories: ResolvedRepository[];
  /** 'manifest' | 'detected-children' | 'workspace-root'. */
  source: 'manifest' | 'detected-children' | 'workspace-root';
  notes: string[];
}

export function repositoryManifestFile(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, 'repositories.json'),
  );
}

/** Directories never treated as repository roots during detection. */
const DETECTION_DENYLIST = new Set([
  '.git',
  '.kiro',
  '.specbridge',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  'vendor',
]);

export function readRepositoryManifest(
  workspace: WorkspaceInfo,
): RepositoryManifest | undefined {
  const file = repositoryManifestFile(workspace);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new IntakeError('SBI018', `The repository manifest at ${file} is not valid JSON.`, {
      remediation: ['Fix or delete .specbridge/repositories.json; without it the workspace root is the repository.'],
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }
  return repositoryManifestSchema.parse(raw);
}

/**
 * Resolve the repository set for this workspace.
 *
 * Fails closed on a manifest that points outside the workspace or at a
 * directory that does not exist: silently dropping a named repository would
 * produce a snapshot that claims to describe the project while missing part
 * of it, which is worse than refusing.
 */
export function resolveRepositories(workspace: WorkspaceInfo): RepositoryResolution {
  const notes: string[] = [];
  const manifest = readRepositoryManifest(workspace);

  if (manifest !== undefined) {
    const seen = new Set<string>();
    const repositories = manifest.repositories.map((entry) => {
      if (seen.has(entry.id)) {
        throw new IntakeError('SBI018', `The repository manifest names "${entry.id}" twice.`);
      }
      seen.add(entry.id);
      // assertInsideWorkspace is the containment boundary: an external
      // sibling path throws here, with the workspace root in the message.
      const absDir = assertInsideWorkspace(workspace.rootDir, entry.path);
      if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
        throw new IntakeError(
          'SBI018',
          `The repository manifest names "${entry.id}" at ${entry.path}, which is not a directory.`,
          {
            remediation: [
              'Repository paths are workspace-relative and must exist. External sibling ' +
                'repositories are not supported; place repository roots inside the workspace.',
            ],
          },
        );
      }
      return resolved(workspace, entry.id, absDir, entry.role);
    });
    return { repositories, source: 'manifest', notes };
  }

  // Detection: direct children that are git repositories.
  const children: ResolvedRepository[] = [];
  try {
    for (const entry of readdirSync(workspace.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (DETECTION_DENYLIST.has(entry.name) || entry.name.startsWith('.')) continue;
      const absDir = path.join(workspace.rootDir, entry.name);
      if (!existsSync(path.join(absDir, '.git'))) continue;
      if (children.length >= BOOTSTRAP_LIMITS.maxRepositories) {
        notes.push('More child repositories exist than the bootstrap bound; declare a manifest to choose.');
        break;
      }
      children.push(resolved(workspace, entry.name, absDir, undefined));
    }
  } catch (cause) {
    notes.push(`The workspace root could not be listed: ${cause instanceof Error ? cause.message : String(cause)}.`);
  }

  if (children.length > 0) {
    const rootIsRepo = existsSync(path.join(workspace.rootDir, '.git'));
    const repositories = rootIsRepo
      ? [resolved(workspace, rootRepositoryId(workspace), workspace.rootDir, undefined), ...children]
      : children;
    return {
      repositories: repositories.slice(0, BOOTSTRAP_LIMITS.maxRepositories),
      source: 'detected-children',
      notes,
    };
  }

  // Single-repository workspace: today's behaviour, no configuration needed.
  return {
    repositories: [resolved(workspace, rootRepositoryId(workspace), workspace.rootDir, undefined)],
    source: 'workspace-root',
    notes,
  };
}

function rootRepositoryId(workspace: WorkspaceInfo): string {
  const base = path
    .basename(workspace.rootDir)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  return base.length > 0 ? base.slice(0, 64) : 'workspace';
}

function resolved(
  workspace: WorkspaceInfo,
  repositoryId: string,
  absDir: string,
  role: string | undefined,
): ResolvedRepository {
  const relPath = path.relative(workspace.rootDir, absDir).replace(/\\/g, '/');
  return {
    repositoryId,
    relPath,
    ...(role !== undefined ? { role } : {}),
    absDir,
    gitHead: readGitHead(absDir),
    isGitRepository: existsSync(path.join(absDir, '.git')),
  };
}

/**
 * Which repository owns a workspace-relative path.
 *
 * Longest matching repository prefix wins, so a file in `agent/src` belongs
 * to the `agent` repository even when the workspace root is itself a
 * repository whose relPath is ''.
 */
export function repositoryOfPath(
  repositories: readonly ResolvedRepository[],
  workspaceRelativePath: string,
): ResolvedRepository | undefined {
  const normalized = workspaceRelativePath.replace(/\\/g, '/');
  let best: ResolvedRepository | undefined;
  let bestLength = -1;
  for (const repo of repositories) {
    if (repo.relPath === '') {
      if (bestLength < 0) {
        best = repo;
        bestLength = 0;
      }
      continue;
    }
    const prefix = `${repo.relPath}/`;
    if ((normalized === repo.relPath || normalized.startsWith(prefix)) && repo.relPath.length > bestLength) {
      best = repo;
      bestLength = repo.relPath.length;
    }
  }
  return best;
}

/** The path inside its repository (equal to the input for the root repo). */
export function repositoryRelativePath(
  repository: ResolvedRepository,
  workspaceRelativePath: string,
): string {
  const normalized = workspaceRelativePath.replace(/\\/g, '/');
  if (repository.relPath === '') return normalized;
  const prefix = `${repository.relPath}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}
