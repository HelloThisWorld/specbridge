import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  RESEARCH_DEPTHS,
  RESEARCH_GATE_DECISIONS,
  RESEARCH_RECORD_STATUSES,
  evaluateAndRecordResearchGate,
  getResearchProviderHealth,
  listResearchRecords,
  readResearchRecord,
  researchFailureSchema,
  researchProviderHealthSchema,
  researchRecordSchema,
  researchReportSchema,
  researchRequestSchema,
  startResearch,
} from '@specbridge/orchestration';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';
import { requireAgentConfig } from './interactive-shared.js';

const requestFields = {
  researchId: z.string().min(1).max(128).optional(),
  depth: z.enum(RESEARCH_DEPTHS),
  question: z.string().min(1).max(4_000),
  topicTags: z.array(z.string().min(1).max(64)).max(16).optional(),
  knownFacts: z.array(z.string().min(1).max(2_000)).max(20).optional(),
  observedFailures: z.array(z.string().min(1).max(2_000)).max(10).optional(),
  failedStrategies: z.array(z.string().min(1).max(2_000)).max(10).optional(),
  constraints: z.array(z.string().min(1).max(2_000)).max(20).optional(),
  contextRefs: z.array(z.string().min(1).max(512)).max(20).optional(),
  questionsToAnswer: z.array(z.string().min(1).max(1_000)).min(1).max(12),
  preferPrimarySources: z.boolean().optional(),
  requireSources: z.boolean().optional(),
  operationId: z.string().min(1).max(128).optional(),
  jobId: z.string().min(1).max(128).optional(),
};

const listSummarySchema = z.object({
  researchId: z.string(),
  provider: z.string(),
  depth: z.enum(RESEARCH_DEPTHS),
  status: z.enum(RESEARCH_RECORD_STATUSES),
  question: z.string(),
  topicTags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function serviceDeps(context: ServerContext) {
  const workspace = context.requireWorkspace();
  return {
    workspace,
    config: requireAgentConfig(workspace),
    clock: context.clock,
  };
}

export function registerResearchGateTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'research_gate',
    title: 'Evaluate the research escalation gate',
    description:
      'Apply the deterministic, zero-model-call ResearchGate to structured caller signals. ' +
      'Human authority and repository truth win; research is reserved for material external ' +
      'uncertainty. Records aggregate decision telemetry but creates no product authority.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      knowledgeGapDeclared: z.boolean(),
      dependsOnExternalFacts: z.boolean(),
      dependsOnCurrentFacts: z.boolean(),
      materialToProductOrArchitecture: z.boolean(),
      repositoryAnswerAvailable: z.boolean(),
      priorResearchAvailable: z.boolean(),
      engineeringDecisionOnly: z.boolean(),
      requiresHumanAuthority: z.boolean(),
      repeatedUnknown: z.boolean().optional(),
      repeatedUnknownAfterDifferentStrategies: z.boolean().optional(),
      requestedDepth: z.enum(RESEARCH_DEPTHS).optional(),
    },
    outputSchema: {
      decision: z.enum(RESEARCH_GATE_DECISIONS),
      reasons: z.array(z.string()),
    },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const result = evaluateAndRecordResearchGate(serviceDeps(context), {
          ...args,
          repeatedUnknown: args.repeatedUnknown ?? false,
          repeatedUnknownAfterDifferentStrategies:
            args.repeatedUnknownAfterDifferentStrategies ?? false,
        });
        return {
          text: `${result.decision}: ${result.reasons.join('; ')}`,
          structured: result,
        };
      }),
  });
}

