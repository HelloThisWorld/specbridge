import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  appendOrchestrationEvent,
  countOrchestrationEvents,
  createOrchestrationRun,
  explainOrchestration,
  listOrchestrationRuns,
  orchestrationDir,
  orchestrationStorageBytes,
  readOrchestrationEvents,
  readOrchestrationState,
  requireOrchestrationState,
} from '@specbridge/orchestration';
import { setupExecutionFixture } from '../helpers-execution.js';
import { callTool, connectMcp } from '../helpers-mcp.js';
import { setupOrchestrationFixture, testOrchestrationState } from '../helpers-orchestration.js';

/**
 * Concurrency and bounds.
 *
 * Orchestration mutations go through the SAME per-project write mutex the
 * existing MCP tools use — there is no second lock system. Reads stay
 * concurrent, and every view is bounded regardless of how much history a run
 * accumulated.
 */

describe('concurrent orchestration mutations serialize', () => {
  it('parallel begins each produce a distinct, readable run', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          callTool(session, 'orchestration_begin', {
            specName: fixture.specName,
            goal: `Parallel goal ${index}.`,
          }),
        ),
      );
      for (const result of results) expect(result.isError).toBe(false);

      const ids = results.map((result) => result.structured['orchestrationId'] as string);
      expect(new Set(ids).size).toBe(ids.length);

      // Every record is complete and readable: no interleaved half-write.
      const workspace = fixture.workspace;
      for (const id of ids) {
        expect(readOrchestrationState(workspace, id).kind).toBe('ok');
      }
      expect(listOrchestrationRuns(workspace).runs).toHaveLength(5);
      expect(listOrchestrationRuns(workspace).diagnostics).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('parallel writes to one run leave a consistent final state', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const begun = await callTool(session, 'orchestration_begin', {
        specName: fixture.specName,
        goal: 'Implement task 1.',
        taskId: '1',
      });
      const orchestrationId = begun.structured['orchestrationId'] as string;

      // Three racing assessments: the mutex means each observes a valid
      // state, and the record never ends up corrupt.
      const results = await Promise.all([
        callTool(session, 'orchestration_assess_intent', {
          orchestrationId,
          outcome: 'READY',
          summary: 'Implement task 1.',
          provenance: [{ fact: 'approved', source: 'known-from-approved-spec' }],
        }),
        callTool(session, 'orchestration_assess_intent', {
          orchestrationId,
          outcome: 'NEEDS_CLARIFICATION',
          summary: 'Implement task 1 but the scope is unclear.',
        }),
        callTool(session, 'orchestration_status', { orchestrationId }),
      ]);
      for (const result of results) {
        // A refusal is acceptable; corruption is not.
        if (result.isError) expect(result.errorCode).toMatch(/^SBMCP0\d\d$/);
      }
      expect(readOrchestrationState(fixture.workspace, orchestrationId).kind).toBe('ok');
    } finally {
      await session.close();
    }
  });

  it('read-only status runs concurrently with itself', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const begun = await callTool(session, 'orchestration_begin', {
        specName: fixture.specName,
        goal: 'Implement task 1.',
        taskId: '1',
      });
      const orchestrationId = begun.structured['orchestrationId'] as string;

      const reads = await Promise.all(
        Array.from({ length: 8 }, () =>
          callTool(session, 'orchestration_status', { orchestrationId }),
        ),
      );
      for (const read of reads) {
        expect(read.isError).toBe(false);
        expect(read.structured['phase']).toBe('CREATED');
      }
      // Reading never advanced anything.
      expect(requireOrchestrationState(fixture.workspace, orchestrationId).phase).toBe('CREATED');
    } finally {
      await session.close();
    }
  });
});

describe('bounded views over unbounded history', () => {
  it('keeps status, explain, and event paging fast with a large history', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState({ phase: 'EXECUTING' });
    createOrchestrationRun(fixture.workspace, state);

    // Setup writes the log in one go: this test measures the READ paths, and
    // 5,000 individual appendFileSync calls would only measure the filesystem.
    // (One append per event is exercised by the persistence suite.)
    const history = Array.from(
      { length: 5_000 },
      (_, index) =>
        `${JSON.stringify({
          at: '2026-08-01T09:00:00.000Z',
          type: 'action_recorded',
          index,
          target: `packages/example/src/module-${index}.ts`,
        })}\n`,
    ).join('');
    writeFileSync(
      path.join(orchestrationDir(fixture.workspace, state.orchestrationId), 'events.jsonl'),
      history,
      'utf8',
    );
    expect(countOrchestrationEvents(fixture.workspace, state.orchestrationId)).toBe(5_000);

    const loadStart = performance.now();
    const loaded = requireOrchestrationState(fixture.workspace, state.orchestrationId);
    const loadMs = performance.now() - loadStart;

    const explainStart = performance.now();
    const explanation = explainOrchestration(loaded);
    const explainMs = performance.now() - explainStart;

    const pageStart = performance.now();
    const page = readOrchestrationEvents(fixture.workspace, state.orchestrationId, { limit: 50 });
    const pageMs = performance.now() - pageStart;

    // Generous informational budgets: the point is that none of these grows
    // without bound, not a tight timing gate.
    expect(loadMs).toBeLessThan(1_000);
    expect(explainMs).toBeLessThan(500);
    expect(pageMs).toBeLessThan(2_000);

    // A default view never returns 5,000 events.
    expect(page.events).toHaveLength(50);
    expect(page.total).toBe(5_000);
    expect(page.truncated).toBe(true);
    expect(explanation.budgets.length).toBeGreaterThan(0);

    // The state record itself stays small even with a huge event log.
    const bytes = orchestrationStorageBytes(fixture.workspace, state.orchestrationId);
    expect(bytes).toBeGreaterThan(0);
    expect(JSON.stringify(loaded).length).toBeLessThan(16_384);
  });

  it('pages backwards through history with offset', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    for (let index = 0; index < 100; index += 1) {
      appendOrchestrationEvent(
        fixture.workspace,
        state.orchestrationId,
        { at: '2026-08-01T09:00:00.000Z', type: 'action_recorded', index },
        { maxEventBytes: 8_192 },
      );
    }

    const newest = readOrchestrationEvents(fixture.workspace, state.orchestrationId, { limit: 10 });
    const older = readOrchestrationEvents(fixture.workspace, state.orchestrationId, {
      limit: 10,
      offset: 10,
    });
    expect(newest.events.at(-1)?.['index']).toBe(99);
    expect(older.events.at(-1)?.['index']).toBe(89);
  });

  it('a bounded MCP status response stays well under the output limit', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      const begun = await callTool(session, 'orchestration_begin', {
        specName: fixture.specName,
        goal: 'Implement task 1.',
        taskId: '1',
      });
      const orchestrationId = begun.structured['orchestrationId'] as string;
      const status = await callTool(session, 'orchestration_status', {
        orchestrationId,
        eventLimit: 200,
      });
      expect(status.isError).toBe(false);
      expect(JSON.stringify(status.structured).length).toBeLessThan(200_000);
    } finally {
      await session.close();
    }
  });
});
