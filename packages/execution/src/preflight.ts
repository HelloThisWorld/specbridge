import type { MarkdownDocument, SpecAnalysis, TasksModel } from '@specbridge/compat-kiro';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type {
  AgentConfig,
  SpecWorkflowState,
  VerificationCommand,
  WorkspaceInfo,
} from '@specbridge/core';
import { EXIT_CODES } from '@specbridge/core';
import type { AgentRunner, RunnerDetectionResult, RunnerRegistry } from '@specbridge/runners';
import type { WorkflowEvaluation } from '@specbridge/workflow';
import { evaluateWorkflow } from '@specbridge/workflow';
import type { GitSnapshot } from '@specbridge/evidence';
import { captureGitSnapshot } from '@specbridge/evidence';
import type { SelectedTask, TaskSelector } from './task-selection.js';
import { openPredecessors, selectTask } from './task-selection.js';

/**
 * Pre-run validation (§ execution prerequisites). Every check happens BEFORE
 * a runner is invoked; a failed prerequisite produces an actionable failure
 * and no agent process ever starts.
 */

export interface PreflightFailure {
  code:
    | 'unmanaged-spec'
    | 'stages-not-approved'
    | 'stale-approval'
    | 'tasks-missing'
    | 'task-not-found'
    | 'task-already-complete'
    | 'task-not-leaf'
    | 'no-open-tasks'
    | 'runner-unavailable'
    | 'git-unavailable'
    | 'dirty-working-tree';
  exitCode: number;
  message: string;
  remediation: string[];
  detection?: RunnerDetectionResult;
  dirtyPaths?: string[];
}

export interface TaskPreflight {
  ok: boolean;
  failure?: PreflightFailure;
  warnings: string[];
  spec: SpecAnalysis;
  state?: SpecWorkflowState;
  evaluation?: WorkflowEvaluation;
  tasksDocument?: MarkdownDocument;
  tasksModel?: TasksModel;
  task?: SelectedTask;
  runnerName: string;
  runner?: AgentRunner;
  detection?: RunnerDetectionResult;
  before?: GitSnapshot;
  verificationCommands: VerificationCommand[];
  timeoutMs: number;
  allowDirty: boolean;
}

export interface PreflightRequest {
  specName: string;
  selector: TaskSelector;
  runnerName?: string;
  timeoutMs?: number;
  allowDirty?: boolean;
}

