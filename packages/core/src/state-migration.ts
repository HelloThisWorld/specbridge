import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SpecBridgeError } from './errors.js';
import { sha256Hex } from './hash.js';
import type { WorkspaceInfo } from './workspace.js';
import { assertInsideWorkspace, writeFileAtomic } from './workspace.js';

/**
 * Unified state-migration framework (v1.0.0).
 *
 * The framework is deliberately generic: it plans, applies, reports, and
 * verifies file rewrites without knowing any schema. State families (config,
 * spec state, evidence, …) plug in as `MigrationFileStep`s built by the CLI,
 * which is the only place that can see every state-owning package.
 *
 * Guarantees:
 *   - planning is pure: nothing is written, no network, no model
 *   - a plan is hash-bound to the exact bytes it was computed from; applying
 *     against changed files is refused before anything is written
 *   - every original file is backed up before the first write
 *   - writes are atomic (temp file + rename) and validated afterwards;
 *     any failure restores every original file
 *   - applying twice is a no-op (steps whose target content already matches
 *     are skipped as already current)
 *   - the clock is injectable, so plan IDs and reports are deterministic in
 *     tests
 */

export const MIGRATION_PLAN_SCHEMA_VERSION = '1.0.0';

/** One file rewrite inside a migration plan. */
export interface MigrationFileStep {
  /** Stable step identifier, e.g. `config-v1-to-v2`. */
  stepId: string;
  /** State family the file belongs to, e.g. `config`. */
  family: string;
  /** Workspace-relative path with forward slashes. */
  file: string;
  fromVersion: string;
  toVersion: string;
  /** Human-readable field mappings, in application order. */
  changes: string[];
  warnings: string[];
  /** SHA-256 of the exact file bytes the plan was computed from. */
  beforeSha256: string;
  /** The complete new file content (exact bytes to write). */
  content: string;
}

export interface MigrationPlan {
  planSchemaVersion: typeof MIGRATION_PLAN_SCHEMA_VERSION;
  /** Deterministic id: `m-<UTC timestamp>-<hash prefix>`. */
  planId: string;
  /** Tool that produced the plan, e.g. `specbridge 1.0.0`. */
  tool: string;
  /** Product version the plan migrates towards, e.g. `1.0.0`. */
  target: string;
  createdAt: string;
  steps: MigrationFileStep[];
  /** SHA-256 over the canonical projection of the plan (see `migrationPlanHash`). */
  planHash: string;
}

/**
 * Canonical, content-addressed projection of a plan. File contents are
 * folded in as hashes so the plan hash is stable, small, and cannot be
 * satisfied by substituted content.
 */
