import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MissionDeps } from '@specbridge/mission';
import {
  answerQuestion as answerMissionQuestion,
  decideContractChangeRequest,
  markContractReady,
  observeSpecApproval,
  readCcrs,
  readContract,
  recordAssessment,
  recordTurn,
  beginMission,
  synthesizeMissionSpec,
} from '@specbridge/mission';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { approveStage } from '@specbridge/workflow';
import type { DriverDeps } from '@specbridge/orchestration';
import {
  answerClarification,
  createJob,
  driveJob,
  evaluateProjectionFreshness,
  readCandidate,
  readCandidatePatch,
  readConflicts,
  readJobEvents,
  readLatestWorkGraph,
  readProjection,
  readWorkerRecords,
  requireGraphRevision,
  requireJobState,
} from '@specbridge/orchestration';
import type { ExecutionFixture } from '../helpers-execution.js';
import { setupExecutionFixture } from '../helpers-execution.js';

/**
 * The StepRelay dogfood: the complete mission-driven flow of §Definition-of-
 * Done, fully offline against the fake Claude CLI.
 *
 *   high-level direction → discovery (blocking questions, decisions,
 *   constitution, contracts) → CONTRACT_READY → synthesis → human approval →
 *   persistent job → DECOMPOSER → isolated builders → deterministic (and
 *   policy-gated semantic) evaluation → structural aggregation →
 *   single-writer integration → the UNCHANGED evidence pipeline → a flipped
 *   checkbox that only evidence could flip.
 */

const GOAL =
  'Build StepRelay: a lightweight, config-driven, distributed workflow engine for event-driven ' +
  'systems. Workflow owns orchestration. Actions own business logic. The engine should be ' +
  'broker-neutral and extensible.';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

interface SteprelayFixture extends ExecutionFixture {
  missionDeps: MissionDeps;
  missionId: string;
  driverDeps: DriverDeps;
  contractId: string;
}

