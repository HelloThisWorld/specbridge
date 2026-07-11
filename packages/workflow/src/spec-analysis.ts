import type { StageName, StageStatus } from '@specbridge/core';
import type { SpecAnalysis } from '@specbridge/compat-kiro';
import type { SpecAnalysisResult, StageAnalysisOptions } from './analyzers.js';
import { analyzeSpecStage, combineStageAnalyses } from './analyzers.js';
import type { WorkflowEvaluation } from './health.js';
import { isEffectivelyApproved } from './health.js';
import { applicableStages } from './state-machine.js';

/**
 * Workflow-aware analysis wiring: decides, per stage, how strict the
 * analyzer should be based on the recorded workflow state.
 *
 * - Active (draft/approved) stages: placeholders are errors, a missing file
 *   is an error.
 * - Blocked stages: placeholders are warnings, a missing file is info —
 *   a "pending" stub behind an unapproved prerequisite is expected.
 * - Unmanaged specs (no sidecar state): every present stage is analyzed at
 *   full strictness, but nothing is assumed about approvals.
 */

export function stagesToAnalyze(
  spec: SpecAnalysis,
  evaluation: WorkflowEvaluation | undefined,
): StageName[] {
  if (evaluation !== undefined) {
    return evaluation.stages.map((stage) => stage.stage);
  }
  return applicableStages(spec.classification.type === 'bugfix' ? 'bugfix' : 'feature');
}

export function stageAnalysisOptions(
  evaluation: WorkflowEvaluation | undefined,
  stage: StageName,
): StageAnalysisOptions {
  if (evaluation === undefined) {
    // Unmanaged: analyze at full strictness; skip state-dependent advisories.
    return { placeholderSeverity: 'error', missingFileSeverity: 'error', prerequisitesApproved: true };
  }
  const stageEvaluation = evaluation.stages.find((s) => s.stage === stage);
  const stored: StageStatus = stageEvaluation?.stored.status ?? 'draft';
  const blocked = stored === 'blocked';
  const prerequisitesApproved = (stageEvaluation?.prerequisites ?? []).every((prerequisite) =>
    isEffectivelyApproved(evaluation, prerequisite),
  );
  return {
    placeholderSeverity: blocked ? 'warning' : 'error',
    missingFileSeverity: blocked ? 'info' : 'error',
    stageStatus: stored,
    prerequisitesApproved,
  };
}

/** Analyze the requested stages of a spec with workflow-appropriate strictness. */
export function analyzeSpecWorkflow(
  spec: SpecAnalysis,
  evaluation: WorkflowEvaluation | undefined,
  stages?: StageName[],
): SpecAnalysisResult {
  const targets = stages ?? stagesToAnalyze(spec, evaluation);
  const results = targets.map((stage) =>
    analyzeSpecStage(spec, stage, stageAnalysisOptions(evaluation, stage)),
  );
  return combineStageAnalyses(spec.folder.name, results);
}
