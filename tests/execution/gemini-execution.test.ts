import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listAttempts, resumeRun, runApprovedTask } from '@specbridge/execution';
import { EXECUTION_SPEC, failingCommand, git, setupExecutionFixtureV2 } from '../helpers-execution.js';

/**
 * v0.6.1 Gemini task execution through the SAME shared orchestration as
 * Claude and Codex: Git snapshots, trusted verification, evidence
 * evaluation, verified-only checkbox completion, explicit-session resume.
 * Fully offline (fake Gemini child process).
 */

afterEach(() => {
  delete process.env['FAKE_GEMINI_SCENARIO'];
  delete process.env['FAKE_GEMINI_LOG'];
});

function tasksDocument(root: string): string {
  return readFileSync(path.join(root, '.kiro', 'specs', EXECUTION_SPEC, 'tasks.md'), 'utf8');
}

describe('gemini task execution through shared orchestration', () => {
  it('a verified gemini run updates exactly one checkbox from actual Git evidence', async () => {
    process.env['FAKE_GEMINI_SCENARIO'] = 'success';
    const fixture = setupExecutionFixtureV2({ useFakeGemini: true, defaultRunner: 'gemini-default' });
    const before = tasksDocument(fixture.root);
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    const report = outcome.report;
    expect(report.runner).toBe('gemini-default');
    expect(report.outcome).toBe('completed');
    expect(report.evidenceStatus).toBe('verified');
    expect(report.checkboxUpdated).toBe(true);
    expect(report.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    // Actual git evidence, not provider claims.
    expect(report.changedFiles.some((file) => file.path === 'src/fake-gemini-change.txt')).toBe(true);
    expect(report.verification.ran).toBe(true);
    // Exactly one checkbox changed; no commit or push happened.
    const beforeLines = before.split('\n');
    const flipped = tasksDocument(fixture.root)
      .split('\n')
      .filter((line, index) => line !== beforeLines[index]);
    expect(flipped).toHaveLength(1);
    expect(flipped[0]).toContain('[x]');
    expect(git(fixture.root, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
    const attempts = listAttempts(fixture.workspace, report.runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.runner).toBe('gemini-cli');
    expect(attempts[0]?.capabilitySnapshot.taskExecution).toBe(true);
  });

  it('a failed verifier leaves the checkbox unchanged (provider claims are not authority)', async () => {
    process.env['FAKE_GEMINI_SCENARIO'] = 'success';
    const fixture = setupExecutionFixtureV2({
      useFakeGemini: true,
      defaultRunner: 'gemini-default',
      verificationCommands: [failingCommand()],
    });
    const before = tasksDocument(fixture.root);
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(tasksDocument(fixture.root)).toBe(before);
  });

  it('a gemini .kiro write prevents verification and is never rolled back', async () => {
    process.env['FAKE_GEMINI_SCENARIO'] = 'protected-write';
    const fixture = setupExecutionFixtureV2({ useFakeGemini: true, defaultRunner: 'gemini-default' });
    const before = tasksDocument(fixture.root);
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).not.toBe('verified');
    expect(outcome.report.violations.join(' ')).toContain('.kiro');
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(tasksDocument(fixture.root)).toBe(before);
    expect(existsSync(path.join(fixture.root, '.kiro', 'fake-gemini-rogue.txt'))).toBe(true);
  });

  it('a gemini tasks.md edit is caught and never verified', async () => {
    process.env['FAKE_GEMINI_SCENARIO'] = 'kiro-tasks-write';
    const fixture = setupExecutionFixtureV2({ useFakeGemini: true, defaultRunner: 'gemini-default' });
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).not.toBe('verified');
    expect(outcome.report.violations.length).toBeGreaterThan(0);
  });

  it('provider claims alone (claimed tests never run) never verify a task', async () => {
    process.env['FAKE_GEMINI_SCENARIO'] = 'claims-untested';
    const fixture = setupExecutionFixtureV2({
      useFakeGemini: true,
      defaultRunner: 'gemini-default',
      verificationCommands: [],
    });
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
    expect(outcome.report.checkboxUpdated).toBe(false);
  });

  it('malformed final output leaves the task unchecked with evidence preserved', async () => {
    process.env['FAKE_GEMINI_SCENARIO'] = 'malformed';
    const fixture = setupExecutionFixtureV2({ useFakeGemini: true, defaultRunner: 'gemini-default' });
    const before = tasksDocument(fixture.root);
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).not.toBe('verified');
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(tasksDocument(fixture.root)).toBe(before);
    expect(existsSync(outcome.report.evidencePath)).toBe(true);
  });

  it('gemini resume uses the explicit recorded session UUID and preserves lineage', async () => {
    process.env['FAKE_GEMINI_SCENARIO'] = 'reports-blocked';
    const fixture = setupExecutionFixtureV2({ useFakeGemini: true, defaultRunner: 'gemini-default' });
    const first = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(first.kind).toBe('executed');
    if (first.kind !== 'executed') return;
    expect(first.report.evidenceStatus).toBe('blocked');
    expect(first.report.resumeSupported).toBe(true);

    process.env['FAKE_GEMINI_SCENARIO'] = 'resume-ok';
    const resume = await resumeRun(fixture.deps, { runId: first.report.runId });
    expect(resume.kind).toBe('executed');
    if (resume.kind !== 'executed') return;
    expect(resume.report.evidenceStatus).toBe('verified');
    expect(resume.report.parentRunId).toBe(first.report.runId);
  });

  it('a missing gemini session refuses the resume honestly', async () => {
    process.env['FAKE_GEMINI_SCENARIO'] = 'reports-blocked';
    const fixture = setupExecutionFixtureV2({ useFakeGemini: true, defaultRunner: 'gemini-default' });
    const first = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    if (first.kind !== 'executed') throw new Error('expected execution');

    process.env['FAKE_GEMINI_SCENARIO'] = 'resume-missing-session';
    const resume = await resumeRun(fixture.deps, { runId: first.report.runId });
    expect(resume.kind).toBe('executed');
    if (resume.kind !== 'executed') return;
    expect(resume.report.evidenceStatus).toBe('failed');
    expect(resume.report.checkboxUpdated).toBe(false);
  });
});
