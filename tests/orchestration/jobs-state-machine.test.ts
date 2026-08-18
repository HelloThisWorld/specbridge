import { describe, expect, it } from 'vitest';
import {
  FINAL_JOB_NODE_STATUSES,
  FINAL_JOB_STATUSES,
  JOB_NODE_STATUSES,
  JOB_STATUSES,
  OrchestrationError,
  allowedJobTransitions,
  allowedNodeTransitions,
  assertJobTransition,
  assertNodeTransition,
  canJobTransition,
  canNodeTransition,
  isFinalJobStatus,
  isFinalNodeStatus,
} from '@specbridge/orchestration';

/**
 * The job and node state machines are fail-closed transition tables. These
 * tests pin every structural rule the tables encode; a table edit that
 * weakens one fails here first.
 */

describe('job state machine', () => {
  it('final statuses have no outgoing transitions', () => {
    for (const status of FINAL_JOB_STATUSES) {
      expect(allowedJobTransitions(status)).toHaveLength(0);
    }
  });

  it('every non-final status can reach BLOCKED, CANCELLED, and FAILED', () => {
    for (const status of JOB_STATUSES) {
      if (isFinalJobStatus(status)) continue;
      if (status !== 'BLOCKED') {
        expect(canJobTransition(status, 'BLOCKED'), `${status} → BLOCKED`).toBe(true);
      }
      expect(canJobTransition(status, 'CANCELLED'), `${status} → CANCELLED`).toBe(true);
      expect(canJobTransition(status, 'FAILED'), `${status} → FAILED`).toBe(true);
    }
  });

  it('a failure is never repaired without passing through DIAGNOSING', () => {
    expect(canJobTransition('RUNNING', 'REPAIRING')).toBe(false);
    expect(canJobTransition('RUNNING', 'DIAGNOSING')).toBe(true);
    expect(canJobTransition('DIAGNOSING', 'REPAIRING')).toBe(true);
  });

  it('COMPLETED is reachable only from statuses where work actually ran', () => {
    const sources = JOB_STATUSES.filter((status) => canJobTransition(status, 'COMPLETED'));
    expect(sources.sort()).toEqual(['READY', 'REPAIRING', 'RUNNING'].sort());
  });

  it('WAITING_RETRY resumes only through READY', () => {
    expect(allowedJobTransitions('WAITING_RETRY')).toEqual(
      expect.arrayContaining(['READY', 'CANCELLED', 'FAILED', 'BLOCKED']),
    );
    expect(canJobTransition('WAITING_RETRY', 'RUNNING')).toBe(false);
  });

  it('BLOCKED is recoverable but never final', () => {
    expect(isFinalJobStatus('BLOCKED')).toBe(false);
    expect(canJobTransition('BLOCKED', 'READY')).toBe(true);
    expect(canJobTransition('BLOCKED', 'COMPLETED')).toBe(false);
  });

  it('refuses an invalid transition with SBO027 and the legal successors', () => {
    try {
      assertJobTransition('CREATED', 'RUNNING');
      expect.unreachable('transition should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError);
      const orchestrationError = error as OrchestrationError;
      expect(orchestrationError.code).toBe('SBO027');
      expect(orchestrationError.remediation.join(' ')).toContain('PLANNING');
    }
  });

  it('refuses to leave a final status with SBO026', () => {
    expect(() => assertJobTransition('COMPLETED', 'READY')).toThrowError(/SBO026|Finalized/);
    try {
      assertJobTransition('CANCELLED', 'RUNNING');
      expect.unreachable('transition should have thrown');
    } catch (error) {
      expect((error as OrchestrationError).code).toBe('SBO026');
    }
  });

  it('accepts every listed transition without throwing', () => {
    for (const from of JOB_STATUSES) {
      for (const to of allowedJobTransitions(from)) {
        expect(() => assertJobTransition(from, to)).not.toThrow();
      }
    }
  });
});

describe('node state machine', () => {
  it('COMPLETED and SUPERSEDED are terminal; FAILED can only be superseded', () => {
    expect(allowedNodeTransitions('COMPLETED')).toHaveLength(0);
    expect(allowedNodeTransitions('SUPERSEDED')).toHaveLength(0);
    expect(allowedNodeTransitions('FAILED')).toEqual(['SUPERSEDED']);
  });

  it('COMPLETED is reachable only from an actual dispatch', () => {
    const sources = JOB_NODE_STATUSES.filter((status) => canNodeTransition(status, 'COMPLETED'));
    expect(sources.sort()).toEqual(['REPAIRING', 'RUNNING'].sort());
  });

  it('every non-final status can be superseded by a replan', () => {
    for (const status of JOB_NODE_STATUSES) {
      if (isFinalNodeStatus(status)) continue;
      expect(canNodeTransition(status, 'SUPERSEDED'), `${status} → SUPERSEDED`).toBe(true);
    }
  });

  it('refuses an invalid node transition with SBO028', () => {
    try {
      assertNodeTransition('n-1', 'PENDING', 'COMPLETED');
      expect.unreachable('transition should have thrown');
    } catch (error) {
      expect((error as OrchestrationError).code).toBe('SBO028');
      expect((error as OrchestrationError).details).toMatchObject({ nodeId: 'n-1' });
    }
  });

  it('final node statuses are exactly COMPLETED, FAILED, SUPERSEDED', () => {
    expect([...FINAL_JOB_NODE_STATUSES].sort()).toEqual(['COMPLETED', 'FAILED', 'SUPERSEDED'].sort());
  });
});
