import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkdownDocument, parseTasks } from '@specbridge/compat-kiro';
import { listTaskEvidence } from '@specbridge/evidence';
import {
  listRuns,
  readRunArtifactJson,
  runAllOpenTasks,
  runApprovedTask,
  selectTask,
} from '@specbridge/execution';
import {
  EXECUTION_SPEC,
  failingCommand,
  git,
  passingCommand,
  setupExecutionFixture,
} from '../helpers-execution.js';

/**
 * End-to-end task execution over the deterministic mock runner: evidence
 * rules, git policy, checkbox surgery, append-only evidence, sequential
 * --all. Fully offline.
 */

function tasksPath(root: string): string {
  return path.join(root, '.kiro', 'specs', EXECUTION_SPEC, 'tasks.md');
}

async function run(fixture: ReturnType<typeof setupExecutionFixture>, request: Record<string, unknown> = {}) {
  return runApprovedTask(fixture.deps, { specName: EXECUTION_SPEC, ...request });
}

describe('task selection', () => {
  const fixture = setupExecutionFixture({ scenario: 'no-change' });
  const document = MarkdownDocument.load(tasksPath(fixture.root));
  const model = parseTasks(document);

  it('default selects the next incomplete required leaf task', () => {
    const selection = selectTask(model, document, { next: true });
    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.task.id).toBe('1');
  });

  it('explicit task id works, including nested ids', () => {
    const selection = selectTask(model, document, { taskId: '2.2' });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.task.id).toBe('2.2');
      expect(selection.task.requirementRefs).toContain('1.2');
    }
  });

  it('missing task is rejected with known ids listed', () => {
    const selection = selectTask(model, document, { taskId: '9.9' });
    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.reason).toBe('task-not-found');
      expect(selection.message).toContain('9.9');
    }
  });

  it('a parent task with children is not selectable', () => {
    const selection = selectTask(model, document, { taskId: '2' });
    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.reason).toBe('task-not-leaf');
      expect(selection.message).toContain('2.1');
    }
  });

  it('a completed task is rejected', () => {
    const completed = MarkdownDocument.fromText(
      '# Plan\n\n- [x] 1. Implement the thing\n- [ ] 2. Test the thing\n',
    );
    const completedModel = parseTasks(completed);
    const selection = selectTask(completedModel, completed, { taskId: '1' });
    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe('task-already-complete');
  });

  it('optional tasks are never picked by --next', () => {
    const doc = MarkdownDocument.fromText('# Plan\n\n- [x] 1. Implement\n- [ ]* 2. Optional extra\n');
    const selection = selectTask(parseTasks(doc), doc, { next: true });
    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe('no-open-tasks');
  });
});

describe('pre-run gates', () => {
  it('unapproved stages block execution', async () => {
    const fixture = setupExecutionFixture({ approve: false });
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('preflight-failed');
    if (outcome.kind === 'preflight-failed') {
      expect(outcome.preflight.failure?.code).toBe('unmanaged-spec');
      expect(outcome.exitCode).toBe(1);
    }
  });

  it('stale approvals block execution with re-approval remediation', async () => {
    const fixture = setupExecutionFixture();
    const designPath = path.join(fixture.root, '.kiro', 'specs', EXECUTION_SPEC, 'design.md');
    writeFileSync(designPath, `${readFileSync(designPath, 'utf8')}\nedited after approval\n`);
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('preflight-failed');
    if (outcome.kind === 'preflight-failed') {
      expect(outcome.preflight.failure?.code).toBe('stale-approval');
      expect(outcome.preflight.failure?.message).toContain('design');
      expect(outcome.preflight.failure?.remediation.join('\n')).toContain('spec approve');
    }
  });

  it('a dirty working tree is rejected by default and lists the paths', async () => {
    const fixture = setupExecutionFixture();
    writeFileSync(path.join(fixture.root, 'src', 'settings.txt'), 'user edit\n');
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('preflight-failed');
    if (outcome.kind === 'preflight-failed') {
      expect(outcome.preflight.failure?.code).toBe('dirty-working-tree');
      expect(outcome.preflight.failure?.dirtyPaths).toContain('src/settings.txt');
    }
  });

  it('the mock runner reports available and execution proceeds on a clean tree', async () => {
    const fixture = setupExecutionFixture();
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
  });
});

