import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { assertInsideWorkspace, writeFileAtomic, type WorkspaceInfo } from '@specbridge/core';
import type { ExtensionValidationIssue } from '@specbridge/extension-sdk';
import { extractZipArchive } from './archive.js';
import { sha256HexOf } from './checksums.js';
import { ExtensionError } from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import {
  loadExtensionPackage,
  readExtensionPackageDirectory,
  type ExtensionPackageValidation,
} from './manifest-loader.js';
import {
  appendExtensionRecord,
  extensionsDir,
  installedVersionDir,
  newExtensionRecordId,
  readExtensionState,
  systemClock,
  writeExtensionState,
  type Clock,
} from './state.js';

/**
 * Local extension installation.
 *
 * Installation never executes extension code, never runs lifecycle scripts,
 * verifies archive and per-file checksums, writes into a versioned directory
 * atomically (staging directory + rename), revalidates the installed files,
 * and always leaves the extension disabled.
 */
export interface InstallExtensionOptions {
  readonly workspace: WorkspaceInfo;
  /** Recorded provenance, e.g. `local-directory:./demo` or `registry:community`. */
  readonly sourceLabel: string;
  readonly dryRun?: boolean;
  readonly clock?: Clock;
  readonly specbridgeVersion?: string;
  /** SHA-256 the archive bytes must match (registry installs). */
  readonly expectedArchiveSha256?: string;
}

export interface InstallExtensionResult {
  readonly id: string;
  readonly version: string;
  readonly kind: string;
  readonly displayName: string;
  readonly manifestSha256: string;
  readonly permissionHash: string;
  readonly archiveSha256?: string;
  readonly installedPath?: string;
  readonly warnings: readonly ExtensionValidationIssue[];
  readonly dryRun: boolean;
}

function requireValid(validation: ExtensionPackageValidation): asserts validation is ExtensionPackageValidation & {
  manifest: NonNullable<ExtensionPackageValidation['manifest']>;
  manifestSha256: string;
  permissionHash: string;
} {
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0 || validation.manifest === undefined) {
    const first = errors[0];
    throw new ExtensionError(
      'SBE008',
      `extension package failed validation with ${errors.length} error(s); first: ` +
        `[${first?.code ?? 'SBE008'}] ${first?.message ?? 'invalid package'}.`,
      'Run `specbridge extension validate <source>` for the full report.',
      { issueCount: errors.length },
    );
  }
}

export function installExtensionFromDirectory(
  sourceDir: string,
  options: InstallExtensionOptions,
): InstallExtensionResult {
  const files = readExtensionPackageDirectory(sourceDir);
  return installExtensionPackage(files, options);
}

export function installExtensionFromArchive(
  archivePath: string,
  options: InstallExtensionOptions,
): InstallExtensionResult {
  let archive: Buffer;
  try {
    archive = readFileSync(archivePath);
  } catch (cause) {
    throw new ExtensionError(
      'SBE008',
      `archive "${archivePath}" could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`,
      'Check the path and try again.',
    );
  }
  return installExtensionFromArchiveBytes(archive, options);
}

export function installExtensionFromArchiveBytes(
  archive: Buffer,
  options: InstallExtensionOptions,
): InstallExtensionResult {
  if (archive.length > EXTENSION_LIMITS.maxArchiveBytes) {
    throw new ExtensionError(
      'SBE008',
      `archive of ${archive.length} bytes exceeds the ${EXTENSION_LIMITS.maxArchiveBytes} byte limit.`,
      'Reduce the package contents.',
    );
  }
  const archiveSha256 = sha256HexOf(archive);
  if (
    options.expectedArchiveSha256 !== undefined &&
    options.expectedArchiveSha256.toLowerCase() !== archiveSha256
  ) {
    throw new ExtensionError(
      'SBE009',
      `archive sha256 ${archiveSha256} does not match the expected ` +
        `${options.expectedArchiveSha256.toLowerCase()}.`,
      'The archive was corrupted or substituted; re-download it from a trusted source.',
    );
  }
  const files = extractZipArchive(archive);
  return installExtensionPackage(files, options, archiveSha256);
}

