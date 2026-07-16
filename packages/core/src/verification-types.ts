import { z } from 'zod';

/**
 * Versioned verification vocabulary shared by the drift rule engine, the
 * reporting renderers, the CLI, and the GitHub Action.
 *
 * Stability contract:
 *   - rule IDs (`SBV###`) are stable and never silently renumbered
 *   - diagnostic and report schemas are versioned; readers accept any 1.x
 *   - every report is validated with these schemas before it is written
 */

export const VERIFICATION_DIAGNOSTIC_SCHEMA_VERSION = '1.0.0';
export const VERIFICATION_REPORT_SCHEMA_VERSION = '1.0.0';

export const VERIFICATION_SEVERITIES = ['error', 'warning', 'info'] as const;
export type VerificationSeverity = (typeof VERIFICATION_SEVERITIES)[number];

export const VERIFICATION_CATEGORIES = [
  'workspace',
  'approval',
  'requirements',
  'design',
  'tasks',
  'evidence',
  'impact-area',
  'verification-command',
  'protected-path',
  'mapping',
  'git',
] as const;
export type VerificationCategory = (typeof VERIFICATION_CATEGORIES)[number];

/**
 * How a finding was produced. `deterministic` findings follow from file
 * bytes, hashes, git output, and exit codes alone. `heuristic` findings come
 * from pattern recognition (e.g. "this task title mentions tests") and must
 * never default to `error` severity.
 */
export const VERIFICATION_CONFIDENCE_VALUES = ['deterministic', 'heuristic'] as const;
export type VerificationConfidence = (typeof VERIFICATION_CONFIDENCE_VALUES)[number];

export const VERIFICATION_RULE_ID_PATTERN = /^SBV\d{3}$/;

/** Repository-relative source location (forward slashes, 1-based line/column). */
export const verificationFileLocationSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1).nullable(),
  column: z.number().int().min(1).nullable(),
});
export type VerificationFileLocation = z.infer<typeof verificationFileLocationSchema>;

export const verificationDiagnosticSchema = z.object({
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  ruleId: z.string().regex(VERIFICATION_RULE_ID_PATTERN),
  title: z.string().min(1),
  severity: z.enum(VERIFICATION_SEVERITIES),
  category: z.enum(VERIFICATION_CATEGORIES),
  message: z.string().min(1),
  remediation: z.string().min(1),
  specName: z.string().nullable(),
  taskId: z.string().nullable(),
  requirementId: z.string().nullable(),
  file: verificationFileLocationSchema.nullable(),
  /** Structured, rule-specific supporting data (always JSON-serializable). */
  evidence: z.record(z.unknown()),
  confidence: z.enum(VERIFICATION_CONFIDENCE_VALUES),
});
export type VerificationDiagnostic = z.infer<typeof verificationDiagnosticSchema>;

export const COMPARISON_MODES = ['diff', 'working-tree', 'staged'] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export const comparisonDescriptorSchema = z.object({
  mode: z.enum(COMPARISON_MODES),
  /** Base ref as given by the user/event; null for working-tree and staged. */
  base: z.string().nullable(),
  head: z.string().nullable(),
  /** Resolved commit SHAs where available. */
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  /** Human-readable label, e.g. `origin/main...HEAD` or `working tree vs HEAD`. */
  label: z.string().min(1),
});
export type ComparisonDescriptor = z.infer<typeof comparisonDescriptorSchema>;

export const CHANGED_FILE_TYPES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
] as const;
export type ChangedFileType = (typeof CHANGED_FILE_TYPES)[number];

export const reportChangedFileSchema = z.object({
  /** Repository-relative path with forward slashes. */
  path: z.string().min(1),
  oldPath: z.string().nullable(),
  changeType: z.enum(CHANGED_FILE_TYPES),
  binary: z.boolean(),
  insertions: z.number().int().min(0).nullable(),
  deletions: z.number().int().min(0).nullable(),
});
export type ReportChangedFile = z.infer<typeof reportChangedFileSchema>;

export const VERIFICATION_COMMAND_DISPOSITIONS = [
  /** The command ran during this verification. */
  'executed',
  /** A passing result was reused from valid, fresh task evidence. */
  'reused-evidence',
  /** The command did not run (per options) and nothing could be reused. */
  'not-run',
] as const;
export type VerificationCommandDisposition = (typeof VERIFICATION_COMMAND_DISPOSITIONS)[number];

