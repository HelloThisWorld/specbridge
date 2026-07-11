import type { Command } from 'commander';
import type { StageName } from '@specbridge/core';
import { CLI_BIN, STAGE_NAMES, SpecBridgeError } from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { ApprovalResult } from '@specbridge/workflow';
import { approveStage } from '@specbridge/workflow';
import {
  createJsonReport,
  dim,
  okLine,
  reportTitle,
  serializeJsonReport,
  severityLine,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec approve <name> --stage <stage>` — record (or revoke) a
 * stage approval in sidecar state. The approved Markdown file is hashed
 * byte-exactly and never modified. Deterministic analysis gates approval:
 * errors block, warnings do not.
 */

interface SpecApproveOptions {
  stage?: string;
  revoke?: boolean;
  json?: boolean;
}

function resultToJson(specName: string, result: ApprovalResult): unknown {
  const base = { specName };
  if (result.ok && result.action === 'approved') {
    return createJsonReport('specbridge.spec-approve/1', `${CLI_BIN} ${VERSION}`, {
      ...base,
      action: 'approved',
      stage: result.stage,
      hash: result.hash,
      reapproved: result.reapproved,
      invalidated: result.invalidated,
      initialized: result.initialized,
      status: result.state.status,
      statePath: result.statePath,
      warnings: result.analysis.diagnostics.filter((d) => d.severity === 'warning'),
      diagnostics: result.diagnostics,
    });
  }
  if (result.ok) {
    return createJsonReport('specbridge.spec-approve/1', `${CLI_BIN} ${VERSION}`, {
      ...base,
      action: 'revoked',
      stage: result.stage,
      invalidated: result.invalidated,
      status: result.state.status,
      statePath: result.statePath,
      diagnostics: result.diagnostics,
    });
  }
  return createJsonReport('specbridge.spec-approve/1', `${CLI_BIN} ${VERSION}`, {
    ...base,
    action: 'blocked',
    reason: result.reason,
    message: result.message,
    missingPrerequisites: result.missingPrerequisites ?? [],
    stalePrerequisites: result.stalePrerequisites ?? [],
    analysis:
      result.analysis !== undefined
        ? {
            errorCount: result.analysis.errorCount,
            warningCount: result.analysis.warningCount,
            diagnostics: result.analysis.diagnostics,
          }
        : null,
    diagnostics: result.diagnostics,
  });
}

export function registerSpecApproveCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('approve <name>')
    .description('Approve (or revoke) a workflow stage; approvals live in .specbridge, never in .kiro')
    .requiredOption('--stage <stage>', `stage to approve: ${STAGE_NAMES.join(' | ')}`)
    .option('--revoke', 'revoke the stage approval (dependent approvals are invalidated too)')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Approval records the SHA-256 of the exact file bytes plus a timestamp in
.specbridge/state/specs/<name>.json. The Markdown file itself is never
rewritten. If an approved file changes later, the approval is reported as
stale; re-approving updates the hash (and invalidates dependent approvals,
because they were made against different content).

Prerequisites by workflow:
  requirements-first  requirements -> design -> tasks
  design-first        design -> requirements -> tasks
  quick               requirements + design in any order, then tasks
  bugfix              bugfix -> design -> tasks

For an existing Kiro spec without SpecBridge state, the first successful
approval initializes the sidecar state (origin: existing-kiro-workspace).

Exit codes: 0 approved/revoked · 1 blocked (prerequisites or analysis errors) · 2 usage error.

Examples:
  ${CLI_BIN} spec approve notification-preferences --stage requirements
  ${CLI_BIN} spec approve notification-preferences --stage design
  ${CLI_BIN} spec approve login-timeout-fix --stage bugfix
  ${CLI_BIN} spec approve notification-preferences --stage requirements --revoke`,
    )
    .action((name: string, options: SpecApproveOptions) => {
      const stage = options.stage as StageName | undefined;
      if (stage === undefined || !STAGE_NAMES.includes(stage)) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `Unknown --stage "${options.stage ?? ''}". Valid stages: ${STAGE_NAMES.join(', ')}.`,
        );
      }

      const workspace = runtime.workspace();
      const folder = requireSpec(workspace, name);
      const spec = analyzeSpec(workspace, folder);

      const result = approveStage(
        workspace,
        spec,
        { stage, ...(options.revoke === true ? { revoke: true } : {}) },
        { clock: () => runtime.now() },
      );

      if (options.json === true) {
        runtime.outRaw(serializeJsonReport(resultToJson(folder.name, result)));
        runtime.exitCode = result.ok ? 0 : result.failure === 'usage' ? 2 : 1;
        return;
      }

      if (!result.ok) {
        runtime.err(result.message);
        if (result.reason === 'prerequisites-unmet') {
          const nextStage = result.missingPrerequisites?.[0] ?? result.stalePrerequisites?.[0];
          if (nextStage !== undefined) {
            runtime.err('');
            runtime.err('Run:');
            runtime.err(`  ${CLI_BIN} spec analyze ${folder.name} --stage ${nextStage}`);
            runtime.err(`  ${CLI_BIN} spec approve ${folder.name} --stage ${nextStage}`);
          }
        }
        if (result.reason === 'analysis-errors' && result.analysis !== undefined) {
          runtime.err('');
          for (const diagnostic of result.analysis.diagnostics.filter((d) => d.severity === 'error')) {
            const location =
              diagnostic.file !== undefined
                ? ` [${relPath(workspace, diagnostic.file)}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}]`
                : '';
            runtime.err(`  ${diagnostic.severity === 'error' ? '✗' : '!'} ${diagnostic.message}${location}`);
          }
          runtime.err('');
          runtime.err(dim(`Full report: ${CLI_BIN} spec analyze ${folder.name} --stage ${stage}`));
        }
        runtime.exitCode = result.failure === 'usage' ? 2 : 1;
        return;
      }

      if (result.action === 'revoked') {
        runtime.out(reportTitle(`Revoked: ${folder.name} — ${result.stage}`));
        runtime.out();
        runtime.out(okLine(`${result.stage} approval revoked (files were not touched)`));
        for (const invalidated of result.invalidated) {
          runtime.out(warnLine(`${invalidated} approval invalidated (it depended on ${result.stage})`));
        }
        runtime.out();
        runtime.out(`  Status: ${result.state.status}`);
        runtime.out(dim(`  State: ${relPath(workspace, result.statePath)}`));
        return;
      }

      runtime.out(reportTitle(`Approved: ${folder.name} — ${result.stage}`));
      runtime.out();
      if (result.initialized) {
        runtime.out(okLine('Sidecar state initialized for this existing Kiro spec', '(origin: existing-kiro-workspace)'));
      }
      runtime.out(
        okLine(
          `${result.stage} ${result.reapproved ? 're-approved' : 'approved'}`,
          `(sha256 ${result.hash.slice(0, 12)}…)`,
        ),
      );
      for (const invalidated of result.invalidated) {
        runtime.out(
          warnLine(
            `${invalidated} approval invalidated — ${result.stage} changed since it was approved; re-approve it`,
          ),
        );
      }
      const warnings = result.analysis.diagnostics.filter((d) => d.severity === 'warning');
      for (const warning of warnings) {
        runtime.out(severityLine('warning', warning.message));
      }
      if (warnings.length > 0) {
        runtime.out(dim('  (warnings never block approval; fix them when convenient)'));
      }
      runtime.out();
      runtime.out(`  Status: ${result.state.status}`);
      runtime.out(dim(`  State: ${relPath(workspace, result.statePath)}`));
      if (result.state.status !== 'READY_FOR_IMPLEMENTATION') {
        runtime.out();
        runtime.out(dim(`  Next: ${CLI_BIN} spec status ${folder.name}`));
      }
    });
}
