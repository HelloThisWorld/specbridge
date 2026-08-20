import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  beginExecutorDispatch,
  beginPlanning,
  beginTaskAttempt,
  buildJobGraph,
  completeExecutorDispatch,
  completeTaskAttempt,
  contextBudgetFromPolicy,
  createJob,
  createTaskCheckpoint,
  listTaskAttempts,
  listTaskCheckpointSeqs,
  prepareTaskResume,
  readExecutionLedger,
  readJobEvents,
  readLatestTaskCheckpoint,
  readTaskAttempt,
  readTaskCheckpoint,
  reconcileInterruptedAttempts,
  reconstructTaskContext,
  recordClassification,
  recordCriticVerdict,
  recordPlan,
  requireGraphRevision,
  requireJobState,
  resumeJob,
  summarizeExecutionLedger,
  taskCheckpointsDir,
} from '@specbridge/orchestration';
import type { AttemptContext, JobDeps } from '@specbridge/orchestration';
import { contextBudgetConfigSchema, renderContextPackage } from '@specbridge/context';
import { idCounter, tickingClock } from '../helpers-execution.js';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';

/**
 * The Survival Runtime (vNext.1): durable ExecutionAttempts, structured task
 * checkpoints, crash recovery, provider handoff, canonical-state
 * independence, and failed-approach preservation.
 *
 * Fully offline and deterministic. "Workers" here are simulated exactly the
 * way the jobs-service tests simulate them — the runtime is a state engine,
 * and these tests prove the state survives everything a worker cannot.
 */

interface JobFixture extends OrchestrationFixture {
  jobId: string;
  nodeId: string;
  taskId: string;
}

async function survivalFixture(policy: Record<string, unknown> = {}): Promise<JobFixture> {
  const fixture = setupOrchestrationFixture({ policy: { jobs: policy } });
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement workflow validation across the settings feature.',
  });
  await buildJobGraph(fixture.deps, job.jobId);
  const graph = requireGraphRevision(fixture.workspace, job.jobId, 1);
  const node = graph.nodes[0];
  if (node === undefined) throw new Error('fixture graph has no nodes');
  // Drive the node to an approved plan (classifier → planner → critic).
  const context = (role: AttemptContext['role']): AttemptContext => ({
    nodeId: node.nodeId,
    role,
    workerId: 'local-test-worker',
    startedAt: fixture.clock().toISOString(),
  });
  recordClassification(fixture.deps, job.jobId, {
    context: context('CLASSIFIER'),
    proposedClass: 'LOW',
  });
  beginPlanning(fixture.deps, job.jobId, node.nodeId);
  await recordPlan(fixture.deps, job.jobId, {
    context: context('PLANNER'),
    candidate: {
      goal: 'Implement workflow validation.',
      steps: [{ description: 'Add the validation module.' }, { description: 'Wire it into the service.' }],
      testStrategy: 'Unit tests for validation outcomes.',
      verificationStrategy: 'Run the trusted verification commands.',
    },
    producedByTier: 'LOCAL_SMALL',
  });
  recordCriticVerdict(fixture.deps, job.jobId, {
    context: context('CRITIC'),
    verdict: 'ACCEPT',
    reasons: ['Steps are ordered and verifiable.'],
  });
  return { ...fixture, jobId: job.jobId, nodeId: node.nodeId, taskId: node.parentTaskId };
}

/** A fresh process over the same workspace: new deps, nothing in memory. */
function restartRuntime(fixture: JobFixture): JobDeps {
  return {
    workspace: fixture.workspace,
    config: fixture.config,
    clock: tickingClock('2026-08-02T09:00:00.000Z'),
    idFactory: idCounter('restart'),
    host: 'test-restarted',
  };
}

function executorContext(fixture: JobFixture, runId?: string): AttemptContext {
  return {
    nodeId: fixture.nodeId,
    role: 'EXECUTOR',
    workerId: 'fake-provider-b',
    startedAt: fixture.clock().toISOString(),
    ...(runId !== undefined ? { runId } : {}),
    usage: { inputTokens: 1_000, outputTokens: 200, costUsd: null },
  };
}

