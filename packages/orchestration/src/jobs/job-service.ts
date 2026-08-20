import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig, JobPolicy, WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, jobPolicyFingerprint, writeFileAtomic } from '@specbridge/core';
import { captureGitSnapshot } from '@specbridge/evidence';
import { readInteractiveLock } from '@specbridge/execution';
import type { Clock } from '@specbridge/workflow';
import { systemClock } from '@specbridge/workflow';
import { OrchestrationError } from '../errors.js';
import type { ClassifiedFailure } from '../failure.js';
import { classifyFailure } from '../failure.js';
import type { ExecutionPlan, ObservationFingerprint } from '../state.js';
import { executionPlanSchema, observationFingerprintSchema } from '../state.js';
import type { PlanCandidateInput } from '../planning.js';
import { buildExecutionPlan, capturePlanBinding, evaluatePlanFreshness } from '../planning.js';
import { assessProgress, diffFingerprint } from '../progress.js';
import { backoffForAttempt } from '../retry.js';
import type { FailureCategory } from '../vocabulary.js';
import { assessComplexity, mergeComplexity } from './complexity.js';
import type { ComplexityInput } from './complexity.js';
import {
  allNodesComplete,
  buildInitialGraph,
  findNode,
  promoteReadyNodes,
  requireNode,
  reviseGraphSuperseding,
  transitionNode,
  withNode,
} from './graph.js';
import { assertJobTransition } from './state-machine.js';
import type { JobCheckpoint, JobGraph, JobNode, JobState, NodeAttempt } from './state.js';
import {
  JOB_CHECKPOINT_SCHEMA_VERSION,
  JOB_STATE_SCHEMA_VERSION,
  jobCheckpointSchema,
  jobGraphSchema,
} from './state.js';
import {
  appendJobEvent,
  countJobEvents,
  initializeJobRecord,
  jobDir,
  listGraphRevisions,
  readGraphRevision,
  readJobCheckpoint,
  readNodePlan,
  requireGraphRevision,
  requireJobState,
  storeGraphRevision,
  storeNodePlan,
  writeJobCheckpoint,
  writeJobState,
} from './store.js';
import type {
  AgentRole,
  ComplexityClass,
  EscalationReason,
  JobEventType,
  JobStatus,
} from './vocabulary.js';
import { isFinalJobStatus } from './vocabulary.js';
import {
  beginTaskAttempt,
  completeTaskAttempt,
  createTaskCheckpoint,
  reconcileInterruptedAttempts,
} from '../survival/service.js';
import { listTaskAttempts, readTaskAttempt } from '../survival/store.js';
import { isFinalAttemptStatus } from '../survival/vocabulary.js';

/**
 * The job application service.
 *
 * Every operation is: load state → validate against policy and the state
 * machines → compute a deterministic decision → persist atomically → append
 * an event. The driver, the CLI, and the MCP surface call these functions;
 * none of them re-implements a transition, a budget, or a routing rule.
 *
 * The service never invokes a model, never runs a repository command, never
 * touches `.kiro`, and never decides that a task is complete — task
 * completion arrives here only as the REPORTED evidence status of the
 * existing execution pipeline, and anything other than verified evidence is
 * refused (SBO022 semantics, unchanged from v1.1).
 */

export interface JobDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  clock?: Clock | undefined;
  idFactory?: (() => string) | undefined;
  /** Host label recorded on the job (e.g. "cli", "daemon"). */
  host?: string | undefined;
}

function policyOf(deps: JobDeps): JobPolicy {
  return deps.config.orchestration.jobs;
}

function now(deps: JobDeps): Date {
  return (deps.clock ?? systemClock)();
}

function newId(deps: JobDeps): string {
  return (deps.idFactory ?? randomUUID)();
}

function assertJobsEnabled(deps: JobDeps): void {
  if (policyOf(deps).enabled) return;
  throw new OrchestrationError(
    'SBO025',
    'Job orchestration is disabled by `orchestration.jobs.enabled` in .specbridge/config.json.',
    { remediation: ['Set orchestration.jobs.enabled to true, or drive tasks interactively.'] },
  );
}

/** Append an event, keeping the persisted counter and the log consistent. */
function record(
  deps: JobDeps,
  job: JobState,
  type: JobEventType,
  payload: Record<string, unknown> = {},
): JobState {
  const stored = countJobEvents(deps.workspace, job.jobId);
  if (stored >= job.budgets.maxEvents) {
    throw new OrchestrationError(
      'SBO020',
      `The job event history reached its ${job.budgets.maxEvents}-event limit. ` +
        'History is never truncated, so the job stops here instead.',
      {
        remediation: ['All evidence is preserved. Create a new job, or raise the event budget explicitly.'],
        failureCategory: 'BUDGET_EXHAUSTED',
      },
    );
  }
  appendJobEvent(
    deps.workspace,
    job.jobId,
    { at: now(deps).toISOString(), type, ...payload },
    { maxEventBytes: deps.config.orchestration.history.maxEventBytes },
  );
  return { ...job, counters: { ...job.counters, events: stored + 1 } };
}

function transition(deps: JobDeps, job: JobState, to: JobStatus): JobState {
  assertJobTransition(job.status, to);
  return { ...job, status: to, updatedAt: now(deps).toISOString() };
}

function persist(deps: JobDeps, job: JobState): JobState {
  return writeJobState(deps.workspace, { ...job, updatedAt: now(deps).toISOString() });
}

/**
 * Persist the graph. Revision-number changes always land in a NEW file
 * (append-only history); node progress WITHIN a revision rewrites the
 * current revision file atomically.
 */
