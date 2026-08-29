import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { LocalExecutionMode, WorkspaceInfo } from '@specbridge/core';
import type { ClaudeProbe, RunnerRegistry } from '@specbridge/runners';
import type { LocalModelManager } from '@specbridge/runners';
import type {
  AgentContractRole,
  CriticOutput,
  DiagnoserOutput,
  PlannerOutput,
  ReplannerOutput,
} from '../agents/contracts.js';
import { replannerOutputToCandidate, plannerOutputToCandidate } from '../agents/contracts.js';
import {
  buildClassifierPacket,
  buildCriticPacket,
  buildDiagnoserPacket,
  buildPlannerPacket,
  buildReplannerPacket,
} from '../agents/prompts.js';
import type { ContextShape } from '@specbridge/context';
import { buildTaskContextPackage } from '../context/selection-service.js';
import { renderMaterializedContext, renderPointerContext } from '../context/packet.js';
import { OrchestrationError } from '../errors.js';
import { executionPlanSchema } from '../state.js';
import type { ExecutionPlan } from '../state.js';
import { resolveDelegatedAuthority, screenReplanForApprovedIntentImpact } from '../jobs/authority.js';
import { escalateAuthority } from '../jobs/autonomous-states.js';
import { findNode } from '../jobs/graph.js';
import type { JobDeps } from '../jobs/job-service.js';
import {
  activeGraph,
  applyDiagnosis,
  askClarification,
  beginExecutorDispatch,
  beginPlanning,
  blockJob,
  buildJobGraph,
  checkpointJob,
  clearRetryWait,
  completeExecutorDispatch,
  completeJobIfDone,
  countLocalInferenceCall,
  noteEscalation,
  recordClassification,
  recordCriticVerdict,
  recordJobEvent,
  recordPlan,
  recordRoleFailure,
  requireJobState,
  resumeJob,
  supersedeNode,
} from '../jobs/index.js';
import { readNodePlan, storeAgentResult } from '../jobs/store.js';
import type { JobGraph, JobNode, JobState } from '../jobs/state.js';
import { escalationAllowed, resolveWorkers } from '../jobs/routing.js';
import { isFinalJobStatus } from '../jobs/vocabulary.js';
import { scheduleNext } from '../jobs/scheduler.js';
import type { SchedulerDecision } from '../jobs/scheduler.js';
import { jobDir } from '../jobs/store.js';
import { findMissionForSpec, readContractRegistry } from '@specbridge/mission';
import { driveObjective } from '../objectives/objective-driver.js';
import type { SecondaryObjectiveBuilderSelection } from '../objectives/secondary-builder.js';
import {
  deferJobForQuota,
  promoteNodeForQuotaOvertake,
  recordObjectiveWorkerAttempt,
} from '../jobs/job-service.js';
import type { QuotaTelemetryProvider } from '../quota/telemetry.js';
import type { SchedulingDecisionRecord } from '../scheduling/decisions.js';
import { appendSchedulingDecision } from '../scheduling/decisions.js';
import {
  ADAPTIVE_DECISION_SCHEMA_VERSION,
  appendAdaptiveDecision,
} from '../adaptive/decisions.js';
import type { LocalExecutionResult, LocalExecutorInference } from '../scheduling/local-execution.js';
import { dispatchLocalExecution } from '../scheduling/local-execution.js';
import type { LocalHarnessExecutionResult } from '../scheduling/local-harness.js';
import { dispatchLocalHarnessExecution } from '../scheduling/local-harness.js';
import type { LocalHarnessBinding } from '../scheduling/local-binding.js';
import type { ApiHarnessBinding } from '../scheduling/api-binding.js';
import { dispatchApiHarnessExecution } from '../scheduling/api-harness.js';
import {
  bindApiBudgetReservation,
  reconcileApiBudget,
  reserveApiBudget,
  summarizeApiBudget,
  readApiBudgetState,
} from '../scheduling/api-budget.js';
import { computeObservedApiCost } from '../scheduling/api-cost.js';
import {
  consumeApiSpendApproval,
  requestApiSpendApproval,
  taskSpendFingerprint,
} from '../scheduling/api-approval.js';
import type { NodeLaneRouting } from '../scheduling/scheduler.js';
import { reconstructTaskContext } from '../survival/reconstruction.js';
import { createTaskCheckpoint } from '../survival/service.js';
import { readLatestTaskCheckpoint } from '../survival/store.js';
import type { BuiltLaneContext, SchedulingRuntime } from './scheduling-runtime.js';
import {
  buildLaneContext,
  createSchedulingRuntime,
  estimateNodeContextRatio,
  localExecutorAttemptsUsed,
} from './scheduling-runtime.js';
import { createLocalManager, runLargeRole, runLocalRole } from './workers.js';
import type { RoleWorkerResult } from './workers.js';
import type { ExecutorDispatchResult } from './executor-dispatch.js';
import { dispatchExecutor } from './executor-dispatch.js';
import type { ExecutionLane } from '../scheduling/vocabulary.js';
import { isSubscriptionExhausted } from '../scheduling/vocabulary.js';
import type { ExecutorReliabilityInput } from '../jobs/job-service.js';
import type { AcceptanceCriterion, CriteriaEvidence, RecoveryResource } from '../reliability/index.js';
import { listFailureAssessments, readTaskReliabilityState } from '../reliability/index.js';
import type { ResearchBridge } from '../research/index.js';
import {
  evaluateRuntimeResearchTrigger,
  listResearchRecords,
  recordResearchLifecycleEffect,
  recordResearchReplanTelemetry,
  renderResearchEvidence,
} from '../research/index.js';

/**
 * The long-running job driver.
 *
 * A foreground persistent loop: schedule → dispatch one bounded worker →
 * fold the result back through the job service → checkpoint → repeat, until
 * the deterministic scheduler says the job is complete, blocked, waiting on
 * a human, or final. Every decision, dispatch, and outcome lands in
 * persisted job state first — the process can die at any point and
 * `resumeJob` reconstructs an honest continuation with no conversational
 * memory.
 *
 * The driver owns exactly two runtime resources: the shared local model
 * server (started lazily, stopped on exit) and the abort signal. It owns no
 * decisions: those come from the scheduler and the service, where they are
 * tested.
 */

export interface DriverDeps extends JobDeps {
  registry: RunnerRegistry;
  /** Test/embedding seam for the optional research provider. */
  researchBridge?: ResearchBridge | undefined;
  /** Phase 4 explicit-only Objective builder backend selection. */
  secondaryObjectiveBuilder?: SecondaryObjectiveBuilderSelection | undefined;
}

export interface DriverEvent {
  kind:
    | 'decision'
    | 'role-started'
    | 'role-finished'
    | 'executor-started'
    | 'executor-finished'
    | 'waiting'
    | 'local-model'
    | 'note';
  message: string;
}

export interface DriveOptions {
  signal?: AbortSignal | undefined;
  onEvent?: ((event: DriverEvent) => void) | undefined;
  /** Injectable sleep (tests). Must resolve early when the signal aborts. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Executor dispatch timeout override. */
  executorTimeoutMs?: number | undefined;
  /** vNext.2 test seam: overrides the configured quota telemetry provider. */
  quotaTelemetryProvider?: QuotaTelemetryProvider | undefined;
  /** vNext.2 test seam: overrides the local execution inference. */
  localExecutorInference?: LocalExecutorInference | undefined;
  /**
   * vNext.4: force one LOCAL execution mode for this run (controlled A/B
   * evaluation and diagnostics). It selects between modes for work that is
   * ALREADY routed local — it can never pull STRONG_REQUIRED work onto the
   * local lane, and never bypasses harness locality verification.
   */
  localExecutionMode?: LocalExecutionMode | undefined;
}

function runtimeResearchForJob(deps: DriverDeps, jobId: string) {
  return listResearchRecords(deps.workspace).records
    .filter((record) =>
      record.scope?.jobId === jobId
      && record.lifecycle?.phase === 'RUNTIME_INVESTIGATION'
      && record.report !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);
}

function recordResearchInformedReplan(
  deps: DriverDeps,
  jobId: string,
  nodeId: string,
  reason: string,
): void {
  const records = runtimeResearchForJob(deps, jobId);
  if (records.length === 0) return;
  const now = (deps.clock ?? (() => new Date()))();
  recordResearchReplanTelemetry(deps.workspace, now);
  for (const record of records) {
    recordResearchLifecycleEffect({
      workspace: deps.workspace,
      config: deps.config,
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.idFactory !== undefined ? { idFactory: deps.idFactory } : {}),
    }, {
      researchId: record.researchId,
      phase: 'RUNTIME_INVESTIGATION',
      reason: `Research informed an accepted replan for ${nodeId}: ${reason}`.slice(0, 1_000),
      effect: 'REPLAN',
      usedBy: nodeId,
    });
  }
  recordJobEvent(deps, jobId, 'research_replan_caused', {
    nodeId,
    researchIds: records.map((record) => record.researchId),
    reason: reason.slice(0, 500),
    authority: 'EVIDENCE_ONLY',
  });
}

export type DriverStop =
  | { kind: 'completed' }
  | { kind: 'blocked'; reason: string }
  /**
   * vNext.10 appends `authority`: the one stop an unattended run may
   * legitimately make. Deliberately distinct from `clarification` — "I need
   * permission" and "I need information" have different audiences, different
   * urgency, and different consequences for the autonomy report.
   */
  | { kind: 'needs-human'; what: 'clarification' | 'plan-review' | 'authority'; detail: string }
  | { kind: 'interrupted' }
  /**
   * vNext.2: no lane can take the remaining work until quota returns. The
   * job is WAITING_RETRY with `retryAt` persisted — resumable, not blocked.
   */
  | { kind: 'deferred'; until: string | null; reason: string }
  | { kind: 'final'; status: string };

