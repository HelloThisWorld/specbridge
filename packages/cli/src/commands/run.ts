import type { Command } from 'commander';
import { CLI_BIN } from '@specbridge/core';
import type { TaskEvidenceRecord, VerificationRunResult } from '@specbridge/evidence';
import type { RunRecord } from '@specbridge/execution';
import {
  diagnoseInteractiveLock,
  listRuns,
  readRunArtifactJson,
  readRunArtifactText,
  readRunRecord,
  removeDiagnosedLock,
  resumeRun,
  runDir,
  updateRunRecord,
} from '@specbridge/execution';
import {
  createJsonReport,
  dim,
  failLine,
  infoLine,
  okLine,
  renderColumns,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import { SpecBridgeError } from '@specbridge/core';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { loadExecutionContext, parseTimeout } from '../execution-context.js';
import { renderDryRunPlan, renderPreflightFailure, renderTaskRunReport } from '../run-view.js';
import { VERSION } from '../version.js';

/**
 * `specbridge run list|show|resume` — inspect and resume recorded runs.
 * Run directories are append-only history under `.specbridge/runs/`.
 */

interface RunViewOptions {
  json?: boolean;
  verbose?: boolean;
  timeout?: string;
  dryRun?: boolean;
}

function shortDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function registerRunCommands(program: Command, runtime: CliRuntime): void {
  const run = program.command('run').description('Inspect and resume recorded runner executions');

  run
    .command('list')
    .description('List recorded runs (newest first)')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include warnings recorded on each run')
    .addHelpText(
      'after',
      `
Examples:
  ${CLI_BIN} run list
  ${CLI_BIN} run list --json`,
    )
    .action((options: RunViewOptions) => {
      const workspace = runtime.workspace();
      const { runs, diagnostics } = listRuns(workspace);
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.run-list/1', `${CLI_BIN} ${VERSION}`, { runs, diagnostics }),
          ),
        );
        return;
      }
      runtime.out(reportTitle('Runs'));
      runtime.out();
      if (runs.length === 0) {
        runtime.out(infoLine('No runs recorded yet.'));
        runtime.out(dim(`  Runs are created by: ${CLI_BIN} spec generate/refine/run`));
        return;
      }
      const rows = runs.map((record) => [
        record.runId.slice(0, 12),
        record.kind,
        record.specName,
        record.taskId ?? record.stage ?? '—',
        record.runner,
        record.createdAt,
        shortDuration(record.durationMs),
        record.evidenceStatus ?? record.outcome ?? '(in progress)',
      ]);
      for (const line of renderColumns([
        ['RUN', 'KIND', 'SPEC', 'TARGET', 'RUNNER', 'STARTED', 'TIME', 'RESULT'],
        ...rows,
      ])) {
        runtime.out(line);
      }
      if (options.verbose === true) {
        for (const diagnostic of diagnostics) runtime.out(warnLine(diagnostic.message));
      }
      runtime.out();
      runtime.out(dim(`  Details: ${CLI_BIN} run show <run-id>  (prefixes are not accepted; use the full id from --json when ambiguous)`));
    });

  run
    .command('show <run-id>')
    .description('Show one run: request, outcome, changed files, verification, evidence')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include the prompt and raw runner output')
    .addHelpText(
      'after',
      `
Raw prompts and raw model output are only printed with --verbose; they are
always retained on disk under .specbridge/runs/<run-id>/.

Examples:
  ${CLI_BIN} run show 8d4f1c22-3e51-4c2e-9f43-0a2b7c1d2e3f
  ${CLI_BIN} run show <run-id> --verbose`,
    )
    .action((runId: string, options: RunViewOptions) => {
      const workspace = runtime.workspace();
      const record = resolveRun(workspace, runId);
      const evidence = readRunArtifactJson(workspace, record.runId, 'evidence.json') as
        | TaskEvidenceRecord
        | undefined;
      const verification = readRunArtifactJson(workspace, record.runId, 'verification.json') as
        | VerificationRunResult
        | undefined;
      const runnerResult = readRunArtifactJson(workspace, record.runId, 'runner-result.json') as
        | Record<string, unknown>
        | undefined;

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.run-show/1', `${CLI_BIN} ${VERSION}`, {
              run: record,
              evidence: evidence ?? null,
              verification: verification ?? null,
              runnerResult: runnerResult ?? null,
              artifactsDir: runDir(workspace, record.runId),
            }),
          ),
        );
        return;
      }

      runtime.out(reportTitle(`Run ${record.runId}`));
      runtime.out();
      const rows: string[][] = [
        ['Kind', record.kind],
        ['Spec', record.specName],
        ['Target', record.taskId ?? record.stage ?? '—'],
        ['Runner', record.runner],
        ['Started', record.createdAt],
        ['Finished', record.finishedAt ?? '(in progress or aborted)'],
        ['Duration', shortDuration(record.durationMs)],
        ['Outcome', String(record.outcome ?? '—')],
        ['Evidence', String(record.evidenceStatus ?? '—')],
        ['Session', record.sessionId ?? '—'],
        ['Resumable', record.resumeSupported ? 'yes' : 'no'],
        ['Parent run', record.parentRunId ?? '—'],
      ];
      for (const line of renderColumns(rows)) runtime.out(line);
      runtime.out();

      if (evidence !== undefined) {
        runtime.out(sectionTitle('Actual changed files'));
        const changed = evidence.changedFiles.filter((file) => file.modifiedDuringRun);
        if (changed.length === 0) runtime.out(infoLine('none'));
        for (const file of changed) {
          runtime.out(infoLine(`${file.changeType}: ${file.path}${file.preExisting ? ' (pre-existing, ambiguous)' : ''}`));
        }
        runtime.out();
        if (evidence.violations.length > 0) {
          runtime.out(sectionTitle('Violations'));
          for (const violation of evidence.violations) runtime.out(failLine(violation));
          runtime.out();
        }
        if (evidence.manualAcceptance !== undefined) {
          runtime.out(sectionTitle('Manual acceptance'));
          runtime.out(warnLine(`Accepted by ${evidence.manualAcceptance.actor}: ${evidence.manualAcceptance.reason}`));
          runtime.out();
        }
      }
      if (verification !== undefined && verification.commands.length > 0) {
        runtime.out(sectionTitle('Verification commands'));
        for (const command of verification.commands) {
          runtime.out(
            command.passed
              ? okLine(command.name, command.argv.join(' '))
              : failLine(`${command.name} (exit ${command.exitCode ?? 'none'})`, command.argv.join(' ')),
          );
        }
        runtime.out();
      }
      if (record.warnings.length > 0) {
        runtime.out(sectionTitle('Warnings'));
        for (const warning of record.warnings) runtime.out(warnLine(warning));
        runtime.out();
      }
      if (options.verbose === true) {
        const prompt = readRunArtifactText(workspace, record.runId, 'prompt.md');
        if (prompt !== undefined) {
          runtime.out(sectionTitle('Prompt'));
          runtime.outRaw(`${prompt}\n`);
        }
        const stdout = readRunArtifactText(workspace, record.runId, 'raw-stdout.log');
        if (stdout !== undefined) {
          runtime.out(sectionTitle('Raw stdout'));
          runtime.outRaw(`${stdout}\n`);
        }
      }
      runtime.out(dim(`  Artifacts: ${relPath(workspace, runDir(workspace, record.runId))}`));
    });

  run
    .command('resume <run-id>')
    .description('Resume an interrupted or unverified task run in its original agent session')
    .option('--timeout <duration>', 'runner timeout (e.g. 90s, 30m)')
    .option('--dry-run', 'print the resume plan and prompt; invoke nothing')
    .option('--no-verify', 'skip verification commands after the resumed run')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Resume continues the SAME task in the SAME recorded agent session. It is
