import type {
  AssembledContext,
  ContextBudgetConfig,
  ContextItem,
} from '@specbridge/context';
import {
  ContextBudgetError,
  assembleContextPackage,
  contextBudgetConfigSchema,
} from '@specbridge/context';
import { captureGitSnapshot } from '@specbridge/evidence';
import type { GitSnapshot } from '@specbridge/evidence';
import type { JobContextPolicy } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import type { JobDeps } from '../jobs/job-service.js';
import { recordJobEvent } from '../jobs/job-service.js';
import { requireGraphRevision, requireJobState } from '../jobs/store.js';
import type { JobNode, JobState } from '../jobs/state.js';
import type { TaskAttempt, TaskCheckpoint } from './state.js';
import { readLatestTaskCheckpoint, listTaskAttempts } from './store.js';
import { reconcileInterruptedAttempts } from './service.js';

/**
 * Context reconstruction: the deterministic path a FRESH worker starts from.
 *
 *   load Job → load Task → load latest Checkpoint → pinned context →
 *   durable state → working context → recent delta → apply budget →
 *   compact if required → ContextPackage
 *
 * Everything comes from SpecBridge durable state plus current repository
 * state. Nothing comes from a previous agent conversation — there is no
 * input through which one could arrive. Provider-native compacted sessions
 * are working memory a SAME-provider attempt may reuse as an optimization;
 * they are structurally incapable of feeding this path.
 *
 * Determinism: the same durable state, working set, and clock produce the
 * same package. Tests replay this exactly.
 */

/** Map the configured context policy onto a provider-neutral budget. */
export function contextBudgetFromPolicy(policy: JobContextPolicy): ContextBudgetConfig {
  return contextBudgetConfigSchema.parse({
    modelContextTokens: policy.defaultModelContextTokens,
    reservedOutputTokens: policy.reservedOutputTokens,
    reservedReasoningTokens: policy.reservedReasoningTokens,
    reservedGrowthTokens: policy.reservedGrowthTokens,
    prepareThreshold: policy.prepareThreshold,
    proactiveCompactionThreshold: policy.proactiveCompactionThreshold,
    emergencyCompactionThreshold: policy.emergencyCompactionThreshold,
    hardStopThreshold: policy.hardStopThreshold,
  });
}

export interface ReconstructTaskContextInput {
  jobId: string;
  nodeId: string;
  /** Budget of the TARGET worker (the one about to receive the package). */
  budget?: ContextBudgetConfig | undefined;
  /** Current repository snapshot, when the caller already captured one. */
  gitSnapshot?: GitSnapshot | undefined;
  /** Replaceable working-set items (repository excerpts, latest test output). */
  workingSet?: readonly ContextItem[] | undefined;
  /** Recent high-value raw deltas to carry into the fresh context. */
  recentDelta?: readonly ContextItem[] | undefined;
  /** Overrides the current action derived from the checkpoint's nextActions. */
  currentAction?: string | undefined;
}

export interface ReconstructedTaskContext {
  job: JobState;
  node: JobNode;
  checkpoint: TaskCheckpoint | undefined;
  assembled: AssembledContext;
  /** Prior attempts, oldest first — history, visible and durable. */
  attempts: TaskAttempt[];
}

function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

function pinnedItems(
  job: JobState,
  node: JobNode,
  checkpoint: TaskCheckpoint | undefined,
  createdAt: string,
): ContextItem[] {
  const items: ContextItem[] = [];
  const contract =
    checkpoint?.pinned.taskContract ?? `Task ${node.parentTaskId}: ${node.title}`;
  items.push({
    itemId: 'pinned-task-contract',
    layer: 'PINNED',
    kind: 'task-contract',
    title: 'TaskContract',
    content: contract,
    createdAt,
    source: checkpoint?.checkpointId ?? node.nodeId,
    compacted: false,
  });
  items.push({
    itemId: 'pinned-job-goal',
    layer: 'PINNED',
    kind: 'job-goal',
    title: 'Job goal',
    content: `Job ${job.jobId} (spec "${job.specName}"): ${job.goal}`,
    createdAt,
    source: job.jobId,
    compacted: false,
  });
  const criteria = checkpoint?.pinned.acceptanceCriteria ?? [];
  if (criteria.length > 0) {
    items.push({
      itemId: 'pinned-acceptance-criteria',
      layer: 'PINNED',
      kind: 'acceptance-criteria',
      title: 'AcceptanceCriteria',
      content: bullets(criteria),
      createdAt,
      source: checkpoint?.checkpointId ?? node.nodeId,
      compacted: false,
    });
  }
  const constraints = [
    ...(checkpoint?.pinned.constraints ?? []),
    ...(checkpoint?.pinned.invariants ?? []),
  ];
  if (constraints.length > 0) {
    items.push({
      itemId: 'pinned-constraints',
      layer: 'PINNED',
      kind: 'constraints',
      title: 'Constraints and invariants',
      content: bullets(constraints),
      createdAt,
      source: checkpoint?.checkpointId ?? node.nodeId,
      compacted: false,
    });
  }
  return items;
}

