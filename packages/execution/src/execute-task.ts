import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MarkdownDocument, taskFingerprint, tryTaskPlanHashOfFile } from '@specbridge/compat-kiro';
import type {
  AgentConfig,
  EvidenceStatus,
  ExecutionOutcome,
  SpecWorkflowState,
  WorkspaceInfo,
} from '@specbridge/core';
import {
  EXIT_CODES,
  TASK_RUNNER_REPORT_JSON_SCHEMA,
  exitCodeForOutcome,
  readSpecState,
  stateStage,
} from '@specbridge/core';
import type {
  RunnerRegistry,
  RunnerSelectionPlan,
  TaskExecutionResult,
} from '@specbridge/runners';
import {
  buildClaudeInvocation,
  buildCodexInvocation,
  composeNormalizedResult,
  probeClaude,
  probeCodex,
} from '@specbridge/runners';
import type { Clock } from '@specbridge/workflow';
import { evaluateWorkflow, systemClock } from '@specbridge/workflow';
import type {
  ChangedFileRecord,
  EvidenceSpecContext,
  SnapshotComparison,
  GitSnapshot,
  VerificationRunResult,
  TaskEvidenceRecord,
} from '@specbridge/evidence';
import {
  EVIDENCE_SCHEMA_VERSION,
  agentChangedFiles,
  capturePatch,
  compareProtectedHashes,
  compareSnapshots,
  captureGitSnapshot,
  evaluateEvidence,
  runVerificationCommands,
  skippedVerification,
  writeTaskEvidence,
} from '@specbridge/evidence';
import { completeTaskCheckbox } from './complete-task.js';
import {
  renderTaskHierarchy,
  repositoryObservations,
  specDocumentSections,
  steeringSections,
  workspaceRootNote,
} from './context.js';
import type { TaskPreflight } from './preflight.js';
import { preflightTaskRun } from './preflight.js';
import { createAttempt, finalizeAttempt } from './attempt-store.js';
import type { TaskPromptInput } from './prompts.js';
import { PROMPT_CONTRACT_VERSION, buildTaskExecutionPrompt } from './prompts.js';
import {
  RUN_RECORD_SCHEMA_VERSION,
  appendRunEvent,
  createRun,
  latestRunForTask,
  runDir,
  updateRunRecord,
  writeRunArtifact,
} from './run-store.js';
import type { SelectedTask } from './task-selection.js';

/**
 * Task execution orchestration.
 *
 * One approved task per run. The runner reports; SpecBridge verifies:
 * repository snapshots before/after, trusted verification commands, evidence
 * evaluation, and only then — for `verified` evidence — the surgical
 * checkbox update. Failure at any point leaves an auditable run directory
 * and an unchanged checkbox. Nothing is ever committed or rolled back.
 */

export interface TaskRunDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  registry: RunnerRegistry;
  clock?: Clock;
  idFactory?: () => string;
  signal?: AbortSignal;
  /** Progress callback (CLI status lines). */
  onProgress?: (message: string) => void;
}

/**
 * The post-run pipeline never invokes a runner, so it does not need the
 * registry. Interactive execution (v0.5) reuses it with these reduced deps;
 * every `TaskRunDeps` value remains assignable.
 */
export type FinalizeDeps = Omit<TaskRunDeps, 'registry'> & { registry?: RunnerRegistry };

export interface TaskRunRequest {
  specName: string;
  taskId?: string;
  next?: boolean;
  runnerName?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  allowDirty?: boolean;
  noVerify?: boolean;
  dryRun?: boolean;
}

export interface TaskDryRunPlan {
  specName: string;
  task: SelectedTask;
  runner: string;
  prerequisites: 'ok';
  gitClean: boolean;
  dirtyPaths: string[];
  verificationCommands: { name: string; argv: string[]; required: boolean }[];
  toolPolicy: 'implementation';
  /** Claude profiles: the configured tool list. Other runners: empty. */
  tools: string[];
  /** Claude profiles: the permission mode. Other runners: the boundary note. */
  permissionMode: string;
  timeoutMs: number;
  promptVersion: string;
  prompt: string;
  /** v0.6: capability-checked selection plan for this run. */
  runnerPlan?: RunnerSelectionPlan;
  argvPreview?: string[];
  expectedArtifacts: string[];
  warnings: string[];
}

