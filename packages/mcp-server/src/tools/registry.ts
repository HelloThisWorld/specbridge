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
import {
  registerOrchestrationAssessIntentTool,
  registerOrchestrationBeginTool,
  registerOrchestrationCheckpointTool,
  registerOrchestrationClarifyTool,
  registerOrchestrationFinalizeTool,
  registerOrchestrationRecordActionTool,
  registerOrchestrationResolveClarificationTool,
  registerOrchestrationReviewPlanTool,
  registerOrchestrationStatusTool,
  registerOrchestrationSubmitPlanTool,
} from './orchestration-tools.js';
import { registerJobCancelTool, registerJobListTool, registerJobReadTool } from './job-tools.js';
import {
  registerContractChangeRequestTool,
  registerContractListTool,
  registerContractReadTool,
  registerMissionAnswerTool,
  registerMissionAssessTool,
  registerMissionBeginTool,
  registerMissionQuestionsTool,
  registerMissionReadTool,
  registerMissionRecordTurnTool,
  registerMissionStatusTool,
  registerMissionSynthesizeTool,
} from './mission-tools.js';
import {
  registerSpecIntakeAnswerTool,
  registerSpecIntakeReadTool,
  registerSpecIntakeStartTool,
} from './intake-tools.js';
import {
  registerRepositoryInspectTool,
  registerWorkspaceBootstrapTool,
  registerWorkspaceSnapshotTool,
} from './workspace-bootstrap.js';
import {
  registerEvaluationReadTool,
  registerObjectiveReadTool,
  registerWorkunitReadTool,
} from './objective-tools.js';

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
  { name: 'orchestration_status', readOnly: true, summary: 'Governed orchestration state, freshness, and next safe action' },
  { name: 'orchestration_begin', readOnly: false, summary: 'Begin a governed orchestration run' },
  { name: 'orchestration_assess_intent', readOnly: false, summary: 'Validate a structured intent assessment' },
  { name: 'orchestration_clarify', readOnly: false, summary: 'Record a bounded round of targeted questions' },
  { name: 'orchestration_resolve_clarification', readOnly: false, summary: 'Record structured clarification decisions' },
  { name: 'orchestration_submit_plan', readOnly: false, summary: 'Validate and store a context-bound execution plan' },
  { name: 'orchestration_review_plan', readOnly: false, summary: 'Record the user plan-review decision (hash-bound)' },
  { name: 'orchestration_record_action', readOnly: false, summary: 'Record one bounded iteration; get the next directive' },
  { name: 'orchestration_checkpoint', readOnly: false, summary: 'Write a compact structured checkpoint' },
  { name: 'orchestration_finalize', readOnly: false, summary: 'Close a run (completion needs verified evidence)' },
  { name: 'job_list', readOnly: true, summary: 'List long-running orchestration jobs' },
  { name: 'job_read', readOnly: true, summary: 'One job in depth: graph, attempts, questions, checkpoint' },
  { name: 'job_cancel', readOnly: false, summary: 'Cancel a job (final, idempotent, evidence preserved)' },
  { name: 'mission_begin', readOnly: false, summary: 'Begin Mission Discovery from a product direction' },
  { name: 'mission_status', readOnly: true, summary: 'List missions with lifecycle status and readiness' },
  { name: 'mission_read', readOnly: true, summary: 'One mission in depth (facts, decisions, coverage, artifacts)' },
  { name: 'mission_record_turn', readOnly: false, summary: 'Persist one user-visible discovery turn (provenance root)' },
  { name: 'mission_assess', readOnly: false, summary: 'Record a governed structured discovery assessment' },
  { name: 'mission_questions', readOnly: true, summary: 'Open discovery questions with materiality' },
  { name: 'mission_answer', readOnly: false, summary: 'Record the user’s answer to one discovery question' },
  { name: 'mission_synthesize', readOnly: false, summary: 'Compile contracts into Kiro spec candidates (approval stays human)' },
  { name: 'contract_list', readOnly: true, summary: 'Product contract registry and constitution' },
  { name: 'contract_read', readOnly: true, summary: 'One product contract in depth (any revision)' },
  { name: 'contract_change_request', readOnly: false, summary: 'Raise a contract change request (human decides it)' },
  { name: 'objective_read', readOnly: true, summary: 'One objective’s work graph, conflicts, and workers' },
  { name: 'workunit_read', readOnly: true, summary: 'One work unit: projection identity, candidate, evaluations' },
  { name: 'evaluation_read', readOnly: true, summary: 'Evaluation records of one objective or work unit' },
  // vNext.10.1 Zero-Touch Spec Intake. There is deliberately no
  // `spec_intake_approve`: approving a discovered specification authorizes an
  // unattended build, and that authority is CLI-only, exactly like
  // `autonomy seal` and `mission ccr`.
  { name: 'spec_intake_start', readOnly: false, summary: 'Ingest a product specification and run repository-grounded discovery' },
  { name: 'spec_intake_read', readOnly: true, summary: 'One spec intake: questions, refusals, delta authority, approval summary' },
  { name: 'spec_intake_answer', readOnly: false, summary: 'Record the user’s answer to one product question' },
  // Workspace Bootstrap (vNext.10.2 Phase 1): the repository-aware starting
  // point of a product conversation. Reads the repository and existing
  // product truth; creates no product authority.
  { name: 'workspace_bootstrap', readOnly: false, summary: 'Build or revalidate the CurrentSystemSnapshot' },
  { name: 'workspace_snapshot', readOnly: true, summary: 'Current-system summary with an explicit freshness verdict' },
  { name: 'repository_inspect', readOnly: true, summary: 'Bounded repository sections for a deeper implementation question' },
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
  registerOrchestrationStatusTool(server, context);
  registerOrchestrationBeginTool(server, context);
  registerOrchestrationAssessIntentTool(server, context);
  registerOrchestrationClarifyTool(server, context);
  registerOrchestrationResolveClarificationTool(server, context);
  registerOrchestrationSubmitPlanTool(server, context);
  registerOrchestrationReviewPlanTool(server, context);
  registerOrchestrationRecordActionTool(server, context);
  registerOrchestrationCheckpointTool(server, context);
  registerOrchestrationFinalizeTool(server, context);
  registerJobListTool(server, context);
  registerJobReadTool(server, context);
  registerJobCancelTool(server, context);
  registerMissionBeginTool(server, context);
  registerMissionStatusTool(server, context);
  registerMissionReadTool(server, context);
  registerMissionRecordTurnTool(server, context);
  registerMissionAssessTool(server, context);
  registerMissionQuestionsTool(server, context);
  registerMissionAnswerTool(server, context);
  registerMissionSynthesizeTool(server, context);
  registerContractListTool(server, context);
  registerContractReadTool(server, context);
  registerContractChangeRequestTool(server, context);
  registerSpecIntakeStartTool(server, context);
  registerSpecIntakeReadTool(server, context);
  registerSpecIntakeAnswerTool(server, context);
  registerWorkspaceBootstrapTool(server, context);
  registerWorkspaceSnapshotTool(server, context);
  registerRepositoryInspectTool(server, context);
  registerObjectiveReadTool(server, context);
  registerWorkunitReadTool(server, context);
  registerEvaluationReadTool(server, context);
}
