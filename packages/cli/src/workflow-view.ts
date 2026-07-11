import type { ApprovalHealth, SpecStateReadResult, WorkspaceInfo } from '@specbridge/core';
import { readSpecState } from '@specbridge/core';
import type { WorkflowEvaluation } from '@specbridge/workflow';
import { evaluateWorkflow } from '@specbridge/workflow';

/**
 * One read of a spec's workflow state, shared by status/list/show/doctor.
 * Never writes: stale approvals are computed in memory only.
 */
export interface SpecWorkflowView {
  stateRead: SpecStateReadResult;
  evaluation?: WorkflowEvaluation;
  health: ApprovalHealth;
  /** Workflow status for display: a WorkflowStatus, STALE_APPROVAL, unmanaged, or invalid. */
  displayStatus: string;
}

export function loadWorkflowView(workspace: WorkspaceInfo, specName: string): SpecWorkflowView {
  const stateRead = readSpecState(workspace, specName);
  if (stateRead.state === undefined) {
    const health: ApprovalHealth = stateRead.exists ? 'invalid' : 'unmanaged';
    return { stateRead, health, displayStatus: health };
  }
  const evaluation = evaluateWorkflow(workspace, stateRead.state);
  return {
    stateRead,
    evaluation,
    health: evaluation.health,
    displayStatus: evaluation.effectiveStatus,
  };
}
