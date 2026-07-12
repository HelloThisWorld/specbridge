import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import { runAllOpenTasks, runApprovedTask } from '@specbridge/execution';
import { createJsonReport, dim, okLine, reportTitle, serializeJsonReport, warnLine } from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import {
  loadExecutionContext,
  parsePositiveInt,
  parsePositiveNumber,
  parseTimeout,
} from '../execution-context.js';
import { renderDryRunPlan, renderPreflightFailure, renderTaskRunReport } from '../run-view.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec run <name>` — execute ONE approved implementation task
 * through a configured runner, capture actual repository evidence, run
 * trusted verification commands, and update the checkbox only when the
 * evidence is verified. `--all` runs open tasks sequentially and stops at
 * the first task that does not verify.
 */

interface SpecRunOptions {
  task?: string;
  next?: boolean;
  all?: boolean;
  runner?: string;
  model?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  timeout?: string;
  dryRun?: boolean;
  allowDirty?: boolean;
  verify?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export function registerSpecRunCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('run <name>')
    .description('Execute one approved task with a runner; evidence-gated checkbox completion')
    .option('--task <task-id>', 'execute this task (e.g. 2.3)')
    .option('--next', 'execute the next open required leaf task (default)')
    .option('--all', 'execute open required leaf tasks sequentially; stop on first unverified task')
    .option('--runner <name>', 'runner to use (default: config defaultRunner)')
    .option('--model <model>', 'model override passed to the runner')
    .option('--max-turns <number>', 'maximum agent turns for this run')
    .option('--max-budget-usd <number>', 'maximum budget for this run (when supported)')
    .option('--timeout <duration>', 'runner timeout (e.g. 90s, 30m)')
    .option('--dry-run', 'print the execution plan and prompt; invoke nothing, write nothing')
    .option('--allow-dirty', 'allow a dirty working tree (baselined; never attributed to the task)')
    .option('--no-verify', 'skip verification commands (task stays implemented-but-unverified)')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include raw runner output locations and extra detail')
    .addHelpText(
      'after',
      `
Requirements before any execution (checked, never assumed):
  - every stage approved and byte-identical to its approved hash
  - the selected task exists, is an open leaf task, and is not complete
  - the runner is installed, authenticated, and capable
  - the working tree is clean (or --allow-dirty baselines it)

After the runner returns, SpecBridge compares actual Git state, runs the
trusted verification commands from .specbridge/config.json, and evaluates
evidence. The checkbox flips to [x] ONLY for verified evidence — a model
claiming success is never enough. Runs never commit, push, or roll back.

Exit codes: 0 verified · 1 unverified/blocked/no-change or gate failure ·
2 usage · 3 runner unavailable · 4 runner failure · 5 timeout/cancel ·
6 permission or safety violation.

Examples:
  ${CLI_BIN} spec run notification-preferences
  ${CLI_BIN} spec run notification-preferences --task 2.3
  ${CLI_BIN} spec run notification-preferences --all
  ${CLI_BIN} spec run notification-preferences --task 2.3 --runner claude-code --max-turns 20
  ${CLI_BIN} spec run notification-preferences --task 1.1 --dry-run`,
    )
    .action(async (name: string, options: SpecRunOptions) => {
      if (options.task !== undefined && options.all === true) {
        throw new SpecBridgeError('INVALID_ARGUMENT', 'Use either --task or --all, not both.');
      }
      if (options.all === true && options.dryRun === true) {
        throw new SpecBridgeError('INVALID_ARGUMENT', '--dry-run plans a single task; combine it with --task or --next.');
      }
      const context = loadExecutionContext(runtime);
      const deps = {
        workspace: context.workspace,
        config: context.config,
        registry: context.registry,
        clock: () => runtime.now(),
        onProgress: (message: string) => {
          if (options.json !== true) runtime.err(dim(message));
        },
      };
      const shared = {
        specName: name,
        ...(options.runner !== undefined ? { runnerName: options.runner } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.maxTurns !== undefined
          ? { maxTurns: parsePositiveInt('--max-turns', options.maxTurns) }
          : {}),
        ...(options.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: parsePositiveNumber('--max-budget-usd', options.maxBudgetUsd) }
          : {}),
        ...(options.timeout !== undefined ? { timeoutMs: parseTimeout(options.timeout) } : {}),
        ...(options.allowDirty === true ? { allowDirty: true } : {}),
        ...(options.verify === false ? { noVerify: true } : {}),
      };

      if (options.all === true) {
        const summary = await runAllOpenTasks(deps, shared);
        runtime.exitCode = summary.exitCode;
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.spec-run-all/1', `${CLI_BIN} ${VERSION}`, {
                specName: name,
                attempted: summary.attempted,
                stoppedBecause: summary.stoppedBecause ?? null,
                exitCode: summary.exitCode,
              }),
            ),
          );
          return;
        }
        for (const report of summary.attempted) {
          renderTaskRunReport(runtime, context.workspace, report);
          runtime.out();
        }
        runtime.out(reportTitle('Batch summary'));
        runtime.out();
        const verified = summary.attempted.filter((r) => r.evidenceStatus === 'verified').length;
        runtime.out(okLine(`${verified}/${summary.attempted.length} attempted task(s) verified`));
        if (summary.stoppedBecause !== undefined) {
          runtime.out(warnLine(`Stopped: ${summary.stoppedBecause}`));
        } else {
          runtime.out(okLine('No open required leaf tasks remain'));
        }
        return;
      }

      const outcome = await runApprovedTask(deps, {
        ...shared,
        ...(options.task !== undefined ? { taskId: options.task } : { next: true }),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      });
      runtime.exitCode = outcome.exitCode;

      if (options.json === true) {
        const data =
          outcome.kind === 'executed'
            ? { result: 'executed', report: outcome.report }
            : outcome.kind === 'dry-run'
              ? { result: 'dry-run', plan: outcome.plan }
              : outcome.kind === 'nothing-to-do'
                ? { result: 'nothing-to-do', message: outcome.message }
                : {
                    result: 'preflight-failed',
                    failure: {
                      code: outcome.preflight.failure?.code,
                      message: outcome.preflight.failure?.message,
                      remediation: outcome.preflight.failure?.remediation ?? [],
                    },
                    warnings: outcome.preflight.warnings,
                  };
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.spec-run/1', `${CLI_BIN} ${VERSION}`, {
              specName: name,
              ...(data as Record<string, unknown>),
            }),
          ),
        );
        return;
      }

      switch (outcome.kind) {
        case 'nothing-to-do':
          runtime.out(okLine(outcome.message));
          runtime.exitCode = EXIT_CODES.ok;
          return;
        case 'preflight-failed':
          renderPreflightFailure(runtime, outcome.preflight);
          return;
        case 'dry-run':
          renderDryRunPlan(runtime, context.workspace, outcome.plan);
          return;
        case 'executed':
          renderTaskRunReport(runtime, context.workspace, outcome.report);
          return;
      }
    });
}
