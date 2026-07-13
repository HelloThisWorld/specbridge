import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from './context.js';
import { registerAllPrompts } from './prompts/registry.js';
import { registerAllResources } from './resources/registry.js';
import { registerAllTools } from './tools/registry.js';
import { MCP_SERVER_NAME, MCP_SERVER_TITLE, MCP_SERVER_VERSION } from './version.js';

/**
 * Server assembly.
 *
 * All SDK-specific wiring lives here and in the small tool/resource/prompt
 * adapters; application logic stays in the shared SpecBridge packages.
 * Protocol capabilities and version negotiation are handled entirely by the
 * official SDK — nothing in this package touches JSON-RPC framing.
 */

export function buildMcpServer(context: ServerContext): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      title: MCP_SERVER_TITLE,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: { logging: {} },
      instructions:
        'SpecBridge exposes existing .kiro specs: read-only inspection tools, validated stage ' +
        'authoring (validate → human review → apply), the interactive task lifecycle ' +
        '(task_begin → the CURRENT session edits source → task_complete), and deterministic drift ' +
        'verification. Stage approval is intentionally not exposed as a tool: a human approves via ' +
        'the SpecBridge CLI. Task completion is decided by Git evidence and trusted verification ' +
        'commands, never by model claims.',
    },
  );

  registerAllTools(server, context);
  registerAllResources(server, context);
  registerAllPrompts(server, context);

  return server;
}
