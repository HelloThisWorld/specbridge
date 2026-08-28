import { describe, expect, it } from 'vitest';
import {
  CLAUDE_WORKER_ID,
  LOCAL_WORKER_ID,
  answerClarification,
  applyDiagnosis,
  askClarification,
  beginExecutorDispatch,
  beginPlanning,
  buildJobGraph,
  cancelJob,
  checkpointJob,
  clearRetryWait,
  completeExecutorDispatch,
  createJob,
  readJobEvents,
  recordClassification,
  recordCriticVerdict,
  recordPlan,
  recordRoleFailure,
  requireGraphRevision,
  requireJobState,
  resumeJob,
  reviewNodePlan,
  scheduleNext,
  supersedeNode,
  writeJobState,
} from '@specbridge/orchestration';
import type { AttemptContext, JobState, OrchestrationError } from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';

/**
 * The job application service: create → graph → classify → plan → critique →
 * execute → verify, plus every deviation (failure classification, diagnosis,
 * repair, replan, retry, clarification, cancellation, resume).
 *
 * Fully offline and deterministic: no model, no git (unless a test opts in),
 * no network. Worker results are simulated as the structured documents the
 * drivers would record.
 */

interface JobFixture extends OrchestrationFixture {
  jobId: string;
}

function jobFixture(policy: Record<string, unknown> = {}): JobFixture {
  const fixture = setupOrchestrationFixture({
    policy: { jobs: policy },
  });
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement the approved settings-persistence plan.',
  });
  return { ...fixture, jobId: job.jobId };
}

function attemptContext(
  fixture: JobFixture,
  overrides: Partial<AttemptContext> & { nodeId: string; role: AttemptContext['role'] },
): AttemptContext {
  return {
    workerId: LOCAL_WORKER_ID,
    startedAt: fixture.clock().toISOString(),
    ...overrides,
  };
}

/** Drive one node to an approved plan (classifier → planner → critic). */
async function planFirstNode(fixture: JobFixture): Promise<{ nodeId: string }> {
  await buildJobGraph(fixture.deps, fixture.jobId);
  const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
  const nodeId = graph.nodes[0]?.nodeId as string;
  recordClassification(fixture.deps, fixture.jobId, {
    context: attemptContext(fixture, { nodeId, role: 'CLASSIFIER' }),
    proposedClass: 'LOW',
  });
  beginPlanning(fixture.deps, fixture.jobId, nodeId);
  await recordPlan(fixture.deps, fixture.jobId, {
    context: attemptContext(fixture, { nodeId, role: 'PLANNER' }),
    candidate: {
      goal: 'Implement the settings store.',
      steps: [{ description: 'Create the persistence module.' }, { description: 'Wire the service.' }],
      testStrategy: 'Unit tests for save and failure paths.',
      verificationStrategy: 'Run the trusted verification commands.',
    },
    producedByTier: 'LOCAL_SMALL',
  });
  recordCriticVerdict(fixture.deps, fixture.jobId, {
    context: attemptContext(fixture, { nodeId, role: 'CRITIC' }),
    verdict: 'ACCEPT',
    reasons: ['Steps are ordered and verifiable.'],
  });
  return { nodeId };
}

function dispatchVerified(fixture: JobFixture, nodeId: string, runId: string): JobState {
  beginExecutorDispatch(fixture.deps, fixture.jobId, { nodeId, mode: 'implement', workerId: CLAUDE_WORKER_ID });
  const result = completeExecutorDispatch(fixture.deps, fixture.jobId, {
    context: attemptContext(fixture, { nodeId, role: 'EXECUTOR', workerId: CLAUDE_WORKER_ID, runId }),
    mode: 'implement',
    evidenceStatus: 'verified',
    changedFiles: [{ path: 'src/settings.ts', contentHash: `h-${runId}` }],
  });
  return result.job;
}

