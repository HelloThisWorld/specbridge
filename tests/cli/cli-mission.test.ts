import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import {
  createContractChangeRequest,
  markContractReady,
  readCcr,
  readContract,
} from '@specbridge/mission';
import type { MissionFixture } from '../helpers-mission.js';
import { coveredMission, setupMissionFixture, startedMission } from '../helpers-mission.js';

/**
 * `specbridge mission …` — the Mission Discovery CLI surface. Thin adapters
 * over @specbridge/mission: inspection, the recorded human decisions
 * (answer, ccr), and synthesis. Fully offline; no model is ever invoked.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(fixture: MissionFixture, ...argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd: fixture.root,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line) => stderr.push(`${line}\n`),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('mission begin / status / show', () => {
  it('creates a mission and lists it', async () => {
    const fixture = setupMissionFixture();
    const begun = await cli(fixture, 'mission', 'begin', 'steprelay', '--goal', 'Build StepRelay.', '--json');
    expect(begun.code).toBe(0);
    const mission = (parseJson(begun.stdout)['data'] as { mission: { missionId: string; status: string } }).mission;
    expect(mission.status).toBe('IDEA');

    const status = await cli(fixture, 'mission', 'status', '--json');
    const missions = (parseJson(status.stdout)['data'] as { missions: { missionId: string }[] }).missions;
    expect(missions.map((entry) => entry.missionId)).toContain(mission.missionId);
  });

  it('show surfaces blocking questions and the answer command', async () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    const { recordAssessment } = await import('@specbridge/mission');
    recordAssessment(fixture.deps, missionId, {
      questions: [
        {
          question: 'What is the wire protocol of action results?',
          whyItMatters: 'Protocol identity is irreversible.',
          topics: ['protocol-identity'],
        },
      ],
    });
    const shown = await cli(fixture, 'mission', 'show', missionId);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('Q-001');
    expect(shown.stdout).toContain('[blocking]');
    expect(shown.stdout).toContain('mission answer');
  });
});

describe('mission answer / coverage / synthesize', () => {
  it('answers a question from the CLI and reflects readiness in coverage', async () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const { recordAssessment } = await import('@specbridge/mission');
    const asked = recordAssessment(fixture.deps, covered.missionId, {
      questions: [
        {
          question: 'Must duplicate results be safe under at-least-once delivery semantics?',
          whyItMatters: 'Delivery semantics are compatibility promises.',
          topics: ['failure-semantics'],
        },
      ],
    });
    const answered = await cli(
      fixture,
      'mission',
      'answer',
      covered.missionId,
      asked.questionIds[0]!,
      'Yes,',
      'duplicates',
      'are',
      'idempotent.',
    );
    expect(answered.code).toBe(0);
    expect(answered.stdout).toMatch(/Recorded DEC-\d+/);
    expect(answered.stdout).toMatch(/coverage gate is satisfied/);

    const coverage = await cli(fixture, 'mission', 'coverage', covered.missionId, '--json');
    const data = parseJson(coverage.stdout)['data'] as { coverage: { contractReady: boolean } };
    expect(data.coverage.contractReady).toBe(true);
  });

  it('synthesize compiles the spec and prints the human approval commands', async () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const ready = await cli(fixture, 'mission', 'contract-ready', covered.missionId);
    expect(ready.code).toBe(0);
    const synthesized = await cli(fixture, 'mission', 'synthesize', covered.missionId);
    expect(synthesized.code).toBe(0);
    expect(synthesized.stdout).toMatch(/Synthesized spec "steprelay" with 1 objective/);
    expect(synthesized.stdout).toMatch(/spec approve steprelay --stage requirements/);
  });
});

describe('mission contracts / adr / decisions', () => {
  it('prints the constitution, registry, and decisions with provenance', async () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    const contracts = await cli(fixture, 'mission', 'contracts', covered.missionId);
    expect(contracts.code).toBe(0);
    expect(contracts.stdout).toContain('CTR-001 r1');
    expect(contracts.stdout).toContain('I1 (invariant)');

    const decisions = await cli(fixture, 'mission', 'decisions', covered.missionId);
    expect(decisions.stdout).toMatch(/DEC-001 \[active\]/);
    expect(decisions.stdout).toMatch(/provenance: known-from-user \(turn t-\d+\)/);
  });
});

describe('mission ccr — the human-only decision path', () => {
  it('lists, approves, and reports the resulting contract revision', async () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    createContractChangeRequest(fixture.deps, covered.missionId, {
      contractId: covered.contractId,
      problem: 'The contract cannot represent negative acknowledgement.',
      proposal: 'Add nack(message, requeuePolicy).',
      raisedBy: 'worker-builder-wu-2',
    });

    const listed = await cli(fixture, 'mission', 'ccr', covered.missionId);
    expect(listed.stdout).toContain('CCR-001 [NEEDS_HUMAN]');

    const approved = await cli(
      fixture,
      'mission',
      'ccr',
      covered.missionId,
      'CCR-001',
      '--approve',
      '--note',
      'RabbitMQ parity.',
    );
    expect(approved.code).toBe(0);
    expect(approved.stdout).toMatch(/now revision 2/);
    expect(approved.stdout).toMatch(/stale/);
    expect(readCcr(fixture.workspace, covered.missionId, 'CCR-001')?.status).toBe('APPROVED');
    expect(readContract(fixture.workspace, covered.missionId, covered.contractId)?.revision).toBe(2);
  });

  it('rejection leaves the contract untouched', async () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    createContractChangeRequest(fixture.deps, covered.missionId, {
      contractId: covered.contractId,
      problem: 'Problem.',
      proposal: 'Proposal.',
      raisedBy: 'cli',
    });
    const rejected = await cli(fixture, 'mission', 'ccr', covered.missionId, 'CCR-001', '--reject');
    expect(rejected.code).toBe(0);
    expect(readContract(fixture.workspace, covered.missionId, covered.contractId)?.revision).toBe(1);
  });
});

describe('mission lifecycle commands', () => {
  it('reopen and abandon transition the lifecycle', async () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    markContractReady(fixture.deps, covered.missionId);
    const reopened = await cli(fixture, 'mission', 'reopen', covered.missionId, '--reason', 'new material topic');
    expect(reopened.stdout).toMatch(/DISCOVERING/);
    const abandoned = await cli(fixture, 'mission', 'abandon', covered.missionId, '--reason', 'direction changed');
    expect(abandoned.stdout).toMatch(/ABANDONED/);
  });

  it('the help documents the mission surface', async () => {
    const fixture = setupMissionFixture();
    const help = await cli(fixture, 'mission', '--help');
    expect(help.code).toBe(0);
    for (const subcommand of ['begin', 'status', 'show', 'events', 'coverage', 'answer', 'synthesize', 'contracts', 'adr', 'ccr']) {
      expect(help.stdout).toContain(subcommand);
    }
  });
});
