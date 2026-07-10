import type { Command } from 'commander';
import { CLI_BIN, SpecBridgeError } from '@specbridge/core';
import type { SpecAnalysis } from '@specbridge/compat-kiro';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
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

function printSummary(runtime: CliRuntime, analysis: SpecAnalysis): void {
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
  if (analysis.state !== undefined) {
    const approvals: string[] = [];
    const recorded = analysis.state.approvals;
    if (recorded?.requirements?.approved === true) approvals.push('requirements ✓');
    if (recorded?.design?.approved === true) approvals.push('design ✓');
    if (recorded?.tasks?.approved === true) approvals.push('tasks ✓');
    runtime.out(
      okLine(
        `${analysis.state.status} (${analysis.state.workflowMode})${approvals.length > 0 ? ` — ${approvals.join(', ')}` : ''}`,
      ),
    );
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

function toJson(analysis: SpecAnalysis): unknown {
  return createJsonReport('specbridge.spec-show/1', `${CLI_BIN} ${VERSION}`, {
    name: analysis.folder.name,
    dir: analysis.folder.dir,
    classification: analysis.classification,
    files: analysis.folder.files,
    extraDirs: analysis.folder.extraDirs,
    sidecarState: analysis.state ?? null,
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
    .option('--json', 'output the full parsed model as JSON')
    .addHelpText(
      'after',
      `
Examples:
  ${CLI_BIN} spec show user-authentication
  ${CLI_BIN} spec show user-authentication --file tasks
  ${CLI_BIN} spec show user-authentication --file requirements --raw
  ${CLI_BIN} spec show login-timeout-fix --json`,
    )
    .action((name: string, options: { file?: string; raw?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      const folder = requireSpec(workspace, name);
      const analysis = analyzeSpec(workspace, folder);

      if (options.json === true) {
        runtime.outRaw(serializeJsonReport(toJson(analysis)));
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

      printSummary(runtime, analysis);
    });
}
