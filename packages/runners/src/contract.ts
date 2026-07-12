import type {
  AgentRunnerKind,
  Diagnostic,
  ExecutionOutcome,
  RunnerStatus,
  StageName,
  StageRunnerReport,
  TaskRunnerReport,
} from '@specbridge/core';

/**
 * The model-agnostic runner contract (v0.3).
 *
 * A runner wraps one way of invoking an AI coding agent. Runners return
 * structured observations only:
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

export interface RunnerCapability {
  id: RunnerCapabilityId;
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

export interface AgentRunner {
  readonly name: string;
  readonly kind: AgentRunnerKind;

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
}
