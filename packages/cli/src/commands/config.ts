import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import {
  RUNNER_CONFIG_SCHEMA_VERSION,
  applyConfigMigration,
  planConfigMigration,
  readAgentConfig,
  resolvedConfigDiagnostics,
} from '@specbridge/core';
import { profileModel, profileTransport } from '@specbridge/runners';
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
import { VERSION } from '../version.js';

/**
 * `specbridge config doctor|migrate` — versioned configuration diagnostics
 * and the EXPLICIT v1 → v2 migration. Reading never mutates the file;
 * `migrate --apply` is the only writer (atomic, with a recoverable backup).
 */

interface ConfigOptions {
  json?: boolean;
  dryRun?: boolean;
  apply?: boolean;
}

export function registerConfigCommands(program: Command, runtime: CliRuntime): void {
  const config = program
    .command('config')
    .description('Validate and migrate .specbridge/config.json');

  config
    .command('doctor')
    .description('Validate the configuration (read-only; never modifies the file)')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Reports: schema version, whether an explicit migration is available, runner
profile validity, and policy defaults. Values are shown redacted; SpecBridge
never stores credentials in this file (the schema rejects them).

Exit codes: 0 valid · 1 invalid configuration.

Examples:
  ${CLI_BIN} config doctor
  ${CLI_BIN} config doctor --json`,
    )
    .action((options: ConfigOptions) => {
      const workspace = runtime.workspace();
      const read = readAgentConfig(workspace);
      const referenceDiagnostics =
        read.config !== undefined ? resolvedConfigDiagnostics(read.config) : [];
      const valid = read.config !== undefined && referenceDiagnostics.length === 0;
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.config-doctor/1', `${CLI_BIN} ${VERSION}`, {
              path: read.path,
              exists: read.exists,
              valid,
              sourceSchemaVersion: read.sourceSchemaVersion ?? null,
              currentSchemaVersion: RUNNER_CONFIG_SCHEMA_VERSION,
              needsMigration: read.needsMigration,
              diagnostics: [...read.diagnostics, ...referenceDiagnostics],
              ...(read.config !== undefined
                ? {
                    defaultRunner: read.config.defaultRunner,
                    operationDefaults: read.config.operationDefaults,
                    runnerPolicy: read.config.runnerPolicy,
                    fallbacks: read.config.fallbacks,
                    profiles: Object.entries(read.config.runnerProfiles).map(([name, profile]) => ({
                      name,
                      runner: profile.runner,
                      enabled: profile.enabled !== false,
                      model: profileModel(profile),
                      networkBacked: profileTransport(profile).networkBacked,
                    })),
                    verificationCommands: read.config.verification.commands.map((command) => command.name),
                  }
                : {}),
            }),
          ),
        );
        runtime.exitCode = valid ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
        return;
      }

      runtime.out(reportTitle('Configuration doctor'));
      runtime.out();
      runtime.out(`  File: ${read.path}${read.exists ? '' : ' (not present; safe defaults apply)'}`);
      if (read.config === undefined) {
        for (const diagnostic of read.diagnostics) runtime.out(failLine(diagnostic.message));
        runtime.out();
        runtime.out(failLine('The configuration is invalid; runner commands will refuse to execute.'));
        runtime.exitCode = EXIT_CODES.gateFailure;
        return;
      }
      runtime.out(
        okLine(
          `Schema: ${read.sourceSchemaVersion ?? '(defaults)'}`,
          read.needsMigration
            ? `a v${RUNNER_CONFIG_SCHEMA_VERSION} migration is available (${CLI_BIN} config migrate --dry-run)`
            : 'current',
        ),
      );
      if (read.needsMigration) {
        runtime.out(
          warnLine(
            'The v1 schema remains fully supported; migration is explicit and never automatic.',
          ),
        );
      }
      runtime.out();
      runtime.out(sectionTitle('Runner profiles'));
      for (const [name, profile] of Object.entries(read.config.runnerProfiles)) {
        const line = profile.enabled !== false ? okLine : infoLine;
        runtime.out(
          line(name, `${profile.runner} · ${profile.enabled !== false ? 'enabled' : 'disabled'}${profileModel(profile) !== null ? ` · model: ${profileModel(profile)}` : ''}`),
        );
      }
      for (const diagnostic of referenceDiagnostics) runtime.out(failLine(diagnostic.message));
      runtime.out();
      runtime.out(sectionTitle('Policy'));
      runtime.out(
        okLine(
          `automatic fallback: ${read.config.runnerPolicy.allowAutomaticFallback ? 'ALLOWED' : 'disabled (default)'}`,
        ),
      );
      runtime.out(
        okLine(`network runners need explicit selection: ${read.config.runnerPolicy.requireExplicitRunnerForNetworkAccess ? 'yes (default)' : 'NO'}`),
      );
      runtime.out(okLine(`trusted verification commands: ${read.config.verification.commands.length} configured`));
      runtime.out(okLine('no credential values stored (rejected by the schema)'));
      runtime.out();
      runtime.out(valid ? okLine('Configuration is valid.') : failLine('Configuration has errors.'));
      runtime.exitCode = valid ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
    });

  config
    .command('migrate')
    .description(
      'Deprecated alias of "migrate plan"/"migrate apply": migrate a v1 configuration to v2',
    )
    .option('--dry-run', 'show the migration plan; write nothing (default)')
    .option('--apply', 'write the migrated file atomically with a recoverable backup')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Deprecated: use "${CLI_BIN} migrate plan" / "${CLI_BIN} migrate apply"
instead. This alias keeps its exact behavior and will be removed no earlier
than v2.0.0.

The migration preserves the effective Claude Code behavior, preserves the
trusted verification commands and execution policy, adds the new Codex and
Ollama profiles DISABLED, never creates credentials, and never enables
fallback. The original file is copied to config.v1.backup*.json before the
new file is written; a failed apply restores the original.

Exit codes: 0 migrated or already current · 1 invalid configuration ·
2 usage error.

Examples:
  ${CLI_BIN} config migrate --dry-run
  ${CLI_BIN} config migrate --apply`,
    )
    .action((options: ConfigOptions) => {
      runtime.err(
        `Deprecated: "${CLI_BIN} config migrate" will be removed no earlier than v2.0.0; ` +
          `use "${CLI_BIN} migrate plan" / "${CLI_BIN} migrate apply" instead.`,
      );
      if (options.dryRun === true && options.apply === true) {
        throw new SpecBridgeError('INVALID_ARGUMENT', 'Use either --dry-run or --apply, not both.');
      }
      const apply = options.apply === true;
      const workspace = runtime.workspace();
      const configPath = path.join(workspace.sidecarDir, 'config.json');
      if (!existsSync(configPath)) {
        const message = `No configuration file exists at ${configPath}; nothing to migrate (safe v2 defaults already apply).`;
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.config-migrate/1', `${CLI_BIN} ${VERSION}`, {
                result: 'nothing-to-migrate',
                message,
              }),
            ),
          );
        } else {
          runtime.out(infoLine(message));
        }
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(configPath, 'utf8'));
      } catch (cause) {
        runtime.err(
          failLine(`The configuration file could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`),
        );
        runtime.exitCode = EXIT_CODES.gateFailure;
        return;
      }

      const planned = planConfigMigration(raw);
      if (planned.kind === 'invalid') {
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.config-migrate/1', `${CLI_BIN} ${VERSION}`, {
                result: 'invalid',
                problems: planned.problems,
              }),
            ),
          );
        } else {
          runtime.err(failLine('The configuration cannot be migrated:'));
          for (const problem of planned.problems) runtime.err(`  ${problem}`);
        }
        runtime.exitCode = EXIT_CODES.gateFailure;
        return;
      }
      if (planned.kind === 'already-current') {
        const message = `The configuration is already schema ${planned.version}; nothing to migrate.`;
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.config-migrate/1', `${CLI_BIN} ${VERSION}`, {
                result: 'already-current',
                version: planned.version,
              }),
            ),
          );
        } else {
          runtime.out(okLine(message));
        }
        return;
      }

      const plan = planned.plan;
      if (options.json === true && !apply) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.config-migrate/1', `${CLI_BIN} ${VERSION}`, {
              result: 'dry-run',
              fromVersion: plan.fromVersion,
              toVersion: plan.toVersion,
              changes: plan.changes,
              warnings: plan.warnings,
              migrated: plan.migrated,
            }),
          ),
        );
        return;
      }

      if (!options.json) {
        runtime.out(reportTitle(apply ? 'Configuration migration' : 'Configuration migration (dry run)'));
        runtime.out();
        runtime.out(`  Schema: ${plan.fromVersion} → ${plan.toVersion}`);
        runtime.out();
        runtime.out(sectionTitle('Field mappings and defaults'));
        for (const change of plan.changes) runtime.out(okLine(change));
        for (const warning of plan.warnings) runtime.out(warnLine(warning));
        runtime.out();
        runtime.out(okLine('Existing Claude Code behavior is preserved (same defaults, same profile).'));
        runtime.out(okLine('Codex and Ollama profiles are added DISABLED; nothing is silently enabled.'));
        runtime.out(okLine('Trusted verification commands and execution policy are preserved unchanged.'));
        runtime.out(okLine('No credential values are created.'));
        runtime.out();
      }

      if (!apply) {
        runtime.out(dim(`Dry run: nothing was written. Apply with: ${CLI_BIN} config migrate --apply`));
        return;
      }

      const applied = applyConfigMigration(workspace, plan);
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.config-migrate/1', `${CLI_BIN} ${VERSION}`, {
              result: 'applied',
              fromVersion: plan.fromVersion,
              toVersion: plan.toVersion,
              configPath: applied.configPath,
              backupPath: applied.backupPath,
              changes: plan.changes,
              warnings: plan.warnings,
            }),
          ),
        );
        return;
      }
      runtime.out(okLine('Migration applied atomically.'));
      runtime.out(`  New file: ${applied.configPath}`);
      runtime.out(`  Backup:   ${applied.backupPath} (restore it to roll back)`);
      runtime.out();
      runtime.out(dim(`Validate the result: ${CLI_BIN} config doctor`));
    });
}
