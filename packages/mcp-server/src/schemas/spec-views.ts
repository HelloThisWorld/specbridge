import { z } from 'zod';
import type { SpecAnalysis } from '@specbridge/compat-kiro';
import type { WorkspaceInfo } from '@specbridge/core';
import type { WorkflowEvaluation } from '@specbridge/workflow';
import { evaluateWorkflow } from '@specbridge/workflow';

/**
 * Shared spec view models: the compact JSON shape used by spec_list,
 * spec_status, and the spec resources. Computed from the same read-only
 * analysis the CLI uses, so both surfaces always agree.
 */

export const taskProgressShape = z.object({
  total: z.number().int(),
  completed: z.number().int(),
  inProgress: z.number().int(),
  optionalTotal: z.number().int(),
  optionalCompleted: z.number().int(),
});

export const specSummaryShape = z.object({
  name: z.string(),
  type: z.enum(['feature', 'bugfix', 'unknown']),
  workflowMode: z.enum(['requirements-first', 'design-first', 'quick', 'unknown']),
  workflowStatus: z.string().describe('Stored workflow status, or STALE_APPROVAL / (unmanaged)'),
  approvalHealth: z.enum(['ok', 'stale', 'unmanaged', 'invalid']),
  managed: z.boolean().describe('True when SpecBridge sidecar state exists for the spec'),
  taskProgress: taskProgressShape,
  diagnosticCounts: z.object({
    errors: z.number().int(),
    warnings: z.number().int(),
    info: z.number().int(),
  }),
});
export type SpecSummaryView = z.infer<typeof specSummaryShape>;

export interface SpecEvaluationBundle {
  analysis: SpecAnalysis;
  evaluation: WorkflowEvaluation | undefined;
  approvalHealth: 'ok' | 'stale' | 'unmanaged' | 'invalid';
  workflowStatus: string;
}

/** Evaluate workflow state for one analyzed spec (read-only, in memory). */
export function evaluateSpecBundle(
  workspace: WorkspaceInfo,
  analysis: SpecAnalysis,
): SpecEvaluationBundle {
  if (analysis.state === undefined) {
    const invalid = analysis.diagnostics.some((diagnostic) =>
      diagnostic.code.startsWith('SIDECAR_STATE_'),
    );
    return {
      analysis,
      evaluation: undefined,
      approvalHealth: invalid ? 'invalid' : 'unmanaged',
      workflowStatus: '(unmanaged)',
    };
  }
  const evaluation = evaluateWorkflow(workspace, analysis.state);
  return {
    analysis,
    evaluation,
    approvalHealth: evaluation.health,
    workflowStatus: evaluation.effectiveStatus,
  };
}

export function toSpecSummary(bundle: SpecEvaluationBundle): SpecSummaryView {
  const { analysis } = bundle;
  const diagnostics = [...analysis.diagnostics, ...(bundle.evaluation?.diagnostics ?? [])];
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors += 1;
    else if (diagnostic.severity === 'warning') warnings += 1;
    else info += 1;
  }
  return {
    name: analysis.folder.name,
    type: analysis.state?.specType ?? analysis.classification.type,
    workflowMode: analysis.state?.workflowMode ?? analysis.classification.workflowMode,
    workflowStatus: bundle.workflowStatus,
    approvalHealth: bundle.approvalHealth,
    managed: analysis.state !== undefined,
    taskProgress: analysis.taskProgress,
    diagnosticCounts: { errors, warnings, info },
  };
}
