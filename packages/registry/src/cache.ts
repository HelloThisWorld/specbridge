import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assertInsideWorkspace,
  writeFileAtomic,
  type Diagnostic,
  type WorkspaceInfo,
} from '@specbridge/core';
import { BUILTIN_REGISTRY_INDEX_JSON } from './builtin-index.generated.js';
import { RegistryError } from './errors.js';
import { parseRegistryIndex, registryIndexSchema, type RegistryIndex } from './schema.js';
import type { RegistrySource } from './source.js';

/**
 * Validated registry cache under `.specbridge/registry-cache/`.
 *
 * Only schema-valid indexes are ever cached; an invalid update never
 * replaces a previously valid cache. Search always reads the cache — the
 * network is touched only by an explicit `registry update --network`.
 */
export const REGISTRY_CACHE_DIR_NAME = 'registry-cache';
export const REGISTRY_CACHE_SCHEMA_VERSION = '1.0.0';

export const cachedRegistrySchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    sourceName: z.string().min(1),
    sourceUrl: z.string().min(1).optional(),
    retrievedAt: z.string().min(1),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    index: registryIndexSchema,
  })
  .passthrough();

export type CachedRegistry = z.infer<typeof cachedRegistrySchema>;

export function registryCacheDir(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, REGISTRY_CACHE_DIR_NAME);
}

export function registryCachePath(workspace: WorkspaceInfo, name: string): string {
  const target = path.join(registryCacheDir(workspace), `${name}.json`);
  assertInsideWorkspace(workspace.rootDir, target);
  return target;
}

export interface RegistryCacheReadResult {
  readonly cache?: CachedRegistry;
  readonly diagnostics: readonly Diagnostic[];
}

export function readRegistryCache(workspace: WorkspaceInfo, name: string): RegistryCacheReadResult {
  const filePath = registryCachePath(workspace, name);
  if (!existsSync(filePath)) {
    return { diagnostics: [] };
  }
  try {
    const parsed = cachedRegistrySchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
    if (!parsed.success) {
      return {
        diagnostics: [
          {
            severity: 'warning',
            code: 'REGISTRY_CACHE_INVALID',
            message: `cached index for "${name}" does not match the cache schema and was ignored`,
            file: filePath,
          },
        ],
      };
    }
    return { cache: parsed.data, diagnostics: [] };
  } catch (cause) {
    return {
      diagnostics: [
        {
          severity: 'warning',
          code: 'REGISTRY_CACHE_UNREADABLE',
          message: `cached index for "${name}" could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: filePath,
        },
      ],
    };
  }
}

export function writeRegistryCache(
  workspace: WorkspaceInfo,
  name: string,
  indexText: string,
  index: RegistryIndex,
  options: { sourceUrl?: string; clock?: () => Date } = {},
): CachedRegistry {
  const cache: CachedRegistry = cachedRegistrySchema.parse({
    schemaVersion: REGISTRY_CACHE_SCHEMA_VERSION,
    sourceName: name,
    ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl }),
    retrievedAt: (options.clock?.() ?? new Date()).toISOString(),
    contentSha256: createHash('sha256').update(indexText, 'utf8').digest('hex'),
    index,
  });
  writeFileAtomic(registryCachePath(workspace, name), `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}

export interface ResolvedRegistryIndex {
  readonly sourceName: string;
  readonly index: RegistryIndex;
  /** Where the index came from for this read. */
  readonly origin: 'builtin' | 'local-file' | 'cache';
  readonly retrievedAt?: string;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Resolve the readable index for a source WITHOUT any network access:
 * builtin → embedded document, local-file → validated file read,
 * https → last validated cache (undefined when never updated).
 */
export function resolveRegistryIndex(
  workspace: WorkspaceInfo,
  source: RegistrySource,
): ResolvedRegistryIndex | undefined {
  if (source.type === 'builtin') {
    const parsed = parseRegistryIndex(BUILTIN_REGISTRY_INDEX_JSON);
    if (parsed.index === undefined) {
      throw new RegistryError(
        'SBR007',
        'the built-in example registry index failed validation.',
        'This is a SpecBridge build problem; run `pnpm check:builtin-registry`.',
      );
    }
    return { sourceName: source.name, index: parsed.index, origin: 'builtin', diagnostics: [] };
  }
  if (source.type === 'local-file') {
    const filePath = path.resolve(workspace.rootDir, source.file);
    assertInsideWorkspace(workspace.rootDir, filePath);
    if (!existsSync(filePath)) {
      return {
        sourceName: source.name,
        index: { schemaVersion: '1.0.0', name: source.name, updatedAt: 'unknown', extensions: [] },
        origin: 'local-file',
        diagnostics: [
          {
            severity: 'warning',
            code: 'REGISTRY_FILE_MISSING',
            message: `registry file ${source.file} does not exist`,
            file: filePath,
          },
        ],
      };
    }
    const text = readFileSync(filePath, 'utf8');
    const parsed = parseRegistryIndex(text);
    if (parsed.index === undefined) {
      throw new RegistryError(
        'SBR007',
        `registry file ${source.file} is invalid: ${parsed.problems.slice(0, 3).join('; ')}.`,
        'Fix the index file; see registry/schema.json for the expected shape.',
        { problems: [...parsed.problems] },
      );
    }
    return { sourceName: source.name, index: parsed.index, origin: 'local-file', diagnostics: [] };
  }
  const cached = readRegistryCache(workspace, source.name);
  if (cached.cache === undefined) {
    return undefined;
  }
  return {
    sourceName: source.name,
    index: cached.cache.index,
    origin: 'cache',
    retrievedAt: cached.cache.retrievedAt,
    diagnostics: cached.diagnostics,
  };
}
