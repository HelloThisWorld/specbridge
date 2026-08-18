import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import type { JobDeps, JobState } from '@specbridge/orchestration';
import {
  cancelJob,
  listJobs,
  readJobCheckpoint,
  readJobEvents,
  requireGraphRevision,
  requireJobState,
} from '@specbridge/orchestration';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';
import { requireAgentConfig } from './interactive-shared.js';

/**
 * Long-running job tools (v1.2) — thin adapters over @specbridge/orchestration.
 *
 * Deliberately narrow: jobs are DRIVEN by the standalone orchestrator
 * (`specbridge orchestrate run`), a foreground persistent process — not by
 * an MCP host holding a conversation open. The MCP surface therefore only
 * inspects jobs and records the one explicitly-final human action
 * (cancellation). No tool here can dispatch a worker, approve a plan,
 * advance the scheduler, or complete a task.
 */

function jobDeps(context: ServerContext, workspace: WorkspaceInfo): JobDeps {
  return {
    workspace,
    config: requireAgentConfig(workspace),
    clock: context.clock,
    idFactory: context.idFactory,
    host: 'mcp',
  };
}

const jobIdArg = z.string().min(1).max(64).describe('Job id (job-…) from job_list or the CLI');

const jobSummaryShape = {
  jobId: z.string(),
  specName: z.string(),
  status: z.string(),
  graphRevision: z.number().int(),
  currentNodeId: z.string().optional(),
  agentRuns: z.number().int(),
  jobReplans: z.number().int(),
  escalations: z.number().int(),
  openQuestions: z.number().int(),
  blockerCode: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finalOutcome: z.string().optional(),
};

function toJobSummary(job: JobState) {
  return {
    jobId: job.jobId,
    specName: job.specName,
    status: job.status,
    graphRevision: job.graphRevision,
    ...(job.currentNodeId !== undefined ? { currentNodeId: job.currentNodeId } : {}),
    agentRuns: job.counters.agentRuns,
    jobReplans: job.counters.jobReplans,
    escalations: job.counters.escalations,
    openQuestions: job.openQuestions.length,
    ...(job.blocker !== undefined ? { blockerCode: job.blocker.code } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.finalOutcome !== undefined ? { finalOutcome: job.finalOutcome } : {}),
  };
}

// ---------------------------------------------------------------------------
// job_list
// ---------------------------------------------------------------------------

export function registerJobListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'job_list',
    title: 'List orchestration jobs',
    description:
      'List long-running orchestration jobs (newest first) with status, budgets consumed, and blockers. ' +
      'Jobs are driven by `specbridge orchestrate run`, not from MCP. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      specName: z.string().max(120).optional().describe('Only jobs for this spec'),
      activeOnly: z.boolean().optional().describe('Only jobs that are not finished'),
    },
    outputSchema: {
      jobs: z.array(z.object(jobSummaryShape)),
      diagnostics: z.array(z.object({ code: z.string(), message: z.string() })),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const listed = listJobs(workspace);
      const jobs = listed.jobs
        .filter((job) => {
          if (args.specName !== undefined && job.specName !== args.specName) return false;
          if (args.activeOnly === true && job.finalizedAt !== undefined) return false;
          return true;
        })
        .slice(0, 100)
        .map(toJobSummary);
      const text =
        jobs.length === 0
          ? 'No orchestration jobs match. Start one with `specbridge orchestrate run <spec>`.'
          : jobs
              .map(
                (job) =>
                  `- ${job.jobId} ${job.status} (${job.specName}, ${job.agentRuns} agent runs, ${job.openQuestions} open question(s))`,
              )
              .join('\n');
      return {
        text,
        structured: {
          jobs,
          diagnostics: listed.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
          })),
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// job_read
// ---------------------------------------------------------------------------

