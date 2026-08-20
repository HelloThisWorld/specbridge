import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MissionDeps } from '@specbridge/mission';
import {
  beginMission,
  markContractReady,
  observeSpecApproval,
  recordAssessment,
  recordTurn,
  synthesizeMissionSpec,
} from '@specbridge/mission';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { approveStage } from '@specbridge/workflow';
import type { DriverDeps } from '@specbridge/orchestration';
import {
  createJob,
  driveJob,
  readJobEvents,
  readLatestWorkGraph,
  readWorkerRecords,
  requireGraphRevision,
  requireJobState,
} from '@specbridge/orchestration';
import type { ExecutionFixture } from '../helpers-execution.js';
import { setupExecutionFixture } from '../helpers-execution.js';

/**
 * Objective-runtime resume and parallelism:
 *   - a job interrupted MID-OBJECTIVE resumes the SAME job, supersedes the
 *     interrupted worker identities, and completes
 *   - parallel builder execution is opt-in, bounded, and provably isolated
 */

const GOAL = 'Build StepRelay: a lightweight, config-driven, distributed workflow engine.';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

const savedScenario = process.env['FAKE_CLAUDE_SCENARIO'];
afterEach(() => {
  if (savedScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
  else process.env['FAKE_CLAUDE_SCENARIO'] = savedScenario;
});

interface Fixture extends ExecutionFixture {
  driverDeps: DriverDeps;
}

function missionFixture(jobs: Record<string, unknown> = {}): Fixture {
  const fixture = setupExecutionFixture({
    git: true,
    useFakeClaude: true,
    defaultRunner: 'claude-code',
    extraConfig: {
      orchestration: {
        jobs: { routing: { classifier: 'disabled', critic: 'disabled' }, planReview: 'auto', ...jobs },
      },
    },
  });
  const missionDeps: MissionDeps = {
    workspace: fixture.workspace,
    clock: fixture.clock,
    idFactory: fixture.idFactory,
    host: 'test',
  };
  const mission = beginMission(missionDeps, { name: 'steprelay', goal: GOAL });
  const turn = recordTurn(missionDeps, mission.missionId, { speaker: 'user', kind: 'confirmation', text: GOAL });
  const decided = recordAssessment(missionDeps, mission.missionId, {
    decisions: (
      [
        ['goal', 'A lightweight config-driven workflow engine.'],
        ['use-cases', 'Event-driven workflow orchestration.'],
        ['system-boundaries', 'Engine owns orchestration; actions own logic.'],
        ['canonical-model', 'A deterministic definition-interpreting kernel.'],
        ['public-api', 'The definition format and the action SDK.'],
        ['failure-semantics', 'At-least-once with idempotent completions.'],
        ['compatibility', 'Additive-only public evolution.'],
      ] as const
    ).map(([topic, decision]) => ({
      decision,
      provenance: 'known-from-user' as const,
      sourceTurnId: turn.turn.turnId,
      topics: [topic],
    })),
  });
  recordAssessment(missionDeps, mission.missionId, {
    contracts: [
      {
        title: 'Event-driven execution',
        summary: 'The canonical envelope and result protocol.',
        classification: 'public',
        compatibilityPolicy: 'additive-only',
        requirements: [
          { statement: 'An action request dispatch is supported.' },
          { statement: 'An action result resumes execution.' },
        ],
        decisionIds: [decided.decisionIds[3]!],
      },
    ],
  });
  markContractReady(missionDeps, mission.missionId);
  synthesizeMissionSpec(missionDeps, mission.missionId);
  for (const stage of ['requirements', 'design', 'tasks'] as const) {
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, 'steprelay'));
    const result = approveStage(fixture.workspace, spec, { stage }, { clock: fixture.clock });
    if (!result.ok) throw new Error(`approval of ${stage} failed`);
  }
  observeSpecApproval(missionDeps, mission.missionId);
  git(fixture.root, 'add', '.kiro');
  git(fixture.root, 'commit', '-q', '-m', 'approved mission spec');
  return {
    ...fixture,
    driverDeps: {
      workspace: fixture.workspace,
      config: fixture.config,
      registry: fixture.registry,
      clock: fixture.clock,
      idFactory: fixture.idFactory,
      host: 'test',
    },
  };
}

