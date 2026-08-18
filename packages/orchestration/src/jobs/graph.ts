import { analyzeSpec, requireSpec, taskFingerprint, tryTaskPlanHashOfFile } from '@specbridge/compat-kiro';
import type { WorkspaceInfo } from '@specbridge/core';
import { readSpecState, stateStage } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import { openRequiredLeafTasks } from '@specbridge/execution';
import { JOB_GRAPH_SCHEMA_VERSION, JOB_STATE_LIMITS, jobGraphSchema } from './state.js';
import type { JobGraph, JobNode } from './state.js';
import { assertNodeTransition } from './state-machine.js';
import type { JobNodeStatus } from './vocabulary.js';
import { isFinalNodeStatus } from './vocabulary.js';

/**
 * The runtime execution graph.
 *
 * Built deterministically from the APPROVED task plan — one node per open
 * required leaf task, in document order, each depending on its predecessor.
 * This mirrors the sequential `--all` execution semantics the evidence model
 * was designed around; parallel edges can be introduced later without a
 * schema change because dependencies are explicit.
 *
 * The graph is runtime state. It lives in `.specbridge/jobs/`, its node ids
 * never appear in `.kiro`, and revising it can never change WHICH approved
 * tasks exist — only how the job works through them. A revision that would
 * need different approved tasks is exactly the situation that blocks the job
 * for a human.
 */

export interface GraphBuildResult {
  graph: JobGraph;
  /** Tasks skipped because they are already complete (informational). */
  skippedCompleted: string[];
}

/** Build the initial runtime execution graph for a job. Deterministic. */
export function buildInitialGraph(
  workspace: WorkspaceInfo,
  options: {
    jobId: string;
    specName: string;
    revision?: number;
    createdAt: string;
    gitHead?: string | undefined;
  },
): GraphBuildResult {
  const folder = requireSpec(workspace, options.specName);
  const spec = analyzeSpec(workspace, folder);
  if (spec.tasks === undefined || spec.documents.tasks === undefined) {
    throw new OrchestrationError('SBO031', `Spec "${options.specName}" has no tasks.md; a job needs an approved task plan.`, {
      remediation: ['Author and approve a tasks stage first.'],
    });
  }

  const open = openRequiredLeafTasks(spec.tasks, spec.documents.tasks);
  if (open.length === 0) {
    throw new OrchestrationError(
      'SBO038',
      `Spec "${options.specName}" has no open required leaf tasks; there is nothing to orchestrate.`,
      { remediation: ['All tasks are complete, optional, or grouped; inspect with `specbridge spec status`.'] },
    );
  }
  if (open.length > JOB_STATE_LIMITS.maxNodes) {
    throw new OrchestrationError(
      'SBO031',
      `Spec "${options.specName}" has ${open.length} open tasks; the graph bound is ${JOB_STATE_LIMITS.maxNodes}.`,
      { remediation: ['Split the spec, or complete part of it first.'] },
    );
  }

  const approvedStageHashes: Record<string, string> = {};
  const state = readSpecState(workspace, options.specName).state;
  if (state !== undefined) {
    for (const stage of ['requirements', 'bugfix', 'design', 'tasks'] as const) {
      const approval = stateStage(state, stage);
      if (approval?.status === 'approved' && typeof approval.approvedHash === 'string') {
        approvedStageHashes[stage] = approval.approvedHash;
      }
    }
  }

  const tasksFile = spec.folder.files.find((file) => file.kind === 'tasks');
  const taskPlanHash = tasksFile !== undefined ? tryTaskPlanHashOfFile(tasksFile.path) : undefined;

  const nodes: JobNode[] = open.map((task, index) => {
    const previous = open[index - 1];
    return {
      // Node ids are deterministic within a graph revision: stable across
      // resume, unique within the job, and meaningless outside it.
      nodeId: `n-${sanitizeTaskId(task.id)}`,
      parentTaskId: task.id,
      title: task.title.slice(0, 2_000),
      taskFingerprint: taskFingerprint({
        id: task.id,
        title: task.title,
        requirementRefs: task.requirementRefs,
      }),
      dependsOn: previous !== undefined ? [`n-${sanitizeTaskId(previous.id)}`] : [],
      status: (index === 0 ? 'READY' : 'PENDING') as JobNodeStatus,
      planRevision: 0,
      planApproved: false,
      humanReviewRequired: false,
      complexitySignals: [],
      attempts: [],
      repairCycles: 0,
      replans: 0,
      consecutiveNoProgress: 0,
    };
  });

  const graph = jobGraphSchema.parse({
    schemaVersion: JOB_GRAPH_SCHEMA_VERSION,
    jobId: options.jobId,
    revision: options.revision ?? 1,
    specName: options.specName,
    createdAt: options.createdAt,
    baseline: {
      ...(taskPlanHash !== undefined ? { taskPlanHash } : {}),
      approvedStageHashes,
      ...(options.gitHead !== undefined ? { gitHead: options.gitHead } : {}),
    },
    nodes,
  });

  const skippedCompleted = (spec.tasks.allTasks ?? [])
    .filter((task) => task.state === 'done' && task.children.length === 0)
    .map((task) => task.id);

  return { graph, skippedCompleted };
}

/** Task ids like `2.3` become node-id-safe segments (`2.3` is already safe). */
function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
}

// ---------------------------------------------------------------------------
// Pure graph operations
// ---------------------------------------------------------------------------

export function findNode(graph: JobGraph, nodeId: string): JobNode | undefined {
  return graph.nodes.find((node) => node.nodeId === nodeId);
}

