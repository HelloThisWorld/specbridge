import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, readAgentConfig, resolveWorkspace } from '@specbridge/core';
import { discoverSpecs } from '@specbridge/compat-kiro';
import {
  createJsonReport,
  dim,
  failLine,
  infoLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge setup` — safe, preview-first workspace initialization.
 *
 * Guarantees (tested):
 *   - the default run is a dry run: it writes NOTHING
 *   - `--apply` creates only missing sidecar directories; it never touches
 *     `.kiro`, never overwrites an existing configuration, never modifies
 *     `.claude`, never installs or authenticates a provider, never enables
 *     an extension, and performs no network access
 *   - a `.specbridge/config.json` is never created: safe defaults apply
 *     without one, so there is nothing to overwrite later
 */

interface SetupOptions {
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
}

/** Directories `--apply` may create when missing. Nothing else is written. */
const SAFE_DIRECTORIES = ['.specbridge', '.specbridge/state/specs'];

export function registerSetupCommand(program: Command, runtime: CliRuntime): void {
  program
    .command('setup')
    .description('Preview (default) or apply safe SpecBridge initialization for this workspace')
    .option('--dry-run', 'report what setup would do; write nothing (default)')
    .option('--apply', 'create only the missing sidecar directories, atomically')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Setup is deliberately minimal and safe:
  - it never touches ${'.kiro'} (your specs stay the source of truth)
  - it never overwrites an existing configuration
  - it never creates ${'.specbridge'}/config.json — safe defaults apply
    without one (create it later only if you need non-default runners)
  - it never modifies .claude, installs providers, or performs network access

Exit codes: 0 success · 2 no workspace or usage error.

Examples:
  ${CLI_BIN} setup                 preview only (writes nothing)
  ${CLI_BIN} setup --apply         create missing sidecar directories`,
    )
    .action((options: SetupOptions) => {
      const apply = options.apply === true;
      if (options.dryRun === true && apply) {
        runtime.err(failLine('Use either --dry-run or --apply, not both.'));
        runtime.exitCode = EXIT_CODES.usageError;
        return;
      }

      const workspace = resolveWorkspace(runtime.cwd);
      if (workspace === undefined) {
        runtime.err(
          failLine(
            `No .kiro directory found from ${runtime.cwd}. Setup never creates .kiro — ` +
              'start from an existing Kiro project (or create .kiro/specs yourself).',
          ),
        );
        runtime.exitCode = EXIT_CODES.usageError;
        return;
      }

      const specs = workspace.specsDir !== undefined ? discoverSpecs(workspace) : [];
      const config = readAgentConfig(workspace);
      const missingDirectories = SAFE_DIRECTORIES.filter(
        (dir) => !existsSync(path.join(workspace.rootDir, dir)),
      );

      const report = {
        workspaceRoot: workspace.rootDir,
        kiro: {
          present: true,
          steering: workspace.steeringDir !== undefined,
          specsDir: workspace.specsDir !== undefined,
          specCount: specs.length,
        },
        sidecar: {
          present: workspace.sidecarExists,
          configPresent: config.exists,
          configNeedsMigration: config.needsMigration,
        },
        directoriesToCreate: missingDirectories,
        filesNeverTouched: ['.kiro/**', '.specbridge/config.json (never created or overwritten)', '.claude/**'],
        configGuidance:
          'No config.json is required — safe defaults apply. Create one only for non-default runners.',
        pluginGuidance:
          'Claude Code plugin: see docs/plugin-installation.md (marketplace "specbridge-plugins").',
        migrationRequired: config.needsMigration,
        mode: apply ? 'apply' : 'dry-run',
        created: [] as string[],
      };

      if (apply) {
        for (const dir of missingDirectories) {
          // mkdir is atomic per directory; parents first via the fixed order.
          mkdirSync(path.join(workspace.rootDir, dir), { recursive: true });
          report.created.push(dir);
        }
      }

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(createJsonReport('specbridge.setup/1', `${CLI_BIN} ${VERSION}`, report)),
        );
        return;
      }

      runtime.out(reportTitle(apply ? 'Setup' : 'Setup (dry run)'));
      runtime.out();
      runtime.out(`  Workspace: ${workspace.rootDir}`);
      runtime.out(okLine(`.kiro present (${specs.length} spec${specs.length === 1 ? '' : 's'} detected)`));
      runtime.out(
        workspace.sidecarExists
          ? okLine('.specbridge sidecar present')
          : infoLine('.specbridge sidecar not present yet'),
      );
      runtime.out();
      runtime.out(sectionTitle('Planned changes'));
      if (missingDirectories.length === 0) {
        runtime.out(okLine('Nothing to create; the workspace is already initialized.'));
      } else {
        for (const dir of missingDirectories) {
          runtime.out(
            apply && report.created.includes(dir)
              ? okLine(`created ${relPath(workspace, path.join(workspace.rootDir, dir))}/`)
              : infoLine(`would create ${relPath(workspace, path.join(workspace.rootDir, dir))}/`),
          );
        }
      }
      runtime.out();
      runtime.out(sectionTitle('Never touched'));
      runtime.out(okLine('.kiro/** stays exactly as it is (zero-migration promise)'));
      runtime.out(okLine('config.json is never created or overwritten (safe defaults apply)'));
      runtime.out(okLine('.claude/** is never modified; no provider is installed or authenticated'));
      runtime.out(okLine('no network access'));
      if (config.needsMigration) {
        runtime.out();
        runtime.out(
          infoLine(
            `The existing config.json uses the v1 schema — an explicit migration is available: ${CLI_BIN} migrate plan`,
          ),
        );
      }
      runtime.out();
      if (!apply) {
        runtime.out(dim(`Dry run: nothing was written. Apply with: ${CLI_BIN} setup --apply`));
      } else {
        runtime.out(okLine('Setup complete.'));
        runtime.out(dim(`Next: ${CLI_BIN} doctor · ${CLI_BIN} spec list · docs/plugin-installation.md`));
      }
    });
}