export function registerJobReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'job_read',
    title: 'Read one orchestration job',
    description:
      'Read one job in detail: runtime graph nodes with statuses, attempts, plans, diagnoses, ' +
      'escalations, open questions, the latest checkpoint, and recent events. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      jobId: jobIdArg,
      eventLimit: z.number().int().min(1).max(200).optional().describe('Recent events to include (default 20)'),
    },
    outputSchema: {
      job: z.object(jobSummaryShape),
      goal: z.string(),
      nodes: z.array(
        z.object({
          nodeId: z.string(),
          taskId: z.string(),
          title: z.string(),
          status: z.string(),
          complexity: z.string().optional(),
          planRevision: z.number().int(),
          planApproved: z.boolean(),
          humanReviewRequired: z.boolean(),
          attempts: z.number().int(),
          repairCycles: z.number().int(),
          replans: z.number().int(),
          latestFailureCategory: z.string().optional(),
          latestDiagnosisAction: z.string().optional(),
        }),
      ),
      openQuestions: z.array(z.object({ id: z.string(), question: z.string(), whyItMatters: z.string() })),
      blocker: z
        .object({ category: z.string(), code: z.string(), message: z.string(), remediation: z.array(z.string()) })
        .optional(),
      nextAction: z.string(),
      events: z.array(z.object({ at: z.string(), type: z.string() })),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const job = requireJobState(workspace, args.jobId);
      const graph =
        job.graphRevision > 0 ? requireGraphRevision(workspace, args.jobId, job.graphRevision) : undefined;
      const checkpoint = readJobCheckpoint(workspace, args.jobId);
      const events = readJobEvents(workspace, args.jobId, { limit: args.eventLimit ?? 20 });

      const nodes = (graph?.nodes ?? []).map((node) => ({
        nodeId: node.nodeId,
        taskId: node.parentTaskId,
        title: node.title.slice(0, 200),
        status: node.status,
        ...(node.complexity !== undefined ? { complexity: node.complexity } : {}),
        planRevision: node.planRevision,
        planApproved: node.planApproved,
        humanReviewRequired: node.humanReviewRequired,
        attempts: node.attempts.length,
        repairCycles: node.repairCycles,
        replans: node.replans,
        ...(node.latestFailure !== undefined ? { latestFailureCategory: node.latestFailure.category } : {}),
        ...(node.latestDiagnosis !== undefined
          ? { latestDiagnosisAction: node.latestDiagnosis.recommendedAction }
          : {}),
      }));

      const text = [
        `Job ${job.jobId}: ${job.status} (${job.specName})`,
        ...(job.blocker !== undefined ? [`Blocker [${job.blocker.code}]: ${job.blocker.message}`] : []),
        ...job.openQuestions.map((question) => `Question ${question.id}: ${question.question}`),
        ...nodes.map(
          (node) => `- ${node.nodeId} ${node.status} task ${node.taskId} (plan r${node.planRevision})`,
        ),
        ...(checkpoint !== undefined ? [`Next action: ${checkpoint.nextAction}`] : []),
      ].join('\n');

      return {
        text,
        structured: {
          job: toJobSummary(job),
          goal: job.goal,
          nodes,
          openQuestions: job.openQuestions.map((question) => ({
            id: question.id,
            question: question.question,
            whyItMatters: question.whyItMatters,
          })),
          ...(job.blocker !== undefined
            ? {
                blocker: {
                  category: job.blocker.category,
                  code: job.blocker.code,
                  message: job.blocker.message,
                  remediation: job.blocker.remediation,
                },
              }
            : {}),
          nextAction: checkpoint?.nextAction ?? 'Run `specbridge orchestrate run` to continue.',
          events: events.events.map((event) => ({
            at: String(event['at'] ?? ''),
            type: String(event['type'] ?? ''),
          })),
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// job_cancel
// ---------------------------------------------------------------------------

export function registerJobCancelTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'job_cancel',
    title: 'Cancel an orchestration job',
    description:
      'Cancel a long-running job. Final and idempotent: a cancelled job is never restarted ' +
      'automatically, and all evidence is preserved. This is the only mutating job tool — ' +
      'jobs are driven and resumed from the CLI, never from MCP.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      jobId: jobIdArg,
      reason: z.string().min(1).max(500).describe('Why the job is being cancelled (recorded)'),
    },
    outputSchema: {
      jobId: z.string(),
      status: z.string(),
      alreadyFinal: z.boolean(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const before = requireJobState(workspace, args.jobId);
      const alreadyFinal = before.finalizedAt !== undefined;
      const job = cancelJob(jobDeps(context, workspace), args.jobId, args.reason);
      return {
        text: alreadyFinal
          ? `Job ${job.jobId} was already ${job.status}; nothing changed.`
          : `Job ${job.jobId} is now ${job.status}. Evidence and source changes are preserved.`,
        structured: { jobId: job.jobId, status: job.status, alreadyFinal },
      };
    },
  });
}