export function registerResearchStartTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'research_start',
    title: 'Run one bounded research request',
    description:
      'Explicitly execute or exactly reuse one bounded provider-neutral research request. ' +
      'Research must be enabled, is budgeted and durable, and returns evidence only: it cannot ' +
      'approve a contract, Mission, task, compatibility promise, or completion outcome.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: requestFields,
    outputSchema: {
      ok: z.boolean(),
      reused: z.boolean().optional(),
      record: researchRecordSchema.optional(),
      report: researchReportSchema.optional(),
      failure: researchFailureSchema.optional(),
    },
    handler: async (args, extras) =>
      context.withWriteLock(async () => {
        const request = researchRequestSchema.parse({
          researchId: args.researchId ?? `research-${context.idFactory()}`,
          depth: args.depth,
          question: args.question,
          topicTags: args.topicTags ?? [],
          context: {
            knownFacts: args.knownFacts ?? [],
            observedFailures: args.observedFailures ?? [],
            failedStrategies: args.failedStrategies ?? [],
            constraints: args.constraints ?? [],
            contextRefs: args.contextRefs ?? [],
          },
          expectedOutput: { questionsToAnswer: args.questionsToAnswer },
          sourcePolicy: {
            preferPrimarySources: args.preferPrimarySources ?? true,
            requireSources: args.requireSources ?? true,
          },
        });
        const result = await startResearch(
          serviceDeps(context),
          request,
          {
            ...(args.operationId !== undefined ? { operationId: args.operationId } : {}),
            ...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
          },
          extras.signal,
        );
        return result.ok
          ? {
              text: result.reused
                ? `Reused research ${result.record.researchId}; no provider call was made.`
                : `Research ${result.record.researchId} finished ${result.record.status}. Evidence is not authority.`,
              structured: {
                ok: true,
                reused: result.reused,
                record: result.record,
                report: result.report,
              },
            }
          : {
              text: `Research did not produce a report: ${result.failure.classification} — ${result.failure.message}`,
              structured: {
                ok: false,
                failure: result.failure,
                ...(result.record !== undefined ? { record: result.record } : {}),
              },
            };
      }),
  });
}

export function registerResearchGetTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'research_get',
    title: 'Read one durable research record',
    description: 'Read one durable ResearchRecord. Read-only; the record is evidence and cannot confer authority.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { researchId: z.string().min(1).max(128) },
    outputSchema: { found: z.boolean(), record: researchRecordSchema.optional(), problem: z.string().optional() },
    handler: async (args) => {
      const read = readResearchRecord(context.requireWorkspace(), args.researchId);
      if (read.kind === 'ok') {
        return { text: `Research ${args.researchId}: ${read.record.status}.`, structured: { found: true, record: read.record } };
      }
      const problem =
        read.kind === 'missing'
          ? 'not found'
          : read.kind === 'unsupported-version'
            ? `unsupported schema ${read.version}`
            : `corrupt record preserved at ${read.file}`;
      return { text: `Research ${args.researchId}: ${problem}.`, structured: { found: false, problem } };
    },
  });
}

export function registerResearchListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'research_list',
    title: 'List durable research records',
    description: 'List bounded ResearchRecord summaries and diagnostics; corrupt records are skipped and preserved.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      status: z.enum(RESEARCH_RECORD_STATUSES).optional(),
      topicTag: z.string().min(1).max(64).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    outputSchema: {
      records: z.array(listSummarySchema),
      diagnostics: z.array(z.object({ code: z.string(), message: z.string(), file: z.string().optional() })),
    },
    handler: async (args) => {
      const listed = listResearchRecords(context.requireWorkspace());
      const records = listed.records
        .filter((record) => args.status === undefined || record.status === args.status)
        .filter((record) => args.topicTag === undefined || record.topicTags.includes(args.topicTag))
        .slice(0, args.limit ?? 50)
        .map((record) => ({
          researchId: record.researchId,
          provider: record.provider,
          depth: record.depth,
          status: record.status,
          question: record.request.question,
          topicTags: record.topicTags,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }));
      return {
        text: `${records.length} durable research record(s).`,
        structured: {
          records,
          diagnostics: listed.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            ...(diagnostic.file !== undefined ? { file: diagnostic.file } : {}),
          })),
        },
      };
    },
  });
}

export function registerResearchProviderStatusTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'research_provider_status',
    title: 'Check research provider health',
    description:
      'Perform only the provider health check. If research or its provider is disabled, returns ' +
      'configuration status without making a network request.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {},
    outputSchema: {
      researchEnabled: z.boolean(),
      providerEnabled: z.boolean(),
      health: researchProviderHealthSchema,
    },
    handler: async (_args, extras) => {
      const deps = serviceDeps(context);
      const health = await getResearchProviderHealth(deps, extras.signal);
      const policy = deps.config.research;
      const providerEnabled =
        policy.provider === 'deerflow' && policy.providers.deerflow.enabled;
      return {
        text: `Research ${policy.enabled ? 'enabled' : 'disabled'}; ${health.provider} health: ${health.status}.`,
        structured: { researchEnabled: policy.enabled, providerEnabled, health },
      };
    },
  });
}
