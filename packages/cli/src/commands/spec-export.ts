import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, SpecBridgeError, readSpecState } from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { ExporterInput } from '@specbridge/extension-sdk';
import {
  runExporterExtension,
  validateExportTargets,
  writeExportFiles,
} from '@specbridge/extensions';
import {
  createJsonReport,
  dim,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec export <name> --extension <id> --output <dir>` — export a
 * spec through an enabled exporter extension.
 *
 * The extension returns candidate files only. SpecBridge validates every
 * candidate path against the selected output directory, previews the plan,
 * never overwrites existing files, writes atomically only after explicit
 * confirmation (--yes), and records each export append-only.
 */
interface SpecExportOptions {
  extension?: string;
  output?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

export function registerSpecExportCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('export <name>')
    .description('Export a spec through an enabled exporter extension (candidate files, explicit confirmation)')
    .option('--extension <extension-id>', 'exporter extension to run (required)')
    .option('--output <directory>', 'output directory for exported files (required)')
    .option('--dry-run', 'preview candidate files without writing anything')
    .option('--yes', 'confirm writing the previewed files')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Exporter extensions never write files themselves: SpecBridge validates every
candidate path (no absolute paths, no traversal, no symlinked targets, no
overwrites) and writes atomically inside --output only after --yes.

Examples:
  ${CLI_BIN} spec export notification-preferences --extension example-exporter --output ./tmp/export --dry-run
  ${CLI_BIN} spec export notification-preferences --extension example-exporter --output ./tmp/export --yes`,
    )
    .action(async (name: string, options: SpecExportOptions) => {
      if (options.extension === undefined) {
        throw new SpecBridgeError('INVALID_ARGUMENT', 'Pass --extension <extension-id> to select an exporter.');
      }
      if (options.output === undefined) {
        throw new SpecBridgeError('INVALID_ARGUMENT', 'Pass --output <directory> to select where files go.');
      }
      if (options.dryRun === true && options.yes === true) {
        throw new SpecBridgeError('INVALID_ARGUMENT', '--dry-run conflicts with --yes; use one.');
      }

      const workspace = runtime.workspace();
      const folder = requireSpec(workspace, name);
      const spec = analyzeSpec(workspace, folder);
      const stateRead = readSpecState(workspace, folder.name);
      const outputDir = path.resolve(runtime.cwd, options.output);

      const stages: Record<string, string> = {};
      for (const file of folder.files) {
        if (file.kind === 'requirements' || file.kind === 'design' || file.kind === 'tasks' || file.kind === 'bugfix') {
          stages[file.kind] = readFileSync(path.join(folder.dir, file.fileName), 'utf8');
        }
      }
      const input: ExporterInput = {
        specName: folder.name,
        specType:
          stateRead.state?.specType ?? (spec.classification.type === 'bugfix' ? 'bugfix' : 'feature'),
        workflowMode: stateRead.state?.workflowMode ?? 'requirements-first',
        stages,
        metadata: { specbridgeVersion: VERSION },
      };

      const run = await runExporterExtension(workspace, options.extension, input);
      // Validate candidate targets before any preview claims they are safe.
      validateExportTargets(outputDir, run.files);

      const write = options.yes === true;
      const written = write
        ? writeExportFiles(
            workspace,
            run.extensionId,
            run.extensionVersion,
            folder.name,
            outputDir,
            run.files,
            () => runtime.now(),
          ).written
        : [];

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.spec-export/1', `${CLI_BIN} ${VERSION}`, {
              specName: folder.name,
              extensionId: run.extensionId,
              extensionVersion: run.extensionVersion,
              outputDir: options.output,
              dryRun: !write,
              files: run.files.map((file) => ({
                path: file.path,
                mediaType: file.mediaType,
                bytes: file.bytes,
              })),
              diagnostics: run.diagnostics,
              summary: run.summary ?? null,
              written,
            }),
          ),
        );
        return;
      }

      runtime.out(reportTitle(`Export: ${folder.name} via ${run.extensionId}@${run.extensionVersion}`));
      runtime.out();
      runtime.out(sectionTitle(`candidate files (${run.files.length})`));
      for (const file of run.files) {
        runtime.out(okLine(`${file.path}`, `(${file.mediaType}, ${file.bytes} bytes)`));
      }
      if (run.diagnostics.length > 0) {
        runtime.out();
        for (const diagnostic of run.diagnostics) {
          runtime.out(warnLine(`${diagnostic.ruleId}: ${diagnostic.message}`));
        }
      }
      runtime.out();
      if (write) {
        runtime.out(okLine(`wrote ${written.length} file${written.length === 1 ? '' : 's'} into ${options.output}`));
      } else {
        runtime.out(dim(`Nothing was written${options.dryRun === true ? ' (--dry-run)' : ''}.`));
        if (options.dryRun !== true) {
          runtime.out(dim(`Re-run with --yes to write these files into ${options.output}.`));
        }
      }
    });
}
