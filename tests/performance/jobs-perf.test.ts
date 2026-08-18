import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { jobPolicySchema } from '@specbridge/core';
import {
  CLAUDE_WORKER_ID,
  appendJobEvent,
  assessProgress,
  checkpointJob,
  createJob,
  failureFingerprint,
  jobGraphSchema,
  jobStateSchema,
  listJobs,
  nextSchedulableNode,
  promoteReadyNodes,
  readJobEvents,
  requireGraphRevision,
  requireJobState,
  resumeJob,
  scheduleNext,
  storeGraphRevision,
  writeJobState,
} from '@specbridge/orchestration';
import type { JobGraph, JobNode, JobWorkerProfile } from '@specbridge/orchestration';
import { callTool, connectMcp } from '../helpers-mcp.js';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * v1.2 job orchestration performance: state load, scheduler decision, graph
 * traversal, checkpoint persistence, no-progress fingerprinting, resume, and
 * the MCP job listing — measured against a job at the schema's node bound
 * (200 nodes) with a thousand-event history. Same policy as the rest of the
 * suite: warm up, measure once, assert a generous budget, log the number.
 */

const SKIP_PERF = process.env['SPECBRIDGE_SKIP_PERF'] === '1';

const BUDGET_MS = {
  jobStateLoad: 1_000,
  schedulerDecision: 500,
  graphTraversal: 500,
  checkpointPersist: 2_000,
  noProgressFingerprint: 500,
  jobResume: 10_000,
  mcpJobList: 5_000,
  eventPage: 2_000,
} as const;

function log(metric: string, value: number, unit = 'ms'): void {
   
  console.log(`perf: ${metric} = ${value.toFixed(1)} ${unit}`);
}

