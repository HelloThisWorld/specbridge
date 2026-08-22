import type {
  AssembledContext,
  ContextBudgetConfig,
  ContextEfficiencyMetrics,
  ContextExpansionState,
  ContextItem,
  ContextSelectionPlan,
  ContextShape,
  ContextStrategy,
  RerankInference,
  RetrievalRole,
} from '@specbridge/context';
import {
  ContextBudgetError,
  beginAttemptExpansion,
  buildEfficientContext,
  buildRetrievalQuery,
  contextAllocationPolicySchema,
  initialExpansionState,
} from '@specbridge/context';
import { captureGitSnapshot } from '@specbridge/evidence';
import type { GitSnapshot } from '@specbridge/evidence';
import { OrchestrationError } from '../errors.js';
import type { JobDeps } from '../jobs/job-service.js';
import { requireGraphRevision, requireJobState } from '../jobs/store.js';
import type { JobNode, JobState } from '../jobs/state.js';
import { listFailureAssessments, listRecoveryDecisions, readTaskReliabilityState } from '../reliability/store.js';
import type { TaskAttempt, TaskCheckpoint } from '../survival/state.js';
import { listTaskAttempts, readLatestTaskCheckpoint } from '../survival/store.js';
import {
  bullets,
  checkpointSummaryItem,
  contextBudgetFromPolicy,
  durableItems,
  pinnedItems,
  repositoryItem,
} from '../survival/reconstruction.js';
import { ensureRepositoryIndex } from './index-service.js';
import {
  listContextSelectionPlans,
  readContextExpansionState,
  writeContextExpansionState,
  writeContextMetrics,
  writeContextSelectionPlan,
} from './store.js';

/**
 * Durable-state-driven context selection.
 *
 * This is the vNext.7 counterpart to `reconstructTaskContext`, and it shares
 * that function's canonical item builders on purpose: pinned and durable
 * layers are produced by exactly the same code under every strategy, so
 * switching strategies can change what REPOSITORY context a worker sees and
 * can never change what CANONICAL state it sees.
 *
 * What this adds on top:
 *
 *   a repository index, refreshed incrementally from the Git snapshot;
 *   a retrieval query built from contract, failure, recovery, and diff state;
 *   shape-aware selection (materialize for a direct model, point for a
 *     tool-capable harness);
 *   staleness removal, deduplication, and deterministic compression;
 *   a durable, inspectable ContextSelectionPlan.
 *
 * Under `LEGACY` it degrades to the vNext.6 assembly with none of the above,
 * which is what makes the strategy a genuine rollback rather than a
 * configuration of the new behaviour.
 */

export interface BuildTaskContextInput {
  jobId: string;
  nodeId: string;
  /** Which agent role the package is for; roles get different context. */
  role: RetrievalRole;
  /**
   * MATERIALIZED for a worker with no repository tools, POINTER for one that
   * reads the repository itself. Derived from runner capabilities by the
   * caller — never from a provider name.
   */
  shape: ContextShape;
  attemptId?: string | undefined;
  /** Economic lane and execution mode, for plan attribution. */
  lane?: string | null | undefined;
  executionMode?: string | null | undefined;
  runner?: string | null | undefined;
  /** Budget of the TARGET worker. Defaults to the configured job budget. */
  budget?: ContextBudgetConfig | undefined;
  /** Current repository snapshot; captured when not supplied. */
  gitSnapshot?: GitSnapshot | undefined;
  /** Caller-supplied working-set items (a diff, the latest test output). */
  workingSet?: readonly ContextItem[] | undefined;
  recentDelta?: readonly ContextItem[] | undefined;
  /** Overrides the current action derived from the checkpoint. */
  currentAction?: string | undefined;
  /** Advisory local reranker; ignored unless policy enables reranking. */
  rerankInference?: RerankInference | undefined;
  onInferenceCall?: (() => void) | undefined;
  /** Persist the plan and metrics for explainability (default true). */
  persist?: boolean | undefined;
  /** Force a full index rebuild before selecting. */
  rebuildIndex?: boolean | undefined;
}