function persistGraph(deps: JobDeps, job: JobState, graph: JobGraph): JobGraph {
  const existing = readGraphRevision(deps.workspace, job.jobId, graph.revision);
  if (existing === undefined) {
    return storeGraphRevision(deps.workspace, job.jobId, graph).graph;
  }
  const validated = jobGraphSchema.parse(graph);
  const file = assertInsideWorkspace(
    deps.workspace.rootDir,
    path.join(
      jobDir(deps.workspace, job.jobId),
      'graphs',
      `${String(validated.revision).padStart(4, '0')}.json`,
    ),
  );
  if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateJobRequest {
  specName: string;
  /** The user's stated goal. Stored verbatim as DATA, never as instructions. */
  goal: string;
}

export function createJob(deps: JobDeps, request: CreateJobRequest): JobState {
  assertJobsEnabled(deps);
  const policy = policyOf(deps);
  const goal = request.goal.trim();
  if (goal.length === 0) {
    throw new OrchestrationError('SBO006', 'A job needs a stated goal.', {
      remediation: ['Describe what should be accomplished, in one or two sentences.'],
    });
  }

  const createdAt = now(deps).toISOString();
  const job: JobState = {
    schemaVersion: JOB_STATE_SCHEMA_VERSION,
    jobId: `job-${newId(deps)}`,
    specName: request.specName,
    status: 'CREATED',
    goal: goal.slice(0, 4_000),
    createdAt,
    updatedAt: createdAt,
    host: deps.host ?? 'cli',
    policyFingerprint: jobPolicyFingerprint(deps.config.orchestration),
    budgets: {
      maxAgentRuns: policy.budgets.maxAgentRuns,
      maxTaskAttempts: policy.budgets.maxTaskAttempts,
      maxRepairCyclesPerTask: policy.budgets.maxRepairCyclesPerTask,
      maxReplansPerTask: policy.budgets.maxReplansPerTask,
      maxJobReplans: policy.budgets.maxJobReplans,
      maxNoProgressCycles: policy.budgets.maxNoProgressCycles,
      maxTransientRetries: policy.budgets.maxTransientRetries,
      maxWallClockMs: policy.budgets.maxWallClockMs,
      maxLocalInferenceCalls: policy.budgets.maxLocalInferenceCalls,
      maxEvents: policy.budgets.maxEvents,
      maxCostUsd: policy.budgets.maxCostUsd,
      maxTokens: policy.budgets.maxTokens,
    },
    counters: {
      agentRuns: 0,
      localInferenceCalls: 0,
      jobReplans: 0,
      transientRetries: 0,
      clarificationRounds: 0,
      escalations: 0,
      events: 0,
      reportedCostUsd: null,
      reportedTokens: null,
    },
    graphRevision: 0,
    openQuestions: [],
    decisions: [],
    escalations: [],
  };

  initializeJobRecord(deps.workspace, job);
  const recorded = record(deps, job, 'job_created', { specName: job.specName });
  return persist(deps, recorded);
}

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

/**
 * Build the initial runtime execution graph and assess every node's
 * deterministic complexity. No model is involved: this is the BUILD_GRAPH
 * scheduler directive, and it is fully replayable.
 */
export async function buildJobGraph(deps: JobDeps, jobId: string): Promise<{ job: JobState; graph: JobGraph }> {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  if (job.status !== 'CREATED') {
    throw new OrchestrationError('SBO027', `The graph is built exactly once, from CREATED (job is ${job.status}).`);
  }

  const snapshot = await captureGitSnapshot(deps.workspace.rootDir, { clock: () => now(deps) });
  const built = buildInitialGraph(deps.workspace, {
    jobId,
    specName: job.specName,
    createdAt: now(deps).toISOString(),
    gitHead: snapshot.head,
  });

  // Deterministic complexity for every node, upfront and recorded.
  const policy = policyOf(deps);
  const graph: JobGraph = {
    ...built.graph,
    nodes: built.graph.nodes.map((node) => {
      const assessment = assessComplexity(complexityInputFor(node), policy.complexity);
      return {
        ...node,
        complexity: assessment.class,
        complexitySignals: assessment.signals.map(
          (signal) => `${signal.signal}(+${signal.weight})${signal.forcesHigh ? '!' : ''}`,
        ),
      };
    }),
  };

  storeGraphRevision(deps.workspace, jobId, graph);
  job = { ...job, graphRevision: graph.revision, currentNodeId: graph.nodes[0]?.nodeId };
  job = transition(deps, job, 'PLANNING');
  job = record(deps, job, 'graph_created', {
    revision: graph.revision,
    nodes: graph.nodes.length,
    ...(built.skippedCompleted.length > 0 ? { skippedCompleted: built.skippedCompleted.length } : {}),
  });
  job = transition(deps, job, 'READY');
  return { job: persist(deps, job), graph };
}

function complexityInputFor(node: JobNode): ComplexityInput {
  return {
    taskId: node.parentTaskId,
    title: node.title,
    requirementRefs: [],
    childCount: 0,
    previousFailureCount: 0,
    previousReplanCount: node.replans,
  };
}

export function activeGraph(deps: JobDeps, job: JobState): JobGraph | undefined {
  if (job.graphRevision === 0) return undefined;
  return requireGraphRevision(deps.workspace, job.jobId, job.graphRevision);
}

// ---------------------------------------------------------------------------
// Role results
// ---------------------------------------------------------------------------

export interface AttemptContext {
  nodeId: string;
  role: AgentRole;
  workerId: string;
  startedAt: string;
  agentResultRef?: string | undefined;
  runId?: string | undefined;
  usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | undefined;
}

/** Fold one finished attempt into the node and the job counters. */
function appendAttempt(
  deps: JobDeps,
  job: JobState,
  graph: JobGraph,
  context: AttemptContext,
  outcome: NodeAttempt['outcome'],
  extras: Partial<NodeAttempt> = {},
): { job: JobState; graph: JobGraph } {
  const node = requireNode(graph, context.nodeId);
  const attempt: NodeAttempt = {
    attempt: node.attempts.length + 1,
    role: context.role,
    workerId: context.workerId,
    startedAt: context.startedAt,
    finishedAt: now(deps).toISOString(),
    outcome,
    ...(context.agentResultRef !== undefined ? { agentResultRef: context.agentResultRef } : {}),
    ...(context.runId !== undefined ? { runId: context.runId } : {}),
    ...(context.usage !== undefined ? { usage: context.usage } : {}),
    ...extras,
  };
  const nextGraph = withNode(graph, { ...node, attempts: [...node.attempts, attempt] });

  const usage = context.usage;
  const reportedTokens =
    usage?.inputTokens !== null && usage?.inputTokens !== undefined
      ? (job.counters.reportedTokens ?? 0) + usage.inputTokens + (usage.outputTokens ?? 0)
      : job.counters.reportedTokens;
  const reportedCostUsd =
    usage?.costUsd !== null && usage?.costUsd !== undefined
      ? (job.counters.reportedCostUsd ?? 0) + usage.costUsd
      : job.counters.reportedCostUsd;

  const nextJob: JobState = {
    ...job,
    counters: {
      ...job.counters,
      agentRuns: job.counters.agentRuns + 1,
      reportedTokens,
      reportedCostUsd,
    },
  };
  return { job: nextJob, graph: nextGraph };
}

/** Record an escalation on the job (audit + sticky routing input). */
export function recordEscalation(
  deps: JobDeps,
  job: JobState,
  input: { nodeId?: string; role: AgentRole; reason: EscalationReason; detail: string },
): JobState {
  const at = now(deps).toISOString();
  const entry = {
    at,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    role: input.role,
    reason: input.reason,
    detail: input.detail.slice(0, 2_000),
  };
  let next: JobState = {
    ...job,
    escalations: [...job.escalations, entry].slice(-100),
    counters: { ...job.counters, escalations: job.counters.escalations + 1 },
  };
  next = record(deps, next, 'worker_escalated', {
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    role: input.role,
    reason: input.reason,
  });
  return next;
}

/** Mark planning as started (job READY → PLANNING; resume-safe). */
export function beginPlanning(deps: JobDeps, jobId: string, nodeId: string): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  if (job.status === 'PLANNING') return job;
  job = transition(deps, job, 'PLANNING');
  job = { ...job, currentNodeId: nodeId };
  job = record(deps, job, 'planning_started', { nodeId });
  return persist(deps, job);
}

/**
 * Record a role run that did not produce a usable structured result.
 *
 * A local model crash or invalid output is a WORKER failure, never a task
 * failure: the node keeps its status, the failure is recorded on the attempt
 * history, and (when an escalation reason is given) the sticky escalation
 * reroutes the role to the large agent on the next scheduling pass. The
 * job's own status only moves when the caller separately decides to block.
 */
export function recordRoleFailure(
  deps: JobDeps,
  jobId: string,
  input: {
    context: AttemptContext;
    outcome: 'failed' | 'invalid-output' | 'cancelled' | 'escalated';
    failureCategory?: FailureCategory | undefined;
    escalation?: { reason: EscalationReason; detail: string } | undefined;
  },
): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  ({ job, graph } = appendAttempt(deps, job, graph, input.context, input.outcome, {
    ...(input.failureCategory !== undefined ? { failureCategory: input.failureCategory } : {}),
    ...(input.escalation !== undefined ? { escalationReason: input.escalation.reason } : {}),
  }));
  if (input.escalation !== undefined) {
    job = recordEscalation(deps, job, {
      nodeId: input.context.nodeId,
      role: input.context.role,
      reason: input.escalation.reason,
      detail: input.escalation.detail,
    });
  }
  // A failed PLANNING role run returns the job to READY so the scheduler can
  // re-route; DIAGNOSING/REPLANNING stay, because the same role re-runs there.
  if (job.status === 'PLANNING') {
    job = transition(deps, job, 'READY');
  }
  persistGraph(deps, job, graph);
  return persist(deps, job);
}

export interface ClassificationResult {
  context: AttemptContext;
  /** The classifier's proposed class; may only RAISE the deterministic one. */
  proposedClass: ComplexityClass;
}

export function recordClassification(
  deps: JobDeps,
  jobId: string,
  result: ClassificationResult,
): { job: JobState; effectiveClass: ComplexityClass } {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, result.context.nodeId);

  const deterministic = node.complexity ?? 'LOW';
  const effective = mergeComplexity(deterministic, result.proposedClass);

  ({ job, graph } = appendAttempt(deps, job, graph, result.context, 'succeeded'));
  graph = withNode(graph, {
    ...requireNode(graph, node.nodeId),
    complexity: effective,
    complexitySignals:
      effective !== deterministic
        ? [...node.complexitySignals, `classifier-raised(${deterministic}->${effective})`]
        : node.complexitySignals,
  });
  job = record(deps, job, 'classification_completed', {
    nodeId: node.nodeId,
    deterministic,
    proposed: result.proposedClass,
    effective,
  });
  persistGraph(deps, job, graph);
  return { job: persist(deps, job), effectiveClass: effective };
}