export const verificationCommandReportSchema = z.object({
  name: z.string().min(1),
  argv: z.array(z.string()),
  required: z.boolean(),
  disposition: z.enum(VERIFICATION_COMMAND_DISPOSITIONS),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().min(0).nullable(),
  timedOut: z.boolean(),
  passed: z.boolean(),
  /** Specs whose policy required this command by name. */
  requiredBySpecs: z.array(z.string()),
});
export type VerificationCommandReport = z.infer<typeof verificationCommandReportSchema>;

export const SELECTION_MODES = ['single', 'changed', 'all'] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

export const VERIFICATION_RESULTS = ['passed', 'failed'] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const POLICY_MODES = ['advisory', 'strict'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const specTraceabilitySummarySchema = z.object({
  requirements: z.number().int().min(0),
  requirementsWithTasks: z.number().int().min(0),
  tasks: z.number().int().min(0),
  tasksWithRequirements: z.number().int().min(0),
});
export type SpecTraceabilitySummary = z.infer<typeof specTraceabilitySummarySchema>;

export const specEvidenceSummarySchema = z.object({
  /** Completed tasks with valid, fresh verified evidence. */
  valid: z.number().int().min(0),
  /** Completed tasks whose best evidence is stale. */
  stale: z.number().int().min(0),
  /** Completed tasks with no accepted evidence at all. */
  missing: z.number().int().min(0),
  /** Structurally invalid evidence records encountered. */
  invalid: z.number().int().min(0),
  /** Completed tasks covered by valid manual acceptance (subset of valid). */
  manuallyAccepted: z.number().int().min(0),
});
export type SpecEvidenceSummary = z.infer<typeof specEvidenceSummarySchema>;

export const specVerificationResultSchema = z.object({
  specName: z.string().min(1),
  specType: z.enum(['feature', 'bugfix', 'unknown']),
  workflowMode: z.enum(['requirements-first', 'design-first', 'quick', 'unknown']),
  /** True when SpecBridge sidecar workflow state exists for the spec. */
  managed: z.boolean(),
  result: z.enum(VERIFICATION_RESULTS),
  policyMode: z.enum(POLICY_MODES),
  /** Workspace-relative policy file path; null when defaults were used. */
  policyPath: z.string().nullable(),
  /** Why the spec was selected (affected-spec reasons; empty for single/all). */
  matchedBy: z.array(z.string()),
  changedFiles: z.array(reportChangedFileSchema),
  traceability: specTraceabilitySummarySchema,
  evidence: specEvidenceSummarySchema,
  diagnostics: z.array(verificationDiagnosticSchema),
});
export type SpecVerificationResult = z.infer<typeof specVerificationResultSchema>;

export const verificationSummarySchema = z.object({
  result: z.enum(VERIFICATION_RESULTS),
  specsVerified: z.number().int().min(0),
  errors: z.number().int().min(0),
  warnings: z.number().int().min(0),
  info: z.number().int().min(0),
});
export type VerificationSummary = z.infer<typeof verificationSummarySchema>;

/**
 * v0.7.1: one extension verifier's contribution to a verification run.
 * Extension verifiers are explicit policy opt-ins that run out of process;
 * their diagnostics stay namespaced (`<extension-id>/<RULE>`) and separate
 * from built-in `SBV` diagnostics. The built-in quality gate remains
 * authoritative: extension results feed it only through the SBV026 rollup
 * rule, and extensions can never mark tasks complete or change evidence.
 */
export const EXTENSION_VERIFIER_STATUS_VALUES = [
  'passed',
  'warning',
  'failed',
  'not-applicable',
  'error',
] as const;
export type ExtensionVerifierStatus = (typeof EXTENSION_VERIFIER_STATUS_VALUES)[number];

export const NAMESPACED_EXTENSION_RULE_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[A-Z][A-Z0-9_-]{0,63}$/;

export const extensionVerifierDiagnosticSchema = z.object({
  ruleId: z.string().regex(NAMESPACED_EXTENSION_RULE_ID_PATTERN),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1),
  file: z.string().nullable(),
  line: z.number().int().min(1).nullable(),
  remediation: z.string().nullable(),
  confidence: z.enum(['deterministic', 'heuristic']),
});
export type ExtensionVerifierDiagnostic = z.infer<typeof extensionVerifierDiagnosticSchema>;

