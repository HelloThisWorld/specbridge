import type { ReliabilityPolicy, WorkspaceInfo } from '@specbridge/core';
import type { ClassifiedFailure } from '../failure.js';
import type { JobBudgets, JobCounters, JobNode } from '../jobs/state.js';
import type { JobEventType } from '../jobs/vocabulary.js';
import type { AssessedFailure, NormalizedHarnessFailureKind } from './assessment.js';
import { assessFailure } from './assessment.js';
import type { ApiBudgetPosition, BudgetView, LocalAttemptBudget } from './budget.js';
import { buildBudgetView, snapshotBudget } from './budget.js';
import type { AttemptActivity } from './health.js';
import { appendObservation, assessHealth, detectRunaway, strategyKey } from './health.js';
import type { RecoveryPlan, RecoveryResource } from './recovery.js';
import { planRecovery } from './recovery.js';
import { evaluateRuntimeResearchTrigger } from '../research/runtime.js';
import type { RuntimeResearchTriggerResult } from '../research/runtime.js';
import {
  FAILURE_ASSESSMENT_SCHEMA_VERSION,
  RECOVERY_DECISION_SCHEMA_VERSION,
  RELIABILITY_LIMITS,
  failureAssessmentSchema,
  recoveryDecisionSchema,
} from './state.js';
import type {
  EvaluationResult,
  FailureAssessment,
  RecoveryDecision,
  ReliabilityObservation,
  TaskReliabilityState,
} from './state.js';
import {
  requireTaskReliabilityState,
  writeEvaluationResult,
  writeFailureAssessment,
  writeRecoveryDecision,
  writeTaskReliabilityState,
} from './store.js';
import type { ExecutionHealth, RecoveryAction } from './vocabulary.js';

/**
 * The reliability service: one entry point that turns a finished attempt
 * into a durable verdict, a durable assessment, and a durable decision.
 *
 * The order of operations is the whole contract, and it is the same on every
 * lane:
 *
 *   evaluate  ->  assess  ->  detect loops  ->  check budget  ->  decide
 *                                                                  |
 *                                                            checkpoint
 *                                                                  |
 *                                                            next attempt
 *
 * Nothing may skip a step. In particular there is no path from "attempt
 * failed" to "run it again" that does not pass through a structured failure
 * assessment first — that is what "no retry without a reasoned failure
 * classification" means operationally, and the reason this function returns
 * a decision rather than exposing the individual pieces for callers to
 * assemble in whatever order suited them.
 *
 * Every record is persisted BEFORE the decision is returned, so a crash
 * between deciding and acting leaves the reasoning on disk. A restarted
 * process then continues from a recorded decision instead of inventing a
 * fresh, different, unexplained transition.
 */

export interface ReliabilityDeps {
  workspace: WorkspaceInfo;
  policy: ReliabilityPolicy;
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
  /** Emits a job event. Injected so this module never imports the job service. */
  recordEvent?: ((type: JobEventType, payload: Record<string, unknown>) => void) | undefined;
}

function now(deps: ReliabilityDeps): Date {
  return (deps.clock ?? (() => new Date()))();
}

