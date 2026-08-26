import { describe, expect, it } from 'vitest';
import { jobPolicySchema } from '@specbridge/core';
import {
  CLAUDE_WORKER_ID,
  LOCAL_WORKER_ID,
  OrchestrationError,
  buildInitialGraph,
  promoteReadyNodes,
  reviseGraphSuperseding,
  scheduleNext,
  workedMsOf,
  transitionNode,
  withNode,
} from '@specbridge/orchestration';
import type {
  JobGraph,
  JobNode,
  JobState,
  JobWorkerProfile,
  ScheduleInput,
} from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * The runtime graph is built deterministically from the approved task plan,
 * and the scheduler is a pure function over (job, graph, policy, workers,
 * now): every decision below is exactly reproducible.
 */

const policy = jobPolicySchema.parse({});
const NOW = new Date('2026-08-01T10:00:00.000Z');

function workers(includeLocal = true): JobWorkerProfile[] {
  const roster: JobWorkerProfile[] = [];
  if (includeLocal) {
    roster.push({
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
    });
  }
  roster.push({
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
  });
  return roster;
}

function buildFixtureGraph(): { graph: JobGraph } {
  const fixture = setupOrchestrationFixture();
  const built = buildInitialGraph(fixture.workspace, {
    jobId: 'job-test-000001',
    specName: fixture.specName,
    createdAt: '2026-08-01T09:00:00.000Z',
  });
  return { graph: built.graph };
}

function testJob(overrides: Partial<JobState> = {}): JobState {
  const budgets = jobPolicySchema.parse({}).budgets;
  return {
    schemaVersion: '1.0.0',
    jobId: 'job-test-000001',
    specName: 'settings-persistence',
    status: 'READY',
    goal: 'Implement the approved plan.',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    host: 'test',
    policyFingerprint: 'test',
    budgets: {
      maxAgentRuns: budgets.maxAgentRuns,
      maxTaskAttempts: budgets.maxTaskAttempts,
      maxRepairCyclesPerTask: budgets.maxRepairCyclesPerTask,
      maxReplansPerTask: budgets.maxReplansPerTask,
      maxJobReplans: budgets.maxJobReplans,
      maxNoProgressCycles: budgets.maxNoProgressCycles,
      maxTransientRetries: budgets.maxTransientRetries,
      maxWallClockMs: budgets.maxWallClockMs,
      maxLocalInferenceCalls: budgets.maxLocalInferenceCalls,
      maxEvents: budgets.maxEvents,
      maxCostUsd: null,
      maxTokens: null,
    },
    counters: {
      agentRuns: 0,
      humanWaitMs: 0,
      localInferenceCalls: 0,
      jobReplans: 0,
      transientRetries: 0,
      clarificationRounds: 0,
      escalations: 0,
      events: 0,
      reportedCostUsd: null,
      reportedTokens: null,
    },
    graphRevision: 1,
    openQuestions: [],
    decisions: [],
    escalations: [],
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleInput> = {}): ReturnType<typeof scheduleNext> {
  const { graph } = buildFixtureGraph();
  return scheduleNext({
    job: testJob(),
    graph,
    policy,
    workers: workers(),
    now: NOW,
    ...overrides,
  });
}

describe('buildInitialGraph', () => {
  it('creates one node per open required leaf task, in document order', () => {
    const { graph } = buildFixtureGraph();
    expect(graph.nodes.map((node) => node.parentTaskId)).toEqual(['1', '2.1', '2.2', '3']);
    // The optional task 4 is not scheduled; parent task 2 is a grouping.
    expect(graph.nodes.some((node) => node.parentTaskId === '4')).toBe(false);
    expect(graph.nodes.some((node) => node.parentTaskId === '2')).toBe(false);
  });

  it('chains sequential dependencies and marks only the first node READY', () => {
    const { graph } = buildFixtureGraph();
    expect(graph.nodes[0]?.status).toBe('READY');
    expect(graph.nodes[0]?.dependsOn).toEqual([]);
    expect(graph.nodes[1]?.status).toBe('PENDING');
    expect(graph.nodes[1]?.dependsOn).toEqual([graph.nodes[0]?.nodeId]);
    expect(graph.nodes[3]?.dependsOn).toEqual([graph.nodes[2]?.nodeId]);
  });

  it('binds the graph to approved stage hashes and the task-plan hash', () => {
    const { graph } = buildFixtureGraph();
    expect(Object.keys(graph.baseline.approvedStageHashes).sort()).toEqual(
      ['design', 'requirements', 'tasks'].sort(),
    );
    expect(graph.baseline.taskPlanHash).toBeDefined();
  });

  it('records task fingerprints so approved-task drift is detectable', () => {
    const { graph } = buildFixtureGraph();
    for (const node of graph.nodes) expect(node.taskFingerprint.length).toBeGreaterThan(8);
  });
});

describe('graph operations', () => {
  it('promoteReadyNodes promotes a node whose dependency completed', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    graph = transitionNode(graph, first.nodeId, 'RUNNING');
    graph = transitionNode(graph, first.nodeId, 'COMPLETED');
    graph = promoteReadyNodes(graph);
    expect(graph.nodes[1]?.status).toBe('READY');
    expect(graph.nodes[2]?.status).toBe('PENDING');
  });

  it('supersession creates a successor for the SAME task and preserves lineage', () => {
    const { graph } = buildFixtureGraph();
    const target = graph.nodes[0] as JobNode;
    const revised = reviseGraphSuperseding(graph, {
      supersedeNodeId: target.nodeId,
      replanReason: 'The planned abstraction does not exist in the repository.',
      createdAt: '2026-08-01T11:00:00.000Z',
    });
    expect(revised.revision).toBe(graph.revision + 1);
    expect(revised.supersedes).toBe(graph.revision);
    const old = revised.nodes.find((node) => node.nodeId === target.nodeId);
    expect(old?.status).toBe('SUPERSEDED');
    const successor = revised.nodes.find((node) => node.supersedes === target.nodeId);
    expect(successor).toBeDefined();
    expect(successor?.parentTaskId).toBe(target.parentTaskId);
    expect(successor?.replans).toBe(target.replans + 1);
    expect(old?.supersededBy).toBe(successor?.nodeId);
  });

  it('a completed node is never superseded', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    graph = transitionNode(graph, first.nodeId, 'RUNNING');
    graph = transitionNode(graph, first.nodeId, 'COMPLETED');
    expect(() =>
      reviseGraphSuperseding(graph, {
        supersedeNodeId: first.nodeId,
        replanReason: 'no',
        createdAt: '2026-08-01T11:00:00.000Z',
      }),
    ).toThrowError(/COMPLETED/);
  });

  it('dependents of a superseded node become READY through the lineage chain', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    const revised = reviseGraphSuperseding(graph, {
      supersedeNodeId: first.nodeId,
      replanReason: 'restart',
      createdAt: '2026-08-01T11:00:00.000Z',
    });
    const successor = revised.nodes.find((node) => node.supersedes === first.nodeId) as JobNode;
    graph = transitionNode(revised, successor.nodeId, 'RUNNING');
    graph = transitionNode(graph, successor.nodeId, 'COMPLETED');
    graph = promoteReadyNodes(graph);
    const second = graph.nodes.find((node) => node.parentTaskId === '2.1');
    expect(second?.status).toBe('READY');
  });
});