export function requireNode(graph: JobGraph, nodeId: string): JobNode {
  const node = findNode(graph, nodeId);
  if (node === undefined) {
    throw new OrchestrationError('SBO031', `Node "${nodeId}" does not exist in graph revision ${graph.revision}.`);
  }
  return node;
}

/** Replace one node (by id) in an immutable-update fashion. */
export function withNode(graph: JobGraph, updated: JobNode): JobGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.nodeId === updated.nodeId ? updated : node)),
  };
}

/** Transition one node's status after asserting legality. */
export function transitionNode(graph: JobGraph, nodeId: string, to: JobNodeStatus): JobGraph {
  const node = requireNode(graph, nodeId);
  assertNodeTransition(nodeId, node.status, to);
  return withNode(graph, { ...node, status: to });
}

/**
 * Recompute PENDING → READY promotions: a node whose dependencies are all
 * COMPLETED becomes READY. A dependency that is SUPERSEDED defers to its
 * successor's status. Pure; returns a new graph.
 */
export function promoteReadyNodes(graph: JobGraph): JobGraph {
  const byId = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const satisfied = (nodeId: string, seen: Set<string> = new Set()): boolean => {
    if (seen.has(nodeId)) return false; // defensive: cycles never satisfy
    seen.add(nodeId);
    const node = byId.get(nodeId);
    if (node === undefined) return false;
    if (node.status === 'COMPLETED') return true;
    if (node.status === 'SUPERSEDED' && node.supersededBy !== undefined) {
      return satisfied(node.supersededBy, seen);
    }
    return false;
  };
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.status !== 'PENDING') return node;
      const ready = node.dependsOn.every((dependency) => satisfied(dependency));
      return ready ? { ...node, status: 'READY' as JobNodeStatus } : node;
    }),
  };
}

/**
 * The next schedulable node: the first node in graph order whose status is
 * READY, RUNNING, or REPAIRING (an in-flight node is always "next" — with
 * maxConcurrentTasks = 1 there is at most one). Deterministic by
 * construction: graph order is document order.
 */
export function nextSchedulableNode(graph: JobGraph): JobNode | undefined {
  return graph.nodes.find(
    (node) => node.status === 'RUNNING' || node.status === 'REPAIRING' || node.status === 'READY',
  );
}

/** True when every node reached a final status and none FAILED outright. */
export function allNodesComplete(graph: JobGraph): boolean {
  return graph.nodes.every(
    (node) => node.status === 'COMPLETED' || node.status === 'SUPERSEDED',
  );
}

export function unfinishedNodes(graph: JobGraph): JobNode[] {
  return graph.nodes.filter((node) => !isFinalNodeStatus(node.status));
}

// ---------------------------------------------------------------------------
// Graph revision (replanning)
// ---------------------------------------------------------------------------

export interface GraphRevisionInput {
  /** Node being superseded (its work strategy was invalidated). */
  supersedeNodeId: string;
  replanReason: string;
  createdAt: string;
}

/**
 * Produce the next graph revision in which `supersedeNodeId` is replaced by
 * a fresh node for the SAME approved task.
 *
 * What a revision may do: replace a node whose approach failed, carrying its
 * attempt history forward as lineage. What it may never do: add or remove
 * approved tasks, reorder them across approval boundaries, or touch nodes
 * that already completed — completed work is evidence, not a draft.
 */
export function reviseGraphSuperseding(graph: JobGraph, input: GraphRevisionInput): JobGraph {
  const node = requireNode(graph, input.supersedeNodeId);
  if (node.status === 'COMPLETED') {
    throw new OrchestrationError(
      'SBO031',
      `Node ${node.nodeId} is COMPLETED; completed work is never superseded.`,
    );
  }
  if (node.status === 'SUPERSEDED') {
    throw new OrchestrationError('SBO031', `Node ${node.nodeId} is already superseded.`);
  }

  const successorId = nextSuccessorId(graph, node);
  const successor: JobNode = {
    nodeId: successorId,
    parentTaskId: node.parentTaskId,
    title: node.title,
    taskFingerprint: node.taskFingerprint,
    dependsOn: [...node.dependsOn],
    status: 'READY',
    planRevision: 0,
    planApproved: false,
    humanReviewRequired: false,
    complexitySignals: [],
    attempts: [],
    repairCycles: 0,
    // Replans consumed by the task carry forward: superseding a node must
    // not reset its budget.
    replans: node.replans + 1,
    consecutiveNoProgress: 0,
    supersedes: node.nodeId,
  };

  const nodes = graph.nodes.map((candidate) => {
    if (candidate.nodeId === node.nodeId) {
      return { ...candidate, status: 'SUPERSEDED' as JobNodeStatus, supersededBy: successorId };
    }
    // Dependents keep their edges; `promoteReadyNodes` resolves SUPERSEDED
    // dependencies through the lineage chain.
    return candidate;
  });

  return jobGraphSchema.parse({
    ...graph,
    revision: graph.revision + 1,
    createdAt: input.createdAt,
    nodes: [...nodes, successor],
    supersedes: graph.revision,
    replanReason: input.replanReason.slice(0, 2_000),
  });
}

function nextSuccessorId(graph: JobGraph, node: JobNode): string {
  const base = node.nodeId.replace(/-r\d+$/, '');
  let candidate = 2;
  const ids = new Set(graph.nodes.map((entry) => entry.nodeId));
  while (ids.has(`${base}-r${candidate}`)) candidate += 1;
  return `${base}-r${candidate}`;
}
