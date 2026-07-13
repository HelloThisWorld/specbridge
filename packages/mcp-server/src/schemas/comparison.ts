import { z } from 'zod';
import type { ComparisonRequest } from '@specbridge/drift';
import { isSafeGitRef } from '@specbridge/drift';
import { McpToolError } from '../errors.js';

/**
 * Git comparison arguments shared by spec_affected, spec_check_drift, and
 * spec_run_verification. Exactly the CLI semantics: working-tree (default),
 * staged, or an explicit base...head diff with validated refs (no option
 * injection, no whitespace, no leading dashes).
 */

export const comparisonArgs = {
  comparison: z
    .enum(['working-tree', 'staged', 'diff'])
    .optional()
    .describe('Comparison mode (default working-tree)'),
  base: z.string().max(256).optional().describe('Base git ref (diff mode only)'),
  head: z.string().max(256).optional().describe('Head git ref (diff mode only; default HEAD)'),
};

export interface ComparisonArgValues {
  comparison?: 'working-tree' | 'staged' | 'diff' | undefined;
  base?: string | undefined;
  head?: string | undefined;
}

export function toComparisonRequest(args: ComparisonArgValues): ComparisonRequest {
  const mode = args.comparison ?? 'working-tree';
  if (mode !== 'diff') {
    if (args.base !== undefined || args.head !== undefined) {
      throw new McpToolError(
        'SBMCP002',
        'base/head are only valid with comparison: "diff".',
      );
    }
    return { mode };
  }
  if (args.base === undefined) {
    throw new McpToolError('SBMCP002', 'comparison "diff" requires a base ref.');
  }
  const head = args.head ?? 'HEAD';
  for (const [role, ref] of [
    ['base', args.base],
    ['head', head],
  ] as const) {
    if (!isSafeGitRef(ref)) {
      throw new McpToolError(
        'SBMCP002',
        `The ${role} ref "${ref}" is not a valid git ref (refs must not start with "-" or contain whitespace).`,
      );
    }
  }
  return { mode: 'diff', base: args.base, head };
}

export const comparisonDescriptorShape = z.object({
  mode: z.string(),
  base: z.string().nullable().optional(),
  head: z.string().nullable().optional(),
});