export interface BuiltTaskContext {
  job: JobState;
  node: JobNode;
  checkpoint: TaskCheckpoint | undefined;
  attempts: TaskAttempt[];
  assembled: AssembledContext;
  plan: ContextSelectionPlan;
  metrics: ContextEfficiencyMetrics;
  expansion: ContextExpansionState;
  /** Indexed paths found stale during selection; the index was refreshed. */
  refreshedPaths: string[];
  strategy: ContextStrategy;
}

function nowIso(deps: JobDeps): string {
  return (deps.clock ?? (() => new Date()))().toISOString();
}

/** Text of the most recent failure for this node, from durable records. */
function latestFailureText(deps: JobDeps, jobId: string, nodeId: string, node: JobNode): string {
  const parts: string[] = [];
  if (node.latestFailure !== undefined) {
    parts.push(`${node.latestFailure.category}: ${node.latestFailure.message}`);
  }
  const assessment = listFailureAssessments(deps.workspace, jobId, { nodeId }).at(-1);
  if (assessment !== undefined) {
    parts.push(assessment.likelyCause);
    parts.push(...assessment.evidenceRefs);
  }
  return parts.join('\n');
}

/** Text of the current recovery decision, from durable records. */
function recoveryText(deps: JobDeps, jobId: string, nodeId: string): string {
  const decision = listRecoveryDecisions(deps.workspace, jobId, { nodeId }).at(-1);
  if (decision === undefined) return '';
  return [decision.action, decision.reason, ...decision.remediation].join('\n');
}

/** Paths this task's previous selection plans materialized or pointed at. */
function priorRelevantPaths(deps: JobDeps, jobId: string, nodeId: string): string[] {
  const plans = listContextSelectionPlans(deps.workspace, jobId, { nodeId }).slice(-3);
  const paths = new Set<string>();
  for (const plan of plans) {
    for (const entry of plan.selectedWorkingItems) paths.add(entry.path);
    for (const pointer of plan.pointers) paths.add(pointer.path);
  }
  return [...paths];
}

/**
 * Build one task's context package under the configured strategy.
 *
 * Read-mostly: the only writes are the derived index cache, the selection
 * plan, the metrics record, and the per-attempt reset of the expansion
 * counter. None of them is canonical task state, and deleting all of them
 * leaves the job exactly as recoverable as before.
 */