function durableItems(checkpoint: TaskCheckpoint | undefined, createdAt: string): ContextItem[] {
  if (checkpoint === undefined) return [];
  const items: ContextItem[] = [];
  const push = (id: string, kind: string, title: string, content: string): void => {
    if (content.length === 0) return;
    items.push({
      itemId: id,
      layer: 'DURABLE_TASK_STATE',
      kind,
      title,
      content,
      createdAt,
      source: checkpoint.checkpointId,
      compacted: false,
    });
  };
  push('durable-objective', 'objective', 'Current objective', checkpoint.objective);
  push('durable-completed-work', 'completed-work', 'Completed work', bullets(checkpoint.completedWork));
  push('durable-pending-work', 'pending-work', 'Pending work', bullets(checkpoint.pendingWork));
  push(
    'durable-decisions',
    'decision',
    'Important decisions',
    bullets(
      checkpoint.importantDecisions.map((decision) =>
        decision.rationale !== undefined
          ? `${decision.decision} (why: ${decision.rationale})`
          : decision.decision,
      ),
    ),
  );
  push(
    'durable-failed-approaches',
    'failed-approach',
    'Failed approaches (do not repeat)',
    bullets(
      checkpoint.failedApproaches.map((failed) => `${failed.approach} — failed because: ${failed.reason}`),
    ),
  );
  push('durable-known-failures', 'known-failure', 'Known failures', bullets(checkpoint.knownFailures));
  push(
    'durable-unresolved-issues',
    'unresolved-issue',
    'Unresolved issues',
    bullets(checkpoint.unresolvedIssues),
  );
  push(
    'durable-test-results',
    'test-result',
    'Test results already obtained',
    bullets(
      checkpoint.testResults.map(
        (test) => `${test.name}: ${test.status}${test.summary !== undefined ? ` — ${test.summary}` : ''}`,
      ),
    ),
  );
  push(
    'durable-changed-files',
    'changed-files',
    'Files changed so far',
    bullets(
      checkpoint.changedFiles.map(
        (file) => `${file.path}${file.note !== undefined ? ` (${file.note})` : ''}`,
      ),
    ),
  );
  push(
    'durable-artifacts',
    'artifact-references',
    'Relevant artifacts',
    bullets([...checkpoint.relevantArtifacts, ...checkpoint.relevantContextReferences]),
  );
  return items;
}

function repositoryItem(snapshot: GitSnapshot | undefined, createdAt: string): ContextItem[] {
  if (snapshot === undefined) return [];
  const lines = [
    snapshot.head !== undefined ? `HEAD: ${snapshot.head}` : 'HEAD: (no commits)',
    snapshot.branch !== undefined
      ? `Branch: ${snapshot.branch}`
      : snapshot.detached
        ? 'Branch: (detached HEAD)'
        : 'Branch: (unknown)',
    snapshot.clean
      ? 'Working tree: clean'
      : `Working tree: ${snapshot.entries.length} modified path(s): ${snapshot.entries
          .slice(0, 30)
          .map((entry) => entry.path)
          .join(', ')}`,
  ];
  return [
    {
      itemId: 'working-repository-state',
      layer: 'WORKING_SET',
      kind: 'repository-state',
      title: 'Current repository state',
      content: lines.join('\n'),
      createdAt,
      source: 'git-snapshot',
      compacted: false,
    },
  ];
}

/** Build the checkpoint-backed summary the assembler may fall back to. */
export function checkpointSummaryItem(checkpoint: TaskCheckpoint, createdAt: string): ContextItem {
  return {
    itemId: `checkpoint-summary-${checkpoint.checkpointId}`,
    layer: 'COMPACTED_HISTORY',
    kind: 'summary',
    title: `Durable checkpoint ${checkpoint.checkpointId} (seq ${checkpoint.seq})`,
    content: [
      `Objective: ${checkpoint.objective}`,
      `Completed: ${checkpoint.completedWork.length} item(s). Pending: ${checkpoint.pendingWork.length}.`,
      `Next actions:\n${bullets(checkpoint.nextActions)}`,
    ].join('\n'),
    createdAt,
    source: checkpoint.checkpointId,
    compacted: true,
  };
}

/**
 * Rebuild a bounded, layered context for one task from durable state only.
 * Read-only: inspecting a task never changes it.
 */