export interface PlanResult {
  context: AttemptContext;
  candidate: PlanCandidateInput;
  producedByTier: 'LOCAL_SMALL' | 'LARGE_AGENT';
}

/**
 * Record a planner (or replanner) result: build the bound ExecutionPlan,
 * store it, and either clear it for execution or set the applicable gate
 * (critic, then human review by policy).
 *
 * The plan binds to the CURRENT Git baseline (captured here unless the
 * caller already holds a snapshot) — an unbound plan would read as stale on
 * every resume and silently burn the replan budget.
 */
export async function recordPlan(
  deps: JobDeps,
  jobId: string,
  result: PlanResult,
  options: { gitHead?: string | undefined; replan?: boolean } = {},
): Promise<{ job: JobState; plan: ExecutionPlan }> {
  assertJobsEnabled(deps);
  const policy = policyOf(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, result.context.nodeId);

  if (options.replan === true) {
    if (node.replans >= job.budgets.maxReplansPerTask) {
      throw new OrchestrationError(
        'SBO013',
        `Task ${node.parentTaskId} used all ${job.budgets.maxReplansPerTask} replans.`,
        { failureCategory: 'BUDGET_EXHAUSTED' },
      );
    }
    if (job.counters.jobReplans >= job.budgets.maxJobReplans) {
      throw new OrchestrationError(
        'SBO013',
        `The job used all ${job.budgets.maxJobReplans} replans.`,
        { failureCategory: 'BUDGET_EXHAUSTED' },
      );
    }
  }

  const gitHead =
    options.gitHead ??
    (await captureGitSnapshot(deps.workspace.rootDir, { clock: () => now(deps) })).head;
  const binding = capturePlanBinding(deps.workspace, {
    specName: job.specName,
    taskId: node.parentTaskId,
    policy: deps.config.orchestration,
    gitHead,
  });
  const revision = node.planRevision + 1;
  const plan = buildExecutionPlan({
    candidate: result.candidate,
    specName: job.specName,
    binding,
    revision,
    planId: `${node.nodeId}-p${revision}`,
    createdAt: now(deps).toISOString(),
    policy: deps.config.orchestration,
  });
  storeNodePlan(deps.workspace, jobId, node.nodeId, revision, plan as unknown as Record<string, unknown>);

  ({ job, graph } = appendAttempt(deps, job, graph, result.context, 'succeeded'));

  // Gates: local plans go to the critic; human review by policy.
  const criticApplies =
    policy.routing.critic !== 'disabled' && result.producedByTier === 'LOCAL_SMALL';
  const humanReview =
    policy.planReview === 'always' ||
    (policy.planReview === 'high-risk' && (requireNode(graph, node.nodeId).complexity ?? 'LOW') === 'HIGH');
  const approved = !criticApplies && !humanReview;

  graph = withNode(graph, {
    ...requireNode(graph, node.nodeId),
    planRevision: revision,
    planApproved: approved,
    humanReviewRequired: humanReview,
    planProducedBy: result.context.workerId,
    planProducedByTier: result.producedByTier,
    // A fresh plan resets the critic verdict and stagnation: a new approach
    // gets a fresh chance to make progress.
    consecutiveNoProgress: 0,
    ...(options.replan === true ? { replans: requireNode(graph, node.nodeId).replans + 1 } : {}),
  });
  const withoutVerdict = requireNode(graph, node.nodeId);
  delete (withoutVerdict as Partial<JobNode>).criticVerdict;
  delete (withoutVerdict as Partial<JobNode>).criticPlanRevision;
  graph = withNode(graph, withoutVerdict);

  if (options.replan === true) {
    job = { ...job, counters: { ...job.counters, jobReplans: job.counters.jobReplans + 1 } };
    job = record(deps, job, 'replan_started', { nodeId: node.nodeId, revision });
  }
  job = record(deps, job, 'plan_created', {
    nodeId: node.nodeId,
    revision,
    producedByTier: result.producedByTier,
    criticApplies,
    humanReview,
  });

  // Status: planning produced a plan; the job returns to READY and the
  // scheduler decides the next gate.
  if (job.status === 'PLANNING' || job.status === 'REPLANNING') {
    job = transition(deps, job, 'READY');
  }
  persistGraph(deps, job, graph);
  return { job: persist(deps, job), plan };
}

export interface CriticResult {
  context: AttemptContext;
  verdict: 'ACCEPT' | 'REVISE' | 'ESCALATE';
  /** Bounded reasons; recorded for audit. */
  reasons: string[];
}

export function recordCriticVerdict(
  deps: JobDeps,
  jobId: string,
  result: CriticResult,
): { job: JobState; verdict: CriticResult['verdict']; humanReviewRequired: boolean } {
  assertJobsEnabled(deps);
  const policy = policyOf(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, result.context.nodeId);

  ({ job, graph } = appendAttempt(deps, job, graph, result.context, 'succeeded'));

  const humanReview =
    policy.planReview === 'always' ||
    (policy.planReview === 'high-risk' && (node.complexity ?? 'LOW') === 'HIGH');

  const accepted = result.verdict === 'ACCEPT';
  graph = withNode(graph, {
    ...requireNode(graph, node.nodeId),
    criticVerdict: result.verdict,
    criticPlanRevision: node.planRevision,
    planApproved: accepted && !humanReview,
    humanReviewRequired: accepted ? humanReview : false,
  });
  job = record(deps, job, 'critic_completed', {
    nodeId: node.nodeId,
    planRevision: node.planRevision,
    verdict: result.verdict,
    reasons: result.reasons.slice(0, 10).map((reason) => reason.slice(0, 200)),
  });

  if (result.verdict === 'REVISE' || result.verdict === 'ESCALATE') {
    // The plan is not cleared; the planner runs again against the critique
    // (for ESCALATE, the sticky escalation reroutes it to the large agent).
    job = transition(deps, job, 'PLANNING');
  }
  persistGraph(deps, job, graph);
  return {
    job: persist(deps, job),
    verdict: result.verdict,
    humanReviewRequired: accepted ? humanReview : false,
  };
}

/**
 * Record a routing escalation once per (node, reason). Deduplicated so the
 * scheduler's sticky-escalation input stays bounded and re-scheduling the
 * same node does not spam the audit trail.
 */
export function noteEscalation(
  deps: JobDeps,
  jobId: string,
  input: { nodeId?: string; role: AgentRole; reason: EscalationReason; detail: string },
): JobState {
  let job = requireJobState(deps.workspace, jobId);
  const already = job.escalations.some(
    (entry) => entry.nodeId === input.nodeId && entry.reason === input.reason,
  );
  if (already) return job;
  job = recordEscalation(deps, job, input);
  return persist(deps, job);
}

/**
 * Reconcile a job whose nodes all finished but whose status transition was
 * interrupted (crash between the graph write and the job write). Idempotent.
 */
export function completeJobIfDone(deps: JobDeps, jobId: string): JobState {
  let job = requireJobState(deps.workspace, jobId);
  if (isFinalJobStatus(job.status)) return job;
  const graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  if (!allNodesComplete(graph)) {
    throw new OrchestrationError('SBO027', 'The job cannot complete: unfinished nodes remain.');
  }
  const at = now(deps).toISOString();
  job = transition(deps, job, 'COMPLETED');
  job = record(deps, job, 'job_completed', { reconciled: true });
  return persist(deps, { ...job, finalizedAt: at, finalOutcome: 'COMPLETED' });
}

/** Append one auxiliary job event (e.g. local model lifecycle). */
export function recordJobEvent(
  deps: JobDeps,
  jobId: string,
  type: JobEventType,
  payload: Record<string, unknown> = {},
): JobState {
  let job = requireJobState(deps.workspace, jobId);
  job = record(deps, job, type, payload);
  return persist(deps, job);
}

