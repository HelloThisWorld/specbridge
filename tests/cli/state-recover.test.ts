import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertInsideSidecar, resolveWorkspace, type WorkspaceInfo } from '@specbridge/core';
import { testWorkflowState } from '../helpers';
import {
  V1_CONFIG,
  cli,
  kiroWorkspace,
  listTree,
  read,
  sha256,
  specWorkspace,
  treeHash,
  write,
  writeInterruptedMigration,
} from './corruption-helpers';

const CACHE_REL = '.specbridge/registry-cache/examples.json';
const CACHE_CONTENT = '{broken cache bytes';

interface PlanReport {
  data: {
    result: string;
    planId: string;
    acknowledgementToken: string;
    applyCommand: string;
    planPath: string;
    actions: Array<{ actionId: string; kind: string; file?: string; sha256?: string | null }>;
  };
}

interface ApplyReport {
  data: {
    result: string;
    actions: Array<{ actionId: string; kind: string; status: string; quarantinePath?: string }>;
    problems: string[];
    logPath: string;
  };
}

function corruptCacheWorkspace(): string {
  const root = kiroWorkspace();
  write(root, CACHE_REL, CACHE_CONTENT);
  return root;
}

async function planFor(root: string): Promise<PlanReport> {
  const result = await cli(root, 'state', 'recover', '--plan', '--json');
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as PlanReport;
}

async function applyPlan(root: string, planId: string, ack: string): Promise<{ code: number; report: ApplyReport }> {
  const result = await cli(root, 'state', 'recover', '--apply', planId, '--ack', ack, '--json');
  return { code: result.code, report: JSON.parse(result.stdout) as ApplyReport };
}

function workspaceOf(root: string): WorkspaceInfo {
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error(`no workspace at ${root}`);
  return workspace;
}

describe('state recover --plan', () => {
  it('persists a hash-bound plan and prints the acknowledgement token', async () => {
    const root = corruptCacheWorkspace();
    const plan = await planFor(root);
    expect(plan.data.result).toBe('planned');
    expect(plan.data.acknowledgementToken).toMatch(/^[0-9a-f]{12}$/);
    expect(plan.data.applyCommand).toContain(plan.data.planId);
    expect(plan.data.applyCommand).toContain(plan.data.acknowledgementToken);
    expect(plan.data.actions).toHaveLength(1);
    expect(plan.data.actions[0]).toMatchObject({
      actionId: 'a1',
      kind: 'quarantine-file',
      file: CACHE_REL,
      sha256: sha256(CACHE_CONTENT),
    });
    expect(existsSync(path.join(root, ...plan.data.planPath.split('/')))).toBe(true);
  });

  it('writes ONLY the plan file (plus its directories)', async () => {
    const root = corruptCacheWorkspace();
    const before = listTree(root);
    await planFor(root);
    const added = listTree(root).filter((entry) => !before.includes(entry));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((entry) => entry.startsWith('.specbridge/recovery'))).toBe(true);
    expect(read(root, CACHE_REL).toString('utf8')).toBe(CACHE_CONTENT);
  });

  it('orders actions deterministically by family then path with ids a1..aN', async () => {
    const root = kiroWorkspace();
    write(root, CACHE_REL, CACHE_CONTENT); // registries
    write(root, '.specbridge/locks/interactive-task.lock', '{not json'); // runs
    write(
      root,
      '.specbridge/state/specs/ghost.json',
      `${JSON.stringify(testWorkflowState({ specName: 'ghost' }), null, 2)}\n`,
    ); // spec-state (orphan)
    const plan = await planFor(root);
    expect(plan.data.actions.map((action) => [action.actionId, action.kind])).toEqual([
      ['a1', 'quarantine-file'],
      ['a2', 'remove-stale-lock'],
      ['a3', 'archive-orphan-state'],
    ]);
  });

  it('reports nothing to recover and writes nothing on a healthy workspace', async () => {
    const root = specWorkspace();
    const before = treeHash(root);
    const result = await cli(root, 'state', 'recover');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('needs no recovery');
    expect(treeHash(root)).toBe(before);
    expect(existsSync(path.join(root, '.specbridge', 'recovery'))).toBe(false);
  });
});