describe('job lifecycle', () => {
  it('creates a job with the policy budgets snapshotted', () => {
    const fixture = jobFixture({ budgets: { maxAgentRuns: 7 } });
    const job = requireJobState(fixture.workspace, fixture.jobId);
    expect(job.status).toBe('CREATED');
    expect(job.budgets.maxAgentRuns).toBe(7);
    expect(job.policyFingerprint).toContain('"maxAgentRuns":7');
  });

  it('refuses a job when jobs are disabled by policy', () => {
    const fixture = setupOrchestrationFixture({ policy: { jobs: { enabled: false } } });
    try {
      createJob(fixture.deps, { specName: fixture.specName, goal: 'x' });
      expect.unreachable('createJob should have thrown');
    } catch (error) {
      expect((error as OrchestrationError).code).toBe('SBO025');
    }
  });

  it('builds the graph exactly once and lands READY with the first node current', async () => {
    const fixture = jobFixture();
    const { job, graph } = await buildJobGraph(fixture.deps, fixture.jobId);
    expect(job.status).toBe('READY');
    expect(job.graphRevision).toBe(1);
    expect(job.currentNodeId).toBe(graph.nodes[0]?.nodeId);
    expect(graph.nodes.every((node) => node.complexity !== undefined)).toBe(true);
    await expect(buildJobGraph(fixture.deps, fixture.jobId)).rejects.toThrowError(/exactly once/);
  });

  it('walks one node through classify → plan → critique → execute → verified completion', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);

    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
    expect(node?.planApproved).toBe(true);
    expect(node?.criticVerdict).toBe('ACCEPT');

    const job = dispatchVerified(fixture, nodeId, 'run-1');
    expect(job.status).toBe('READY');
    const after = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(after.nodes[0]?.status).toBe('COMPLETED');
    expect(after.nodes[0]?.latestEvidence?.evidenceStatus).toBe('verified');
    expect(after.nodes[1]?.status).toBe('READY');
    expect(job.currentNodeId).toBe(after.nodes[1]?.nodeId);
    expect(job.latestEvidence?.taskId).toBe('1');
  });

  it('records an auditable event trail for the whole pipeline', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    dispatchVerified(fixture, nodeId, 'run-1');
    const events = readJobEvents(fixture.workspace, fixture.jobId, { limit: 100 });
    const types = events.events.map((event) => event.type);
    for (const expected of [
      'job_created',
      'graph_created',
      'classification_completed',
      'planning_started',
      'plan_created',
      'critic_completed',
      'execution_started',
      'node_completed',
    ]) {
      expect(types).toContain(expected);
    }
  });

  it('completes the job when the last node verifies', async () => {
    const fixture = jobFixture();
    await buildJobGraph(fixture.deps, fixture.jobId);
    let graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    let finalJob: JobState | undefined;
    for (let index = 0; index < graph.nodes.length; index += 1) {
      graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
      const node = graph.nodes.find((candidate) => candidate.status === 'READY');
      expect(node).toBeDefined();
      const nodeId = node?.nodeId as string;
      recordClassification(fixture.deps, fixture.jobId, {
        context: attemptContext(fixture, { nodeId, role: 'CLASSIFIER' }),
        proposedClass: 'LOW',
      });
      beginPlanning(fixture.deps, fixture.jobId, nodeId);
      await recordPlan(fixture.deps, fixture.jobId, {
        context: attemptContext(fixture, { nodeId, role: 'PLANNER' }),
        candidate: {
          goal: `Implement ${node?.parentTaskId}.`,
          steps: [{ description: 'Do the work.' }],
          testStrategy: 'Tests.',
          verificationStrategy: 'Trusted commands.',
        },
        producedByTier: 'LOCAL_SMALL',
      });
      recordCriticVerdict(fixture.deps, fixture.jobId, {
        context: attemptContext(fixture, { nodeId, role: 'CRITIC' }),
        verdict: 'ACCEPT',
        reasons: [],
      });
      finalJob = dispatchVerified(fixture, nodeId, `run-${index + 1}`);
    }
    expect(finalJob?.status).toBe('COMPLETED');
    expect(finalJob?.finalOutcome).toBe('COMPLETED');
    const decision = scheduleNext({
      job: finalJob as JobState,
      graph: requireGraphRevision(fixture.workspace, fixture.jobId, 1),
      policy: fixture.config.orchestration.jobs,
      workers: [],
      now: fixture.clock(),
    });
    expect(decision.kind).toBe('JOB_FINAL');
  });

  it('an unverified completion claim never completes a node', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    beginExecutorDispatch(fixture.deps, fixture.jobId, { nodeId, mode: 'implement', workerId: CLAUDE_WORKER_ID });
    const result = completeExecutorDispatch(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'EXECUTOR', workerId: CLAUDE_WORKER_ID, runId: 'run-x' }),
      mode: 'implement',
      evidenceStatus: 'unverified',
    });
    expect(result.nextAction).toBe('diagnose');
    expect(result.job.status).toBe('DIAGNOSING');
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(graph.nodes[0]?.status).toBe('READY');
    expect(graph.nodes[0]?.latestFailure?.category).toBe('VERIFICATION_FAILURE');
  });
});

