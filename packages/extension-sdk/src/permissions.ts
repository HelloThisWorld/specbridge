import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The explicit extension permission model.
 *
 * Permissions are declarations and audit anchors, not an OS sandbox: an
 * enabled executable extension still runs as local code with the invoking
 * user's operating-system permissions. SpecBridge uses the declarations to
 * bound the data it sends to an extension, to decide which environment
 * variables the extension process receives, and to require explicit,
 * hash-bound user acceptance before an extension can run.
 */
export const EXTENSION_PERMISSION_FLAGS = [
  'specRead',
  'repositoryRead',
  'repositoryWrite',
  'network',
  'childProcess',
] as const;

export type ExtensionPermissionFlag = (typeof EXTENSION_PERMISSION_FLAGS)[number];

export const MAX_PERMISSION_ENVIRONMENT_VARIABLES = 16;

/** Explicit variable names only — wildcard environment access is rejected. */
export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export const extensionPermissionsSchema = z
  .object({
    specRead: z.boolean(),
    repositoryRead: z.boolean(),
    repositoryWrite: z.boolean(),
    network: z.boolean(),
    childProcess: z.boolean(),
    environmentVariables: z
      .array(z.string().regex(ENVIRONMENT_VARIABLE_NAME_PATTERN))
      .max(MAX_PERMISSION_ENVIRONMENT_VARIABLES),
  })
  .strict();

export type ExtensionPermissions = z.infer<typeof extensionPermissionsSchema>;

/** A permission set that grants nothing. */
export function noPermissions(): ExtensionPermissions {
  return {
    specRead: false,
    repositoryRead: false,
    repositoryWrite: false,
    network: false,
    childProcess: false,
    environmentVariables: [],
  };
}

/**
 * Canonical form used for hashing and comparison: fixed key order, sorted
 * unique environment variable names.
 */
export function normalizePermissions(permissions: ExtensionPermissions): ExtensionPermissions {
  return {
    specRead: permissions.specRead,
    repositoryRead: permissions.repositoryRead,
    repositoryWrite: permissions.repositoryWrite,
    network: permissions.network,
    childProcess: permissions.childProcess,
    environmentVariables: [...new Set(permissions.environmentVariables)].sort(),
  };
}

export interface PermissionHashInput {
  readonly extensionId: string;
  readonly extensionVersion: string;
  /** SHA-256 hex of the exact manifest bytes. */
  readonly manifestSha256: string;
  readonly permissions: ExtensionPermissions;
}

/**
 * Deterministic permission hash. Acceptance is bound to this value: any change
 * to the extension ID, version, manifest bytes, or the normalized permission
 * set produces a different hash and therefore invalidates a stored grant.
 */
export function computePermissionHash(input: PermissionHashInput): string {
  const normalized = normalizePermissions(input.permissions);
  const canonical = JSON.stringify({
    extensionId: input.extensionId,
    extensionVersion: input.extensionVersion,
    manifestSha256: input.manifestSha256,
    permissions: {
      childProcess: normalized.childProcess,
      environmentVariables: normalized.environmentVariables,
      network: normalized.network,
      repositoryRead: normalized.repositoryRead,
      repositoryWrite: normalized.repositoryWrite,
      specRead: normalized.specRead,
    },
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Human-readable permission lines for display before acceptance. */
export function describePermissions(permissions: ExtensionPermissions): string[] {
  const normalized = normalizePermissions(permissions);
  const lines: string[] = [];
  lines.push(`specRead: ${normalized.specRead ? 'yes — receives bounded spec content' : 'no'}`);
  lines.push(
    `repositoryRead: ${normalized.repositoryRead ? 'yes — may receive selected repository content' : 'no'}`,
  );
  lines.push(
    `repositoryWrite: ${normalized.repositoryWrite ? 'yes — may modify repository files from its own process' : 'no'}`,
  );
  lines.push(`network: ${normalized.network ? 'yes — may access the network from its own process' : 'no'}`);
  lines.push(
    `childProcess: ${normalized.childProcess ? 'yes — may spawn child processes from its own process' : 'no'}`,
  );
  lines.push(
    normalized.environmentVariables.length === 0
      ? 'environmentVariables: none'
      : `environmentVariables: ${normalized.environmentVariables.join(', ')}`,
  );
  return lines;
}

/**
 * Names of permissions that `after` grants beyond `before`. A non-empty result
 * always requires fresh user acceptance.
 */
export function permissionEscalations(
  before: ExtensionPermissions,
  after: ExtensionPermissions,
): string[] {
  const escalations: string[] = [];
  for (const flag of EXTENSION_PERMISSION_FLAGS) {
    if (!before[flag] && after[flag]) {
      escalations.push(flag);
    }
  }
  const knownVariables = new Set(before.environmentVariables);
  for (const name of normalizePermissions(after).environmentVariables) {
    if (!knownVariables.has(name)) {
      escalations.push(`environmentVariables:${name}`);
    }
  }
  return escalations;
}
