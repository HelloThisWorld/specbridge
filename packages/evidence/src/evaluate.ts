import type { EvidenceStatus, ExecutionOutcome, TaskRunnerReport } from '@specbridge/core';
import type { SnapshotComparison } from './changed-files.js';
import { agentChangedFiles } from './changed-files.js';
import type { GitSnapshot } from './git-snapshot.js';
import type { VerificationRunResult } from './verification.js';

/**
 * Evidence evaluation: the single place that decides whether a task attempt
 * counts as verified.
 *
 * A model claim is never sufficient. `verified` requires ALL of:
 *   1. the runner completed successfully
 *   2. actual repository changes exist
 *   3. every change is attributable to the run (no ambiguous dirty files)
 *   4. no protected path changed and HEAD did not move
 *   5. verification ran and every required command passed
 *   6. the structured runner output validated
 *   7. approved spec hashes remained valid throughout
 *   8. the selected task still exists and its document was untouched
 *
 * Anything else degrades to an honest lesser status; nothing here ever
 * rolls changes back.
 */

export interface EvidenceEvaluationInput {
  runnerOutcome: ExecutionOutcome;
  /** True when the structured runner output parsed and validated. */
  reportValidated: boolean;
  report?: TaskRunnerReport;
  before: GitSnapshot;
  after: GitSnapshot;
  comparison: SnapshotComparison;
  verification: VerificationRunResult;
  /** Approved stage hashes re-checked after the run. */
  approvalsStillValid: boolean;
  /** The selected task still exists in tasks.md with its recorded text. */
  taskStillExists: boolean;
  /** `--allow-dirty` was used (adds a standing warning). */
  allowDirty: boolean;
}

export interface EvidenceEvaluation {
  status: EvidenceStatus;
  violations: string[];
  warnings: string[];
  /** Human-readable, ordered explanation of how the status was reached. */
  reasons: string[];
}

export function evaluateEvidence(input: EvidenceEvaluationInput): EvidenceEvaluation {
  const violations: string[] = [];
  const warnings: string[] = [...input.comparison.warnings];
  const reasons: string[] = [];

  if (input.allowDirty) {
    warnings.push(
      'The run started with a dirty working tree (--allow-dirty); pre-existing changes were baselined and are not attributed to the task.',
    );
  }

  for (const violation of input.comparison.protectedViolations) {
    violations.push(`protected path ${violation.kind}: ${violation.path}`);
  }
  if (input.comparison.headMoved) {
    violations.push(
      `HEAD moved during the run (${input.before.head ?? '(none)'} → ${input.after.head ?? '(none)'}); runners must never commit`,
    );
  }
  if (!input.approvalsStillValid) {
    violations.push('an approved spec stage changed during the run (stale approval)');
  }
  if (!input.taskStillExists) {
    violations.push('the selected task no longer exists in tasks.md with its recorded text');
  }

  // 1. Runner-level failures map directly; evidence stays for auditing.
  const outcomeStatus = statusForFailedOutcome(input.runnerOutcome);
  if (outcomeStatus !== undefined) {
    reasons.push(`the runner outcome was "${input.runnerOutcome}"`);
    return { status: outcomeStatus, violations, warnings, reasons };
  }

  const agentChanges = agentChangedFiles(input.comparison).filter(
    (file) => !input.comparison.ambiguousPaths.includes(file.path),
  );
  const ambiguous = input.comparison.ambiguousPaths;

  // 2. Safety violations: never verified, no automatic rollback.
  if (violations.length > 0) {
    reasons.push('safety violations prevent verification (see violations)');
    const status: EvidenceStatus =
      agentChanges.length > 0 || ambiguous.length > 0 ? 'implemented-unverified' : 'failed';
    return { status, violations, warnings, reasons };
  }

  // 3. Completed without any actual repository change: the claim alone
  //    proves nothing.
  if (agentChanges.length === 0 && ambiguous.length === 0) {
    reasons.push('the runner reported success but no repository change exists');
    if (input.report !== undefined && input.report.changedFiles.length > 0) {
      warnings.push(
        `the runner claimed ${input.report.changedFiles.length} changed file(s) but the repository shows none`,
      );
    }
    return { status: 'no-change', violations, warnings, reasons };
  }

  // 4. Ambiguous attribution can never verify automatically.
  if (ambiguous.length > 0) {
    reasons.push(
      `changes to ${ambiguous.join(', ')} cannot be attributed reliably (files were already modified before the run)`,
    );
    return { status: 'implemented-unverified', violations, warnings, reasons };
  }

  // 5. Structured output must have validated for automatic verification.
  if (!input.reportValidated) {
    reasons.push('the structured runner output did not validate');
    return { status: 'implemented-unverified', violations, warnings, reasons };
  }

  // 6. Verification gate.
  if (input.verification.skipped) {
    reasons.push('verification was skipped (--no-verify)');
    return { status: 'implemented-unverified', violations, warnings, reasons };
  }
  if (!input.verification.configured) {
    reasons.push('no verification commands are configured');
    warnings.push(
      'configure verification.commands in .specbridge/config.json so tasks can be verified deterministically',
    );
    return { status: 'implemented-unverified', violations, warnings, reasons };
  }
  if (!input.verification.passed) {
    reasons.push(
      `required verification failed: ${input.verification.requiredFailed.join(', ')}`,
    );
    return { status: 'implemented-unverified', violations, warnings, reasons };
  }
  for (const optional of input.verification.optionalFailed) {
    warnings.push(`optional verification command "${optional}" failed`);
  }

  reasons.push(
    `verified: ${agentChanges.length} attributable file change(s), ` +
      `${input.verification.commands.filter((c) => c.required && c.passed).length} required verification command(s) passed`,
  );
  return { status: 'verified', violations, warnings, reasons };
}

function statusForFailedOutcome(outcome: ExecutionOutcome): EvidenceStatus | undefined {
  switch (outcome) {
    case 'timed-out':
      return 'timed-out';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    case 'failed':
    case 'permission-denied':
    case 'malformed-output':
      return 'failed';
    case 'completed':
    case 'no-change':
      return undefined;
  }
}
