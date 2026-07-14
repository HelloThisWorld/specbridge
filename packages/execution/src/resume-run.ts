import { EXIT_CODES } from '@specbridge/core';
import type { GitSnapshot, VerificationRunResult } from '@specbridge/evidence';
import { captureGitSnapshot } from '@specbridge/evidence';
import { systemClock } from '@specbridge/workflow';
import {
  renderTaskHierarchy,
  repositoryObservations,
  specDocumentSections,
  steeringSections,
  workspaceRootNote,
} from './context.js';
import type { TaskDryRunPlan, TaskRunDeps, TaskRunReport } from './execute-task.js';
import { boundaryNoteFor, finalizeTaskRun } from './execute-task.js';
import { preflightTaskRun } from './preflight.js';
import type { TaskPreflight } from './preflight.js';
import { PROMPT_CONTRACT_VERSION, buildTaskResumePrompt } from './prompts.js';
import {
  RUN_RECORD_SCHEMA_VERSION,
  appendRunEvent,
  createRun,
  readRunArtifactJson,
  readRunRecord,
  runDir,
  writeRunArtifact,
} from './run-store.js';
import { randomUUID } from 'node:crypto';

/**
 * Claude Code session resume (§ resumable runs).
 *
 * Resume continues the SAME task in the SAME session. It is refused —
 * honestly, with remediation — whenever the original run is not resumable,
 * the session is unknown, approvals went stale, the task disappeared, or
 * the repository diverged from the previous run's recorded post-state.
 * SpecBridge never silently starts a fresh session while claiming a resume.
 */

const RESUMABLE_STATUSES = new Set([
  'blocked',
  'failed',
  'timed-out',
  'cancelled',
  'implemented-unverified',
  'no-change',
]);

export interface ResumeRequest {
  runId: string;
  timeoutMs?: number;
  noVerify?: boolean;
  dryRun?: boolean;
}

export type ResumeOutcome =
  | { kind: 'refused'; exitCode: number; message: string; remediation: string[]; divergence?: string[] }
  | { kind: 'preflight-failed'; exitCode: number; preflight: TaskPreflight }
  | { kind: 'dry-run'; exitCode: number; plan: TaskDryRunPlan }
  | { kind: 'executed'; exitCode: number; report: TaskRunReport; originalRunId: string };

function refuse(
  message: string,
  remediation: string[],
  exitCode: number = EXIT_CODES.gateFailure,
): ResumeOutcome {
  return { kind: 'refused', exitCode, message, remediation };
}

/** Compare the current repository with the original run's recorded post-state. */
function diverges(current: GitSnapshot, recordedAfter: GitSnapshot): string[] {
  const differences: string[] = [];
  if (current.head !== recordedAfter.head) {
    differences.push(
      `HEAD is ${current.head ?? '(none)'} but the run ended at ${recordedAfter.head ?? '(none)'}`,
    );
  }
  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
  const recordedByPath = new Map(recordedAfter.entries.map((entry) => [entry.path, entry]));
  for (const [file, entry] of recordedByPath) {
    const now = currentByPath.get(file);
    if (now === undefined) differences.push(`"${file}" was modified after the run ended (now clean or removed)`);
    else if (now.contentHash !== entry.contentHash) differences.push(`"${file}" changed after the run ended`);
  }
  for (const file of currentByPath.keys()) {
    if (!recordedByPath.has(file)) differences.push(`"${file}" was modified after the run ended`);
  }
  return differences;
}

