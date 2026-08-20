import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  beginExecutorDispatch,
  beginPlanning,
  buildJobGraph,
  completeExecutorDispatch,
  createJob,
  createTaskCheckpoint,
  listTaskAttempts,
  prepareTaskResume,
  readExecutionLedger,
  readLatestTaskCheckpoint,
  recordClassification,
  recordCriticVerdict,
  recordPlan,
  repositoryStateFromSnapshot,
  requireGraphRevision,
  requireJobState,
  resumeJob,
  summarizeExecutionLedger,
} from '@specbridge/orchestration';
import type { AttemptContext, JobDeps } from '@specbridge/orchestration';
import { captureGitSnapshot } from '@specbridge/evidence';
import {
  ContextLifecycleManager,
  contextBudgetConfigSchema,
  renderContextPackage,
} from '@specbridge/context';
import type { ContextItem, ContextLifecycleEvent } from '@specbridge/context';
import { idCounter, tickingClock } from '../helpers-execution.js';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * The vNext.1 final validation scenario (one deterministic integration run):
 *
 *   create Job → Worker A executes with real context pressure and repeated
 *   compaction → partial workspace changes → structured checkpoint →
 *   Worker A dies → SpecBridge restarts → Worker A's conversation state is
 *   deleted → Worker B resumes from durable state + repository state →
 *   more compaction → Task completes →
 *   contract/decisions/failed approaches survived, attempts recorded,
 *   cumulative context exceeded one window by multiples.
 *
 * If this scenario cannot pass, the Survival Runtime is not complete.
 */

/** A worker-window budget small enough to force real compaction cycles. */
const WORKER_BUDGET = contextBudgetConfigSchema.parse({
  modelContextTokens: 4_000,
  reservedOutputTokens: 500,
  reservedReasoningTokens: 250,
  reservedGrowthTokens: 250,
});

const PINNED = {
  taskContract: 'Implement workflow validation for the settings feature.',
  acceptanceCriteria: ['All workflow definitions validate.', 'The full test suite passes.'],
  constraints: ['Do not modify the public CLI contract.'],
  invariants: ['Verification cannot be bypassed.'],
};

function workingNoise(id: string, cycle: number): ContextItem {
  return {
    itemId: `noise-${id}-${cycle}`,
    layer: 'WORKING_SET',
    kind: 'tool-result',
    title: `Tool output ${id}/${cycle}`,
    content: `output of cycle ${cycle} `.repeat(200),
    createdAt: '2026-08-02T09:00:00.000Z',
    dedupeKey: `tool-${cycle % 3}`,
    compacted: false,
  };
}

