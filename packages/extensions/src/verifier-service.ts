import type {
  ExtensionVerifierHook,
  ExtensionVerifierReportEntry,
  WorkspaceInfo,
} from '@specbridge/core';
import {
  namespaceRuleId,
  verifierInputSchema,
  verifierResultSchema,
  type VerifierInput,
} from '@specbridge/extension-sdk';
import { requireEnabledExtension } from './enablement.js';
import { ExtensionError } from './errors.js';
import { invokeExtensionOperation } from './protocol-client.js';

/**
 * Verifier extension invocation and the hook the verification engine uses.
 *
 * Verifier extensions receive a bounded verification context and return a
 * status plus namespaced diagnostics. They cannot update task checkboxes,
 * cannot write evidence, cannot define commands for SpecBridge to run, and
 * cannot disable built-in rules — the existing quality gate consumes their
 * results only through the SBV026 rollup.
 */
export interface ExtensionVerifierRun {
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly status: 'passed' | 'warning' | 'failed' | 'not-applicable';
  readonly diagnostics: ExtensionVerifierReportEntry['diagnostics'];
  readonly summary?: string;
  readonly durationMs: number;
}

export interface RunVerifierOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly configuration?: Record<string, unknown>;
}

export async function runVerifierExtension(
  workspace: WorkspaceInfo,
  extensionId: string,
  input: VerifierInput,
  options: RunVerifierOptions = {},
): Promise<ExtensionVerifierRun> {
  const enabled = requireEnabledExtension(workspace, extensionId);
  if (enabled.manifest.kind !== 'verifier') {
    throw new ExtensionError(
      'SBE021',
      `extension "${extensionId}" is a ${enabled.manifest.kind} extension, not a verifier.`,
      'Configure a verifier extension in the policy extensionVerifiers list.',
      { extensionId, kind: enabled.manifest.kind },
    );
  }

  // Permission-aware boundary: repository file content crosses the process
  // boundary only when the extension holds repositoryRead.
  const bounded = verifierInputSchema.parse(input);
  const payload = enabled.manifest.permissions.repositoryRead
    ? bounded
    : (() => {
        const { files: _files, ...rest } = bounded;
        return rest;
      })();

  const outcome = await invokeExtensionOperation(enabled, {
    operation: 'verifier.verify',
    payload,
    ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });

  const result = verifierResultSchema.parse(outcome.output);
  return {
    extensionId: enabled.manifest.id,
    extensionVersion: enabled.manifest.version,
    status: result.status,
    diagnostics: result.diagnostics.map((diagnostic) => ({
      ruleId: namespaceRuleId(enabled.manifest.id, diagnostic.ruleId),
      severity: diagnostic.severity,
      message: diagnostic.message,
      file: diagnostic.file ?? null,
      line: diagnostic.line ?? null,
      remediation: diagnostic.remediation ?? null,
      confidence: diagnostic.confidence,
    })),
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    durationMs: outcome.durationMs,
  };
}

const SDK_CHANGE_TYPES = new Set(['added', 'modified', 'deleted', 'renamed']);

/**
 * Build the hook `verifySpecs` calls for policy-configured extension
 * verifiers. The hook never throws: every failure becomes a
 * `status: 'error'` entry so a required verifier can fail the gate while an
 * extension crash can never crash SpecBridge.
 */
export function createExtensionVerifierHook(
  workspace: WorkspaceInfo,
  options: { timeoutMs?: number; environment?: Readonly<Record<string, string | undefined>> } = {},
): ExtensionVerifierHook {
  return async ({ specName, entries, changedFiles }) => {
    const results: ExtensionVerifierReportEntry[] = [];
    for (const entry of entries) {
      const input: VerifierInput = {
        specName,
        changedFiles: changedFiles.slice(0, 2000).map((file) => ({
          path: file.path,
          changeType: SDK_CHANGE_TYPES.has(file.changeType)
            ? (file.changeType as 'added' | 'modified' | 'deleted' | 'renamed')
            : 'unknown',
        })),
        ...(Object.keys(entry.configuration).length > 0
          ? { configuration: entry.configuration }
          : {}),
      };
      try {
        const run = await runVerifierExtension(workspace, entry.extension, input, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          ...(Object.keys(entry.configuration).length > 0
            ? { configuration: entry.configuration }
            : {}),
        });
        results.push({
          extensionId: run.extensionId,
          extensionVersion: run.extensionVersion,
          specName,
          required: entry.required,
          status: run.status,
          summary: run.summary ?? null,
          durationMs: run.durationMs,
          diagnostics: run.diagnostics,
        });
      } catch (cause) {
        results.push({
          extensionId: entry.extension,
          extensionVersion: 'unknown',
          specName,
          required: entry.required,
          status: 'error',
          summary: cause instanceof Error ? cause.message : String(cause),
          durationMs: 0,
          diagnostics: [],
        });
      }
    }
    return results;
  };
}
