import { describe, expect, it } from 'vitest';
import { jobPolicySchema } from '@specbridge/core';
import {
  CLAUDE_WORKER_ID,
  LOCAL_WORKER_ID,
  resolveWorkers,
  selectWorker,
} from '@specbridge/orchestration';
import type { JobWorkerProfile ,
  OrchestrationError} from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * Role routing: local-first, escalate-on-evidence, and the executor is
 * structurally pinned to a repository-writing large agent. No provider-name
 * branching: everything below runs on worker profiles.
 */

const policy = jobPolicySchema.parse({});

function localWorker(): JobWorkerProfile {
  return {
    workerId: LOCAL_WORKER_ID,
    roles: ['CLASSIFIER', 'PLANNER', 'CRITIC', 'DIAGNOSER', 'REPLANNER'],
    reasoningTier: 'LOCAL_SMALL',
    costTier: 'LOCAL',
    repositoryRead: false,
    repositoryWrite: false,
    structuredOutput: true,
    localOnly: true,
    requiresNetwork: false,
    supportsCancellation: true,
    maxInputCharacters: 48_000,
  };
}

function largeWorker(): JobWorkerProfile {
  return {
    workerId: CLAUDE_WORKER_ID,
    roles: ['CLASSIFIER', 'PLANNER', 'CRITIC', 'DIAGNOSER', 'REPLANNER', 'EXECUTOR'],
    reasoningTier: 'LARGE_AGENT',
    costTier: 'PAID',
    repositoryRead: true,
    repositoryWrite: true,
    structuredOutput: true,
    localOnly: false,
    requiresNetwork: true,
    supportsCancellation: true,
    maxInputCharacters: 500_000,
  };
}

describe('resolveWorkers', () => {
  it('without local inference configured, only the large agent exists', () => {
    const fixture = setupOrchestrationFixture();
    const workers = resolveWorkers(fixture.config);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.reasoningTier).toBe('LARGE_AGENT');
    expect(workers[0]?.repositoryWrite).toBe(true);
  });

  it('with local inference enabled and coherent, the local worker joins the roster', () => {
    const fixture = setupOrchestrationFixture({
      extraConfig: {
        localInference: {
          enabled: true,
          // Any ABSOLUTE path passes the coherence check (existence is a
          // start-time concern); process.execPath is absolute on every OS,
          // where a hard-coded drive-letter path would fail on POSIX.
          executable: process.execPath,
          model: process.execPath,
        },
      },
    });
    const workers = resolveWorkers(fixture.config);
    expect(workers).toHaveLength(2);
    const local = workers.find((worker) => worker.reasoningTier === 'LOCAL_SMALL');
    expect(local).toBeDefined();
    // The local worker NEVER writes the repository and never holds EXECUTOR.
    expect(local?.repositoryWrite).toBe(false);
    expect(local?.roles).not.toContain('EXECUTOR');
    expect(local?.localOnly).toBe(true);
  });

  it('an enabled but incomplete local configuration produces no local worker', () => {
    const fixture = setupOrchestrationFixture({
      extraConfig: { localInference: { enabled: true } },
    });
    const workers = resolveWorkers(fixture.config);
    expect(workers.every((worker) => worker.reasoningTier === 'LARGE_AGENT')).toBe(true);
  });
});

describe('selectWorker', () => {
  const roster = [localWorker(), largeWorker()];

  it('routes LOW-complexity planning to the local worker with no escalation', () => {
    const selection = selectWorker({
      role: 'PLANNER',
      complexity: 'LOW',
      policy,
      workers: roster,
      nodeEscalations: [],
    });
    expect(selection.worker.workerId).toBe(LOCAL_WORKER_ID);
    expect(selection.escalation).toBeUndefined();
  });

  it('HIGH complexity bypasses local planning and records COMPLEXITY_HIGH', () => {
    const selection = selectWorker({
      role: 'PLANNER',
      complexity: 'HIGH',
      policy,
      workers: roster,
      nodeEscalations: [],
    });
    expect(selection.worker.workerId).toBe(CLAUDE_WORKER_ID);
    expect(selection.escalation?.reason).toBe('COMPLEXITY_HIGH');
  });

  it('a missing local worker escalates with LOCAL_WORKER_UNAVAILABLE', () => {
    const selection = selectWorker({
      role: 'DIAGNOSER',
      complexity: 'LOW',
      policy,
      workers: [largeWorker()],
      nodeEscalations: [],
    });
    expect(selection.worker.workerId).toBe(CLAUDE_WORKER_ID);
    expect(selection.escalation?.reason).toBe('LOCAL_WORKER_UNAVAILABLE');
  });

  it('sticky escalation: an INVALID_LOCAL_OUTPUT node never retries the local tier', () => {
    const selection = selectWorker({
      role: 'PLANNER',
      complexity: 'LOW',
      policy,
      workers: roster,
      nodeEscalations: ['INVALID_LOCAL_OUTPUT'],
    });
    expect(selection.worker.workerId).toBe(CLAUDE_WORKER_ID);
    expect(selection.escalation?.reason).toBe('INVALID_LOCAL_OUTPUT');
  });

  it('the EXECUTOR always resolves to a repository-writing worker', () => {
    const selection = selectWorker({
      role: 'EXECUTOR',
      complexity: 'LOW',
      policy,
      workers: roster,
      nodeEscalations: [],
    });
    expect(selection.worker.repositoryWrite).toBe(true);
    expect(selection.worker.reasoningTier).toBe('LARGE_AGENT');
  });

  it('no repository-writing worker at all fails closed with SBO034', () => {
    try {
      selectWorker({
        role: 'EXECUTOR',
        complexity: 'LOW',
        policy,
        workers: [localWorker()],
        nodeEscalations: [],
      });
      expect.unreachable('selection should have thrown');
    } catch (error) {
      expect((error as OrchestrationError).code).toBe('SBO034');
    }
  });

  it('a large-agent route records ROLE_POLICY instead of selecting silently', () => {
    const routed = jobPolicySchema.parse({ routing: { planner: 'large-agent' } });
    const selection = selectWorker({
      role: 'PLANNER',
      complexity: 'LOW',
      policy: routed,
      workers: roster,
      nodeEscalations: [],
    });
    expect(selection.worker.workerId).toBe(CLAUDE_WORKER_ID);
    expect(selection.escalation?.reason).toBe('ROLE_POLICY');
  });

  it('a disabled role is refused rather than silently rerouted', () => {
    const disabled = jobPolicySchema.parse({ routing: { critic: 'disabled' } });
    expect(() =>
      selectWorker({
        role: 'CRITIC',
        complexity: 'LOW',
        policy: disabled,
        workers: roster,
        nodeEscalations: [],
      }),
    ).toThrowError(/disabled/);
  });

  it('the executor route accepts only large-agent (local execution is not configurable)', () => {
    expect(() => jobPolicySchema.parse({ routing: { executor: 'local-first' } })).toThrow();
    expect(() => jobPolicySchema.parse({ routing: { executor: 'local' } })).toThrow();
  });
});
