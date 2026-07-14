import type { AgentConfig, RunnerProfileConfig } from '@specbridge/core';
import { validateRunnerBaseUrl } from '@specbridge/core';
import type { RegisteredRunnerProfile, RunnerRegistry } from '../registry.js';
import type {
  RunnerCapabilityKey,
  RunnerCapabilitySet,
  RunnerCategory,
  RunnerSupportLevel,
} from '../contracts/capabilities.js';
import type { RunnerOperation } from '../contracts/operations.js';
import {
  RUNNER_OPERATION_REQUIREMENTS,
  checkOperationSupport,
  supportedOperations,
} from '../contracts/operations.js';
import type { NormalizedRunnerError } from '../contracts/errors.js';
import { runnerError } from '../contracts/errors.js';

/**
 * Deterministic, capability-driven runner selection (v0.6).
 *
 * Precedence (first match wins; nothing is ever selected merely because it
 * is available, and failure never switches providers silently):
 *
 *   1. explicit `--runner <profile>`
 *   2. spec-specific preference (reserved; the current architecture stores
 *      no per-spec runner preference)
 *   3. operation-specific default (`operationDefaults`)
 *   4. global `defaultRunner`
 *
 * Selection validates BEFORE any process or network execution:
 *   - the profile exists and is enabled
 *   - the implementation's declared capabilities support the operation
 *   - network-backed transports are explicitly selected (CLI flag or
 *     operation default), never implicitly via the global default
 *   - support level permits automatic selection (preview/experimental
 *     profiles require the explicit CLI flag)
 */

export type SelectionOrigin = 'explicit' | 'spec-preference' | 'operation-default' | 'global-default';

export interface RunnerSelectionRequest {
  operation: RunnerOperation;
  /** `--runner <profile>` (highest precedence). */
  explicitProfile?: string;
  /** Reserved for spec-level preferences (not stored by the current architecture). */
  specPreference?: string;
}

export interface RunnerSelectionPlan {
  profile: string;
  runner: string;
  category: RunnerCategory;
  /** Declared support level (detection may still downgrade at run time). */
  supportLevel: RunnerSupportLevel;
  operation: RunnerOperation;
  origin: SelectionOrigin;
  requiredCapabilities: RunnerCapabilityKey[];
  declaredCapabilities: RunnerCapabilitySet;
  /** True when SpecBridge itself would talk to a non-loopback endpoint. */
  networkBacked: boolean;
  /** True when inference stays on this machine (loopback model API). */
  localExecution: boolean;
  model: string | null;
  /** Authoring fallback profiles that would be attempted after this one. */
  fallbackChain: string[];
  /** Human-readable safety constraints for plan displays. */
  constraints: string[];
  endpoint?: string;
}

export interface RunnerSelectionFailure {
  error: NormalizedRunnerError;
  operation: RunnerOperation;
  profile?: string;
  requiredCapabilities: RunnerCapabilityKey[];
  missingCapabilities: RunnerCapabilityKey[];
  declaredCapabilities?: RunnerCapabilitySet;
  /** Enabled profiles whose declared capabilities support the operation. */
  compatibleProfiles: string[];
}

export type RunnerSelectionResult =
  | { ok: true; plan: RunnerSelectionPlan }
  | { ok: false; failure: RunnerSelectionFailure };

/** Profile transport classification (no probes; configuration only). */
export function profileTransport(config: RunnerProfileConfig): {
  networkBacked: boolean;
  localExecution: boolean;
  endpoint?: string;
} {
  if (config.runner === 'ollama' || config.runner === 'openai-compatible') {
    const url = validateRunnerBaseUrl(config.baseUrl, {
      allowInsecureHttp: config.allowInsecureHttp,
    });
    return {
      networkBacked: !url.loopback,
      localExecution: url.loopback,
      endpoint: config.baseUrl,
    };
  }
  if (config.runner === 'mock') {
    return { networkBacked: false, localExecution: true };
  }
  // Agent CLIs run locally; their provider connectivity is their own.
  return { networkBacked: false, localExecution: false };
}

export function profileModel(config: RunnerProfileConfig): string | null {
  if (config.runner === 'mock' || config.runner === 'antigravity-cli') return null;
  return config.model ?? null;
}