describe('verified task completion', () => {
  it('a successful run with passing verification is verified and updates exactly one checkbox', async () => {
    const fixture = setupExecutionFixture();
    const beforeBytes = readFileSync(tasksPath(fixture.root));
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;

    expect(outcome.report.evidenceStatus).toBe('verified');
    expect(outcome.report.checkboxUpdated).toBe(true);
    expect(outcome.report.exitCode).toBe(0);
    expect(outcome.report.taskId).toBe('1');

    // Byte-exact surgery: exactly one line changed, [ ] → [x].
    const afterBytes = readFileSync(tasksPath(fixture.root));
    const beforeLines = beforeBytes.toString('utf8').split('\n');
    const afterLines = afterBytes.toString('utf8').split('\n');
    expect(afterLines.length).toBe(beforeLines.length);
    const changed = beforeLines
      .map((line, index) => ({ line, index, after: afterLines[index] }))
      .filter((entry) => entry.line !== entry.after);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.line).toBe('- [ ] 1. Implement the settings store');
    expect(changed[0]?.after).toBe('- [x] 1. Implement the settings store');

    // Evidence record exists and is verified.
    const evidence = listTaskEvidence(fixture.workspace, EXECUTION_SPEC, '1');
    expect(evidence.records).toHaveLength(1);
    expect(evidence.records[0]?.status).toBe('verified');
    expect(evidence.records[0]?.verificationCommands.some((c) => c.passed)).toBe(true);

    // Run artifacts exist.
    const artifacts = outcome.report.artifactsDir;
    for (const file of ['run.json', 'prompt.md', 'runner-result.json', 'git-before.json', 'git-after.json', 'changed-files.json', 'verification.json', 'evidence.json', 'report.json']) {
      expect(existsSync(path.join(artifacts, file)), `${file} should exist`).toBe(true);
    }
  });

  it('the tasks approval hash is re-recorded so the next run still passes preflight', async () => {
    const fixture = setupExecutionFixture();
    const first = await run(fixture);
    expect(first.kind).toBe('executed');
    if (first.kind === 'executed') expect(first.report.evidenceStatus).toBe('verified');

    // The user commits the agent's work — but the checkbox update and the
    // sidecar state stay uncommitted. Those sanctioned edits must not trip
    // the clean-tree policy (the re-recorded hash proves they are intact).
    git(fixture.root, 'add', 'src/mock-change.txt');
    git(fixture.root, 'commit', '-q', '-m', 'task 1 implementation');
    expect(git(fixture.root, 'status', '--porcelain')).toContain('tasks.md');

    const second = await run(fixture);
    expect(second.kind).toBe('executed');
    if (second.kind === 'executed') {
      expect(second.report.taskId).toBe('2.1');
      expect(second.report.evidenceStatus).toBe('verified');
      expect(second.report.parentRunId).toBeUndefined();
    }
  });

  it('CRLF task documents keep their line endings through a checkbox update', async () => {
    const fixture = setupExecutionFixture();
    const file = tasksPath(fixture.root);
    const crlf = readFileSync(file, 'utf8').replace(/\n/g, '\r\n');
    writeFileSync(file, crlf, 'utf8');
    // Re-approve tasks so the hash matches the CRLF bytes.
    const { approveAllStages } = await import('../helpers-execution.js');
    approveAllStages(fixture.workspace, EXECUTION_SPEC, fixture.clock);

    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('verified');
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('- [x] 1. Implement the settings store\r\n');
    expect(after.includes('\r\n')).toBe(true);
    // No lone-LF lines were introduced.
    expect(after.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });
});

describe('unverified and failed outcomes leave the checkbox unchanged', () => {
  it('required verifier failure → implemented-unverified, checkbox unchanged, evidence retained', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand('test')] });
    const beforeBytes = readFileSync(tasksPath(fixture.root));
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;

    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(outcome.report.exitCode).toBe(1);
    expect(readFileSync(tasksPath(fixture.root)).equals(beforeBytes)).toBe(true);
    expect(existsSync(path.join(fixture.root, 'src', 'mock-change.txt'))).toBe(true);

    const evidence = listTaskEvidence(fixture.workspace, EXECUTION_SPEC, '1');
    expect(evidence.records[0]?.status).toBe('implemented-unverified');
  });

  it('optional verifier failure only warns; the task still verifies', async () => {
    const fixture = setupExecutionFixture({
      verificationCommands: [passingCommand('test'), failingCommand('lint', false)],
    });
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('verified');
    expect(outcome.report.warnings.join(' ')).toContain('optional verification command "lint" failed');
  });

  it('a completed claim without any repository change is no-change, never verified', async () => {
    const fixture = setupExecutionFixture({ scenario: 'no-change' });
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('no-change');
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(outcome.report.exitCode).toBe(1);
  });

  it('claimed tests that never ran do not verify anything without configured commands', async () => {
    const fixture = setupExecutionFixture({ scenario: 'claims-untested', verificationCommands: [] });
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
    expect(outcome.report.reasons.join(' ')).toContain('no verification commands are configured');
    // The claim is preserved as a claim in the evidence record.
    const evidence = listTaskEvidence(fixture.workspace, EXECUTION_SPEC, '1');
    expect(evidence.records[0]?.runnerClaims.testsReported[0]?.status).toBe('passed');
  });

  it('--no-verify skips verification and cannot verify the task', async () => {
    const fixture = setupExecutionFixture();
    const outcome = await run(fixture, { noVerify: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
    expect(outcome.report.verification.skipped).toBe(true);
    expect(outcome.report.checkboxUpdated).toBe(false);
  });

  it.each([
    ['blocked', 'blocked', 1],
    ['failed', 'failed', 4],
    ['timeout', 'timed-out', 5],
    ['cancelled', 'cancelled', 5],
    ['permission-denied', 'failed', 6],
    ['malformed-output', 'failed', 4],
  ] as const)('mock scenario %s → evidence %s, exit %d, checkbox unchanged', async (scenario, expected, exitCode) => {
    const fixture = setupExecutionFixture({ scenario });
    const beforeBytes = readFileSync(tasksPath(fixture.root));
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe(expected);
    expect(outcome.report.exitCode).toBe(exitCode);
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(readFileSync(tasksPath(fixture.root)).equals(beforeBytes)).toBe(true);
  });
});