export async function buildTaskContextPackage(
  deps: JobDeps,
  input: BuildTaskContextInput,
): Promise<BuiltTaskContext> {
  const job = requireJobState(deps.workspace, input.jobId);
  if (job.graphRevision < 1) {
    throw new OrchestrationError(
      'SBO051',
      `Job ${input.jobId} has no runtime graph yet; there is no task context to build.`,
    );
  }
  const graph = requireGraphRevision(deps.workspace, input.jobId, job.graphRevision);
  const node = graph.nodes.find((candidate) => candidate.nodeId === input.nodeId);
  if (node === undefined) {
    throw new OrchestrationError(
      'SBO051',
      `Node ${input.nodeId} does not exist in graph revision ${job.graphRevision} of job ${input.jobId}.`,
    );
  }

  const contextPolicy = deps.config.orchestration.jobs.context;
  const policy = contextPolicy.efficiency;
  const strategy = policy.strategy as ContextStrategy;
  const createdAt = nowIso(deps);
  const budget = input.budget ?? contextBudgetFromPolicy(contextPolicy);
  const checkpoint = readLatestTaskCheckpoint(deps.workspace, input.jobId, input.nodeId);
  const attempts = listTaskAttempts(deps.workspace, input.jobId, { nodeId: input.nodeId });

  const snapshot =
    input.gitSnapshot ??
    (await captureGitSnapshot(deps.workspace.rootDir, {
      clock: () => (deps.clock ?? (() => new Date()))(),
    }));

  // --- canonical layers: identical under every strategy --------------------
  const nextActions = checkpoint?.nextActions ?? [`Start task ${node.parentTaskId}: ${node.title}`];
  const currentActionText = input.currentAction ?? bullets(nextActions);
  const canonicalItems: ContextItem[] = [
    ...pinnedItems(job, node, checkpoint, createdAt),
    ...durableItems(checkpoint, createdAt),
    ...repositoryItem(snapshot, createdAt),
    ...(input.workingSet ?? []),
    ...(input.recentDelta ?? []),
    {
      itemId: 'current-action',
      layer: 'CURRENT_ACTION',
      kind: 'next-action',
      title: 'Continue from here',
      content: currentActionText,
      createdAt,
      source: checkpoint?.checkpointId ?? node.nodeId,
      compacted: false,
      authority: 'CANONICAL',
      freshness: 'EPHEMERAL',
    },
  ];

  // --- expansion state: how wide retrieval may go right now ----------------
  const stored =
    readContextExpansionState(deps.workspace, input.jobId, input.nodeId) ??
    initialExpansionState({ taskId: node.parentTaskId, nodeId: input.nodeId, now: createdAt });
  const expansion =
    input.attemptId !== undefined ? beginAttemptExpansion(stored, createdAt) : stored;

  if (strategy === 'LEGACY') {
    const result = await buildEfficientContext({
      strategy: 'LEGACY',
      shape: input.shape,
      expansionLevel: expansion.level,
      canonicalItems,
      budget,
      createdAt,
      planId: planIdFor(input, createdAt),
      taskId: node.parentTaskId,
      jobId: input.jobId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      executionLane: input.lane ?? null,
      executionMode: input.executionMode ?? null,
      runner: input.runner ?? null,
      checkpointId: checkpoint?.checkpointId,
      checkpointSummaryItem:
        checkpoint !== undefined ? checkpointSummaryItem(checkpoint, createdAt) : undefined,
    }).catch(rethrowBudget);
    return persistAndReturn(deps, input, {
      job,
      node,
      checkpoint,
      attempts,
      expansion,
      strategy,
      result,
      refreshedPaths: [],
    });
  }

  // --- repository index -----------------------------------------------------
  const indexed = ensureRepositoryIndex({
    workspace: deps.workspace,
    config: deps.config,
    now: createdAt,
    gitSnapshot: snapshot,
    ...(input.rebuildIndex === true ? { rebuild: true } : {}),
  });

  // --- retrieval query, grounded in durable state --------------------------
  const query = buildRetrievalQuery({
    taskId: node.parentTaskId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    role: input.role,
    contract: checkpoint?.pinned.taskContract ?? `${node.parentTaskId}: ${node.title}`,
    objective: checkpoint?.objective ?? node.title,
    acceptanceCriteria: checkpoint?.pinned.acceptanceCriteria ?? [],
    currentAction: currentActionText,
    failureText: latestFailureText(deps, input.jobId, input.nodeId, node),
    recoveryText: recoveryText(deps, input.jobId, input.nodeId),
    failureFingerprint:
      readTaskReliabilityState(deps.workspace, input.jobId, input.nodeId)?.observations.at(-1)
        ?.failureFingerprint ?? undefined,
    changedPaths: snapshot.entries.map((entry) => entry.path.replace(/\\/g, '/')),
    checkpointChangedPaths: (checkpoint?.changedFiles ?? []).map((file) => file.path),
    priorRelevantPaths: priorRelevantPaths(deps, input.jobId, input.nodeId),
    expansionLevel: expansion.level,
  });

  const allocationPolicy = contextAllocationPolicySchema.parse({
    pinnedReserveRatio: policy.pinnedReserveRatio,
    durableReserveRatio: policy.durableReserveRatio,
    recoveryReserveRatio: policy.recoveryReserveRatio,
    deltaReserveRatio: policy.deltaReserveRatio,
    workingSetMaxRatio: policy.workingSetMaxRatio,
    pointerShapeWorkingSetMaxRatio: policy.pointerShapeWorkingSetMaxRatio,
    maxSingleItemRatio: policy.maxSingleItemRatio,
  });

  // Staleness world: the CURRENT hash of every indexed path, so a carried-over
  // file body whose bytes have moved is removed rather than re-sent.
  const currentHashes = new Map<string, string | null>(
    indexed.state.entries.map((entry) => [entry.path, entry.contentHash]),
  );

  const result = await buildEfficientContext({
    strategy,
    shape: input.shape,
    expansionLevel: expansion.level,
    canonicalItems,
    budget,
    allocationPolicy,
    createdAt,
    planId: planIdFor(input, createdAt),
    taskId: node.parentTaskId,
    jobId: input.jobId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    executionLane: input.lane ?? null,
    executionMode: input.executionMode ?? null,
    runner: input.runner ?? null,
    index: indexed.index,
    rootDir: deps.workspace.rootDir,
    query,
    rankOptions: { maxCandidates: policy.maxCandidates },
    sectionOptions: {
      wholeFileUnderChars: policy.wholeFileUnderChars,
      targetSectionChars: policy.targetSectionChars,
    },
    maxSelectedItems: policy.maxSelectedItems,
    maxPointers: policy.maxPointers,
    ...(policy.localRerank && input.rerankInference !== undefined
      ? { rerankInference: input.rerankInference }
      : {}),
    ...(input.onInferenceCall !== undefined ? { onInferenceCall: input.onInferenceCall } : {}),
    stalenessWorld: {
      currentHashes,
      taskId: node.parentTaskId,
      ...(checkpoint !== undefined ? { checkpointId: checkpoint.checkpointId } : {}),
      ...(snapshot.head !== undefined ? { baselineRef: snapshot.head } : {}),
    },
    compressOverChars: policy.compressOverChars,
    checkpointId: checkpoint?.checkpointId,
    checkpointSummaryItem:
      checkpoint !== undefined ? checkpointSummaryItem(checkpoint, createdAt) : undefined,
    contextExpansionsSoFar: expansion.expansionsThisTask,
  }).catch(rethrowBudget);

  return persistAndReturn(deps, input, {
    job,
    node,
    checkpoint,
    attempts,
    expansion,
    strategy,
    result,
    refreshedPaths: result.refreshedPaths,
  });
}

