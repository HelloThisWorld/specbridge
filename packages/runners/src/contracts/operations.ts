import type { RunnerCapabilityKey, RunnerCapabilitySet } from './capabilities.js';
import { missingCapabilities } from './capabilities.js';

/**
 * Stable runner operations and their capability requirements (v0.6, frozen).
 *
 * Operation names are public discriminators used by configuration
 * (`operationDefaults`), selection plans, attempt records, and the CLI.
 */

export const RUNNER_OPERATIONS = [
  'stage-generation',
  'stage-refinement',
  'task-execution',
  'task-resume',
  'model-list',
  'runner-test',
] as const;
export type RunnerOperation = (typeof RUNNER_OPERATIONS)[number];

/**
 * Capability requirements for one operation.
 *
 * `required` capabilities must all be present. Each `anyOf` group must have
 * at least one present capability — used for safe execution boundaries
 * (`sandbox` OR an adapter-specific, conformance-approved equivalent such as
 * Claude Code tool restriction).
 *
 * Structured output note: `structuredFinalOutput` means the adapter returns
 * a schema-validated structured result — either through provider JSON Schema
 * constraining (`supportsJsonSchema`) or through a validated fallback that
 * passed structured-output conformance. Adapters must not declare it
 * otherwise.
 */
export interface RunnerOperationRequirements {
  operation: RunnerOperation;
  required: readonly RunnerCapabilityKey[];
  anyOf: readonly (readonly RunnerCapabilityKey[])[];
}

export const RUNNER_OPERATION_REQUIREMENTS: Record<RunnerOperation, RunnerOperationRequirements> = {
  'stage-generation': {
    operation: 'stage-generation',
    required: ['stageGeneration', 'structuredFinalOutput', 'supportsCancellation'],
    anyOf: [],
  },
  'stage-refinement': {
    operation: 'stage-refinement',
    required: ['stageRefinement', 'structuredFinalOutput', 'supportsCancellation'],
    anyOf: [],
  },
  'task-execution': {
    operation: 'task-execution',
    required: [
      'taskExecution',
      'repositoryRead',
      'repositoryWrite',
      'structuredFinalOutput',
      'supportsCancellation',
    ],
    // At least one safe execution boundary. `toolRestriction` is the
    // documented, conformance-approved adapter-specific equivalent used by
    // Claude Code (restricted tool set + permission modes, no bypass).
    anyOf: [['sandbox', 'toolRestriction']],
  },
  'task-resume': {
    operation: 'task-resume',
    required: ['taskResume', 'taskExecution', 'structuredFinalOutput', 'supportsCancellation'],
    anyOf: [['sandbox', 'toolRestriction']],
  },
  // Model listing needs provider-supported enumeration; that is a per-adapter
  // affordance (listModels), not a general capability key.
  'model-list': { operation: 'model-list', required: [], anyOf: [] },
  'runner-test': {
    operation: 'runner-test',
    required: ['structuredFinalOutput', 'supportsCancellation'],
    anyOf: [],
  },
};

export interface OperationSupportResult {
  operation: RunnerOperation;
  supported: boolean;
  requiredCapabilities: RunnerCapabilityKey[];
  missingCapabilities: RunnerCapabilityKey[];
  /** anyOf groups where no member capability is available. */
  unsatisfiedBoundaries: RunnerCapabilityKey[][];
}

/** Pure capability check — no provider names, no side effects. */
export function checkOperationSupport(
  operation: RunnerOperation,
  capabilities: RunnerCapabilitySet,
): OperationSupportResult {
  const requirements = RUNNER_OPERATION_REQUIREMENTS[operation];
  const missing = missingCapabilities(requirements.required, capabilities);
  const unsatisfied = requirements.anyOf
    .filter((group) => !group.some((key) => capabilities[key]))
    .map((group) => [...group]);
  return {
    operation,
    supported: missing.length === 0 && unsatisfied.length === 0,
    requiredCapabilities: [...requirements.required],
    missingCapabilities: missing,
    unsatisfiedBoundaries: unsatisfied,
  };
}

/** All operations the capability set supports, in stable declaration order. */
export function supportedOperations(capabilities: RunnerCapabilitySet): RunnerOperation[] {
  return RUNNER_OPERATIONS.filter(
    (operation) => checkOperationSupport(operation, capabilities).supported,
  );
}
