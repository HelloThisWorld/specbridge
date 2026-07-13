import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InteractiveLock } from '@specbridge/execution';
import {
  diagnoseInteractiveLock,
  interactiveLockPath,
  readInteractiveLock,
} from '@specbridge/execution';
import { resolveWorkspace } from '@specbridge/core';
import type { ExecutionFixture } from '../helpers-execution.js';
import {
  EXECUTION_SPEC,
  failingCommand,
  git,
  passingCommand,
  setupExecutionFixture,
} from '../helpers-execution.js';
import type { McpTestSession } from '../helpers-mcp.js';
import { callTool, connectMcp, parsedLogs } from '../helpers-mcp.js';

/**
 * The interactive task lifecycle over MCP: task_begin → the host session
 * edits source files → task_complete, plus task_abort and lock recovery.
 *
 * Everything runs offline: no model, no runner process. The "agent edits"
 * are plain file writes in the test, exactly like a host session would make
 * them.
 */

function workspaceOf(fixture: ExecutionFixture): NonNullable<ReturnType<typeof resolveWorkspace>> {
  const workspace = resolveWorkspace(fixture.root);
  if (workspace === undefined) throw new Error('fixture has no workspace');
  return workspace;
}

async function connect(fixture: ExecutionFixture): Promise<McpTestSession> {
  return connectMcp(fixture.root);
}

function tasksDocument(fixture: ExecutionFixture): string {
  return readFileSync(
    path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'tasks.md'),
    'utf8',
  );
}

function editSource(fixture: ExecutionFixture, content = 'implemented by the host session\n'): void {
  writeFileSync(path.join(fixture.root, 'src', 'feature.txt'), content);
}

describe('task_begin', () => {
  it('validates approvals and rejects an unapproved spec', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    const session = await connect(fixture);
    try {
      const result = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('SBMCP006');
      expect(readInteractiveLock(workspaceOf(fixture)).state).toBe('absent');
    } finally {
      await session.close();
    }
  });

  it('rejects a stale approval', async () => {
    const fixture = setupExecutionFixture();
    const requirements = path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'requirements.md');
    writeFileSync(requirements, `${readFileSync(requirements, 'utf8')}\nEdited after approval.\n`);
    const session = await connect(fixture);
    try {
      const result = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('SBMCP005');
    } finally {
      await session.close();
    }
  });

  it('rejects a dirty working tree by default and supports allowDirty', async () => {
    const fixture = setupExecutionFixture();
    writeFileSync(path.join(fixture.root, 'src', 'pre-existing.txt'), 'user change before the run\n');
    const session = await connect(fixture);
    try {
      const rejected = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(rejected.isError).toBe(true);
      expect(rejected.errorCode).toBe('SBMCP009');
      expect(readInteractiveLock(workspaceOf(fixture)).state).toBe('absent');

      const allowed = await callTool(session, 'task_begin', {
        specName: EXECUTION_SPEC,
        allowDirty: true,
      });
      expect(allowed.isError).toBe(false);
      expect(allowed.structured['allowDirty']).toBe(true);
      expect(
        (allowed.structured['warnings'] as string[]).some((warning) => warning.includes('baselined')),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('selects the next executable leaf task when no taskId is given', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const result = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(result.isError).toBe(false);
      expect((result.structured['task'] as { id: string }).id).toBe('1');
      // The full contract of the begin result.
      expect(result.structured['runId']).toBeDefined();
      expect((result.structured['context'] as string).length).toBeGreaterThan(100);
      expect((result.structured['instructions'] as string[]).join(' ')).toContain('task_complete');
      expect(result.structured['protectedPaths']).toContain('.kiro/');
      expect(result.structured['protectedPaths']).toContain('.specbridge/');
      expect(
        (result.structured['verificationCommands'] as { name: string }[]).map((c) => c.name),
      ).toContain('test');
    } finally {
      await session.close();
    }
  });

  it('acquires the lock and rejects a second concurrent begin', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const first = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(first.isError).toBe(false);
      const lock = readInteractiveLock(workspaceOf(fixture));
      expect(lock.state).toBe('held');
      if (lock.state === 'held') {
        expect(lock.lock.runId).toBe(first.structured['runId']);
        expect(lock.lock.specName).toBe(EXECUTION_SPEC);
      }

      const second = await callTool(session, 'task_begin', {
        specName: EXECUTION_SPEC,
        taskId: '2.1',
      });
      expect(second.isError).toBe(true);
      expect(second.errorCode).toBe('SBMCP010');
    } finally {
      await session.close();
    }
  });

  it('invokes no model and starts no process (pure file/git operations)', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const result = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(result.isError).toBe(false);
      // The run directory contains context/state artifacts but no prompt,
      // no runner request, and no raw model output.
      const runDir = path.join(fixture.root, '.specbridge', 'runs', result.structured['runId'] as string);
      const artifacts = readdirSync(runDir).sort();
      expect(artifacts).toContain('context.md');
      expect(artifacts).toContain('git-before.json');
      expect(artifacts).toContain('interactive-state.json');
      expect(artifacts).not.toContain('prompt.md');
      expect(artifacts).not.toContain('runner-request.json');
      expect(artifacts).not.toContain('raw-stdout.log');
    } finally {
      await session.close();
    }
  });
});