export interface DriveResult {
  stop: DriverStop;
  job: JobState;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Bounded requirements+design excerpt for local reasoning packets. */
function specExcerptFor(workspace: WorkspaceInfo, specName: string, maxChars: number): string {
  try {
    const folder = requireSpec(workspace, specName);
    const spec = analyzeSpec(workspace, folder);
    const parts: string[] = [];
    for (const kind of ['requirements', 'bugfix', 'design'] as const) {
      const file = spec.folder.files.find((entry) => entry.kind === kind);
      if (file === undefined) continue;
      try {
        parts.push(`--- ${kind} ---\n${readFileSync(file.path, 'utf8')}`);
      } catch {
        // A racing edit is not fatal for an excerpt.
      }
    }
    return parts.join('\n').slice(0, maxChars);
  } catch {
    return '';
  }
}

let agentResultSequence = 0;

function persistAgentResult(
  deps: DriverDeps,
  jobId: string,
  role: AgentContractRole,
  raw: string,
): string | undefined {
  agentResultSequence += 1;
  const name = `${Date.now()}-${String(agentResultSequence).padStart(4, '0')}-${role.toLowerCase()}.json`;
  try {
    return storeAgentResult(
      deps.workspace,
      jobId,
      name,
      JSON.parse(raw) as Record<string, unknown>,
      { maxBytes: deps.config.orchestration.jobs.maxAgentResultBytes },
    ).ref;
  } catch {
    // A result too large to store is still validated and acted on; the
    // attempt record simply lacks the document reference.
    return undefined;
  }
}

/**
 * Drive one job until it stops. The single public entry point of the
 * long-running orchestrator; `specbridge orchestrate run` is a thin shell
 * around it, and a future daemon would call exactly this.
 */
export async function driveJob(
  deps: DriverDeps,
  jobId: string,
  options: DriveOptions = {},
): Promise<DriveResult> {
  const emit = (kind: DriverEvent['kind'], message: string): void => {
    options.onEvent?.({ kind, message });
  };
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const policy = deps.config.orchestration.jobs;

  // Resume reconciles reality before anything runs (a freshly created job
  // has nothing to reconcile and skips it).
  let job = requireJobState(deps.workspace, jobId);
  if (job.status !== 'CREATED') {
    const resume = await resumeJob(deps, jobId);
    job = resume.job;
    for (const warning of resume.warnings) emit('note', warning);
    if (resume.finalized) {
      return { stop: { kind: 'final', status: job.status }, job };
    }
  }

  // One Claude probe per driver run: the CLI's flag surface cannot change
  // mid-run, and re-probing spawns three processes per reasoning role.
  const probeCache: { probe: ClaudeProbe | undefined } = { probe: undefined };

  const localManager: LocalModelManager | undefined = createLocalManager(deps.config, (event) => {
    emit('local-model', `${event.type}: ${event.detail}`);
    if (event.type === 'ready') {
      recordJobEvent(deps, jobId, 'local_model_started', { detail: event.detail.slice(0, 200) });
    }
    if (event.type === 'stopped' || event.type === 'exited') {
      recordJobEvent(deps, jobId, 'local_model_stopped', {
        kind: event.type,
        detail: event.detail.slice(0, 200),
      });
    }
  });

  // vNext.2 lane scheduling: derived entirely from durable state, telemetry,
  // and configuration; absent (disabled) the loop behaves exactly as vNext.1.
  const missionDriven =
    policy.objectives.enabled === true &&
    findMissionForSpec(deps.workspace, job.specName) !== undefined;
  const schedulingRuntime = createSchedulingRuntime(deps.config, deps.workspace, {
    localManager,
    missionDriven,
    // vNext.5: whether prepaid strong compute exists at all. A roster with
    // no subscription worker is a different gap from an exhausted quota
    // window — it never "resets" — and the planner must be able to tell.
    subscriptionWorkerAvailable: resolveWorkers(deps.config).some(
      (worker) => worker.reasoningTier !== 'LOCAL_SMALL',
    ),
    options: {
      quotaTelemetryProvider: options.quotaTelemetryProvider,
      localExecutorInference: options.localExecutorInference,
      localExecutionMode: options.localExecutionMode,
      signal,
    },
  });

  // The loop itself is budget-bounded by the scheduler; this valve only
  // guards against a decision cycle that never dispatches (a driver bug).
  const maxLoop = policy.budgets.maxAgentRuns * 6 + 50;
  let loops = 0;
  // Consecutive quota defers WITHOUT a known reset time: after a few polls
  // the driver stops (resumable) instead of polling until the loop bound —
  // telemetry without a reset timestamp cannot promise capacity will return.
  let unboundedQuotaDefers = 0;
  /**
   * vNext.5: a paid attempt ran to completion while prepaid capacity came
   * back. The flag exists only so the RETURN to the subscription lane is
   * recorded once — it never influences routing, which the ordinary
   * scheduler decides fresh from live telemetry every pass.
   */
  let apiBridgedWhileMaxReturned = false;

  try {
    for (;;) {
      loops += 1;
      if (loops > maxLoop) {
        blockJob(deps, jobId, {
          category: 'INTERNAL',
          code: 'DRIVER_LOOP_BOUND',
          message: `The driver exceeded ${maxLoop} scheduling cycles without finishing; stopping for inspection.`,
          remediation: ['Inspect the job events; this indicates a scheduling defect, not a task failure.'],
        });
        job = requireJobState(deps.workspace, jobId);
        return { stop: { kind: 'blocked', reason: 'driver loop bound reached' }, job };
      }
      if (signal?.aborted === true) {
        checkpointJob(deps, jobId, 'Interrupted; resume with `specbridge orchestrate run` to continue.');
        job = requireJobState(deps.workspace, jobId);
        return { stop: { kind: 'interrupted' }, job };
      }

      // ONE instant for this whole scheduling pass.
      //
      // `clearRetryWait` and `scheduleNext` both test `retryAt <= now`. Two
      // independent clock reads let `retryAt` fall between them: the job
      // stays WAITING_RETRY while the scheduler concludes the wait elapsed
      // and returns work, and the dispatch then dies on an illegal
      // WAITING_RETRY -> RUNNING transition. Sampling once makes the two
      // gates agree by construction. Reusing this instant across the awaits
      // below is deliberate and safe in one direction only: a slightly stale
      // `now` can defer a pass that could have run, never dispatch one that
      // should have waited.
      const scheduleAt = (deps.clock ?? (() => new Date()))();
      job = clearRetryWait(deps, jobId, scheduleAt);
      const graph = activeGraph(deps, job);
      const workers = resolveWorkers(deps.config);
      let lane: BuiltLaneContext | undefined;
      if (schedulingRuntime !== undefined && graph !== undefined && !isFinalJobStatus(job.status)) {
        lane = await buildLaneContext(schedulingRuntime, deps, jobId, job, graph);
        emitSchedulingTransitions(deps, jobId, schedulingRuntime, lane, emit);
        // Local work continues during a subscription cooldown: promote the
        // identified LOCAL-lane node past its quota-deferred predecessors
        // (recorded), then re-enter scheduling over the updated graph.
        if (lane.overtakeCandidate !== undefined && job.status === 'READY') {
          promoteNodeForQuotaOvertake(deps, jobId, lane.overtakeCandidate);
          emit('note', `quota overtake: ${lane.overtakeCandidate.detail}`);
          job = requireJobState(deps.workspace, jobId);
          continue;
        }
      }
      const decision = scheduleNext({
        job,
        graph,
        policy,
        workers,
        now: scheduleAt,
        scheduling: lane?.context,
      });
      emit('decision', `${decision.kind}${'reason' in decision ? `: ${decision.reason}` : ''}`);
      if (decision.kind !== 'WAIT_QUOTA') unboundedQuotaDefers = 0;

      switch (decision.kind) {
        case 'BUILD_GRAPH': {
          const built = await buildJobGraph(deps, jobId);
          emit('note', `Runtime graph: ${built.graph.nodes.length} node(s) from the approved task plan.`);
          checkpointJob(deps, jobId, 'Graph built; classify and plan the first node.');
          break;
        }

        case 'RUN_ROLE': {
          const outcome = await handleRoleDecision(deps, jobId, decision, {
            localManager,
            probeCache,
            signal,
            emit,
          });
          if (outcome === 'stop-interrupted') {
            checkpointJob(deps, jobId, 'Interrupted during a role run; resume to continue.');
            job = requireJobState(deps.workspace, jobId);
            return { stop: { kind: 'interrupted' }, job };
          }
          checkpointJob(deps, jobId, 'Continue with the next scheduler decision.');
          break;
        }

        case 'DISPATCH_EXECUTOR': {
          const node = graph !== undefined ? findNode(graph, decision.nodeId) : undefined;
          if (node === undefined) {
            throw new OrchestrationError('SBO031', `Node ${decision.nodeId} vanished between scheduling and dispatch.`);
          }
          const laneName = decision.lane;
          const laneRouting = decision.laneRouting;
          // vNext.4: the lane is already decided; this is only HOW the local
          // lane spends its compute. `localExecution` is present exactly when
          // the lane decision was LOCAL.
          const localExecution = laneName === 'LOCAL' ? laneRouting?.localExecution : undefined;
          // vNext.5: the API lane runs the SAME harness execution mode as
          // the local lane's agentic path. Mode, lane, runner, and compute
          // locality stay four separate values — "HARNESS" never implies
          // paid, and "API" never implies a particular runtime.
          const apiLane = laneName === 'API' && schedulingRuntime !== undefined;
          const apiBridge = apiLane ? laneRouting?.apiBridge : undefined;
          const executionMode = apiLane ? 'HARNESS' : (localExecution?.mode ?? undefined);
          const harnessProfileName = apiLane
            ? (schedulingRuntime?.apiBinding.profileName ?? undefined)
            : executionMode === 'HARNESS'
              ? (localExecution?.harness?.profileName ?? undefined)
              : undefined;
          emit(
            'executor-started',
            `${decision.mode} task ${decision.taskId} via ${decision.worker.workerId}${laneName !== undefined ? ` [${laneName} lane${executionMode !== undefined ? `/${executionMode}` : ''}]` : ''}`,
          );

          // vNext.2: persist the routing decision + observability BEFORE the
          // dispatch, then capture quota/context observations for the ledger.
          let schedulingDecisionId: string | undefined;
          let quotaBefore:
            | { fiveHourRemainingRatio: number | null; weeklyRemainingRatio: number | null }
            | undefined;
          let contextBefore: number | null = null;
          if (schedulingRuntime !== undefined && lane !== undefined && laneName !== undefined && laneRouting !== undefined) {
            schedulingDecisionId = persistLaneDecision(deps, jobId, {
              nodeId: node.nodeId,
              taskId: node.parentTaskId,
              selectedLane: laneName,
              selectedProvider:
                laneName === 'LOCAL' || laneName === 'API'
                  ? (harnessProfileName ?? decision.worker.workerId)
                  : (decision.worker.runnerProfile ?? decision.worker.workerId),
              reasonCode: laneRouting.routing.reasonCode,
              detail: laneRouting.routing.detail,
              deferUntil: null,
              laneRouting,
              lane,
              ...(schedulingRuntime !== undefined
                ? {
                    harnessBinding: schedulingRuntime.harnessBinding,
                    apiBinding: schedulingRuntime.apiBinding,
                  }
                : {}),
            });
            if (laneName !== 'API') {
              recordJobEvent(deps, jobId, laneName === 'LOCAL' ? 'task_routed_local' : 'task_routed_subscription', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                reasonCode: laneRouting.routing.reasonCode,
                suitability: laneRouting.suitability.class,
                mode: lane.forecast.schedulerMode,
                ...(executionMode !== undefined ? { executionMode } : {}),
              });
            }
            // vNext.5: the first strong dispatch after a paid bridge, once
            // prepaid capacity is healthy again, is recorded explicitly.
            // "API is a bridge, not the preferred strong lane" must be
            // visible in the timeline, not merely true in the code — a
            // provider that succeeded once must never become sticky.
            if (apiBridgedWhileMaxReturned && laneName === 'SUBSCRIPTION') {
              recordJobEvent(deps, jobId, 'api_next_task_returned_to_subscription', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                reasonCode: laneRouting.routing.reasonCode,
                detail:
                  'Prepaid subscription capacity is healthy again; strong work routes back to it ' +
                  'rather than continuing on the paid lane.',
              });
              apiBridgedWhileMaxReturned = false;
            }
            if (localExecution !== undefined && executionMode !== undefined) {
              // One structured record of the mode decision, with the reason
              // and the shape that produced it: "why did this task use the
              // harness (or not)?" must be answerable from the timeline.
              recordJobEvent(deps, jobId, 'local_execution_mode_selected', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                executionMode,
                shape: localExecution.shape,
                reasonCode: localExecution.reasonCode ?? 'UNKNOWN',
                suitability: laneRouting.suitability.class,
              });
              if (executionMode === 'HARNESS') {
                recordJobEvent(deps, jobId, 'local_harness_selected', {
                  nodeId: node.nodeId,
                  taskId: node.parentTaskId,
                  profile: localExecution.harness?.profileName ?? 'unknown',
                  runner: localExecution.harness?.runner ?? 'unknown',
                  computeLocality: localExecution.harness?.locality ?? 'UNKNOWN',
                  reasonCode: localExecution.reasonCode ?? 'UNKNOWN',
                });
              } else if (localExecution.reasonCode === 'LOCAL_HARNESS_NOT_VERIFIED_LOCAL') {
                recordJobEvent(deps, jobId, 'local_harness_locality_rejected', {
                  nodeId: node.nodeId,
                  taskId: node.parentTaskId,
                  bindingStatus: schedulingRuntime?.harnessBinding.status ?? 'UNKNOWN',
                  computeLocality: schedulingRuntime?.harnessBinding.locality ?? 'UNKNOWN',
                  detail: (schedulingRuntime?.harnessBinding.problems[0] ?? 'not verified local').slice(0, 300),
                });
              } else if (localExecution.reasonCode === 'LOCAL_HARNESS_UNAVAILABLE') {
                recordJobEvent(deps, jobId, 'local_harness_unavailable', {
                  nodeId: node.nodeId,
                  taskId: node.parentTaskId,
                  bindingStatus: schedulingRuntime?.harnessBinding.status ?? 'UNKNOWN',
                  detail: (schedulingRuntime?.harnessBinding.problems[0] ?? 'no bound harness').slice(0, 300),
                });
              }
            }
            if (laneName === 'SUBSCRIPTION' && laneRouting.routing.admission?.crossesReset === true) {
              recordJobEvent(deps, jobId, 'cross_reset_admitted', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                preResetBurnRatio: laneRouting.routing.admission.preResetBurnRatio,
                expectedWallTimeMs: laneRouting.estimate.expectedWallTimeMs,
                timeToResetMs: lane.forecast.timeToFiveHourResetMs,
              });
            }
            quotaBefore = {
              fiveHourRemainingRatio: lane.forecast.fiveHourRemainingRatio,
              weeklyRemainingRatio: lane.forecast.weeklyRemainingRatio,
            };
            contextBefore = estimateNodeContextRatio(deps, jobId, node.nodeId);
            if (decision.compactFirst === true) {
              // Context admission demanded a compact-before-dispatch: rebuild
              // a bounded package from durable state (the vNext.1 path); its
              // compaction passes are recorded for the timeline.
              const reconstructed = reconstructTaskContext(deps, { jobId, nodeId: node.nodeId });
              recordJobEvent(deps, jobId, 'context_compaction_before_dispatch', {
                nodeId: node.nodeId,
                contextUsageRatio: contextBefore,
                passes: reconstructed.assembled.compactions.map((record) => record.level),
                estimatedTokens: reconstructed.assembled.package.usage.estimatedTokens,
              });
              emit('note', `context compacted before dispatch (${reconstructed.assembled.compactions.length} pass(es))`);
            }
          }

          // vNext.5: reserve API budget BEFORE any attempt record exists.
          //
          // The ordering matters. A refusal here has cost nothing and left
          // nothing to reconcile; a refusal after the attempt started would
          // leave a paid attempt whose funding is in doubt. The reservation
          // is also re-checked against freshly read durable state inside its
          // own lock, so a second task cannot have spent the same dollar in
          // between the planner's look and this one.
          let apiReservationId: string | undefined;
          let apiApprovalId: string | undefined;
          // Fail closed before any money moves. Reaching DISPATCH_EXECUTOR
          // with lane API and no resolvable harness profile should be
          // impossible — the routing requires an available binding — but the
          // fallthrough it would cause (a SUBSCRIPTION worker running under a
          // record that says API) is exactly the kind of silent lane
          // reclassification this phase forbids. So it is checked, not
          // assumed.
          if (apiLane && (harnessProfileName === undefined || apiBridge === undefined)) {
            throw new OrchestrationError(
              'SBO031',
              `Task ${decision.taskId} routed to the API lane, but no bound API harness profile ` +
                'resolved at dispatch. Refusing to run it on another lane under an API record.',
              {
                remediation: [
                  'Inspect `specbridge orchestrate scheduler <jobId>`; this indicates a scheduling defect, not a task failure.',
                ],
              },
            );
          }
          if (apiLane && schedulingRuntime !== undefined && apiBridge !== undefined) {
            const apiPolicy = schedulingRuntime.policy.api;
            // The gap is recorded whether it leads to a wait or a spend, so
            // the timeline reads the same either way: a gap was detected,
            // and here is what was decided about it.
            recordJobEvent(deps, jobId, 'api_gap_detected', {
              nodeId: node.nodeId,
              taskId: node.parentTaskId,
              gapReason: apiBridge.gap.reason,
              expectedAvailableAt: apiBridge.gap.expectedAvailableAt,
              estimatedGapDurationMs: apiBridge.gap.timeUntilAvailableMs,
              confidence: apiBridge.gap.confidence,
              delaySensitivity: apiBridge.delaySensitivity.level,
              decision: apiBridge.decision,
              reasonCode: apiBridge.reasonCode,
            });
            const reservation = reserveApiBudget({
              workspace: deps.workspace,
              jobId,
              nodeId: node.nodeId,
              taskId: node.parentTaskId,
              policy: apiPolicy.budget,
              safeCostUsd: apiBridge.cost?.safeCostUsd ?? null,
              profileName: schedulingRuntime.apiBinding.profileName,
              now: (deps.clock ?? (() => new Date()))(),
              reservationId: `ar-${((deps.idFactory ?? (() => `${Date.now()}`))())}`.slice(0, 64),
              detail: apiBridge.detail,
            });
            if (!reservation.ok) {
              // The budget refused between planning and dispatch. Nothing is
              // spent, nothing is dispatched, and the task stays durably
              // pending with the refusal on record.
              recordJobEvent(deps, jobId, 'api_budget_exceeded', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                refusal: reservation.admission.refusal ?? 'UNKNOWN',
                remainingUsd: reservation.admission.job.remainingUsd,
                detail: reservation.admission.detail.slice(0, 300),
              });
              if (
                reservation.admission.refusal === 'JOB_CEILING' ||
                reservation.admission.refusal === 'JOB_ATTEMPTS'
              ) {
                recordJobEvent(deps, jobId, 'api_budget_exhausted', {
                  jobId,
                  refusal: reservation.admission.refusal,
                  encumberedUsd: reservation.admission.job.encumberedUsd,
                });
              }
              emit('waiting', `api budget refused: ${reservation.admission.detail}`);
              job = deferJobForQuota(deps, jobId, {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                until: apiBridge.gap.expectedAvailableAt,
                reasonCode: 'API_BUDGET_EXCEEDED',
                detail: reservation.admission.detail,
                pollMs: schedulingRuntime.policy.deferPollMs,
              });
              checkpointJob(
                deps,
                jobId,
                'API budget refused the bridge; the task waits for subscription capacity.',
              );
              job = requireJobState(deps.workspace, jobId);
              return {
                stop: {
                  kind: 'deferred',
                  until: job.retryAt ?? null,
                  reason: reservation.admission.detail,
                },
                job,
              };
            }
            apiReservationId = reservation.reservation.reservationId;
            apiApprovalId = apiBridge.approval?.approval?.approvalId;
            recordJobEvent(deps, jobId, 'api_budget_reserved', {
              nodeId: node.nodeId,
              taskId: node.parentTaskId,
              reservationId: apiReservationId,
              reservedUsd: reservation.reservation.reservedUsd,
              remainingUsd: reservation.admission.job.remainingUsd,
              profile: schedulingRuntime.apiBinding.profileName ?? 'unknown',
            });
            emit(
              'note',
              `api budget reserved $${reservation.reservation.reservedUsd.toFixed(4)} for task ${node.parentTaskId}`,
            );
          }

