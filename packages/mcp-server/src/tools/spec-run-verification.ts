import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { verifySpecs } from '@specbridge/drift';
import type { ServerContext } from '../context.js';
import { comparisonArgs, toComparisonRequest } from '../schemas/comparison.js';
import { specNameArg } from '../schemas/common.js';
import {
  toVerificationView,
  verificationSummaryShape,
  verificationText,
} from '../schemas/verification-views.js';
import { registerDefinedTool } from './helpers.js';
import { toSelection } from './spec-check-drift.js';
import { MCP_SERVER_VERSION } from '../version.js';

/**
 * spec_run_verification — deterministic drift rules PLUS trusted configured
 * verification commands.
 *
 * Commands come exclusively from `.specbridge/config.json` — never from MCP
 * arguments and never from spec content — and run as argv arrays with the
 * configured timeouts and output limits. Reports persist under
 * `.specbridge/reports` only when persistReport is true. Spec content,
 * approvals, tasks, and evidence are never modified.
 */

const inputSchema = {
  scope: z
    .enum(['spec', 'changed', 'all'])
    .optional()
    .describe('Verify one spec, specs affected by the comparison, or all specs (default changed)'),
  specName: specNameArg.optional().describe('Required when scope is "spec"'),
  ...comparisonArgs,
  strict: z.boolean().optional(),
  failOn: z.enum(['error', 'warning', 'never']).optional().describe('Failure threshold (default error)'),
  persistReport: z
    .boolean()
    .optional()
    .describe('Persist command logs and report.json under .specbridge/reports (default false)'),
};

const outputSchema = {
  ...verificationSummaryShape,
  commands: z.array(
    z.object({
      name: z.string(),
      required: z.boolean(),
      disposition: z.enum(['executed', 'reused-evidence', 'not-run']),
      passed: z.boolean(),
      exitCode: z.number().nullable(),
      durationMs: z.number().nullable(),
      timedOut: z.boolean(),
    }),
  ),
  reportPersisted: z.boolean(),
  reportPath: z.string().optional().describe('Repository-relative report directory when persisted'),
};

export function registerSpecRunVerificationTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_run_verification',
    title: 'Run trusted verification',
    description:
      'Run the deterministic drift rules plus the trusted verification commands configured in ' +
      '.specbridge/config.json (argv arrays; never from tool arguments or spec content). Executes ' +
      'local commands — not read-only — but never changes spec content, approvals, or evidence. ' +
      'Report persistence is an explicit opt-in.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args, extras) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const selection = toSelection(args.scope, args.specName);
        const comparison = toComparisonRequest(args);
        const persistReport = args.persistReport === true;

        const result = await verifySpecs({
          workspace,
          selection,
          comparison,
          runVerification: true,
          ...(args.strict !== undefined ? { strict: args.strict } : {}),
          failOn: args.failOn ?? 'error',
          toolVersion: MCP_SERVER_VERSION,
          persistArtifacts: persistReport,
          clock: context.clock,
          idFactory: context.idFactory,
          signal: extras.signal,
          onProgress: (message) => context.logger.debug('verification_progress', { message }),
        });

        const view = toVerificationView(result.report);
        const commands = result.report.verificationCommands.map((command) => ({
          name: command.name,
          required: command.required,
          disposition: command.disposition,
          passed: command.passed,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
          timedOut: command.timedOut,
        }));
        const reportPath =
          result.artifactsDir !== undefined
            ? path.relative(workspace.rootDir, result.artifactsDir).split(path.sep).join('/')
            : undefined;

        const commandLines = commands.map(
          (command) =>
            `- ${command.name}: ${command.disposition}${command.disposition === 'executed' ? (command.passed ? ' (passed)' : ` (FAILED, exit ${command.exitCode ?? 'none'})`) : ''}`,
        );
        const text = [
          verificationText(view, 'Verification (rules + trusted commands)'),
          commands.length > 0 ? `Commands:\n${commandLines.join('\n')}` : 'No verification commands are configured.',
          persistReport && reportPath !== undefined ? `Report persisted: ${reportPath}` : 'Report not persisted (persistReport was false).',
        ].join('\n');

        return {
          text,
          structured: {
            ...view,
            commands,
            reportPersisted: persistReport && reportPath !== undefined,
            ...(persistReport && reportPath !== undefined ? { reportPath } : {}),
          },
        };
      }),
  });
}