/** Redacted argv preview for dry runs (agent CLI runners only). */
async function taskArgvPreview(
  deps: TaskRunDeps,
  preflight: TaskPreflight,
  prompt: string,
  runIdPreview: string,
): Promise<string[] | undefined> {
  const profileConfig = preflight.profileConfig;
  if (profileConfig === undefined) return undefined;
  const execution = {
    workspaceRoot: deps.workspace.rootDir,
    runDir: path.join(deps.workspace.sidecarDir, 'runs', runIdPreview),
    timeoutMs: preflight.timeoutMs,
  };
  if (profileConfig.runner === 'claude-code') {
    const probe = await probeClaude(profileConfig);
    if (!probe.found) return undefined;
    const plan = buildClaudeInvocation({
      config: profileConfig,
      probe,
      prompt,
      toolPolicy: 'implementation',
      outputJsonSchema: TASK_RUNNER_REPORT_JSON_SCHEMA,
      sessionId: '<generated-session-uuid>',
      execution,
      materializeTempFiles: false,
    });
    return [plan.executable, ...plan.argv];
  }
  if (profileConfig.runner === 'codex-cli') {
    const probe = await probeCodex(profileConfig);
    if (!probe.found) return undefined;
    const plan = buildCodexInvocation({
      config: profileConfig,
      probe,
      prompt,
      toolPolicy: 'implementation',
      outputJsonSchema: TASK_RUNNER_REPORT_JSON_SCHEMA,
      execution,
      materializeTempFiles: false,
    });
    return [plan.executable, ...plan.argv];
  }
  return undefined;
}

export interface TaskRunReport {
  runId: string;
  parentRunId?: string;
  specName: string;
  taskId: string;
  taskTitle: string;
  runner: string;
  sessionId?: string;
  resumeSupported: boolean;
  outcome: ExecutionOutcome;
  failureReason?: string;
  runnerSummary?: string;
  evidenceStatus: EvidenceStatus;
  reasons: string[];
  violations: string[];
  warnings: string[];
  changedFiles: ChangedFileRecord[];
  verification: VerificationRunResult;
  checkboxUpdated: boolean;
  evidencePath: string;
  artifactsDir: string;
  durationMs: number;
  exitCode: number;
}

export type TaskRunOutcome =
  | { kind: 'preflight-failed'; exitCode: number; preflight: TaskPreflight }
  | { kind: 'nothing-to-do'; exitCode: number; message: string }
  | { kind: 'dry-run'; exitCode: number; plan: TaskDryRunPlan }
  | { kind: 'executed'; exitCode: number; report: TaskRunReport };

/** Attempt boundary classification from the selection plan. */
export function taskAttemptBoundary(
  plan: RunnerSelectionPlan,
): 'local-process' | 'loopback-endpoint' | 'network-endpoint' | 'in-process' {
  if (plan.category === 'mock') return 'in-process';
  if (plan.category === 'model-api') {
    return plan.networkBacked ? 'network-endpoint' : 'loopback-endpoint';
  }
  return 'local-process';
}

function exitCodeForEvidence(status: EvidenceStatus, outcome: ExecutionOutcome): number {
  switch (status) {
    case 'verified':
    case 'manually-accepted':
      return EXIT_CODES.ok;
    case 'no-change':
    case 'implemented-unverified':
    case 'blocked':
      return EXIT_CODES.gateFailure;
    case 'timed-out':
    case 'cancelled':
      return EXIT_CODES.timeout;
    case 'failed':
      return exitCodeForOutcome(outcome) === EXIT_CODES.ok
        ? EXIT_CODES.runnerFailure
        : exitCodeForOutcome(outcome);
  }
}

/** The safety-boundary line embedded in the shared prompt contract. */
export function boundaryNoteFor(preflight: TaskPreflight): string {
  return (
    preflight.runner?.executionBoundaryNote?.('implementation') ??
    'Repository access is bounded by the configured runner safety boundary. Permission bypasses are never used.'
  );
}

