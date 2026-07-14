import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { approveStage } from '@specbridge/workflow';
import { authorStage, listAttempts, resumeRun, runApprovedTask } from '@specbridge/execution';
import type { ExecutionFixture } from '../helpers-execution.js';
import { EXECUTION_SPEC, failingCommand, git, setupExecutionFixtureV2 } from '../helpers-execution.js';
import { startFakeOllama } from '../helpers-fake-ollama.js';

/**
 * v0.6 multi-runner orchestration: Codex task execution through the SAME
 * shared pipeline as Claude (snapshots, verification, evidence, verified-only
 * checkboxes), Ollama authoring through the same authoring gates, capability
 * rejections before any invocation, and the bounded explicit fallback loop.
 * Fully offline (fake Codex child process + fake Ollama loopback server).
 */

afterEach(() => {
  delete process.env['FAKE_CODEX_SCENARIO'];
  delete process.env['FAKE_CODEX_LOG'];
});

function tasksDocument(root: string): string {
  return readFileSync(path.join(root, '.kiro', 'specs', EXECUTION_SPEC, 'tasks.md'), 'utf8');
}

/** Initialize workflow state with every stage left DRAFT. */
function initDraftState(fixture: ExecutionFixture): void {
  const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
  const approved = approveStage(fixture.workspace, spec, { stage: 'requirements' }, { clock: fixture.clock });
  if (!approved.ok) throw new Error(approved.message);
  const again = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
  const revoked = approveStage(
    fixture.workspace,
    again,
    { stage: 'requirements', revoke: true },
    { clock: fixture.clock },
  );
  if (!revoked.ok) throw new Error(revoked.message);
}

function approveOne(fixture: ExecutionFixture, stage: 'requirements' | 'design' | 'tasks'): void {
  const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
  const result = approveStage(fixture.workspace, spec, { stage }, { clock: fixture.clock });
  if (!result.ok) throw new Error(result.message);
}

