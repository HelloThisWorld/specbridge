import { notImplemented } from '@specbridge/core';
import type { AgentGenerationInput, AgentGenerationResult, AgentRunner } from './runner.js';

/**
 * STUB — intentionally not implemented.
 *
 * Placeholder for a local-model runner speaking the Ollama HTTP API. It is
 * registered so `--runner ollama` gives an honest "not implemented" error
 * instead of a confusing "unknown runner". There is no fake implementation
 * here and there never will be; see docs/runner-adapters.md for status.
 */
export class OllamaRunnerStub implements AgentRunner {
  readonly name = 'ollama';

  isAvailable(): Promise<boolean> {
    // Not implemented — therefore never available.
    return Promise.resolve(false);
  }

  generate(_input: AgentGenerationInput): Promise<AgentGenerationResult> {
    return Promise.reject(notImplemented('Ollama runner', 'a post-v0.1 runner-adapter phase'));
  }
}
