import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, PRODUCT_NAME, hasErrors } from '@specbridge/core';
import type { WorkspaceAnalysis } from '@specbridge/compat-kiro';
import { analyzeWorkspace } from '@specbridge/compat-kiro';
import type { SidecarAudit } from '@specbridge/workflow';
import { auditSidecarState } from '@specbridge/workflow';
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

function printSidecarSection(runtime: CliRuntime, audit: SidecarAudit): void {
  runtime.out(sectionTitle('Sidecar state (.specbridge)'));
  if (!audit.stateDirExists) {
    runtime.out(infoLine('No workflow state yet', '(created by "spec new" or the first "spec approve")'));
    runtime.out();
    return;
  }
  const healthy = audit.entries.filter(
    (entry) => entry.health === 'ok' && entry.hasSpecFolder,
  ).length;
  if (healthy > 0) {
    runtime.out(okLine(`${healthy} spec state file${healthy === 1 ? '' : 's'} valid and in sync`));
  }
  for (const specName of audit.staleSpecs) {
    runtime.out(
      warnLine(`${specName}: an approved file changed after approval`, `(repair: ${CLI_BIN} spec approve ${specName} --stage <stage>)`),
    );
  }
  for (const specName of audit.invalidStates.filter((name) => !audit.orphanStates.includes(name))) {
    runtime.out(warnLine(`${specName}: sidecar state is invalid and was ignored`));
  }
  for (const specName of audit.orphanStates) {
    runtime.out(warnLine(`${specName}: state file has no matching .kiro/specs/${specName}/ directory`));
  }
  if (audit.unmanagedSpecs.length > 0) {
    runtime.out(
      infoLine(
        `${audit.unmanagedSpecs.length} spec${audit.unmanagedSpecs.length === 1 ? '' : 's'} without workflow state (unmanaged): ${audit.unmanagedSpecs.join(', ')}`,
        '(normal for Kiro-only projects)',
      ),
    );
  }
  if (audit.unknownEntries.length > 0) {
    runtime.out(infoLine(`Ignored non-state entries in state dir: ${audit.unknownEntries.join(', ')}`));
  }
  runtime.out();
}

function printReport(runtime: CliRuntime, analysis: WorkspaceAnalysis, audit: SidecarAudit): void {
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

  printSidecarSection(runtime, audit);

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
    ...audit.diagnostics,
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

function toJson(analysis: WorkspaceAnalysis, audit: SidecarAudit): unknown {
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
    sidecar: {
      stateDir: audit.stateDir,
      stateDirExists: audit.stateDirExists,
      states: audit.entries.map((entry) => ({
        specName: entry.specName,
        statePath: entry.statePath,
        hasSpecFolder: entry.hasSpecFolder,
        health: entry.health,
        effectiveStatus: entry.effectiveStatus ?? null,
      })),
      orphanStates: audit.orphanStates,
      unmanagedSpecs: audit.unmanagedSpecs,
      staleSpecs: audit.staleSpecs,
      invalidStates: audit.invalidStates,
    },
    lineEndings: analysis.lineEndings,
    roundTripSafe: analysis.roundTripSafe,
    healthy: analysis.healthy,
    diagnostics: [...analysis.diagnostics, ...audit.diagnostics],
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
      const audit = auditSidecarState(
        workspace,
        analysis.specs.map((spec) => spec.folder),
      );
      if (options.json === true) {
        runtime.outRaw(serializeJsonReport(toJson(analysis, audit)));
      } else {
        printReport(runtime, analysis, audit);
      }
      const auditHealthy = !hasErrors(audit.diagnostics);
      runtime.exitCode = analysis.healthy && analysis.roundTripSafe && auditHealthy ? 0 : 1;
    });
}