describe('scheduleNext', () => {
  it('a CREATED job builds the graph first', () => {
    const decision = schedule({ job: testJob({ status: 'CREATED', graphRevision: 0 }), graph: undefined });
    expect(decision.kind).toBe('BUILD_GRAPH');
  });

  it('an unclassified node runs the classifier on the local tier', () => {
    const decision = schedule();
    expect(decision).toMatchObject({ kind: 'RUN_ROLE', role: 'CLASSIFIER' });
    if (decision.kind === 'RUN_ROLE') {
      expect(decision.worker.workerId).toBe(LOCAL_WORKER_ID);
    }
  });

  it('a classified node without a plan runs the planner', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    graph = withNode(graph, {
      ...first,
      complexity: 'LOW',
      attempts: [
        {
          attempt: 1,
          role: 'CLASSIFIER',
          workerId: LOCAL_WORKER_ID,
          startedAt: '2026-08-01T09:30:00.000Z',
          finishedAt: '2026-08-01T09:30:01.000Z',
          outcome: 'succeeded',
        },
      ],
    });
    const decision = schedule({ graph });
    expect(decision).toMatchObject({ kind: 'RUN_ROLE', role: 'PLANNER', nodeId: first.nodeId });
    if (decision.kind === 'RUN_ROLE') expect(decision.worker.workerId).toBe(LOCAL_WORKER_ID);
  });

  it('HIGH complexity routes planning straight to the large agent', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    graph = withNode(graph, {
      ...first,
      complexity: 'HIGH',
      attempts: [
        {
          attempt: 1,
          role: 'CLASSIFIER',
          workerId: LOCAL_WORKER_ID,
          startedAt: '2026-08-01T09:30:00.000Z',
          outcome: 'succeeded',
        },
      ],
    });
    const decision = schedule({ graph });
    expect(decision).toMatchObject({ kind: 'RUN_ROLE', role: 'PLANNER' });
    if (decision.kind === 'RUN_ROLE') {
      expect(decision.worker.workerId).toBe(CLAUDE_WORKER_ID);
      expect(decision.escalation?.reason).toBe('COMPLEXITY_HIGH');
    }
  });

  it('a local plan that has not been critiqued runs the critic', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    graph = withNode(graph, {
      ...first,
      complexity: 'LOW',
      planRevision: 1,
      planApproved: false,
      planProducedBy: LOCAL_WORKER_ID,
      planProducedByTier: 'LOCAL_SMALL',
      attempts: [
        { attempt: 1, role: 'CLASSIFIER', workerId: LOCAL_WORKER_ID, startedAt: 't', outcome: 'succeeded' },
      ],
    });
    const decision = schedule({ graph });
    expect(decision).toMatchObject({ kind: 'RUN_ROLE', role: 'CRITIC' });
  });

  it('an approved plan dispatches the executor to the repository-writing worker', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    graph = withNode(graph, {
      ...first,
      complexity: 'LOW',
      planRevision: 1,
      planApproved: true,
      attempts: [
        { attempt: 1, role: 'CLASSIFIER', workerId: LOCAL_WORKER_ID, startedAt: 't', outcome: 'succeeded' },
      ],
    });
    const decision = schedule({ graph });
    expect(decision).toMatchObject({
      kind: 'DISPATCH_EXECUTOR',
      taskId: '1',
      mode: 'implement',
    });
    if (decision.kind === 'DISPATCH_EXECUTOR') {
      expect(decision.worker.repositoryWrite).toBe(true);
    }
  });

  it('a plan awaiting human review yields AWAIT_HUMAN, not a dispatch', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    graph = withNode(graph, {
      ...first,
      complexity: 'HIGH',
      planRevision: 1,
      planApproved: false,
      humanReviewRequired: true,
      planProducedByTier: 'LARGE_AGENT',
      attempts: [
        { attempt: 1, role: 'CLASSIFIER', workerId: LOCAL_WORKER_ID, startedAt: 't', outcome: 'succeeded' },
      ],
    });
    const decision = schedule({ graph });
    expect(decision).toMatchObject({ kind: 'AWAIT_HUMAN', what: 'plan-review' });
  });

  it('a diagnosis recommending repair dispatches in repair mode', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    graph = withNode(graph, {
      ...first,
      complexity: 'LOW',
      planRevision: 1,
      planApproved: true,
      latestDiagnosis: {
        category: 'IMPLEMENTATION_DEFECT',
        planValidity: 'VALID',
        recommendedAction: 'REPAIR',
        at: 't',
      },
      attempts: [
        { attempt: 1, role: 'CLASSIFIER', workerId: LOCAL_WORKER_ID, startedAt: 't', outcome: 'succeeded' },
      ],
    });
    const decision = schedule({ graph });
    expect(decision).toMatchObject({ kind: 'DISPATCH_EXECUTOR', mode: 'repair' });
  });

  it('all nodes complete yields JOB_COMPLETE', () => {
    let { graph } = buildFixtureGraph();
    for (const node of graph.nodes) {
      graph = transitionNode(graph, node.nodeId, node.status === 'READY' ? 'RUNNING' : 'READY');
      if (node.status === 'PENDING') graph = transitionNode(graph, node.nodeId, 'RUNNING');
      graph = transitionNode(graph, node.nodeId, 'COMPLETED');
    }
    const decision = schedule({ graph });
    expect(decision.kind).toBe('JOB_COMPLETE');
  });

  it('the wall-clock budget stops scheduling before any dispatch', () => {
    const decision = schedule({
      now: new Date(Date.parse('2026-08-01T09:00:00.000Z') + policy.budgets.maxWallClockMs + 1),
    });
    expect(decision).toMatchObject({ kind: 'JOB_BLOCKED', budget: 'maxWallClockMs' });
  });

  it('the agent-run budget stops scheduling', () => {
    const job = testJob();
    job.counters.agentRuns = job.budgets.maxAgentRuns;
    const decision = schedule({ job });
    expect(decision).toMatchObject({ kind: 'JOB_BLOCKED', budget: 'maxAgentRuns' });
  });

  it('a reported cost over the configured budget stops scheduling', () => {
    const job = testJob();
    job.budgets.maxCostUsd = 5;
    job.counters.reportedCostUsd = 5.5;
    const decision = schedule({ job });
    expect(decision).toMatchObject({ kind: 'JOB_BLOCKED', budget: 'maxCostUsd' });
  });

  it('an exhausted task-attempt budget blocks with evidence preserved', () => {
    let { graph } = buildFixtureGraph();
    const first = graph.nodes[0] as JobNode;
    const attempts = Array.from({ length: policy.budgets.maxTaskAttempts }, (_, index) => ({
      attempt: index + 1,
      role: 'EXECUTOR' as const,
      workerId: CLAUDE_WORKER_ID,
      startedAt: 't',
      outcome: 'failed' as const,
    }));
    graph = withNode(graph, { ...first, complexity: 'LOW', planRevision: 1, planApproved: true, attempts });
    const decision = schedule({ graph });
    expect(decision).toMatchObject({ kind: 'JOB_BLOCKED', budget: 'maxTaskAttempts' });
  });

  it('WAITING_RETRY before retryAt waits; after retryAt it schedules again', () => {
    const waiting = testJob({ status: 'WAITING_RETRY', retryAt: '2026-08-01T10:30:00.000Z' });
    const early = schedule({ job: waiting, now: new Date('2026-08-01T10:00:00.000Z') });
    expect(early).toMatchObject({ kind: 'WAIT_RETRY', retryAt: '2026-08-01T10:30:00.000Z' });
    const late = schedule({ job: waiting, now: new Date('2026-08-01T10:31:00.000Z') });
    expect(late.kind).not.toBe('WAIT_RETRY');
  });

  it('a final job yields JOB_FINAL and nothing else', () => {
    const decision = schedule({ job: testJob({ status: 'COMPLETED' }) });
    expect(decision.kind).toBe('JOB_FINAL');
  });

  it('an in-flight status without reconciliation fails closed', () => {
    expect(() => schedule({ job: testJob({ status: 'RUNNING' }) })).toThrowError(OrchestrationError);
  });

  it('NEEDS_CLARIFICATION yields AWAIT_HUMAN clarification', () => {
    const decision = schedule({ job: testJob({ status: 'NEEDS_CLARIFICATION' }) });
    expect(decision).toMatchObject({ kind: 'AWAIT_HUMAN', what: 'clarification' });
  });
});