export function reconstructTaskContext(
  deps: JobDeps,
  input: ReconstructTaskContextInput,
): ReconstructedTaskContext {
  const job = requireJobState(deps.workspace, input.jobId);
  if (job.graphRevision < 1) {
    throw new OrchestrationError(
      'SBO051',
      `Job ${input.jobId} has no runtime graph yet; there is no task context to reconstruct.`,
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
  const checkpoint = readLatestTaskCheckpoint(deps.workspace, input.jobId, input.nodeId);
  const attempts = listTaskAttempts(deps.workspace, input.jobId, { nodeId: input.nodeId });
  const createdAt = ((deps.clock ?? (() => new Date()))()).toISOString();
  const budget =
    input.budget ?? contextBudgetFromPolicy(deps.config.orchestration.jobs.context);

  const items: ContextItem[] = [
    ...pinnedItems(job, node, checkpoint, createdAt),
    ...durableItems(checkpoint, createdAt),
    ...repositoryItem(input.gitSnapshot, createdAt),
    ...(input.workingSet ?? []),
    ...(input.recentDelta ?? []),
  ];
  const nextActions = checkpoint?.nextActions ?? [`Start task ${node.parentTaskId}: ${node.title}`];
  items.push({
    itemId: 'current-action',
    layer: 'CURRENT_ACTION',
    kind: 'next-action',
    title: 'Continue from here',
    content: input.currentAction ?? bullets(nextActions),
    createdAt,
    source: checkpoint?.checkpointId ?? node.nodeId,
    compacted: false,
  });

  try {
    const assembled = assembleContextPackage({
      items,
      budget,
      createdAt,
      jobId: input.jobId,
      taskId: node.parentTaskId,
      checkpointId: checkpoint?.checkpointId,
      checkpointSummaryItem:
        checkpoint !== undefined ? checkpointSummaryItem(checkpoint, createdAt) : undefined,
    });
    return { job, node, checkpoint, assembled, attempts };
  } catch (cause) {
    if (cause instanceof ContextBudgetError) {
      throw new OrchestrationError('SBO051', cause.message, {
        remediation: [
          'Raise the context budget for the target worker, or reduce pinned/durable state at its source.',
        ],
      });
    }
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Resume semantics
// ---------------------------------------------------------------------------

export interface PrepareTaskResumeInput {
  jobId: string;
  nodeId: string;
  budget?: ContextBudgetConfig | undefined;
  workingSet?: readonly ContextItem[] | undefined;
  recentDelta?: readonly ContextItem[] | undefined;
}

export interface TaskResumePreparation extends ReconstructedTaskContext {
  /** Attempts reconciled RUNNING → INTERRUPTED by this preparation. */
  interruptedAttemptIds: string[];
  /** The attempt a new dispatch should record as its lineage parent. */
  resumeFromAttemptId: string | undefined;
  /** The exact next actions, from the latest checkpoint. */
  nextActions: string[];
}

/**
 * Prepare to resume one task with a fresh worker:
 *
 *   1. durable task state is loaded;
 *   2. the latest valid checkpoint is determined;
 *   3. repository state is inspected;
 *   4. bounded context is reconstructed;
 *   5. (the caller then creates a new ExecutionAttempt via the normal
 *      dispatch path, carrying `resumeFromAttemptId` lineage);
 *   6. execution continues from `nextActions`;
 *   7. previous attempts remain as history.
 *
 * The one write this performs is reconciliation: attempts persisted as
 * RUNNING with no live process become INTERRUPTED — which is itself part of
 * refusing to pretend a resumed task is the same transient execution.
 */
export async function prepareTaskResume(
  deps: JobDeps,
  input: PrepareTaskResumeInput,
): Promise<TaskResumePreparation> {
  const reconciled = reconcileInterruptedAttempts(
    { workspace: deps.workspace, clock: deps.clock },
    input.jobId,
  );
  const snapshot = await captureGitSnapshot(deps.workspace.rootDir, {
    clock: () => (deps.clock ?? (() => new Date()))(),
  });
  const context = reconstructTaskContext(deps, {
    jobId: input.jobId,
    nodeId: input.nodeId,
    budget: input.budget,
    gitSnapshot: snapshot,
    workingSet: input.workingSet,
    recentDelta: input.recentDelta,
  });
  const nodeAttempts = context.attempts;
  const latestFinal = [...nodeAttempts]
    .reverse()
    .find((attempt) => attempt.status !== 'RUNNING');

  // Observability: the resume and any compaction it needed are lifecycle
  // events, recorded with the same budget rules as every other job event.
  recordJobEvent(deps, input.jobId, 'task_resumed', {
    nodeId: input.nodeId,
    taskId: context.node.parentTaskId,
    checkpointId: context.checkpoint?.checkpointId,
    priorAttempts: nodeAttempts.length,
  });
  if (context.assembled.compactions.length > 0) {
    recordJobEvent(deps, input.jobId, 'context_compacted', {
      nodeId: input.nodeId,
      passes: context.assembled.compactions.map((record) => record.level),
      estimatedTokens: context.assembled.package.usage.estimatedTokens,
    });
  }

  return {
    ...context,
    interruptedAttemptIds: reconciled
      .filter((attempt) => attempt.nodeId === input.nodeId)
      .map((attempt) => attempt.attemptId),
    resumeFromAttemptId: latestFinal?.attemptId,
    nextActions: context.checkpoint?.nextActions ?? [
      `Start task ${context.node.parentTaskId}: ${context.node.title}`,
    ],
  };
}