/** Record an explicit human review of a node's active plan. */
export function reviewNodePlan(
  deps: JobDeps,
  jobId: string,
  input: { nodeId: string; decision: 'approved' | 'rejected'; note?: string | undefined },
): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, input.nodeId);
  if (!node.humanReviewRequired) {
    throw new OrchestrationError('SBO012', `Node ${input.nodeId} has no pending human plan review.`);
  }

  graph = withNode(graph, {
    ...node,
    planApproved: input.decision === 'approved',
    humanReviewRequired: input.decision === 'approved' ? false : true,
  });
  job = record(deps, job, 'plan_reviewed', {
    nodeId: node.nodeId,
    planRevision: node.planRevision,
    decision: input.decision,
    ...(input.note !== undefined ? { note: input.note.slice(0, 500) } : {}),
  });
  if (input.decision === 'rejected') {
    // A rejected plan needs a replacement; the job plans again.
    graph = withNode(graph, { ...requireNode(graph, node.nodeId), humanReviewRequired: false });
    if (job.status === 'READY') job = transition(deps, job, 'PLANNING');
  }
  persistGraph(deps, job, graph);
  return persist(deps, job);
}

// ---------------------------------------------------------------------------
// Executor dispatch lifecycle
// ---------------------------------------------------------------------------

/** Mark the executor dispatch as started (job RUNNING / REPAIRING). */
export function beginExecutorDispatch(
  deps: JobDeps,
  jobId: string,
  input: {
    nodeId: string;
    mode: 'implement' | 'repair';
    workerId: string;
    /** Provider identity for the durable attempt (defaults to the worker id). */
    provider?: string | undefined;
    /** Model identity when known. Never guessed. */
    model?: string | undefined;
    /** Provider session reference — working memory, never canonical state. */
    providerSessionId?: string | undefined;
  },
): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, input.nodeId);

  graph = transitionNode(graph, node.nodeId, input.mode === 'repair' ? 'REPAIRING' : 'RUNNING');
  job = transition(deps, job, input.mode === 'repair' ? 'REPAIRING' : 'RUNNING');

  // Survival runtime: persist the durable ExecutionAttempt BEFORE any work
  // runs, with lineage to the newest final attempt on this node — so a crash
  // right after this point already left evidence, and a retry never
  // masquerades as a first try.
  const priorAttempts = listTaskAttempts(deps.workspace, jobId, { nodeId: node.nodeId });
  const lineageParent = [...priorAttempts]
    .reverse()
    .find((prior) => isFinalAttemptStatus(prior.status));
  const attempt = beginTaskAttempt(
    { workspace: deps.workspace, clock: deps.clock, idFactory: deps.idFactory },
    {
      jobId,
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      role: 'EXECUTOR',
      workerId: input.workerId,
      provider: input.provider ?? input.workerId,
      model: input.model,
      providerSessionId: input.providerSessionId,
      resumedFromAttemptId: lineageParent?.attemptId,
    },
  );
  job = { ...job, currentNodeId: node.nodeId, currentAttemptId: attempt.attemptId };
  job = record(deps, job, input.mode === 'repair' ? 'repair_started' : 'execution_started', {
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    workerId: input.workerId,
    ...(input.mode === 'repair' ? { cycle: node.repairCycles + 1 } : {}),
  });
  job = record(deps, job, 'attempt_started', {
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    provider: attempt.provider,
    ...(attempt.resumedFromAttemptId !== undefined
      ? { resumedFromAttemptId: attempt.resumedFromAttemptId }
      : {}),
  });
  persistGraph(deps, job, graph);
  return persist(deps, job);
}

export interface ExecutorOutcome {
  context: AttemptContext;
  mode: 'implement' | 'repair';
  /** The evidence status reported by the existing completion pipeline. */
  evidenceStatus: string | undefined;
  /** Verification/execution failure, when the dispatch did not complete. */
  failure?:
    | {
        category: FailureCategory;
        message: string;
        source: string;
        exitCode?: number | undefined;
        output?: string | undefined;
      }
    | undefined;
  /** Files the pipeline observed as changed (diff fingerprinting). */
  changedFiles?: { path: string; contentHash?: string | undefined }[] | undefined;
}

export interface ExecutorOutcomeResult {
  job: JobState;
  /** What the deterministic policy decided happens next. */
  nextAction:
    | 'node-complete'
    | 'diagnose'
    | 'wait-retry'
    | 'clarify'
    | 'blocked'
    | 'job-complete';
  classified?: ClassifiedFailure;
}

/**
 * Finalize the durable survival attempt for one finished dispatch.
 *
 * Every dispatch leaves ledger data: a dispatch begun before the survival
 * runtime recorded attempts (or whose record was lost) is backfilled so the
 * history stays complete. An attempt already reconciled to a final status by
 * a concurrent resume keeps that status — finished attempts are immutable.
 */
function finalizeDispatchAttempt(
  deps: JobDeps,
  job: JobState,
  node: JobNode,
  outcome: ExecutorOutcome,
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
): string {
  const survivalDeps = { workspace: deps.workspace, clock: deps.clock, idFactory: deps.idFactory };
  let attemptId = job.currentAttemptId;
  if (attemptId === undefined || readTaskAttempt(deps.workspace, job.jobId, attemptId) === undefined) {
    attemptId = beginTaskAttempt(survivalDeps, {
      jobId: job.jobId,
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      role: outcome.context.role,
      workerId: outcome.context.workerId,
      provider: outcome.context.workerId,
      runId: outcome.context.runId,
    }).attemptId;
  }
  const existing = readTaskAttempt(deps.workspace, job.jobId, attemptId);
  if (existing !== undefined && isFinalAttemptStatus(existing.status)) {
    return attemptId;
  }
  const usage = outcome.context.usage;
  completeTaskAttempt(survivalDeps, {
    jobId: job.jobId,
    attemptId,
    status,
    runId: outcome.context.runId,
    ...(status === 'COMPLETED'
      ? {
          resultSummary: `Evidence status "${outcome.evidenceStatus ?? 'verified'}"; ${
            outcome.changedFiles?.length ?? 0
          } file(s) changed.`,
        }
      : {
          failure:
            outcome.failure !== undefined
              ? { category: outcome.failure.category, message: outcome.failure.message }
              : {
                  category: 'VERIFICATION_FAILURE',
                  message: `The dispatch ended with evidence status "${outcome.evidenceStatus ?? 'none'}", which does not complete a task.`,
                },
        }),
    metrics: {
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      ...(outcome.changedFiles !== undefined ? { filesChanged: outcome.changedFiles.length } : {}),
    },
  });
  return attemptId;
}

/**
 * Fold the executor dispatch outcome into the job.
 *
 * Success requires VERIFIED evidence — the reported status of the existing
 * completion pipeline, exactly as v1.1 requires it (SBO022). Failure runs
 * through the shared failure taxonomy and the deterministic policy: repair
 * and replan candidates go to DIAGNOSING (a reasoned diagnosis is mandatory
 * before any repair), transients go to WAITING_RETRY with backoff, and
 * terminal categories block the job with evidence preserved.
 */
