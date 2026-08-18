import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { runAllOpenTasks, runApprovedTask } from '@specbridge/execution';
import type { TaskRunOutcome } from '@specbridge/execution';
import type { RunnerRegistry } from '@specbridge/runners';
import type { Clock } from '@specbridge/workflow';
import type { FailureCategory } from '../vocabulary.js';
import type { ExecutorOutcome } from '../jobs/job-service.js';
import type { JobNode } from '../jobs/state.js';

// Re-exported so the driver has one import site for execution machinery.
export { runAllOpenTasks };

/**
 * The executor dispatch: one approved task through the EXISTING evidence
 * pipeline (`runApprovedTask` — pre/post Git snapshots, trusted verification,
 * evidence evaluation, verified-only checkbox update).
 *
 * Nothing here weakens or reimplements completion: this module RUNS the
 * pipeline and TRANSLATES its outcome into the job vocabulary. The mapping
 * table below is the entire policy surface, and it only ever classifies —
 * it cannot upgrade an unverified result into a completed one.
 */

export interface ExecutorDispatchInput {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  registry: RunnerRegistry;
  node: JobNode;
  specName: string;
  mode: 'implement' | 'repair';
  /**
   * Allow a dirty working tree. Sequential jobs inevitably run later tasks
   * over the uncommitted verified changes of earlier ones (SpecBridge never
   * commits) and repairs over their own failed attempt — the same rule
   * `runAllOpenTasks` applies; the hash-exact baseline keeps attribution
   * precise either way.
   */
  allowDirty: boolean;
  /** Runner profile of the selected executor worker. */
  runnerProfile: string | undefined;
  timeoutMs?: number | undefined;
  clock?: Clock | undefined;
  idFactory?: (() => string) | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

export interface ExecutorDispatchResult {
  /** What completeExecutorDispatch needs, minus the attempt context. */
  evidenceStatus: string | undefined;
  runId: string | undefined;
  failure?: ExecutorOutcome['failure'];
  changedFiles?: { path: string; contentHash?: string | undefined }[];
  usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}

/** Map a preflight failure code onto the shared failure taxonomy. */
export function classifyPreflightFailure(code: string | undefined): FailureCategory {
  switch (code) {
    case 'stale-approval':
    case 'task-changed':
    case 'task-already-complete':
      return 'STALE_CONTEXT';
    case 'dirty-working-tree':
      return 'REPOSITORY_DIVERGED';
    case 'lock-held':
      return 'BLOCKED_DEPENDENCY';
    case 'git-unavailable':
      return 'BLOCKED_DEPENDENCY';
    case 'stages-not-approved':
    case 'tasks-missing':
    case 'unmanaged-spec':
      return 'STALE_CONTEXT';
    case 'runner-unavailable':
    case 'capability-missing':
      return 'CAPABILITY_UNAVAILABLE';
    default:
      return 'INVALID_CONFIGURATION';
  }
}

/** Map an executed report's evidence status onto the failure taxonomy. */
export function classifyEvidenceFailure(evidenceStatus: string): FailureCategory {
  switch (evidenceStatus) {
    case 'implemented-unverified':
      return 'VERIFICATION_FAILURE';
    case 'no-change':
      // The runner claimed work but the repository is byte-identical: the
      // implementation attempt is defective, whatever the claim says.
      return 'IMPLEMENTATION_DEFECT';
    case 'blocked':
      return 'BLOCKED_DEPENDENCY';
    case 'timed-out':
      return 'TRANSIENT_TOOL';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'IMPLEMENTATION_DEFECT';
  }
}

/**
 * Run one executor dispatch and translate the outcome.
 *
 * Repair dispatches receive the latest diagnosis as bounded, data-only
 * repository observations — the worker packet of §repair — while the prompt
 * contract itself stays byte-identical for ordinary runs.
 */
export async function dispatchExecutor(input: ExecutorDispatchInput): Promise<ExecutorDispatchResult> {
  const extraObservations: string[] = [];
  if (input.mode === 'repair' && input.node.latestDiagnosis !== undefined) {
    extraObservations.push(
      `Previous attempt failed (${input.node.latestFailure?.category ?? 'unknown'}): ${
        input.node.latestFailure?.message ?? 'see evidence'
      }`,
      `Diagnosis: ${input.node.latestDiagnosis.category}; recommended ${input.node.latestDiagnosis.recommendedAction}.`,
      `This is repair cycle ${input.node.repairCycles + 1}; fix the diagnosed defect, do not restart the approach.`,
    );
  }

  const outcome: TaskRunOutcome = await runApprovedTask(
    {
      workspace: input.workspace,
      config: input.config,
      registry: input.registry,
      ...(input.clock !== undefined ? { clock: input.clock } : {}),
      ...(input.idFactory !== undefined ? { idFactory: input.idFactory } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    },
    {
      specName: input.specName,
      taskId: input.node.parentTaskId,
      allowDirty: input.allowDirty,
      ...(input.runnerProfile !== undefined ? { runnerName: input.runnerProfile } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(extraObservations.length > 0 ? { extraObservations } : {}),
    },
  );

  switch (outcome.kind) {
    case 'executed': {
      const report = outcome.report;
      const verified =
        report.evidenceStatus === 'verified' || report.evidenceStatus === 'manually-accepted';
      if (verified) {
        return {
          evidenceStatus: report.evidenceStatus,
          runId: report.runId,
          changedFiles: report.changedFiles.map((file) => ({
            path: file.path,
            contentHash: file.changeType,
          })),
        };
      }
      const category = classifyEvidenceFailure(report.evidenceStatus);
      const verificationOutput = report.verification.commands
        .filter((command) => !command.passed)
        .map((command) => `${command.name}: ${command.status}\n${command.stdoutTail}\n${command.stderrTail}`)
        .join('\n');
      return {
        evidenceStatus: report.evidenceStatus,
        runId: report.runId,
        failure: {
          category,
          message:
            report.failureReason ??
            `The dispatch ended with evidence status "${report.evidenceStatus}".`,
          source:
            category === 'VERIFICATION_FAILURE'
              ? (report.verification.commands.find((command) => !command.passed)?.name ?? 'verification')
              : report.runner,
          ...(verificationOutput.length > 0 ? { output: verificationOutput.slice(0, 16_384) } : {}),
        },
        // Change identity for no-progress detection: path plus change type.
        // Content hashes are not in the report; the diff fingerprint stays
        // deterministic over the (path, changeType) set.
        changedFiles: report.changedFiles.map((file) => ({
          path: file.path,
          contentHash: file.changeType,
        })),
      };
    }
    case 'preflight-failed': {
      const code = outcome.preflight.failure?.code;
      return {
        evidenceStatus: undefined,
        runId: undefined,
        failure: {
          category: classifyPreflightFailure(code),
          message: outcome.preflight.failure?.message ?? 'Preflight failed.',
          source: `preflight:${code ?? 'unknown'}`,
        },
      };
    }
    case 'nothing-to-do':
      return {
        evidenceStatus: undefined,
        runId: undefined,
        failure: {
          category: 'STALE_CONTEXT',
          message: outcome.message,
          source: 'preflight:no-open-tasks',
        },
      };
    case 'dry-run':
      return {
        evidenceStatus: undefined,
        runId: undefined,
        failure: {
          category: 'INTERNAL',
          message: 'The executor dispatch unexpectedly ran as a dry run.',
          source: 'dispatch',
        },
      };
  }
}
