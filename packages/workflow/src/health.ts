import path from 'node:path';
import type {
  Diagnostic,
  SpecWorkflowState,
  StageApproval,
  StageName,
  WorkflowStatus,
  WorkspaceInfo,
} from '@specbridge/core';
import { stateStage, trySha256File } from '@specbridge/core';
import { tryTaskPlanHashOfFile } from '@specbridge/compat-kiro';
import type { WorkflowShape } from './state-machine.js';
import {
  dependentStages,
  deriveWorkflowStatus,
  stagePrerequisites,
  workflowShape,
} from './state-machine.js';

/**
 * Read-time evaluation of recorded approvals against the current file bytes.
 *
 * Everything here is computed in memory: read-only commands report stale
 * approvals but never rewrite sidecar state. The only way to change state is
 * an explicit `spec approve` (or `--revoke`).
 */

export type EffectiveStageStatus =
  | 'blocked'
  | 'draft'
  | 'approved'
  /** The stage was approved, but its file bytes changed afterwards. */
  | 'modified-after-approval'
  /** The stage's own approval is intact, but a prerequisite approval went stale. */
  | 'stale-prerequisite';

export interface StageEvaluation {
  stage: StageName;
  stored: StageApproval;
  effective: EffectiveStageStatus;
  /** Absolute path of the stage file. */
  filePath: string;
  fileExists: boolean;
  /** Present for approved stages (undefined when the file is unreadable). */
  currentHash?: string;
  /**
   * Tasks stage only: true when the exact bytes changed after approval but
   * the checkbox-normalized plan hash still matches — i.e. the only changes
   * since approval are `[ ]`/`[x]` progress. The stage stays effectively
   * approved in that case (hash semantics v2).
   */
  checkboxProgressOnly?: boolean;
  prerequisites: StageName[];
}

export interface WorkflowEvaluation {
  state: SpecWorkflowState;
  shape: WorkflowShape;
  stages: StageEvaluation[];
  /** Status derived from recorded approvals alone. */
  storedStatus: WorkflowStatus;
  /** `STALE_APPROVAL` when any recorded approval no longer holds. */
  effectiveStatus: WorkflowStatus | 'STALE_APPROVAL';
  /** Stages whose approved file bytes changed. */
  staleStages: StageName[];
  /** Approved stages invalidated because a prerequisite went stale. */
  invalidatedStages: StageName[];
  health: 'ok' | 'stale';
  diagnostics: Diagnostic[];
}

function shortHash(hash: string | null | undefined): string {
  return hash === null || hash === undefined ? '(none)' : `${hash.slice(0, 12)}…`;
}

/** Resolve a stored workspace-relative stage file path, refusing traversal. */
export function resolveStageFile(workspace: WorkspaceInfo, stage: StageApproval): string {
  // Stored paths use forward slashes; normalize for the current platform.
  const relative = stage.file.split('/').join(path.sep);
  const resolved = path.resolve(workspace.rootDir, relative);
  const check = path.relative(workspace.rootDir, resolved);
  if (check.startsWith('..') || path.isAbsolute(check)) {
    // A hand-edited state file must never make SpecBridge read outside the
    // workspace. Point at a path that cannot exist instead of throwing so
    // read-only commands stay non-fatal; the hash simply reports as missing.
    return path.join(workspace.rootDir, '.specbridge', 'invalid-path', path.basename(stage.file));
  }
  return resolved;
}

export function evaluateWorkflow(
  workspace: WorkspaceInfo,
  state: SpecWorkflowState,
): WorkflowEvaluation {
  const shape = workflowShape(state.specType, state.workflowMode);
  const diagnostics: Diagnostic[] = [];
  const staleStages: StageName[] = [];

  const evaluations = new Map<StageName, StageEvaluation>();
  for (const stage of shape.order) {
    const stored = stateStage(state, stage);
    if (stored === undefined) continue; // schema guarantees presence; be safe anyway
    const filePath = resolveStageFile(workspace, stored);
    const currentHash = trySha256File(filePath);
    const fileExists = currentHash !== undefined;

    let effective: EffectiveStageStatus;
    let checkboxProgressOnly = false;
    if (stored.status === 'approved') {
      if (currentHash !== undefined && currentHash === stored.approvedHash) {
        effective = 'approved';
      } else if (
        stage === 'tasks' &&
        currentHash !== undefined &&
        typeof stored.approvedPlanHash === 'string' &&
        tryTaskPlanHashOfFile(filePath) === stored.approvedPlanHash
      ) {
        // Only checkbox state changed since approval: the plan itself is the
        // one that was approved (hash semantics v2), so the approval holds.
        effective = 'approved';
        checkboxProgressOnly = true;
        diagnostics.push({
          severity: 'info',
          code: 'APPROVAL_CHECKBOX_PROGRESS',
          message:
            'tasks.md has checkbox progress since approval; the approved task plan itself is unchanged.',
          file: filePath,
        });
      } else {
        effective = 'modified-after-approval';
        staleStages.push(stage);
        diagnostics.push({
          severity: 'warning',
          code: 'APPROVAL_STALE',
          message:
            currentHash === undefined
              ? `${stage} was approved but its file is missing or unreadable (approved hash ${shortHash(stored.approvedHash)}).`
              : `${stage} was modified after approval (approved ${shortHash(stored.approvedHash)}, current ${shortHash(currentHash)}). Review the changes and re-approve.`,
          file: filePath,
        });
      }
    } else {
      effective = stored.status;
    }

    evaluations.set(stage, {
      stage,
      stored,
      effective,
      filePath,
      fileExists,
      ...(stored.status === 'approved' && currentHash !== undefined ? { currentHash } : {}),
      ...(checkboxProgressOnly ? { checkboxProgressOnly } : {}),
      prerequisites: stagePrerequisites(shape, stage),
    });
  }

  // Propagate staleness: an approved stage whose prerequisite went stale is
  // itself no longer trustworthy; a draft stage behind a stale prerequisite
  // is effectively blocked.
  const invalidatedStages: StageName[] = [];
  for (const stale of staleStages) {
    for (const dependent of dependentStages(shape, stale)) {
      const evaluation = evaluations.get(dependent);
      if (evaluation === undefined) continue;
      if (evaluation.effective === 'approved') {
        evaluation.effective = 'stale-prerequisite';
        invalidatedStages.push(dependent);
        diagnostics.push({
          severity: 'warning',
          code: 'APPROVAL_DEPENDENT_STALE',
          message: `${dependent} approval is now stale because ${stale} changed after it was approved.`,
          file: evaluation.filePath,
        });
      } else if (evaluation.effective === 'draft') {
        evaluation.effective = 'blocked';
      }
    }
  }

  const stagesRecord: Record<string, StageApproval> = {};
  for (const [name, evaluation] of evaluations) stagesRecord[name] = evaluation.stored;
  const storedStatus = deriveWorkflowStatus(shape, stagesRecord);
  const hasStale = staleStages.length > 0 || invalidatedStages.length > 0;

  return {
    state,
    shape,
    stages: shape.order
      .map((stage) => evaluations.get(stage))
      .filter((s): s is StageEvaluation => s !== undefined),
    storedStatus,
    effectiveStatus: hasStale ? 'STALE_APPROVAL' : storedStatus,
    staleStages,
    invalidatedStages,
    health: hasStale ? 'stale' : 'ok',
    diagnostics,
  };
}

/** True when the stage's recorded approval still holds against current bytes. */
export function isEffectivelyApproved(
  evaluation: WorkflowEvaluation,
  stage: StageName,
): boolean {
  return evaluation.stages.find((s) => s.stage === stage)?.effective === 'approved';
}
