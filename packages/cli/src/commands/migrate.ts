import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { MigrationPlan, MigrationResult, WorkspaceInfo } from '@specbridge/core';
import {
  CLI_BIN,
  EXIT_CODES,
  RUNNER_CONFIG_SCHEMA_VERSION,
  SPEC_STATE_SCHEMA_VERSION,
  SpecBridgeError,
  agentConfigV2Schema,
  applyMigrationPlan,
  buildMigrationPlan,
  listMigrationIds,
  verifyMigration,
  writeMigrationReport,
} from '@specbridge/core';
import { RUN_RECORD_SCHEMA_VERSION } from '@specbridge/execution';
import { EVIDENCE_SCHEMA_VERSION } from '@specbridge/evidence';
import { VERIFICATION_POLICY_SCHEMA_VERSION } from '@specbridge/drift';
import { TEMPLATE_RECORD_SCHEMA_VERSION } from '@specbridge/templates';
import { EXTENSION_STATE_SCHEMA_VERSION } from '@specbridge/extensions';
import { REGISTRIES_SCHEMA_VERSION } from '@specbridge/registry';
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
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';
import type { StateFinding } from '../state/state-families.js';
import {
  STATE_FAMILY_IDS,
  collectMigrationSteps,
  collectStateFindings,
  inspectConfigMigration,
} from '../state/state-families.js';

/**
 * `specbridge migrate status|plan|apply|verify` — the explicit v1.0.0 state
 * migration surface.
 *
 * Migrations NEVER run automatically: every other command only detects and
 * reports. `migrate status` and `migrate plan` are pure reads, `migrate
 * apply` is the single writer (hash-bound plan, atomic writes, backups,
 * rollback on failure, full report), and `migrate verify` re-checks a
 * persisted report against the workspace.
 *
 * Honesty note: the only migration that has ever existed is the
 * configuration v1 (agent-config 1.0.0) → v2 (runner-config 2.0.0) rewrite.
 * Every other persisted schema has been 1.0.0 since its introduction.
 */

const CURRENT_FAMILY_VERSIONS: Record<string, string> = {
  config: RUNNER_CONFIG_SCHEMA_VERSION,
  'spec-state': SPEC_STATE_SCHEMA_VERSION,
  runs: RUN_RECORD_SCHEMA_VERSION,
  evidence: EVIDENCE_SCHEMA_VERSION,
  policies: VERIFICATION_POLICY_SCHEMA_VERSION,
  templates: TEMPLATE_RECORD_SCHEMA_VERSION,
  extensions: EXTENSION_STATE_SCHEMA_VERSION,
  registries: REGISTRIES_SCHEMA_VERSION,
};

const NO_MIGRATION_NOTE =
  'all versions current; no migration has ever been required for this family';

interface MigrateStatusOptions {
  json?: boolean;
}

interface MigratePlanOptions {
  json?: boolean;
  target?: string;
}

interface MigrateApplyOptions extends MigratePlanOptions {
  dryRun?: boolean;
  backupDirectory?: string;
}

interface MigrateVerifyOptions {
  json?: boolean;
  id?: string;
}

function requireSupportedTarget(target: string | undefined): string {
  const resolved = target ?? VERSION;
  if (resolved !== VERSION) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `--target ${resolved} is not supported; the only supported migration target is ${VERSION}.`,
    );
  }
  return resolved;
}

function familySummaries(
  workspace: WorkspaceInfo,
  findings: readonly StateFinding[],
): Array<{
  family: string;
  filesScanned: number;
  schemaVersionsFound: string[];
  currentVersion: string;
  pendingMigrations: number;
  invalidFindings: number;
  note: string;
}> {
  return STATE_FAMILY_IDS.map((family) => {
    const familyFindings = findings.filter((candidate) => candidate.family === family);
    const versions = [
      ...new Set(
        familyFindings
          .map((candidate) => candidate.schemaVersion)
          .filter((version): version is string => version !== null),
      ),
    ].sort((a, b) => a.localeCompare(b, 'en'));
    const pending = familyFindings.filter((candidate) => candidate.status === 'migration-required').length;
    const invalid = familyFindings.filter((candidate) => candidate.status === 'invalid').length;
    return {
      family,
      filesScanned: familyFindings.filter((candidate) =>
        existsSync(path.join(workspace.rootDir, ...candidate.path.split('/'))),
      ).length,
      schemaVersionsFound: versions,
      currentVersion: CURRENT_FAMILY_VERSIONS[family] ?? '1.0.0',
      pendingMigrations: pending,
      invalidFindings: invalid,
      note:
        family === 'config'
          ? pending > 0
            ? `a v1 → v2 migration is pending (${CLI_BIN} migrate plan)`
            : 'v1 → v2 is the only migration that has ever existed for this family'
          : NO_MIGRATION_NOTE,
    };
  });
}

