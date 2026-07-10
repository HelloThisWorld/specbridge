import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, PRODUCT_NAME, hasErrors } from '@specbridge/core';
import type { WorkspaceAnalysis } from '@specbridge/compat-kiro';
import { analyzeWorkspace } from '@specbridge/compat-kiro';
import {
  addLine,
  createJsonReport,
  dim,
  failLine,
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
import { relPath } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge doctor` — read-only workspace health report. Never modifies
 * files. Exit 0 when the workspace is healthy, 1 when problems were found
 * (including "no .kiro directory").
 */

function describeProgress(analysis: WorkspaceAnalysis['specs'][number]): string {
  if (analysis.tasks === undefined) {
    return analysis.classification.completeness === 'partial'
      ? `${analysis.classification.presentKinds.join(', ') || 'no known files'}`
      : 'no tasks.md';
  }
  const p = analysis.taskProgress;
  const optional = p.optionalTotal > 0 ? ` (+${p.optionalTotal} optional)` : '';
  return `${p.completed}/${p.total} tasks${optional}`;
}

function printReport(runtime: CliRuntime, analysis: WorkspaceAnalysis): void {
  const { workspace } = analysis;
  runtime.out(reportTitle(`${PRODUCT_NAME} Doctor`));
  runtime.out();

  runtime.out(sectionTitle('Workspace'));
  if (workspace.gitRootDir !== undefined) {
    runtime.out(okLine('Git repository detected', `(${workspace.gitRootDir})`));
  } else {
    runtime.out(warnLine('Not inside a git repository', '(optional, but recommended)'));
  }
  runtime.out(okLine('.kiro directory detected', `(${workspace.kiroDir})`));
  if (workspace.steeringDir !== undefined) {
    runtime.out(okLine('.kiro/steering detected', `(${analysis.steering.length} file${analysis.steering.length === 1 ? '' : 's'})`));
  } else {
    runtime.out(infoLine('.kiro/steering not present', '(optional)'));
  }
  if (workspace.specsDir !== undefined) {
    runtime.out(okLine('.kiro/specs detected', `(${analysis.specs.length} spec${analysis.specs.length === 1 ? '' : 's'})`));
  } else {
    runtime.out(infoLine('.kiro/specs not present', '(optional)'));
  }
  if (workspace.sidecarExists) {
    runtime.out(okLine('.specbridge sidecar present', `(${relPath(workspace, workspace.sidecarDir)})`));
  } else {
    runtime.out(infoLine('.specbridge sidecar not present', '(created only by state-changing commands)'));
  }
  runtime.out();

  runtime.out(sectionTitle('Steering'));
  if (analysis.steering.length === 0) {
    runtime.out(infoLine('No steering files found'));
  } else {
    const defaults = analysis.steering.filter((s) => s.isDefault);
    const additional = analysis.steering.filter((s) => !s.isDefault);
    for (const info of defaults) runtime.out(okLine(info.fileName));
    if (additional.length > 0) {
      runtime.out(
        addLine(
          `${additional.length} additional steering file${additional.length === 1 ? '' : 's'} (${additional
            .map((s) => s.fileName)
            .join(', ')})`,
        ),
      );
    }
    if (analysis.unknownSteeringEntries.length > 0) {
      runtime.out(
        infoLine(
          `${analysis.unknownSteeringEntries.length} non-Markdown entr${analysis.unknownSteeringEntries.length === 1 ? 'y' : 'ies'} ignored (${analysis.unknownSteeringEntries.join(', ')})`,
        ),
      );
    }
  }
  runtime.out();

  runtime.out(sectionTitle('Specs'));
  if (analysis.specs.length === 0) {
    runtime.out(infoLine('No specs found'));
  } else {
    const rows = analysis.specs.map((spec) => {
      const specErrors = hasErrors(spec.diagnostics);
      const marker = specErrors ? '✗' : spec.classification.completeness === 'complete' ? '✓' : '!';
      return [
        marker,
        spec.folder.name,
        spec.classification.type,
        spec.classification.completeness,
        describeProgress(spec),
      ];
    });
    for (const line of renderColumns(rows)) runtime.out(line);
  }
  runtime.out();

  runtime.out(sectionTitle('Line endings'));
  const le = analysis.lineEndings;
  const parts: string[] = [];
  if (le.lf > 0) parts.push(`LF ×${le.lf}`);
  if (le.crlf > 0) parts.push(`CRLF ×${le.crlf}`);
  if (le.cr > 0) parts.push(`CR ×${le.cr}`);
  if (le.none > 0) parts.push(`single-line ×${le.none}`);
  if (parts.length === 0) parts.push('no Markdown files scanned');
  if (le.mixed > 0) {
    runtime.out(warnLine(`${parts.join(', ')}, mixed ×${le.mixed}`, '(mixed endings are preserved as-is)'));
  } else {
    runtime.out(okLine(`${parts.join(', ')}`, '(preserved exactly as found)'));
  }
  runtime.out();

  runtime.out(sectionTitle('Compatibility'));
  runtime.out(okLine('No migration required — .kiro remains the source of truth'));
  const foreignMetadata = analysis.specs.some((spec) =>
    spec.diagnostics.some((d) => d.code === 'FOREIGN_METADATA_IN_KIRO_FILE'),
  );
  if (foreignMetadata) {
    runtime.out(failLine('SpecBridge metadata found inside .kiro files (should never happen)'));
  } else {
    runtime.out(okLine('No SpecBridge metadata inside .kiro files'));
  }
  if (analysis.roundTripSafe) {
    runtime.out(okLine('Round-trip safe: every Markdown file reserializes byte-identically'));
  } else {
    runtime.out(failLine('Round-trip check failed for at least one file (see diagnostics)'));
  }
  runtime.out(okLine('Safe for read-only use'));
  runtime.out();

  const allDiagnostics = [
    ...analysis.diagnostics,
    ...analysis.specs.flatMap((spec) => spec.diagnostics),
  ];
  const visible = allDiagnostics.filter((d) => d.severity !== 'info');
  if (visible.length > 0) {
    runtime.out(sectionTitle('Diagnostics'));
    for (const diagnostic of visible) {
      const location =
        diagnostic.file !== undefined
          ? ` [${relPath(workspace, diagnostic.file)}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}]`
          : '';
      runtime.out(severityLine(diagnostic.severity, `${diagnostic.message}${location}`));
    }
    runtime.out();
  }

  if (analysis.healthy && analysis.roundTripSafe) {
    runtime.out(`Result: ${reportTitle('OK')} — workspace is ready for ${PRODUCT_NAME}`);
  } else {
    runtime.out(`Result: ${reportTitle('PROBLEMS FOUND')} — see diagnostics above`);
  }
}

function toJson(analysis: WorkspaceAnalysis): unknown {
  return createJsonReport('specbridge.doctor/1', `${CLI_BIN} ${VERSION}`, {
    workspace: {
      rootDir: analysis.workspace.rootDir,
      kiroDir: analysis.workspace.kiroDir,
      steeringDir: analysis.workspace.steeringDir ?? null,
      specsDir: analysis.workspace.specsDir ?? null,
      gitRootDir: analysis.workspace.gitRootDir ?? null,
      sidecarDir: analysis.workspace.sidecarDir,
      sidecarExists: analysis.workspace.sidecarExists,
    },
    steering: analysis.steering.map((s) => ({
      name: s.name,
      fileName: s.fileName,
      isDefault: s.isDefault,
      inclusion: s.inclusion,
      fileMatchPattern: s.fileMatchPattern ?? null,
    })),
    specs: analysis.specs.map((spec) => ({
      name: spec.folder.name,
      type: spec.classification.type,
      workflowMode: spec.classification.workflowMode,
      completeness: spec.classification.completeness,
      presentKinds: spec.classification.presentKinds,
      missingKinds: spec.classification.missingKinds,
      taskProgress: spec.taskProgress,
      roundTripSafe: spec.roundTrip.every((check) => check.identical),
      diagnostics: spec.diagnostics,
    })),
    lineEndings: analysis.lineEndings,
    roundTripSafe: analysis.roundTripSafe,
    healthy: analysis.healthy,
    diagnostics: analysis.diagnostics,
  });
}

export function registerDoctorCommand(program: Command, runtime: CliRuntime): void {
  program
    .command('doctor')
    .description('Check .kiro workspace health and SpecBridge compatibility (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Examples:
  ${CLI_BIN} doctor
  ${CLI_BIN} doctor --json
  ${CLI_BIN} --cwd path/to/project doctor`,
    )
    .action((options: { json?: boolean }) => {
      const workspace = runtime.tryWorkspace();
      if (workspace === undefined) {
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.doctor/1', `${CLI_BIN} ${VERSION}`, {
                workspace: null,
                searchedFrom: path.resolve(runtime.cwd),
                healthy: false,
              }),
            ),
          );
        } else {
          runtime.out(reportTitle(`${PRODUCT_NAME} Doctor`));
          runtime.out();
          runtime.out(failLine(`No .kiro directory found from ${path.resolve(runtime.cwd)} upward`));
          runtime.out();
          runtime.out(
            dim(
              `${PRODUCT_NAME} works with existing Kiro projects. Open a project that contains .kiro/, or create .kiro/specs/<name>/ manually.`,
            ),
          );
        }
        runtime.exitCode = 1;
        return;
      }

      const analysis = analyzeWorkspace(workspace);
      if (options.json === true) {
        runtime.outRaw(serializeJsonReport(toJson(analysis)));
      } else {
        printReport(runtime, analysis);
      }
      runtime.exitCode = analysis.healthy && analysis.roundTripSafe ? 0 : 1;
    });
}
