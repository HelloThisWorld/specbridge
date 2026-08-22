import type { EvaluationCheck, EvaluationResult, SemanticFinding } from './state.js';
import { EVALUATION_RESULT_SCHEMA_VERSION, evaluationResultSchema } from './state.js';
import type { EvaluationCheckLevel, EvaluationCheckOutcome, EvaluationStatus } from './vocabulary.js';
import { EVALUATION_CHECK_LEVEL_DEPTH, isIndeterminate } from './vocabulary.js';

/**
 * Unified execution evaluation: the single place that decides whether one
 * ExecutionAttempt's work is acceptable, on the same terms for every lane.
 *
 * The rule the whole module exists to enforce:
 *
 *   A model's completion claim is never completion evidence.
 *
 * A worker saying "done" is an input to this function, not an output of it,
 * and it carries exactly as much weight on the paid API lane as it does on a
 * local one. Stronger compute buys better implementations; it never buys
 * weaker evidence.
 *
 * Evaluation is deterministic-first and strictly ordered:
 *
 *   Level 0  EXECUTION_INTEGRITY   is this attempt trustworthy at all?
 *   Level 1  REPOSITORY_INTEGRITY  what does Git actually say changed?
 *   Level 2  BUILD_STATIC          compile / typecheck / lint / schema
 *   Level 3  TESTS                 unit / integration / regression / contract
 *   Level 4  ACCEPTANCE_CRITERIA   the approved contract's own criteria
 *   Level 5  SEMANTIC_REVIEW       bounded judgment, only where 0-4 cannot decide
 *
 * Level 0 comes first because everything above it is conditional on it. If
 * the attempt itself is not trustworthy — the worker was not the assigned
 * one, the baseline moved underneath it, a protected path was touched — then
 * its output is not evidence about the implementation, and evaluating that
 * output would be reasoning about a measurement taken with a broken
 * instrument.
 *
 * Three verdicts, and the third is not decoration:
 *
 *   FAIL          a required check failed on evidence we trust
 *   INCONCLUSIVE  a required check could not run at all
 *   PASS          everything required ran and passed
 *
 * The FAIL/INCONCLUSIVE split is what stops SpecBridge rewriting correct code
 * because the test runner was down.
 */

export interface ExecutionIntegrityInput {
  /** The attempt process ended normally rather than crashing or timing out. */
  terminatedNormally: boolean;
  /** The worker that ran is the one the scheduler assigned. */
  workerIdentityMatches: boolean;
  /** The workspace baseline the attempt started from is still valid. */
  baselineValid: boolean;
  /** The bound task fingerprint still matches the approved task. */
  taskFingerprintValid: boolean;
  /** Approved stage hashes stayed valid across the attempt. */
  approvalsStillValid: boolean;
  /** Protected paths the attempt modified. Any entry is a hard violation. */
  protectedPathViolations: readonly string[];
  /** Whether the runner's structured output parsed and validated. */
  reportValidated: boolean;
  /** Bounded detail for an abnormal termination, when there was one. */
  terminationDetail?: string | undefined;
}

export interface RepositoryIntegrityInput {
  /** Paths Git reports as changed. Never the agent's claimed list. */
  changedPaths: readonly string[];
  /** Paths whose authorship cannot be attributed to this attempt. */
  ambiguousPaths: readonly string[];
  /** True when HEAD moved during the attempt (runners must never commit). */
  headMoved: boolean;
  /** The task the attempt was bound to still exists with its recorded text. */
  taskStillExists: boolean;
  /**
   * Files the agent CLAIMED to change. Used only to record a discrepancy
   * against Git — never to decide anything. Git is the authority.
   */
  claimedChangedPaths?: readonly string[] | undefined;
  /** True when a change was required for this attempt to mean anything. */
  changeRequired: boolean;
}

/** One trusted verification command's result, as the verifier reported it. */
export interface VerificationCheckInput {
  name: string;
  required: boolean;
  passed: boolean;
  timedOut: boolean;
  /** True when the command could not be started at all. */
  unavailable?: boolean | undefined;
  durationMs?: number | null | undefined;
  detail?: string | undefined;
  /**
   * Explicit level override. Absent, the level is inferred from the command
   * name — which affects REPORTING only, never the verdict: a failed
   * required command fails the evaluation whichever level it is filed under.
   */
  level?: Extract<EvaluationCheckLevel, 'BUILD_STATIC' | 'TESTS'> | undefined;
}