describe('task_complete', () => {
  it('verified completion: captures actual changes, runs the verifier, updates exactly one checkbox', async () => {
    const fixture = setupExecutionFixture();
    const tasksBefore = tasksDocument(fixture);
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      editSource(fixture);

      const complete = await callTool(session, 'task_complete', {
        runId,
        summary: 'Implemented the settings store.',
        reportedChangedFiles: ['src/feature.txt'],
        reportedTests: [{ name: 'settings save', status: 'passed' }],
      });
      expect(complete.isError).toBe(false);
      expect(complete.structured['outcome']).toBe('verified');
      expect(complete.structured['evidenceStatus']).toBe('verified');
      expect(complete.structured['checkboxUpdated']).toBe(true);
      const actual = complete.structured['actualChangedFiles'] as { path: string }[];
      expect(actual.map((file) => file.path)).toEqual(['src/feature.txt']);
      const verifiers = complete.structured['verifierOutcomes'] as { name: string; passed: boolean }[];
      expect(verifiers).toHaveLength(1);
      expect(verifiers[0]?.passed).toBe(true);

      // Exactly one line changed in tasks.md: the task 1 checkbox.
      const tasksAfter = tasksDocument(fixture);
      const beforeLines = tasksBefore.split('\n');
      const afterLines = tasksAfter.split('\n');
      const changed = afterLines.filter((line, index) => line !== beforeLines[index]);
      expect(changed).toEqual(['- [x] 1. Implement the settings store']);

      // Evidence recorded on disk.
      const evidencePath = path.join(fixture.root, complete.structured['evidencePath'] as string);
      expect(existsSync(evidencePath)).toBe(true);
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
        status: string;
        runner: string;
        runnerClaims: { changedFiles: string[] };
        specContext?: { taskFingerprint?: string };
      };
      expect(evidence.status).toBe('verified');
      expect(evidence.runner).toBe('interactive');
      expect(evidence.runnerClaims.changedFiles).toEqual(['src/feature.txt']);
      expect(evidence.specContext?.taskFingerprint).toMatch(/^[0-9a-f]{64}$/);

      // Lock released; lifecycle recorded; log events emitted.
      expect(readInteractiveLock(workspaceOf(fixture)).state).toBe('absent');
      const events = parsedLogs(session).map((log) => log.event);
      expect(events).toContain('interactive_run_started');
      expect(events).toContain('interactive_run_completed');
    } finally {
      await session.close();
    }
  });

  it('model claims alone do not verify a task (no actual change → no-change)', async () => {
    const fixture = setupExecutionFixture();
    const tasksBefore = tasksDocument(fixture);
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      // The "agent" claims changes but made none.
      const complete = await callTool(session, 'task_complete', {
        runId,
        summary: 'I definitely implemented everything.',
        reportedChangedFiles: ['src/feature.txt', 'src/other.txt'],
        reportedTests: [{ name: 'all tests', status: 'passed' }],
      });
      expect(complete.isError).toBe(false);
      expect(complete.structured['outcome']).toBe('no-change');
      expect(complete.structured['checkboxUpdated']).toBe(false);
      expect(tasksDocument(fixture)).toBe(tasksBefore);
    } finally {
      await session.close();
    }
  });

  it('required verifier failure leaves the checkbox unchanged but retains evidence', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const tasksBefore = tasksDocument(fixture);
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      editSource(fixture);
      const complete = await callTool(session, 'task_complete', {
        runId,
        summary: 'Implemented, but the verifier fails.',
      });
      expect(complete.isError).toBe(false);
      expect(complete.structured['outcome']).toBe('implemented-unverified');
      expect(complete.structured['checkboxUpdated']).toBe(false);
      expect(tasksDocument(fixture)).toBe(tasksBefore);
      const evidencePath = path.join(fixture.root, complete.structured['evidencePath'] as string);
      expect(existsSync(evidencePath)).toBe(true);
      // Source changes are NOT rolled back.
      expect(existsSync(path.join(fixture.root, 'src', 'feature.txt'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('.kiro modification is a protected-path violation without rollback', async () => {
    const fixture = setupExecutionFixture();
    const tasksBefore = tasksDocument(fixture);
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      // The "agent" edits a protected steering file mid-run.
      const steering = path.join(fixture.root, '.kiro', 'steering', 'product.md');
      writeFileSync(steering, `${readFileSync(steering, 'utf8')}\nRogue edit.\n`);
      editSource(fixture);
      const complete = await callTool(session, 'task_complete', {
        runId,
        summary: 'Implemented (and also touched steering).',
      });
      expect(complete.isError).toBe(false);
      expect(complete.structured['outcome']).toBe('protected-path-violation');
      expect(complete.structured['checkboxUpdated']).toBe(false);
      const violations = complete.structured['violations'] as string[];
      expect(violations.some((violation) => violation.includes('.kiro/steering/product.md'))).toBe(true);
      // No rollback: the rogue edit is still on disk, reported honestly.
      expect(readFileSync(steering, 'utf8')).toContain('Rogue edit.');
      expect(tasksDocument(fixture)).toBe(tasksBefore);
    } finally {
      await session.close();
    }
  });

  it('unauthorized .specbridge modification is detected', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      // The "agent" edits sidecar state (forbidden).
      const statePath = path.join(fixture.root, '.specbridge', 'state', 'specs', `${EXECUTION_SPEC}.json`);
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      writeFileSync(statePath, `${JSON.stringify({ ...state, updatedAt: '2030-01-01T00:00:00.000Z' }, null, 2)}\n`);
      editSource(fixture);
      const complete = await callTool(session, 'task_complete', {
        runId,
        summary: 'Implemented (and also edited sidecar state).',
      });
      expect(complete.isError).toBe(false);
      expect(complete.structured['outcome']).toBe('protected-path-violation');
      expect(complete.structured['checkboxUpdated']).toBe(false);
      const violations = complete.structured['violations'] as string[];
      expect(violations.some((violation) => violation.includes('.specbridge/state'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('repeated completion is idempotent (no duplicate evidence, no second checkbox)', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      editSource(fixture);
      const first = await callTool(session, 'task_complete', { runId, summary: 'Implemented.' });
      expect(first.structured['outcome']).toBe('verified');
      expect(first.structured['finalizedNow']).toBe(true);
      const tasksAfterFirst = tasksDocument(fixture);

      const second = await callTool(session, 'task_complete', { runId, summary: 'Implemented again?' });
      expect(second.isError).toBe(false);
      expect(second.structured['outcome']).toBe('verified');
      expect(second.structured['finalizedNow']).toBe(false);
      expect(tasksDocument(fixture)).toBe(tasksAfterFirst);

      // Still exactly one evidence record for the task.
      const evidenceDir = path.join(fixture.root, '.specbridge', 'evidence', EXECUTION_SPEC, '1');
      expect(readdirSync(evidenceDir)).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it('repository divergence (mid-run commit) is detected', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      editSource(fixture);
      git(fixture.root, 'add', '.');
      git(fixture.root, 'commit', '-q', '-m', 'someone committed mid-run');
      const complete = await callTool(session, 'task_complete', { runId, summary: 'Implemented.' });
      expect(complete.isError).toBe(false);
      expect(complete.structured['outcome']).toBe('repository-diverged');
      expect(complete.structured['checkboxUpdated']).toBe(false);
      const violations = complete.structured['violations'] as string[];
      expect(violations.some((violation) => violation.includes('HEAD moved'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('a tasks.md edit mid-run blocks completion as a stale approval', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      // Someone rewrites the selected task line mid-run: the tasks approval
      // goes stale (plan hash changed), which is the first gate to fire.
      const tasksPath = path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'tasks.md');
      writeFileSync(
        tasksPath,
        readFileSync(tasksPath, 'utf8').replace(
          '- [ ] 1. Implement the settings store',
          '- [ ] 1. Implement something entirely different',
        ),
      );
      editSource(fixture);
      const complete = await callTool(session, 'task_complete', { runId, summary: 'Implemented.' });
      expect(complete.isError).toBe(true);
      expect(complete.errorCode).toBe('SBMCP005');
      // The run is still open; the agent must abort explicitly.
      const abort = await callTool(session, 'task_abort', { runId, reason: 'task changed mid-run' });
      expect(abort.isError).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('a stale task fingerprint blocks completion even when approvals were re-recorded', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      // Someone rewrites the selected task AND re-approves the tasks stage
      // mid-run: approvals are current again, but the task the run was
      // started for no longer exists as fingerprinted.
      const tasksPath = path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'tasks.md');
      writeFileSync(
        tasksPath,
        readFileSync(tasksPath, 'utf8').replace(
          '- [ ] 1. Implement the settings store',
          '- [ ] 1. Implement something entirely different',
        ),
      );
      const { analyzeSpec, requireSpec } = await import('@specbridge/compat-kiro');
      const { approveStage } = await import('@specbridge/workflow');
      const workspace = workspaceOf(fixture);
      const approval = approveStage(
        workspace,
        analyzeSpec(workspace, requireSpec(workspace, EXECUTION_SPEC)),
        { stage: 'tasks' },
        { clock: fixture.clock },
      );
      expect(approval.ok).toBe(true);

      editSource(fixture);
      const complete = await callTool(session, 'task_complete', { runId, summary: 'Implemented.' });
      expect(complete.isError).toBe(true);
      expect(complete.errorCode).toBe('SBMCP013');
      const abort = await callTool(session, 'task_abort', { runId, reason: 'task changed mid-run' });
      expect(abort.isError).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('completion with an unknown run id fails with SBMCP011', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const result = await callTool(session, 'task_complete', {
        runId: 'no-such-run',
        summary: 'x',
      });
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('SBMCP011');
    } finally {
      await session.close();
    }
  });
});

describe('task_abort', () => {
  it('releases the lock, records the reason, and never resets source changes', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      editSource(fixture, 'half-finished work\n');

      const abort = await callTool(session, 'task_abort', {
        runId,
        reason: 'blocked on missing requirements detail',
      });
      expect(abort.isError).toBe(false);
      expect(abort.structured['status']).toBe('aborted');
      expect(abort.structured['remainingChangedPaths']).toEqual(['src/feature.txt']);
      expect(readInteractiveLock(workspaceOf(fixture)).state).toBe('absent');
      // Source preserved.
      expect(readFileSync(path.join(fixture.root, 'src', 'feature.txt'), 'utf8')).toBe(
        'half-finished work\n',
      );
      // Run record reflects the abort.
      const runJson = JSON.parse(
        readFileSync(path.join(fixture.root, '.specbridge', 'runs', runId, 'run.json'), 'utf8'),
      ) as { lifecycleStatus: string; abortReason: string };
      expect(runJson.lifecycleStatus).toBe('ABORTED');
      expect(runJson.abortReason).toContain('blocked on missing');

      // Aborting again returns the current status without mutation.
      const again = await callTool(session, 'task_abort', { runId, reason: 'again' });
      expect(again.isError).toBe(false);
      expect(again.structured['status']).toBe('already-aborted');

      // Completing an aborted run is refused.
      const complete = await callTool(session, 'task_complete', { runId, summary: 'late' });
      expect(complete.isError).toBe(true);
      expect(complete.errorCode).toBe('SBMCP012');
    } finally {
      await session.close();
    }
  });

  it('requires a non-empty reason', async () => {
    const fixture = setupExecutionFixture();
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      const runId = begin.structured['runId'] as string;
      const abort = await callTool(session, 'task_abort', { runId, reason: '   ' });
      expect(abort.isError).toBe(true);
      // The run stays active and can still be completed.
      editSource(fixture);
      const complete = await callTool(session, 'task_complete', { runId, summary: 'done after all' });
      expect(complete.isError).toBe(false);
    } finally {
      await session.close();
    }
  });
});

describe('lock diagnosis and recovery', () => {
  it('a crash-created stale lock is diagnosable and not silently removed', async () => {
    const fixture = setupExecutionFixture();
    const workspace = workspaceOf(fixture);
    // Simulate a crashed process: a valid lock whose pid is dead and whose
    // run record never finalized.
    const lockPath = interactiveLockPath(workspace);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadLock: InteractiveLock = {
      schemaVersion: '1.0.0',
      runId: 'crashed-run-000001',
      specName: EXECUTION_SPEC,
      taskId: '1',
      pid: 999_999_99,
      createdAt: '2026-07-13T00:00:00.000Z',
      heartbeatAt: '2026-07-13T00:00:00.000Z',
    };
    writeFileSync(lockPath, `${JSON.stringify(deadLock, null, 2)}\n`);

    const diagnosis = diagnoseInteractiveLock(workspace, () => new Date('2026-07-13T12:00:00.000Z'));
    expect(diagnosis.state).toBe('stale');
    expect(diagnosis.safeToRemove).toBe(true);
    expect(diagnosis.findings.join(' ')).toContain('no readable run record');

    // task_begin refuses while the stale lock exists (no silent stealing).
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect(begin.isError).toBe(true);
      expect(begin.errorCode).toBe('SBMCP010');
      expect(begin.text).toContain('recover-lock');
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('an ambiguous lock (alive owner) is reported active and never removable', async () => {
    const fixture = setupExecutionFixture();
    const workspace = workspaceOf(fixture);
    const lockPath = interactiveLockPath(workspace);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const aliveLock: InteractiveLock = {
      schemaVersion: '1.0.0',
      runId: 'alive-run-000001',
      specName: EXECUTION_SPEC,
      taskId: '1',
      pid: process.pid, // this very test process — provably alive
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    writeFileSync(lockPath, `${JSON.stringify(aliveLock, null, 2)}\n`);
    const diagnosis = diagnoseInteractiveLock(workspace);
    expect(diagnosis.state).toBe('active');
    expect(diagnosis.safeToRemove).toBe(false);
  });

  it('the recover-lock CLI removes a stale lock only with --remove', async () => {
    const fixture = setupExecutionFixture();
    const workspace = workspaceOf(fixture);
    const lockPath = interactiveLockPath(workspace);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          schemaVersion: '1.0.0',
          runId: 'crashed-run-000002',
          specName: EXECUTION_SPEC,
          taskId: '1',
          pid: 999_999_99,
          createdAt: '2026-07-13T00:00:00.000Z',
          heartbeatAt: '2026-07-13T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );

    const { runCli } = await import('../../packages/cli/src/cli.js');
    const out: string[] = [];
    const io = {
      cwd: fixture.root,
      out: (line: string) => out.push(line),
      outRaw: (text: string) => out.push(text),
      err: (line: string) => out.push(line),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    };

    // Diagnosis only: the lock stays.
    const diagnoseExit = await runCli(['run', 'recover-lock'], io);
    expect(diagnoseExit).toBe(1);
    expect(existsSync(lockPath)).toBe(true);
    expect(out.join('\n')).toContain('--remove');

    // Explicit confirmation removes it.
    const removeExit = await runCli(['run', 'recover-lock', '--remove'], io);
    expect(removeExit).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('recover-lock refuses to remove an active lock even with --remove', async () => {
    const fixture = setupExecutionFixture();
    const workspace = workspaceOf(fixture);
    const lockPath = interactiveLockPath(workspace);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          schemaVersion: '1.0.0',
          runId: 'alive-run-000002',
          specName: EXECUTION_SPEC,
          taskId: '1',
          pid: process.pid,
          createdAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    const { runCli } = await import('../../packages/cli/src/cli.js');
    const out: string[] = [];
    const io = {
      cwd: fixture.root,
      out: (line: string) => out.push(line),
      outRaw: (text: string) => out.push(text),
      err: (line: string) => out.push(line),
      now: () => new Date(),
    };
    const exit = await runCli(['run', 'recover-lock', '--remove'], io);
    expect(exit).toBe(0); // active lock: healthy state, nothing to recover
    expect(existsSync(lockPath)).toBe(true);
    expect(out.join('\n')).toContain('actively held');
  });
});

describe('multi-task flow', () => {
  it('verified tasks advance the plan; the next begin selects the following task', async () => {
    const fixture = setupExecutionFixture({
      verificationCommands: [passingCommand()],
    });
    const session = await connect(fixture);
    try {
      const first = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      expect((first.structured['task'] as { id: string }).id).toBe('1');
      editSource(fixture, 'task 1 work\n');
      const firstComplete = await callTool(session, 'task_complete', {
        runId: first.structured['runId'] as string,
        summary: 'Task 1 done.',
      });
      expect(firstComplete.structured['outcome']).toBe('verified');

      // Later tasks run over the uncommitted verified changes of earlier
      // ones (SpecBridge never commits), so the tree is legitimately dirty.
      const second = await callTool(session, 'task_begin', {
        specName: EXECUTION_SPEC,
        allowDirty: true,
      });
      expect(second.isError).toBe(false);
      expect((second.structured['task'] as { id: string }).id).toBe('2.1');
      const abort = await callTool(session, 'task_abort', {
        runId: second.structured['runId'] as string,
        reason: 'test cleanup',
      });
      expect(abort.isError).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('git history is never touched: no commits are created by the lifecycle', async () => {
    const fixture = setupExecutionFixture();
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.root,
      encoding: 'utf8',
    }).trim();
    const session = await connect(fixture);
    try {
      const begin = await callTool(session, 'task_begin', { specName: EXECUTION_SPEC });
      editSource(fixture);
      await callTool(session, 'task_complete', {
        runId: begin.structured['runId'] as string,
        summary: 'Implemented.',
      });
      const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture.root,
        encoding: 'utf8',
      }).trim();
      expect(headAfter).toBe(headBefore);
    } finally {
      await session.close();
    }
  });
});

describe('no nested agent invocation', () => {
  it('the interactive execution code paths never reference nested Claude execution', () => {
    // Static safety scan over the interactive lifecycle sources: the plugin
    // path must never spawn a nested agent (claude -p, spec run, runner
    // registry execution).
    const repoRoot = path.resolve(__dirname, '..', '..');
    const files = [
      'packages/execution/src/interactive.ts',
      'packages/execution/src/interactive-lock.ts',
      'packages/mcp-server/src/tools/task-begin.ts',
      'packages/mcp-server/src/tools/task-complete.ts',
      'packages/mcp-server/src/tools/task-abort.ts',
      'packages/mcp-server/src/tools/interactive-shared.ts',
    ];
    for (const file of files) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source, `${file} must not invoke claude`).not.toMatch(/claude\s+-p|claude -p/);
      expect(source, `${file} must not call spec run`).not.toMatch(/spec\s+run\b/);
      expect(source, `${file} must not use the runner registry`).not.toMatch(
        /RunnerRegistry|createDefaultRunnerRegistry|\.executeTask\(|\.generateStage\(/,
      );
      expect(source, `${file} must not spawn processes directly`).not.toMatch(
        /child_process|execa|spawn\(/,
      );
    }
  });
});

// Keep TypeScript aware this suite intentionally leaves temp dirs to the OS.
void rmSync;
