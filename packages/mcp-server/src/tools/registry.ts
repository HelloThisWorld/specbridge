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
import { registerRunnerListTool } from './runner-list.js';
import { registerRunnerShowTool } from './runner-show.js';
import { registerRunnerDoctorTool } from './runner-doctor.js';
import { registerRunnerMatrixTool } from './runner-matrix.js';
import { registerTemplateListTool } from './template-list.js';
import { registerTemplateSearchTool } from './template-search.js';
import { registerTemplateShowTool } from './template-show.js';
import { registerTemplatePreviewTool } from './template-preview.js';
import { registerTemplateApplyTool } from './template-apply.js';
import {
  registerExtensionDoctorTool,
  registerExtensionListTool,
  registerExtensionSearchTool,
  registerExtensionShowTool,
} from './extension-tools.js';
import {
  registerRegistryListTool,
  registerRegistrySearchTool,
  registerRegistryShowTool,
} from './registry-tools.js';

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
  { name: 'runner_list', readOnly: true, summary: 'Runner profiles with capabilities and availability' },
  { name: 'runner_show', readOnly: true, summary: 'One runner profile in depth (redacted)' },
  { name: 'runner_doctor', readOnly: true, summary: 'Runner diagnostics (never a model request)' },
  { name: 'runner_matrix', readOnly: true, summary: 'Authoritative runner capability matrix' },
  { name: 'template_list', readOnly: true, summary: 'List built-in and project spec templates' },
  { name: 'template_search', readOnly: true, summary: 'Deterministic local template search' },
  { name: 'template_show', readOnly: true, summary: 'One template in depth (variables, files, README)' },
  { name: 'template_preview', readOnly: true, summary: 'Render a template without writing (candidate hash)' },
  { name: 'spec_create', readOnly: false, summary: 'Preview-first offline spec creation' },
  { name: 'template_apply', readOnly: false, summary: 'Hash-bound spec creation from a reviewed template' },
  { name: 'spec_stage_validate', readOnly: true, summary: 'Validate a stage candidate (no write)' },
  { name: 'spec_stage_apply', readOnly: false, summary: 'Apply a reviewed stage candidate atomically' },
  { name: 'spec_run_verification', readOnly: false, summary: 'Drift rules + trusted configured commands' },
  { name: 'task_begin', readOnly: false, summary: 'Begin an interactive task run (lock + snapshot)' },
  { name: 'task_complete', readOnly: false, summary: 'Finalize an interactive run with evidence' },
  { name: 'task_abort', readOnly: false, summary: 'Abort an interactive run, preserving changes' },
  { name: 'extension_list', readOnly: true, summary: 'List installed extensions with status' },
  { name: 'extension_search', readOnly: true, summary: 'Offline extension search (installed + cached registries)' },
  { name: 'extension_show', readOnly: true, summary: 'One extension in depth (permissions, hash, grant)' },
  { name: 'extension_doctor', readOnly: true, summary: 'Extension health check (bounded no-op handshake)' },
  { name: 'registry_list', readOnly: true, summary: 'List configured extension registries' },
  { name: 'registry_search', readOnly: true, summary: 'Offline registry index search' },
  { name: 'registry_show', readOnly: true, summary: 'Registry metadata for one extension (no download)' },
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
  registerRunnerListTool(server, context);
  registerRunnerShowTool(server, context);
  registerRunnerDoctorTool(server, context);
  registerRunnerMatrixTool(server, context);
  registerTemplateListTool(server, context);
  registerTemplateSearchTool(server, context);
  registerTemplateShowTool(server, context);
  registerTemplatePreviewTool(server, context);
  registerSpecCreateTool(server, context);
  registerTemplateApplyTool(server, context);
  registerSpecStageValidateTool(server, context);
  registerSpecStageApplyTool(server, context);
  registerSpecRunVerificationTool(server, context);
  registerTaskBeginTool(server, context);
  registerTaskCompleteTool(server, context);
  registerTaskAbortTool(server, context);
  registerExtensionListTool(server, context);
  registerExtensionSearchTool(server, context);
  registerExtensionShowTool(server, context);
  registerExtensionDoctorTool(server, context);
  registerRegistryListTool(server, context);
  registerRegistrySearchTool(server, context);
  registerRegistryShowTool(server, context);
}