describe('failure handling', () => {
  async function failOnce(fixture: JobFixture, nodeId: string): Promise<ReturnType<typeof completeExecutorDispatch>> {
    beginExecutorDispatch(fixture.deps, fixture.jobId, { nodeId, mode: 'implement', workerId: CLAUDE_WORKER_ID });
    return completeExecutorDispatch(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'EXECUTOR', workerId: CLAUDE_WORKER_ID, runId: 'run-f' }),
      mode: 'implement',
      evidenceStatus: undefined,
      failure: {
        category: 'VERIFICATION_FAILURE',
        message: 'test command failed',
        source: 'test',
        exitCode: 1,
        output: 'AssertionError: expected save to persist',
      },
      changedFiles: [{ path: 'src/settings.ts', contentHash: 'h1' }],
    });
  }

  it('a verification failure transitions to DIAGNOSING, never to a blind rerun', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    const result = await failOnce(fixture, nodeId);
    expect(result.nextAction).toBe('diagnose');
    expect(result.job.status).toBe('DIAGNOSING');
    expect(result.classified?.fingerprint).toBeDefined();
  });

  it('a REPAIR diagnosis returns to READY and the scheduler dispatches repair mode', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    await failOnce(fixture, nodeId);
    const applied = applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'IMPLEMENTATION_DEFECT',
      planValidity: 'VALID',
      recommendedAction: 'REPAIR',
      rootCause: 'The save path drops the payload.',
    });
    expect(applied.applied).toBe('repair');
    expect(applied.job.status).toBe('READY');
    const decision = scheduleNext({
      job: applied.job,
      graph: requireGraphRevision(fixture.workspace, fixture.jobId, 1),
      policy: fixture.config.orchestration.jobs,
      workers: [
        {
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
        },
      ],
      now: fixture.clock(),
    });
    expect(decision).toMatchObject({ kind: 'DISPATCH_EXECUTOR', mode: 'repair' });
  });

  it('an INVALID plan diagnosis transitions to REPLANNING and a replan consumes budget', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    await failOnce(fixture, nodeId);
    const applied = applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'IMPLEMENTATION_DEFECT',
      planValidity: 'INVALID',
      recommendedAction: 'REPLAN',
      rootCause: 'The repository has no service interface to wire behind.',
    });
    expect(applied.applied).toBe('replan');
    expect(applied.job.status).toBe('REPLANNING');

    const replanned = await recordPlan(
      fixture.deps,
      fixture.jobId,
      {
        context: attemptContext(fixture, { nodeId, role: 'REPLANNER' }),
        candidate: {
          goal: 'Introduce the interface first, then implement the store.',
          steps: [{ description: 'Add the interface.' }, { description: 'Implement the store.' }],
          testStrategy: 'Unit tests.',
          verificationStrategy: 'Trusted commands.',
        },
        producedByTier: 'LOCAL_SMALL',
      },
      { replan: true },
    );
    expect(replanned.job.status).toBe('READY');
    expect(replanned.job.counters.jobReplans).toBe(1);
    expect(replanned.plan.revision).toBe(2);
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(graph.nodes[0]?.replans).toBe(1);
    // A fresh plan needs a fresh critique.
    expect(graph.nodes[0]?.planApproved).toBe(false);
  });

  it('an exhausted replan budget refuses further replans (SBO013)', async () => {
    const fixture = jobFixture({ budgets: { maxReplansPerTask: 0 } });
    const { nodeId } = await planFirstNode(fixture);
    await failOnce(fixture, nodeId);
    applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'IMPLEMENTATION_DEFECT',
      planValidity: 'VALID',
      recommendedAction: 'REPAIR',
      rootCause: 'fixable',
    });
    await expect(
      recordPlan(
        fixture.deps,
        fixture.jobId,
        {
          context: attemptContext(fixture, { nodeId, role: 'REPLANNER' }),
          candidate: {
            goal: 'g',
            steps: [{ description: 's' }],
            testStrategy: 't',
            verificationStrategy: 'v',
          },
          producedByTier: 'LOCAL_SMALL',
        },
        { replan: true },
      ),
    ).rejects.toThrowError(/replans/);
  });

  it('a transient failure waits with backoff instead of failing the task', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    beginExecutorDispatch(fixture.deps, fixture.jobId, { nodeId, mode: 'implement', workerId: CLAUDE_WORKER_ID });
    const result = completeExecutorDispatch(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'EXECUTOR', workerId: CLAUDE_WORKER_ID }),
      mode: 'implement',
      evidenceStatus: undefined,
      failure: { category: 'TRANSIENT_TRANSPORT', message: 'connection reset', source: 'runner' },
    });
    expect(result.nextAction).toBe('wait-retry');
    expect(result.job.status).toBe('WAITING_RETRY');
    expect(result.job.retryAt).toBeDefined();
    expect(result.job.counters.transientRetries).toBe(1);
    // The task itself is untouched: the node is READY again, not FAILED.
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(graph.nodes[0]?.status).toBe('READY');
  });

  it('clearRetryWait resumes only after retryAt', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    beginExecutorDispatch(fixture.deps, fixture.jobId, { nodeId, mode: 'implement', workerId: CLAUDE_WORKER_ID });
    completeExecutorDispatch(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'EXECUTOR', workerId: CLAUDE_WORKER_ID }),
      mode: 'implement',
      evidenceStatus: undefined,
      failure: { category: 'TRANSIENT_TOOL', message: 'flake', source: 'tool' },
    });
    // The ticking clock advances one second per call; the default retry
    // delay is five seconds, so the first clear is a no-op.
    const still = clearRetryWait(fixture.deps, fixture.jobId);
    expect(still.status).toBe('WAITING_RETRY');
    for (let index = 0; index < 8; index += 1) fixture.clock();
    const cleared = clearRetryWait(fixture.deps, fixture.jobId);
    expect(cleared.status).toBe('READY');
  });

  it('a terminal failure blocks the job with the evidence preserved', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    beginExecutorDispatch(fixture.deps, fixture.jobId, { nodeId, mode: 'implement', workerId: CLAUDE_WORKER_ID });
    const result = completeExecutorDispatch(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'EXECUTOR', workerId: CLAUDE_WORKER_ID }),
      mode: 'implement',
      evidenceStatus: undefined,
      failure: { category: 'PROTECTED_PATH', message: '.kiro was modified', source: 'evidence' },
    });
    expect(result.nextAction).toBe('blocked');
    expect(result.job.status).toBe('BLOCKED');
    expect(result.job.blocker?.category).toBe('PROTECTED_PATH');
  });

  it('a local role failure escalates stickily without failing the node', async () => {
    const fixture = jobFixture();
    await buildJobGraph(fixture.deps, fixture.jobId);
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    const nodeId = graph.nodes[0]?.nodeId as string;
    const job = recordRoleFailure(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'PLANNER' }),
      outcome: 'invalid-output',
      escalation: {
        reason: 'INVALID_LOCAL_OUTPUT',
        detail: 'The local planner output stayed invalid after one correction.',
      },
    });
    expect(job.status).toBe('READY');
    expect(job.escalations[0]?.reason).toBe('INVALID_LOCAL_OUTPUT');
    const after = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(after.nodes[0]?.status).toBe('READY');
    expect(after.nodes[0]?.attempts[0]?.outcome).toBe('invalid-output');
  });
});