function printPlan(runtime: CliRuntime, plan: MigrationPlan): void {
  runtime.out(`  Target:    ${plan.target}`);
  runtime.out(`  Plan id:   ${plan.planId}`);
  runtime.out(`  Plan hash: ${plan.planHash}`);
  runtime.out();
  runtime.out(sectionTitle('Steps'));
  for (const step of plan.steps) {
    runtime.out(okLine(`${step.stepId}: ${step.file} (${step.family}) ${step.fromVersion} → ${step.toVersion}`));
    for (const change of step.changes) runtime.out(`      - ${change}`);
    for (const warning of step.warnings) runtime.out(warnLine(warning));
  }
}

function printApplyResult(runtime: CliRuntime, result: MigrationResult, reportDir?: string): void {
  runtime.out(sectionTitle('Result'));
  for (const step of result.steps) {
    const line = step.status === 'applied' || step.status === 'already-current' ? okLine : failLine;
    runtime.out(line(`${step.stepId}: ${step.file} — ${step.status}`));
    if (step.backupPath !== undefined) runtime.out(`      backup: ${step.backupPath}`);
    for (const problem of step.problems) runtime.out(failLine(problem));
  }
  for (const problem of result.problems) runtime.out(failLine(problem));
  if (reportDir !== undefined) {
    runtime.out();
    runtime.out(`  Report: ${reportDir}`);
  }
}

/** Steps or an honest refusal; `undefined` means the command already finished. */
function stepsOrFinish(
  runtime: CliRuntime,
  workspace: WorkspaceInfo,
  options: { json?: boolean },
  reportId: string,
): ReturnType<typeof collectMigrationSteps> | undefined {
  const inspection = inspectConfigMigration(workspace);
  if (inspection.status === 'invalid') {
    if (options.json === true) {
      runtime.outRaw(
        serializeJsonReport(
          createJsonReport(reportId, `${CLI_BIN} ${VERSION}`, {
            result: 'invalid-state',
            problems: inspection.problems,
          }),
        ),
      );
    } else {
      runtime.err(failLine('The configuration cannot be migrated until it is fixed:'));
      for (const problem of inspection.problems) runtime.err(`  ${problem}`);
    }
    runtime.exitCode = EXIT_CODES.gateFailure;
    return undefined;
  }
  return collectMigrationSteps(workspace);
}

