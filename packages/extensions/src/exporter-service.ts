import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, type WorkspaceInfo } from '@specbridge/core';
import {
  exporterInputSchema,
  exporterResultSchema,
  namespaceRuleId,
  type ExporterFile,
  type ExporterInput,
} from '@specbridge/extension-sdk';
import { requireEnabledExtension } from './enablement.js';
import { ExtensionError } from './errors.js';
import { checkPackageRelativePath } from './paths.js';
import { invokeExtensionOperation } from './protocol-client.js';
import { appendExtensionRecord, newExtensionRecordId, systemClock, type Clock } from './state.js';

/**
 * Exporter extension invocation.
 *
 * Exporters return *candidate* files only. SpecBridge validates every
 * candidate path against the explicitly selected output directory, previews
 * before writing, refuses to overwrite existing files, writes atomically
 * only after explicit confirmation, and records each export append-only.
 * The extension process never receives write access to the target.
 */
export interface ExtensionExportCandidate {
  readonly path: string;
  readonly mediaType: string;
  readonly content: string;
  readonly bytes: number;
}

export interface ExtensionExportRun {
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly files: readonly ExtensionExportCandidate[];
  readonly diagnostics: readonly { ruleId: string; severity: string; message: string }[];
  readonly summary?: string;
  readonly durationMs: number;
}

export interface RunExporterOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly configuration?: Record<string, unknown>;
}

export async function runExporterExtension(
  workspace: WorkspaceInfo,
  extensionId: string,
  input: ExporterInput,
  options: RunExporterOptions = {},
): Promise<ExtensionExportRun> {
  const enabled = requireEnabledExtension(workspace, extensionId);
  if (enabled.manifest.kind !== 'exporter') {
    throw new ExtensionError(
      'SBE021',
      `extension "${extensionId}" is a ${enabled.manifest.kind} extension, not an exporter.`,
      'Pass an exporter extension to --extension.',
      { extensionId, kind: enabled.manifest.kind },
    );
  }

  const bounded = exporterInputSchema.parse(input);
  const outcome = await invokeExtensionOperation(enabled, {
    operation: 'exporter.export',
    payload: bounded,
    ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });

  const result = exporterResultSchema.parse(outcome.output);
  return {
    extensionId: enabled.manifest.id,
    extensionVersion: enabled.manifest.version,
    files: result.files.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      content: file.content,
      bytes: Buffer.byteLength(file.content, 'utf8'),
    })),
    diagnostics: (result.diagnostics ?? []).map((diagnostic) => ({
      ruleId: namespaceRuleId(enabled.manifest.id, diagnostic.ruleId),
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    durationMs: outcome.durationMs,
  };
}

/**
 * Validate candidate targets against the selected output directory:
 * schema-safe relative paths (the SDK already rejects traversal and absolute
 * paths), no resolution outside the directory, no symlinked path components,
 * and no overwriting of existing files.
 */
export function validateExportTargets(
  outputDir: string,
  files: readonly Pick<ExporterFile, 'path'>[],
): { target: string; relative: string }[] {
  const resolvedRoot = path.resolve(outputDir);
  const rootStat = lstatSync(resolvedRoot, { throwIfNoEntry: false });
  if (rootStat !== undefined && rootStat.isSymbolicLink()) {
    throw new ExtensionError(
      'SBE011',
      `output directory "${outputDir}" is a symbolic link.`,
      'Pass a plain directory as --output.',
    );
  }
  const seen = new Set<string>();
  const targets: { target: string; relative: string }[] = [];
  for (const file of files) {
    const problem = checkPackageRelativePath(file.path);
    if (problem !== undefined) {
      throw new ExtensionError(
        'SBE030',
        `exporter returned an unsafe output path "${file.path}": ${problem}.`,
        'Report this to the extension author; nothing was written.',
      );
    }
    const target = path.resolve(resolvedRoot, ...file.path.split('/'));
    const relative = path.relative(resolvedRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ExtensionError(
        'SBE030',
        `exporter output path "${file.path}" escapes the output directory.`,
        'Report this to the extension author; nothing was written.',
      );
    }
    if (seen.has(target.toLowerCase())) {
      throw new ExtensionError(
        'SBE030',
        `exporter returned duplicate output path "${file.path}".`,
        'Report this to the extension author; nothing was written.',
      );
    }
    seen.add(target.toLowerCase());

    // Refuse symlinked components between the output root and the target.
    let current = resolvedRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() === true) {
        throw new ExtensionError(
          'SBE011',
          `export target path component "${segment}" is a symbolic link.`,
          'Remove the symlink from the output directory and retry.',
        );
      }
    }
    if (existsSync(target)) {
      throw new ExtensionError(
        'SBE030',
        `export target "${file.path}" already exists in the output directory.`,
        'SpecBridge never overwrites existing files on export; choose an empty directory.',
      );
    }
    targets.push({ target, relative: file.path });
  }
  return targets;
}

/** Write confirmed candidates atomically and record the export run. */
export function writeExportFiles(
  workspace: WorkspaceInfo,
  extensionId: string,
  extensionVersion: string,
  specName: string,
  outputDir: string,
  files: readonly ExtensionExportCandidate[],
  clock: Clock = systemClock,
): { written: string[] } {
  const targets = validateExportTargets(outputDir, files);
  const written: string[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const file = files[index];
    if (target === undefined || file === undefined) {
      continue;
    }
    mkdirSync(path.dirname(target.target), { recursive: true });
    writeFileAtomic(target.target, file.content);
    written.push(target.relative);
  }
  appendExtensionRecord(workspace, {
    schemaVersion: '1.0.0',
    recordId: newExtensionRecordId(clock),
    type: 'export',
    at: clock().toISOString(),
    extensionId,
    version: extensionVersion,
    details: { specName, outputDir, files: written },
  });
  return { written };
}
