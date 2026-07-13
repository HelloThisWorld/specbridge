import { existsSync, readdirSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readRunRecord, runDir } from '@specbridge/execution';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { buildRunDetail, runDetailShape } from '../schemas/run-views.js';
import { registerDefinedTool } from './helpers.js';

/**
 * run_read — safe summary of one run.
 *
 * Prompts, raw runner stdout/stderr, and full command logs stay on disk for
 * local auditing; this tool returns lifecycle facts, Git summaries,
 * verification outcomes, violations, and artifact NAMES only.
 */

const inputSchema = {
  runId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'run ids contain only letters, digits, dot, underscore, and dash')
    .describe('Full run id (see run_list)'),
};

const outputSchema = { run: runDetailShape };

/** Artifact names that must never cross the MCP boundary raw. */
const REDACTED_ARTIFACTS = new Set([
  'prompt.md',
  'raw-stdout.log',
  'raw-stderr.log',
]);

export function registerRunReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'run_read',
    title: 'Read a run',
    description:
      'Safe summary of one recorded run: lifecycle, Git before/after summary, changed files, ' +
      'verification outcomes, evidence status, warnings, and artifact names. Raw prompts and raw ' +
      'runner output are never returned. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const record = readRunRecord(workspace, args.runId);
      if (record === undefined) {
        throw new McpToolError('SBMCP011', `Run "${args.runId}" was not found under .specbridge/runs/.`, {
          remediation: ['List runs with the run_list tool.'],
        });
      }
      const directory = runDir(workspace, record.runId);
      const artifactNames = existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => !REDACTED_ARTIFACTS.has(name))
            .sort((a, b) => a.localeCompare(b, 'en'))
        : [];
      const detail = buildRunDetail(workspace, record, artifactNames);

      const lines = [
        `Run ${detail.summary.runId} — ${detail.summary.runType} for spec "${detail.summary.specName}"` +
          `${detail.summary.taskId !== undefined ? `, task ${detail.summary.taskId}` : ''}.`,
        `Status: ${detail.summary.evidenceStatus ?? detail.summary.lifecycleStatus ?? detail.summary.outcome ?? '(in progress)'}.`,
      ];
      if (detail.changedFiles !== undefined) {
        const during = detail.changedFiles.filter((file) => file.modifiedDuringRun);
        lines.push(`Changed during the run: ${during.length} file(s).`);
      }
      if (detail.verification !== undefined && detail.verification.ran) {
        lines.push(`Verification: ${detail.verification.passed ? 'passed' : 'failed'}.`);
      }
      if (detail.violations !== undefined && detail.violations.length > 0) {
        lines.push(`Violations: ${detail.violations.join('; ')}`);
      }

      return { text: lines.join('\n'), structured: { run: detail } };
    },
  });
}
