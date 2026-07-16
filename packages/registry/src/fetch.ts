import type { WorkspaceInfo } from '@specbridge/core';
import { RegistryError } from './errors.js';
import { writeRegistryCache, type CachedRegistry } from './cache.js';
import { MAX_REGISTRY_INDEX_BYTES, parseRegistryIndex } from './schema.js';
import type { RegistrySource } from './source.js';

/**
 * Explicit-network registry operations.
 *
 * The HTTP transport is injected (the CLI passes `safeHttpRequest` from
 * @specbridge/runners), so this package holds no network capability of its
 * own and the security policy lives in one audited client: HTTPS only,
 * bounded response size, timeout, bounded redirects with no HTTPS→HTTP
 * downgrade and no cross-origin header forwarding, and no credentials in
 * URLs. An invalid response never replaces a previously valid cache, and
 * updating a registry never installs anything.
 */
export interface RegistryHttpResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly bodyText?: string;
  /** Byte-exact body, present when binaryBody was requested. */
  readonly bodyBase64?: string;
  readonly kind?: string;
  readonly detail?: string;
}

export type RegistryHttpRequest = (request: {
  method: 'GET';
  url: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects?: number;
  expectJson?: boolean;
  binaryBody?: boolean;
  signal?: AbortSignal;
}) => Promise<RegistryHttpResult>;

export const REGISTRY_FETCH_TIMEOUT_MS = 30_000;
export const REGISTRY_MAX_REDIRECTS = 3;

export interface UpdateRegistryOptions {
  /** Explicit opt-in; without it the update refuses to touch the network. */
  readonly network: boolean;
  readonly http: RegistryHttpRequest;
  readonly signal?: AbortSignal;
  readonly clock?: () => Date;
}

export interface UpdateRegistryResult {
  readonly sourceName: string;
  readonly cache: CachedRegistry;
  readonly extensionCount: number;
}

/** Fetch, validate, and atomically cache one https registry index. */
export async function updateRegistryIndex(
  workspace: WorkspaceInfo,
  source: RegistrySource,
  options: UpdateRegistryOptions,
): Promise<UpdateRegistryResult> {
  if (source.type !== 'https') {
    throw new RegistryError(
      'SBR015',
      `registry "${source.name}" is a ${source.type} source and has nothing to update.`,
      'Only https registries are updated; local-file and builtin sources are always current.',
      { name: source.name },
    );
  }
  if (!options.network) {
    throw new RegistryError(
      'SBR004',
      `updating registry "${source.name}" requires network access.`,
      'Re-run with --network to allow this one explicit fetch.',
      { name: source.name },
    );
  }

  const response = await options.http({
    method: 'GET',
    url: source.url,
    timeoutMs: REGISTRY_FETCH_TIMEOUT_MS,
    maxResponseBytes: MAX_REGISTRY_INDEX_BYTES,
    maxRedirects: REGISTRY_MAX_REDIRECTS,
    expectJson: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok) {
    if (response.kind === 'response-too-large') {
      throw new RegistryError(
        'SBR006',
        `the index from ${source.url} exceeds ${MAX_REGISTRY_INDEX_BYTES} bytes.`,
        'The previous valid cache (if any) was preserved.',
      );
    }
    if (response.kind === 'redirect-rejected') {
      throw new RegistryError(
        'SBR009',
        `the request to ${source.url} was redirected in a way SpecBridge refuses ` +
          `(${response.detail ?? 'unsafe redirect'}).`,
        'HTTPS→HTTP downgrades and excessive redirects are never followed; the cache was preserved.',
      );
    }
    throw new RegistryError(
      'SBR005',
      `fetching ${source.url} failed (${response.kind ?? 'error'}${response.status !== undefined ? ` ${response.status}` : ''}: ` +
        `${response.detail ?? 'no detail'}).`,
      'Check the URL and connectivity; the previous valid cache (if any) was preserved.',
    );
  }

  const bodyText = response.bodyText ?? '';
  const parsed = parseRegistryIndex(bodyText);
  if (parsed.index === undefined) {
    throw new RegistryError(
      'SBR007',
      `the index from ${source.url} failed validation: ${parsed.problems.slice(0, 3).join('; ')}.`,
      'The previous valid cache (if any) was preserved; contact the registry maintainer.',
      { problems: [...parsed.problems] },
    );
  }

  const cache = writeRegistryCache(workspace, source.name, bodyText, parsed.index, {
    sourceUrl: source.url,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return { sourceName: source.name, cache, extensionCount: parsed.index.extensions.length };
}

export interface DownloadArchiveOptions {
  readonly network: boolean;
  readonly http: RegistryHttpRequest;
  readonly maxArchiveBytes: number;
  readonly signal?: AbortSignal;
}

/** Download an extension archive named by a validated registry entry. */
export async function downloadRegistryArchive(
  archiveUrl: string,
  options: DownloadArchiveOptions,
): Promise<Buffer> {
  if (!options.network) {
    throw new RegistryError(
      'SBR004',
      'downloading an extension archive requires network access.',
      'Re-run with --network to allow this one explicit download.',
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(archiveUrl);
  } catch {
    throw new RegistryError('SBR013', `archive URL "${archiveUrl}" is invalid.`, 'Fix the registry entry.');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new RegistryError(
      'SBR013',
      `archive URL "${archiveUrl}" is not a credential-free https:// URL.`,
      'Registry archives are only ever downloaded over HTTPS.',
    );
  }
  const response = await options.http({
    method: 'GET',
    url: archiveUrl,
    timeoutMs: REGISTRY_FETCH_TIMEOUT_MS,
    maxResponseBytes: options.maxArchiveBytes,
    maxRedirects: REGISTRY_MAX_REDIRECTS,
    binaryBody: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    throw new RegistryError(
      'SBR013',
      `downloading ${archiveUrl} failed (${response.kind ?? 'error'}: ${response.detail ?? 'no detail'}).`,
      'Nothing was installed; check connectivity and the registry entry.',
    );
  }
  if (response.bodyBase64 === undefined) {
    throw new RegistryError(
      'SBR013',
      `downloading ${archiveUrl} returned no byte-exact body.`,
      'Nothing was installed; this indicates a transport problem.',
    );
  }
  return Buffer.from(response.bodyBase64, 'base64');
}
