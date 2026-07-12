import type {
  SpecVerificationResult,
  VerificationDiagnostic,
  VerificationReport,
} from '@specbridge/core';
import { escapeHtml } from './html-report.js';

/**
 * Self-contained static HTML rendering for verification reports.
 *
 *   - no external requests of any kind (CSS is inline, no fonts, no CDN)
 *   - no JavaScript: severity and spec filters use CSS-only checkboxes;
 *     all content is fully readable with CSS disabled too
 *   - all dynamic content is HTML-escaped
 *   - works from file:// and inside artifact viewers
 */

function severityGlyph(severity: VerificationDiagnostic['severity']): string {
  if (severity === 'error') return '✗';
  if (severity === 'warning') return '!';
  return '·';
}

function specSlug(index: number): string {
  return `spec-${index}`;
}

function renderDiagnostic(diagnostic: VerificationDiagnostic, specClass: string): string {
  const location =
    diagnostic.file !== null
      ? `<code>${escapeHtml(diagnostic.file.path)}${diagnostic.file.line !== null ? `:${diagnostic.file.line}` : ''}</code>`
      : diagnostic.taskId !== null
        ? `task <code>${escapeHtml(diagnostic.taskId)}</code>`
        : '';
  return [
    `<li class="diag ${diagnostic.severity} ${specClass}">`,
    `<span class="glyph" aria-hidden="true">${severityGlyph(diagnostic.severity)}</span>`,
    `<div><p class="head"><strong>${escapeHtml(diagnostic.ruleId)}</strong>`,
    ` <span class="sev">${diagnostic.severity}</span>`,
    diagnostic.confidence === 'heuristic' ? ' <span class="heuristic">heuristic</span>' : '',
    location !== '' ? ` — ${location}` : '',
    `</p><p>${escapeHtml(diagnostic.message)}</p>`,
    `<p class="fix">Fix: ${escapeHtml(diagnostic.remediation)}</p></div></li>`,
  ].join('');
}

function renderSpec(spec: SpecVerificationResult, index: number): string {
  const cls = specSlug(index);
  const t = spec.traceability;
  const e = spec.evidence;
  const rows = spec.changedFiles
    .map(
      (file) =>
        `<tr><td>${escapeHtml(file.changeType)}</td><td><code>${escapeHtml(file.path)}</code>${
          file.oldPath !== null ? ` <span class="from">from <code>${escapeHtml(file.oldPath)}</code></span>` : ''
        }</td><td class="num">${file.binary ? 'binary' : `+${file.insertions ?? 0} −${file.deletions ?? 0}`}</td></tr>`,
    )
    .join('\n');
  return `
<section class="spec ${cls}">
<h2>${escapeHtml(spec.specName)} <span class="badge ${spec.result}">${spec.result}</span></h2>
<p class="meta">${escapeHtml(spec.specType)}${spec.managed ? '' : ' · unmanaged'} · policy: ${escapeHtml(spec.policyMode)}${
    spec.policyPath !== null ? ` (<code>${escapeHtml(spec.policyPath)}</code>)` : ' (defaults)'
  }</p>
<p class="meta">Traceability: ${t.requirements} requirements (${t.requirementsWithTasks} with tasks), ${t.tasks} tasks (${t.tasksWithRequirements} linked) ·
Evidence: ${e.valid} valid${e.manuallyAccepted > 0 ? ` (${e.manuallyAccepted} manually accepted)` : ''}, ${e.stale} stale, ${e.missing} missing${
    e.invalid > 0 ? `, ${e.invalid} invalid` : ''
  }</p>
${
  spec.changedFiles.length > 0
    ? `<details><summary>${spec.changedFiles.length} changed file${spec.changedFiles.length === 1 ? '' : 's'}</summary>
<table><thead><tr><th>Change</th><th>Path</th><th>Lines</th></tr></thead><tbody>
${rows}
</tbody></table></details>`
    : ''
}
${
  spec.diagnostics.length > 0
    ? `<ul class="diags">\n${spec.diagnostics.map((diagnostic) => renderDiagnostic(diagnostic, cls)).join('\n')}\n</ul>`
    : '<p class="ok">No findings.</p>'
}
</section>`;
}