export interface VerificationInput {
  /** At least one verification command is configured for this workspace. */
  configured: boolean;
  /** Verification was deliberately skipped (--no-verify). */
  skipped: boolean;
  /** Verification actually executed. */
  ran: boolean;
  commands: readonly VerificationCheckInput[];
}

/**
 * The bounded semantic reviewer's proposal.
 *
 * Structurally incapable of granting a pass on its own: this shape has
 * findings and a verdict, and `foldEvaluation` reads the verdict only after
 * every deterministic level has already passed. A reviewer that returns PASS
 * over failing tests changes nothing.
 */
export interface SemanticEvaluationInput {
  ran: boolean;
  /** The reviewer's proposal. Consulted only when deterministic levels pass. */
  verdict: 'PASS' | 'CONCERNS' | 'FAIL';
  findings: readonly SemanticFinding[];
  /** True when the review could not complete (unavailable worker, timeout). */
  unavailable?: boolean | undefined;
  detail?: string | undefined;
}

export interface EvaluateAttemptInput {
  evaluationId: string;
  jobId: string;
  nodeId: string;
  taskId: string;
  attemptId: string;
  lane?: string | null | undefined;
  createdAt: string;
  integrity: ExecutionIntegrityInput;
  repository: RepositoryIntegrityInput;
  verification: VerificationInput;
  /** Level 4 checks, already evaluated by `evaluateAcceptanceCriteria`. */
  criteriaChecks?: readonly EvaluationCheck[] | undefined;
  failedCriteria?: readonly string[] | undefined;
  uncheckedCriteria?: readonly string[] | undefined;
  semantic?: SemanticEvaluationInput | undefined;
  /** Normalized failure fingerprints observed for this attempt. */
  failureSignals?: readonly string[] | undefined;
  evidenceRefs?: readonly string[] | undefined;
}

/**
 * Infer which level a verification command belongs to from its name.
 *
 * Reporting only. A required command that fails, fails the evaluation
 * whichever level it lands in — this exists so `orchestrate explain` can say
 * "the build failed" rather than "a command failed", not to gate anything.
 */
function inferLevel(name: string): Extract<EvaluationCheckLevel, 'BUILD_STATIC' | 'TESTS'> {
  return /test|spec|e2e|integration|regression|contract/i.test(name) ? 'TESTS' : 'BUILD_STATIC';
}

function check(
  level: EvaluationCheckLevel,
  name: string,
  outcome: EvaluationCheckOutcome,
  options: { required?: boolean; detail?: string; evidenceRef?: string; durationMs?: number | null } = {},
): EvaluationCheck {
  return {
    level,
    name,
    outcome,
    required: options.required ?? true,
    ...(options.detail !== undefined ? { detail: options.detail.slice(0, 2_000) } : {}),
    ...(options.evidenceRef !== undefined ? { evidenceRef: options.evidenceRef } : {}),
    durationMs: options.durationMs ?? null,
  };
}