export function registerMigrateCommands(program: Command, runtime: CliRuntime): void {
  const migrate = program
    .command('migrate')
    .description('Plan, apply, and verify explicit state migrations (never automatic)');

  migrate
    .command('status')
    .description('Report every state family\'s schema versions and pending migrations (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Scans every persisted state family (config, spec-state, runs, evidence,
policies, templates, extensions, registries) without writing anything.
Migrations never run automatically; this command only detects and reports.

The only migration that has ever existed is configuration v1 → v2; every
other schema has been 1.0.0 since its introduction.

Exit codes: 0 nothing pending and nothing invalid · 1 a migration is pending
or state is invalid · 2 usage error.

Examples:
  ${CLI_BIN} migrate status
  ${CLI_BIN} migrate status --json`,
    )
    .action((options: MigrateStatusOptions) => {
      const workspace = runtime.workspace();
      const findings = collectStateFindings(workspace, [...STATE_FAMILY_IDS]);
      const steps = collectMigrationSteps(workspace);
      const inspection = inspectConfigMigration(workspace);
      const summaries = familySummaries(workspace, findings).map((summary) =>
        summary.family === 'config' && inspection.status === 'invalid'
          ? { ...summary, invalidFindings: Math.max(summary.invalidFindings, 1) }
          : summary,
      );
      const pending = steps.length + summaries.reduce((sum, summary) => sum + summary.pendingMigrations, 0);
      const invalid = summaries.reduce((sum, summary) => sum + summary.invalidFindings, 0);
      const healthy = pending === 0 && invalid === 0;

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.migrate-status/1', `${CLI_BIN} ${VERSION}`, {
              families: summaries,
              pendingSteps: steps.map((step) => ({
                stepId: step.stepId,
                family: step.family,
                file: step.file,
                fromVersion: step.fromVersion,
                toVersion: step.toVersion,
              })),
              healthy,
            }),
          ),
        );
        runtime.exitCode = healthy ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
        return;
      }

      runtime.out(reportTitle('Migration status'));
      runtime.out();
      const rows = [
        ['family', 'files', 'found', 'current', 'pending'],
        ...summaries.map((summary) => [
          summary.family,
          String(summary.filesScanned),
          summary.schemaVersionsFound.join(', ') || '—',
          summary.currentVersion,
          String(summary.pendingMigrations),
        ]),
      ];
      for (const line of renderColumns(rows)) runtime.out(line);
      runtime.out();
      for (const summary of summaries) {
        if (summary.pendingMigrations > 0) {
          runtime.out(warnLine(`${summary.family}: ${summary.note}`));
        } else if (summary.invalidFindings > 0) {
          runtime.out(
            failLine(
              `${summary.family}: ${summary.invalidFindings} invalid file${summary.invalidFindings === 1 ? '' : 's'} (${CLI_BIN} state validate)`,
            ),
          );
        } else {
          runtime.out(infoLine(`${summary.family}: ${summary.note}`));
        }
      }
      runtime.out();
      runtime.out(
        healthy
          ? okLine('Nothing to migrate and nothing invalid.')
          : failLine(
              pending > 0
                ? `A migration is pending; review it with "${CLI_BIN} migrate plan".`
                : `Invalid state was found; inspect it with "${CLI_BIN} state validate".`,
            ),
      );
      runtime.exitCode = healthy ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
    });

  migrate
    .command('plan')
    .description('Compute the hash-bound migration plan (read-only; writes nothing)')
    .option('--target <version>', `product version to migrate towards (only ${VERSION} is accepted)`)
    .option('--json', 'output the full plan as a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Planning is pure: nothing is written, no network, no model. The plan is
hash-bound to the exact bytes it was computed from, so "migrate apply"
refuses to run against files that changed afterwards.

Exit codes: 0 plan computed (with or without steps) · 1 invalid state ·
2 usage error (including an unsupported --target).

Examples:
  ${CLI_BIN} migrate plan
  ${CLI_BIN} migrate plan --json`,
    )
    .action((options: MigratePlanOptions) => {
      const target = requireSupportedTarget(options.target);
      const workspace = runtime.workspace();
      const steps = stepsOrFinish(runtime, workspace, options, 'specbridge.migrate-plan/1');
      if (steps === undefined) return;
      const plan = buildMigrationPlan({
        tool: `${CLI_BIN} ${VERSION}`,
        target,
        steps,
        now: () => runtime.now(),
      });

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.migrate-plan/1', `${CLI_BIN} ${VERSION}`, {
              result: steps.length === 0 ? 'nothing-to-migrate' : 'planned',
              plan,
            }),
          ),
        );
        return;
      }

      runtime.out(reportTitle('Migration plan'));
      runtime.out();
      if (steps.length === 0) {
        runtime.out(okLine('Nothing to migrate — every state family is already current.'));
        runtime.out(infoLine(NO_MIGRATION_NOTE.replace('this family', 'any family except config (v1 → v2)')));
        return;
      }
      printPlan(runtime, plan);
      runtime.out();
      runtime.out(dim(`Planning wrote nothing. Apply with: ${CLI_BIN} migrate apply`));
    });

  migrate
    .command('apply')
    .description('Apply the migration plan atomically with backups and a full report')
    .option('--target <version>', `product version to migrate towards (only ${VERSION} is accepted)`)
    .option('--dry-run', 'print the plan and write nothing')
    .option('--backup-directory <path>', 'workspace-relative directory for original-file backups')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
The ONLY command that rewrites state files, and only after recomputing the
plan against the current bytes. Every original is backed up first, writes
are atomic and validated, any failure restores every original, and the full
report lands in .specbridge/migrations/<planId>/. Applying twice is a no-op.

Exit codes: 0 applied or nothing to do · 1 refused (stale plan) or failed
(originals restored) · 2 usage error.

