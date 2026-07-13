import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MarkdownDocument, findTask, parseTasks, taskFingerprint } from '@specbridge/compat-kiro';
import type {
  AgentConfig,
  EvidenceStatus,
  InteractiveLifecycleStatus,
  WorkspaceInfo,
} from '@specbridge/core';
import { readSpecState, taskRunnerReportSchema } from '@specbridge/core';
import type { GitSnapshot } from '@specbridge/evidence';
import { agentChangedFiles, captureGitSnapshot, compareSnapshots } from '@specbridge/evidence';
import type { TaskExecutionResult } from '@specbridge/runners';
import type { Clock } from '@specbridge/workflow';
import { evaluateWorkflow, systemClock } from '@specbridge/workflow';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { TaskRunReport } from './execute-task.js';
import { buildEvidenceSpecContext, finalizeTaskRun } from './execute-task.js';
import {
  acquireInteractiveLock,
  readInteractiveLock,
  releaseInteractiveLock,
} from './interactive-lock.js';
import { policyRelevantDirtyPaths } from './preflight.js';
import {
  RUN_RECORD_SCHEMA_VERSION,
  appendRunEvent,
  createRun,
  latestRunForTask,
  readRunArtifactJson,
  readRunRecord,
  runDir,
  updateRunRecord,
  writeRunArtifact,
} from './run-store.js';
import type { RunRecord } from './run-store.js';
import { renderTaskHierarchy, specDocumentSections, steeringSections } from './context.js';
import type { SelectedTask } from './task-selection.js';
import { openPredecessors, selectTask } from './task-selection.js';

/**
 * Interactive task execution (v0.5).
 *
 * The current host agent session — not a nested runner process — implements
 * the task. SpecBridge brackets that work with the exact same machinery the
 * v0.3 runner path uses: pre-run Git snapshot, trusted verification
 * commands, deterministic evidence evaluation, append-only evidence, and the
 * verified-only surgical checkbox update. What the host agent *says* it did
 * is recorded as a claim and never treated as proof.
 *
 * Lifecycle: `beginInteractiveTask` acquires the repository-local lock,
 * snapshots the repository, and returns bounded context plus explicit agent
 * instructions. The host edits source files. `completeInteractiveTask`
 * captures the post-state and runs the shared finalize pipeline.
 * `abortInteractiveTask` closes the run without touching source changes.
 * No step ever invokes a model or spawns an agent process.
 */

export const INTERACTIVE_RUNNER_NAME = 'interactive';

export interface InteractiveDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  clock?: Clock;
  idFactory?: () => string;
  signal?: AbortSignal;
  /** Host label recorded on run records (default "mcp"). */
  host?: string;
}

/** Instructions returned to the host agent, verbatim. */
export const INTERACTIVE_AGENT_INSTRUCTIONS: readonly string[] = [
  'Implement only the selected task.',
  'Do not edit `.kiro`.',
  'Do not edit `.specbridge`.',
  'Do not change task checkboxes.',
  'Do not commit.',
  'Do not push.',
  'Do not reset user changes.',
  'Stop and report blockers when information is missing.',
  'Call `task_complete` only after source changes are ready.',
  'Call `task_abort` when the task cannot continue.',
];

export type InteractiveBlockCode =
  | 'unmanaged-spec'
  | 'stages-not-approved'
  | 'stale-approval'
  | 'tasks-missing'
  | 'task-not-found'
  | 'task-already-complete'
  | 'task-not-leaf'
  | 'no-open-tasks'
  | 'git-unavailable'
  | 'dirty-working-tree'
  | 'lock-held'
  | 'run-not-found'
  | 'run-state-invalid'
  | 'lock-invalid'
  | 'task-changed';

export interface InteractiveBlocked {
  kind: 'blocked';
  code: InteractiveBlockCode;
  message: string;
  remediation: string[];
  details?: Record<string, unknown>;
}

export interface InteractiveRunStart {
  kind: 'started';
  runId: string;
  specName: string;
  task: SelectedTask;
  /** Bounded, deterministic context (steering + approved documents + tasks). */
  contextMarkdown: string;
  boundaries: string[];
  protectedPaths: string[];
  verificationCommands: { name: string; argv: string[]; required: boolean }[];
  instructions: string[];
  allowDirty: boolean;
  runVerificationOnComplete: boolean;
  warnings: string[];
}

