import { z } from 'zod';
import {
  EXTENSION_KINDS,
  extensionCapabilitiesSchema,
  isExecutableKind,
  isOperationAllowedForKind,
  operationsForKind,
  REQUIRED_OPERATIONS_BY_KIND,
} from './capabilities.js';
import {
  extensionIssue,
  type ExtensionValidationIssue,
} from './errors.js';
import { validateExtensionId } from './ids.js';
import { extensionPermissionsSchema } from './permissions.js';
import { parseSemver, sameMajor, validateSemverRange } from './semver.js';
import { EXTENSION_MANIFEST_SCHEMA_VERSION, EXTENSION_PROTOCOL_VERSION } from './version.js';

export const EXTENSION_MANIFEST_FILE_NAME = 'specbridge-extension.json';

/** Manifest documents above this size are rejected before parsing. */
export const MAX_EXTENSION_MANIFEST_BYTES = 256 * 1024;

const SEMVER_STRING = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a strict X.Y.Z version');

/**
 * The declared entrypoint must be a relative, forward-slash JavaScript file
 * inside the package. Traversal, absolute paths, and backslashes are rejected
 * by the pattern itself; symlink rejection happens at package-load time.
 */
export const ENTRYPOINT_PATTERN =
  /^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.(?:cjs|mjs|js)$/;

export const extensionAuthorSchema = z
  .object({
    name: z.string().min(1).max(200),
    email: z.string().min(3).max(320).optional(),
    url: z.string().min(1).max(500).optional(),
  })
  .strict();

export const extensionCompatibilitySchema = z
  .object({
    specbridge: z.string().min(1).max(100),
    extensionSdk: z.string().min(1).max(100).optional(),
  })
  .strict();

export const extensionManifestSchema = z
  .object({
    schemaVersion: SEMVER_STRING,
    protocolVersion: SEMVER_STRING,
    id: z.string().min(1).max(64),
    version: SEMVER_STRING,
    displayName: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    kind: z.enum(EXTENSION_KINDS),
    entrypoint: z.string().min(1).max(300).optional(),
    compatibility: extensionCompatibilitySchema,
    capabilities: extensionCapabilitiesSchema,
    permissions: extensionPermissionsSchema,
    license: z.string().min(1).max(100),
    author: extensionAuthorSchema.optional(),
    homepage: z.string().min(1).max(500).optional(),
    repository: z.string().min(1).max(500).optional(),
    keywords: z.array(z.string().min(1).max(30)).max(12).optional(),
    deprecated: z.boolean().optional(),
    replacement: z.string().min(1).max(64).optional(),
    examples: z.array(z.string().min(1).max(300)).max(5).optional(),
    configurationSchema: z.record(z.unknown()).optional(),
    minimumNodeVersion: SEMVER_STRING.optional(),
  })
  .strict();

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
export type ExtensionAuthor = z.infer<typeof extensionAuthorSchema>;
export type ExtensionCompatibility = z.infer<typeof extensionCompatibilitySchema>;

export interface ExtensionManifestParseResult {
  readonly manifest?: ExtensionManifest;
  readonly issues: readonly ExtensionValidationIssue[];
}

function checkUrl(field: string, value: string | undefined, issues: ExtensionValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!/^https:\/\/[^\s]+$/u.test(value)) {
    issues.push(
      extensionIssue('SBE004', 'manifest', 'error', `${field} must be an https:// URL`),
    );
  }
}

/**
 * Non-throwing semantic validation on top of the strict shape schema. Returns
 * every finding so callers can report all problems at once.
 */
