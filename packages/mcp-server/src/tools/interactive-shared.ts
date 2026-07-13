import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { readAgentConfig } from '@specbridge/core';
import type { InteractiveBlocked, InteractiveDeps, TaskRunReport } from '@specbridge/execution';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import type { SbmcpCode } from '../errors.js';
import { McpToolError } from '../errors.js';

/** Shared plumbing for the task_begin / task_complete / task_abort adapters. */

/** Fail-closed configuration load (invalid config refuses execution). */
export function requireAgentConfig(workspace: WorkspaceInfo): AgentConfig {
  const read = readAgentConfig(workspace);
  if (read.config === undefined) {
    throw new McpToolError(
      'SBMCP012',
      `.specbridge/config.json is invalid: ${read.diagnostics.map((d) => d.message).join('; ')}`,
      { remediation: ['Fix the configuration file (or delete it to fall back to safe defaults).'] },
    );
  }
  return read.config;
}

export function interactiveDeps(context: ServerContext, workspace: WorkspaceInfo): InteractiveDeps {
  return {
    workspace,
    config: requireAgentConfig(workspace),
    clock: context.clock,
    idFactory: context.idFactory,
    host: 'mcp',
  };
}

const BLOCK_CODE_MAP: Record<InteractiveBlocked['code'], SbmcpCode> = {
  'unmanaged-spec': 'SBMCP006',
  'stages-not-approved': 'SBMCP006',
  'stale-approval': 'SBMCP005',
  'tasks-missing': 'SBMCP007',
  'task-not-found': 'SBMCP007',
  'task-already-complete': 'SBMCP008',
  'task-not-leaf': 'SBMCP002',
  'no-open-tasks': 'SBMCP007',
  'git-unavailable': 'SBMCP001',
  'dirty-working-tree': 'SBMCP009',
  'lock-held': 'SBMCP010',
  'run-not-found': 'SBMCP011',
  'run-state-invalid': 'SBMCP012',
  'lock-invalid': 'SBMCP012',
  'task-changed': 'SBMCP013',
};

/** Convert an interactive lifecycle refusal into the stable error envelope. */
export function throwBlocked(blockedOutcome: InteractiveBlocked): never {
  throw new McpToolError(BLOCK_CODE_MAP[blockedOutcome.code], blockedOutcome.message, {
    remediation: blockedOutcome.remediation,
    details: { gate: blockedOutcome.code, ...(blockedOutcome.details ?? {}) },
  });
}

export const changedFileShape = z.object({
  path: z.string(),
  changeType: z.enum(['added', 'modified', 'deleted']),
  preExisting: z.boolean(),
  modifiedDuringRun: z.boolean(),
});

export const verifierOutcomeShape = z.object({
  name: z.string(),
  required: z.boolean(),
  passed: z.boolean(),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
  timedOut: z.boolean(),
});

export function verifierOutcomes(report: TaskRunReport): z.infer<typeof verifierOutcomeShape>[] {
  return report.verification.commands.map((command) => ({
    name: command.name,
    required: command.required,
    passed: command.passed,
    exitCode: command.exitCode ?? null,
    durationMs: command.durationMs,
    timedOut: command.timedOut,
  }));
}

export function nextActionFor(outcome: string, report: TaskRunReport): string {
  switch (outcome) {
    case 'verified':
      return `Task ${report.taskId} is verified and its checkbox was updated. Continue with the next task (task_begin) or check drift (spec_check_drift).`;
    case 'implemented-unverified':
      return 'Changes exist but verification did not pass. Inspect the failing commands (run_read), fix the code, and run a fresh task_begin/task_complete cycle — or a human can accept manually via the CLI.';
    case 'no-change':
      return 'No repository change was detected, so nothing can be verified. Implement the task before calling task_complete.';
    case 'protected-path-violation':
      return 'A protected path (.kiro, .specbridge, or a configured path) was modified. Revert that change manually — SpecBridge never rolls back — and start a fresh run.';
    case 'repository-diverged':
      return 'The repository moved under the run (commit, task edit, or approval change). Reconcile manually and start a fresh run.';
    case 'blocked':
      return 'The run reported a blocker. Resolve it and start a fresh run.';
    default:
      return 'Inspect the run with run_read and start a fresh attempt when ready.';
  }
}
