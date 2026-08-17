import { createHash } from 'node:crypto';
import type { FailureCategory } from './vocabulary.js';

/**
 * Failure classification and its policy consequences.
 *
 * One table, consulted everywhere. The point is that "can this be retried?"
 * is answered by a category, not by an agent's opinion — an agent saying
 * "let me try that again" is exactly the behaviour this milestone exists to
 * prevent.
 */

export interface FailurePolicy {
  category: FailureCategory;
  /** Whether a bounded automatic retry of the SAME operation is allowed. */
  retryable: boolean;
  /** Whether a repair cycle (fix the implementation) is the right response. */
  repairable: boolean;
  /** Whether replanning may address it. */
  replannable: boolean;
  /** Whether asking the user is the right response. */
  clarifiable: boolean;
  /** Whether the run must stop (no automatic continuation of any kind). */
  terminal: boolean;
  /** Safe, non-leaking default remediation. */
  remediation: string[];
}

const POLICIES: Readonly<Record<FailureCategory, Omit<FailurePolicy, 'category'>>> = Object.freeze({
  TRANSIENT_TRANSPORT: {
    retryable: true,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: false,
    remediation: ['Retry the same read-only operation within the configured transient budget.'],
  },
  TRANSIENT_TOOL: {
    retryable: true,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: false,
    remediation: ['Retry the same idempotent operation within the configured transient budget.'],
  },
  VERIFICATION_FAILURE: {
    // A failing verifier is information, not noise. Rerunning it unchanged
    // cannot make it pass; only a repair can.
    retryable: false,
    repairable: true,
    replannable: true,
    clarifiable: false,
    terminal: false,
    remediation: [
      'Read the failing verifier output, fix the implementation, then request verification again.',
    ],
  },
  IMPLEMENTATION_DEFECT: {
    retryable: false,
    repairable: true,
    replannable: true,
    clarifiable: false,
    terminal: false,
    remediation: ['Repair the implementation against the observed failure evidence.'],
  },
  AMBIGUITY: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: true,
    terminal: false,
    remediation: [
      'Ask the user the specific question whose answer changes the implementation.',
      'If the answer changes the specification, re-author and re-approve the affected stage.',
    ],
  },
  BLOCKED_DEPENDENCY: {
    retryable: false,
    repairable: false,
    replannable: true,
    clarifiable: true,
    terminal: false,
    remediation: ['Satisfy the missing dependency, then continue the run.'],
  },
  CAPABILITY_UNAVAILABLE: {
    retryable: false,
    repairable: false,
    replannable: true,
    clarifiable: false,
    terminal: false,
    remediation: [
      'Check runner capabilities with `specbridge runner doctor`.',
      'SpecBridge never switches provider automatically during implementation.',
    ],
  },
  AUTHENTICATION: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: true,
    remediation: [
      'Authenticate with the provider directly. SpecBridge never stores or replays credentials.',
    ],
  },
  PERMISSION: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: true,
    remediation: ['Grant the required permission explicitly, then start a new run.'],
  },
  SAFETY_POLICY: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: true,
    remediation: [
      'This boundary is not configurable away. Change the request so it stays inside it.',
    ],
  },
  STALE_CONTEXT: {
    retryable: false,
    repairable: false,
    replannable: true,
    clarifiable: false,
    terminal: false,
    remediation: [
      'Reconcile the changed spec/task state, then replan against the current context.',
    ],
  },
  REPOSITORY_DIVERGED: {
    retryable: false,
    repairable: false,
    replannable: true,
    clarifiable: false,
    terminal: false,
    remediation: [
      'Inspect the repository state that changed under the run, then replan or start a fresh run.',
    ],
  },
  PROTECTED_PATH: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: true,
    remediation: [
      'Revert the modification to the protected path. Protected paths are never negotiable.',
    ],
  },
  NO_PROGRESS: {
    retryable: false,
    repairable: false,
    replannable: true,
    clarifiable: true,
    terminal: false,
    remediation: [
      'The same approach is producing the same result. Replan, or ask the user for the missing decision.',
    ],
  },
  BUDGET_EXHAUSTED: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: true,
    remediation: [
      'Review the preserved evidence and decide explicitly whether to raise the budget or change approach.',
    ],
  },
  CANCELLED: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: true,
    remediation: ['Cancellation is never restarted automatically. Start a new run when ready.'],
  },
  INVALID_CONFIGURATION: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: true,
    remediation: ['Fix `.specbridge/config.json`, then run `specbridge doctor`.'],
  },
  INTERNAL: {
    retryable: false,
    repairable: false,
    replannable: false,
    clarifiable: false,
    terminal: true,
    remediation: ['Report the failure with the run id; the evidence directory is preserved.'],
  },
});