describe('protected paths and safety violations', () => {
  it('a runner writing into .kiro prevents verification and reports the violation', async () => {
    const fixture = setupExecutionFixture({ scenario: 'protected-path' });
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).not.toBe('verified');
    expect(outcome.report.violations.join(' ')).toContain('.kiro/mock-rogue-write.txt');
    expect(outcome.report.checkboxUpdated).toBe(false);
    // No automatic rollback: the rogue file is still there.
    expect(existsSync(path.join(fixture.root, '.kiro', 'mock-rogue-write.txt'))).toBe(true);
  });

  it('a runner editing tasks.md directly prevents verification', async () => {
    const fixture = setupExecutionFixture({ scenario: 'modify-tasks-doc' });
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).not.toBe('verified');
    expect(outcome.report.violations.join(' ')).toContain('tasks.md');
  });

  it('configured protected paths are enforced', async () => {
    const fixture = setupExecutionFixture({
      execution: { protectedPaths: ['src'] },
    });
    const outcome = await run(fixture);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    // The mock change file lives under src/ → violation.
    expect(outcome.report.violations.join(' ')).toContain('src/mock-change.txt');
    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
  });
});

describe('--allow-dirty baseline attribution', () => {
  it('pre-existing changes are captured and never attributed to the task', async () => {
    const fixture = setupExecutionFixture();
    writeFileSync(path.join(fixture.root, 'src', 'settings.txt'), 'user edit before run\n');
    const outcome = await run(fixture, { allowDirty: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;

    expect(outcome.report.evidenceStatus).toBe('verified');
    const preExisting = outcome.report.changedFiles.find((f) => f.path === 'src/settings.txt');
    expect(preExisting?.preExisting).toBe(true);
    expect(preExisting?.modifiedDuringRun).toBe(false);
    const agentChange = outcome.report.changedFiles.find((f) => f.path === 'src/mock-change.txt');
    expect(agentChange?.preExisting).toBe(false);
    expect(agentChange?.modifiedDuringRun).toBe(true);
    expect(outcome.report.warnings.join(' ')).toContain('--allow-dirty');
  });

  it('untracked files are captured with hashes in the baseline', async () => {
    const fixture = setupExecutionFixture();
    writeFileSync(path.join(fixture.root, 'notes.txt'), 'untracked scratch file\n');
    const outcome = await run(fixture, { allowDirty: true });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    const before = readRunArtifactJson(fixture.workspace, outcome.report.runId, 'git-before.json') as {
      entries: { path: string; contentHash?: string }[];
    };
    const entry = before.entries.find((candidate) => candidate.path === 'notes.txt');
    expect(entry).toBeDefined();
    expect(entry?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sequential --all', () => {
  it('executes open required leaf tasks in order and verifies each', async () => {
    const fixture = setupExecutionFixture();
    const summary = await runAllOpenTasks(fixture.deps, { specName: EXECUTION_SPEC });
    expect(summary.attempted.map((report) => report.taskId)).toEqual(['1', '2.1', '2.2', '3']);
    expect(summary.attempted.every((report) => report.evidenceStatus === 'verified')).toBe(true);
    expect(summary.stoppedBecause).toBeUndefined();
    expect(summary.exitCode).toBe(0);

    // The optional task 4 was not executed and stays open.
    const document = readFileSync(tasksPath(fixture.root), 'utf8');
    expect(document).toContain('- [ ]* 4. Add optional performance benchmarks');
    expect(document).not.toContain('- [ ] 1.');

    // One run directory per task, all sequential (no parallelism).
    const { runs } = listRuns(fixture.workspace);
    expect(runs).toHaveLength(4);
    const spans = runs
      .map((record) => ({ start: record.createdAt, end: record.finishedAt ?? record.createdAt }))
      .sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < spans.length; i += 1) {
      expect((spans[i]?.start ?? '') >= (spans[i - 1]?.end ?? '')).toBe(true);
    }
  });

  it('stops at the first unverified task and leaves later checkboxes unchanged', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const summary = await runAllOpenTasks(fixture.deps, { specName: EXECUTION_SPEC });
    expect(summary.attempted).toHaveLength(1);
    expect(summary.attempted[0]?.evidenceStatus).toBe('implemented-unverified');
    expect(summary.stoppedBecause).toContain('task 1');
    expect(summary.exitCode).toBe(1);
    const document = readFileSync(tasksPath(fixture.root), 'utf8');
    expect(document).not.toContain('[x]');
  });

  it('stops immediately on a hard failure', async () => {
    const fixture = setupExecutionFixture({ scenario: 'failed' });
    const summary = await runAllOpenTasks(fixture.deps, { specName: EXECUTION_SPEC });
    expect(summary.attempted).toHaveLength(1);
    expect(summary.attempted[0]?.evidenceStatus).toBe('failed');
    expect(summary.stoppedBecause).toContain('failed');
  });
});

describe('evidence storage is append-only', () => {
  it('each attempt gets its own record and prior attempts are preserved', async () => {
    const fixture = setupExecutionFixture({ verificationCommands: [failingCommand()] });
    const first = await run(fixture, { taskId: '1' });
    expect(first.kind).toBe('executed');

    // Fix verification, then retry the same task.
    writeFixtureVerification(fixture.root, [passingCommand()]);
    const refreshed = refreshFixtureConfig(fixture);
    const second = await runApprovedTask(refreshed, { specName: EXECUTION_SPEC, taskId: '1', allowDirty: true });
    expect(second.kind).toBe('executed');
    if (second.kind !== 'executed' || first.kind !== 'executed') return;

    expect(second.report.parentRunId).toBe(first.report.runId);
    const evidence = listTaskEvidence(fixture.workspace, EXECUTION_SPEC, '1');
    expect(evidence.records).toHaveLength(2);
    expect(evidence.records.map((record) => record.status).sort()).toEqual([
      'implemented-unverified',
      'verified',
    ]);
  });
});

describe('dry run', () => {
  it('invokes nothing, writes nothing, and prints the full plan', async () => {
    const fixture = setupExecutionFixture();
    const statusBefore = git(fixture.root, 'status', '--porcelain');
    const outcome = await run(fixture, { taskId: '2.1', dryRun: true });
    expect(outcome.kind).toBe('dry-run');
    if (outcome.kind !== 'dry-run') return;

    expect(outcome.plan.task.id).toBe('2.1');
    expect(outcome.plan.runner).toBe('mock');
    expect(outcome.plan.verificationCommands[0]?.argv[0]).toBe(process.execPath);
    expect(outcome.plan.prompt).toContain('>>> IMPLEMENT THIS TASK ONLY: 2.1.');
    expect(outcome.plan.prompt).toContain('SpecBridge control instructions');
    expect(outcome.plan.expectedArtifacts.some((artifact) => artifact.endsWith('evidence.json'))).toBe(true);

    // No run directory, no evidence, no mock change, no git change.
    expect(listRuns(fixture.workspace).runs).toHaveLength(0);
    expect(existsSync(path.join(fixture.root, 'src', 'mock-change.txt'))).toBe(false);
    expect(git(fixture.root, 'status', '--porcelain')).toBe(statusBefore);
  });
});

// -- small local helpers ----------------------------------------------------

function writeFixtureVerification(root: string, commands: Record<string, unknown>[]): void {
  const configPath = path.join(root, '.specbridge', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config['verification'] = { commands };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function refreshFixtureConfig(fixture: ReturnType<typeof setupExecutionFixture>) {
  // Re-read config and rebuild the registry after editing config.json.
  const read = readAgentConfigLocal(fixture);
  return { ...fixture.deps, config: read.config, registry: read.registry };
}

import { readAgentConfig } from '@specbridge/core';
import { createDefaultRunnerRegistry } from '@specbridge/runners';

function readAgentConfigLocal(fixture: ReturnType<typeof setupExecutionFixture>) {
  const result = readAgentConfig(fixture.workspace);
  if (result.config === undefined) throw new Error('fixture config became invalid');
  return { config: result.config, registry: createDefaultRunnerRegistry(result.config) };
}