function declaredSupportLevel(profile: RegisteredRunnerProfile): RunnerSupportLevel {
  // v0.6.0 adapters declare no level and are production; v0.6.1 preview or
  // experimental adapters declare their level on the adapter itself.
  return profile.runner.declaredSupportLevel ?? 'production';
}

function constraintsFor(profile: RegisteredRunnerProfile, operation: RunnerOperation): string[] {
  const constraints: string[] = [];
  const boundary = profile.runner.executionBoundaryNote?.(
    operation === 'task-execution' || operation === 'task-resume' ? 'implementation' : 'read-only',
  );
  if (boundary !== undefined) constraints.push(boundary);
  if (profile.config.runner === 'ollama' || profile.config.runner === 'openai-compatible') {
    constraints.push('Task execution and repository writes are not capabilities of this runner.');
  }
  if (profile.config.runner === 'openai-compatible' && profile.config.allowInsecureHttp) {
    constraints.push('INSECURE development override: plain HTTP to a remote endpoint is explicitly allowed.');
  }
  constraints.push('No commits, no pushes, no checkbox updates by the provider; evidence stays provider-independent.');
  return constraints;
}

function compatibleProfilesFor(
  registry: RunnerRegistry,
  operation: RunnerOperation,
): string[] {
  return registry
    .listProfiles()
    .filter(
      (candidate) =>
        candidate.config.enabled !== false &&
        checkOperationSupport(operation, candidate.runner.declaredCapabilities).supported,
    )
    .map((candidate) => candidate.name);
}

function operationDefaultFor(config: AgentConfig, operation: RunnerOperation): string | null {
  switch (operation) {
    case 'stage-generation':
      return config.operationDefaults.stageGeneration;
    case 'stage-refinement':
      return config.operationDefaults.stageRefinement;
    case 'task-execution':
    case 'task-resume':
      return config.operationDefaults.taskExecution;
    case 'model-list':
    case 'runner-test':
      return null;
  }
}

function fallbackChainFor(
  config: AgentConfig,
  operation: RunnerOperation,
  selected: string,
): string[] {
  const chain =
    operation === 'stage-generation'
      ? config.fallbacks.stageGeneration
      : operation === 'stage-refinement'
        ? config.fallbacks.stageRefinement
        : [];
  return chain.filter((name) => name !== selected);
}

/** Resolve the candidate profile name and its origin. Deterministic. */
export function resolveSelectionCandidate(
  config: AgentConfig,
  request: RunnerSelectionRequest,
): { profile: string; origin: SelectionOrigin } {
  if (request.explicitProfile !== undefined) {
    return { profile: request.explicitProfile, origin: 'explicit' };
  }
  if (request.specPreference !== undefined) {
    return { profile: request.specPreference, origin: 'spec-preference' };
  }
  const operationDefault = operationDefaultFor(config, request.operation);
  if (operationDefault !== null) {
    return { profile: operationDefault, origin: 'operation-default' };
  }
  return { profile: config.defaultRunner, origin: 'global-default' };
}

/**
 * Select a runner profile for one operation. Pure over the registry and
 * configuration: no probes, no processes, no network — every refusal
 * happens before execution could start.
 */
