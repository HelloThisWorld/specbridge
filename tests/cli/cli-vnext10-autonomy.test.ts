import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { HARD_HUMAN_AUTHORITY_SURFACES } from '@specbridge/core';
import { listSeals, readClosureLedger } from '@specbridge/autonomy';
import type { AutonomyFixture } from '../helpers-autonomy.js';
import { sealableMission, sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * `specbridge autonomy …` and `specbridge overnight …`.
 *
 * The surface is deliberately tiny, and these tests hold it to that: four
 * commands do everything an operator needs, `autonomy seal --confirm` is the
 * one that carries human authority, and every inspection command is
 * read-only. A CLI whose inspection commands mutated state would make
 * "inspection is not required for progress" impossible to guarantee.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(fixture: AutonomyFixture, ...argv: string[]): Promise<CliResult> {
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

describe('autonomy setup', () => {
  it('writes the OVERNIGHT preset and preserves the rest of the config', async () => {
    const fixture = setupAutonomyFixture({ interactive: true });
    const before = JSON.parse(
      readFileSync(path.join(fixture.root, '.specbridge', 'config.json'), 'utf8'),
    ) as Record<string, unknown>;

    const result = await cli(fixture, 'autonomy', 'setup', '--mode', 'overnight', '--json');
    expect(result.code).toBe(0);
    const data = parseJson(result.stdout).data as Record<string, unknown>;
    expect(data['mode']).toBe('OVERNIGHT');
    expect(data['humanGate']).toBe('AUTHORITY_ONLY');

    const after = JSON.parse(
      readFileSync(path.join(fixture.root, '.specbridge', 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(after['runnerProfiles']).toEqual(before['runnerProfiles']);
    expect(after['verification']).toEqual(before['verification']);
  });

  it('leaves control-plane repair off unless a source path is supplied', async () => {
    const fixture = setupAutonomyFixture({ interactive: true });
    await cli(fixture, 'autonomy', 'setup', '--mode', 'overnight');
    const config = JSON.parse(
      readFileSync(path.join(fixture.root, '.specbridge', 'config.json'), 'utf8'),
    ) as { autonomy: { controlPlaneRepair: { enabled: boolean } } };
    expect(config.autonomy.controlPlaneRepair.enabled).toBe(false);

    await cli(fixture, 'autonomy', 'setup', '--mode', 'overnight', '--specbridge-source', '.');
    const withSource = JSON.parse(
      readFileSync(path.join(fixture.root, '.specbridge', 'config.json'), 'utf8'),
    ) as { autonomy: { controlPlaneRepair: { enabled: boolean; sourcePath?: string } } };
    expect(withSource.autonomy.controlPlaneRepair.enabled).toBe(true);
    expect(withSource.autonomy.controlPlaneRepair.sourcePath).toBeDefined();
  });

  it('refuses an unknown mode rather than guessing', async () => {
    const fixture = setupAutonomyFixture();
    const result = await cli(fixture, 'autonomy', 'setup', '--mode', 'YOLO');
    expect(result.code).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Unknown autonomy mode/);
  });
});

describe('autonomy policy', () => {
  it('prints the authority boundary alongside the delegated surfaces', async () => {
    const fixture = setupAutonomyFixture();
    const result = await cli(fixture, 'autonomy', 'policy');
    expect(result.code).toBe(0);
    for (const surface of HARD_HUMAN_AUTHORITY_SURFACES) {
      expect(result.stdout).toContain(surface);
    }
    expect(result.stdout).toMatch(/No configuration, agent, or model can move any of these/);
  });
});

describe('autonomy seal', () => {
  it('drafts without --confirm and does not authorize', async () => {
    const fixture = setupAutonomyFixture();
    const { missionId } = sealableMission(fixture);
    const result = await cli(fixture, 'autonomy', 'seal', missionId, '--json');
    expect(result.code).toBe(0);
    const data = parseJson(result.stdout).data as Record<string, unknown>;
    expect(data['status']).toBe('DRAFT');
    expect(listSeals(fixture.workspace).every((seal) => seal.status === 'DRAFT')).toBe(true);
  });

  it('authorizes with --confirm and reports the sealed authority', async () => {
    const fixture = setupAutonomyFixture();
    const { missionId } = sealableMission(fixture);
    const result = await cli(fixture, 'autonomy', 'seal', missionId, '--confirm', '--json');
    expect(result.code).toBe(0);
    const data = parseJson(result.stdout).data as Record<string, unknown>;
    expect(data['status']).toBe('SEALED');
    expect(Number(data['contracts'])).toBeGreaterThan(0);
    expect(Number(data['acceptanceCriteria'])).toBeGreaterThan(0);
    expect(String(data['authorityDigest']).length).toBeGreaterThan(0);
  });

  it('refuses an incomplete seal with the gaps named, exit 1', async () => {
    const fixture = setupAutonomyFixture();
    const { beginMission } = await import('@specbridge/mission');
    const mission = beginMission(fixture.mission.deps, {
      name: 'bare',
      goal: 'Build something unspecified.',
    });
    const result = await cli(fixture, 'autonomy', 'seal', mission.missionId, '--confirm');
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Not authorizable/);
    expect(result.stdout).toMatch(/CONTRACTS/);
  });

  it('lists seals and revokes one', async () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);

    const listed = await cli(fixture, 'autonomy', 'seals', '--json');
    const seals = (parseJson(listed.stdout).data as { seals: { sealId: string }[] }).seals;
    expect(seals.some((entry) => entry.sealId === seal.sealId)).toBe(true);

    const revoked = await cli(
      fixture,
      'autonomy',
      'revoke',
      seal.sealId,
      '--reason',
      'direction changed',
    );
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toMatch(/REVOKED/);
  });
});

describe('overnight preflight', () => {
  it('refuses an unsealed mission with exit 1 and names what a person must do', async () => {
    const fixture = setupAutonomyFixture();
    const { missionId } = sealableMission(fixture);
    const result = await cli(fixture, 'overnight', 'preflight', missionId);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/SEAL_PRESENT/);
    expect(result.stdout).toMatch(/HUMAN_ACTION_REQUIRED|INDETERMINATE/);
  });

  it('reports the checks and never leaks a credential-shaped value', async () => {
    const fixture = setupAutonomyFixture();
    sealedMission(fixture);
    const result = await cli(fixture, 'overnight', 'preflight', 'steprelay', '--json');
    const serialized = result.stdout.toLowerCase();
    for (const forbidden of ['api_key', 'apikey', 'secret', 'password', 'bearer ']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    const data = parseJson(result.stdout).data as { checks: unknown[] };
    expect(data.checks.length).toBeGreaterThan(10);
  });
});

describe('overnight run', () => {
  it('refuses a mission with no authorized seal', async () => {
    const fixture = setupAutonomyFixture();
    const { missionId } = sealableMission(fixture);
    const result = await cli(fixture, 'overnight', 'run', missionId);
    expect(result.code).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/no authorized seal/);
  });
});

