import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { readSpecState } from '@specbridge/core';
import { listSpecIntakes } from '@specbridge/intake';
import { setupIntakeFixture } from '../helpers-intake.js';
import type { IntakeFixture } from '../helpers-intake.js';
import { goldenSpecText, unambiguousSpecText } from '../helpers-intake.js';

/**
 * `specbridge spec start|discover|answer|intake` and `spec approve --build`
 * — the vNext.10.1 product surface.
 *
 * Four commands and one flag. The tests assert two things a user would
 * notice immediately if either broke:
 *
 *   the new path never requires a lifecycle command, and
 *   the OLD per-stage approval works exactly as it always did.
 *
 * Every invocation goes through the real `runCli`, so option parsing,
 * exit codes, and the JSON envelope are exercised rather than the service
 * functions underneath them.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line) => stderr.push(`${line}\n`),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

/** The CLI JSON envelope is { schema, generator, data }. */
function jsonOf(result: CliResult): Record<string, unknown> {
  const parsed = JSON.parse(result.stdout) as { schema: string; data: Record<string, unknown> };
  expect(typeof parsed.schema).toBe('string');
  return parsed.data;
}

function writeSpecFile(fixture: IntakeFixture, name: string, content: string): string {
  const file = path.join(fixture.root, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('spec intake CLI — the product workflow', () => {
  it('starts an intake from a file and reports the product questions', async () => {
    const fixture = setupIntakeFixture();
    const file = writeSpecFile(fixture, 'demo-spec.md', goldenSpecText());

    const started = await cli(fixture.root, 'spec', 'start', 'airport-demo', '--file', file);
    expect(started.code).toBe(0);
    expect(started.stdout).toContain('Spec intake');
    expect(started.stdout).toContain('product question(s) need your decision');
    // Every question carries the context needed to answer it without any
    // SpecBridge vocabulary.
    expect(started.stdout).toContain('Why it matters:');
    expect(started.stdout).toContain('Affects:');
    expect(started.stdout).toContain('Not answered by evidence:');
    expect(started.stdout).toContain('Step Functions');

    const intakes = listSpecIntakes(fixture.intake).intakes;
    expect(intakes).toHaveLength(1);
    expect(intakes[0]?.name).toBe('airport-demo');
    expect(intakes[0]?.status).toBe('AWAITING_PRODUCT_ANSWERS');
  });

  it('refuses a start with no specification, and with two', async () => {
    const fixture = setupIntakeFixture();
    const none = await cli(fixture.root, 'spec', 'start', 'x');
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/--file|--text|--stdin/);

    const file = writeSpecFile(fixture, 'a.md', unambiguousSpecText());
    const both = await cli(fixture.root, 'spec', 'start', 'x', '--file', file, '--text', 'hi');
    expect(both.code).toBe(2);
    expect(both.stderr).toMatch(/exactly one/i);
  });

  it('answers a question and converges to a ready specification', async () => {
    const fixture = setupIntakeFixture();
    const file = writeSpecFile(fixture, 'demo-spec.md', goldenSpecText());
    await cli(fixture.root, 'spec', 'start', 'airport-demo', '--file', file);

    const listed = await cli(fixture.root, 'spec', 'discover', 'airport-demo', '--json');
    const questions = (jsonOf(listed)['questions'] as { questionId: string; options: string[] }[])
      .filter((question) => (question as unknown as { status: string }).status === 'open');
    expect(questions.length).toBe(4);

    for (const question of questions) {
      const answered = await cli(
        fixture.root,
        'spec',
        'answer',
        'airport-demo',
        question.questionId,
        question.options[0] ?? 'The strict reading holds.',
      );
      expect(answered.code).toBe(0);
      expect(answered.stdout).toContain(`Recorded your answer to ${question.questionId}`);
    }

    const ready = await cli(fixture.root, 'spec', 'discover', 'airport-demo');
    expect(ready.code).toBe(0);
    expect(ready.stdout).toContain('Specification ready.');
    // The approval summary is product language, and it names the one number
    // that matters before authorizing.
    expect(ready.stdout).toContain('New product surfaces');
    expect(ready.stdout).toContain('Existing contracts affected');
    expect(ready.stdout).toContain('none — no existing sealed contract is modified');
    expect(ready.stdout).toContain('Remaining blockers: 0');
    expect(ready.stdout).toContain('spec approve airport-demo --build');
  });

  it('approves once and builds without a single lifecycle command', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const file = writeSpecFile(fixture, 'demo-spec.md', unambiguousSpecText());
    const started = await cli(fixture.root, 'spec', 'start', 'settings-export', '--file', file);
    expect(started.stdout).toContain('Specification ready.');

    const approved = await cli(
      fixture.root,
      'spec',
      'approve',
      'settings-export',
      '--build',
      '--no-launch',
    );
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain('Human authority recorded as');
    expect(approved.stdout).toContain('Everything from here is unattended.');

    // Every lifecycle step ran from the one command.
    for (const step of [
      'CONTRACT_READY',
      'SYNTHESIZE',
      'VALIDATE_PROJECTION',
      'DERIVE_APPROVALS',
      'SEAL',
      'PREFLIGHT',
      'CREATE_JOB',
    ]) {
      expect(approved.stdout, step).toContain(step);
    }
    expect(approved.stdout).toContain('humanInterventionsAfterSeal: 0');

    // The synthesized spec is approved with derived provenance — the user
    // never ran `spec approve --stage` at all.
    const intake = listSpecIntakes(fixture.intake).intakes[0];
    const state = readSpecState(fixture.workspace, intake?.specName as string).state;
    expect(state?.status).toBe('READY_FOR_IMPLEMENTATION');
    const requirements = (state?.stages as Record<string, Record<string, unknown>>)['requirements'];
    expect(requirements?.['approvalMode']).toBe('DERIVED_FROM_INTENT_APPROVAL');
  });

  it('inspects an intake and reports the zero-touch boundary', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const file = writeSpecFile(fixture, 'demo-spec.md', unambiguousSpecText());
    await cli(fixture.root, 'spec', 'start', 'settings-export', '--file', file);
    await cli(fixture.root, 'spec', 'approve', 'settings-export', '--build', '--no-launch');

    const shown = await cli(fixture.root, 'spec', 'intake', 'settings-export');
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('Approved by a human at');
    expect(shown.stdout).toContain('Build lifecycle');
    expect(shown.stdout).toContain('Zero-touch boundary');
    expect(shown.stdout).toContain('authorityApprovalCount: 1');

    const listed = await cli(fixture.root, 'spec', 'intake', '--json');
    const intakes = jsonOf(listed)['intakes'] as { name: string }[];
    expect(intakes.map((intake) => intake.name)).toContain('settings-export');
  });

  it('reports a human-only prerequisite instead of half-starting a job', async () => {
    const fixture = setupIntakeFixture({
      spec: true,
      git: true,
      // Deny the browser capability so the preflight's satisfiable path is
      // not available, and leave the machine without docker.
      autonomy: { toolsmith: { enabled: false, capabilities: [] } },
    });
    const file = writeSpecFile(
      fixture,
      'demo-spec.md',
      `${unambiguousSpecText()}\n## Verification\n\n- The dashboard page must render the export history in a browser.\n- The export must run end to end against a real Postgres via docker compose.\n`,
    );
    await cli(fixture.root, 'spec', 'start', 'settings-export', '--file', file);
    const built = await cli(
      fixture.root,
      'spec',
      'approve',
      'settings-export',
      '--build',
      '--no-launch',
      '--json',
    );
    const report = jsonOf(built);
    expect(report['outcome']).toBe('HUMAN_PREREQUISITE_REQUIRED');
    expect((report['humanPrerequisites'] as string[]).length).toBeGreaterThan(0);
    expect(report['jobId']).toBeNull();
    expect(built.code).toBe(1);
  });

  it('resumes an interrupted build idempotently', async () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const file = writeSpecFile(fixture, 'demo-spec.md', unambiguousSpecText());
    await cli(fixture.root, 'spec', 'start', 'settings-export', '--file', file);
    await cli(fixture.root, 'spec', 'approve', 'settings-export', '--build', '--no-launch');

    const resumed = await cli(
      fixture.root,
      'spec',
      'intake',
      'settings-export',
      '--resume',
      '--no-launch',
      '--json',
    );
    expect(resumed.code).toBe(0);
    const report = jsonOf(resumed);
    expect(report['outcome']).toBe('LAUNCHED');
    // Nothing was rebuilt: the same spec, seal, and job.
    const listing = jsonOf(await cli(fixture.root, 'spec', 'intake', '--json'));
    const intakes = listing['intakes'] as { specName: string; sealId: string; jobId: string }[];
    expect(report['specName']).toBe(intakes[0]?.specName);
    expect(report['sealId']).toBe(intakes[0]?.sealId);
  });

  it('refuses --build together with --stage, and --revoke with --build', async () => {
    const fixture = setupIntakeFixture({ spec: true });
    const both = await cli(
      fixture.root,
      'spec',
      'approve',
      'x',
      '--build',
      '--stage',
      'requirements',
    );
    expect(both.code).toBe(2);
    expect(both.stderr).toMatch(/one or the other/i);

    const revoke = await cli(fixture.root, 'spec', 'approve', 'x', '--build', '--revoke');
    expect(revoke.code).toBe(2);
    expect(revoke.stderr).toMatch(/autonomy revoke/);
  });
});