export interface BeginInteractiveRequest {
  specName: string;
  taskId?: string;
  allowDirty?: boolean;
  runVerificationOnComplete?: boolean;
}

interface StoredInteractiveState {
  before: GitSnapshot;
  task: SelectedTask;
  taskFingerprint: string;
  allowDirty: boolean;
  runVerificationOnComplete: boolean;
}

function blocked(
  code: InteractiveBlockCode,
  message: string,
  remediation: string[] = [],
  details?: Record<string, unknown>,
): InteractiveBlocked {
  return { kind: 'blocked', code, message, remediation, ...(details !== undefined ? { details } : {}) };
}

function buildInteractiveContext(
  deps: InteractiveDeps,
  specName: string,
  task: SelectedTask,
): string {
  const folder = requireSpec(deps.workspace, specName);
  const spec = analyzeSpec(deps.workspace, folder);
  const state = spec.state;
  const evaluation = state !== undefined ? evaluateWorkflow(deps.workspace, state) : undefined;
  const documentStage = state?.specType === 'bugfix' ? 'bugfix' : 'requirements';

  const lines: string[] = [];
  lines.push(`# Interactive task context: ${specName} — task ${task.id}`);
  lines.push('');
  lines.push(`Selected task: ${task.id}. ${task.title}`);
  if (task.requirementRefs.length > 0) {
    lines.push(`Requirement references: ${task.requirementRefs.join(', ')}`);
  }
  lines.push('');
  for (const steering of steeringSections(deps.workspace)) {
    lines.push(`## Steering: ${steering.name}`);
    lines.push('');
    lines.push(steering.body.trimEnd());
    lines.push('');
  }
  for (const section of specDocumentSections(spec, evaluation, [documentStage, 'design'])) {
    lines.push(`## ${section.fileName}${section.approved ? ' (approved)' : ''}`);
    lines.push('');
    lines.push(section.content.trimEnd());
    lines.push('');
  }
  if (spec.tasks !== undefined) {
    lines.push('## Task plan (selected task marked)');
    lines.push('');
    lines.push(renderTaskHierarchy(spec.tasks, task.id));
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** Begin an interactive run. Validates every precondition before locking. */
export async function beginInteractiveTask(
  deps: InteractiveDeps,
  request: BeginInteractiveRequest,
): Promise<InteractiveBlocked | InteractiveRunStart> {
  const clock = deps.clock ?? systemClock;
  const { workspace, config } = deps;
  const allowDirty = request.allowDirty === true;
  const runVerificationOnComplete = request.runVerificationOnComplete !== false;
  const warnings: string[] = [];

  const folder = requireSpec(workspace, request.specName);
  const spec = analyzeSpec(workspace, folder);
  const specName = folder.name;

  // Approvals: recorded, fresh, complete — same gates as runner execution.
  if (spec.state === undefined) {
    return blocked(
      'unmanaged-spec',
      `Spec "${specName}" has no SpecBridge workflow state; tasks can only be executed for specs with approved stages.`,
      [`Approve the stages first (human action): specbridge spec approve ${specName} --stage <stage>`],
    );
  }
  const evaluation = evaluateWorkflow(workspace, spec.state);
  if (evaluation.health === 'stale') {
    const stale = [...evaluation.staleStages, ...evaluation.invalidatedStages];
    return blocked(
      'stale-approval',
      `Cannot execute tasks for "${specName}": approved stage(s) changed after approval (${stale.join(', ')}).`,
      [
        `Review the changes and re-approve (human action): specbridge spec approve ${specName} --stage ${stale[0] ?? '<stage>'}`,
      ],
    );
  }
  if (evaluation.effectiveStatus !== 'READY_FOR_IMPLEMENTATION') {
    const unapproved = evaluation.stages
      .filter((stage) => stage.effective !== 'approved')
      .map((stage) => stage.stage);
    return blocked(
      'stages-not-approved',
      `Cannot execute tasks for "${specName}": not every stage is approved yet (missing: ${unapproved.join(', ')}).`,
      [`Author and approve the missing stage(s) first.`],
    );
  }

  // Task selection (explicit id or next deterministic executable leaf).
  const tasksDocument = spec.documents.tasks;
  const tasksModel = spec.tasks;
  if (tasksDocument === undefined || tasksModel === undefined) {
    return blocked('tasks-missing', `Spec "${specName}" has no readable tasks.md.`, []);
  }
  const selection = selectTask(tasksModel, tasksDocument, {
    ...(request.taskId !== undefined ? { taskId: request.taskId } : { next: true }),
  });
  if (!selection.ok) {
    return blocked(selection.reason, selection.message, []);
  }
  const task = selection.task;
  if (task.optional) warnings.push(`Task ${task.id} is optional; it was selected explicitly.`);
  if (task.state === 'in-progress') warnings.push(`Task ${task.id} is marked in-progress ([-]); continuing it.`);
  const predecessors = openPredecessors(tasksModel, tasksDocument, task);
  if (request.taskId !== undefined && predecessors.length > 0) {
    warnings.push(
      `${predecessors.length} earlier task(s) are still open (next would be ${predecessors[0]?.id}); running ${task.id} out of order.`,
    );
  }

  // Lock first, snapshot second: the baseline must be captured while no
  // other interactive run can start.
  const runId = (deps.idFactory ?? randomUUID)();
  const acquisition = acquireInteractiveLock(workspace, {
    runId,
    specName,
    taskId: task.id,
    clock: () => clock(),
  });
  if (!acquisition.acquired) {
    return blocked(
      'lock-held',
      `Cannot begin: ${acquisition.problem}.`,
      [
        'Finish or abort the active run first (task_complete / task_abort),',
        'or diagnose a crashed run with: specbridge run recover-lock',
      ],
      acquisition.existing !== undefined ? { activeRun: acquisition.existing } : undefined,
    );
  }

  try {
    const before = await captureGitSnapshot(workspace.rootDir, { clock: () => clock() });
    if (!before.gitAvailable) {
      releaseInteractiveLock(workspace, runId);
      return blocked(
        'git-unavailable',
        'Interactive task execution needs a git repository: SpecBridge captures the repository state before and after every run.',
        ['Initialize one with "git init" and commit the current state.'],
      );
    }
    const policyDirtyPaths = policyRelevantDirtyPaths(before, evaluation);
    if (policyDirtyPaths.length > 0 && config.execution.requireCleanWorkingTree && !allowDirty) {
      releaseInteractiveLock(workspace, runId);
      return blocked(
        'dirty-working-tree',
        `The working tree has uncommitted changes (${policyDirtyPaths.length} path(s)); task execution requires a clean tree.`,
        [
          'Commit or stash the existing changes,',
          'or begin with allowDirty: true (pre-existing changes are baselined and never attributed to the task).',
        ],
        { dirtyPaths: policyDirtyPaths.slice(0, 100) },
      );
    }
    if (!before.clean) {
      warnings.push(
        `The working tree already has ${before.entries.length} modified path(s); they were baselined and will not be attributed to the task.`,
      );
    }

    const createdAt = clock().toISOString();
    const parent = latestRunForTask(workspace, specName, task.id);
    createRun(workspace, {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId,
      kind: 'interactive-execution',
      specName,
      taskId: task.id,
      runner: INTERACTIVE_RUNNER_NAME,
      ...(parent !== undefined ? { parentRunId: parent.runId } : {}),
      createdAt,
      resumeSupported: false,
      warnings,
      lifecycleStatus: 'AWAITING_AGENT_CHANGES',
      host: deps.host ?? 'mcp',
    });

    const fingerprint = taskFingerprint({
      id: task.id,
      title: task.title,
      requirementRefs: task.requirementRefs,
    });
    const stored: StoredInteractiveState = {
      before,
      task,
      taskFingerprint: fingerprint,
      allowDirty,
      runVerificationOnComplete,
    };
    writeRunArtifact(workspace, runId, 'git-before.json', `${JSON.stringify(before, null, 2)}\n`);
    writeRunArtifact(
      workspace,
      runId,
      'interactive-state.json',
      `${JSON.stringify(stored, null, 2)}\n`,
    );
    writeRunArtifact(
      workspace,
      runId,
      'spec-context-hashes.json',
      `${JSON.stringify(buildEvidenceSpecContext(workspace, specName, spec.state, task), null, 2)}\n`,
    );
    const contextMarkdown = buildInteractiveContext(deps, specName, task);
    writeRunArtifact(workspace, runId, 'context.md', contextMarkdown);
    appendRunEvent(workspace, runId, {
      at: createdAt,
      type: 'interactive-begin',
      task: task.id,
      allowDirty,
    });

    const protectedPaths = [
      '.kiro/',
      '.specbridge/',
      '.git/',
      ...config.execution.protectedPaths.map((prefix) => (prefix.endsWith('/') ? prefix : `${prefix}/`)),
    ];

    return {
      kind: 'started',
      runId,
      specName,
      task,
      contextMarkdown,
      boundaries: [
        `Repository root: the project root this server serves. All changes must stay inside it.`,
        `Implement exactly one task: ${task.id}. ${task.title}`,
        `Protected paths (any modification fails the run): ${protectedPaths.join(', ')}`,
        'The task checkbox is updated by SpecBridge alone, and only for verified evidence.',
      ],
      protectedPaths,
      verificationCommands: config.verification.commands.map((command) => ({
        name: command.name,
        argv: [...command.argv],
        required: command.required,
      })),
      instructions: [...INTERACTIVE_AGENT_INSTRUCTIONS],
      allowDirty,
      runVerificationOnComplete,
      warnings,
    };
  } catch (cause) {
    // Any failure after acquisition must not leave a dangling lock.
    releaseInteractiveLock(workspace, runId);
    throw cause;
  }
}

export interface CompleteInteractiveRequest {
  runId: string;
  summary: string;
  /** Overrides the begin-time runVerificationOnComplete default. */
  runVerification?: boolean;
  reportedChangedFiles?: string[];
  reportedTests?: { name: string; status: 'passed' | 'failed' | 'skipped' }[];
  reportedRisks?: string[];
}

/** Interactive outcome vocabulary (documented in the MCP tool contract). */
export type InteractiveOutcomeLabel =
  | 'verified'
  | 'implemented-unverified'
  | 'failed'
  | 'blocked'
  | 'no-change'
  | 'protected-path-violation'
  | 'repository-diverged';

export interface InteractiveCompleted {
  kind: 'finalized';
  outcome: InteractiveOutcomeLabel;
  report: TaskRunReport;
  /** True when this call finalized the run; false for idempotent repeats. */
  finalizedNow: boolean;
}

export function classifyInteractiveOutcome(report: TaskRunReport): InteractiveOutcomeLabel {
  const violations = report.violations;
  if (violations.some((violation) => violation.startsWith('protected path'))) {
    return 'protected-path-violation';
  }
  if (
    violations.some(
      (violation) =>
        violation.startsWith('HEAD moved') ||
        violation.includes('stale approval') ||
        violation.includes('no longer exists in tasks.md'),
    )
  ) {
    return 'repository-diverged';
  }
  const status: EvidenceStatus = report.evidenceStatus;
  switch (status) {
    case 'verified':
    case 'manually-accepted':
      return 'verified';
    case 'implemented-unverified':
      return 'implemented-unverified';
    case 'no-change':
      return 'no-change';
    case 'blocked':
      return 'blocked';
    default:
      return 'failed';
  }
}

function loadInteractiveRun(
  workspace: WorkspaceInfo,
  runId: string,
):
  | { ok: true; record: RunRecord; state: StoredInteractiveState }
  | { ok: false; failure: InteractiveBlocked } {
  const record = readRunRecord(workspace, runId);
  if (record === undefined) {
    return {
      ok: false,
      failure: blocked('run-not-found', `Run "${runId}" was not found under .specbridge/runs/.`, [
        'List runs with the run_list tool.',
      ]),
    };
  }
  if (record.kind !== 'interactive-execution') {
    return {
      ok: false,
      failure: blocked(
        'run-state-invalid',
        `Run ${runId} is a ${record.kind} run, not an interactive execution run.`,
      ),
    };
  }
  const state = readRunArtifactJson(workspace, runId, 'interactive-state.json') as
    | StoredInteractiveState
    | undefined;
  if (state === undefined || state.before === undefined || state.task === undefined) {
    return {
      ok: false,
      failure: blocked(
        'run-state-invalid',
        `Run ${runId} has no readable interactive state (interactive-state.json).`,
      ),
    };
  }
  return { ok: true, record, state };
}

/** Read the final report of a finalized run (idempotent repeat results). */
function readFinalReport(workspace: WorkspaceInfo, runId: string): TaskRunReport | undefined {
  const artifact = readRunArtifactJson(workspace, runId, 'report.json') as
    | { report?: TaskRunReport }
    | undefined;
  return artifact?.report;
}

export type CompleteInteractiveOutcome = InteractiveBlocked | InteractiveCompleted;

export async function completeInteractiveTask(
  deps: InteractiveDeps,
  request: CompleteInteractiveRequest,
): Promise<CompleteInteractiveOutcome> {
  const clock = deps.clock ?? systemClock;
  const { workspace } = deps;

  const loaded = loadInteractiveRun(workspace, request.runId);
  if (!loaded.ok) return loaded.failure;
  const { record, state } = loaded;

  // Idempotent finalization: a completed run returns its recorded result and
  // never evaluates, records, or updates anything twice.
  const lifecycle = record.lifecycleStatus as InteractiveLifecycleStatus | undefined;
  if (lifecycle === 'COMPLETED') {
    const report = readFinalReport(workspace, request.runId);
    if (report !== undefined) {
      return {
        kind: 'finalized',
        outcome: classifyInteractiveOutcome(report),
        report,
        finalizedNow: false,
      };
    }
    return {
      kind: 'blocked',
      code: 'run-state-invalid',
      message: `Run ${request.runId} is already finalized but its report artifact is unreadable.`,
      remediation: ['Inspect the run directory with the run_read tool.'],
    };
  }
  if (lifecycle === 'ABORTED') {
    return blocked(
      'run-state-invalid',
      `Run ${request.runId} was aborted${record.abortReason !== undefined ? ` (${record.abortReason})` : ''}; it cannot be completed. Begin a new run.`,
      ['Start a fresh attempt with task_begin.'],
    );
  }

  // The lock must still reference this run: a missing or foreign lock means
  // the bracketing that makes attribution trustworthy is gone.
  const lockRead = readInteractiveLock(workspace);
  if (lockRead.state !== 'held' || lockRead.lock.runId !== request.runId) {
    return blocked(
      'lock-invalid',
      lockRead.state === 'held'
        ? `The interactive lock is held by a different run (${lockRead.lock.runId}); this run can no longer be completed safely.`
        : 'The interactive lock for this run no longer exists; the run can no longer be completed safely.',
      [
        'Abort this run with task_abort (source changes are preserved),',
        'then inspect the repository and begin a fresh run.',
      ],
    );
  }

  // Approvals must still hold before the post-state is captured.
  const stateNow = readSpecState(workspace, record.specName).state;
  if (stateNow === undefined || evaluateWorkflow(workspace, stateNow).health !== 'ok') {
    return blocked(
      'stale-approval',
      `Approved stages of "${record.specName}" changed during the run; completion is blocked and the checkbox stays unchanged.`,
      [
        'Review the spec changes, re-approve the stages (human action),',
        'then abort this run and begin a fresh one.',
      ],
    );
  }

  // The selected task must be untouched (fingerprint and exact line text).
  const task = state.task;
  const tasksPath = path.join(workspace.kiroDir, 'specs', record.specName, 'tasks.md');
  let taskIntact = false;
  try {
    const document = MarkdownDocument.load(tasksPath);
    const model = parseTasks(document);
    const current = findTask(model, task.id);
    const currentFingerprint =
      current !== undefined
        ? taskFingerprint({
            id: current.id,
            title: current.title,
            requirementRefs: current.requirementRefs,
          })
        : undefined;
    taskIntact =
      currentFingerprint === state.taskFingerprint &&
      task.line < document.lineCount &&
      document.lineAt(task.line).text === task.rawLineText;
  } catch {
    taskIntact = false;
  }
  if (!taskIntact) {
    return blocked(
      'task-changed',
      `Task ${task.id} in "${record.specName}" changed since the run began (fingerprint or line text differs); completion is blocked.`,
      ['Abort this run with task_abort and begin a fresh one against the current task plan.'],
    );
  }

  // Model claims become a structured report — recorded verbatim as CLAIMS.
  // Verification below relies exclusively on Git evidence and trusted
  // commands; nothing in this report can verify the task by itself.
  const report = taskRunnerReportSchema.parse({
    outcome: 'completed',
    summary: request.summary,
    changedFiles: request.reportedChangedFiles ?? [],
    commandsReported: [],
    testsReported: request.reportedTests ?? [],
    remainingRisks: request.reportedRisks ?? [],
  });
  const startedMs = Date.parse(record.createdAt);
  const durationMs = Math.max(0, clock().getTime() - (Number.isFinite(startedMs) ? startedMs : clock().getTime()));
  const result: TaskExecutionResult = {
    runner: INTERACTIVE_RUNNER_NAME,
    outcome: 'completed',
    rawStdout: '',
    rawStderr: '',
    durationMs,
    warnings: [],
    resumeSupported: false,
    report,
  };

  const noVerify = request.runVerification !== undefined
    ? !request.runVerification
    : !state.runVerificationOnComplete;

  const finalReport = await finalizeTaskRun(
    {
      workspace,
      config: deps.config,
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
    {
      runId: request.runId,
      ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
      specName: record.specName,
      task,
      runnerName: INTERACTIVE_RUNNER_NAME,
      before: state.before,
      allowDirty: state.allowDirty,
      noVerify,
      preflightWarnings: [...record.warnings],
      result,
    },
  );

  updateRunRecord(workspace, request.runId, { lifecycleStatus: 'COMPLETED' });
  appendRunEvent(workspace, request.runId, {
    at: clock().toISOString(),
    type: 'interactive-complete',
    evidenceStatus: finalReport.evidenceStatus,
    checkboxUpdated: finalReport.checkboxUpdated,
  });
  releaseInteractiveLock(workspace, request.runId);

  return {
    kind: 'finalized',
    outcome: classifyInteractiveOutcome(finalReport),
    report: finalReport,
    finalizedNow: true,
  };
}

export interface AbortInteractiveRequest {
  runId: string;
  reason: string;
}

export interface InteractiveAborted {
  kind: 'aborted';
  runId: string;
  reason: string;
  /** Working-tree paths still changed relative to the run baseline. */
  remainingChangedPaths: string[];
  /** True when this call performed the abort; false for idempotent repeats. */
  abortedNow: boolean;
  lockReleased: boolean;
}

export interface InteractiveAlreadyFinal {
  kind: 'already-final';
  runId: string;
  lifecycleStatus: InteractiveLifecycleStatus;
  outcome?: InteractiveOutcomeLabel;
}

export type AbortInteractiveOutcome = InteractiveBlocked | InteractiveAborted | InteractiveAlreadyFinal;

export async function abortInteractiveTask(
  deps: InteractiveDeps,
  request: AbortInteractiveRequest,
): Promise<AbortInteractiveOutcome> {
  const clock = deps.clock ?? systemClock;
  const { workspace } = deps;
  const reason = request.reason.trim();
  if (reason.length === 0) {
    return blocked('run-state-invalid', 'task_abort requires a non-empty reason.', []);
  }

  const loaded = loadInteractiveRun(workspace, request.runId);
  if (!loaded.ok) return loaded.failure;
  const { record, state } = loaded;

  const lifecycle = record.lifecycleStatus as InteractiveLifecycleStatus | undefined;
  if (lifecycle === 'COMPLETED' || lifecycle === 'ABORTED') {
    const report = lifecycle === 'COMPLETED' ? readFinalReport(workspace, request.runId) : undefined;
    return {
      kind: 'already-final',
      runId: request.runId,
      lifecycleStatus: lifecycle,
      ...(report !== undefined ? { outcome: classifyInteractiveOutcome(report) } : {}),
    };
  }

  // Abort never resets or deletes anything: capture what remains changed,
  // record the reason, release the lock, and leave every file alone.
  const now = await captureGitSnapshot(workspace.rootDir, { clock: () => clock() });
  const remaining = now.gitAvailable
    ? agentChangedFiles(compareSnapshots(state.before, now)).map((file) => file.path)
    : [];
  const abortedAt = clock().toISOString();
  writeRunArtifact(
    workspace,
    request.runId,
    'abort.json',
    `${JSON.stringify({ reason, abortedAt, remainingChangedPaths: remaining }, null, 2)}\n`,
  );
  updateRunRecord(workspace, request.runId, {
    lifecycleStatus: 'ABORTED',
    abortReason: reason,
    outcome: 'cancelled',
    finishedAt: abortedAt,
  });
  appendRunEvent(workspace, request.runId, {
    at: abortedAt,
    type: 'interactive-abort',
    reason,
  });
  const release = releaseInteractiveLock(workspace, request.runId);

  return {
    kind: 'aborted',
    runId: request.runId,
    reason,
    remainingChangedPaths: remaining,
    abortedNow: true,
    lockReleased: release.released,
  };
}

/** Absolute run directory (re-exported convenience for hosts). */
export function interactiveRunDir(workspace: WorkspaceInfo, runId: string): string {
  return runDir(workspace, runId);
}