function newId(deps: ReliabilityDeps, prefix: string): string {
  const raw = (deps.idFactory ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`))();
  return `${prefix}-${raw}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
}

function emit(
  deps: ReliabilityDeps,
  type: JobEventType,
  payload: Record<string, unknown>,
): void {
  deps.recordEvent?.(type, payload);
}

// ---------------------------------------------------------------------------
// Evaluation recording
// ---------------------------------------------------------------------------

/**
 * Persist an evaluation verdict and announce it.
 *
 * Called for every finished attempt, including passing ones: "why did we
 * believe this task was done?" is a question that gets asked long after the
 * run, and only a durable PASS record can answer it.
 */
export function recordEvaluation(
  deps: ReliabilityDeps,
  result: EvaluationResult,
): EvaluationResult {
  const stored = writeEvaluationResult(deps.workspace, result, {
    maxRecords: deps.policy.maxRecordsPerJob,
  });
  emit(
    deps,
    stored.status === 'PASS'
      ? 'evaluation_passed'
      : stored.status === 'FAIL'
        ? 'evaluation_failed'
        : 'evaluation_inconclusive',
    {
      nodeId: stored.nodeId,
      taskId: stored.taskId,
      attemptId: stored.attemptId,
      evaluationId: stored.evaluationId,
      status: stored.status,
      lane: stored.lane,
      failedChecks: stored.deterministicChecks
        .filter((entry) => entry.required && entry.outcome !== 'PASSED')
        .map((entry) => `${entry.level}:${entry.name}:${entry.outcome}`)
        .slice(0, 12),
      failedCriteria: stored.failedCriteria.slice(0, 12),
      semanticReviewRan: stored.semanticReviewRan,
    },
  );
  if (stored.semanticReviewRan) {
    emit(deps, 'semantic_review_completed', {
      nodeId: stored.nodeId,
      taskId: stored.taskId,
      attemptId: stored.attemptId,
      findings: stored.semanticFindings.length,
      blocking: stored.semanticFindings.filter((finding) => finding.severity === 'blocking').length,
    });
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Governed failure handling
// ---------------------------------------------------------------------------

export interface GovernFailureInput {
  jobId: string;
  nodeId: string;
  taskId: string;
  attemptId: string;
  attemptNumber: number;
  /** The failure as the existing classifier produced it. Never re-derived. */
  classified: ClassifiedFailure;
  evaluation?: EvaluationResult | undefined;
  lane?: string | null | undefined;
  executionMode?: string | null | undefined;
  planRevision: number;
  planValid?: boolean | undefined;
  diffFingerprint?: string | null | undefined;
  harnessFailureKind?: NormalizedHarnessFailureKind | undefined;
  /** Observed activity of the attempt; nulls stay unknown, never zero. */
  activity: AttemptActivity;
  /** Durable budget inputs, read from their owners. */
  budgets: JobBudgets;
  counters: JobCounters;
  node: Pick<JobNode, 'attempts' | 'repairCycles' | 'replans' | 'consecutiveNoProgress'>;
  executorAttempts: number;
  elapsedMs?: number | null | undefined;
  local?: LocalAttemptBudget | undefined;
  api?: ApiBudgetPosition | undefined;
  resource: RecoveryResource;
  contextRatio?: number | null | undefined;
  evidenceRefs?: readonly string[] | undefined;
  /** A DIAGNOSER's structured proposal, when one ran. A claim, not authority. */
  proposedSource?: AssessedFailure['source'] | undefined;
  /**
   * vNext.7: OBSERVED evidence that the package was insufficient, from
   * `assessContextMiss`. Empty (or absent) is the normal case, and it leaves
   * assessment and recovery byte-identical to vNext.6.
   */
  contextInsufficiencySignals?: readonly string[] | undefined;
  /**
   * vNext.7: whether bounded context widening is on offer, from
   * `offerContextExpansion`. An OFFER: the planner still decides, and a hard
   * boundary, an exhausted budget, or broken verification all outrank it.
   */
  contextExpansion?:
    | { available: boolean; nextLevel: string; reason: string; exhausted: boolean }
    | undefined;
}

export interface GovernedFailure {
  assessment: FailureAssessment;
  decision: RecoveryDecision;
  health: ExecutionHealth;
  budget: BudgetView;
  state: TaskReliabilityState;
  /** The action, hoisted for callers that only branch on it. */
  action: RecoveryAction;
  /** Evidence-only signal consumed by REPLAN; never a recovery action itself. */
  researchEligibility?: RuntimeResearchTriggerResult | undefined;
}

/**
 * Turn a failed attempt into a durable assessment and a durable decision.
 *
 * The one function every lane's failure path goes through. A caller that
 * wanted to "just retry" would have to not call it, which is exactly the
 * kind of omission a code review can see.
 */
export function governFailedAttempt(
  deps: ReliabilityDeps,
  input: GovernFailureInput,
): GovernedFailure {
  const at = now(deps).toISOString();
  const previous = requireTaskReliabilityState(
    deps.workspace,
    input.jobId,
    input.nodeId,
    input.taskId,
    at,
  );

  // 1. Was the attempt itself out of control? Checked against the PRIOR
  //    window, before this attempt joins it.
  const runawaySignals = detectRunaway(
    input.activity,
    {
      maxToolCallsPerAttempt: deps.policy.maxToolCallsPerAttempt,
      maxCommandRunsPerAttempt: deps.policy.maxCommandRunsPerAttempt,
      maxAttemptWallTimeMs: deps.policy.maxAttemptWallTimeMs,
      maxContextUsageRatio: deps.policy.maxContextUsageRatio,
      maxTestLoopsPerAttempt: deps.policy.maxTestLoopsPerAttempt,
    },
    previous.observations,
  );

  // 2. Fold this attempt into the bounded window.
  const observation: ReliabilityObservation = {
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    failureFingerprint: input.classified.fingerprint,
    diffFingerprint: input.diffFingerprint ?? null,
    strategyKey: strategyKey({
      lane: input.lane ?? null,
      executionMode: input.executionMode ?? null,
      planRevision: input.planRevision,
      freshContext: false,
    }),
    evaluationStatus: input.evaluation?.status ?? null,
    lane: input.lane ?? null,
    at,
  };
  const window = appendObservation(
    previous,
    observation,
    RELIABILITY_LIMITS.maxFingerprintHistory,
  );

  // 3. Deterministic health over the window.
  const healthAssessment = assessHealth({
    window,
    thresholds: {
      sameFailureThreshold: deps.policy.sameFailureThreshold,
      // The same-diff bound is the EXISTING no-progress budget, read from
      // its owner rather than duplicated under a reliability-specific name.
      sameDiffThreshold: input.budgets.maxNoProgressCycles,
      oscillationThreshold: deps.policy.oscillationThreshold,
    },
    runawaySignals,
    passed: false,
  });

  if (healthAssessment.health === 'RUNAWAY') {
    emit(deps, 'execution_runaway', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      signals: healthAssessment.runawaySignals,
      lane: input.lane ?? null,
      detail: healthAssessment.reasons[0]?.slice(0, 300) ?? 'the attempt exceeded its bounds',
    });
  } else if (healthAssessment.health === 'OSCILLATING') {
    emit(deps, 'execution_oscillating', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      windowSize: window.length,
      failureFingerprint: input.classified.fingerprint,
    });
  } else if (healthAssessment.health === 'STALLED') {
    emit(deps, 'execution_stalled', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      repeatedFailureCount: healthAssessment.repeatedFailureCount,
      sameDiffRun: healthAssessment.sameDiffRun,
      failureFingerprint: input.classified.fingerprint,
    });
  }

  // 4. Normalize the failure across lanes.
  const assessed = assessFailure({
    classified: input.classified,
    lane: input.lane ?? null,
    ...(input.harnessFailureKind !== undefined
      ? { harnessFailureKind: input.harnessFailureKind }
      : {}),
    diffFingerprint: input.diffFingerprint ?? null,
    history: window,
    health: healthAssessment.health,
    runawaySignals: healthAssessment.runawaySignals,
    verificationInfrastructureBroken: verificationBroken(input.evaluation),
    ...(input.proposedSource !== undefined ? { proposedSource: input.proposedSource } : {}),
    ...(input.contextInsufficiencySignals !== undefined
      ? { contextInsufficiencySignals: input.contextInsufficiencySignals }
      : {}),
  });

  const assessment = writeFailureAssessment(
    deps.workspace,
    failureAssessmentSchema.parse({
      schemaVersion: FAILURE_ASSESSMENT_SCHEMA_VERSION,
      assessmentId: newId(deps, 'fa'),
      jobId: input.jobId,
      nodeId: input.nodeId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      lane: input.lane ?? null,
      category: assessed.category,
      source: assessed.source,
      scope: assessed.scope,
      recoverability: assessed.recoverability,
      basis: assessed.basis,
      fingerprint: assessed.fingerprint,
      diffFingerprint: assessed.diffFingerprint,
      repeatedCount: assessed.repeatedCount,
      likelyCause: assessed.likelyCause,
      recommendedRecoveryClass: assessed.recommendedRecoveryClass,
      health: healthAssessment.health,
      runawaySignals: assessed.runawaySignals,
      evidenceRefs: [...(input.evidenceRefs ?? [])].slice(0, 40),
      createdAt: at,
    }),
    { maxRecords: deps.policy.maxRecordsPerJob },
  );

  emit(deps, 'failure_assessed', {
    nodeId: input.nodeId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    assessmentId: assessment.assessmentId,
    category: assessment.category,
    source: assessment.source,
    recoverability: assessment.recoverability,
    basis: assessment.basis,
    fingerprint: assessment.fingerprint,
    repeatedCount: assessment.repeatedCount,
    health: assessment.health,
  });

  // 5. Budget position, projected from every owner.
  const budget = buildBudgetView({
    budgets: input.budgets,
    counters: input.counters,
    node: input.node,
    executorAttempts: input.executorAttempts,
    elapsedMs: input.elapsedMs ?? null,
    ...(input.local !== undefined ? { local: input.local } : {}),
    ...(input.api !== undefined ? { api: input.api } : {}),
  });

  // 6. Decide. Pure, reproducible, and the only place an action is chosen.
  const plan = planRecovery({
    assessment: assessed,
    ...(input.evaluation !== undefined ? { evaluation: input.evaluation } : {}),
    health: healthAssessment.health,
    budget,
    policy: deps.policy,
    lane: input.lane ?? null,
    executionMode: input.executionMode ?? null,
    planRevision: input.planRevision,
    planValid: input.planValid ?? true,
    history: window,
    exhaustedStrategies: previous.exhaustedStrategies,
    freshContextRestartsUsed: previous.freshContextRestarts,
    infrastructureRetriesUsed: countInfrastructureRetries(previous),
    contextRatio: input.contextRatio ?? null,
    ...(input.contextExpansion !== undefined ? { contextExpansion: input.contextExpansion } : {}),
    resource: input.resource,
  });
  const researchEligibility = evaluateRuntimeResearchTrigger({
    explicitExternalKnowledgeGap: false,
    externalAssumptionContradiction: false,
    unknownToolingOrPlatformBehavior: assessed.source === 'UNKNOWN',
    repositoryAnswerAvailable: false,
    productAuthorityAmbiguity: assessed.source === 'REQUIREMENT_CONTRACT' || input.classified.category === 'AMBIGUITY',
    insufficientRepositoryContext: (input.contextInsufficiencySignals?.length ?? 0) > 0,
    failureCategory: input.classified.category,
    failureSource: assessed.source,
    failureFingerprint: assessed.fingerprint,
    observations: window,
  });
  if (researchEligibility.eligible) {
    emit(deps, 'runtime_research_eligible', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      failureFingerprint: assessed.fingerprint,
      depth: researchEligibility.depth,
      repeatedCount: researchEligibility.repeatedCount,
      materiallyDistinctStrategies: researchEligibility.materiallyDistinctStrategies,
      reason: researchEligibility.reason,
      nextRecovery: plan.action,
    });
  }

  const decision = writeRecoveryDecision(
    deps.workspace,
    recoveryDecisionSchema.parse({
      schemaVersion: RECOVERY_DECISION_SCHEMA_VERSION,
      decisionId: newId(deps, 'rd'),
      jobId: input.jobId,
      nodeId: input.nodeId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      assessmentId: assessment.assessmentId,
      ...(input.evaluation !== undefined ? { evaluationId: input.evaluation.evaluationId } : {}),
      action: plan.action,
      reasonCode: plan.reasonCode,
      reason: plan.reason.slice(0, 2_000),
      failureFingerprint: assessment.fingerprint,
      health: healthAssessment.health,
      strategyChange: plan.strategyChange,
      previousStrategy: plan.previousStrategy,
      nextStrategy: plan.nextStrategy,
      budgetSnapshot: snapshotBudget(budget),
      evidenceRefs: [...(input.evidenceRefs ?? [])].slice(0, 40),
      remediation: plan.remediation.slice(0, 50),
      ...(plan.requestedCapability !== undefined
        ? { requestedCapability: plan.requestedCapability }
        : {}),
      applied: false,
      createdAt: at,
    }),
    { maxRecords: deps.policy.maxRecordsPerJob },
  );

  emitDecisionEvents(deps, input, decision, plan);

  // 7. Persist the rolling window and the cumulative counters LAST, so the
  //    decision is already durable if this write is what crashes.
  const state = writeTaskReliabilityState(deps.workspace, {
    ...previous,
    health: healthAssessment.health,
    observations: window,
    exhaustedStrategies: rememberStrategy(previous, plan, observation),
    evaluationsFailed:
      previous.evaluationsFailed + (input.evaluation?.status === 'FAIL' ? 1 : 0),
    evaluationsInconclusive:
      previous.evaluationsInconclusive + (input.evaluation?.status === 'INCONCLUSIVE' ? 1 : 0),
    stagnationEvents: previous.stagnationEvents + (healthAssessment.health === 'STALLED' ? 1 : 0),
    oscillationEvents:
      previous.oscillationEvents + (healthAssessment.health === 'OSCILLATING' ? 1 : 0),
    runawayEvents: previous.runawayEvents + (healthAssessment.health === 'RUNAWAY' ? 1 : 0),
    freshContextRestarts:
      previous.freshContextRestarts + (plan.action === 'RESTART_FRESH_CONTEXT' ? 1 : 0),
    failedAttemptMs: previous.failedAttemptMs + Math.max(0, input.activity.durationMs ?? 0),
    pendingDecisionId: decision.decisionId,
    updatedAt: at,
  });

  return {
    assessment,
    decision,
    health: healthAssessment.health,
    budget,
    state,
    action: plan.action,
    ...(researchEligibility.eligible ? { researchEligibility } : {}),
  };
}

