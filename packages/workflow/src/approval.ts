import type {
  ConcreteSpecType,
  ConcreteWorkflowMode,
  Diagnostic,
  SpecWorkflowState,
  StageApproval,
  StageName,
  WorkspaceInfo,
} from '@specbridge/core';
import {
  SPEC_STATE_SCHEMA_VERSION,
  TASK_PLAN_HASH_SEMANTICS_VERSION,
  readSpecState,
  sha256File,
  stateStage,
  writeSpecState,
} from '@specbridge/core';
import type { SpecAnalysis } from '@specbridge/compat-kiro';
import { tryTaskPlanHashOfFile } from '@specbridge/compat-kiro';
import type { Clock } from './clock.js';
import { isoNow, systemClock } from './clock.js';
import type { SpecAnalysisResult } from './analyzers.js';
import { analyzeSpecStage, combineStageAnalyses } from './analyzers.js';
import type { WorkflowEvaluation } from './health.js';
import { evaluateWorkflow, resolveStageFile } from './health.js';
import type { WorkflowShape } from './state-machine.js';
import {
  applicableStages,
  dependentStages,
  deriveWorkflowStatus,
  documentStageFor,
  initialStages,
  isStageApplicable,
  recomputeStages,
  stagePrerequisites,
  workflowShape,
} from './state-machine.js';

/**
 * Stage approval and revocation.
 *
 * Approval is the only door to sidecar state changes:
 * 1. the stage must exist for the spec type,
 * 2. every prerequisite stage must be approved and still match its approved
 *    file bytes,
 * 3. deterministic analysis of the stage must produce no errors,
 * 4. then the exact file bytes are hashed and recorded.
 *
 * The approved Markdown file itself is never rewritten.
 */

export interface ApprovalRequest {
  stage: StageName;
  revoke?: boolean;
}

export interface ApprovalOptions {
  clock?: Clock;
}

export type ApprovalResult =
  | {
      ok: true;
      action: 'approved';
      stage: StageName;
      state: SpecWorkflowState;
      statePath: string;
      hash: string;
      /** True when this replaced an earlier approval of the same stage. */
      reapproved: boolean;
      /** Later-stage approvals that were invalidated by this (re)approval. */
      invalidated: StageName[];
      /** True when sidecar state was created by this command. */
      initialized: boolean;
      analysis: SpecAnalysisResult;
      diagnostics: Diagnostic[];
    }
  | {
      ok: true;
      action: 'revoked';
      stage: StageName;
      state: SpecWorkflowState;
      statePath: string;
      /** Later-stage approvals invalidated together with this one. */
      invalidated: StageName[];
      diagnostics: Diagnostic[];
    }
  | {
      ok: false;
      /** `usage` failures exit 2; `gate` failures exit 1. */
      failure: 'usage' | 'gate';
      reason:
        | 'stage-not-applicable'
        | 'nothing-to-revoke'
        | 'initialization-unsupported'
        | 'prerequisites-unmet'
        | 'analysis-errors';
      message: string;
      /** Prerequisites that are not approved at all. */
      missingPrerequisites?: StageName[];
      /** Prerequisites whose approval is stale (file changed after approval). */
      stalePrerequisites?: StageName[];
      analysis?: SpecAnalysisResult;
      diagnostics: Diagnostic[];
    };

/** Deterministic workflow-mode inference for an unmanaged spec's first approval. */
export function inferWorkflowForFirstApproval(
  specType: ConcreteSpecType,
  firstStage: StageName,
):
  | { ok: true; mode: ConcreteWorkflowMode; explanation: string }
  | { ok: false; message: string } {
  const documentStage = documentStageFor(specType);
  if (firstStage === documentStage) {
    return {
      ok: true,
      mode: 'requirements-first',
      explanation: `Initialized as ${specType === 'bugfix' ? 'a bugfix workflow' : 'requirements-first'} because ${documentStage} is being approved first and no contrary evidence exists.`,
    };
  }
  if (firstStage === 'design') {
    return {
      ok: true,
      mode: 'design-first',
      explanation: 'Initialized as design-first because design is being approved first.',
    };
  }
  return {
    ok: false,
    message:
      `Cannot start managing this spec by approving "${firstStage}": tasks always require earlier stage approvals. ` +
      `Approve "${documentStage}" or "design" first.`,
  };
}

function buildInitialState(
  specName: string,
  specType: ConcreteSpecType,
  mode: ConcreteWorkflowMode,
  origin: SpecWorkflowState['origin'],
  clock: Clock,
): SpecWorkflowState {
  const shape = workflowShape(specType, mode);
  const stages = initialStages(shape, specName);
  const now = isoNow(clock);
  return {
    schemaVersion: SPEC_STATE_SCHEMA_VERSION,
    specName,
    specType,
    workflowMode: mode,
    origin,
    status: deriveWorkflowStatus(shape, stages),
    createdAt: now,
    updatedAt: now,
    stages: stages as SpecWorkflowState['stages'],
  };
}

