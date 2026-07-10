import { execa } from 'execa';
import { notImplemented } from '@specbridge/core';
import type { AgentGenerationInput, AgentGenerationResult, AgentRunner } from './runner.js';

/**
 * Codex CLI runner.
 *
 * v0.1 status: availability detection only. `generate` intentionally throws
 * NOT_IMPLEMENTED — see docs/roadmap.md. Same safety requirements as the
 * Claude Code runner apply when implemented.
 */
export class CodexRunner implements AgentRunner {
  readonly name = 'codex';
  private readonly command: string;

  constructor(options?: { command?: string }) {
    this.command = options?.command ?? 'codex';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await execa(this.command, ['--version'], {
        timeout: 10_000,
        reject: false,
        stdin: 'ignore',
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  generate(_input: AgentGenerationInput): Promise<AgentGenerationResult> {
    return Promise.reject(
      notImplemented('Codex runner generation', 'the runner-adapter phase (Phase F)'),
    );
  }
}
