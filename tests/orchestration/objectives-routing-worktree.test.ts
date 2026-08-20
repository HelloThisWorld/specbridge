import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultOrchestrationPolicy, resolveWorkspace } from '@specbridge/core';
import {
  CLAUDE_WORKER_ID,
  collectWorktreeChanges,
  createWorkerWorktree,
  pruneWorktrees,
  removeWorkerWorktree,
  runWorktreeVerification,
  selectWorker,
} from '@specbridge/orchestration';
import type { JobWorkerProfile } from '@specbridge/orchestration';
import { emptyTempDir } from '../helpers.js';

/**
 * Objective-role routing (deterministic, local-first-with-boundaries) and
 * the isolated worktree lifecycle.
 */

const POLICY = defaultOrchestrationPolicy().jobs;

const LOCAL: JobWorkerProfile = {
  workerId: 'local-llamacpp',
  roles: ['CLASSIFIER', 'PLANNER', 'CRITIC', 'DIAGNOSER', 'REPLANNER', 'EVALUATOR'],
  reasoningTier: 'LOCAL_SMALL',
  costTier: 'LOCAL',
  repositoryRead: false,
  repositoryWrite: false,
  structuredOutput: true,
  localOnly: true,
  requiresNetwork: false,
  supportsCancellation: true,
  maxInputCharacters: 100_000,
};

const CLAUDE: JobWorkerProfile = {
  workerId: CLAUDE_WORKER_ID,
  runnerProfile: 'claude-code',
  roles: [
    'CLASSIFIER', 'PLANNER', 'CRITIC', 'DIAGNOSER', 'REPLANNER', 'EXECUTOR',
    'DECOMPOSER', 'BUILDER', 'EVALUATOR', 'AGGREGATOR', 'INTEGRATOR',
  ],
  reasoningTier: 'LARGE_AGENT',
  costTier: 'PAID',
  repositoryRead: true,
  repositoryWrite: true,
  structuredOutput: true,
  localOnly: false,
  requiresNetwork: true,
  supportsCancellation: true,
  maxInputCharacters: 500_000,
};

describe('objective-role routing', () => {
  it('BUILDER and INTEGRATOR structurally require a repository-writing worker', () => {
    for (const role of ['BUILDER', 'INTEGRATOR'] as const) {
      const selected = selectWorker({
        role,
        complexity: 'LOW',
        policy: POLICY,
        workers: [LOCAL, CLAUDE],
        nodeEscalations: [],
      });
      expect(selected.worker.workerId).toBe(CLAUDE_WORKER_ID);
      expect(selected.worker.repositoryWrite).toBe(true);
      // Without a writer, the selection fails closed.
      expect(() =>
        selectWorker({ role, complexity: 'LOW', policy: POLICY, workers: [LOCAL], nodeEscalations: [] }),
      ).toThrow(/repository-writing/);
    }
  });

  it('DECOMPOSER and AGGREGATOR route to the large agent by default (architecture-sensitive)', () => {
    for (const role of ['DECOMPOSER', 'AGGREGATOR'] as const) {
      const selected = selectWorker({
        role,
        complexity: 'LOW',
        policy: POLICY,
        workers: [LOCAL, CLAUDE],
        nodeEscalations: [],
      });
      expect(selected.worker.workerId).toBe(CLAUDE_WORKER_ID);
      expect(selected.escalation?.reason).toBe('ROLE_POLICY');
    }
  });

  it('EVALUATOR is local-first but HIGH complexity escalates with a recorded reason', () => {
    const local = selectWorker({
      role: 'EVALUATOR',
      complexity: 'LOW',
      policy: POLICY,
      workers: [LOCAL, CLAUDE],
      nodeEscalations: [],
    });
    expect(local.worker.workerId).toBe('local-llamacpp');
    expect(local.escalation).toBeUndefined();

    const high = selectWorker({
      role: 'EVALUATOR',
      complexity: 'HIGH',
      policy: POLICY,
      workers: [LOCAL, CLAUDE],
      nodeEscalations: [],
    });
    expect(high.worker.workerId).toBe(CLAUDE_WORKER_ID);
    expect(high.escalation?.reason).toBe('COMPLEXITY_HIGH');
  });
});