describe('the wall-clock budget pays for work, not for waiting', () => {
  const CREATED = new Date(Date.parse(NOW.toISOString()) - 20 * 3_600_000).toISOString();

  it('does not charge a job for the hours it spent parked on a person', () => {
    // The vNext.10.1 dogfood asked one product question, was answered
    // sixteen hours later, and woke to find its eight-hour budget spent
    // without having run anything. For a long-horizon project that means
    // every genuine authority question costs a night.
    const job = testJob({ createdAt: CREATED });
    const decision = schedule({
      job: {
        ...job,
        budgets: { ...job.budgets, maxWallClockMs: 8 * 3_600_000 },
        counters: { ...job.counters, humanWaitMs: 16 * 3_600_000 },
      },
    });
    expect(decision.kind).not.toBe('JOB_BLOCKED');
  });

  it('still stops a job that genuinely worked past its budget', () => {
    const job = testJob({ createdAt: CREATED });
    const decision = schedule({
      job: {
        ...job,
        budgets: { ...job.budgets, maxWallClockMs: 8 * 3_600_000 },
        counters: { ...job.counters, humanWaitMs: 0 },
      },
    });
    expect(decision.kind).toBe('JOB_BLOCKED');
  });
});


describe('workedMsOf — the one definition of how long a job has worked', () => {
  // The scheduler had the human-wait subtraction and the recovery path did
  // not, so the same job passed one wall-clock check and was refused by the
  // other: 7.5 hours parked on two product decisions turned 4 hours of real
  // work into a BUDGET_EXHAUSTED verdict. One function now feeds both.
  const CREATED = Date.parse('2026-08-25T12:00:00.000Z');

  it('subtracts banked waits and a live one', () => {
    const job = {
      ...testJob({ createdAt: new Date(CREATED).toISOString() }),
      counters: { ...testJob().counters, humanWaitMs: 2 * 3_600_000 },
      humanWaitSince: new Date(CREATED + 9 * 3_600_000).toISOString(),
    };
    // 10h elapsed, 2h banked, 1h still waiting -> 7h worked.
    expect(workedMsOf(job, CREATED + 10 * 3_600_000)).toBe(7 * 3_600_000);
  });

  it('is plain wall clock for a job that never waited', () => {
    const job = testJob({ createdAt: new Date(CREATED).toISOString() });
    expect(workedMsOf(job, CREATED + 3 * 3_600_000)).toBe(3 * 3_600_000);
  });
});