export async function preflightTaskRun(
  deps: {
    workspace: WorkspaceInfo;
    config: AgentConfig;
    registry: RunnerRegistry;
    clock?: () => Date;
  },
  request: PreflightRequest,
): Promise<TaskPreflight> {
  const { workspace, config } = deps;
  const runnerName = request.runnerName ?? config.defaultRunner;
  const allowDirty = request.allowDirty === true;
  const timeoutMs = request.timeoutMs ?? config.runners['claude-code'].timeoutMs;
  const verificationCommands = config.verification.commands;
  const warnings: string[] = [];

  const folder = requireSpec(workspace, request.specName);
  const spec = analyzeSpec(workspace, folder);
  const base: Omit<TaskPreflight, 'ok'> = {
    warnings,
    spec,
    runnerName,
    verificationCommands,
    timeoutMs,
    allowDirty,
  };
  const fail = (failure: PreflightFailure, extra?: Partial<TaskPreflight>): TaskPreflight => ({
    ok: false,
    failure,
    ...base,
    ...extra,
  });

  // Sidecar workflow state must exist — execution runs only on managed specs.
  if (spec.state === undefined) {
    return fail({
      code: 'unmanaged-spec',
      exitCode: EXIT_CODES.gateFailure,
      message:
        `Spec "${folder.name}" has no SpecBridge workflow state; tasks can only be executed for specs with approved stages.`,
      remediation: [
        `specbridge spec status ${folder.name}`,
        `specbridge spec approve ${folder.name} --stage <stage>  (initializes state for existing Kiro specs)`,
      ],
    });
  }
  const state = spec.state;
  base.state = state;

  // Approvals: recorded, fresh, and complete.
  const evaluation = evaluateWorkflow(workspace, state);
  base.evaluation = evaluation;
  if (evaluation.health === 'stale') {
    const stale = [...evaluation.staleStages, ...evaluation.invalidatedStages];
    const first = stale[0];
    return fail({
      code: 'stale-approval',
      exitCode: EXIT_CODES.gateFailure,
      message:
        `Cannot execute tasks for "${folder.name}": approved stage(s) changed after approval (${stale.join(', ')}). ` +
        'Review the changes and re-approve before running tasks.',
      remediation:
        first !== undefined
          ? [
              `specbridge spec status ${folder.name}`,
              `specbridge spec analyze ${folder.name} --stage ${first}`,
              `specbridge spec approve ${folder.name} --stage ${first}`,
            ]
          : [`specbridge spec status ${folder.name}`],
    });
  }
  if (evaluation.effectiveStatus !== 'READY_FOR_IMPLEMENTATION') {
    const unapproved = evaluation.stages
      .filter((stage) => stage.effective !== 'approved')
      .map((stage) => stage.stage);
    return fail({
      code: 'stages-not-approved',
      exitCode: EXIT_CODES.gateFailure,
      message:
        `Cannot execute tasks for "${folder.name}": not every stage is approved yet ` +
        `(missing: ${unapproved.join(', ')}; status: ${evaluation.effectiveStatus}).`,
      remediation: unapproved[0] !== undefined
        ? [
            `specbridge spec analyze ${folder.name} --stage ${unapproved[0]}`,
            `specbridge spec approve ${folder.name} --stage ${unapproved[0]}`,
          ]
        : [`specbridge spec status ${folder.name}`],
    });
  }

  // Tasks document and selection.
  const tasksDocument = spec.documents.tasks;
  const tasksModel = spec.tasks;
  if (tasksDocument === undefined || tasksModel === undefined) {
    return fail({
      code: 'tasks-missing',
      exitCode: EXIT_CODES.gateFailure,
      message: `Spec "${folder.name}" has no readable tasks.md.`,
      remediation: [`specbridge spec status ${folder.name}`],
    });
  }
  base.tasksDocument = tasksDocument;
  base.tasksModel = tasksModel;

  const selection = selectTask(tasksModel, tasksDocument, request.selector);
  if (!selection.ok) {
    const exitCode =
      selection.reason === 'task-not-found' || selection.reason === 'task-not-leaf'
        ? EXIT_CODES.usageError
        : selection.reason === 'no-open-tasks'
          ? EXIT_CODES.ok
          : EXIT_CODES.gateFailure;
    return fail({
      code: selection.reason,
      exitCode,
      message: selection.message,
      remediation:
        selection.reason === 'no-open-tasks'
          ? []
          : [`specbridge spec show ${folder.name} --file tasks`],
    });
  }
  const task = selection.task;
  base.task = task;

  if (task.optional) {
    warnings.push(`Task ${task.id} is optional; it was selected explicitly.`);
  }
  if (task.state === 'in-progress') {
    warnings.push(`Task ${task.id} is marked in-progress ([-]); continuing it.`);
  }
  const predecessors = openPredecessors(tasksModel, tasksDocument, task);
  if (request.selector.taskId !== undefined && predecessors.length > 0) {
    warnings.push(
      `${predecessors.length} earlier task(s) are still open (next would be ${predecessors[0]?.id}); running ${task.id} out of order.`,
    );
  }

  // Runner availability, authentication, capabilities.
  const runner = deps.registry.get(runnerName);
  base.runner = runner;
  const detection = await runner.detect({
    workspaceRoot: workspace.rootDir,
    probeCapabilities: true,
  });
  base.detection = detection;
  if (detection.status !== 'available') {
    return fail({
      code: 'runner-unavailable',
      exitCode: EXIT_CODES.runnerUnavailable,
      message: `The ${runnerName} runner is not available (status: ${detection.status}).`,
      remediation: [`specbridge runner doctor ${runnerName}`],
      detection,
    });
  }

  // Repository state and clean-tree policy. The snapshot doubles as the
  // pre-run baseline so preflight and execution see the same state.
  const before = await captureGitSnapshot(workspace.rootDir, {
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
  });
  base.before = before;
  if (!before.gitAvailable) {
    return fail({
      code: 'git-unavailable',
      exitCode: EXIT_CODES.usageError,
      message:
        'Task execution needs a git repository: SpecBridge captures the repository state before and after every run.',
      remediation: ['Initialize one with "git init" and commit the current state.'],
    });
  }
  // The dirty-tree POLICY ignores SpecBridge's own runtime state and .kiro
  // stage files whose bytes still match their recorded approved hash (e.g.
  // a tasks.md checkbox update SpecBridge itself made after a verified
  // task). Snapshots and attribution still track every path.
  const approvedHashes = new Map<string, string>();
  for (const stageEvaluation of evaluation.stages) {
    if (stageEvaluation.stored.approvedHash !== null) {
      approvedHashes.set(stageEvaluation.stored.file, stageEvaluation.stored.approvedHash);
    }
  }
  const policyDirtyPaths = before.entries
    .filter((entry) => {
      if (entry.path.startsWith('.specbridge/')) return false;
      const approvedHash = approvedHashes.get(entry.path);
      if (approvedHash !== undefined && entry.contentHash === approvedHash) return false;
      return true;
    })
    .map((entry) => entry.path);

  const requireClean = config.execution.requireCleanWorkingTree;
  if (policyDirtyPaths.length > 0 && requireClean && !allowDirty) {
    return fail({
      code: 'dirty-working-tree',
      exitCode: EXIT_CODES.gateFailure,
      message: `The working tree has uncommitted changes (${policyDirtyPaths.length} path(s)); task execution requires a clean tree.`,
      remediation: [
        'Commit or stash the existing changes,',
        'or rerun with --allow-dirty (pre-existing changes are baselined and never attributed to the task).',
      ],
      dirtyPaths: policyDirtyPaths,
    });
  }
  if (!before.clean) {
    warnings.push(
      `The working tree already has ${before.entries.length} modified path(s); they were baselined and will not be attributed to the task.`,
    );
  }

  return { ok: true, ...base };
}
