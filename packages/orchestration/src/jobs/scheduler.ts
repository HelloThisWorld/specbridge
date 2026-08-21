import type { JobPolicy, JobSchedulerPolicy } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import type { QuotaForecast } from '../quota/state.js';
import type { NodeLaneRouting } from '../scheduling/scheduler.js';
import { selectReadyCandidate } from '../scheduling/scheduler.js';
import type { ExecutionLane, SchedulingReasonCode } from '../scheduling/vocabulary.js';
import { isSubscriptionExhausted } from '../scheduling/vocabulary.js';
import { findNode, nextSchedulableNode, unfinishedNodes } from './graph.js';
import { selectWorker } from './routing.js';
import type { JobGraph, JobNode, JobState, JobWorkerProfile } from './state.js';
import type { AgentRole, EscalationReason } from './vocabulary.js';
import { isFinalJobStatus } from './vocabulary.js';

/**
 * The deterministic scheduler.
 *
 * One pure function: given the persisted job, the active graph, the policy,
 * the worker roster, and the clock reading, produce the single next action.
 * The driver executes decisions; it never invents them. Because the function
 * is pure, every decision is exactly reproducible in tests — and in the
 * audit trail, where the decision's `reason` is recorded verbatim.
 *
 * Scheduling order is fixed: budgets are checked before anything may run,
 * the current node is the first schedulable node in graph order, and the
 * node's pipeline (classify → plan → critique → review gate → execute)
 * advances one bounded step at a time. `maxConcurrentTasks` is 1 in this
 * version, so there is never more than one current node.
 */

export type SchedulerDecision =
  | { kind: 'BUILD_GRAPH'; reason: string }
  | {
      kind: 'RUN_ROLE';
      role: AgentRole;
      nodeId: string;
      worker: JobWorkerProfile;
      reason: string;
      escalation?: { reason: EscalationReason; detail: string };
    }
  | {
      kind: 'DISPATCH_EXECUTOR';
      nodeId: string;
      taskId: string;
      worker: JobWorkerProfile;
      mode: 'implement' | 'repair';
      reason: string;
      /** vNext.2: the economic lane this dispatch runs on, when scheduled. */
      lane?: ExecutionLane;
      /** vNext.2: the lane assessment behind the decision (audit/record). */
      laneRouting?: NodeLaneRouting;
      /** vNext.2: context must be compacted/reconstructed before dispatch. */
      compactFirst?: boolean;
    }
  | { kind: 'WAIT_RETRY'; retryAt: string; reason: string }
  | {
      /** vNext.2: subscription capacity cannot take this work right now. */
      kind: 'WAIT_QUOTA';
      nodeId: string;
      taskId: string;
      /** When capacity is expected to return (ISO), when known. */
      until: string | null;
      reasonCode: SchedulingReasonCode;
      reason: string;
      laneRouting?: NodeLaneRouting;
      /**
       * vNext.5: the wait is for a human spend authorization, not for
       * capacity. The task stays durably pending either way — the driver
       * uses this to record the bounded approval request rather than to
       * change what waiting means.
       */
      awaitingApiApproval?: boolean;
    }
  | {
      kind: 'AWAIT_HUMAN';
      what: 'clarification' | 'plan-review';
      nodeId?: string;
      reason: string;
    }
  | { kind: 'JOB_COMPLETE'; reason: string }
  | { kind: 'JOB_BLOCKED'; reason: string; budget?: string }
  | { kind: 'JOB_FINAL'; reason: string };

export interface ScheduleInput {
  job: JobState;
  /** Active graph; undefined only while the job is CREATED. */
  graph: JobGraph | undefined;
  policy: JobPolicy;
  workers: readonly JobWorkerProfile[];
  now: Date;
  /**
   * vNext.2 lane-scheduling context. Absent (the default for callers that
   * predate it, and whenever `scheduler.enabled` is false) the function
   * behaves byte-identically to vNext.1. Present, executor dispatches gain
   * a lane, quota-deferred work becomes WAIT_QUOTA, and ready-node
   * selection may prefer a runnable node over a deferring one.
   */
  scheduling?: LaneSchedulingContext | undefined;
}