          beginExecutorDispatch(deps, jobId, {
            nodeId: decision.nodeId,
            mode: decision.mode,
            workerId: decision.worker.workerId,
            // The durable attempt records the true provider identity (the
            // runner profile) so the execution ledger attributes correctly.
            // A LOCAL harness attempt records the HARNESS profile as its
            // provider — the lane stays LOCAL, and the two remain separate
            // fields rather than one compound value.
            provider:
              harnessProfileName ?? decision.worker.runnerProfile ?? decision.worker.workerId,
            ...(apiLane && schedulingRuntime?.apiBinding.model != null
              ? { model: schedulingRuntime.apiBinding.model }
              : localExecution?.harness?.model != null
                ? { model: localExecution.harness.model }
                : {}),
            ...(laneName !== undefined ? { lane: laneName } : {}),
            ...(executionMode !== undefined ? { executionMode } : {}),
            // vNext.8: the grouping key and context strategy travel with the
            // observation. Recorded in EVERY adaptive mode, including
            // HEURISTIC — a workspace that switches the adaptive scheduler on
            // later should find comparable history already waiting, not start
            // learning from zero.
            ...(laneRouting?.signature !== undefined
              ? { taskSignature: laneRouting.signature.key }
              : {}),
            contextStrategy: deps.config.orchestration.jobs.context.efficiency.strategy,
            ...(localExecution !== undefined
              ? {
                  executionShape: localExecution.shape,
                  computeLocality:
                    executionMode === 'HARNESS'
                      ? (localExecution.harness?.locality ?? 'UNKNOWN')
                      : 'LOCAL',
                }
              : {}),
            // vNext.5 paid-attempt attribution. Every field is recorded, and
            // every one is separate: the lane says it was paid, the gap says
            // why prepaid capacity could not run it, the cost fields say what
            // was authorized, and none of them is derived from another.
            ...(apiLane && apiBridge !== undefined && schedulingRuntime !== undefined
              ? {
                  executionShape: 'AGENTIC',
                  computeLocality: schedulingRuntime.apiBinding.locality,
                  apiSpendMode: schedulingRuntime.policy.api.spendMode,
                  gapReason: apiBridge.gap.reason,
                  ...(apiBridge.gap.expectedAvailableAt !== null
                    ? { subscriptionAvailableAt: apiBridge.gap.expectedAvailableAt }
                    : {}),
                  estimatedGapDurationMs: apiBridge.gap.timeUntilAvailableMs,
                  costSource: apiBridge.cost?.costSource ?? 'UNKNOWN',
                  ...(apiBridge.cost?.pricingSource != null
                    ? { pricingProfile: apiBridge.cost.pricingSource }
                    : {}),
                  delaySensitivity: apiBridge.delaySensitivity.level,
                  estimatedCostUsd: apiBridge.cost?.estimatedCostUsd ?? null,
                  reservedCostUsd: apiBridge.cost?.safeCostUsd ?? null,
                  ...(apiReservationId !== undefined
                    ? { apiBudgetReservationId: apiReservationId }
                    : {}),
                  ...(apiApprovalId !== undefined ? { apiApprovalId } : {}),
                }
              : {}),
            ...(laneRouting !== undefined
              ? {
                  localSuitability: laneRouting.suitability.class,
                  taskCategory: laneRouting.suitability.category,
                }
              : {}),
            ...(schedulingDecisionId !== undefined ? { schedulingDecisionId } : {}),
            ...(quotaBefore !== undefined ? { quotaBefore } : {}),
            ...(contextBefore !== null ? { contextUsageBefore: contextBefore } : {}),
          });
          const startedAt = (deps.clock ?? (() => new Date()))().toISOString();

