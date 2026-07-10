import { notImplemented } from '@specbridge/core';
import type { AgentGenerationInput, AgentGenerationResult, AgentRunner } from './runner.js';

/**
 * STUB — intentionally not implemented.
 *
 * Placeholder for a runner speaking an OpenAI-compatible chat-completions
 * API (many local and hosted models expose this shape). Registered so
 * `--runner openai-compatible` fails honestly. No fake implementation; see
 * docs/runner-adapters.md for status. API keys, when this lands, will come
 * from the environment and never be logged or stored.
 */
export class OpenAiCompatibleRunnerStub implements AgentRunner {
  readonly name = 'openai-compatible';

  isAvailable(): Promise<boolean> {
    // Not implemented — therefore never available.
    return Promise.resolve(false);
  }

  generate(_input: AgentGenerationInput): Promise<AgentGenerationResult> {
    return Promise.reject(
      notImplemented('OpenAI-compatible runner', 'a post-v0.1 runner-adapter phase'),
    );
  }
}