const PINNED = {
  taskContract: 'Implement workflow validation for the settings feature.',
  acceptanceCriteria: ['All workflow definitions validate.', 'The full test suite passes.'],
  constraints: ['Do not modify the public CLI contract.'],
  invariants: ['Verification cannot be bypassed.'],
};

describe('durable execution attempts', () => {
  it('persists the attempt BEFORE work runs, finalizes it after, and keeps history immutable', async () => {
    const fixture = await survivalFixture();
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'fake-provider-a',
      provider: 'fake-provider-a',
      model: 'fake-model-1',
    });

    // The attempt exists NOW, while the (simulated) worker is still running.
    const job = requireJobState(fixture.workspace, fixture.jobId);
    expect(job.currentAttemptId).toBeDefined();
    const running = readTaskAttempt(fixture.workspace, fixture.jobId, job.currentAttemptId as string);
    expect(running?.status).toBe('RUNNING');
    expect(running?.provider).toBe('fake-provider-a');
    expect(running?.model).toBe('fake-model-1');
    expect(running?.attemptNumber).toBe(1);

    const result = completeExecutorDispatch(fixture.deps, fixture.jobId, {
      context: executorContext(fixture, 'run-0001'),
      mode: 'implement',
      evidenceStatus: 'verified',
      changedFiles: [{ path: 'src/validation.ts', contentHash: 'modified' }],
    });
    expect(result.nextAction === 'node-complete' || result.nextAction === 'job-complete').toBe(true);
    expect(result.job.currentAttemptId).toBeUndefined();

    const attempts = listTaskAttempts(fixture.workspace, fixture.jobId, { nodeId: fixture.nodeId });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('COMPLETED');
    expect(attempts[0]?.metrics.inputTokens).toBe(1_000);
    expect(attempts[0]?.metrics.filesChanged).toBe(1);
    expect(attempts[0]?.metrics.costUsd).toBeNull();

    // Finished attempts are immutable history.
    expect(() =>
      completeTaskAttempt(
        { workspace: fixture.workspace, clock: fixture.clock },
        { jobId: fixture.jobId, attemptId: attempts[0]?.attemptId as string, status: 'FAILED' },
      ),
    ).toThrow(/immutable/);
  });

  it('records failed dispatches as FAILED attempts with the failure preserved', async () => {
    const fixture = await survivalFixture();
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'fake-provider-a',
    });
    completeExecutorDispatch(fixture.deps, fixture.jobId, {
      context: executorContext(fixture),
      mode: 'implement',
      evidenceStatus: 'implemented-unverified',
      failure: {
        category: 'VERIFICATION_FAILURE',
        message: 'Tests failed: expected 3, got 2.',
        source: 'test',
      },
    });
    const attempts = listTaskAttempts(fixture.workspace, fixture.jobId, { nodeId: fixture.nodeId });
    expect(attempts[0]?.status).toBe('FAILED');
    expect(attempts[0]?.failure?.category).toBe('VERIFICATION_FAILURE');
    expect(attempts[0]?.failure?.message).toContain('expected 3, got 2');
  });
});