describe('state recover --apply', () => {
  it('requires --ack and refuses to run without it', async () => {
    const root = corruptCacheWorkspace();
    const plan = await planFor(root);
    const result = await cli(root, 'state', 'recover', '--apply', plan.data.planId);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--apply requires --ack');
  });

  it('refuses a wrong acknowledgement token and changes nothing', async () => {
    const root = corruptCacheWorkspace();
    const plan = await planFor(root);
    const { code, report } = await applyPlan(root, plan.data.planId, 'ffffffffffff');
    expect(code).toBe(1);
    expect(report.data.result).toBe('refused-bad-acknowledgement');
    expect(read(root, CACHE_REL).toString('utf8')).toBe(CACHE_CONTENT);
  });

  it('refuses an unknown plan id with a clear message', async () => {
    const root = corruptCacheWorkspace();
    const result = await cli(root, 'state', 'recover', '--apply', 'r-nope', '--ack', 'aaaaaaaaaaaa');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No readable recovery plan');
  });

  it('quarantines the corrupt cache, preserves the original bytes, and appends to the log', async () => {
    const root = corruptCacheWorkspace();
    const plan = await planFor(root);
    const { code, report } = await applyPlan(root, plan.data.planId, plan.data.acknowledgementToken);
    expect(code).toBe(0);
    expect(report.data.result).toBe('applied');
    expect(report.data.actions[0]?.status).toBe('applied');

    // Original path is gone; the exact bytes live in quarantine.
    expect(existsSync(path.join(root, ...CACHE_REL.split('/')))).toBe(false);
    const quarantined = path.join(
      root,
      '.specbridge',
      'quarantine',
      plan.data.planId,
      'registry-cache',
      'examples.json',
    );
    expect(existsSync(quarantined)).toBe(true);
    expect(sha256(readFileSync(quarantined))).toBe(sha256(CACHE_CONTENT));

    const log = read(root, '.specbridge/recovery/log.jsonl').toString('utf8');
    const lines = log.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1] as string) as { planId: string; status: string };
    expect(last.planId).toBe(plan.data.planId);
    expect(last.status).toBe('applied');
  });

  it('refuses to apply the same plan twice (target file is gone)', async () => {
    const root = corruptCacheWorkspace();
    const plan = await planFor(root);
    await applyPlan(root, plan.data.planId, plan.data.acknowledgementToken);
    const { code, report } = await applyPlan(root, plan.data.planId, plan.data.acknowledgementToken);
    expect(code).toBe(1);
    expect(report.data.result).toBe('refused-stale-plan');
    expect(report.data.problems.join(' ')).toContain('no longer exists');
  });

  it('refuses when the target file changed between plan and apply', async () => {
    const root = corruptCacheWorkspace();
    const plan = await planFor(root);
    write(root, CACHE_REL, '{different broken bytes');
    const { code, report } = await applyPlan(root, plan.data.planId, plan.data.acknowledgementToken);
    expect(code).toBe(1);
    expect(report.data.result).toBe('refused-stale-plan');
    expect(read(root, CACHE_REL).toString('utf8')).toBe('{different broken bytes');
  });

  it('archives orphan spec state into quarantine', async () => {
    const root = kiroWorkspace();
    const stateJson = `${JSON.stringify(testWorkflowState({ specName: 'ghost' }), null, 2)}\n`;
    write(root, '.specbridge/state/specs/ghost.json', stateJson);
    const plan = await planFor(root);
    expect(plan.data.actions[0]?.kind).toBe('archive-orphan-state');
    const { code } = await applyPlan(root, plan.data.planId, plan.data.acknowledgementToken);
    expect(code).toBe(0);
    expect(existsSync(path.join(root, '.specbridge', 'state', 'specs', 'ghost.json'))).toBe(false);
    const quarantined = path.join(
      root,
      '.specbridge',
      'quarantine',
      plan.data.planId,
      'state',
      'specs',
      'ghost.json',
    );
    expect(readFileSync(quarantined, 'utf8')).toBe(stateJson);
  });

  it('moves an unreadable stale lock into quarantine', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/locks/interactive-task.lock', '{not json');
    const plan = await planFor(root);
    expect(plan.data.actions[0]?.kind).toBe('remove-stale-lock');
    const { code } = await applyPlan(root, plan.data.planId, plan.data.acknowledgementToken);
    expect(code).toBe(0);
    expect(existsSync(path.join(root, '.specbridge', 'locks', 'interactive-task.lock'))).toBe(false);
    expect(
      existsSync(
        path.join(root, '.specbridge', 'quarantine', plan.data.planId, 'locks', 'interactive-task.lock'),
      ),
    ).toBe(true);
  });

  it('restores an interrupted migration from its backup, quarantining the broken bytes', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', '{broken');
    writeInterruptedMigration(root, { backupContent: V1_CONFIG });
    const plan = await planFor(root);
    expect(plan.data.actions).toHaveLength(1);
    expect(plan.data.actions[0]?.kind).toBe('restore-from-migration-backup');
    const { code, report } = await applyPlan(root, plan.data.planId, plan.data.acknowledgementToken);
    expect(code).toBe(0);
    expect(report.data.result).toBe('applied');
    expect(read(root, '.specbridge/config.json').toString('utf8')).toBe(V1_CONFIG);
    const quarantined = path.join(root, '.specbridge', 'quarantine', plan.data.planId, 'config.json');
    expect(readFileSync(quarantined, 'utf8')).toBe('{broken');
  });
});

