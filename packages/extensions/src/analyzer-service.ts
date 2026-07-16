import type { WorkspaceInfo } from '@specbridge/core';
import {
  analyzerInputSchema,
  analyzerResultSchema,
  namespaceRuleId,
  type AnalyzerInput,
} from '@specbridge/extension-sdk';
import { requireEnabledExtension } from './enablement.js';
import { ExtensionError } from './errors.js';
import { invokeExtensionOperation } from './protocol-client.js';

/**
 * Analyzer extension invocation.
 *
 * Analyzers receive bounded structured spec content and return diagnostics.
 * The host namespaces every rule ID with the extension ID so extension rules
 * can never collide with built-in `SBV` rules or another extension's rules.
 * Extension analysis is additive: it never overwrites built-in diagnostics
 * and never gains approval authority.
 */
export interface ExtensionAnalyzerDiagnostic {
  readonly ruleId: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly remediation?: string;
  readonly confidence: 'deterministic' | 'heuristic';
  readonly extensionId: string;
  readonly extensionVersion: string;
}

export interface ExtensionAnalysisRun {
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly diagnostics: readonly ExtensionAnalyzerDiagnostic[];
  readonly summary?: string;
  readonly durationMs: number;
}

export interface RunAnalyzerOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly configuration?: Record<string, unknown>;
}

export async function runAnalyzerExtension(
  workspace: WorkspaceInfo,
  extensionId: string,
  input: AnalyzerInput,
  options: RunAnalyzerOptions = {},
): Promise<ExtensionAnalysisRun> {
  const enabled = requireEnabledExtension(workspace, extensionId);
  if (enabled.manifest.kind !== 'analyzer') {
    throw new ExtensionError(
      'SBE021',
      `extension "${extensionId}" is a ${enabled.manifest.kind} extension, not an analyzer.`,
      'Pass an analyzer extension to --extension.',
      { extensionId, kind: enabled.manifest.kind },
    );
  }
  if (!enabled.manifest.permissions.specRead) {
    throw new ExtensionError(
      'SBE030',
      `analyzer extension "${extensionId}" does not declare the specRead permission, ` +
        'so SpecBridge cannot send it spec content.',
      'The extension manifest must declare "specRead": true to analyze specs.',
      { extensionId },
    );
  }

  // The permission-aware input boundary: analyzers never receive a project
  // root or repository file content — the schema has no such fields, and the
  // payload is validated before it crosses the process boundary.
  const boundedInput = analyzerInputSchema.parse(input);

  const outcome = await invokeExtensionOperation(enabled, {
    operation: 'analyzer.analyze',
    payload: boundedInput,
    ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });

  const result = analyzerResultSchema.parse(outcome.output);
  const diagnostics = result.diagnostics.map((diagnostic): ExtensionAnalyzerDiagnostic => {
    return {
      ruleId: namespaceRuleId(enabled.manifest.id, diagnostic.ruleId),
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      ...(diagnostic.remediation === undefined ? {} : { remediation: diagnostic.remediation }),
      confidence: diagnostic.confidence,
      extensionId: enabled.manifest.id,
      extensionVersion: enabled.manifest.version,
    };
  });

  return {
    extensionId: enabled.manifest.id,
    extensionVersion: enabled.manifest.version,
    diagnostics,
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    durationMs: outcome.durationMs,
  };
}