/**
 * Everything the lane decisions need, precomputed by the driver from
 * durable state and telemetry so this function stays pure and replayable.
 */
export interface LaneSchedulingContext {
  policy: JobSchedulerPolicy;
  forecast: QuotaForecast;
  /** The dynamic reserve ratio in force. */
  reserveRatio: number;
  /** Per-node lane assessments, keyed by nodeId. */
  routings: ReadonlyMap<string, NodeLaneRouting>;
}

/** Escalation reasons recorded for a node, in order (sticky routing input). */
function nodeEscalations(job: JobState, nodeId: string): EscalationReason[] {
  return job.escalations
    .filter((entry) => entry.nodeId === nodeId)
    .map((entry) => entry.reason);
}

/**
 * vNext.2 quota gate for reasoning-role dispatches: a PAID worker may not
 * be invoked while the subscription lane is exhausted. The step waits for
 * the relevant reset; local-tier role work is never gated.
 */
function gateRoleQuota(
  scheduling: LaneSchedulingContext | undefined,
  decision: Extract<SchedulerDecision, { kind: 'RUN_ROLE' }>,
  node: JobNode,
): SchedulerDecision {
  if (scheduling === undefined || !scheduling.policy.enabled) return decision;
  if (decision.worker.costTier !== 'PAID') return decision;
  const mode = scheduling.forecast.schedulerMode;
  if (!isSubscriptionExhausted(mode)) return decision;
  const fiveHour = mode === 'EXHAUSTED_5H';
  return {
    kind: 'WAIT_QUOTA',
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    until: fiveHour ? scheduling.forecast.fiveHourResetAt : scheduling.forecast.weeklyResetAt,
    reasonCode: fiveHour ? 'FIVE_HOUR_EXHAUSTED' : 'WEEKLY_EXHAUSTED',
    reason:
      `The ${decision.role} step needs the paid worker, but the ` +
      `${fiveHour ? 'five-hour' : 'weekly'} subscription window is exhausted; the step waits for the reset.`,
  };
}

/**
 * vNext.2 lane-aware node selection. Only reorders among READY nodes (every
 * candidate's dependencies are satisfied), only when a complete lane
 * assessment exists for each, and only while the job itself is READY — the
 * DIAGNOSING/REPLANNING flows keep the vNext.1 first-in-graph-order rule so
 * recovery always continues on the node that failed.
 */
function selectSchedulableNode(input: ScheduleInput): JobNode | undefined {
  const graph = input.graph;
  if (graph === undefined) return undefined;
  const first = nextSchedulableNode(graph);
  const scheduling = input.scheduling;
  if (scheduling === undefined || !scheduling.policy.enabled) return first;
  if (input.job.status !== 'READY') return first;
  if (first === undefined || first.status !== 'READY') return first;
  const ready = graph.nodes.filter((candidate) => candidate.status === 'READY');
  if (ready.length <= 1) return first;
  const candidates = ready.flatMap((candidate, index) => {
    const routing = scheduling.routings.get(candidate.nodeId);
    return routing === undefined
      ? []
      : [{ nodeId: candidate.nodeId, graphIndex: index, routing: routing.routing }];
  });
  if (candidates.length !== ready.length) return first;
  const selection = selectReadyCandidate(candidates);
  if (selection === undefined) return first;
  return findNode(graph, selection.nodeId) ?? first;
}

/** The executor dispatches (implement + repair) already attempted on a node. */
export function executorAttempts(node: JobNode): number {
  return node.attempts.filter((attempt) => attempt.role === 'EXECUTOR').length;
}

function successfulAttemptIndex(node: JobNode, role: AgentRole): number {
  for (let index = node.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = node.attempts[index];
    if (attempt !== undefined && attempt.role === role && attempt.outcome === 'succeeded') {
      return index;
    }
  }
  return -1;
}

