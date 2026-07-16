import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import type { RegistryIndex } from '@specbridge/registry';
import { readRegistriesConfig, resolveRegistryIndex } from '@specbridge/registry';

/**
 * Shared plumbing for the extension_* and registry_* tools. Everything here
 * is read-only and offline: installed state, grants, and validated registry
 * caches. Nothing ever fetches, installs, enables, or executes an extension
 * beyond the bounded read-only doctor handshake.
 */
export const extensionSummaryShape = z.object({
  id: z.string(),
  version: z.string(),
  kind: z.string(),
  displayName: z.string(),
  description: z.string(),
  source: z.string(),
  installedAt: z.string(),
  enabled: z.boolean(),
  permissionsAccepted: z.boolean(),
  permissionHash: z.string(),
  compatibility: z.string(),
  conformance: z.string(),
  deprecated: z.boolean(),
});

export const registryHitShape = z.object({
  registryName: z.string(),
  id: z.string(),
  kind: z.string(),
  displayName: z.string(),
  description: z.string(),
  latestVersion: z.string(),
  license: z.string(),
  score: z.number().int(),
});

/** Readable registry indexes with zero network access. */
export function readableRegistryIndexes(
  workspace: WorkspaceInfo,
  registryFilter?: string,
): Array<{ registryName: string; index: RegistryIndex }> {
  const { config } = readRegistriesConfig(workspace);
  const indexes: Array<{ registryName: string; index: RegistryIndex }> = [];
  for (const source of config.registries) {
    if (source.enabled !== true) {
      continue;
    }
    if (registryFilter !== undefined && source.name !== registryFilter) {
      continue;
    }
    try {
      const resolved = resolveRegistryIndex(workspace, source);
      if (resolved !== undefined) {
        indexes.push({ registryName: resolved.sourceName, index: resolved.index });
      }
    } catch {
      // Unreadable sources are skipped here; the CLI reports them.
    }
  }
  return indexes;
}
