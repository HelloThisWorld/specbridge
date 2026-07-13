import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerContext } from '../context.js';

/** Build a single-user-message prompt result and log the request. */
export function promptResult(
  context: ServerContext,
  name: string,
  description: string,
  text: string,
): GetPromptResult {
  context.logger.info('prompt_requested', { prompt: name });
  return {
    description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}
