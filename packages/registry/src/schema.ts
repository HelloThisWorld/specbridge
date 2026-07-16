import { z } from 'zod';
import {
  EXTENSION_KINDS,
  extensionPermissionsSchema,
  validateExtensionId,
  validateSemverRange,
} from '@specbridge/extension-sdk';
import { RegistryError } from './errors.js';

/**
 * The versioned registry index schema.
 *
 * A registry is a metadata index and nothing more: it never contains
 * executable content, never triggers code execution, and being listed is not
 * an endorsement. Archive SHA-256 values prove download integrity only — not
 * publisher identity and not trustworthiness.
 */
export const REGISTRY_INDEX_SCHEMA_VERSION = '1.0.0';

/** Registry index documents above this size are rejected before parsing. */
export const MAX_REGISTRY_INDEX_BYTES = 5 * 1024 * 1024;

export const REGISTRY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_REGISTRY_NAME_LENGTH = 40;

const HTTPS_URL = z
  .string()
  .min(9)
  .max(1000)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a valid URL' });
      return;
    }
    if (parsed.protocol !== 'https:') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only https:// URLs are allowed' });
    }
    if (parsed.username !== '' || parsed.password !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URLs must not embed credentials',
      });
    }
  });

export const registryVersionEntrySchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    archiveUrl: HTTPS_URL,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: z
      .object({
        protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        compatibility: z
          .object({
            specbridge: z.string().min(1).max(100),
          })
          .passthrough(),
        permissions: extensionPermissionsSchema,
      })
      .passthrough(),
  })
  .strict();

export type RegistryVersionEntry = z.infer<typeof registryVersionEntrySchema>;

export const registryExtensionEntrySchema = z
  .object({
    id: z.string().min(1).max(64),
    displayName: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    kind: z.enum(EXTENSION_KINDS),
    latestVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    versions: z.array(registryVersionEntrySchema).min(1).max(50),
    repository: HTTPS_URL.optional(),
    homepage: HTTPS_URL.optional(),
    license: z.string().min(1).max(100),
    keywords: z.array(z.string().min(1).max(30)).max(12).optional(),
    deprecated: z.boolean().optional(),
  })
  .strict();

export type RegistryExtensionEntry = z.infer<typeof registryExtensionEntrySchema>;

export const registryIndexSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().min(1).max(100),
    updatedAt: z.string().min(1).max(60),
    extensions: z.array(registryExtensionEntrySchema).max(2000),
  })
  .strict();

export type RegistryIndex = z.infer<typeof registryIndexSchema>;

export interface RegistryIndexParseResult {
  readonly index?: RegistryIndex;
  readonly problems: readonly string[];
}

/** Parse and semantically validate a registry index. Never throws. */
export function parseRegistryIndex(text: string): RegistryIndexParseResult {
  const problems: string[] = [];
  if (Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_INDEX_BYTES) {
    return { problems: [`index exceeds ${MAX_REGISTRY_INDEX_BYTES} bytes`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problems: [`index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'schemaVersion' in parsed &&
    typeof (parsed as { schemaVersion: unknown }).schemaVersion === 'string'
  ) {
    const major = (parsed as { schemaVersion: string }).schemaVersion.split('.')[0];
    if (major !== REGISTRY_INDEX_SCHEMA_VERSION.split('.')[0]) {
      return {
        problems: [
          `schemaVersion ${(parsed as { schemaVersion: string }).schemaVersion} is not supported ` +
            `(supported major: ${REGISTRY_INDEX_SCHEMA_VERSION.split('.')[0]})`,
        ],
      };
    }
  }
  const result = registryIndexSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues.slice(0, 15)) {
      problems.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return { problems };
  }
  const seen = new Set<string>();
  for (const entry of result.data.extensions) {
    if (!validateExtensionId(entry.id).valid) {
      problems.push(`extension "${entry.id}": invalid extension ID`);
    }
    if (seen.has(entry.id)) {
      problems.push(`extension "${entry.id}": duplicate entry`);
    }
    seen.add(entry.id);
    if (!entry.versions.some((version) => version.version === entry.latestVersion)) {
      problems.push(`extension "${entry.id}": latestVersion ${entry.latestVersion} is not in versions`);
    }
    const versionsSeen = new Set<string>();
    for (const version of entry.versions) {
      if (versionsSeen.has(version.version)) {
        problems.push(`extension "${entry.id}": duplicate version ${version.version}`);
      }
      versionsSeen.add(version.version);
      const range = validateSemverRange(version.manifest.compatibility.specbridge);
      if (!range.valid) {
        problems.push(
          `extension "${entry.id}" ${version.version}: invalid compatibility range ` +
            `(${range.problem ?? 'unknown'})`,
        );
      }
    }
  }
  if (problems.length > 0) {
    return { problems };
  }
  return { index: result.data, problems: [] };
}

/** Parse an index or throw SBR007 with the first problems embedded. */
export function requireRegistryIndex(text: string, sourceLabel: string): RegistryIndex {
  const parsed = parseRegistryIndex(text);
  if (parsed.index === undefined) {
    throw new RegistryError(
      'SBR007',
      `registry index from ${sourceLabel} is invalid: ${parsed.problems.slice(0, 3).join('; ')}.`,
      'Fix the index document or contact the registry maintainer.',
      { problems: [...parsed.problems] },
    );
  }
  return parsed.index;
}