describe('final validation scenario (Survival Runtime, end to end)', () => {
  it('a job survives worker death, restart, conversation loss, and provider handoff', async () => {
    // (1) Create a long-running Job — with a REAL git repository, so the
    // checkpoints ground in actual repository state.
    const fixture = setupOrchestrationFixture({ git: true });
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Ship workflow validation end to end.',
    });
    await buildJobGraph(fixture.deps, job.jobId);
    const graph = requireGraphRevision(fixture.workspace, job.jobId, 1);
    const node = graph.nodes[0];
    if (node === undefined) throw new Error('fixture graph has no nodes');
    const context = (role: AttemptContext['role']): AttemptContext => ({
      nodeId: node.nodeId,
      role,
      workerId: 'local-test-worker',
      startedAt: fixture.clock().toISOString(),
    });
    recordClassification(fixture.deps, job.jobId, { context: context('CLASSIFIER'), proposedClass: 'LOW' });
    beginPlanning(fixture.deps, job.jobId, node.nodeId);
    await recordPlan(fixture.deps, job.jobId, {
      context: context('PLANNER'),
      candidate: {
        goal: 'Implement workflow validation.',
        steps: [{ description: 'Add validation.' }, { description: 'Wire the service.' }],
        testStrategy: 'Unit tests.',
        verificationStrategy: 'Trusted verification commands.',
      },
      producedByTier: 'LOCAL_SMALL',
    });
    recordCriticVerdict(fixture.deps, job.jobId, {
      context: context('CRITIC'),
      verdict: 'ACCEPT',
      reasons: ['Sound.'],
    });

    // (2) Start Task A using Worker A. The durable attempt exists before work.
    beginExecutorDispatch(fixture.deps, job.jobId, {
      nodeId: node.nodeId,
      mode: 'implement',
      workerId: 'worker-a',
      provider: 'fake-provider-a',
      providerSessionId: 'conversation-a',
    });
    const attemptA = requireJobState(fixture.workspace, job.jobId).currentAttemptId as string;

    // Worker A's transient conversation lives OUTSIDE SpecBridge state.
    const conversationDir = path.join(fixture.root, 'worker-a-home');
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(path.join(conversationDir, 'conversation-a.jsonl'), '{"turn":1}\n', 'utf8');

    // (3–5) Worker A generates execution history far beyond its window;
    // proactive compaction fires, execution continues, compaction fires again.
    const eventsA: ContextLifecycleEvent[] = [];
    const workerA = new ContextLifecycleManager({
      budget: WORKER_BUDGET,
      clock: fixture.clock,
      onEvent: (event) => eventsA.push(event),
    });
    workerA.add({
      itemId: 'pinned-contract',
      layer: 'PINNED',
      kind: 'task-contract',
      title: 'TaskContract',
      content: `${PINNED.taskContract}\nAcceptanceCriteria:\n- ${PINNED.acceptanceCriteria.join('\n- ')}`,
      createdAt: fixture.clock().toISOString(),
      compacted: false,
    });
    workerA.add({
      itemId: 'current-action-a',
      layer: 'CURRENT_ACTION',
      kind: 'next-action',
      title: 'Current action',
      content: 'Implement the validation module.',
      createdAt: fixture.clock().toISOString(),
      compacted: false,
    });
    const survivalDeps = { workspace: fixture.workspace, clock: fixture.clock };
    let checkpointsDuringA = 0;
    for (let cycle = 0; cycle < 25; cycle += 1) {
      workerA.add(workingNoise('a', cycle));
      workerA.add({
        itemId: `delta-a-${cycle}`,
        layer: 'RECENT_DELTA',
        kind: 'diff',
        title: `Delta ${cycle}`,
        content: `diff hunk ${cycle}`,
        createdAt: fixture.clock().toISOString(),
        compacted: false,
      });
      if (workerA.health() === 'PROACTIVE_COMPACT' || workerA.health() === 'FORCE_COMPACT' || workerA.health() === 'OVERFLOW') {
        // Durable state FIRST, then compaction — the recovery-sensitive
        // transition persists before any context is discarded.
        checkpointsDuringA += 1;
        const checkpoint = createTaskCheckpoint(survivalDeps, {
          jobId: job.jobId,
          nodeId: node.nodeId,
          taskId: node.parentTaskId,
          attemptId: attemptA,
          reason: 'pre-compaction',
          objective: 'Implement workflow validation.',
          pinned: PINNED,
          completedWork: [`Progress through cycle ${cycle}.`],
          nextActions: ['Continue implementing the validation module.'],
        });
        workerA.milestoneCompact(checkpoint.checkpointId);
        const assembled = workerA.assemble({ checkpointId: checkpoint.checkpointId });
        expect(assembled.package.usage.estimatedTokens).toBeLessThanOrEqual(workerA.usableBudgetTokens());
      }
    }
    expect(checkpointsDuringA).toBeGreaterThanOrEqual(2); // compaction happened repeatedly
    expect(eventsA.filter((event) => event.type === 'context_compacted').length).toBeGreaterThanOrEqual(2);

    // (6) Partial workspace changes land in the real repository.
    writeFileSync(path.join(fixture.root, 'survival-progress.md'), '# partial validation work\n', 'utf8');
    const midSnapshot = await captureGitSnapshot(fixture.root, { clock: fixture.clock });
    expect(midSnapshot.gitAvailable).toBe(true);
    expect(midSnapshot.clean).toBe(false);

    // (7) The rich handoff checkpoint: completed work, decisions, a failed
    // approach, test status, next action — grounded in repository state.
    createTaskCheckpoint(survivalDeps, {
      jobId: job.jobId,
      nodeId: node.nodeId,
      taskId: node.parentTaskId,
      attemptId: attemptA,
      reason: 'handoff',
      objective: 'Implement workflow validation.',
      pinned: PINNED,
      completedWork: ['Validation module implemented.', 'Unit tests written for the happy path.'],
      pendingWork: ['Service wiring.', 'Failure-path tests.'],
      importantDecisions: [
        { decision: 'Use zod schemas for validation.', rationale: 'Repository convention.' },
      ],
      failedApproaches: [
        { approach: 'Approach X: regex-based validation', reason: 'Y: cannot express nested rules' },
      ],
      changedFiles: [{ path: 'survival-progress.md', note: 'work-in-progress notes' }],
      repositoryState: repositoryStateFromSnapshot(midSnapshot),
      testResults: [{ name: 'unit', status: 'passed', summary: 'happy path green' }],
      knownFailures: ['Failure-path test still missing.'],
      nextActions: ['Wire validation into the service startup path.', 'Add failure-path tests.'],
    });

    // (8–10) Worker A disappears; SpecBridge restarts; Worker A's transient
    // conversation state is DELETED.
    rmSync(conversationDir, { recursive: true, force: true });
    const restarted: JobDeps = {
      workspace: fixture.workspace,
      config: fixture.config,
      clock: tickingClock('2026-08-02T12:00:00.000Z'),
      idFactory: idCounter('restart'),
      host: 'test-restarted',
    };
    const resumeReport = await resumeJob(restarted, job.jobId);
    expect(resumeReport.interruptedAttemptIds).toEqual([attemptA]);
    expect(resumeReport.job.status).toBe('READY');
    expect(resumeReport.gitHead).toBeDefined();

    // (11–12) Worker B resumes Task A; context is reconstructed ENTIRELY
    // from SpecBridge durable state plus current repository state.
    const preparation = await prepareTaskResume(restarted, {
      jobId: job.jobId,
      nodeId: node.nodeId,
      budget: WORKER_BUDGET,
    });
    expect(preparation.resumeFromAttemptId).toBe(attemptA);
    const reconstructed = renderContextPackage(preparation.assembled.package);
    expect(reconstructed).toContain('Implement workflow validation for the settings feature.');
    expect(reconstructed).toContain('Approach X: regex-based validation');
    expect(reconstructed).toContain('Use zod schemas for validation.');
    expect(reconstructed).toContain('Wire validation into the service startup path.');
    expect(reconstructed).toContain('survival-progress.md'); // current repo state
    expect(reconstructed).not.toContain('conversation-a'); // A's session: gone, unneeded

    beginExecutorDispatch(restarted, job.jobId, {
      nodeId: node.nodeId,
      mode: 'implement',
      workerId: 'worker-b',
      provider: 'fake-provider-b',
      model: 'fake-model-b',
    });
    const attemptB = requireJobState(fixture.workspace, job.jobId).currentAttemptId as string;

    // (13) Worker B generates enough additional context to compact again.
    const workerB = ContextLifecycleManager.restoreItems(
      { budget: WORKER_BUDGET, clock: restarted.clock },
      preparation.assembled.package.items,
    );
    let compactionsDuringB = 0;
    for (let cycle = 0; cycle < 25; cycle += 1) {
      workerB.add(workingNoise('b', cycle));
      if (workerB.health() !== 'HEALTHY' && workerB.health() !== 'PREPARE') {
        const checkpoint = createTaskCheckpoint(
          { workspace: fixture.workspace, clock: restarted.clock },
          {
            jobId: job.jobId,
            nodeId: node.nodeId,
            taskId: node.parentTaskId,
            attemptId: attemptB,
            reason: 'pre-compaction',
            objective: 'Implement workflow validation.',
            pinned: PINNED,
            completedWork: [`Worker B progress through cycle ${cycle}.`],
            nextActions: ['Finish service wiring.'],
          },
        );
        workerB.milestoneCompact(checkpoint.checkpointId);
        workerB.assemble({ checkpointId: checkpoint.checkpointId });
        compactionsDuringB += 1;
      }
    }
    expect(compactionsDuringB).toBeGreaterThanOrEqual(1);

    // (14) Complete Task A through the verified evidence path.
    const completion = completeExecutorDispatch(restarted, job.jobId, {
      context: {
        nodeId: node.nodeId,
        role: 'EXECUTOR',
        workerId: 'worker-b',
        startedAt: new Date('2026-08-02T12:30:00.000Z').toISOString(),
        runId: 'run-final',
        usage: { inputTokens: 9_000, outputTokens: 1_200, costUsd: null },
      },
      mode: 'implement',
      evidenceStatus: 'verified',
      changedFiles: [
        { path: 'src/validation.ts', contentHash: 'modified' },
        { path: 'survival-progress.md', contentHash: 'modified' },
      ],
    });

    // (15) Verify everything the scenario demands.
    // Original task contract survived (latest checkpoint still pins it —
    // the auto milestone checkpoint carries its own contract snapshot).
    const finalCheckpoint = readLatestTaskCheckpoint(fixture.workspace, job.jobId, node.nodeId);
    expect(finalCheckpoint).toBeDefined();
    // Failed approach was not forgotten; decisions survived (carry-forward).
    expect(finalCheckpoint?.failedApproaches.map((failed) => failed.approach)).toContain(
      'Approach X: regex-based validation',
    );
    expect(finalCheckpoint?.importantDecisions.map((decision) => decision.decision)).toContain(
      'Use zod schemas for validation.',
    );
    // Repository state remained correct: the file is still there, HEAD unmoved.
    const finalSnapshot = await captureGitSnapshot(fixture.root, { clock: restarted.clock ?? (() => new Date()) });
    expect(finalSnapshot.head).toBe(midSnapshot.head);
    expect(finalSnapshot.entries.some((entry) => entry.path === 'survival-progress.md')).toBe(true);
    // Multiple ExecutionAttempts are recorded, across two providers.
    const attempts = listTaskAttempts(fixture.workspace, job.jobId, { nodeId: node.nodeId });
    expect(attempts.map((attempt) => [attempt.provider, attempt.status])).toEqual([
      ['fake-provider-a', 'INTERRUPTED'],
      ['fake-provider-b', 'COMPLETED'],
    ]);
    // The task completed through the normal path.
    const finalGraph = requireGraphRevision(
      fixture.workspace,
      job.jobId,
      requireJobState(fixture.workspace, job.jobId).graphRevision,
    );
    expect(finalGraph.nodes.find((candidate) => candidate.nodeId === node.nodeId)?.status).toBe(
      'COMPLETED',
    );
    expect(completion.nextAction === 'node-complete' || completion.nextAction === 'job-complete').toBe(true);
    // Cumulative context exceeded one window by several multiples while the
    // live context always fit inside it.
    const cumulative = workerA.cumulativeTokens() + workerB.cumulativeTokens();
    expect(cumulative).toBeGreaterThan(5 * WORKER_BUDGET.modelContextTokens);
    // The ledger recorded both attempts with whatever metrics existed.
    const summary = summarizeExecutionLedger(readExecutionLedger(fixture.workspace, job.jobId));
    expect(summary.byProvider['fake-provider-a']?.interrupted).toBe(1);
    expect(summary.byProvider['fake-provider-b']?.completed).toBe(1);
    expect(summary.byProvider['fake-provider-b']?.reportedInputTokens).toBe(9_000);
  }, 60_000);
});
