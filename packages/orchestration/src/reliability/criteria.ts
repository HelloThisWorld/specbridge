import type { EvaluationCheck } from './state.js';
import type { AcceptanceCriterionCheckKind } from './vocabulary.js';

/**
 * Deterministic acceptance-criteria evaluation.
 *
 * A task is not complete because its tests pass. Tests encode what someone
 * remembered to assert; the TaskContract's acceptance criteria encode what
 * was actually approved. Code that compiles, passes every test, and violates
 * the approved intent is a FAILED task, and this module is what makes that
 * verdict deterministic rather than a matter of opinion.
 *
 * Every check here answers its question from bytes: repository paths, the
 * added lines of the candidate diff, and the trusted verifiers' own results.
 * Nothing consults a model. A criterion whose truth genuinely cannot be
 * established this way is reported NOT_RUN and routed to the bounded
 * semantic reviewer — it is never quietly assumed to hold, because a
 * criterion nobody checked is exactly the one that silently regresses.
 *
 * The check kinds are deliberately few. A richer expression language would
 * be a place for approved intent to drift into executable configuration that
 * nobody reviews; the closed set in ACCEPTANCE_CRITERION_CHECK_KINDS covers
 * the criteria that can honestly be machine-checked, and the rest are
 * honestly marked unchecked.
 */

/** One acceptance criterion as the durable task contract carries it. */
export interface AcceptanceCriterion {
  /** Stable identifier, used in failedCriteria and in recovery records. */
  id: string;
  /** The criterion as approved, verbatim and bounded. Data, never instructions. */
  text: string;
  /**
   * The machine-checkable form, when the criterion has one. Absent means the
   * criterion is real but not structurally checkable — it becomes NOT_RUN at
   * Level 4 and semantic-review input, never an assumed pass.
   */
  check?: AcceptanceCriterionCheck | undefined;
}

export interface AcceptanceCriterionCheck {
  kind: AcceptanceCriterionCheckKind;
  /**
   * Repository path (for path checks), regular expression source (for
   * pattern checks), or verifier name (for verifier checks).
   */
  value: string;
  /** Restrict a pattern check to paths matching this prefix, when given. */
  pathPrefix?: string | undefined;
}

/** The deterministic facts a criterion check is evaluated against. */
export interface CriteriaEvidence {
  /** Repository-relative paths that exist in the tree after the attempt. */
  existingPaths: ReadonlySet<string>;
  /** Paths the attempt changed, as Git reports them (never as claimed). */
  changedPaths: readonly string[];
  /** Added lines of the candidate diff, already stripped of their markers. */
  addedLines: readonly string[];
  /** Verifier name to whether it passed. Absent means it did not run. */
  verifierResults: ReadonlyMap<string, boolean>;
}

export interface CriteriaEvaluation {
  checks: EvaluationCheck[];
  failedCriteria: string[];
  /** Criteria that carry no machine-checkable form. */
  uncheckedCriteria: string[];
}

/**
 * Evaluate every criterion structurally.
 *
 * Pure and total. Each criterion produces exactly one check, so the record
 * shows what was verified AND what was not — the second half being the part
 * that makes an INCONCLUSIVE verdict possible instead of a false PASS.
 */
