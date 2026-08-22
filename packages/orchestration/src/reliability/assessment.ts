import type { ClassifiedFailure } from '../failure.js';
import { failurePolicy } from '../failure.js';
import type { FailureCategory } from '../vocabulary.js';
import type { ReliabilityObservation } from './state.js';
import type {
  AssessmentBasis,
  ExecutionHealth,
  FailureRecoverability,
  FailureScope,
  FailureSource,
  RecoveryAction,
  RunawaySignal,
} from './vocabulary.js';

/**
 * Cross-lane failure normalization.
 *
 * One structured assessment, whatever ran the attempt. The recovery planner
 * must never see a provider-shaped error — a llama.cpp socket reset, a Claude
 * CLI exit code, and a DeepSeek HTTP 429 are three spellings of "the runtime
 * was not available", and a control plane that branches on their differences
 * grows three retry policies that drift apart.
 *
 * The mapping this module performs, stated once:
 *
 *   FailureCategory  (what went wrong)     kept UNCHANGED from the existing
 *                                          stable taxonomy
 *   FailureSource    (whose fault it was)  added here, orthogonally
 *
 * Neither is derived from the other. A VERIFICATION_FAILURE is normally an
 * IMPLEMENTATION source — the code is wrong and the verifier caught it — but
 * the very same category with a crashed test runner is a
 * VERIFICATION_INFRASTRUCTURE source, and the two demand opposite responses:
 * repair the code, versus do not touch the code because nothing was proved.
 *
 * Provider-specific detail enters through ONE narrow door: the harness
 * failure kind that vNext.3/vNext.4 already normalize
 * (INFRASTRUCTURE / INTELLIGENCE / PREFLIGHT / CANCELLED). Nothing below
 * inspects a raw provider payload.
 */

/**
 * The already-normalized harness failure kind, re-declared structurally so
 * this module does not import a runtime that only some lanes have. Keeping
 * it a plain union rather than an import is deliberate: reliability policy
 * must not acquire a dependency on any particular execution backend.
 */
export type NormalizedHarnessFailureKind =
  | 'INFRASTRUCTURE'
  | 'INTELLIGENCE'
  | 'PREFLIGHT'
  | 'CANCELLED';

/**
 * Default source for each stable failure category.
 *
 * One table, consulted everywhere, exactly like the existing failure policy
 * table it sits beside. Where a category is genuinely ambiguous about its
 * source, the entry chooses the reading that is SAFEST to be wrong about:
 * an infrastructure guess costs a bounded retry, whereas an implementation
 * guess costs a rewrite of code that may have been correct.
 */
const CATEGORY_SOURCES: Readonly<Record<FailureCategory, FailureSource>> = Object.freeze({
  TRANSIENT_TRANSPORT: 'TRANSIENT',
  TRANSIENT_TOOL: 'TRANSIENT',
  // The default reading of a failing verifier is that the code is wrong;
  // `verificationInfrastructureBroken` overrides it with actual evidence.
  VERIFICATION_FAILURE: 'IMPLEMENTATION',
  IMPLEMENTATION_DEFECT: 'IMPLEMENTATION',
  AMBIGUITY: 'REQUIREMENT_CONTRACT',
  BLOCKED_DEPENDENCY: 'EXECUTION_INFRASTRUCTURE',
  CAPABILITY_UNAVAILABLE: 'EXECUTION_INFRASTRUCTURE',
  AUTHENTICATION: 'AUTHORIZATION',
  PERMISSION: 'AUTHORIZATION',
  SAFETY_POLICY: 'AUTHORIZATION',
  STALE_CONTEXT: 'CONTEXT',
  REPOSITORY_DIVERGED: 'REPOSITORY_STATE',
  PROTECTED_PATH: 'REPOSITORY_STATE',
  NO_PROGRESS: 'IMPLEMENTATION',
  BUDGET_EXHAUSTED: 'BUDGET',
  CANCELLED: 'UNKNOWN',
  INVALID_CONFIGURATION: 'EXECUTION_INFRASTRUCTURE',
  INTERNAL: 'EXECUTION_INFRASTRUCTURE',
});

