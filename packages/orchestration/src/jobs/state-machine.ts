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
 * Operational recovery statuses, plus the authority stop, reachable from any
 * status where the underlying condition can be OBSERVED. Spelled once and
 * spread into the rows below so the table cannot drift member by member.
 */
const RECOVERY_TARGETS = [
  'WAITING_RESOURCE',
  'RECOVERING_PROVIDER',
  'REPAIRING_TOOLCHAIN',
  'REPAIRING_ENVIRONMENT',
  'REPAIRING_CONTROL_PLANE',
  'NEEDS_AUTHORITY',
] as const satisfies readonly JobStatus[];

/** Where an operational status may go once its condition clears. */
const RECOVERY_EXITS = [
  'READY',
  'PLANNING',
  'REPLANNING',
  'QUALIFYING',
  ...RECOVERY_TARGETS,
  'NEEDS_CLARIFICATION',
  'BLOCKED',
  'CANCELLED',
  'FAILED',
] as const satisfies readonly JobStatus[];

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
 *
 * vNext.10 adds the autonomous operational statuses. Two rules shape every
 * edge added for them, and they are the whole point of the phase:
 *
 *   1. Every operational status can return to `READY` on its own. That is
 *      what makes "the reason for waiting disappeared" a runtime event
 *      rather than a support ticket. None of them is a terminus.
 *   2. `NEEDS_AUTHORITY` is reachable from every non-final status, and is
 *      NOT reachable from any budget, complexity, or retry condition. The
 *      table permits the edge; `authority.ts` decides whether a given
 *      situation may take it.
 *
 * `QUALIFYING` sits between the last implementation node and `COMPLETED`.
 * The table still allows the historical `READY|RUNNING|REPAIRING` to
 * `COMPLETED` edges, because a non-sealed v1.2 job completes exactly as it
 * always did; the closure ORACLE, not this table, is what forbids a SEALED
 * mission from completing without closure evidence. Two places enforcing
 * the same rule would be two places to forget it.
 */
const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  CREATED: ['PLANNING', 'BLOCKED', 'NEEDS_CLARIFICATION', 'NEEDS_AUTHORITY', 'CANCELLED', 'FAILED'],
  // PLANNING/REPLANNING → WAITING_RETRY (vNext.2, additive): a paid-tier
  // reasoning step may have to wait for subscription quota to return. The
  // wait resumes through READY; the pipeline re-derives the pending stage
  // from durable state, so nothing about the plan lifecycle is lost.
  PLANNING: [
    'READY',
    'NEEDS_CLARIFICATION',
    'WAITING_RETRY',
    ...RECOVERY_TARGETS,
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  READY: [
    'RUNNING',
    // A repair dispatch starts from READY after a diagnosis recommended it.
    'REPAIRING',
    'PLANNING',
    'REPLANNING',
    // vNext.10: planned implementation is done; the closure lifecycle owns
    // whether COMPLETED is available at all.
    'QUALIFYING',
    'NEEDS_CLARIFICATION',
    'WAITING_RETRY',
    ...RECOVERY_TARGETS,
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
    ...RECOVERY_TARGETS,
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
    // A diagnosis is exactly where an operational cause is IDENTIFIED: a
    // dead provider, a missing tool, an unhealthy environment, a runner
    // defect. Naming the cause is what lets the job recover without a human.
    ...RECOVERY_TARGETS,
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
    ...RECOVERY_TARGETS,
    'COMPLETED',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  REPLANNING: [
    'READY',
    'PLANNING',
    'QUALIFYING',
    'NEEDS_CLARIFICATION',
    'WAITING_RETRY',
    ...RECOVERY_TARGETS,
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  WAITING_RETRY: ['READY', ...RECOVERY_TARGETS, 'BLOCKED', 'CANCELLED', 'FAILED'],
  NEEDS_CLARIFICATION: [
    // Another bounded round of questions.
    'NEEDS_CLARIFICATION',
    'READY',
    'PLANNING',
    'REPLANNING',
    'NEEDS_AUTHORITY',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  BLOCKED: [
    'READY',
    'PLANNING',
    'REPLANNING',
    'NEEDS_CLARIFICATION',
    // A blocker whose real cause turns out to be operational is recoverable
    // without a human; a blocker whose real cause is authority is not.
    ...RECOVERY_TARGETS,
    'CANCELLED',
    'FAILED',
  ],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  // -------------------------------------------------------------------------
  // vNext.10 autonomous statuses.
  // -------------------------------------------------------------------------
  WAITING_RESOURCE: [...RECOVERY_EXITS, 'RUNNING'],
  RECOVERING_PROVIDER: [...RECOVERY_EXITS, 'RUNNING'],
  REPAIRING_TOOLCHAIN: [...RECOVERY_EXITS, 'RUNNING'],
  REPAIRING_ENVIRONMENT: [...RECOVERY_EXITS, 'RUNNING'],
  REPAIRING_CONTROL_PLANE: [...RECOVERY_EXITS, 'RUNNING'],
  QUALIFYING: [
    // The closure audit found a gap: more real implementation work exists.
    'READY',
    'PLANNING',
    'REPLANNING',
    // A qualification failure is diagnosed before it is repaired, exactly
    // like any other failure. QUALIFYING gets no shortcut to REPAIRING.
    'DIAGNOSING',
    'RUNNING',
    'QUALIFYING',
    ...RECOVERY_TARGETS,
    'NEEDS_CLARIFICATION',
    'COMPLETED',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  NEEDS_AUTHORITY: [
    // Resolving one authority question may reveal the next one.
    'NEEDS_AUTHORITY',
    'READY',
    'PLANNING',
    'REPLANNING',
    'QUALIFYING',
    'NEEDS_CLARIFICATION',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
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