export function evaluateAcceptanceCriteria(
  criteria: readonly AcceptanceCriterion[],
  evidence: CriteriaEvidence,
): CriteriaEvaluation {
  const checks: EvaluationCheck[] = [];
  const failedCriteria: string[] = [];
  const uncheckedCriteria: string[] = [];

  for (const criterion of criteria) {
    if (criterion.check === undefined) {
      uncheckedCriteria.push(criterion.id);
      // Recorded as NOT_RUN and NOT required. A criterion with no structural
      // form cannot be established from bytes, and treating it as required
      // would make every task with prose criteria permanently INCONCLUSIVE.
      // It stays visible in `uncheckedCriteria`, is reported by the CLI, and
      // becomes semantic-review input — what it never becomes is a silent
      // pass that nobody can see was never checked.
      checks.push({
        level: 'ACCEPTANCE_CRITERIA',
        name: criterion.id,
        outcome: 'NOT_RUN',
        required: false,
        detail: `No machine-checkable form: "${criterion.text.slice(0, 160)}"`,
        durationMs: null,
      });
      continue;
    }
    const outcome = runCriterionCheck(criterion.check, evidence);
    if (outcome.outcome === 'FAILED') failedCriteria.push(criterion.id);
    if (outcome.outcome === 'UNAVAILABLE' || outcome.outcome === 'NOT_RUN') {
      uncheckedCriteria.push(criterion.id);
    }
    checks.push({
      level: 'ACCEPTANCE_CRITERIA',
      name: criterion.id,
      outcome: outcome.outcome,
      required: true,
      ...(outcome.detail !== undefined ? { detail: outcome.detail.slice(0, 2_000) } : {}),
      evidenceRef: `criterion:${criterion.id}`,
      durationMs: null,
    });
  }

  return { checks, failedCriteria, uncheckedCriteria };
}

function runCriterionCheck(
  check: AcceptanceCriterionCheck,
  evidence: CriteriaEvidence,
): { outcome: EvaluationCheck['outcome']; detail?: string } {
  switch (check.kind) {
    case 'path-exists': {
      const present = evidence.existingPaths.has(normalizePath(check.value));
      return present
        ? { outcome: 'PASSED', detail: `${check.value} exists` }
        : { outcome: 'FAILED', detail: `${check.value} does not exist` };
    }
    case 'path-absent': {
      const present = evidence.existingPaths.has(normalizePath(check.value));
      return present
        ? { outcome: 'FAILED', detail: `${check.value} still exists` }
        : { outcome: 'PASSED', detail: `${check.value} is absent` };
    }
    case 'pattern-present':
    case 'pattern-absent': {
      let regex: RegExp;
      try {
        regex = new RegExp(check.value);
      } catch {
        // An unparseable pattern is inert rather than fatal, exactly as the
        // contract guard patterns are: a malformed criterion must not be
        // able to fail a task by accident, and NOT_RUN keeps it visible.
        return { outcome: 'NOT_RUN', detail: `criterion pattern is not a valid expression` };
      }
      const lines = evidence.addedLines;
      const matched = lines.some((line) => regex.test(line));
      if (check.kind === 'pattern-present') {
        return matched
          ? { outcome: 'PASSED', detail: 'the required pattern appears in the added lines' }
          : { outcome: 'FAILED', detail: 'the required pattern does not appear in the added lines' };
      }
      return matched
        ? { outcome: 'FAILED', detail: 'a forbidden pattern appears in the added lines' }
        : { outcome: 'PASSED', detail: 'the forbidden pattern does not appear' };
    }
    case 'changed-within': {
      const prefix = normalizePath(check.value);
      const outside = evidence.changedPaths.filter(
        (path) => !normalizePath(path).startsWith(prefix),
      );
      return outside.length === 0
        ? { outcome: 'PASSED', detail: `every change is inside ${check.value}` }
        : {
            outcome: 'FAILED',
            detail: `${outside.length} change(s) outside ${check.value}: ${outside.slice(0, 5).join(', ')}`,
          };
    }
    case 'verifier-passed': {
      const result = evidence.verifierResults.get(check.value);
      if (result === undefined) {
        // The verifier this criterion depends on never ran. That is not a
        // failing implementation — it is an unproven criterion, and saying so
        // is what keeps INCONCLUSIVE distinguishable from FAIL.
        return { outcome: 'UNAVAILABLE', detail: `verifier "${check.value}" did not run` };
      }
      return result
        ? { outcome: 'PASSED', detail: `verifier "${check.value}" passed` }
        : { outcome: 'FAILED', detail: `verifier "${check.value}" failed` };
    }
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