export function completeExecutorDispatch(
  deps: JobDeps,
  jobId: string,
  outcome: ExecutorOutcome,
): ExecutorOutcomeResult {
  assertJobsEnabled(deps);
  const policy = policyOf(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, outcome.context.nodeId);
  const at = now(deps).toISOString();

  // --- Verified completion --------------------------------------------------
  const verified =
    outcome.evidenceStatus === 'verified' || outcome.evidenceStatus === 'manually-accepted';

  // Survival runtime: the attempt's own outcome is already decided, whatever
  // the policy below chooses next — finalize the durable record first so
  // every branch (complete, retry, diagnose, block, cancel) leaves history.
  const attemptStatus =
    outcome.failure === undefined && verified
      ? 'COMPLETED'
      : outcome.failure?.category === 'CANCELLED'
        ? 'CANCELLED'
        : 'FAILED';
  const attemptId = finalizeDispatchAttempt(deps, job, node, outcome, attemptStatus);
  job = { ...job, currentAttemptId: undefined };
  job = record(deps, job, 'attempt_completed', {
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    attemptId,
    status: attemptStatus,
  });

  if (outcome.failure === undefined && verified) {
    ({ job, graph } = appendAttempt(deps, job, graph, outcome.context, 'succeeded'));
    graph = transitionNode(graph, node.nodeId, 'COMPLETED');
    graph = withNode(graph, {
      ...requireNode(graph, node.nodeId),
      completedAt: at,
      latestEvidence: {
        runId: outcome.context.runId ?? 'unknown',
        evidenceStatus: outcome.evidenceStatus ?? 'verified',
        at,
      },
    });
    graph = promoteReadyNodes(graph);
    job = {
      ...job,
      latestEvidence: {
        taskId: node.parentTaskId,
        runId: outcome.context.runId ?? 'unknown',
        evidenceStatus: outcome.evidenceStatus ?? 'verified',
        at,
      },
    };
    job = record(deps, job, 'node_completed', {
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      evidenceStatus: outcome.evidenceStatus,
      ...(outcome.context.runId !== undefined ? { runId: outcome.context.runId } : {}),
    });

    // Survival runtime: a completed task IS a milestone. The structured
    // checkpoint makes the completion durable for any future worker without
    // requiring anyone to have called checkpointTask explicitly.
    const milestone = createTaskCheckpoint(
      { workspace: deps.workspace, clock: deps.clock, idFactory: deps.idFactory },
      {
        jobId,
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        attemptId,
        reason: 'milestone',
        objective: `Task ${node.parentTaskId}: ${node.title}`.slice(0, 2_000),
        pinned: {
          taskContract: `Task ${node.parentTaskId}: ${node.title}`.slice(0, 2_000),
          acceptanceCriteria: [],
          constraints: [],
          invariants: [],
        },
        completedWork: [`Task ${node.parentTaskId} completed with evidence status "${outcome.evidenceStatus ?? 'verified'}".`],
        changedFiles: (outcome.changedFiles ?? []).slice(0, 500).map((file) => ({ path: file.path.slice(0, 512) })),
        testResults: [
          {
            name: 'trusted-verification',
            status: 'passed',
            summary: `Evidence status "${outcome.evidenceStatus ?? 'verified'}".`,
          },
        ],
        nextActions: ['Task complete; nothing remains for this task.'],
        relevantArtifacts: outcome.context.runId !== undefined ? [outcome.context.runId] : [],
      },
    );
    job = record(deps, job, 'task_checkpoint_created', {
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      checkpointId: milestone.checkpointId,
      reason: 'milestone',
    });

    if (allNodesComplete(graph)) {
      job = transition(deps, job, 'COMPLETED');
      job = record(deps, job, 'job_completed', {});
      job = { ...job, finalizedAt: at, finalOutcome: 'COMPLETED' };
      persistGraph(deps, job, graph);
      return { job: persist(deps, job), nextAction: 'job-complete' };
    }
    job = transition(deps, job, 'READY');
    const next = graph.nodes.find((candidate) => candidate.status === 'READY');
    job = { ...job, currentNodeId: next?.nodeId };
    if (next !== undefined) {
      job = record(deps, job, 'node_ready', { nodeId: next.nodeId, taskId: next.parentTaskId });
    }
    persistGraph(deps, job, graph);
    return { job: persist(deps, job), nextAction: 'node-complete' };
  }

  // --- Failure --------------------------------------------------------------
  // A dispatch that reports neither verified evidence nor a failure is a
  // failed verification claim: classify it as such rather than trusting it.
  const failureInput = outcome.failure ?? {
    category: 'VERIFICATION_FAILURE' as FailureCategory,
    message: `The dispatch ended with evidence status "${outcome.evidenceStatus ?? 'none'}", which does not complete a task.`,
    source: 'evidence-evaluation',
  };
  const classified = classifyFailure(failureInput);

  const observation: ObservationFingerprint = observationFingerprintSchema.parse({
    failureFingerprint: classified.fingerprint,
    ...(outcome.changedFiles !== undefined
      ? { diffFingerprint: diffFingerprint(outcome.changedFiles) }
      : {}),
    changedFileCount: outcome.changedFiles?.length ?? 0,
    actionCategory: 'VERIFY',
    planRevision: node.planRevision,
    result: 'failed',
  });
  const progress = assessProgress({
    previous: node.lastObservation,
    next: observation,
    consecutiveNoProgress: node.consecutiveNoProgress,
    maxNoProgressCycles: job.budgets.maxNoProgressCycles,
  });

  ({ job, graph } = appendAttempt(deps, job, graph, outcome.context, 'failed', {
    failureCategory: classified.category,
    failureFingerprint: classified.fingerprint,
  }));
  graph = withNode(graph, {
    ...requireNode(graph, node.nodeId),
    lastObservation: observation,
    consecutiveNoProgress: progress.consecutiveNoProgress,
    latestFailure: {
      category: classified.category,
      fingerprint: classified.fingerprint,
      message: classified.message.slice(0, 2_000),
      at,
    },
    ...(outcome.mode === 'repair'
      ? { repairCycles: requireNode(graph, node.nodeId).repairCycles + 1 }
      : {}),
  });
  if (classified.category === 'VERIFICATION_FAILURE') {
    job = record(deps, job, 'verification_failed', {
      nodeId: node.nodeId,
      fingerprint: classified.fingerprint,
      source: failureInput.source,
    });
  }
  job = record(deps, job, 'execution_finished', {
    nodeId: node.nodeId,
    outcome: 'failed',
    category: classified.category,
    progressed: progress.progressed,
    consecutiveNoProgress: progress.consecutiveNoProgress,
  });

  // The node dispatch is over; the node returns to READY while policy
  // decides what runs next.
  graph = transitionNode(graph, node.nodeId, 'READY');

  // Deterministic policy, in strict priority order (mirrors decideNextStep).
  const blockWith = (
    category: FailureCategory,
    code: string,
    message: string,
    remediation: string[],
  ): ExecutorOutcomeResult => {
    let blocked = transition(deps, job, 'BLOCKED');
    blocked = record(deps, blocked, category === 'BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'job_blocked', {
      nodeId: node.nodeId,
      category,
      reason: message.slice(0, 500),
    });
    blocked = { ...blocked, blocker: { category, code, message, remediation, at } };
    persistGraph(deps, blocked, graph);
    return { job: persist(deps, blocked), nextAction: 'blocked', classified };
  };

  if (classified.category === 'CANCELLED') {
    let cancelled = transition(deps, job, 'CANCELLED');
    cancelled = record(deps, cancelled, 'job_cancelled', { nodeId: node.nodeId });
    cancelled = { ...cancelled, finalizedAt: at, finalOutcome: 'CANCELLED' };
    persistGraph(deps, cancelled, graph);
    return { job: persist(deps, cancelled), nextAction: 'blocked', classified };
  }
  if (classified.policy.terminal) {
    return blockWith(
      classified.category,
      classified.category,
      `${classified.category}: ${classified.message}`.slice(0, 1_500),
      classified.policy.remediation,
    );
  }
  if (classified.policy.retryable) {
    if (job.counters.transientRetries >= job.budgets.maxTransientRetries) {
      return blockWith(
        'BUDGET_EXHAUSTED',
        'maxTransientRetries',
        `The transient failure recurred after ${job.budgets.maxTransientRetries} bounded retries; it is not transient.`,
        ['Investigate the underlying tool or transport failure before continuing.'],
      );
    }
    const backoffMs = backoffForAttempt(job.counters.transientRetries + 1, {
      baseBackoffMs: Math.max(policy.retryDelayMs, 1),
      maxBackoffMs: Math.max(policy.retryDelayMs * 16, policy.retryDelayMs),
    });
    let waiting = transition(deps, job, 'WAITING_RETRY');
    waiting = {
      ...waiting,
      retryAt: new Date(now(deps).getTime() + backoffMs).toISOString(),
      counters: { ...waiting.counters, transientRetries: waiting.counters.transientRetries + 1 },
    };
    waiting = record(deps, waiting, 'waiting_retry', {
      nodeId: node.nodeId,
      category: classified.category,
      retryAt: waiting.retryAt,
    });
    persistGraph(deps, waiting, graph);
    return { job: persist(deps, waiting), nextAction: 'wait-retry', classified };
  }
  if (classified.policy.clarifiable && !classified.policy.repairable) {
    // Ambiguity and blocked dependencies need a user, not a model: the
    // failure is recorded as a concrete question so the stop is actionable.
    let clarify = transition(deps, job, 'NEEDS_CLARIFICATION');
    const question = {
      id: `q-${newId(deps)}`.slice(0, 64),
      question:
        `Task ${node.parentTaskId} cannot proceed: ${classified.message.slice(0, 600)} ` +
        'Resolve the prerequisite (or decide otherwise), then resume the job.',
      whyItMatters: `${classified.category} has no safe automatic response.`,
      options: [],
      relatedTaskId: node.parentTaskId,
      askedAt: at,
      round: Math.min(
        clarify.counters.clarificationRounds + 1,
        deps.config.orchestration.clarification.maxRounds,
      ),
    };
    clarify = {
      ...clarify,
      openQuestions: [...clarify.openQuestions, question],
      counters: { ...clarify.counters, clarificationRounds: question.round },
    };
    clarify = record(deps, clarify, 'clarification_requested', {
      nodeId: node.nodeId,
      category: classified.category,
    });
    persistGraph(deps, clarify, graph);
    return { job: persist(deps, clarify), nextAction: 'clarify', classified };
  }
  if (progress.stagnated) {
    // Stagnation is handled by the diagnoser too, but the budget check is
    // deterministic: with no replan budget left, the job stops here.
    if (
      requireNode(graph, node.nodeId).replans >= job.budgets.maxReplansPerTask ||
      job.counters.jobReplans >= job.budgets.maxJobReplans
    ) {
      return blockWith(
        'BUDGET_EXHAUSTED',
        'maxNoProgressCycles',
        `No progress after ${progress.consecutiveNoProgress} materially identical cycles, and no replan budget remains.`,
        ['All evidence is preserved. Inspect the failure and decide the approach explicitly.'],
      );
    }
  }
  if (classified.policy.repairable || classified.policy.replannable) {
    // Repair budget check happens here so DIAGNOSING is never entered when
    // no automatic response could be legal anyway.
    if (
      classified.policy.repairable &&
      requireNode(graph, node.nodeId).repairCycles >= job.budgets.maxRepairCyclesPerTask &&
      requireNode(graph, node.nodeId).replans >= job.budgets.maxReplansPerTask
    ) {
      return blockWith(
        'BUDGET_EXHAUSTED',
        'maxRepairCyclesPerTask',
        `The repair budget (${job.budgets.maxRepairCyclesPerTask}) and replan budget are exhausted and verification still fails.`,
        ['The implementation changes and all failure evidence are preserved.'],
      );
    }
    const diagnosing = transition(deps, job, 'DIAGNOSING');
    persistGraph(deps, diagnosing, graph);
    return { job: persist(deps, diagnosing), nextAction: 'diagnose', classified };
  }
  return blockWith(
    classified.category,
    classified.category,
    `${classified.category} has no automatic recovery path.`,
    classified.policy.remediation,
  );
}

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

