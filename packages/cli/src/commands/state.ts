import path from 'node:path';
import type { Command } from 'commander';
import type { RecoveryApplyResult, WorkspaceInfo } from '@specbridge/core';
import {
  CLI_BIN,
  EXIT_CODES,
  SpecBridgeError,
  applyRecoveryPlan,
  buildRecoveryPlan,
  readRecoveryPlan,
  recoveryAcknowledgementToken,
  recoveryLogPath,
  writeRecoveryPlan,
} from '@specbridge/core';
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
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { VERSION } from '../version.js';
import type { StateFinding, StateFindingStatus } from '../state/state-families.js';
import {
  MIGRATIONS_FAMILY,
  STATE_FAMILY_IDS,
  buildRecoveryActions,
  collectStateFindings,
} from '../state/state-families.js';

/**
 * `specbridge state validate|recover` — read-only validation across every
 * persisted state family, and the explicit two-step recovery flow.
 *
 * `state validate` never writes. `state recover --plan` writes ONLY the plan
 * file; `state recover --apply <planId> --ack <token>` is the single command
 * that executes recovery, and every action it can perform moves bytes into
 * `.specbridge/quarantine/` — nothing is destroyed, approvals and evidence
 * are never invented, and there is deliberately no force flag.
 */

const STATUS_ORDER: readonly StateFindingStatus[] = [
  'valid',
  'stale',
  'migration-required',
  'legacy',
  'incompatible',
  'orphaned',
  'recoverable',
  'invalid',
  'unrecoverable',
];

interface ValidateOptions {
  json?: boolean;
  all?: boolean;
  config?: boolean;
  spec?: string;
  runs?: boolean;
  evidence?: boolean;
  templates?: boolean;
  extensions?: boolean;
  registries?: boolean;
}

interface RecoverOptions {
  json?: boolean;
  plan?: boolean;
  apply?: string;
  ack?: string;
}

function selectedFamilies(options: ValidateOptions): { families?: string[]; specName?: string } {
  const families: string[] = [];
  if (options.config === true) families.push('config');
  if (options.spec !== undefined) families.push('spec-state');
  if (options.runs === true) families.push('runs');
  if (options.evidence === true) families.push('evidence');
  if (options.templates === true) families.push('templates');
  if (options.extensions === true) families.push('extensions');
  if (options.registries === true) families.push('registries');
  if (options.all === true || families.length === 0) {
    // Full scan (default): every family plus interrupted-migration reports.
    return { ...(options.spec !== undefined ? { specName: options.spec } : {}) };
  }
  if (options.spec !== undefined) {
    // A spec filter also scopes the other spec-scoped families.
    if (!families.includes('policies')) families.push('policies');
    return { families, specName: options.spec };
  }
  return { families };
}

function countsByStatus(findings: readonly StateFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of STATUS_ORDER) {
    const count = findings.filter((candidate) => candidate.status === status).length;
    if (count > 0) counts[status] = count;
  }
  return counts;
}

function statusLine(status: StateFindingStatus): (message: string, detail?: string) => string {
  if (status === 'valid') return okLine;
  if (status === 'stale' || status === 'migration-required' || status === 'legacy') return warnLine;
  return failLine;
}

function printFindings(runtime: CliRuntime, findings: readonly StateFinding[]): void {
  const families = [...new Set(findings.map((candidate) => candidate.family))];
  for (const family of families) {
    runtime.out(sectionTitle(family));
    for (const found of findings.filter((candidate) => candidate.family === family)) {
      runtime.out(statusLine(found.status)(`${found.path}`, found.status));
      for (const problem of found.problems) runtime.out(`      ${problem}`);
    }
    runtime.out();
  }
}

function planTouchedPaths(actions: readonly { file?: string }[]): Set<string> {
  return new Set(
    actions
      .map((action) => action.file)
      .filter((file): file is string => file !== undefined),
  );
}

function printApplyOutcome(
  runtime: CliRuntime,
  workspace: WorkspaceInfo,
  result: RecoveryApplyResult,
): void {
  runtime.out(sectionTitle('Actions'));
  for (const action of result.actions) {
    const line = action.status === 'applied' ? okLine : failLine;
    runtime.out(line(`${action.actionId} (${action.kind}) — ${action.status}`));
    if (action.quarantinePath !== undefined) {
      runtime.out(`      quarantined to: ${relPath(workspace, action.quarantinePath)}`);
    }
    for (const problem of action.problems) runtime.out(failLine(problem));
  }
  for (const problem of result.problems) runtime.out(failLine(problem));
  runtime.out();
  runtime.out(`  Log: ${relPath(workspace, recoveryLogPath(workspace))} (append-only)`);
}