async function measure(fn: () => void | Promise<void>): Promise<number> {
  await fn(); // warm-up
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

const MAX_NODES = 200;

function syntheticNode(index: number): JobNode {
  return {
    nodeId: `n-${index}`,
    parentTaskId: String(index),
    title: `Synthetic task ${index} exercising the graph bound`,
    taskFingerprint: `fp-${index}`,
    dependsOn: index > 0 ? [`n-${index - 1}`] : [],
    status: index === 0 ? 'READY' : 'PENDING',
    planRevision: 0,
    planApproved: false,
    humanReviewRequired: false,
    complexity: 'LOW',
    complexitySignals: [],
    attempts: [],
    repairCycles: 0,
    replans: 0,
    consecutiveNoProgress: 0,
  } as JobNode;
}

function largeJobFixture(): {
  fixture: ReturnType<typeof setupOrchestrationFixture>;
  jobId: string;
} {
  const fixture = setupOrchestrationFixture();
  const deps = { workspace: fixture.workspace, config: fixture.config, host: 'perf' };
  const job = createJob(deps, { specName: fixture.specName, goal: 'Perf fixture job.' });
  const graph: JobGraph = jobGraphSchema.parse({
    schemaVersion: '1.0.0',
    jobId: job.jobId,
    revision: 1,
    specName: fixture.specName,
    createdAt: job.createdAt,
    baseline: { approvedStageHashes: {} },
    nodes: Array.from({ length: MAX_NODES }, (_, index) => syntheticNode(index)),
  });
  storeGraphRevision(fixture.workspace, job.jobId, graph);
  writeJobState(fixture.workspace, { ...job, status: 'READY', graphRevision: 1, currentNodeId: 'n-0' });
  for (let index = 0; index < 1_000; index += 1) {
    appendJobEvent(
      fixture.workspace,
      job.jobId,
      { at: `2026-08-01T09:00:00.${String(index % 1000).padStart(3, '0')}Z`, type: 'node_ready', index },
      { maxEventBytes: 8_192 },
    );
  }
  return { fixture, jobId: job.jobId };
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

describe.skipIf(SKIP_PERF)('job orchestration performance', () => {
  it('meets the budgets at the 200-node graph bound with a 1000-event history', async () => {
    const { fixture, jobId } = largeJobFixture();
    const policy = jobPolicySchema.parse({ routing: { classifier: 'disabled' } });

    const load = await measure(() => {
      const job = requireJobState(fixture.workspace, jobId);
      expect(job.graphRevision).toBe(1);
      requireGraphRevision(fixture.workspace, jobId, 1);
    });
    log('jobStateLoad(200 nodes)', load);
    expect(load).toBeLessThan(BUDGET_MS.jobStateLoad);

    const job = requireJobState(fixture.workspace, jobId);
    const graph = requireGraphRevision(fixture.workspace, jobId, 1);

    const traversal = await measure(() => {
      const promoted = promoteReadyNodes(graph);
      expect(nextSchedulableNode(promoted)?.nodeId).toBe('n-0');
    });
    log('graphTraversal(200 nodes)', traversal);
    expect(traversal).toBeLessThan(BUDGET_MS.graphTraversal);

    const decision = await measure(() => {
      const result = scheduleNext({
        job,
        graph,
        policy,
        workers: [largeWorker()],
        now: fixture.clock(),
      });
      expect(result.kind).toBe('RUN_ROLE');
    });
    log('schedulerDecision(200 nodes)', decision);
    expect(decision).toBeLessThan(BUDGET_MS.schedulerDecision);

    const checkpoint = await measure(() => {
      checkpointJob(
        { workspace: fixture.workspace, config: fixture.config, host: 'perf' },
        jobId,
        'Perf checkpoint.',
      );
    });
    log('checkpointPersist(200 nodes)', checkpoint);
    expect(checkpoint).toBeLessThan(BUDGET_MS.checkpointPersist);

    const fingerprint = await measure(() => {
      const output = 'AssertionError at /some/path/file.ts:120:5 after 12ms pid=4242\n'.repeat(400);
      const first = failureFingerprint({
        category: 'VERIFICATION_FAILURE',
        source: 'test',
        exitCode: 1,
        output,
      });
      const progressed = assessProgress({
        previous: undefined,
        next: {
          failureFingerprint: first,
          changedFileCount: 3,
          actionCategory: 'VERIFY',
          planRevision: 1,
          result: 'failed',
        },
        consecutiveNoProgress: 0,
        maxNoProgressCycles: 2,
      });
      expect(progressed.consecutiveNoProgress).toBeGreaterThanOrEqual(0);
    });
    log('noProgressFingerprint(400-line output)', fingerprint);
    expect(fingerprint).toBeLessThan(BUDGET_MS.noProgressFingerprint);

    const events = await measure(() => {
      const page = readJobEvents(fixture.workspace, jobId, { limit: 50 });
      expect(page.total).toBeGreaterThanOrEqual(1_000);
      expect(page.events.length).toBeLessThanOrEqual(50);
    });
    log('eventPage(1000+ events, page 50)', events);
    expect(events).toBeLessThan(BUDGET_MS.eventPage);

    const resume = await measure(async () => {
      const report = await resumeJob(
        { workspace: fixture.workspace, config: fixture.config, host: 'perf' },
        jobId,
      );
      expect(report.finalized).toBe(false);
    });
    log('jobResume(200 nodes)', resume);
    expect(resume).toBeLessThan(BUDGET_MS.jobResume);

    // Persisted history must not make default status views unbounded: the
    // listing reads job.json only, never the event log or graph revisions.
    const session = await connectMcp(fixture.root);
    try {
      const list = await measure(async () => {
        const result = await callTool(session, 'job_list', {});
        expect(result.isError).toBe(false);
      });
      log('mcpJobList', list);
      expect(list).toBeLessThan(BUDGET_MS.mcpJobList);
    } finally {
      await session.close();
    }
  });

  it('schema validation of a maximal job state stays cheap', async () => {
    const { fixture, jobId } = largeJobFixture();
    const job = requireJobState(fixture.workspace, jobId);
    const graph = requireGraphRevision(fixture.workspace, jobId, 1);
    const parse = await measure(() => {
      expect(jobStateSchema.safeParse(job).success).toBe(true);
      expect(jobGraphSchema.safeParse(graph).success).toBe(true);
    });
    log('schemaValidation(job + 200-node graph)', parse);
    expect(parse).toBeLessThan(1_000);
    expect(listJobs(fixture.workspace).jobs).toHaveLength(1);
  });
});
