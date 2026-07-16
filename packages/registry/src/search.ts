import { RegistryError } from './errors.js';
import type { RegistryExtensionEntry, RegistryIndex, RegistryVersionEntry } from './schema.js';

/**
 * Deterministic offline search over validated registry indexes. There is no
 * semantic matching and no network access — the documented lexical ranking
 * is: exact ID, ID prefix, exact keyword, display-name token, description
 * token. Ties break by extension ID, then registry name.
 */
export interface RegistrySearchHit {
  readonly registryName: string;
  readonly entry: RegistryExtensionEntry;
  readonly score: number;
}

export const DEFAULT_REGISTRY_SEARCH_LIMIT = 20;
export const MAX_REGISTRY_SEARCH_LIMIT = 50;

export function searchRegistryIndexes(
  indexes: ReadonlyArray<{ registryName: string; index: RegistryIndex }>,
  query: string,
  options: { kind?: string; limit?: number } = {},
): RegistrySearchHit[] {
  const needle = query.trim().toLowerCase();
  const limit = Math.min(options.limit ?? DEFAULT_REGISTRY_SEARCH_LIMIT, MAX_REGISTRY_SEARCH_LIMIT);
  const hits: RegistrySearchHit[] = [];
  for (const { registryName, index } of indexes) {
    for (const entry of index.extensions) {
      if (options.kind !== undefined && entry.kind !== options.kind) {
        continue;
      }
      let score = 0;
      if (entry.id === needle) {
        score = 100;
      } else if (entry.id.startsWith(needle)) {
        score = 80;
      } else if ((entry.keywords ?? []).some((keyword) => keyword.toLowerCase() === needle)) {
        score = 60;
      } else if (entry.displayName.toLowerCase().split(/\s+/).includes(needle)) {
        score = 40;
      } else if (entry.description.toLowerCase().includes(needle)) {
        score = 20;
      }
      if (score > 0) {
        hits.push({ registryName, entry, score });
      }
    }
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.id.localeCompare(b.entry.id, 'en') ||
        a.registryName.localeCompare(b.registryName, 'en'),
    )
    .slice(0, limit);
}

export interface ResolvedRegistryExtension {
  readonly registryName: string;
  readonly entry: RegistryExtensionEntry;
  readonly version: RegistryVersionEntry;
}

/** Resolve one extension version across readable indexes. */
export function resolveRegistryExtension(
  indexes: ReadonlyArray<{ registryName: string; index: RegistryIndex }>,
  extensionId: string,
  version?: string,
): ResolvedRegistryExtension {
  const matches: ResolvedRegistryExtension[] = [];
  for (const { registryName, index } of indexes) {
    const entry = index.extensions.find((candidate) => candidate.id === extensionId);
    if (entry === undefined) {
      continue;
    }
    const wanted = version ?? entry.latestVersion;
    const versionEntry = entry.versions.find((candidate) => candidate.version === wanted);
    if (versionEntry === undefined) {
      throw new RegistryError(
        'SBR011',
        `extension "${extensionId}" has no version ${wanted} in registry "${registryName}" ` +
          `(available: ${entry.versions.map((candidate) => candidate.version).join(', ')}).`,
        'Pass one of the available versions with --version.',
        { extensionId, version: wanted },
      );
    }
    matches.push({ registryName, entry, version: versionEntry });
  }
  if (matches.length === 0) {
    throw new RegistryError(
      'SBR011',
      `extension "${extensionId}" was not found in any readable registry index.`,
      'Run `specbridge registry search <query>` to discover extensions, or update the ' +
        'registry cache with `specbridge registry update <name> --network`.',
      { extensionId },
    );
  }
  const first = matches[0];
  if (matches.length > 1 && first !== undefined) {
    // Deterministic: the first configured registry wins, but say so.
    return first;
  }
  if (first === undefined) {
    throw new RegistryError('SBR011', `extension "${extensionId}" was not found.`, 'Check the ID.');
  }
  return first;
}