/** Blast radius per category: what has to be re-examined, not merely reported. */
const CATEGORY_SCOPES: Readonly<Record<FailureCategory, FailureScope>> = Object.freeze({
  TRANSIENT_TRANSPORT: 'ATTEMPT',
  TRANSIENT_TOOL: 'ATTEMPT',
  VERIFICATION_FAILURE: 'TASK',
  IMPLEMENTATION_DEFECT: 'TASK',
  AMBIGUITY: 'TASK',
  BLOCKED_DEPENDENCY: 'TASK',
  CAPABILITY_UNAVAILABLE: 'JOB',
  AUTHENTICATION: 'JOB',
  PERMISSION: 'JOB',
  SAFETY_POLICY: 'JOB',
  STALE_CONTEXT: 'TASK',
  REPOSITORY_DIVERGED: 'WORKSPACE',
  PROTECTED_PATH: 'WORKSPACE',
  NO_PROGRESS: 'TASK',
  BUDGET_EXHAUSTED: 'JOB',
  CANCELLED: 'ATTEMPT',
  INVALID_CONFIGURATION: 'WORKSPACE',
  INTERNAL: 'ATTEMPT',
});

export interface FailureAssessmentInput {
  /** The failure as the existing classifier produced it. Never re-derived. */
  classified: ClassifiedFailure;
  /** Economic lane the attempt ran on, when one was assigned. */
  lane?: string | null | undefined;
  /** Normalized harness failure kind, when the runtime reported one. */
  harnessFailureKind?: NormalizedHarnessFailureKind | undefined;
  /** Working-tree identity that accompanied this failure. */
  diffFingerprint?: string | null | undefined;
  /** Bounded history for this task, oldest first, INCLUDING this attempt. */
  history: readonly ReliabilityObservation[];
  /** Deterministic health, already assessed. */
  health: ExecutionHealth;
  runawaySignals?: readonly RunawaySignal[];
  /**
   * True when the machinery that JUDGES the work is what broke — the test
   * runner could not start, a required verifier is missing, the integration
   * environment is unavailable. This is EVIDENCE, supplied by the evaluator,
   * not an inference: it flips the source away from IMPLEMENTATION because
   * nothing about the implementation was actually established.
   */
  verificationInfrastructureBroken?: boolean;
  /**
   * A DIAGNOSER's structured proposal, when one ran. Recorded and allowed to
   * refine the source ONLY where the deterministic evidence is genuinely
   * silent — a model may not overrule Git, an exit code, or a verifier.
   */
  proposedSource?: FailureSource | undefined;
  /**
   * vNext.7: OBSERVED evidence that the attempt failed for want of context.
   *
   * The whole point of this field is that it is not an inference. Each signal
   * is something SpecBridge watched happen — a worker's structured output
   * naming a repository artifact it was never given, a selected file whose
   * hash had already moved, a mandatory reference the budget dropped, a
   * direct model declining for want of repository access.
   *
   * Its effect is narrow and deliberate: it moves the SOURCE to CONTEXT,
   * which `permitsIntelligenceEscalation` already treats as a reason to fix
   * the context rather than to buy a bigger model. A local model that could
   * not find an implementation it was never shown has demonstrated nothing
   * about its own capability, and spending prepaid quota to ask it again is
   * the exact waste this phase exists to prevent.
   */
  contextInsufficiencySignals?: readonly string[] | undefined;
}

export interface AssessedFailure {
  category: FailureCategory;
  source: FailureSource;
  scope: FailureScope;
  recoverability: FailureRecoverability;
  basis: AssessmentBasis;
  fingerprint: string;
  diffFingerprint: string | null;
  repeatedCount: number;
  likelyCause: string;
  recommendedRecoveryClass: RecoveryAction | null;
  runawaySignals: RunawaySignal[];
}

/**
 * Normalize one failure into the structured assessment the recovery planner
 * consumes.
 *
 * Pure and total: every input produces an assessment, and an input the rules
 * cannot place lands on UNKNOWN with an ABSENT basis rather than on a
 * confident guess. "We do not know" is a legitimate, actionable answer here
 * — it routes to conservative recovery — whereas a fabricated source would
 * route confidently to the wrong one.
 */
