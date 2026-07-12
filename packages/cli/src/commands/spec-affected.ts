import type { Command } from 'commander';
import { CLI_BIN } from '@specbridge/core';
import { resolveAffectedSpecs, resolveComparison } from '@specbridge/drift';
import {
  createJsonReport,
  dim,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import type { ComparisonCliOptions } from '../verify-options.js';
import { resolveComparisonRequest } from '../verify-options.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec affected` — which specs does a change set touch?
 * Read-only: resolves the comparison and the deterministic spec mapping;
 * runs no verification commands and writes nothing.
 */

interface SpecAffectedOptions extends ComparisonCliOptions {
  json?: boolean;
}

export function registerSpecAffectedCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('affected')
    .description('Resolve which specs are affected by a git comparison (read-only)')
    .option('--diff <range>', 'compare a git revision range, e.g. origin/main...HEAD')
    .option('--base <ref>', 'explicit base ref (with optional --head)')
    .option('--head <ref>', 'explicit head ref (defaults to HEAD)')
    .option('--working-tree', 'compare working tree vs HEAD (default)')
    .option('--staged', 'compare staged changes vs HEAD')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
A spec is affected when a changed file lives under .kiro/specs/<name>/, is
the spec's sidecar state or policy file, matches a declared impact area,
appears in accepted task evidence, or is explicitly referenced by design.md.

Exit codes: 0 resolved · 2 invalid input · 3 git comparison unavailable.

Examples:
  ${CLI_BIN} spec affected --diff origin/main...HEAD
  ${CLI_BIN} spec affected --working-tree --json`,
    )
    .action(async (options: SpecAffectedOptions) => {
      const workspace = runtime.workspace();
      const request = resolveComparisonRequest(options);
      const comparison = await resolveComparison(workspace.rootDir, request);

      if (!comparison.ok) {
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.spec-affected/1', `${CLI_BIN} ${VERSION}`, {
                comparison: comparison.descriptor,
                ok: false,
                failure: comparison.failure ?? null,
                affected: [],
                unmapped: [],
                ambiguous: [],
              }),
            ),
          );
        } else {
          runtime.err(`Cannot resolve the comparison: ${comparison.failure?.message ?? 'unknown git failure'}`);
        }
        runtime.exitCode = 3;
        return;
      }

      const result = resolveAffectedSpecs(workspace, comparison.changedFiles);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.spec-affected/1', `${CLI_BIN} ${VERSION}`, {
              comparison: comparison.descriptor,
              ok: true,
              changedFiles: comparison.changedFiles.map((file) => ({
                path: file.path,
                changeType: file.changeType,
              })),
              affected: result.affected,
              unmapped: result.unmapped.map((file) => file.path),
              ambiguous: result.ambiguous,
            }),
          ),
        );
        return;
      }

      runtime.out(reportTitle('Affected specs'));
      runtime.out(dim(`Comparison: ${comparison.descriptor.label}`));
      runtime.out();
      if (result.affected.length === 0) {
        runtime.out(okLine('No spec is affected by this change set.'));
      }
      for (const affected of result.affected) {
        runtime.out(`${affected.specName}`);
        runtime.out(dim('  matched:'));
        for (const match of affected.matches) {
          runtime.out(`    ${match.file}`);
          runtime.out(dim(`      via ${match.via.join(', ')}`));
        }
        runtime.out();
      }

      if (result.ambiguous.length > 0) {
        runtime.out(sectionTitle('Ambiguous mappings'));
        for (const entry of result.ambiguous) {
          runtime.out(
            warnLine(
              `${entry.path} maps to ${entry.specs.map((specMatch) => specMatch.name).join(' and ')}`,
            ),
          );
        }
        runtime.out();
      }

      if (result.unmapped.length > 0) {
        runtime.out(sectionTitle('Warnings'));
        for (const file of result.unmapped) {
          runtime.out(warnLine(`${file.path} does not map to any spec`));
        }
      }
    });
}
