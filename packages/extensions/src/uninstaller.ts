import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { assertInsideWorkspace, type WorkspaceInfo } from '@specbridge/core';
import { ExtensionError } from './errors.js';
import {
  appendExtensionRecord,
  extensionsDir,
  installedVersionDir,
  installedVersions,
  isEnabled,
  newExtensionRecordId,
  readExtensionState,
  readPermissionGrants,
  systemClock,
  writeExtensionState,
  writePermissionGrants,
  type Clock,
} from './state.js';

/**
 * Uninstall one installed extension version.
 *
 * The extension must be disabled first, runner profiles referencing it block
 * the operation, run records and generated files always remain, and deletion
 * is recoverable: the installed directory is moved into
 * `.specbridge/extensions/trash/` instead of being destroyed.
 */
export interface UninstallExtensionOptions {
  readonly workspace: WorkspaceInfo;
  readonly id: string;
  readonly version?: string;
  readonly dryRun?: boolean;
  readonly clock?: Clock;
  /** Names of runner profiles that reference this extension (caller-computed). */
  readonly referencingProfiles?: readonly string[];
}

export interface UninstallExtensionResult {
  readonly id: string;
  readonly version: string;
  readonly removedPath: string;
  readonly trashPath?: string;
  readonly dryRun: boolean;
}

export function uninstallExtension(options: UninstallExtensionOptions): UninstallExtensionResult {
  const clock = options.clock ?? systemClock;
  const workspace = options.workspace;
  const { state } = readExtensionState(workspace);

  const versions = installedVersions(state, options.id);
  if (versions.length === 0) {
    throw new ExtensionError(
      'SBE014',
      `extension "${options.id}" is not installed.`,
      'Nothing to uninstall.',
      { extensionId: options.id },
    );
  }
  let version = options.version;
  if (version === undefined) {
    if (versions.length > 1) {
      throw new ExtensionError(
        'SBE002',
        `extension "${options.id}" has ${versions.length} installed versions ` +
          `(${versions.map((record) => record.version).join(', ')}).`,
        'Pass --version <version> to select the version to uninstall.',
        { extensionId: options.id },
      );
    }
    version = versions[0]?.version ?? '';
  }
  const record = versions.find((candidate) => candidate.version === version);
  if (record === undefined) {
    throw new ExtensionError(
      'SBE014',
      `extension "${options.id}" version ${version} is not installed.`,
      `Installed versions: ${versions.map((candidate) => candidate.version).join(', ')}.`,
      { extensionId: options.id, version },
    );
  }

  if (isEnabled(state, options.id, version)) {
    throw new ExtensionError(
      'SBE028',
      `extension "${options.id}@${version}" is currently enabled.`,
      `Disable it first with \`specbridge extension disable ${options.id}\`.`,
      { extensionId: options.id, version },
    );
  }
  if (options.referencingProfiles !== undefined && options.referencingProfiles.length > 0) {
    throw new ExtensionError(
      'SBE029',
      `runner profile(s) ${options.referencingProfiles.map((name) => `"${name}"`).join(', ')} ` +
        `reference extension "${options.id}".`,
      'Remove or repoint those profiles in .specbridge/config.json first.',
      { extensionId: options.id, profiles: [...options.referencingProfiles] },
    );
  }

  const installedDir = installedVersionDir(workspace, options.id, version);
  const stat = lstatSync(installedDir, { throwIfNoEntry: false });
  if (stat !== undefined && stat.isSymbolicLink()) {
    throw new ExtensionError(
      'SBE011',
      `installed path "${installedDir}" is a symbolic link.`,
      'Refusing to remove through a symlink; inspect the extension store manually.',
    );
  }

  if (options.dryRun === true) {
    return { id: options.id, version, removedPath: installedDir, dryRun: true };
  }

  const recordId = newExtensionRecordId(clock);
  let trashPath: string | undefined;
  if (stat !== undefined) {
    const trashDir = path.join(extensionsDir(workspace), 'trash');
    trashPath = path.join(trashDir, `${options.id}-${version}-${recordId}`);
    assertInsideWorkspace(workspace.rootDir, trashPath);
    mkdirSync(trashDir, { recursive: true });
    renameSync(installedDir, trashPath);
  }

  writeExtensionState(workspace, {
    ...state,
    installed: state.installed.filter(
      (candidate) => !(candidate.id === options.id && candidate.version === version),
    ),
  });

  const { grants } = readPermissionGrants(workspace);
  const grant = grants.grants[options.id];
  if (grant !== undefined && grant.version === version) {
    const nextGrants = { ...grants.grants };
    delete nextGrants[options.id];
    writePermissionGrants(workspace, { ...grants, grants: nextGrants });
  }

  appendExtensionRecord(workspace, {
    schemaVersion: '1.0.0',
    recordId,
    type: 'uninstall',
    at: clock().toISOString(),
    extensionId: options.id,
    version,
    details: trashPath === undefined ? {} : { trashPath },
  });

  return trashPath === undefined
    ? { id: options.id, version, removedPath: installedDir, dryRun: false }
    : { id: options.id, version, removedPath: installedDir, trashPath, dryRun: false };
}