export function migrationPlanHash(
  target: string,
  steps: readonly MigrationFileStep[],
): string {
  const projection = {
    planSchemaVersion: MIGRATION_PLAN_SCHEMA_VERSION,
    target,
    steps: steps.map((step) => ({
      stepId: step.stepId,
      family: step.family,
      file: step.file,
      fromVersion: step.fromVersion,
      toVersion: step.toVersion,
      beforeSha256: step.beforeSha256,
      contentSha256: sha256Hex(step.content),
    })),
  };
  return sha256Hex(JSON.stringify(projection));
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/** Assemble a hash-bound plan from prepared steps. Pure: writes nothing. */
export function buildMigrationPlan(options: {
  tool: string;
  target: string;
  steps: MigrationFileStep[];
  now: () => Date;
}): MigrationPlan {
  const createdAt = options.now().toISOString();
  const planHash = migrationPlanHash(options.target, options.steps);
  return {
    planSchemaVersion: MIGRATION_PLAN_SCHEMA_VERSION,
    planId: `m-${timestampSlug(new Date(createdAt))}-${planHash.slice(0, 8)}`,
    tool: options.tool,
    target: options.target,
    createdAt,
    steps: options.steps,
    planHash,
  };
}

export type MigrationStepStatus = 'applied' | 'already-current' | 'failed' | 'rolled-back';

export interface MigrationStepResult {
  stepId: string;
  family: string;
  file: string;
  fromVersion: string;
  toVersion: string;
  status: MigrationStepStatus;
  beforeSha256: string;
  afterSha256?: string;
  backupPath?: string;
  problems: string[];
}

export interface MigrationResult {
  planId: string;
  planHash: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  status: 'applied' | 'nothing-to-do' | 'refused-stale-plan' | 'failed';
  steps: MigrationStepResult[];
  problems: string[];
}

export interface MigrationApplyOptions {
  /**
   * Directory for original-file backups. Workspace-relative or absolute
   * inside the workspace. Default: `.specbridge/migrations/<planId>/backups`.
   */
  backupDirectory?: string;
  now: () => Date;
  /**
   * Family-specific validation of a rewritten file, given the parsed JSON of
   * the bytes actually on disk. Returns problems; any problem fails the step
   * and rolls the whole migration back.
   */
  validateStep?: (step: MigrationFileStep, written: unknown) => string[];
}

function backupRelPath(file: string): string {
  // Keep the original layout under the backup root so restores are obvious.
  return file.split('/').join(path.sep);
}

/**
 * Apply a plan. All-or-nothing: preconditions for every step are checked
 * before the first write; every original is backed up; any post-write
 * validation failure restores every original file.
 */
export function applyMigrationPlan(
  workspace: WorkspaceInfo,
  plan: MigrationPlan,
  options: MigrationApplyOptions,
): MigrationResult {
  const startedAt = options.now().toISOString();
  const expectedHash = migrationPlanHash(plan.target, plan.steps);
  const base: Omit<MigrationResult, 'status' | 'steps' | 'problems' | 'finishedAt'> = {
    planId: plan.planId,
    planHash: plan.planHash,
    target: plan.target,
    startedAt,
  };
  const finish = (
    status: MigrationResult['status'],
    steps: MigrationStepResult[],
    problems: string[],
  ): MigrationResult => ({ ...base, status, steps, problems, finishedAt: options.now().toISOString() });

  if (expectedHash !== plan.planHash) {
    return finish('refused-stale-plan', [], [
      'The plan hash does not match its contents. The plan file was modified after it was ' +
        'created; regenerate it with "migrate plan" and retry.',
    ]);
  }

  interface Prepared {
    step: MigrationFileStep;
    absolutePath: string;
    originalBytes: Buffer | undefined;
    alreadyCurrent: boolean;
  }

  // Phase 1 — check every precondition before writing anything.
  const prepared: Prepared[] = [];
  const problems: string[] = [];
  for (const step of plan.steps) {
    const absolutePath = assertInsideWorkspace(workspace.rootDir, step.file);
    if (!existsSync(absolutePath)) {
      problems.push(`${step.file}: the file no longer exists; the plan is stale.`);
      continue;
    }
    const originalBytes = readFileSync(absolutePath);
    const currentHash = sha256Hex(originalBytes);
    if (currentHash === sha256Hex(step.content)) {
      prepared.push({ step, absolutePath, originalBytes, alreadyCurrent: true });
      continue;
    }
    if (currentHash !== step.beforeSha256) {
      problems.push(
        `${step.file}: the file changed after the plan was created ` +
          `(expected ${step.beforeSha256.slice(0, 12)}…, found ${currentHash.slice(0, 12)}…); ` +
          'regenerate the plan and retry.',
      );
      continue;
    }
    prepared.push({ step, absolutePath, originalBytes, alreadyCurrent: false });
  }
  if (problems.length > 0) {
    return finish('refused-stale-plan', [], problems);
  }

  const pending = prepared.filter((entry) => !entry.alreadyCurrent);
  const results: MigrationStepResult[] = prepared
    .filter((entry) => entry.alreadyCurrent)
    .map((entry) => ({
      stepId: entry.step.stepId,
      family: entry.step.family,
      file: entry.step.file,
      fromVersion: entry.step.fromVersion,
      toVersion: entry.step.toVersion,
      status: 'already-current' as const,
      beforeSha256: entry.step.beforeSha256,
      afterSha256: sha256Hex(entry.step.content),
      problems: [],
    }));
  if (pending.length === 0) {
    return finish('nothing-to-do', results, []);
  }

  // Phase 2 — back up every original before the first write.
  const backupRoot = assertInsideWorkspace(
    workspace.rootDir,
    options.backupDirectory ??
      path.posix.join('.specbridge', 'migrations', plan.planId, 'backups'),
  );
  const backups = new Map<string, string>();
  for (const entry of pending) {
    const backupPath = path.join(backupRoot, backupRelPath(entry.step.file));
    mkdirSync(path.dirname(backupPath), { recursive: true });
    writeFileAtomic(backupPath, entry.originalBytes ?? Buffer.alloc(0));
    backups.set(entry.step.file, backupPath);
  }

  // Phase 3 — write atomically; Phase 4 — validate what is actually on disk.
  const written: Prepared[] = [];
  const rollback = (failed: Prepared, failure: string[]): MigrationResult => {
    for (const entry of written) {
      writeFileAtomic(entry.absolutePath, entry.originalBytes ?? Buffer.alloc(0));
    }
    for (const entry of pending) {
      results.push({
        stepId: entry.step.stepId,
        family: entry.step.family,
        file: entry.step.file,
        fromVersion: entry.step.fromVersion,
        toVersion: entry.step.toVersion,
        status: entry === failed ? 'failed' : 'rolled-back',
        beforeSha256: entry.step.beforeSha256,
        ...(backups.has(entry.step.file) ? { backupPath: backups.get(entry.step.file) as string } : {}),
        problems: entry === failed ? failure : [],
      });
    }
    return finish('failed', results, failure);
  };

  for (const entry of pending) {
    try {
      writeFileAtomic(entry.absolutePath, entry.step.content);
    } catch (cause) {
      return rollback(entry, [
        `${entry.step.file}: write failed — ${cause instanceof Error ? cause.message : String(cause)}`,
      ]);
    }
    written.push(entry);

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(entry.absolutePath, 'utf8'));
    } catch (cause) {
      return rollback(entry, [
        `${entry.step.file}: the migrated file is not valid JSON — ` +
          `${cause instanceof Error ? cause.message : String(cause)}; every file was restored.`,
      ]);
    }
    const stepProblems = options.validateStep?.(entry.step, parsed) ?? [];
    if (stepProblems.length > 0) {
      return rollback(entry, [
        `${entry.step.file}: the migrated file failed validation; every file was restored.`,
        ...stepProblems,
      ]);
    }
  }

  for (const entry of pending) {
    results.push({
      stepId: entry.step.stepId,
      family: entry.step.family,
      file: entry.step.file,
      fromVersion: entry.step.fromVersion,
      toVersion: entry.step.toVersion,
      status: 'applied',
      beforeSha256: entry.step.beforeSha256,
      afterSha256: sha256Hex(entry.step.content),
      backupPath: backups.get(entry.step.file) as string,
      problems: [],
    });
  }
  return finish('applied', results, []);
}