export function checkManifestSemantics(manifest: ExtensionManifest): ExtensionValidationIssue[] {
  const issues: ExtensionValidationIssue[] = [];

  const idCheck = validateExtensionId(manifest.id);
  if (!idCheck.valid) {
    for (const problem of idCheck.problems) {
      issues.push(extensionIssue('SBE003', 'manifest', 'error', `id: ${problem}`));
    }
  }

  if (!sameMajor(manifest.protocolVersion, EXTENSION_PROTOCOL_VERSION)) {
    issues.push(
      extensionIssue(
        'SBE007',
        'protocol',
        'error',
        `protocolVersion ${manifest.protocolVersion} is not compatible with supported protocol ` +
          `${EXTENSION_PROTOCOL_VERSION} (major versions must match)`,
      ),
    );
  }

  const rangeCheck = validateSemverRange(manifest.compatibility.specbridge);
  if (!rangeCheck.valid) {
    issues.push(
      extensionIssue(
        'SBE004',
        'compatibility',
        'error',
        `compatibility.specbridge: ${rangeCheck.problem ?? 'invalid range'}`,
      ),
    );
  }
  if (manifest.compatibility.extensionSdk !== undefined) {
    const sdkRange = validateSemverRange(manifest.compatibility.extensionSdk);
    if (!sdkRange.valid) {
      issues.push(
        extensionIssue(
          'SBE004',
          'compatibility',
          'error',
          `compatibility.extensionSdk: ${sdkRange.problem ?? 'invalid range'}`,
        ),
      );
    }
  }

  if (isExecutableKind(manifest.kind)) {
    if (manifest.entrypoint === undefined) {
      issues.push(
        extensionIssue(
          'SBE012',
          'manifest',
          'error',
          `kind "${manifest.kind}" is executable and requires an entrypoint`,
        ),
      );
    } else if (
      manifest.entrypoint.includes('\u0000') ||
      manifest.entrypoint.includes('\\') ||
      manifest.entrypoint.includes('..') ||
      manifest.entrypoint.startsWith('/') ||
      /^[a-zA-Z]:/.test(manifest.entrypoint) ||
      !ENTRYPOINT_PATTERN.test(manifest.entrypoint)
    ) {
      issues.push(
        extensionIssue(
          'SBE012',
          'paths',
          'error',
          `entrypoint "${manifest.entrypoint}" must be a relative forward-slash path to a ` +
            '.cjs, .mjs, or .js file inside the package',
        ),
      );
    }
  } else if (manifest.entrypoint !== undefined) {
    issues.push(
      extensionIssue(
        'SBE004',
        'manifest',
        'error',
        'template-provider extensions are data-only and must not declare an entrypoint',
      ),
    );
  }

  const declared = manifest.capabilities.operations;
  const seen = new Set<string>();
  for (const operation of declared) {
    if (seen.has(operation)) {
      issues.push(
        extensionIssue('SBE004', 'capabilities', 'error', `duplicate operation "${operation}"`),
      );
    }
    seen.add(operation);
    if (!isOperationAllowedForKind(manifest.kind, operation)) {
      issues.push(
        extensionIssue(
          'SBE021',
          'capabilities',
          'error',
          `operation "${operation}" is not valid for kind "${manifest.kind}" ` +
            `(allowed: ${operationsForKind(manifest.kind).join(', ') || 'none'})`,
        ),
      );
    }
  }
  for (const required of REQUIRED_OPERATIONS_BY_KIND[manifest.kind]) {
    if (!seen.has(required)) {
      issues.push(
        extensionIssue(
          'SBE004',
          'capabilities',
          'error',
          `kind "${manifest.kind}" must declare the "${required}" operation`,
        ),
      );
    }
  }
  if (manifest.kind === 'template-provider' && declared.length > 0) {
    issues.push(
      extensionIssue(
        'SBE004',
        'capabilities',
        'error',
        'template-provider extensions must not declare operations',
      ),
    );
  }

  if (manifest.kind === 'template-provider') {
    const p = manifest.permissions;
    if (p.repositoryRead || p.repositoryWrite || p.network || p.childProcess || p.environmentVariables.length > 0) {
      issues.push(
        extensionIssue(
          'SBE004',
          'permissions',
          'error',
          'template-provider extensions are data-only and may not request repositoryRead, ' +
            'repositoryWrite, network, childProcess, or environment variables',
        ),
      );
    }
  }

  const uniqueVariables = new Set(manifest.permissions.environmentVariables);
  if (uniqueVariables.size !== manifest.permissions.environmentVariables.length) {
    issues.push(
      extensionIssue(
        'SBE004',
        'permissions',
        'error',
        'permissions.environmentVariables contains duplicate names',
      ),
    );
  }

  if (manifest.replacement !== undefined) {
    const replacementCheck = validateExtensionId(manifest.replacement);
    if (!replacementCheck.valid) {
      issues.push(
        extensionIssue('SBE004', 'manifest', 'error', 'replacement must be a valid extension ID'),
      );
    }
    if (manifest.deprecated !== true) {
      issues.push(
        extensionIssue(
          'SBE004',
          'manifest',
          'warning',
          'replacement is set but deprecated is not true',
        ),
      );
    }
  }

  checkUrl('homepage', manifest.homepage, issues);
  checkUrl('repository', manifest.repository, issues);

  return issues;
}

/**
 * Parse and validate a manifest document. Never throws: all findings are
 * returned as issues, and `manifest` is present only when the shape parsed.
 */
export function parseExtensionManifest(text: string): ExtensionManifestParseResult {
  const issues: ExtensionValidationIssue[] = [];

  if (Buffer.byteLength(text, 'utf8') > MAX_EXTENSION_MANIFEST_BYTES) {
    issues.push(
      extensionIssue(
        'SBE008',
        'limits',
        'error',
        `manifest exceeds ${MAX_EXTENSION_MANIFEST_BYTES} bytes`,
        EXTENSION_MANIFEST_FILE_NAME,
      ),
    );
    return { issues };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    issues.push(
      extensionIssue(
        'SBE004',
        'manifest',
        'error',
        `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        EXTENSION_MANIFEST_FILE_NAME,
      ),
    );
    return { issues };
  }

  if (typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed) {
    const rawVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
    if (typeof rawVersion === 'string') {
      const parsedVersion = parseSemver(rawVersion);
      const supported = parseSemver(EXTENSION_MANIFEST_SCHEMA_VERSION);
      if (parsedVersion && supported && parsedVersion.major !== supported.major) {
        issues.push(
          extensionIssue(
            'SBE005',
            'manifest',
            'error',
            `schemaVersion ${rawVersion} is not supported (supported major: ${supported.major})`,
            EXTENSION_MANIFEST_FILE_NAME,
          ),
        );
        return { issues };
      }
    }
  }

  const result = extensionManifestSchema.safeParse(parsed);
  if (!result.success) {
    for (const zodIssue of result.error.issues.slice(0, 25)) {
      issues.push(
        extensionIssue(
          'SBE004',
          'manifest',
          'error',
          `${zodIssue.path.join('.') || '(root)'}: ${zodIssue.message}`,
          EXTENSION_MANIFEST_FILE_NAME,
        ),
      );
    }
    return { issues };
  }

  issues.push(...checkManifestSemantics(result.data));
  return { manifest: result.data, issues };
}
