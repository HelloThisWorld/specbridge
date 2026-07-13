import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { trySha256File } from '@specbridge/core';
import type { SpecEvaluationBundle } from '../schemas/spec-views.js';
import type { ServerContext } from '../context.js';
import { capDiagnostics } from '../limits.js';
import { diagnosticShape, specNameArg, toDiagnosticViews } from '../schemas/common.js';
import { evaluateSpecBundle, specSummaryShape, toSpecSummary } from '../schemas/spec-views.js';
import { registerDefinedTool } from './helpers.js';

/**
 * spec_status — the authoritative workflow state for one spec, computed
 * exactly the way the CLI computes it (recorded approvals re-checked
 * against current file bytes, never inferred, never repaired).
 */

const stageShape = z.object({
  stage: z.enum(['requirements', 'bugfix', 'design', 'tasks']),
  stored: z.enum(['blocked', 'draft', 'approved']),
  effective: z.enum([
    'blocked',
    'draft',
    'approved',
    'modified-after-approval',
    'stale-prerequisite',
  ]),
  file: z.string().describe('Repository-relative stage file path'),
  fileExists: z.boolean(),
  approvedAt: z.string().nullable(),
  approvedHash: z.string().nullable(),
  currentHash: z.string().nullable(),
  checkboxProgressOnly: z.boolean().optional(),
  prerequisites: z.array(z.string()),
});

const outputSchema = {
  summary: specSummaryShape,
  stages: z.array(stageShape),
  staleStages: z.array(z.string()),
  invalidatedStages: z.array(z.string()),
  diagnostics: z.array(diagnosticShape),
  diagnosticsDropped: z.number().int(),
  suggestedNextActions: z.array(z.string()),
};

/** Deterministic next-step guidance shared by spec_status and prompts. */
export function suggestNextActions(bundle: SpecEvaluationBundle): string[] {
  const { analysis, evaluation } = bundle;
  const name = analysis.folder.name;
  if (evaluation === undefined) {
    return [
      `Spec "${name}" is unmanaged (no SpecBridge state). Approving a stage initializes state: run the approval command (human action).`,
      `Inspect the documents first with spec_read or spec_analyze.`,
    ];
  }
  const actions: string[] = [];
  for (const stale of [...evaluation.staleStages, ...evaluation.invalidatedStages]) {
    actions.push(
      `Stage "${stale}" approval is stale; review the changes (spec_read) and re-approve it (human action via the CLI).`,
    );
  }
  if (actions.length > 0) return actions;

  if (evaluation.effectiveStatus === 'READY_FOR_IMPLEMENTATION') {
    const progress = analysis.taskProgress;
    if (progress.completed < progress.total) {
      actions.push(`All stages are approved. Start the next task with task_begin (spec "${name}").`);
    } else {
      actions.push(`All required tasks are complete. Check drift with spec_check_drift.`);
    }
    return actions;
  }

  const nextDraft = evaluation.stages.find((stage) => stage.effective === 'draft');
  if (nextDraft !== undefined) {
    actions.push(
      `Stage "${nextDraft.stage}" is in draft. Author it (spec_stage_validate + spec_stage_apply), then a human approves it via the CLI.`,
    );
  } else {
    actions.push(`Inspect stage prerequisites with spec_status; no stage is currently editable.`);
  }
  return actions;
}

export function registerSpecStatusTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'spec_status',
    title: 'Spec workflow status',
    description:
      'Authoritative workflow state for one spec: per-stage approval status with recorded and current ' +
      'hashes, stale-approval detection, task progress, diagnostics, and the next valid workflow step. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { specName: specNameArg },
    outputSchema,
    handler: async (args) => {
      const { workspace, analysis } = context.requireSpecAnalysis(args.specName);
      const bundle = evaluateSpecBundle(workspace, analysis);
      const summary = toSpecSummary(bundle);

      const stages =
        bundle.evaluation?.stages.map((stage) => ({
          stage: stage.stage,
          stored: stage.stored.status,
          effective: stage.effective,
          file: stage.stored.file,
          fileExists: stage.fileExists,
          approvedAt: stage.stored.approvedAt,
          approvedHash: stage.stored.approvedHash,
          currentHash: stage.currentHash ?? trySha256File(stage.filePath) ?? null,
          ...(stage.checkboxProgressOnly === true ? { checkboxProgressOnly: true } : {}),
          prerequisites: stage.prerequisites,
        })) ?? [];

      const allDiagnostics = [
        ...analysis.diagnostics,
        ...(bundle.evaluation?.diagnostics ?? []),
      ];
      const capped = capDiagnostics(toDiagnosticViews(workspace, allDiagnostics));
      const suggestedNextActions = suggestNextActions(bundle);

      const stageLines = stages.map((stage) => `  ${stage.stage}: ${stage.effective}`);
      const text = [
        `Spec "${summary.name}" (${summary.type}, ${summary.workflowMode}) — status ${summary.workflowStatus}, approvals ${summary.approvalHealth}.`,
        stages.length > 0 ? `Stages:\n${stageLines.join('\n')}` : 'No SpecBridge workflow state (unmanaged spec).',
        `Tasks: ${summary.taskProgress.completed}/${summary.taskProgress.total} required complete.`,
        `Next: ${suggestedNextActions[0] ?? '(no suggestion)'}`,
      ].join('\n');

      return {
        text,
        structured: {
          summary,
          stages,
          staleStages: bundle.evaluation?.staleStages ?? [],
          invalidatedStages: bundle.evaluation?.invalidatedStages ?? [],
          diagnostics: capped.items,
          diagnosticsDropped: capped.dropped,
          suggestedNextActions,
        },
      };
    },
  });
}