Examples:
  ${CLI_BIN} migrate apply --dry-run
  ${CLI_BIN} migrate apply
  ${CLI_BIN} migrate apply --backup-directory .specbridge/backups/pre-1.0.0`,
    )
    .action((options: MigrateApplyOptions) => {
      const target = requireSupportedTarget(options.target);
      const workspace = runtime.workspace();
      const steps = stepsOrFinish(runtime, workspace, options, 'specbridge.migrate-apply/1');
      if (steps === undefined) return;
      const plan = buildMigrationPlan({
        tool: `${CLI_BIN} ${VERSION}`,
        target,
        steps,
        now: () => runtime.now(),
      });

      if (steps.length === 0) {
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.migrate-apply/1', `${CLI_BIN} ${VERSION}`, {
                result: 'nothing-to-do',
                dryRun: options.dryRun === true,
              }),
            ),
          );
        } else {
          runtime.out(okLine('Nothing to migrate — every state family is already current.'));
        }
        return;
      }

      if (options.dryRun === true) {
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.migrate-apply/1', `${CLI_BIN} ${VERSION}`, {
                result: 'dry-run',
                plan,
              }),
            ),
          );
          return;
        }
        runtime.out(reportTitle('Migration apply (dry run)'));
        runtime.out();
        printPlan(runtime, plan);
        runtime.out();
        runtime.out(dim(`Dry run: nothing was written. Apply with: ${CLI_BIN} migrate apply`));
        return;
      }

      const result = applyMigrationPlan(workspace, plan, {
        now: () => runtime.now(),
        ...(options.backupDirectory !== undefined ? { backupDirectory: options.backupDirectory } : {}),
        validateStep: (step, written) => {
          if (step.stepId !== 'config-v1-to-v2') return [];
          const check = agentConfigV2Schema.safeParse(written);
          return check.success
            ? []
            : check.error.issues.map(
                (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
              );
        },
      });
      const reportDir = writeMigrationReport(workspace, plan, result);
      const succeeded = result.status === 'applied' || result.status === 'nothing-to-do';

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.migrate-apply/1', `${CLI_BIN} ${VERSION}`, {
              result: result.status,
              planId: plan.planId,
              planHash: plan.planHash,
              steps: result.steps,
              problems: result.problems,
              reportDir,
            }),
          ),
        );
        runtime.exitCode = succeeded ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
        return;
      }

      runtime.out(reportTitle('Migration apply'));
      runtime.out();
      printApplyResult(runtime, result, reportDir);
      runtime.out();
      runtime.out(
        succeeded
          ? okLine(`Migration ${result.status === 'applied' ? 'applied atomically' : 'needed nothing'}.`)
          : failLine('The migration did not apply; every original file is unchanged.'),
      );
      if (succeeded) runtime.out(dim(`Verify any time with: ${CLI_BIN} migrate verify`));
      runtime.exitCode = succeeded ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
    });

  migrate
    .command('verify')
    .description('Verify a previously applied migration from its persisted report (read-only)')
    .option('--id <planId>', 'migration to verify (default: the newest report)')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Checks that the report parses, the plan hash still matches, every migrated
file's current bytes match the recorded after-hash, and every backup still
holds the original bytes.

Exit codes: 0 verified · 1 modified since migration, invalid report, or no
migration exists · 2 usage error.

Examples:
  ${CLI_BIN} migrate verify
  ${CLI_BIN} migrate verify --id m-20260718-093000-1a2b3c4d --json`,
    )
    .action((options: MigrateVerifyOptions) => {
      const workspace = runtime.workspace();
      const planId = options.id ?? listMigrationIds(workspace)[0];
      if (planId === undefined) {
        const message = `No migration reports exist under .specbridge/migrations/; nothing to verify. Apply one first with "${CLI_BIN} migrate apply".`;
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.migrate-verify/1', `${CLI_BIN} ${VERSION}`, {
                result: 'no-migrations',
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

      const verification = verifyMigration(workspace, planId);
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.migrate-verify/1', `${CLI_BIN} ${VERSION}`, {
              result: verification.status,
              planId,
              checks: 'checks' in verification ? verification.checks : [],
              problems: 'problems' in verification ? verification.problems : [],
            }),
          ),
        );
        runtime.exitCode = verification.status === 'verified' ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
        return;
      }

      runtime.out(reportTitle(`Migration verify — ${planId}`));
      runtime.out();
      if ('checks' in verification) {
        for (const check of verification.checks) runtime.out(okLine(check));
      }
      if ('problems' in verification) {
        for (const problem of verification.problems) runtime.out(failLine(problem));
      }
      runtime.out();
      runtime.out(
        verification.status === 'verified'
          ? okLine('Migration verified: files and backups match the report.')
          : failLine(`Verification result: ${verification.status}.`),
      );
      runtime.exitCode = verification.status === 'verified' ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
    });
}
