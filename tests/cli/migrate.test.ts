import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyMigrationPlan,
  buildMigrationPlan,
  resolveWorkspace,
  type WorkspaceInfo,
} from '@specbridge/core';
import { collectMigrationSteps } from '../../packages/cli/src/state/state-families';
import { fixedClock } from '../helpers';
import {
  V1_CONFIG,
  cli,
  kiroWorkspace,
  read,
  sha256,
  specWorkspace,
  treeHash,
  write,
  writeValidSpecState,
} from './corruption-helpers';

function workspaceOf(root: string): WorkspaceInfo {
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error(`no workspace at ${root}`);
  return workspace;
}

const REPORT_FILES = [
  'backups.json',
  'changed-files.json',
  'diagnostics.json',
  'plan.json',
  'result.json',
  'summary.md',
];

describe('migrate status', () => {
  it('exits 0 on a clean workspace with nothing pending', async () => {
    const root = specWorkspace();
    writeValidSpecState(root);
    const result = await cli(root, 'migrate', 'status');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nothing to migrate and nothing invalid.');
    expect(result.stdout).toContain('no migration has ever been required');
  });

  it('reports a pending config migration and exits 1', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const result = await cli(root, 'migrate', 'status', '--json');
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: {
        healthy: boolean;
        pendingSteps: Array<{ stepId: string; fromVersion: string; toVersion: string }>;
        families: Array<{ family: string; pendingMigrations: number; schemaVersionsFound: string[] }>;
      };
    };
    expect(report.schema).toBe('specbridge.migrate-status/1');
    expect(report.data.healthy).toBe(false);
    expect(report.data.pendingSteps[0]?.stepId).toBe('config-v1-to-v2');
    const config = report.data.families.find((family) => family.family === 'config');
    expect(config?.pendingMigrations).toBe(1);
    expect(config?.schemaVersionsFound).toContain('1.0.0');
  });

  it('is honest that only the config family has ever had a migration', async () => {
    const root = specWorkspace();
    writeValidSpecState(root);
    const result = await cli(root, 'migrate', 'status', '--json');
    const report = JSON.parse(result.stdout) as {
      data: { families: Array<{ family: string; note: string }> };
    };
    for (const family of report.data.families) {
      if (family.family === 'config') continue;
      expect(family.note).toContain('no migration has ever been required');
    }
  });
});

describe('migrate plan', () => {
  it('prints the step, changes, and plan hash without writing anything', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const before = treeHash(root);
    const result = await cli(root, 'migrate', 'plan');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('config-v1-to-v2');
    expect(result.stdout).toContain('1.0.0 → 2.0.0');
    expect(result.stdout).toContain('Plan hash:');
    expect(treeHash(root)).toBe(before);
    expect(existsSync(path.join(root, '.specbridge', 'migrations'))).toBe(false);
  });

  it('reports nothing to migrate on an already-current workspace', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', `${JSON.stringify({ schemaVersion: '2.0.0' }, null, 2)}\n`);
    const result = await cli(root, 'migrate', 'plan');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nothing to migrate');
  });

  it('emits the full hash-bound plan as clean JSON', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const result = await cli(root, 'migrate', 'plan', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: { result: string; plan: { planHash: string; steps: Array<{ beforeSha256: string; content: string }> } };
    };
    expect(report.schema).toBe('specbridge.migrate-plan/1');
    expect(report.data.result).toBe('planned');
    expect(report.data.plan.steps).toHaveLength(1);
    expect(report.data.plan.steps[0]?.beforeSha256).toBe(sha256(V1_CONFIG));
    expect(report.data.plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects any --target except the current product version', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const result = await cli(root, 'migrate', 'plan', '--target', '0.9.0');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--target 0.9.0 is not supported');
  });

  it('surfaces an invalid configuration instead of planning around it', async () => {
    const root = kiroWorkspace();
    write(
      root,
      '.specbridge/config.json',
      `${JSON.stringify({ schemaVersion: '1.0.0', note: 'dangerously-skip-permissions' }, null, 2)}\n`,
    );
    const result = await cli(root, 'migrate', 'plan');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot be migrated');
    expect(existsSync(path.join(root, '.specbridge', 'migrations'))).toBe(false);
  });
});

