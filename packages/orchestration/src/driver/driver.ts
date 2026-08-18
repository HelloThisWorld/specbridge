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
import { scheduleNext } from '../jobs/scheduler.js';
import type { SchedulerDecision } from '../jobs/scheduler.js';
import { jobDir } from '../jobs/store.js';
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
}

export type DriverStop =
  | { kind: 'completed' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'needs-human'; what: 'clarification' | 'plan-review'; detail: string }
  | { kind: 'interrupted' }
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

  // The loop itself is budget-bounded by the scheduler; this valve only
  // guards against a decision cycle that never dispatches (a driver bug).
  const maxLoop = policy.budgets.maxAgentRuns * 6 + 50;
  let loops = 0;

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
      const decision = scheduleNext({ job, graph, policy, workers, now: (deps.clock ?? (() => new Date()))() });
      emit('decision', `${decision.kind}${'reason' in decision ? `: ${decision.reason}` : ''}`);

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
          emit('executor-started', `${decision.mode} task ${decision.taskId} via ${decision.worker.workerId}`);
          beginExecutorDispatch(deps, jobId, {
            nodeId: decision.nodeId,
            mode: decision.mode,
            workerId: decision.worker.workerId,
          });
          const startedAt = (deps.clock ?? (() => new Date()))().toISOString();
          // Later tasks run over earlier verified (uncommitted) changes, and
          // a repair runs over its own failed attempt: same rule as `--all`.
          const allowDirty =
            decision.mode === 'repair' ||
            (graph?.nodes.some((candidate) => candidate.status === 'COMPLETED') ?? false) ||
            node.attempts.some((attempt) => attempt.role === 'EXECUTOR');
          const dispatch = await dispatchExecutor({
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