function buildPrompt(deps: TaskRunDeps, preflight: TaskPreflight): string {
  const { workspace } = deps;
  const spec = preflight.spec;
  const state = preflight.state;
  const evaluation = preflight.evaluation;
  const task = preflight.task as SelectedTask;
  const documentStage = state?.specType === 'bugfix' ? 'bugfix' : 'requirements';
  const input: TaskPromptInput = {
    specName: spec.folder.name,
    specType: state?.specType ?? 'feature',
    workflowMode: state?.workflowMode ?? 'unknown',
    steering: steeringSections(workspace),
    documents: specDocumentSections(spec, evaluation, [documentStage, 'design']),
    taskHierarchy:
      preflight.tasksModel !== undefined ? renderTaskHierarchy(preflight.tasksModel, task.id) : '',
    taskId: task.id,
    taskTitle: task.title,
    requirementRefs: task.requirementRefs,
    repositoryObservations:
      preflight.before !== undefined
        ? repositoryObservations(workspace.rootDir, preflight.before)
        : [],
    workspaceRootNote: workspaceRootNote(workspace),
    allowedToolsNote: boundaryNoteFor(preflight),
  };
  return buildTaskExecutionPrompt(input);
}

/** Execute one approved task (or plan it with `dryRun`). */
export async function runApprovedTask(
  deps: TaskRunDeps,
  request: TaskRunRequest,
): Promise<TaskRunOutcome> {
  const clock = deps.clock ?? systemClock;
  const preflight = await preflightTaskRun(deps, {
    specName: request.specName,
    selector: {
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.next !== undefined ? { next: request.next } : {}),
    },
    ...(request.runnerName !== undefined ? { runnerName: request.runnerName } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.allowDirty !== undefined ? { allowDirty: request.allowDirty } : {}),
  });

  if (!preflight.ok) {
    const failure = preflight.failure;
    if (failure !== undefined && failure.code === 'no-open-tasks') {
      return {
        kind: 'nothing-to-do',
        exitCode: EXIT_CODES.ok,
        message: `No open required leaf task remains in "${request.specName}". Nothing to do.`,
      };
    }
    return {
      kind: 'preflight-failed',
      exitCode: preflight.failure?.exitCode ?? EXIT_CODES.usageError,
      preflight,
    };
  }

  const task = preflight.task as SelectedTask;
  const prompt = buildPrompt(deps, preflight);
  const profileConfig = preflight.profileConfig;

  if (request.dryRun === true) {
    const runIdPreview = (deps.idFactory ?? randomUUID)();
    const argvPreview = await taskArgvPreview(deps, preflight, prompt, runIdPreview);
    const artifactBase = `.specbridge/runs/${runIdPreview}`;
    return {
      kind: 'dry-run',
      exitCode: EXIT_CODES.ok,
      plan: {
        specName: preflight.spec.folder.name,
        task,
        runner: preflight.runnerName,
        prerequisites: 'ok',
        gitClean: preflight.before?.clean ?? false,
        dirtyPaths: preflight.before?.entries.map((entry) => entry.path) ?? [],
        verificationCommands: preflight.verificationCommands.map((command) => ({
          name: command.name,
          argv: [...command.argv],
          required: command.required,
        })),
        toolPolicy: 'implementation',
        tools:
          profileConfig !== undefined && profileConfig.runner === 'claude-code'
            ? [...profileConfig.tools]
            : [],
        permissionMode:
          profileConfig !== undefined && profileConfig.runner === 'claude-code'
            ? profileConfig.permissionMode
            : boundaryNoteFor(preflight),
        timeoutMs: preflight.timeoutMs,
        promptVersion: PROMPT_CONTRACT_VERSION,
        prompt,
        ...(preflight.selectionPlan !== undefined ? { runnerPlan: preflight.selectionPlan } : {}),
        ...(argvPreview !== undefined ? { argvPreview } : {}),
        expectedArtifacts: [
          `${artifactBase}/run.json`,
          `${artifactBase}/prompt.md`,
          `${artifactBase}/runner-request.json`,
          `${artifactBase}/runner-result.json`,
          `${artifactBase}/raw-stdout.log`,
          `${artifactBase}/raw-stderr.log`,
          `${artifactBase}/git-before.json`,
          `${artifactBase}/git-after.json`,
          `${artifactBase}/changed-files.json`,
          `${artifactBase}/diff.patch`,
          `${artifactBase}/events.jsonl`,
          `${artifactBase}/verification.json`,
          `${artifactBase}/evidence.json`,
          `${artifactBase}/report.json`,
        ],
        warnings: preflight.warnings,
      },
    };
  }

  // ---- Real execution -----------------------------------------------------
  const runId = (deps.idFactory ?? randomUUID)();
  const sessionId = (deps.idFactory ?? randomUUID)();
  const parent = latestRunForTask(deps.workspace, preflight.spec.folder.name, task.id);
  const createdAt = clock().toISOString();
  createRun(deps.workspace, {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    runId,
    kind: 'task-execution',
    specName: preflight.spec.folder.name,
    taskId: task.id,
    runner: preflight.runnerName,
    sessionId,
    ...(parent !== undefined ? { parentRunId: parent.runId } : {}),
    createdAt,
    resumeSupported: false,
    promptVersion: PROMPT_CONTRACT_VERSION,
    warnings: preflight.warnings,
  });
  writeRunArtifact(deps.workspace, runId, 'prompt.md', prompt);
  writeRunArtifact(
    deps.workspace,
    runId,
    'runner-request.json',
    `${JSON.stringify(
      {
        runner: preflight.runnerName,
        taskId: task.id,
        toolPolicy: 'implementation',
        timeoutMs: preflight.timeoutMs,
        promptVersion: PROMPT_CONTRACT_VERSION,
        sessionId,
        allowDirty: preflight.allowDirty,
        noVerify: request.noVerify === true,
      },
      null,
      2,
    )}\n`,
  );
  appendRunEvent(deps.workspace, runId, { at: createdAt, type: 'runner-start', task: task.id });
  deps.onProgress?.(`Executing task ${task.id} with ${preflight.runnerName}…`);

  const runner = preflight.runner;
  if (runner === undefined) throw new Error('preflight.ok implies runner');
  const selectionPlan = preflight.selectionPlan;
  const attempt =
    selectionPlan !== undefined
      ? createAttempt(deps.workspace, {
          runId,
          profile: selectionPlan.profile,
          runner: selectionPlan.runner,
          category: selectionPlan.category,
          supportLevel: selectionPlan.supportLevel,
          operation: 'task-execution',
          attemptKind: 'initial',
          boundary: taskAttemptBoundary(selectionPlan),
          model: request.model ?? selectionPlan.model,
          capabilitySnapshot: preflight.detection?.capabilitySet ?? selectionPlan.declaredCapabilities,
          createdAt,
        })
      : undefined;
  const result = await runner.executeTask(
    {
      specName: preflight.spec.folder.name,
      taskId: task.id,
      prompt,
      promptVersion: PROMPT_CONTRACT_VERSION,
      toolPolicy: 'implementation',
      sessionId,
    },
    {
      workspaceRoot: deps.workspace.rootDir,
      runDir: runDir(deps.workspace, runId),
      timeoutMs: preflight.timeoutMs,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
      ...(request.maxBudgetUsd !== undefined ? { maxBudgetUsd: request.maxBudgetUsd } : {}),
    },
  );
  if (attempt !== undefined && selectionPlan !== undefined) {
    finalizeAttempt(deps.workspace, attempt, {
      finishedAt: clock().toISOString(),
      outcome: result.outcome,
      durationMs: result.durationMs,
      result,
      normalized: composeNormalizedResult(
        {
          profile: selectionPlan.profile,
          category: selectionPlan.category,
          supportLevel: selectionPlan.supportLevel,
          operation: 'task-execution',
        },
        result,
      ),
    });
  }

  const report = await finalizeTaskRun(deps, {
    runId,
    ...(parent !== undefined ? { parentRunId: parent.runId } : {}),
    specName: preflight.spec.folder.name,
    task,
    runnerName: preflight.runnerName,
    before: preflight.before as GitSnapshot,
    allowDirty: preflight.allowDirty,
    noVerify: request.noVerify === true,
    preflightWarnings: preflight.warnings,
    result,
  });
  return { kind: 'executed', exitCode: report.exitCode, report };
}

