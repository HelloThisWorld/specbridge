import type { Command } from 'commander';
import { CLI_BIN } from '@specbridge/core';
import { listSteeringFiles, listUnknownSteeringEntries } from '@specbridge/compat-kiro';
import {
  createJsonReport,
  dim,
  infoLine,
  renderColumns,
  reportTitle,
  serializeJsonReport,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { formatBytes } from '../context.js';
import { VERSION } from '../version.js';

export function registerSteeringListCommand(steering: Command, runtime: CliRuntime): void {
  steering
    .command('list')
    .description('List steering files in .kiro/steering')
    .option('--json', 'output JSON')
    .addHelpText(
      'after',
      `
Examples:
  ${CLI_BIN} steering list
  ${CLI_BIN} steering list --json`,
    )
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const files = listSteeringFiles(workspace);
      const unknown = listUnknownSteeringEntries(workspace);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.steering-list/1', `${CLI_BIN} ${VERSION}`, {
              steering: files.map((f) => ({
                name: f.name,
                fileName: f.fileName,
                path: f.path,
                isDefault: f.isDefault,
                inclusion: f.inclusion,
                fileMatchPattern: f.fileMatchPattern ?? null,
                sizeBytes: f.sizeBytes,
              })),
              unknownEntries: unknown,
            }),
          ),
        );
        return;
      }

      if (files.length === 0) {
        runtime.out(infoLine('No steering files found (.kiro/steering is missing or empty).'));
        runtime.out(dim('  Steering is optional; Kiro projects typically have product.md, tech.md, and structure.md.'));
        return;
      }

      runtime.out(reportTitle(`Steering files (${files.length})`));
      runtime.out();
      const rows = files.map((f) => [
        f.name,
        f.isDefault ? 'default' : 'additional',
        f.inclusion + (f.fileMatchPattern !== undefined ? ` (${f.fileMatchPattern})` : ''),
        formatBytes(f.sizeBytes),
      ]);
      for (const line of renderColumns(rows)) runtime.out(line);
      if (unknown.length > 0) {
        runtime.out();
        runtime.out(infoLine(`Ignored non-Markdown entries: ${unknown.join(', ')}`));
      }
    });
}
