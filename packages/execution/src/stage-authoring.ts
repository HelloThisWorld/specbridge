import path from 'node:path';
import type { SpecAnalysis } from '@specbridge/compat-kiro';
import {
  MarkdownDocument,
  analyzeSpec,
  parseBugfix,
  parseDesign,
  parseRequirements,
  parseTasks,
  requireSpec,
} from '@specbridge/compat-kiro';
import type { AgentConfig, StageName, WorkspaceInfo } from '@specbridge/core';
import { EXIT_CODES, STAGE_RUNNER_REPORT_JSON_SCHEMA, exitCodeForOutcome } from '@specbridge/core';
import type {
  AgentRunner,
  RunnerDetectionResult,
  RunnerRegistry,
  StageGenerationResult,
} from '@specbridge/runners';
import { ClaudeCodeRunner, buildClaudeInvocation, probeClaude } from '@specbridge/runners';
import type { Clock, SpecAnalysisResult, WorkflowEvaluation } from '@specbridge/workflow';
import { analyzeSpecStage, combineStageAnalyses, evaluateWorkflow, systemClock } from '@specbridge/workflow';
import { randomUUID } from 'node:crypto';
import { specDocumentSections, steeringSections, workspaceRootNote } from './context.js';
import type { SpecDocumentSection } from './prompts.js';
import {
  PROMPT_CONTRACT_VERSION,
  buildStageGenerationPrompt,
  buildStageRefinementPrompt,
} from './prompts.js';
import {
  RUN_RECORD_SCHEMA_VERSION,
  appendRunEvent,
  createRun,
  runDir,
  updateRunRecord,
  writeRunArtifact,
} from './run-store.js';
import { contextStagesFor, invalidateDependentApprovals, stageAuthoringGate } from './stage-rules.js';
import { unifiedDiff } from './unified-diff.js';
import { normalizeCandidateMarkdown, stageDocumentPath, writeStageDocument } from './write-stage.js';

/**
 * Model-assisted stage authoring: `spec generate` and `spec refine`.
 *
 * The runner returns Markdown in structured output; SpecBridge — not the
 * runner — validates it deterministically and writes the `.kiro` document
 * atomically. Invalid candidates are retained in the run directory and
 * never applied. Nothing is ever auto-approved.
 */

export interface AuthoringDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  registry: RunnerRegistry;
  clock?: Clock;
  idFactory?: () => string;
  signal?: AbortSignal;
}

export interface StageAuthoringRequest {
  specName: string;
  stage: StageName;
  intent: 'generate' | 'refine';
  /** Refinement instruction (required for refine). */
  instruction?: string;
  runnerName?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  dryRun?: boolean;
}

export interface AuthoringDryRunPlan {
  specName: string;
  stage: StageName;
  intent: 'generate' | 'refine';
  runner: string;
  toolPolicy: 'read-only' | 'inspect-only';
  targetFile: string;
  timeoutMs: number;
  promptVersion: string;
  prompt: string;
  /** Redacted argv preview (claude-code only). */
  argvPreview?: string[];
  warnings: string[];
}

export type StageAuthoringOutcome =
  | {
      kind: 'gate-failed';
      exitCode: number;
      message: string;
      remediation: string[];
      warnings: string[];
    }
  | { kind: 'runner-unavailable'; exitCode: number; detection: RunnerDetectionResult }
  | { kind: 'dry-run'; exitCode: number; plan: AuthoringDryRunPlan }
  | {
      kind: 'runner-failed';
      exitCode: number;
      runId: string;
      result: StageGenerationResult;
      artifactsDir: string;
    }
  | {
      kind: 'invalid-candidate';
      exitCode: number;
      runId: string;
      candidatePath: string;
      analysis: SpecAnalysisResult;
      artifactsDir: string;
      summary: string;
    }
  | {
      kind: 'applied';
      exitCode: number;
      runId: string;
      filePath: string;
      created: boolean;
      invalidated: StageName[];
      analysis: SpecAnalysisResult;
      diff: string;
      summary: string;
      openQuestions: string[];
      warnings: string[];
      artifactsDir: string;
    };

const READ_ONLY_STAGES: StageName[] = ['requirements', 'bugfix'];

