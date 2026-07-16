import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';
import {
  EXTENSION_MANIFEST_FILE_NAME,
  parseExtensionManifest,
  semverSatisfies,
} from '@specbridge/extension-sdk';
import { SPECBRIDGE_VERSION } from '@specbridge/templates';
import {
  installedVersionDir,
  isEnabled,
  readExtensionState,
  readPermissionGrants,
  type InstalledExtensionRecord,
} from './state.js';

/**
 * Read-only summary view over installed extensions, shared by the CLI and
 * the read-only MCP tools. Building the catalog never starts a process and
 * never touches the network.
 */
export interface ExtensionCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly kind: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: string;
  readonly installedAt: string;
  readonly enabled: boolean;
  readonly permissionsAccepted: boolean;
  readonly permissionHash: string;
  readonly compatibility: 'compatible' | 'incompatible' | 'unknown';
  readonly conformance: 'passed' | 'failed' | 'not-run';
  readonly deprecated: boolean;
}

export interface ExtensionCatalog {
  readonly entries: readonly ExtensionCatalogEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

function compatibilityOf(
  workspace: WorkspaceInfo,
  record: InstalledExtensionRecord,
  specbridgeVersion: string,
): { compatibility: ExtensionCatalogEntry['compatibility']; deprecated: boolean } {
  try {
    const manifestPath = path.join(
      installedVersionDir(workspace, record.id, record.version),
      EXTENSION_MANIFEST_FILE_NAME,
    );
    if (!existsSync(manifestPath)) {
      return { compatibility: 'unknown', deprecated: false };
    }
    const parsed = parseExtensionManifest(readFileSync(manifestPath, 'utf8'));
    if (parsed.manifest === undefined) {
      return { compatibility: 'unknown', deprecated: false };
    }
    return {
      compatibility: semverSatisfies(specbridgeVersion, parsed.manifest.compatibility.specbridge)
        ? 'compatible'
        : 'incompatible',
      deprecated: parsed.manifest.deprecated === true,
    };
  } catch {
    return { compatibility: 'unknown', deprecated: false };
  }
}

export function listInstalledExtensions(
  workspace: WorkspaceInfo,
  options: { specbridgeVersion?: string } = {},
): ExtensionCatalog {
  const specbridgeVersion = options.specbridgeVersion ?? SPECBRIDGE_VERSION;
  const stateResult = readExtensionState(workspace);
  const grantsResult = readPermissionGrants(workspace);
  const diagnostics: Diagnostic[] = [...stateResult.diagnostics, ...grantsResult.diagnostics];

  const entries = stateResult.state.installed
    .map((record): ExtensionCatalogEntry => {
      const grant = grantsResult.grants.grants[record.id];
      const { compatibility, deprecated } = compatibilityOf(workspace, record, specbridgeVersion);
      return {
        id: record.id,
        version: record.version,
        kind: record.kind,
        displayName: record.displayName,
        description: record.description,
        source: record.source,
        installedAt: record.installedAt,
        enabled: isEnabled(stateResult.state, record.id, record.version),
        permissionsAccepted:
          grant !== undefined &&
          grant.version === record.version &&
          grant.permissionHash === record.permissionHash,
        permissionHash: record.permissionHash,
        compatibility,
        conformance: record.conformanceStatus ?? 'not-run',
        deprecated,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'en') || a.version.localeCompare(b.version, 'en'));

  return { entries, diagnostics };
}

/**
 * Deterministic offline search over installed extension metadata.
 * Ranking: exact ID, ID prefix, exact keyword, display-name token,
 * description token.
 */
export function searchInstalledExtensions(
  catalog: ExtensionCatalog,
  query: string,
  options: { kind?: string; limit?: number } = {},
): ExtensionCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  const limit = options.limit ?? 20;
  const scored: Array<{ entry: ExtensionCatalogEntry; score: number }> = [];
  for (const entry of catalog.entries) {
    if (options.kind !== undefined && entry.kind !== options.kind) {
      continue;
    }
    let score = 0;
    if (entry.id === needle) {
      score = 100;
    } else if (entry.id.startsWith(needle)) {
      score = 80;
    } else if (entry.displayName.toLowerCase().split(/\s+/).includes(needle)) {
      score = 40;
    } else if (entry.description.toLowerCase().includes(needle)) {
      score = 20;
    }
    if (score > 0) {
      scored.push({ entry, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id, 'en'))
    .slice(0, limit)
    .map((item) => item.entry);
}