const savedScenario = process.env['FAKE_CLAUDE_SCENARIO'];
afterEach(() => {
  if (savedScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
  else process.env['FAKE_CLAUDE_SCENARIO'] = savedScenario;
});

function setScenario(scenario: string): void {
  process.env['FAKE_CLAUDE_SCENARIO'] = scenario;
}

/** Discovery → contracts → synthesis → approval → committed baseline. */
function steprelayFixture(jobs: Record<string, unknown> = {}): SteprelayFixture {
  const fixture = setupExecutionFixture({
    git: true,
    useFakeClaude: true,
    defaultRunner: 'claude-code',
    extraConfig: {
      orchestration: {
        jobs: {
          // The objective pipeline is under test; the node pipeline stays
          // deterministic (no classifier/critic round-trips per node).
          routing: { classifier: 'disabled', critic: 'disabled' },
          planReview: 'auto',
          ...jobs,
        },
      },
    },
  });
  const missionDeps: MissionDeps = {
    workspace: fixture.workspace,
    clock: fixture.clock,
    idFactory: fixture.idFactory,
    host: 'test',
  };

  // --- Discovery -----------------------------------------------------------
  const mission = beginMission(missionDeps, { name: 'steprelay', goal: GOAL });
  const missionId = mission.missionId;
  recordTurn(missionDeps, missionId, { speaker: 'user', kind: 'statement', text: GOAL });

  // SpecBridge identifies unresolved material topics: the blocking question.
  const asked = recordAssessment(missionDeps, missionId, {
    questions: [
      {
        question: 'May an action determine the next workflow state, or does the definition own all control flow?',
        whyItMatters: 'It fixes the canonical runtime model and the public wire protocol of every action result.',
        topics: ['canonical-model', 'protocol-identity'],
      },
      {
        question: 'Should the internal scheduler use a heap or a sorted list?',
        whyItMatters: 'Only affects internal implementation cost.',
        topics: ['performance'],
        materiality: 'implementation-detail',
      },
    ],
  });
  const blocking = asked.questionIds[0]!;
  expect(asked.mission.status).toBe('NEEDS_DECISION');
  // The implementation-detail question did not block anything.
  expect(asked.coverage.blockingQuestionIds).toEqual([blocking]);

  answerMissionQuestion(missionDeps, missionId, {
    questionId: blocking,
    answer: 'The workflow definition owns all control flow; actions never determine transitions.',
  });

  const confirm = recordTurn(missionDeps, missionId, {
    speaker: 'user',
    kind: 'confirmation',
    text: 'Confirmed: broker-neutral engine, at-least-once delivery, idempotent duplicate results, additive public contracts.',
  });
  const decided = recordAssessment(missionDeps, missionId, {
    decisions: [
      { decision: 'StepRelay is a lightweight config-driven distributed workflow engine.', provenance: 'known-from-user', sourceTurnId: confirm.turn.turnId, topics: ['goal'] },
      { decision: 'Primary use case: orchestrating event-driven workflows across services.', provenance: 'known-from-user', sourceTurnId: confirm.turn.turnId, topics: ['use-cases'] },
      { decision: 'The engine owns orchestration; user services own business logic via actions.', provenance: 'known-from-user', sourceTurnId: confirm.turn.turnId, topics: ['system-boundaries', 'architecture-ownership'] },
      { decision: 'The public API is the workflow definition format plus the action SDK.', provenance: 'known-from-user', sourceTurnId: confirm.turn.turnId, topics: ['public-api'] },
      { decision: 'Delivery is at-least-once; duplicate and late action results must be safe.', provenance: 'known-from-user', sourceTurnId: confirm.turn.turnId, topics: ['failure-semantics', 'idempotency'] },
      { decision: 'Public contracts evolve additively within a major version.', provenance: 'known-from-user', sourceTurnId: confirm.turn.turnId, topics: ['compatibility', 'evolution-rules'] },
    ],
  });
  const modelDecision = decided.decisionIds[2]!;

  const withRules = recordAssessment(missionDeps, missionId, {
    constitutionRules: [
      { statement: 'Workflow definition is the sole authority for control flow.', decisionIds: [modelDecision] },
      {
        statement: 'Actions never determine workflow transitions.',
        decisionIds: [modelDecision],
        guardPatterns: ['nextState\\s*[:=]'],
      },
      { statement: 'Duplicate external results must be safe.', decisionIds: [decided.decisionIds[4]!] },
    ],
  });
  const conRule = withRules.constitutionRuleIds[1]!;

  const withContract = recordAssessment(missionDeps, missionId, {
    contracts: [
      {
        title: 'Event-driven execution',
        summary: 'The canonical envelope and result protocol for event-driven action execution.',
        classification: 'public',
        compatibilityPolicy: 'additive-only',
        requirements: [
          { statement: 'An action request dispatch is supported for every workflow step.' },
          { statement: 'An action result resumes exactly the execution that requested it.' },
        ],
        invariants: [
          {
            statement: 'An action result never carries a next-state directive.',
            constitutionRuleIds: [conRule],
            guardPatterns: ['nextState\\s*[:=]'],
          },
        ],
        decisionIds: [modelDecision, decided.decisionIds[4]!],
      },
    ],
  });
  const contractId = withContract.contractIds[0]!;

  // --- Contract freeze and synthesis ----------------------------------------
  markContractReady(missionDeps, missionId);
  const synthesized = synthesizeMissionSpec(missionDeps, missionId);
  expect(synthesized.specName).toBe('steprelay');
  expect(synthesized.objectiveCount).toBe(1);

  // --- The HUMAN approval lifecycle, unchanged -------------------------------
  for (const stage of ['requirements', 'design', 'tasks'] as const) {
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, 'steprelay'));
    const result = approveStage(fixture.workspace, spec, { stage }, { clock: fixture.clock });
    if (!result.ok) throw new Error(`approval of ${stage} failed: ${result.message}`);
  }
  expect(observeSpecApproval(missionDeps, missionId).status).toBe('APPROVED');

  // The approved spec becomes part of the committed baseline, as a user would.
  git(fixture.root, 'add', '.kiro');
  git(fixture.root, 'commit', '-q', '-m', 'steprelay: approved mission spec');

  return {
    ...fixture,
    missionDeps,
    missionId,
    contractId,
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

describe('StepRelay mission-driven execution (dogfood)', () => {
  it('decomposes dynamically, builds in isolation, evaluates, aggregates, integrates, and completes only through evidence', async () => {
    setScenario('objective-multi');
    const fixture = steprelayFixture();
    const job = createJob(fixture.driverDeps, { specName: 'steprelay', goal: 'Implement StepRelay.' });

    const result = await driveJob(fixture.driverDeps, job.jobId, {});
    expect(result.stop.kind).toBe('completed');
    expect(result.job.status).toBe('COMPLETED');

    // The objective decomposed into MULTIPLE work units plus integration.
    const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
    const nodeId = jobGraph.nodes[0]!.nodeId;
    const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, nodeId);
    expect(workGraph).toBeDefined();
    expect(workGraph!.units.length).toBe(3);
    expect(workGraph!.units.filter((unit) => unit.kind === 'build').every((unit) => unit.status === 'INTEGRATED')).toBe(true);

    // Isolation: every worker got its OWN projection with its own hash, and
    // no projection carries any conversation.
    const first = readProjection(fixture.workspace, job.jobId, nodeId, 'wu-1', 1);
    const second = readProjection(fixture.workspace, job.jobId, nodeId, 'wu-2', 1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.contentHash).not.toBe(second!.contentHash);
    expect(JSON.stringify(first)).not.toMatch(/conversation|transcript|chat/i);
    // Both saw the same approved contract snapshot.
    expect(first!.contractSnapshotHash).toBe(second!.contractSnapshotHash);

    // Candidates with real observed diffs and worker identity records exist.
    for (const unitId of ['wu-1', 'wu-2']) {
      const candidate = readCandidate(fixture.workspace, job.jobId, nodeId, unitId, 1);
      expect(candidate?.changedFiles.length).toBeGreaterThan(0);
      expect(readCandidatePatch(fixture.workspace, job.jobId, nodeId, unitId, 1)).toMatch(/diff --git/);
    }
    const workers = readWorkerRecords(fixture.workspace, job.jobId, nodeId);
    expect(workers.filter((record) => record.agentRole === 'BUILDER')).toHaveLength(2);
    expect(workers.every((record) => record.status === 'FINISHED')).toBe(true);
    expect(workers.every((record) => record.workspaceIdentity.startsWith('worktree:'))).toBe(true);

    // The single canonical integrator applied both candidates; the evidence
    // pipeline (not any worker) flipped the checkbox.
    const tasks = readFileSync(path.join(fixture.workspace.kiroDir, 'specs', 'steprelay', 'tasks.md'), 'utf8');
    expect(tasks).toMatch(/- \[x\] 1\. Event-driven execution/);
    expect(existsSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'))).toBe(true);
    expect(existsSync(path.join(fixture.root, 'src', 'transport', 'implementation.js'))).toBe(true);

    // Semantic runtime events, in causal order categories.
    const events = readJobEvents(fixture.workspace, job.jobId, { limit: 500 }).events.map((event) => event.type);
    for (const expected of [
      'workgraph_proposed',
      'workgraph_created',
      'worker_started',
      'candidate_ready',
      'evaluation_passed',
      'aggregation_completed',
      'integration_ready',
      'objective_verified',
      'node_completed',
      'job_completed',
    ]) {
      expect(events, `event ${expected}`).toContain(expected);
    }

    // No worktree survives the run.
    expect(existsSync(path.join(fixture.root, '.specbridge', 'jobs', job.jobId, 'worktrees', 'wu-1-a01'))).toBe(false);
    expect(git(fixture.root, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  }, 300_000);

  it('detects the nextState contract conflict deterministically and refuses to integrate it', async () => {
    setScenario('builder-conflict');
    const fixture = steprelayFixture();
    const job = createJob(fixture.driverDeps, { specName: 'steprelay', goal: 'Implement StepRelay.' });

    const result = await driveJob(fixture.driverDeps, job.jobId, {});
    expect(result.stop.kind).toBe('needs-human');
    expect(requireJobState(fixture.workspace, job.jobId).status).toBe('NEEDS_CLARIFICATION');

    const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
    const nodeId = jobGraph.nodes[0]!.nodeId;
    const conflicts = readConflicts(fixture.workspace, job.jobId, nodeId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.decisionKind).toBe('architecture-contract-change');
    expect(conflicts[0]?.status).toBe('OPEN');
    expect(conflicts[0]?.claims[0]?.claim).toMatch(/nextState/);

    // Nothing was integrated: the checkbox is untouched and the canonical
    // tree carries no builder change.
    const tasks = readFileSync(path.join(fixture.workspace.kiroDir, 'specs', 'steprelay', 'tasks.md'), 'utf8');
    expect(tasks).toMatch(/- \[ \] 1\. Event-driven execution/);
    expect(existsSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'))).toBe(false);
    const events = readJobEvents(fixture.workspace, job.jobId, { limit: 500 }).events.map((event) => event.type);
    expect(events).toContain('contract_conflict_detected');
    expect(events).not.toContain('objective_verified');
  }, 300_000);

  it('a discovered contract gap becomes a CCR; the human decision revises the contract; stale projections replan; the job completes', async () => {
    setScenario('builder-ccr');
    const fixture = steprelayFixture();
    const job = createJob(fixture.driverDeps, { specName: 'steprelay', goal: 'Implement StepRelay.' });

    // First drive: the builder reports the missing-nack gap → material CCR
    // → execution stops for human authority.
    const first = await driveJob(fixture.driverDeps, job.jobId, {});
    expect(first.stop.kind).toBe('needs-human');
    const ccrs = readCcrs(fixture.workspace, fixture.missionId);
    expect(ccrs).toHaveLength(1);
    expect(ccrs[0]?.status).toBe('NEEDS_HUMAN');
    expect(ccrs[0]?.proposal).toMatch(/nack/);
    expect(ccrs[0]?.originJobId).toBe(job.jobId);

    // The old projection is stale the moment the human approves revision 2.
    const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, requireJobState(fixture.workspace, job.jobId).graphRevision);
    const nodeId = jobGraph.nodes[0]!.nodeId;
    const staleProjection = readProjection(fixture.workspace, job.jobId, nodeId, 'wu-1', 1);
    expect(staleProjection).toBeDefined();

    const decided = decideContractChangeRequest(fixture.missionDeps, fixture.missionId, {
      ccrId: ccrs[0]!.ccrId,
      decision: 'approved',
      note: 'RabbitMQ parity requires negative acknowledgement.',
    });
    expect(decided.contract?.revision).toBe(2);
    const freshness = evaluateProjectionFreshness(staleProjection!, {
      contracts: [{ contractId: fixture.contractId, revision: 2 }],
      constitutionVersion: 3,
    });
    expect(freshness.fresh).toBe(false);

    // The human answers the job's open question; the builder proceeds under
    // the REVISED contract on the next attempt.
    setScenario('success');
    const jobState = requireJobState(fixture.workspace, job.jobId);
    answerClarification(fixture.driverDeps, job.jobId, [
      {
        questionId: jobState.openQuestions[0]!.id,
        answer: 'CCR-001 is approved; continue under contract revision 2.',
      },
    ]);
    const second = await driveJob(fixture.driverDeps, job.jobId, {});
    expect(second.stop.kind).toBe('completed');

    // The retry attempt saw revision 2 — provable from its stored projection.
    const retryProjection = readProjection(fixture.workspace, job.jobId, nodeId, 'wu-1', 2);
    expect(retryProjection).toBeDefined();
    expect(retryProjection!.contracts[0]?.revision).toBe(2);
    expect(retryProjection!.contractSnapshotHash).not.toBe(staleProjection!.contractSnapshotHash);
    expect(readContract(fixture.workspace, fixture.missionId, fixture.contractId)?.requirements.at(-1)?.statement).toMatch(/nack/);
  }, 300_000);

  it('a persistently failing verifier fails the unit, blocks integration structurally, and never completes anything', async () => {
    setScenario('objective-multi');
    const fixture = steprelayFixture({
      budgets: { maxRepairCyclesPerTask: 0, maxReplansPerTask: 0, maxJobReplans: 0, maxTaskAttempts: 1 },
    });
    // Replace the passing verifier with one that always fails: local
    // verification inside the worktrees fails, so no candidate ever verifies.
    const configPath = path.join(fixture.root, '.specbridge', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    (config as { verification: { commands: unknown[] } }).verification.commands = [
      { name: 'always-fails', argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 60_000, required: true },
    ];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const { readAgentConfig } = await import('@specbridge/core');
    const reread = readAgentConfig(fixture.workspace);
    const driverDeps: DriverDeps = { ...fixture.driverDeps, config: reread.config! };

    const job = createJob(driverDeps, { specName: 'steprelay', goal: 'Implement StepRelay.' });
    const result = await driveJob(driverDeps, job.jobId, {});

    // The honest outcome is a stop — never a completion.
    expect(['blocked', 'needs-human']).toContain(result.stop.kind);
    const tasks = readFileSync(path.join(fixture.workspace.kiroDir, 'specs', 'steprelay', 'tasks.md'), 'utf8');
    expect(tasks).toMatch(/- \[ \] 1\. Event-driven execution/);
    const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, requireJobState(fixture.workspace, job.jobId).graphRevision);
    const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, jobGraph.nodes[0]!.nodeId);
    expect(workGraph?.units.some((unit) => unit.status === 'FAILED')).toBe(true);
    const events = readJobEvents(fixture.workspace, job.jobId, { limit: 500 }).events.map((event) => event.type);
    expect(events).toContain('evaluation_failed');
    expect(events).not.toContain('objective_verified');
  }, 300_000);
});
