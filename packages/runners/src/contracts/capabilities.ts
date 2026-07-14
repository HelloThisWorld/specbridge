import { z } from 'zod';
import type { RunnerStatus } from '@specbridge/core';

/**
 * Versioned runner capability contract (v0.6, frozen for v0.6.1 adapters).
 *
 * Core orchestration NEVER branches on provider names. It asks whether the
 * selected runner declares (and detection confirms) the capabilities an
 * operation requires. Provider-specific knowledge lives inside adapters.
 *
 * Frozen discriminators — changing any value here is a breaking change for
 * external adapters and is guarded by contract snapshot tests:
 *   - RUNNER_CATEGORIES
 *   - RUNNER_SUPPORT_LEVELS
 *   - RUNNER_CAPABILITY_KEYS
 */

export const RUNNER_CAPABILITIES_SCHEMA_VERSION = '1.0.0';

/** Runner categories. v0.6.0 production adapters use agent-cli, model-api, mock. */
export const RUNNER_CATEGORIES = ['agent-cli', 'model-api', 'mock', 'experimental'] as const;
export type RunnerCategory = (typeof RUNNER_CATEGORIES)[number];

/**
 * Support levels.
 *
 *   production   — implementation complete, all applicable conformance groups
 *                  pass, provider integration tests pass, security boundaries
 *                  documented
 *   preview      — usable only through explicit selection; documented
 *                  limitations remain; never selected automatically
 *   experimental — detection or incomplete integration only; never selected
 *                  automatically
 *   unavailable  — the required executable or endpoint is missing
 *   incompatible — the executable or endpoint exists but required
 *                  capabilities are unavailable
 */
export const RUNNER_SUPPORT_LEVELS = [
  'production',
  'preview',
  'experimental',
  'unavailable',
  'incompatible',
] as const;
export type RunnerSupportLevel = (typeof RUNNER_SUPPORT_LEVELS)[number];

/**
 * The stable capability vocabulary. Deliberately NOT a single `supported`
 * boolean: operations require specific combinations, and adapters must be
 * honest per capability.
 */
export const RUNNER_CAPABILITY_KEYS = [
  'stageGeneration',
  'stageRefinement',
  'taskExecution',
  'taskResume',
  'structuredFinalOutput',
  'streamingEvents',
  'repositoryRead',
  'repositoryWrite',
  'sandbox',
  'toolRestriction',
  'usageReporting',
  'costReporting',
  'localOnly',
  'requiresNetwork',
  'supportsSystemPrompt',
  'supportsJsonSchema',
  'supportsCancellation',
] as const;
export type RunnerCapabilityKey = (typeof RUNNER_CAPABILITY_KEYS)[number];

/** One boolean per capability key. */
export type RunnerCapabilitySet = Record<RunnerCapabilityKey, boolean>;

const capabilitySetShape = Object.fromEntries(
  RUNNER_CAPABILITY_KEYS.map((key) => [key, z.boolean()]),
) as Record<RunnerCapabilityKey, z.ZodBoolean>;

export const runnerCapabilitySetSchema = z.object(capabilitySetShape).strict();

/** Versioned capability document for one runner (declared or detected). */
export const runnerCapabilitiesSchema = z
  .object({
    schemaVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default(RUNNER_CAPABILITIES_SCHEMA_VERSION),
    runner: z.string().min(1),
    category: z.enum(RUNNER_CATEGORIES),
    supportLevel: z.enum(RUNNER_SUPPORT_LEVELS),
    capabilities: runnerCapabilitySetSchema,
  })
  .strict();
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

/** Build a full capability set from the keys that are true. */
export function capabilitySet(enabled: RunnerCapabilityKey[]): RunnerCapabilitySet {
  const set = Object.fromEntries(
    RUNNER_CAPABILITY_KEYS.map((key) => [key, false]),
  ) as RunnerCapabilitySet;
  for (const key of enabled) set[key] = true;
  return set;
}

/** Capability keys missing from `available` among `required`. */
export function missingCapabilities(
  required: readonly RunnerCapabilityKey[],
  available: RunnerCapabilitySet,
): RunnerCapabilityKey[] {
  return required.filter((key) => !available[key]);
}

/**
 * Effective support level after detection. Detection only DOWNGRADES the
 * adapter's declared level: a missing executable/endpoint is `unavailable`,
 * missing required capabilities are `incompatible`. Authentication state and
 * `enabled` are reported separately — they do not change the support level.
 */
export function effectiveSupportLevel(
  declared: RunnerSupportLevel,
  status: RunnerStatus,
): RunnerSupportLevel {
  switch (status) {
    case 'available':
    case 'unauthenticated':
    case 'misconfigured':
      return declared;
    case 'unavailable':
    case 'error':
      return 'unavailable';
    case 'incompatible':
      return 'incompatible';
  }
}