export interface DiagnosisResult {
  context: AttemptContext;
  category: FailureCategory;
  planValidity: 'VALID' | 'INVALID' | 'UNKNOWN';
  recommendedAction: 'REPAIR' | 'REPLAN' | 'RETRY' | 'CLARIFY' | 'BLOCK';
  rootCause: string;
}

export interface DiagnosisApplied {
  job: JobState;
  /** What policy actually decided (may differ from the recommendation). */
  applied: 'repair' | 'replan' | 'wait-retry' | 'clarify' | 'blocked';
}

/**
 * Apply a diagnosis. The diagnoser PROPOSES; deterministic policy DECIDES:
 *   - REPAIR requires a repairable category, a valid plan, and repair budget
 *   - REPLAN requires replan budget and moves the job to REPLANNING
 *   - a recommendation the policy cannot legally follow degrades toward
 *     caution (repair → replan → clarify/block), never toward continuation
 */
export function applyDiagnosis(
  deps: JobDeps,
  jobId: string,
  result: DiagnosisResult,
): DiagnosisApplied {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, result.context.nodeId);
  const at = now(deps).toISOString();

  if (job.status !== 'DIAGNOSING') {
    throw new OrchestrationError('SBO027', `A diagnosis applies only while DIAGNOSING (job is ${job.status}).`);
  }

  ({ job, graph } = appendAttempt(deps, job, graph, result.context, 'succeeded'));
  graph = withNode(graph, {
    ...requireNode(graph, node.nodeId),
    latestDiagnosis: {
      category: result.category,
      planValidity: result.planValidity,
      recommendedAction: result.recommendedAction,
      at,
      ...(result.context.agentResultRef !== undefined
        ? { agentResultRef: result.context.agentResultRef }
        : {}),
    },
  });
  job = record(deps, job, 'diagnosis_completed', {
    nodeId: node.nodeId,
    category: result.category,
    planValidity: result.planValidity,
    recommendedAction: result.recommendedAction,
  });

  const policyOfFailure = classifyFailure({
    category: result.category,
    message: result.rootCause.slice(0, 500),
    source: 'diagnoser',
  }).policy;

  const repairBudgetLeft =
    requireNode(graph, node.nodeId).repairCycles < job.budgets.maxRepairCyclesPerTask;
  const replanBudgetLeft =
    requireNode(graph, node.nodeId).replans < job.budgets.maxReplansPerTask &&
    job.counters.jobReplans < job.budgets.maxJobReplans;

  // REPAIR: legal only for repairable categories with a valid plan.
  if (
    result.recommendedAction === 'REPAIR' &&
    policyOfFailure.repairable &&
    result.planValidity === 'VALID' &&
    repairBudgetLeft
  ) {
    job = transition(deps, job, 'READY');
    persistGraph(deps, job, graph);
    return { job: persist(deps, job), applied: 'repair' };
  }

  // REPLAN: plan assumptions were invalid, or repair is not available.
  const wantsReplan =
    result.recommendedAction === 'REPLAN' ||
    result.planValidity === 'INVALID' ||
    (result.recommendedAction === 'REPAIR' && (!repairBudgetLeft || !policyOfFailure.repairable));
  if (wantsReplan && policyOfFailure.replannable !== false && replanBudgetLeft) {
    job = transition(deps, job, 'REPLANNING');
    persistGraph(deps, job, graph);
    return { job: persist(deps, job), applied: 'replan' };
  }

  if (result.recommendedAction === 'RETRY' && policyOfFailure.retryable) {
    if (job.counters.transientRetries < job.budgets.maxTransientRetries) {
      const delay = policyOf(deps).retryDelayMs;
      job = transition(deps, job, 'WAITING_RETRY');
      job = {
        ...job,
        retryAt: new Date(now(deps).getTime() + delay).toISOString(),
        counters: { ...job.counters, transientRetries: job.counters.transientRetries + 1 },
      };
      job = record(deps, job, 'waiting_retry', { nodeId: node.nodeId, retryAt: job.retryAt });
      persistGraph(deps, job, graph);
      return { job: persist(deps, job), applied: 'wait-retry' };
    }
  }

  if (result.recommendedAction === 'CLARIFY' || policyOfFailure.clarifiable) {
    job = transition(deps, job, 'NEEDS_CLARIFICATION');
    job = record(deps, job, 'clarification_requested', { nodeId: node.nodeId });
    persistGraph(deps, job, graph);
    return { job: persist(deps, job), applied: 'clarify' };
  }

  job = transition(deps, job, 'BLOCKED');
  job = {
    ...job,
    blocker: {
      category: result.category,
      code: result.category,
      message: `Diagnosis: ${result.rootCause}`.slice(0, 1_500),
      remediation: policyOfFailure.remediation,
      at,
    },
  };
  job = record(deps, job, 'job_blocked', { nodeId: node.nodeId, category: result.category });
  persistGraph(deps, job, graph);
  return { job: persist(deps, job), applied: 'blocked' };
}

// ---------------------------------------------------------------------------
// Graph-level replan (node supersession)
// ---------------------------------------------------------------------------

/**
 * Supersede a node whose approach was invalidated: the next graph revision
 * carries a fresh successor node for the same approved task. Used when a
 * replanner concludes the node needs a clean restart rather than a plan
 * revision.
 */