function planIdFor(input: BuildTaskContextInput, createdAt: string): string {
  const stamp = createdAt.replace(/[^0-9]/g, '').slice(0, 14);
  const suffix = input.attemptId ?? input.role.toLowerCase();
  return `ctx-${input.nodeId}-${suffix}-${stamp}`.slice(0, 120);
}

/**
 * Budget failures surface as the existing orchestration error, unchanged.
 *
 * A context that cannot be assembled within the budget is structural
 * PRESSURE, and it is reported to the control plane rather than absorbed:
 * the context layer does not get to decide that the task should be
 * decomposed, replanned, or moved to a bigger runner.
 */
function rethrowBudget(cause: unknown): never {
  if (cause instanceof ContextBudgetError) {
    throw new OrchestrationError('SBO051', cause.message, {
      remediation: [
        'Raise the context budget for the target worker, or reduce pinned/durable state at its source.',
        'If the task genuinely needs more canonical state than the runner can hold, decompose or replan it.',
      ],
    });
  }
  throw cause;
}

function persistAndReturn(
  deps: JobDeps,
  input: BuildTaskContextInput,
  data: {
    job: JobState;
    node: JobNode;
    checkpoint: TaskCheckpoint | undefined;
    attempts: TaskAttempt[];
    expansion: ContextExpansionState;
    strategy: ContextStrategy;
    result: Awaited<ReturnType<typeof buildEfficientContext>>;
    refreshedPaths: string[];
  },
): BuiltTaskContext {
  const { result } = data;
  // LEGACY writes NOTHING. The strategy is a rollback path, and a rollback
  // that still leaves new files in the job namespace is not one. Benchmarks
  // read the returned metrics directly, so the A/B baseline loses nothing by
  // this — and an upgraded workspace that never opts in stays byte-identical
  // on disk as well as in behaviour.
  if (input.persist !== false && data.strategy !== 'LEGACY') {
    writeContextSelectionPlan(deps.workspace, result.plan);
    if (input.attemptId !== undefined) {
      writeContextMetrics(deps.workspace, input.jobId, input.attemptId, result.metrics);
      writeContextExpansionState(deps.workspace, input.jobId, input.nodeId, {
        ...data.expansion,
        lastWorkingSetTokens: result.metrics.workingSetTokens,
        baselineWorkingSetTokens:
          data.expansion.baselineWorkingSetTokens ?? result.metrics.workingSetTokens,
      });
    }
  }
  return {
    job: data.job,
    node: data.node,
    checkpoint: data.checkpoint,
    attempts: data.attempts,
    assembled: result.assembled,
    plan: result.plan,
    metrics: result.metrics,
    expansion: data.expansion,
    refreshedPaths: data.refreshedPaths,
    strategy: data.strategy,
  };
}
