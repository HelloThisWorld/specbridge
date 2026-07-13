import type { SpecAnalysis } from '@specbridge/compat-kiro';
import type { SpecWorkflowState, StageName, WorkspaceInfo } from '@specbridge/core';
import { sha256Hex, trySha256File } from '@specbridge/core';
import {
  candidateAnalysis,
  normalizeCandidateMarkdown,
  stageDocumentPath,
  unifiedDiff,
} from '@specbridge/execution';
import type { SpecAnalysisResult, WorkflowEvaluation } from '@specbridge/workflow';
import { dependentStages, evaluateWorkflow, workflowShape } from '@specbridge/workflow';
import { stageAuthoringGate } from '@specbridge/execution';
import type { ServerContext } from '../context.js';
import { McpToolError } from '../errors.js';
import { LIMITS, assertInputSize } from '../limits.js';

/**
 * Shared candidate-stage evaluation for spec_stage_validate and
 * spec_stage_apply. Both tools evaluate a candidate through exactly this
 * path, so what validate reported is what apply enforces.
 */

export interface StageCandidateEvaluation {
  workspace: WorkspaceInfo;
  analysis: SpecAnalysis;
  state: SpecWorkflowState;
  evaluation: WorkflowEvaluation;
  stage: StageName;
  targetPath: string;
  currentExists: boolean;
  /** SHA-256 of the exact current file bytes; null when the file is absent. */
  currentHash: string | null;
  /** Candidate normalized to LF with one trailing newline. */
  normalizedCandidate: string;
  /** SHA-256 of the normalized candidate — the validate/apply binding. */
  candidateHash: string;
  analysisResult: SpecAnalysisResult;
  diff: string;
  /** Currently approved stages that applying this candidate would invalidate. */
  wouldInvalidate: StageName[];
  gateWarnings: string[];
}

export function evaluateStageCandidate(
  context: ServerContext,
  args: { specName: string; stage: StageName; candidateMarkdown: string },
): StageCandidateEvaluation {
  assertInputSize('candidateMarkdown', args.candidateMarkdown, LIMITS.maximumCandidateBytes);
  if (args.candidateMarkdown.trim().length === 0) {
    throw new McpToolError('SBMCP002', 'candidateMarkdown must not be empty.');
  }

  const { workspace, analysis } = context.requireSpecAnalysis(args.specName);
  if (analysis.state === undefined) {
    throw new McpToolError(
      'SBMCP012',
      `Spec "${analysis.folder.name}" has no SpecBridge workflow state, so its workflow mode is unknown ` +
        'and authoring prerequisites cannot be checked.',
      {
        remediation: [
          `Approve an existing stage first to initialize state (human action): specbridge spec approve ${analysis.folder.name} --stage <stage>`,
          'Or create new specs with the spec_create tool.',
        ],
      },
    );
  }
  const state = analysis.state;
  const evaluation = evaluateWorkflow(workspace, state);

  const gate = stageAuthoringGate(state, evaluation, args.stage);
  if (!gate.ok) {
    const code =
      gate.reason === 'stage-not-applicable' || gate.reason === 'stage-approved'
        ? ('SBMCP004' as const)
        : ('SBMCP006' as const);
    throw new McpToolError(code, gate.message, { remediation: gate.remediation });
  }

  const targetPath = stageDocumentPath(workspace, analysis.folder.name, args.stage);
  const currentHash = trySha256File(targetPath) ?? null;
  const normalizedCandidate = normalizeCandidateMarkdown(args.candidateMarkdown);
  const candidateHash = sha256Hex(normalizedCandidate);

  const analysisResult = candidateAnalysis(
    analysis,
    args.stage,
    normalizedCandidate,
    `${args.stage}.md (candidate)`,
  );

  const currentDocument = analysis.documents[args.stage as keyof SpecAnalysis['documents']];
  const currentContent = currentDocument?.bodyText() ?? '';
  const diff = unifiedDiff(currentContent, normalizedCandidate, {
    oldLabel: `${args.stage}.md (current)`,
    newLabel: `${args.stage}.md (candidate)`,
  });

  const shape = workflowShape(state.specType, state.workflowMode);
  const wouldInvalidate = dependentStages(shape, args.stage).filter(
    (dependent) =>
      evaluation.stages.find((stage) => stage.stage === dependent)?.stored.status === 'approved',
  );

  return {
    workspace,
    analysis,
    state,
    evaluation,
    stage: args.stage,
    targetPath,
    currentExists: currentHash !== null,
    currentHash,
    normalizedCandidate,
    candidateHash,
    analysisResult,
    diff,
    wouldInvalidate,
    gateWarnings: gate.warnings,
  };
}

/** Enforce the expectedCurrentHash contract (null asserts "file absent"). */
export function assertCurrentHash(
  evaluation: StageCandidateEvaluation,
  expected: string | null | undefined,
): void {
  if (expected === undefined) return;
  if (expected === null) {
    if (evaluation.currentExists) {
      throw new McpToolError(
        'SBMCP017',
        `${evaluation.stage}.md already exists (hash ${evaluation.currentHash}); expectedCurrentHash null asserts it is absent. ` +
          'Re-validate against the current document.',
      );
    }
    return;
  }
  if (evaluation.currentHash !== expected) {
    throw new McpToolError(
      'SBMCP017',
      `${evaluation.stage}.md changed since validation: expected hash ${expected}, ` +
        `current ${evaluation.currentHash ?? '(file absent)'}. Re-validate the candidate against the current document.`,
    );
  }
}