export const extensionVerifierReportEntrySchema = z.object({
  extensionId: z.string().min(1),
  extensionVersion: z.string().min(1),
  specName: z.string().min(1),
  required: z.boolean(),
  status: z.enum(EXTENSION_VERIFIER_STATUS_VALUES),
  summary: z.string().nullable(),
  durationMs: z.number().int().min(0),
  diagnostics: z.array(extensionVerifierDiagnosticSchema).max(1000),
});
export type ExtensionVerifierReportEntry = z.infer<typeof extensionVerifierReportEntrySchema>;

/** One policy opt-in for an extension verifier. */
export interface ExtensionVerifierPolicyEntry {
  extension: string;
  required: boolean;
  configuration: Record<string, unknown>;
}

/** Input handed to the injected extension-verifier hook, per spec. */
export interface ExtensionVerifierHookInput {
  specName: string;
  entries: readonly ExtensionVerifierPolicyEntry[];
  changedFiles: ReadonlyArray<{ path: string; changeType: string }>;
}

/**
 * Injected by the CLI (backed by @specbridge/extensions) so the verification
 * engine stays free of extension dependencies. The hook must never throw:
 * extension failures are reported as `status: 'error'` entries.
 */
export type ExtensionVerifierHook = (
  input: ExtensionVerifierHookInput,
) => Promise<ExtensionVerifierReportEntry[]>;

export const verificationReportSchema = z.object({
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  tool: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  verificationId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  comparison: comparisonDescriptorSchema,
  selection: z.object({
    mode: z.enum(SELECTION_MODES),
    specs: z.array(z.string()),
  }),
  summary: verificationSummarySchema,
  specResults: z.array(specVerificationResultSchema),
  /** Diagnostics not attributable to a single selected spec. */
  globalDiagnostics: z.array(verificationDiagnosticSchema),
  verificationCommands: z.array(verificationCommandReportSchema),
  /** v0.7.1: results from policy-configured extension verifiers (optional). */
  extensionVerifiers: z.array(extensionVerifierReportEntrySchema).optional(),
});
export type VerificationReport = z.infer<typeof verificationReportSchema>;

const SEVERITY_RANK: Record<VerificationSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function severityRank(severity: VerificationSeverity): number {
  return SEVERITY_RANK[severity];
}

/**
 * Deterministic diagnostic ordering used by every report format:
 * severity (errors first), then rule ID, file path, line, task, requirement,
 * and finally the message text as a tiebreaker.
 */
export function compareVerificationDiagnostics(
  a: VerificationDiagnostic,
  b: VerificationDiagnostic,
): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byRule = a.ruleId.localeCompare(b.ruleId, 'en');
  if (byRule !== 0) return byRule;
  const byFile = (a.file?.path ?? '').localeCompare(b.file?.path ?? '', 'en');
  if (byFile !== 0) return byFile;
  const byLine = (a.file?.line ?? 0) - (b.file?.line ?? 0);
  if (byLine !== 0) return byLine;
  const byTask = (a.taskId ?? '').localeCompare(b.taskId ?? '', 'en');
  if (byTask !== 0) return byTask;
  const byRequirement = (a.requirementId ?? '').localeCompare(b.requirementId ?? '', 'en');
  if (byRequirement !== 0) return byRequirement;
  return a.message.localeCompare(b.message, 'en');
}

export function sortVerificationDiagnostics(
  diagnostics: readonly VerificationDiagnostic[],
): VerificationDiagnostic[] {
  return [...diagnostics].sort(compareVerificationDiagnostics);
}

/** Count diagnostics per severity across spec results and global diagnostics. */
export function countDiagnostics(
  diagnostics: readonly VerificationDiagnostic[],
): { errors: number; warnings: number; info: number } {
  const counts = { errors: 0, warnings: 0, info: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') counts.errors += 1;
    else if (diagnostic.severity === 'warning') counts.warnings += 1;
    else counts.info += 1;
  }
  return counts;
}

export const FAIL_ON_THRESHOLDS = ['error', 'warning', 'never'] as const;
export type FailOnThreshold = (typeof FAIL_ON_THRESHOLDS)[number];

/** True when the diagnostic counts reach the configured failure threshold. */
export function reachesFailureThreshold(
  counts: { errors: number; warnings: number },
  threshold: FailOnThreshold,
): boolean {
  if (threshold === 'never') return false;
  if (threshold === 'warning') return counts.errors > 0 || counts.warnings > 0;
  return counts.errors > 0;
}