describe('migrate apply', () => {
  it('--dry-run prints the plan and writes nothing', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const before = treeHash(root);
    const result = await cli(root, 'migrate', 'apply', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Dry run: nothing was written.');
    expect(treeHash(root)).toBe(before);
  });

  it('migrates v1 to v2 atomically with a byte-identical backup and full report', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const result = await cli(root, 'migrate', 'apply', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      data: { result: string; planId: string; reportDir: string; steps: Array<{ status: string; backupPath: string }> };
    };
    expect(report.data.result).toBe('applied');
    expect(report.data.steps[0]?.status).toBe('applied');

    const migrated = JSON.parse(read(root, '.specbridge/config.json').toString('utf8')) as {
      schemaVersion: string;
      runnerProfiles: Record<string, { enabled?: boolean }>;
      verification: { commands: Array<{ name: string }> };
    };
    expect(migrated.schemaVersion).toBe('2.0.0');
    expect(migrated.verification.commands[0]?.name).toBe('test');
    // New profiles exist but stay disabled; nothing is silently enabled.
    expect(migrated.runnerProfiles['codex-default']?.enabled).toBe(false);
    expect(migrated.runnerProfiles['ollama-local']?.enabled).toBe(false);

    const backupPath = report.data.steps[0]?.backupPath as string;
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(readFileSync(backupPath))).toBe(sha256(V1_CONFIG));

    // The default backup location lives inside the report dir; the six
    // report files must all be present alongside it.
    const reportFiles = readdirSync(report.data.reportDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'));
    expect(reportFiles).toEqual(REPORT_FILES);
  });

  it('is idempotent: a second apply finds nothing to do and writes nothing new', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const first = await cli(root, 'migrate', 'apply', '--json');
    expect(first.code).toBe(0);
    const migrationsDir = path.join(root, '.specbridge', 'migrations');
    const dirsAfterFirst = readdirSync(migrationsDir);
    const configAfterFirst = sha256(read(root, '.specbridge/config.json'));

    const second = await cli(root, 'migrate', 'apply', '--json');
    expect(second.code).toBe(0);
    const report = JSON.parse(second.stdout) as { data: { result: string } };
    expect(report.data.result).toBe('nothing-to-do');
    expect(readdirSync(migrationsDir)).toEqual(dirsAfterFirst);
    expect(sha256(read(root, '.specbridge/config.json'))).toBe(configAfterFirst);
  });

  it('honors --backup-directory', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const result = await cli(
      root,
      'migrate',
      'apply',
      '--backup-directory',
      '.specbridge/backups/pre-v1',
      '--json',
    );
    expect(result.code).toBe(0);
    const backup = path.join(root, '.specbridge', 'backups', 'pre-v1', '.specbridge', 'config.json');
    expect(existsSync(backup)).toBe(true);
    expect(sha256(readFileSync(backup))).toBe(sha256(V1_CONFIG));
  });

  it('refuses to migrate an invalid configuration', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', '{broken');
    const result = await cli(root, 'migrate', 'apply');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot be migrated');
    expect(read(root, '.specbridge/config.json').toString('utf8')).toBe('{broken');
  });
});

describe('migration engine guarantees (core, unit)', () => {
  it('refuses a plan whose contents were tampered with after planning', () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const workspace = workspaceOf(root);
    const plan = buildMigrationPlan({
      tool: 'specbridge test',
      target: '1.0.0',
      steps: collectMigrationSteps(workspace),
      now: fixedClock,
    });
    const step = plan.steps[0];
    if (step === undefined) throw new Error('expected one step');
    step.content = `${step.content}// tampered`;
    const result = applyMigrationPlan(workspace, plan, { now: fixedClock });
    expect(result.status).toBe('refused-stale-plan');
    expect(read(root, '.specbridge/config.json').toString('utf8')).toBe(V1_CONFIG);
  });

  it('restores the original file when post-write validation fails', () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const workspace = workspaceOf(root);
    const plan = buildMigrationPlan({
      tool: 'specbridge test',
      target: '1.0.0',
      steps: collectMigrationSteps(workspace),
      now: fixedClock,
    });
    const result = applyMigrationPlan(workspace, plan, {
      now: fixedClock,
      validateStep: () => ['injected validation failure'],
    });
    expect(result.status).toBe('failed');
    expect(result.problems.join(' ')).toContain('every file was restored');
    expect(read(root, '.specbridge/config.json').toString('utf8')).toBe(V1_CONFIG);
  });
});

describe('migrate verify', () => {
  it('fails with a clear message when no migration exists', async () => {
    const root = kiroWorkspace();
    const result = await cli(root, 'migrate', 'verify');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No migration reports exist');
  });

  it('verifies a freshly applied migration', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    await cli(root, 'migrate', 'apply');
    const result = await cli(root, 'migrate', 'verify');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Migration verified');
    expect(result.stdout).toContain('backup holds the original bytes');
  });

  it('detects a file modified after the migration', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    await cli(root, 'migrate', 'apply');
    const configPath = path.join(root, '.specbridge', 'config.json');
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n`, 'utf8');
    const result = await cli(root, 'migrate', 'verify', '--json');
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { data: { result: string; problems: string[] } };
    expect(report.data.result).toBe('modified-since-migration');
    expect(report.data.problems.join(' ')).toContain('modified after the migration');
  });
});

describe('JSON purity and the deprecated alias', () => {
  it('keeps --json stdout parseable with warnings on stderr only', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    for (const argv of [
      ['migrate', 'status', '--json'],
      ['migrate', 'plan', '--json'],
      ['migrate', 'apply', '--dry-run', '--json'],
    ]) {
      const result = await cli(root, ...argv);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });

  it('config migrate still works but deprecates to stderr, never stdout', async () => {
    const root = kiroWorkspace();
    write(root, '.specbridge/config.json', V1_CONFIG);
    const dry = await cli(root, 'config', 'migrate', '--dry-run', '--json');
    expect(dry.code).toBe(0);
    expect(() => JSON.parse(dry.stdout)).not.toThrow();
    expect(dry.stdout).not.toContain('Deprecated');
    expect(dry.stderr).toContain('Deprecated: "specbridge config migrate" will be removed no earlier than v2.0.0');
    expect(dry.stderr).toContain('use "specbridge migrate plan" / "specbridge migrate apply" instead');

    const apply = await cli(root, 'config', 'migrate', '--apply');
    expect(apply.code).toBe(0);
    expect(apply.stderr).toContain('Deprecated');
    const migrated = JSON.parse(read(root, '.specbridge/config.json').toString('utf8')) as {
      schemaVersion: string;
    };
    expect(migrated.schemaVersion).toBe('2.0.0');
  });
});