/** Fresh sidecar state for a spec created by `spec new`. */
export function newSpecState(
  specName: string,
  specType: ConcreteSpecType,
  mode: ConcreteWorkflowMode,
  clock: Clock = systemClock,
): SpecWorkflowState {
  return buildInitialState(specName, specType, mode, 'created-by-specbridge', clock);
}

function stageList(stages: StageName[]): string {
  return stages.join(', ');
}

/**
 * A stage approval reset to draft. Every approval artifact — including the
 * v0.4 plan-hash fields — is removed so the cleared entry validates and a
 * later re-approval starts from a clean slate.
 */
function clearedApproval(stage: StageApproval): StageApproval {
  const {
    approvedPlanHash: _plan,
    hashAlgorithm: _algorithm,
    hashSemanticsVersion: _semantics,
    ...rest
  } = stage;
  return { ...rest, status: 'draft', approvedAt: null, approvedHash: null };
}

function cloneStages(state: SpecWorkflowState): Record<string, StageApproval> {
  const stages: Record<string, StageApproval> = {};
  for (const [name, value] of Object.entries(state.stages)) {
    if (value !== undefined && typeof value === 'object') {
      stages[name] = { ...(value as StageApproval) };
    }
  }
  return stages;
}

function withStages(
  state: SpecWorkflowState,
  shape: WorkflowShape,
  stages: Record<string, StageApproval>,
  clock: Clock,
): SpecWorkflowState {
  const ordered: Record<string, StageApproval> = {};
  for (const stage of shape.order) {
    const value = stages[stage];
    if (value !== undefined) ordered[stage] = value;
  }
  return {
    ...state,
    stages: ordered as SpecWorkflowState['stages'],
    status: deriveWorkflowStatus(shape, ordered),
    updatedAt: isoNow(clock),
  };
}

/**
 * Approve or revoke one stage of a spec.
 *
 * `spec` must be the current analysis of an existing spec folder. The caller
 * is responsible for having resolved the spec (unknown specs are a usage
 * error before this point).
 */
