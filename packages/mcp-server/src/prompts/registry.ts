import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { registerStatusPrompt } from './status.js';
import { registerAuthorPrompt } from './author.js';
import { registerImplementPrompt } from './implement.js';
import { registerVerifyPrompt } from './verify.js';

/**
 * Reusable workflow prompts for MCP clients that are not Claude Code.
 *
 * Prompts are guidance only: they order the tool calls, name the explicit
 * human approval boundaries, and never claim that model output counts as
 * evidence. Stage approval is deliberately absent — it stays a human CLI
 * action in every client.
 */

export interface PromptRegistryEntry {
  name: string;
  summary: string;
}

export const PROMPT_CATALOG: readonly PromptRegistryEntry[] = [
  { name: 'specbridge-status', summary: 'Inspect workspace or spec status and the next valid step' },
  { name: 'specbridge-author-stage', summary: 'Draft, validate, review, and apply a stage candidate' },
  { name: 'specbridge-implement-task', summary: 'Implement one task through task_begin → task_complete' },
  { name: 'specbridge-verify', summary: 'Run deterministic drift checks and explain the findings' },
] as const;

export function registerAllPrompts(server: McpServer, context: ServerContext): void {
  registerStatusPrompt(server, context);
  registerAuthorPrompt(server, context);
  registerImplementPrompt(server, context);
  registerVerifyPrompt(server, context);
}
