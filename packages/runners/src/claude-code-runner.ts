import { execa } from 'execa';
import { notImplemented } from '@specbridge/core';
import type { AgentGenerationInput, AgentGenerationResult, AgentRunner } from './runner.js';

/**
 * Claude Code runner.
 *
 * v0.1 status: availability detection only. `generate` intentionally throws
 * NOT_IMPLEMENTED — generation and task execution land with the
 * runner-adapter phase (see docs/roadmap.md). We do not fake output.
 *
 * When implemented, this runner will pass context via files/stdin, never log
 * secrets, and record command/duration/exit status for every invocation.
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly name = 'claude-code';
  private readonly command: string;

  constructor(options?: { command?: string }) {
    this.command = options?.command ?? 'claude';
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
      notImplemented('Claude Code runner generation', 'the runner-adapter phase (Phase F)'),
    );
  }
}