export function assessFailure(input: FailureAssessmentInput): AssessedFailure {
  const category = input.classified.category;
  const runawaySignals = [...(input.runawaySignals ?? [])];

  let source: FailureSource = CATEGORY_SOURCES[category];
  let basis: AssessmentBasis = 'DETERMINISTIC_EVIDENCE';

  // 1. The harness already normalized WHY it failed. INFRASTRUCTURE from a
  //    runtime is a fact about the installation, and it outranks the
  //    category default — a crashed process proves nothing about the task.
  if (input.harnessFailureKind === 'INFRASTRUCTURE') {
    source = 'EXECUTION_INFRASTRUCTURE';
    basis = 'PROVIDER_SIGNAL';
  } else if (input.harnessFailureKind === 'PREFLIGHT') {
    source = 'REPOSITORY_STATE';
    basis = 'PROVIDER_SIGNAL';
  } else if (input.harnessFailureKind === 'CANCELLED') {
    source = 'UNKNOWN';
    basis = 'PROVIDER_SIGNAL';
  } else if (input.harnessFailureKind === 'INTELLIGENCE') {
    source = 'IMPLEMENTATION';
    basis = 'PROVIDER_SIGNAL';
  }

  // 2. Broken judging machinery outranks everything above. If the verifier
  //    could not run, the attempt's correctness was never established, so
  //    no source that blames the implementation is defensible.
  if (input.verificationInfrastructureBroken === true) {
    source = 'VERIFICATION_INFRASTRUCTURE';
    basis = 'DETERMINISTIC_EVIDENCE';
  }

  // 3. A RUNAWAY attempt is an execution-bounds failure in its own right,
  //    unless the bound it hit was context growth — that is a context
  //    problem, and rebuilding context is the response, not a bigger budget.
  if (runawaySignals.length > 0 && input.verificationInfrastructureBroken !== true) {
    source = runawaySignals.includes('CONTEXT_GROWTH') ? 'CONTEXT' : 'IMPLEMENTATION';
    basis = 'DETERMINISTIC_EVIDENCE';
  }

  // 4. Observed context insufficiency. Ranked here — below broken machinery
  //    and execution bounds, above any model proposal — because it is
  //    deterministic evidence about the PACKAGE rather than about the work.
  //    An attempt that was never shown the file it had to edit did not fail
  //    at implementation, and recording it as IMPLEMENTATION would route the
  //    task straight at a stronger model for a question it cannot answer.
  if (
    (input.contextInsufficiencySignals?.length ?? 0) > 0 &&
    input.verificationInfrastructureBroken !== true &&
    input.harnessFailureKind !== 'INFRASTRUCTURE' &&
    runawaySignals.length === 0
  ) {
    source = 'CONTEXT';
    basis = 'DETERMINISTIC_EVIDENCE';
  }

  // 5. A model proposal may refine only what the evidence leaves open.
  if (
    input.proposedSource !== undefined &&
    source === 'UNKNOWN' &&
    input.harnessFailureKind === undefined
  ) {
    source = input.proposedSource;
    basis = 'MODEL_DIAGNOSIS';
  }

  // Repetition is counted from durable attempt history, never from a claim.
  const fingerprint = input.classified.fingerprint;
  const repeatedCount = Math.max(
    1,
    input.history.filter((entry) => entry.failureFingerprint === fingerprint).length,
  );
  if (repeatedCount > 1 && basis === 'DETERMINISTIC_EVIDENCE') basis = 'ATTEMPT_HISTORY';

  const policy = failurePolicy(category);
  const recoverability = deriveRecoverability({
    category,
    source,
    health: input.health,
    terminal: policy.terminal,
    clarifiable: policy.clarifiable,
    repairable: policy.repairable,
    retryable: policy.retryable,
  });

  return {
    category,
    source,
    scope: CATEGORY_SCOPES[category],
    recoverability,
    basis,
    fingerprint,
    diffFingerprint: input.diffFingerprint ?? null,
    repeatedCount,
    likelyCause: describeCause({
      category,
      source,
      repeatedCount,
      health: input.health,
      message: input.classified.message,
    }),
    recommendedRecoveryClass: recommendRecoveryClass({ source, health: input.health, policy }),
    runawaySignals,
  };
}

