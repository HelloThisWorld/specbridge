import path from 'node:path';
import type { Command } from 'commander';
import type { FailOnThreshold, VerificationReport } from '@specbridge/core';
import { CLI_BIN, SpecBridgeError, writeFileAtomic } from '@specbridge/core';
import type { VerifySelection } from '@specbridge/drift';
import { verifySpecs } from '@specbridge/drift';
import {
  dim,
  renderVerificationHtml,
  renderVerificationMarkdown,
  renderVerificationTerminal,
  serializeJsonReport,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import type { ComparisonCliOptions } from '../verify-options.js';
import { resolveComparisonRequest } from '../verify-options.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec verify` — deterministic spec-to-code drift verification.
 *
 * Read-only by default: no spec content, approval state, task state, or
 * evidence is ever modified. The only writes are report artifacts (command
 * logs and report.json when trusted commands execute, plus the --output
 * file when requested). No model is involved anywhere.
 */

interface SpecVerifyOptions extends ComparisonCliOptions {
  changed?: boolean;
  all?: boolean;
  runVerification?: boolean;
  policy?: string;
  failOn?: string;
  strict?: boolean;
  json?: boolean;
  format?: string;
  output?: string;
  verbose?: boolean;
}

const FORMATS = ['terminal', 'json', 'markdown', 'html'] as const;
type OutputFormat = (typeof FORMATS)[number];

function resolveSelection(name: string | undefined, options: SpecVerifyOptions): VerifySelection {
  const modes: string[] = [];
  if (name !== undefined) modes.push(`spec "${name}"`);
  if (options.changed === true) modes.push('--changed');
  if (options.all === true) modes.push('--all');
  if (modes.length > 1) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Choose one selection mode — ${modes.join(', ')} are mutually exclusive.`,
    );
  }
  if (name !== undefined) return { mode: 'single', spec: name };
  if (options.changed === true) return { mode: 'changed' };
  if (options.all === true) return { mode: 'all' };
  throw new SpecBridgeError(
    'INVALID_ARGUMENT',
    `Select what to verify: a spec name, --changed (specs affected by the comparison), or --all.`,
  );
}

function resolveFormat(options: SpecVerifyOptions): OutputFormat {
  if (options.json === true && options.format !== undefined && options.format !== 'json') {
    throw new SpecBridgeError('INVALID_ARGUMENT', '--json conflicts with --format; use one.');
  }
  if (options.json === true) return 'json';
  const format = options.format ?? 'terminal';
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `--format must be one of ${FORMATS.join(', ')}, got "${format}".`,
    );
  }
  return format as OutputFormat;
}

function resolveFailOn(options: SpecVerifyOptions): FailOnThreshold {
  const failOn = options.failOn ?? 'error';
  if (failOn !== 'error' && failOn !== 'warning' && failOn !== 'never') {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `--fail-on must be error, warning, or never, got "${failOn}".`,
    );
  }
  return failOn;
}

function renderReport(
  report: VerificationReport,
  format: OutputFormat,
  verbose: boolean,
): string {
  switch (format) {
    case 'json':
      return serializeJsonReport(report);
    case 'markdown':
      return renderVerificationMarkdown(report);
    case 'html':
      return renderVerificationHtml(report);
    case 'terminal':
      return `${renderVerificationTerminal(report, { verbose }).join('\n')}\n`;
  }
}

export function registerSpecVerifyCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('verify [name]')
    .description('Deterministically verify spec-to-code alignment against a git comparison')
    .option('--changed', 'verify every spec affected by the comparison')
    .option('--all', 'verify every spec in the workspace')
    .option('--diff <range>', 'compare a git revision range, e.g. origin/main...HEAD')
    .option('--base <ref>', 'explicit base ref (with optional --head)')
    .option('--head <ref>', 'explicit head ref (defaults to HEAD)')
    .option('--working-tree', 'compare working tree (staged + unstaged + untracked) vs HEAD (default)')
    .option('--staged', 'compare staged changes vs HEAD')
    .option('--run-verification', 'run every trusted command from .specbridge/config.json')
    .option('--no-run-verification', 'never run commands; reuse valid evidence where possible')
    .option('--policy <path>', 'explicit verification policy file (single-spec mode)')
    .option('--fail-on <threshold>', 'failure threshold: error, warning, or never', 'error')
    .option('--strict', 'strict verification behavior (tightens, never loosens, the policy)')
    .option('--json', 'print the JSON report to stdout (same as --format json)')
    .option('--format <format>', 'terminal (default), json, markdown, or html')
    .option('--output <path>', 'write the report to a file instead of stdout')
    .option('--verbose', 'include info diagnostics and full file lists')
    .addHelpText(
      'after',
      `
Verification is read-only: it never edits .kiro files, never marks task
checkboxes, and never changes approval state or evidence. Commands run only
from trusted .specbridge/config.json configuration — never from spec text.

By default only commands required by a spec policy run; --run-verification
runs everything configured, --no-run-verification runs nothing and reuses
valid evidence recorded at the current HEAD where possible.

Exit codes:
  0 passed per --fail-on · 1 threshold reached · 2 invalid input/policy/state
  3 git comparison unavailable · 4 command failed to start · 5 command timeout

Examples:
  ${CLI_BIN} spec verify notification-preferences --working-tree
  ${CLI_BIN} spec verify notification-preferences --diff origin/main...HEAD --run-verification
  ${CLI_BIN} spec verify --changed --diff origin/main...HEAD
  ${CLI_BIN} spec verify --all --working-tree --fail-on warning`,
    )
    .action(async (name: string | undefined, options: SpecVerifyOptions) => {
      const workspace = runtime.workspace();
      const selection = resolveSelection(name, options);
      const comparison = resolveComparisonRequest(options);
      const format = resolveFormat(options);
      const failOn = resolveFailOn(options);
      if (options.output !== undefined && format === 'terminal') {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          '--output needs a file format: pass --format json, markdown, or html.',
        );
      }

      // Progress only in interactive terminal mode; machine formats stay clean.
      const interactive =
        format === 'terminal' && options.output === undefined && process.stderr.isTTY === true;

      const result = await verifySpecs({
        workspace,
        selection,
        comparison,
        ...(options.runVerification !== undefined
          ? { runVerification: options.runVerification }
          : {}),
        ...(options.strict !== undefined ? { strict: options.strict } : {}),
        failOn,
        ...(options.policy !== undefined ? { explicitPolicyPath: options.policy } : {}),
        toolVersion: VERSION,
        reportsDir: path.join(workspace.sidecarDir, 'reports'),
        clock: () => runtime.now(),
        ...(interactive ? { onProgress: (message: string) => runtime.err(dim(message)) } : {}),
      });

      if (options.strict === true && format === 'terminal') {
        const raised = result.report.specResults
          .filter((specResult) => specResult.policyMode === 'strict')
          .map((specResult) => specResult.specName);
        if (raised.length > 0) {
          runtime.err(
            dim(
              `--strict: strict-mode severities apply to ${raised.join(', ')} (the policy files themselves are unchanged).`,
            ),
          );
        }
      }

      const rendered = renderReport(result.report, format, options.verbose === true);
      if (options.output !== undefined) {
        const outputPath = path.resolve(runtime.cwd, options.output);
        writeFileAtomic(outputPath, rendered);
        runtime.out(`Report written: ${relPath(workspace, outputPath)}`);
      } else {
        runtime.outRaw(rendered);
      }
      if (result.artifactsDir !== undefined && format === 'terminal') {
        runtime.out(dim(`Artifacts: ${relPath(workspace, result.artifactsDir)}`));
      }
      runtime.exitCode = result.exitCode;
    });
}