describe('objective interruption and resume', () => {
  it('an aborted drive resumes the SAME job, supersedes interrupted workers, and completes', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    const fixture = missionFixture();
    const job = createJob(fixture.driverDeps, { specName: 'steprelay', goal: 'Implement StepRelay.' });

    // Interrupt as soon as the first builder starts.
    const controller = new AbortController();
    const interrupted = await driveJob(fixture.driverDeps, job.jobId, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === 'note' || event.message.includes('BUILDER')) controller.abort();
      },
    });
    // Whatever the exact stop point, the job is NOT final and NOT completed.
    expect(['interrupted', 'blocked', 'needs-human']).toContain(interrupted.stop.kind);
    const midState = requireJobState(fixture.workspace, job.jobId);
    expect(midState.status).not.toBe('COMPLETED');

    // Resume the SAME job to completion.
    const resumed = await driveJob(fixture.driverDeps, job.jobId, {});
    expect(resumed.stop.kind).toBe('completed');
    expect(resumed.job.jobId).toBe(job.jobId);
    const events = readJobEvents(fixture.workspace, job.jobId, { limit: 500 }).events.map((event) => event.type);
    expect(events).toContain('job_resumed');
    expect(events).toContain('objective_verified');

    // No worktree survived; no worker record is stuck RUNNING.
    const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, resumed.job.graphRevision);
    const workers = readWorkerRecords(fixture.workspace, job.jobId, jobGraph.nodes[0]!.nodeId);
    expect(workers.every((record) => record.status !== 'RUNNING')).toBe(true);
    expect(git(fixture.root, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  }, 300_000);
});

describe('parallel builder execution (opt-in)', () => {
  it('disabled by default: builders run one at a time', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    const fixture = missionFixture();
    const job = createJob(fixture.driverDeps, { specName: 'steprelay', goal: 'Implement StepRelay.' });
    const notes: string[] = [];
    const result = await driveJob(fixture.driverDeps, job.jobId, {
      onEvent: (event) => notes.push(event.message),
    });
    expect(result.stop.kind).toBe('completed');
    expect(notes.some((note) => note.includes('in parallel'))).toBe(false);
  }, 300_000);

  it('enabled: independent units build concurrently in isolated worktrees and still integrate once', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    const fixture = missionFixture({
      objectives: { parallelism: { enabled: true, maxConcurrentBuilders: 2 } },
    });
    const job = createJob(fixture.driverDeps, { specName: 'steprelay', goal: 'Implement StepRelay.' });
    const notes: string[] = [];
    const result = await driveJob(fixture.driverDeps, job.jobId, {
      onEvent: (event) => notes.push(event.message),
    });
    expect(result.stop.kind).toBe('completed');
    expect(notes.some((note) => note.includes('2 independent builders in parallel'))).toBe(true);

    // Both units produced isolated candidates; ONE integration run applied
    // them; the evidence pipeline completed the objective exactly once.
    const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
    const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, jobGraph.nodes[0]!.nodeId);
    expect(workGraph!.units.filter((unit) => unit.status === 'INTEGRATED')).toHaveLength(2);
    const events = readJobEvents(fixture.workspace, job.jobId, { limit: 500 }).events;
    expect(events.filter((event) => event.type === 'integration_started')).toHaveLength(1);
    expect(existsSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'))).toBe(true);
    expect(existsSync(path.join(fixture.root, 'src', 'transport', 'implementation.js'))).toBe(true);
    const tasks = readFileSync(path.join(fixture.workspace.kiroDir, 'specs', 'steprelay', 'tasks.md'), 'utf8');
    expect(tasks).toMatch(/- \[x\] 1\./);
  }, 300_000);
});
