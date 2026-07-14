import { CLI_BIN } from '@specbridge/core';
import type { TaskDryRunPlan, TaskPreflight, TaskRunReport } from '@specbridge/execution';
import {
  blockedLine,
  dim,
  failLine,
  infoLine,
  okLine,
  reportTitle,
  sectionTitle,
  warnLine,
} from '@specbridge/reporting';
import type { WorkspaceInfo } from '@specbridge/core';
import type { CliRuntime } from './context.js';
import { relPath } from './context.js';

/** Shared rendering for task execution results (spec run / run resume). */

const RESULT_LABEL: Record<TaskRunReport['evidenceStatus'], string> = {
  verified: 'VERIFIED',
  'manually-accepted': 'MANUALLY ACCEPTED',
  'implemented-unverified': 'IMPLEMENTED BUT UNVERIFIED',
  'no-change': 'NO CHANGE',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  'timed-out': 'TIMED OUT',
};

export function renderPreflightFailure(runtime: CliRuntime, preflight: TaskPreflight): void {
  const failure = preflight.failure;
  if (failure === undefined) return;
  runtime.err(failure.message);
  if (failure.dirtyPaths !== undefined && failure.dirtyPaths.length > 0) {
    runtime.err('');
    runtime.err('Changed paths:');
    for (const dirtyPath of failure.dirtyPaths.slice(0, 20)) runtime.err(`  ${dirtyPath}`);
    if (failure.dirtyPaths.length > 20) {
      runtime.err(`  … and ${failure.dirtyPaths.length - 20} more`);
    }
  }
  if (failure.detection !== undefined) {
    for (const diagnostic of failure.detection.diagnostics.filter((d) => d.severity === 'error')) {
      runtime.err(`  ${diagnostic.message}`);
    }
  }
  if (failure.selection !== undefined) {
    if (failure.selection.requiredCapabilities.length > 0) {
      runtime.err('');
      runtime.err('Required capabilities:');
      for (const key of failure.selection.requiredCapabilities) runtime.err(`  ${key}`);
    }
    if (failure.selection.declaredCapabilities !== undefined) {
      const declared = Object.entries(failure.selection.declaredCapabilities)
        .filter(([, available]) => available)
        .map(([key]) => key);
      runtime.err('');
      runtime.err('Detected capabilities:');
      for (const key of declared) runtime.err(`  ${key}`);
    }
    if (failure.selection.compatibleProfiles.length > 0) {
      runtime.err('');
      runtime.err('Compatible configured profiles:');
      for (const profile of failure.selection.compatibleProfiles) runtime.err(`  ${profile}`);
    }
  }
  if (failure.remediation.length > 0) {
    runtime.err('');
    runtime.err('Resolution:');
    for (const step of failure.remediation) runtime.err(`  ${step}`);
  }
}

export function renderDryRunPlan(
  runtime: CliRuntime,
  workspace: WorkspaceInfo,
  plan: TaskDryRunPlan,
): void {
  runtime.out(reportTitle(`Dry run: task execution plan`));
  runtime.out();
  runtime.out(`  Spec: ${plan.specName}`);
  runtime.out(`  Task: ${plan.task.id} ${plan.task.title}`);
  runtime.out(`  Runner: ${plan.runner}`);
  runtime.out();
  runtime.out(sectionTitle('Prerequisites'));
  runtime.out(okLine('All required stages approved and unchanged'));
  runtime.out(
    plan.gitClean
      ? okLine('Working tree clean')
      : warnLine(`Working tree dirty (${plan.dirtyPaths.length} path(s) baselined)`),
  );
  runtime.out();
  runtime.out(sectionTitle('Verification commands'));
  if (plan.verificationCommands.length === 0) {
    runtime.out(warnLine('none configured — the task cannot reach "verified" automatically'));
  }
  for (const command of plan.verificationCommands) {
    runtime.out(infoLine(`${command.name}: ${command.argv.join(' ')}`, command.required ? 'required' : 'optional'));
  }
  runtime.out();
  runtime.out(sectionTitle('Runner invocation'));
  runtime.out(`  Tools: ${plan.tools.join(', ')}`);
  runtime.out(`  Permission mode: ${plan.permissionMode} (bypass is never used)`);
  runtime.out(`  Timeout: ${plan.timeoutMs} ms`);
  if (plan.argvPreview !== undefined) {
    runtime.out(`  Command: ${plan.argvPreview.join(' ')}`);
  }
  runtime.out();
  runtime.out(sectionTitle('Expected run artifacts'));
  for (const artifact of plan.expectedArtifacts) runtime.out(`  ${artifact}`);
  runtime.out();
  for (const warning of plan.warnings) runtime.out(warnLine(warning));
  runtime.out(sectionTitle('Task prompt'));
  runtime.outRaw(`${plan.prompt}\n`);
  runtime.out(dim('Dry run: the runner was NOT invoked; no files, runs, or state were written.'));
}