/** Render a verification report as one portable HTML document. */
export function renderVerificationHtml(report: VerificationReport): string {
  const specFilters = report.specResults
    .map(
      (spec, index) =>
        `<label><input type="checkbox" id="f-${specSlug(index)}" checked> ${escapeHtml(spec.specName)}</label>`,
    )
    .join('\n');
  const specFilterCss = report.specResults
    .map(
      (_, index) =>
        `body:has(#f-${specSlug(index)}:not(:checked)) .${specSlug(index)} { display: none; }`,
    )
    .join('\n');

  const commandRows = report.verificationCommands
    .map((command) => {
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
      return `<tr class="${command.passed ? 'pass' : 'fail'}"><td><code>${escapeHtml(command.name)}</code></td><td>${
        command.required ? 'required' : 'optional'
      }</td><td><code>${escapeHtml(command.argv.join(' '))}</code></td><td>${escapeHtml(outcome)}</td></tr>`;
    })
    .join('\n');

  const summary = report.summary;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SpecBridge verification — ${escapeHtml(summary.result)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; border-bottom: 1px solid #8884; padding-bottom: 0.25rem; margin-top: 2rem; }
  code { background: #8881; padding: 0 0.25em; border-radius: 3px; word-break: break-all; }
  .meta { color: #777; margin: 0.15rem 0; }
  .badge { font-size: 0.8rem; padding: 0.1rem 0.5rem; border-radius: 999px; vertical-align: middle; }
  .badge.passed { background: #1a7f3722; color: #1a7f37; }
  .badge.failed { background: #cf222e22; color: #cf222e; }
  .result { font-size: 1.1rem; font-weight: 700; }
  .result.passed { color: #1a7f37; }
  .result.failed { color: #cf222e; }
  fieldset { border: 1px solid #8884; border-radius: 6px; margin: 1rem 0; padding: 0.5rem 0.75rem; }
  fieldset label { margin-right: 1rem; white-space: nowrap; }
  ul.diags { list-style: none; padding-left: 0; }
  .diag { display: flex; gap: 0.6rem; padding: 0.4rem 0; border-bottom: 1px dashed #8883; }
  .diag p { margin: 0.1rem 0; }
  .diag .head { font-size: 0.95rem; }
  .glyph { width: 1.2em; text-align: center; font-weight: 700; }
  .diag.error .glyph { color: #cf222e; }
  .diag.warning .glyph { color: #b08800; }
  .diag.info .glyph { color: #777; }
  .sev { font-size: 0.75rem; border: 1px solid #8886; border-radius: 999px; padding: 0 0.4em; color: #777; }
  .heuristic { font-size: 0.75rem; background: #8882; border-radius: 999px; padding: 0 0.4em; color: #777; }
  .fix { color: #777; font-size: 0.9rem; }
  .ok { color: #1a7f37; }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
  th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #8883; font-size: 0.9rem; vertical-align: top; }
  td.num { text-align: right; white-space: nowrap; }
  tr.fail td:last-child { color: #cf222e; }
  .from { color: #777; }
  footer { margin-top: 2rem; color: #777; font-size: 0.85rem; }
  /* CSS-only filters (no JavaScript anywhere in this document). */
  body:has(#f-error:not(:checked)) .diag.error { display: none; }
  body:has(#f-warning:not(:checked)) .diag.warning { display: none; }
  body:has(#f-info:not(:checked)) .diag.info { display: none; }
${specFilterCss}
</style>
</head>
<body>
<h1>SpecBridge Verification</h1>
<p class="result ${summary.result}">${summary.result === 'passed' ? 'PASSED' : 'FAILED'} — ${summary.errors} errors, ${summary.warnings} warnings, ${summary.info} info</p>
<p class="meta">Comparison: <code>${escapeHtml(report.comparison.label)}</code> · selection: ${escapeHtml(report.selection.mode)} · ${summary.specsVerified} spec(s) verified</p>
<p class="meta">specbridge ${escapeHtml(report.tool.version)} · verification <code>${escapeHtml(report.verificationId)}</code> · ${escapeHtml(report.createdAt)}</p>

<fieldset>
<legend>Filters (CSS only — content remains in the document)</legend>
<label><input type="checkbox" id="f-error" checked> errors</label>
<label><input type="checkbox" id="f-warning" checked> warnings</label>
<label><input type="checkbox" id="f-info" checked> info</label>
${specFilters}
</fieldset>

${
  report.globalDiagnostics.length > 0
    ? `<section><h2>Workspace findings</h2><ul class="diags">
${report.globalDiagnostics.map((diagnostic) => renderDiagnostic(diagnostic, 'global')).join('\n')}
</ul></section>`
    : ''
}

${
  report.verificationCommands.length > 0
    ? `<section><h2>Verification commands</h2>
<table><thead><tr><th>Command</th><th>Kind</th><th>argv</th><th>Outcome</th></tr></thead><tbody>
${commandRows}
</tbody></table></section>`
    : ''
}

${report.specResults.map((spec, index) => renderSpec(spec, index)).join('\n')}

<footer>Generated by specbridge spec verify — deterministic, offline, no model involved.</footer>
</body>
</html>
`;
}