export function registerStateCommands(program: Command, runtime: CliRuntime): void {
  const state = program
    .command('state')
    .description('Validate and recover persisted SpecBridge state (.specbridge)');

  state
    .command('validate')
    .description('Validate every persisted state family (strictly read-only)')
    .option('--all', 'scan every family (default when no family flag is given)')
    .option('--config', 'scan the configuration family')
    .option('--spec <name>', 'scan spec-scoped state for one spec')
    .option('--runs', 'scan run records and the interactive lock')
    .option('--evidence', 'scan task evidence records')
    .option('--templates', 'scan template records and installed packs')
    .option('--extensions', 'scan extension state, grants, and installed packages')
    .option('--registries', 'scan registry configuration and caches')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Never writes, repairs, or deletes anything; bad state degrades to findings.
Migrations never run automatically — this command only detects and reports.

Exit codes: 0 every finding is valid · 1 any other finding exists (including
informational "stale" approvals, which only an explicit human re-approval
resolves) · 2 usage error.

Examples:
  ${CLI_BIN} state validate
  ${CLI_BIN} state validate --spec checkout-flow
  ${CLI_BIN} state validate --registries --json`,
    )
    .action((options: ValidateOptions) => {
      const workspace = runtime.workspace();
      const selection = selectedFamilies(options);
      const findings = collectStateFindings(workspace, selection.families, selection.specName);
      const healthy = findings.every((candidate) => candidate.status === 'valid');
      const counts = countsByStatus(findings);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.state-validate/1', `${CLI_BIN} ${VERSION}`, {
              families: selection.families ?? [...STATE_FAMILY_IDS, MIGRATIONS_FAMILY],
              ...(selection.specName !== undefined ? { spec: selection.specName } : {}),
              findings,
              counts,
              healthy,
            }),
          ),
        );
        runtime.exitCode = healthy ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
        return;
      }

      runtime.out(reportTitle('State validation'));
      runtime.out();
      if (findings.length === 0) {
        runtime.out(infoLine('No persisted SpecBridge state exists yet; nothing to validate.'));
        runtime.exitCode = EXIT_CODES.ok;
        return;
      }
      printFindings(runtime, findings);
      runtime.out(sectionTitle('Summary'));
      for (const [status, count] of Object.entries(counts)) {
        runtime.out(statusLine(status as StateFindingStatus)(`${status}: ${count}`));
      }
      runtime.out();
      if (healthy) {
        runtime.out(okLine('Every finding is valid.'));
      } else {
        runtime.out(failLine('Findings need attention.'));
        runtime.out(dim(`Preview safe recovery actions with: ${CLI_BIN} state recover --plan`));
      }
      runtime.exitCode = healthy ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
    });

  state
    .command('recover')
    .description('Plan (default) and explicitly apply safe state recovery')
    .option('--plan', 'build and persist a recovery plan (the default behavior)')
    .option('--apply <planId>', 'apply a previously persisted plan (requires --ack)')
    .option('--ack <token>', 'acknowledgement token printed by --plan')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Two explicit steps, no shortcuts and no force flag:
  1. "${CLI_BIN} state recover --plan" persists a hash-bound plan and prints
     its acknowledgement token. Nothing else is written.
  2. "${CLI_BIN} state recover --apply <planId> --ack <token>" executes it.
     Every file hash is revalidated first (stale plans are refused), every
     action moves bytes into .specbridge/quarantine/<planId>/ (nothing is
     destroyed), failures roll every move back, and the outcome is appended
     to ${path.posix.join('.specbridge', 'recovery', 'log.jsonl')}.

Recovery can only touch files inside .specbridge/. It never writes to .kiro,
and it never creates approvals, evidence, or completed tasks.

Exit codes: 0 planned or applied (or nothing to recover) · 1 refused
(bad acknowledgement, stale plan, unknown plan) or failed · 2 usage error.

Examples:
  ${CLI_BIN} state recover --plan
  ${CLI_BIN} state recover --apply r-20260718-093000-1a2b3c4d --ack 1a2b3c4d5e6f`,
    )
    .action((options: RecoverOptions) => {
      const workspace = runtime.workspace();

      if (options.apply !== undefined) {
        if (options.plan === true) {
          throw new SpecBridgeError('INVALID_ARGUMENT', 'Use either --plan or --apply, not both.');
        }
        if (options.ack === undefined) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `--apply requires --ack <token>. Run "${CLI_BIN} state recover --plan" to get the token.`,
          );
        }
        const plan = readRecoveryPlan(workspace, options.apply);
        if (plan === undefined) {
          const message =
            `No readable recovery plan "${options.apply}" exists under .specbridge/recovery/plans/. ` +
            `Create one with "${CLI_BIN} state recover --plan".`;
          if (options.json === true) {
            runtime.outRaw(
              serializeJsonReport(
                createJsonReport('specbridge.state-recover/1', `${CLI_BIN} ${VERSION}`, {
                  result: 'unknown-plan',
                  planId: options.apply,
                  message,
                }),
              ),
            );
          } else {
            runtime.err(failLine(message));
          }
          runtime.exitCode = EXIT_CODES.gateFailure;
          return;
        }

        const touched = planTouchedPaths(plan.actions);
        const result = applyRecoveryPlan(workspace, plan, {
          acknowledgementToken: options.ack ?? '',
          now: () => runtime.now(),
          validateFinalState: () => {
            // Re-scan and report only paths this plan touched that STILL fail.
            // "stale" (informational) and "migration-required" (a restored v1
            // file is fully supported state) are acceptable outcomes.
            const after = collectStateFindings(workspace);
            return after
              .filter(
                (candidate) =>
                  touched.has(candidate.path) &&
                  candidate.status !== 'valid' &&
                  candidate.status !== 'stale' &&
                  candidate.status !== 'migration-required',
              )
              .map((candidate) => `${candidate.path} still reports ${candidate.status} after recovery.`);
          },
        });
        const applied = result.status === 'applied';

        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.state-recover/1', `${CLI_BIN} ${VERSION}`, {
                result: result.status,
                planId: result.planId,
                planHash: result.planHash,
                actions: result.actions,
                problems: result.problems,
                logPath: relPath(workspace, recoveryLogPath(workspace)),
              }),
            ),
          );
          runtime.exitCode = applied ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
          return;
        }

        runtime.out(reportTitle(`State recovery — apply ${plan.planId}`));
        runtime.out();
        printApplyOutcome(runtime, workspace, result);
        runtime.out();
        runtime.out(
          applied
            ? okLine('Recovery applied; originals are preserved in quarantine.')
            : failLine(`Recovery was not applied (${result.status}); nothing was lost.`),
        );
        runtime.exitCode = applied ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
        return;
      }

      if (options.ack !== undefined) {
        throw new SpecBridgeError('INVALID_ARGUMENT', '--ack is only meaningful together with --apply <planId>.');
      }

      const findings = collectStateFindings(workspace);
      const actions = buildRecoveryActions(workspace, findings);
      if (actions.length === 0) {
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.state-recover/1', `${CLI_BIN} ${VERSION}`, {
                result: 'nothing-to-recover',
                actions: [],
              }),
            ),
          );
        } else {
          runtime.out(okLine('State needs no recovery; nothing was written.'));
        }
        return;
      }

      const plan = buildRecoveryPlan({
        tool: `${CLI_BIN} ${VERSION}`,
        actions,
        now: () => runtime.now(),
      });
      const planPath = writeRecoveryPlan(workspace, plan);
      const token = recoveryAcknowledgementToken(plan);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.state-recover/1', `${CLI_BIN} ${VERSION}`, {
              result: 'planned',
              planId: plan.planId,
              planHash: plan.planHash,
              planPath: relPath(workspace, planPath),
              acknowledgementToken: token,
              applyCommand: `${CLI_BIN} state recover --apply ${plan.planId} --ack ${token}`,
              actions: plan.actions,
            }),
          ),
        );
        return;
      }

      runtime.out(reportTitle('State recovery plan'));
      runtime.out();
      runtime.out(`  Plan: ${relPath(workspace, planPath)}`);
      runtime.out();
      runtime.out(sectionTitle('Proposed actions'));
      for (const action of plan.actions) {
        runtime.out(
          warnLine(
            `${action.actionId} ${action.kind}`,
            `risk ${action.risk} · ${action.confidence} · ${action.reversible ? 'reversible' : 'not reversible'}`,
          ),
        );
        if (action.file !== undefined) runtime.out(`      file: ${action.file}`);
        if (action.backupPath !== undefined) runtime.out(`      backup: ${action.backupPath}`);
        runtime.out(`      ${action.reason}`);
      }
      runtime.out();
      runtime.out(`  Plan id: ${plan.planId}`);
      runtime.out(`  Acknowledgement token: ${token}`);
      runtime.out();
      runtime.out(okLine('Only the plan file was written; no state was touched.'));
      runtime.out(dim(`Apply with: ${CLI_BIN} state recover --apply ${plan.planId} --ack ${token}`));
    });
}