/** Where a migration's report directory lives. */
export function migrationReportDir(workspace: WorkspaceInfo, planId: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.posix.join('.specbridge', 'migrations', planId),
  );
}

/**
 * Persist the migration report:
 * `.specbridge/migrations/<planId>/{plan,result,changed-files,backups,diagnostics}.json`
 * plus a human-readable `summary.md`. Contains hashes and versions, never
 * credential values (the schemas reject credentials before a plan exists).
 */
export function writeMigrationReport(
  workspace: WorkspaceInfo,
  plan: MigrationPlan,
  result: MigrationResult,
  diagnostics: string[] = [],
): string {
  const dir = migrationReportDir(workspace, plan.planId);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown): void => {
    writeFileAtomic(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  };
  write('plan.json', plan);
  write('result.json', result);
  write(
    'changed-files.json',
    result.steps.map((step) => ({
      file: step.file,
      family: step.family,
      stepId: step.stepId,
      oldSchemaVersion: step.fromVersion,
      newSchemaVersion: step.toVersion,
      status: step.status,
      beforeSha256: step.beforeSha256,
      afterSha256: step.afterSha256 ?? null,
      backupPath: step.backupPath ?? null,
      warnings: plan.steps.find((s) => s.stepId === step.stepId)?.warnings ?? [],
    })),
  );
  write(
    'backups.json',
    result.steps
      .filter((step) => step.backupPath !== undefined)
      .map((step) => ({ file: step.file, backupPath: step.backupPath, sha256: step.beforeSha256 })),
  );
  write('diagnostics.json', { diagnostics, problems: result.problems });

  const lines: string[] = [
    `# Migration ${plan.planId}`,
    '',
    `- Tool: ${plan.tool}`,
    `- Target: ${plan.target}`,
    `- Created: ${plan.createdAt}`,
    `- Applied: ${result.startedAt} → ${result.finishedAt}`,
    `- Status: ${result.status}`,
    `- Plan hash: ${plan.planHash}`,
    '',
    '## Files',
    '',
  ];
  for (const step of result.steps) {
    lines.push(
      `- \`${step.file}\` (${step.family}): ${step.fromVersion} → ${step.toVersion} — ${step.status}`,
    );
    if (step.backupPath !== undefined) lines.push(`  - backup: \`${step.backupPath}\``);
  }
  for (const problem of result.problems) lines.push('', `> ${problem}`);
  writeFileAtomic(path.join(dir, 'summary.md'), `${lines.join('\n')}\n`);
  return dir;
}

