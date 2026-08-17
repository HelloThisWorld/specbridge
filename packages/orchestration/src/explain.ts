import type { WorkspaceInfo } from '@specbridge/core';
import { effectiveDecisions } from './clarification.js';
import type { ExecutionPlan, OrchestrationState } from './state.js';
import { readOrchestrationEvents, readPlanRevision } from './store.js';
import { allowedActions, allowedTransitions } from './state-machine.js';
import { isFinalPhase } from './vocabulary.js';

/**
 * Explainability.
 *
 * Every answer here is derived from persisted structured state — the phase,
 * the counters, the recorded blocker, the plan bindings, the append-only
 * events. Nothing is reconstructed by asking a model what it remembers doing,
 * because a plausible story about a run is not the same thing as the run.
 */

export interface BudgetUsage {
  name: string;
  used: number;
  limit: number;
  exhausted: boolean;
}

export function budgetUsage(state: OrchestrationState): BudgetUsage[] {
  const rows: BudgetUsage[] = [
    { name: 'iterations', used: state.counters.iterations, limit: state.budgets.maxIterations },
    { name: 'repairCycles', used: state.counters.repairCycles, limit: state.budgets.maxRepairCycles },
    { name: 'replans', used: state.counters.replans, limit: state.budgets.maxReplans },
    {
      name: 'transientRetries',
      used: state.counters.transientRetries,
      limit: state.budgets.maxTransientRetries,
    },
    {
      name: 'noProgressCycles',
      used: state.counters.consecutiveNoProgress,
      limit: state.budgets.maxNoProgressCycles,
    },
    {
      name: 'clarificationRounds',
      used: state.counters.clarificationRounds,
      limit: state.budgets.maxClarificationRounds,
    },
    { name: 'events', used: state.counters.events, limit: state.budgets.maxEvents },
  ].map((row) => ({ ...row, exhausted: row.used >= row.limit }));
  return rows;
}

export interface OrchestrationExplanation {
  orchestrationId: string;
  specName: string;
  taskId?: string;
  phase: string;
  final: boolean;
  /** One line: what the run is waiting on, or why it stopped. */
  summary: string;
  /** The exact next safe action, in the user's terms. */
  nextAction: string;
  /** Why execution has not started, when it has not. */
  executionBlockedBecause?: string;
  openQuestions: { id: string; question: string; whyItMatters: string }[];
  decisions: { id: string; question: string; answer: string; source: string }[];
  planRevision: number;
  planStale: boolean;
  planStaleReasons: string[];
  planReviewed: boolean;
  budgets: BudgetUsage[];
  exhaustedBudgets: string[];
  blocker?: { category: string; code: string; message: string; remediation: string[] };
  allowedNextPhases: string[];
  allowedActions: string[];
  interactiveRunIds: string[];
}

function summarize(state: OrchestrationState): { summary: string; nextAction: string } {
  switch (state.phase) {
    case 'CREATED':
      return {
        summary: 'The run exists but intent has not been assessed yet.',
        nextAction: 'Assess intent with orchestration_assess_intent.',
      };
    case 'NEEDS_CLARIFICATION':
      return {
        summary: `${state.openQuestions.length} question(s) must be answered before implementation can start.`,
        nextAction:
          state.openQuestions[0] !== undefined
            ? `Answer: ${state.openQuestions[0].question}`
            : 'Record the answers with orchestration_resolve_clarification.',
      };
    case 'READY_TO_PLAN':
      return {
        summary: 'Intent is READY; no execution plan exists yet.',
        nextAction: 'Submit an execution plan with orchestration_submit_plan.',
      };
    case 'AWAITING_PLAN_REVIEW':
      return {
        summary: `Plan revision ${state.planRevision} is waiting for explicit review.`,
        nextAction: 'Present the plan to the user, then record their decision with orchestration_review_plan.',
      };
    case 'READY_TO_EXECUTE':
      return {
        summary: `Plan revision ${state.planRevision} is valid; implementation may begin.`,
        nextAction: 'Begin the task with task_begin, then record actions as you go.',
      };
    case 'EXECUTING':
      return {
        summary: `Executing plan revision ${state.planRevision} (iteration ${state.counters.iterations}).`,
        nextAction: 'Continue the plan steps, then call task_complete when the changes are ready.',
      };
    case 'REPAIRING':
      return {
        summary: `Repairing a verification failure (cycle ${state.counters.repairCycles} of ${state.budgets.maxRepairCycles}).`,
        nextAction: 'Fix the implementation against the failing verifier output, then verify again.',
      };
    case 'REPLANNING':
      return {
        summary:
          state.planStaleReasons.length > 0
            ? `The active plan is stale (${state.planStaleReasons.join(', ')}).`
            : 'The active plan was invalidated and must be replaced.',
        nextAction: 'Submit a replacement plan with orchestration_submit_plan.',
      };
    case 'BLOCKED':
      return {
        summary: state.blocker?.message ?? 'The run is blocked on an unsatisfied prerequisite.',
        nextAction: state.blocker?.remediation[0] ?? 'Resolve the blocker, then continue explicitly.',
      };
    case 'COMPLETED':
      return {
        summary: 'The task was completed through verified evidence.',
        nextAction: 'Nothing. Start a new run for further work.',
      };
    case 'ABORTED':
      return {
        summary: 'The run was aborted; source changes and evidence are preserved.',
        nextAction: 'Inspect the preserved changes, then start a new run when ready.',
      };
    case 'CANCELLED':
      return {
        summary: 'The run was cancelled and is never restarted automatically.',
        nextAction: 'Start a new run explicitly when ready.',
      };
    case 'REJECTED':
      return {
        summary:
          state.intent?.overrideReason ?? 'The request violated a hard SpecBridge product boundary.',
        nextAction: 'Change the request so it stays inside the boundary, then start a new run.',
      };
  }
}

