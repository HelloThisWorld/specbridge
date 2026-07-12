import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { resolveWorkspace, writeFileAtomic } from '@specbridge/core';
import type { VerifySelection } from '@specbridge/drift';
import { verifySpecs } from '@specbridge/drift';
import { renderVerificationHtml, renderVerificationMarkdown } from '@specbridge/reporting';
import { emitAnnotations } from './annotations.js';
import { resolveComparisonFromEvent } from './event.js';
import { parseActionInputs } from './inputs.js';
import { ACTION_VERSION } from './version.js';

/**
 * SpecBridge verification GitHub Action (node20).
 *
 * A thin wrapper around the shared @specbridge/drift verification engine:
 * no rule logic lives here. Requires no model, no API key, no Claude Code
 * installation, and performs no network access. It never modifies tracked
 * project files — its only writes are the generated reports under the
 * configured report directory.
 */

function readEventPayload(eventPath: string | undefined): unknown {
  if (eventPath === undefined || eventPath === '') return undefined;
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

export async function run(): Promise<void> {
  const inputs = parseActionInputs((name) => core.getInput(name));

  const workspaceDir = process.env['GITHUB_WORKSPACE'] ?? process.cwd();
  const workspace = resolveWorkspace(workspaceDir);
  if (workspace === undefined) {
    core.setFailed(
      `No .kiro directory found under ${workspaceDir}. ` +
        'Check out the repository containing your Kiro workspace before this step.',
    );
    return;
  }

  const eventResolution = resolveComparisonFromEvent({
    eventName: process.env['GITHUB_EVENT_NAME'],
    payload: readEventPayload(process.env['GITHUB_EVENT_PATH']),
    sha: process.env['GITHUB_SHA'],
    baseRef: inputs.baseRef,
    headRef: inputs.headRef,
  });
  if (!eventResolution.ok) {
    core.setFailed(eventResolution.message);
    return;
  }
  core.info(
    `Comparison: ${eventResolution.request.mode === 'diff' ? `${eventResolution.request.base}...${eventResolution.request.head}` : eventResolution.request.mode} (${eventResolution.source})`,
  );

  const selection: VerifySelection =
    inputs.mode === 'single'
      ? { mode: 'single', spec: inputs.spec as string }
      : { mode: inputs.mode };

  const reportDirectory = path.resolve(workspace.rootDir, inputs.reportDirectory);
  const result = await verifySpecs({
    workspace,
    selection,
    comparison: eventResolution.request,
    runVerification: inputs.runVerification,
    strict: inputs.strict,
    failOn: inputs.failOn,
    toolVersion: ACTION_VERSION,
    reportsDir: reportDirectory,
    onProgress: (message) => core.info(message),
  });
  const report = result.report;

  // ---- Reports --------------------------------------------------------------
  const jsonPath = path.join(reportDirectory, 'report.json');
  const markdownPath = path.join(reportDirectory, 'report.md');
  const htmlPath = path.join(reportDirectory, 'report.html');
  const relative = {
    json: toPosixRelative(workspace.rootDir, jsonPath),
    markdown: toPosixRelative(workspace.rootDir, markdownPath),
    html: toPosixRelative(workspace.rootDir, htmlPath),
  };
  const markdown = renderVerificationMarkdown(report, { artifactPaths: relative });
  writeFileAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileAtomic(markdownPath, `${markdown}\n`);
  writeFileAtomic(htmlPath, renderVerificationHtml(report));

  // ---- Outputs --------------------------------------------------------------
  core.setOutput('result', report.summary.result);
  core.setOutput('verification-id', report.verificationId);
  core.setOutput('spec-count', String(report.summary.specsVerified));
  core.setOutput('error-count', String(report.summary.errors));
  core.setOutput('warning-count', String(report.summary.warnings));
  core.setOutput('info-count', String(report.summary.info));
  core.setOutput('json-report', relative.json);
  core.setOutput('markdown-report', relative.markdown);
  core.setOutput('html-report', relative.html);
  core.setOutput('affected-specs', JSON.stringify(report.selection.specs));

  // ---- Annotations and step summary ------------------------------------------
  if (inputs.annotations) {
    const outcome = emitAnnotations(core, report, inputs.annotationLimit);
    core.info(
      `Annotations: ${outcome.emitted} emitted${outcome.suppressed > 0 ? `, ${outcome.suppressed} suppressed by the limit` : ''}.`,
    );
  }
  if (inputs.writeStepSummary) {
    await core.summary.addRaw(markdown, true).write();
  }

  core.info(
    `Verification ${report.summary.result}: ${report.summary.errors} errors, ` +
      `${report.summary.warnings} warnings, ${report.summary.info} info ` +
      `across ${report.summary.specsVerified} spec(s).`,
  );

  if (result.exitCode !== 0) {
    const reason =
      result.exitCode === 3
        ? 'the git comparison could not be resolved (shallow clone? use actions/checkout with fetch-depth: 0)'
        : result.exitCode === 2
          ? 'a verification policy or configuration is invalid'
          : result.exitCode === 4
            ? 'a required verification command failed to start'
            : result.exitCode === 5
              ? 'a required verification command timed out'
              : `the ${inputs.failOn} failure threshold was reached`;
    core.setFailed(`SpecBridge verification failed: ${reason}. See the step summary and ${relative.markdown}.`);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