function gitFixture(): { root: string; workspace: NonNullable<ReturnType<typeof resolveWorkspace>> } {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro', 'specs'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'existing.js'), 'module.exports = 1;\n', 'utf8');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'tests@specbridge.invalid');
  git('config', 'user.name', 'SpecBridge Tests');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-q', '-m', 'baseline');
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('no workspace');
  return { root, workspace };
}

describe('isolated worktrees', () => {
  it('creates an isolated checkout, observes exactly what a builder changed, and removes it', async () => {
    const { root, workspace } = gitFixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-1', attempt: 1 });
    expect(existsSync(handle.dir)).toBe(true);
    expect(handle.dir).toContain(path.join('.specbridge', 'jobs', 'job-1', 'worktrees'));

    // A "builder" edits the worktree — the canonical tree stays untouched.
    writeFileSync(path.join(handle.dir, 'src', 'new-module.js'), 'module.exports = 2;\n', 'utf8');
    writeFileSync(path.join(handle.dir, 'src', 'existing.js'), 'module.exports = 42;\n', 'utf8');
    expect(existsSync(path.join(root, 'src', 'new-module.js'))).toBe(false);

    const collected = await collectWorktreeChanges(handle, { protectedPaths: [] });
    expect(collected.changedFiles.map((file) => `${file.changeType}:${file.path}`).sort()).toEqual([
      'added:src/new-module.js',
      'modified:src/existing.js',
    ]);
    expect(collected.patch).toMatch(/diff --git/);
    expect(collected.protectedViolations).toEqual([]);

    // Local verification runs INSIDE the worktree.
    const verification = await runWorktreeVerification(handle, [
      { name: 'check', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60_000, required: true },
    ]);
    expect(verification.passed).toBe(true);

    await removeWorkerWorktree(workspace, 'job-1', handle);
    expect(existsSync(handle.dir)).toBe(false);
    expect(execFileSync('git', ['worktree', 'list'], { cwd: root, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  });

  it('flags protected-path writes (.kiro, .specbridge) at collection time', async () => {
    const { workspace } = gitFixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-2', attempt: 1 });
    mkdirSync(path.join(handle.dir, '.kiro', 'specs', 'rogue'), { recursive: true });
    writeFileSync(path.join(handle.dir, '.kiro', 'specs', 'rogue', 'tasks.md'), '- [x] 1. rogue\n', 'utf8');
    const collected = await collectWorktreeChanges(handle, { protectedPaths: [] });
    expect(collected.protectedViolations).toContain('.kiro/specs/rogue/tasks.md');
    await removeWorkerWorktree(workspace, 'job-1', handle);
  });

  it('a worker committing locally cannot hide changes: the diff is against the recorded baseline', async () => {
    const { workspace } = gitFixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-3', attempt: 1 });
    writeFileSync(path.join(handle.dir, 'src', 'sneaky.js'), 'module.exports = 3;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: handle.dir });
    execFileSync('git', ['-c', 'user.email=w@x.invalid', '-c', 'user.name=w', 'commit', '-q', '-m', 'sneaky local commit'], { cwd: handle.dir });
    const collected = await collectWorktreeChanges(handle, { protectedPaths: [] });
    expect(collected.changedFiles.map((file) => file.path)).toContain('src/sneaky.js');
    await removeWorkerWorktree(workspace, 'job-1', handle);
  });

  it('prune reconciles crashed worktrees on resume', async () => {
    const { workspace } = gitFixture();
    await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-4', attempt: 1 });
    const removed = await pruneWorktrees(workspace, 'job-1');
    expect(removed).toContain('wu-4-a01');
  });
});