export interface FinalizeContext {
  runId: string;
  parentRunId?: string;
  specName: string;
  task: SelectedTask;
  runnerName: string;
  /** Attribution baseline (for a resume: the ORIGINAL run's pre-state). */
  before: GitSnapshot;
  /**
   * Start of THIS runner session. Protected-path and HEAD-motion checks use
   * this so legitimate between-run edits (e.g. the user fixing config.json)
   * are not blamed on the session. Defaults to `before`.
   */
  sessionBefore?: GitSnapshot;
  allowDirty: boolean;
  noVerify: boolean;
  preflightWarnings: string[];
  result: TaskExecutionResult;
}

/** Shared post-run pipeline for task execution, resume, and interactive runs. */
export async function finalizeTaskRun(
  deps: FinalizeDeps,
  context: FinalizeContext,
): Promise<TaskRunReport> {
  const clock = deps.clock ?? systemClock;
  const { workspace, config } = deps;
  const { runId, task, result } = context;

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
        resumeSupported: result.resumeSupported,
        durationMs: result.durationMs,
        warnings: result.warnings,
      },
      null,
      2,
    )}\n`,
  );
  appendRunEvent(workspace, runId, {
    at: clock().toISOString(),
    type: 'runner-finished',
    outcome: result.outcome,
  });

  // Actual repository state after the run.
  const after = await captureGitSnapshot(workspace.rootDir, { clock: () => clock() });
  writeRunArtifact(workspace, runId, 'git-before.json', `${JSON.stringify(context.before, null, 2)}\n`);
  writeRunArtifact(workspace, runId, 'git-after.json', `${JSON.stringify(after, null, 2)}\n`);
  const comparison = compareSnapshots(context.before, after);

  // Protected paths and HEAD motion are judged against THIS session's start.
  const sessionBefore = context.sessionBefore ?? context.before;
  if (context.sessionBefore !== undefined) {
    comparison.protectedViolations = compareProtectedHashes(
      sessionBefore.protectedHashes,
      after.protectedHashes,
    );
    comparison.headMoved = sessionBefore.head !== after.head;
  }

  // Additional configured protected paths.
  applyConfiguredProtectedPaths(config, comparison);
  writeRunArtifact(
    workspace,
    runId,
    'changed-files.json',
    `${JSON.stringify(
      { changedFiles: comparison.changedFiles, ambiguousPaths: comparison.ambiguousPaths },
      null,
      2,
    )}\n`,
  );

  const agentChanges = agentChangedFiles(comparison);
  if (config.execution.capturePatch && agentChanges.length > 0) {
    const patch = await capturePatch(workspace.rootDir, config.execution.maximumPatchBytes);
    if (patch.captured && patch.patch !== undefined) {
      writeRunArtifact(workspace, runId, 'diff.patch', patch.patch);
    } else if (patch.note !== undefined) {
      comparison.warnings.push(patch.note);
    }
  }

  // Approvals must still hold and the selected task must still exist.
  const stateNow = readSpecState(workspace, context.specName).state;
  const approvalsStillValid =
    stateNow !== undefined && evaluateWorkflow(workspace, stateNow).health === 'ok';
  const taskStillExists = taskLineIntact(workspace, context.specName, task);

  // Trusted verification (only after a completed implementation).
  let verification: VerificationRunResult;
  if (context.noVerify) {
    verification = skippedVerification(config.verification.commands);
  } else if (result.outcome === 'completed' && agentChanges.length > 0) {
    deps.onProgress?.('Running trusted verification commands…');
    verification = await runVerificationCommands(
      workspace.rootDir,
      config.verification.commands,
      {
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        onCommandFinished: (commandResult, stdout, stderr) => {
          writeRunArtifact(
            workspace,
            runId,
            `verification-${commandResult.name}.stdout.log`,
            stdout,
          );
          writeRunArtifact(
            workspace,
            runId,
            `verification-${commandResult.name}.stderr.log`,
            stderr,
          );
        },
      },
    );
  } else {
    verification = {
      ran: false,
      skipped: false,
      configured: config.verification.commands.length > 0,
      commands: [],
      requiredFailed: [],
      optionalFailed: [],
      passed: false,
    };
  }
  writeRunArtifact(workspace, runId, 'verification.json', `${JSON.stringify(verification, null, 2)}\n`);

  // Deterministic evidence evaluation.
  const evaluation = evaluateEvidence({
    runnerOutcome: result.outcome,
    reportValidated: result.report !== undefined,
    ...(result.report !== undefined ? { report: result.report } : {}),
    before: context.before,
    after,
    comparison,
    verification,
    approvalsStillValid,
    taskStillExists,
    allowDirty: context.allowDirty,
  });

  // Verified evidence → surgical checkbox update (fail-safe on races).
  let checkboxUpdated = false;
  let evidenceStatus = evaluation.status;
  if (evidenceStatus === 'verified') {
    try {
      const update = completeTaskCheckbox(
        workspace,
        context.specName,
        { line: task.line, rawLineText: task.rawLineText },
        clock,
      );
      checkboxUpdated = true;
      writeRunArtifact(
        workspace,
        runId,
        'checkbox-update.json',
        `${JSON.stringify(update, null, 2)}\n`,
      );
    } catch (cause) {
      evidenceStatus = 'implemented-unverified';
      evaluation.warnings.push(
        `the checkbox update failed safely: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  const specContext = buildEvidenceSpecContext(workspace, context.specName, stateNow, task);
  const evidenceRecord: TaskEvidenceRecord = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId,
    ...(context.parentRunId !== undefined ? { parentRunId: context.parentRunId } : {}),
    specName: context.specName,
    taskId: task.id,
    status: evidenceStatus,
    specContext,
    runner: context.runnerName,
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    repository: {
      ...(context.before.head !== undefined ? { headBefore: context.before.head } : {}),
      ...(after.head !== undefined ? { headAfter: after.head } : {}),
      ...(context.before.branch !== undefined ? { branch: context.before.branch } : {}),
      dirtyBefore: !context.before.clean,
      dirtyAfter: !after.clean,
    },
    changedFiles: comparison.changedFiles,
    verificationCommands: verification.commands.map((command) => ({
      name: command.name,
      argv: command.argv,
      required: command.required,
      exitCode: command.exitCode ?? null,
      durationMs: command.durationMs,
      passed: command.passed,
    })),
    verificationSkipped: verification.skipped,
    runnerClaims: {
      ...(result.report !== undefined ? { outcome: result.report.outcome } : {}),
      ...(result.report !== undefined ? { summary: result.report.summary } : {}),
      changedFiles: result.report?.changedFiles ?? [],
      commandsReported: result.report?.commandsReported ?? [],
      testsReported: (result.report?.testsReported ?? []).map((test) => ({
        name: test.name,
        status: test.status,
      })),
    },
    violations: evaluation.violations,
    warnings: [...evaluation.warnings],
    evaluatedAt: clock().toISOString(),
  };
  const evidencePath = writeTaskEvidence(workspace, evidenceRecord);
  writeRunArtifact(workspace, runId, 'evidence.json', `${JSON.stringify(evidenceRecord, null, 2)}\n`);

  const finishedAt = clock().toISOString();
  updateRunRecord(workspace, runId, {
    outcome: result.outcome,
    evidenceStatus,
    finishedAt,
    durationMs: result.durationMs,
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    resumeSupported: result.resumeSupported,
  });

  const warnings = [...context.preflightWarnings, ...result.warnings, ...evaluation.warnings];
  const report: TaskRunReport = {
    runId,
    ...(context.parentRunId !== undefined ? { parentRunId: context.parentRunId } : {}),
    specName: context.specName,
    taskId: task.id,
    taskTitle: task.title,
    runner: context.runnerName,
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    resumeSupported: result.resumeSupported,
    outcome: result.outcome,
    ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
    ...(result.report?.summary !== undefined ? { runnerSummary: result.report.summary } : {}),
    evidenceStatus,
    reasons: evaluation.reasons,
    violations: evaluation.violations,
    warnings,
    changedFiles: comparison.changedFiles,
    verification,
    checkboxUpdated,
    evidencePath,
    artifactsDir: runDir(workspace, runId),
    durationMs: result.durationMs,
    exitCode: exitCodeForEvidence(evidenceStatus, result.outcome),
  };
  writeRunArtifact(
    workspace,
    runId,
    'report.json',
    `${JSON.stringify({ schema: 'specbridge.task-run/1', report }, null, 2)}\n`,
  );
  return report;
}