export function installExtensionPackage(
  files: ReadonlyMap<string, Buffer>,
  options: InstallExtensionOptions,
  archiveSha256?: string,
): InstallExtensionResult {
  const clock = options.clock ?? systemClock;
  const validation = loadExtensionPackage(
    files,
    options.specbridgeVersion === undefined ? {} : { specbridgeVersion: options.specbridgeVersion },
  );
  requireValid(validation);
  const manifest = validation.manifest;
  const warnings = validation.issues.filter((issue) => issue.severity === 'warning');

  const workspace = options.workspace;
  const { state } = readExtensionState(workspace);
  const alreadyInstalled = state.installed.some(
    (record) => record.id === manifest.id && record.version === manifest.version,
  );
  if (alreadyInstalled) {
    throw new ExtensionError(
      'SBE013',
      `extension "${manifest.id}" version ${manifest.version} is already installed.`,
      'Bump the extension version or uninstall the existing version first.',
      { extensionId: manifest.id, version: manifest.version },
    );
  }

  const targetDir = installedVersionDir(workspace, manifest.id, manifest.version);

  const base: Omit<InstallExtensionResult, 'installedPath' | 'dryRun'> = {
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    displayName: manifest.displayName,
    manifestSha256: validation.manifestSha256,
    permissionHash: validation.permissionHash,
    ...(archiveSha256 === undefined ? {} : { archiveSha256 }),
    warnings,
  };

  if (options.dryRun === true) {
    return { ...base, dryRun: true };
  }

  const recordId = newExtensionRecordId(clock);
  const stagingDir = path.join(extensionsDir(workspace), `tmp-install-${recordId}`);
  assertInsideWorkspace(workspace.rootDir, stagingDir);

  try {
    for (const [name, content] of files) {
      const target = path.join(stagingDir, ...name.split('/'));
      assertInsideWorkspace(workspace.rootDir, target);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, content);
    }
    mkdirSync(path.dirname(targetDir), { recursive: true });
    renameSync(stagingDir, targetDir);
  } catch (cause) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (cause instanceof ExtensionError) {
      throw cause;
    }
    throw new ExtensionError(
      'SBE030',
      `installation failed while writing files: ${cause instanceof Error ? cause.message : String(cause)}.`,
      'Nothing was installed; fix the underlying problem and retry.',
    );
  }

  try {
    // Revalidate the installed artifact as an independent copy.
    const installedFiles = readExtensionPackageDirectory(targetDir);
    const revalidated = loadExtensionPackage(
      installedFiles,
      options.specbridgeVersion === undefined ? {} : { specbridgeVersion: options.specbridgeVersion },
    );
    requireValid(revalidated);

    const nextState = {
      ...state,
      installed: [
        ...state.installed,
        {
          id: manifest.id,
          version: manifest.version,
          kind: manifest.kind,
          displayName: manifest.displayName,
          description: manifest.description,
          source: options.sourceLabel,
          installedAt: clock().toISOString(),
          ...(archiveSha256 === undefined ? {} : { archiveSha256 }),
          manifestSha256: validation.manifestSha256,
          permissionHash: validation.permissionHash,
          ...(manifest.entrypoint === undefined ? {} : { entrypoint: manifest.entrypoint }),
          installRecordId: recordId,
        },
      ],
    };
    writeExtensionState(workspace, nextState);
    appendExtensionRecord(workspace, {
      schemaVersion: '1.0.0',
      recordId,
      type: 'install',
      at: clock().toISOString(),
      extensionId: manifest.id,
      version: manifest.version,
      details: {
        source: options.sourceLabel,
        manifestSha256: validation.manifestSha256,
        permissionHash: validation.permissionHash,
        ...(archiveSha256 === undefined ? {} : { archiveSha256 }),
      },
    });
  } catch (cause) {
    rmSync(targetDir, { recursive: true, force: true });
    if (cause instanceof ExtensionError) {
      throw cause;
    }
    throw new ExtensionError(
      'SBE030',
      `installation failed while recording state: ${cause instanceof Error ? cause.message : String(cause)}.`,
      'The partially installed version was removed; retry the installation.',
    );
  }

  return { ...base, installedPath: targetDir, dryRun: false };
}