          // vNext.5: checkpoint BEFORE the paid handoff.
          //
          // The paid attempt must be able to start from canonical durable
          // state rather than from a Claude conversation that no longer
          // exists — so the transition subscription-unavailable → API is
          // recorded as an explicit handoff checkpoint that carries forward
          // decisions, failed approaches, and known test state. If the paid
          // process then dies, this is what the next attempt resumes from.
          if (apiLane && schedulingRuntime !== undefined && apiBridge !== undefined) {
            const attemptId = requireJobState(deps.workspace, jobId).currentAttemptId;
            if (attemptId !== undefined) {
              if (apiReservationId !== undefined) {
                bindApiBudgetReservation(
                  deps.workspace,
                  jobId,
                  apiReservationId,
                  attemptId,
                  (deps.clock ?? (() => new Date()))(),
                );
              }
              if (apiApprovalId !== undefined) {
                // Approvals are single-use and bound to one attempt: an
                // authorization spent is an authorization gone.
                try {
                  consumeApiSpendApproval(deps.workspace, jobId, apiApprovalId, attemptId);
                } catch {
                  // The approval record is observability at this point; the
                  // dispatch was already authorized against it.
                }
              }
              writeApiHandoffCheckpoint(deps, jobId, node, attemptId, apiBridge);
              recordJobEvent(deps, jobId, 'api_task_dispatched', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                attemptId,
                profile: schedulingRuntime.apiBinding.profileName ?? 'unknown',
                runner: schedulingRuntime.apiBinding.runner ?? 'unknown',
                model: schedulingRuntime.apiBinding.model ?? 'unknown',
                computeLocality: schedulingRuntime.apiBinding.locality,
                spendMode: schedulingRuntime.policy.api.spendMode,
                gapReason: apiBridge.gap.reason,
                estimatedGapDurationMs: apiBridge.gap.timeUntilAvailableMs,
                delaySensitivity: apiBridge.delaySensitivity.level,
                estimatedCostUsd: apiBridge.cost?.estimatedCostUsd ?? null,
                reasonCode: laneRouting?.routing.reasonCode ?? 'API_GAP_BRIDGE_SELECTED',
              });
            }
          }
          // Later tasks run over earlier verified (uncommitted) changes, and
          // a repair runs over its own failed attempt: same rule as `--all`.
          const allowDirty =
            decision.mode === 'repair' ||
            (graph?.nodes.some((candidate) => candidate.status === 'COMPLETED') ?? false) ||
            node.attempts.some((attempt) => attempt.role === 'EXECUTOR') ||
            node.attempts.some((attempt) => attempt.role === 'BUILDER');
          // Mission-driven specs route the objective through the objective
          // runtime (decompose → build in isolation → evaluate → aggregate →
          // single-writer integration); legacy specs keep the direct
          // executor path byte-identical.
          const mission =
            policy.objectives.enabled === true
              ? findMissionForSpec(deps.workspace, job.specName)
              : undefined;
          // vNext.4: one LOCAL lane, two execution modes. The harness branch
          // runs an agentic attempt inside the same evidence pipeline; the
          // direct branch is the vNext.2 path, byte-identical.
          const localHarnessLane =
            laneName === 'LOCAL' && harnessProfileName !== undefined && schedulingRuntime !== undefined;
          const localLane =
            laneName === 'LOCAL' &&
            !localHarnessLane &&
            schedulingRuntime !== undefined &&
            schedulingRuntime.localInference !== undefined;
          const apiHarnessLane =
            apiLane && harnessProfileName !== undefined && schedulingRuntime !== undefined;
          const harnessCheckpoint =
            localHarnessLane || apiHarnessLane
              ? readLatestTaskCheckpoint(deps.workspace, jobId, node.nodeId)
              : undefined;

          // vNext.7: build the shape-appropriate context package.
          //
          // The SHAPE is decided by what the worker can do for itself, never
          // by which provider it is: a tool-capable harness receives pointers
          // and reads current bytes; a direct model with no tools receives a
          // bounded, materialized working set. Sending both to either would
          // pay for the same information twice.
          //
          // Under the LEGACY default this call is skipped entirely and every
          // dispatch below is byte-identical to vNext.6.
          const contextSupplement =
            deps.config.orchestration.jobs.context.efficiency.strategy === 'LEGACY'
              ? undefined
              : await buildDispatchContext(deps, {
                  jobId,
                  node,
                  shape: localHarnessLane || apiHarnessLane ? 'POINTER' : 'MATERIALIZED',
                  ...(laneName !== undefined ? { lane: laneName } : {}),
                  ...(executionMode !== undefined ? { executionMode } : {}),
                  ...(harnessProfileName !== undefined ? { runner: harnessProfileName } : {}),
                  emit: (message) => emit('note', message),
                });
          const dispatch = apiHarnessLane
            ? // vNext.5: the paid continuity bridge. Same runner, same
              // evidence pipeline, same completion authority — the only
              // differences are who is billed and what bounds the attempt.
              await dispatchApiHarnessExecution({
                workspace: deps.workspace,
                config: deps.config,
                registry: deps.registry,
                node,
                specName: job.specName,
                jobId,
                mode: decision.mode,
                allowDirty,
                profileName: harnessProfileName as string,
                // The lean canonical bootstrap: a fresh remote session has
                // never seen this job, and nothing on disk records what was
                // already decided, tried, and ruled out.
                ...(harnessCheckpoint !== undefined ? { checkpoint: harnessCheckpoint } : {}),
                // vNext.7: the paid lane is where data minimization matters
                // most. Pointers, never bodies — the harness fetches what it
                // needs, and unrelated repository content never leaves the
                // machine at all.
                ...(contextSupplement?.pointers !== undefined
                  ? {
                      repositoryPointers: contextSupplement.pointers,
                      contextPlanId: contextSupplement.planId,
                    }
                  : {}),
                maxWallTimeMs: (schedulingRuntime as SchedulingRuntime).apiBinding.maxWallTimeMs,
                ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
                ...(deps.idFactory !== undefined ? { idFactory: deps.idFactory } : {}),
                ...(signal !== undefined ? { signal } : {}),
                onProgress: (message) => emit('note', message),
              })
            : localHarnessLane
            ? await dispatchLocalHarnessExecution({
                workspace: deps.workspace,
                config: deps.config,
                registry: deps.registry,
                node,
                specName: job.specName,
                jobId,
                mode: decision.mode,
                allowDirty,
                profileName: harnessProfileName as string,
                // Canonical memory for the bootstrap package: the harness
                // reads the repository itself, but nothing on disk records
                // what was already decided, tried, and ruled out.
                ...(harnessCheckpoint !== undefined ? { checkpoint: harnessCheckpoint } : {}),
                ...(contextSupplement?.pointers !== undefined
                  ? {
                      repositoryPointers: contextSupplement.pointers,
                      contextPlanId: contextSupplement.planId,
                    }
                  : {}),
                maxWallTimeMs: schedulingRuntime.harnessBinding.maxWallTimeMs,
                ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
                ...(deps.idFactory !== undefined ? { idFactory: deps.idFactory } : {}),
                ...(signal !== undefined ? { signal } : {}),
                onProgress: (message) => emit('note', message),
              })
            : localLane
            ? await dispatchLocalExecution({
                workspace: deps.workspace,
                config: deps.config,
                node,
                specName: job.specName,
                mode: decision.mode,
                allowDirty,
                inference: schedulingRuntime.localInference as NonNullable<
                  SchedulingRuntime['localInference']
                >,
                maxCorrections: policy.maxLocalOutputCorrections,
                // vNext.7: a direct model has no tools, so the selected
                // working set is the only way it ever sees current source.
                ...(contextSupplement?.rendered !== undefined
                  ? {
                      repositoryContext: contextSupplement.rendered,
                      contextPlanId: contextSupplement.planId,
                    }
                  : {}),
                ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
                ...(deps.idFactory !== undefined ? { idFactory: deps.idFactory } : {}),
                ...(signal !== undefined ? { signal } : {}),
                onProgress: (message) => emit('note', message),
                onInferenceCall: () => countLocalInferenceCall(deps, jobId),
              })
            : mission !== undefined
              ? await driveObjective({
                  workspace: deps.workspace,
                  config: deps.config,
                  jobId,
                  specName: job.specName,
                  node,
                  mission,
                  policy,
                  workers: resolveWorkers(deps.config),
                  allowDirty,
                  runnerProfile: decision.worker.runnerProfile,
                  localManager,
                  probeCache,
                  ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
                  ...(deps.idFactory !== undefined ? { idFactory: deps.idFactory } : {}),
                  ...(signal !== undefined ? { signal } : {}),
                  ...(deps.researchBridge !== undefined ? { researchBridge: deps.researchBridge } : {}),
                  ...(deps.secondaryObjectiveBuilder !== undefined
                    ? { secondaryBuilder: deps.secondaryObjectiveBuilder }
                    : {}),
                  onProgress: (message) => emit('note', message),
                  countWorkerRun: (run) =>
                    recordObjectiveWorkerAttempt(deps, jobId, { nodeId: node.nodeId, ...run }),
                  recordEvent: (type, payload) =>
                    recordJobEvent(deps, jobId, type as never, payload),
                })
              : await dispatchExecutor({
                  workspace: deps.workspace,
                  config: deps.config,
                  registry: deps.registry,
                  node,
                  specName: job.specName,
                  mode: decision.mode,
                  allowDirty,
                  runnerProfile: decision.worker.runnerProfile,
                  ...(options.executorTimeoutMs !== undefined ? { timeoutMs: options.executorTimeoutMs } : {}),
                  ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
                  ...(deps.idFactory !== undefined ? { idFactory: deps.idFactory } : {}),
                  ...(signal !== undefined ? { signal } : {}),
                  onProgress: (message) => emit('note', message),
                });

          // vNext.2: local failures stay visible, and a declined/exhausted
          // local attempt escalates STICKILY before the outcome is folded, so
          // the very next routing pass already prefers the strong lane.
          //
          // vNext.4 adds one intermediate transition. A direct attempt that
          // failed for lack of REPOSITORY KNOWLEDGE has not shown that local
          // intelligence is insufficient — it has shown that a model with no
          // tools cannot see the repository. When a verified-local harness is
          // bound and the shared local budget still has room, that becomes a
          // LOCAL → LOCAL mode change instead of spending Max quota.
          if (localLane) {
            const localResult = dispatch as LocalExecutionResult;
            if (localResult.failure !== undefined) {
              recordJobEvent(deps, jobId, 'local_attempt_failed', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                category: localResult.failure.category,
                escalated: localResult.escalated,
                executionMode: 'DIRECT_MODEL',
              });
            }
            const harnessCanTakeOver =
              schedulingRuntime !== undefined &&
              schedulingRuntime.harnessBinding.available &&
              schedulingRuntime.policy.localExecution.strategy !== 'DIRECT_ONLY' &&
              localExecutorAttemptsUsed(deps, jobId, node.nodeId) < schedulingRuntime.policy.maxLocalAttempts;
            const needsRepositoryTools =
              localResult.failure !== undefined &&
              directFailureNeedsRepositoryTools(localResult);
            if (harnessCanTakeOver && needsRepositoryTools) {
              noteEscalation(deps, jobId, {
                nodeId: node.nodeId,
                role: 'EXECUTOR',
                reason: 'LOCAL_DIRECT_TO_HARNESS',
                detail: (localResult.escalationReason ?? localResult.failure?.message ?? 'the direct attempt lacked repository knowledge').slice(0, 500),
              });
              recordJobEvent(deps, jobId, 'local_direct_to_harness_escalated', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                category: localResult.failure?.category ?? 'unknown',
                detail: (localResult.escalationReason ?? 'the direct attempt lacked repository knowledge').slice(0, 300),
              });
            } else if (localResult.escalated) {
              noteEscalation(deps, jobId, {
                nodeId: node.nodeId,
                role: 'EXECUTOR',
                reason: 'LOCAL_EXECUTION_ESCALATED',
                detail: (localResult.escalationReason ?? localResult.failure?.message ?? 'local execution declined').slice(0, 500),
              });
              recordJobEvent(deps, jobId, 'local_escalation_triggered', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                detail: (localResult.escalationReason ?? 'bounded local attempts exhausted').slice(0, 300),
              });
            }
          }

          // vNext.4: harness attempt outcomes. The distinction that matters
          // here is infrastructure vs intelligence: a runtime that crashed
          // proves nothing about the task, and spending subscription quota to
          // "answer" a crashed process is exactly the waste §40 forbids.
          if (localHarnessLane) {
            const harnessResult = dispatch as LocalHarnessExecutionResult;
            if (harnessResult.failure !== undefined) {
              recordJobEvent(deps, jobId, 'local_attempt_failed', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                category: harnessResult.failure.category,
                escalated: harnessResult.escalated,
                executionMode: 'HARNESS',
                failureKind: harnessResult.failureKind ?? 'UNKNOWN',
              });
            }
            const localAttemptsAfter = localExecutorAttemptsUsed(deps, jobId, node.nodeId) + 1;
            const budgetSpent =
              schedulingRuntime !== undefined &&
              localAttemptsAfter >= schedulingRuntime.policy.maxLocalAttempts;
            const intelligenceFailure =
              harnessResult.failure !== undefined && harnessResult.failureKind === 'INTELLIGENCE';
            if (intelligenceFailure && (harnessResult.escalated || budgetSpent)) {
              noteEscalation(deps, jobId, {
                nodeId: node.nodeId,
                role: 'EXECUTOR',
                reason: 'LOCAL_EXECUTION_ESCALATED',
                detail: (harnessResult.escalationReason ?? harnessResult.failure?.message ?? 'the local harness could not implement the task').slice(0, 500),
              });
              recordJobEvent(deps, jobId, 'local_harness_to_subscription_escalated', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                localAttempts: localAttemptsAfter,
                detail: (harnessResult.escalationReason ?? 'local harness attempts exhausted').slice(0, 300),
              });
              recordJobEvent(deps, jobId, 'local_escalation_triggered', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                detail: 'the local harness did not produce a verifiable implementation',
              });
            }
          }

          // Capture post-dispatch quota/context observations for the ledger.
          let extraMetrics: Record<string, number | null> | undefined;
          if (schedulingRuntime !== undefined && lane !== undefined) {
            const after = await schedulingRuntime.manager.snapshot();
            extraMetrics = {
              fiveHourQuotaAfter: after.fiveHour?.remainingRatio ?? null,
              weeklyQuotaAfter: after.weekly?.remainingRatio ?? null,
              contextUsageAfter: estimateNodeContextRatio(deps, jobId, node.nodeId),
            };
          }
          if (localHarnessLane || apiHarnessLane) {
            // Observed harness activity. Anything the runtime did not report
            // stays null: an invented zero would quietly corrupt every later
            // direct-vs-harness comparison.
            const observed = (dispatch as LocalHarnessExecutionResult).observed;
            extraMetrics = {
              ...(extraMetrics ?? {}),
              toolCalls: observed.toolCalls,
              commandRuns: observed.commandRuns,
              compactions: observed.compactions,
              cachedTokens: observed.cachedInputTokens,
              filesRead: observed.filesRead,
            };
          }

          // vNext.5: reconcile the paid attempt's budget reservation.
          //
          // Two honest outcomes only. If the provider reported a cost, or
          // reported usage a configured price table can price, the
          // reservation COMMITS at that figure. Otherwise it moves to
          // UNKNOWN and KEEPS its hold — a paid attempt that cannot say what
          // it used is not evidence that it used nothing.
          if (apiHarnessLane && schedulingRuntime !== undefined) {
            const apiResult = dispatch as LocalHarnessExecutionResult;
            const observedCost = computeObservedApiCost({
              ...(apiResult.usage !== undefined
                ? {
                    usage: {
                      inputTokens: apiResult.usage.inputTokens,
                      outputTokens: apiResult.usage.outputTokens,
                      cachedInputTokens: apiResult.observed.cachedInputTokens,
                      costUsd: apiResult.usage.costUsd,
                    },
                  }
                : {}),
              pricing: schedulingRuntime.policy.api.pricing,
              interrupted: apiResult.failureKind === 'INFRASTRUCTURE',
            });
            extraMetrics = {
              ...(extraMetrics ?? {}),
              reconciledCostUsd: observedCost.costUsd,
            };
            if (apiReservationId !== undefined) {
              const reconciled = reconcileApiBudget({
                workspace: deps.workspace,
                jobId,
                reservationId: apiReservationId,
                observedCostUsd: observedCost.costUsd,
                costSource: observedCost.source,
                now: (deps.clock ?? (() => new Date()))(),
                detail: observedCost.detail,
              });
              const summary = summarizeApiBudget(
                readApiBudgetState(deps.workspace, jobId),
                schedulingRuntime.policy.api.budget,
              );
              recordJobEvent(deps, jobId, 'api_budget_reconciled', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                reservationId: apiReservationId,
                state: reconciled.state,
                reservedUsd: reconciled.reservedUsd,
                reconciledUsd: reconciled.reconciledUsd,
                costSource: observedCost.source,
                encumberedUsd: summary.encumberedUsd,
                remainingUsd: summary.remainingUsd,
              });
              if (observedCost.costUsd === null) {
                recordJobEvent(deps, jobId, 'api_cost_unknown', {
                  nodeId: node.nodeId,
                  taskId: node.parentTaskId,
                  reservationId: apiReservationId,
                  detail: observedCost.detail.slice(0, 300),
                });
              }
              emit(
                'note',
                `api budget reconciled: ${reconciled.state}` +
                  `${observedCost.costUsd !== null ? ` at $${observedCost.costUsd.toFixed(4)} (${observedCost.source})` : ' with UNKNOWN cost (hold retained)'}`,
              );
            }
            if (apiResult.failure !== undefined) {
              // Classify why paid work failed. Infrastructure failures say
              // nothing about the task and must not become a paid retry
              // loop; intelligence failures follow the ordinary recovery
              // policy that governs every other lane.
              recordJobEvent(deps, jobId, 'api_attempt_failed', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                category: apiResult.failure.category,
                failureKind: apiResult.failureKind ?? 'UNKNOWN',
                detail: apiResult.failure.message.slice(0, 300),
              });
            }
            // Did prepaid capacity return while we were paying? Recording it
            // is the point — the attempt was NOT killed for it, and the next
            // strong task will route back to the subscription lane on its
            // own through the ordinary scheduler.
            const after = await schedulingRuntime.manager.snapshot();
            const fiveHourBack =
              (after.fiveHour?.remainingRatio ?? 0) > schedulingRuntime.policy.fiveHourExhaustedRatio;
            const weeklyBack =
              (after.weekly?.remainingRatio ?? 0) > schedulingRuntime.policy.weeklyExhaustedRatio;
            if (fiveHourBack && weeklyBack) {
              recordJobEvent(deps, jobId, 'api_max_returned', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                fiveHourRemainingRatio: after.fiveHour?.remainingRatio ?? null,
                weeklyRemainingRatio: after.weekly?.remainingRatio ?? null,
                detail:
                  'Subscription capacity returned during the paid attempt; the atomic attempt was ' +
                  'allowed to finish and subsequent strong work routes back to the subscription lane.',
              });
              apiBridgedWhileMaxReturned = true;
            }
          }

          // vNext.6: hand the reliability layer what this dispatch actually
          // OBSERVED — never a conclusion. Which runtime failed and how, what
          // it did, and what capacity exists right now. The verdict and the
          // recovery action are computed from these facts inside the job
          // service, so no dispatcher (and no runner behind one) can hand in
          // its own answer about whether it succeeded or deserves a retry.
          const acceptanceCriteria = resolveAcceptanceCriteria(deps, jobId, job.specName, node.nodeId);
          const dispatchVerification = (dispatch as { verification?: ExecutorDispatchResult['verification'] })
            .verification;
          const reliabilityInput: ExecutorReliabilityInput = {
            ...buildReliabilityInput({
              deps,
              jobId,
              dispatch,
              lane: laneName,
              harness: localHarnessLane || apiHarnessLane,
              schedulingRuntime,
              laneContext: lane,
              nodeId: node.nodeId,
              taskId: node.parentTaskId,
              contextRatio: extraMetrics?.['contextUsageAfter'] ?? null,
            }),
            ...(dispatchVerification !== undefined ? { verification: dispatchVerification } : {}),
            // vNext.7: what the WORKER itself said, from structured fields
            // only. A direct model that declines gives its escalation
            // reason; a harness gives its blocking questions. Both are
            // scanned for repository artifacts the package did not include —
            // never read for sentiment.
            ...(workerReportedTextOf(dispatch) !== undefined
              ? { workerReportedText: workerReportedTextOf(dispatch) }
              : {}),
            // A direct local model that DECLINED is the clearest evidence
            // there is that the package, not the model, was insufficient:
            // a model with no tools said it could not see the code.
            ...(localLane && (dispatch as { escalated?: boolean }).escalated === true
              ? { directModelRequestedRepository: true }
              : {}),
            ...(acceptanceCriteria.length > 0
              ? {
                  acceptanceCriteria,
                  criteriaEvidence: buildCriteriaEvidence({
                    workspaceRoot: deps.workspace.rootDir,
                    changedPaths: (dispatch.changedFiles ?? []).map((file) => file.path),
                    verifierResults: new Map(
                      (dispatchVerification?.commands ?? []).map((command) => [
                        command.name,
                        command.passed,
                      ]),
                    ),
                  }),
                }
              : {}),
          };

          const result = completeExecutorDispatch(deps, jobId, {
            context: {
              nodeId: decision.nodeId,
              role: 'EXECUTOR',
              workerId: decision.worker.workerId,
              startedAt,
              ...(dispatch.runId !== undefined ? { runId: dispatch.runId } : {}),
              ...(dispatch.usage !== undefined ? { usage: dispatch.usage } : {}),
            },
            mode: decision.mode,
            evidenceStatus: dispatch.evidenceStatus,
            ...(dispatch.failure !== undefined ? { failure: dispatch.failure } : {}),
            ...(dispatch.changedFiles !== undefined ? { changedFiles: dispatch.changedFiles } : {}),
            ...(extraMetrics !== undefined ? { extraMetrics } : {}),
            reliability: reliabilityInput,
          });
          if (result.recovery !== undefined) {
            emit(
              'note',
              `recovery: ${result.recovery.action} (${result.recovery.reasonCode}) — health ${result.recovery.health}`,
            );
          }
          emit(
            'executor-finished',
            `task ${decision.taskId}: ${dispatch.evidenceStatus ?? dispatch.failure?.category ?? 'unknown'} → ${result.nextAction}`,
          );
          checkpointJob(
            deps,
            jobId,
            result.nextAction === 'job-complete'
              ? 'Job complete.'
              : `Executor outcome ${result.nextAction}; continue with the next scheduler decision.`,
          );
          if (result.nextAction === 'job-complete') {
            job = requireJobState(deps.workspace, jobId);
            return { stop: { kind: 'completed' }, job };
          }
          break;
        }

        case 'WAIT_RETRY': {
          const waitMs = Math.max(0, Date.parse(decision.retryAt) - Date.now());
          emit('waiting', `transient failure; retrying in ${Math.ceil(waitMs / 1000)}s`);
          await sleep(Math.min(waitMs, 60_000), signal);
          break;
        }

        case 'WAIT_QUOTA': {
          // Subscription capacity cannot take the work now. Persist the
          // decision + the durable WAITING_RETRY defer FIRST — a crash while
          // waiting must leave a resumable job with the reason on record.
          if (schedulingRuntime !== undefined && lane !== undefined) {
            persistLaneDecision(deps, jobId, {
              nodeId: decision.nodeId,
              taskId: decision.taskId,
              selectedLane: decision.awaitingApiApproval === true ? 'REQUIRE_APPROVAL' : 'DEFER',
              selectedProvider: null,
              reasonCode: decision.reasonCode,
              detail: decision.reason,
              deferUntil: decision.until,
              laneRouting: decision.laneRouting,
              lane,
              apiBinding: schedulingRuntime.apiBinding,
            });
            recordApiGapObservations(deps, jobId, schedulingRuntime, decision, graph, emit);
          }
          job = deferJobForQuota(deps, jobId, {
            nodeId: decision.nodeId,
            taskId: decision.taskId,
            until: decision.until,
            reasonCode: decision.reasonCode,
            detail: decision.reason,
            pollMs: schedulingRuntime?.policy.deferPollMs ?? 60_000,
          });
          emit('waiting', `quota: ${decision.reasonCode} — ${decision.reason}`);
          const nowMs = (deps.clock ?? (() => new Date()))().getTime();
          const waitMs = Math.max(0, Date.parse(job.retryAt ?? new Date(nowMs).toISOString()) - nowMs);
          const holdMs = schedulingRuntime?.policy.maxQuotaHoldMs ?? 600_000;
          unboundedQuotaDefers = decision.until === null ? unboundedQuotaDefers + 1 : 0;
          if ((decision.until === null && unboundedQuotaDefers <= 3) || (decision.until !== null && waitMs <= holdMs)) {
            await sleep(waitMs, signal);
            break;
          }
          checkpointJob(deps, jobId, `Deferred for subscription quota until ${job.retryAt ?? 'unknown'}; resume to continue.`);
          job = requireJobState(deps.workspace, jobId);
          return {
            stop: { kind: 'deferred', until: job.retryAt ?? null, reason: decision.reason },
            job,
          };
        }

        case 'AWAIT_HUMAN': {
          checkpointJob(
            deps,
            jobId,
            decision.what === 'plan-review'
              ? 'Review the pending plan, then resume the job.'
              : decision.what === 'authority'
                ? 'Decide the open authority question, then resume the job.'
                : 'Answer the open clarification question(s), then resume the job.',
          );
          job = requireJobState(deps.workspace, jobId);
          return { stop: { kind: 'needs-human', what: decision.what, detail: decision.reason }, job };
        }

        case 'JOB_COMPLETE': {
          job = completeJobIfDone(deps, jobId);
          if (job.status !== 'COMPLETED') {
            // The task plan is finished and the sealed contract is not. The
            // closure gate moved the job to QUALIFYING; the driver's work is
            // done and the closure lifecycle owns what happens next.
            checkpointJob(deps, jobId, 'Contract closure decides what remains.');
            return { stop: { kind: 'final', status: job.status }, job };
          }
          checkpointJob(deps, jobId, 'Job complete.');
          return { stop: { kind: 'completed' }, job };
        }

        case 'JOB_BLOCKED': {
          job = requireJobState(deps.workspace, jobId);
          if (job.status !== 'BLOCKED') {
            blockJob(deps, jobId, {
              category: decision.budget !== undefined ? 'BUDGET_EXHAUSTED' : 'BLOCKED_DEPENDENCY',
              code: decision.budget ?? 'BLOCKED',
              message: decision.reason,
              remediation: [
                'All evidence and source changes are preserved.',
                'Inspect the job with `specbridge orchestrate job <id>`, then decide explicitly.',
              ],
            });
          }
          checkpointJob(deps, jobId, 'Blocked; an explicit user action is required.');
          job = requireJobState(deps.workspace, jobId);
          return { stop: { kind: 'blocked', reason: decision.reason }, job };
        }

        case 'JOB_FINAL': {
          job = requireJobState(deps.workspace, jobId);
          return { stop: { kind: 'final', status: job.status }, job };
        }
      }
    }
  } finally {
    await localManager?.stop('driver exit');
  }
}

