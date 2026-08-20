import { readFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { WorkspaceInfo } from '@specbridge/core';
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
import { OrchestrationError } from '../errors.js';
import { executionPlanSchema } from '../state.js';
import type { ExecutionPlan } from '../state.js';
import { screenReplanForApprovedIntentImpact } from '../jobs/authority.js';
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
import type { JobNode, JobState } from '../jobs/state.js';
import { escalationAllowed, resolveWorkers } from '../jobs/routing.js';
import { isFinalJobStatus } from '../jobs/vocabulary.js';
import { scheduleNext } from '../jobs/scheduler.js';
import type { SchedulerDecision } from '../jobs/scheduler.js';
import { jobDir } from '../jobs/store.js';
import { findMissionForSpec } from '@specbridge/mission';
import { driveObjective } from '../objectives/objective-driver.js';
import {
  deferJobForQuota,
  promoteNodeForQuotaOvertake,
  recordObjectiveWorkerAttempt,
} from '../jobs/job-service.js';
import type { QuotaTelemetryProvider } from '../quota/telemetry.js';
import type { SchedulingDecisionRecord } from '../scheduling/decisions.js';
import { appendSchedulingDecision } from '../scheduling/decisions.js';
import type { LocalExecutionResult, LocalExecutorInference } from '../scheduling/local-execution.js';
import { dispatchLocalExecution } from '../scheduling/local-execution.js';
import type { NodeLaneRouting } from '../scheduling/scheduler.js';
import { reconstructTaskContext } from '../survival/reconstruction.js';
import type { BuiltLaneContext, SchedulingRuntime } from './scheduling-runtime.js';
import { buildLaneContext, createSchedulingRuntime, estimateNodeContextRatio } from './scheduling-runtime.js';
import { createLocalManager, runLargeRole, runLocalRole } from './workers.js';
import type { RoleWorkerResult } from './workers.js';
import { dispatchExecutor } from './executor-dispatch.js';

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
}

export type DriverStop =
  | { kind: 'completed' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'needs-human'; what: 'clarification' | 'plan-review'; detail: string }
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
    options: {
      quotaTelemetryProvider: options.quotaTelemetryProvider,
      localExecutorInference: options.localExecutorInference,
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

      job = clearRetryWait(deps, jobId);
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
        now: (deps.clock ?? (() => new Date()))(),
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
          emit(
            'executor-started',
            `${decision.mode} task ${decision.taskId} via ${decision.worker.workerId}${laneName !== undefined ? ` [${laneName} lane]` : ''}`,
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
                laneName === 'LOCAL'
                  ? decision.worker.workerId
                  : (decision.worker.runnerProfile ?? decision.worker.workerId),
              reasonCode: laneRouting.routing.reasonCode,
              detail: laneRouting.routing.detail,
              deferUntil: null,
              laneRouting,
              lane,
            });
            recordJobEvent(deps, jobId, laneName === 'LOCAL' ? 'task_routed_local' : 'task_routed_subscription', {
              nodeId: node.nodeId,
              taskId: node.parentTaskId,
              reasonCode: laneRouting.routing.reasonCode,
              suitability: laneRouting.suitability.class,
              mode: lane.forecast.schedulerMode,
            });
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

          beginExecutorDispatch(deps, jobId, {
            nodeId: decision.nodeId,
            mode: decision.mode,
            workerId: decision.worker.workerId,
            // The durable attempt records the true provider identity (the
            // runner profile) so the execution ledger attributes correctly.
            provider: decision.worker.runnerProfile ?? decision.worker.workerId,
            ...(laneName !== undefined ? { lane: laneName } : {}),
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
          const localLane =
            laneName === 'LOCAL' && schedulingRuntime !== undefined && schedulingRuntime.localInference !== undefined;
          const dispatch = localLane
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
          if (localLane) {
            const localResult = dispatch as LocalExecutionResult;
            if (localResult.failure !== undefined) {
              recordJobEvent(deps, jobId, 'local_attempt_failed', {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                category: localResult.failure.category,
                escalated: localResult.escalated,
              });
            }
            if (localResult.escalated) {
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
          });
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
              selectedLane: 'DEFER',
              selectedProvider: null,
              reasonCode: decision.reasonCode,
              detail: decision.reason,
              deferUntil: decision.until,
              laneRouting: decision.laneRouting,
              lane,
            });
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
              : 'Answer the open clarification question(s), then resume the job.',
          );
          job = requireJobState(deps.workspace, jobId);
          return { stop: { kind: 'needs-human', what: decision.what, detail: decision.reason }, job };
        }

        case 'JOB_COMPLETE': {
          job = completeJobIfDone(deps, jobId);
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

// ---------------------------------------------------------------------------
// vNext.2 scheduling observability
// ---------------------------------------------------------------------------

/**
 * Persist one SchedulingDecision record and its compact timeline events.
 * Records are bounded observability; a storage hiccup here must never fail
 * the dispatch it describes.
 */
function persistLaneDecision(
  deps: DriverDeps,
  jobId: string,
  input: {
    nodeId: string;
    taskId: string;
    selectedLane: 'LOCAL' | 'SUBSCRIPTION' | 'DEFER';
    selectedProvider: string | null;
    reasonCode: SchedulingDecisionRecord['reasonCode'];
    detail: string;
    deferUntil: string | null;
    laneRouting: NodeLaneRouting | undefined;
    lane: BuiltLaneContext;
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
  return decisionId;
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
  const packet = buildPacketFor(role, packetBase, node, activePlan, job);
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
        remediation: ['Check the Claude Code installation with `specbridge runner doctor claude-code`.'],
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
      return buildReplannerPacket({
        ...base,
        invalidPlan: activePlan,
        diagnosis: {
          category: node.latestDiagnosis?.category ?? 'IMPLEMENTATION_DEFECT',
          rootCause: node.latestFailure?.message ?? 'see recorded diagnosis',
          recommendedAction: node.latestDiagnosis?.recommendedAction ?? 'REPLAN',
        },
        remainingReplans: Math.max(0, job.budgets.maxReplansPerTask - node.replans),
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
      return;
    }
  }
}
