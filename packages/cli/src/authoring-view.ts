import { CLI_BIN } from '@specbridge/core';
import type {
  AuthoringAttemptSummary,
  AuthoringDataBoundary,
  StageAuthoringOutcome,
} from '@specbridge/execution';
import type { RunnerSelectionPlan } from '@specbridge/runners';
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
    case 'selection-failed':
      return {
        ...base,
        result: 'selection-failed',
        error: outcome.failure.error,
        operation: outcome.failure.operation,
        profile: outcome.failure.profile ?? null,
        requiredCapabilities: outcome.failure.requiredCapabilities,
        missingCapabilities: outcome.failure.missingCapabilities,
        compatibleProfiles: outcome.failure.compatibleProfiles,
      };
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
        profile: outcome.profile,
        outcome: outcome.result.outcome,
        failureReason: outcome.result.failureReason ?? null,
        artifactsDir: outcome.artifactsDir,
        attempts: outcome.attempts,
      };
    case 'invalid-candidate':
      return {
        ...base,
        result: 'invalid-candidate',
        runId: outcome.runId,
        profile: outcome.profile,
        candidatePath: outcome.candidatePath,
        errorCount: outcome.analysis.errorCount,
        warningCount: outcome.analysis.warningCount,
        diagnostics: outcome.analysis.diagnostics,
        attempts: outcome.attempts,
      };
    case 'applied':
      return {
        ...base,
        result: 'applied',
        runId: outcome.runId,
        profile: outcome.profile,
        filePath: outcome.filePath,
        created: outcome.created,
        invalidated: outcome.invalidated,
        summary: outcome.summary,
        openQuestions: outcome.openQuestions,
        warningCount: outcome.analysis.warningCount,
        warnings: outcome.warnings,
        attempts: outcome.attempts,
      };
  }
}

/** Render the capability-checked selection plan (`--show-runner-plan`). */
export function renderRunnerPlan(
  runtime: CliRuntime,
  plan: RunnerSelectionPlan,
  dataBoundary?: AuthoringDataBoundary,
): void {
  runtime.out(sectionTitle('Runner plan'));
  runtime.out(`  Profile: ${plan.profile}`);
  runtime.out(`  Runner: ${plan.runner}`);
  runtime.out(`  Category: ${plan.category}`);
  runtime.out(`  Support: ${plan.supportLevel}`);
  runtime.out(`  Operation: ${plan.operation}`);
  runtime.out(`  Selected via: ${plan.origin}`);
  runtime.out();
  runtime.out('  Capabilities:');
  const label: Record<string, string> = {
    stageGeneration: 'Stage generation',
    stageRefinement: 'Stage refinement',
    taskExecution: 'Task execution',
    repositoryWrite: 'Repository writing',
    supportsJsonSchema: 'JSON Schema output',
    supportsCancellation: 'Cancellation',
  };
  for (const key of [
    'stageGeneration',
    'stageRefinement',
    'supportsJsonSchema',
    'supportsCancellation',
    'taskExecution',
    'repositoryWrite',
  ] as const) {
    runtime.out(`  ${plan.declaredCapabilities[key] ? '✓' : '○'} ${label[key]}`);
  }
  if (plan.fallbackChain.length > 0) {
    runtime.out();
    runtime.out(`  Fallback chain (explicitly configured): ${plan.fallbackChain.join(' → ')}`);
  }
  for (const constraint of plan.constraints) {
    runtime.out(dim(`  ${constraint}`));
  }
  if (dataBoundary !== undefined) {
    runtime.out();
    runtime.out('  Data boundary:');
    if (dataBoundary.endpoint !== undefined) runtime.out(`    Endpoint: ${dataBoundary.endpoint}`);
    runtime.out(`    Network-backed: ${dataBoundary.networkBacked ? 'yes' : 'no'}`);
    runtime.out(`    Model: ${dataBoundary.model ?? '(not configured)'}`);
    runtime.out(`    Input characters (approx.): ${dataBoundary.inputCharacters}`);
    runtime.out('    Documents:');
    for (const document of dataBoundary.documents) runtime.out(`    - ${document}`);
  }
  runtime.out();
}

function renderAttempts(runtime: CliRuntime, attempts: AuthoringAttemptSummary[]): void {
  if (attempts.length <= 1) return;
  runtime.out(sectionTitle('Attempts'));
  for (const attempt of attempts) {
    const line = attempt.outcome === 'completed' ? okLine : attempt.kind === 'skipped' ? warnLine : failLine;
    runtime.out(line(`${attempt.profile} (${attempt.kind})`, `${attempt.outcome} — ${attempt.reason}`));
  }
  runtime.out();
}

export function renderAuthoringOutcome(
  runtime: CliRuntime,
  workspace: WorkspaceInfo,
  specName: string,
  stage: string,
  outcome: StageAuthoringOutcome,
  options: { json?: boolean; verbose?: boolean; showRunnerPlan?: boolean; schema: string },
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

  if (
    options.showRunnerPlan === true &&
    outcome.kind === 'applied' &&
    outcome.runnerPlan !== undefined
  ) {
    renderRunnerPlan(runtime, outcome.runnerPlan);
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
    case 'selection-failed': {
      runtime.err(outcome.failure.error.message);
      if (outcome.failure.requiredCapabilities.length > 0) {
        runtime.err('');
        runtime.err('Required capabilities:');
        for (const key of outcome.failure.requiredCapabilities) runtime.err(`  ${key}`);
      }
      if (outcome.failure.declaredCapabilities !== undefined) {
        const declared = Object.entries(outcome.failure.declaredCapabilities)
          .filter(([, available]) => available)
          .map(([key]) => key);
        runtime.err('');
        runtime.err('Detected capabilities:');
        for (const key of declared) runtime.err(`  ${key}`);
      }
      if (outcome.failure.compatibleProfiles.length > 0) {
        runtime.err('');
        runtime.err('Compatible configured profiles:');
        for (const profile of outcome.failure.compatibleProfiles) runtime.err(`  ${profile}`);
      }
      for (const step of outcome.failure.error.remediation) runtime.err(`  ${step}`);
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
      if (outcome.plan.runnerPlan !== undefined) {
        renderRunnerPlan(runtime, outcome.plan.runnerPlan, outcome.plan.dataBoundary);
      }
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
      renderAttempts(runtime, outcome.attempts);
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
      renderAttempts(runtime, outcome.attempts);
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
      renderAttempts(runtime, outcome.attempts);
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