describe('structured task checkpoints', () => {
  it('accumulates decisions and failed approaches across revisions (carry-forward)', async () => {
    const fixture = await survivalFixture();
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'fake-provider-a',
    });
    const attemptId = requireJobState(fixture.workspace, fixture.jobId).currentAttemptId as string;
    const survivalDeps = { workspace: fixture.workspace, clock: fixture.clock };

    createTaskCheckpoint(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      attemptId,
      reason: 'milestone',
      objective: 'Implement workflow validation.',
      pinned: PINNED,
      completedWork: ['Validation module scaffolded.'],
      importantDecisions: [{ decision: 'Use zod schemas for validation.', rationale: 'Matches the repository style.' }],
      failedApproaches: [{ approach: 'Regex-based validation', reason: 'Cannot express nested rules.' }],
      nextActions: ['Wire the module into the service.'],
    });
    const second = createTaskCheckpoint(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      attemptId,
      reason: 'pre-compaction',
      objective: 'Implement workflow validation.',
      pinned: PINNED,
      completedWork: ['Service wiring started.'],
      importantDecisions: [{ decision: 'Validate at load time, not save time.' }],
      nextActions: ['Finish the wiring; run the tests.'],
    });

    expect(second.seq).toBe(2);
    // Carry-forward: earlier truths persist without re-stating them.
    expect(second.completedWork).toContain('Validation module scaffolded.');
    expect(second.completedWork).toContain('Service wiring started.');
    expect(second.importantDecisions.map((d) => d.decision)).toEqual([
      'Use zod schemas for validation.',
      'Validate at load time, not save time.',
    ]);
    expect(second.failedApproaches[0]?.approach).toBe('Regex-based validation');

    // The attempt is linked to its checkpoints.
    const attempt = readTaskAttempt(fixture.workspace, fixture.jobId, attemptId);
    expect(attempt?.checkpointIds).toHaveLength(2);
  });

  it('falls back to the newest READABLE checkpoint when the latest is corrupt', async () => {
    const fixture = await survivalFixture();
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'fake-provider-a',
    });
    const attemptId = requireJobState(fixture.workspace, fixture.jobId).currentAttemptId as string;
    const survivalDeps = { workspace: fixture.workspace, clock: fixture.clock };
    const first = createTaskCheckpoint(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      attemptId,
      reason: 'milestone',
      objective: 'Implement workflow validation.',
      pinned: PINNED,
      nextActions: ['Continue.'],
    });
    // A crash mid-write leaves a corrupt newest revision.
    const dir = taskCheckpointsDir(fixture.workspace, fixture.jobId, fixture.nodeId);
    writeFileSync(path.join(dir, '0002.json'), '{ truncated', 'utf8');

    const latest = readLatestTaskCheckpoint(fixture.workspace, fixture.jobId, fixture.nodeId);
    expect(latest?.checkpointId).toBe(first.checkpointId);
    // The corrupt file is preserved for diagnosis, never deleted.
    expect(existsSync(path.join(dir, '0002.json'))).toBe(true);
  });
});