/**
 * The durable acceptance criteria one task is evaluated against.
 *
 * Derived from state that was already APPROVED, never authored at execution
 * time: the active product contracts' machine-checkable invariants, and the
 * criteria pinned on the task's canonical checkpoint. Nothing here can be
 * set from model output, plan text, or repository content — a criterion an
 * agent could write for itself would be a task grading its own homework.
 *
 * A contract invariant's guard pattern is a `pattern-absent` criterion: the
 * pattern describes the SHAPE OF A VIOLATION, so a match is a failure. This
 * is the same screening the objective runtime already performs on candidate
 * patches, reused rather than reinvented, so both paths enforce one
 * definition of "violates approved architecture".
 *
 * Criteria pinned as prose have no structural form. They are carried through
 * as unchecked: visible in `explain-node`, available to the bounded semantic
 * reviewer, and never a silent pass.
 */
function resolveAcceptanceCriteria(
  deps: DriverDeps,
  jobId: string,
  specName: string,
  nodeId: string,
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const mission = findMissionForSpec(deps.workspace, specName);
  if (mission !== undefined) {
    for (const contract of readContractRegistry(deps.workspace, mission.missionId)) {
      for (const invariant of contract.invariants) {
        for (const [index, pattern] of invariant.guardPatterns.entries()) {
          criteria.push({
            id: `${contract.contractId}-${invariant.invariantId}${index > 0 ? `-${index}` : ''}`.slice(0, 120),
            text: invariant.statement.slice(0, 2_000),
            check: { kind: 'pattern-absent', value: pattern },
          });
        }
      }
    }
  }
  const checkpoint = readLatestTaskCheckpoint(deps.workspace, jobId, nodeId);
  for (const [index, statement] of (checkpoint?.pinned.acceptanceCriteria ?? []).entries()) {
    criteria.push({ id: `AC-${index + 1}`, text: statement.slice(0, 2_000) });
  }
  return criteria.slice(0, 50);
}

/**
 * The deterministic facts those criteria are checked against.
 *
 * Read from the repository and the trusted verifiers, never from the
 * attempt's own account of itself: `changedPaths` comes from the evidence
 * pipeline's Git comparison, and existence is tested against the tree.
 *
 * `addedLines` stays EMPTY on this path, deliberately. The executor pipeline
 * does not retain a unified diff, and screening whole file contents instead
 * would fail a task for a violation that was already in a file it merely
 * touched. So pattern criteria report NOT_RUN here and surface as unchecked
 * — the honest answer — rather than producing a verdict from evidence that
 * does not exist. The objective runtime, which DOES have the candidate
 * patch, screens patterns properly on its own path.
 */
function buildCriteriaEvidence(input: {
  workspaceRoot: string;
  changedPaths: readonly string[];
  verifierResults: ReadonlyMap<string, boolean>;
}): CriteriaEvidence {
  const normalized = input.changedPaths.map((entry) => entry.replaceAll('\\', '/'));
  const existing = new Set<string>();
  for (const changed of normalized) {
    if (existsSync(path.join(input.workspaceRoot, changed))) existing.add(changed);
  }
  return {
    existingPaths: existing,
    changedPaths: normalized,
    addedLines: [],
    verifierResults: input.verifierResults,
  };
}

/**
 * Assemble the observed facts one dispatch can report to the reliability
 * layer.
 *
 * Everything here is a READING, never a judgment:
 *
 *   harnessFailureKind  the runtime's own already-normalized failure kind
 *   activity            what the runtime reported doing (nulls stay unknown)
 *   resource            live capacity, read from the scheduler's telemetry
 *   local / api         the bounded budgets, read from their owners
 *
 * The API position is deliberately read from the vNext.5 budget controller
 * rather than recomputed: reliability may decide NOT to spend, but it must
 * never maintain a competing idea of how much money is left.
 */
function buildReliabilityInput(input: {
  deps: DriverDeps;
  jobId: string;
  /**
   * Structural, not the concrete result type: the dispatch union spans four
   * execution paths and this function reads only what all of them report.
   * Narrowing it here would make adding a fifth path a change to reliability
   * code, which is the coupling this phase is supposed to remove.
   */
  dispatch: { changedFiles?: readonly { path: string }[] | undefined };
  lane: ExecutionLane | undefined;
  harness: boolean;
  schedulingRuntime: SchedulingRuntime | undefined;
  laneContext: BuiltLaneContext | undefined;
  nodeId: string;
  taskId: string;
  contextRatio: number | null;
}): ExecutorReliabilityInput {
  const { schedulingRuntime, laneContext } = input;
  const harnessResult = input.harness
    ? (input.dispatch as LocalHarnessExecutionResult)
    : undefined;

  const forecast = laneContext?.forecast;
  const subscriptionExhausted =
    forecast !== undefined && isSubscriptionExhausted(forecast.schedulerMode);
  const returnsInMs =
    forecast === undefined
      ? null
      : forecast.schedulerMode === 'EXHAUSTED_WEEKLY'
        ? forecast.timeToWeeklyResetMs
        : forecast.schedulerMode === 'EXHAUSTED_5H'
          ? forecast.timeToFiveHourResetMs
          : null;

  const apiPolicy = schedulingRuntime?.policy.api;
  const apiSummary =
    schedulingRuntime !== undefined
      ? summarizeApiBudget(readApiBudgetState(input.deps.workspace, input.jobId), apiPolicy!.budget)
      : undefined;

  const resource: RecoveryResource = {
    subscriptionAvailable: !subscriptionExhausted,
    subscriptionReturnsInMs: returnsInMs,
    subscriptionWorkerConfigured: resolveWorkers(input.deps.config).some(
      (worker) => worker.reasoningTier !== 'LOCAL_SMALL',
    ),
    // Authorization in principle only. The gap-bridge planner and the budget
    // still hold independent vetoes at dispatch, and a recovery decision can
    // never substitute for either.
    apiAuthorized: apiPolicy !== undefined && apiPolicy.spendMode !== 'DISABLED',
    apiBudgetAvailable: apiSummary === undefined ? false : apiSummary.remainingUsd === null || apiSummary.remainingUsd > 0,
    localAvailable: schedulingRuntime?.localInference !== undefined,
    localHarnessAvailable: schedulingRuntime?.harnessBinding.available === true,
  };

  return {
    resource,
    ...(harnessResult?.failureKind !== undefined
      ? { harnessFailureKind: harnessResult.failureKind }
      : {}),
    ...(harnessResult !== undefined
      ? {
          activity: {
            toolCalls: harnessResult.observed.toolCalls,
            commandRuns: harnessResult.observed.commandRuns,
            contextUsageAfter: input.contextRatio,
            emptyDiff: (input.dispatch.changedFiles ?? []).length === 0,
          },
        }
      : {}),
    contextRatio: input.contextRatio,
    ...(schedulingRuntime !== undefined
      ? {
          local: {
            used: localExecutorAttemptsUsed(input.deps, input.jobId, input.nodeId),
            max: schedulingRuntime.policy.maxLocalAttempts,
          },
        }
      : {}),
    ...(apiSummary !== undefined
      ? {
          api: {
            remainingUsd: apiSummary.remainingUsd,
            encumberedUsd: apiSummary.encumberedUsd,
            available: resource.apiAuthorized && (apiSummary.remainingUsd === null || apiSummary.remainingUsd > 0),
          },
        }
      : {}),
  };
}

/**
 * Whether a failed DIRECT local attempt is evidence that the work needed
 * REPOSITORY TOOLS rather than a stronger model (vNext.4 §19).
 *
 * Deliberately a short closed list, not "retry everything on the harness":
 *
 *   - the local executor DECLINED, which it is instructed to do exactly when
 *     the task needs repository knowledge it was not given;
 *   - it produced no repository change at all (evidence status no-change →
 *     IMPLEMENTATION_DEFECT), the signature of a model that did not know
 *     where to write;
 *   - the applied edits failed trusted verification, which is the case an
 *     edit → test → repair loop exists for.
 *
 * Everything else — invalid structured output, cancellation, transient tool
 * failures, stale context, a diverged repository — is NOT repository-
 * knowledge evidence, and follows the existing policy unchanged.
 */
function directFailureNeedsRepositoryTools(result: LocalExecutionResult): boolean {
  const failure = result.failure;
  if (failure === undefined) return false;
  if (failure.category === 'VERIFICATION_FAILURE') return true;
  if (failure.category === 'IMPLEMENTATION_DEFECT') {
    return result.evidenceStatus === 'no-change' || result.evidenceStatus === undefined;
  }
  // A decline is only meaningful when the model itself declined; the same
  // category also covers invalid output and refused edits, which a harness
  // would not fix.
  return failure.category === 'CAPABILITY_UNAVAILABLE' && result.escalationReason !== undefined;
}

// ---------------------------------------------------------------------------
// vNext.2 scheduling observability
// ---------------------------------------------------------------------------

/**
 * Persist one SchedulingDecision record and its compact timeline events.
 * Records are bounded observability; a storage hiccup here must never fail
 * the dispatch it describes.
 */
/**
 * Persist the canonical handoff state a paid attempt will start from
 * (vNext.5 §40).
 *
 * The paid runtime is a stranger to this job: it has never seen the
 * subscription conversation that preceded it, and it must not need to. So
 * the transition is recorded as an explicit `handoff` checkpoint whose
 * carry-forward rules (decisions and failed approaches accumulate) give the
 * new session everything SpecBridge knows and the repository does not.
 *
 * Best-effort by design: a checkpoint that cannot be written must not block
 * a dispatch that is already authorized and funded. The attempt record and
 * the ledger remain the durable evidence either way.
 */
function writeApiHandoffCheckpoint(
  deps: DriverDeps,
  jobId: string,
  node: JobNode,
  attemptId: string,
  bridge: NonNullable<NodeLaneRouting['apiBridge']>,
): void {
  try {
    const previous = readLatestTaskCheckpoint(deps.workspace, jobId, node.nodeId);
    createTaskCheckpoint(
      { workspace: deps.workspace, clock: deps.clock, idFactory: deps.idFactory },
      {
        jobId,
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        attemptId,
        reason: 'handoff',
        objective:
          previous?.objective ??
          `Implement task ${node.parentTaskId}: ${node.title}`.slice(0, 2_000),
        pinned: previous?.pinned ?? {
          taskContract: `Task ${node.parentTaskId}: ${node.title}`.slice(0, 2_000),
          acceptanceCriteria: [],
          constraints: [],
          invariants: [],
        },
        nextActions: previous?.nextActions ?? [
          `Implement task ${node.parentTaskId} (${node.title}) and make the verification commands pass.`,
        ],
        importantDecisions: [
          {
            decision:
              'Execution handed off to the metered API lane because prepaid subscription ' +
              'capacity is unavailable.',
            rationale: bridge.detail.slice(0, 2_000),
          },
        ],
      },
    );
  } catch {
    // Observability, not authority: the dispatch proceeds regardless.
  }
}

/**
 * Record what the gap-bridge planner concluded for a task that is waiting
 * (vNext.5 §55), and open a bounded approval request when MANUAL mode
 * concluded that paid execution would preserve continuity.
 *
 * Deliberately on the WAIT path: the decisions that do NOT spend money are
 * the ones a user most needs explained, because their symptom is a job that
 * appears to be doing nothing.
 */
