import type {
  SpecVerificationResult,
  VerificationDiagnostic,
  VerificationReport,
} from '@specbridge/core';

/**
 * Markdown rendering for verification reports — used for GitHub Step
 * Summaries, pull-request comments, and saved artifacts.
 *
 * Output limits are enforced (GitHub truncates step summaries at 1 MiB);
 * no raw command output or environment data ever appears here.
 */

export interface VerificationMarkdownOptions {
  /** Maximum diagnostics listed per spec before folding into a count. */
  maxDiagnosticsPerSpec?: number;
  /** Maximum blocking issues in the top section. */
  maxBlockingIssues?: number;
  /** Report paths to link at the bottom (workspace-relative). */
  artifactPaths?: { json?: string; markdown?: string; html?: string };
}

const DEFAULT_MAX_DIAGNOSTICS = 50;
const DEFAULT_MAX_BLOCKING = 10;

/** Escape content for a Markdown table cell. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** Inline code span that survives backticks in the content. */
function code(text: string): string {
  return text.includes('`') ? `\`\`${text}\`\`` : `\`${text}\``;
}

function diagnosticLine(diagnostic: VerificationDiagnostic): string {
  const location =
    diagnostic.file !== null
      ? ` — ${code(diagnostic.file.path)}${diagnostic.file.line !== null ? `:${diagnostic.file.line}` : ''}`
      : '';
  const heuristic = diagnostic.confidence === 'heuristic' ? ' _(heuristic)_' : '';
  return `- ${code(diagnostic.ruleId)}${location}${heuristic} — ${diagnostic.message}`;
}

function severityBadge(diagnostic: VerificationDiagnostic): string {
  if (diagnostic.severity === 'error') return '🔴 error';
  if (diagnostic.severity === 'warning') return '🟡 warning';
  return '🔵 info';
}

