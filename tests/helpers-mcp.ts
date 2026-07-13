import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ServerContext, buildMcpServer, createLogger } from '@specbridge/mcp-server';
import type { LogFields } from '@specbridge/mcp-server';
import { idCounter, tickingClock } from './helpers-execution.js';

/**
 * In-memory MCP test session: the real server implementation connected to
 * the official SDK client over linked in-memory transports. No process, no
 * network, no model.
 */

export interface CapturedLog {
  line: string;
}

export interface McpTestSession {
  client: Client;
  context: ServerContext;
  logs: CapturedLog[];
  close: () => Promise<void>;
}

export interface ConnectMcpOptions {
  clock?: () => Date;
  idFactory?: () => string;
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}

export async function connectMcp(
  projectRoot: string,
  options: ConnectMcpOptions = {},
): Promise<McpTestSession> {
  const logs: CapturedLog[] = [];
  const logger = createLogger({
    level: options.logLevel ?? 'info',
    json: true,
    sink: (line) => logs.push({ line }),
  });
  const context = new ServerContext({
    projectRoot,
    logger,
    clock: options.clock ?? tickingClock(),
    idFactory: options.idFactory ?? idCounter('mcp-run'),
  });
  const server = buildMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'specbridge-tests', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    context,
    logs,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Unwrap a tool result into text + structured content + error envelope. */
export interface UnwrappedToolResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
  errorCode?: string;
}

export function unwrapResult(result: CallToolResult): UnwrappedToolResult {
  const first = result.content?.[0];
  const text = first !== undefined && first.type === 'text' ? first.text : '';
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  const error = structured['error'] as { code?: string } | undefined;
  return {
    isError: result.isError === true,
    text,
    structured,
    ...(error?.code !== undefined ? { errorCode: error.code } : {}),
  };
}

/** Call a tool and unwrap the result. */
export async function callTool(
  session: McpTestSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<UnwrappedToolResult> {
  const result = (await session.client.callTool({ name, arguments: args })) as CallToolResult;
  return unwrapResult(result);
}

/** Parse the JSON log lines captured from the server (structured stderr). */
export function parsedLogs(session: McpTestSession): ({ event?: string } & LogFields)[] {
  return session.logs.map((entry) => JSON.parse(entry.line) as { event?: string } & LogFields);
}

/** Text of the first content entry of a resource read (asserting it is text). */
export function resourceText(result: { contents: unknown[] }): string {
  const first = result.contents[0] as { text?: string; mimeType?: string } | undefined;
  if (first?.text === undefined) throw new Error('resource returned no text content');
  return first.text;
}