export function approveStage(
  workspace: WorkspaceInfo,
  spec: SpecAnalysis,
  request: ApprovalRequest,
  options: ApprovalOptions = {},
): ApprovalResult {
  const clock = options.clock ?? systemClock;
  const specName = spec.folder.name;
  const diagnostics: Diagnostic[] = [];

  // Load state; invalid state degrades to "unmanaged" with a diagnostic.
  const stateRead = readSpecState(workspace, specName);
  diagnostics.push(...stateRead.diagnostics);
  let state = stateRead.state;
  let initialized = false;

  if (state === undefined) {
    if (request.revoke === true) {
      return {
        ok: false,
        failure: 'usage',
        reason: 'nothing-to-revoke',
        message:
          stateRead.exists
            ? `Cannot revoke: the sidecar state for "${specName}" is invalid. Approving a stage will rebuild it.`
            : `Cannot revoke: "${specName}" has no sidecar state (approval state: unmanaged). There is nothing to revoke.`,
        diagnostics,
      };
    }

    // First approval of an existing Kiro spec: initialize sidecar state.
    const specType: ConcreteSpecType = spec.classification.type === 'bugfix' ? 'bugfix' : 'feature';
    if (!isStageApplicable(specType, request.stage)) {
      return {
        ok: false,
        failure: 'usage',
        reason: 'stage-not-applicable',
        message: `Stage "${request.stage}" does not apply to a ${specType} spec. Applicable stages: ${stageList(applicableStages(specType))}.`,
        diagnostics,
      };
    }
    const inference = inferWorkflowForFirstApproval(specType, request.stage);
    if (!inference.ok) {
      return {
        ok: false,
        failure: 'gate',
        reason: 'initialization-unsupported',
        message: inference.message,
        diagnostics,
      };
    }
    state = buildInitialState(specName, specType, inference.mode, 'existing-kiro-workspace', clock);
    initialized = true;
    diagnostics.push({
      severity: 'info',
      code: 'STATE_INITIALIZED',
      message: inference.explanation,
    });
  }

  const shape = workflowShape(state.specType, state.workflowMode);

  if (!isStageApplicable(state.specType, request.stage)) {
    return {
      ok: false,
      failure: 'usage',
      reason: 'stage-not-applicable',
      message: `Stage "${request.stage}" does not apply to a ${state.specType} spec. Applicable stages: ${stageList(applicableStages(state.specType))}.`,
      diagnostics,
    };
  }

  if (request.revoke === true) {
    return revoke(workspace, state, shape, request.stage, clock, diagnostics);
  }

  // Prerequisites must be approved and still match their approved bytes.
  const evaluation: WorkflowEvaluation = evaluateWorkflow(workspace, state);
  const prerequisites = stagePrerequisites(shape, request.stage);
  const missingPrerequisites: StageName[] = [];
  const stalePrerequisites: StageName[] = [];
  for (const prerequisite of prerequisites) {
    const stageEvaluation = evaluation.stages.find((s) => s.stage === prerequisite);
    if (stageEvaluation === undefined) continue;
    if (stageEvaluation.stored.status !== 'approved') {
      missingPrerequisites.push(prerequisite);
    } else if (stageEvaluation.effective !== 'approved') {
      stalePrerequisites.push(prerequisite);
    }
  }
  if (missingPrerequisites.length > 0 || stalePrerequisites.length > 0) {
    const parts: string[] = [];
    if (missingPrerequisites.length > 0) {
      parts.push(`${stageList(missingPrerequisites)} ${missingPrerequisites.length === 1 ? 'is' : 'are'} not approved yet`);
    }
    if (stalePrerequisites.length > 0) {
      parts.push(`${stageList(stalePrerequisites)} changed after approval and must be re-approved`);
    }
    return {
      ok: false,
      failure: 'gate',
      reason: 'prerequisites-unmet',
      message: `Cannot approve ${request.stage} for "${specName}": ${parts.join('; ')}.`,
      missingPrerequisites,
      stalePrerequisites,
      diagnostics,
    };
  }

  // Deterministic stage analysis gates the approval: errors block, warnings pass.
  const stored = stateStage(state, request.stage);
  const analysis = combineStageAnalyses(specName, [
    analyzeSpecStage(spec, request.stage, {
      placeholderSeverity: 'error',
      missingFileSeverity: 'error',
      ...(stored !== undefined ? { stageStatus: stored.status } : {}),
      prerequisitesApproved: true,
    }),
  ]);
  if (analysis.hasErrors) {
    return {
      ok: false,
      failure: 'gate',
      reason: 'analysis-errors',
      message: `Cannot approve ${request.stage} for "${specName}": analysis found ${analysis.errorCount} error${analysis.errorCount === 1 ? '' : 's'}. Fix them and re-run the approval.`,
      analysis,
      diagnostics,
    };
  }

  // Hash the exact file bytes of the stage document.
  const stages = cloneStages(state);
  const target = stages[request.stage];
  if (target === undefined) {
    return {
      ok: false,
      failure: 'usage',
      reason: 'stage-not-applicable',
      message: `Sidecar state for "${specName}" has no "${request.stage}" stage entry.`,
      diagnostics,
    };
  }
  const filePath = resolveStageFile(workspace, target);
  const hash = sha256File(filePath);

  const reapproved = target.status === 'approved';
  const hashChanged = reapproved && target.approvedHash !== hash;

  // A reapproval after content changes means every dependent approval was
  // made against different content — invalidate them (files are untouched).
  const invalidated: StageName[] = [];
  if (!reapproved || hashChanged) {
    for (const dependent of dependentStages(shape, request.stage)) {
      const dependentStage = stages[dependent];
      if (dependentStage !== undefined && dependentStage.status === 'approved') {
        stages[dependent] = clearedApproval(dependentStage);
        invalidated.push(dependent);
      }
    }
  }

  // The tasks stage additionally records a checkbox-normalized plan hash
  // (semantics v2) so later `[ ]` → `[x]` progress does not read as a plan
  // change. Other stages stay exact-byte only.
  const planHash = request.stage === 'tasks' ? tryTaskPlanHashOfFile(filePath) : undefined;
  stages[request.stage] = {
    ...target,
    status: 'approved',
    approvedAt: isoNow(clock),
    approvedHash: hash,
    ...(planHash !== undefined
      ? {
          approvedPlanHash: planHash,
          hashAlgorithm: 'sha256' as const,
          hashSemanticsVersion: TASK_PLAN_HASH_SEMANTICS_VERSION,
        }
      : {}),
  };

  const recomputed = recomputeStages(shape, {
    ...state,
    stages: stages as SpecWorkflowState['stages'],
  });
  const nextState = withStages(state, shape, recomputed, clock);
  const statePath = writeSpecState(workspace, nextState);

  return {
    ok: true,
    action: 'approved',
    stage: request.stage,
    state: nextState,
    statePath,
    hash,
    reapproved,
    invalidated,
    initialized,
    analysis,
    diagnostics,
  };
}

function revoke(
  workspace: WorkspaceInfo,
  state: SpecWorkflowState,
  shape: WorkflowShape,
  stage: StageName,
  clock: Clock,
  diagnostics: Diagnostic[],
): ApprovalResult {
  const stages = cloneStages(state);
  const target = stages[stage];
  if (target === undefined || target.status !== 'approved') {
    return {
      ok: false,
      failure: 'usage',
      reason: 'nothing-to-revoke',
      message: `Cannot revoke ${stage} for "${state.specName}": it is not approved (current status: ${target?.status ?? 'missing'}).`,
      diagnostics,
    };
  }

  const invalidated: StageName[] = [];
  for (const dependent of dependentStages(shape, stage)) {
    const dependentStage = stages[dependent];
    if (dependentStage !== undefined && dependentStage.status === 'approved') {
      stages[dependent] = clearedApproval(dependentStage);
      invalidated.push(dependent);
    }
  }

  stages[stage] = clearedApproval(target);

  const recomputed = recomputeStages(shape, {
    ...state,
    stages: stages as SpecWorkflowState['stages'],
  });
  const nextState = withStages(state, shape, recomputed, clock);
  const statePath = writeSpecState(workspace, nextState);

  return {
    ok: true,
    action: 'revoked',
    stage,
    state: nextState,
    statePath,
    invalidated,
    diagnostics,
  };
}
