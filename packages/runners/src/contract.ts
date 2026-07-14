import type {
  AgentRunnerKind,
  Diagnostic,
  ExecutionOutcome,
  RunnerStatus,
  StageName,
  StageRunnerReport,
  TaskRunnerReport,
} from '@specbridge/core';
import type { RunnerCapabilitySet, RunnerCategory, RunnerSupportLevel } from './contracts/capabilities.js';
import type { NormalizedRunnerError } from './contracts/errors.js';
import type { NormalizedRunnerEvent } from './contracts/events.js';
import type { RunnerCost, RunnerUsage } from './contracts/usage.js';

/**
 * The model-agnostic runner contract (v0.3, extended by the frozen v0.6
 * capability layer in ./contracts/).
 *
 * A runner wraps one way of invoking an AI coding agent or authoring model.
 * Runners return structured observations only:
 *
 *   - they never update task checkboxes,
 *   - they never decide whether evidence is sufficient,
 *   - everything a model reports (`report`) is an unverified claim.
 *
 * Execution orchestration and evidence evaluation live in
 * @specbridge/execution and @specbridge/evidence.
 *
 * Safety requirements for every implementation:
 *   - build argument vectors as arrays; never concatenate a shell string
 *   - never pass a permission-bypass flag of any kind
 *   - never log secrets or environment variables
 *   - never execute commands suggested by model output
 *   - record executable, argv, duration, and exit status for auditability
 */

export interface RunnerDetectionContext {
  workspaceRoot: string;
  /** Probe optional capabilities too (slower; used by `runner doctor`). */
  probeCapabilities?: boolean;
  timeoutMs?: number;
}

/** IDs are stable so reports and tests can reference capabilities by name. */
export type RunnerCapabilityId =
  | 'non-interactive'
  | 'json-output'
  | 'structured-output'
  | 'session-id'
  | 'resume'
  | 'tool-restriction'
  | 'permission-modes'
  | 'max-turns'
  | 'max-budget';

/**
 * One detailed detection finding. `id` is stable per adapter; the
 * `RunnerCapabilityId` union covers the Claude Code probes, other adapters
 * add their own provider-specific probe ids. (The provider-independent
 * capability vocabulary is `RunnerCapabilityKey` in contracts/capabilities.)
 */
export interface RunnerCapability {
  id: RunnerCapabilityId | (string & {});
  label: string;
  available: boolean;
  /** Required capabilities gate task execution; optional ones degrade gracefully. */
  required: boolean;
  detail?: string;
}

export type RunnerAuthState =
  | 'authenticated'
  | 'unauthenticated'
  /** The runner exists but exposes no way to check (reported, not fatal). */
  | 'unknown'
  | 'not-applicable';

export interface RunnerDetectionResult {
  runner: string;
  kind: AgentRunnerKind;
  status: RunnerStatus;
  /** Resolved executable (config value; never shell-interpolated). */
  executable?: string;
  version?: string;
  authentication: RunnerAuthState;
  capabilities: RunnerCapability[];
  /** Actionable findings — a non-`available` status must explain itself here. */
  diagnostics: Diagnostic[];
  /** v0.6: runner category (agent-cli, model-api, mock, experimental). */
  category: RunnerCategory;
  /** v0.6: detected capability set (declared capabilities adjusted by probes). */
  capabilitySet: RunnerCapabilitySet;
  /** v0.6: effective support level after detection. */
  supportLevel: RunnerSupportLevel;
  /** v0.6: whether executing through this runner leaves the local machine. */
  networkBacked: boolean;
}