/** Budget checks that apply before ANY dispatch. Returns a stop decision or null. */
function checkJobBudgets(input: ScheduleInput): SchedulerDecision | null {
  const { job, policy, now } = input;
  const elapsed = Math.max(0, now.getTime() - Date.parse(job.createdAt));
  if (elapsed >= job.budgets.maxWallClockMs) {
    return {
      kind: 'JOB_BLOCKED',
      budget: 'maxWallClockMs',
      reason: `The job reached its ${job.budgets.maxWallClockMs}ms wall-clock budget.`,
    };
  }
  if (job.counters.agentRuns >= job.budgets.maxAgentRuns) {
    return {
      kind: 'JOB_BLOCKED',
      budget: 'maxAgentRuns',
      reason: `The job reached its ${job.budgets.maxAgentRuns}-dispatch budget.`,
    };
  }
  if (
    job.budgets.maxCostUsd !== null &&
    job.counters.reportedCostUsd !== null &&
    job.counters.reportedCostUsd >= job.budgets.maxCostUsd
  ) {
    return {
      kind: 'JOB_BLOCKED',
      budget: 'maxCostUsd',
      reason:
        `Provider-reported cost (${job.counters.reportedCostUsd.toFixed(2)} USD) reached the ` +
        `configured ${job.budgets.maxCostUsd} USD budget.`,
    };
  }
  if (
    job.budgets.maxTokens !== null &&
    job.counters.reportedTokens !== null &&
    job.counters.reportedTokens >= job.budgets.maxTokens
  ) {
    return {
      kind: 'JOB_BLOCKED',
      budget: 'maxTokens',
      reason: `Provider-reported token usage reached the configured ${job.budgets.maxTokens}-token budget.`,
    };
  }
  const localBudgetLeft = job.counters.localInferenceCalls < job.budgets.maxLocalInferenceCalls;
  if (!localBudgetLeft && policy.escalation === 'manual') {
    // With automatic escalation the roster simply routes around the local
    // worker; in manual mode the user asked to decide about paid reasoning
    // themselves, so an exhausted local budget stops the job explicitly.
    return {
      kind: 'JOB_BLOCKED',
      budget: 'maxLocalInferenceCalls',
      reason: `The local inference budget of ${job.budgets.maxLocalInferenceCalls} calls is exhausted and escalation is manual.`,
    };
  }
  return null;
}

/**
 * Decide the next action. Pure; throws only on structurally inconsistent
 * input (which reconciliation is required to fix before scheduling).
 */