function candidateAnalysis(
  spec: SpecAnalysis,
  stage: StageName,
  candidateMarkdown: string,
  virtualPath: string,
): SpecAnalysisResult {
  const document = MarkdownDocument.fromText(candidateMarkdown, virtualPath);
  const candidateSpec: SpecAnalysis = {
    ...spec,
    documents: { ...spec.documents, [stage]: document },
  };
  switch (stage) {
    case 'requirements':
      candidateSpec.requirements = parseRequirements(document);
      break;
    case 'design':
      candidateSpec.design = parseDesign(document);
      break;
    case 'tasks':
      candidateSpec.tasks = parseTasks(document);
      break;
    case 'bugfix':
      candidateSpec.bugfix = parseBugfix(document);
      break;
  }
  return combineStageAnalyses(spec.folder.name, [
    analyzeSpecStage(candidateSpec, stage, {
      placeholderSeverity: 'error',
      missingFileSeverity: 'error',
      stageStatus: 'draft',
      prerequisitesApproved: true,
    }),
  ]);
}

/** Validate model-reported referenced files; anything escaping the repo is dropped. */
function validateReferencedFiles(
  workspace: WorkspaceInfo,
  referenced: string[],
): { accepted: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const file of referenced) {
    if (file.includes('\0') || path.isAbsolute(file)) {
      rejected.push(file);
      continue;
    }
    const resolved = path.resolve(workspace.rootDir, file);
    const relative = path.relative(path.resolve(workspace.rootDir), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) rejected.push(file);
    else accepted.push(file);
  }
  return { accepted, rejected };
}

function runnerTimeoutMs(config: AgentConfig, request: StageAuthoringRequest): number {
  return request.timeoutMs ?? config.runners['claude-code'].timeoutMs;
}

async function argvPreviewFor(
  runner: AgentRunner,
  config: AgentConfig,
  workspace: WorkspaceInfo,
  prompt: string,
  toolPolicy: 'read-only' | 'inspect-only',
  timeoutMs: number,
): Promise<string[] | undefined> {
  if (!(runner instanceof ClaudeCodeRunner)) return undefined;
  const claudeConfig = config.runners['claude-code'];
  const probe = await probeClaude(claudeConfig);
  if (!probe.found) return undefined;
  const plan = buildClaudeInvocation({
    config: claudeConfig,
    probe,
    prompt,
    toolPolicy,
    outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
    execution: {
      workspaceRoot: workspace.rootDir,
      runDir: path.join(workspace.sidecarDir, 'runs', '<run-id>'),
      timeoutMs,
    },
    materializeTempFiles: false,
  });
  return [plan.executable, ...plan.argv];
}