/** Everything a runner needs to execute one invocation. */
export interface RunnerExecutionOptions {
  workspaceRoot: string;
  /** Absolute run directory (`.specbridge/runs/<run-id>`); may hold temp files. */
  runDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** CLI-level overrides. Absent means "use the runner's configuration". */
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

/** Tool policy tiers. Runners map these to their own restriction mechanism. */
export type RunnerToolPolicy =
  /** Requirements/bugfix generation: Read/Glob/Grep only. */
  | 'read-only'
  /** Design/tasks generation: repository inspection, no source modification. */
  | 'inspect-only'
  /** Task execution: configured tool set (never permission bypass). */
  | 'implementation';

export interface StageGenerationInput {
  specName: string;
  stage: StageName;
  intent: 'generate' | 'refine';
  /** Fully assembled, versioned prompt (see @specbridge/execution prompts). */
  prompt: string;
  promptVersion: string;
  toolPolicy: RunnerToolPolicy;
  /**
   * v0.6: structured-output correction retry context. Set by orchestration
   * for AT MOST ONE retry after `structured_output_invalid`, and only for
   * adapters declaring `supportsStructuredOutputCorrection`.
   */
  correction?: {
    /** The previous invalid model output (retained for inspection). */
    previousOutput: string;
    /** Safe validation problem summary (never secrets). */
    problems: string;
  };
}

export interface TaskExecutionInput {
  specName: string;
  taskId: string;
  prompt: string;
  promptVersion: string;
  toolPolicy: 'implementation';
  /** Session ID the runner should adopt when it supports sessions. */
  sessionId?: string;
}

export interface TaskResumeInput {
  specName: string;
  taskId: string;
  /** Resume prompt: previous summary, current repo state, unresolved issues. */
  prompt: string;
  promptVersion: string;
  toolPolicy: 'implementation';
  /** The session to resume. */
  sessionId: string;
}

/** Audit record of one child-process invocation (absent for in-process runners). */
export interface ProcessObservation {
  executable: string;
  /** argv with sensitive values redacted; safe to store and print. */
  redactedArgv: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | undefined;
  signal: string | undefined;
  timedOut: boolean;
  cancelled: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface RunnerResultBase {
  runner: string;
  outcome: ExecutionOutcome;
  /** Present when the outcome is not `completed`/`no-change`. */
  failureReason?: string;
  /** Raw output, possibly truncated at the configured limits. Retained for audit. */
  rawStdout: string;
  rawStderr: string;
  process?: ProcessObservation;
  sessionId?: string;
  durationMs: number;
  warnings: string[];
  /** v0.6: normalized provider events (bounded; no reasoning content). */
  normalizedEvents?: NormalizedRunnerEvent[];
  /** v0.6: normalized error classification for non-completed outcomes. */
  error?: NormalizedRunnerError;
  /** v0.6: provider-reported usage, when available. */
  usage?: RunnerUsage;
  /** v0.6: provider-reported cost, when available (never computed from pricing). */
  cost?: RunnerCost;
  /**
   * v0.6: the raw model output that FAILED structured-output validation
   * (bounded; retained for inspection and for the correction retry). Never
   * applied to any file.
   */
  invalidStructuredOutput?: string;
}

export interface StageGenerationResult extends RunnerResultBase {
  /** Validated structured output. Present only when parsing succeeded. */
  report?: StageRunnerReport;
}

export interface TaskExecutionResult extends RunnerResultBase {
  /** Validated structured output — a *claim*, never evidence. */
  report?: TaskRunnerReport;
  /** True when this runner could resume this session later. */
  resumeSupported: boolean;
}

/** One locally available model (from a provider-supported listing command). */
export interface RunnerModelInfo {
  name: string;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  modifiedAt?: string;
  /** 'local' when the model runs on this machine; 'remote' when served elsewhere. */
  location?: 'local' | 'remote' | 'unknown';
}

export interface RunnerModelListResult {
  supported: boolean;
  models: RunnerModelInfo[];
  /** Why listing is unsupported/failed. Never guessed model names. */
  detail?: string;
}

/** Bounded structured-output self test (`runner test <profile> --network`). */
export interface RunnerSelfTestResult {
  ok: boolean;
  detail: string;
  usage?: RunnerUsage;
  process?: ProcessObservation;
}

export interface AgentRunner {
  readonly name: string;
  readonly kind: AgentRunnerKind;
  /** v0.6: runner category — agent-cli, model-api, mock, or experimental. */
  readonly category: RunnerCategory;
  /**
   * v0.6: capabilities this adapter implements when the provider is fully
   * available. Detection may downgrade individual capabilities (never add).
   */
  readonly declaredCapabilities: RunnerCapabilitySet;
  /**
   * v0.6: adapter opts into the bounded structured-output correction retry
   * for authoring operations (see StageGenerationInput.correction).
   */
  readonly supportsStructuredOutputCorrection?: boolean;
  /**
   * v0.6.1 (additive, optional — existing adapters are unaffected): the
   * support level the adapter itself declares. Absent means `production`
   * (the v0.6.0 behavior). `preview`/`experimental` adapters are never
   * selected automatically and can never be confirmed production by
   * conformance.
   */
  readonly declaredSupportLevel?: RunnerSupportLevel;

  detect(context: RunnerDetectionContext): Promise<RunnerDetectionResult>;

  generateStage(
    input: StageGenerationInput,
    execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult>;

  executeTask(
    input: TaskExecutionInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult>;

  resumeTask?(
    input: TaskResumeInput,
    execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult>;

  /**
   * v0.6: provider-supported model enumeration (`runner models`). Absent or
   * `supported: false` when the provider has no official local listing
   * mechanism — model names are never guessed and never probed by paid
   * inference.
   */
  listModels?(context: RunnerDetectionContext): Promise<RunnerModelListResult>;

  /**
   * v0.6: minimal bounded structured-output test (`runner test --network`).
   * Must not modify repository files and must not expose credentials.
   */
  selfTest?(execution: RunnerExecutionOptions): Promise<RunnerSelfTestResult>;

  /**
   * v0.6: one-line description of the safety boundary this runner applies
   * for the given tool policy — embedded in the shared prompt contract.
   */
  executionBoundaryNote?(policy: RunnerToolPolicy): string;
}