/**
 * Record that a passing attempt advanced the task.
 *
 * Health resets to HEALTHY and the pending decision clears: a task that just
 * succeeded is not carrying an unacted recovery decision, and leaving one
 * behind would make a later restart believe it owed the task a retry.
 */
export function recordSuccessfulAttempt(
  deps: ReliabilityDeps,
  input: {
    jobId: string;
    nodeId: string;
    taskId: string;
    attemptId: string;
    attemptNumber: number;
    lane?: string | null | undefined;
    evaluationStatus?: EvaluationResult['status'] | undefined;
  },
): TaskReliabilityState {
  const at = now(deps).toISOString();
  const previous = requireTaskReliabilityState(
    deps.workspace,
    input.jobId,
    input.nodeId,
    input.taskId,
    at,
  );
  const window = appendObservation(
    previous,
    {
      attemptId: input.attemptId,
      attemptNumber: input.attemptNumber,
      failureFingerprint: null,
      diffFingerprint: null,
      strategyKey: null,
      evaluationStatus: input.evaluationStatus ?? 'PASS',
      lane: input.lane ?? null,
      at,
    },
    RELIABILITY_LIMITS.maxFingerprintHistory,
  );
  const next: TaskReliabilityState = {
    ...previous,
    health: 'HEALTHY',
    observations: window,
    updatedAt: at,
  };
  delete (next as { pendingDecisionId?: string }).pendingDecisionId;
  return writeTaskReliabilityState(deps.workspace, next);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the evaluation says the JUDGING machinery broke, as opposed to the
 * implementation.
 *
 * Read from the record rather than inferred: an evaluation is INCONCLUSIVE
 * exactly when a required check could not produce a verdict, and that is the
 * evidence the assessment needs in order to refuse to blame the code.
 */
function verificationBroken(evaluation: EvaluationResult | undefined): boolean {
  if (evaluation === undefined) return false;
  if (evaluation.status !== 'INCONCLUSIVE') return false;
  return evaluation.deterministicChecks.some(
    (entry) =>
      entry.required &&
      (entry.level === 'BUILD_STATIC' || entry.level === 'TESTS') &&
      entry.outcome !== 'PASSED' &&
      entry.outcome !== 'FAILED',
  );
}

/** Bounded infrastructure retries already spent, counted from durable history. */
function countInfrastructureRetries(state: TaskReliabilityState): number {
  // Infrastructure retries do not change the strategy key, so they show up in
  // the window as repeats of one strategy with no evaluation verdict at all —
  // the shape of an attempt that never got far enough to be judged.
  return state.observations.filter((entry) => entry.evaluationStatus === 'INCONCLUSIVE').length;
}

/**
 * Remember a strategy once it has demonstrably failed.
 *
 * Only recorded when the decision CHANGES strategy: while the planner is
 * still repairing within one approach, that approach has not been ruled out,
 * and marking it exhausted early would push the task to escalate before it
 * had genuinely finished trying.
 */
function rememberStrategy(
  previous: TaskReliabilityState,
  plan: RecoveryPlan,
  observation: ReliabilityObservation,
): string[] {
  if (plan.strategyChange === 'SAME') return previous.exhaustedStrategies;
  const key = observation.strategyKey;
  if (key === null || previous.exhaustedStrategies.includes(key)) {
    return previous.exhaustedStrategies;
  }
  const next = [...previous.exhaustedStrategies, key];
  return next.length > RELIABILITY_LIMITS.maxListItems
    ? next.slice(next.length - RELIABILITY_LIMITS.maxListItems)
    : next;
}

function emitDecisionEvents(
  deps: ReliabilityDeps,
  input: GovernFailureInput,
  decision: RecoveryDecision,
  plan: RecoveryPlan,
): void {
  const base = {
    nodeId: input.nodeId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    decisionId: decision.decisionId,
    action: decision.action,
    reasonCode: decision.reasonCode,
    health: decision.health,
    strategyChange: decision.strategyChange,
  };
  emit(deps, 'recovery_decided', {
    ...base,
    reason: decision.reason.slice(0, 300),
    remainingAttempts: decision.budgetSnapshot.attemptsMax - decision.budgetSnapshot.attemptsUsed,
    remainingRepairs: decision.budgetSnapshot.repairsMax - decision.budgetSnapshot.repairsUsed,
    remainingReplans: decision.budgetSnapshot.replansMax - decision.budgetSnapshot.replansUsed,
  });

  switch (plan.action) {
    case 'RESTART_FRESH_CONTEXT':
      emit(deps, 'fresh_context_selected', base);
      break;
    case 'RETRY_DIFFERENT_LOCAL_MODE':
      emit(deps, 'local_mode_recovery_selected', {
        ...base,
        fromMode: input.executionMode ?? 'unknown',
        toMode: plan.nextStrategy.executionMode ?? 'unknown',
      });
      break;
    case 'ESCALATE_INTELLIGENCE':
    case 'ESCALATE_LANE':
      emit(deps, 'lane_escalation_requested', {
        ...base,
        requestedKind: plan.requestedCapability?.kind ?? 'STRONG',
        // Said explicitly in the timeline because it is the invariant most
        // worth being able to prove after the fact.
        detail:
          'A recovery REQUIREMENT was recorded. It authorizes nothing: spend policy, ' +
          'the API budget, and the scheduler each decide independently.',
      });
      break;
    case 'WAIT_FOR_RESOURCE':
      emit(deps, 'resource_wait_selected', {
        ...base,
        waitMs: plan.waitMs ?? null,
      });
      break;
    case 'FAIL_TASK':
      emit(deps, 'recovery_budget_exhausted', {
        ...base,
        budgetSnapshot: decision.budgetSnapshot,
      });
      emit(deps, 'task_blocked_after_recovery', {
        ...base,
        remediation: decision.remediation.slice(0, 5),
      });
      break;
    case 'BLOCK':
      emit(deps, 'task_blocked_after_recovery', {
        ...base,
        remediation: decision.remediation.slice(0, 5),
      });
      break;
    default:
      break;
  }
}
