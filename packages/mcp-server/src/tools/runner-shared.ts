import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import type {
  RegisteredRunnerProfile,
  RunnerConformanceResult,
  RunnerDetectionResult,
  RunnerRegistry,
} from '@specbridge/runners';
import { createDefaultRunnerRegistry, runRunnerConformance } from '@specbridge/runners';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { requireAgentConfig } from './interactive-shared.js';

/**
 * Shared plumbing for the READ-ONLY runner diagnostic tools (v0.6.1):
 * runner_list, runner_show, runner_doctor, runner_matrix.
 *
 * These tools call the SAME shared runner services as the CLI (registry,
 * detection, matrix, conformance) — no detection or matrix logic is
 * duplicated. They never invoke a model, never make paid inference
 * requests, never modify configuration, never authenticate, never start an
 * interactive UI, and never trust folders. Environment-variable VALUES and
 * provider credentials never appear in any result (adapters redact at the
 * source; profiles cannot store credentials at all).
 */

export interface RunnerToolContext {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  registry: RunnerRegistry;
}

export function loadRunnerToolContext(context: ServerContext): RunnerToolContext {
  const workspace = context.requireWorkspace();
  const config = requireAgentConfig(workspace);
  return { workspace, config, registry: createDefaultRunnerRegistry(config) };
}

export function requireProfile(registry: RunnerRegistry, name: string): RegisteredRunnerProfile {
  if (!registry.has(name)) {
    throw new McpToolError(
      'SBMCP002',
      `Unknown runner profile "${name}". Configured profiles: ${registry
        .listProfiles()
        .map((profile) => profile.name)
        .join(', ')}.`,
      { remediation: ['Call runner_list to see every configured profile.'] },
    );
  }
  return registry.getProfile(name);
}

/** Bounded doctor-level probe timeout: diagnostics stay responsive. */
export const RUNNER_PROBE_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export const capabilitySetShape = z
  .record(z.boolean())
  .describe('Provider-independent capability keys to booleans');

export const profileSummaryShape = z.object({
  profile: z.string(),
  implementation: z.string(),
  category: z.string(),
  supportLevel: z.string().describe('Adapter-declared support level'),
  enabled: z.boolean(),
  model: z.string().nullable(),
  networkBacked: z.boolean().describe('True when SpecBridge itself would leave this machine'),
  localExecution: z.boolean(),
  supportedOperations: z.array(z.string()),
});

export const detectionCapabilityShape = z.object({
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  required: z.boolean(),
  detail: z.string().optional(),
});

export const runnerDiagnosticShape = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  message: z.string(),
});

export const detectionViewShape = z.object({
  status: z.string(),
  supportLevel: z.string().describe('Effective support level after detection'),
  version: z.string().nullable(),
  authentication: z.string(),
  networkBacked: z.boolean(),
  capabilities: z.array(detectionCapabilityShape),
  detectedCapabilities: capabilitySetShape,
  diagnostics: z.array(runnerDiagnosticShape),
});
export type DetectionView = z.infer<typeof detectionViewShape>;

const MAX_DIAGNOSTICS = 50;

export function toDetectionView(detection: RunnerDetectionResult, verbose: boolean): DetectionView {
  const diagnostics = (
    verbose
      ? detection.diagnostics
      : detection.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info')
  ).slice(0, MAX_DIAGNOSTICS);
  return {
    status: detection.status,
    supportLevel: detection.supportLevel,
    version: detection.version ?? null,
    authentication: detection.authentication,
    networkBacked: detection.networkBacked,
    capabilities: detection.capabilities.map((capability) => ({
      id: String(capability.id),
      label: capability.label,
      available: capability.available,
      required: capability.required,
      ...(capability.detail !== undefined ? { detail: capability.detail } : {}),
    })),
    detectedCapabilities: detection.capabilitySet,
    diagnostics: diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
    })),
  };
}

export const conformanceSummaryShape = z.object({
  passed: z.boolean(),
  productionConfirmed: z.boolean(),
  failedChecks: z.number().int(),
  skippedChecks: z.number().int(),
  groups: z.array(
    z.object({
      group: z.string(),
      applicable: z.boolean(),
      reason: z.string().optional(),
      passed: z.boolean(),
      skipped: z.number().int(),
    }),
  ),
  note: z.string(),
});
export type ConformanceSummaryView = z.infer<typeof conformanceSummaryShape>;

/**
 * Invocation-free conformance summary against a throwaway scratch directory
 * (never the user's repository). Checks needing provider invocation are
 * reported as skipped — running them stays a CLI decision (`--network`).
 */
export async function invocationFreeConformanceSummary(
  profile: RegisteredRunnerProfile,
): Promise<ConformanceSummaryView> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-mcp-conformance-'));
  let result: RunnerConformanceResult;
  try {
    result = await runRunnerConformance({
      profile,
      workspaceRoot: scratch,
      runDir: path.join(scratch, '.specbridge-conformance-runs'),
      invocationsAllowed: false,
      timeoutMs: RUNNER_PROBE_TIMEOUT_MS,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    passed: result.passed,
    productionConfirmed: result.productionConfirmed,
    failedChecks: result.failedChecks,
    skippedChecks: result.skippedChecks,
    groups: result.groups.map((group) => ({
      group: group.group,
      applicable: group.applicable,
      ...(group.reason !== undefined ? { reason: group.reason } : {}),
      passed: group.passed,
      skipped: group.skipped,
    })),
    note:
      'Invocation-free summary: checks that would invoke the provider are skipped here. ' +
      'Run "specbridge runner conformance <profile> --network" for the full suite.',
  };
}
