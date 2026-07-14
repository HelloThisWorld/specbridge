import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
  RunnerSelectionFailure,
  RunnerSelectionPlan,
  StageGenerationInput,
  StageGenerationResult,
} from '@specbridge/runners';
import {
  MAX_CORRECTION_RETRIES,
  buildClaudeInvocation,
  buildCodexInvocation,
  composeNormalizedResult,
  fallbackEligible,
  probeClaude,
  probeCodex,
  retryBackoffMs,
  selectRunner,
  transientRetryEligible,
} from '@specbridge/runners';
import type { Clock, SpecAnalysisResult, WorkflowEvaluation } from '@specbridge/workflow';
import { analyzeSpecStage, combineStageAnalyses, evaluateWorkflow, systemClock } from '@specbridge/workflow';
import type { GitSnapshot } from '@specbridge/evidence';
import { captureGitSnapshot } from '@specbridge/evidence';
import { randomUUID } from 'node:crypto';
import { specDocumentSections, steeringSections, workspaceRootNote } from './context.js';
import type { SpecDocumentSection } from './prompts.js';
import {
  PROMPT_CONTRACT_VERSION,
  buildStageGenerationPrompt,
  buildStageRefinementPrompt,
  promptRepositoryAccess,
} from './prompts.js';
import {
  RUN_RECORD_SCHEMA_VERSION,
  appendRunEvent,
  createRun,
  runDir,
  updateRunRecord,
  writeRunArtifact,
} from './run-store.js';
import { createAttempt, finalizeAttempt, writeAttemptArtifact } from './attempt-store.js';
import type { AttemptRecord } from './attempt-store.js';
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
 *
 * v0.6: capability-driven selection runs before any invocation; every
 * runner invocation (including bounded correction/transport retries and
 * explicitly configured fallback candidates) gets its own append-only
 * attempt record under `.specbridge/runs/<run-id>/attempts/`.
 */

export interface AuthoringDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  registry: RunnerRegistry;
  clock?: Clock;
  idFactory?: () => string;
  signal?: AbortSignal;
  /** Test hook: replaces the real backoff sleep between transport retries. */
  backoff?: (ms: number) => Promise<void>;
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

/** Data-boundary summary shown in runner plans (what leaves the machine). */
export interface AuthoringDataBoundary {
  endpoint?: string;
  networkBacked: boolean;
  networkRequestWillOccur: boolean;
  model: string | null;
  /** Workspace-relative documents included in the prompt. */
  documents: string[];
  inputCharacters: number;
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
  /** Redacted argv preview (agent CLI runners only). */
  argvPreview?: string[];
  /** v0.6: capability-checked selection plan. */
  runnerPlan?: RunnerSelectionPlan;
  dataBoundary?: AuthoringDataBoundary;
  warnings: string[];
}

/** One line per attempted profile: honest, auditable fallback reporting. */
export interface AuthoringAttemptSummary {
  attemptId?: string;
  profile: string;
  kind: 'initial' | 'correction-retry' | 'transport-retry' | 'fallback' | 'skipped';
  outcome: string;
  reason: string;
}

export type StageAuthoringOutcome =
  | {
      kind: 'gate-failed';
      exitCode: number;
      message: string;
      remediation: string[];
      warnings: string[];
    }
  | {
      kind: 'selection-failed';
      exitCode: number;
      failure: RunnerSelectionFailure;
    }
  | { kind: 'runner-unavailable'; exitCode: number; detection: RunnerDetectionResult }
  | { kind: 'dry-run'; exitCode: number; plan: AuthoringDryRunPlan }
  | {
      kind: 'runner-failed';
      exitCode: number;
      runId: string;
      result: StageGenerationResult;
      artifactsDir: string;
      attempts: AuthoringAttemptSummary[];
      profile: string;
    }
  | {
      kind: 'invalid-candidate';
      exitCode: number;
      runId: string;
      candidatePath: string;
      analysis: SpecAnalysisResult;
      artifactsDir: string;
      summary: string;
      attempts: AuthoringAttemptSummary[];
      profile: string;
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
      attempts: AuthoringAttemptSummary[];
      profile: string;
      runnerPlan?: RunnerSelectionPlan;
    };

