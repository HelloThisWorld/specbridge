import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { SpecBridgeError, ioError } from './errors.js';
import {
  CLI_BIN,
  KIRO_DIR_NAME,
  KIRO_SPECS_DIR,
  KIRO_STEERING_DIR,
  SIDECAR_DIR_NAME,
} from './types.js';

export interface WorkspaceInfo {
  /** Directory that contains `.kiro`. This is the workspace root. */
  rootDir: string;
  kiroDir: string;
  /** Present only when the directory exists on disk. */
  steeringDir?: string;
  specsDir?: string;
  /** Nearest enclosing git repository root, if any. */
  gitRootDir?: string;
  /** `<rootDir>/.specbridge` — may not exist yet. */
  sidecarDir: string;
  sidecarExists: boolean;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walkUp(startDir: string, predicate: (dir: string) => boolean): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Find the nearest directory (here or above) that contains a `.kiro` directory. */
export function findKiroRoot(startDir: string): string | undefined {
  return walkUp(startDir, (dir) => isDirectory(path.join(dir, KIRO_DIR_NAME)));
}

/** Find the nearest enclosing git root (`.git` may be a directory or a worktree file). */
export function findGitRoot(startDir: string): string | undefined {
  return walkUp(startDir, (dir) => existsSync(path.join(dir, '.git')));
}

/** Resolve the workspace from a starting directory, or `undefined` if no `.kiro` exists. */
export function resolveWorkspace(startDir: string): WorkspaceInfo | undefined {
  const rootDir = findKiroRoot(startDir);
  if (rootDir === undefined) return undefined;

  const kiroDir = path.join(rootDir, KIRO_DIR_NAME);
  const steeringDir = path.join(kiroDir, KIRO_STEERING_DIR);
  const specsDir = path.join(kiroDir, KIRO_SPECS_DIR);
  const sidecarDir = path.join(rootDir, SIDECAR_DIR_NAME);
  const gitRootDir = findGitRoot(rootDir);

  return {
    rootDir,
    kiroDir,
    ...(isDirectory(steeringDir) ? { steeringDir } : {}),
    ...(isDirectory(specsDir) ? { specsDir } : {}),
    ...(gitRootDir !== undefined ? { gitRootDir } : {}),
    sidecarDir,
    sidecarExists: isDirectory(sidecarDir),
  };
}

/** Resolve the workspace or fail with actionable guidance. */
export function requireWorkspace(startDir: string): WorkspaceInfo {
  const workspace = resolveWorkspace(startDir);
  if (workspace === undefined) {
    throw new SpecBridgeError(
      'WORKSPACE_NOT_FOUND',
      `No ${KIRO_DIR_NAME} directory found in ${path.resolve(startDir)} or any parent directory. ` +
        `Run ${CLI_BIN} inside a project that contains ${KIRO_DIR_NAME}/, ` +
        `or run "${CLI_BIN} doctor" for a full workspace report.`,
    );
  }
  return workspace;
}

/**
 * Resolve `target` against `rootDir` and reject anything that escapes the
 * workspace (path traversal, absolute paths outside the root). Every write
 * path in SpecBridge must pass through this guard.
 */
export function assertInsideWorkspace(rootDir: string, target: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SpecBridgeError(
      'PATH_OUTSIDE_WORKSPACE',
      `Refusing to touch ${resolved}: it is outside the workspace root ${resolvedRoot}.`,
      { rootDir: resolvedRoot, target: resolved },
    );
  }
  return resolved;
}

/**
 * Atomic file write: write to a temp sibling, fsync, then rename over the
 * target. Guarantees readers never observe a half-written file and the temp
 * file never survives a failure.
 */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tempPath, 'w');
    try {
      writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, filePath);
  } catch (cause) {
    rmSync(tempPath, { force: true });
    throw ioError('write', filePath, cause);
  }
}