export function renderTaskRunReport(
  runtime: CliRuntime,
  workspace: WorkspaceInfo,
  report: TaskRunReport,
): void {
  runtime.out(reportTitle('Task Execution'));
  runtime.out();
  runtime.out(`  Spec: ${report.specName}`);
  runtime.out(`  Task: ${report.taskId} ${report.taskTitle}`);
  runtime.out(`  Runner: ${report.runner}`);
  runtime.out(`  Run: ${report.runId}`);
  if (report.parentRunId !== undefined) {
    runtime.out(dim(`  Parent run: ${report.parentRunId}`));
  }
  runtime.out();

  runtime.out(sectionTitle('Repository'));
  const agentChanges = report.changedFiles.filter((file) => file.modifiedDuringRun);
  const preExisting = report.changedFiles.filter((file) => file.preExisting && !file.modifiedDuringRun);
  runtime.out(okLine('State captured before and after execution'));
  if (agentChanges.length > 0) {
    runtime.out(okLine(`${agentChanges.length} file(s) changed by the run`));
    for (const file of agentChanges.slice(0, 15)) {
      runtime.out(infoLine(`${file.changeType}: ${file.path}${file.preExisting ? ' (was already dirty — ambiguous)' : ''}`));
    }
  } else {
    runtime.out(infoLine('No file changed during the run'));
  }
  if (preExisting.length > 0) {
    runtime.out(warnLine(`${preExisting.length} pre-existing change(s) baselined, not attributed to the task`));
  }
  runtime.out();

  runtime.out(sectionTitle('Runner'));
  if (report.outcome === 'completed' || report.outcome === 'no-change') {
    runtime.out(okLine(`Outcome: ${report.outcome}`));
  } else {
    runtime.out(failLine(`Outcome: ${report.outcome}`, report.failureReason));
  }
  if (report.runnerSummary !== undefined) {
    runtime.out(infoLine(`Reported: ${report.runnerSummary}`));
    runtime.out(dim('    (runner reports are claims; only the evidence below counts)'));
  }
  runtime.out();

  runtime.out(sectionTitle('Verification'));
  if (report.verification.skipped) {
    runtime.out(warnLine('Skipped (--no-verify) — the task cannot be verified'));
  } else if (!report.verification.ran) {
    runtime.out(infoLine('Not run (nothing to verify for this outcome)'));
  } else if (report.verification.commands.length === 0) {
    runtime.out(warnLine('No verification commands configured'));
  } else {
    for (const command of report.verification.commands) {
      runtime.out(
        command.passed
          ? okLine(`${command.name}`, command.argv.join(' '))
          : failLine(`${command.name} failed (exit ${command.exitCode ?? 'none'})`, command.argv.join(' ')),
      );
    }
  }
  runtime.out();

  runtime.out(sectionTitle('Evidence'));
  for (const reason of report.reasons) runtime.out(infoLine(reason));
  for (const violation of report.violations) runtime.out(failLine(`VIOLATION: ${violation}`));
  for (const warning of report.warnings) runtime.out(warnLine(warning));
  runtime.out(
    report.checkboxUpdated
      ? okLine('Task checkbox updated ([ ] → [x], surgical edit)')
      : blockedLine('Task checkbox unchanged'),
  );
  runtime.out(dim(`  Evidence: ${relPath(workspace, report.evidencePath)}`));
  runtime.out(dim(`  Artifacts: ${relPath(workspace, report.artifactsDir)}`));
  runtime.out();
  runtime.out(reportTitle(`Result: ${RESULT_LABEL[report.evidenceStatus]}`));
  if (report.evidenceStatus !== 'verified' && report.evidenceStatus !== 'manually-accepted') {
    runtime.out(dim(`  Inspect: ${CLI_BIN} run show ${report.runId}`));
    if (report.resumeSupported) {
      runtime.out(dim(`  Resume:  ${CLI_BIN} run resume ${report.runId}`));
    }
  }
}

export function taskRunReportToJson(report: TaskRunReport): unknown {
  return report;
}
