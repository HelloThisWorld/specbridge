import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resumeRun, runApprovedTask } from '@specbridge/execution';
import {
  EXECUTION_SPEC,
  failingCommand,
  passingCommand,
  setupExecutionFixture,
} from '../helpers-execution.js';

/**
 * Session resume over the deterministic mock runner: lineage, divergence
 * detection, refusal rules. Fully offline.
 */

async function failedFirstRun(fixture: ReturnType<typeof setupExecutionFixture>) {
  const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, taskId: '1' });
  expect(outcome.kind).toBe('executed');
  if (outcome.kind !== 'executed') throw new Error('expected executed');
  return outcome.report;
}

describe('run resume', () => {
  it('records a resumable session on every mock run', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const report = await failedFirstRun(fixture);
    expect(report.evidenceStatus).toBe('implemented-unverified');
    expect(report.sessionId).toBeDefined();
    expect(report.resumeSupported).toBe(true);
  });

  it('a failed run can resume, complete, and verify with lineage preserved', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const first = await failedFirstRun(fixture);

    // Fix verification for the retry.
    const configPath = path.join(fixture.root, '.specbridge', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config['verification'] = { commands: [passingCommand()] };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const { readAgentConfig } = await import('@specbridge/core');
    const { createDefaultRunnerRegistry } = await import('@specbridge/runners');
    const refreshed = readAgentConfig(fixture.workspace);
    if (refreshed.config === undefined) throw new Error('config invalid');
    const deps = {
      ...fixture.deps,
      config: refreshed.config,
      registry: createDefaultRunnerRegistry(refreshed.config),
    };

    const outcome = await resumeRun(deps, { runId: first.runId });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.originalRunId).toBe(first.runId);
    expect(outcome.report.parentRunId).toBe(first.runId);
    expect(outcome.report.sessionId).toBe(first.sessionId);
    expect(outcome.report.evidenceStatus).toBe('verified');
    expect(outcome.report.checkboxUpdated).toBe(true);
    // Changes from BOTH sessions are attributed to the task.
    expect(outcome.report.changedFiles.some((file) => file.path === 'src/mock-change.txt')).toBe(true);
  });

  it('a verified run cannot resume', async () => {
    const fixture = setupExecutionFixture();
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, taskId: '1' });
    if (outcome.kind !== 'executed') throw new Error('expected executed');
    expect(outcome.report.evidenceStatus).toBe('verified');

    const resume = await resumeRun(fixture.deps, { runId: outcome.report.runId });
    expect(resume.kind).toBe('refused');
    if (resume.kind === 'refused') {
      expect(resume.message).toContain('verified');
      expect(resume.exitCode).toBe(1);
    }
  });

  it('repository divergence after the run blocks an unsafe resume', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const first = await failedFirstRun(fixture);

    // The user edits the agent's file after the run ended.
    writeFileSync(path.join(fixture.root, 'src', 'mock-change.txt'), 'manually rewritten\n');

    const resume = await resumeRun(fixture.deps, { runId: first.runId });
    expect(resume.kind).toBe('refused');
    if (resume.kind === 'refused') {
      expect(resume.divergence?.join(' ')).toContain('src/mock-change.txt');
      expect(resume.remediation.join(' ')).toContain('spec run');
    }
  });

  it('an unknown run id is reported honestly', async () => {
    const fixture = setupExecutionFixture();
    const resume = await resumeRun(fixture.deps, { runId: 'does-not-exist' });
    expect(resume.kind).toBe('refused');
    if (resume.kind === 'refused') expect(resume.exitCode).toBe(2);
  });

  it('a run without a recorded session id refuses resume and suggests a fresh attempt', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const first = await failedFirstRun(fixture);
    // Simulate an older/degraded record without a session id.
    const runJsonPath = path.join(fixture.root, '.specbridge', 'runs', first.runId, 'run.json');
    const record = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Record<string, unknown>;
    delete record['sessionId'];
    writeFileSync(runJsonPath, `${JSON.stringify(record, null, 2)}\n`);

    const resume = await resumeRun(fixture.deps, { runId: first.runId });
    expect(resume.kind).toBe('refused');
    if (resume.kind === 'refused') {
      expect(resume.message).toContain('session');
      expect(resume.remediation.join(' ')).toContain(`spec run ${EXECUTION_SPEC} --task 1`);
    }
  });

  it('a mock resume-failure scenario ends failed without touching the checkbox', async () => {
    const fixture = setupExecutionFixture({
      scenario: 'resume-failure',
      verificationCommands: [passingCommand()],
    });
    // First run: resume-failure behaves like success for the initial attempt
    // but verification failure is simulated by editing config afterwards; to
    // keep it simple, fail the first run via a failing verifier config edit.
    const configPath = path.join(fixture.root, '.specbridge', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config['verification'] = { commands: [failingCommand()] };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const { readAgentConfig } = await import('@specbridge/core');
    const { createDefaultRunnerRegistry } = await import('@specbridge/runners');
    const read = readAgentConfig(fixture.workspace);
    if (read.config === undefined) throw new Error('config invalid');
    const deps = { ...fixture.deps, config: read.config, registry: createDefaultRunnerRegistry(read.config) };

    const first = await runApprovedTask(deps, { specName: EXECUTION_SPEC, taskId: '1' });
    if (first.kind !== 'executed') throw new Error('expected executed');
    expect(first.report.evidenceStatus).toBe('implemented-unverified');

    const resume = await resumeRun(deps, { runId: first.report.runId });
    expect(resume.kind).toBe('executed');
    if (resume.kind !== 'executed') return;
    expect(resume.report.evidenceStatus).toBe('failed');
    expect(resume.report.checkboxUpdated).toBe(false);
    expect(resume.report.parentRunId).toBe(first.report.runId);
  });
});