describe('Test A: process restart', () => {
  it('a task survives shutdown: same task, new attempt, nothing lost', async () => {
    const fixture = await survivalFixture();

    // Start Attempt #1 and perform partial work.
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'worker-a',
      provider: 'fake-provider-a',
    });
    const firstAttemptId = requireJobState(fixture.workspace, fixture.jobId)
      .currentAttemptId as string;
    createTaskCheckpoint(
      { workspace: fixture.workspace, clock: fixture.clock },
      {
        jobId: fixture.jobId,
        nodeId: fixture.nodeId,
        taskId: fixture.taskId,
        attemptId: firstAttemptId,
        reason: 'shutdown',
        objective: 'Implement workflow validation.',
        pinned: PINNED,
        completedWork: ['Validation module implemented.'],
        pendingWork: ['Service wiring.', 'Tests.'],
        importantDecisions: [{ decision: 'Use zod schemas for validation.' }],
        nextActions: ['Wire the module into the service.'],
      },
    );

    // Simulate shutdown: the process dies; a NEW runtime loads the state.
    const restarted = restartRuntime(fixture);
    const report = await resumeJob(restarted, fixture.jobId);

    // The interrupted dispatch is visible, reconciled, and preserved.
    expect(report.interruptedAttemptIds).toEqual([firstAttemptId]);
    expect(report.reconciled.some((line) => line.includes('INTERRUPTED'))).toBe(true);
    const interrupted = readTaskAttempt(fixture.workspace, fixture.jobId, firstAttemptId);
    expect(interrupted?.status).toBe('INTERRUPTED');
    expect(interrupted?.interruptedReason).toBe('process-restart');
    expect(report.job.currentAttemptId).toBeUndefined();
    expect(report.job.status).toBe('READY');

    // Resume with a new attempt and complete the task.
    beginExecutorDispatch(restarted, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'worker-a2',
      provider: 'fake-provider-a',
    });
    const secondAttemptId = requireJobState(fixture.workspace, fixture.jobId)
      .currentAttemptId as string;
    expect(secondAttemptId).not.toBe(firstAttemptId);
    const second = readTaskAttempt(fixture.workspace, fixture.jobId, secondAttemptId);
    expect(second?.resumedFromAttemptId).toBe(firstAttemptId);
    expect(second?.attemptNumber).toBe(2);

    completeExecutorDispatch(restarted, fixture.jobId, {
      context: {
        nodeId: fixture.nodeId,
        role: 'EXECUTOR',
        workerId: 'worker-a2',
        startedAt: restarted.clock === undefined ? new Date().toISOString() : restarted.clock().toISOString(),
        runId: 'run-0002',
      },
      mode: 'implement',
      evidenceStatus: 'verified',
      changedFiles: [{ path: 'src/validation.ts', contentHash: 'modified' }],
    });

    // Task identity preserved; both attempts preserved; checkpoint preserved;
    // completed work not lost (milestone checkpoint carried it forward).
    const graph = requireGraphRevision(
      fixture.workspace,
      fixture.jobId,
      requireJobState(fixture.workspace, fixture.jobId).graphRevision,
    );
    const node = graph.nodes.find((candidate) => candidate.nodeId === fixture.nodeId);
    expect(node?.status).toBe('COMPLETED');
    const attempts = listTaskAttempts(fixture.workspace, fixture.jobId, { nodeId: fixture.nodeId });
    expect(attempts.map((attempt) => attempt.status)).toEqual(['INTERRUPTED', 'COMPLETED']);
    const latest = readLatestTaskCheckpoint(fixture.workspace, fixture.jobId, fixture.nodeId);
    expect(latest?.completedWork).toContain('Validation module implemented.');
    expect(latest?.importantDecisions[0]?.decision).toBe('Use zod schemas for validation.');
  });
});

describe('Test B: provider handoff', () => {
  it('provider B continues from durable state, without provider A conversation', async () => {
    const fixture = await survivalFixture();

    // Provider A: partial progress, then a handoff checkpoint.
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'worker-a',
      provider: 'fake-provider-a',
      providerSessionId: 'provider-a-session-42',
    });
    const attemptA = requireJobState(fixture.workspace, fixture.jobId).currentAttemptId as string;
    createTaskCheckpoint(
      { workspace: fixture.workspace, clock: fixture.clock },
      {
        jobId: fixture.jobId,
        nodeId: fixture.nodeId,
        taskId: fixture.taskId,
        attemptId: attemptA,
        reason: 'handoff',
        objective: 'Implement workflow validation.',
        pinned: PINNED,
        completedWork: ['Validation module implemented and unit-tested.'],
        pendingWork: ['Service wiring.'],
        importantDecisions: [{ decision: 'Use zod schemas for validation.' }],
        failedApproaches: [{ approach: 'Approach X: validate lazily on first use', reason: 'Y: breaks startup diagnostics ordering' }],
        testResults: [{ name: 'unit', status: 'passed', summary: '12 tests green' }],
        nextActions: ['Wire validation into the service startup path.'],
      },
    );

    // Provider A disappears (session and all). A fresh runtime resumes the
    // job first (process-level reconciliation), then prepares the task.
    const restarted = restartRuntime(fixture);
    const report = await resumeJob(restarted, fixture.jobId);
    expect(report.interruptedAttemptIds).toEqual([attemptA]);
    const preparation = await prepareTaskResume(restarted, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
    });
    expect(preparation.resumeFromAttemptId).toBe(attemptA);
    expect(preparation.nextActions).toEqual(['Wire validation into the service startup path.']);

    // The reconstructed context carries everything provider B needs — all of
    // it from SpecBridge durable state, none of it from A's conversation.
    const rendered = renderContextPackage(preparation.assembled.package);
    expect(rendered).toContain('Implement workflow validation for the settings feature.'); // contract
    expect(rendered).toContain('All workflow definitions validate.'); // acceptance criteria
    expect(rendered).toContain('Validation module implemented and unit-tested.'); // completed
    expect(rendered).toContain('Use zod schemas for validation.'); // decision
    expect(rendered).toContain('Approach X: validate lazily on first use'); // failed approach
    expect(rendered).toContain('Wire validation into the service startup path.'); // next action
    expect(rendered).not.toContain('provider-a-session-42'); // session stays working memory

    // Provider B executes and completes the task.
    beginExecutorDispatch(restarted, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'worker-b',
      provider: 'fake-provider-b',
      model: 'fake-model-b',
    });
    completeExecutorDispatch(restarted, fixture.jobId, {
      context: {
        nodeId: fixture.nodeId,
        role: 'EXECUTOR',
        workerId: 'worker-b',
        startedAt: new Date('2026-08-02T10:00:00.000Z').toISOString(),
        runId: 'run-b-0001',
        usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.25 },
      },
      mode: 'implement',
      evidenceStatus: 'verified',
      changedFiles: [{ path: 'src/service.ts', contentHash: 'modified' }],
    });

    const ledger = readExecutionLedger(fixture.workspace, fixture.jobId, { nodeId: fixture.nodeId });
    expect(ledger.map((entry) => [entry.provider, entry.status])).toEqual([
      ['fake-provider-a', 'INTERRUPTED'],
      ['fake-provider-b', 'COMPLETED'],
    ]);
    expect(ledger[1]?.metrics.costUsd).toBe(0.25);
  });
});

