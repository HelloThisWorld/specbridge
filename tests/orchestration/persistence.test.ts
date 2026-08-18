import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATION_STATE_SCHEMA_VERSION,
  appendOrchestrationEvent,
  countOrchestrationEvents,
  createOrchestrationRun,
  isOrchestrationError,
  listOrchestrationRuns,
  listPlanRevisions,
  orchestrationDir,
  planHash,
  readOrchestrationEvents,
  readOrchestrationState,
  readPlanRevision,
  requireOrchestrationState,
  storePlanRevision,
  writeOrchestrationState,
} from '@specbridge/orchestration';
import type { ExecutionPlan } from '@specbridge/orchestration';
import { setupOrchestrationFixture, testOrchestrationState } from '../helpers-orchestration.js';

/**
 * Persistence guarantees: versioned, atomic, bounded, path-safe, and honest
 * about corruption (never silently rewritten, never silently deleted).
 */

function samplePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    schemaVersion: '1.0.0',
    planId: 'plan-1',
    revision: 1,
    specName: 'settings-persistence',
    createdAt: '2026-08-01T09:00:00.000Z',
    binding: {
      taskId: '1',
      taskFingerprint: 'fp-1',
      approvedStageHashes: { requirements: 'aaa' },
      gitHead: 'abc1234',
      policyFingerprint: 'policy-1',
    },
    goal: 'Do the thing',
    nonGoals: [],
    constraints: [],
    relevantEvidence: [],
    assumptions: [],
    openQuestions: [],
    expectedAreas: [],
    steps: [{ id: 's1', description: 'step one', expectedAreas: [], status: 'pending' }],
    testStrategy: 'unit test',
    verificationStrategy: 'trusted commands',
    replanTriggers: [],
    ...overrides,
  } as ExecutionPlan;
}

describe('orchestration state persistence', () => {
  it('round-trips a state record through disk unchanged', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState({ phase: 'READY_TO_PLAN', taskId: '1' });
    createOrchestrationRun(fixture.workspace, state);

    const read = readOrchestrationState(fixture.workspace, state.orchestrationId);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.state).toEqual(state);
  });

  it('writes state atomically, leaving no temp files behind', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    writeOrchestrationState(fixture.workspace, { ...state, phase: 'READY_TO_PLAN' });

    const dir = orchestrationDir(fixture.workspace, state.orchestrationId);
    const stray = readdirSync(dir).filter((name) => name.includes('.tmp'));
    expect(stray).toEqual([]);
  });

  it('reports missing runs as SBO002 without creating anything', () => {
    const fixture = setupOrchestrationFixture();
    try {
      requireOrchestrationState(fixture.workspace, 'orc-missing');
      expect.unreachable('missing run must throw');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.code).toBe('SBO002');
    }
  });

  it('fails safely on corrupt JSON and preserves the file for diagnosis', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    const file = path.join(orchestrationDir(fixture.workspace, state.orchestrationId), 'state.json');
    writeFileSync(file, '{ this is not json', 'utf8');

    const read = readOrchestrationState(fixture.workspace, state.orchestrationId);
    expect(read.kind).toBe('corrupt');
    // The corrupt bytes are still exactly as written.
    expect(readFileSync(file, 'utf8')).toBe('{ this is not json');

    expect(() => requireOrchestrationState(fixture.workspace, state.orchestrationId)).toThrow(
      /unreadable state/,
    );
  });

  it('refuses a future major schema version instead of coercing it', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    const file = path.join(orchestrationDir(fixture.workspace, state.orchestrationId), 'state.json');
    writeFileSync(file, JSON.stringify({ ...state, schemaVersion: '2.0.0' }), 'utf8');

    const read = readOrchestrationState(fixture.workspace, state.orchestrationId);
    expect(read.kind).toBe('unsupported-version');
    if (read.kind !== 'unsupported-version') return;
    expect(read.version).toBe('2.0.0');
    expect(() => requireOrchestrationState(fixture.workspace, state.orchestrationId)).toThrow(
      /newer SpecBridge/,
    );
  });

  it('accepts a compatible minor version within the same major line', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    const file = path.join(orchestrationDir(fixture.workspace, state.orchestrationId), 'state.json');
    writeFileSync(file, JSON.stringify({ ...state, schemaVersion: '1.5.0' }), 'utf8');

    expect(readOrchestrationState(fixture.workspace, state.orchestrationId).kind).toBe('ok');
  });

  it('preserves unknown fields written by a newer minor version', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    const file = path.join(orchestrationDir(fixture.workspace, state.orchestrationId), 'state.json');
    writeFileSync(file, JSON.stringify({ ...state, futureField: { keep: true } }), 'utf8');

    const read = readOrchestrationState(fixture.workspace, state.orchestrationId);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect((read.state as Record<string, unknown>)['futureField']).toEqual({ keep: true });

    // A rewrite must not drop it.
    writeOrchestrationState(fixture.workspace, read.state);
    const again = readOrchestrationState(fixture.workspace, state.orchestrationId);
    if (again.kind !== 'ok') expect.unreachable('rewrite must stay readable');
    else expect((again.state as Record<string, unknown>)['futureField']).toEqual({ keep: true });
  });

  it('rejects ids that could escape the sidecar directory', () => {
    const fixture = setupOrchestrationFixture();
    for (const id of ['../escape', 'a/b', '..', 'x\0y', '', 'a'.repeat(200)]) {
      expect(() => orchestrationDir(fixture.workspace, id)).toThrow();
    }
  });

  it('lists runs newest first and degrades unreadable ones to diagnostics', () => {
    const fixture = setupOrchestrationFixture();
    createOrchestrationRun(
      fixture.workspace,
      testOrchestrationState({ orchestrationId: 'orc-a', createdAt: '2026-08-01T09:00:00.000Z' }),
    );
    createOrchestrationRun(
      fixture.workspace,
      testOrchestrationState({ orchestrationId: 'orc-b', createdAt: '2026-08-02T09:00:00.000Z' }),
    );
    const brokenDir = orchestrationDir(fixture.workspace, 'orc-broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, 'state.json'), 'not json', 'utf8');

    const result = listOrchestrationRuns(fixture.workspace);
    expect(result.runs.map((run) => run.orchestrationId)).toEqual(['orc-b', 'orc-a']);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('ORCHESTRATION_STATE_UNREADABLE');
  });
});

