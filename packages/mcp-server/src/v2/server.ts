import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  DESIGN_STAGES,
  SpecBridgeError,
} from '@specbridge/core';
import type { ResearchReport } from '@specbridge/core';
import { DesignService, isDesignStage } from '@specbridge/design';
import type { ModelEvaluationFinding } from '@specbridge/design';

type Shape = Record<string, z.ZodTypeAny>;

export const DESIGN_TOOL_NAMES = [
  'workspace_detect',
  'workspace_bootstrap',
  'design_start',
  'design_read',
  'design_answer',
  'design_research',
  'design_generate',
  'design_evaluate',
  'design_approve',
  'spec_list',
  'spec_read',
] as const;

function response(value: unknown, summary: string): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent:
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { result: value },
  };
}

function failure(cause: unknown): CallToolResult {
  const error =
    cause instanceof SpecBridgeError
      ? {
          code: cause.code,
          message: cause.message,
          details: cause.details,
        }
      : {
          code: 'INTERNAL_ERROR',
          message: cause instanceof Error ? cause.message : String(cause),
          details: {},
        };
  return {
    content: [{ type: 'text', text: error.code + ': ' + error.message }],
    structuredContent: { error },
    isError: true,
  };
}

function register(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Shape,
  readOnly: boolean,
  handler: (input: Record<string, unknown>) => unknown | Promise<unknown>,
): void {
  server.registerTool(
    name,
    {
      title: name
        .split('_')
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(' '),
      description,
      inputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: false,
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    },
    (async (input: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await handler(input);
        return response(result, name + ' completed.');
      } catch (cause) {
        return failure(cause);
      }
    }) as never,
  );
}

export function buildMcpServer(rootDir: string): McpServer {
  const service = new DesignService({ rootDir });
  const server = new McpServer(
    {
      name: 'specbridge',
      title: 'SpecBridge AI System Design and Spec Compiler',
      version: '2.0.0',
    },
    {
      instructions:
        'SpecBridge turns rough ideas into repository-grounded, research-backed, implementation-ready Spec Packs. ' +
        'It designs and evaluates specifications only. It never launches coding agents, owns worktrees, schedules workers, or supervises implementation.',
    },
  );

  register(
    server,
    'workspace_detect',
    'Detect the current repository and whether SpecBridge 2.0 design state exists.',
    {},
    true,
    () => ({
      rootDir: service.rootDir,
      version: '2.0.0',
      designSessions: service.list().length,
      specs: service.listSpecs().length,
    }),
  );

  register(
    server,
    'workspace_bootstrap',
    'Build a bounded, evidence-backed CurrentSystemSnapshot and deterministic repository index.',
    {
      maxFiles: z.number().int().positive().max(100_000).optional(),
      maxFileBytes: z.number().int().positive().max(5_000_000).optional(),
    },
    false,
    (input) =>
      service.bootstrap({
        ...(typeof input['maxFiles'] === 'number' ? { maxFiles: input['maxFiles'] } : {}),
        ...(typeof input['maxFileBytes'] === 'number'
          ? { maxFileBytes: input['maxFileBytes'] }
          : {}),
      }),
  );

  register(
    server,
    'design_start',
    'Start a DesignSession from a rough product idea after repository bootstrap.',
    {
      title: z.string().min(1),
      idea: z.string().min(1),
    },
    false,
    (input) => service.start(String(input['title']), String(input['idea'])),
  );

  register(
    server,
    'design_read',
    'Read one DesignSession, its pending product decisions, next stage, and bounded repository context.',
    { subject: z.string().min(1) },
    true,
    (input) => service.read(String(input['subject'])),
  );

  register(
    server,
    'design_answer',
    'Record the human answer to one genuine product decision.',
    {
      subject: z.string().min(1),
      decisionId: z.string().min(1),
      answer: z.string().min(1),
    },
    false,
    (input) =>
      service.answer(
        String(input['subject']),
        String(input['decisionId']),
        String(input['answer']),
      ),
  );

  register(
    server,
    'design_research',
    'Persist one provider-neutral ResearchReport with findings, citations, implications, and unresolved facts.',
    {
      subject: z.string().min(1),
      report: z.record(z.unknown()),
    },
    false,
    (input) =>
      service.recordResearch(
        String(input['subject']),
        input['report'] as unknown as ResearchReport,
      ),
  );

  register(
    server,
    'design_generate',
    'Validate and persist exactly one structured system-design stage. Stages must be supplied in order.',
    {
      subject: z.string().min(1),
      stage: z.enum(DESIGN_STAGES),
      output: z.record(z.unknown()),
    },
    false,
    (input) => {
      const stage = String(input['stage']);
      if (!isDesignStage(stage)) {
        throw new SpecBridgeError('INVALID_DESIGN_STAGE', 'Unknown design stage.', { stage });
      }
      return service.recordStage(String(input['subject']), stage, input['output']);
    },
  );

  register(
    server,
    'design_evaluate',
    'Run deterministic checks plus optional model-assisted semantic findings for quality, traceability, contradictions, security, reliability, and readiness.',
    {
      subject: z.string().min(1),
      modelFindings: z
        .array(
          z.object({
            dimension: z.enum([
              'COMPLETENESS',
              'GROUNDING',
              'PRODUCT_CLARITY',
              'ARCHITECTURE_COHERENCE',
              'TRADE_OFF_QUALITY',
              'RESEARCH_COVERAGE',
              'SECURITY',
              'RELIABILITY',
              'IMPLEMENTATION_READINESS',
              'ACCEPTANCE_COVERAGE',
              'OPEN_RISKS',
            ]),
            severity: z.enum(['WARN', 'FAIL']),
            message: z.string().min(1),
            references: z.array(z.string().min(1)),
          }),
        )
        .optional(),
    },
    false,
    (input) =>
      service.evaluate(
        String(input['subject']),
        (input['modelFindings'] ?? []) as ModelEvaluationFinding[],
      ),
  );

  register(
    server,
    'design_approve',
    'Record the human natural-language approval and compile the portable Spec Pack when evaluation passes.',
    {
      subject: z.string().min(1),
      approvalText: z.string().min(1),
      approvedBy: z.string().min(1).optional(),
    },
    false,
    (input) =>
      service.approve(
        String(input['subject']),
        String(input['approvalText']),
        typeof input['approvedBy'] === 'string' ? input['approvedBy'] : 'human',
      ),
  );

  register(
    server,
    'spec_list',
    'List compiled, portable Spec Packs.',
    {},
    true,
    () => ({ specs: service.listSpecs() }),
  );

  register(
    server,
    'spec_read',
    'Read a Spec Pack manifest or one manifest-referenced document.',
    {
      name: z.string().min(1),
      document: z.string().min(1).optional(),
    },
    true,
    (input) =>
      service.readSpec(
        String(input['name']),
        typeof input['document'] === 'string' ? input['document'] : undefined,
      ),
  );

  return server;
}