function recordApiGapObservations(
  deps: DriverDeps,
  jobId: string,
  runtime: SchedulingRuntime,
  decision: Extract<SchedulerDecision, { kind: 'WAIT_QUOTA' }>,
  graph: JobGraph | undefined,
  emit: (kind: DriverEvent['kind'], message: string) => void,
): void {
  const bridge = decision.laneRouting?.apiBridge;
  if (bridge === undefined) return;
  const now = (deps.clock ?? (() => new Date()))();

  recordJobEvent(deps, jobId, 'api_gap_detected', {
    nodeId: decision.nodeId,
    taskId: decision.taskId,
    gapReason: bridge.gap.reason,
    expectedAvailableAt: bridge.gap.expectedAvailableAt,
    estimatedGapDurationMs: bridge.gap.timeUntilAvailableMs,
    confidence: bridge.gap.confidence,
    delaySensitivity: bridge.delaySensitivity.level,
    decision: bridge.decision,
    reasonCode: bridge.reasonCode,
  });
  if (bridge.reasonCode === 'API_GAP_SHORT_DEFER' || bridge.reasonCode === 'API_WASTEFUL_NEAR_RESET') {
    recordJobEvent(deps, jobId, 'api_gap_short_deferred', {
      nodeId: decision.nodeId,
      taskId: decision.taskId,
      estimatedGapDurationMs: bridge.gap.timeUntilAvailableMs,
      detail: bridge.detail.slice(0, 300),
    });
  }
  if (bridge.reasonCode === 'API_COST_UNKNOWN') {
    recordJobEvent(deps, jobId, 'api_cost_unknown', {
      nodeId: decision.nodeId,
      taskId: decision.taskId,
      detail: (bridge.cost?.detail ?? bridge.detail).slice(0, 300),
    });
  }
  if (bridge.reasonCode === 'API_BUDGET_EXCEEDED') {
    recordJobEvent(deps, jobId, 'api_budget_exceeded', {
      nodeId: decision.nodeId,
      taskId: decision.taskId,
      refusal: bridge.budget?.refusal ?? 'UNKNOWN',
      remainingUsd: bridge.budget?.job.remainingUsd ?? null,
      detail: bridge.detail.slice(0, 300),
    });
  }

  if (decision.awaitingApiApproval !== true) return;
  const profileName = runtime.apiBinding.profileName;
  if (profileName === null) return;
  const node = graph?.nodes.find((candidate) => candidate.nodeId === decision.nodeId);
  if (node === undefined) return;
  const safeCost = bridge.cost?.safeCostUsd;
  if (safeCost === null || safeCost === undefined) return;

  // The authorization is bounded to THIS task version, THIS profile, and a
  // maximum cost — never to "API", which would be an unbounded yes.
  const requested = requestApiSpendApproval({
    workspace: deps.workspace,
    jobId,
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    taskFingerprint: taskSpendFingerprint(node),
    profileName,
    maxAuthorizedCostUsd: safeCost,
    estimatedCostUsd: bridge.cost?.estimatedCostUsd ?? null,
    rationale: bridge.detail,
    approvalId: `aa-${((deps.idFactory ?? (() => `${Date.now()}`))())}`.slice(0, 64),
    now,
    ttlMs: runtime.policy.api.gap.approvalTtlMs,
  });
  if (!requested.created) return;
  recordJobEvent(deps, jobId, 'api_approval_required', {
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    approvalId: requested.approval.approvalId,
    profile: profileName,
    maxAuthorizedCostUsd: requested.approval.maxAuthorizedCostUsd,
    estimatedCostUsd: requested.approval.estimatedCostUsd,
    gapReason: bridge.gap.reason,
    estimatedGapDurationMs: bridge.gap.timeUntilAvailableMs,
    delaySensitivity: bridge.delaySensitivity.level,
    expiresAt: requested.approval.expiresAt,
  });
  emit(
    'waiting',
    `api spend approval required (${requested.approval.approvalId}): up to ` +
      `$${safeCost.toFixed(4)} on "${profileName}" for task ${node.parentTaskId}`,
  );
}

function persistLaneDecision(
  deps: DriverDeps,
  jobId: string,
  input: {
    nodeId: string;
    taskId: string;
    selectedLane: 'LOCAL' | 'SUBSCRIPTION' | 'API' | 'DEFER' | 'REQUIRE_APPROVAL';
    selectedProvider: string | null;
    reasonCode: SchedulingDecisionRecord['reasonCode'];
    detail: string;
    deferUntil: string | null;
    laneRouting: NodeLaneRouting | undefined;
    lane: BuiltLaneContext;
    /** vNext.4: the LOCAL harness binding in force, for mode attribution. */
    harnessBinding?: LocalHarnessBinding | undefined;
    /** vNext.5: the API binding in force, for paid-lane attribution. */
    apiBinding?: ApiHarnessBinding | undefined;
  },
): string {
  const createdAt = ((deps.clock ?? (() => new Date()))()).toISOString();
  const decisionId = `sd-${((deps.idFactory ?? (() => `${Date.now()}`))())}`.slice(0, 64);
  const routing = input.laneRouting;
  try {
    appendSchedulingDecision(
      deps.workspace,
      {
        schemaVersion: '1.0.0',
        decisionId,
        jobId,
        nodeId: input.nodeId,
        taskId: input.taskId,
        selectedLane: input.selectedLane,
        selectedProvider: input.selectedProvider,
        schedulerMode: input.lane.forecast.schedulerMode,
        reasonCode: input.reasonCode,
        quotaSnapshot: input.lane.forecast,
        workloadEstimate:
          routing !== undefined
            ? {
                complexity: routing.estimate.complexity,
                localSuitability: routing.estimate.localSuitability,
                taskCategory: routing.suitability.category,
                expectedWallTimeMs: routing.estimate.expectedWallTimeMs,
                expectedFiveHourBurnRatio: routing.estimate.expectedFiveHourBurnRatio,
                expectedWeeklyBurnRatio: routing.estimate.expectedWeeklyBurnRatio,
                confidence: routing.estimate.confidence,
                basis: routing.estimate.basis,
              }
            : null,
        reserveRatio: input.lane.reserve.ratio,
        preResetBurnRatio: routing?.routing.admission?.preResetBurnRatio ?? null,
        crossesReset: routing?.routing.admission?.crossesReset ?? false,
        contextStatus:
          routing !== undefined
            ? {
                usageRatio: estimateNodeContextRatio(deps, jobId, input.nodeId),
                compactFirst: routing.routing.compactFirst,
              }
            : null,
        localExecution:
          routing?.localExecution?.mode != null && routing.localExecution.reasonCode !== null
            ? {
                mode: routing.localExecution.mode,
                reasonCode: routing.localExecution.reasonCode,
                shape: routing.localExecution.shape,
                runner:
                  routing.localExecution.mode === 'HARNESS'
                    ? (routing.localExecution.harness?.runner ?? null)
                    : 'local-model',
                model:
                  routing.localExecution.mode === 'HARNESS'
                    ? (routing.localExecution.harness?.model ?? null)
                    : null,
                computeLocality:
                  routing.localExecution.mode === 'HARNESS'
                    ? (routing.localExecution.harness?.locality ?? 'UNKNOWN')
                    : 'LOCAL',
                localityEvidence: (input.harnessBinding?.localityEvidence ?? null)?.slice(0, 500) ?? null,
                harnessBindingStatus: input.harnessBinding?.status ?? null,
                detail: routing.localExecution.detail.slice(0, 1_000),
              }
            : null,
        // vNext.5: everything a reader needs to answer "why did (or didn't)
        // this cost money?" from ONE record — the gap and its expected
        // duration, how much the delay actually mattered, the estimate, the
        // budget that remained, and which paid profile was in play. Present
        // on every decision the gap-bridge planner touched, including the
        // ones where it declined to spend.
        apiBridge:
          routing?.apiBridge !== undefined
            ? {
                decision: routing.apiBridge.decision,
                spendMode: deps.config.orchestration.jobs.scheduler.api.spendMode,
                gapReason: routing.apiBridge.gap.reason,
                subscriptionAvailableAt: routing.apiBridge.gap.expectedAvailableAt,
                estimatedGapDurationMs: routing.apiBridge.gap.timeUntilAvailableMs,
                gapConfidence: routing.apiBridge.gap.confidence,
                delaySensitivity: routing.apiBridge.delaySensitivity.level,
                blockedDependents: routing.apiBridge.delaySensitivity.blockedDependents,
                criticalPath: routing.apiBridge.delaySensitivity.criticalPath,
                readyLocalBacklog: routing.apiBridge.delaySensitivity.readyLocalBacklog,
                estimatedCostUsd: routing.apiBridge.cost?.estimatedCostUsd ?? null,
                safeCostUsd: routing.apiBridge.cost?.safeCostUsd ?? null,
                currency: routing.apiBridge.cost?.currency ?? 'USD',
                costSource: routing.apiBridge.cost?.costSource ?? 'UNKNOWN',
                pricingSource: routing.apiBridge.cost?.pricingSource ?? null,
                budgetRemainingUsd: routing.apiBridge.budget?.job.remainingUsd ?? null,
                budgetEncumberedUsd: routing.apiBridge.budget?.job.encumberedUsd ?? null,
                apiProfile: input.apiBinding?.profileName ?? null,
                apiRunner: input.apiBinding?.runner ?? null,
                apiModel: input.apiBinding?.model ?? null,
                computeLocality: input.apiBinding?.locality ?? 'UNKNOWN',
                bindingStatus: input.apiBinding?.status ?? null,
                approvalId: routing.apiBridge.approval?.approval?.approvalId ?? null,
                approvalStatus: routing.apiBridge.approval?.approval?.status ?? null,
                detail: routing.apiBridge.detail.slice(0, 2_000),
              }
            : null,
        deferUntil: input.deferUntil,
        detail: input.detail.slice(0, 2_000),
        createdAt,
      },
      { maxRecords: deps.config.orchestration.jobs.scheduler.maxDecisionRecords },
    );
  } catch {
    // Bounded observability only; the decision itself already executed.
  }
  recordJobEvent(deps, jobId, 'scheduling_decision_created', {
    decisionId,
    nodeId: input.nodeId,
    taskId: input.taskId,
    lane: input.selectedLane,
    reasonCode: input.reasonCode,
    mode: input.lane.forecast.schedulerMode,
    ...(input.deferUntil !== null ? { deferUntil: input.deferUntil } : {}),
  });
  if (routing !== undefined) {
    recordJobEvent(deps, jobId, 'local_suitability_classified', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      suitability: routing.suitability.class,
      category: routing.suitability.category,
      signals: routing.suitability.signals.slice(0, 5).map((signal) => signal.signal),
    });
    recordJobEvent(deps, jobId, 'workload_estimated', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      expectedWallTimeMs: routing.estimate.expectedWallTimeMs,
      expectedFiveHourBurnRatio: routing.estimate.expectedFiveHourBurnRatio,
      expectedWeeklyBurnRatio: routing.estimate.expectedWeeklyBurnRatio,
      confidence: routing.estimate.confidence,
      basis: routing.estimate.basis,
    });
  }
  persistAdaptiveDecision(deps, jobId, {
    nodeId: input.nodeId,
    taskId: input.taskId,
    heuristicLane: input.selectedLane,
    heuristicReasonCode: input.reasonCode,
    lane: input.lane,
    createdAt,
    decisionId,
  });
  return decisionId;
}

/**
 * Persist the vNext.8 adaptive evaluation for one node, and emit the few
 * semantic events that go with it.
 *
 * Written in SHADOW as well as ADAPTIVE — a mode whose entire purpose is
 * producing evidence would be useless without a record — and not written at
 * all in HEURISTIC, where nothing was computed.
 *
 * Everything here is observability. A failure to write it is swallowed for
 * the same reason the scheduling decision's is: the placement already
 * happened, and losing the explanation must never lose the work.
 */
function persistAdaptiveDecision(
  deps: DriverDeps,
  jobId: string,
  input: {
    nodeId: string;
    taskId: string;
    heuristicLane: string;
    heuristicReasonCode: string;
    lane: BuiltLaneContext;
    createdAt: string;
    decisionId: string;
  },
): void {
  const adaptive = input.lane.adaptive;
  if (adaptive === undefined) return;
  const ranking = adaptive.rankings.get(input.nodeId);
  const signature = adaptive.signatures.get(input.nodeId);
  if (ranking === undefined || signature === undefined) return;

  try {
    appendAdaptiveDecision(
      deps.workspace,
      {
        schemaVersion: ADAPTIVE_DECISION_SCHEMA_VERSION,
        decisionId: `ad-${input.decisionId}`.slice(0, 200),
        jobId,
        nodeId: input.nodeId,
        taskId: input.taskId,
        mode: ranking.mode,
        taskSignature: signature.key,
        signatureFeatures: {
          ...signature.features,
          repositorySize: signature.repositorySize,
          contextSize: signature.contextSize,
        },
        heuristicLane: input.heuristicLane,
        heuristicReasonCode: input.heuristicReasonCode,
        eligibleCandidates: ranking.ranked.map((entry) => ({
          candidateId: entry.prediction.candidate.candidateId,
          lane: entry.prediction.candidate.lane,
          executionMode: entry.prediction.candidate.executionMode,
          runner: entry.prediction.candidate.runner,
          model: entry.prediction.candidate.model,
          profile: entry.prediction.candidate.profile,
          contextStrategy: entry.prediction.candidate.contextStrategy,
          computeLocality: entry.prediction.candidate.computeLocality,
          heuristicChoice: entry.prediction.candidate.heuristicChoice,
        })),
        rejectedCandidates: ranking.vetoes.map((entry) => ({
          candidateId: entry.candidateId,
          lane: entry.lane,
          executionMode: entry.executionMode,
          runner: entry.runner,
          code: entry.code,
          detail: entry.detail.slice(0, 600),
        })),
        predictions: ranking.ranked.map((entry) => ({
          candidateId: entry.prediction.candidate.candidateId,
          level: entry.prediction.level,
          profileKey: entry.prediction.profileKey,
          confidence: entry.prediction.confidence,
          confidenceScore: entry.prediction.confidenceScore,
          identityMatch: entry.prediction.identityMatch,
          driftDetected: entry.prediction.drift.detected,
          driftSignals: entry.prediction.drift.signals,
          verifiedSuccessProbability: entry.prediction.verifiedSuccessProbability,
          priorSuccessProbability: entry.prediction.priorSuccessProbability,
          observedSuccessRate: entry.prediction.observedSuccessRate,
          firstAttemptSuccessRate: entry.prediction.firstAttemptSuccessRate,
          availabilityProbability: entry.prediction.availabilityProbability,
          expectedAttempts: entry.prediction.expectedAttempts,
          expectedWallTimeMs: entry.prediction.expectedWallTimeMs,
          expectedTotalWallTimeMs: entry.prediction.expectedTotalWallTimeMs,
          expectedInputTokens: entry.prediction.expectedInputTokens,
          expectedContextTokens: entry.prediction.expectedContextTokens,
          expectedFiveHourBurnRatio: entry.prediction.expectedFiveHourBurnRatio,
          conservativeFiveHourBurnRatio: entry.prediction.conservativeFiveHourBurnRatio,
          expectedApiCostUsd: entry.prediction.expectedApiCostUsd,
          expectedFailedWallTimeMs: entry.prediction.expectedFailedWallTimeMs,
          stagnationRate: entry.prediction.stagnationRate,
          oscillationRate: entry.prediction.oscillationRate,
          runawayRate: entry.prediction.runawayRate,
          contextMissRate: entry.prediction.contextMissRate,
          contextExpansionRate: entry.prediction.contextExpansionRate,
          safetyEvents: entry.prediction.safetyEvents,
          sampleCount: entry.prediction.sampleCount,
          weightedSampleCount: entry.prediction.weightedSampleCount,
          lastObservedAt: entry.prediction.lastObservedAt,
          score: entry.score.score,
          scoreComponents: entry.score.components.map((component) => ({
            name: component.name,
            raw: component.raw,
            unit: component.unit,
            normalized: component.normalized,
            weight: component.weight,
            contribution: component.contribution,
            detail: component.detail.slice(0, 600),
          })),
        })),
        heuristicCandidateId: ranking.heuristicCandidate?.candidateId ?? null,
        recommendedCandidateId: ranking.recommendedCandidate?.candidateId ?? null,
        selectedCandidateId: ranking.selectedCandidate?.candidateId ?? null,
        adaptiveApplied: ranking.adaptiveApplied,
        disagreement: ranking.disagreement,
        wouldApplyInAdaptiveMode: ranking.wouldApplyInAdaptiveMode,
        confidence: ranking.confidence,
        utilityMargin: ranking.utilityMargin,
        fallbackReason: ranking.fallbackReason,
        explanation: ranking.explanation.map((line) => line.slice(0, 600)).slice(0, 24),
        profileObservations: adaptive.profiles.observationCount,
        profileBuiltAt: adaptive.profiles.builtAt,
        createdAt: input.createdAt,
      },
      { maxRecords: deps.config.orchestration.jobs.scheduler.adaptive.maxDecisionRecords },
    );
  } catch {
    // Bounded observability only; the placement itself already happened.
  }

  recordJobEvent(deps, jobId, 'adaptive_prediction_created', {
    nodeId: input.nodeId,
    taskId: input.taskId,
    mode: ranking.mode,
    taskSignature: signature.key,
    candidates: ranking.ranked.length,
    confidence: ranking.confidence,
    profileSource: adaptive.source,
  });
  for (const veto of ranking.vetoes) {
    if (veto.code === 'LANE_NOT_ELIGIBLE') continue;
    recordJobEvent(deps, jobId, 'adaptive_candidate_vetoed', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      candidateId: veto.candidateId,
      code: veto.code,
    });
  }
  const drifting = ranking.ranked.filter((entry) => entry.prediction.drift.detected);
  for (const entry of drifting) {
    recordJobEvent(deps, jobId, 'adaptive_drift_detected', {
      nodeId: input.nodeId,
      candidateId: entry.prediction.candidate.candidateId,
      signals: entry.prediction.drift.signals,
      detail: entry.prediction.drift.detail.slice(0, 300),
    });
  }
  if (ranking.adaptiveApplied) {
    recordJobEvent(deps, jobId, 'adaptive_candidate_selected', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      selected: ranking.selectedCandidate?.candidateId ?? null,
      heuristic: ranking.heuristicCandidate?.candidateId ?? null,
      confidence: ranking.confidence,
      utilityMargin: ranking.utilityMargin,
    });
    return;
  }
  if (ranking.mode === 'SHADOW' && ranking.disagreement) {
    // A DISAGREEMENT, and nothing more. The recommended candidate was not
    // executed, so no outcome is attributed to it and no regret is computed.
    recordJobEvent(deps, jobId, 'adaptive_shadow_disagreement', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      executed: ranking.heuristicCandidate?.candidateId ?? null,
      recommended: ranking.recommendedCandidate?.candidateId ?? null,
      wouldApplyInAdaptiveMode: ranking.wouldApplyInAdaptiveMode,
      confidence: ranking.confidence,
    });
    return;
  }
  if (ranking.fallbackReason !== null && ranking.fallbackReason !== 'AGREES_WITH_HEURISTIC') {
    recordJobEvent(deps, jobId, 'adaptive_fallback_to_heuristic', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      reason: ranking.fallbackReason,
      confidence: ranking.confidence,
    });
  }
}