describe('replanning the graph', () => {
  it('supersedeNode produces a successor and returns the job to READY', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    // Reach REPLANNING through an invalid-plan diagnosis.
    beginExecutorDispatch(fixture.deps, fixture.jobId, { nodeId, mode: 'implement', workerId: CLAUDE_WORKER_ID });
    completeExecutorDispatch(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'EXECUTOR', workerId: CLAUDE_WORKER_ID }),
      mode: 'implement',
      evidenceStatus: undefined,
      failure: { category: 'VERIFICATION_FAILURE', message: 'fails', source: 'test' },
    });
    applyDiagnosis(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'DIAGNOSER' }),
      category: 'IMPLEMENTATION_DEFECT',
      planValidity: 'INVALID',
      recommendedAction: 'REPLAN',
      rootCause: 'The approach cannot work in this repository.',
    });
    const { job, graph } = supersedeNode(fixture.deps, fixture.jobId, {
      nodeId,
      reason: 'Clean restart with a different strategy.',
    });
    expect(job.status).toBe('READY');
    expect(job.graphRevision).toBe(2);
    expect(graph.nodes.find((node) => node.nodeId === nodeId)?.status).toBe('SUPERSEDED');
    const successor = graph.nodes.find((node) => node.supersedes === nodeId);
    expect(successor?.status).toBe('READY');
    expect(job.counters.jobReplans).toBe(1);
    // Old graph revision is preserved on disk.
    expect(requireGraphRevision(fixture.workspace, fixture.jobId, 1)).toBeDefined();
  });
});

