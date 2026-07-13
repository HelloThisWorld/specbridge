import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { verifySpecs } from '@specbridge/drift';
import type { VerifySelection } from '@specbridge/drift';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { comparisonArgs, toComparisonRequest } from '../schemas/comparison.js';
import { specNameArg } from '../schemas/common.js';
import {
  toVerificationView,
  verificationSummaryShape,
  verificationText,
} from '../schemas/verification-views.js';
import { registerDefinedTool } from './helpers.js';
import { MCP_SERVER_VERSION } from '../version.js';

/**
 * spec_check_drift — deterministic drift rules only. Never executes
 * configured verification commands and never persists reports: the entire
 * evaluation happens in memory (passing prior evidence may be *reused*, but
 * nothing runs and nothing is written).
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
};

const outputSchema = verificationSummaryShape;

export function toSelection(
  scope: 'spec' | 'changed' | 'all' | undefined,
  specName: string | undefined,
): VerifySelection {
  if (scope === 'spec' || (scope === undefined && specName !== undefined)) {
    if (specName === undefined) {
      throw new McpToolError('SBMCP002', 'scope "spec" requires specName.');
    }
    return { mode: 'single', spec: specName };
  }
  if (scope === 'all') return { mode: 'all' };
  return { mode: 'changed' };
}

export function registerSpecCheckDriftTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_check_drift',
    title: 'Check spec drift',
    description:
      'Run the deterministic drift rule engine (stable SBV rule IDs) against a git comparison — one ' +
      'spec, changed specs, or all specs. Read-only: never executes configured commands and never ' +
      'persists reports.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args, extras) => {
      const workspace = context.requireWorkspace();
      const selection = toSelection(args.scope, args.specName);
      const comparison = toComparisonRequest(args);

      const result = await verifySpecs({
        workspace,
        selection,
        comparison,
        runVerification: false,
        ...(args.strict !== undefined ? { strict: args.strict } : {}),
        failOn: args.failOn ?? 'error',
        toolVersion: MCP_SERVER_VERSION,
        persistArtifacts: false,
        clock: context.clock,
        idFactory: context.idFactory,
        signal: extras.signal,
      });

      const view = toVerificationView(result.report);
      return {
        text: verificationText(view, 'Drift check (deterministic rules only; no commands executed)'),
        structured: view,
      };
    },
  });
}
