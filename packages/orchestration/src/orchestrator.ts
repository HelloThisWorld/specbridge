import { randomUUID } from 'node:crypto';
import type { AgentConfig, OrchestrationPolicy, WorkspaceInfo } from '@specbridge/core';
import { orchestrationPolicyFingerprint } from '@specbridge/core';
import { captureGitSnapshot } from '@specbridge/evidence';
import type { Clock } from '@specbridge/workflow';
import { systemClock } from '@specbridge/workflow';
import type { DecisionCandidate, QuestionCandidate } from './clarification.js';
import { buildClarificationDecisions, buildClarificationRound } from './clarification.js';
import { OrchestrationError } from './errors.js';
import type { ClassifiedFailure } from './failure.js';
import { classifyFailure } from './failure.js';
import type { IntentSubmission } from './intent.js';
import { validateIntent } from './intent.js';
import type { PlanCandidateInput } from './planning.js';
import { assessPlanChange, buildExecutionPlan, capturePlanBinding, evaluatePlanFreshness } from './planning.js';
import { assessProgress, diffFingerprint } from './progress.js';
import type { RetryDecision } from './retry.js';
import { decideNextStep } from './retry.js';
import { assertActionAllowed, assertTransition } from './state-machine.js';
import type {
  ExecutionPlan,
  ObservationFingerprint,
  OrchestrationCheckpoint,
  OrchestrationState,
} from './state.js';
import {
  ORCHESTRATION_CHECKPOINT_SCHEMA_VERSION,
  ORCHESTRATION_STATE_SCHEMA_VERSION,
  observationFingerprintSchema,
  orchestrationCheckpointSchema,
} from './state.js';
import {
  appendOrchestrationEvent,
  countOrchestrationEvents,
  createOrchestrationRun,
  planHash,
  readPlanRevision,
  requireOrchestrationState,
  storePlanRevision,
  writeOrchestrationCheckpoint,
  writeOrchestrationState,
} from './store.js';
import type {
  ActionCategory,
  FailureCategory,
  ObservationResult,
  OrchestrationEventType,
  OrchestrationPhase,
} from './vocabulary.js';
import { isFinalPhase } from './vocabulary.js';

/**
 * The orchestration application service.
 *
 * Every operation is: load state → validate against policy and the state
 * machine → compute a deterministic decision → persist atomically → append an
 * event. CLI handlers, MCP tools, and plugin skills call these functions;
 * none of them re-implement a transition, a budget, or a retry rule.
 *
 * The service never invokes a model, never runs a command, never touches
 * `.kiro`, and never decides that a task is complete — that stays with
 * `task_complete`, its Git evidence, and the trusted verifiers.
 */

export interface OrchestrationDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  clock?: Clock | undefined;
  idFactory?: (() => string) | undefined;
  /** Host label recorded on the run (e.g. "mcp", "cli"). */
  host?: string | undefined;
}

function policyOf(deps: OrchestrationDeps): OrchestrationPolicy {
  return deps.config.orchestration;
}

function now(deps: OrchestrationDeps): Date {
  return (deps.clock ?? systemClock)();
}

function newId(deps: OrchestrationDeps): string {
  return (deps.idFactory ?? randomUUID)();
}

function assertEnabled(policy: OrchestrationPolicy): void {
  if (policy.enabled) return;
  throw new OrchestrationError(
    'SBO001',
    'Governed orchestration is disabled by `orchestration.enabled` in .specbridge/config.json.',
    {
      remediation: [
        'Set orchestration.enabled to true, or use the direct task lifecycle (task_begin/task_complete).',
      ],
    },
  );
}

/** Append an event, keeping the persisted counter and the log consistent. */
function record(
  deps: OrchestrationDeps,
  state: OrchestrationState,
  type: OrchestrationEventType,
  payload: Record<string, unknown> = {},
): OrchestrationState {
  const policy = policyOf(deps);
  const stored = countOrchestrationEvents(deps.workspace, state.orchestrationId);
  if (stored >= state.budgets.maxEvents) {
    throw new OrchestrationError(
      'SBO020',
      `The orchestration event history reached its ${state.budgets.maxEvents}-event limit. ` +
        'History is never truncated, so the run stops here instead.',
      {
        remediation: [
          'All evidence is preserved. Start a new run, or raise orchestration.history.maxEvents explicitly.',
        ],
        failureCategory: 'BUDGET_EXHAUSTED',
      },
    );
  }
  appendOrchestrationEvent(
    deps.workspace,
    state.orchestrationId,
    { at: now(deps).toISOString(), type, ...payload },
    { maxEventBytes: policy.history.maxEventBytes },
  );
  return { ...state, counters: { ...state.counters, events: stored + 1 } };
}

