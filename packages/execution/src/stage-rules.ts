import type { SpecWorkflowState, StageApproval, StageName, WorkspaceInfo } from '@specbridge/core';
import { stateStage, writeSpecState } from '@specbridge/core';
import type { Clock, WorkflowEvaluation, WorkflowShape } from '@specbridge/workflow';
import {
  applicableStages,
  dependentStages,
  deriveWorkflowStatus,
  isStageApplicable,
  isoNow,
  recomputeStages,
  stagePrerequisites,
  workflowShape,
} from '@specbridge/workflow';

/**
 * Model-assisted authoring rules (§ workflow modes):
 *
 *   requirements-first : requirements while draft → design needs requirements
 *                        approved → tasks needs requirements + design approved
 *   design-first       : design while draft → requirements needs design
 *                        approved → tasks needs both approved
 *   quick              : requirements/design in either order, tasks may be
 *                        generated from the current documents (warned when
 *                        they are unapproved)
 *   bugfix             : bugfix first → design needs bugfix approved → tasks
 *                        needs bugfix + design approved
 *
 * Nothing is ever auto-approved, and an approved stage is never overwritten:
 * approval must be revoked explicitly first.
 */

export type StageGateResult =
  | { ok: true; shape: WorkflowShape; warnings: string[] }
  | {
      ok: false;
      reason: 'stage-not-applicable' | 'stage-approved' | 'prerequisites-unmet';
      message: string;
      remediation: string[];
    };

export function stageAuthoringGate(
  state: SpecWorkflowState,
  evaluation: WorkflowEvaluation,
  stage: StageName,
): StageGateResult {
  if (!isStageApplicable(state.specType, stage)) {
    return {
      ok: false,
      reason: 'stage-not-applicable',
      message: `Stage "${stage}" does not apply to a ${state.specType} spec. Applicable stages: ${applicableStages(state.specType).join(', ')}.`,
      remediation: [],
    };
  }
  const shape = workflowShape(state.specType, state.workflowMode);

  const stored = stateStage(state, stage);
  if (stored?.status === 'approved') {
    return {
      ok: false,
      reason: 'stage-approved',
      message:
        `Stage "${stage}" of "${state.specName}" is approved; SpecBridge never overwrites an approved document. ` +
        'Revoke the approval first if you really want to regenerate it.',
      remediation: [`specbridge spec approve ${state.specName} --stage ${stage} --revoke`],
    };
  }

  const warnings: string[] = [];
  const prerequisites = stagePrerequisites(shape, stage);
  if (shape.kind === 'parallel-docs' && stage === 'tasks') {
    // Quick workflow: tasks generation is allowed from the current documents.
    const unapproved = prerequisites.filter(
      (prerequisite) =>
        evaluation.stages.find((s) => s.stage === prerequisite)?.effective !== 'approved',
    );
    if (unapproved.length > 0) {
      warnings.push(
        `Generating tasks from unapproved document(s): ${unapproved.join(', ')} (quick workflow allows this; nothing is auto-approved).`,
      );
    }
    return { ok: true, shape, warnings };
  }

  const missing: StageName[] = [];
  const stale: StageName[] = [];
  for (const prerequisite of prerequisites) {
    const stageEvaluation = evaluation.stages.find((s) => s.stage === prerequisite);
    if (stageEvaluation === undefined) continue;
    if (stageEvaluation.stored.status !== 'approved') missing.push(prerequisite);
    else if (stageEvaluation.effective !== 'approved') stale.push(prerequisite);
  }
  if (missing.length > 0 || stale.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`${missing.join(', ')} must be approved first`);
    if (stale.length > 0) parts.push(`${stale.join(', ')} changed after approval and must be re-approved`);
    const next = missing[0] ?? stale[0];
    return {
      ok: false,
      reason: 'prerequisites-unmet',
      message: `Cannot generate ${stage} for "${state.specName}": ${parts.join('; ')}.`,
      remediation:
        next !== undefined
          ? [
              `specbridge spec analyze ${state.specName} --stage ${next}`,
              `specbridge spec approve ${state.specName} --stage ${next}`,
            ]
          : [],
    };
  }
  return { ok: true, shape, warnings };
}

/** Stages whose current content belongs in the generation prompt. */
export function contextStagesFor(shape: WorkflowShape, stage: StageName): StageName[] {
  if (shape.kind === 'parallel-docs' && stage === 'tasks') {
    return shape.order.filter((candidate) => candidate !== 'tasks');
  }
  const index = shape.order.indexOf(stage);
  return index <= 0 ? [] : shape.order.slice(0, index);
}

/**
 * After SpecBridge writes new content into a draft stage, every approval
 * that depended on that stage was made against different content — revoke
 * those approvals in sidecar state (files stay untouched).
 */
export function invalidateDependentApprovals(
  workspace: WorkspaceInfo,
  state: SpecWorkflowState,
  stage: StageName,
  clock: Clock,
): { state: SpecWorkflowState; statePath: string; invalidated: StageName[] } {
  const shape = workflowShape(state.specType, state.workflowMode);
  const stages: Record<string, StageApproval> = {};
  for (const [name, value] of Object.entries(state.stages)) {
    if (value !== undefined && typeof value === 'object') {
      stages[name] = { ...(value as StageApproval) };
    }
  }

  const invalidated: StageName[] = [];
  for (const dependent of dependentStages(shape, stage)) {
    const entry = stages[dependent];
    if (entry !== undefined && entry.status === 'approved') {
      stages[dependent] = { ...entry, status: 'draft', approvedAt: null, approvedHash: null };
      invalidated.push(dependent);
    }
  }

  const recomputed = recomputeStages(shape, {
    ...state,
    stages: stages as SpecWorkflowState['stages'],
  });
  const ordered: Record<string, StageApproval> = {};
  for (const name of shape.order) {
    const value = recomputed[name];
    if (value !== undefined) ordered[name] = value;
  }
  const nextState: SpecWorkflowState = {
    ...state,
    stages: ordered as SpecWorkflowState['stages'],
    status: deriveWorkflowStatus(shape, recomputed),
    updatedAt: isoNow(clock),
  };
  const statePath = writeSpecState(workspace, nextState);
  return { state: nextState, statePath, invalidated };
}
