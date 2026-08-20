import { MissionError } from './errors.js';
import type { MissionStatus } from './vocabulary.js';
import { isFinalMissionStatus } from './vocabulary.js';

/**
 * The mission state machine.
 *
 * A pure function over a frozen transition table, exactly like the run and
 * job state machines: no I/O, no clock, no configuration, fail-closed. A
 * transition that is not explicitly listed is refused.
 *
 * Reading the table:
 *   - `CONTRACT_READY` is only reachable from discovery statuses, and the
 *     service additionally requires the deterministic coverage gate — this
 *     table is necessary, not sufficient.
 *   - Discovery can always be REOPENED from `CONTRACT_READY` and
 *     `SPEC_REVIEW`: a new material question moves the mission backwards
 *     instead of papering over a gap. From `APPROVED` it can too — approving
 *     a spec does not forbid changing one's mind, it just restarts the
 *     approval lifecycle for whatever changes.
 *   - `ABANDONED` is reachable from every non-final status and is final.
 */
const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> =
  Object.freeze({
    IDEA: ['DISCOVERING', 'ABANDONED'],
    DISCOVERING: ['NEEDS_DECISION', 'CONTRACT_READY', 'ABANDONED'],
    NEEDS_DECISION: ['DISCOVERING', 'CONTRACT_READY', 'ABANDONED'],
    CONTRACT_READY: ['SPEC_SYNTHESIS', 'DISCOVERING', 'NEEDS_DECISION', 'ABANDONED'],
    SPEC_SYNTHESIS: ['SPEC_REVIEW', 'CONTRACT_READY', 'ABANDONED'],
    SPEC_REVIEW: ['APPROVED', 'SPEC_SYNTHESIS', 'DISCOVERING', 'ABANDONED'],
    APPROVED: ['SPEC_REVIEW', 'DISCOVERING', 'ABANDONED'],
    ABANDONED: [],
  });

export function allowedMissionTransitions(from: MissionStatus): readonly MissionStatus[] {
  return MISSION_TRANSITIONS[from];
}

export function canMissionTransition(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

/** Assert a transition is legal; throw a stable SBM error otherwise. */
export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (canMissionTransition(from, to)) return;
  if (isFinalMissionStatus(from)) {
    throw new MissionError(
      'SBM004',
      `Mission is already ${from}; it cannot transition to ${to}. Abandoned missions are read-only.`,
      { remediation: ['Begin a new mission instead of continuing this one.'], details: { from, to } },
    );
  }
  throw new MissionError('SBM003', `Invalid mission transition ${from} → ${to}.`, {
    remediation: [
      `Valid next statuses from ${from}: ${MISSION_TRANSITIONS[from].join(', ') || '(none)'}.`,
    ],
    details: { from, to, allowed: [...MISSION_TRANSITIONS[from]] },
  });
}