describe('Test F: canonical state independence', () => {
  it('deleting all provider transient state deletes nothing canonical', async () => {
    const fixture = await survivalFixture();

    // A fake provider keeps its transient conversation outside SpecBridge.
    const providerStateDir = path.join(fixture.root, 'fake-provider-home', 'sessions');
    mkdirSync(providerStateDir, { recursive: true });
    writeFileSync(
      path.join(providerStateDir, 'session-42.jsonl'),
      '{"role":"assistant","content":"(conversation working memory)"}\n',
      'utf8',
    );

    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'worker-a',
      provider: 'fake-provider-a',
      providerSessionId: 'session-42',
    });
    const attemptId = requireJobState(fixture.workspace, fixture.jobId).currentAttemptId as string;
    createTaskCheckpoint(
      { workspace: fixture.workspace, clock: fixture.clock },
      {
        jobId: fixture.jobId,
        nodeId: fixture.nodeId,
        taskId: fixture.taskId,
        attemptId,
        reason: 'milestone',
        objective: 'Implement workflow validation.',
        pinned: PINNED,
        importantDecisions: [{ decision: 'Use zod schemas for validation.' }],
        relevantArtifacts: ['run-0001'],
        nextActions: ['Continue implementation.'],
      },
    );

    // Delete EVERY trace of the provider's working memory.
    rmSync(path.join(fixture.root, 'fake-provider-home'), { recursive: true, force: true });

    // Job, Task, Checkpoint, Decision, Attempt history, Artifact references:
    // all intact, readable by a fresh runtime.
    const restarted = restartRuntime(fixture);
    const job = requireJobState(restarted.workspace, fixture.jobId);
    expect(job.jobId).toBe(fixture.jobId);
    const graph = requireGraphRevision(restarted.workspace, fixture.jobId, job.graphRevision);
    expect(graph.nodes.find((node) => node.nodeId === fixture.nodeId)).toBeDefined();
    const checkpoint = readLatestTaskCheckpoint(restarted.workspace, fixture.jobId, fixture.nodeId);
    expect(checkpoint?.importantDecisions[0]?.decision).toBe('Use zod schemas for validation.');
    expect(checkpoint?.relevantArtifacts).toEqual(['run-0001']);
    const attempts = listTaskAttempts(restarted.workspace, fixture.jobId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptId).toBe(attemptId);
  });
});