/**
 * Record scheduler-state transitions (mode, freshness, reserve, snapshot)
 * as structured lifecycle events — once per actual change, never per pass.
 */
function emitSchedulingTransitions(
  deps: DriverDeps,
  jobId: string,
  runtime: SchedulingRuntime,
  lane: BuiltLaneContext,
  emit: (kind: DriverEvent['kind'], message: string) => void,
): void {
  const forecast = lane.forecast;

  if (runtime.lastObservedAt !== forecast.observedAt) {
    recordJobEvent(deps, jobId, 'quota_snapshot_updated', {
      fiveHourRemainingRatio: forecast.fiveHourRemainingRatio,
      weeklyRemainingRatio: forecast.weeklyRemainingRatio,
      fiveHourResetAt: forecast.fiveHourResetAt,
      weeklyResetAt: forecast.weeklyResetAt,
      freshness: forecast.telemetryFreshness,
      source: runtime.manager.source,
    });
    runtime.lastObservedAt = forecast.observedAt;
  }

  if (runtime.lastFreshness !== forecast.telemetryFreshness) {
    if (forecast.telemetryFreshness === 'STALE') {
      recordJobEvent(deps, jobId, 'quota_telemetry_stale', {
        observedAt: forecast.observedAt,
        staleThresholdMs: runtime.policy.telemetryStaleMs,
      });
      emit('note', 'quota telemetry is stale; scheduling conservatively');
    }
    runtime.lastFreshness = forecast.telemetryFreshness;
  }

  if (runtime.lastMode !== forecast.schedulerMode) {
    if (runtime.lastMode !== undefined) {
      recordJobEvent(deps, jobId, 'scheduler_mode_changed', {
        from: runtime.lastMode,
        to: forecast.schedulerMode,
        fiveHourRemainingRatio: forecast.fiveHourRemainingRatio,
        weeklyRemainingRatio: forecast.weeklyRemainingRatio,
        timeToFiveHourResetMs: forecast.timeToFiveHourResetMs,
      });
    }
    if (forecast.schedulerMode === 'HARVEST') {
      recordJobEvent(deps, jobId, 'harvest_entered', {
        fiveHourRemainingRatio: forecast.fiveHourRemainingRatio,
        timeToFiveHourResetMs: forecast.timeToFiveHourResetMs,
        reserveRatio: lane.reserve.ratio,
      });
    } else if (runtime.lastMode === 'HARVEST') {
      recordJobEvent(deps, jobId, 'harvest_exited', { to: forecast.schedulerMode });
    }
    if (forecast.schedulerMode === 'EXHAUSTED_5H' || forecast.schedulerMode === 'EXHAUSTED_WEEKLY') {
      recordJobEvent(deps, jobId, 'quota_exhausted', {
        window: forecast.schedulerMode === 'EXHAUSTED_5H' ? 'five-hour' : 'weekly',
        resetAt:
          forecast.schedulerMode === 'EXHAUSTED_5H' ? forecast.fiveHourResetAt : forecast.weeklyResetAt,
      });
    }
    emit('note', `scheduler mode: ${forecast.schedulerMode}`);
    runtime.lastMode = forecast.schedulerMode;
  }

  const reserveDelta =
    runtime.lastReserveRatio === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(lane.reserve.ratio - runtime.lastReserveRatio);
  if (reserveDelta >= 0.05) {
    if (runtime.lastReserveRatio !== undefined) {
      recordJobEvent(deps, jobId, 'dynamic_reserve_changed', {
        from: runtime.lastReserveRatio,
        to: lane.reserve.ratio,
        timeComponent: lane.reserve.basis.timeComponent,
        weeklyPressureExtra: lane.reserve.basis.weeklyPressureExtra,
        staleTelemetryExtra: lane.reserve.basis.staleTelemetryExtra,
      });
    }
    runtime.lastReserveRatio = lane.reserve.ratio;
  }
}

// ---------------------------------------------------------------------------
// Role handling
// ---------------------------------------------------------------------------

type RoleHandlingOutcome = 'continue' | 'stop-interrupted';

