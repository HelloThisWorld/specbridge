import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveAffectedSpecs, resolveComparison } from '@specbridge/drift';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { comparisonArgs, toComparisonRequest } from '../schemas/comparison.js';
import { registerDefinedTool } from './helpers.js';

/** spec_affected — v0.4 affected-spec resolution over a git comparison. */

const inputSchema = {
  ...comparisonArgs,
  strict: z.boolean().optional().describe('Use strict policy evaluation where policies define it'),
};

const outputSchema = {
  comparison: z.object({
    mode: z.string(),
    changedFiles: z.number().int(),
  }),
  affected: z.array(
    z.object({
      specName: z.string(),
      matches: z.array(z.object({ file: z.string(), via: z.array(z.string()) })),
    }),
  ),
  unmapped: z.array(z.string()).describe('Changed files no spec claims (bounded)'),
  ambiguous: z.array(
    z.object({
      path: z.string(),
      specs: z.array(z.object({ name: z.string(), via: z.array(z.string()) })),
    }),
  ),
  truncated: z.boolean(),
};

const MAX_PATHS = 500;

export function registerSpecAffectedTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_affected',
    title: 'Resolve affected specs',
    description:
      'Resolve which specs a change set touches (spec files, sidecar state, policies, impact areas, ' +
      'accepted evidence, design references) plus unmapped and ambiguous files. Read-only.',
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
      const request = toComparisonRequest(args);
      const comparison = await resolveComparison(workspace.rootDir, request, {
        signal: extras.signal,
      });
      if (!comparison.ok) {
        throw new McpToolError(
          'SBMCP013',
          `The git comparison could not be resolved: ${comparison.failure?.message ?? 'unknown reason'}.`,
          { remediation: ['Check that the refs exist and the repository has at least one commit.'] },
        );
      }

      const result = resolveAffectedSpecs(workspace, comparison.changedFiles, {
        ...(args.strict !== undefined ? { strict: args.strict } : {}),
      });

      let truncated = false;
      const boundedAffected = result.affected.map((spec) => {
        if (spec.matches.length > MAX_PATHS) truncated = true;
        return { specName: spec.specName, matches: spec.matches.slice(0, MAX_PATHS) };
      });
      if (result.unmapped.length > MAX_PATHS || result.ambiguous.length > MAX_PATHS) truncated = true;

      const text = [
        `Comparison ${request.mode}: ${comparison.changedFiles.length} changed file(s).`,
        result.affected.length > 0
          ? `Affected specs: ${result.affected.map((spec) => spec.specName).join(', ')}.`
          : 'No spec is affected by this change set.',
        result.unmapped.length > 0 ? `${result.unmapped.length} unmapped changed file(s).` : '',
        result.ambiguous.length > 0 ? `${result.ambiguous.length} file(s) claimed by more than one spec.` : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n');

      return {
        text,
        structured: {
          comparison: { mode: request.mode, changedFiles: comparison.changedFiles.length },
          affected: boundedAffected,
          unmapped: result.unmapped.slice(0, MAX_PATHS).map((file) => file.path),
          ambiguous: result.ambiguous.slice(0, MAX_PATHS),
          truncated,
        },
      };
    },
  });
}
