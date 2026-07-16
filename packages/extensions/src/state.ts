import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  assertInsideWorkspace,
  ioError,
  writeFileAtomic,
  type Diagnostic,
  type WorkspaceInfo,
} from '@specbridge/core';
import { compareSemver, parseSemver, validateExtensionId } from '@specbridge/extension-sdk';
import { ExtensionError } from './errors.js';

/**
 * Extension installation and enablement state, stored outside `.kiro` under
 * `.specbridge/extensions/`:
 *
 *   installed/<extension-id>/<version>/   — installed package files
 *   state.json                            — installed + enabled bookkeeping
 *   grants.json                           — accepted permission grants
 *   records.jsonl                         — append-only operation history
 *
 * Reads are tolerant (invalid state degrades to diagnostics, never crashes,
 * and is never silently repaired); writes are atomic and workspace-guarded.
 */
export const EXTENSIONS_DIR_NAME = 'extensions';
export const EXTENSION_STATE_FILE_NAME = 'state.json';
export const EXTENSION_GRANTS_FILE_NAME = 'grants.json';
export const EXTENSION_RECORDS_FILE_NAME = 'records.jsonl';
export const EXTENSION_STATE_SCHEMA_VERSION = '1.0.0';

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function extensionsDir(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, EXTENSIONS_DIR_NAME);
}

export function installedRootDir(workspace: WorkspaceInfo): string {
  return path.join(extensionsDir(workspace), 'installed');
}

export function installedVersionDir(workspace: WorkspaceInfo, id: string, version: string): string {
  if (!validateExtensionId(id).valid || parseSemver(version) === undefined) {
    throw new ExtensionError(
      'SBE003',
      `"${id}@${version}" is not a valid extension reference.`,
      'Use a valid extension ID and X.Y.Z version.',
    );
  }
  const dir = path.join(installedRootDir(workspace), id, version);
  assertInsideWorkspace(workspace.rootDir, dir);
  return dir;
}

export const installedExtensionRecordSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    kind: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().min(1),
    source: z.string().min(1),
    installedAt: z.string().min(1),
    archiveSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    permissionHash: z.string().regex(/^[0-9a-f]{64}$/),
    entrypoint: z.string().min(1).optional(),
    installRecordId: z.string().min(1),
    conformanceStatus: z.enum(['passed', 'failed']).optional(),
    conformanceAt: z.string().min(1).optional(),
    lastDoctorResult: z.enum(['ok', 'failed']).optional(),
    lastDoctorAt: z.string().min(1).optional(),
  })
  .passthrough();

export type InstalledExtensionRecord = z.infer<typeof installedExtensionRecordSchema>;

export const extensionStateSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    installed: z.array(installedExtensionRecordSchema),
    enabled: z.record(z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).passthrough()),
  })
  .passthrough();

export type ExtensionState = z.infer<typeof extensionStateSchema>;

export const permissionGrantSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    permissionHash: z.string().regex(/^[0-9a-f]{64}$/),
    acceptedAt: z.string().min(1),
  })
  .passthrough();

export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

export const permissionGrantsSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    grants: z.record(permissionGrantSchema),
  })
  .passthrough();

export type PermissionGrants = z.infer<typeof permissionGrantsSchema>;

export function emptyExtensionState(): ExtensionState {
  return { schemaVersion: EXTENSION_STATE_SCHEMA_VERSION, installed: [], enabled: {} };
}

export function emptyPermissionGrants(): PermissionGrants {
  return { schemaVersion: EXTENSION_STATE_SCHEMA_VERSION, grants: {} };
}

export interface ExtensionStateReadResult {
  readonly state: ExtensionState;
  readonly diagnostics: readonly Diagnostic[];
  readonly exists: boolean;
}

function readValidatedJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
  empty: T,
  label: string,
): { value: T; diagnostics: Diagnostic[]; exists: boolean } {
  if (!existsSync(filePath)) {
    return { value: empty, diagnostics: [], exists: false };
  }
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (cause) {
    return {
      value: empty,
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'EXTENSION_STATE_UNREADABLE',
          message: `${label} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: filePath,
        },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      value: empty,
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'EXTENSION_STATE_INVALID_JSON',
          message: `${label} is not valid JSON; fix or remove the file (SpecBridge never repairs it silently)`,
          file: filePath,
        },
      ],
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      value: empty,
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'EXTENSION_STATE_INVALID_SHAPE',
          message: `${label} does not match the expected schema: ${result.error.issues[0]?.message ?? 'unknown'}`,
          file: filePath,
        },
      ],
    };
  }
  return { value: result.data, diagnostics: [], exists: true };
}

export function extensionStatePath(workspace: WorkspaceInfo): string {
  return path.join(extensionsDir(workspace), EXTENSION_STATE_FILE_NAME);
}

export function permissionGrantsPath(workspace: WorkspaceInfo): string {
  return path.join(extensionsDir(workspace), EXTENSION_GRANTS_FILE_NAME);
}

export function extensionRecordsPath(workspace: WorkspaceInfo): string {
  return path.join(extensionsDir(workspace), EXTENSION_RECORDS_FILE_NAME);
}

export function readExtensionState(workspace: WorkspaceInfo): ExtensionStateReadResult {
  const { value, diagnostics, exists } = readValidatedJson(
    extensionStatePath(workspace),
    extensionStateSchema,
    emptyExtensionState(),
    'extension state',
  );
  return { state: value, diagnostics, exists };
}

export function writeExtensionState(workspace: WorkspaceInfo, state: ExtensionState): void {
  const filePath = extensionStatePath(workspace);
  assertInsideWorkspace(workspace.rootDir, filePath);
  writeFileAtomic(filePath, `${JSON.stringify(extensionStateSchema.parse(state), null, 2)}\n`);
}

export interface PermissionGrantsReadResult {
  readonly grants: PermissionGrants;
  readonly diagnostics: readonly Diagnostic[];
}

export function readPermissionGrants(workspace: WorkspaceInfo): PermissionGrantsReadResult {
  const { value, diagnostics } = readValidatedJson(
    permissionGrantsPath(workspace),
    permissionGrantsSchema,
    emptyPermissionGrants(),
    'permission grants',
  );
  return { grants: value, diagnostics };
}

export function writePermissionGrants(workspace: WorkspaceInfo, grants: PermissionGrants): void {
  const filePath = permissionGrantsPath(workspace);
  assertInsideWorkspace(workspace.rootDir, filePath);
  writeFileAtomic(filePath, `${JSON.stringify(permissionGrantsSchema.parse(grants), null, 2)}\n`);
}

export const extensionOperationRecordSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    recordId: z.string().min(1),
    type: z.enum(['install', 'uninstall', 'enable', 'disable', 'export']),
    at: z.string().min(1),
    extensionId: z.string().min(1),
    version: z.string().min(1),
    details: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type ExtensionOperationRecord = z.infer<typeof extensionOperationRecordSchema>;

let recordCounter = 0;

/** Unique-enough record ID; tests may pass explicit IDs instead. */
export function newExtensionRecordId(clock: Clock = systemClock): string {
  recordCounter += 1;
  return `extension-${clock().getTime().toString(36)}-${process.pid.toString(36)}-${recordCounter}`;
}

/** Validate and append one record. Records are append-only by contract. */
export function appendExtensionRecord(workspace: WorkspaceInfo, record: ExtensionOperationRecord): void {
  const validated = extensionOperationRecordSchema.parse(record);
  const filePath = extensionRecordsPath(workspace);
  assertInsideWorkspace(workspace.rootDir, filePath);
  try {
    mkdirSync(extensionsDir(workspace), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(validated)}\n`, 'utf8');
  } catch (cause) {
    throw ioError('append extension record to', filePath, cause);
  }
}

/** All installed records for an ID, newest version first. */
export function installedVersions(state: ExtensionState, id: string): InstalledExtensionRecord[] {
  return state.installed
    .filter((record) => record.id === id)
    .sort((a, b) => {
      const left = parseSemver(a.version);
      const right = parseSemver(b.version);
      if (left === undefined || right === undefined) {
        return a.version.localeCompare(b.version, 'en');
      }
      return compareSemver(right, left);
    });
}

/**
 * Resolve one installed record. Without an explicit version this resolves the
 * enabled version when present, otherwise the newest installed version.
 */
export function resolveInstalled(
  state: ExtensionState,
  id: string,
  version?: string,
): InstalledExtensionRecord {
  const versions = installedVersions(state, id);
  if (versions.length === 0) {
    throw new ExtensionError(
      'SBE014',
      `extension "${id}" is not installed.`,
      `Install it first with \`specbridge extension install <source>\`.`,
      { extensionId: id },
    );
  }
  if (version !== undefined) {
    const match = versions.find((record) => record.version === version);
    if (match === undefined) {
      throw new ExtensionError(
        'SBE014',
        `extension "${id}" version ${version} is not installed (installed: ${versions
          .map((record) => record.version)
          .join(', ')}).`,
        'Pass one of the installed versions or install the requested version.',
        { extensionId: id, version },
      );
    }
    return match;
  }
  const enabledVersion = state.enabled[id]?.version;
  if (enabledVersion !== undefined) {
    const enabledRecord = versions.find((record) => record.version === enabledVersion);
    if (enabledRecord !== undefined) {
      return enabledRecord;
    }
  }
  const newest = versions[0];
  if (newest === undefined) {
    throw new ExtensionError(
      'SBE014',
      `extension "${id}" is not installed.`,
      'Install it first with `specbridge extension install <source>`.',
    );
  }
  return newest;
}

export function isEnabled(state: ExtensionState, id: string, version?: string): boolean {
  const enabled = state.enabled[id];
  if (enabled === undefined) {
    return false;
  }
  return version === undefined ? true : enabled.version === version;
}