function deriveRecoverability(input: {
  category: FailureCategory;
  source: FailureSource;
  health: ExecutionHealth;
  terminal: boolean;
  clarifiable: boolean;
  repairable: boolean;
  retryable: boolean;
}): FailureRecoverability {
  if (input.terminal) return 'TERMINAL';
  if (input.source === 'REQUIREMENT_CONTRACT' || input.clarifiable) return 'REQUIRES_HUMAN';
  // Stuck is stuck whatever the category says: repeating a strategy that
  // demonstrably produces the same result is not recovery, it is billing.
  if (input.health === 'STALLED' || input.health === 'OSCILLATING' || input.health === 'RUNAWAY') {
    return 'REQUIRES_NEW_STRATEGY';
  }
  if (input.retryable) return 'RECOVERABLE';
  if (input.repairable) return 'RECOVERABLE';
  return 'REQUIRES_NEW_STRATEGY';
}

/**
 * A HINT for the planner, which decides independently.
 *
 * Kept deliberately coarse. The planner has the budgets, the lane, the spend
 * policy, and the history; this function has none of them, and a hint that
 * pretended to more precision than its inputs support would invite callers
 * to treat it as the decision.
 */
function recommendRecoveryClass(input: {
  source: FailureSource;
  health: ExecutionHealth;
  policy: { terminal: boolean; repairable: boolean; retryable: boolean; clarifiable: boolean };
}): RecoveryAction | null {
  if (input.policy.terminal) return 'BLOCK';
  if (input.health === 'RUNAWAY') return 'RESTART_FRESH_CONTEXT';
  if (input.source === 'CONTEXT') return 'RESTART_FRESH_CONTEXT';
  if (input.source === 'REQUIREMENT_CONTRACT') return 'REQUEST_HUMAN_DECISION';
  if (input.source === 'BUDGET') return 'BLOCK';
  if (input.source === 'AUTHORIZATION') return 'REQUEST_HUMAN_DECISION';
  if (input.source === 'VERIFICATION_INFRASTRUCTURE') return 'RETRY_TRANSIENT';
  if (input.source === 'EXECUTION_INFRASTRUCTURE' || input.source === 'PROVIDER') {
    return 'RETRY_TRANSIENT';
  }
  if (input.source === 'TRANSIENT') return 'RETRY_TRANSIENT';
  if (input.health === 'STALLED' || input.health === 'OSCILLATING') return 'REPLAN';
  if (input.policy.repairable) return 'REPAIR';
  return null;
}

/**
 * A bounded, safe statement of the likely cause.
 *
 * Assembled from structured facts by SpecBridge, never copied from model
 * output. It exists so that a durable record reads as an explanation rather
 * than as an enum dump, and it is the only prose in the assessment.
 */
function describeCause(input: {
  category: FailureCategory;
  source: FailureSource;
  repeatedCount: number;
  health: ExecutionHealth;
  message: string;
}): string {
  const sourceClause: string = {
    IMPLEMENTATION: 'the implementation does not satisfy the trusted checks',
    REQUIREMENT_CONTRACT: 'the approved contract does not support what implementation requires',
    EXECUTION_INFRASTRUCTURE: 'the execution runtime failed, which says nothing about the task',
    PROVIDER: 'the model provider failed or refused the request',
    CONTEXT: 'the working context degraded past the point where the attempt could reason reliably',
    VERIFICATION_INFRASTRUCTURE:
      'the verification machinery failed, so the implementation was never actually judged',
    REPOSITORY_STATE: 'the repository is not in a state this attempt could build on',
    BUDGET: 'a configured budget refused further work',
    AUTHORIZATION: 'authorization refused the operation',
    TRANSIENT: 'a transient condition interrupted the attempt',
    UNKNOWN: 'the available evidence does not identify a cause',
  }[input.source];

  const repetition =
    input.repeatedCount > 1
      ? ` The same normalized failure has now occurred ${input.repeatedCount} times on this task.`
      : '';
  const healthClause =
    input.health === 'STALLED'
      ? ' Attempts are no longer producing new information.'
      : input.health === 'OSCILLATING'
        ? ' Attempts are alternating between states that have already failed.'
        : input.health === 'RUNAWAY'
          ? ' The attempt exceeded its own execution bounds and was stopped.'
          : '';

  return `${input.category}: ${sourceClause}.${repetition}${healthClause} ${input.message}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000);
}