async function handleRoleDecision(
  deps: DriverDeps,
  jobId: string,
  decision: Extract<SchedulerDecision, { kind: 'RUN_ROLE' }>,
  runtime: {
    localManager: LocalModelManager | undefined;
    probeCache: { probe: ClaudeProbe | undefined };
    signal: AbortSignal | undefined;
    emit: (kind: DriverEvent['kind'], message: string) => void;
  },
): Promise<RoleHandlingOutcome> {
  const policy = deps.config.orchestration.jobs;
  const role = decision.role as AgentContractRole;
  const job = requireJobState(deps.workspace, jobId);
  const graph = activeGraph(deps, job);
  const node = graph !== undefined ? findNode(graph, decision.nodeId) : undefined;
  if (node === undefined) {
    throw new OrchestrationError('SBO031', `Node ${decision.nodeId} vanished between scheduling and the role run.`);
  }

  // A worker-selection escalation is recorded BEFORE the paid worker runs —
  // and in manual escalation mode it stops the job for the user instead.
  if (decision.escalation !== undefined) {
    if (!escalationAllowed(policy) && decision.worker.costTier === 'PAID') {
      askClarification(deps, jobId, [
        {
          question:
            `Escalate ${role} for task ${node.parentTaskId} to the paid large agent? ` +
            `(${decision.escalation.detail})`,
          whyItMatters: 'Escalation mode is manual; paid reasoning needs an explicit decision.',
          nodeId: node.nodeId,
        },
      ]);
      return 'continue';
    }
    noteEscalation(deps, jobId, {
      nodeId: node.nodeId,
      role,
      reason: decision.escalation.reason,
      detail: decision.escalation.detail,
    });
  }

  if (role === 'PLANNER' && job.status === 'READY') {
    beginPlanning(deps, jobId, node.nodeId);
  }
  recordJobEvent(deps, jobId, 'worker_selected', {
    nodeId: node.nodeId,
    role,
    workerId: decision.worker.workerId,
    tier: decision.worker.reasoningTier,
  });

  const startedAt = (deps.clock ?? (() => new Date()))().toISOString();
  const specExcerpt = specExcerptFor(deps.workspace, job.specName, 12_000);
  const packetBase = {
    specName: job.specName,
    taskId: node.parentTaskId,
    taskTitle: node.title,
    specExcerpt,
  };

  const activePlan = readActivePlan(deps, jobId, node);
  const packet = buildPacketFor(deps, jobId, role, packetBase, node, activePlan, job);
  runtime.emit('role-started', `${role} for task ${node.parentTaskId} on ${decision.worker.workerId}`);

  const result = await runRole(deps, jobId, role, decision, packet, runtime);
  if (!result.ok) {
    if (result.kind === 'cancelled') return 'stop-interrupted';
    const attemptContext = {
      nodeId: node.nodeId,
      role,
      workerId: decision.worker.workerId,
      startedAt,
    };
    if (decision.worker.reasoningTier === 'LOCAL_SMALL') {
      // Local worker failures escalate stickily; they never fail the task.
      recordRoleFailure(deps, jobId, {
        context: attemptContext,
        outcome: result.kind === 'invalid-output' ? 'invalid-output' : 'failed',
        escalation: {
          reason:
            result.kind === 'invalid-output'
              ? 'INVALID_LOCAL_OUTPUT'
              : result.kind === 'context-exceeded'
                ? 'CONTEXT_LIMIT_EXCEEDED'
                : 'REPEATED_LOCAL_FAILURE',
          detail: result.problem.slice(0, 500),
        },
      });
      runtime.emit('role-finished', `${role} failed locally (${result.kind}); escalating`);
      return 'continue';
    }
    // The large tier failed: there is no further tier. A single repeat is
    // allowed (transient CLI hiccups); a second failure blocks the job.
    const previousLargeFailures = node.attempts.filter(
      (attempt) =>
        attempt.role === role &&
        attempt.workerId === decision.worker.workerId &&
        (attempt.outcome === 'failed' || attempt.outcome === 'invalid-output'),
    ).length;
    recordRoleFailure(deps, jobId, {
      context: attemptContext,
      outcome: result.kind === 'invalid-output' ? 'invalid-output' : 'failed',
    });
    if (previousLargeFailures >= 1) {
      blockJob(deps, jobId, {
        category: 'CAPABILITY_UNAVAILABLE',
        code: 'LARGE_WORKER_FAILED',
        message: `The large-agent ${role} failed twice: ${result.problem.slice(0, 500)}`,
        remediation: [
          'Check the Claude Code installation with `specbridge runner doctor claude-code`.',
          // The excerpt is the whole point of the remediation. A job blocked
          // on "the response is not a single valid JSON document" with
          // nothing retained leaves an operator a message and no evidence,
          // which is not how anything else here reports a failure.
          ...(result.observed !== undefined && result.observed.length > 0
            ? [`The worker returned: ${result.observed}`]
            : []),
        ],
      });
    }
    runtime.emit('role-finished', `${role} failed on the large tier (${result.kind})`);
    return 'continue';
  }

  const agentResultRef = persistAgentResult(deps, jobId, role, result.raw);
  const context = {
    nodeId: node.nodeId,
    role,
    workerId: decision.worker.workerId,
    startedAt,
    ...(agentResultRef !== undefined ? { agentResultRef } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
  await applyRoleOutput(deps, jobId, role, result, context, node, activePlan);
  runtime.emit('role-finished', `${role} for task ${node.parentTaskId} succeeded`);
  return 'continue';
}

function readActivePlan(deps: DriverDeps, jobId: string, node: JobNode): ExecutionPlan | undefined {
  if (node.planRevision === 0) return undefined;
  const raw = readNodePlan(deps.workspace, jobId, node.nodeId, node.planRevision);
  if (raw === undefined) return undefined;
  const parsed = executionPlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function buildPacketFor(
  deps: DriverDeps,
  jobId: string,
  role: AgentContractRole,
  base: { specName: string; taskId: string; taskTitle: string; specExcerpt: string },
  node: JobNode,
  activePlan: ExecutionPlan | undefined,
  job: JobState,
): string {
  switch (role) {
    case 'CLASSIFIER':
      return buildClassifierPacket(base);
    case 'PLANNER': {
      const critique =
        node.criticVerdict === 'REVISE' || node.criticVerdict === 'ESCALATE'
          ? node.attempts
              .filter((attempt) => attempt.role === 'CRITIC')
              .slice(-1)
              .map(() => 'Address the critic-requested changes recorded for the previous revision.')
          : undefined;
      return buildPlannerPacket({
        ...base,
        ...(critique !== undefined ? { critiqueToAddress: critique } : {}),
        decisions: job.decisions.slice(-10).map((decision) => ({
          question: decision.question,
          answer: decision.answer,
        })),
      });
    }
    case 'CRITIC': {
      if (activePlan === undefined) {
        throw new OrchestrationError('SBO031', 'The critic needs the active plan document.');
      }
      return buildCriticPacket({ ...base, plan: activePlan });
    }
    case 'DIAGNOSER': {
      return buildDiagnoserPacket({
        ...base,
        plan: activePlan,
        failure: {
          category: node.latestFailure?.category ?? 'VERIFICATION_FAILURE',
          source: 'execution',
          message: node.latestFailure?.message ?? 'unknown failure',
          output: node.latestFailure?.message,
        },
        attemptCount: node.attempts.filter((attempt) => attempt.role === 'EXECUTOR').length,
        previousDiagnoses:
          node.latestDiagnosis !== undefined
            ? [
                {
                  category: node.latestDiagnosis.category,
                  recommendedAction: node.latestDiagnosis.recommendedAction,
                  rootCause: 'see recorded diagnosis',
                },
              ]
            : undefined,
      });
    }
    case 'REPLANNER': {
      if (activePlan === undefined) {
        throw new OrchestrationError('SBO031', 'The replanner needs the invalidated plan document.');
      }
      const latestAssessment = listFailureAssessments(deps.workspace, jobId, { nodeId: node.nodeId }).at(-1);
      const reliabilityState = readTaskReliabilityState(deps.workspace, jobId, node.nodeId);
      const researchEligibility = latestAssessment === undefined
        ? undefined
        : evaluateRuntimeResearchTrigger({
            explicitExternalKnowledgeGap: false,
            externalAssumptionContradiction: false,
            unknownToolingOrPlatformBehavior: latestAssessment.source === 'UNKNOWN',
            repositoryAnswerAvailable: false,
            productAuthorityAmbiguity: latestAssessment.source === 'REQUIREMENT_CONTRACT',
            insufficientRepositoryContext: false,
            failureCategory: latestAssessment.category,
            failureSource: latestAssessment.source,
            failureFingerprint: latestAssessment.fingerprint,
            observations: reliabilityState?.observations ?? [],
          });
      const researchEvidence = runtimeResearchForJob(deps, jobId).map((record) => ({
        researchId: record.researchId,
        summary: renderResearchEvidence(record.report!),
      }));
      return buildReplannerPacket({
        ...base,
        invalidPlan: activePlan,
        diagnosis: {
          category: node.latestDiagnosis?.category ?? 'IMPLEMENTATION_DEFECT',
          rootCause: node.latestFailure?.message ?? 'see recorded diagnosis',
          recommendedAction: node.latestDiagnosis?.recommendedAction ?? 'REPLAN',
        },
        remainingReplans: Math.max(0, job.budgets.maxReplansPerTask - node.replans),
        ...(researchEligibility?.eligible === true
          ? {
              researchEligibility: {
                reason: researchEligibility.reason,
                depth: researchEligibility.depth,
                failureFingerprint: latestAssessment!.fingerprint,
                failedStrategies: researchEligibility.materiallyDistinctStrategies,
              },
            }
          : {}),
        ...(researchEvidence.length > 0 ? { researchEvidence } : {}),
      });
    }
  }
}

async function runRole(
  deps: DriverDeps,
  jobId: string,
  role: AgentContractRole,
  decision: Extract<SchedulerDecision, { kind: 'RUN_ROLE' }>,
  packet: string,
  runtime: {
    localManager: LocalModelManager | undefined;
    probeCache: { probe: ClaudeProbe | undefined };
    signal: AbortSignal | undefined;
  },
): Promise<RoleWorkerResult<AgentContractRole>> {
  if (decision.worker.reasoningTier === 'LOCAL_SMALL') {
    if (runtime.localManager === undefined) {
      return { ok: false, kind: 'worker-unavailable', problem: 'No local model manager is active.' };
    }
    return runLocalRole({
      manager: runtime.localManager,
      config: deps.config,
      role,
      packet,
      maxCorrections: deps.config.orchestration.jobs.maxLocalOutputCorrections,
      onInferenceCall: () => countLocalInferenceCall(deps, jobId),
      signal: runtime.signal,
    });
  }
  const result = await runLargeRole({
    workspace: deps.workspace,
    config: deps.config,
    runnerProfile: decision.worker.runnerProfile ?? deps.config.defaultRunner,
    role,
    packet,
    scratchDir: path.join(jobDir(deps.workspace, jobId), 'scratch'),
    timeoutMs: 600_000,
    signal: runtime.signal,
    cachedProbe: runtime.probeCache.probe,
  });
  if (result.probe !== undefined) runtime.probeCache.probe = result.probe;
  return result;
}

async function applyRoleOutput(
  deps: DriverDeps,
  jobId: string,
  role: AgentContractRole,
  result: Extract<RoleWorkerResult<AgentContractRole>, { ok: true }>,
  context: {
    nodeId: string;
    role: AgentContractRole;
    workerId: string;
    startedAt: string;
    agentResultRef?: string;
    usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  },
  node: JobNode,
  activePlan: ExecutionPlan | undefined,
): Promise<void> {
  const producedByTier =
    context.workerId === 'local-llamacpp' ? ('LOCAL_SMALL' as const) : ('LARGE_AGENT' as const);
  switch (role) {
    case 'CLASSIFIER': {
      const output = result.output as { complexity: 'LOW' | 'MEDIUM' | 'HIGH' };
      recordClassification(deps, jobId, { context, proposedClass: output.complexity });
      return;
    }
    case 'PLANNER': {
      const output = result.output as PlannerOutput;
      if (output.decision === 'ESCALATE' || output.requiresEscalation) {
        recordRoleFailure(deps, jobId, {
          context,
          outcome: 'escalated',
          escalation: {
            reason: 'COMPLEXITY_HIGH',
            detail: output.escalationReason ?? 'The local planner judged the task beyond local planning.',
          },
        });
        return;
      }
      // A `PLAN` decision carrying no goal or no steps has not planned
      // anything. That is an INTELLIGENCE failure of this attempt, not a
      // control-plane fault: `plannerOutputToCandidate` throws SBO037, and
      // an uncaught throw here kills the driver, which the supervisor
      // restarts straight back into the same local planner and the same
      // empty plan. The vNext.10.1 StepRelay dogfood did exactly that —
      // "DRIVER_DIED: A PLAN decision requires a goal and at least one
      // step" — and it would have burned the whole restart budget without
      // ever reaching a model that could plan.
      //
      // Routed through the SAME path as an explicit escalation, so the
      // scheduler moves the role to a stronger worker instead of retrying
      // the one that just failed.
      if (output.steps.length === 0 || output.goal === undefined) {
        recordRoleFailure(deps, jobId, {
          context,
          outcome: 'escalated',
          escalation: {
            reason: 'INVALID_LOCAL_OUTPUT',
            detail:
              'The planner returned a PLAN decision with no goal or no steps, which is not a ' +
              'usable plan.',
          },
        });
        return;
      }
      await recordPlan(deps, jobId, {
        context,
        candidate: plannerOutputToCandidate(output),
        producedByTier,
      });
      return;
    }
    case 'CRITIC': {
      const output = result.output as CriticOutput;
      recordCriticVerdict(deps, jobId, {
        context,
        verdict: output.verdict,
        reasons: [...output.reasons, ...output.requestedChanges],
      });
      if (output.verdict === 'ESCALATE') {
        noteEscalation(deps, jobId, {
          nodeId: node.nodeId,
          role: 'CRITIC',
          reason: 'CRITIC_ESCALATED',
          detail: output.escalationReason ?? output.reasons.join('; ').slice(0, 500),
        });
      }
      return;
    }
    case 'DIAGNOSER': {
      const output = result.output as DiagnoserOutput;
      applyDiagnosis(deps, jobId, {
        context,
        category: output.category,
        planValidity: output.planValidity,
        recommendedAction: output.recommendedAction,
        rootCause: output.rootCause,
      });
      return;
    }
    case 'REPLANNER': {
      const output = result.output as ReplannerOutput;
      if (output.decision === 'ESCALATE') {
        recordRoleFailure(deps, jobId, {
          context,
          outcome: 'escalated',
          escalation: {
            reason: 'REPLAN_BUDGET_PRESSURE',
            detail: output.escalationReason ?? output.reason,
          },
        });
        return;
      }
      if (output.decision === 'BLOCKED') {
        blockJob(deps, jobId, {
          category: 'BLOCKED_DEPENDENCY',
          code: 'REPLANNER_BLOCKED',
          message: output.reason,
          remediation: ['Resolve the stated blocker, then resume the job.'],
        });
        return;
      }
      if (output.decision === 'SUPERSEDE_NODE') {
        supersedeNode(deps, jobId, { nodeId: node.nodeId, reason: output.reason });
        recordResearchInformedReplan(deps, jobId, node.nodeId, output.reason);
        return;
      }
      // A REVISED_PLAN carrying no goal or no steps has revised nothing.
      // Same reasoning as the PLANNER branch: an intelligence failure, not a
      // control-plane fault, and an uncaught throw here would kill the
      // driver mid-replan.
      if (output.steps.length === 0 || output.goal === undefined) {
        recordRoleFailure(deps, jobId, {
          context,
          outcome: 'escalated',
          escalation: {
            reason: 'INVALID_LOCAL_OUTPUT',
            detail:
              'The replanner returned a REVISED_PLAN decision with no goal or no steps, which ' +
              'is not a usable plan.',
          },
        });
        return;
      }
      // REVISED_PLAN: both the model's own flag and the deterministic screen
      // must clear before an autonomous replan may proceed.
      const candidate = replannerOutputToCandidate(output);
      const screen = screenReplanForApprovedIntentImpact(
        { goal: candidate.goal, steps: candidate.steps },
        activePlan !== undefined
          ? { goal: activePlan.goal, steps: activePlan.steps.map((step) => ({ description: step.description })) }
          : undefined,
      );
      if (output.impactsApprovedIntent || screen.impacts) {
        // vNext.10: under a sealed Mission the screens above are INPUT to the
        // authority firewall rather than a verdict. The firewall re-reads
        // them against what the human actually delegated, so "restructure
        // the module layout" stops being a 03:00 question while "change the
        // public API" still is. With no resolver bound this whole branch is
        // skipped and the v1.2 clarification below runs unchanged.
        const delegated = resolveDelegatedAuthority(deps.authorityResolver, {
          jobId,
          nodeId: node.nodeId,
          decisionKinds: screen.decisionKinds,
          reasons: screen.reasons,
          proposal: `${candidate.goal}\n${candidate.steps
            .map((step) => step.description)
            .join('\n')}`.slice(0, 4_000),
        });
        if (delegated?.kind === 'AUTONOMOUS') {
          recordJobEvent(deps, jobId, 'authority_delegated', {
            nodeId: node.nodeId,
            decisionKinds: [...screen.decisionKinds],
            reason: delegated.reason.slice(0, 300),
          });
          await recordPlan(deps, jobId, { context, candidate, producedByTier }, { replan: true });
          recordResearchInformedReplan(deps, jobId, node.nodeId, output.reason);
          return;
        }
        if (delegated?.kind === 'NEEDS_AUTHORITY') {
          escalateAuthority(deps, jobId, {
            surface: delegated.surface,
            reason: delegated.reason,
            question: delegated.question,
            whyItMatters: delegated.whyItMatters,
            nodeId: node.nodeId,
            ...(delegated.options !== undefined ? { options: delegated.options } : {}),
          });
          return;
        }
        askClarification(deps, jobId, [
          {
            question:
              `The proposed replacement plan for task ${node.parentTaskId} may change approved intent` +
              `${screen.reasons.length > 0 ? ` (${screen.reasons.join('; ')})` : ''}. Proceed, change the spec, or decide otherwise?`,
            whyItMatters:
              'Replanning may never silently change approved behavior, public API, architecture, or product decisions.',
            nodeId: node.nodeId,
          },
        ]);
        return;
      }
      await recordPlan(deps, jobId, { context, candidate, producedByTier }, { replan: true });
      recordResearchInformedReplan(deps, jobId, node.nodeId, output.reason);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// vNext.7 context efficiency
// ---------------------------------------------------------------------------

interface DispatchContextSupplement {
  planId: string;
  /** Rendered working set, for a worker with no repository tools. */
  rendered?: string | undefined;
  /** Ranked repository locations, for a worker that reads the repository. */
  pointers?: string[] | undefined;
}

/**
 * Build the context supplement for one dispatch.
 *
 * Deliberately best-effort. Context efficiency is an OPTIMIZATION layered
 * over a runtime that already works without it, so a failure here — an
 * unreadable index, a budget that cannot be satisfied, a workspace the
 * scanner could not walk — degrades to the vNext.6 packet and says so,
 * rather than failing a dispatch that would otherwise have run. The failure
 * mode this guards against is the one where a token-saving feature becomes a
 * new way for a long-running job to stop.
 */
async function buildDispatchContext(
  deps: JobDeps,
  input: {
    jobId: string;
    node: JobNode;
    shape: ContextShape;
    lane?: string | undefined;
    executionMode?: string | undefined;
    runner?: string | undefined;
    emit: (message: string) => void;
  },
): Promise<DispatchContextSupplement | undefined> {
  const attemptId = requireJobState(deps.workspace, input.jobId).currentAttemptId;
  try {
    const built = await buildTaskContextPackage(deps, {
      jobId: input.jobId,
      nodeId: input.node.nodeId,
      role: 'EXECUTOR',
      shape: input.shape,
      ...(attemptId !== undefined ? { attemptId } : {}),
      ...(input.lane !== undefined ? { lane: input.lane } : {}),
      ...(input.executionMode !== undefined ? { executionMode: input.executionMode } : {}),
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
    });
    recordJobEvent(deps, input.jobId, 'context_selected', {
      nodeId: input.node.nodeId,
      taskId: input.node.parentTaskId,
      planId: built.plan.planId,
      strategy: built.plan.strategy,
      shape: built.plan.shape,
      expansionLevel: built.plan.expansionLevel,
      selectedFiles: built.plan.selectedWorkingItems.length,
      pointers: built.plan.pointers.length,
      excluded: built.plan.excludedCandidates.length,
      estimatedTokens: built.metrics.estimatedContextTokens,
      workingSetTokens: built.metrics.workingSetTokens,
    });
    if (input.shape === 'POINTER') {
      return { planId: built.plan.planId, pointers: renderPointerContext(built.plan) };
    }
    return {
      planId: built.plan.planId,
      rendered: renderMaterializedContext(built.assembled.package),
    };
  } catch (cause) {
    input.emit(
      `context selection unavailable; continuing with the legacy packet (${
        cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200)
      })`,
    );
    return undefined;
  }
}

/**
 * Bounded text the worker produced in STRUCTURED result fields.
 *
 * Deliberately narrow: an escalation reason and a set of blocking questions,
 * both of which are already part of the runner output contract. This is not
 * a transcript, and nothing downstream treats it as one — it is scanned for
 * repository paths and symbols, and it is discarded otherwise.
 */
function workerReportedTextOf(dispatch: unknown): string | undefined {
  const record = dispatch as {
    escalationReason?: unknown;
    blockingQuestions?: unknown;
    failure?: { message?: unknown };
  };
  const parts: string[] = [];
  if (typeof record.escalationReason === 'string') parts.push(record.escalationReason);
  if (Array.isArray(record.blockingQuestions)) {
    for (const entry of record.blockingQuestions) {
      if (typeof entry === 'string') parts.push(entry);
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n').slice(0, 8_000);
}