refused when the run is already verified, the session id is missing, the
runner cannot resume, approvals went stale, the task changed, or the
repository diverged from the run's recorded post-state — in that case fix
the repository or start a fresh attempt (lineage is kept via parentRunId).

Exit codes: 0 resumed and verified · 1 refused or unverified · 2 usage ·
3 resume unsupported · 4 runner failure · 5 timeout/cancel · 6 safety.

Examples:
  ${CLI_BIN} run resume 8d4f1c22-3e51-4c2e-9f43-0a2b7c1d2e3f
  ${CLI_BIN} run resume <run-id> --dry-run`,
    )
    .action(async (runId: string, options: RunViewOptions & { verify?: boolean }) => {
      const context = loadExecutionContext(runtime);
      const record = resolveRun(context.workspace, runId);
      const outcome = await resumeRun(
        {
          workspace: context.workspace,
          config: context.config,
          registry: context.registry,
          clock: () => runtime.now(),
          onProgress: (message: string) => {
            if (options.json !== true) runtime.err(dim(message));
          },
        },
        {
          runId: record.runId,
          ...(options.timeout !== undefined ? { timeoutMs: parseTimeout(options.timeout) } : {}),
          ...(options.verify === false ? { noVerify: true } : {}),
          ...(options.dryRun === true ? { dryRun: true } : {}),
        },
      );
      runtime.exitCode = outcome.exitCode;

      if (options.json === true) {
        const data =
          outcome.kind === 'executed'
            ? { result: 'executed', originalRunId: outcome.originalRunId, report: outcome.report }
            : outcome.kind === 'dry-run'
              ? { result: 'dry-run', plan: outcome.plan }
              : outcome.kind === 'refused'
                ? {
                    result: 'refused',
                    message: outcome.message,
                    remediation: outcome.remediation,
                    divergence: outcome.divergence ?? [],
                  }
                : {
                    result: 'preflight-failed',
                    failure: {
                      code: outcome.preflight.failure?.code,
                      message: outcome.preflight.failure?.message,
                    },
                  };
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.run-resume/1', `${CLI_BIN} ${VERSION}`, {
              runId: record.runId,
              ...(data as Record<string, unknown>),
            }),
          ),
        );
        return;
      }

      switch (outcome.kind) {
        case 'refused': {
          runtime.err(outcome.message);
          if (outcome.divergence !== undefined && outcome.divergence.length > 0) {
            runtime.err('');
            runtime.err('Divergence:');
            for (const difference of outcome.divergence) runtime.err(`  ${difference}`);
          }
          if (outcome.remediation.length > 0) {
            runtime.err('');
            for (const step of outcome.remediation) runtime.err(`  ${step}`);
          }
          return;
        }
        case 'preflight-failed':
          renderPreflightFailure(runtime, outcome.preflight);
          return;
        case 'dry-run':
          renderDryRunPlan(runtime, context.workspace, outcome.plan);
          return;
        case 'executed':
          runtime.out(dim(`Resumed from run ${outcome.originalRunId}`));
          runtime.out();
          renderTaskRunReport(runtime, context.workspace, outcome.report);
          return;
      }
    });

  run
    .command('recover-lock')
    .description('Diagnose the interactive execution lock and remove it after explicit confirmation')
    .option('--dry-run', 'diagnose only; never remove anything (same as running without --remove)')
    .option('--remove', 'explicitly confirm removal of a lock diagnosed as stale')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
The interactive lock (.specbridge/locks/interactive-task.lock) guarantees a
single active interactive task run per repository. A crashed process leaves
it behind by design — SpecBridge never steals a lock silently.

Recovery is two-step: run without flags to see the diagnosis (referenced
run, owner process, heartbeat age), then rerun with --remove to confirm.
A lock whose owner is still alive, or whose staleness is ambiguous, is
never removed. Removing a stale lock also marks its still-open run ABORTED.

Exit codes: 0 no lock / removed / active-and-healthy · 1 stale or ambiguous
lock present (action needed) · 2 usage or runtime error.

Examples:
  ${CLI_BIN} run recover-lock
  ${CLI_BIN} run recover-lock --remove`,
    )
    .action((options: { dryRun?: boolean; remove?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      const clock = (): Date => runtime.now();
      const diagnosis = diagnoseInteractiveLock(workspace, clock);
      const wantsRemoval = options.remove === true && options.dryRun !== true;

      let removed = false;
      let abortedRun: string | undefined;
      if (wantsRemoval && diagnosis.safeToRemove) {
        const result = removeDiagnosedLock(workspace, clock);
        removed = result.removed;
        // Keep the run record consistent: a removed lock's still-open run
        // can never be completed, so it is closed as aborted.
        const runId = result.diagnosis.lock?.runId;
        if (removed && runId !== undefined) {
          const record = readRunRecord(workspace, runId);
          if (record !== undefined && record.lifecycleStatus === 'AWAITING_AGENT_CHANGES') {
            updateRunRecord(workspace, runId, {
              lifecycleStatus: 'ABORTED',
              abortReason: 'stale lock removed via "specbridge run recover-lock --remove"',
              outcome: 'cancelled',
              finishedAt: runtime.now().toISOString(),
            });
            abortedRun = runId;
          }
        }
      }

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.run-recover-lock/1', `${CLI_BIN} ${VERSION}`, {
              state: diagnosis.state,
              lock: diagnosis.lock ?? null,
              findings: diagnosis.findings,
              safeToRemove: diagnosis.safeToRemove,
              removed,
              abortedRun: abortedRun ?? null,
            }),
          ),
        );
        runtime.exitCode = diagnosis.state === 'absent' || removed || diagnosis.state === 'active' ? 0 : 1;
        return;
      }

      runtime.out(reportTitle('Interactive lock recovery'));
      runtime.out();
      for (const finding of diagnosis.findings) runtime.out(infoLine(finding));
      runtime.out();
      switch (diagnosis.state) {
        case 'absent':
          runtime.out(okLine('No lock is held; nothing to recover.'));
          runtime.exitCode = 0;
          return;
        case 'active':
          runtime.out(okLine('The lock is actively held; leave it alone.'));
          runtime.out(dim('  Finish the run with task_complete / task_abort from its owning session.'));
          runtime.exitCode = 0;
          return;
        case 'ambiguous':
          runtime.out(warnLine('The lock state is ambiguous; SpecBridge will not remove it.'));
          runtime.out(dim('  Re-check later, or finish/abort the run from its owning session.'));
          runtime.exitCode = 1;
          return;
        case 'stale':
        case 'unreadable':
          if (removed) {
            runtime.out(okLine('Lock removed.'));
            if (abortedRun !== undefined) {
              runtime.out(infoLine(`Run ${abortedRun} was marked ABORTED (its work is preserved on disk).`));
            }
            runtime.exitCode = 0;
          } else if (wantsRemoval) {
            runtime.out(warnLine('The lock was not removed (its state changed during recovery). Re-run the diagnosis.'));
            runtime.exitCode = 1;
          } else {
            runtime.out(warnLine('The lock appears stale.'));
            runtime.out(dim(`  Confirm removal explicitly with: ${CLI_BIN} run recover-lock --remove`));
            runtime.exitCode = 1;
          }
          return;
      }
    });
}

/** Resolve a full or unambiguous-prefix run id. */
function resolveRun(workspace: ReturnType<CliRuntime['workspace']>, runId: string): RunRecord {
  const exact = readRunRecord(workspace, runId);
  if (exact !== undefined) return exact;
  const { runs } = listRuns(workspace);
  const matches = runs.filter((record) => record.runId.startsWith(runId));
  if (matches.length === 1) return matches[0] as RunRecord;
  if (matches.length > 1) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Run id prefix "${runId}" is ambiguous (${matches.length} matches). Use the full run id.`,
    );
  }
  throw new SpecBridgeError(
    'INVALID_ARGUMENT',
    `Run "${runId}" was not found under .specbridge/runs/. List runs with "${CLI_BIN} run list".`,
  );
}
