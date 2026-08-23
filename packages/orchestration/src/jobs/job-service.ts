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
import type { CompletionGate, DelegatedAuthorityResolver } from './authority.js';
import { assessCompletion, resolvePlanReviewRequirement } from './authority.js';
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
import { executorAttempts } from './scheduler.js';
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
import { reconcileInterruptedApiReservations } from '../scheduling/api-budget.js';
import type {
  AcceptanceCriterion,
  ApiBudgetPosition,
  AttemptActivity,
  CriteriaEvidence,
  EvaluationResult,
  ExecutionIntegrityInput,
  LocalAttemptBudget,
  NormalizedHarnessFailureKind,
  RecoveryDecision,
  RecoveryResource,
  RepositoryIntegrityInput,
  SemanticEvaluationInput,
  VerificationInput,
} from '../reliability/index.js';
import {
  RepositoryContextIndex,
  applyExpansion,
  initialExpansionState,
  planContextExpansion,
} from '@specbridge/context';
import type { ContextInsufficiencySignal, ContextStrategy } from '@specbridge/context';
import { recordCalibrationForAttempt } from '../adaptive/service.js';
import {
  assessContextMiss,
  expansionPolicyFrom,
  listContextSelectionPlans,
  offerContextExpansion,
  readContextExpansionState,
  readRepositoryIndexCache,
  writeContextExpansionState,
} from '../context/index.js';
import {
  evaluateAcceptanceCriteria,
  evaluateAttempt,
  governFailedAttempt,
  markRecoveryDecisionApplied,
  readRecoveryDecision,
  readTaskReliabilityState,
  recordEvaluation,
  recordSuccessfulAttempt,
} from '../reliability/index.js';

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
  /**
   * vNext.10: the delegated-authority resolver, supplied by
   * @specbridge/autonomy when a sealed Mission governs this job. Absent for
   * every unsealed job, which then behaves exactly as it did in v1.2.
   */
  authorityResolver?: DelegatedAuthorityResolver | undefined;
  /**
   * vNext.10: the contract-closure completion gate, supplied by
   * @specbridge/autonomy for a sealed Mission. Absent for every unsealed
   * job, which then completes exactly as it did in v1.2.
   */
  completionGate?: CompletionGate | undefined;
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

/**
 * The reviewable text of a stored plan, bounded.
 *
 * Used to screen a plan for PROMISE vocabulary when the authority firewall
 * decides whether a policy-mandated review still needs a person. A plan that
 * cannot be read yields empty text, which screens as no promises and leaves
 * the v1.2 gate exactly where it was.
 */