describe('plan revision storage', () => {
  it('keeps every revision; nothing is replaced', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);

    storePlanRevision(fixture.workspace, state.orchestrationId, samplePlan());
    storePlanRevision(
      fixture.workspace,
      state.orchestrationId,
      samplePlan({ revision: 2, planId: 'plan-2', goal: 'Different goal' }),
    );

    const all = listPlanRevisions(fixture.workspace, state.orchestrationId);
    expect(all.map((plan) => plan.revision)).toEqual([1, 2]);
    expect(readPlanRevision(fixture.workspace, state.orchestrationId, 1)?.goal).toBe('Do the thing');
  });

  it('produces a stable hash that changes with any plan content change', () => {
    const one = planHash(samplePlan());
    expect(planHash(samplePlan())).toBe(one);
    expect(planHash(samplePlan({ goal: 'Something else' }))).not.toBe(one);
  });
});

describe('event history', () => {
  it('appends events and returns bounded pages, never the whole log', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);

    for (let index = 0; index < 120; index += 1) {
      appendOrchestrationEvent(
        fixture.workspace,
        state.orchestrationId,
        { at: `2026-08-01T09:00:${String(index % 60).padStart(2, '0')}.000Z`, type: 'action_recorded', index },
        { maxEventBytes: 8_192 },
      );
    }

    expect(countOrchestrationEvents(fixture.workspace, state.orchestrationId)).toBe(120);
    const page = readOrchestrationEvents(fixture.workspace, state.orchestrationId, { limit: 10 });
    expect(page.events).toHaveLength(10);
    expect(page.total).toBe(120);
    expect(page.truncated).toBe(true);
    // Newest last within the page.
    expect(page.events.at(-1)?.['index']).toBe(119);
  });

  it('caps the page size even when a caller asks for more', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    for (let index = 0; index < 800; index += 1) {
      appendOrchestrationEvent(
        fixture.workspace,
        state.orchestrationId,
        { at: '2026-08-01T09:00:00.000Z', type: 'action_recorded', index },
        { maxEventBytes: 8_192 },
      );
    }
    const page = readOrchestrationEvents(fixture.workspace, state.orchestrationId, { limit: 100_000 });
    expect(page.events.length).toBeLessThanOrEqual(500);
  });

  it('refuses an oversized event rather than truncating the audit record', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    try {
      appendOrchestrationEvent(
        fixture.workspace,
        state.orchestrationId,
        { at: '2026-08-01T09:00:00.000Z', type: 'action_recorded', blob: 'x'.repeat(20_000) },
        { maxEventBytes: 8_192 },
      );
      expect.unreachable('oversized events must be refused');
    } catch (error) {
      if (!isOrchestrationError(error)) throw error;
      expect(error.code).toBe('SBO021');
    }
    expect(countOrchestrationEvents(fixture.workspace, state.orchestrationId)).toBe(0);
  });

  it('survives a partially written final line from a crash mid-append', () => {
    const fixture = setupOrchestrationFixture();
    const state = testOrchestrationState();
    createOrchestrationRun(fixture.workspace, state);
    appendOrchestrationEvent(
      fixture.workspace,
      state.orchestrationId,
      { at: '2026-08-01T09:00:00.000Z', type: 'orchestration_started' },
      { maxEventBytes: 8_192 },
    );
    const file = path.join(orchestrationDir(fixture.workspace, state.orchestrationId), 'events.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"at":"2026-08-01T09:00:01.000Z","ty`, 'utf8');

    const page = readOrchestrationEvents(fixture.workspace, state.orchestrationId);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.['type']).toBe('orchestration_started');
  });
});

describe('legacy workspaces', () => {
  it('a v1.0 workspace with no orchestration directory reads as empty', () => {
    const fixture = setupOrchestrationFixture();
    const result = listOrchestrationRuns(fixture.workspace);
    expect(result.runs).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('resolves a default orchestration policy for a config file without one', () => {
    const fixture = setupOrchestrationFixture();
    // The fixture writes a v1 config with no orchestration block at all.
    expect(fixture.config.orchestration.enabled).toBe(true);
    expect(fixture.config.orchestration.planning.mode).toBe('review');
    expect(fixture.config.orchestration.execution.maxIterations).toBe(12);
  });
});

describe('schema version constant', () => {
  it('is a semantic version', () => {
    expect(ORCHESTRATION_STATE_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