export async function resumeRun(deps: TaskRunDeps, request: ResumeRequest): Promise<ResumeOutcome> {
  const clock = deps.clock ?? systemClock;
  const { workspace } = deps;

  const original = readRunRecord(workspace, request.runId);
  if (original === undefined) {
    return refuse(
      `Run "${request.runId}" was not found under .specbridge/runs/.`,
      ['specbridge run list'],
      EXIT_CODES.usageError,
    );
  }
  if (original.kind !== 'task-execution' && original.kind !== 'task-resume') {
    return refuse(
      `Run ${original.runId} is a ${original.kind} run; only task runs can be resumed.`,
      ['specbridge run list'],
      EXIT_CODES.usageError,
    );
  }
  if (original.evidenceStatus === 'verified' || original.evidenceStatus === 'manually-accepted') {
    return refuse(
      `Run ${original.runId} completed with evidence status "${original.evidenceStatus}"; a verified task is never resumed.`,
      [`specbridge run show ${original.runId}`],
    );
  }
  const status = original.evidenceStatus ?? original.outcome ?? 'unknown';
  if (!RESUMABLE_STATUSES.has(status)) {
    return refuse(
      `Run ${original.runId} (status: ${status}) is not resumable. Resumable statuses: ${[...RESUMABLE_STATUSES].join(', ')}.`,
      [`specbridge run show ${original.runId}`],
    );
  }
  if (original.taskId === undefined) {
    return refuse(`Run ${original.runId} records no task id; it cannot be resumed.`, []);
  }
  if (original.sessionId === undefined) {
    return refuse(
      `Run ${original.runId} recorded no session id, so the agent session cannot be resumed. Start a new attempt instead:`,
      [`specbridge spec run ${original.specName} --task ${original.taskId}`],
    );
  }

  // Preflight the same task again (approvals, task existence, runner, git).
  // The v0.6 capability check runs as task-resume: a runner without the
  // taskResume capability is refused before any process or network work.
  const preflight = await preflightTaskRun(deps, {
    specName: original.specName,
    selector: { taskId: original.taskId },
    runnerName: original.runner,
    operation: 'task-resume',
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  });
  if (!preflight.ok) {
    // A dirty tree is EXPECTED when resuming over previous progress; only
    // treat it as fatal if it also diverges from the recorded post-state.
    if (preflight.failure?.code !== 'dirty-working-tree') {
      return {
        kind: 'preflight-failed',
        exitCode: preflight.failure?.exitCode ?? EXIT_CODES.usageError,
        preflight,
      };
    }
  }
  const task = preflight.task;
  const runner = preflight.runner;
  const detection = preflight.detection;
  if (task === undefined || runner === undefined) {
    return {
      kind: 'preflight-failed',
      exitCode: preflight.failure?.exitCode ?? EXIT_CODES.usageError,
      preflight,
    };
  }

  if (runner.resumeTask === undefined) {
    return refuse(
      `The ${original.runner} runner does not support resuming sessions. Start a new attempt (run lineage is preserved through parentRunId):`,
      [`specbridge spec run ${original.specName} --task ${original.taskId}`],
      EXIT_CODES.runnerUnavailable,
    );
  }
  const resumeCapable = detection?.capabilities.find((c) => c.id === 'resume');
  if (resumeCapable !== undefined && !resumeCapable.available) {
    return refuse(
      `The installed ${original.runner} version does not support --resume. Start a new attempt instead:`,
      [`specbridge spec run ${original.specName} --task ${original.taskId}`],
      EXIT_CODES.runnerUnavailable,
    );
  }

  // Repository must be reconcilable with the recorded post-run state, and
  // the ORIGINAL pre-run snapshot stays the attribution baseline so work
  // from the interrupted session still counts toward the same task.
  const recordedAfter = readRunArtifactJson(workspace, original.runId, 'git-after.json') as
    | GitSnapshot
    | undefined;
  const originalBefore = readRunArtifactJson(workspace, original.runId, 'git-before.json') as
    | GitSnapshot
    | undefined;
  if (recordedAfter === undefined || originalBefore === undefined) {
    return refuse(
      `Run ${original.runId} has no recorded repository snapshots; an unsafe resume is refused.`,
      [`specbridge spec run ${original.specName} --task ${original.taskId}`],
    );
  }
  const current =
    preflight.before ?? (await captureGitSnapshot(workspace.rootDir, { clock: () => clock() }));
  const divergence = diverges(current, recordedAfter);
  if (divergence.length > 0) {
    return {
      kind: 'refused',
      exitCode: EXIT_CODES.gateFailure,
      message:
        `The repository diverged from the state run ${original.runId} left behind; resuming would attribute unrelated changes to the task.`,
      remediation: [
        'Restore the repository to the post-run state (or commit/stash your new changes),',
        `or start a fresh attempt: specbridge spec run ${original.specName} --task ${original.taskId}`,
      ],
      divergence,
    };
  }

  // Build the resume prompt from recorded artifacts.
  const previousResult = readRunArtifactJson(workspace, original.runId, 'runner-result.json') as
    | { report?: { summary?: string; blockingQuestions?: string[] } | null; failureReason?: string | null }
    | undefined;
  const previousVerification = readRunArtifactJson(workspace, original.runId, 'verification.json') as
    | VerificationRunResult
    | undefined;
  const failedVerification =
    previousVerification?.commands
      .filter((command) => !command.passed)
      .map((command) => `${command.name} (${command.argv.join(' ')}) exited ${command.exitCode ?? 'without a code'}`) ?? [];

  const state = preflight.state;
  const documentStage = state?.specType === 'bugfix' ? 'bugfix' : 'requirements';
  const prompt = buildTaskResumePrompt({
    specName: original.specName,
    specType: state?.specType ?? 'feature',
    workflowMode: state?.workflowMode ?? 'unknown',
    steering: steeringSections(workspace),
    documents: specDocumentSections(preflight.spec, preflight.evaluation, [documentStage, 'design']),
    taskHierarchy:
      preflight.tasksModel !== undefined ? renderTaskHierarchy(preflight.tasksModel, task.id) : '',
    taskId: task.id,
    taskTitle: task.title,
    requirementRefs: task.requirementRefs,
    repositoryObservations: repositoryObservations(workspace.rootDir, current),
    workspaceRootNote: workspaceRootNote(workspace),
    allowedToolsNote: boundaryNoteFor(preflight),
    previousSummary:
      previousResult?.report?.summary ?? previousResult?.failureReason ?? '(no summary recorded)',
    previousOutcome: String(original.outcome ?? 'unknown'),
    actualChangesNow: current.entries.map((entry) => `${entry.status} ${entry.path}`),
    failedVerification,
    unresolvedIssues: previousResult?.report?.blockingQuestions ?? [],
  });

  if (request.dryRun === true) {
    const profileConfig = preflight.profileConfig;
    return {
      kind: 'dry-run',
      exitCode: EXIT_CODES.ok,
      plan: {
        specName: original.specName,
        task,
        runner: original.runner,
        prerequisites: 'ok',
        gitClean: current.clean,
        dirtyPaths: current.entries.map((entry) => entry.path),
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
        expectedArtifacts: [],
        warnings: preflight.warnings,
      },
    };
  }

  const runId = (deps.idFactory ?? randomUUID)();
  const createdAt = clock().toISOString();
  createRun(workspace, {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    runId,
    kind: 'task-resume',
    specName: original.specName,
    taskId: task.id,
    runner: original.runner,
    sessionId: original.sessionId,
    parentRunId: original.runId,
    createdAt,
    resumeSupported: false,
    promptVersion: PROMPT_CONTRACT_VERSION,
    warnings: preflight.warnings,
  });
  writeRunArtifact(workspace, runId, 'prompt.md', prompt);
  appendRunEvent(workspace, runId, {
    at: createdAt,
    type: 'resume-start',
    originalRunId: original.runId,
    sessionId: original.sessionId,
  });
  deps.onProgress?.(`Resuming task ${task.id} (session ${original.sessionId})…`);

  const result = await runner.resumeTask(
    {
      specName: original.specName,
      taskId: task.id,
      prompt,
      promptVersion: PROMPT_CONTRACT_VERSION,
      toolPolicy: 'implementation',
      sessionId: original.sessionId,
    },
    {
      workspaceRoot: workspace.rootDir,
      runDir: runDir(workspace, runId),
      timeoutMs: preflight.timeoutMs,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
  );

  const report = await finalizeTaskRun(deps, {
    runId,
    parentRunId: original.runId,
    specName: original.specName,
    task,
    runnerName: original.runner,
    before: originalBefore,
    sessionBefore: current,
    allowDirty: !originalBefore.clean,
    noVerify: request.noVerify === true,
    preflightWarnings: preflight.warnings,
    result,
  });
  return { kind: 'executed', exitCode: report.exitCode, report, originalRunId: original.runId };
}