export function supersedeNode(
  deps: JobDeps,
  jobId: string,
  input: { nodeId: string; reason: string },
): { job: JobState; graph: JobGraph } {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  const graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, input.nodeId);

  if (node.replans >= job.budgets.maxReplansPerTask || job.counters.jobReplans >= job.budgets.maxJobReplans) {
    throw new OrchestrationError('SBO013', 'No replan budget remains; the node cannot be superseded.', {
      failureCategory: 'BUDGET_EXHAUSTED',
    });
  }

  const revised = reviseGraphSuperseding(graph, {
    supersedeNodeId: input.nodeId,
    replanReason: input.reason,
    createdAt: now(deps).toISOString(),
  });
  storeGraphRevision(deps.workspace, jobId, revised);
  job = {
    ...job,
    graphRevision: revised.revision,
    currentNodeId: node.supersededBy,
    counters: { ...job.counters, jobReplans: job.counters.jobReplans + 1 },
  };
  job = record(deps, job, 'graph_revised', {
    revision: revised.revision,
    supersedes: graph.revision,
    supersededNode: input.nodeId,
    reason: input.reason.slice(0, 500),
  });
  job = record(deps, job, 'node_superseded', { nodeId: input.nodeId });
  if (job.status === 'REPLANNING') job = transition(deps, job, 'READY');
  return { job: persist(deps, job), graph: revised };
}

// ---------------------------------------------------------------------------
// Clarification, cancellation, blocking
// ---------------------------------------------------------------------------

export function askClarification(
  deps: JobDeps,
  jobId: string,
  questions: { question: string; whyItMatters: string; nodeId?: string }[],
): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  if (isFinalJobStatus(job.status)) {
    throw new OrchestrationError('SBO026', `Job is ${job.status}; no questions can be asked.`);
  }
  const maxRounds = deps.config.orchestration.clarification.maxRounds;
  if (job.counters.clarificationRounds >= maxRounds) {
    throw new OrchestrationError('SBO008', `All ${maxRounds} clarification rounds are used.`, {
      failureCategory: 'BUDGET_EXHAUSTED',
    });
  }
  const at = now(deps).toISOString();
  const round = job.counters.clarificationRounds + 1;
  const added = questions.slice(0, deps.config.orchestration.clarification.maxQuestionsPerRound).map(
    (candidate) => ({
      id: `q-${newId(deps)}`.slice(0, 64),
      question: candidate.question.slice(0, 1_000),
      whyItMatters: candidate.whyItMatters.slice(0, 1_000),
      options: [],
      ...(candidate.nodeId !== undefined ? { relatedTaskId: candidate.nodeId } : {}),
      askedAt: at,
      round,
    }),
  );
  job = {
    ...job,
    openQuestions: [...job.openQuestions, ...added],
    counters: { ...job.counters, clarificationRounds: round },
  };
  if (job.status !== 'NEEDS_CLARIFICATION') job = transition(deps, job, 'NEEDS_CLARIFICATION');
  job = record(deps, job, 'clarification_requested', {
    round,
    questionIds: added.map((question) => question.id),
  });
  return persist(deps, job);
}

export function answerClarification(
  deps: JobDeps,
  jobId: string,
  answers: { questionId: string; answer: string }[],
): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  if (job.status !== 'NEEDS_CLARIFICATION') {
    throw new OrchestrationError('SBO027', `Answers apply only while NEEDS_CLARIFICATION (job is ${job.status}).`);
  }
  const at = now(deps).toISOString();
  const answered = new Set<string>();
  const decisions = answers
    .filter((answer) => job.openQuestions.some((question) => question.id === answer.questionId))
    .map((answer) => {
      answered.add(answer.questionId);
      const question = job.openQuestions.find((candidate) => candidate.id === answer.questionId);
      return {
        id: `d-${newId(deps)}`.slice(0, 64),
        questionId: answer.questionId,
        question: question?.question ?? '',
        answer: answer.answer.slice(0, 2_000),
        source: 'known-from-user' as const,
        decidedAt: at,
      };
    });
  if (decisions.length === 0) {
    throw new OrchestrationError('SBO007', 'No answer matched an open question.');
  }
  job = {
    ...job,
    decisions: [...job.decisions, ...decisions],
    openQuestions: job.openQuestions.filter((question) => !answered.has(question.id)),
  };
  job = record(deps, job, 'clarification_resolved', {
    decisionIds: decisions.map((decision) => decision.id),
    remaining: job.openQuestions.length,
  });
  if (job.openQuestions.length === 0) {
    job = transition(deps, job, 'READY');
  }
  return persist(deps, job);
}

export function cancelJob(deps: JobDeps, jobId: string, reason: string): JobState {
  let job = requireJobState(deps.workspace, jobId);
  if (isFinalJobStatus(job.status)) return job; // idempotent
  const at = now(deps).toISOString();
  job = transition(deps, job, 'CANCELLED');
  job = record(deps, job, 'job_cancelled', { reason: reason.slice(0, 500) });
  return persist(deps, { ...job, finalizedAt: at, finalOutcome: 'CANCELLED' });
}

/** Block the job explicitly (scheduler budget stops route through here). */
export function blockJob(
  deps: JobDeps,
  jobId: string,
  input: { category: FailureCategory; code: string; message: string; remediation: string[] },
): JobState {
  let job = requireJobState(deps.workspace, jobId);
  if (job.status === 'BLOCKED') return job;
  const at = now(deps).toISOString();
  job = transition(deps, job, 'BLOCKED');
  job = record(deps, job, input.category === 'BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'job_blocked', {
    code: input.code,
    reason: input.message.slice(0, 500),
  });
  return persist(deps, {
    ...job,
    blocker: { category: input.category, code: input.code, message: input.message, remediation: input.remediation, at },
  });
}

/** Clear WAITING_RETRY once the delay elapsed (driver calls before scheduling). */
export function clearRetryWait(deps: JobDeps, jobId: string): JobState {
  let job = requireJobState(deps.workspace, jobId);
  if (job.status !== 'WAITING_RETRY') return job;
  if (job.retryAt !== undefined && Date.parse(job.retryAt) > now(deps).getTime()) return job;
  job = transition(deps, job, 'READY');
  delete job.retryAt;
  return persist(deps, job);
}

// ---------------------------------------------------------------------------
// Checkpoints and resume
// ---------------------------------------------------------------------------

export function checkpointJob(deps: JobDeps, jobId: string, nextAction: string): JobCheckpoint {
  let job = requireJobState(deps.workspace, jobId);
  const graph = job.graphRevision > 0 ? readGraphRevision(deps.workspace, jobId, job.graphRevision) : undefined;
  const nodes = graph?.nodes ?? [];
  const checkpoint = jobCheckpointSchema.parse({
    schemaVersion: JOB_CHECKPOINT_SCHEMA_VERSION,
    jobId,
    createdAt: now(deps).toISOString(),
    specName: job.specName,
    status: job.status,
    graphRevision: job.graphRevision,
    ...(job.currentNodeId !== undefined ? { currentNodeId: job.currentNodeId } : {}),
    completedNodes: nodes.filter((node) => node.status === 'COMPLETED').map((node) => node.nodeId),
    remainingNodes: nodes
      .filter((node) => node.status !== 'COMPLETED' && node.status !== 'SUPERSEDED')
      .map((node) => node.nodeId),
    ...(job.latestEvidence !== undefined ? { latestEvidence: job.latestEvidence } : {}),
    counters: job.counters,
    budgets: job.budgets,
    ...(job.blocker !== undefined ? { blocker: job.blocker } : {}),
    nextAction: nextAction.slice(0, 2_000),
  });
  writeJobCheckpoint(deps.workspace, jobId, checkpoint);
  job = record(deps, job, 'checkpoint_created', { status: job.status });
  persist(deps, job);
  return checkpoint;
}

export interface JobResumeReport {
  job: JobState;
  graph: JobGraph | undefined;
  finalized: boolean;
  /** Statuses reconciled because a previous process died mid-dispatch. */
  reconciled: string[];
  /** Durable attempts reconciled RUNNING → INTERRUPTED by this resume. */
  interruptedAttemptIds?: string[] | undefined;
  planStale: boolean;
  planStaleReasons: string[];
  policyChanged: boolean;
  gitHead?: string | undefined;
  checkpoint?: JobCheckpoint;
  warnings: string[];
  nextAction: string;
}