function specSection(spec: SpecVerificationResult, maxDiagnostics: number): string[] {
  const lines: string[] = [];
  lines.push(`### ${spec.specName}`);
  lines.push('');
  const policy =
    spec.policyPath !== null ? `${spec.policyMode} (${code(spec.policyPath)})` : `${spec.policyMode} (defaults)`;
  lines.push(
    `**Result:** ${spec.result === 'passed' ? 'Passed' : 'Failed'} · **Policy:** ${policy} · ` +
      `**Type:** ${spec.specType}${spec.managed ? '' : ' (unmanaged)'}`,
  );
  lines.push('');
  const t = spec.traceability;
  const e = spec.evidence;
  lines.push(
    `Traceability: ${t.requirements} requirements (${t.requirementsWithTasks} with tasks), ` +
      `${t.tasks} tasks (${t.tasksWithRequirements} linked). ` +
      `Evidence: ${e.valid} valid${e.manuallyAccepted > 0 ? ` (${e.manuallyAccepted} manual)` : ''}, ` +
      `${e.stale} stale, ${e.missing} missing.`,
  );
  lines.push('');

  if (spec.diagnostics.length === 0) {
    lines.push('No findings.');
    lines.push('');
    return lines;
  }

  lines.push('| Severity | Rule | Where | Finding |');
  lines.push('|---|---|---|---|');
  const shown = spec.diagnostics.slice(0, maxDiagnostics);
  for (const diagnostic of shown) {
    const where =
      diagnostic.file !== null
        ? `${code(diagnostic.file.path)}${diagnostic.file.line !== null ? `:${diagnostic.file.line}` : ''}`
        : diagnostic.taskId !== null
          ? `task ${code(diagnostic.taskId)}`
          : '—';
    lines.push(
      `| ${severityBadge(diagnostic)} | ${code(diagnostic.ruleId)} | ${cell(where)} | ${cell(diagnostic.message)} |`,
    );
  }
  if (spec.diagnostics.length > shown.length) {
    lines.push('');
    lines.push(`… and ${spec.diagnostics.length - shown.length} more findings (see the JSON report).`);
  }
  lines.push('');

  const remediations = shown.filter((diagnostic) => diagnostic.severity !== 'info');
  if (remediations.length > 0) {
    lines.push('<details>');
    lines.push('<summary>How to fix</summary>');
    lines.push('');
    for (const diagnostic of remediations) {
      lines.push(`- ${code(diagnostic.ruleId)} — ${diagnostic.remediation}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  return lines;
}

/** Render a verification report as GitHub-flavored Markdown. */
export function renderVerificationMarkdown(
  report: VerificationReport,
  options: VerificationMarkdownOptions = {},
): string {
  const maxDiagnostics = options.maxDiagnosticsPerSpec ?? DEFAULT_MAX_DIAGNOSTICS;
  const maxBlocking = options.maxBlockingIssues ?? DEFAULT_MAX_BLOCKING;
  const lines: string[] = [];

  lines.push('# SpecBridge Verification');
  lines.push('');
  lines.push(`**Result:** ${report.summary.result === 'passed' ? 'Passed ✅' : 'Failed ❌'}`);
  lines.push('');
  lines.push(
    `Comparison: ${code(report.comparison.label)} · Selection: ${report.selection.mode} · ` +
      `${report.summary.specsVerified} spec${report.summary.specsVerified === 1 ? '' : 's'} verified · ` +
      `${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.info} info`,
  );
  lines.push('');

  if (report.specResults.length > 0) {
    lines.push('| Spec | Result | Errors | Warnings |');
    lines.push('|---|---|---:|---:|');
    for (const spec of report.specResults) {
      const errors = spec.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
      const warnings = spec.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'warning',
      ).length;
      lines.push(
        `| ${cell(spec.specName)} | ${spec.result === 'passed' ? 'Passed' : 'Failed'} | ${errors} | ${warnings} |`,
      );
    }
    lines.push('');
  }

  const allDiagnostics = [
    ...report.globalDiagnostics,
    ...report.specResults.flatMap((spec) => spec.diagnostics),
  ];
  const blocking = allDiagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (blocking.length > 0) {
    lines.push('## Blocking issues');
    lines.push('');
    for (const diagnostic of blocking.slice(0, maxBlocking)) {
      lines.push(diagnosticLine(diagnostic));
    }
    if (blocking.length > maxBlocking) {
      lines.push(`- … and ${blocking.length - maxBlocking} more errors.`);
    }
    lines.push('');
  }

  if (report.verificationCommands.length > 0) {
    lines.push('## Verification commands');
    lines.push('');
    lines.push('| Command | Required | Outcome |');
    lines.push('|---|---|---|');
    for (const command of report.verificationCommands) {
      const outcome =
        command.disposition === 'executed'
          ? command.passed
            ? `passed (exit ${command.exitCode ?? 0})`
            : command.timedOut
              ? 'timed out'
              : `failed (exit ${command.exitCode ?? '?'})`
          : command.disposition === 'reused-evidence'
            ? 'passed (reused from evidence)'
            : 'not run';
      lines.push(`| ${code(command.name)} | ${command.required ? 'yes' : 'no'} | ${cell(outcome)} |`);
    }
    lines.push('');
  }

  if (report.globalDiagnostics.length > 0) {
    lines.push('## Workspace findings');
    lines.push('');
    for (const diagnostic of report.globalDiagnostics.slice(0, maxDiagnostics)) {
      lines.push(diagnosticLine(diagnostic));
    }
    lines.push('');
  }

  for (const spec of report.specResults) {
    lines.push(...specSection(spec, maxDiagnostics));
  }

  const artifacts = options.artifactPaths;
  if (artifacts !== undefined && (artifacts.json ?? artifacts.markdown ?? artifacts.html) !== undefined) {
    lines.push('## Reports');
    lines.push('');
    if (artifacts.json !== undefined) lines.push(`- JSON: ${code(artifacts.json)}`);
    if (artifacts.markdown !== undefined) lines.push(`- Markdown: ${code(artifacts.markdown)}`);
    if (artifacts.html !== undefined) lines.push(`- HTML: ${code(artifacts.html)}`);
    lines.push('');
  }

  lines.push(
    `<sub>specbridge ${report.tool.version} · verification ${report.verificationId} · ${report.createdAt}</sub>`,
  );
  lines.push('');
  return lines.join('\n');
}