export async function authorStage(
  deps: AuthoringDeps,
  request: StageAuthoringRequest,
): Promise<StageAuthoringOutcome> {
  const clock = deps.clock ?? systemClock;
  const { workspace, config } = deps;
  const folder = requireSpec(workspace, request.specName);
  const spec = analyzeSpec(workspace, folder);
  const specName = folder.name;

  if (spec.state === undefined) {
    return {
      kind: 'gate-failed',
      exitCode: EXIT_CODES.usageError,
      message:
        `Spec "${specName}" has no SpecBridge workflow state, so its workflow mode is unknown ` +
        'and generation prerequisites cannot be checked.',
      remediation: [
        `Approve an existing stage first to initialize state: specbridge spec approve ${specName} --stage <stage>`,
        `Or create specs with: specbridge spec new <name>`,
      ],
      warnings: [],
    };
  }
  const evaluation: WorkflowEvaluation = evaluateWorkflow(workspace, spec.state);
  const gate = stageAuthoringGate(spec.state, evaluation, request.stage);
  if (!gate.ok) {
    return {
      kind: 'gate-failed',
      exitCode: gate.reason === 'stage-not-applicable' ? EXIT_CODES.usageError : EXIT_CODES.gateFailure,
      message: gate.message,
      remediation: gate.remediation,
      warnings: [],
    };
  }

  const currentDocument = spec.documents[request.stage as keyof SpecAnalysis['documents']];
  if (request.intent === 'refine') {
    if (currentDocument === undefined) {
      return {
        kind: 'gate-failed',
        exitCode: EXIT_CODES.usageError,
        message: `Cannot refine ${request.stage} for "${specName}": ${request.stage}.md does not exist yet. Generate it first.`,
        remediation: [`specbridge spec generate ${specName} --stage ${request.stage}`],
        warnings: [],
      };
    }
    if (request.instruction === undefined || request.instruction.trim().length === 0) {
      return {
        kind: 'gate-failed',
        exitCode: EXIT_CODES.usageError,
        message: 'Refinement needs an instruction (--instruction or --instruction-file).',
        remediation: [],
        warnings: [],
      };
    }
  }

  // Resolve and probe the runner.
  const runnerName = request.runnerName ?? config.defaultRunner;
  const runner = deps.registry.get(runnerName);
  const detection = await runner.detect({ workspaceRoot: workspace.rootDir, probeCapabilities: true });
  if (detection.status !== 'available') {
    return {
      kind: 'runner-unavailable',
      exitCode: EXIT_CODES.runnerUnavailable,
      detection,
    };
  }

  // Build the bounded prompt.
  const steering = steeringSections(workspace);
  const contextStages = contextStagesFor(gate.shape, request.stage);
  const documents: SpecDocumentSection[] = specDocumentSections(spec, evaluation, contextStages);
  if (request.intent === 'generate' && currentDocument !== undefined) {
    documents.push({
      stage: request.stage,
      fileName: `${request.stage}.md (current draft)`,
      approved: false,
      content: currentDocument.bodyText(),
    });
  }
  const promptInput = {
    specName,
    specType: spec.state.specType,
    workflowMode: spec.state.workflowMode,
    stage: request.stage,
    steering,
    documents,
    workspaceRootNote: workspaceRootNote(workspace),
  };
  const prompt =
    request.intent === 'refine'
      ? buildStageRefinementPrompt({
          ...promptInput,
          currentContent: (currentDocument as MarkdownDocument).bodyText(),
          instruction: (request.instruction as string).trim(),
        })
      : buildStageGenerationPrompt(promptInput);

  const toolPolicy = READ_ONLY_STAGES.includes(request.stage) ? 'read-only' : 'inspect-only';
  const timeoutMs = runnerTimeoutMs(config, request);
  const targetFile = stageDocumentPath(workspace, specName, request.stage);

  if (request.dryRun === true) {
    const argvPreview = await argvPreviewFor(runner, config, workspace, prompt, toolPolicy, timeoutMs);
    return {
      kind: 'dry-run',
      exitCode: EXIT_CODES.ok,
      plan: {
        specName,
        stage: request.stage,
        intent: request.intent,
        runner: runnerName,
        toolPolicy,
        targetFile,
        timeoutMs,
        promptVersion: PROMPT_CONTRACT_VERSION,
        prompt,
        ...(argvPreview !== undefined ? { argvPreview } : {}),
        warnings: gate.warnings,
      },
    };
  }

  // Record the run.
  const runId = (deps.idFactory ?? randomUUID)();
  const createdAt = clock().toISOString();
  createRun(workspace, {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    runId,
    kind: request.intent === 'refine' ? 'stage-refinement' : 'stage-generation',
    specName,
    stage: request.stage,
    runner: runnerName,
    createdAt,
    resumeSupported: false,
    promptVersion: PROMPT_CONTRACT_VERSION,
    warnings: gate.warnings,
  });
  const artifactsDir = runDir(workspace, runId);
  writeRunArtifact(workspace, runId, 'prompt.md', prompt);
  writeRunArtifact(
    workspace,
    runId,
    'runner-request.json',
    `${JSON.stringify(
      {
        runner: runnerName,
        intent: request.intent,
        stage: request.stage,
        toolPolicy,
        timeoutMs,
        promptVersion: PROMPT_CONTRACT_VERSION,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
      },
      null,
      2,
    )}\n`,
  );
  appendRunEvent(workspace, runId, { at: createdAt, type: 'runner-start', runner: runnerName });

  const result = await runner.generateStage(
    {
      specName,
      stage: request.stage,
      intent: request.intent,
      prompt,
      promptVersion: PROMPT_CONTRACT_VERSION,
      toolPolicy,
    },
    {
      workspaceRoot: workspace.rootDir,
      runDir: artifactsDir,
      timeoutMs,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
      ...(request.maxBudgetUsd !== undefined ? { maxBudgetUsd: request.maxBudgetUsd } : {}),
    },
  );

  writeRunArtifact(workspace, runId, 'raw-stdout.log', result.rawStdout);
  writeRunArtifact(workspace, runId, 'raw-stderr.log', result.rawStderr);
  writeRunArtifact(
    workspace,
    runId,
    'runner-result.json',
    `${JSON.stringify(
      {
        outcome: result.outcome,
        failureReason: result.failureReason ?? null,
        report: result.report ?? null,
        process: result.process ?? null,
        sessionId: result.sessionId ?? null,
        durationMs: result.durationMs,
        warnings: result.warnings,
      },
      null,
      2,
    )}\n`,
  );
  const finishedAt = clock().toISOString();
  appendRunEvent(workspace, runId, { at: finishedAt, type: 'runner-finished', outcome: result.outcome });

  if (result.outcome !== 'completed' || result.report === undefined) {
    updateRunRecord(workspace, runId, {
      outcome: result.outcome === 'completed' ? 'malformed-output' : result.outcome,
      finishedAt,
      durationMs: result.durationMs,
      applied: false,
    });
    return {
      kind: 'runner-failed',
      exitCode: exitCodeForOutcome(result.outcome === 'completed' ? 'malformed-output' : result.outcome),
      runId,
      result,
      artifactsDir,
    };
  }

  const warnings = [...gate.warnings, ...result.warnings];
  if (result.report.stage !== request.stage) {
    warnings.push(
      `the runner reported stage "${result.report.stage}" but "${request.stage}" was requested; the requested stage is used`,
    );
  }
  const referenced = validateReferencedFiles(workspace, result.report.referencedFiles);
  if (referenced.rejected.length > 0) {
    warnings.push(
      `ignored ${referenced.rejected.length} referenced path(s) outside the repository: ${referenced.rejected.join(', ')}`,
    );
  }

  // Retain the candidate, then gate on deterministic analysis.
  const candidate = normalizeCandidateMarkdown(result.report.markdown);
  const candidatePath = writeRunArtifact(workspace, runId, `candidate-${request.stage}.md`, candidate);
  const analysis = candidateAnalysis(spec, request.stage, candidate, candidatePath);
  writeRunArtifact(
    workspace,
    runId,
    'candidate-analysis.json',
    `${JSON.stringify(
      {
        errorCount: analysis.errorCount,
        warningCount: analysis.warningCount,
        diagnostics: analysis.diagnostics,
      },
      null,
      2,
    )}\n`,
  );

  if (analysis.hasErrors) {
    updateRunRecord(workspace, runId, {
      outcome: 'completed',
      finishedAt,
      durationMs: result.durationMs,
      applied: false,
    });
    return {
      kind: 'invalid-candidate',
      exitCode: EXIT_CODES.gateFailure,
      runId,
      candidatePath,
      analysis,
      artifactsDir,
      summary: result.report.summary,
    };
  }

  const currentContent = currentDocument?.bodyText() ?? '';
  const diff = unifiedDiff(currentContent, candidate, {
    oldLabel: `${request.stage}.md (before)`,
    newLabel: `${request.stage}.md (after)`,
  });
  if (diff.length > 0) {
    writeRunArtifact(workspace, runId, `candidate-${request.stage}.diff`, diff);
  }

  const written = writeStageDocument(workspace, specName, request.stage, candidate);
  const invalidation = invalidateDependentApprovals(workspace, spec.state, request.stage, clock);
  updateRunRecord(workspace, runId, {
    outcome: 'completed',
    finishedAt: clock().toISOString(),
    durationMs: result.durationMs,
    applied: true,
  });
  appendRunEvent(workspace, runId, {
    at: clock().toISOString(),
    type: 'stage-written',
    file: written.filePath,
    invalidated: invalidation.invalidated,
  });

  return {
    kind: 'applied',
    exitCode: EXIT_CODES.ok,
    runId,
    filePath: written.filePath,
    created: written.created,
    invalidated: invalidation.invalidated,
    analysis,
    diff,
    summary: result.report.summary,
    openQuestions: result.report.openQuestions,
    warnings,
    artifactsDir,
  };
}
