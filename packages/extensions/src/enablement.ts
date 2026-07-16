import type { WorkspaceInfo } from '@specbridge/core';
import {
  describePermissions,
  type ExtensionManifest,
  type ExtensionPermissions,
} from '@specbridge/extension-sdk';
import { ExtensionError } from './errors.js';
import { loadExtensionPackage, readExtensionPackageDirectory } from './manifest-loader.js';
import {
  appendExtensionRecord,
  installedVersionDir,
  isEnabled,
  newExtensionRecordId,
  readExtensionState,
  readPermissionGrants,
  resolveInstalled,
  systemClock,
  writeExtensionState,
  writePermissionGrants,
  type Clock,
  type InstalledExtensionRecord,
} from './state.js';

/**
 * Explicit enablement with manifest-bound permission acceptance.
 *
 * Installed extensions start disabled. Enabling revalidates the installed
 * package, recomputes the permission hash from the manifest bytes on disk,
 * and requires the caller to pass exactly that hash. Any manifest change —
 * including a version or permission change — produces a different hash and
 * therefore invalidates prior acceptance.
 */
export interface EnablementPreview {
  readonly record: InstalledExtensionRecord;
  readonly manifest: ExtensionManifest;
  readonly permissions: ExtensionPermissions;
  readonly permissionLines: readonly string[];
  readonly permissionHash: string;
  readonly manifestSha256: string;
  readonly enabled: boolean;
  /** Whether a stored grant matches the current permission hash. */
  readonly grantStatus: 'none' | 'current' | 'stale';
}

/** Revalidate an installed version and describe what enabling would accept. */
export function describeEnablement(
  workspace: WorkspaceInfo,
  id: string,
  version?: string,
): EnablementPreview {
  const { state } = readExtensionState(workspace);
  const record = resolveInstalled(state, id, version);
  const dir = installedVersionDir(workspace, record.id, record.version);
  const files = readExtensionPackageDirectory(dir);
  const validation = loadExtensionPackage(files);
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0 || validation.manifest === undefined || validation.permissionHash === undefined || validation.manifestSha256 === undefined) {
    const first = errors[0];
    throw new ExtensionError(
      'SBE008',
      `installed extension "${record.id}@${record.version}" failed integrity validation` +
        `${first === undefined ? '' : `: [${first.code}] ${first.message}`}.`,
      'Uninstall and reinstall the extension from a trusted source.',
      { extensionId: record.id, version: record.version },
    );
  }
  const { grants } = readPermissionGrants(workspace);
  const grant = grants.grants[record.id];
  const grantStatus =
    grant === undefined ? 'none' : grant.permissionHash === validation.permissionHash ? 'current' : 'stale';
  return {
    record,
    manifest: validation.manifest,
    permissions: validation.manifest.permissions,
    permissionLines: describePermissions(validation.manifest.permissions),
    permissionHash: validation.permissionHash,
    manifestSha256: validation.manifestSha256,
    enabled: isEnabled(state, record.id, record.version),
    grantStatus,
  };
}

export interface EnableExtensionOptions {
  readonly workspace: WorkspaceInfo;
  readonly id: string;
  readonly version?: string;
  /** Must equal the current permission hash exactly. */
  readonly acceptPermissions: string;
  readonly clock?: Clock;
  /**
   * Optional executable probe (handshake / conformance) run before the grant
   * is stored. Injected by the caller so state logic stays process-free.
   */
  readonly probe?: (preview: EnablementPreview, installedDir: string) => Promise<void>;
}

export interface EnableExtensionResult {
  readonly id: string;
  readonly version: string;
  readonly permissionHash: string;
  readonly preview: EnablementPreview;
}

