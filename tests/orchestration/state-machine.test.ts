import { describe, expect, it } from 'vitest';
import {
  ACTION_CATEGORIES,
  FINAL_ORCHESTRATION_PHASES,
  ORCHESTRATION_PHASES,
  allowedActions,
  allowedTransitions,
  assertActionAllowed,
  assertTransition,
  canTransition,
  isActionAllowed,
  isFinalPhase,
  isOrchestrationError,
} from '@specbridge/orchestration';
import type { OrchestrationPhase } from '@specbridge/orchestration';

/**
 * The state machine is the governance core: every valid transition is
 * exercised, representative invalid ones are refused, and finalized runs are
 * proven inert.
 */

describe('orchestration state machine', () => {
  it('every phase has an entry in the transition table', () => {
    for (const phase of ORCHESTRATION_PHASES) {
      expect(allowedTransitions(phase)).toBeDefined();
      expect(allowedActions(phase)).toBeDefined();
    }
  });

  it('accepts every transition the table declares', () => {
    for (const from of ORCHESTRATION_PHASES) {
      for (const to of allowedTransitions(from)) {
        expect(canTransition(from, to)).toBe(true);
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it('refuses every transition the table does not declare', () => {
    let refusals = 0;
    for (const from of ORCHESTRATION_PHASES) {
      const allowed = new Set(allowedTransitions(from));
      for (const to of ORCHESTRATION_PHASES) {
        if (allowed.has(to)) continue;
        refusals += 1;
        expect(canTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrow();
      }
    }
    // Sanity: the exhaustive sweep really did test refusals.
    expect(refusals).toBeGreaterThan(50);
  });

  it('final phases have no outgoing transitions and no allowed actions', () => {
    for (const phase of FINAL_ORCHESTRATION_PHASES) {
      expect(isFinalPhase(phase)).toBe(true);
      expect(allowedTransitions(phase)).toHaveLength(0);
      expect(allowedActions(phase)).toHaveLength(0);
      for (const action of ACTION_CATEGORIES) {
        expect(isActionAllowed(phase, action)).toBe(false);
      }
    }
  });

  it('a finalized run reports SBO005 rather than a generic invalid transition', () => {
    try {
      assertTransition('COMPLETED', 'EXECUTING');
      expect.unreachable('completed runs must not transition');
    } catch (error) {
      expect(isOrchestrationError(error)).toBe(true);
      if (!isOrchestrationError(error)) return;
      expect(error.code).toBe('SBO005');
      expect(error.message).toMatch(/already COMPLETED/);
      expect(error.remediation.join(' ')).toMatch(/never presented as a continuation/i);
    }
  });

  it('an illegal non-final transition reports SBO004 with the legal successors', () => {
    try {
      assertTransition('CREATED', 'EXECUTING');
      expect.unreachable('cannot execute straight from CREATED');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.code).toBe('SBO004');
      expect(error.details['allowed']).toEqual([...allowedTransitions('CREATED')]);
    }
  });

  describe('the edit gate', () => {
    const preExecutionPhases: OrchestrationPhase[] = [
      'CREATED',
      'NEEDS_CLARIFICATION',
      'READY_TO_PLAN',
      'AWAITING_PLAN_REVIEW',
      'REPLANNING',
      'BLOCKED',
    ];

    it('forbids EDIT in every phase before a plan is ready', () => {
      for (const phase of preExecutionPhases) {
        expect(isActionAllowed(phase, 'EDIT')).toBe(false);
        expect(() => assertActionAllowed(phase, 'EDIT')).toThrow(/not allowed/);
      }
    });

    it('explains that edits require a plan', () => {
      try {
        assertActionAllowed('AWAITING_PLAN_REVIEW', 'EDIT');
        expect.unreachable('edits must be refused before review');
      } catch (error) {
        if (!isOrchestrationError(error)) throw error;
        expect(error.code).toBe('SBO019');
        expect(error.remediation.join(' ')).toMatch(/execution plan/i);
      }
    });

    it('allows EDIT only once a plan is in force', () => {
      for (const phase of ['READY_TO_EXECUTE', 'EXECUTING', 'REPAIRING'] as OrchestrationPhase[]) {
        expect(isActionAllowed(phase, 'EDIT')).toBe(true);
      }
    });
  });

  it('forbids COMPLETE before execution has started', () => {
    for (const phase of ['CREATED', 'READY_TO_PLAN', 'AWAITING_PLAN_REVIEW'] as OrchestrationPhase[]) {
      expect(isActionAllowed(phase, 'COMPLETE')).toBe(false);
    }
    expect(isActionAllowed('EXECUTING', 'COMPLETE')).toBe(true);
  });

  it('allows inspection and clarification in every non-final phase', () => {
    for (const phase of ORCHESTRATION_PHASES) {
      if (isFinalPhase(phase)) continue;
      expect(isActionAllowed(phase, 'INSPECT')).toBe(true);
      expect(isActionAllowed(phase, 'REQUEST_CLARIFICATION')).toBe(true);
      expect(isActionAllowed(phase, 'ABORT')).toBe(true);
    }
  });

  it('BLOCKED is recoverable only through an explicit operation', () => {
    // It can be resolved, replanned, or given up — but never simply resumed.
    expect(canTransition('BLOCKED', 'NEEDS_CLARIFICATION')).toBe(true);
    expect(canTransition('BLOCKED', 'READY_TO_PLAN')).toBe(true);
    expect(canTransition('BLOCKED', 'REPLANNING')).toBe(true);
    expect(canTransition('BLOCKED', 'EXECUTING')).toBe(false);
    expect(canTransition('BLOCKED', 'READY_TO_EXECUTE')).toBe(false);
    expect(canTransition('BLOCKED', 'COMPLETED')).toBe(false);
  });

  it('never allows completion straight from planning phases', () => {
    for (const phase of [
      'CREATED',
      'NEEDS_CLARIFICATION',
      'READY_TO_PLAN',
      'AWAITING_PLAN_REVIEW',
      'READY_TO_EXECUTE',
      'REPLANNING',
      'BLOCKED',
    ] as OrchestrationPhase[]) {
      expect(canTransition(phase, 'COMPLETED')).toBe(false);
    }
    expect(canTransition('EXECUTING', 'COMPLETED')).toBe(true);
    expect(canTransition('REPAIRING', 'COMPLETED')).toBe(true);
  });
});
