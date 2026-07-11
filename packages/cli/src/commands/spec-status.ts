import type { Command } from 'commander';
import type { StageName } from '@specbridge/core';
import { CLI_BIN } from '@specbridge/core';
import { analyzeSpec, requireSpec, specFile } from '@specbridge/compat-kiro';
import type { StageEvaluation, WorkflowEvaluation } from '@specbridge/workflow';
import { analyzeSpecWorkflow, documentStageFor } from '@specbridge/workflow';
import {
  activeLine,
  blockedLine,
  createJsonReport,
  dim,
  infoLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  severityLine,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { loadWorkflowView } from '../workflow-view.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec status <name>` — workflow status, per-stage approval
 * health, and analysis findings for one spec. Read-only: stale approvals are
 * reported, never silently repaired.
 */

interface SpecStatusOptions {
  json?: boolean;
  verbose?: boolean;
}

function describeStage(
  runtime: CliRuntime,
  evaluation: WorkflowEvaluation,
  stage: StageEvaluation,
  verbose: boolean,
): void {
  const title = stage.stage.charAt(0).toUpperCase() + stage.stage.slice(1);
  runtime.out(`${title}`);
  switch (stage.effective) {
    case 'approved':
      runtime.out(okLine('Approved'));
      if (stage.stored.approvedAt !== null) {
        runtime.out(dim(`    Approved at: ${stage.stored.approvedAt}`));
      }
      runtime.out(dim('    Content unchanged since approval'));
      if (verbose && stage.stored.approvedHash !== null) {
        runtime.out(dim(`    Approved hash: ${stage.stored.approvedHash}`));
      }
      break;
    case 'modified-after-approval':
      runtime.out(warnLine('Modified after approval'));
      runtime.out(dim(`    Approved hash: ${stage.stored.approvedHash ?? '(none)'}`));
      runtime.out(dim(`    Current hash:  ${stage.currentHash ?? '(file missing or unreadable)'}`));
      runtime.out(dim(`    Re-approve with: ${CLI_BIN} spec approve <name> --stage ${stage.stage}`));
      break;
    case 'stale-prerequisite':
      runtime.out(warnLine('Approval is stale (an earlier stage changed after this was approved)'));
      if (stage.stored.approvedAt !== null) {
        runtime.out(dim(`    Originally approved at: ${stage.stored.approvedAt}`));
      }
      break;
    case 'draft': {
      runtime.out(activeLine('Draft'));
      const prerequisites = stage.prerequisites;
      if (prerequisites.length > 0) {
        runtime.out(dim('    Prerequisites satisfied'));
      }
      break;
    }
    case 'blocked': {
      runtime.out(blockedLine('Blocked'));
      const unapproved = stage.prerequisites.filter(
        (p) => evaluation.stages.find((s) => s.stage === p)?.effective !== 'approved',
      );
      if (unapproved.length > 0) {
        runtime.out(dim(`    Requires ${unapproved.join(' and ')} approval`));
      }
      break;
    }
  }
  runtime.out();
}

export function registerSpecStatusCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('status <name>')
    .description('Show workflow status, stage approvals, and approval health for a spec')
    .option('--verbose', 'include full hashes and info-level diagnostics')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Approval state comes only from .specbridge/state — a stage is never treated
as approved just because its file exists. Specs without sidecar state are
reported as unmanaged (normal for existing Kiro projects).

Examples:
  ${CLI_BIN} spec status notification-preferences
  ${CLI_BIN} spec status notification-preferences --json
  ${CLI_BIN} spec status notification-preferences --verbose`,
    )
    .action((name: string, options: SpecStatusOptions) => {
      const workspace = runtime.workspace();
      const folder = requireSpec(workspace, name);
      const spec = analyzeSpec(workspace, folder);
      const view = loadWorkflowView(workspace, folder.name);
      const analysis = analyzeSpecWorkflow(spec, view.evaluation);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.spec-status/1', `${CLI_BIN} ${VERSION}`, {
              specName: folder.name,
              specType: view.stateRead.state?.specType ?? spec.classification.type,
              workflowMode: view.stateRead.state?.workflowMode ?? spec.classification.workflowMode,
              origin: view.stateRead.state?.origin ?? null,
              managed: view.evaluation !== undefined,
              approvalHealth: view.health,
              status: view.evaluation?.storedStatus ?? null,
              effectiveStatus: view.displayStatus,
              stages:
                view.evaluation?.stages.map((stage) => ({
                  stage: stage.stage,
                  status: stage.stored.status,
                  effective: stage.effective,
                  file: stage.stored.file,
                  fileExists: stage.fileExists,
                  approvedAt: stage.stored.approvedAt,
                  approvedHash: stage.stored.approvedHash,
                  currentHash: stage.currentHash ?? null,
                  prerequisites: stage.prerequisites,
                })) ?? null,
              files: folder.files.map((f) => ({ fileName: f.fileName, kind: f.kind })),
              analysis: {
                errorCount: analysis.errorCount,
                warningCount: analysis.warningCount,
                diagnostics: analysis.diagnostics,
              },
              stateDiagnostics: view.stateRead.diagnostics,
            }),
          ),
        );
        return;
      }

      runtime.out(reportTitle(`Spec: ${folder.name}`));
      runtime.out(`Type: ${view.stateRead.state?.specType ?? spec.classification.type}`);
      runtime.out(`Mode: ${view.stateRead.state?.workflowMode ?? spec.classification.workflowMode}`);
      runtime.out(`Status: ${view.displayStatus}`);
      if (view.stateRead.state?.origin === 'existing-kiro-workspace') {
        runtime.out(dim('Origin: initialized from an existing Kiro workspace'));
      }
      runtime.out();

      for (const diagnostic of view.stateRead.diagnostics) {
        runtime.out(severityLine(diagnostic.severity, diagnostic.message));
      }

      if (view.evaluation === undefined) {
        runtime.out('Approval state: unmanaged');
        runtime.out(
          dim(
            '  This spec has no SpecBridge sidecar state — normal for a spec created by Kiro.\n' +
              '  Files stay untouched either way. To start managing approvals, run:',
          ),
        );
        const firstStage = documentStageFor(spec.classification.type === 'bugfix' ? 'bugfix' : 'feature');
        runtime.out(dim(`    ${CLI_BIN} spec approve ${folder.name} --stage ${firstStage}`));
        runtime.out();
      } else {
        runtime.out(sectionTitle('Stages'));
        runtime.out();
        for (const stage of view.evaluation.stages) {
          describeStage(runtime, view.evaluation, stage, options.verbose === true);
        }
      }

      runtime.out(sectionTitle('Files'));
      const expected: StageName[] =
        spec.classification.type === 'bugfix'
          ? ['bugfix', 'design', 'tasks']
          : ['requirements', 'design', 'tasks'];
      for (const kind of expected) {
        const file = specFile(folder, kind);
        if (file !== undefined) {
          runtime.out(okLine(file.fileName));
        } else {
          runtime.out(infoLine(`${kind}.md not present`));
        }
      }
      runtime.out();

      runtime.out(sectionTitle('Diagnostics'));
      const visible = analysis.diagnostics.filter(
        (d) => options.verbose === true || d.severity !== 'info',
      );
      if (visible.length === 0) {
        runtime.out(okLine('none'));
      } else {
        for (const diagnostic of visible) {
          const location =
            diagnostic.file !== undefined
              ? ` [${relPath(workspace, diagnostic.file)}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}]`
              : '';
          runtime.out(severityLine(diagnostic.severity, `${diagnostic.message}${location}`));
        }
      }
    });
}
