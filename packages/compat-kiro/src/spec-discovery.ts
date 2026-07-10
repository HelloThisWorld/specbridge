import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SpecFileKind, WorkspaceInfo } from '@specbridge/core';
import { SpecBridgeError } from '@specbridge/core';

/**
 * Spec discovery: every directory under `.kiro/specs/` is a spec. Files we
 * recognize get a kind; everything else is listed as `other` and preserved.
 */

export interface SpecFileEntry {
  fileName: string;
  kind: SpecFileKind;
  path: string;
  sizeBytes: number;
}

export interface SpecFolder {
  name: string;
  dir: string;
  files: SpecFileEntry[];
  /** Subdirectories inside the spec folder. Never touched by SpecBridge. */
  extraDirs: string[];
}

const KNOWN_FILE_KINDS: Record<string, SpecFileKind> = {
  'requirements.md': 'requirements',
  'design.md': 'design',
  'tasks.md': 'tasks',
  'bugfix.md': 'bugfix',
};

export function kindForFileName(fileName: string): SpecFileKind {
  return KNOWN_FILE_KINDS[fileName.toLowerCase()] ?? 'other';
}

function readSpecFolder(specsDir: string, name: string): SpecFolder {
  const dir = path.join(specsDir, name);
  const files: SpecFileEntry[] = [];
  const extraDirs: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      extraDirs.push(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(filePath).size;
    } catch {
      // Race with a concurrent delete; keep the entry with size 0.
    }
    files.push({
      fileName: entry.name,
      kind: kindForFileName(entry.name),
      path: filePath,
      sizeBytes,
    });
  }
  files.sort((a, b) => a.fileName.localeCompare(b.fileName, 'en'));
  extraDirs.sort((a, b) => a.localeCompare(b, 'en'));
  return { name, dir, files, extraDirs };
}

/** All spec folders, sorted by name. Returns an empty list when `.kiro/specs` is absent. */
export function discoverSpecs(workspace: WorkspaceInfo): SpecFolder[] {
  if (workspace.specsDir === undefined) return [];
  return readdirSync(workspace.specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((name) => readSpecFolder(workspace.specsDir as string, name));
}

export function findSpec(workspace: WorkspaceInfo, name: string): SpecFolder | undefined {
  if (workspace.specsDir === undefined) return undefined;
  const wanted = name.toLowerCase();
  return discoverSpecs(workspace).find((spec) => spec.name.toLowerCase() === wanted);
}

/** Find a spec or throw `SPEC_NOT_FOUND` listing what exists. */
export function requireSpec(workspace: WorkspaceInfo, name: string): SpecFolder {
  const spec = findSpec(workspace, name);
  if (spec === undefined) {
    const available = discoverSpecs(workspace).map((s) => s.name);
    throw new SpecBridgeError(
      'SPEC_NOT_FOUND',
      available.length > 0
        ? `Spec "${name}" not found. Available specs: ${available.join(', ')}.`
        : `Spec "${name}" not found. This workspace has no specs under .kiro/specs/.`,
    );
  }
  return spec;
}

export function specFile(folder: SpecFolder, kind: SpecFileKind): SpecFileEntry | undefined {
  return folder.files.find((file) => file.kind === kind);
}

/** Files loose in `.kiro/specs/` that are not spec directories (listed, never parsed). */
export function listLooseSpecEntries(workspace: WorkspaceInfo): string[] {
  if (workspace.specsDir === undefined) return [];
  return readdirSync(workspace.specsDir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
}