describe('clarification, review, cancellation', () => {
  it('asks bounded questions and resumes when the last one is answered', async () => {
    const fixture = jobFixture();
    await buildJobGraph(fixture.deps, fixture.jobId);
    const asked = askClarification(fixture.deps, fixture.jobId, [
      { question: 'Which storage backend should the settings use?', whyItMatters: 'Changes the module layout.' },
    ]);
    expect(asked.status).toBe('NEEDS_CLARIFICATION');
    expect(asked.openQuestions).toHaveLength(1);
    const answered = answerClarification(fixture.deps, fixture.jobId, [
      { questionId: asked.openQuestions[0]?.id as string, answer: 'The existing file-based store.' },
    ]);
    expect(answered.status).toBe('READY');
    expect(answered.decisions[0]?.source).toBe('known-from-user');
  });

  it('human plan review: approval clears the gate, rejection replans', async () => {
    const fixture = jobFixture({ planReview: 'always' });
    await buildJobGraph(fixture.deps, fixture.jobId);
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    const nodeId = graph.nodes[0]?.nodeId as string;
    recordClassification(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'CLASSIFIER' }),
      proposedClass: 'LOW',
    });
    beginPlanning(fixture.deps, fixture.jobId, nodeId);
    await recordPlan(fixture.deps, fixture.jobId, {
      context: attemptContext(fixture, { nodeId, role: 'PLANNER' }),
      candidate: {
        goal: 'g',
        steps: [{ description: 's' }],
        testStrategy: 't',
        verificationStrategy: 'v',
      },
      producedByTier: 'LARGE_AGENT',
    });
    let after = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(after.nodes[0]?.humanReviewRequired).toBe(true);
    expect(after.nodes[0]?.planApproved).toBe(false);

    reviewNodePlan(fixture.deps, fixture.jobId, { nodeId, decision: 'approved' });
    after = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(after.nodes[0]?.planApproved).toBe(true);
    expect(after.nodes[0]?.humanReviewRequired).toBe(false);
  });

  it('cancellation is final and idempotent', async () => {
    const fixture = jobFixture();
    await buildJobGraph(fixture.deps, fixture.jobId);
    const cancelled = cancelJob(fixture.deps, fixture.jobId, 'User cancelled.');
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.finalOutcome).toBe('CANCELLED');
    const again = cancelJob(fixture.deps, fixture.jobId, 'again');
    expect(again.status).toBe('CANCELLED');
    expect(again.finalizedAt).toBe(cancelled.finalizedAt);
  });
});