/**
 * Resume a job in a fresh process.
 *
 * The honesty rules are v1.1's, extended to jobs: a resumed job is the SAME
 * job (same id, counters, graph, history); a resumed process remembers
 * nothing beyond persisted structured state; and reality is re-checked —
 * in-flight statuses are reconciled, the current node's plan is re-bound
 * against the repository, and a stale plan forces REPLANNING rather than
 * silent execution.
 */
export async function resumeJob(deps: JobDeps, jobId: string): Promise<JobResumeReport> {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  const warnings: string[] = [];
  const reconciled: string[] = [];
  const checkpoint = readJobCheckpoint(deps.workspace, jobId);

  if (isFinalJobStatus(job.status)) {
    return {
      job,
      graph: job.graphRevision > 0 ? readGraphRevision(deps.workspace, jobId, job.graphRevision) : undefined,
      finalized: true,
      reconciled,
      planStale: false,
      planStaleReasons: [],
      policyChanged: false,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      warnings: [`Job ${jobId} is ${job.status} and cannot be continued.`],
      nextAction: 'Create a new job for further work.',
    };
  }

  const currentFingerprint = jobPolicyFingerprint(deps.config.orchestration);
  const policyChanged = currentFingerprint !== job.policyFingerprint;
  if (policyChanged) {
    warnings.push(
      'The job policy changed since this job began. The job continues under the budgets recorded at its start.',
    );
  }

  // Reconcile in-flight statuses: a fresh process has no live dispatch.
  let graph = job.graphRevision > 0 ? requireGraphRevision(deps.workspace, jobId, job.graphRevision) : undefined;
  if (graph !== undefined) {
    for (const node of graph.nodes) {
      if (node.status === 'RUNNING' || node.status === 'REPAIRING') {
        graph = transitionNode(graph, node.nodeId, 'READY');
        reconciled.push(`node ${node.nodeId}: ${node.status} → READY (interrupted dispatch)`);
      }
    }
  }
  if (job.status === 'RUNNING' || job.status === 'REPAIRING' || job.status === 'PLANNING') {
    // An executor dispatch or planner call was in flight when the process
    // died. READY is the safe re-entry point: the scheduler re-decides
    // deterministically from persisted state. DIAGNOSING and REPLANNING are
    // left untouched — they are schedulable statuses whose role runs are
    // re-derivable at any time.
    const interrupted = job.status;
    job = { ...job, status: 'READY', updatedAt: now(deps).toISOString() };
    reconciled.push(`job: ${interrupted} → READY (interrupted process)`);
  }

  // Survival runtime: attempts persisted as RUNNING have no live worker in a
  // fresh process — reconcile them to INTERRUPTED, visibly. Each record
  // remains as historical evidence; continuation is a NEW attempt with
  // lineage, never a resurrected old one.
  const interruptedAttempts = reconcileInterruptedAttempts(
    { workspace: deps.workspace, clock: deps.clock },
    jobId,
  );
  for (const attempt of interruptedAttempts) {
    reconciled.push(`attempt ${attempt.attemptId}: RUNNING → INTERRUPTED (worker disappeared)`);
    job = record(deps, job, 'attempt_interrupted', {
      nodeId: attempt.nodeId,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      provider: attempt.provider,
    });
  }
  if (job.currentAttemptId !== undefined) {
    job = { ...job, currentAttemptId: undefined };
  }

  // Re-bind the current node's plan against the repository as it is now.
  const snapshot = await captureGitSnapshot(deps.workspace.rootDir, { clock: () => now(deps) });
  let planStale = false;
  let planStaleReasons: string[] = [];
  if (graph !== undefined && job.currentNodeId !== undefined) {
    const node = findNode(graph, job.currentNodeId);
    if (node !== undefined && node.planRevision > 0) {
      const raw = readNodePlan(deps.workspace, jobId, node.nodeId, node.planRevision);
      const parsed = raw !== undefined ? executionPlanSchema.safeParse(raw) : undefined;
      if (parsed === undefined || !parsed.success) {
        warnings.push(`The plan for node ${node.nodeId} is missing or unreadable; a fresh plan is required.`);
        graph = withNode(graph, { ...node, planApproved: false, planRevision: 0 });
      } else {
        const current = capturePlanBinding(deps.workspace, {
          specName: job.specName,
          taskId: node.parentTaskId,
          policy: deps.config.orchestration,
          gitHead: snapshot.head,
        });
        const freshness = evaluatePlanFreshness(parsed.data, current);
        planStale = !freshness.fresh;
        planStaleReasons = freshness.reasons;
        if (planStale) {
          warnings.push('The recorded plan no longer matches the repository; it will not be executed as-is.');
          graph = withNode(graph, { ...node, planApproved: false });
          if (job.status === 'READY') {
            job = transition(deps, job, 'REPLANNING');
          }
        }
      }
    }
  }

  // Surface an interactive lock left by an interrupted execution run.
  const lock = readInteractiveLock(deps.workspace);
  if (lock.state === 'held') {
    warnings.push(
      `The repository lock is held by run ${lock.lock.runId}; recover it with \`specbridge run recover-lock\` before dispatching.`,
    );
  }

  if (graph !== undefined) persistGraph(deps, job, graph);
  job = record(deps, job, 'job_resumed', {
    reconciled: reconciled.length,
    planStale,
    policyChanged,
  });
  if (reconciled.length > 0 || planStale) {
    job = record(deps, job, 'repository_reconciled', {
      ...(snapshot.head !== undefined ? { gitHead: snapshot.head } : {}),
      planStale,
    });
  }
  job = persist(deps, job);

  return {
    job,
    graph,
    finalized: false,
    reconciled,
    ...(interruptedAttempts.length > 0
      ? { interruptedAttemptIds: interruptedAttempts.map((attempt) => attempt.attemptId) }
      : {}),
    planStale,
    planStaleReasons,
    policyChanged,
    ...(snapshot.head !== undefined ? { gitHead: snapshot.head } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    warnings,
    nextAction: planStale
      ? 'Produce a replacement plan: the recorded plan is stale.'
      : 'Continue with the scheduler decision.',
  };
}

/**
 * Fold one objective-runtime worker dispatch (DECOMPOSER / BUILDER /
 * EVALUATOR / AGGREGATOR / INTEGRATOR) into the job: the attempt lands on
 * the OBJECTIVE NODE's history, the dispatch counts against maxAgentRuns,
 * and reported usage accumulates — the same accounting every other worker
 * gets. Throws SBO032 when the dispatch budget is exhausted, which stops
 * the objective mid-flight and blocks the job honestly.
 */
export function recordObjectiveWorkerAttempt(
  deps: JobDeps,
  jobId: string,
  input: {
    nodeId: string;
    role: AgentRole;
    workerId: string;
    outcome: 'succeeded' | 'failed' | 'invalid-output';
    usage?:
      | { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
      | undefined;
  },
): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  if (job.counters.agentRuns >= job.budgets.maxAgentRuns) {
    throw new OrchestrationError(
      'SBO032',
      `The job reached its ${job.budgets.maxAgentRuns}-dispatch budget during objective execution.`,
      { failureCategory: 'BUDGET_EXHAUSTED' },
    );
  }
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  ({ job, graph } = appendAttempt(
    deps,
    job,
    graph,
    {
      nodeId: input.nodeId,
      role: input.role,
      workerId: input.workerId,
      startedAt: now(deps).toISOString(),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
    },
    input.outcome === 'succeeded' ? 'succeeded' : input.outcome,
  ));
  persistGraph(deps, job, graph);
  return persist(deps, job);
}

/** Count a local inference call against the job budget (driver hook). */
export function countLocalInferenceCall(deps: JobDeps, jobId: string): JobState {
  let job = requireJobState(deps.workspace, jobId);
  if (job.counters.localInferenceCalls >= job.budgets.maxLocalInferenceCalls) {
    throw new OrchestrationError(
      'SBO032',
      `The local inference budget of ${job.budgets.maxLocalInferenceCalls} calls is exhausted.`,
      { failureCategory: 'BUDGET_EXHAUSTED' },
    );
  }
  job = {
    ...job,
    counters: { ...job.counters, localInferenceCalls: job.counters.localInferenceCalls + 1 },
  };
  return persist(deps, job);
}

export { listGraphRevisions };