/**
 * Spec-and-task identity captured alongside evidence (v0.4). Verification
 * later compares these values with the then-current approved state to decide
 * deterministically whether the evidence is still fresh.
 */
export function buildEvidenceSpecContext(
  workspace: WorkspaceInfo,
  specName: string,
  state: SpecWorkflowState | undefined,
  task: Pick<SelectedTask, 'id' | 'title' | 'requirementRefs' | 'rawLineText'>,
): EvidenceSpecContext {
  const specContext: EvidenceSpecContext = {
    taskFingerprint: taskFingerprint({
      id: task.id,
      title: task.title,
      requirementRefs: task.requirementRefs,
    }),
    taskText: task.rawLineText,
  };
  if (state === undefined) return specContext;

  const documentStage = stateStage(state, state.specType === 'bugfix' ? 'bugfix' : 'requirements');
  if (documentStage?.status === 'approved' && documentStage.approvedHash !== null) {
    specContext.documentHash = documentStage.approvedHash;
  }
  const designStage = stateStage(state, 'design');
  if (designStage?.status === 'approved' && designStage.approvedHash !== null) {
    specContext.designHash = designStage.approvedHash;
  }
  const tasksStage = stateStage(state, 'tasks');
  if (tasksStage?.status === 'approved') {
    // Prefer the recorded plan hash; fall back to hashing the current file
    // (identical whenever the approval is effective, which evidence
    // evaluation has already checked at this point).
    const planHash =
      typeof tasksStage.approvedPlanHash === 'string'
        ? tasksStage.approvedPlanHash
        : tryTaskPlanHashOfFile(path.join(workspace.kiroDir, 'specs', specName, 'tasks.md'));
    if (planHash !== undefined) specContext.tasksPlanHash = planHash;
  }
  return specContext;
}

