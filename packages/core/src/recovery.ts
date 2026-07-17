import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './hash.js';
import { SIDECAR_DIR_NAME } from './types.js';
import type { WorkspaceInfo } from './workspace.js';
import { assertInsideWorkspace, writeFileAtomic } from './workspace.js';

/**
 * Recovery planning and application (v1.0.0).
 *
 * Recovery is deliberately narrow. A plan can only propose the safe action
 * kinds below, every target must live inside `.specbridge/` (the engine
 * refuses anything else, so `.kiro`, source code, and `.git` are structurally
 * out of reach), and applying requires the acknowledgement token derived from
 * the plan hash. Nothing here can create approvals, evidence, or completed
 * tasks — those files are never written by any action kind.
 *
 * "Removal" always means a move into the quarantine directory: corrupted or
 * stale files are preserved for manual review, never destroyed.
 */

export const RECOVERY_PLAN_SCHEMA_VERSION = '1.0.0';

export const RECOVERY_ACTION_KINDS = [
  /** Move an invalid/corrupted sidecar file into quarantine (preserved). */
  'quarantine-file',
  /** Move a stale interactive lock into quarantine (preserved). */
  'remove-stale-lock',
  /** Move sidecar state whose `.kiro` spec no longer exists into quarantine. */
  'archive-orphan-state',
  /** Restore a file from a migration backup (current bytes are quarantined first). */
  'restore-from-migration-backup',
  /** Create a missing standard sidecar directory. */
  'create-missing-directory',
] as const;
export type RecoveryActionKind = (typeof RECOVERY_ACTION_KINDS)[number];

export type RecoveryRisk = 'low' | 'medium';
export type RecoveryConfidence = 'certain' | 'likely' | 'manual-review';

export interface RecoveryAction {
  /** Stable within the plan: `a1`, `a2`, … */
  actionId: string;
  kind: RecoveryActionKind;
  /** Why this action is proposed. */
  reason: string;
  risk: RecoveryRisk;
  /** Workspace-relative file the action operates on (absent for directory creation). */
  file?: string;
  /** SHA-256 of the file's current bytes; `null` when the file must be absent. */
  sha256?: string | null;
  /** For `restore-from-migration-backup`. */
  backupPath?: string;
  backupSha256?: string;
  /** For `create-missing-directory`. */
  directory?: string;
  reversible: boolean;
  confidence: RecoveryConfidence;
  requiresAcknowledgement: boolean;
}

export interface RecoveryPlan {
  planSchemaVersion: typeof RECOVERY_PLAN_SCHEMA_VERSION;
  planId: string;
  tool: string;
  createdAt: string;
  actions: RecoveryAction[];
  planHash: string;
}

export function recoveryPlanHash(actions: readonly RecoveryAction[]): string {
  const projection = {
    planSchemaVersion: RECOVERY_PLAN_SCHEMA_VERSION,
    actions: actions.map((action) => ({
      actionId: action.actionId,
      kind: action.kind,
      file: action.file ?? null,
      sha256: action.sha256 ?? null,
      backupPath: action.backupPath ?? null,
      backupSha256: action.backupSha256 ?? null,
      directory: action.directory ?? null,
    })),
  };
  return sha256Hex(JSON.stringify(projection));
}

