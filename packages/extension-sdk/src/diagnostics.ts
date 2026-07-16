import { z } from 'zod';

/**
 * Diagnostics returned by analyzer and verifier extensions.
 *
 * Extensions return bare rule IDs (`RULE001`); the SpecBridge host prefixes
 * them with the extension ID (`security-analyzer/RULE001`) so an extension can
 * never impersonate another extension's rules or the built-in `SBV` rules.
 */
export const EXTENSION_RULE_ID_PATTERN = /^[A-Z][A-Z0-9_-]{0,63}$/;

/** Namespaced form produced by the host: `<extension-id>/<rule-id>`. */
export const NAMESPACED_RULE_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[A-Z][A-Z0-9_-]{0,63}$/;

export const MAX_EXTENSION_DIAGNOSTICS = 1000;

export const EXTENSION_DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'error'] as const;
export type ExtensionDiagnosticSeverity = (typeof EXTENSION_DIAGNOSTIC_SEVERITIES)[number];

export const EXTENSION_CONFIDENCE_LEVELS = ['deterministic', 'heuristic'] as const;
export type ExtensionConfidence = (typeof EXTENSION_CONFIDENCE_LEVELS)[number];

export const extensionDiagnosticSchema = z
  .object({
    ruleId: z.string().regex(EXTENSION_RULE_ID_PATTERN, 'rule IDs are UPPERCASE tokens like RULE001'),
    severity: z.enum(EXTENSION_DIAGNOSTIC_SEVERITIES),
    message: z.string().min(1).max(2000),
    file: z.string().min(1).max(500).optional(),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    remediation: z.string().min(1).max(2000).optional(),
    confidence: z.enum(EXTENSION_CONFIDENCE_LEVELS),
  })
  .strict();

export type ExtensionDiagnostic = z.infer<typeof extensionDiagnosticSchema>;

export const extensionDiagnosticsArraySchema = z
  .array(extensionDiagnosticSchema)
  .max(MAX_EXTENSION_DIAGNOSTICS);

/** Compose the host-side namespaced rule ID. */
export function namespaceRuleId(extensionId: string, ruleId: string): string {
  return `${extensionId}/${ruleId}`;
}
