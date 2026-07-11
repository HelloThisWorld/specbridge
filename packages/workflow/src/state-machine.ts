import type {
  ConcreteSpecType,
  ConcreteWorkflowMode,
  SpecWorkflowState,
  StageApproval,
  StageName,
  WorkflowStatus,
} from '@specbridge/core';
import { stateStage } from '@specbridge/core';

/**
 * The workflow state machine.
 *
 * A workflow is an ordered list of stages plus a prerequisite rule. Two
 * shapes exist:
 *
 * - `sequential` — each stage requires every earlier stage to be approved
 *   (requirements-first, design-first, and bugfix workflows).
 * - `parallel-docs` — the two document stages can be approved in either
 *   order; tasks requires both (quick workflows).
 *
 * Approval state is only ever read from sidecar state. A stage is never
 * considered approved because its file exists.
 */

export interface WorkflowShape {
  specType: ConcreteSpecType;
  mode: ConcreteWorkflowMode;
  /** Stage order used for display and for sequential prerequisites. */
  order: StageName[];
  kind: 'sequential' | 'parallel-docs';
}

/** The stage that holds the written problem statement for a spec type. */
export function documentStageFor(specType: ConcreteSpecType): StageName {
  return specType === 'bugfix' ? 'bugfix' : 'requirements';
}

export function workflowShape(
  specType: ConcreteSpecType,
  mode: ConcreteWorkflowMode,
): WorkflowShape {
  const documentStage = documentStageFor(specType);
  switch (mode) {
    case 'requirements-first':
      return { specType, mode, order: [documentStage, 'design', 'tasks'], kind: 'sequential' };
    case 'design-first':
      return { specType, mode, order: ['design', documentStage, 'tasks'], kind: 'sequential' };
    case 'quick':
      return { specType, mode, order: [documentStage, 'design', 'tasks'], kind: 'parallel-docs' };
  }
}

/** Stages that exist for a spec type (independent of order). */
export function applicableStages(specType: ConcreteSpecType): StageName[] {
  return [documentStageFor(specType), 'design', 'tasks'];
}

export function isStageApplicable(specType: ConcreteSpecType, stage: StageName): boolean {
  return applicableStages(specType).includes(stage);
}

/** Direct prerequisites of a stage under the given workflow shape. */
export function stagePrerequisites(shape: WorkflowShape, stage: StageName): StageName[] {
  const index = shape.order.indexOf(stage);
  if (index < 0) return [];
  if (shape.kind === 'sequential') {
    return shape.order.slice(0, index);
  }
  // parallel-docs: document stages have no prerequisites; tasks needs both.
  return stage === 'tasks' ? shape.order.slice(0, 2) : [];
}

/** Stages whose approval depends (directly or transitively) on `stage`. */
export function dependentStages(shape: WorkflowShape, stage: StageName): StageName[] {
  return shape.order.filter((candidate) => stagePrerequisites(shape, candidate).includes(stage));
}

function isApproved(state: SpecWorkflowState, stage: StageName): boolean {
  return stateStage(state, stage)?.status === 'approved';
}

/**
 * Recompute the blocked/draft flag of every non-approved stage from the
 * recorded approvals. Returns a new stages object in workflow order.
 */
export function recomputeStages(
  shape: WorkflowShape,
  state: SpecWorkflowState,
): Record<string, StageApproval> {
  const next: Record<string, StageApproval> = {};
  for (const stage of shape.order) {
    const current = stateStage(state, stage);
    if (current === undefined) continue;
    if (current.status === 'approved') {
      next[stage] = current;
      continue;
    }
    const ready = stagePrerequisites(shape, stage).every((prereq) => isApproved(state, prereq));
    next[stage] = { ...current, status: ready ? 'draft' : 'blocked' };
  }
  return next;
}

const DRAFT_STATUS: Record<StageName, WorkflowStatus> = {
  requirements: 'REQUIREMENTS_DRAFT',
  bugfix: 'BUGFIX_DRAFT',
  design: 'DESIGN_DRAFT',
  tasks: 'TASKS_DRAFT',
};

const APPROVED_STATUS: Partial<Record<StageName, WorkflowStatus>> = {
  requirements: 'REQUIREMENTS_APPROVED',
  bugfix: 'BUGFIX_APPROVED',
  design: 'DESIGN_APPROVED',
  // tasks approved means the whole workflow is READY_FOR_IMPLEMENTATION.
};

/**
 * Derive the stored workflow status from stage approvals alone.
 * Quick workflows only distinguish READY_FOR_REVIEW / READY_FOR_IMPLEMENTATION.
 */
export function deriveWorkflowStatus(
  shape: WorkflowShape,
  stages: Record<string, StageApproval>,
): WorkflowStatus {
  const approved = (stage: StageName): boolean => stages[stage]?.status === 'approved';
  const allApproved = shape.order.every(approved);
  if (allApproved) return 'READY_FOR_IMPLEMENTATION';
  if (shape.kind === 'parallel-docs') return 'READY_FOR_REVIEW';

  for (let i = 0; i < shape.order.length; i += 1) {
    const stage = shape.order[i] as StageName;
    if (approved(stage)) continue;
    if (stages[stage]?.status === 'draft') return DRAFT_STATUS[stage];
    // Defensive: a blocked stage whose predecessor is approved should not
    // occur after recomputeStages, but hand-edited state can express it.
    const previous = i > 0 ? (shape.order[i - 1] as StageName) : undefined;
    if (previous !== undefined && approved(previous)) {
      return APPROVED_STATUS[previous] ?? DRAFT_STATUS[stage];
    }
    return DRAFT_STATUS[stage];
  }
  return 'READY_FOR_IMPLEMENTATION';
}

/** Workspace-relative stage file path, always with forward slashes. */
export function stageFilePath(specName: string, stage: StageName): string {
  return `.kiro/specs/${specName}/${stage}.md`;
}

/** Initial stages for a fresh workflow: nothing approved, first stage(s) draft. */
export function initialStages(shape: WorkflowShape, specName: string): Record<string, StageApproval> {
  const stages: Record<string, StageApproval> = {};
  for (const stage of shape.order) {
    const ready = stagePrerequisites(shape, stage).length === 0;
    stages[stage] = {
      status: ready ? 'draft' : 'blocked',
      file: stageFilePath(specName, stage),
      approvedAt: null,
      approvedHash: null,
    };
  }
  return stages;
}

/** The status a fresh spec starts in. */
export function initialWorkflowStatus(shape: WorkflowShape): WorkflowStatus {
  return deriveWorkflowStatus(shape, initialStages(shape, 'unused'));
}