export async function enableExtension(options: EnableExtensionOptions): Promise<EnableExtensionResult> {
  const clock = options.clock ?? systemClock;
  const workspace = options.workspace;
  const preview = describeEnablement(workspace, options.id, options.version);

  if (options.acceptPermissions !== preview.permissionHash) {
    throw new ExtensionError(
      'SBE017',
      `the acceptance hash does not match the current permission hash for ` +
        `"${preview.record.id}@${preview.record.version}".`,
      `Review the permissions with \`specbridge extension show ${preview.record.id}\` and re-run ` +
        `with --accept-permissions ${preview.permissionHash}.`,
      { expected: preview.permissionHash },
    );
  }

  if (options.probe !== undefined) {
    const dir = installedVersionDir(workspace, preview.record.id, preview.record.version);
    await options.probe(preview, dir);
  }

  const { grants } = readPermissionGrants(workspace);
  writePermissionGrants(workspace, {
    ...grants,
    grants: {
      ...grants.grants,
      [preview.record.id]: {
        version: preview.record.version,
        manifestSha256: preview.manifestSha256,
        permissionHash: preview.permissionHash,
        acceptedAt: clock().toISOString(),
      },
    },
  });

  const { state } = readExtensionState(workspace);
  writeExtensionState(workspace, {
    ...state,
    enabled: { ...state.enabled, [preview.record.id]: { version: preview.record.version } },
  });

  appendExtensionRecord(workspace, {
    schemaVersion: '1.0.0',
    recordId: newExtensionRecordId(clock),
    type: 'enable',
    at: clock().toISOString(),
    extensionId: preview.record.id,
    version: preview.record.version,
    details: { permissionHash: preview.permissionHash },
  });

  return {
    id: preview.record.id,
    version: preview.record.version,
    permissionHash: preview.permissionHash,
    preview,
  };
}

export interface DisableExtensionOptions {
  readonly workspace: WorkspaceInfo;
  readonly id: string;
  readonly clock?: Clock;
}

export function disableExtension(options: DisableExtensionOptions): { id: string; version: string } {
  const clock = options.clock ?? systemClock;
  const { state } = readExtensionState(options.workspace);
  const enabled = state.enabled[options.id];
  if (enabled === undefined) {
    throw new ExtensionError(
      'SBE015',
      `extension "${options.id}" is not enabled.`,
      'Nothing to disable; run `specbridge extension list` to see enablement state.',
      { extensionId: options.id },
    );
  }
  const nextEnabled = { ...state.enabled };
  delete nextEnabled[options.id];
  writeExtensionState(options.workspace, { ...state, enabled: nextEnabled });
  appendExtensionRecord(options.workspace, {
    schemaVersion: '1.0.0',
    recordId: newExtensionRecordId(clock),
    type: 'disable',
    at: clock().toISOString(),
    extensionId: options.id,
    version: enabled.version,
  });
  return { id: options.id, version: enabled.version };
}

/**
 * Resolve an installed, enabled, grant-valid extension for invocation.
 * This is the single gate every runtime invocation path goes through.
 */
export interface EnabledExtension {
  readonly record: InstalledExtensionRecord;
  readonly manifest: ExtensionManifest;
  readonly installedDir: string;
  readonly permissionHash: string;
  readonly manifestSha256: string;
}

export function requireEnabledExtension(workspace: WorkspaceInfo, id: string): EnabledExtension {
  const { state } = readExtensionState(workspace);
  const enabled = state.enabled[id];
  if (enabled === undefined) {
    const installed = state.installed.some((record) => record.id === id);
    if (!installed) {
      throw new ExtensionError(
        'SBE001',
        `extension "${id}" is not installed.`,
        'Install it with `specbridge extension install <source>` and enable it explicitly.',
        { extensionId: id },
      );
    }
    throw new ExtensionError(
      'SBE015',
      `extension "${id}" is installed but disabled.`,
      `Enable it with \`specbridge extension enable ${id} --accept-permissions <hash>\`.`,
      { extensionId: id },
    );
  }
  const preview = describeEnablement(workspace, id, enabled.version);
  const { grants } = readPermissionGrants(workspace);
  const grant = grants.grants[id];
  if (grant === undefined) {
    throw new ExtensionError(
      'SBE016',
      `extension "${id}" has no stored permission grant.`,
      `Re-enable it with \`specbridge extension enable ${id} --accept-permissions ${preview.permissionHash}\`.`,
      { extensionId: id },
    );
  }
  if (grant.permissionHash !== preview.permissionHash || grant.version !== enabled.version) {
    throw new ExtensionError(
      'SBE018',
      `the stored permission grant for "${id}" no longer matches the installed extension ` +
        '(the manifest, version, or permissions changed after acceptance).',
      `Review the permissions and re-enable with \`specbridge extension enable ${id} ` +
        `--accept-permissions ${preview.permissionHash}\`.`,
      { extensionId: id },
    );
  }
  return {
    record: preview.record,
    manifest: preview.manifest,
    installedDir: installedVersionDir(workspace, preview.record.id, preview.record.version),
    permissionHash: preview.permissionHash,
    manifestSha256: preview.manifestSha256,
  };
}