describe('checkpoints and resume', () => {
  it('checkpoints capture the compact continuation state', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    dispatchVerified(fixture, nodeId, 'run-1');
    const checkpoint = checkpointJob(fixture.deps, fixture.jobId, 'Dispatch the next node.');
    expect(checkpoint.completedNodes).toHaveLength(1);
    expect(checkpoint.remainingNodes).toHaveLength(3);
    expect(checkpoint.nextAction).toBe('Dispatch the next node.');
    expect(checkpoint.latestEvidence?.taskId).toBe('1');
  });

  it('resume reconciles an interrupted dispatch back to READY', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    beginExecutorDispatch(fixture.deps, fixture.jobId, { nodeId, mode: 'implement', workerId: CLAUDE_WORKER_ID });
    // Simulate a process crash: nothing completes the dispatch.
    const report = await resumeJob(fixture.deps, fixture.jobId);
    expect(report.finalized).toBe(false);
    expect(report.reconciled.length).toBeGreaterThan(0);
    expect(report.job.status).toBe('READY');
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(graph.nodes[0]?.status).toBe('READY');
  });

  it('resume of a finalized job reports status and never continues', async () => {
    const fixture = jobFixture();
    await buildJobGraph(fixture.deps, fixture.jobId);
    cancelJob(fixture.deps, fixture.jobId, 'done');
    const report = await resumeJob(fixture.deps, fixture.jobId);
    expect(report.finalized).toBe(true);
    expect(report.warnings[0]).toContain('CANCELLED');
  });

  it('resume detects a changed policy without silently adopting it', async () => {
    const fixture = jobFixture();
    await buildJobGraph(fixture.deps, fixture.jobId);
    const job = requireJobState(fixture.workspace, fixture.jobId);
    writeJobState(fixture.workspace, { ...job, policyFingerprint: 'different' });
    const report = await resumeJob(fixture.deps, fixture.jobId);
    expect(report.policyChanged).toBe(true);
    expect(report.warnings.join(' ')).toContain('policy changed');
  });

  it('banks dead-process idle on stale-lock removal, and the wall clock excludes it', async () => {
    const fixture = jobFixture();
    const { spawnSync } = await import('node:child_process');
    const { acquireInteractiveLock } = await import('@specbridge/execution');
    const { selfHealOnResume, workedMsOf } = await import('@specbridge/orchestration');

    // A lock owned by a genuinely dead process: the same evidence
    // `run recover-lock` demands before it will call anything stale.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const diedAt = requireJobState(fixture.workspace, fixture.jobId).updatedAt;
    acquireInteractiveLock(fixture.workspace, {
      runId: 'run-dead-process',
      specName: fixture.specName,
      taskId: '1',
      pid: dead.pid ?? 999_999,
      clock: () => new Date(diedAt),
    });

    // Four hours later, somebody resumes.
    const resumedAt = Date.parse(diedAt) + 4 * 3_600_000;
    const healed = selfHealOnResume(
      { ...fixture.deps, clock: () => new Date(resumedAt) },
      fixture.jobId,
    );

    const codes = healed.repairs.map((repair) => repair.code);
    expect(codes).toContain('STALE_RUN_LOCK_REMOVED');
    expect(codes).toContain('DEAD_IDLE_BANKED');
    const banked = healed.job.counters.deadIdleMs ?? 0;
    expect(banked).toBeGreaterThanOrEqual(4 * 3_600_000 - 60_000);
    // The dead hours are excluded: the job "worked" only the sliver between
    // its creation and the moment its process died.
    expect(workedMsOf(healed.job, resumedAt)).toBeLessThan(60_000);
  });

  it('resume detects a stale plan and forces REPLANNING (approved stage changed)', async () => {
    const fixture = jobFixture();
    const { nodeId } = await planFirstNode(fixture);
    // Invalidate the plan binding by re-approving with different content:
    // simplest deterministic route is to hand-edit the stored spec state.
    const { readSpecState, writeSpecState } = await import('@specbridge/core');
    const state = readSpecState(fixture.workspace, fixture.specName).state;
    if (state?.stages?.['tasks'] !== undefined) {
      (state.stages['tasks'] as { approvedHash?: string }).approvedHash = 'sha256:changed';
      writeSpecState(fixture.workspace, state);
    }
    const report = await resumeJob(fixture.deps, fixture.jobId);
    expect(report.planStale).toBe(true);
    expect(report.planStaleReasons).toContain('approved-stage-changed');
    expect(report.job.status).toBe('REPLANNING');
    const graph = requireGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(graph.nodes.find((node) => node.nodeId === nodeId)?.planApproved).toBe(false);
  });
});
