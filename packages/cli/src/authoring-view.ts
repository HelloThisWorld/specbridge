import { CLI_BIN } from '@specbridge/core';
import type { StageAuthoringOutcome } from '@specbridge/execution';
import {
  createJsonReport,
  dim,
  failLine,
  infoLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from './context.js';
import { relPath } from './context.js';
import type { WorkspaceInfo } from '@specbridge/core';
import { VERSION } from './version.js';

/** Shared rendering for `spec generate` and `spec refine` results. */

export function authoringOutcomeToJson(specName: string, outcome: StageAuthoringOutcome): unknown {
  const base = { specName };
  switch (outcome.kind) {
    case 'gate-failed':
      return { ...base, result: 'gate-failed', message: outcome.message, remediation: outcome.remediation };
    case 'runner-unavailable':
      return {
        ...base,
        result: 'runner-unavailable',
        runner: outcome.detection.runner,
        status: outcome.detection.status,
        diagnostics: outcome.detection.diagnostics,
      };
    case 'dry-run':
      return { ...base, result: 'dry-run', plan: outcome.plan };
    case 'runner-failed':
      return {
        ...base,
        result: 'runner-failed',
        runId: outcome.runId,
        outcome: outcome.result.outcome,
        failureReason: outcome.result.failureReason ?? null,
        artifactsDir: outcome.artifactsDir,
      };
    case 'invalid-candidate':
      return {
        ...base,
        result: 'invalid-candidate',
        runId: outcome.runId,
        candidatePath: outcome.candidatePath,
        errorCount: outcome.analysis.errorCount,
        warningCount: outcome.analysis.warningCount,
        diagnostics: outcome.analysis.diagnostics,
      };
    case 'applied':
      return {
        ...base,
        result: 'applied',
        runId: outcome.runId,
        filePath: outcome.filePath,
        created: outcome.created,
        invalidated: outcome.invalidated,
        summary: outcome.summary,
        openQuestions: outcome.openQuestions,
        warningCount: outcome.analysis.warningCount,
        warnings: outcome.warnings,
      };
  }
}

export function renderAuthoringOutcome(
  runtime: CliRuntime,
  workspace: WorkspaceInfo,
  specName: string,
  stage: string,
  outcome: StageAuthoringOutcome,
  options: { json?: boolean; verbose?: boolean; schema: string },
): void {
  runtime.exitCode = outcome.exitCode;
  if (options.json === true) {
    runtime.outRaw(
      serializeJsonReport(
        createJsonReport(options.schema, `${CLI_BIN} ${VERSION}`, authoringOutcomeToJson(specName, outcome)),
      ),
    );
    return;
  }

  switch (outcome.kind) {
    case 'gate-failed': {
      runtime.err(outcome.message);
      if (outcome.remediation.length > 0) {
        runtime.err('');
        runtime.err('Run:');
        for (const step of outcome.remediation) runtime.err(`  ${step}`);
      }
      return;
    }
    case 'runner-unavailable': {
      runtime.err(`The ${outcome.detection.runner} runner is not available (status: ${outcome.detection.status}).`);
      for (const diagnostic of outcome.detection.diagnostics.filter((d) => d.severity === 'error')) {
        runtime.err(`  ${diagnostic.message}`);
      }
      runtime.err('');
      runtime.err(`Diagnose it with: ${CLI_BIN} runner doctor ${outcome.detection.runner}`);
      return;
    }
    case 'dry-run': {
      runtime.out(reportTitle(`Dry run: ${outcome.plan.intent} ${stage} for ${specName}`));
      runtime.out();
      runtime.out(`  Runner: ${outcome.plan.runner}`);
      runtime.out(`  Tool policy: ${outcome.plan.toolPolicy} (no source modification)`);
      runtime.out(`  Target file: ${relPath(workspace, outcome.plan.targetFile)}`);
      runtime.out(`  Timeout: ${outcome.plan.timeoutMs} ms`);
      runtime.out(`  Prompt contract: v${outcome.plan.promptVersion}`);
      if (outcome.plan.argvPreview !== undefined) {
        runtime.out(`  Command: ${outcome.plan.argvPreview.join(' ')}`);
      }
      for (const warning of outcome.plan.warnings) runtime.out(warnLine(warning));
      runtime.out();
      runtime.out(sectionTitle('Prompt'));
      runtime.outRaw(`${outcome.plan.prompt}\n`);
      runtime.out(dim('Dry run: the runner was NOT invoked; no file or state was written.'));
      return;
    }
    case 'runner-failed': {
      runtime.err(
        `${stage} ${outcome.result.outcome === 'malformed-output' ? 'generation returned malformed output' : `generation ${outcome.result.outcome}`}.`,
      );
      if (outcome.result.failureReason !== undefined) runtime.err(`  ${outcome.result.failureReason}`);
      runtime.err('');
      runtime.err(dim(`Raw output retained: ${relPath(workspace, outcome.artifactsDir)}`));
      runtime.err(dim(`Inspect the run: ${CLI_BIN} run show ${outcome.runId}`));
      return;
    }
    case 'invalid-candidate': {
      runtime.out(reportTitle(`Generated ${stage} was NOT applied: ${specName}`));
      runtime.out();
      runtime.out(failLine(`Deterministic analysis found ${outcome.analysis.errorCount} error(s); the current document is unchanged.`));
      for (const diagnostic of outcome.analysis.diagnostics.filter((d) => d.severity === 'error')) {
        runtime.out(failLine(diagnostic.message));
      }
      runtime.out();
      runtime.out(`  Candidate retained: ${relPath(workspace, outcome.candidatePath)}`);
      runtime.out(dim('  Inspect it, then regenerate or write the document manually.'));
      return;
    }
    case 'applied': {
      runtime.out(reportTitle(`${outcome.created ? 'Generated' : 'Updated'}: ${specName} — ${stage}`));
      runtime.out();
      runtime.out(okLine(`${stage}.md written`, relPath(workspace, outcome.filePath)));
      runtime.out(infoLine(`Summary: ${outcome.summary}`));
      for (const invalidated of outcome.invalidated) {
        runtime.out(warnLine(`${invalidated} approval invalidated (it depended on ${stage})`));
      }
      if (outcome.analysis.warningCount > 0) {
        runtime.out(warnLine(`analysis reported ${outcome.analysis.warningCount} warning(s)`, `${CLI_BIN} spec analyze ${specName} --stage ${stage}`));
      }
      for (const question of outcome.openQuestions) {
        runtime.out(warnLine(`Open question: ${question}`));
      }
      for (const warning of outcome.warnings) {
        if (options.verbose === true) runtime.out(warnLine(warning));
      }
      if (options.verbose === true && outcome.diff.length > 0) {
        runtime.out();
        runtime.out(sectionTitle('Diff'));
        runtime.outRaw(outcome.diff);
      }
      runtime.out();
      runtime.out(okLine('The stage is DRAFT — nothing was auto-approved.'));
      runtime.out(dim(`  Review it, then: ${CLI_BIN} spec analyze ${specName} --stage ${stage}`));
      runtime.out(dim(`                   ${CLI_BIN} spec approve ${specName} --stage ${stage}`));
      runtime.out(dim(`  Run artifacts: ${relPath(workspace, outcome.artifactsDir)}`));
      return;
    }
  }
}