const READ_ONLY_STAGES: StageName[] = ['requirements', 'bugfix'];

/**
 * Deterministic analysis of a candidate stage document, in memory, at full
 * draft strictness (placeholders and missing content are errors). Shared by
 * runner-based authoring and the MCP spec_stage_validate/apply tools so a
 * candidate is always judged by exactly the same rules.
 */
export function candidateAnalysis(
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

/** Redacted argv preview for dry runs (agent CLI runners only). */
async function authoringArgvPreview(
  deps: AuthoringDeps,
  plan: RunnerSelectionPlan,
  prompt: string,
  toolPolicy: 'read-only' | 'inspect-only',
  timeoutMs: number,
): Promise<string[] | undefined> {
  const profileConfig = deps.registry.getProfile(plan.profile).config;
  const execution = {
    workspaceRoot: deps.workspace.rootDir,
    runDir: path.join(deps.workspace.sidecarDir, 'runs', '<run-id>'),
    timeoutMs,
  };
  if (profileConfig.runner === 'claude-code') {
    const probe = await probeClaude(profileConfig);
    if (!probe.found) return undefined;
    const invocation = buildClaudeInvocation({
      config: profileConfig,
      probe,
      prompt,
      toolPolicy,
      outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      execution,
      materializeTempFiles: false,
    });
    return [invocation.executable, ...invocation.argv];
  }
  if (profileConfig.runner === 'codex-cli') {
    const probe = await probeCodex(profileConfig);
    if (!probe.found) return undefined;
    const invocation = buildCodexInvocation({
      config: profileConfig,
      probe,
      prompt,
      toolPolicy,
      outputJsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      execution,
      materializeTempFiles: false,
    });
    return [invocation.executable, ...invocation.argv];
  }
  return undefined;
}

function includedDocumentPaths(
  specName: string,
  steering: { name: string }[],
  documents: SpecDocumentSection[],
): string[] {
  return [
    ...steering.map((section) => `.kiro/steering/${section.name}`),
    ...documents.map((section) => `.kiro/specs/${specName}/${section.stage}.md`),
  ];
}

interface AttemptLoopSuccess {
  kind: 'success';
  result: StageGenerationResult;
  plan: RunnerSelectionPlan;
  attempts: AuthoringAttemptSummary[];
}

interface AttemptLoopFailure {
  kind: 'failure';
  result: StageGenerationResult;
  plan: RunnerSelectionPlan;
  attempts: AuthoringAttemptSummary[];
}

/**
 * Bounded attempt loop for one authoring run:
 *
 *   candidate profiles = selected profile + explicitly configured fallbacks
 *   per profile: 1 initial attempt
 *                + at most MAX_CORRECTION_RETRIES structured-output retries
 *                  (adapters that declare correction support)
 *                + at most MAX_TRANSPORT_RETRIES transient transport retries
 *                  (exponential backoff, bounded jitter)
 *
 * Fallback moves to the next candidate only for fallback-eligible failures
 * (never after auth/permission/config failures or user cancellation) and
 * never after the repository changed since the run started. Every attempt —
 * and every skipped candidate — is recorded.
 */
async function runAuthoringAttempts(
  deps: AuthoringDeps,
  request: StageAuthoringRequest,
  runId: string,
  primary: RunnerSelectionPlan,
  input: Omit<StageGenerationInput, 'correction'>,
  timeoutMs: number,
  clock: Clock,
): Promise<AttemptLoopSuccess | AttemptLoopFailure> {
  const operation = request.intent === 'refine' ? 'stage-refinement' : 'stage-generation';
  const attempts: AuthoringAttemptSummary[] = [];
  const backoff = deps.backoff ?? ((ms: number) => sleep(ms));
  const candidates = [primary.profile, ...primary.fallbackChain];
  let lastFailure: { result: StageGenerationResult; plan: RunnerSelectionPlan } | undefined;
  let parentAttemptId: string | undefined;

  // Authoring runners are read-only bounded, but "no fallback after
  // repository modification" is verified, not assumed: the working tree is
  // fingerprinted before the first attempt and re-checked before every
  // fallback candidate (skipped when git is unavailable — nothing could be
  // verified, and authoring itself never requires git).
  const initialTree = candidates.length > 1 ? await captureGitSnapshot(deps.workspace.rootDir) : undefined;
  const treeFingerprint = (snapshot: GitSnapshot): string =>
    JSON.stringify(snapshot.entries.map((entry) => [entry.path, entry.contentHash]));

  for (let index = 0; index < candidates.length; index += 1) {
    const profileName = candidates[index] as string;
    const isFallback = index > 0;

    if (isFallback && initialTree !== undefined && initialTree.gitAvailable) {
      const treeNow = await captureGitSnapshot(deps.workspace.rootDir);
      if (treeFingerprint(treeNow) !== treeFingerprint(initialTree)) {
        attempts.push({
          profile: profileName,
          kind: 'skipped',
          outcome: 'not-attempted',
          reason: 'the repository changed since the run started; fallback never runs after repository modification',
        });
        appendRunEvent(deps.workspace, runId, {
          at: clock().toISOString(),
          type: 'fallback-stopped',
          profile: profileName,
          reason: 'repository-modified',
        });
        break;
      }
    }

    // Fallback candidates are re-validated with the same selection rules
    // (chain membership counts as explicit selection).
    const selection = isFallback
      ? selectRunner(deps.registry, deps.config, { operation, explicitProfile: profileName })
      : ({ ok: true, plan: primary } as const);
    if (!selection.ok) {
      attempts.push({
        profile: profileName,
        kind: 'skipped',
        outcome: 'not-attempted',
        reason: selection.failure.error.message,
      });
      appendRunEvent(deps.workspace, runId, {
        at: clock().toISOString(),
        type: 'fallback-skipped',
        profile: profileName,
        reason: selection.failure.error.code,
      });
      continue;
    }
    const plan = selection.plan;
    const runner: AgentRunner = deps.registry.get(plan.profile);
    const profileConfig = deps.registry.getProfile(plan.profile).config;
    const profileTimeout =
      request.timeoutMs ?? (profileConfig.runner !== 'mock' ? profileConfig.timeoutMs : timeoutMs);

    let transportRetries = 0;
    let correctionRetries = 0;
    let correction: StageGenerationInput['correction'] | undefined;

    for (;;) {
      const attemptKind: AttemptRecord['attemptKind'] =
        correction !== undefined
          ? 'correction-retry'
          : transportRetries > 0
            ? 'transport-retry'
            : isFallback
              ? 'fallback'
              : 'initial';
      const attempt = createAttempt(deps.workspace, {
        runId,
        profile: plan.profile,
        runner: plan.runner,
        category: plan.category,
        supportLevel: plan.supportLevel,
        operation,
        attemptKind,
        ...(parentAttemptId !== undefined ? { parentAttemptId } : {}),
        boundary:
          plan.category === 'mock'
            ? 'in-process'
            : plan.category === 'model-api'
              ? plan.networkBacked
                ? 'network-endpoint'
                : 'loopback-endpoint'
              : 'local-process',
        model: request.model ?? plan.model,
        capabilitySnapshot: plan.declaredCapabilities,
        createdAt: clock().toISOString(),
      });
      appendRunEvent(deps.workspace, runId, {
        at: clock().toISOString(),
        type: 'attempt-start',
        attemptId: attempt.attemptId,
        profile: plan.profile,
        attemptKind,
      });

      const result = await runner.generateStage(
        { ...input, ...(correction !== undefined ? { correction } : {}) },
        {
          workspaceRoot: deps.workspace.rootDir,
          runDir: runDir(deps.workspace, runId),
          timeoutMs: profileTimeout,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          ...(request.model !== undefined ? { model: request.model } : {}),
          ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
          ...(request.maxBudgetUsd !== undefined ? { maxBudgetUsd: request.maxBudgetUsd } : {}),
        },
      );
      finalizeAttempt(deps.workspace, attempt, {
        finishedAt: clock().toISOString(),
        outcome: result.outcome,
        durationMs: result.durationMs,
        result,
        normalized: composeNormalizedResult(
          {
            profile: plan.profile,
            category: plan.category,
            supportLevel: plan.supportLevel,
            operation,
          },
          result,
        ),
      });
      if (result.invalidStructuredOutput !== undefined) {
        writeAttemptArtifact(
          deps.workspace,
          runId,
          attempt.attemptId,
          'invalid-candidate.txt',
          result.invalidStructuredOutput,
        );
      }
      parentAttemptId = attempt.attemptId;

      if (result.outcome === 'completed' && result.report !== undefined) {
        attempts.push({
          attemptId: attempt.attemptId,
          profile: plan.profile,
          kind: attemptKind,
          outcome: result.outcome,
          reason: 'completed with a validated structured result',
        });
        return { kind: 'success', result, plan, attempts };
      }

      const failureReason = result.failureReason ?? `outcome ${result.outcome}`;
      attempts.push({
        attemptId: attempt.attemptId,
        profile: plan.profile,
        kind: attemptKind,
        outcome: result.outcome,
        reason: failureReason,
      });
      lastFailure = { result, plan };

      // Bounded structured-output correction retry (same profile).
      if (
        result.error?.code === 'structured_output_invalid' &&
        runner.supportsStructuredOutputCorrection === true &&
        correctionRetries < MAX_CORRECTION_RETRIES
      ) {
        correctionRetries += 1;
        correction = {
          previousOutput: result.invalidStructuredOutput ?? '',
          problems: failureReason,
        };
        continue;
      }
      correction = undefined;

      // Bounded transient transport retry (same profile, backoff + jitter).
      const transient = transientRetryEligible(operation, result.error, transportRetries);
      if (transient.eligible) {
        transportRetries += 1;
        await backoff(retryBackoffMs(transportRetries - 1));
        continue;
      }

      // This candidate is done; decide whether the NEXT candidate may run.
      const decision = fallbackEligible(operation, result.outcome, result.error);
      if (!decision.eligible) {
        appendRunEvent(deps.workspace, runId, {
          at: clock().toISOString(),
          type: 'fallback-stopped',
          profile: plan.profile,
          reason: decision.reason,
        });
        return { kind: 'failure', result, plan, attempts };
      }
      break;
    }
  }

  const last = lastFailure as { result: StageGenerationResult; plan: RunnerSelectionPlan };
  return { kind: 'failure', result: last.result, plan: last.plan, attempts };
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

  // Capability-driven selection (v0.6): refused before ANY invocation.
  const operation = request.intent === 'refine' ? 'stage-refinement' : 'stage-generation';
  const selection = selectRunner(deps.registry, config, {
    operation,
    ...(request.runnerName !== undefined ? { explicitProfile: request.runnerName } : {}),
  });
  if (!selection.ok) {
    return {
      kind: 'selection-failed',
      exitCode: EXIT_CODES.usageError,
      failure: selection.failure,
    };
  }
  const plan = selection.plan;
  const runner = deps.registry.get(plan.profile);
  const profileConfig = deps.registry.getProfile(plan.profile).config;

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
  const candidateNote = runner.executionBoundaryNote?.('read-only');
  const promptInput = {
    specName,
    specType: spec.state.specType,
    workflowMode: spec.state.workflowMode,
    stage: request.stage,
    steering,
    documents,
    workspaceRootNote: workspaceRootNote(workspace),
    repositoryAccess: promptRepositoryAccess(plan.declaredCapabilities),
    ...(candidateNote !== undefined ? { candidateNote } : {}),
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
  const timeoutMs =
    request.timeoutMs ?? (profileConfig.runner !== 'mock' ? profileConfig.timeoutMs : 1_800_000);
  const targetFile = stageDocumentPath(workspace, specName, request.stage);

  if (request.dryRun === true) {
    // Dry-run never invokes the provider: no process print-mode run, no
    // HTTP request. (Agent CLI argv previews use read-only detection.)
    const argvPreview =
      plan.category === 'agent-cli'
        ? await authoringArgvPreview(deps, plan, prompt, toolPolicy, timeoutMs)
        : undefined;
    return {
      kind: 'dry-run',
      exitCode: EXIT_CODES.ok,
      plan: {
        specName,
        stage: request.stage,
        intent: request.intent,
        runner: plan.profile,
        toolPolicy,
        targetFile,
        timeoutMs,
        promptVersion: PROMPT_CONTRACT_VERSION,
        prompt,
        ...(argvPreview !== undefined ? { argvPreview } : {}),
        runnerPlan: plan,
        dataBoundary: {
          ...(plan.endpoint !== undefined ? { endpoint: plan.endpoint } : {}),
          networkBacked: plan.networkBacked,
          networkRequestWillOccur: plan.category === 'model-api',
          model: request.model ?? plan.model,
          documents: includedDocumentPaths(specName, steering, documents),
          inputCharacters: prompt.length,
        },
        warnings: gate.warnings,
      },
    };
  }

  // Preserve the v0.3 behavior when no fallback chain is configured: an
  // unavailable runner is reported without creating a run. With a chain,
  // availability problems surface as recorded attempts instead.
  if (plan.fallbackChain.length === 0) {
    const detection = await runner.detect({ workspaceRoot: workspace.rootDir, probeCapabilities: true });
    if (detection.status !== 'available') {
      return {
        kind: 'runner-unavailable',
        exitCode: EXIT_CODES.runnerUnavailable,
        detection,
      };
    }
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
    runner: plan.profile,
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
        runner: plan.profile,
        implementation: plan.runner,
        category: plan.category,
        intent: request.intent,
        stage: request.stage,
        toolPolicy,
        timeoutMs,
        model: request.model ?? plan.model,
        networkBacked: plan.networkBacked,
        fallbackChain: plan.fallbackChain,
        promptVersion: PROMPT_CONTRACT_VERSION,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
      },
      null,
      2,
    )}\n`,
  );
  appendRunEvent(workspace, runId, { at: createdAt, type: 'runner-start', runner: plan.profile });

  const loop = await runAuthoringAttempts(
    deps,
    request,
    runId,
    plan,
    {
      specName,
      stage: request.stage,
      intent: request.intent,
      prompt,
      promptVersion: PROMPT_CONTRACT_VERSION,
      toolPolicy,
    },
    timeoutMs,
    clock,
  );
  const result = loop.result;
  const finalPlan = loop.plan;

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
        profile: finalPlan.profile,
        attempts: loop.attempts,
      },
      null,
      2,
    )}\n`,
  );
  const finishedAt = clock().toISOString();
  appendRunEvent(workspace, runId, { at: finishedAt, type: 'runner-finished', outcome: result.outcome });

  if (loop.kind === 'failure' || result.report === undefined) {
    updateRunRecord(workspace, runId, {
      runner: finalPlan.profile,
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
      attempts: loop.attempts,
      profile: finalPlan.profile,
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
      runner: finalPlan.profile,
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
      attempts: loop.attempts,
      profile: finalPlan.profile,
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
    runner: finalPlan.profile,
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
    attempts: loop.attempts,
    profile: finalPlan.profile,
    runnerPlan: finalPlan,
  };
}
