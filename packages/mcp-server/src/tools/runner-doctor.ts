import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';
import {
  RUNNER_PROBE_TIMEOUT_MS,
  detectionViewShape,
  loadRunnerToolContext,
  requireProfile,
  toDetectionView,
} from './runner-shared.js';

/**
 * runner_doctor — read-only diagnostics for one profile (default: the
 * configured default runner). Runs version/help/auth-status probes or
 * loopback reachability checks only. It never invokes a model, never makes
 * a paid inference request, never modifies configuration, never
 * authenticates, never starts an interactive UI, and never trusts folders.
 */

const inputSchema = {
  profile: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Runner profile name (default: the configured default runner)'),
  verbose: z.boolean().optional().describe('Include informational diagnostics'),
};

const outputSchema = {
  profile: z.string(),
  implementation: z.string(),
  category: z.string(),
  enabled: z.boolean(),
  executable: z.string().nullable().describe('Configured executable or endpoint'),
  detection: detectionViewShape,
  ready: z.boolean().describe('True when the runner status is available'),
};

export function registerRunnerDoctorTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'runner_doctor',
    title: 'Diagnose a runner profile',
    description:
      'Diagnose one runner profile: executable/endpoint presence, version, authentication ' +
      'state (never via credential files), detected capabilities, and actionable findings. ' +
      'Read-only: never a model request, never a login, never a configuration change.',
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
      const profileName = args.profile ?? config.defaultRunner;
      const profile = requireProfile(registry, profileName);
      const detection = await profile.runner.detect({
        workspaceRoot: workspace.rootDir,
        probeCapabilities: true,
        timeoutMs: RUNNER_PROBE_TIMEOUT_MS,
      });
      const view = toDetectionView(detection, args.verbose === true);
      const findings = view.diagnostics
        .map((diagnostic) => `- [${diagnostic.severity}] ${diagnostic.message}`)
        .join('\n');
      return {
        text:
          `Runner ${profileName} (${profile.runner.name}): status ${view.status}, ` +
          `support ${view.supportLevel}, authentication ${view.authentication}.` +
          `${findings.length > 0 ? `\n${findings}` : ''}`,
        structured: {
          profile: profileName,
          implementation: profile.runner.name,
          category: profile.runner.category,
          enabled: profile.config.enabled !== false,
          executable: detection.executable ?? null,
          detection: view,
          ready: detection.status === 'available',
        },
      };
    },
  });
}
