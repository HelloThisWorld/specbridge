import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic, WorkspaceInfo } from '@specbridge/core';

/**
 * Shared schema fragments and view-model helpers.
 *
 * Structured tool output never exposes raw internal class instances or
 * absolute local paths: everything is converted to plain JSON with
 * repository-relative forward-slash paths here.
 */

export const SCHEMA_VERSION = '1.0.0';

export const specNameArg = z
  .string()
  .min(1)
  .max(120)
  .describe('Spec folder name under .kiro/specs/ (e.g. "notification-preferences")');

export const stageArg = z
  .enum(['requirements', 'bugfix', 'design', 'tasks'])
  .describe('Workflow stage name');

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe('Maximum items to return (default 50, maximum 200)');

export const cursorArg = z
  .string()
  .max(4096)
  .optional()
  .describe('Continuation cursor from a previous truncated response');

export const diagnosticShape = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  message: z.string(),
  file: z.string().optional().describe('Repository-relative path'),
  line: z.number().int().optional().describe('1-based line number'),
});
export type DiagnosticView = z.infer<typeof diagnosticShape>;

export const paginationShape = z.object({
  totalCount: z.number().int(),
  truncated: z.boolean(),
  nextCursor: z.string().optional(),
});

/** Repository-relative forward-slash path (identity for already-relative input). */
export function repoRelative(workspace: WorkspaceInfo, target: string): string {
  const relative = path.isAbsolute(target) ? path.relative(workspace.rootDir, target) : target;
  const posix = relative.split(path.sep).join('/');
  return posix === '' ? '.' : posix;
}

/** Convert a core diagnostic into the bounded, repo-relative view shape. */
export function toDiagnosticView(workspace: WorkspaceInfo, diagnostic: Diagnostic): DiagnosticView {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.file !== undefined ? { file: repoRelative(workspace, diagnostic.file) } : {}),
    ...(diagnostic.line !== undefined ? { line: diagnostic.line } : {}),
  };
}

export function toDiagnosticViews(
  workspace: WorkspaceInfo,
  diagnostics: readonly Diagnostic[],
): DiagnosticView[] {
  return diagnostics.map((diagnostic) => toDiagnosticView(workspace, diagnostic));
}

/** Count diagnostics by severity for compact summaries. */
export function diagnosticCounts(diagnostics: readonly Diagnostic[]): {
  errors: number;
  warnings: number;
  info: number;
} {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors += 1;
    else if (diagnostic.severity === 'warning') warnings += 1;
    else info += 1;
  }
  return { errors, warnings, info };
}