/** The short token a user must echo back to apply a plan. */
export function recoveryAcknowledgementToken(plan: Pick<RecoveryPlan, 'planHash'>): string {
  return plan.planHash.slice(0, 12);
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/** Assemble a hash-bound recovery plan. Pure: writes nothing. */
export function buildRecoveryPlan(options: {
  tool: string;
  actions: RecoveryAction[];
  now: () => Date;
}): RecoveryPlan {
  const createdAt = options.now().toISOString();
  const planHash = recoveryPlanHash(options.actions);
  return {
    planSchemaVersion: RECOVERY_PLAN_SCHEMA_VERSION,
    planId: `r-${timestampSlug(new Date(createdAt))}-${planHash.slice(0, 8)}`,
    tool: options.tool,
    createdAt,
    actions: options.actions,
    planHash,
  };
}

/**
 * Resolve a workspace-relative path and require it to live inside
 * `.specbridge/`. Every path a recovery action touches passes through this
 * guard — recovery can never modify `.kiro`, `.git`, or project sources.
 */
export function assertInsideSidecar(workspace: WorkspaceInfo, relative: string): string {
  const resolved = assertInsideWorkspace(workspace.rootDir, relative);
  const sidecarRelative = path.relative(workspace.sidecarDir, resolved);
  if (sidecarRelative.startsWith('..') || path.isAbsolute(sidecarRelative)) {
    throw new Error(
      `Recovery refuses to touch ${relative}: only files inside ${SIDECAR_DIR_NAME}/ are recoverable.`,
    );
  }
  return resolved;
}

export interface RecoveryActionResult {
  actionId: string;
  kind: RecoveryActionKind;
  status: 'applied' | 'failed' | 'rolled-back';
  /** Where the original bytes were preserved, when the action moved a file. */
  quarantinePath?: string;
  problems: string[];
}

export interface RecoveryApplyResult {
  planId: string;
  planHash: string;
  startedAt: string;
  finishedAt: string;
  status: 'applied' | 'refused-bad-acknowledgement' | 'refused-stale-plan' | 'failed';
  actions: RecoveryActionResult[];
  problems: string[];
}

export interface RecoveryApplyOptions {
  /** Must equal `recoveryAcknowledgementToken(plan)` or the full plan hash. */
  acknowledgementToken: string;
  now: () => Date;
  /**
   * Validation of the workspace after all actions ran. Problems roll every
   * action back (moves are reversed from quarantine).
   */
  validateFinalState?: () => string[];
}

interface ExecutedMove {
  from: string;
  to: string;
}

/**
 * Apply a recovery plan:
 *   1. the acknowledgement token must match the plan hash
 *   2. the plan hash must match the plan contents
 *   3. every recorded file hash must match the bytes on disk (stale plans
 *      are refused before anything changes)
 *   4. moves preserve originals in `.specbridge/quarantine/<planId>/`
 *   5. a validation failure reverses every move
 *   6. the outcome is appended to the append-only recovery log
 */
export function applyRecoveryPlan(
  workspace: WorkspaceInfo,
  plan: RecoveryPlan,
  options: RecoveryApplyOptions,
): RecoveryApplyResult {
  const startedAt = options.now().toISOString();
  const finish = (
    status: RecoveryApplyResult['status'],
    actions: RecoveryActionResult[],
    problems: string[],
  ): RecoveryApplyResult => {
    const result: RecoveryApplyResult = {
      planId: plan.planId,
      planHash: plan.planHash,
      startedAt,
      finishedAt: options.now().toISOString(),
      status,
      actions,
      problems,
    };
    appendRecoveryLog(workspace, result);
    return result;
  };

  const token = options.acknowledgementToken.trim().toLowerCase();
  if (token !== plan.planHash && token !== recoveryAcknowledgementToken(plan)) {
    return finish('refused-bad-acknowledgement', [], [
      'The acknowledgement token does not match this plan. Re-run "state recover --plan" and ' +
        'pass the token it prints (or the full plan hash) to --apply.',
    ]);
  }
  if (recoveryPlanHash(plan.actions) !== plan.planHash) {
    return finish('refused-stale-plan', [], [
      'The plan hash does not match its contents; the plan file was modified after it was created.',
    ]);
  }

  // Revalidate every recorded file hash before changing anything.
  const staleProblems: string[] = [];
  for (const action of plan.actions) {
    if (action.file === undefined) continue;
    const absolute = assertInsideSidecar(workspace, action.file);
    const exists = existsSync(absolute);
    if (action.sha256 === null) {
      if (exists) staleProblems.push(`${action.file}: expected to be absent, but it exists now.`);
      continue;
    }
    if (action.sha256 !== undefined) {
      if (!exists) {
        staleProblems.push(`${action.file}: no longer exists; the plan is stale.`);
        continue;
      }
      const current = sha256Hex(readFileSync(absolute));
      if (current !== action.sha256) {
        staleProblems.push(
          `${action.file}: changed after the plan was created ` +
            `(expected ${action.sha256.slice(0, 12)}…, found ${current.slice(0, 12)}…).`,
        );
      }
    }
    if (action.kind === 'restore-from-migration-backup') {
      if (action.backupPath === undefined || action.backupSha256 === undefined) {
        staleProblems.push(`${action.actionId}: restore action is missing its backup reference.`);
      } else {
        const backupAbsolute = assertInsideSidecar(workspace, action.backupPath);
        if (!existsSync(backupAbsolute)) {
          staleProblems.push(`${action.backupPath}: migration backup is missing.`);
        } else if (sha256Hex(readFileSync(backupAbsolute)) !== action.backupSha256) {
          staleProblems.push(`${action.backupPath}: migration backup does not match its recorded hash.`);
        }
      }
    }
  }
  if (staleProblems.length > 0) {
    return finish('refused-stale-plan', [], staleProblems);
  }

  const quarantineRoot = path.join(workspace.sidecarDir, 'quarantine', plan.planId);
  const executedMoves: ExecutedMove[] = [];
  /** Files written by a restore action that did not exist before it ran. */
  const restoredWithoutOriginal: string[] = [];
  const createdDirs: string[] = [];
  const results: RecoveryActionResult[] = [];

  const moveToQuarantine = (relativeFile: string): string => {
    const source = assertInsideSidecar(workspace, relativeFile);
    const sidecarRelative = path.relative(workspace.sidecarDir, source);
    const target = path.join(quarantineRoot, sidecarRelative);
    mkdirSync(path.dirname(target), { recursive: true });
    const bytes = readFileSync(source);
    writeFileAtomic(target, bytes);
    if (sha256Hex(readFileSync(target)) !== sha256Hex(bytes)) {
      throw new Error(`quarantine copy of ${relativeFile} does not match the original.`);
    }
    rmSync(source);
    executedMoves.push({ from: source, to: target });
    return target;
  };

  const rollbackAll = (failedAction: RecoveryAction, failure: string[]): RecoveryApplyResult => {
    // A restore that had no original to quarantine is undone by removing the
    // restored file; every other change is a move that gets reversed below.
    for (const restored of restoredWithoutOriginal) {
      try {
        rmSync(restored, { force: true });
      } catch {
        failure.push(`Could not remove the restored file ${restored} during rollback.`);
      }
    }
    for (const move of [...executedMoves].reverse()) {
      try {
        mkdirSync(path.dirname(move.from), { recursive: true });
        writeFileAtomic(move.from, readFileSync(move.to));
        rmSync(move.to, { force: true });
      } catch {
        failure.push(`Could not reverse the move of ${move.from}; the bytes remain at ${move.to}.`);
      }
    }
    for (const action of plan.actions) {
      if (results.some((r) => r.actionId === action.actionId)) {
        const recorded = results.find((r) => r.actionId === action.actionId) as RecoveryActionResult;
        if (action.actionId !== failedAction.actionId) recorded.status = 'rolled-back';
        continue;
      }
      results.push({
        actionId: action.actionId,
        kind: action.kind,
        status: action.actionId === failedAction.actionId ? 'failed' : 'rolled-back',
        problems: action.actionId === failedAction.actionId ? failure : [],
      });
    }
    return finish('failed', results, failure);
  };

  for (const action of plan.actions) {
    try {
      switch (action.kind) {
        case 'quarantine-file':
        case 'remove-stale-lock':
        case 'archive-orphan-state': {
          const quarantinePath = moveToQuarantine(action.file as string);
          results.push({ actionId: action.actionId, kind: action.kind, status: 'applied', quarantinePath, problems: [] });
          break;
        }
        case 'restore-from-migration-backup': {
          const target = assertInsideSidecar(workspace, action.file as string);
          let quarantinePath: string | undefined;
          if (existsSync(target)) {
            quarantinePath = moveToQuarantine(action.file as string);
          } else {
            restoredWithoutOriginal.push(target);
          }
          const backupAbsolute = assertInsideSidecar(workspace, action.backupPath as string);
          writeFileAtomic(target, readFileSync(backupAbsolute));
          results.push({
            actionId: action.actionId,
            kind: action.kind,
            status: 'applied',
            ...(quarantinePath !== undefined ? { quarantinePath } : {}),
            problems: [],
          });
          break;
        }
        case 'create-missing-directory': {
          const dir = assertInsideSidecar(workspace, action.directory as string);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
            createdDirs.push(dir);
          }
          results.push({ actionId: action.actionId, kind: action.kind, status: 'applied', problems: [] });
          break;
        }
      }
    } catch (cause) {
      return rollbackAll(action, [
        `${action.actionId} (${action.kind}) failed — ${cause instanceof Error ? cause.message : String(cause)}`,
      ]);
    }
  }

  const finalProblems = options.validateFinalState?.() ?? [];
  if (finalProblems.length > 0) {
    const failed = plan.actions[plan.actions.length - 1] as RecoveryAction;
    return rollbackAll(failed, [
      'Post-recovery validation failed; every move was reversed.',
      ...finalProblems,
    ]);
  }
  void createdDirs;
  return finish('applied', results, []);
}