export function selectRunner(
  registry: RunnerRegistry,
  config: AgentConfig,
  request: RunnerSelectionRequest,
): RunnerSelectionResult {
  const { profile: profileName, origin } = resolveSelectionCandidate(config, request);
  const requirements = RUNNER_OPERATION_REQUIREMENTS[request.operation];
  const fail = (failure: Omit<RunnerSelectionFailure, 'operation' | 'compatibleProfiles'>): RunnerSelectionResult => ({
    ok: false,
    failure: {
      ...failure,
      operation: request.operation,
      compatibleProfiles: compatibleProfilesFor(registry, request.operation),
    },
  });

  if (!registry.has(profileName)) {
    return fail({
      error: runnerError({
        code: 'runner_not_found',
        message: `Runner profile "${profileName}" is not configured.`,
        remediation: [
          `Configured profiles: ${registry.listProfiles().map((profile) => profile.name).join(', ')}.`,
        ],
      }),
      profile: profileName,
      requiredCapabilities: [...requirements.required],
      missingCapabilities: [],
    });
  }
  const profile = registry.getProfile(profileName);

  if (profile.config.enabled === false) {
    return fail({
      error: runnerError({
        code: 'runner_disabled',
        message: `Runner profile "${profileName}" is disabled.`,
        remediation: [
          `Enable it explicitly in .specbridge/config.json (runnerProfiles.${profileName}.enabled = true).`,
        ],
      }),
      profile: profileName,
      requiredCapabilities: [...requirements.required],
      missingCapabilities: [],
      declaredCapabilities: profile.runner.declaredCapabilities,
    });
  }

  const support = checkOperationSupport(request.operation, profile.runner.declaredCapabilities);
  if (!support.supported) {
    const missing = [
      ...support.missingCapabilities,
      ...support.unsatisfiedBoundaries.flat(),
    ];
    return fail({
      error: runnerError({
        code: 'unsupported_operation',
        message: `Cannot perform ${request.operation} using "${profileName}": the ${profile.runner.name} runner lacks required capabilities.`,
        remediation: [`Missing capabilities: ${missing.join(', ')}.`],
      }),
      profile: profileName,
      requiredCapabilities: support.requiredCapabilities,
      missingCapabilities: missing,
      declaredCapabilities: profile.runner.declaredCapabilities,
    });
  }

  const transport = profileTransport(profile.config);
  if (transport.networkBacked) {
    if (!config.runnerPolicy.allowNetworkRunners) {
      return fail({
        error: runnerError({
          code: 'invalid_configuration',
          message: `Runner profile "${profileName}" is network-backed and runnerPolicy.allowNetworkRunners is false.`,
          remediation: ['Use a local profile, or allow network runners explicitly in the policy.'],
        }),
        profile: profileName,
        requiredCapabilities: support.requiredCapabilities,
        missingCapabilities: [],
        declaredCapabilities: profile.runner.declaredCapabilities,
      });
    }
    const explicitEnough = origin === 'explicit' || origin === 'operation-default';
    if (config.runnerPolicy.requireExplicitRunnerForNetworkAccess && !explicitEnough) {
      return fail({
        error: runnerError({
          code: 'invalid_configuration',
          message:
            `Runner profile "${profileName}" is network-backed (requests leave this machine) and is never selected implicitly.`,
          remediation: [
            `Select it explicitly with --runner ${profileName}, or set it as an operationDefaults entry.`,
          ],
        }),
        profile: profileName,
        requiredCapabilities: support.requiredCapabilities,
        missingCapabilities: [],
        declaredCapabilities: profile.runner.declaredCapabilities,
      });
    }
  }

  const supportLevel = declaredSupportLevel(profile);
  if ((supportLevel === 'preview' || supportLevel === 'experimental') && origin !== 'explicit') {
    return fail({
      error: runnerError({
        code: 'runner_incompatible',
        message: `Runner profile "${profileName}" is ${supportLevel} and is never selected automatically.`,
        remediation: [`Select it explicitly with --runner ${profileName} if you accept its limitations.`],
      }),
      profile: profileName,
      requiredCapabilities: support.requiredCapabilities,
      missingCapabilities: [],
      declaredCapabilities: profile.runner.declaredCapabilities,
    });
  }

  return {
    ok: true,
    plan: {
      profile: profileName,
      runner: profile.runner.name,
      category: profile.runner.category,
      supportLevel,
      operation: request.operation,
      origin,
      requiredCapabilities: support.requiredCapabilities,
      declaredCapabilities: profile.runner.declaredCapabilities,
      networkBacked: transport.networkBacked,
      localExecution: transport.localExecution,
      model: profileModel(profile.config),
      fallbackChain: fallbackChainFor(config, request.operation, profileName),
      constraints: constraintsFor(profile, request.operation),
      ...(transport.endpoint !== undefined ? { endpoint: transport.endpoint } : {}),
    },
  };
}

/**
 * Operations a profile supports (for listings): capability-driven, with the
 * method-based affordances (model listing, self test) requiring the actual
 * adapter method — model names are never guessed.
 */
export function profileOperations(profile: RegisteredRunnerProfile): RunnerOperation[] {
  return supportedOperations(profile.runner.declaredCapabilities).filter((operation) => {
    if (operation === 'model-list') return profile.runner.listModels !== undefined;
    if (operation === 'runner-test') return profile.runner.selfTest !== undefined;
    return true;
  });
}