/** Level 0. Is the attempt itself trustworthy enough to judge its output? */
export function evaluateExecutionIntegrity(input: ExecutionIntegrityInput): EvaluationCheck[] {
  const checks: EvaluationCheck[] = [];
  checks.push(
    check(
      'EXECUTION_INTEGRITY',
      'attempt-terminated-normally',
      // An abnormal termination is not a failed implementation — nothing was
      // established either way — so it is INDETERMINATE, not FAILED.
      input.terminatedNormally ? 'PASSED' : 'UNAVAILABLE',
      input.terminatedNormally
        ? {}
        : { detail: input.terminationDetail ?? 'the attempt did not terminate normally' },
    ),
  );
  checks.push(
    check(
      'EXECUTION_INTEGRITY',
      'worker-identity',
      input.workerIdentityMatches ? 'PASSED' : 'FAILED',
      input.workerIdentityMatches ? {} : { detail: 'the attempt ran on a worker other than the assigned one' },
    ),
  );
  checks.push(
    check(
      'EXECUTION_INTEGRITY',
      'workspace-baseline',
      input.baselineValid ? 'PASSED' : 'FAILED',
      input.baselineValid ? {} : { detail: 'the workspace baseline this attempt started from is no longer valid' },
    ),
  );
  checks.push(
    check(
      'EXECUTION_INTEGRITY',
      'task-fingerprint',
      input.taskFingerprintValid ? 'PASSED' : 'FAILED',
      input.taskFingerprintValid ? {} : { detail: 'the approved task changed underneath this attempt' },
    ),
  );
  checks.push(
    check(
      'EXECUTION_INTEGRITY',
      'approvals-current',
      input.approvalsStillValid ? 'PASSED' : 'FAILED',
      input.approvalsStillValid ? {} : { detail: 'an approved spec stage changed during the attempt' },
    ),
  );
  checks.push(
    check(
      'EXECUTION_INTEGRITY',
      'protected-paths',
      input.protectedPathViolations.length === 0 ? 'PASSED' : 'FAILED',
      input.protectedPathViolations.length === 0
        ? {}
        : { detail: `protected path(s) modified: ${input.protectedPathViolations.slice(0, 10).join(', ')}` },
    ),
  );
  checks.push(
    check(
      'EXECUTION_INTEGRITY',
      'structured-output',
      input.reportValidated ? 'PASSED' : 'FAILED',
      // Advisory: a runner whose structured output did not validate has not
      // necessarily done bad work, and Git already tells us what changed.
      { required: false, ...(input.reportValidated ? {} : { detail: 'the structured runner output did not validate' }) },
    ),
  );
  return checks;
}

/** Level 1. What the repository actually says, independent of any claim. */
export function evaluateRepositoryIntegrity(input: RepositoryIntegrityInput): EvaluationCheck[] {
  const checks: EvaluationCheck[] = [];
  checks.push(
    check(
      'REPOSITORY_INTEGRITY',
      'head-stable',
      input.headMoved ? 'FAILED' : 'PASSED',
      input.headMoved ? { detail: 'HEAD moved during the attempt; runners must never commit' } : {},
    ),
  );
  checks.push(
    check(
      'REPOSITORY_INTEGRITY',
      'task-present',
      input.taskStillExists ? 'PASSED' : 'FAILED',
      input.taskStillExists ? {} : { detail: 'the selected task no longer exists with its recorded text' },
    ),
  );
  checks.push(
    check(
      'REPOSITORY_INTEGRITY',
      'change-attribution',
      input.ambiguousPaths.length === 0 ? 'PASSED' : 'FAILED',
      input.ambiguousPaths.length === 0
        ? {}
        : {
            detail: `changes to ${input.ambiguousPaths.slice(0, 5).join(', ')} cannot be attributed to this attempt`,
          },
    ),
  );
  const hasChanges = input.changedPaths.length > 0;
  checks.push(
    check(
      'REPOSITORY_INTEGRITY',
      'non-empty-change',
      !input.changeRequired || hasChanges ? 'PASSED' : 'FAILED',
      !input.changeRequired || hasChanges
        ? {}
        : { detail: 'the attempt reported success but the repository shows no change' },
    ),
  );
  // The agent's own list is recorded only where it CONTRADICTS Git, and it is
  // advisory: the discrepancy is worth seeing, but Git already decided.
  const claimed = input.claimedChangedPaths;
  if (claimed !== undefined && claimed.length > 0 && !hasChanges) {
    checks.push(
      check('REPOSITORY_INTEGRITY', 'claim-consistency', 'FAILED', {
        required: false,
        detail: `the attempt claimed ${claimed.length} changed file(s) but Git shows none`,
      }),
    );
  }
  return checks;
}

