import { captureGitSnapshot } from '@specbridge/evidence';
import { orchestrationPolicyFingerprint } from '@specbridge/core';
import { readInteractiveLock, readRunRecord } from '@specbridge/execution';
import type { OrchestrationDeps } from './orchestrator.js';
import { checkPlanFreshness } from './orchestrator.js';
import type { OrchestrationCheckpoint, OrchestrationState } from './state.js';
import { readOrchestrationCheckpoint, requireOrchestrationState } from './store.js';
import { explainOrchestration } from './explain.js';
import type { OrchestrationExplanation } from './explain.js';
import { isFinalPhase } from './vocabulary.js';

/**
 * Resume and recovery.
 *
 * The honesty rules this enforces:
 *
 *   A resumed run is the SAME run. It keeps its id, its counters, its plan
 *   revisions, and its event history. A new run is never dressed up as a
 *   continuation, and a finalized run never becomes runnable again — it
 *   returns its recorded outcome and stops.
 *
 *   A resumed agent remembers nothing. Only persisted structured state is
 *   trusted; there is no field that could carry the previous session's
 *   reasoning, so there is nothing for a new session to pretend to recall.
 *
 *   A resumed run re-checks reality. The plan is re-bound against the current
 *   task, approvals, and Git baseline before anything continues, so an
 *   obsolete plan is never executed silently.
 */

export interface ResumeReport {
  state: OrchestrationState;
  explanation: OrchestrationExplanation;
  /** True when the run is finalized: status only, no continuation. */
  finalized: boolean;
  /** The plan was re-bound and found stale; a replan is required. */
  planStale: boolean;
  planStaleReasons: string[];
  planStaleExplanations: string[];
  /** The orchestration policy changed since the run started. */
  policyChanged: boolean;
  /** The interactive execution run this orchestration owned, if still open. */
  activeInteractiveRun?: {
    runId: string;
    lifecycleStatus: string | undefined;
    /** True when the repository lock still belongs to this run. */
    lockHeld: boolean;
  };
  /** Repository HEAD now, for divergence reporting. */
  gitHead?: string;
  checkpoint?: OrchestrationCheckpoint;
  /** The exact next safe action. */
  nextAction: string;
  warnings: string[];
}

/**
 * Recover an orchestration run for a fresh session.
 *
 * Read-mostly: the only write it may perform is recording that the active
 * plan became stale, which is itself part of refusing to continue silently.
 */
export async function resumeOrchestration(
  deps: OrchestrationDeps,
  orchestrationId: string,
): Promise<ResumeReport> {
  const state = requireOrchestrationState(deps.workspace, orchestrationId);
  const warnings: string[] = [];
  const checkpoint = readOrchestrationCheckpoint(deps.workspace, orchestrationId);

  // A finalized run is reported, never resumed. This is the guard that stops
  // a completed run from masquerading as work in progress.
  if (isFinalPhase(state.phase)) {
    const explanation = explainOrchestration(state);
    return {
      state,
      explanation,
      finalized: true,
      planStale: false,
      planStaleReasons: [],
      planStaleExplanations: [],
      policyChanged: false,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      nextAction: explanation.nextAction,
      warnings: [
        `Run ${orchestrationId} is ${state.phase} and cannot be continued. Start a new run for further work.`,
      ],
    };
  }

  // The bounds a run executes under are the ones it started with. A changed
  // policy is surfaced rather than silently applied.
  const currentFingerprint = orchestrationPolicyFingerprint(deps.config.orchestration);
  const policyChanged = currentFingerprint !== state.policyFingerprint;
  if (policyChanged) {
    warnings.push(
      'The orchestration policy changed since this run began. The run continues under the budgets ' +
        'recorded at its start; start a new run to adopt the new policy.',
    );
  }

  const snapshot = await captureGitSnapshot(deps.workspace.rootDir, {
    clock: () => (deps.clock ?? (() => new Date()))(),
  });

  // Re-bind the plan against the world as it is now. Read-only: inspecting a
  // run must never change it, so the verdict is reported rather than
  // persisted. The transition to REPLANNING happens when execution is next
  // actually attempted (recordActionChecked), which is the moment it matters.
  let planStale = false;
  let planStaleReasons: string[] = [];
  let planStaleExplanations: string[] = [];
  if (state.planRevision > 0) {
    const freshness = await checkPlanFreshness(deps, orchestrationId);
    planStale = !freshness.fresh;
    planStaleReasons = freshness.reasons;
    planStaleExplanations = freshness.explanations;
    if (planStale) {
      warnings.push(
        'The recorded execution plan no longer matches the repository; it will not be executed as-is.',
      );
    }
  }

  // Reconcile the interactive execution run, if one was open.
  let activeInteractiveRun: ResumeReport['activeInteractiveRun'];
  if (state.activeInteractiveRunId !== undefined) {
    const record = readRunRecord(deps.workspace, state.activeInteractiveRunId);
    const lock = readInteractiveLock(deps.workspace);
    const lockHeld = lock.state === 'held' && lock.lock.runId === state.activeInteractiveRunId;
    activeInteractiveRun = {
      runId: state.activeInteractiveRunId,
      lifecycleStatus: record?.lifecycleStatus,
      lockHeld,
    };
    if (record === undefined) {
      warnings.push(
        `The recorded interactive run ${state.activeInteractiveRunId} no longer exists; a fresh task_begin is required.`,
      );
    } else if (record.lifecycleStatus === 'AWAITING_AGENT_CHANGES' && !lockHeld) {
      warnings.push(
        `Interactive run ${state.activeInteractiveRunId} is still open but no longer owns the repository lock. ` +
          'Abort it with task_abort (source changes are preserved), then begin a fresh run.',
      );
    }
  }

  const explanation = explainOrchestration(state);
  const nextAction = planStale
    ? 'Submit a replacement execution plan: the recorded plan is stale.'
    : explanation.nextAction;

  return {
    state,
    explanation,
    finalized: false,
    planStale,
    planStaleReasons,
    planStaleExplanations,
    policyChanged,
    ...(activeInteractiveRun !== undefined ? { activeInteractiveRun } : {}),
    ...(snapshot.head !== undefined ? { gitHead: snapshot.head } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    nextAction,
    warnings,
  };
}
