import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MissionDeps } from '@specbridge/mission';
import {
  beginMission,
  markContractReady,
  observeSpecApproval,
  readCcrs,
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
  readAggregationReport,
  readCandidate,
  readConflicts,
  readEvaluations,
  readJobEvents,
  readLatestWorkGraph,
  requireGraphRevision,
  requireJobState,
} from '@specbridge/orchestration';
import { setupExecutionFixture } from '../helpers-execution.js';
import type { ExecutionFixture } from '../helpers-execution.js';

/**
 * Semantic aggregation (§10.2): several verified INVESTIGATION reports are
 * synthesized by one bounded AGGREGATOR dispatch — which may surface
 * cross-report contract conflicts but can never approve anything or pick a
 * side silently.
 */

const savedScenario = process.env['FAKE_CLAUDE_SCENARIO'];
afterEach(() => {
  if (savedScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
  else process.env['FAKE_CLAUDE_SCENARIO'] = savedScenario;
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function investigationsFixture(): ExecutionFixture & { driverDeps: DriverDeps; missionId: string } {
  const fixture = setupExecutionFixture({
    git: true,
    useFakeClaude: true,
    defaultRunner: 'claude-code',
    extraConfig: {
      orchestration: {
        jobs: { routing: { classifier: 'disabled', critic: 'disabled' }, planReview: 'auto' },
      },
    },
  });
  const missionDeps: MissionDeps = {
    workspace: fixture.workspace,
    clock: fixture.clock,
    idFactory: fixture.idFactory,
    host: 'test',
  };
  const mission = beginMission(missionDeps, { name: 'steprelay', goal: 'Build StepRelay, broker-neutral.' });
  const turn = recordTurn(missionDeps, mission.missionId, {
    speaker: 'user',
    kind: 'confirmation',
    text: 'Confirmed: broker-neutral transport with at-least-once semantics.',
  });
  const decided = recordAssessment(missionDeps, mission.missionId, {
    decisions: (
      [
        ['goal'],
        ['use-cases'],
        ['system-boundaries'],
        ['canonical-model'],
        ['public-api'],
        ['failure-semantics'],
        ['compatibility'],
      ] as const
    ).map(([topic]) => ({
      decision: `Decision covering ${topic}.`,
      provenance: 'known-from-user' as const,
      sourceTurnId: turn.turn.turnId,
      topics: [topic],
    })),
  });
  recordAssessment(missionDeps, mission.missionId, {
    contracts: [
      {
        title: 'Broker-neutral transport',
        summary: 'The transport seam every broker adapter implements.',
        classification: 'public',
        compatibilityPolicy: 'additive-only',
        requirements: [{ statement: 'A transport delivers action requests and returns results.' }],
        decisionIds: [decided.decisionIds[3]!],
      },
    ],
  });
  markContractReady(missionDeps, mission.missionId);
  synthesizeMissionSpec(missionDeps, mission.missionId);
  for (const stage of ['requirements', 'design', 'tasks'] as const) {
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, 'steprelay'));
    const approvedStage = approveStage(fixture.workspace, spec, { stage }, { clock: fixture.clock });
    if (!approvedStage.ok) throw new Error(`approval of ${stage} failed`);
  }
  observeSpecApproval(missionDeps, mission.missionId);
  git(fixture.root, 'add', '.kiro');
  git(fixture.root, 'commit', '-q', '-m', 'approved mission spec');
  return {
    ...fixture,
    missionId: mission.missionId,
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

describe('investigation units and semantic aggregation', () => {
  it('two investigations produce reports, get evaluated, aggregate into one synthesis, and inform the build', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-investigations';
    const fixture = investigationsFixture();
    const job = createJob(fixture.driverDeps, { specName: 'steprelay', goal: 'Implement the transport.' });
    const result = await driveJob(fixture.driverDeps, job.jobId, {});
    expect(result.stop.kind).toBe('completed');

    const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
    const nodeId = jobGraph.nodes[0]!.nodeId;
    const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, nodeId)!;
    const investigations = workGraph.units.filter((unit) => unit.kind === 'investigation');
    expect(investigations).toHaveLength(2);
    // Investigations end VERIFIED (they carry no repository change to integrate).
    expect(investigations.every((unit) => unit.status === 'VERIFIED_CANDIDATE')).toBe(true);
    expect(workGraph.units.find((unit) => unit.kind === 'build')?.status).toBe('INTEGRATED');

    // Reports exist as candidate claims and were SEMANTICALLY evaluated
    // (investigations always carry judgment under the auto policy).
    const kafka = readCandidate(fixture.workspace, job.jobId, nodeId, 'wu-1', 1);
    expect(kafka?.claims.report).toMatch(/at-least-once/);
    const semantic = readEvaluations(fixture.workspace, job.jobId, nodeId, 'wu-1').filter(
      (evaluation) => evaluation.layer === 'semantic',
    );
    expect(semantic.length).toBeGreaterThan(0);

    // One aggregation report synthesizes both, attributed to its sources.
    const report = readAggregationReport(
      fixture.workspace,
      job.jobId,
      nodeId,
      `aggregation-r${String(workGraph.revision).padStart(3, '0')}`,
    );
    expect(report).toBeDefined();
    expect(report?.['sources']).toEqual(['wu-1', 'wu-2']);
    expect(String(report?.['synthesis'])).toMatch(/at-least-once/);

    // The dependent build unit saw the investigation evidence in its projection.
    const events = readJobEvents(fixture.workspace, job.jobId, { limit: 500 }).events;
    expect(events.some((event) => event.type === 'aggregation_completed' && event['semantic'] === true)).toBe(true);
  }, 300_000);

  it('contradicting investigation reports become a recorded conflict that stops integration for a human', async () => {
    process.env['FAKE_CLAUDE_SCENARIO'] = 'aggregator-conflict';
    const fixture = investigationsFixture();
    const job = createJob(fixture.driverDeps, { specName: 'steprelay', goal: 'Implement the transport.' });
    const result = await driveJob(fixture.driverDeps, job.jobId, {});

    expect(result.stop.kind).toBe('needs-human');
    expect(requireJobState(fixture.workspace, job.jobId).status).toBe('NEEDS_CLARIFICATION');

    const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, requireJobState(fixture.workspace, job.jobId).graphRevision);
    const nodeId = jobGraph.nodes[0]!.nodeId;
    const conflicts = readConflicts(fixture.workspace, job.jobId, nodeId);
    expect(conflicts.some((conflict) => conflict.conflictId.startsWith('conflict-agg-'))).toBe(true);
    const aggregated = conflicts.find((conflict) => conflict.conflictId.startsWith('conflict-agg-'))!;
    // Both claims are preserved — nobody silently picked a side.
    expect(aggregated.claims).toHaveLength(2);
    expect(aggregated.claims.map((claim) => claim.workUnitId).sort()).toEqual(['wu-1', 'wu-2']);

    // Nothing integrated; the checkbox is untouched.
    const tasks = readFileSync(path.join(fixture.workspace.kiroDir, 'specs', 'steprelay', 'tasks.md'), 'utf8');
    expect(tasks).toMatch(/- \[ \] 1\./);
    // No CCR was invented from the conflict (suggestions were empty).
    expect(readCcrs(fixture.workspace, fixture.missionId)).toHaveLength(0);
  }, 300_000);
});
