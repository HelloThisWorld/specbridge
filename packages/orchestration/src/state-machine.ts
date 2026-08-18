import { OrchestrationError } from './errors.js';
import type { ActionCategory, OrchestrationPhase } from './vocabulary.js';
import { isFinalPhase } from './vocabulary.js';

/**
 * The orchestration state machine.
 *
 * Pure functions over a frozen transition table. No I/O, no clock, no
 * configuration — so every valid and invalid transition is directly testable
 * and the same table governs the CLI, the MCP server, and the plugin.
 *
 * Fail-closed: a transition that is not explicitly listed is refused. New
 * phases therefore cannot become reachable by accident.
 */

/**
 * Allowed transitions, keyed by source phase.
 *
 * Reading the table:
 *   - Every non-final phase can reach `BLOCKED`, `CANCELLED`, and `ABORTED`:
 *     a prerequisite can fail, a user can cancel, and a run can be given up
 *     at any point. None of those need a budget.
 *   - `BLOCKED` is deliberately NOT final. It is recoverable, but only
 *     through an explicit operation (answering a clarification, replanning,
 *     or restarting planning) — never by the loop continuing on its own.
 *   - Final phases have no outgoing transitions at all. A "continue" against
 *     a finalized run returns status, it never resumes execution.
 */
const TRANSITIONS: Readonly<Record<OrchestrationPhase, readonly OrchestrationPhase[]>> =
  Object.freeze({
    CREATED: ['NEEDS_CLARIFICATION', 'READY_TO_PLAN', 'BLOCKED', 'REJECTED', 'CANCELLED', 'ABORTED'],
    NEEDS_CLARIFICATION: [
      // Another bounded round of questions.
      'NEEDS_CLARIFICATION',
      'READY_TO_PLAN',
      'BLOCKED',
      'REJECTED',
      'CANCELLED',
      'ABORTED',
    ],
    READY_TO_PLAN: [
      'AWAITING_PLAN_REVIEW',
      // Planning mode `auto`/`disabled`, or a re-submitted plan under review.
      'READY_TO_EXECUTE',
      'NEEDS_CLARIFICATION',
      'BLOCKED',
      'CANCELLED',
      'ABORTED',
    ],
    AWAITING_PLAN_REVIEW: [
      'READY_TO_EXECUTE',
      // A revised plan submitted before review simply re-enters review.
      'AWAITING_PLAN_REVIEW',
      // A rejected plan goes back to planning, never straight to execution.
      'READY_TO_PLAN',
      'NEEDS_CLARIFICATION',
      'BLOCKED',
      'CANCELLED',
      'ABORTED',
    ],
    // A plan may be revised from any phase where one is already in force.
    // Materiality — not the phase — decides whether a prior review still
    // applies, so both the "re-enter review" and the "stay executable"
    // outcomes are reachable from each of the three phases below.
    READY_TO_EXECUTE: [
      'EXECUTING',
      'REPLANNING',
      'AWAITING_PLAN_REVIEW',
      'READY_TO_EXECUTE',
      'NEEDS_CLARIFICATION',
      'BLOCKED',
      'CANCELLED',
      'ABORTED',
    ],
    EXECUTING: [
      // Self-transition: one bounded observe/decide/act iteration.
      'EXECUTING',
      'REPAIRING',
      'REPLANNING',
      'AWAITING_PLAN_REVIEW',
      'READY_TO_EXECUTE',
      'NEEDS_CLARIFICATION',
      'COMPLETED',
      'BLOCKED',
      'CANCELLED',
      'ABORTED',
    ],
    REPAIRING: [
      // Self-transition: another bounded repair cycle.
      'REPAIRING',
      // A repair that produced fresh work returns to ordinary execution.
      'EXECUTING',
      'REPLANNING',
      'AWAITING_PLAN_REVIEW',
      'READY_TO_EXECUTE',
      'NEEDS_CLARIFICATION',
      'COMPLETED',
      'BLOCKED',
      'CANCELLED',
      'ABORTED',
    ],
    REPLANNING: [
      'AWAITING_PLAN_REVIEW',
      'READY_TO_EXECUTE',
      'NEEDS_CLARIFICATION',
      'BLOCKED',
      'CANCELLED',
      'ABORTED',
    ],
    BLOCKED: ['NEEDS_CLARIFICATION', 'READY_TO_PLAN', 'REPLANNING', 'CANCELLED', 'ABORTED'],
    COMPLETED: [],
    ABORTED: [],
    CANCELLED: [],
    REJECTED: [],
  });

