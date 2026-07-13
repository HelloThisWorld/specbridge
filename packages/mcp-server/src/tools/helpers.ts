import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape, objectOutputType, ZodTypeAny } from 'zod';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { toErrorEnvelope } from '../errors.js';
import { assertStructuredSize } from '../limits.js';

/**
 * Shared tool plumbing.
 *
 * Every SpecBridge tool goes through `defineTool`, which provides:
 *   - versioned Zod input/output schemas (validated by the SDK layer)
 *   - explicit MCP tool annotations
 *   - a human-readable text block plus structured content on success
 *   - the stable SBMCP error envelope (`isError: true`) on failure —
 *     never a protocol error, never a stack trace
 *   - structured-response size enforcement before serialization
 *   - tool_started / tool_completed / tool_failed / tool_cancelled logging
 */

/** The per-request extras a handler may use (subset of the SDK's shape). */
export interface ToolRequestExtras {
  signal: AbortSignal;
  requestId: string | number;
}

export interface ToolSuccess<TStructured> {
  /** Concise human-readable summary (first content block). */
  text: string;
  /** Deterministic structured content matching the output schema. */
  structured: TStructured;
}

export interface ToolDefinition<TInput extends ZodRawShape, TOutput extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations & {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  inputSchema: TInput;
  outputSchema: TOutput;
  handler: (
    args: objectOutputType<TInput, ZodTypeAny>,
    extras: ToolRequestExtras,
  ) => Promise<ToolSuccess<objectOutputType<TOutput, ZodTypeAny>>>;
}

/** Error envelope shape reused by every tool's failure path. */
export const toolErrorShape = {
  error: z
    .object({
      code: z.string(),
      category: z.string(),
      message: z.string(),
      remediation: z.array(z.string()),
      details: z.record(z.unknown()),
    })
    .describe('Stable SBMCP error envelope (present only on failures)'),
};

export function registerDefinedTool<TInput extends ZodRawShape, TOutput extends ZodRawShape>(
  server: McpServer,
  context: ServerContext,
  definition: ToolDefinition<TInput, TOutput>,
): void {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: definition.annotations,
    },
    (async (
      args: objectOutputType<TInput, ZodTypeAny>,
      extra: { signal: AbortSignal; requestId: string | number },
    ): Promise<CallToolResult> => {
      const startedAt = Date.now();
      context.logger.info('tool_started', { tool: definition.name, requestId: extra.requestId });
      try {
        const success = await definition.handler(args, {
          signal: extra.signal,
          requestId: extra.requestId,
        });
        assertStructuredSize(definition.name, success.structured);
        context.logger.info('tool_completed', {
          tool: definition.name,
          requestId: extra.requestId,
          durationMs: Date.now() - startedAt,
        });
        return {
          content: [{ type: 'text', text: success.text }],
          structuredContent: success.structured as Record<string, unknown>,
        };
      } catch (cause) {
        if (extra.signal.aborted) {
          context.logger.info('tool_cancelled', {
            tool: definition.name,
            requestId: extra.requestId,
            durationMs: Date.now() - startedAt,
          });
        }
        const envelope = toErrorEnvelope(cause);
        context.logger.warn('tool_failed', {
          tool: definition.name,
          requestId: extra.requestId,
          durationMs: Date.now() - startedAt,
          errorCode: envelope.code,
        });
        if (context.logger.level === 'debug' && cause instanceof Error && cause.stack !== undefined) {
          context.logger.debug('tool_failure_stack', {
            tool: definition.name,
            stack: cause.stack,
          });
        }
        const remediation =
          envelope.remediation.length > 0
            ? `\nRemediation:\n${envelope.remediation.map((step) => `  - ${step}`).join('\n')}`
            : '';
        return {
          content: [
            {
              type: 'text',
              text: `${envelope.code} (${envelope.category}): ${envelope.message}${remediation}`,
            },
          ],
          structuredContent: { error: envelope } as unknown as Record<string, unknown>,
          isError: true,
        };
      }
      // The SDK's ToolCallback generic is stricter than necessary for our
      // uniform wrapper; the runtime contract above matches it exactly.
    }) as never,
  );
}