export type MigrationVerification =
  | { status: 'verified'; planId: string; checks: string[] }
  | { status: 'modified-since-migration'; planId: string; checks: string[]; problems: string[] }
  | { status: 'invalid'; planId: string; problems: string[] };

/**
 * Verify a previously applied migration from its persisted report:
 * report files parse, the plan hash still matches, each applied file's
 * current bytes match the recorded after-hash, and each backup still holds
 * the recorded original bytes.
 */
export function verifyMigration(workspace: WorkspaceInfo, planId: string): MigrationVerification {
  const dir = migrationReportDir(workspace, planId);
  const problems: string[] = [];
  const checks: string[] = [];

  const readJson = (name: string): unknown => {
    const filePath = path.join(dir, name);
    if (!existsSync(filePath)) {
      throw new SpecBridgeError('INVALID_STATE', `${name} is missing from ${dir}.`);
    }
    return JSON.parse(readFileSync(filePath, 'utf8'));
  };

  let plan: MigrationPlan;
  let result: MigrationResult;
  try {
    plan = readJson('plan.json') as MigrationPlan;
    result = readJson('result.json') as MigrationResult;
  } catch (cause) {
    return {
      status: 'invalid',
      planId,
      problems: [cause instanceof Error ? cause.message : String(cause)],
    };
  }

  if (migrationPlanHash(plan.target, plan.steps) !== plan.planHash) {
    return {
      status: 'invalid',
      planId,
      problems: ['plan.json does not match its recorded plan hash; the report was modified.'],
    };
  }
  checks.push('plan hash matches plan contents');

  for (const step of result.steps) {
    if (step.status !== 'applied' && step.status !== 'already-current') continue;
    const absolutePath = assertInsideWorkspace(workspace.rootDir, step.file);
    if (!existsSync(absolutePath)) {
      problems.push(`${step.file}: missing (was ${step.status}).`);
      continue;
    }
    const currentHash = sha256Hex(readFileSync(absolutePath));
    if (step.afterSha256 !== undefined && currentHash !== step.afterSha256) {
      problems.push(
        `${step.file}: modified after the migration (expected ${step.afterSha256.slice(0, 12)}…).`,
      );
    } else {
      checks.push(`${step.file}: current bytes match the migration result`);
    }
    if (step.backupPath !== undefined) {
      if (!existsSync(step.backupPath)) {
        problems.push(`${step.file}: backup ${step.backupPath} is missing.`);
      } else if (sha256Hex(readFileSync(step.backupPath)) !== step.beforeSha256) {
        problems.push(`${step.file}: backup ${step.backupPath} does not match the original bytes.`);
      } else {
        checks.push(`${step.file}: backup holds the original bytes`);
      }
    }
  }

  if (problems.length > 0) {
    return { status: 'modified-since-migration', planId, checks, problems };
  }
  return { status: 'verified', planId, checks };
}

/** List migration report directories, newest first (lexicographic on id). */
export function listMigrationIds(workspace: WorkspaceInfo): string[] {
  const dir = path.join(workspace.sidecarDir, 'migrations');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('m-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
