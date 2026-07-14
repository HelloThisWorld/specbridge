import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  RUNNER_OPERATIONS,
  checkOperationSupport,
  redactedRunnerProfileConfig,
  runnerProfileSummary,
} from '@specbridge/runners';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';
import {
  RUNNER_PROBE_TIMEOUT_MS,
  capabilitySetShape,
  conformanceSummaryShape,
  detectionViewShape,
  invocationFreeConformanceSummary,
  loadRunnerToolContext,
  profileSummaryShape,
  requireProfile,
  toDetectionView,
} from './runner-shared.js';

/**
 * runner_show — one profile in depth: redacted configuration, declared and
 * detected capabilities, operation compatibility, invocation-free
 * conformance summary, network boundary, limitations, and remediation.
 * Read-only; never a model request.
 */

const inputSchema = {
  profile: z.string().min(1).max(120).describe('Runner profile name (e.g. "gemini-default")'),
};

const operationCompatibilityShape = z.object({
  operation: z.string(),
  supported: z.boolean(),
  missingCapabilities: z.array(z.string()),
});

const outputSchema = {
  summary: profileSummaryShape,
  configuration: z
    .record(z.unknown())
    .describe('Redacted profile configuration (profiles can never store credential values)'),
  declaredCapabilities: capabilitySetShape,
  detection: detectionViewShape,
  operationCompatibility: z
    .array(operationCompatibilityShape)
    .describe('Per-operation support from DETECTED capabilities'),
  conformance: conformanceSummaryShape,
  boundary: z.object({
    networkBacked: z.boolean(),
    localExecution: z.boolean(),
    constraints: z.array(z.string()),
  }),
  limitations: z.array(z.string()),
  remediation: z.array(z.string()),
};

export function registerRunnerShowTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'runner_show',
    title: 'Show a runner profile',
    description:
      'Show one runner profile: redacted configuration, declared and detected capabilities, ' +
      'operation compatibility, invocation-free conformance summary, network boundary, known ' +
      'limitations, and remediation. Read-only; never sends a model request.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema,
    outputSchema,
    handler: async (args) => {
      const { workspace, registry } = loadRunnerToolContext(context);
      const profile = requireProfile(registry, args.profile);
      const summary = runnerProfileSummary(profile);
      const detection = await profile.runner.detect({
        workspaceRoot: workspace.rootDir,
        probeCapabilities: true,
        timeoutMs: RUNNER_PROBE_TIMEOUT_MS,
      });
      const detectionView = toDetectionView(detection, true);
      const conformance = await invocationFreeConformanceSummary(profile);

      const operationCompatibility = RUNNER_OPERATIONS.filter(
        (operation) => operation !== 'model-list' && operation !== 'runner-test',
      ).map((operation) => {
        const support = checkOperationSupport(operation, detection.capabilitySet);
        return {
          operation,
          supported: support.supported,
          missingCapabilities: [
            ...support.missingCapabilities,
            ...support.unsatisfiedBoundaries.flat(),
          ],
        };
      });

      const boundaryNote = profile.runner.executionBoundaryNote?.('implementation');
      const limitations = detectionView.diagnostics
        .filter((diagnostic) => diagnostic.severity !== 'error')
        .map((diagnostic) => diagnostic.message);
      const remediation = detectionView.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.message);

      const supported = operationCompatibility
        .filter((entry) => entry.supported)
        .map((entry) => entry.operation);
      return {
        text:
          `Profile ${args.profile} (${summary.implementation}, ${summary.category}): ` +
          `${summary.enabled ? 'enabled' : 'disabled'}, status ${detection.status}, ` +
          `support ${detection.supportLevel}. Supported operations (detected): ` +
          `${supported.join(', ') || '(none)'}.`,
        structured: {
          summary,
          configuration: redactedRunnerProfileConfig(profile),
          declaredCapabilities: profile.runner.declaredCapabilities,
          detection: detectionView,
          operationCompatibility,
          conformance,
          boundary: {
            networkBacked: summary.networkBacked,
            localExecution: summary.localExecution,
            constraints: [
              ...(boundaryNote !== undefined ? [boundaryNote] : []),
              'No commits, no pushes, no checkbox updates by the provider; evidence stays provider-independent.',
            ],
          },
          limitations,
          remediation,
        },
      };
    },
  });
}
