import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OrchestrationError,
  appendJobEvent,
  createJob,
  initializeJobRecord,
  jobsRootDir,
  listJobs,
  readAgentResult,
  readGraphRevision,
  readJobCheckpoint,
  readJobEvents,
  readJobState,
  readNodePlan,
  requireJobState,
  storeAgentResult,
  storeGraphRevision,
  storeNodePlan,
  writeJobCheckpoint,
  writeJobState,
} from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * Job persistence: versioned, atomic, workspace-confined, fail-safe on
 * corruption, and readable back exactly as written.
 */

function fixtureWithJob(): ReturnType<typeof setupOrchestrationFixture> & { jobId: string } {
  const fixture = setupOrchestrationFixture();
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Persist things.',
  });
  return { ...fixture, jobId: job.jobId };
}

describe('job state persistence', () => {
  it('round-trips a created job through the store', () => {
    const fixture = fixtureWithJob();
    const read = requireJobState(fixture.workspace, fixture.jobId);
    expect(read.specName).toBe(fixture.specName);
    expect(read.status).toBe('CREATED');
    expect(read.schemaVersion).toBe('1.0.0');
  });

  it('a duplicate job id is refused', () => {
    const fixture = fixtureWithJob();
    const job = requireJobState(fixture.workspace, fixture.jobId);
    expect(() => initializeJobRecord(fixture.workspace, job)).toThrowError(/already exists/);
  });

  it('an invalid job id never touches the filesystem', () => {
    const fixture = setupOrchestrationFixture();
    for (const bad of ['../escape', 'a/b', '..', 'x'.repeat(80)]) {
      expect(() => readJobState(fixture.workspace, bad)).toThrowError(OrchestrationError);
    }
  });

  it('corrupt state is reported, preserved, and never rewritten', () => {
    const fixture = fixtureWithJob();
    const file = path.join(jobsRootDir(fixture.workspace), fixture.jobId, 'job.json');
    writeFileSync(file, '{ not json', 'utf8');
    const read = readJobState(fixture.workspace, fixture.jobId);
    expect(read.kind).toBe('corrupt');
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    expect(() => requireJobState(fixture.workspace, fixture.jobId)).toThrowError(/unreadable/);
  });

  it('an unknown MAJOR schema version is refused, not coerced', () => {
    const fixture = fixtureWithJob();
    const file = path.join(jobsRootDir(fixture.workspace), fixture.jobId, 'job.json');
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    record['schemaVersion'] = '2.0.0';
    writeFileSync(file, JSON.stringify(record), 'utf8');
    const read = readJobState(fixture.workspace, fixture.jobId);
    expect(read).toMatchObject({ kind: 'unsupported-version', version: '2.0.0' });
  });

  it('unknown additive fields survive a read/write cycle (passthrough)', () => {
    const fixture = fixtureWithJob();
    const job = requireJobState(fixture.workspace, fixture.jobId);
    writeJobState(fixture.workspace, { ...job, futureField: 'kept' } as typeof job);
    const read = requireJobState(fixture.workspace, fixture.jobId) as Record<string, unknown>;
    expect(read['futureField']).toBe('kept');
  });

  it('listJobs reports readable jobs and diagnoses unreadable ones', () => {
    const fixture = fixtureWithJob();
    const brokenDir = path.join(jobsRootDir(fixture.workspace), 'job-broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, 'job.json'), 'nope', 'utf8');
    const listed = listJobs(fixture.workspace);
    expect(listed.jobs.map((job) => job.jobId)).toContain(fixture.jobId);
    expect(listed.diagnostics.some((diagnostic) => diagnostic.code === 'JOB_STATE_UNREADABLE')).toBe(true);
  });

  it('a workspace without a jobs directory lists nothing and errors nowhere', () => {
    const fixture = setupOrchestrationFixture();
    expect(listJobs(fixture.workspace)).toEqual({ jobs: [], diagnostics: [] });
  });
});

describe('events', () => {
  it('appends bounded events and reads bounded pages, newest last', () => {
    const fixture = fixtureWithJob();
    for (let index = 0; index < 10; index += 1) {
      appendJobEvent(
        fixture.workspace,
        fixture.jobId,
        { at: `2026-08-01T09:00:0${index}.000Z`, type: 'node_ready', index },
        { maxEventBytes: 8_192 },
      );
    }
    const page = readJobEvents(fixture.workspace, fixture.jobId, { limit: 3 });
    expect(page.events).toHaveLength(3);
    expect(page.truncated).toBe(true);
    expect(page.events[2]).toMatchObject({ index: 9 });
  });

  it('an oversized event is refused, never truncated', () => {
    const fixture = fixtureWithJob();
    expect(() =>
      appendJobEvent(
        fixture.workspace,
        fixture.jobId,
        { at: 't', type: 'node_ready', payload: 'x'.repeat(10_000) },
        { maxEventBytes: 1_024 },
      ),
    ).toThrowError(/not recorded/);
  });

  it('a partially written final line is skipped, not fatal', () => {
    const fixture = fixtureWithJob();
    appendJobEvent(
      fixture.workspace,
      fixture.jobId,
      { at: 't', type: 'node_ready' },
      { maxEventBytes: 8_192 },
    );
    const file = path.join(jobsRootDir(fixture.workspace), fixture.jobId, 'events.jsonl');
    const intact = readJobEvents(fixture.workspace, fixture.jobId).total;
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"truncated`, 'utf8');
    const page = readJobEvents(fixture.workspace, fixture.jobId);
    expect(page.total).toBe(intact);
  });
});

describe('graphs, plans, agent results, checkpoints', () => {
  it('graph revisions are append-only and read back validated', () => {
    const fixture = fixtureWithJob();
    const graph = {
      schemaVersion: '1.0.0',
      jobId: fixture.jobId,
      revision: 1,
      specName: fixture.specName,
      createdAt: 't',
      baseline: { approvedStageHashes: {} },
      nodes: [
        {
          nodeId: 'n-1',
          parentTaskId: '1',
          title: 'task',
          taskFingerprint: 'fp',
          dependsOn: [],
          status: 'READY',
          planRevision: 0,
          planApproved: false,
          humanReviewRequired: false,
          complexitySignals: [],
          attempts: [],
          repairCycles: 0,
          replans: 0,
          consecutiveNoProgress: 0,
        },
      ],
    };
    storeGraphRevision(fixture.workspace, fixture.jobId, graph as never);
    const read = readGraphRevision(fixture.workspace, fixture.jobId, 1);
    expect(read?.nodes[0]?.nodeId).toBe('n-1');
    expect(readGraphRevision(fixture.workspace, fixture.jobId, 2)).toBeUndefined();
  });

  it('node plans are append-only: a stored revision is never overwritten', () => {
    const fixture = fixtureWithJob();
    storeNodePlan(fixture.workspace, fixture.jobId, 'n-1', 1, { goal: 'a' });
    expect(() => storeNodePlan(fixture.workspace, fixture.jobId, 'n-1', 1, { goal: 'b' })).toThrowError(
      /already exists/,
    );
    expect(readNodePlan(fixture.workspace, fixture.jobId, 'n-1', 1)).toEqual({ goal: 'a' });
  });

  it('agent results enforce the size bound and append-only naming', () => {
    const fixture = fixtureWithJob();
    const stored = storeAgentResult(
      fixture.workspace,
      fixture.jobId,
      '000001-planner.json',
      { decision: 'PLAN' },
      { maxBytes: 65_536 },
    );
    expect(stored.ref).toBe('agents/000001-planner.json');
    expect(readAgentResult(fixture.workspace, fixture.jobId, stored.ref)).toEqual({ decision: 'PLAN' });
    expect(() =>
      storeAgentResult(
        fixture.workspace,
        fixture.jobId,
        '000001-planner.json',
        { decision: 'AGAIN' },
        { maxBytes: 65_536 },
      ),
    ).toThrowError(/append-only/);
    expect(() =>
      storeAgentResult(
        fixture.workspace,
        fixture.jobId,
        '000002-planner.json',
        { blob: 'x'.repeat(70_000) },
        { maxBytes: 65_536 },
      ),
    ).toThrowError(/limit/);
    expect(() =>
      storeAgentResult(fixture.workspace, fixture.jobId, '../escape.json', {}, { maxBytes: 1_024 }),
    ).toThrowError(OrchestrationError);
  });

  it('checkpoints round-trip and unreadable ones read as absent', () => {
    const fixture = fixtureWithJob();
    const job = requireJobState(fixture.workspace, fixture.jobId);
    writeJobCheckpoint(fixture.workspace, fixture.jobId, {
      schemaVersion: '1.0.0',
      jobId: fixture.jobId,
      createdAt: 't',
      specName: fixture.specName,
      status: job.status,
      graphRevision: 0,
      completedNodes: [],
      remainingNodes: [],
      counters: job.counters,
      budgets: job.budgets,
      nextAction: 'Build the graph.',
    });
    expect(readJobCheckpoint(fixture.workspace, fixture.jobId)?.nextAction).toBe('Build the graph.');
    const file = path.join(jobsRootDir(fixture.workspace), fixture.jobId, 'checkpoint.json');
    writeFileSync(file, 'garbage', 'utf8');
    expect(readJobCheckpoint(fixture.workspace, fixture.jobId)).toBeUndefined();
  });
});