describe('inspection is read-only', () => {
  it('status, report, toolsmith, supervision, repairs, certification change nothing', async () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    const { createJob } = await import('@specbridge/orchestration');
    const { bindSealToJob, buildClosureLedger } = await import('@specbridge/autonomy');
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement the sealed product intent.',
    });
    bindSealToJob(fixture.deps, job.jobId, seal.sealId);
    const before = buildClosureLedger(fixture.deps, { jobId: job.jobId, seal });

    for (const argv of [
      ['autonomy', 'status'],
      ['autonomy', 'report', job.jobId],
      ['autonomy', 'toolsmith', job.jobId],
      ['autonomy', 'supervision'],
      ['autonomy', 'repairs'],
      ['autonomy', 'certification'],
    ]) {
      const result = await cli(fixture, ...argv);
      expect(result.code, argv.join(' ')).toBe(0);
    }

    const after = readClosureLedger(fixture.workspace, job.jobId);
    expect(after?.entries.length).toBe(before.entries.length);
    expect(after?.phase).toBe(before.phase);
    expect(after?.gapCycles).toBe(before.gapCycles);
  });

  it('the report names unclosed items and prints n/a for unknown measurements', async () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    const { createJob } = await import('@specbridge/orchestration');
    const { bindSealToJob, buildClosureLedger } = await import('@specbridge/autonomy');
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement the sealed product intent.',
    });
    bindSealToJob(fixture.deps, job.jobId, seal.sealId);
    buildClosureLedger(fixture.deps, { jobId: job.jobId, seal });

    const result = await cli(fixture, 'autonomy', 'report', job.jobId);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Contract closure/);
    expect(result.stdout).toMatch(/NOT_STARTED/);
    // No provider reported a cost, so the report says so rather than $0.00.
    expect(result.stdout).toMatch(/cost n\/a/);
    expect(result.stdout).not.toMatch(/cost \$0\.0000/);
  });
});