function scratchFile(name: string): string {
  const dir = path.join(os.tmpdir(), `specbridge-mr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

describe('codex task execution through shared orchestration', () => {
  it('a verified codex run updates exactly one checkbox from actual evidence', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'codex-default' });
    const before = tasksDocument(fixture.root);
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    const report = outcome.report;
    expect(report.runner).toBe('codex-default');
    expect(report.outcome).toBe('completed');
    expect(report.evidenceStatus).toBe('verified');
    expect(report.checkboxUpdated).toBe(true);
    expect(report.sessionId).toBe('fake-thread-0001');
    // Actual git evidence, not provider claims.
    expect(report.changedFiles.some((file) => file.path === 'src/fake-codex-change.txt')).toBe(true);
    expect(report.verification.ran).toBe(true);
    // Exactly one checkbox changed.
    const beforeLines = before.split('\n');
    const flipped = tasksDocument(fixture.root)
      .split('\n')
      .filter((line, index) => line !== beforeLines[index]);
    expect(flipped).toHaveLength(1);
    expect(flipped[0]).toContain('[x]');
    // No commit or push happened (still exactly the fixture baseline commit).
    expect(git(fixture.root, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
    // The attempt record exists with the capability snapshot.
    const attempts = listAttempts(fixture.workspace, report.runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.runner).toBe('codex-cli');
    expect(attempts[0]?.operation).toBe('task-execution');
    expect(attempts[0]?.boundary).toBe('local-process');
    expect(attempts[0]?.capabilitySnapshot.taskExecution).toBe(true);
  });

  it('a failed verifier leaves the checkbox unchanged and retains evidence — no retry, no fallback', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const log = scratchFile('codex-invocations.jsonl');
    process.env['FAKE_CODEX_LOG'] = log;
    const fixture = setupExecutionFixtureV2({
      useFakeCodex: true,
      defaultRunner: 'codex-default',
      verificationCommands: [failingCommand()],
      // A configured authoring fallback chain must NOT apply to execution.
      fallbacks: { stageGeneration: ['mock'] },
    });
    const before = tasksDocument(fixture.root);
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(tasksDocument(fixture.root)).toBe(before);
    expect(existsSync(outcome.report.evidencePath)).toBe(true);
    // Exactly ONE codex invocation: no automatic retry, no provider switch.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(listAttempts(fixture.workspace, outcome.report.runId)).toHaveLength(1);
  });

  it('a codex .kiro write prevents verification and is never rolled back', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'protected-write';
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'codex-default' });
    const before = tasksDocument(fixture.root);
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).not.toBe('verified');
    expect(outcome.report.violations.join(' ')).toContain('.kiro');
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(tasksDocument(fixture.root)).toBe(before);
    // The rogue file is retained for inspection — never auto-reverted.
    expect(existsSync(path.join(fixture.root, '.kiro', 'fake-codex-rogue.txt'))).toBe(true);
  });

  it('a codex tasks.md edit is caught and never verified', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'kiro-tasks-write';
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'codex-default' });
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).not.toBe('verified');
    expect(outcome.report.violations.length).toBeGreaterThan(0);
  });

  it('provider claims alone (claimed tests never run) never verify a task', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'claims-untested';
    const fixture = setupExecutionFixtureV2({
      useFakeCodex: true,
      defaultRunner: 'codex-default',
      verificationCommands: [],
    });
    const outcome = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
    expect(outcome.report.checkboxUpdated).toBe(false);
  });

  it('codex resume uses the explicit recorded session id and preserves lineage', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'reports-blocked';
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'codex-default' });
    const first = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    expect(first.kind).toBe('executed');
    if (first.kind !== 'executed') return;
    expect(first.report.evidenceStatus).toBe('blocked');
    expect(first.report.resumeSupported).toBe(true);

    process.env['FAKE_CODEX_SCENARIO'] = 'resume-ok';
    const log = scratchFile('codex-resume.jsonl');
    process.env['FAKE_CODEX_LOG'] = log;
    const resume = await resumeRun(fixture.deps, { runId: first.report.runId });
    expect(resume.kind).toBe('executed');
    if (resume.kind !== 'executed') return;
    expect(resume.report.evidenceStatus).toBe('verified');
    // The resumed invocation carried the EXPLICIT session id (never "latest").
    const invocation = JSON.parse(readFileSync(log, 'utf8').trim()) as { argv: string[] };
    const resumeIndex = invocation.argv.indexOf('resume');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(invocation.argv[resumeIndex + 1]).toBe(first.report.sessionId);
    expect(resume.report.parentRunId).toBe(first.report.runId);
  });

  it('a missing codex session refuses the resume honestly', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'reports-blocked';
    const fixture = setupExecutionFixtureV2({ useFakeCodex: true, defaultRunner: 'codex-default' });
    const first = await runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, next: true });
    if (first.kind !== 'executed') throw new Error('expected execution');

    process.env['FAKE_CODEX_SCENARIO'] = 'resume-missing-session';
    const resume = await resumeRun(fixture.deps, { runId: first.report.runId });
    // The provider refused the session: the run fails, nothing verifies.
    expect(resume.kind).toBe('executed');
    if (resume.kind !== 'executed') return;
    expect(resume.report.evidenceStatus).toBe('failed');
    expect(resume.report.checkboxUpdated).toBe(false);
  });
});

describe('capability rejections before any invocation', () => {
  it('ollama task execution is rejected before any HTTP request or file change', async () => {
    const server = await startFakeOllama({});
    try {
      const fixture = setupExecutionFixtureV2({
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
      });
      const before = tasksDocument(fixture.root);
      const outcome = await runApprovedTask(fixture.deps, {
        specName: EXECUTION_SPEC,
        next: true,
        runnerName: 'ollama-local',
      });
      expect(outcome.kind).toBe('preflight-failed');
      if (outcome.kind !== 'preflight-failed') return;
      expect(outcome.preflight.failure?.code).toBe('runner-not-selectable');
      expect(outcome.preflight.failure?.selection?.missingCapabilities).toContain('taskExecution');
      expect(outcome.preflight.failure?.selection?.compatibleProfiles).toContain('mock');
      // NOTHING happened: no HTTP request, no run record, no file change.
      expect(server.requests).toHaveLength(0);
      expect(tasksDocument(fixture.root)).toBe(before);
      expect(existsSync(path.join(fixture.root, '.specbridge', 'runs'))).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe('ollama authoring through shared orchestration', () => {
  it('generates a design stage that stays draft; SpecBridge writes the file', async () => {
    const server = await startFakeOllama({ chatBehaviors: ['valid-design'] });
    try {
      const fixture = setupExecutionFixtureV2({
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
        approve: false,
      });
      approveOne(fixture, 'requirements');
      const outcome = await authorStage(fixture.deps, {
        specName: EXECUTION_SPEC,
        stage: 'design',
        intent: 'generate',
        runnerName: 'ollama-local',
      });
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.profile).toBe('ollama-local');
      expect(readFileSync(outcome.filePath, 'utf8')).toContain('# Design Document');
      // The design stage remains unapproved after generation.
      const { stateStage } = await import('@specbridge/core');
      const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, EXECUTION_SPEC));
      const designStage = spec.state !== undefined ? stateStage(spec.state, 'design') : undefined;
      expect(designStage?.status).not.toBe('approved');
      // Exactly one loopback chat request; SpecBridge wrote the document.
      expect(server.chatCalls()).toHaveLength(1);
      const attempts = listAttempts(fixture.workspace, outcome.runId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.boundary).toBe('loopback-endpoint');
      expect(attempts[0]?.model).toBe('qwen-fake:7b');
    } finally {
      await server.close();
    }
  });

  it('one correction retry after invalid structured output, then success — both attempts recorded', async () => {
    const server = await startFakeOllama({ chatBehaviors: ['schema-invalid', 'valid'] });
    try {
      const fixture = setupExecutionFixtureV2({
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
        approve: false,
      });
      initDraftState(fixture);
      const outcome = await authorStage(fixture.deps, {
        specName: EXECUTION_SPEC,
        stage: 'requirements',
        intent: 'generate',
        runnerName: 'ollama-local',
      });
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      // Exactly two chat requests: the initial one plus ONE correction.
      expect(server.chatCalls()).toHaveLength(2);
      const correction = server.chatCalls()[1]?.body as { messages: { role: string; content: string }[] };
      expect(correction.messages).toHaveLength(3);
      expect(correction.messages[2]?.content).toContain('Validation problems');
      const attempts = listAttempts(fixture.workspace, outcome.runId);
      expect(attempts.map((attempt) => attempt.attemptKind)).toEqual(['initial', 'correction-retry']);
      // The invalid candidate is retained for inspection inside attempt 1.
      const attemptDir = path.join(outcome.artifactsDir, 'attempts', 'attempt-001');
      expect(existsSync(path.join(attemptDir, 'invalid-candidate.txt'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('a failed correction retry stops (no unlimited loop) and applies nothing', async () => {
    const server = await startFakeOllama({
      chatBehaviors: ['schema-invalid', 'schema-invalid', 'schema-invalid'],
    });
    try {
      const fixture = setupExecutionFixtureV2({
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
        approve: false,
      });
      initDraftState(fixture);
      const requirementsPath = path.join(
        fixture.root,
        '.kiro',
        'specs',
        EXECUTION_SPEC,
        'requirements.md',
      );
      const before = readFileSync(requirementsPath, 'utf8');
      const outcome = await authorStage(fixture.deps, {
        specName: EXECUTION_SPEC,
        stage: 'requirements',
        intent: 'generate',
        runnerName: 'ollama-local',
      });
      expect(outcome.kind).toBe('runner-failed');
      if (outcome.kind !== 'runner-failed') return;
      expect(outcome.result.error?.code).toBe('structured_output_invalid');
      // Bounded: initial + exactly ONE correction retry — never a loop.
      expect(server.chatCalls()).toHaveLength(2);
      // The invalid candidate was retained but NOT applied.
      expect(readFileSync(requirementsPath, 'utf8')).toBe(before);
    } finally {
      await server.close();
    }
  });
});

describe('explicit authoring fallback (bounded and auditable)', () => {
  it('falls back from a failing Ollama to Codex, recording every attempt', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const server = await startFakeOllama({ chatBehaviors: ['http-500'] });
    try {
      const fixture = setupExecutionFixtureV2({
        useFakeCodex: true,
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
        operationDefaults: { stageGeneration: 'ollama-local' },
        fallbacks: { stageGeneration: ['ollama-local', 'codex-default'] },
        approve: false,
      });
      initDraftState(fixture);
      const outcome = await authorStage(fixture.deps, {
        specName: EXECUTION_SPEC,
        stage: 'requirements',
        intent: 'generate',
      });
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.profile).toBe('codex-default');
      // Ollama transport failure retried (bounded), then codex attempted:
      // every attempt is a separate append-only record.
      const attempts = listAttempts(fixture.workspace, outcome.runId);
      const profiles = attempts.map((attempt) => `${attempt.profile}:${attempt.attemptKind}`);
      expect(profiles[0]).toBe('ollama-local:initial');
      expect(profiles).toContain('codex-default:fallback');
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      // Failed attempts remain on disk after the fallback succeeded.
      const attemptDirs = readdirSync(path.join(outcome.artifactsDir, 'attempts'));
      expect(attemptDirs.length).toBe(attempts.length);
      // The outcome reports every attempted profile and reason.
      expect(outcome.attempts.map((attempt) => attempt.profile)).toContain('ollama-local');
      expect(outcome.attempts.map((attempt) => attempt.profile)).toContain('codex-default');
    } finally {
      await server.close();
    }
  });

  it('never falls back after an authentication failure', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const server = await startFakeOllama({ chatBehaviors: ['http-401'] });
    try {
      const log = scratchFile('codex-fallback-auth.jsonl');
      process.env['FAKE_CODEX_LOG'] = log;
      const fixture = setupExecutionFixtureV2({
        useFakeCodex: true,
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
        operationDefaults: { stageGeneration: 'ollama-local' },
        fallbacks: { stageGeneration: ['ollama-local', 'codex-default'] },
        approve: false,
      });
      initDraftState(fixture);
      const outcome = await authorStage(fixture.deps, {
        specName: EXECUTION_SPEC,
        stage: 'requirements',
        intent: 'generate',
      });
      expect(outcome.kind).toBe('runner-failed');
      if (outcome.kind !== 'runner-failed') return;
      expect(outcome.profile).toBe('ollama-local');
      // Codex was NEVER attempted (no exec invocation logged).
      expect(existsSync(log)).toBe(false);
      const attempts = listAttempts(fixture.workspace, outcome.runId);
      expect(attempts.every((attempt) => attempt.profile === 'ollama-local')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('never falls back without an explicitly configured chain (bounded transport retries only)', async () => {
    process.env['FAKE_CODEX_SCENARIO'] = 'success';
    const server = await startFakeOllama({
      chatBehaviors: ['http-500', 'http-500', 'http-500', 'http-500'],
    });
    try {
      const fixture = setupExecutionFixtureV2({
        useFakeCodex: true,
        ollamaBaseUrl: server.baseUrl,
        defaultRunner: 'mock',
        operationDefaults: { stageGeneration: 'ollama-local' },
        approve: false,
      });
      initDraftState(fixture);
      const outcome = await authorStage(fixture.deps, {
        specName: EXECUTION_SPEC,
        stage: 'requirements',
        intent: 'generate',
      });
      expect(outcome.kind).toBe('runner-failed');
      if (outcome.kind !== 'runner-failed') return;
      expect(outcome.profile).toBe('ollama-local');
      // Bounded transport retries (max 2) on the SAME profile; no switch.
      const attempts = listAttempts(fixture.workspace, outcome.runId);
      expect(attempts.length).toBeLessThanOrEqual(3);
      expect(attempts.every((attempt) => attempt.profile === 'ollama-local')).toBe(true);
      expect(server.chatCalls().length).toBeLessThanOrEqual(3);
    } finally {
      await server.close();
    }
  });
});
