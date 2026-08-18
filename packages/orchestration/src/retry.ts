import type { ClassifiedFailure } from './failure.js';
import type { OrchestrationBudgets, OrchestrationCounters } from './state.js';
import type { FailureCategory, NextStepDirective } from './vocabulary.js';

/**
 * The retry / repair / replan decision engine.
 *
 * One pure function decides what happens after every observation, from:
 * the failure category, the budgets, the counters, and the progress
 * assessment. Nothing here consults a model, and no caller may substitute its
 * own judgement — an agent asking to "try again" gets the same answer the CLI
 * would get.
 *
 * The rules this encodes, stated plainly:
 *   - only genuinely transient, idempotent failures are retried, and only
 *     within a bounded count with backoff
 *   - a failing verifier enters a bounded REPAIR cycle; it is never rerun
 *     unchanged in the hope of a different result
 *   - an implementation defect is repaired, never "retried"
 *   - ambiguity is clarified, never retried
 *   - authentication, permission, and safety failures are never auto-retried
 *   - cancellation is never auto-restarted
 *   - stagnation replans if a replan budget remains, otherwise blocks
 *   - an exhausted budget stops the run explicitly and preserves evidence
 */

export interface RetryDecisionInput {
  failure?: ClassifiedFailure | undefined;
  counters: OrchestrationCounters;
  budgets: OrchestrationBudgets;
  /** Elapsed wall-clock milliseconds since the run started. */
  elapsedMs: number;
  /** True when the no-progress bound is exceeded. */
  stagnated: boolean;
  /** True when the last observation advanced the world. */
  progressed: boolean;
  /** True when the host asserts the implementation is ready to verify. */
  readyToVerify?: boolean;
}

export interface RetryDecision {
  directive: NextStepDirective;
  /** Stable, safe explanation of why this directive was chosen. */
  reason: string;
  /** Backoff before a RETRY directive; 0 for every other directive. */
  backoffMs: number;
  /** Failure category that drove the decision, when there was a failure. */
  failureCategory?: FailureCategory;
  remediation: string[];
  /** Which budget was exhausted, when the directive is a budget stop. */
  exhaustedBudget?: string;
}

function budgetStop(
  budget: string,
  reason: string,
  remediation: string[],
): RetryDecision {
  return {
    directive: 'STOP_BUDGET_EXHAUSTED',
    reason,
    backoffMs: 0,
    failureCategory: 'BUDGET_EXHAUSTED',
    remediation,
    exhaustedBudget: budget,
  };
}

/** Exponential backoff, capped. Deterministic — no jitter, so tests are exact. */
export function backoffForAttempt(
  attempt: number,
  options: { baseBackoffMs: number; maxBackoffMs: number },
): number {
  if (attempt <= 0) return 0;
  const raw = options.baseBackoffMs * 2 ** (attempt - 1);
  return Math.min(raw, options.maxBackoffMs);
}

/**
 * Decide the next step. Evaluated in strict priority order so the outcome is
 * fully determined by the inputs.
 */
