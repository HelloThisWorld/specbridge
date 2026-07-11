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
import { loadWorkflowView } from '../workflow-view.js';
import { VERSION } from '../version.js';

export function registerSpecListCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('list')
    .description('List specs with type, workflow mode, files, progress, and approval health')
    .option('--json', 'output JSON')
    .addHelpText(
      'after',
      `
STATUS shows the effective workflow status: the recorded status, or
STALE_APPROVAL when an approved file changed after approval, or "unmanaged"
for specs without SpecBridge sidecar state (normal for Kiro-only projects).

Examples:
  ${CLI_BIN} spec list
  ${CLI_BIN} spec list --json`,
    )
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const entries = discoverSpecs(workspace).map((folder) => {
        const analysis = analyzeSpec(workspace, folder);
        const view = loadWorkflowView(workspace, folder.name);
        return { analysis, view };
      });

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.spec-list/1', `${CLI_BIN} ${VERSION}`, {
              specs: entries.map(({ analysis, view }) => ({
                name: analysis.folder.name,
                dir: analysis.folder.dir,
                type: analysis.classification.type,
                workflowMode: analysis.classification.workflowMode,
                completeness: analysis.classification.completeness,
                files: analysis.folder.files.map((f) => ({ fileName: f.fileName, kind: f.kind })),
                taskProgress: analysis.taskProgress,
                managed: view.evaluation !== undefined,
                approvalHealth: view.health,
                workflowStatus: view.evaluation?.storedStatus ?? null,
                effectiveStatus: view.displayStatus,
                staleStages: view.evaluation?.staleStages ?? [],
                sidecarStatus: view.stateRead.state?.status ?? null,
                diagnostics: analysis.diagnostics,
              })),
            }),
          ),
        );
        return;
      }

      if (entries.length === 0) {
        runtime.out(infoLine('No specs found under .kiro/specs.'));
        runtime.out(dim(`  Create one with "${CLI_BIN} spec new <name>", in Kiro, or by hand.`));
        return;
      }

      runtime.out(reportTitle(`Specs (${entries.length})`));
      runtime.out();
      const rows: string[][] = [['', 'NAME', 'TYPE', 'MODE', 'FILES', 'TASKS', 'STATUS']];
      for (const { analysis, view } of entries) {
        const stale = view.health === 'stale';
        const marker = hasErrors(analysis.diagnostics)
          ? '✗'
          : stale
            ? '!'
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
        const mode = view.stateRead.state?.workflowMode ?? analysis.classification.workflowMode;
        rows.push([
          marker,
          analysis.folder.name,
          analysis.classification.type,
          mode,
          files,
          tasksCell,
          view.displayStatus,
        ]);
      }
      for (const line of renderColumns(rows)) runtime.out(line);
      runtime.out();
      runtime.out(
        dim(
          `  ✓ complete   ! partial or stale approval   ✗ has errors — details: ${CLI_BIN} spec status <name>`,
        ),
      );
    });
}
