import pc from 'picocolors';
import type {
  SpecVerificationResult,
  VerificationDiagnostic,
  VerificationReport,
} from '@specbridge/core';
import { dim, failLine, infoLine, okLine, reportTitle, sectionTitle, warnLine } from './terminal-report.js';

/**
 * Terminal rendering for verification reports. Concise but actionable: every
 * diagnostic shows its stable rule ID, location, and remediation. Severity is
 * always carried by a glyph (✓ ! ✗ ·), never by color alone — picocolors
 * already honors NO_COLOR and non-TTY output.
 */

export interface VerificationTerminalOptions {
  verbose?: boolean;
}

function severityGlyphLine(diagnostic: VerificationDiagnostic, text: string): string {
  if (diagnostic.severity === 'error') return failLine(text);
  if (diagnostic.severity === 'warning') return warnLine(text);
  return infoLine(text);
}

function diagnosticLocation(diagnostic: VerificationDiagnostic): string {
  if (diagnostic.file === null) return '';
  const line = diagnostic.file.line !== null ? `:${diagnostic.file.line}` : '';
  return ` ${diagnostic.file.path}${line}`;
}

function renderDiagnostic(lines: string[], diagnostic: VerificationDiagnostic): void {
  const heuristic = diagnostic.confidence === 'heuristic' ? ' (heuristic)' : '';
  lines.push(
    severityGlyphLine(diagnostic, `${pc.bold(diagnostic.ruleId)}${diagnosticLocation(diagnostic)}${heuristic}`),
  );
  lines.push(`      ${diagnostic.message}`);
  lines.push(dim(`      Fix: ${diagnostic.remediation}`));
}

function renderSpecResult(
  lines: string[],
  spec: SpecVerificationResult,
  options: VerificationTerminalOptions,
): void {
  lines.push(reportTitle(`Spec: ${spec.specName}`));
  const mode = spec.workflowMode !== 'unknown' ? `, ${spec.workflowMode}` : '';
  lines.push(dim(`  ${spec.specType}${mode}${spec.managed ? '' : ', unmanaged'}`));
  lines.push(
    `  Policy: ${spec.policyMode}${spec.policyPath !== null ? ` (${spec.policyPath})` : ' (defaults — no policy file)'}`,
  );
  if (spec.matchedBy.length > 0) {
    lines.push(dim(`  Selected via: ${spec.matchedBy.join('; ')}`));
  }

  const t = spec.traceability;
  if (t.requirements > 0 || t.tasks > 0) {
    lines.push(sectionTitle('  Traceability'));
    lines.push(
      okLine(
        `${t.requirements} requirement${t.requirements === 1 ? '' : 's'} detected, ${t.requirementsWithTasks} with tasks`,
      ),
    );
    lines.push(okLine(`${t.tasks} task${t.tasks === 1 ? '' : 's'}, ${t.tasksWithRequirements} with requirement references`));
  }

  const e = spec.evidence;
  const completedTracked = e.valid + e.stale + e.missing;
  if (completedTracked > 0 || e.invalid > 0) {
    lines.push(sectionTitle('  Evidence (completed tasks)'));
    if (e.valid > 0) {
      const manual = e.manuallyAccepted > 0 ? ` (${e.manuallyAccepted} manually accepted)` : '';
      lines.push(okLine(`${e.valid} with valid evidence${manual}`));
    }
    if (e.stale > 0) lines.push(failLine(`${e.stale} with stale evidence`));
    if (e.missing > 0) lines.push(warnLine(`${e.missing} without evidence`));
    if (e.invalid > 0) lines.push(failLine(`${e.invalid} invalid evidence record${e.invalid === 1 ? '' : 's'}`));
  }

  if (spec.changedFiles.length > 0) {
    lines.push(sectionTitle('  Changed files'));
    const shown = options.verbose === true ? spec.changedFiles : spec.changedFiles.slice(0, 10);
    for (const file of shown) {
      const rename = file.oldPath !== null ? ` (from ${file.oldPath})` : '';
      lines.push(dim(`    ${file.changeType.padEnd(9)} ${file.path}${rename}`));
    }
    if (shown.length < spec.changedFiles.length) {
      lines.push(dim(`    … and ${spec.changedFiles.length - shown.length} more (--verbose shows all)`));
    }
  }

  const visible = spec.diagnostics.filter(
    (diagnostic) => options.verbose === true || diagnostic.severity !== 'info',
  );
  lines.push(sectionTitle('  Diagnostics'));
  if (visible.length === 0) {
    lines.push(okLine('none'));
  } else {
    for (const diagnostic of visible) renderDiagnostic(lines, diagnostic);
  }
  lines.push(
    spec.result === 'passed'
      ? okLine(pc.bold('Spec result: PASSED'))
      : failLine(pc.bold('Spec result: FAILED')),
  );
  lines.push('');
}

/** Render a full verification report as terminal lines. */
export function renderVerificationTerminal(
  report: VerificationReport,
  options: VerificationTerminalOptions = {},
): string[] {
  const lines: string[] = [];
  lines.push(reportTitle('Spec Drift Verification'));
  lines.push('');
  lines.push(sectionTitle('Comparison'));
  lines.push(`  ${report.comparison.label}`);
  if (report.comparison.baseSha !== null && report.comparison.mode === 'diff') {
    lines.push(
      dim(`  ${report.comparison.baseSha.slice(0, 12)} → ${report.comparison.headSha?.slice(0, 12) ?? '?'}`),
    );
  }
  lines.push('');

  if (report.selection.mode !== 'single') {
    lines.push(sectionTitle(report.selection.mode === 'changed' ? 'Affected specs' : 'Specs'));
    if (report.selection.specs.length === 0) {
      lines.push(infoLine('none'));
    } else {
      for (const spec of report.selection.specs) lines.push(`  ${spec}`);
    }
    lines.push('');
  }

  for (const spec of report.specResults) renderSpecResult(lines, spec, options);

  if (report.globalDiagnostics.length > 0) {
    lines.push(sectionTitle('Workspace diagnostics'));
    for (const diagnostic of report.globalDiagnostics) {
      if (options.verbose !== true && diagnostic.severity === 'info') continue;
      renderDiagnostic(lines, diagnostic);
    }
    lines.push('');
  }

  if (report.verificationCommands.length > 0) {
    lines.push(sectionTitle('Verification commands'));
    for (const command of report.verificationCommands) {
      const detail =
        command.disposition === 'executed'
          ? `exit ${command.exitCode ?? '?'}${command.timedOut ? ', timed out' : ''}`
          : command.disposition === 'reused-evidence'
            ? 'reused from evidence'
            : 'not run';
      const label = `${command.name}${command.required ? '' : ' (optional)'} — ${detail}`;
      lines.push(command.passed ? okLine(label) : failLine(label));
    }
    lines.push('');
  }

  const s = report.summary;
  const counts = `${s.errors} error${s.errors === 1 ? '' : 's'}, ${s.warnings} warning${s.warnings === 1 ? '' : 's'}, ${s.info} info`;
  lines.push(sectionTitle('Result'));
  lines.push(
    s.result === 'passed'
      ? okLine(pc.bold(`PASSED — ${counts}`))
      : failLine(pc.bold(`FAILED — ${counts}`)),
  );
  return lines;
}