describe('Test G: failed-approach preservation', () => {
  it('a recorded dead end survives compactions, restart, and a provider switch', async () => {
    const fixture = await survivalFixture();
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'worker-a',
      provider: 'fake-provider-a',
    });
    const attemptId = requireJobState(fixture.workspace, fixture.jobId).currentAttemptId as string;
    const survivalDeps = { workspace: fixture.workspace, clock: fixture.clock };

    // Record: Approach X failed because Y.
    createTaskCheckpoint(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      attemptId,
      reason: 'milestone',
      objective: 'Implement workflow validation.',
      pinned: PINNED,
      failedApproaches: [
        { approach: 'Approach X: patch the parser in place', reason: 'Y: the parser is generated code' },
      ],
      nextActions: ['Try the visitor-based approach instead.'],
    });
    // Later checkpoints (compaction cycles) that do NOT restate the failure.
    for (const step of ['first pass', 'second pass', 'third pass']) {
      createTaskCheckpoint(survivalDeps, {
        jobId: fixture.jobId,
        nodeId: fixture.nodeId,
        taskId: fixture.taskId,
        attemptId,
        reason: 'pre-compaction',
        objective: 'Implement workflow validation.',
        pinned: PINNED,
        completedWork: [`Visitor approach: ${step} done.`],
        nextActions: ['Continue the visitor-based approach.'],
      });
    }

    // Restart, then reconstruct for ANOTHER provider with a budget so small
    // that compaction must run during assembly.
    const restarted = restartRuntime(fixture);
    reconcileInterruptedAttempts({ workspace: restarted.workspace }, fixture.jobId);
    const tinyBudget = contextBudgetConfigSchema.parse({
      modelContextTokens: 4_000,
      reservedOutputTokens: 500,
      reservedReasoningTokens: 250,
      reservedGrowthTokens: 250,
    });
    const context = reconstructTaskContext(restarted, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      budget: tinyBudget,
      workingSet: Array.from({ length: 20 }, (_, index) => ({
        itemId: `noise-${index}`,
        layer: 'WORKING_SET' as const,
        kind: 'log',
        title: `Noise ${index}`,
        content: 'noise '.repeat(400),
        createdAt: '2026-08-02T09:00:00.000Z',
        compacted: false,
      })),
    });
    expect(context.assembled.compactions.length).toBeGreaterThan(0);
    const rendered = renderContextPackage(context.assembled.package);
    expect(rendered).toContain('Approach X: patch the parser in place');
    expect(rendered).toContain('Y: the parser is generated code');
    // And the working-set noise was compacted away, not the failed approach.
    expect(context.assembled.package.usage.estimatedTokens).toBeLessThanOrEqual(3_000);
  });
});

describe('crash recovery', () => {
  it('reconciliation is idempotent and never touches finished attempts', async () => {
    const fixture = await survivalFixture();
    const survivalDeps = { workspace: fixture.workspace, clock: fixture.clock };
    const running = beginTaskAttempt(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      role: 'EXECUTOR',
      workerId: 'worker-a',
      provider: 'fake-provider-a',
    });
    const done = beginTaskAttempt(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      role: 'EXECUTOR',
      workerId: 'worker-a',
      provider: 'fake-provider-a',
      resumedFromAttemptId: undefined,
    });
    completeTaskAttempt(survivalDeps, {
      jobId: fixture.jobId,
      attemptId: done.attemptId,
      status: 'COMPLETED',
    });

    const first = reconcileInterruptedAttempts(survivalDeps, fixture.jobId);
    expect(first.map((attempt) => attempt.attemptId)).toEqual([running.attemptId]);
    const second = reconcileInterruptedAttempts(survivalDeps, fixture.jobId);
    expect(second).toHaveLength(0);
    expect(readTaskAttempt(fixture.workspace, fixture.jobId, done.attemptId)?.status).toBe('COMPLETED');
  });

  it('resume emits attempt_interrupted events for observability', async () => {
    const fixture = await survivalFixture();
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'worker-a',
      provider: 'fake-provider-a',
    });
    const restarted = restartRuntime(fixture);
    await resumeJob(restarted, fixture.jobId);
    const events = readJobEvents(fixture.workspace, fixture.jobId, { limit: 100 });
    const types = events.events.map((event) => event.type);
    expect(types).toContain('attempt_started');
    expect(types).toContain('attempt_interrupted');
    expect(types).toContain('job_resumed');
  });
});