/** Why execution cannot start right now, in one line — or undefined. */
export function executionBlockedReason(state: OrchestrationState): string | undefined {
  if (state.phase === 'EXECUTING' || state.phase === 'REPAIRING') return undefined;
  if (isFinalPhase(state.phase)) {
    return `The run is ${state.phase}; finalized runs never resume.`;
  }
  switch (state.phase) {
    case 'CREATED':
      return 'Intent has not been assessed.';
    case 'NEEDS_CLARIFICATION':
      return `${state.openQuestions.length} clarification question(s) are unanswered.`;
    case 'READY_TO_PLAN':
      return 'No execution plan has been submitted.';
    case 'AWAITING_PLAN_REVIEW':
      return `Plan revision ${state.planRevision} has not been reviewed.`;
    case 'REPLANNING':
      return state.planStaleReasons.length > 0
        ? `The active plan is stale: ${state.planStaleReasons.join(', ')}.`
        : 'The active plan was invalidated.';
    case 'BLOCKED':
      return state.blocker?.message ?? 'A prerequisite is unsatisfied.';
    default:
      return undefined;
  }
}

export function explainOrchestration(state: OrchestrationState): OrchestrationExplanation {
  const { summary, nextAction } = summarize(state);
  const budgets = budgetUsage(state);
  const blockedBecause = executionBlockedReason(state);
  return {
    orchestrationId: state.orchestrationId,
    specName: state.specName,
    ...(state.taskId !== undefined ? { taskId: state.taskId } : {}),
    phase: state.phase,
    final: isFinalPhase(state.phase),
    summary,
    nextAction,
    ...(blockedBecause !== undefined ? { executionBlockedBecause: blockedBecause } : {}),
    openQuestions: state.openQuestions.map((question) => ({
      id: question.id,
      question: question.question,
      whyItMatters: question.whyItMatters,
    })),
    decisions: effectiveDecisions(state.decisions).map((decision) => ({
      id: decision.id,
      question: decision.question,
      answer: decision.answer,
      source: decision.source,
    })),
    planRevision: state.planRevision,
    planStale: state.planStaleReasons.length > 0,
    planStaleReasons: [...state.planStaleReasons],
    planReviewed: state.planReview?.decision === 'approved',
    budgets,
    exhaustedBudgets: budgets.filter((row) => row.exhausted).map((row) => row.name),
    ...(state.blocker !== undefined
      ? {
          blocker: {
            category: state.blocker.category,
            code: state.blocker.code,
            message: state.blocker.message,
            remediation: [...state.blocker.remediation],
          },
        }
      : {}),
    allowedNextPhases: [...allowedTransitions(state.phase)],
    allowedActions: [...allowedActions(state.phase)],
    interactiveRunIds: [...state.interactiveRunIds],
  };
}

export interface OrchestrationDetail extends OrchestrationExplanation {
  activePlan?: ExecutionPlan;
  recentEvents: { at: string; type: string }[];
  totalEvents: number;
}

/** Bounded detail view: the plan plus a page of history, never the whole log. */
export function describeOrchestration(
  workspace: WorkspaceInfo,
  state: OrchestrationState,
  options: { eventLimit?: number } = {},
): OrchestrationDetail {
  const plan =
    state.planRevision > 0
      ? readPlanRevision(workspace, state.orchestrationId, state.planRevision)
      : undefined;
  const page = readOrchestrationEvents(workspace, state.orchestrationId, {
    limit: options.eventLimit ?? 20,
  });
  return {
    ...explainOrchestration(state),
    ...(plan !== undefined ? { activePlan: plan } : {}),
    recentEvents: page.events.map((event) => ({
      at: String(event['at'] ?? ''),
      type: String(event['type'] ?? ''),
    })),
    totalEvents: page.total,
  };
}