function applyConfiguredProtectedPaths(config: AgentConfig, comparison: SnapshotComparison): void {
  const prefixes = config.execution.protectedPaths.map((prefix) =>
    prefix.endsWith('/') ? prefix : `${prefix}/`,
  );
  if (prefixes.length === 0) return;
  for (const file of comparison.changedFiles) {
    if (!file.modifiedDuringRun) continue;
    const posixPath = file.path;
    for (const prefix of prefixes) {
      if (posixPath === prefix.slice(0, -1) || posixPath.startsWith(prefix)) {
        comparison.protectedViolations.push({
          path: posixPath,
          kind: file.changeType === 'deleted' ? 'deleted' : file.changeType,
        });
      }
    }
  }
}

function taskLineIntact(
  workspace: WorkspaceInfo,
  specName: string,
  task: SelectedTask,
): boolean {
  try {
    const document = MarkdownDocument.load(
      path.join(workspace.kiroDir, 'specs', specName, 'tasks.md'),
    );
    if (task.line >= document.lineCount) return false;
    return document.lineAt(task.line).text === task.rawLineText;
  } catch {
    return false;
  }
}

export interface BatchRunSummary {
  attempted: TaskRunReport[];
  stoppedBecause?: string;
  exitCode: number;
}

/** Sequential `--all`: one task per run, deterministic order, stop on trouble. */
export async function runAllOpenTasks(
  deps: TaskRunDeps,
  request: Omit<TaskRunRequest, 'taskId' | 'next' | 'all' | 'dryRun'>,
): Promise<BatchRunSummary> {
  const attempted: TaskRunReport[] = [];
  const stopOnUnverified = deps.config.execution.stopOnUnverifiedTask;

  for (;;) {
    // Later tasks in a batch inevitably run over the uncommitted (verified)
    // changes of earlier tasks — SpecBridge never commits. The hash-exact
    // baseline keeps attribution precise for every subsequent task.
    const allowDirty = request.allowDirty === true || attempted.length > 0;
    const outcome = await runApprovedTask(deps, { ...request, allowDirty, next: true });
    if (outcome.kind === 'nothing-to-do') {
      return { attempted, exitCode: attempted.length === 0 ? EXIT_CODES.ok : summaryExit(attempted) };
    }
    if (outcome.kind === 'preflight-failed') {
      return {
        attempted,
        stoppedBecause: outcome.preflight.failure?.message ?? 'preflight failed',
        exitCode: outcome.exitCode,
      };
    }
    if (outcome.kind === 'dry-run') {
      // Unreachable (dryRun is excluded from the request type); defensive.
      return { attempted, exitCode: EXIT_CODES.ok };
    }
    attempted.push(outcome.report);
    const status = outcome.report.evidenceStatus;
    if (status === 'verified') continue;
    if (status === 'implemented-unverified' && !stopOnUnverified) {
      continue;
    }
    return {
      attempted,
      stoppedBecause: `task ${outcome.report.taskId} ended with evidence status "${status}"`,
      exitCode: outcome.exitCode,
    };
  }
}

function summaryExit(attempted: TaskRunReport[]): number {
  return attempted.every((report) => report.evidenceStatus === 'verified')
    ? EXIT_CODES.ok
    : EXIT_CODES.gateFailure;
}
