import type { Command } from 'commander';
import { CLI_BIN } from '@specbridge/core';
import type { RoundTripCheck } from '@specbridge/compat-kiro';
import {
  checkNoopRoundTrip,
  discoverSpecs,
  listSteeringFiles,
  requireSpec,
} from '@specbridge/compat-kiro';
import {
  createJsonReport,
  dim,
  failLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge compat check [name]` — prove the no-op round-trip guarantee
 * against real files: load every Markdown file, reserialize it in memory,
 * and compare bytes. Read-only; nothing is written anywhere.
 */

interface GroupResult {
  group: string;
  checks: RoundTripCheck[];
}

function eolLabel(check: RoundTripCheck): string {
  const bom = check.hasBom ? ', BOM' : '';
  return `${check.eol.toUpperCase()}${bom}, ${check.lineCount} lines, ${check.byteLength} bytes`;
}

export function registerCompatCheckCommand(program: Command, runtime: CliRuntime): void {
  const compat = program.command('compat').description('Kiro compatibility verification');

  compat
    .command('check [name]')
    .description('Verify the byte-identical no-op round trip for a spec (or everything)')
    .option('--json', 'output JSON')
    .addHelpText(
      'after',
      `
Without a name, every spec and every steering file is checked.

Examples:
  ${CLI_BIN} compat check
  ${CLI_BIN} compat check user-authentication
  ${CLI_BIN} compat check --json`,
    )
    .action((name: string | undefined, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const groups: GroupResult[] = [];

      if (name !== undefined) {
        const folder = requireSpec(workspace, name);
        groups.push({
          group: `spec:${folder.name}`,
          checks: folder.files
            .filter((file) => file.fileName.toLowerCase().endsWith('.md'))
            .map((file) => checkNoopRoundTrip(file.path)),
        });
      } else {
        for (const folder of discoverSpecs(workspace)) {
          groups.push({
            group: `spec:${folder.name}`,
            checks: folder.files
              .filter((file) => file.fileName.toLowerCase().endsWith('.md'))
              .map((file) => checkNoopRoundTrip(file.path)),
          });
        }
        const steering = listSteeringFiles(workspace);
        if (steering.length > 0) {
          groups.push({
            group: 'steering',
            checks: steering.map((info) => checkNoopRoundTrip(info.path)),
          });
        }
      }

      const allChecks = groups.flatMap((g) => g.checks);
      const failed = allChecks.filter((check) => !check.identical);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.compat-check/1', `${CLI_BIN} ${VERSION}`, {
              groups: groups.map((group) => ({
                group: group.group,
                checks: group.checks,
              })),
              totalFiles: allChecks.length,
              identicalFiles: allChecks.length - failed.length,
              passed: failed.length === 0,
            }),
          ),
        );
        runtime.exitCode = failed.length === 0 ? 0 : 1;
        return;
      }

      runtime.out(reportTitle('Compat check (no-op round trip)'));
      runtime.out();
      for (const group of groups) {
        runtime.out(sectionTitle(group.group));
        if (group.checks.length === 0) {
          runtime.out(dim('  (no Markdown files)'));
        }
        for (const check of group.checks) {
          const label = relPath(workspace, check.file);
          if (check.identical) {
            runtime.out(okLine(`${label}`, `byte-identical (${eolLabel(check)})`));
          } else {
            runtime.out(failLine(`${label}`, check.reason ?? 'differs'));
          }
        }
        runtime.out();
      }

      if (failed.length === 0) {
        runtime.out(
          `Result: ${reportTitle('PASS')} — ${allChecks.length} file${allChecks.length === 1 ? '' : 's'} verified byte-identical`,
        );
        runtime.exitCode = 0;
      } else {
        runtime.out(`Result: ${reportTitle('FAIL')} — ${failed.length} of ${allChecks.length} files did not round-trip`);
        runtime.exitCode = 1;
      }
    });
}
