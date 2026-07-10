import type { Command } from 'commander';
import { CLI_BIN, hasErrors } from '@specbridge/core';
import { analyzeSpec, discoverSpecs } from '@specbridge/compat-kiro';
import {
  createJsonReport,
  dim,
  infoLine,
  renderColumns,
  reportTitle,
  serializeJsonReport,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

export function registerSpecListCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('list')
    .description('List specs in .kiro/specs with type, files, progress, and status')
    .option('--json', 'output JSON')
    .addHelpText(
      'after',
      `
Examples:
  ${CLI_BIN} spec list
  ${CLI_BIN} spec list --json`,
    )
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const analyses = discoverSpecs(workspace).map((folder) => analyzeSpec(workspace, folder));

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.spec-list/1', `${CLI_BIN} ${VERSION}`, {
              specs: analyses.map((analysis) => ({
                name: analysis.folder.name,
                dir: analysis.folder.dir,
                type: analysis.classification.type,
                workflowMode: analysis.classification.workflowMode,
                completeness: analysis.classification.completeness,
                files: analysis.folder.files.map((f) => ({ fileName: f.fileName, kind: f.kind })),
                taskProgress: analysis.taskProgress,
                sidecarStatus: analysis.state?.status ?? null,
                diagnostics: analysis.diagnostics,
              })),
            }),
          ),
        );
        return;
      }

      if (analyses.length === 0) {
        runtime.out(infoLine('No specs found under .kiro/specs.'));
        runtime.out(dim(`  Create one in Kiro, or add .kiro/specs/<name>/requirements.md by hand.`));
        return;
      }

      runtime.out(reportTitle(`Specs (${analyses.length})`));
      runtime.out();
      const rows: string[][] = [['', 'NAME', 'TYPE', 'WORKFLOW', 'FILES', 'TASKS', 'STATE']];
      for (const analysis of analyses) {
        const marker = hasErrors(analysis.diagnostics)
          ? '✗'
          : analysis.classification.completeness === 'complete'
            ? '✓'
            : '!';
        const files =
          analysis.classification.presentKinds.length > 0
            ? analysis.classification.presentKinds.join(', ')
            : '(none)';
        const p = analysis.taskProgress;
        const tasksCell =
          analysis.tasks !== undefined
            ? `${p.completed}/${p.total}${p.optionalTotal > 0 ? `+${p.optionalTotal}o` : ''}`
            : '—';
        rows.push([
          marker,
          analysis.folder.name,
          analysis.classification.type,
          analysis.classification.workflowMode,
          files,
          tasksCell,
          analysis.state?.status ?? '—',
        ]);
      }
      for (const line of renderColumns(rows)) runtime.out(line);
      runtime.out();
      runtime.out(dim(`  ✓ complete   ! partial/empty   ✗ has errors — details: ${CLI_BIN} spec show <name>`));
    });
}