describe('recovery safety boundaries', () => {
  it('assertInsideSidecar refuses paths outside .specbridge', () => {
    const root = specWorkspace();
    const workspace = workspaceOf(root);
    expect(() => assertInsideSidecar(workspace, '../.kiro/x')).toThrow();
    expect(() => assertInsideSidecar(workspace, '.kiro/specs/a/requirements.md')).toThrow(
      /only files inside \.specbridge\//,
    );
    expect(assertInsideSidecar(workspace, '.specbridge/registry-cache/examples.json')).toContain(
      '.specbridge',
    );
  });

  it('never proposes recovery for the evidence family', async () => {
    const root = specWorkspace();
    write(root, '.specbridge/evidence/demo/1/run-1.json', '{}');
    const before = treeHash(root);
    const result = await cli(root, 'state', 'recover', '--plan');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('needs no recovery');
    expect(treeHash(root)).toBe(before);

    // Even alongside recoverable problems, no action ever touches evidence.
    write(root, CACHE_REL, CACHE_CONTENT);
    const plan = await planFor(root);
    expect(plan.data.actions).toHaveLength(1);
    expect(plan.data.actions.every((action) => !(action.file ?? '').includes('evidence'))).toBe(true);
  });

  it('doctor --repair-plan previews the same actions and writes nothing', async () => {
    const root = corruptCacheWorkspace();
    const before = treeHash(root);
    const result = await cli(root, 'doctor', '--repair-plan');
    expect(result.stdout).toContain('Recovery preview (--repair-plan)');
    expect(result.stdout).toContain('quarantine-file');
    expect(result.stdout).toContain('Nothing was written');
    expect(result.stdout).toContain('state recover --plan');
    expect(treeHash(root)).toBe(before);

    const healthy = specWorkspace();
    const healthyBefore = treeHash(healthy);
    const healthyResult = await cli(healthy, 'doctor', '--repair-plan');
    expect(healthyResult.stdout).toContain('No recovery actions are proposed');
    expect(treeHash(healthy)).toBe(healthyBefore);
  });

  it('rejects --ack without --apply and --plan combined with --apply', async () => {
    const root = corruptCacheWorkspace();
    const ackOnly = await cli(root, 'state', 'recover', '--ack', 'aaaaaaaaaaaa');
    expect(ackOnly.code).toBe(2);
    const both = await cli(root, 'state', 'recover', '--plan', '--apply', 'r-x', '--ack', 'aaaaaaaaaaaa');
    expect(both.code).toBe(2);
  });
});
