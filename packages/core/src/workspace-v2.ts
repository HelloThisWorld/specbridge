import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface Workspace {
  rootDir: string;
  sidecarDir: string;
}

export class SpecBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SpecBridgeError';
  }
}

export function resolveWorkspace(startDir: string): Workspace | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (
      existsSync(path.join(current, '.git')) ||
      existsSync(path.join(current, 'package.json')) ||
      existsSync(path.join(current, '.specbridge'))
    ) {
      return { rootDir: current, sidecarDir: path.join(current, '.specbridge') };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function requireWorkspace(startDir: string): Workspace {
  const workspace = resolveWorkspace(startDir);
  if (workspace === undefined) {
    throw new SpecBridgeError(
      'WORKSPACE_NOT_FOUND',
      'No repository or SpecBridge workspace was found from the requested directory.',
      { startDir: path.resolve(startDir) },
    );
  }
  return workspace;
}

export function assertInsideWorkspace(rootDir: string, target: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SpecBridgeError('PATH_ESCAPE', 'Path resolves outside the workspace.', {
      root,
      target,
      resolved,
    });
  }
  return resolved;
}

export function workspaceRelative(rootDir: string, target: string): string {
  return path.relative(path.resolve(rootDir), assertInsideWorkspace(rootDir, target)).replaceAll('\\', '/');
}

export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (cause) {
    throw new SpecBridgeError('INVALID_JSON', `Cannot read JSON file: ${filePath}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${sha256(parts.join('\u0000')).slice(0, 12)}`;
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug.length > 0 ? slug : `design-${stableId('id', value).slice(-8)}`;
}

export function repositoryName(rootDir: string): string {
  try {
    return path.basename(realpathSync(rootDir));
  } catch {
    return path.basename(path.resolve(rootDir));
  }
}

export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
