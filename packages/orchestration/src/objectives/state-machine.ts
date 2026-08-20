import { OrchestrationError } from '../errors.js';
import type { WorkUnitStatus } from './vocabulary.js';
import { isFinalWorkUnitStatus } from './vocabulary.js';

/**
 * The work-unit state machine. Pure function over a frozen table,
 * fail-closed, exactly like the job and node machines.
 *
 * Reading the table:
 *   - `INTEGRATED` is reachable ONLY from `VERIFIED_CANDIDATE`: nothing can
 *     be integrated without passing evaluation, structurally.
 *   - `VERIFIED_CANDIDATE` is reachable only from evaluation statuses: a
 *     unit can never be born verified.
 *   - `SUPERSEDED` is reachable from every non-final status (a work-graph
 *     revision may replace unfinished work), and additionally from FAILED —
 *     a failed unit is replaced by a successor, carrying lineage.
 *   - `REJECTED` returns to `READY` (bounded retry) or ends in `FAILED`.
 */
const WORK_UNIT_TRANSITIONS: Readonly<Record<WorkUnitStatus, readonly WorkUnitStatus[]>> =
  Object.freeze({
    PLANNED: ['READY', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
    READY: ['BUILDING', 'CANDIDATE_READY', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
    BUILDING: ['CANDIDATE_READY', 'READY', 'REJECTED', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
    CANDIDATE_READY: ['EVALUATING', 'VERIFIED_CANDIDATE', 'REJECTED', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
    EVALUATING: ['VERIFIED_CANDIDATE', 'REJECTED', 'CANDIDATE_READY', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
    VERIFIED_CANDIDATE: ['INTEGRATED', 'REJECTED', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
    REJECTED: ['READY', 'BLOCKED', 'SUPERSEDED', 'FAILED'],
    BLOCKED: ['READY', 'SUPERSEDED', 'FAILED'],
    FAILED: ['SUPERSEDED'],
    SUPERSEDED: [],
    INTEGRATED: [],
  });

export function allowedWorkUnitTransitions(from: WorkUnitStatus): readonly WorkUnitStatus[] {
  return WORK_UNIT_TRANSITIONS[from];
}

export function canWorkUnitTransition(from: WorkUnitStatus, to: WorkUnitStatus): boolean {
  return WORK_UNIT_TRANSITIONS[from].includes(to);
}

export function assertWorkUnitTransition(
  workUnitId: string,
  from: WorkUnitStatus,
  to: WorkUnitStatus,
): void {
  if (canWorkUnitTransition(from, to)) return;
  if (isFinalWorkUnitStatus(from) && !(from === 'FAILED' && to === 'SUPERSEDED')) {
    throw new OrchestrationError(
      'SBO040',
      `Work unit ${workUnitId} is already ${from}; it cannot transition to ${to}.`,
      { details: { workUnitId, from, to } },
    );
  }
  throw new OrchestrationError(
    'SBO040',
    `Invalid work-unit transition ${from} → ${to} for ${workUnitId}.`,
    {
      remediation: [
        `Valid next statuses from ${from}: ${WORK_UNIT_TRANSITIONS[from].join(', ') || '(none)'}.`,
      ],
      details: { workUnitId, from, to, allowed: [...WORK_UNIT_TRANSITIONS[from]] },
    },
  );
}