export function allowedTransitions(from: OrchestrationPhase): readonly OrchestrationPhase[] {
  return TRANSITIONS[from];
}

export function canTransition(from: OrchestrationPhase, to: OrchestrationPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Assert a transition is legal. Throws a stable SBO error otherwise, with
 * the exact set of legal successors so the caller can explain the refusal
 * without guessing.
 */
export function assertTransition(from: OrchestrationPhase, to: OrchestrationPhase): void {
  if (canTransition(from, to)) return;
  if (isFinalPhase(from)) {
    throw new OrchestrationError(
      'SBO005',
      `Orchestration run is already ${from}; it cannot transition to ${to}. ` +
        'Finalized runs are read-only: start a new orchestration run instead of continuing this one.',
      {
        remediation: [
          'Inspect the finished run with `specbridge orchestrate show <id>`.',
          'Begin a new run for further work — a new run is never presented as a continuation.',
        ],
        details: { from, to },
      },
    );
  }
  throw new OrchestrationError(
    'SBO004',
    `Invalid orchestration transition ${from} → ${to}.`,
    {
      remediation: [
        `Valid next phases from ${from}: ${TRANSITIONS[from].join(', ') || '(none)'}.`,
      ],
      details: { from, to, allowed: [...TRANSITIONS[from]] },
    },
  );
}

/**
 * Which action categories may be recorded in a given phase.
 *
 * This is the second half of the fail-closed model: the phase table governs
 * *where the run can go*, this table governs *what may be attempted while it
 * is there*. Notably `EDIT` is absent from every phase before
 * `READY_TO_EXECUTE`, which is what makes "no source edits before the plan
 * gate" a hard-enforced rule rather than a skill instruction.
 */
const PHASE_ACTIONS: Readonly<Record<OrchestrationPhase, readonly ActionCategory[]>> = Object.freeze(
  {
    CREATED: ['INSPECT', 'REQUEST_CLARIFICATION', 'ABORT'],
    NEEDS_CLARIFICATION: ['INSPECT', 'REQUEST_CLARIFICATION', 'ABORT'],
    READY_TO_PLAN: ['INSPECT', 'REQUEST_CLARIFICATION', 'ABORT'],
    AWAITING_PLAN_REVIEW: ['INSPECT', 'REQUEST_CLARIFICATION', 'REPLAN', 'ABORT'],
    READY_TO_EXECUTE: ['INSPECT', 'EDIT', 'TEST', 'REPLAN', 'REQUEST_CLARIFICATION', 'ABORT'],
    EXECUTING: [
      'INSPECT',
      'EDIT',
      'TEST',
      'VERIFY',
      'REPLAN',
      'REQUEST_CLARIFICATION',
      'COMPLETE',
      'ABORT',
    ],
    REPAIRING: [
      'INSPECT',
      'EDIT',
      'TEST',
      'VERIFY',
      'REPLAN',
      'REQUEST_CLARIFICATION',
      'COMPLETE',
      'ABORT',
    ],
    REPLANNING: ['INSPECT', 'REPLAN', 'REQUEST_CLARIFICATION', 'ABORT'],
    BLOCKED: ['INSPECT', 'REQUEST_CLARIFICATION', 'ABORT'],
    COMPLETED: [],
    ABORTED: [],
    CANCELLED: [],
    REJECTED: [],
  },
);

export function allowedActions(phase: OrchestrationPhase): readonly ActionCategory[] {
  return PHASE_ACTIONS[phase];
}

export function isActionAllowed(phase: OrchestrationPhase, action: ActionCategory): boolean {
  return PHASE_ACTIONS[phase].includes(action);
}

/** Assert an action category is legal in the current phase. */
export function assertActionAllowed(phase: OrchestrationPhase, action: ActionCategory): void {
  if (isActionAllowed(phase, action)) return;
  const remediation: string[] = [
    `Actions allowed in ${phase}: ${PHASE_ACTIONS[phase].join(', ') || '(none — the run is final)'}.`,
  ];
  if (action === 'EDIT' && !isFinalPhase(phase)) {
    remediation.push(
      'Source edits require a valid execution plan. Submit one with orchestration_submit_plan, ' +
        'and have it reviewed when the planning policy is "review".',
    );
  }
  if (action === 'COMPLETE') {
    remediation.push('Completion is only possible once execution has actually started.');
  }
  throw new OrchestrationError(
    'SBO019',
    `Action ${action} is not allowed while the orchestration run is ${phase}.`,
    { remediation, details: { phase, action, allowed: [...PHASE_ACTIONS[phase]] } },
  );
}
