import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCli } from '../../packages/cli/src/cli';
import { FIXED_NOW, emptyTempDir, testWorkflowState } from '../helpers';

/**
 * Programmatic corruption fixtures for the v1.0.0 migration/validation/
 * recovery tests. Corrupt state is generated into fresh temp directories
 * (never checked into the repository); tests/fixtures/corruption/README.md
 * documents every case and points back here.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the whole CLI in-process with a deterministic clock. */
export async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line = '') => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line = '') => stderr.push(`${line}\n`),
    now: () => FIXED_NOW,
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Write a workspace-relative (forward-slash) file, creating parents. */
export function write(root: string, relative: string, content: string | Buffer): string {
  const target = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

export function read(root: string, relative: string): Buffer {
  return readFileSync(path.join(root, ...relative.split('/')));
}

/** Sorted relative paths of every file/directory under `root`. */
export function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const absolute = path.join(dir, entry.name);
      out.push(path.relative(root, absolute).split(path.sep).join('/'));
      if (entry.isDirectory()) walk(absolute);
    }
  };
  walk(root);
  return out;
}

/** One hash over every path + file byte under `root` (write-detection). */
export function treeHash(root: string): string {
  const hash = createHash('sha256');
  for (const relative of listTree(root)) {
    hash.update(relative);
    const absolute = path.join(root, ...relative.split('/'));
    if (statSync(absolute).isFile()) hash.update(readFileSync(absolute));
  }
  return hash.digest('hex');
}

/** A fresh workspace containing only an empty `.kiro/`. */
export function kiroWorkspace(): string {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro'), { recursive: true });
  return root;
}

export const REQUIREMENTS_CONTENT = '# Requirements Document\n\n## Introduction\n\nDemo.\n';

/** A workspace with one complete spec (`.kiro/specs/<name>/`). */
export function specWorkspace(specName = 'demo'): string {
  const root = kiroWorkspace();
  write(root, `.kiro/specs/${specName}/requirements.md`, REQUIREMENTS_CONTENT);
  write(root, `.kiro/specs/${specName}/design.md`, '# Design Document\n\nDemo.\n');
  write(root, `.kiro/specs/${specName}/tasks.md`, '# Implementation Plan\n\n- [ ] 1. Do it.\n');
  return root;
}

/** Persist a schema-valid state file whose requirements approval is fresh. */
export function writeValidSpecState(root: string, specName = 'demo'): void {
  const approvedHash = sha256(read(root, `.kiro/specs/${specName}/requirements.md`));
  const state = testWorkflowState({
    specName,
    stages: {
      requirements: {
        status: 'approved',
        approvedAt: FIXED_NOW.toISOString(),
        approvedHash,
      },
    },
  });
  write(root, `.specbridge/state/specs/${specName}.json`, `${JSON.stringify(state, null, 2)}\n`);
}

/** Persist a state file whose recorded approval no longer matches the file. */
export function writeStaleSpecState(root: string, specName = 'demo'): void {
  const state = testWorkflowState({
    specName,
    stages: {
      requirements: {
        status: 'approved',
        approvedAt: FIXED_NOW.toISOString(),
        approvedHash: sha256('content that was approved but has since changed\n'),
      },
    },
  });
  write(root, `.specbridge/state/specs/${specName}.json`, `${JSON.stringify(state, null, 2)}\n`);
}

export const V1_CONFIG = `${JSON.stringify(
  {
    schemaVersion: '1.0.0',
    defaultRunner: 'claude-code',
    runners: { 'claude-code': { command: 'claude' } },
    verification: { commands: [{ name: 'test', argv: ['pnpm', 'test'] }] },
  },
  null,
  2,
)}\n`;

export const V2_CONFIG = `${JSON.stringify({ schemaVersion: '2.0.0' }, null, 2)}\n`;

/** A syntactically valid JSON state file that fails the spec-state schema. */
export function truncatedStateJson(specName = 'demo'): string {
  const valid = JSON.stringify(testWorkflowState({ specName }), null, 2);
  return valid.slice(0, Math.floor(valid.length / 2));
}

export function writeValidLock(root: string): void {
  write(
    root,
    '.specbridge/locks/interactive-task.lock',
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        runId: 'run-held-1',
        specName: 'demo',
        taskId: '1',
        pid: process.pid,
        createdAt: FIXED_NOW.toISOString(),
        heartbeatAt: FIXED_NOW.toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

/** A schema-valid task evidence record (override fields to corrupt it). */
export function validEvidenceRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    specName: 'demo',
    taskId: '1',
    status: 'verified',
    runner: 'mock',
    repository: { dirtyBefore: false, dirtyAfter: false },
    changedFiles: [
      { path: 'src/demo.ts', changeType: 'modified', preExisting: true, modifiedDuringRun: true },
    ],
    verificationCommands: [],
    verificationSkipped: false,
    runnerClaims: { changedFiles: [], commandsReported: [], testsReported: [] },
    violations: [],
    warnings: [],
    evaluatedAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

/** Interrupted migration report: plan.json + backup, but no result.json. */
export function writeInterruptedMigration(
  root: string,
  options: { planId?: string; backupContent?: string; withBackup?: boolean } = {},
): string {
  const planId = options.planId ?? 'm-20260101-000000-deadbeef';
  const backupContent = options.backupContent ?? V1_CONFIG;
  const plan = {
    planSchemaVersion: '1.0.0',
    planId,
    tool: 'specbridge test',
    target: '1.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        stepId: 'config-v1-to-v2',
        family: 'config',
        file: '.specbridge/config.json',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        changes: [],
        warnings: [],
        beforeSha256: sha256(backupContent),
        content: V2_CONFIG,
      },
    ],
    planHash: sha256('not-verified-by-the-interrupted-report-scan'),
  };
  write(root, `.specbridge/migrations/${planId}/plan.json`, `${JSON.stringify(plan, null, 2)}\n`);
  if (options.withBackup !== false) {
    write(root, `.specbridge/migrations/${planId}/backups/.specbridge/config.json`, backupContent);
  }
  return planId;
}
