import type { JobGraph, JobNode } from '../jobs/state.js';
import type { DelaySensitivity } from './vocabulary.js';

/**
 * DelaySensitivity (vNext.5): does WAITING actually cost this job anything?
 *
 * The gap-bridge planner needs an answer before it can justify spending
 * money to avoid a wait. The answer is derived from the deterministic work
 * graph SpecBridge already owns — blocked dependents, critical-path
 * membership, whether any other useful work is ready — and never from an
 * unconstrained model judgement about urgency. A model asked "is this
 * urgent?" will say yes, and it would be spending someone else's money to
 * say it.
 *
 *   LOW     waiting is close to free: other work is ready, nothing is
 *           blocked behind this task
 *   MEDIUM  waiting costs real progress, but the job is not stalled
 *   HIGH    the job is effectively blocked on this task
 *
 * Deliberately small. This is not a project-scheduling engine; it is four
 * graph facts and a table, so that the reason a paid attempt was justified
 * stays legible in one decision record months later.
 */

export interface DelaySensitivitySignal {
  signal: string;
  evidence: string;
}

export interface DelaySensitivityAssessment {
  level: DelaySensitivity;
  /** Unfinished nodes that transitively depend on this one. */
  blockedDependents: number;
  /**
   * True when no unfinished node outside this task's own dependency chain
   * could proceed instead — i.e. the whole job waits on this task.
   */
  criticalPath: boolean;
  /** READY nodes that could run on the LOCAL lane right now. */
  readyLocalBacklog: number;
  /** Other READY nodes that are not deferred. */
  readyAlternatives: number;
  signals: DelaySensitivitySignal[];
}

const UNFINISHED_STATUSES: readonly string[] = [
  'PENDING',
  'READY',
  'RUNNING',
  'REPAIRING',
  'BLOCKED',
  'FAILED',
];

function isUnfinished(node: JobNode): boolean {
  return UNFINISHED_STATUSES.includes(node.status);
}

/** Nodes that transitively depend on `nodeId` and are not finished. */
function transitiveDependents(graph: JobGraph, nodeId: string): Set<string> {
  const dependents = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (node.nodeId === nodeId || dependents.has(node.nodeId)) continue;
      const depends = node.dependsOn.some(
        (dependency) => dependency === nodeId || dependents.has(dependency),
      );
      if (depends) {
        dependents.add(node.nodeId);
        changed = true;
      }
    }
  }
  return dependents;
}

export interface AssessDelaySensitivityInput {
  graph: JobGraph | undefined;
  /** The node whose delay is being assessed. */
  nodeId: string;
  /**
   * Node ids that could run on the LOCAL lane right now (the driver knows
   * this from the same pass's lane assessments). Useful local work waiting
   * is a reason to do it INSTEAD of paying, not a reason to pay faster.
   */
  readyLocalNodeIds?: readonly string[] | undefined;
  /** Node ids that are READY and would NOT defer (any lane). */
  readyRunnableNodeIds?: readonly string[] | undefined;
}

/** Assess how much a delay on one task costs the job. Pure and deterministic. */
export function assessDelaySensitivity(
  input: AssessDelaySensitivityInput,
): DelaySensitivityAssessment {
  const graph = input.graph;
  const signals: DelaySensitivitySignal[] = [];
  const readyLocal = (input.readyLocalNodeIds ?? []).filter((id) => id !== input.nodeId);
  const readyAlternatives = (input.readyRunnableNodeIds ?? []).filter((id) => id !== input.nodeId);

  if (graph === undefined) {
    // No graph means no evidence of blocking. Absence of evidence is not
    // evidence of urgency: the conservative (cheaper) answer wins.
    return {
      level: 'LOW',
      blockedDependents: 0,
      criticalPath: false,
      readyLocalBacklog: readyLocal.length,
      readyAlternatives: readyAlternatives.length,
      signals: [
        { signal: 'no-graph', evidence: 'no runtime graph is available to assess blocking' },
      ],
    };
  }

  const dependents = transitiveDependents(graph, input.nodeId);
  const blockedDependents = graph.nodes.filter(
    (node) => dependents.has(node.nodeId) && isUnfinished(node),
  ).length;
  // Critical path, deterministically: every OTHER unfinished node is either
  // downstream of this one or is not itself runnable. If that holds, the job
  // makes no progress at all until this task moves.
  const otherUnfinished = graph.nodes.filter(
    (node) => node.nodeId !== input.nodeId && isUnfinished(node),
  );
  const criticalPath =
    otherUnfinished.length === 0 ||
    otherUnfinished.every(
      (node) => dependents.has(node.nodeId) || !readyAlternatives.includes(node.nodeId),
    );

  if (blockedDependents > 0) {
    signals.push({
      signal: 'blocked-dependents',
      evidence: `${blockedDependents} unfinished task(s) depend on this one`,
    });
  }
  if (criticalPath) {
    signals.push({
      signal: 'critical-path',
      evidence: 'no other ready task can make progress while this one waits',
    });
  }
  if (readyLocal.length > 0) {
    signals.push({
      signal: 'ready-local-backlog',
      evidence: `${readyLocal.length} task(s) can run on the LOCAL lane meanwhile`,
    });
  }
  if (readyAlternatives.length > 0) {
    signals.push({
      signal: 'ready-alternatives',
      evidence: `${readyAlternatives.length} other ready task(s) could run instead`,
    });
  }

  // The table. Ordered most-blocking first; the first match wins.
  let level: DelaySensitivity;
  if (criticalPath && readyAlternatives.length === 0) {
    level = 'HIGH';
  } else if (blockedDependents >= 2 && readyLocal.length === 0) {
    level = 'HIGH';
  } else if (blockedDependents > 0 || criticalPath) {
    level = 'MEDIUM';
  } else {
    level = 'LOW';
  }
  if (level === 'HIGH' && readyLocal.length > 0) {
    // Genuinely blocking work still outranks peripheral local work — that
    // is the critical-path exception — but the fact that local work exists
    // is recorded, because it is the planner's first alternative to paying.
    signals.push({
      signal: 'critical-path-exception',
      evidence:
        'the task blocks the job even though local work remains ready; blocking wins, and the ' +
        'available local work is recorded on the decision',
    });
  }
  if (signals.length === 0) {
    signals.push({ signal: 'no-blocking', evidence: 'nothing waits on this task' });
  }
  return {
    level,
    blockedDependents,
    criticalPath,
    readyLocalBacklog: readyLocal.length,
    readyAlternatives: readyAlternatives.length,
    signals,
  };
}

/** Ordering for policy comparisons ("at least MEDIUM"). */
export function delaySensitivityRank(level: DelaySensitivity): number {
  return level === 'HIGH' ? 3 : level === 'MEDIUM' ? 2 : 1;
}
