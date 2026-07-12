/**
 * Shared vocabulary for agent runners, task execution, and evidence.
 *
 * These types are deliberately in @specbridge/core so that runner
 * implementations, execution orchestration, evidence evaluation, and the CLI
 * all speak the same language without importing each other.
 */

/** Runner kinds shipped in v0.3. Unsupported runners are honest stubs. */
export const AGENT_RUNNER_KINDS = ['mock', 'claude-code', 'unsupported'] as const;
export type AgentRunnerKind = (typeof AGENT_RUNNER_KINDS)[number];

/**
 * Result of probing a runner. `available` is the only status that permits
 * execution; every other status must come with actionable diagnostics.
 */
export const RUNNER_STATUS_VALUES = [
  'available',
  'unavailable',
  'unauthenticated',
  'incompatible',
  'misconfigured',
  'error',
] as const;
export type RunnerStatus = (typeof RUNNER_STATUS_VALUES)[number];

/**
 * How one runner invocation ended. This describes the *process/agent*
 * outcome only — whether the task counts as done is decided later by
 * evidence evaluation, never by the runner.
 */
export const EXECUTION_OUTCOMES = [
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'timed-out',
  'permission-denied',
  'malformed-output',
  'no-change',
] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

/**
 * Evidence status of one task attempt. Only `verified` and
 * `manually-accepted` ever update a task checkbox.
 */
export const EVIDENCE_STATUS_VALUES = [
  'no-change',
  'implemented-unverified',
  'verified',
  'failed',
  'blocked',
  'cancelled',
  'timed-out',
  'manually-accepted',
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUS_VALUES)[number];

/** Kinds of runs recorded under `.specbridge/runs/<run-id>/`. */
export const RUN_KINDS = [
  'task-execution',
  'task-resume',
  'stage-generation',
  'stage-refinement',
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * Documented CLI exit codes. Codes 0–2 are the v0.1/v0.2 contract and keep
 * their exact meaning; 3–6 are added by v0.3 for runner execution.
 */
export const EXIT_CODES = {
  /** Command succeeded. */
  ok: 0,
  /** Workflow, analysis, verification, or quality-gate failure. */
  gateFailure: 1,
  /** Invalid input, invalid configuration, or runtime setup failure. */
  usageError: 2,
  /** Runner unavailable, unauthenticated, or incompatible. */
  runnerUnavailable: 3,
  /** Runner invocation started but failed (nonzero exit, malformed output). */
  runnerFailure: 4,
  /** Timeout or cancellation. */
  timeout: 5,
  /** Permission or safety policy failure (protected paths, denied tools). */
  safetyFailure: 6,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Map an execution outcome to the documented exit code. */
export function exitCodeForOutcome(outcome: ExecutionOutcome): ExitCode {
  switch (outcome) {
    case 'completed':
    case 'no-change':
      return EXIT_CODES.ok;
    case 'blocked':
      return EXIT_CODES.gateFailure;
    case 'failed':
    case 'malformed-output':
      return EXIT_CODES.runnerFailure;
    case 'cancelled':
    case 'timed-out':
      return EXIT_CODES.timeout;
    case 'permission-denied':
      return EXIT_CODES.safetyFailure;
  }
}