export function scheduleNext(input: ScheduleInput): SchedulerDecision {
  const { job, graph, policy, workers } = input;

  if (isFinalJobStatus(job.status)) {
    return { kind: 'JOB_FINAL', reason: `The job is ${job.status}; nothing may run.` };
  }
  if (job.status === 'RUNNING' || job.status === 'REPAIRING') {
    // An executor dispatch appears to be in flight. Inside one driver
    // process the scheduler is never consulted mid-dispatch, so this means
    // the previous process died. Resume reconciliation must run first.
    // (DIAGNOSING and REPLANNING are schedulable: their role runs are
    // re-derivable from persisted state at any time.)
    throw new OrchestrationError(
      'SBO030',
      `The job is ${job.status} but no dispatch is active in this process; resume reconciliation is required before scheduling.`,
      { remediation: ['Run resumeJob() (the orchestrate command does this automatically).'] },
    );
  }
  if (job.status === 'BLOCKED') {
    return {
      kind: 'JOB_BLOCKED',
      reason: job.blocker?.message ?? 'The job is blocked and needs an explicit user action.',
    };
  }
  if (job.status === 'NEEDS_CLARIFICATION') {
    return {
      kind: 'AWAIT_HUMAN',
      what: 'clarification',
      reason:
        job.openQuestions.length > 0
          ? `${job.openQuestions.length} clarification question(s) are open.`
          : 'A user decision is required before the job can continue.',
    };
  }
  if (job.status === 'WAITING_RETRY') {
    const retryAt = job.retryAt ?? input.now.toISOString();
    if (Date.parse(retryAt) > input.now.getTime()) {
      return { kind: 'WAIT_RETRY', retryAt, reason: `A transient failure defers the next attempt until ${retryAt}.` };
    }
    // The wait elapsed; fall through to normal scheduling below.
  }

  const budgetStop = checkJobBudgets(input);
  if (budgetStop !== null) return budgetStop;

  if (job.status === 'CREATED' || graph === undefined || job.graphRevision === 0) {
    return { kind: 'BUILD_GRAPH', reason: 'No runtime execution graph exists yet.' };
  }

  const node = selectSchedulableNode(input);
  if (node === undefined) {
    if (unfinishedNodes(graph).length === 0) {
      return { kind: 'JOB_COMPLETE', reason: 'Every runtime node completed through verified evidence.' };
    }
    return {
      kind: 'JOB_BLOCKED',
      reason: 'No node is schedulable but unfinished nodes remain (blocked or failed nodes need an explicit decision).',
    };
  }

  if (node.status === 'RUNNING' || node.status === 'REPAIRING') {
    throw new OrchestrationError(
      'SBO030',
      `Node ${node.nodeId} is ${node.status} but no dispatch is active; resume reconciliation is required.`,
    );
  }

  // Per-node budget checks, before advancing its pipeline.
  if (executorAttempts(node) >= job.budgets.maxTaskAttempts) {
    return {
      kind: 'JOB_BLOCKED',
      budget: 'maxTaskAttempts',
      reason:
        `Task ${node.parentTaskId} used all ${job.budgets.maxTaskAttempts} execution attempts ` +
        'without verified completion. Evidence is preserved.',
    };
  }

  const escalations = nodeEscalations(job, node.nodeId);

  // ---- Failure-recovery statuses (before the ordinary pipeline) -----------

  // DIAGNOSING: a reasoned diagnosis is mandatory before any repair.
  if (job.status === 'DIAGNOSING') {
    const selection = selectWorker({
      role: 'DIAGNOSER',
      complexity: node.complexity,
      policy,
      workers,
      nodeEscalations: escalations,
    });
    return gateRoleQuota(
      input.scheduling,
      {
        kind: 'RUN_ROLE',
        role: 'DIAGNOSER',
        nodeId: node.nodeId,
        worker: selection.worker,
        reason: `The last dispatch for task ${node.parentTaskId} failed (${node.latestFailure?.category ?? 'unknown'}); a diagnosis is required before any repair.`,
        ...(selection.escalation !== undefined ? { escalation: selection.escalation } : {}),
      },
      node,
    );
  }

  // REPLANNING: the active plan was invalidated; a replacement is required.
  if (job.status === 'REPLANNING') {
    const role = node.planRevision > 0 ? 'REPLANNER' : 'PLANNER';
    const selection = selectWorker({
      role,
      complexity: node.complexity,
      policy,
      workers,
      nodeEscalations: escalations,
    });
    return gateRoleQuota(
      input.scheduling,
      {
        kind: 'RUN_ROLE',
        role,
        nodeId: node.nodeId,
        worker: selection.worker,
        reason:
          role === 'REPLANNER'
            ? 'The active plan was invalidated; a replacement plan is required.'
            : 'A fresh plan is required after the previous approach was superseded.',
        ...(selection.escalation !== undefined ? { escalation: selection.escalation } : {}),
      },
      node,
    );
  }

  // ---- Node pipeline -------------------------------------------------------

  // 1. Classification: one successful CLASSIFIER pass per node, when routed.
  if (
    node.complexity === undefined ||
    (policy.routing.classifier !== 'disabled' && successfulAttemptIndex(node, 'CLASSIFIER') < 0)
  ) {
    if (policy.routing.classifier === 'disabled') {
      // Deterministic assessment only; job-service assigns it when building
      // the graph or promoting the node. Reaching here with no complexity is
      // an inconsistency.
      throw new OrchestrationError(
        'SBO030',
        `Node ${node.nodeId} has no complexity class and the classifier is disabled; the deterministic assessment must run first.`,
      );
    }
    const selection = selectWorker({
      role: 'CLASSIFIER',
      complexity: node.complexity,
      policy,
      workers,
      nodeEscalations: escalations,
    });
    return gateRoleQuota(
      input.scheduling,
      {
        kind: 'RUN_ROLE',
        role: 'CLASSIFIER',
        nodeId: node.nodeId,
        worker: selection.worker,
        reason: 'The node has not been classified yet; a classification can only raise the deterministic class.',
        ...(selection.escalation !== undefined ? { escalation: selection.escalation } : {}),
      },
      node,
    );
  }

  // 2. Planning: the node needs an execution plan.
  if (node.planRevision === 0) {
    const selection = selectWorker({
      role: 'PLANNER',
      complexity: node.complexity,
      policy,
      workers,
      nodeEscalations: escalations,
    });
    return gateRoleQuota(
      input.scheduling,
      {
        kind: 'RUN_ROLE',
        role: 'PLANNER',
        nodeId: node.nodeId,
        worker: selection.worker,
        reason: `Node ${node.nodeId} (task ${node.parentTaskId}) has no execution plan.`,
        ...(selection.escalation !== undefined ? { escalation: selection.escalation } : {}),
      },
      node,
    );
  }

  // 3. A critiqued-but-rejected plan goes back to the planner: REVISE means
  //    address the critique, ESCALATE means the sticky escalation reroutes
  //    the next planning pass to the large agent.
  if (
    !node.planApproved &&
    node.planRevision > 0 &&
    node.criticPlanRevision === node.planRevision &&
    (node.criticVerdict === 'REVISE' || node.criticVerdict === 'ESCALATE')
  ) {
    const selection = selectWorker({
      role: 'PLANNER',
      complexity: node.complexity,
      policy,
      workers,
      nodeEscalations: escalations,
    });
    return gateRoleQuota(
      input.scheduling,
      {
        kind: 'RUN_ROLE',
        role: 'PLANNER',
        nodeId: node.nodeId,
        worker: selection.worker,
        reason:
          node.criticVerdict === 'REVISE'
            ? `The critic requested revisions to plan revision ${node.planRevision}.`
            : `The critic escalated plan revision ${node.planRevision}; planning reroutes to the large agent.`,
        ...(selection.escalation !== undefined ? { escalation: selection.escalation } : {}),
      },
      node,
    );
  }

  // 4. Critique: local plans are reviewed by the critic before execution.
  if (!node.planApproved) {
    const criticEnabled = policy.routing.critic !== 'disabled';
    const criticDone = node.criticPlanRevision === node.planRevision && node.criticVerdict !== undefined;
    const planFromLocal = node.planProducedByTier === 'LOCAL_SMALL';
    if (criticEnabled && planFromLocal && !criticDone) {
      const selection = selectWorker({
        role: 'CRITIC',
        complexity: node.complexity,
        policy,
        workers,
        nodeEscalations: escalations,
      });
      return gateRoleQuota(
        input.scheduling,
        {
          kind: 'RUN_ROLE',
          role: 'CRITIC',
          nodeId: node.nodeId,
          worker: selection.worker,
          reason: `Plan revision ${node.planRevision} was produced by the local planner and has not been critiqued.`,
          ...(selection.escalation !== undefined ? { escalation: selection.escalation } : {}),
        },
        node,
      );
    }
    if (node.humanReviewRequired) {
      return {
        kind: 'AWAIT_HUMAN',
        what: 'plan-review',
        nodeId: node.nodeId,
        reason: `Plan revision ${node.planRevision} for task ${node.parentTaskId} requires an explicit human review (${policy.planReview} policy).`,
      };
    }
    // Neither critic nor human gate applies: an inconsistency, because
    // job-service always either approves the plan or sets a gate.
    throw new OrchestrationError(
      'SBO030',
      `Node ${node.nodeId} has an unapproved plan with no pending gate; the plan lifecycle is inconsistent.`,
    );
  }

  // 5. Execute (or repair): the plan is approved and current.
  const mode: 'implement' | 'repair' = node.latestDiagnosis?.recommendedAction === 'REPAIR' ? 'repair' : 'implement';
  const baseReason =
    mode === 'repair'
      ? `A diagnosed defect on task ${node.parentTaskId} is being repaired (cycle ${node.repairCycles + 1}).`
      : `Task ${node.parentTaskId} has an approved plan (revision ${node.planRevision}) and is ready to implement.`;

  // vNext.2: the lane decision controls the dispatch. LOCAL runs through
  // the SpecBridge-driven local execution path (structured edits +
  // deterministic verification); SUBSCRIPTION runs the normal strong
  // worker; DEFER waits for quota with a recorded reason. Without a
  // scheduling context the vNext.1 path below is byte-identical.
  const scheduling = input.scheduling;
  const laneRouting = scheduling?.routings.get(node.nodeId);
  if (scheduling !== undefined && scheduling.policy.enabled && laneRouting !== undefined) {
    const routing = laneRouting.routing;
    if (routing.lane === 'DEFER' || routing.lane === 'REQUIRE_APPROVAL') {
      return {
        kind: 'WAIT_QUOTA',
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        until: routing.deferUntil,
        reasonCode: routing.reasonCode,
        reason: routing.detail,
        laneRouting,
        ...(routing.lane === 'REQUIRE_APPROVAL' ? { awaitingApiApproval: true } : {}),
      };
    }
    // vNext.5: the paid continuity bridge. It reaches this point only
    // because the gap-bridge planner already refused every cheaper option,
    // and it dispatches through the SAME executor path as every other lane
    // — one durable attempt, one evidence pipeline, one verdict.
    if (routing.lane === 'API') {
      return {
        kind: 'DISPATCH_EXECUTOR',
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        // The API lane runs its own bound harness runtime, not a
        // subscription worker. The worker profile is carried for roster
        // bookkeeping; the runner identity comes from the API binding.
        worker: selectWorker({
          role: 'EXECUTOR',
          complexity: node.complexity,
          policy,
          workers,
          nodeEscalations: escalations,
        }).worker,
        mode,
        lane: 'API',
        laneRouting,
        compactFirst: routing.compactFirst,
        reason: `${baseReason} ${routing.detail}`,
      };
    }
    if (routing.lane === 'LOCAL') {
      const localWorker = workers.find((worker) => worker.reasoningTier === 'LOCAL_SMALL');
      if (localWorker !== undefined) {
        return {
          kind: 'DISPATCH_EXECUTOR',
          nodeId: node.nodeId,
          taskId: node.parentTaskId,
          worker: localWorker,
          mode,
          lane: 'LOCAL',
          laneRouting,
          compactFirst: false,
          reason: `${baseReason} ${routing.detail}`,
        };
      }
      // The routing believed a local worker existed but the roster has
      // none: fall through to the subscription path with the discrepancy
      // visible in the reason.
    }
    const subscriptionExecutor = selectWorker({
      role: 'EXECUTOR',
      complexity: node.complexity,
      policy,
      workers,
      nodeEscalations: escalations,
    });
    return {
      kind: 'DISPATCH_EXECUTOR',
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      worker: subscriptionExecutor.worker,
      mode,
      lane: 'SUBSCRIPTION',
      laneRouting,
      compactFirst: routing.compactFirst,
      reason: `${baseReason} ${routing.detail}`,
    };
  }

  const executor = selectWorker({
    role: 'EXECUTOR',
    complexity: node.complexity,
    policy,
    workers,
    nodeEscalations: escalations,
  });
  return {
    kind: 'DISPATCH_EXECUTOR',
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    worker: executor.worker,
    mode,
    reason: baseReason,
  };
}