/** Move to a new phase after asserting the transition is legal. */
function transition(
  deps: OrchestrationDeps,
  state: OrchestrationState,
  to: OrchestrationPhase,
): OrchestrationState {
  assertTransition(state.phase, to);
  return { ...state, phase: to, updatedAt: now(deps).toISOString() };
}

function persist(deps: OrchestrationDeps, state: OrchestrationState): OrchestrationState {
  return writeOrchestrationState(deps.workspace, {
    ...state,
    updatedAt: now(deps).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Begin
// ---------------------------------------------------------------------------

export interface BeginOrchestrationRequest {
  specName: string;
  /** The user's stated goal. Stored verbatim as DATA, never as instructions. */
  goal: string;
  taskId?: string | undefined;
}

export function beginOrchestration(
  deps: OrchestrationDeps,
  request: BeginOrchestrationRequest,
): OrchestrationState {
  const policy = policyOf(deps);
  assertEnabled(policy);

  const goal = request.goal.trim();
  if (goal.length === 0) {
    throw new OrchestrationError('SBO006', 'An orchestration run needs a stated goal.', {
      remediation: ['Describe what the user asked for, in one or two sentences.'],
    });
  }

  const createdAt = now(deps).toISOString();
  const state: OrchestrationState = {
    schemaVersion: ORCHESTRATION_STATE_SCHEMA_VERSION,
    orchestrationId: newId(deps),
    specName: request.specName,
    ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
    phase: 'CREATED',
    goal: goal.slice(0, 4_000),
    createdAt,
    updatedAt: createdAt,
    host: deps.host ?? 'mcp',
    planningMode: policy.planning.mode,
    policyFingerprint: orchestrationPolicyFingerprint(policy),
    budgets: {
      maxIterations: policy.execution.maxIterations,
      maxRepairCycles: policy.execution.maxRepairCycles,
      maxReplans: policy.planning.maxReplans,
      maxNoProgressCycles: policy.execution.maxNoProgressCycles,
      maxTransientRetries: policy.retry.maxTransientRetries,
      maxClarificationRounds: policy.clarification.maxRounds,
      maxElapsedMs: policy.execution.maxElapsedMs,
      maxEvents: policy.history.maxEvents,
    },
    counters: {
      iterations: 0,
      repairCycles: 0,
      replans: 0,
      transientRetries: 0,
      consecutiveNoProgress: 0,
      clarificationRounds: 0,
      events: 0,
    },
    openQuestions: [],
    decisions: [],
    planRevision: 0,
    planStaleReasons: [],
    interactiveRunIds: [],
  };

  createOrchestrationRun(deps.workspace, state);
  const recorded = record(deps, state, 'orchestration_started', {
    specName: state.specName,
    ...(state.taskId !== undefined ? { taskId: state.taskId } : {}),
    planningMode: state.planningMode,
  });
  return persist(deps, recorded);
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export interface IntentResult {
  state: OrchestrationState;
  overridden: boolean;
  blockers: { code: string; message: string; remediation: string[] }[];
}

export function assessIntent(
  deps: OrchestrationDeps,
  orchestrationId: string,
  submission: IntentSubmission,
): IntentResult {
  const policy = policyOf(deps);
  assertEnabled(policy);
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  if (isFinalPhase(state.phase)) {
    throw new OrchestrationError(
      'SBO005',
      `Orchestration run ${orchestrationId} is ${state.phase}; intent cannot be reassessed.`,
      { remediation: ['Start a new orchestration run.'] },
    );
  }

  const validation = validateIntent(
    {
      workspace: deps.workspace,
      specName: state.specName,
      taskId: state.taskId,
      policy,
      orchestrationId,
    },
    submission,
    { assessedAt: now(deps).toISOString() },
  );

  const target: OrchestrationPhase =
    validation.assessment.outcome === 'READY'
      ? 'READY_TO_PLAN'
      : validation.assessment.outcome === 'NEEDS_CLARIFICATION'
        ? 'NEEDS_CLARIFICATION'
        : validation.assessment.outcome === 'REJECTED'
          ? 'REJECTED'
          : 'BLOCKED';

  state = { ...state, intent: validation.assessment };
  state = transition(deps, state, target);

  if (target === 'BLOCKED' && validation.blockers[0] !== undefined) {
    const first = validation.blockers[0];
    state = {
      ...state,
      blocker: {
        category: 'BLOCKED_DEPENDENCY',
        code: first.code,
        message: first.message,
        remediation: first.remediation,
        at: now(deps).toISOString(),
      },
    };
  }
  if (target === 'REJECTED') {
    state = {
      ...state,
      finalizedAt: now(deps).toISOString(),
      finalOutcome: 'REJECTED',
    };
  }

  state = record(deps, state, 'intent_assessed', {
    outcome: validation.assessment.outcome,
    overridden: validation.overridden,
    ...(validation.assessment.overriddenFrom !== undefined
      ? { submittedOutcome: validation.assessment.overriddenFrom }
      : {}),
    blockers: validation.blockers.map((blocker) => blocker.code),
  });

  return {
    state: persist(deps, state),
    overridden: validation.overridden,
    blockers: validation.blockers.map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
      remediation: blocker.remediation,
    })),
  };
}

// ---------------------------------------------------------------------------
// Clarification
// ---------------------------------------------------------------------------

export function requestClarification(
  deps: OrchestrationDeps,
  orchestrationId: string,
  candidates: readonly QuestionCandidate[],
): OrchestrationState {
  const policy = policyOf(deps);
  assertEnabled(policy);
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  assertActionAllowed(state.phase, 'REQUEST_CLARIFICATION');

  const round = buildClarificationRound(state, candidates, policy, {
    askedAt: now(deps).toISOString(),
    idFactory: () => newId(deps),
  });

  state = {
    ...state,
    openQuestions: [...state.openQuestions, ...round.questions],
    counters: { ...state.counters, clarificationRounds: round.round },
  };
  if (state.phase !== 'NEEDS_CLARIFICATION') {
    state = transition(deps, state, 'NEEDS_CLARIFICATION');
  }
  state = record(deps, state, 'clarification_requested', {
    round: round.round,
    questionIds: round.questions.map((question) => question.id),
  });
  return persist(deps, state);
}

export interface ClarificationResolution {
  state: OrchestrationState;
  /** Decisions whose stated impact means the spec itself should change. */
  requiresSpecChange: string[];
}

export function resolveClarification(
  deps: OrchestrationDeps,
  orchestrationId: string,
  candidates: readonly DecisionCandidate[],
): ClarificationResolution {
  const policy = policyOf(deps);
  assertEnabled(policy);
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  if (isFinalPhase(state.phase)) {
    throw new OrchestrationError(
      'SBO005',
      `Orchestration run ${orchestrationId} is ${state.phase}; clarifications cannot be recorded.`,
    );
  }

  const decisions = buildClarificationDecisions(state, candidates, policy, {
    decidedAt: now(deps).toISOString(),
    idFactory: () => newId(deps),
  });
  const answeredIds = new Set(decisions.map((decision) => decision.questionId));

  state = {
    ...state,
    decisions: [...state.decisions, ...decisions],
    openQuestions: state.openQuestions.filter((question) => !answeredIds.has(question.id)),
  };

  // Answering the last open question unblocks planning; unanswered questions
  // keep the run where it is.
  if (state.openQuestions.length === 0 && state.phase === 'NEEDS_CLARIFICATION') {
    state = transition(deps, state, 'READY_TO_PLAN');
  }

  state = record(deps, state, 'clarification_resolved', {
    decisionIds: decisions.map((decision) => decision.id),
    remainingQuestions: state.openQuestions.length,
  });

  const requiresSpecChange = decisions
    .filter((decision) => /\b(spec|requirement|design|acceptance criteri)\b/i.test(decision.impact ?? ''))
    .map((decision) => decision.id);

  return { state: persist(deps, state), requiresSpecChange };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface SubmitPlanResult {
  state: OrchestrationState;
  plan: ExecutionPlan;
  planHash: string;
  reviewRequired: boolean;
  /** Present for a replacement plan: how it differs from the reviewed one. */
  materiality?: { materiality: string; materialChanges: string[]; immaterialChanges: string[] };
}

export async function submitPlan(
  deps: OrchestrationDeps,
  orchestrationId: string,
  candidate: PlanCandidateInput & { taskId: string },
): Promise<SubmitPlanResult> {
  const policy = policyOf(deps);
  assertEnabled(policy);
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  if (isFinalPhase(state.phase)) {
    throw new OrchestrationError(
      'SBO005',
      `Orchestration run ${orchestrationId} is ${state.phase}; a plan cannot be submitted.`,
    );
  }
  if (state.phase === 'CREATED') {
    throw new OrchestrationError(
      'SBO006',
      'Intent must be assessed before an execution plan is submitted.',
      { remediation: ['Call orchestration_assess_intent first.'] },
    );
  }
  if (state.phase === 'NEEDS_CLARIFICATION') {
    throw new OrchestrationError(
      'SBO007',
      `${state.openQuestions.length} clarification question(s) are still open; planning cannot start.`,
      {
        remediation: [
          'Answer the open questions with orchestration_resolve_clarification.',
          ...state.openQuestions.slice(0, 5).map((question) => `- ${question.question}`),
        ],
        failureCategory: 'AMBIGUITY',
      },
    );
  }

  const replacing = state.planRevision > 0;
  if (replacing && state.counters.replans >= state.budgets.maxReplans) {
    throw new OrchestrationError(
      'SBO013',
      `The replan budget of ${state.budgets.maxReplans} is exhausted; a further plan revision is refused.`,
      {
        remediation: [
          'All evidence and source changes are preserved; the task stays incomplete.',
          'Decide the approach explicitly, or raise orchestration.planning.maxReplans.',
        ],
        failureCategory: 'BUDGET_EXHAUSTED',
      },
    );
  }

  const snapshot = await captureGitSnapshot(deps.workspace.rootDir, { clock: () => now(deps) });
  const binding = capturePlanBinding(deps.workspace, {
    specName: state.specName,
    taskId: candidate.taskId,
    policy,
    gitHead: snapshot.head,
  });

  const revision = state.planRevision + 1;
  const previous = replacing
    ? readPlanRevision(deps.workspace, orchestrationId, state.planRevision)
    : undefined;

  const plan = buildExecutionPlan({
    candidate,
    specName: state.specName,
    binding,
    revision,
    planId: newId(deps),
    createdAt: now(deps).toISOString(),
    policy,
    ...(previous !== undefined ? { supersedes: previous.planId } : {}),
  });

  const stored = storePlanRevision(deps.workspace, orchestrationId, plan);
  const materiality = previous !== undefined ? assessPlanChange(previous, plan) : undefined;

  // A material change invalidates a prior review; an immaterial one (a
  // reorder, a wording fix) must not drag the user back into a review.
  const reviewRequired =
    policy.planning.mode === 'review' &&
    (state.planReview?.decision !== 'approved' || materiality?.materiality === 'material');

  state = {
    ...state,
    taskId: candidate.taskId,
    planRevision: revision,
    activePlanId: plan.planId,
    activePlanHash: stored.hash,
    planStaleReasons: [],
    ...(reviewRequired ? { planReview: undefined } : {}),
    counters: {
      ...state.counters,
      ...(replacing ? { replans: state.counters.replans + 1 } : {}),
      // A new plan is a new approach: stagnation does not carry over.
      consecutiveNoProgress: 0,
    },
  };
  if (reviewRequired) delete state.planReview;

  state = record(deps, state, 'plan_created', {
    revision,
    planId: plan.planId,
    planHash: stored.hash,
    reviewRequired,
    ...(materiality !== undefined ? { materiality: materiality.materiality } : {}),
    ...(materiality !== undefined ? { materialChanges: materiality.materialChanges } : {}),
  });
  if (replacing) {
    state = record(deps, state, 'replan_started', {
      revision,
      ...(candidate.replanReason !== undefined ? { reason: candidate.replanReason } : {}),
    });
  }

  state = transition(deps, state, reviewRequired ? 'AWAITING_PLAN_REVIEW' : 'READY_TO_EXECUTE');

  return {
    state: persist(deps, state),
    plan,
    planHash: stored.hash,
    reviewRequired,
    ...(materiality !== undefined ? { materiality } : {}),
  };
}

export interface ReviewPlanRequest {
  /** Hash of the exact plan being reviewed. A stale hash is refused. */
  planHash: string;
  decision: 'approved' | 'rejected';
  note?: string | undefined;
  channel?: 'user-relayed' | 'cli';
}

export function reviewPlan(
  deps: OrchestrationDeps,
  orchestrationId: string,
  request: ReviewPlanRequest,
): OrchestrationState {
  const policy = policyOf(deps);
  assertEnabled(policy);
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  if (state.phase !== 'AWAITING_PLAN_REVIEW') {
    throw new OrchestrationError(
      'SBO004',
      `Plan review is only meaningful while awaiting review; the run is ${state.phase}.`,
      { details: { phase: state.phase } },
    );
  }
  // Binding the review to the exact plan hash is what stops a review from
  // silently carrying over to a plan the user never saw.
  if (state.activePlanHash !== request.planHash) {
    throw new OrchestrationError(
      'SBO012',
      'The reviewed plan hash does not match the active plan; the review was not recorded.',
      {
        remediation: [
          'Re-read the active plan with `specbridge orchestrate show`, present it, then record the review.',
        ],
        details: { activePlanHash: state.activePlanHash, submitted: request.planHash },
      },
    );
  }

  const reviewedAt = now(deps).toISOString();
  state = {
    ...state,
    planReview: {
      decision: request.decision,
      planHash: request.planHash,
      planRevision: state.planRevision,
      reviewedAt,
      channel: request.channel ?? 'user-relayed',
      ...(request.note !== undefined ? { note: request.note } : {}),
    },
  };
  state = record(deps, state, 'plan_reviewed', {
    decision: request.decision,
    revision: state.planRevision,
    planHash: request.planHash,
  });
  state = transition(deps, state, request.decision === 'approved' ? 'READY_TO_EXECUTE' : 'READY_TO_PLAN');
  return persist(deps, state);
}

// ---------------------------------------------------------------------------
// Plan freshness
// ---------------------------------------------------------------------------

export interface PlanFreshnessResult {
  fresh: boolean;
  reasons: string[];
  explanations: string[];
  planRevision: number;
}

/**
 * Evaluate the active plan against the world as it is now, WITHOUT writing.
 *
 * Used by every read-only surface (status, resume inspection) so that looking
 * at a run can never change it.
 */
export async function checkPlanFreshness(
  deps: OrchestrationDeps,
  orchestrationId: string,
): Promise<PlanFreshnessResult> {
  const policy = policyOf(deps);
  const state = requireOrchestrationState(deps.workspace, orchestrationId);
  if (state.planRevision === 0) {
    return { fresh: false, reasons: ['no-plan'], explanations: ['No plan exists yet.'], planRevision: 0 };
  }
  const plan = readPlanRevision(deps.workspace, orchestrationId, state.planRevision);
  if (plan === undefined) {
    return {
      fresh: false,
      reasons: ['plan-unreadable'],
      explanations: [`Plan revision ${state.planRevision} is missing or unreadable.`],
      planRevision: state.planRevision,
    };
  }
  const snapshot = await captureGitSnapshot(deps.workspace.rootDir, { clock: () => now(deps) });
  const current = capturePlanBinding(deps.workspace, {
    specName: state.specName,
    taskId: plan.binding.taskId,
    policy,
    gitHead: snapshot.head,
  });
  const freshness = evaluatePlanFreshness(plan, current);
  return { ...freshness, planRevision: state.planRevision };
}

/**
 * Re-evaluate the active plan against the world as it is now and PERSIST the
 * verdict.
 *
 * Called before any mutating action. A stale plan is recorded as stale and
 * the run is moved to REPLANNING — it is never executed silently.
 */
export async function refreshPlanBinding(
  deps: OrchestrationDeps,
  orchestrationId: string,
): Promise<{ state: OrchestrationState; freshness: PlanFreshnessResult }> {
  const policy = policyOf(deps);
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  if (state.planRevision === 0) {
    return {
      state,
      freshness: { fresh: false, reasons: ['no-plan'], explanations: ['No plan exists yet.'], planRevision: 0 },
    };
  }
  const plan = readPlanRevision(deps.workspace, orchestrationId, state.planRevision);
  if (plan === undefined) {
    throw new OrchestrationError(
      'SBO010',
      `Plan revision ${state.planRevision} of run ${orchestrationId} is missing or unreadable.`,
      { remediation: ['Submit a fresh plan; the previous revisions are preserved on disk.'] },
    );
  }

  const snapshot = await captureGitSnapshot(deps.workspace.rootDir, { clock: () => now(deps) });
  const current = capturePlanBinding(deps.workspace, {
    specName: state.specName,
    taskId: plan.binding.taskId,
    policy,
    gitHead: snapshot.head,
  });
  const freshness = evaluatePlanFreshness(plan, current);

  if (!freshness.fresh) {
    state = { ...state, planStaleReasons: freshness.reasons };
    state = record(deps, state, 'plan_invalidated', {
      revision: state.planRevision,
      reasons: freshness.reasons,
    });
    if (state.phase !== 'REPLANNING' && !isFinalPhase(state.phase)) {
      state = transition(deps, state, 'REPLANNING');
    }
    state = persist(deps, state);
  } else if (state.planStaleReasons.length > 0) {
    state = persist(deps, { ...state, planStaleReasons: [] });
  }

  return {
    state,
    freshness: {
      fresh: freshness.fresh,
      reasons: freshness.reasons,
      explanations: freshness.explanations,
      planRevision: state.planRevision,
    },
  };
}

// ---------------------------------------------------------------------------
// Bounded execution loop
// ---------------------------------------------------------------------------

export interface RecordActionRequest {
  action: ActionCategory;
  /** What the action targeted: a path, a verifier name, a step id. */
  target: string;
  /** The plan step this action serves. */
  planStepId?: string | undefined;
  /** What evidence the action was expected to produce. */
  expectedEvidence?: string | undefined;
  result: ObservationResult;
  /** Files observed as changed. Claims; the completion gate re-derives them. */
  changedFiles?: { path: string; contentHash?: string | undefined }[];
  /** Classified failure, when the action failed. */
  failure?:
    | {
        category: FailureCategory;
        message: string;
        source: string;
        exitCode?: number | undefined;
        output?: string | undefined;
      }
    | undefined;
  /** True when the host asserts the implementation is ready to verify. */
  readyToVerify?: boolean | undefined;
}

export interface RecordActionResult {
  state: OrchestrationState;
  decision: RetryDecision;
  progress: { progressed: boolean; consecutiveNoProgress: number; stagnated: boolean; reason: string };
  classifiedFailure?: ClassifiedFailure;
}

/**
 * Record one bounded observe/decide/act iteration and return the
 * deterministic next directive.
 *
 * This is the whole ReAct/TAO control surface. What is recorded is
 * operational — action category, target, expected evidence, plan step,
 * result classification — and nothing else. No reasoning is requested,
 * accepted, or stored: see docs/orchestration/react-tao-execution.md for why
 * a harness needs control, not a transcript of deliberation.
 */
export function recordAction(
  deps: OrchestrationDeps,
  orchestrationId: string,
  request: RecordActionRequest,
): RecordActionResult {
  const policy = policyOf(deps);
  assertEnabled(policy);
  let state = requireOrchestrationState(deps.workspace, orchestrationId);

  if (isFinalPhase(state.phase)) {
    throw new OrchestrationError(
      'SBO005',
      `Orchestration run ${orchestrationId} is ${state.phase}; no further actions are recorded.`,
      { remediation: ['Read the final report; start a new run for further work.'] },
    );
  }
  // Phase/action gate: this is what makes "no source edits before the plan
  // gate" hard-enforced rather than an instruction in a Markdown file.
  assertActionAllowed(state.phase, request.action);

  // A plan must exist and be reviewed before anything mutates source.
  if (request.action === 'EDIT') {
    if (state.planRevision === 0 && policy.planning.mode !== 'disabled') {
      throw new OrchestrationError('SBO009', 'Source edits require an execution plan.', {
        remediation: ['Submit a plan with orchestration_submit_plan first.'],
      });
    }
    if (policy.planning.mode === 'review' && state.planReview?.decision !== 'approved') {
      throw new OrchestrationError(
        'SBO012',
        'The execution plan has not been reviewed; source edits are refused.',
        {
          remediation: [
            'Present the plan to the user and record their explicit decision with orchestration_review_plan.',
          ],
        },
      );
    }
    if (state.planStaleReasons.length > 0) {
      throw new OrchestrationError(
        'SBO011',
        `The active execution plan is stale (${state.planStaleReasons.join(', ')}); source edits are refused.`,
        { remediation: ['Replan against the current context.'], failureCategory: 'STALE_CONTEXT' },
      );
    }
  }

  const classified =
    request.failure !== undefined
      ? classifyFailure({
          category: request.failure.category,
          message: request.failure.message,
          source: request.failure.source,
          exitCode: request.failure.exitCode,
          output: request.failure.output,
        })
      : undefined;

  const observation: ObservationFingerprint = observationFingerprintSchema.parse({
    ...(classified !== undefined ? { failureFingerprint: classified.fingerprint } : {}),
    ...(request.changedFiles !== undefined
      ? { diffFingerprint: diffFingerprint(request.changedFiles) }
      : {}),
    changedFileCount: request.changedFiles?.length ?? 0,
    actionCategory: request.action,
    planRevision: state.planRevision,
    result: request.result,
  });

  const progress = assessProgress({
    previous: state.lastObservation,
    next: observation,
    consecutiveNoProgress: state.counters.consecutiveNoProgress,
    maxNoProgressCycles: state.budgets.maxNoProgressCycles,
  });

  const elapsedMs = Math.max(0, now(deps).getTime() - Date.parse(state.createdAt));
  const decision = decideNextStep(
    {
      failure: classified,
      counters: state.counters,
      budgets: state.budgets,
      elapsedMs,
      stagnated: progress.stagnated,
      progressed: progress.progressed,
      ...(request.readyToVerify !== undefined ? { readyToVerify: request.readyToVerify } : {}),
    },
    { baseBackoffMs: policy.retry.baseBackoffMs, maxBackoffMs: policy.retry.maxBackoffMs },
  );

  state = {
    ...state,
    lastObservation: observation,
    counters: {
      ...state.counters,
      iterations: state.counters.iterations + 1,
      consecutiveNoProgress: progress.consecutiveNoProgress,
      ...(decision.directive === 'RETRY'
        ? { transientRetries: state.counters.transientRetries + 1 }
        : {}),
      ...(decision.directive === 'REPAIR'
        ? { repairCycles: state.counters.repairCycles + 1 }
        : {}),
    },
  };

  state = record(deps, state, 'action_recorded', {
    action: request.action,
    target: request.target.slice(0, 200),
    ...(request.planStepId !== undefined ? { planStepId: request.planStepId } : {}),
    result: request.result,
  });
  state = record(deps, state, 'observation_recorded', {
    result: request.result,
    progressed: progress.progressed,
    consecutiveNoProgress: progress.consecutiveNoProgress,
    changedFileCount: observation.changedFileCount,
    ...(classified !== undefined ? { failureCategory: classified.category } : {}),
    ...(classified !== undefined ? { failureFingerprint: classified.fingerprint } : {}),
    directive: decision.directive,
  });
  if (classified?.category === 'VERIFICATION_FAILURE') {
    state = record(deps, state, 'verification_failed', {
      source: request.failure?.source ?? 'unknown',
      fingerprint: classified.fingerprint,
    });
  }

  state = applyDirective(deps, state, decision, classified);
  return {
    state: persist(deps, state),
    decision,
    progress,
    ...(classified !== undefined ? { classifiedFailure: classified } : {}),
  };
}

/**
 * Record an action after re-checking that the plan still describes reality.
 *
 * This is the entry point every adapter uses. The freshness check lives here,
 * not in the CLI or MCP handler, so a stale plan cannot be edited against
 * simply because a caller forgot to re-bind first.
 */
export async function recordActionChecked(
  deps: OrchestrationDeps,
  orchestrationId: string,
  request: RecordActionRequest,
): Promise<RecordActionResult> {
  const needsFreshPlan =
    request.action === 'EDIT' || request.action === 'VERIFY' || request.action === 'COMPLETE';
  if (needsFreshPlan) {
    const state = requireOrchestrationState(deps.workspace, orchestrationId);
    if (state.planRevision > 0 && !isFinalPhase(state.phase)) {
      await refreshPlanBinding(deps, orchestrationId);
    }
  }
  return recordAction(deps, orchestrationId, request);
}

/** Move the run into the phase implied by a directive. */
function applyDirective(
  deps: OrchestrationDeps,
  input: OrchestrationState,
  decision: RetryDecision,
  failure: ClassifiedFailure | undefined,
): OrchestrationState {
  let state = input;
  const at = now(deps).toISOString();

  switch (decision.directive) {
    case 'CONTINUE':
    case 'RETRY':
    case 'VERIFY':
      if (state.phase === 'READY_TO_EXECUTE') state = transition(deps, state, 'EXECUTING');
      return state;
    case 'REPAIR': {
      if (state.phase !== 'REPAIRING') {
        state = transition(deps, state, 'REPAIRING');
        state = record(deps, state, 'repair_started', {
          cycle: state.counters.repairCycles,
          ...(failure !== undefined ? { fingerprint: failure.fingerprint } : {}),
        });
      }
      return {
        ...state,
        ...(failure !== undefined ? { repairTargetFingerprint: failure.fingerprint } : {}),
      };
    }
    case 'REPLAN':
      // Replanning replaces an existing plan. With no plan yet the run is
      // already in a planning phase, and there is nothing to supersede — so
      // the phase stays where it is rather than inventing a REPLANNING state
      // that would have no plan to replan.
      if (state.planRevision > 0 && state.phase !== 'REPLANNING') {
        state = transition(deps, state, 'REPLANNING');
      }
      return state;
    case 'CLARIFY':
      if (state.phase !== 'NEEDS_CLARIFICATION') {
        state = transition(deps, state, 'NEEDS_CLARIFICATION');
      }
      return state;
    case 'BLOCK': {
      state = transition(deps, state, 'BLOCKED');
      state = record(deps, state, 'execution_blocked', {
        ...(failure !== undefined ? { category: failure.category } : {}),
        reason: decision.reason,
      });
      return {
        ...state,
        blocker: {
          category: failure?.category ?? 'INTERNAL',
          code: decision.exhaustedBudget ?? failure?.category ?? 'BLOCKED',
          message: decision.reason,
          remediation: decision.remediation,
          at,
        },
      };
    }
    case 'STOP_BUDGET_EXHAUSTED': {
      state = transition(deps, state, 'BLOCKED');
      state = record(deps, state, 'budget_exhausted', {
        budget: decision.exhaustedBudget ?? 'unknown',
        reason: decision.reason,
      });
      return {
        ...state,
        blocker: {
          category: 'BUDGET_EXHAUSTED',
          code: decision.exhaustedBudget ?? 'BUDGET_EXHAUSTED',
          message: decision.reason,
          remediation: decision.remediation,
          at,
        },
      };
    }
    case 'STOP_FINAL': {
      state = transition(deps, state, 'CANCELLED');
      state = record(deps, state, 'execution_cancelled', { reason: decision.reason });
      return { ...state, finalizedAt: at, finalOutcome: 'CANCELLED' };
    }
  }
}

// ---------------------------------------------------------------------------
// Execution linkage
// ---------------------------------------------------------------------------

/**
 * Attach an interactive execution run to the orchestration.
 *
 * The orchestration never implements anything itself: it records which
 * `task_begin` run is carrying the work, so evidence and completion stay
 * exactly where they already live.
 */
export function attachInteractiveRun(
  deps: OrchestrationDeps,
  orchestrationId: string,
  runId: string,
): OrchestrationState {
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  if (isFinalPhase(state.phase)) {
    throw new OrchestrationError(
      'SBO005',
      `Orchestration run ${orchestrationId} is ${state.phase}; no execution run can be attached.`,
    );
  }
  if (state.phase === 'READY_TO_EXECUTE') {
    state = transition(deps, state, 'EXECUTING');
    state = record(deps, state, 'execution_started', { runId });
  }
  state = {
    ...state,
    activeInteractiveRunId: runId,
    interactiveRunIds: state.interactiveRunIds.includes(runId)
      ? state.interactiveRunIds
      : [...state.interactiveRunIds, runId],
  };
  return persist(deps, state);
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

export interface FinalizeRequest {
  outcome: 'completed' | 'aborted' | 'cancelled';
  reason: string;
  /**
   * Evidence status reported by `task_complete`. Completion is accepted only
   * for `verified` or `manually-accepted`: orchestration has no independent
   * notion of "done" and cannot create one.
   */
  evidenceStatus?: string | undefined;
  interactiveRunId?: string | undefined;
}

export function finalizeOrchestration(
  deps: OrchestrationDeps,
  orchestrationId: string,
  request: FinalizeRequest,
): OrchestrationState {
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  if (isFinalPhase(state.phase)) {
    // Idempotent: a repeat finalize returns the recorded outcome rather than
    // finalizing twice or pretending to be a new run.
    return state;
  }

  const at = now(deps).toISOString();
  if (request.outcome === 'completed') {
    const accepted = request.evidenceStatus === 'verified' || request.evidenceStatus === 'manually-accepted';
    if (!accepted) {
      throw new OrchestrationError(
        'SBO022',
        'Orchestration cannot mark a task complete: completion requires a verified evidence status ' +
          `from task_complete (received ${request.evidenceStatus ?? 'none'}).`,
        {
          remediation: [
            'Run the trusted verification through task_complete and report its actual evidenceStatus.',
            'If verification failed, repair the implementation — a claim of success is not evidence.',
          ],
          failureCategory: 'SAFETY_POLICY',
        },
      );
    }
    state = transition(deps, state, 'COMPLETED');
    state = record(deps, state, 'execution_completed', {
      evidenceStatus: request.evidenceStatus,
      ...(request.interactiveRunId !== undefined ? { runId: request.interactiveRunId } : {}),
    });
    return persist(deps, { ...state, finalizedAt: at, finalOutcome: 'COMPLETED' });
  }

  if (request.outcome === 'cancelled') {
    state = transition(deps, state, 'CANCELLED');
    state = record(deps, state, 'execution_cancelled', { reason: request.reason });
    return persist(deps, { ...state, finalizedAt: at, finalOutcome: 'CANCELLED' });
  }

  state = transition(deps, state, 'ABORTED');
  state = record(deps, state, 'execution_aborted', { reason: request.reason });
  return persist(deps, { ...state, finalizedAt: at, finalOutcome: 'ABORTED' });
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export function createCheckpoint(
  deps: OrchestrationDeps,
  orchestrationId: string,
  input: { observations?: string[]; latestVerifier?: string | undefined; nextAction: string },
): OrchestrationCheckpoint {
  let state = requireOrchestrationState(deps.workspace, orchestrationId);
  const plan =
    state.planRevision > 0
      ? readPlanRevision(deps.workspace, orchestrationId, state.planRevision)
      : undefined;

  const checkpoint = orchestrationCheckpointSchema.parse({
    schemaVersion: ORCHESTRATION_CHECKPOINT_SCHEMA_VERSION,
    orchestrationId,
    createdAt: now(deps).toISOString(),
    specName: state.specName,
    ...(state.taskId !== undefined ? { taskId: state.taskId } : {}),
    phase: state.phase,
    planRevision: state.planRevision,
    completedSteps: (plan?.steps ?? []).filter((s) => s.status === 'done').map((s) => s.id),
    unresolvedSteps: (plan?.steps ?? []).filter((s) => s.status !== 'done').map((s) => s.id),
    observations: (input.observations ?? []).slice(0, 50),
    ...(input.latestVerifier !== undefined ? { latestVerifier: input.latestVerifier } : {}),
    counters: state.counters,
    budgets: state.budgets,
    ...(state.blocker !== undefined ? { blocker: state.blocker } : {}),
    nextAction: input.nextAction,
  });

  writeOrchestrationCheckpoint(deps.workspace, orchestrationId, checkpoint);
  state = record(deps, state, 'checkpoint_created', { phase: state.phase });
  persist(deps, state);
  return checkpoint;
}

export { planHash };