export function decideNextStep(
  input: RetryDecisionInput,
  backoff: { baseBackoffMs: number; maxBackoffMs: number },
): RetryDecision {
  const { counters, budgets, failure } = input;

  // 1. Cancellation is absolute and comes before every budget and retry rule.
  if (failure?.category === 'CANCELLED') {
    return {
      directive: 'STOP_FINAL',
      reason: 'The run was cancelled. Cancellation is never restarted automatically.',
      backoffMs: 0,
      failureCategory: 'CANCELLED',
      remediation: failure.policy.remediation,
    };
  }

  // 2. Terminal categories stop the run regardless of remaining budget.
  if (failure !== undefined && failure.policy.terminal) {
    return {
      directive: 'BLOCK',
      reason: `${failure.category} cannot be retried, repaired, or replanned automatically.`,
      backoffMs: 0,
      failureCategory: failure.category,
      remediation: failure.policy.remediation,
    };
  }

  // 3. Hard budgets. Checked before any continuation so an exhausted run can
  //    never take "one more" step.
  if (input.elapsedMs >= budgets.maxElapsedMs) {
    return budgetStop(
      'maxElapsedMs',
      `The run reached its ${budgets.maxElapsedMs}ms wall-clock budget.`,
      [
        'All evidence and source changes are preserved.',
        'Review the checkpoint, then start a new run if the work should continue.',
      ],
    );
  }
  if (counters.iterations >= budgets.maxIterations) {
    return budgetStop(
      'maxIterations',
      `The run reached its ${budgets.maxIterations}-iteration budget.`,
      [
        'All evidence and source changes are preserved; the task stays incomplete.',
        'Raise orchestration.execution.maxIterations explicitly, or change approach.',
      ],
    );
  }

  // 4. Ambiguity is never retried and never guessed past.
  if (failure?.category === 'AMBIGUITY') {
    if (counters.clarificationRounds >= budgets.maxClarificationRounds) {
      return budgetStop(
        'maxClarificationRounds',
        `The run used all ${budgets.maxClarificationRounds} clarification rounds and the request is still ambiguous.`,
        [
          'Resolve the ambiguity in the specification and re-approve the affected stage.',
        ],
      );
    }
    return {
      directive: 'CLARIFY',
      reason: 'The request is underspecified; a user decision is required before implementing.',
      backoffMs: 0,
      failureCategory: 'AMBIGUITY',
      remediation: failure.policy.remediation,
    };
  }

  // 5. Bounded transient retry — the only category that reruns the same thing.
  if (failure !== undefined && failure.policy.retryable) {
    if (counters.transientRetries >= budgets.maxTransientRetries) {
      return budgetStop(
        'maxTransientRetries',
        `The transient failure recurred after ${budgets.maxTransientRetries} bounded retries; it is not transient.`,
        ['Investigate the underlying tool or transport failure before continuing.'],
      );
    }
    return {
      directive: 'RETRY',
      reason: `${failure.category} is safely retryable; retrying the same idempotent operation.`,
      backoffMs: backoffForAttempt(counters.transientRetries + 1, backoff),
      failureCategory: failure.category,
      remediation: failure.policy.remediation,
    };
  }

  // 6. Stagnation: replan if a budget remains and replanning could help,
  //    otherwise block. Never "try harder".
  if (input.stagnated) {
    if (counters.replans < budgets.maxReplans) {
      return {
        directive: 'REPLAN',
        reason:
          'Repeated actions produced materially identical results; the current approach is not working.',
        backoffMs: 0,
        failureCategory: 'NO_PROGRESS',
        remediation: [
          'Replan with a different strategy against the observed evidence.',
          'If the blocker is a missing user decision, ask instead of replanning.',
        ],
      };
    }
    return budgetStop(
      'maxNoProgressCycles',
      `No progress after ${counters.consecutiveNoProgress} materially identical cycles, and the replan budget (${budgets.maxReplans}) is exhausted.`,
      [
        'All evidence and source changes are preserved; the task stays incomplete.',
        'Inspect the preserved failure evidence and decide the approach explicitly.',
      ],
    );
  }

  // 7. Verification failures and implementation defects enter bounded repair.
  if (failure !== undefined && failure.policy.repairable) {
    if (counters.repairCycles >= budgets.maxRepairCycles) {
      return budgetStop(
        'maxRepairCycles',
        `The repair budget of ${budgets.maxRepairCycles} cycle(s) is exhausted and verification still fails.`,
        [
          'The implementation changes and all failure evidence are preserved.',
          'The task stays incomplete: inspect the failing verifier and decide explicitly.',
        ],
      );
    }
    return {
      directive: 'REPAIR',
      reason:
        failure.category === 'VERIFICATION_FAILURE'
          ? 'A trusted verification command failed; repair the implementation against its output rather than rerunning it.'
          : 'The implementation is defective; repair it against the observed failure.',
      backoffMs: 0,
      failureCategory: failure.category,
      remediation: failure.policy.remediation,
    };
  }

  // 8. Failures that only replanning can address.
  if (failure !== undefined && failure.policy.replannable) {
    if (counters.replans >= budgets.maxReplans) {
      return budgetStop(
        'maxReplans',
        `${failure.category} requires replanning, but the replan budget of ${budgets.maxReplans} is exhausted.`,
        failure.policy.remediation,
      );
    }
    return {
      directive: 'REPLAN',
      reason: `${failure.category} invalidates the current plan.`,
      backoffMs: 0,
      failureCategory: failure.category,
      remediation: failure.policy.remediation,
    };
  }

  // 9. Failures that can only be clarified.
  if (failure !== undefined && failure.policy.clarifiable) {
    return {
      directive: 'CLARIFY',
      reason: `${failure.category} needs a user decision.`,
      backoffMs: 0,
      failureCategory: failure.category,
      remediation: failure.policy.remediation,
    };
  }

  // 10. Any remaining classified failure blocks rather than continuing.
  if (failure !== undefined) {
    return {
      directive: 'BLOCK',
      reason: `${failure.category} has no automatic recovery path.`,
      backoffMs: 0,
      failureCategory: failure.category,
      remediation: failure.policy.remediation,
    };
  }

  // 11. No failure: verify when asserted ready, otherwise keep going.
  if (input.readyToVerify === true) {
    return {
      directive: 'VERIFY',
      reason:
        'The implementation is asserted ready; trusted verification decides completion, not the assertion.',
      backoffMs: 0,
      remediation: [
        'Call task_complete: Git evidence and the configured verifiers decide the outcome.',
      ],
    };
  }
  return {
    directive: 'CONTINUE',
    reason: input.progressed
      ? 'The last action advanced the run; continue with the next plan step.'
      : 'Continue with the next plan step.',
    backoffMs: 0,
    remediation: [],
  };
}
