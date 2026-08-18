import { OrchestrationError } from '../errors.js';
import type { JobNodeStatus, JobStatus } from './vocabulary.js';
import { isFinalJobStatus, isFinalNodeStatus } from './vocabulary.js';

/**
 * The job and node state machines.
 *
 * Pure functions over frozen transition tables, exactly like the v1.1 run
 * state machine: no I/O, no clock, no configuration, fail-closed. A
 * transition that is not explicitly listed is refused, so new statuses can
 * never become reachable by accident, and the same tables govern the CLI
 * driver, the MCP surface, and any future daemon.
 */

/**
 * Allowed job transitions, keyed by source status.
 *
 * Reading the table:
 *   - Every non-final status can reach `BLOCKED`, `CANCELLED`, and `FAILED`:
 *     a prerequisite can fail, a user can cancel, and a job can be given up
 *     at any point. None of those needs a budget.
 *   - `BLOCKED` and `NEEDS_CLARIFICATION` are deliberately NOT final. They
 *     are recoverable, but only through an explicit operation (an answer, a
 *     replan, a resume after fixing the prerequisite) — never by the
 *     scheduler continuing on its own.
 *   - A failure is never repaired without passing through `DIAGNOSING`
 *     first: `RUNNING → REPAIRING` is not a legal edge, which enforces
 *     "no repair without a reasoned diagnosis" structurally.
 *   - Final statuses have no outgoing transitions at all.
 */
const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  CREATED: ['PLANNING', 'BLOCKED', 'NEEDS_CLARIFICATION', 'CANCELLED', 'FAILED'],
  PLANNING: ['READY', 'NEEDS_CLARIFICATION', 'BLOCKED', 'CANCELLED', 'FAILED'],
  READY: [
    'RUNNING',
    // A repair dispatch starts from READY after a diagnosis recommended it.
    'REPAIRING',
    'PLANNING',
    'REPLANNING',
    'NEEDS_CLARIFICATION',
    'WAITING_RETRY',
    'COMPLETED',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  RUNNING: [
    // The dispatched node completed or the dispatcher yields between nodes.
    'READY',
    'DIAGNOSING',
    'WAITING_RETRY',
    'NEEDS_CLARIFICATION',
    'COMPLETED',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  DIAGNOSING: [
    'REPAIRING',
    'REPLANNING',
    'WAITING_RETRY',
    'NEEDS_CLARIFICATION',
    // A diagnosis may conclude nothing is wrong with the approach and hand
    // control back to the scheduler (e.g. the failure was transient).
    'READY',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  REPAIRING: [
    // A repair dispatch ends in fresh verification: back to READY when it
    // passed, back through DIAGNOSING when it failed again.
    'READY',
    'DIAGNOSING',
    'WAITING_RETRY',
    'NEEDS_CLARIFICATION',
    'COMPLETED',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  REPLANNING: ['READY', 'PLANNING', 'NEEDS_CLARIFICATION', 'BLOCKED', 'CANCELLED', 'FAILED'],
  WAITING_RETRY: ['READY', 'BLOCKED', 'CANCELLED', 'FAILED'],
  NEEDS_CLARIFICATION: [
    // Another bounded round of questions.
    'NEEDS_CLARIFICATION',
    'READY',
    'PLANNING',
    'REPLANNING',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  BLOCKED: ['READY', 'PLANNING', 'REPLANNING', 'NEEDS_CLARIFICATION', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
});

export function allowedJobTransitions(from: JobStatus): readonly JobStatus[] {
  return JOB_TRANSITIONS[from];
}

export function canJobTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** Assert a job transition is legal; throw a stable SBO error otherwise. */
export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (canJobTransition(from, to)) return;
  if (isFinalJobStatus(from)) {
    throw new OrchestrationError(
      'SBO026',
      `Job is already ${from}; it cannot transition to ${to}. ` +
        'Finalized jobs are read-only: create a new job instead of continuing this one.',
      {
        remediation: [
          'Inspect the finished job with `specbridge orchestrate job <id>`.',
          'Create a new job for further work — a new job is never presented as a continuation.',
        ],
        details: { from, to },
      },
    );
  }
  throw new OrchestrationError('SBO027', `Invalid job transition ${from} → ${to}.`, {
    remediation: [`Valid next statuses from ${from}: ${JOB_TRANSITIONS[from].join(', ') || '(none)'}.`],
    details: { from, to, allowed: [...JOB_TRANSITIONS[from]] },
  });
}

/**
 * Allowed node transitions.
 *
 * `SUPERSEDED` is reachable from every non-final status: a replan may
 * replace a node whose work has not completed, whatever intermediate state
 * it is in. `COMPLETED` is reachable only from `RUNNING`/`REPAIRING`, i.e.
 * only as the outcome of an actual dispatch — a node can never be marked
 * complete while nothing was running for it.
 */
const NODE_TRANSITIONS: Readonly<Record<JobNodeStatus, readonly JobNodeStatus[]>> = Object.freeze({
  PENDING: ['READY', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
  READY: ['RUNNING', 'REPAIRING', 'PENDING', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
  RUNNING: ['READY', 'REPAIRING', 'COMPLETED', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
  REPAIRING: ['RUNNING', 'READY', 'COMPLETED', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
  BLOCKED: ['READY', 'PENDING', 'SUPERSEDED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['SUPERSEDED'],
  SUPERSEDED: [],
});

export function allowedNodeTransitions(from: JobNodeStatus): readonly JobNodeStatus[] {
  return NODE_TRANSITIONS[from];
}

export function canNodeTransition(from: JobNodeStatus, to: JobNodeStatus): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}

/** Assert a node transition is legal; throw a stable SBO error otherwise. */
export function assertNodeTransition(nodeId: string, from: JobNodeStatus, to: JobNodeStatus): void {
  if (canNodeTransition(from, to)) return;
  if (isFinalNodeStatus(from) && !(from === 'FAILED' && to === 'SUPERSEDED')) {
    throw new OrchestrationError(
      'SBO028',
      `Node ${nodeId} is already ${from}; it cannot transition to ${to}.`,
      { details: { nodeId, from, to } },
    );
  }
  throw new OrchestrationError('SBO028', `Invalid node transition ${from} → ${to} for ${nodeId}.`, {
    remediation: [
      `Valid next statuses from ${from}: ${NODE_TRANSITIONS[from].join(', ') || '(none)'}.`,
    ],
    details: { nodeId, from, to, allowed: [...NODE_TRANSITIONS[from]] },
  });
}