describe('spec intake CLI — backward compatibility', () => {
  it('the per-stage approval workflow is unchanged', async () => {
    const fixture = setupIntakeFixture({ spec: true });
    // The fixture's spec is already approved; revoke and re-approve through
    // the ORIGINAL command to prove the path still works end to end.
    const revoked = await cli(
      fixture.root,
      'spec',
      'approve',
      fixture.specName,
      '--stage',
      'tasks',
      '--revoke',
    );
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toContain('tasks approval revoked');

    const approved = await cli(
      fixture.root,
      'spec',
      'approve',
      fixture.specName,
      '--stage',
      'tasks',
    );
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain('tasks approved');

    // Still a HUMAN approval: no derived provenance is written by this path.
    const state = readSpecState(fixture.workspace, fixture.specName).state;
    const tasks = (state?.stages as Record<string, Record<string, unknown>>)['tasks'];
    expect(tasks?.['status']).toBe('approved');
    expect(tasks?.['approvalMode']).toBeUndefined();
    expect(tasks?.['sourceApprovalId']).toBeUndefined();
  });

  it('an unknown --stage is still a usage error, exactly as before', async () => {
    const fixture = setupIntakeFixture({ spec: true });
    const result = await cli(
      fixture.root,
      'spec',
      'approve',
      fixture.specName,
      '--stage',
      'nonsense',
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Unknown --stage/);
  });

  it('omitting --stage without --build is still a usage error', async () => {
    const fixture = setupIntakeFixture({ spec: true });
    const result = await cli(fixture.root, 'spec', 'approve', fixture.specName);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Unknown --stage/);
  });

  it('a workspace with no intake behaves exactly as it always did', async () => {
    const fixture = setupIntakeFixture({ spec: true });
    const listed = await cli(fixture.root, 'spec', 'intake');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('none — start one with');

    // The mission surface is untouched.
    const missions = await cli(fixture.root, 'mission', 'status');
    expect(missions.code).toBe(0);
    const specs = await cli(fixture.root, 'spec', 'list');
    expect(specs.code).toBe(0);
    expect(specs.stdout).toContain(fixture.specName);
  });

  it('the low-level lifecycle commands remain available', async () => {
    const fixture = setupIntakeFixture({ spec: true });
    for (const argv of [
      ['mission', 'begin', '--help'],
      ['mission', 'contract-ready', '--help'],
      ['mission', 'synthesize', '--help'],
      ['autonomy', 'seal', '--help'],
      ['overnight', 'preflight', '--help'],
      ['overnight', 'run', '--help'],
    ]) {
      const result = await cli(fixture.root, ...argv);
      expect(result.code, argv.join(' ')).toBe(0);
    }
  });
});
