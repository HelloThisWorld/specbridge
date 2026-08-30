import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AutonomyDeps } from '@specbridge/autonomy';
import {
  computeExecutionTelemetryReport,
  executionTelemetryReportSchema,
} from '@specbridge/autonomy';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { MCP_SERVER_VERSION } from '../version.js';
import { registerDefinedTool } from './helpers.js';
import { requireAgentConfig } from './interactive-shared.js';

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function registerJobReportTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'job_report',
    title: 'Read a Job execution report',
    description:
      'Derive versioned operational and token-conservation telemetry from durable Job, WorkUnit, ' +
      'attempt, research, cooldown, verification, and closure records. Read-only; metrics never ' +
      'grant completion or authority.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      jobId: z.string().min(1).max(64).describe('Job id (job-…) from job_list'),
    },
    outputSchema: {
      report: executionTelemetryReportSchema,
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const deps: AutonomyDeps = {
        workspace,
        config: requireAgentConfig(workspace),
        clock: context.clock,
        idFactory: context.idFactory,
        host: 'mcp',
      };
      const report = computeExecutionTelemetryReport(deps, args.jobId, {
        persist: false,
        specbridgeVersion: MCP_SERVER_VERSION,
      });
      const summary = report.qualificationSummary;
      return {
        text: [
          `Job ${report.jobId}: ${report.outcome.status} (${report.outcome.authoritativeJobStatus})`,
          `StrongBuilderAvoidanceRatio: ${percent(summary.strongBuilderAvoidanceRatio)}`,
          `Secondary initial/repair: ${percent(summary.secondaryInitialSuccessRate)} / ${percent(summary.secondaryRepairRecoveryRate)}`,
          `ResearchAvoidanceRatio: ${percent(summary.researchAvoidanceRatio)}`,
          `UsefulWorkDuringSubscriptionCooldown: ${summary.usefulWorkDuringSubscriptionCooldown}`,
          `humanInterventionsAfterSeal: ${summary.humanInterventionsAfterSeal}`,
          `CompletedWorkRedoCount: ${summary.completedWorkRedoCount}`,
          `Verification / closure: ${report.outcome.verification} / ${report.outcome.closure}`,
        ].join('\n'),
        structured: { report },
      };
    },
  });
}
