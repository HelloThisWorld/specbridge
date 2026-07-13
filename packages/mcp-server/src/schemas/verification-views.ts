import { z } from 'zod';
import type { VerificationDiagnostic, VerificationReport } from '@specbridge/core';
import { capDiagnostics } from '../limits.js';

/**
 * Bounded views over the versioned v0.4 verification report, shared by
 * spec_check_drift and spec_run_verification.
 */

export const verificationDiagnosticShape = z.object({
  ruleId: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  remediation: z.string(),
  specName: z.string().nullable(),
  file: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
});

export const verificationSummaryShape = {
  verificationId: z.string(),
  result: z.enum(['passed', 'failed']),
  comparison: z.object({ mode: z.string() }),
  specsVerified: z.number().int(),
  errors: z.number().int(),
  warnings: z.number().int(),
  info: z.number().int(),
  specResults: z.array(
    z.object({
      specName: z.string(),
      result: z.enum(['passed', 'failed']),
      managed: z.boolean(),
      errors: z.number().int(),
      warnings: z.number().int(),
      info: z.number().int(),
    }),
  ),
  ruleIds: z.array(z.string()).describe('Distinct rule IDs that produced findings'),
  diagnostics: z.array(verificationDiagnosticShape),
  diagnosticsDropped: z.number().int(),
  remediation: z.array(z.string()),
};

export interface VerificationView {
  verificationId: string;
  result: 'passed' | 'failed';
  comparison: { mode: string };
  specsVerified: number;
  errors: number;
  warnings: number;
  info: number;
  specResults: {
    specName: string;
    result: 'passed' | 'failed';
    managed: boolean;
    errors: number;
    warnings: number;
    info: number;
  }[];
  ruleIds: string[];
  diagnostics: z.infer<typeof verificationDiagnosticShape>[];
  diagnosticsDropped: number;
  remediation: string[];
}

function toDiagnosticView(diagnostic: VerificationDiagnostic): z.infer<typeof verificationDiagnosticShape> {
  return {
    ruleId: diagnostic.ruleId,
    severity: diagnostic.severity,
    message: diagnostic.message,
    remediation: diagnostic.remediation,
    specName: diagnostic.specName,
    file: diagnostic.file?.path ?? null,
    line: diagnostic.file?.line ?? null,
  };
}

function countBySeverity(diagnostics: readonly VerificationDiagnostic[]): {
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

export function toVerificationView(report: VerificationReport): VerificationView {
  const allDiagnostics = [
    ...report.globalDiagnostics,
    ...report.specResults.flatMap((spec) => spec.diagnostics),
  ];
  const capped = capDiagnostics(allDiagnostics.map(toDiagnosticView));
  const ruleIds = [...new Set(allDiagnostics.map((diagnostic) => diagnostic.ruleId))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  const remediation = [
    ...new Set(
      allDiagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.remediation),
    ),
  ].slice(0, 20);

  return {
    verificationId: report.verificationId,
    result: report.summary.result,
    comparison: { mode: report.comparison.mode },
    specsVerified: report.summary.specsVerified,
    errors: report.summary.errors,
    warnings: report.summary.warnings,
    info: report.summary.info,
    specResults: report.specResults.map((spec) => ({
      specName: spec.specName,
      result: spec.result,
      managed: spec.managed,
      ...countBySeverity(spec.diagnostics),
    })),
    ruleIds,
    diagnostics: capped.items,
    diagnosticsDropped: capped.dropped,
    remediation,
  };
}

export function verificationText(view: VerificationView, heading: string): string {
  const lines = [
    `${heading}: ${view.result.toUpperCase()} — ${view.specsVerified} spec(s), ` +
      `${view.errors} error(s), ${view.warnings} warning(s), ${view.info} info (comparison: ${view.comparison.mode}).`,
  ];
  for (const spec of view.specResults) {
    lines.push(`- ${spec.specName}: ${spec.result} (${spec.errors}E/${spec.warnings}W/${spec.info}I)`);
  }
  if (view.ruleIds.length > 0) lines.push(`Rules triggered: ${view.ruleIds.join(', ')}.`);
  for (const diagnostic of view.diagnostics.filter((d) => d.severity === 'error').slice(0, 10)) {
    lines.push(`  ${diagnostic.ruleId} [${diagnostic.specName ?? 'global'}]: ${diagnostic.message}`);
  }
  return lines.join('\n');
}