/** Levels 2 and 3, from the trusted verification commands only. */
export function evaluateVerification(input: VerificationInput): EvaluationCheck[] {
  if (!input.configured) {
    // Genuinely unknown, not passing. A workspace with no verifiers cannot
    // prove a task correct, and saying so is the honest verdict.
    return [
      check('BUILD_STATIC', 'verification-configured', 'UNAVAILABLE', {
        detail: 'no verification commands are configured; correctness cannot be established',
      }),
    ];
  }
  if (input.skipped) {
    return [
      check('BUILD_STATIC', 'verification-skipped', 'NOT_RUN', {
        detail: 'verification was skipped for this attempt',
      }),
    ];
  }
  if (!input.ran) {
    return [
      check('BUILD_STATIC', 'verification-ran', 'UNAVAILABLE', {
        detail: 'verification did not run',
      }),
    ];
  }
  return input.commands.map((command) =>
    check(
      command.level ?? inferLevel(command.name),
      command.name,
      command.timedOut
        ? 'TIMED_OUT'
        : command.unavailable === true
          ? 'UNAVAILABLE'
          : command.passed
            ? 'PASSED'
            : 'FAILED',
      {
        required: command.required,
        ...(command.detail !== undefined ? { detail: command.detail } : {}),
        evidenceRef: `verify:${command.name}`,
        durationMs: command.durationMs ?? null,
      },
    ),
  );
}

/**
 * Fold every level into one durable verdict.
 *
 * Strict priority, and the ordering IS the policy:
 *
 *   1. any required deterministic check FAILED         -> FAIL
 *   2. any required deterministic check INDETERMINATE  -> INCONCLUSIVE
 *   3. a semantic review returned blocking findings    -> FAIL
 *   4. otherwise                                       -> PASS
 *
 * Steps 1 and 2 run before step 3 and there is no path back. That is the
 * structural reason a semantic reviewer cannot rescue a failing build: by
 * the time its verdict is read, the deterministic answer has already been
 * returned. The reviewer can only ever make a passing task fail — which is
 * the direction where judgment is allowed to be conservative.
 */