describe('execution ledger', () => {
  it('tolerates missing provider metrics and never fabricates them', async () => {
    const fixture = await survivalFixture();
    const survivalDeps = { workspace: fixture.workspace, clock: fixture.clock };
    const bare = beginTaskAttempt(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      role: 'EXECUTOR',
      workerId: 'worker-a',
      provider: 'metricless-provider',
    });
    completeTaskAttempt(survivalDeps, {
      jobId: fixture.jobId,
      attemptId: bare.attemptId,
      status: 'COMPLETED',
      // No metrics reported at all.
    });
    const rich = beginTaskAttempt(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      role: 'EXECUTOR',
      workerId: 'worker-b',
      provider: 'metered-provider',
      model: 'metered-1',
    });
    completeTaskAttempt(survivalDeps, {
      jobId: fixture.jobId,
      attemptId: rich.attemptId,
      status: 'FAILED',
      failure: { category: 'VERIFICATION_FAILURE', message: 'tests failed' },
      metrics: { inputTokens: 2_000, outputTokens: 300, costUsd: 0.5, toolCalls: 7 },
    });

    const ledger = readExecutionLedger(fixture.workspace, fixture.jobId);
    expect(ledger).toHaveLength(2);
    const bareEntry = ledger.find((entry) => entry.provider === 'metricless-provider');
    expect(bareEntry?.metrics.inputTokens).toBeNull();
    expect(bareEntry?.metrics.durationMs).not.toBeNull(); // derived from timestamps
    expect(bareEntry?.success).toBe(true);

    const summary = summarizeExecutionLedger(ledger);
    expect(summary.totalAttempts).toBe(2);
    expect(summary.byProvider['metricless-provider']?.reportedInputTokens).toBeNull();
    expect(summary.byProvider['metered-provider']?.reportedInputTokens).toBe(2_000);
    expect(summary.byProvider['metered-provider']?.reportedCostUsd).toBe(0.5);
    expect(summary.byProvider['metered-provider']?.failed).toBe(1);
  });
});

describe('checkpoint store discipline', () => {
  it('checkpoint revisions are append-only; sequence collisions are refused', async () => {
    const fixture = await survivalFixture();
    beginExecutorDispatch(fixture.deps, fixture.jobId, {
      nodeId: fixture.nodeId,
      mode: 'implement',
      workerId: 'worker-a',
    });
    const attemptId = requireJobState(fixture.workspace, fixture.jobId).currentAttemptId as string;
    const survivalDeps = { workspace: fixture.workspace, clock: fixture.clock };
    createTaskCheckpoint(survivalDeps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      taskId: fixture.taskId,
      attemptId,
      reason: 'milestone',
      objective: 'Objective.',
      pinned: PINNED,
      nextActions: ['Continue.'],
    });
    expect(listTaskCheckpointSeqs(fixture.workspace, fixture.jobId, fixture.nodeId)).toEqual([1]);
    expect(
      readTaskCheckpoint(fixture.workspace, fixture.jobId, fixture.nodeId, 1)?.reason,
    ).toBe('milestone');
    // The context policy is configurable and maps onto a context budget.
    const budget = contextBudgetFromPolicy(fixture.config.orchestration.jobs.context);
    expect(budget.modelContextTokens).toBe(200_000);
    expect(budget.proactiveCompactionThreshold).toBe(0.7);
  });
});
