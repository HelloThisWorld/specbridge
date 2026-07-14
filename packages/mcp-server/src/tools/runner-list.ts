import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runnerProfileSummary } from '@specbridge/runners';
import type { ServerContext } from '../context.js';
import { paginate } from '../limits.js';
import { cursorArg, limitArg, paginationShape } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';
import {
  RUNNER_PROBE_TIMEOUT_MS,
  loadRunnerToolContext,
  profileSummaryShape,
} from './runner-shared.js';

/**
 * runner_list — paginated runner profile summaries with availability.
 * Read-only: detection runs version/help/reachability probes only and never
 * sends a model request.
 */

const inputSchema = {
  enabledOnly: z.boolean().optional().describe('Only profiles that are enabled in the configuration'),
  detect: z
    .boolean()
    .optional()
    .describe(
      'Probe availability for the returned page (read-only version/help/reachability probes; ' +
        'slower — default false)',
    ),
  limit: limitArg,
  cursor: cursorArg,
};

const outputSchema = {
  defaultRunner: z.string(),
  profiles: z.array(
    profileSummaryShape.extend({
      availability: z.string().optional().describe('Detection status (present when detect=true)'),
    }),
  ),
  pagination: paginationShape,
};

export function registerRunnerListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'runner_list',
    title: 'List runner profiles',
    description:
      'List configured runner profiles: implementation, category, support level, enabled state, ' +
      'configured model, local/network classification, and supported operations. Optionally probes ' +
      'availability (read-only; never a model request). Supports pagination. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      const { workspace, config, registry } = loadRunnerToolContext(context);
      const profiles = registry
        .listProfiles()
        .filter((profile) => args.enabledOnly !== true || profile.config.enabled !== false);
      const page = paginate(profiles, {
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        token: 'runner_list',
      });

      const summaries = [];
      for (const profile of page.items) {
        const summary = runnerProfileSummary(profile);
        if (args.detect === true) {
          const detection = await profile.runner.detect({
            workspaceRoot: workspace.rootDir,
            timeoutMs: RUNNER_PROBE_TIMEOUT_MS,
          });
          summaries.push({ ...summary, availability: detection.status });
        } else {
          summaries.push(summary);
        }
      }

      const lines = summaries.map(
        (summary) =>
          `- ${summary.profile} [${summary.implementation}/${summary.category}] ` +
          `${summary.enabled ? 'enabled' : 'disabled'}, support ${summary.supportLevel}` +
          `${'availability' in summary && summary.availability !== undefined ? `, ${summary.availability}` : ''}` +
          `, operations: ${summary.supportedOperations.join(', ') || '(none)'}`,
      );
      return {
        text: `${page.totalCount} runner profile(s); default runner: ${config.defaultRunner}.\n${lines.join('\n')}`,
        structured: {
          defaultRunner: config.defaultRunner,
          profiles: summaries,
          pagination: {
            totalCount: page.totalCount,
            truncated: page.truncated,
            ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
          },
        },
      };
    },
  });
}