function planTextOf(plan: Record<string, unknown> | undefined): string {
  if (plan === undefined) return '';
  const goal = typeof plan['goal'] === 'string' ? plan['goal'] : '';
  const steps = Array.isArray(plan['steps']) ? plan['steps'] : [];
  const descriptions = steps
    .map((step) =>
      step !== null && typeof step === 'object' && typeof (step as { description?: unknown }).description === 'string'
        ? (step as { description: string }).description
        : '',
    )
    .filter((description) => description.length > 0);
  return [goal, ...descriptions].join('\n').slice(0, 4_000);
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

  // Gates: local plans go to the critic; human review by policy — and, under
  // a sealed Mission, the authority firewall gets to dissolve a review that
  // exists only because the work is HARD.
  const criticApplies =
    policy.routing.critic !== 'disabled' && result.producedByTier === 'LOCAL_SMALL';
  const complexity = requireNode(graph, node.nodeId).complexity ?? 'LOW';
  const policyRequiresReview =
    policy.planReview === 'always' ||
    (policy.planReview === 'high-risk' && complexity === 'HIGH');
  const review = resolvePlanReviewRequirement(deps.authorityResolver, {
    jobId,
    nodeId: node.nodeId,
    policyRequiresReview,
    policyReason: `plan review by ${policy.planReview} policy at complexity ${complexity}`,
    planText: `${result.candidate.goal}\n${result.candidate.steps
      .map((step) => step.description)
      .join('\n')}`,
  });
  const humanReview = review.humanReviewRequired;
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

  const activePlan = readNodePlan(deps.workspace, jobId, node.nodeId, node.planRevision);
  const policyRequiresReview =
    policy.planReview === 'always' ||
    (policy.planReview === 'high-risk' && (node.complexity ?? 'LOW') === 'HIGH');
  const humanReview = resolvePlanReviewRequirement(deps.authorityResolver, {
    jobId,
    nodeId: node.nodeId,
    policyRequiresReview,
    policyReason: `plan review by ${policy.planReview} policy at complexity ${node.complexity ?? 'LOW'}`,
    planText: planTextOf(activePlan),
  }).humanReviewRequired;

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
/**
 * Complete the job when every runtime node completed through verified
 * evidence — AND, for a sealed Mission, when the closure ledger agrees.
 *
 * The v1.2 rule runs first and is unchanged: unfinished nodes still refuse.
 * The gate is consulted only after that rule has said yes, and it can only
 * refuse. A refused job moves to QUALIFYING rather than erroring, because
 * "the task list is finished and the contract is not" is not a failure — it
 * is the moment the closure lifecycle takes over and generates the work that
 * is actually missing.
 */
export function completeJobIfDone(deps: JobDeps, jobId: string): JobState {
  let job = requireJobState(deps.workspace, jobId);
  if (isFinalJobStatus(job.status)) return job;
  const graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  if (!allNodesComplete(graph)) {
    throw new OrchestrationError('SBO027', 'The job cannot complete: unfinished nodes remain.');
  }

  const closure = assessCompletion(deps.completionGate, jobId);
  if (closure !== undefined && !closure.mayComplete) {
    if (job.status === 'QUALIFYING') {
      // Already there; the closure lifecycle owns the next move.
      return job;
    }
    job = transition(deps, job, 'QUALIFYING');
    job = record(deps, job, 'closure_audit_completed', {
      directive: 'CONTRACT_CLOSURE_AUDIT',
      unclosed: closure.unclosed,
      reason: closure.reason.slice(0, 500),
    });
    return persist(deps, { ...job, closurePhase: 'CONTRACT_CLOSURE_AUDIT' });
  }

  const at = now(deps).toISOString();
  job = transition(deps, job, 'COMPLETED');
  job = record(deps, job, 'job_completed', {
    reconciled: true,
    ...(closure !== undefined ? { closure: closure.reason.slice(0, 300) } : {}),
  });
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

/**
 * The shared state-mutation primitive for the vNext.10 autonomous statuses.
 *
 * `record`, `transition`, and `persist` are private to this module on
 * purpose: every job status change goes through the same event-budget check
 * and the same fail-closed transition table, and a second module that
 * reimplemented them would be a second place for that to stop being true.
 * Rather than exporting three primitives, this exports the one composition
 * `autonomous-states.ts` needs, which is also the only composition that is
 * ever correct: transition, record why, patch, persist, atomically.
 *
 * A transition to the SAME status is legal here and is a no-op on the
 * status while still recording the event and applying the patch — an
 * operational condition that recurs (a second failed provider probe) is a
 * real observation even though the job has not moved.
 */
export function applyJobTransition(
  deps: JobDeps,
  jobId: string,
  input: {
    to: JobStatus;
    event: JobEventType;
    payload?: Record<string, unknown>;
    patch?: Partial<JobState>;
  },
): JobState {
  let job = requireJobState(deps.workspace, jobId);
  if (isFinalJobStatus(job.status)) {
    throw new OrchestrationError(
      'SBO026',
      `Job is ${job.status}; autonomous status changes are not possible on a finalized job.`,
      { details: { from: job.status, to: input.to } },
    );
  }
  if (job.status !== input.to) job = transition(deps, job, input.to);
  job = record(deps, job, input.event, input.payload ?? {});
  return persist(deps, { ...job, ...(input.patch ?? {}) });
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
    /** vNext.2 scheduling attribution (recorded on the durable attempt). */
    lane?: string | undefined;
    localSuitability?: string | undefined;
    taskCategory?: string | undefined;
    schedulingDecisionId?: string | undefined;
    /** vNext.4 LOCAL execution attribution (recorded, never policy). */
    executionMode?: string | undefined;
    executionShape?: string | undefined;
    computeLocality?: string | undefined;
    /** vNext.5 API-lane attribution (recorded, never policy). */
    apiSpendMode?: string | undefined;
    gapReason?: string | undefined;
    subscriptionAvailableAt?: string | undefined;
    estimatedGapDurationMs?: number | null | undefined;
    costSource?: string | undefined;
    pricingProfile?: string | undefined;
    apiBudgetReservationId?: string | undefined;
    apiApprovalId?: string | undefined;
    delaySensitivity?: string | undefined;
    /** vNext.8 adaptive attribution (recorded in every mode, never policy). */
    taskSignature?: string | undefined;
    contextStrategy?: string | undefined;
    runnerVersion?: string | undefined;
    estimatedCostUsd?: number | null | undefined;
    reservedCostUsd?: number | null | undefined;
    /** Quota/context observations captured at dispatch start. */
    quotaBefore?:
      | {
          fiveHourRemainingRatio?: number | null | undefined;
          weeklyRemainingRatio?: number | null | undefined;
        }
      | undefined;
    contextUsageBefore?: number | undefined;
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
      lane: input.lane,
      localSuitability: input.localSuitability,
      taskComplexity: node.complexity,
      taskCategory: input.taskCategory,
      schedulingDecisionId: input.schedulingDecisionId,
      executionMode: input.executionMode,
      executionShape: input.executionShape,
      computeLocality: input.computeLocality,
      apiSpendMode: input.apiSpendMode,
      gapReason: input.gapReason,
      subscriptionAvailableAt: input.subscriptionAvailableAt,
      estimatedGapDurationMs: input.estimatedGapDurationMs,
      costSource: input.costSource,
      pricingProfile: input.pricingProfile,
      apiBudgetReservationId: input.apiBudgetReservationId,
      apiApprovalId: input.apiApprovalId,
      delaySensitivity: input.delaySensitivity,
      taskSignature: input.taskSignature,
      contextStrategy: input.contextStrategy,
      runnerVersion: input.runnerVersion,
      estimatedCostUsd: input.estimatedCostUsd,
      reservedCostUsd: input.reservedCostUsd,
      quotaBefore: input.quotaBefore,
      ...(input.contextUsageBefore !== undefined
        ? { contextUsageBefore: input.contextUsageBefore }
        : {}),
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
  /**
   * vNext.2: additional attempt metrics observed by the dispatcher (quota
   * after, context usage after, test loops). Merged into the durable
   * attempt; unknown fields simply stay null.
   */
  extraMetrics?: Record<string, number | null> | undefined;
  /**
   * vNext.6 reliability inputs.
   *
   * Entirely optional and additive. Absent, the evaluation is derived from
   * the reported evidence status alone and the pre-vNext.6 behavior is
   * preserved exactly — which is what keeps existing workspaces and every
   * caller that predates this phase valid. Dispatchers that KNOW more (which
   * verifiers ran, what the harness observed, what the lane was) supply it,
   * and the evaluation gets correspondingly sharper.
   */
  reliability?: ExecutorReliabilityInput | undefined;
}

/**
 * What a dispatcher can tell the reliability layer about its own attempt.
 *
 * Every field is evidence the dispatcher OBSERVED, never a judgment it made:
 * which verifiers ran and how they ended, what Git showed, how much the
 * runtime did. The verdict is computed here from those facts, so no
 * dispatcher — and no runner behind one — can hand in a conclusion.
 */
export interface ExecutorReliabilityInput {
  integrity?: Partial<ExecutionIntegrityInput> | undefined;
  repository?: Partial<RepositoryIntegrityInput> | undefined;
  verification?: VerificationInput | undefined;
  /** Durable acceptance criteria for this task, when the contract carries them. */
  acceptanceCriteria?: readonly AcceptanceCriterion[] | undefined;
  criteriaEvidence?: CriteriaEvidence | undefined;
  /** A bounded read-only semantic review, when policy warranted one. */
  semantic?: SemanticEvaluationInput | undefined;
  /** Observed attempt activity; unreported metrics stay null, never zero. */
  activity?: Partial<AttemptActivity> | undefined;
  /** The runtime's already-normalized failure kind, when it reported one. */
  harnessFailureKind?: NormalizedHarnessFailureKind | undefined;
  contextRatio?: number | null | undefined;
  /** Live resource availability, read from the scheduler's own telemetry. */
  resource?: RecoveryResource | undefined;
  local?: LocalAttemptBudget | undefined;
  api?: ApiBudgetPosition | undefined;
  /** True when the task is flagged high-risk (architecture, public API, security). */
  highRisk?: boolean | undefined;
  /**
   * vNext.7: bounded text the worker itself produced in STRUCTURED fields —
   * blocking questions, remaining risks, an escalation reason.
   *
   * Used only to detect whether the worker named a repository artifact it
   * was never given. Deliberately not a transcript, and deliberately not
   * read for sentiment: a worker asserting "I need more context" without
   * naming anything produces no signal at all, because that claim is exactly
   * what an underperforming model says and acting on it would let a worker
   * request its own budget increase.
   */
  workerReportedText?: string | undefined;
  /**
   * vNext.7: a DIRECT_MODEL attempt declined for want of repository access.
   *
   * A structured decision the local executor already makes (its ESCALATE
   * outcome), not an interpretation of prose. It is the clearest possible
   * evidence that the failure was about the PACKAGE rather than the model:
   * a model with no tools said it could not see the code.
   */
  directModelRequestedRepository?: boolean | undefined;
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
    | 'job-complete'
    // vNext.6 (additive): actions the recovery planner selects that map onto
    // a rescheduled attempt rather than onto one of the statuses above.
    | 'replan'
    | 'retry-strategy-change';
  classified?: ClassifiedFailure;
  /** vNext.6: the durable verdict on this attempt, when one was produced. */
  evaluation?: EvaluationResult;
  /** vNext.6: the durable recovery decision, when the attempt failed. */
  recovery?: RecoveryDecision;
}

// ---------------------------------------------------------------------------
// vNext.6 evaluation and recovery wiring
// ---------------------------------------------------------------------------

/**
 * Build the deterministic evaluation for one finished dispatch.
 *
 * The dispatcher supplies FACTS; this function computes the verdict. Where a
 * dispatcher supplied nothing (every caller that predates vNext.6, and the
 * simpler execution paths), the facts are derived from the reported evidence
 * status — which the existing pipeline already produced from Git, protected
 * paths, and the trusted verifiers, so the derivation adds no new trust.
 *
 * The evidence-status mapping is deliberately conservative in one direction:
 * a status that means "we could not establish this" becomes INCONCLUSIVE,
 * never a quiet FAIL against the implementation.
 */
function buildAttemptEvaluation(
  deps: JobDeps,
  job: JobState,
  node: JobNode,
  outcome: ExecutorOutcome,
  attemptId: string,
  lane: string | null,
  at: string,
): EvaluationResult {
  const input = outcome.reliability;
  const status = outcome.evidenceStatus;
  const verified = status === 'verified' || status === 'manually-accepted';
  const changedPaths = (outcome.changedFiles ?? []).map((file) => file.path);

  // An evidence status that means "the attempt never got far enough to be
  // judged" must not be read as a statement about the implementation.
  const inconclusiveStatus = status === 'timed-out';
  const terminatedNormally =
    input?.integrity?.terminatedNormally ??
    (!inconclusiveStatus && outcome.failure?.category !== 'CANCELLED');

  const integrity: ExecutionIntegrityInput = {
    terminatedNormally,
    workerIdentityMatches: input?.integrity?.workerIdentityMatches ?? true,
    baselineValid: input?.integrity?.baselineValid ?? true,
    taskFingerprintValid: input?.integrity?.taskFingerprintValid ?? true,
    approvalsStillValid: input?.integrity?.approvalsStillValid ?? true,
    protectedPathViolations: input?.integrity?.protectedPathViolations ?? [],
    reportValidated: input?.integrity?.reportValidated ?? true,
    ...(input?.integrity?.terminationDetail !== undefined
      ? { terminationDetail: input.integrity.terminationDetail }
      : {}),
  };

  const repository: RepositoryIntegrityInput = {
    changedPaths: input?.repository?.changedPaths ?? changedPaths,
    ambiguousPaths: input?.repository?.ambiguousPaths ?? [],
    headMoved: input?.repository?.headMoved ?? false,
    taskStillExists: input?.repository?.taskStillExists ?? true,
    ...(input?.repository?.claimedChangedPaths !== undefined
      ? { claimedChangedPaths: input.repository.claimedChangedPaths }
      : {}),
    changeRequired: input?.repository?.changeRequired ?? true,
  };

  // With no reported verification detail, the reported evidence status IS the
  // verification result: the completion pipeline already ran the trusted
  // commands to produce it.
  const verification: VerificationInput = input?.verification ?? {
    configured: true,
    skipped: false,
    ran: !inconclusiveStatus,
    commands: inconclusiveStatus
      ? [
          {
            name: 'trusted-verification',
            required: true,
            passed: false,
            timedOut: true,
            detail: `the attempt ended with evidence status "${status ?? 'none'}"`,
          },
        ]
      : [
          {
            name: 'trusted-verification',
            required: true,
            passed: verified,
            timedOut: false,
            ...(verified
              ? {}
              : {
                  detail: `evidence status "${status ?? 'none'}" does not complete a task`,
                }),
          },
        ],
  };

  const criteria =
    input?.acceptanceCriteria !== undefined && input.criteriaEvidence !== undefined
      ? evaluateAcceptanceCriteria(input.acceptanceCriteria, input.criteriaEvidence)
      : { checks: [], failedCriteria: [], uncheckedCriteria: [] };

  return evaluateAttempt({
    evaluationId: `ev-${newId(deps)}`.slice(0, 64),
    jobId: job.jobId,
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    attemptId,
    lane,
    createdAt: at,
    integrity,
    repository,
    verification,
    criteriaChecks: criteria.checks,
    failedCriteria: criteria.failedCriteria,
    uncheckedCriteria: criteria.uncheckedCriteria,
    ...(input?.semantic !== undefined ? { semantic: input.semantic } : {}),
    ...(outcome.context.runId !== undefined ? { evidenceRefs: [outcome.context.runId] } : {}),
  });
}

/**
 * What the recovery planner may assume about resources when the caller did
 * not say.
 *
 * Deliberately the most CONSERVATIVE world that is still able to make
 * progress: prepaid capacity is assumed available (so escalation requests go
 * to the preferred strong lane), and paid execution is assumed unauthorized
 * with no budget (so nothing can accidentally route to spending because a
 * caller forgot a field). Defaults may cost a wait; they may never cost
 * money.
 */
function defaultRecoveryResource(): RecoveryResource {
  return {
    subscriptionAvailable: true,
    subscriptionReturnsInMs: null,
    subscriptionWorkerConfigured: true,
    apiAuthorized: false,
    apiBudgetAvailable: false,
    localAvailable: true,
    localHarnessAvailable: false,
  };
}

function attemptActivity(
  outcome: ExecutorOutcome,
  startedAt: string | undefined,
  at: string,
): AttemptActivity {
  const supplied = outcome.reliability?.activity;
  const metrics = outcome.extraMetrics ?? {};
  const elapsed =
    startedAt !== undefined ? Math.max(0, Date.parse(at) - Date.parse(startedAt)) : null;
  return {
    toolCalls: supplied?.toolCalls ?? numeric(metrics['toolCalls']),
    commandRuns: supplied?.commandRuns ?? numeric(metrics['commandRuns']),
    durationMs: supplied?.durationMs ?? elapsed,
    contextUsageAfter: supplied?.contextUsageAfter ?? numeric(metrics['contextUsageAfter']),
    testLoops: supplied?.testLoops ?? numeric(metrics['testLoops']),
    emptyDiff: supplied?.emptyDiff ?? (outcome.changedFiles ?? []).length === 0,
  };
}

/** A metric the runtime did not report stays null; it never becomes zero. */
function numeric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function reliabilityDepsFor(deps: JobDeps, jobId: string): Parameters<typeof governFailedAttempt>[0] {
  return {
    workspace: deps.workspace,
    policy: policyOf(deps).reliability,
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    ...(deps.idFactory !== undefined ? { idFactory: deps.idFactory } : {}),
    recordEvent: (type, payload) => {
      try {
        recordJobEvent(deps, jobId, type, payload);
      } catch {
        // Observability must never be able to fail a run: an event budget
        // that is already exhausted is a reason to stop recording, not a
        // reason to lose the recovery decision that was just persisted.
      }
    },
  };
}

/**
 * The recovery decision this node is currently acting on, if any.
 *
 * Read from durable state rather than carried in memory, which is the point:
 * a process that crashes between deciding and acting restarts, finds the
 * decision on disk, and continues it. Without this, a restart would re-derive
 * a transition from whatever the world looks like now and could silently
 * choose differently from what was recorded — the exact "stale/invented
 * recovery decision" failure this phase is meant to rule out.
 */
function pendingRecoveryDecision(
  deps: JobDeps,
  jobId: string,
  nodeId: string,
): RecoveryDecision | undefined {
  if (!policyOf(deps).reliability.enabled) return undefined;
  const state = readTaskReliabilityState(deps.workspace, jobId, nodeId);
  const decisionId = state?.pendingDecisionId;
  if (decisionId === undefined) return undefined;
  const decision = readRecoveryDecision(deps.workspace, jobId, decisionId);
  return decision !== undefined && !decision.applied ? decision : undefined;
}

/**
 * Map one durable recovery decision onto the existing job/graph transitions.
 *
 * Deliberately a MAPPING and not a second decision. Every branch below either
 * moves the job to a status the state machine already knows or records an
 * escalation the router already understands — it never reconsiders, softens,
 * or second-guesses the action. If this function ever grows a condition of
 * its own there will be two recovery policies again, and they will disagree.
 *
 * The one thing it does add is BOUNDING: a wait is clamped so a decision can
 * never park a job past its own wall-clock budget.
 */
function applyRecoveryDecision(
  deps: JobDeps,
  input: {
    job: JobState;
    graph: JobGraph;
    node: JobNode;
    decision: RecoveryDecision;
    classified: ClassifiedFailure;
    evaluation: EvaluationResult;
    at: string;
    blockWith: (
      category: FailureCategory,
      code: string,
      message: string,
      remediation: string[],
    ) => ExecutorOutcomeResult;
  },
): ExecutorOutcomeResult {
  const { decision, node, at } = input;
  let job = input.job;
  const graph = input.graph;
  const retryDelayMs = policyOf(deps).retryDelayMs;
  const finish = (
    next: JobState,
    nextAction: ExecutorOutcomeResult['nextAction'],
  ): ExecutorOutcomeResult => {
    persistGraph(deps, next, graph);
    return {
      job: persist(deps, next),
      nextAction,
      classified: input.classified,
      evaluation: input.evaluation,
      recovery: decision,
    };
  };

  switch (decision.action) {
    case 'RETRY_TRANSIENT': {
      const backoffMs = backoffForAttempt(job.counters.transientRetries + 1, {
        baseBackoffMs: Math.max(retryDelayMs, 1),
        maxBackoffMs: Math.max(retryDelayMs * 16, retryDelayMs),
      });
      job = transition(deps, job, 'WAITING_RETRY');
      job = {
        ...job,
        retryAt: new Date(now(deps).getTime() + backoffMs).toISOString(),
        counters: { ...job.counters, transientRetries: job.counters.transientRetries + 1 },
      };
      job = record(deps, job, 'waiting_retry', {
        nodeId: node.nodeId,
        category: input.classified.category,
        retryAt: job.retryAt,
        reasonCode: decision.reasonCode,
      });
      return finish(job, 'wait-retry');
    }

    case 'WAIT_FOR_RESOURCE': {
      // A wait is bounded by the job's own wall clock: a decision may park a
      // task, but never past the budget the job was created under.
      const elapsed = Math.max(0, Date.parse(at) - Date.parse(job.createdAt));
      const remaining = Math.max(0, job.budgets.maxWallClockMs - elapsed);
      const waitMs = Math.min(Math.max(retryDelayMs, 60_000), Math.max(remaining, retryDelayMs));
      job = transition(deps, job, 'WAITING_RETRY');
      job = { ...job, retryAt: new Date(now(deps).getTime() + waitMs).toISOString() };
      job = record(deps, job, 'waiting_retry', {
        nodeId: node.nodeId,
        retryAt: job.retryAt,
        reasonCode: decision.reasonCode,
        detail: 'waiting for execution capacity rather than spending to avoid the wait',
      });
      return finish(job, 'wait-retry');
    }

    case 'REPAIR': {
      // Repair still routes through DIAGNOSING. The deterministic assessment
      // has already established that repair is the legal action; the
      // diagnoser adds the root-cause detail the repair packet needs, and
      // cannot widen the decision (see applyDiagnosis).
      job = transition(deps, job, 'DIAGNOSING');
      return finish(job, 'diagnose');
    }

    case 'REPLAN': {
      // REPLANNING is not reachable directly from a finished dispatch, by
      // design: the job state machine has never allowed a failure to become
      // a new plan without passing through DIAGNOSING first. That rule is
      // older than this phase and stronger with it — the deterministic
      // assessment has ALREADY chosen REPLAN and persisted it, so the
      // diagnosis step now adds root-cause detail to a decision that is
      // already made rather than being the thing that makes it.
      job = transition(deps, job, 'DIAGNOSING');
      return finish(job, 'diagnose');
    }

    case 'RESTART_FRESH_CONTEXT': {
      // The transient session is discarded; the next dispatch rebuilds a
      // bounded package from the canonical checkpoint. The job returns to
      // READY, and the durable decision is what tells the driver to rebuild.
      job = transition(deps, job, 'READY');
      job = { ...job, currentNodeId: node.nodeId };
      job = record(deps, job, 'context_threshold_reached', {
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        decisionId: decision.decisionId,
        reasonCode: decision.reasonCode,
      });
      return finish(job, 'retry-strategy-change');
    }

    case 'EXPAND_CONTEXT': {
      // vNext.7: the package was insufficient, not the intelligence. The task
      // returns to READY exactly like a fresh-context restart — what differs
      // is the durable expansion state the next assembly reads, which widens
      // retrieval by one bounded level. Nothing about the lane, the model, or
      // the plan changes here, deliberately: this decision asserts that the
      // experiment was never actually run with what it needed.
      job = transition(deps, job, 'READY');
      job = { ...job, currentNodeId: node.nodeId };
      job = record(deps, job, 'context_threshold_reached', {
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        decisionId: decision.decisionId,
        reasonCode: decision.reasonCode,
        detail: 'context insufficiency observed; retrieval widens one bounded level',
      });
      return finish(job, 'retry-strategy-change');
    }

    case 'RETRY_DIFFERENT_LOCAL_MODE': {
      job = transition(deps, job, 'READY');
      job = { ...job, currentNodeId: node.nodeId };
      job = recordEscalation(deps, job, {
        nodeId: node.nodeId,
        role: 'EXECUTOR',
        reason: 'LOCAL_DIRECT_TO_HARNESS',
        detail: decision.reason.slice(0, 500),
      });
      return finish(job, 'retry-strategy-change');
    }

    case 'ESCALATE_INTELLIGENCE':
    case 'ESCALATE_LANE': {
      // A REQUEST is recorded. The economic scheduler still decides where and
      // when the next attempt runs, and for the paid lane the spend
      // authorization and the API budget each keep an independent veto.
      job = transition(deps, job, 'READY');
      job = { ...job, currentNodeId: node.nodeId };
      job = recordEscalation(deps, job, {
        nodeId: node.nodeId,
        role: 'EXECUTOR',
        reason:
          decision.health === 'STALLED' || decision.health === 'OSCILLATING'
            ? 'NO_PROGRESS'
            : 'LOCAL_EXECUTION_ESCALATED',
        detail: decision.reason.slice(0, 500),
      });
      return finish(job, 'retry-strategy-change');
    }

    case 'REQUEST_HUMAN_DECISION': {
      job = transition(deps, job, 'NEEDS_CLARIFICATION');
      const question = {
        id: `q-${newId(deps)}`.slice(0, 64),
        question:
          `Task ${node.parentTaskId} cannot proceed automatically: ${decision.reason.slice(0, 600)} ` +
          'Decide explicitly, then resume the job.',
        whyItMatters: `${decision.reasonCode} has no safe automatic response.`,
        options: [],
        relatedTaskId: node.parentTaskId,
        askedAt: at,
        round: Math.min(
          job.counters.clarificationRounds + 1,
          deps.config.orchestration.clarification.maxRounds,
        ),
      };
      job = {
        ...job,
        openQuestions: [...job.openQuestions, question],
        counters: { ...job.counters, clarificationRounds: question.round },
      };
      job = record(deps, job, 'clarification_requested', {
        nodeId: node.nodeId,
        category: input.classified.category,
        reasonCode: decision.reasonCode,
      });
      return finish(job, 'clarify');
    }

    case 'BLOCK':
    case 'FAIL_TASK': {
      return input.blockWith(
        decision.reasonCode === 'RECOVERY_BUDGET_EXHAUSTED'
          ? 'BUDGET_EXHAUSTED'
          : input.classified.category,
        decision.reasonCode,
        decision.reason.slice(0, 1_500),
        decision.remediation.length > 0 ? decision.remediation : input.classified.policy.remediation,
      );
    }
  }
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
      ...(outcome.extraMetrics ?? {}),
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

  // vNext.6: every finished attempt gets a durable verdict, including the
  // passing ones. "Why did we believe this task was done?" is a question
  // asked months later, and only a persisted PASS record can answer it.
  const lane = readTaskAttempt(deps.workspace, jobId, attemptId)?.lane ?? null;
  const evaluation = buildAttemptEvaluation(deps, job, node, outcome, attemptId, lane, at);
  recordEvaluation(reliabilityDepsFor(deps, jobId), evaluation);

  // vNext.8: with the attempt final and its verdict on record, compare the
  // forecast made before it started against what it actually did. Derived
  // metadata in both directions — this never edits the attempt, the
  // evaluation, or the ledger, and nothing reads it back to place work.
  recordCalibrationForAttempt({
    workspace: deps.workspace,
    policy: policy.scheduler.adaptive,
    jobId,
    nodeId: node.nodeId,
    attemptId,
    now: now(deps),
  });

  // vNext.6: the evaluation is a SECOND, independent gate on completion.
  //
  // The evidence pipeline answers "did the trusted verifiers pass?"; the
  // evaluation answers "is this attempt's work acceptable?", which is a
  // strictly larger question. A change can compile, pass every test, and
  // still violate a deterministic acceptance criterion — approved intent is
  // not a subset of what someone remembered to assert in a test file.
  //
  // So a task completes only when BOTH agree. An attempt that satisfies the
  // verifiers but fails evaluation falls through to the failure path below
  // and is governed like any other failure: assessed, and recovered from
  // with a reasoned decision.
  const evaluationBlocksCompletion =
    policy.reliability.enabled && evaluation.status !== 'PASS';
  if (evaluationBlocksCompletion && outcome.failure === undefined && verified) {
    job = record(deps, job, 'evaluation_failed', {
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      attemptId,
      evaluationId: evaluation.evaluationId,
      status: evaluation.status,
      detail:
        'The trusted verifiers passed but the attempt did not satisfy evaluation; ' +
        'the task stays incomplete.',
      failedCriteria: evaluation.failedCriteria.slice(0, 12),
    });
  }

  if (outcome.failure === undefined && verified && !evaluationBlocksCompletion) {
    recordSuccessfulAttempt(reliabilityDepsFor(deps, jobId), {
      jobId,
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      attemptId,
      attemptNumber: Math.max(1, executorAttempts(node)),
      lane,
      evaluationStatus: evaluation.status,
    });
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
      return { job: persist(deps, job), nextAction: 'job-complete', evaluation };
    }
    job = transition(deps, job, 'READY');
    const next = graph.nodes.find((candidate) => candidate.status === 'READY');
    job = { ...job, currentNodeId: next?.nodeId };
    if (next !== undefined) {
      job = record(deps, job, 'node_ready', { nodeId: next.nodeId, taskId: next.parentTaskId });
    }
    persistGraph(deps, job, graph);
    return { job: persist(deps, job), nextAction: 'node-complete', evaluation };
  }

  // --- Failure --------------------------------------------------------------
  // A dispatch that reports neither verified evidence nor a failure is a
  // failed verification claim: classify it as such rather than trusting it.
  const failureInput =
    outcome.failure ??
    (evaluationBlocksCompletion && verified
      ? {
          // The verifiers passed; evaluation did not. Saying so precisely
          // matters, because the failure fingerprint derived from this is
          // what no-progress detection compares across attempts — and
          // "contract criterion AC-2 failed" and "the tests failed" must
          // never hash to the same experiment.
          category: (evaluation.status === 'INCONCLUSIVE'
            ? 'VERIFICATION_FAILURE'
            : evaluation.failedCriteria.length > 0
              ? 'IMPLEMENTATION_DEFECT'
              : 'VERIFICATION_FAILURE') as FailureCategory,
          message:
            evaluation.reasons[0] ??
            'The attempt satisfied the trusted verifiers but did not pass evaluation.',
          source: 'attempt-evaluation',
          output: evaluation.deterministicChecks
            .filter((check) => check.required && check.outcome !== 'PASSED')
            .map((check) => `${check.level}:${check.name}:${check.outcome}`)
            .join('\n'),
        }
      : {
          category: 'VERIFICATION_FAILURE' as FailureCategory,
          message: `The dispatch ended with evidence status "${outcome.evidenceStatus ?? 'none'}", which does not complete a task.`,
          source: 'evidence-evaluation',
        });
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
  // vNext.6: the governed path.
  //
  // Everything below this point in the legacy cascade still exists and is
  // still exercised — it is what runs when reliability governance is turned
  // off, and it is the behavior existing workspaces keep. When governance IS
  // on, the SAME evidence is routed through one place instead: evaluate,
  // assess, detect loops, check budget, decide, persist. The difference is
  // not that the rules changed; it is that they are now decided once, from a
  // structured assessment, and written down.
  if (policy.reliability.enabled) {
    // vNext.7: was this a CONTEXT miss rather than an intelligence failure?
    //
    // Assessed from OBSERVED evidence — the plan that built the failing
    // package, the repository index, the failure text, and what the worker
    // itself named in structured output. When nothing observed says the
    // package was insufficient, `signals` is empty and everything below is
    // byte-identical to vNext.6.
    const contextMiss = assessDispatchContextMiss(deps, {
      jobId,
      nodeId: node.nodeId,
      attemptId,
      failureText: classified.message,
      ...(outcome.reliability?.workerReportedText !== undefined
        ? { workerReportedText: outcome.reliability.workerReportedText }
        : {}),
      ...(outcome.reliability?.directModelRequestedRepository === true
        ? { directModelRequestedRepository: true }
        : {}),
    });
    const governed = governFailedAttempt(reliabilityDepsFor(deps, jobId), {
      jobId,
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      attemptId,
      attemptNumber: Math.max(1, executorAttempts(requireNode(graph, node.nodeId))),
      classified,
      evaluation,
      lane,
      executionMode: readTaskAttempt(deps.workspace, jobId, attemptId)?.executionMode ?? null,
      planRevision: node.planRevision,
      diffFingerprint: observation.diffFingerprint ?? null,
      ...(outcome.reliability?.harnessFailureKind !== undefined
        ? { harnessFailureKind: outcome.reliability.harnessFailureKind }
        : {}),
      activity: attemptActivity(outcome, outcome.context.startedAt, at),
      budgets: job.budgets,
      counters: job.counters,
      node: requireNode(graph, node.nodeId),
      executorAttempts: executorAttempts(requireNode(graph, node.nodeId)),
      elapsedMs: Math.max(0, Date.parse(at) - Date.parse(job.createdAt)),
      ...(outcome.reliability?.local !== undefined ? { local: outcome.reliability.local } : {}),
      ...(outcome.reliability?.api !== undefined ? { api: outcome.reliability.api } : {}),
      resource: outcome.reliability?.resource ?? defaultRecoveryResource(),
      contextRatio: outcome.reliability?.contextRatio ?? null,
      ...(contextMiss.signals.length > 0
        ? {
            contextInsufficiencySignals: contextMiss.signals,
            contextExpansion: contextMiss.offer,
          }
        : {}),
      ...(outcome.context.runId !== undefined ? { evidenceRefs: [outcome.context.runId] } : {}),
    });
    if (contextMiss.signals.length > 0) {
      recordJobEvent(deps, jobId, 'context_insufficient', {
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        attemptId,
        signals: contextMiss.signals,
        missingPaths: contextMiss.missingPaths.slice(0, 20),
        expansionAvailable: contextMiss.offer.available,
        nextLevel: contextMiss.offer.nextLevel,
      });
    }
    if (governed.decision.action === 'EXPAND_CONTEXT') {
      applyContextExpansion(deps, {
        jobId,
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        signals: contextMiss.signals,
        at,
      });
    } else if (contextMiss.offer.exhausted) {
      recordJobEvent(deps, jobId, 'context_expansion_exhausted', {
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        reason: contextMiss.offer.reason.slice(0, 500),
      });
    }
    return applyRecoveryDecision(deps, {
      job,
      graph,
      node: requireNode(graph, node.nodeId),
      decision: governed.decision,
      classified,
      evaluation,
      at,
      blockWith,
    });
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

  // vNext.6: a recovery decision that was already made deterministically for
  // this attempt acts as a CEILING on what the diagnosis may do.
  //
  // The asymmetry is the point, and it runs in exactly one direction:
  //
  //   a diagnoser may move the action TOWARD caution   (repair -> replan)
  //   a diagnoser may never move it AWAY from caution  (replan -> repair)
  //
  // The second half is what this phase exists to protect. Before it, a
  // diagnoser recommending REPAIR got a repair whenever policy could legally
  // allow one — so a task the loop detector had already proved stalled could
  // talk its way into another identical attempt. Now the loop detector, the
  // budget, and the lane economics have all had their say first, and no
  // proposal can widen the result.
  //
  // The first half is equally deliberate. A diagnoser inspects the repository
  // and can discover that the PLAN's assumptions were invalid — genuinely new
  // information the failure output alone could not carry. Refusing to act on
  // it would not be caution; it would be ignoring evidence in order to keep a
  // decision tidy, which is its own kind of unreliability.
  const pending = pendingRecoveryDecision(deps, jobId, node.nodeId);
  if (pending !== undefined) {
    const replanBudgetForCaution =
      requireNode(graph, node.nodeId).replans < job.budgets.maxReplansPerTask &&
      job.counters.jobReplans < job.budgets.maxJobReplans;
    // The only permitted narrowing: a valid-looking repair becomes a replan
    // when the diagnosis found the plan itself to be the problem.
    const narrowsToReplan =
      pending.action === 'REPAIR' &&
      replanBudgetForCaution &&
      (result.planValidity === 'INVALID' || result.recommendedAction === 'REPLAN');
    const effective = narrowsToReplan ? 'REPLAN' : pending.action;

    job = record(deps, job, 'recovery_decided', {
      nodeId: node.nodeId,
      decisionId: pending.decisionId,
      action: effective,
      plannedAction: pending.action,
      reasonCode: narrowsToReplan ? 'PLAN_INVALIDATED_REPLAN' : pending.reasonCode,
      diagnoserRecommended: result.recommendedAction,
      diagnoserPlanValidity: result.planValidity,
      narrowedByDiagnosis: narrowsToReplan,
      applied: true,
    });
    markRecoveryDecisionApplied(deps.workspace, jobId, pending.decisionId);
    if (effective === 'REPLAN') {
      job = transition(deps, job, 'REPLANNING');
      persistGraph(deps, job, graph);
      return { job: persist(deps, job), applied: 'replan' };
    }
    if (effective === 'REPAIR') {
      job = transition(deps, job, 'READY');
      persistGraph(deps, job, graph);
      return { job: persist(deps, job), applied: 'repair' };
    }
  }

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

/**
 * Clear WAITING_RETRY once the delay elapsed (driver calls before scheduling).
 *
 * `at` is the instant the CALLER is scheduling against, and passing it is not
 * optional in spirit even though it is in the signature. The scheduler
 * applies the very same `retryAt <= now` test a moment later; if the two
 * sample the clock independently and `retryAt` falls between the samples,
 * they disagree — this one leaves the job WAITING_RETRY while the scheduler
 * decides the wait elapsed and dispatches, and the dispatch then dies on an
 * illegal WAITING_RETRY -> RUNNING transition. One instant, both gates.
 */
export function clearRetryWait(deps: JobDeps, jobId: string, at?: Date): JobState {
  let job = requireJobState(deps.workspace, jobId);
  if (job.status !== 'WAITING_RETRY') return job;
  const instant = at ?? now(deps);
  if (job.retryAt !== undefined && Date.parse(job.retryAt) > instant.getTime()) return job;
  job = transition(deps, job, 'READY');
  delete job.retryAt;
  return persist(deps, job);
}

/**
 * vNext.2: promote one PENDING node past quota-DEFERRED predecessors.
 *
 * The initial graph chains tasks in plan order as an ordering preference
 * (later work runs over earlier verified changes). During a subscription
 * cooldown that preference must not become a global stall: a LOCAL-lane
 * node whose only unfinished predecessors are quota-deferred strong tasks
 * may run early. Deterministic verification remains the arbiter — an
 * out-of-order result only ever completes through the same trusted
 * evidence pipeline, and the promotion is recorded, never silent.
 */
export function promoteNodeForQuotaOvertake(
  deps: JobDeps,
  jobId: string,
  input: { nodeId: string; detail: string },
): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  let graph = requireGraphRevision(deps.workspace, jobId, job.graphRevision);
  const node = requireNode(graph, input.nodeId);
  if (node.status !== 'PENDING') {
    // Already promoted (or otherwise moved on) — nothing to do.
    return job;
  }
  graph = transitionNode(graph, node.nodeId, 'READY');
  job = record(deps, job, 'node_ready', {
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    quotaOvertake: true,
    detail: input.detail.slice(0, 300),
  });
  persistGraph(deps, job, graph);
  return persist(deps, job);
}

/**
 * vNext.2: defer schedulable work because no execution lane can take it now
 * (subscription quota exhausted or admission-unsafe, and the work is not
 * local-eligible). The job enters WAITING_RETRY with `retryAt` set to when
 * capacity is expected to return — durable, resumable, and honest: the task
 * remains pending with a recorded scheduling reason, never silently stuck
 * and never failed.
 */
export function deferJobForQuota(
  deps: JobDeps,
  jobId: string,
  input: {
    nodeId: string;
    taskId: string;
    /** When capacity is expected back (ISO); null polls at `pollMs`. */
    until: string | null;
    reasonCode: string;
    detail: string;
    /** Poll interval when no reset time is known. */
    pollMs: number;
  },
): JobState {
  assertJobsEnabled(deps);
  let job = requireJobState(deps.workspace, jobId);
  const at = now(deps);
  const retryAt =
    input.until !== null && Date.parse(input.until) > at.getTime()
      ? input.until
      : new Date(at.getTime() + Math.max(1_000, input.pollMs)).toISOString();
  if (job.status !== 'WAITING_RETRY') {
    job = transition(deps, job, 'WAITING_RETRY');
  }
  job = { ...job, retryAt };
  job = record(deps, job, 'task_deferred', {
    nodeId: input.nodeId,
    taskId: input.taskId,
    reasonCode: input.reasonCode.slice(0, 100),
    retryAt,
    detail: input.detail.slice(0, 500),
  });
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

  // vNext.5: an API budget reservation held by a process that disappeared is
  // reconciled to UNKNOWN and STAYS CHARGED. This is deliberately the
  // pessimistic direction: SpecBridge cannot know whether the remote
  // provider was billed before the crash, and releasing a hold that may
  // already have been spent would let a job quietly exceed its budget by
  // crashing. An operator who knows better can inspect and adjust; the
  // runtime never guesses in the direction that spends more.
  const interruptedReservations = reconcileInterruptedApiReservations(
    deps.workspace,
    jobId,
    now(deps),
  );
  for (const reservation of interruptedReservations) {
    reconciled.push(
      `api budget ${reservation.reservationId}: RESERVED → UNKNOWN ` +
        `($${reservation.reservedUsd.toFixed(4)} stays charged; remote usage cannot be ruled out)`,
    );
    job = record(deps, job, 'api_budget_reconciled', {
      nodeId: reservation.nodeId,
      taskId: reservation.taskId,
      reservationId: reservation.reservationId,
      state: reservation.state,
      reservedUsd: reservation.reservedUsd,
      reconciledUsd: reservation.reconciledUsd,
      costSource: reservation.costSource,
    });
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

// ---------------------------------------------------------------------------
// vNext.7 context-miss governance
// ---------------------------------------------------------------------------

interface DispatchContextMiss {
  signals: string[];
  missingPaths: string[];
  offer: { available: boolean; nextLevel: string; reason: string; exhausted: boolean };
}

/**
 * Decide whether the failed attempt failed for want of CONTEXT.
 *
 * Read-only and best-effort. If the plan is missing, the index cannot be
 * read, or anything else goes wrong, the answer is "no signals" — which
 * leaves the reliability decision exactly where vNext.6 left it. A
 * diagnostic that could itself fail a dispatch would be a poor trade for the
 * information it provides.
 *
 * The index is loaded from the CACHE only (never rebuilt here): this runs on
 * a failure path, and paying for a full repository walk to decide how to
 * classify a failure would be its own kind of waste.
 */
function assessDispatchContextMiss(
  deps: JobDeps,
  input: {
    jobId: string;
    nodeId: string;
    attemptId: string;
    failureText: string;
    workerReportedText?: string | undefined;
    directModelRequestedRepository?: boolean | undefined;
  },
): DispatchContextMiss {
  const at = now(deps).toISOString();
  const idle: DispatchContextMiss = {
    signals: [],
    missingPaths: [],
    offer: { available: false, nextLevel: 'TOP_WORKING_SET', reason: '', exhausted: false },
  };
  if (deps.config.orchestration.jobs.context.efficiency.strategy === 'LEGACY') return idle;
  try {
    const plan = listContextSelectionPlans(deps.workspace, input.jobId, {
      nodeId: input.nodeId,
      attemptId: input.attemptId,
    }).at(-1);
    const cached = readRepositoryIndexCache(deps.workspace);
    const index = cached === undefined ? undefined : new RepositoryContextIndex(cached);
    const miss = assessContextMiss({
      plan,
      index,
      failureText: input.failureText,
      ...(input.workerReportedText !== undefined
        ? { workerReportedText: input.workerReportedText }
        : {}),
      ...(input.directModelRequestedRepository === true
        ? { directModelRequestedRepository: true }
        : {}),
    });
    if (miss.signals.length === 0) return idle;
    const state =
      readContextExpansionState(deps.workspace, input.jobId, input.nodeId) ??
      initialExpansionState({ taskId: plan?.taskId ?? input.nodeId, nodeId: input.nodeId, now: at });
    return {
      signals: miss.signals,
      missingPaths: miss.missingPaths,
      offer: offerContextExpansion({ config: deps.config, state, signals: miss.signals }),
    };
  } catch {
    return idle;
  }
}

/**
 * Record that retrieval widens one level for the next attempt.
 *
 * The durable expansion state is what makes the bound REAL: it survives a
 * restart, so a process that dies mid-recovery cannot reset the widening
 * budget and start the loop again. Recovery decided; this only writes down
 * what the next assembly must read.
 */
function applyContextExpansion(
  deps: JobDeps,
  input: {
    jobId: string;
    nodeId: string;
    taskId: string;
    signals: readonly string[];
    at: string;
  },
): void {
  try {
    const state =
      readContextExpansionState(deps.workspace, input.jobId, input.nodeId) ??
      initialExpansionState({ taskId: input.taskId, nodeId: input.nodeId, now: input.at });
    const signals = input.signals as ContextInsufficiencySignal[];
    const decision = planContextExpansion({
      strategy: deps.config.orchestration.jobs.context.efficiency.strategy as ContextStrategy,
      policy: expansionPolicyFrom(deps.config),
      state,
      signals,
    });
    if (!decision.expand) return;
    const next = applyExpansion(state, decision, { signals, now: input.at });
    writeContextExpansionState(deps.workspace, input.jobId, input.nodeId, next);
    recordJobEvent(deps, input.jobId, 'context_expanded', {
      nodeId: input.nodeId,
      taskId: input.taskId,
      level: next.level,
      expansionsThisTask: next.expansionsThisTask,
      signals: [...signals],
    });
  } catch {
    // Expansion is an optimization. Failing to record it costs a level of
    // widening, never the recovery decision that was already persisted.
  }
}