export function evaluateAttempt(input: EvaluateAttemptInput): EvaluationResult {
  const deterministic: EvaluationCheck[] = [
    ...evaluateExecutionIntegrity(input.integrity),
    ...evaluateRepositoryIntegrity(input.repository),
    ...evaluateVerification(input.verification),
    ...(input.criteriaChecks ?? []),
  ].sort(
    (left, right) =>
      EVALUATION_CHECK_LEVEL_DEPTH[left.level] - EVALUATION_CHECK_LEVEL_DEPTH[right.level],
  );

  const reasons: string[] = [];
  const requiredFailed = deterministic.filter(
    (entry) => entry.required && entry.outcome === 'FAILED',
  );
  const requiredIndeterminate = deterministic.filter(
    (entry) => entry.required && isIndeterminate(entry.outcome),
  );

  let status: EvaluationStatus;
  if (requiredFailed.length > 0) {
    status = 'FAIL';
    for (const entry of requiredFailed.slice(0, 10)) {
      reasons.push(
        `${entry.level} check "${entry.name}" failed${entry.detail !== undefined ? `: ${entry.detail}` : ''}`,
      );
    }
  } else if (requiredIndeterminate.length > 0) {
    status = 'INCONCLUSIVE';
    for (const entry of requiredIndeterminate.slice(0, 10)) {
      reasons.push(
        `${entry.level} check "${entry.name}" could not produce a verdict (${entry.outcome})` +
          `${entry.detail !== undefined ? `: ${entry.detail}` : ''}`,
      );
    }
    reasons.push(
      'The implementation was not judged wrong: the evaluation itself could not reach a conclusion.',
    );
  } else {
    status = 'PASS';
  }

  // Level 5 is consulted ONLY on an otherwise-passing attempt. A reviewer
  // whose opinion could reach a failing one would be a model with authority
  // over evidence, which is the thing this whole subsystem forbids.
  const semanticChecks: EvaluationCheck[] = [];
  const semanticFindings: SemanticFinding[] = [];
  let semanticReviewRan = false;
  const semantic = input.semantic;
  if (semantic !== undefined && semantic.ran) {
    semanticFindings.push(...semantic.findings.slice(0, 40));
    if (status === 'PASS') {
      semanticReviewRan = true;
      const blocking = semantic.findings.filter((finding) => finding.severity === 'blocking');
      if (semantic.unavailable === true) {
        semanticChecks.push(
          check('SEMANTIC_REVIEW', 'semantic-review', 'UNAVAILABLE', {
            required: false,
            ...(semantic.detail !== undefined ? { detail: semantic.detail } : {}),
          }),
        );
        reasons.push('The bounded semantic review could not complete; deterministic evidence stands.');
      } else if (semantic.verdict === 'FAIL' || blocking.length > 0) {
        semanticChecks.push(
          check('SEMANTIC_REVIEW', 'semantic-review', 'FAILED', {
            detail:
              blocking.length > 0
                ? blocking.map((finding) => finding.observation).join('; ').slice(0, 1_500)
                : (semantic.detail ?? 'the reviewer judged the change unacceptable'),
          }),
        );
        status = 'FAIL';
        reasons.push(
          `Deterministic evidence passed, but the bounded semantic review raised ${Math.max(blocking.length, 1)} blocking finding(s).`,
        );
      } else {
        semanticChecks.push(
          check('SEMANTIC_REVIEW', 'semantic-review', 'PASSED', {
            required: false,
            ...(semantic.detail !== undefined ? { detail: semantic.detail } : {}),
          }),
        );
      }
    } else {
      // Recorded, explicitly inert. The audit trail should show that a
      // reviewer's opinion existed and did not count — the invariant is more
      // convincing when its exercise is visible.
      semanticChecks.push(
        check('SEMANTIC_REVIEW', 'semantic-review', 'NOT_RUN', {
          required: false,
          detail:
            `deterministic evaluation already returned ${status}; the semantic proposal ` +
            `(${semantic.verdict}) cannot override it`,
        }),
      );
    }
  }

  if (status === 'PASS') {
    const unchecked = input.uncheckedCriteria ?? [];
    reasons.push(
      `Every required deterministic check passed (${deterministic.filter((entry) => entry.outcome === 'PASSED').length} check(s)).`,
    );
    if (unchecked.length > 0) {
      reasons.push(
        `${unchecked.length} acceptance criterion/criteria have no machine-checkable form and were not verified deterministically: ${unchecked.slice(0, 8).join(', ')}.`,
      );
    }
  }

  return evaluationResultSchema.parse({
    schemaVersion: EVALUATION_RESULT_SCHEMA_VERSION,
    evaluationId: input.evaluationId,
    jobId: input.jobId,
    nodeId: input.nodeId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    lane: input.lane ?? null,
    status,
    deterministicChecks: deterministic.slice(0, 60),
    semanticChecks,
    semanticFindings,
    failedCriteria: [...(input.failedCriteria ?? [])].slice(0, 50),
    evidenceRefs: [...(input.evidenceRefs ?? [])].slice(0, 40),
    failureSignals: [...(input.failureSignals ?? [])].slice(0, 50),
    reasons: reasons.slice(0, 50).map((reason) => reason.slice(0, 2_000)),
    semanticReviewRan,
    createdAt: input.createdAt,
  });
}

/**
 * Whether a bounded semantic review is worth running for this attempt.
 *
 * Deterministic policy, evaluated BEFORE any reviewer is dispatched, because
 * review is not free: it consumes the same compute the implementation
 * competes for, and an evaluation layer that quietly becomes a paid-token
 * sink is its own kind of reliability failure.
 *
 * A review is worth running when deterministic evidence is genuinely
 * insufficient — unchecked criteria remain — or when the change touches
 * something whose blast radius justifies a second look. It is never worth
 * running when the deterministic layers already decided.
 */
export function semanticReviewWarranted(input: {
  mode: 'auto' | 'always' | 'disabled';
  deterministicStatus: EvaluationStatus;
  uncheckedCriteriaCount: number;
  /** True when the task is flagged high-risk (architecture, public API, security). */
  highRisk: boolean;
}): boolean {
  if (input.mode === 'disabled') return false;
  // Nothing to supplement: the deterministic layers already produced a
  // verdict, and a reviewer could only either agree or be ignored.
  if (input.deterministicStatus !== 'PASS') return false;
  if (input.mode === 'always') return true;
  return input.highRisk || input.uncheckedCriteriaCount > 0;
}