/** `.specbridge/recovery/log.jsonl` — append-only record of every apply attempt. */
export function recoveryLogPath(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, 'recovery', 'log.jsonl');
}

function appendRecoveryLog(workspace: WorkspaceInfo, result: RecoveryApplyResult): void {
  const logPath = recoveryLogPath(workspace);
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(result)}\n`, 'utf8');
  } catch {
    // The log is informational; a failure to append never blocks recovery.
  }
}

/** Where persisted recovery plans live. */
export function recoveryPlanPath(workspace: WorkspaceInfo, planId: string): string {
  return path.join(workspace.sidecarDir, 'recovery', 'plans', `${planId}.json`);
}

/** Persist a plan for a later `--apply <planId>`. */
export function writeRecoveryPlan(workspace: WorkspaceInfo, plan: RecoveryPlan): string {
  const planPath = recoveryPlanPath(workspace, plan.planId);
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileAtomic(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return planPath;
}

/** Read a persisted plan; `undefined` when missing or unparsable. */
export function readRecoveryPlan(workspace: WorkspaceInfo, planId: string): RecoveryPlan | undefined {
  const planPath = recoveryPlanPath(workspace, planId);
  if (!existsSync(planPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as RecoveryPlan;
    if (parsed.planSchemaVersion !== RECOVERY_PLAN_SCHEMA_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
