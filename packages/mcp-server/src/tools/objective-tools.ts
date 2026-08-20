import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  readCandidate,
  readConflicts,
  readEvaluations,
  readLatestWorkGraph,
  readProjection,
  readWorkerRecords,
  requireJobState,
} from '@specbridge/orchestration';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';

/**
 * Objective-runtime inspection tools — read-only windows into the work
 * graph, workers, candidates, and evaluations of a mission-driven job.
 * Objectives are DRIVEN by the standalone orchestrator; nothing here can
 * dispatch, approve, evaluate, or integrate anything.
 */

const jobIdArg = z.string().min(1).max(64).describe('Job id (job-…)');
const nodeIdArg = z.string().min(1).max(64).describe('Objective node id (n-…) from job_read');

export function registerObjectiveReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'objective_read',
    title: 'Read one objective’s work graph',
    description:
      'The dynamic work graph of one approved objective: units with statuses, dependencies, contract ' +
      'relevance, failures, plus open contract conflicts and worker identities. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { jobId: jobIdArg, nodeId: nodeIdArg },
    outputSchema: {
      workGraph: z.record(z.unknown()).nullable(),
      conflicts: z.array(z.record(z.unknown())),
      workers: z.array(
        z.object({
          workerId: z.string(),
          agentRole: z.string(),
          workUnitId: z.string(),
          attempt: z.number().int(),
          status: z.string(),
          workspaceIdentity: z.string(),
        }),
      ),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      requireJobState(workspace, args.jobId);
      const graph = readLatestWorkGraph(workspace, args.jobId, args.nodeId);
      const conflicts = readConflicts(workspace, args.jobId, args.nodeId);
      const workers = readWorkerRecords(workspace, args.jobId, args.nodeId).map((record) => ({
        workerId: record.workerId,
        agentRole: record.agentRole,
        workUnitId: record.workUnitId,
        attempt: record.attempt,
        status: record.status,
        workspaceIdentity: record.workspaceIdentity,
      }));
      const text =
        graph === undefined
          ? 'No work graph exists for this objective yet.'
          : graph.units
              .map((unit) => `- ${unit.workUnitId} [${unit.status}] (${unit.kind}) ${unit.title}`)
              .join('\n') + (conflicts.length > 0 ? `\n${conflicts.length} contract conflict(s) recorded.` : '');
      return {
        text,
        structured: {
          workGraph: (graph as unknown as Record<string, unknown>) ?? null,
          conflicts: conflicts as unknown as Record<string, unknown>[],
          workers,
        },
      };
    },
  });
}

export function registerWorkunitReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'workunit_read',
    title: 'Read one work unit',
    description:
      'One work unit in depth: the exact approved truth its worker saw (context projection identity), the ' +
      'candidate artifact with observed changes and local verification, and every evaluation. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      jobId: jobIdArg,
      nodeId: nodeIdArg,
      workUnitId: z.string().min(1).max(64),
      attempt: z.number().int().min(1).optional().describe('A specific attempt (default: latest)'),
    },
    outputSchema: {
      unit: z.record(z.unknown()).nullable(),
      projection: z.record(z.unknown()).nullable(),
      candidate: z.record(z.unknown()).nullable(),
      evaluations: z.array(z.record(z.unknown())),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      requireJobState(workspace, args.jobId);
      const graph = readLatestWorkGraph(workspace, args.jobId, args.nodeId);
      const unit = graph?.units.find((candidate) => candidate.workUnitId === args.workUnitId);
      const attempt = args.attempt ?? Math.max(1, unit?.attempt ?? 1);
      const projection = readProjection(workspace, args.jobId, args.nodeId, args.workUnitId, attempt);
      const candidate = readCandidate(workspace, args.jobId, args.nodeId, args.workUnitId, attempt);
      const evaluations = readEvaluations(workspace, args.jobId, args.nodeId, args.workUnitId);
      return {
        text:
          unit === undefined
            ? `Work unit ${args.workUnitId} does not exist for this objective.`
            : `${unit.workUnitId} [${unit.status}] attempt ${unit.attempt}: ` +
              `${candidate !== undefined ? `${candidate.changedFiles.length} changed file(s), local verification ${candidate.localVerification.passed ? 'passed' : 'failed'}` : 'no candidate yet'}; ` +
              `${evaluations.length} evaluation(s).`,
        structured: {
          unit: (unit as unknown as Record<string, unknown>) ?? null,
          projection: (projection as unknown as Record<string, unknown>) ?? null,
          candidate: (candidate as unknown as Record<string, unknown>) ?? null,
          evaluations: evaluations as unknown as Record<string, unknown>[],
        },
      };
    },
  });
}

export function registerEvaluationReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'evaluation_read',
    title: 'Read objective evaluations',
    description:
      'Every evaluation record of one objective (optionally one work unit): layer, verdict, named ' +
      'deterministic checks, reasons, evidence references, affected contracts. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      jobId: jobIdArg,
      nodeId: nodeIdArg,
      workUnitId: z.string().max(64).optional(),
    },
    outputSchema: { evaluations: z.array(z.record(z.unknown())) },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      requireJobState(workspace, args.jobId);
      const evaluations = readEvaluations(workspace, args.jobId, args.nodeId, args.workUnitId);
      return {
        text:
          evaluations.length === 0
            ? 'No evaluations recorded.'
            : evaluations
                .map((evaluation) => `- ${evaluation.evaluationId} [${evaluation.layer}] ${evaluation.verdict}`)
                .join('\n'),
        structured: { evaluations: evaluations as unknown as Record<string, unknown>[] },
      };
    },
  });
}
