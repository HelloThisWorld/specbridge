import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@specbridge/core';
import type { ExtensionValidationIssue } from '@specbridge/extension-sdk';
import { createDeterministicZip, extractZipArchive, EXTENSION_ARCHIVE_SUFFIX } from './archive.js';
import {
  computeExtensionChecksums,
  EXTENSION_CHECKSUMS_FILE_NAME,
  sha256HexOf,
} from './checksums.js';
import { ExtensionError } from './errors.js';
import { loadExtensionPackage, readExtensionPackageDirectory } from './manifest-loader.js';

/**
 * `specbridge extension package` — deterministic archive creation.
 *
 * Packaging never runs lifecycle scripts and requires the entrypoint to be
 * built already. Only runtime files enter the archive (manifest, README,
 * LICENSE, NOTICE.md, dist/, templates/, schemas/, examples/); development
 * files (src/, test/, package.json, configs) stay out. Checksums are
 * regenerated over the exact archived bytes, the archive is store-method
 * with fixed timestamps and sorted entries (byte-identical for identical
 * inputs), and the result is re-extracted and revalidated before the SHA-256
 * is reported. No signature is created — the hash proves integrity only.
 */
const RUNTIME_ROOT_FILES = new Set([
  'specbridge-extension.json',
  'README.md',
  'LICENSE',
  'NOTICE.md',
]);
const RUNTIME_DIRECTORIES = ['dist/', 'templates/', 'schemas/', 'examples/'];

function isRuntimeFile(name: string): boolean {
  if (name.endsWith('.zip')) {
    return false; // never re-pack previously built archives from dist/
  }
  if (RUNTIME_ROOT_FILES.has(name)) {
    return true;
  }
  return RUNTIME_DIRECTORIES.some((directory) => name.startsWith(directory));
}

export interface BuildArchiveOptions {
  /** Directory the archive is written into (default: `<source>/dist`). */
  readonly outputDir?: string;
  readonly dryRun?: boolean;
}

export interface BuildArchiveResult {
  readonly id: string;
  readonly version: string;
  readonly kind: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly fileCount: number;
  readonly archiveBytes: number;
  readonly warnings: readonly ExtensionValidationIssue[];
  readonly dryRun: boolean;
}

export function buildExtensionArchive(
  sourceDir: string,
  options: BuildArchiveOptions = {},
): BuildArchiveResult {
  const allFiles = readExtensionPackageDirectory(sourceDir);
  const runtimeFiles = new Map<string, Buffer>();
  for (const [name, content] of allFiles) {
    if (isRuntimeFile(name) && name !== EXTENSION_CHECKSUMS_FILE_NAME) {
      runtimeFiles.set(name, content);
    }
  }

  // Regenerate checksums over the exact bytes entering the archive.
  const checksums = computeExtensionChecksums(runtimeFiles);
  runtimeFiles.set(
    EXTENSION_CHECKSUMS_FILE_NAME,
    Buffer.from(`${JSON.stringify(checksums, null, 2)}\n`, 'utf8'),
  );

  const validation = loadExtensionPackage(runtimeFiles);
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0 || validation.manifest === undefined) {
    const first = errors[0];
    throw new ExtensionError(
      'SBE008',
      `the package failed validation with ${errors.length} error(s); first: ` +
        `[${first?.code ?? 'SBE008'}] ${first?.message ?? 'invalid package'}.`,
      'Run `specbridge extension validate <dir>` for the full report; ' +
        'executable extensions must already contain their built entrypoint.',
    );
  }
  const manifest = validation.manifest;

  const archive = createDeterministicZip(runtimeFiles);
  const archiveSha256 = sha256HexOf(archive);
  const outputDir = options.outputDir ?? path.join(sourceDir, 'dist');
  const archivePath = path.join(
    outputDir,
    `${manifest.id}-${manifest.version}${EXTENSION_ARCHIVE_SUFFIX}`,
  );

  // Prove the archive round-trips before anything is written or reported.
  const reextracted = extractZipArchive(archive);
  const revalidated = loadExtensionPackage(reextracted);
  if (!revalidated.valid) {
    throw new ExtensionError(
      'SBE008',
      'the built archive failed revalidation after extraction.',
      'This indicates a packaging bug; please report it.',
    );
  }

  if (options.dryRun !== true) {
    mkdirSync(outputDir, { recursive: true });
    writeFileAtomic(archivePath, archive);
  }

  return {
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    archivePath,
    archiveSha256,
    fileCount: runtimeFiles.size,
    archiveBytes: archive.length,
    warnings: validation.issues.filter((issue) => issue.severity === 'warning'),
    dryRun: options.dryRun === true,
  };
}
