import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executionTelemetryReportFile } from '@specbridge/autonomy';
import { buildJobGraph, createJob, requireJobState } from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';
import { callTool, connectMcp } from '../helpers-mcp.js';

/**
 * MCP job tools (v1.2): thin, bounded adapters. Jobs are driven by the
 * standalone CLI orchestrator; MCP only inspects and cancels.
 */

async function fixtureWithJob(): Promise<OrchestrationFixture & { jobId: string }> {
  const fixture = setupOrchestrationFixture();
  const deps = { workspace: fixture.workspace, config: fixture.config, host: 'test' };
  const job = createJob(deps, { specName: fixture.specName, goal: 'Implement the plan.' });
  await buildJobGraph(deps, job.jobId);
  return { ...fixture, jobId: job.jobId };
}

describe('job_list / job_read / job_cancel', () => {
  it('lists jobs with bounded summaries', async () => {
    const fixture = await fixtureWithJob();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'job_list', {});
      expect(result.isError).toBe(false);
      const jobs = result.structured['jobs'] as { jobId: string; status: string; openQuestions: number }[];
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ jobId: fixture.jobId, status: 'READY' });
    } finally {
      await session.close();
    }
  });

  it('reads one job with its runtime graph and next action', async () => {
    const fixture = await fixtureWithJob();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'job_read', { jobId: fixture.jobId });
      expect(result.isError).toBe(false);
      const nodes = result.structured['nodes'] as { taskId: string; status: string }[];
      expect(nodes.map((node) => node.taskId)).toEqual(['1', '2.1', '2.2', '3']);
      expect(result.structured['nextAction']).toBeDefined();
      expect(result.structured['goal']).toBe('Implement the plan.');
    } finally {
      await session.close();
    }
  });

  it('an unknown job id is a stable error, not a crash', async () => {
    const fixture = setupOrchestrationFixture();
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'job_read', { jobId: 'job-nope' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('not found');
    } finally {
      await session.close();
    }
  });

  it('derives a versioned job report without persisting or changing job state', async () => {
    const fixture = await fixtureWithJob();
    const before = requireJobState(fixture.workspace, fixture.jobId);
    const reportFile = executionTelemetryReportFile(fixture.workspace, fixture.jobId);
    const researchDir = path.join(fixture.root, '.specbridge', 'research');
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(path.join(researchDir, 'telemetry.json'), '{corrupt', 'utf8');
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'job_report', { jobId: fixture.jobId });
      expect(result.isError).toBe(false);
      expect(result.structured['report']).toMatchObject({
        schemaVersion: '1.1.0',
        jobId: fixture.jobId,
        outcome: { authoritativeJobStatus: 'READY' },
      });
      expect((result.structured['report'] as { diagnostics: { code: string }[] }).diagnostics)
        .toContainEqual(expect.objectContaining({ code: 'RESEARCH_TELEMETRY_UNREADABLE' }));
      expect(existsSync(reportFile)).toBe(false);
      expect(requireJobState(fixture.workspace, fixture.jobId)).toEqual(before);
    } finally {
      await session.close();
    }
  });

  it('job_cancel finalizes idempotently and reports honestly', async () => {
    const fixture = await fixtureWithJob();
    const session = await connectMcp(fixture.root);
    try {
      const first = await callTool(session, 'job_cancel', {
        jobId: fixture.jobId,
        reason: 'test cancellation',
      });
      expect(first.isError).toBe(false);
      expect(first.structured).toMatchObject({ status: 'CANCELLED', alreadyFinal: false });
      expect(requireJobState(fixture.workspace, fixture.jobId).status).toBe('CANCELLED');

      const again = await callTool(session, 'job_cancel', { jobId: fixture.jobId, reason: 'again' });
      expect(again.structured).toMatchObject({ status: 'CANCELLED', alreadyFinal: true });
    } finally {
      await session.close();
    }
  });

  it('no job tool can advance, approve, or complete anything', async () => {
    const fixture = await fixtureWithJob();
    const session = await connectMcp(fixture.root);
    try {
      const tools = await session.client.listTools();
      const jobTools = tools.tools.filter((tool) => tool.name.startsWith('job_'));
      expect(jobTools.map((tool) => tool.name).sort()).toEqual([
        'job_cancel',
        'job_list',
        'job_read',
        'job_report',
      ]);
      // Nothing exposes dispatch, review, approval, or completion for jobs.
      expect(tools.tools.some((tool) => /job_(run|step|dispatch|approve|review|complete)/.test(tool.name))).toBe(
        false,
      );
    } finally {
      await session.close();
    }
  });
});