export function failurePolicy(category: FailureCategory): FailurePolicy {
  return { category, ...POLICIES[category] };
}

/** One observed failure, as recorded by orchestration. */
export interface ClassifiedFailure {
  category: FailureCategory;
  /** Safe, bounded message. Never a raw exception or stack. */
  message: string;
  /** Deterministic identity of the failure, for no-progress detection. */
  fingerprint: string;
  policy: FailurePolicy;
  details?: Record<string, unknown>;
}

/**
 * Normalize verifier/tool output into a stable failure fingerprint.
 *
 * Deterministic by construction: volatile substrings that change on every run
 * (absolute paths, timings, pids, hex ids, line/column noise, ANSI codes) are
 * masked before hashing, so "the same failure" hashes the same across
 * machines and repeat runs, and a genuinely different failure does not.
 *
 * This is deliberately NOT natural-language similarity: it is a byte-level
 * normalization with an explicit, auditable mask list.
 */
export function normalizeFailureOutput(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex -- ANSI SGR sequences in tool output
    .replace(/\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r\n/g, '\n')
    // Windows and POSIX absolute paths.
    .replace(/[A-Za-z]:\\[^\s:"']*/g, '<PATH>')
    .replace(/(?<![\w-])\/(?:[\w.-]+\/)+[\w.-]+/g, '<PATH>')
    // Durations, timestamps, pids, hex ids, and numeric noise.
    .replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds|m|min)\b/gi, '<DURATION>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TIMESTAMP>')
    .replace(/\b(pid|PID)[=: ]+\d+/g, 'pid=<PID>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<HEX>')
    .replace(/:\d+:\d+/g, ':<LINE>:<COL>')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

export interface FailureFingerprintInput {
  category: FailureCategory;
  /** Identity of the thing that failed (verifier name, tool, step id). */
  source: string;
  /** Process exit code when there was one. */
  exitCode?: number | undefined;
  /** Raw output; normalized before hashing. */
  output?: string | undefined;
}

/**
 * Stable identity of a failure: category + source + exit code + normalized
 * output. Two repair attempts that end in the same fingerprint made no
 * progress, whatever the agent says about them.
 */
export function failureFingerprint(input: FailureFingerprintInput): string {
  const normalized = input.output !== undefined ? normalizeFailureOutput(input.output) : '';
  // Bound the hashed slice so a pathological megabyte of output cannot make
  // fingerprinting itself expensive.
  const bounded = normalized.slice(0, 16_384);
  const canonical = [
    input.category,
    input.source,
    input.exitCode === undefined ? 'no-exit-code' : String(input.exitCode),
    bounded,
  ].join(' ');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function classifyFailure(input: {
  category: FailureCategory;
  message: string;
  source: string;
  exitCode?: number | undefined;
  output?: string | undefined;
  details?: Record<string, unknown>;
}): ClassifiedFailure {
  return {
    category: input.category,
    message: input.message,
    fingerprint: failureFingerprint({
      category: input.category,
      source: input.source,
      exitCode: input.exitCode,
      output: input.output,
    }),
    policy: failurePolicy(input.category),
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}
