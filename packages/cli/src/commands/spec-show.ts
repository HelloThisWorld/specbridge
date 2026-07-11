import type { Command } from 'commander';
import { CLI_BIN, SpecBridgeError, stateStageNames, stateStage } from '@specbridge/core';
import type { SpecAnalysis } from '@specbridge/compat-kiro';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { analyzeSpecWorkflow } from '@specbridge/workflow';
import {
  createJsonReport,
  dim,
  infoLine,
  okLine,
  renderColumns,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  severityLine,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { formatBytes, relPath } from '../context.js';
import type { SpecWorkflowView } from '../workflow-view.js';
import { loadWorkflowView } from '../workflow-view.js';
import { VERSION } from '../version.js';

const FILE_KINDS = ['requirements', 'design', 'tasks', 'bugfix'] as const;
type FileKind = (typeof FILE_KINDS)[number];

function describeDocument(analysis: SpecAnalysis, kind: FileKind): string {
  switch (kind) {
    case 'requirements': {
      const model = analysis.requirements;
      if (model === undefined) return '';
      const criteria = model.requirements.reduce((sum, r) => sum + r.criteria.length, 0);
      return `${model.requirements.length} requirements, ${criteria} acceptance criteria`;
    }
    case 'design': {
      const model = analysis.design;
      if (model === undefined) return '';
      const mermaid = model.mermaidBlockCount > 0 ? `, ${model.mermaidBlockCount} mermaid` : '';
      return `${model.sections.length} sections${mermaid}`;
    }
    case 'tasks': {
      const model = analysis.tasks;
      if (model === undefined) return '';
      const p = analysis.taskProgress;
      const optional = p.optionalTotal > 0 ? ` (+${p.optionalCompleted}/${p.optionalTotal} optional)` : '';
      return `${p.total} tasks — ${p.completed} done, ${p.total - p.completed} open${optional}`;
    }
    case 'bugfix': {
      const model = analysis.bugfix;
      if (model === undefined) return '';
      const concepts = Object.keys(model.concepts).length;
      return `${concepts} recognized section${concepts === 1 ? '' : 's'}`;
    }
  }
}

function printSummary(runtime: CliRuntime, analysis: SpecAnalysis, view: SpecWorkflowView): void {
  const workspace = runtime.workspace();
  const { classification, folder } = analysis;
  runtime.out(reportTitle(`Spec: ${folder.name}`));
  runtime.out(
    `  Type: ${classification.type} — workflow: ${classification.workflowMode} — completeness: ${classification.completeness}`,
  );
  runtime.out(`  Location: ${relPath(workspace, folder.dir)}`);
  runtime.out();

  runtime.out(sectionTitle('Files'));
  const rows: string[][] = [];
  for (const file of folder.files) {
    const detail = file.kind !== 'other' ? describeDocument(analysis, file.kind as FileKind) : 'unknown file (preserved, not parsed)';
    rows.push([file.fileName, formatBytes(file.sizeBytes), detail]);
  }
  for (const line of renderColumns(rows)) runtime.out(line);
  for (const missing of classification.missingKinds) {
    runtime.out(infoLine(`${missing}.md not present yet`));
  }
  if (folder.extraDirs.length > 0) {
    runtime.out(infoLine(`Subdirectories (untouched): ${folder.extraDirs.join(', ')}`));
  }
  runtime.out();

  runtime.out(sectionTitle('Sidecar state'));
  const state = analysis.state;
  if (state !== undefined) {
    const approvals = stateStageNames(state)
      .filter((stage) => stateStage(state, stage)?.status === 'approved')
      .map((stage) => `${stage} ✓`);
    const stale = view.health === 'stale' ? ' — STALE_APPROVAL (an approved file changed)' : '';
    runtime.out(
      okLine(
        `${view.displayStatus} (${state.workflowMode})${approvals.length > 0 ? ` — ${approvals.join(', ')}` : ''}${stale}`,
      ),
    );
    runtime.out(dim(`    Details: ${CLI_BIN} spec status ${folder.name}`));
  } else if (view.health === 'invalid') {
    runtime.out(warnLine('invalid sidecar state (ignored) — see diagnostics below'));
  } else {
    runtime.out(infoLine('none (this spec has only ever been used by Kiro — that is fine)'));
  }
  runtime.out();

  if (analysis.tasks !== undefined) {
    const open = analysis.tasks.allTasks.filter((t) => t.state === 'open' && !t.optional).slice(0, 5);
    if (open.length > 0) {
      runtime.out(sectionTitle('Next open tasks'));
      for (const task of open) {
        runtime.out(`  [ ] ${task.number !== undefined ? `${task.number} ` : ''}${task.title}`);
      }
      runtime.out();
    }
  }

  runtime.out(sectionTitle('Diagnostics'));
  if (analysis.diagnostics.length === 0) {
    runtime.out(okLine('none'));
  } else {
    for (const diagnostic of analysis.diagnostics) {
      const location =
        diagnostic.file !== undefined
          ? ` [${relPath(workspace, diagnostic.file)}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}]`
          : '';
      runtime.out(severityLine(diagnostic.severity, `${diagnostic.message}${location}`));
    }
  }
  const roundTripOk = analysis.roundTrip.every((check) => check.identical);
  runtime.out();
  if (roundTripOk) {
    runtime.out(okLine('Round-trip safe: all Markdown files reserialize byte-identically'));
  } else {
    runtime.out(warnLine(`Round-trip check failed — run "${CLI_BIN} compat check ${folder.name}"`));
  }
}

function toJson(analysis: SpecAnalysis, view: SpecWorkflowView): unknown {
  return createJsonReport('specbridge.spec-show/1', `${CLI_BIN} ${VERSION}`, {
    name: analysis.folder.name,
    dir: analysis.folder.dir,
    classification: analysis.classification,
    files: analysis.folder.files,
    extraDirs: analysis.folder.extraDirs,
    sidecarState: analysis.state ?? null,
    approvalHealth: view.health,
    effectiveStatus: view.displayStatus,
    requirements: analysis.requirements ?? null,
    design: analysis.design ?? null,
    tasks:
      analysis.tasks !== undefined
        ? {
            ...analysis.tasks,
            // The nested task tree duplicates allTasks; keep JSON output flat and stable.
            tasks: undefined,
            allTasks: analysis.tasks.allTasks.map((task) => ({
              id: task.id,
              number: task.number ?? null,
              title: task.title,
              line: task.line,
              state: task.state,
              optional: task.optional,
              requirementRefs: task.requirementRefs,
              childIds: task.children.map((child) => child.id),
            })),
          }
        : null,
    bugfix: analysis.bugfix ?? null,
    taskProgress: analysis.taskProgress,
    roundTrip: analysis.roundTrip,
    diagnostics: analysis.diagnostics,
  });
}

export function registerSpecShowCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('show <name>')
    .description('Show a spec summary, one of its files, or the full parsed model')
    .option('--file <kind>', `print one file's content (${FILE_KINDS.join(', ')})`)
    .option('--raw', 'print raw file content without any summary framing')
    .option('--state', 'print the sidecar workflow state (JSON) for this spec')
    .option('--analysis', 'print deterministic analysis findings for this spec')
    .option('--status', 'print a one-line workflow status for this spec')
    .option('--json', 'output the full parsed model as JSON')
    .addHelpText(
      'after',
      `
Examples:
  ${CLI_BIN} spec show user-authentication
  ${CLI_BIN} spec show user-authentication --file tasks
  ${CLI_BIN} spec show user-authentication --file requirements --raw
  ${CLI_BIN} spec show user-authentication --state
  ${CLI_BIN} spec show user-authentication --analysis
  ${CLI_BIN} spec show login-timeout-fix --json`,
    )
    .action(
      (
        name: string,
        options: {
          file?: string;
          raw?: boolean;
          json?: boolean;
          state?: boolean;
          analysis?: boolean;
          status?: boolean;
        },
      ) => {
      const workspace = runtime.workspace();
      const folder = requireSpec(workspace, name);
      const analysis = analyzeSpec(workspace, folder);
      const view = loadWorkflowView(workspace, folder.name);

      if (options.json === true) {
        runtime.outRaw(serializeJsonReport(toJson(analysis, view)));
        return;
      }

      if (options.state === true) {
        for (const diagnostic of view.stateRead.diagnostics) {
          runtime.out(severityLine(diagnostic.severity, diagnostic.message));
        }
        if (view.stateRead.state !== undefined) {
          runtime.outRaw(`${JSON.stringify(view.stateRead.state, null, 2)}\n`);
        } else if (!view.stateRead.exists) {
          runtime.out(infoLine(`No sidecar state (approval state: unmanaged). Path: ${relPath(workspace, view.stateRead.path)}`));
        }
        return;
      }

      if (options.status === true) {
        const mode = view.stateRead.state?.workflowMode ?? analysis.classification.workflowMode;
        runtime.out(
          `${folder.name}  ${analysis.classification.type}  ${mode}  ${view.displayStatus}`,
        );
        runtime.out(dim(`  Details: ${CLI_BIN} spec status ${folder.name}`));
        return;
      }

      if (options.analysis === true) {
        const result = analyzeSpecWorkflow(analysis, view.evaluation);
        if (result.diagnostics.length === 0) {
          runtime.out(okLine('no findings'));
        } else {
          for (const diagnostic of result.diagnostics) {
            const location =
              diagnostic.file !== undefined
                ? ` [${relPath(workspace, diagnostic.file)}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}]`
                : '';
            runtime.out(severityLine(diagnostic.severity, `${diagnostic.message}${location}`));
          }
        }
        runtime.out();
        runtime.out(
          dim(`  ${result.errorCount} errors, ${result.warningCount} warnings — full report: ${CLI_BIN} spec analyze ${folder.name}`),
        );
        return;
      }

      if (options.file !== undefined) {
        const kind = options.file as FileKind;
        if (!FILE_KINDS.includes(kind)) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `Unknown --file kind "${options.file}". Valid kinds: ${FILE_KINDS.join(', ')}.`,
          );
        }
        const document = analysis.documents[kind];
        if (document === undefined) {
          throw new SpecBridgeError(
            'SPEC_FILE_NOT_FOUND',
            `Spec "${folder.name}" has no ${kind}.md. Present files: ${folder.files
              .map((f) => f.fileName)
              .join(', ')}.`,
          );
        }
        runtime.outRaw(document.bodyText());
        return;
      }

      if (options.raw === true) {
        // Raw dump of every known document, in workflow order, with separators.
        const order: FileKind[] = ['bugfix', 'requirements', 'design', 'tasks'];
        for (const kind of order) {
          const document = analysis.documents[kind];
          if (document === undefined) continue;
          runtime.out(dim(`--- file: ${kind}.md ---`));
          runtime.outRaw(document.bodyText());
          if (!document.bodyText().endsWith('\n')) runtime.out();
        }
        return;
      }

      printSummary(runtime, analysis, view);
      },
    );
}
