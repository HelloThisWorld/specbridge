import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { registerWorkspaceDetectTool } from './workspace-detect.js';
import { registerSteeringListTool } from './steering-list.js';
import { registerSteeringReadTool } from './steering-read.js';
import { registerSpecListTool } from './spec-list.js';
import { registerSpecReadTool } from './spec-read.js';
import { registerSpecStatusTool } from './spec-status.js';
import { registerSpecContextTool } from './spec-context.js';
import { registerSpecAnalyzeTool } from './spec-analyze.js';
import { registerSpecCreateTool } from './spec-create.js';
import { registerSpecStageValidateTool } from './spec-stage-validate.js';
import { registerSpecStageApplyTool } from './spec-stage-apply.js';
import { registerTaskListTool } from './task-list.js';
import { registerTaskNextTool } from './task-next.js';
import { registerTaskBeginTool } from './task-begin.js';
import { registerTaskCompleteTool } from './task-complete.js';
import { registerTaskAbortTool } from './task-abort.js';
import { registerRunListTool } from './run-list.js';
import { registerRunReadTool } from './run-read.js';
import { registerSpecAffectedTool } from './spec-affected.js';
import { registerSpecCheckDriftTool } from './spec-check-drift.js';
import { registerSpecRunVerificationTool } from './spec-run-verification.js';

/**
 * The complete, closed tool registry.
 *
 * Every tool is a small typed adapter over the shared SpecBridge packages.
 * There is deliberately no arbitrary-filesystem tool, no arbitrary-shell
 * tool, no arbitrary-Git tool, and no stage-approval tool: approval remains
 * an explicit human CLI action, and the only commands that ever execute are
 * the trusted verification commands from `.specbridge/config.json`.
 */

export interface ToolRegistryEntry {
  name: string;
  readOnly: boolean;
  summary: string;
}

/** Deterministic catalog used by `specbridge mcp tools` and mcp doctor. */
export const TOOL_CATALOG: readonly ToolRegistryEntry[] = [
  { name: 'workspace_detect', readOnly: true, summary: 'Detect the Kiro-compatible workspace' },
  { name: 'steering_list', readOnly: true, summary: 'List steering documents' },
  { name: 'steering_read', readOnly: true, summary: 'Read one steering document by name' },
  { name: 'spec_list', readOnly: true, summary: 'List specs with status and progress' },
  { name: 'spec_read', readOnly: true, summary: 'Read canonical spec documents' },
  { name: 'spec_status', readOnly: true, summary: 'Authoritative workflow status for one spec' },
  { name: 'spec_context', readOnly: true, summary: 'Bounded agent-ready context' },
  { name: 'spec_analyze', readOnly: true, summary: 'Deterministic spec analysis' },
  { name: 'task_list', readOnly: true, summary: 'Parsed task hierarchy with evidence summaries' },
  { name: 'task_next', readOnly: true, summary: 'Next executable task or blockers' },
  { name: 'run_list', readOnly: true, summary: 'Bounded run summaries' },
  { name: 'run_read', readOnly: true, summary: 'Safe single-run summary' },
  { name: 'spec_affected', readOnly: true, summary: 'Affected-spec resolution for a change set' },
  { name: 'spec_check_drift', readOnly: true, summary: 'Deterministic drift rules (no commands)' },
  { name: 'spec_create', readOnly: false, summary: 'Preview-first offline spec creation' },
  { name: 'spec_stage_validate', readOnly: true, summary: 'Validate a stage candidate (no write)' },
  { name: 'spec_stage_apply', readOnly: false, summary: 'Apply a reviewed stage candidate atomically' },
  { name: 'spec_run_verification', readOnly: false, summary: 'Drift rules + trusted configured commands' },
  { name: 'task_begin', readOnly: false, summary: 'Begin an interactive task run (lock + snapshot)' },
  { name: 'task_complete', readOnly: false, summary: 'Finalize an interactive run with evidence' },
  { name: 'task_abort', readOnly: false, summary: 'Abort an interactive run, preserving changes' },
] as const;

export function registerAllTools(server: McpServer, context: ServerContext): void {
  registerWorkspaceDetectTool(server, context);
  registerSteeringListTool(server, context);
  registerSteeringReadTool(server, context);
  registerSpecListTool(server, context);
  registerSpecReadTool(server, context);
  registerSpecStatusTool(server, context);
  registerSpecContextTool(server, context);
  registerSpecAnalyzeTool(server, context);
  registerTaskListTool(server, context);
  registerTaskNextTool(server, context);
  registerRunListTool(server, context);
  registerRunReadTool(server, context);
  registerSpecAffectedTool(server, context);
  registerSpecCheckDriftTool(server, context);
  registerSpecCreateTool(server, context);
  registerSpecStageValidateTool(server, context);
  registerSpecStageApplyTool(server, context);
  registerSpecRunVerificationTool(server, context);
  registerTaskBeginTool(server, context);
  registerTaskCompleteTool(server, context);
  registerTaskAbortTool(server, context);
}
