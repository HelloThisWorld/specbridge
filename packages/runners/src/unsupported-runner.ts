import type { Diagnostic } from '@specbridge/core';
import { notImplemented } from '@specbridge/core';
import type {
  AgentRunner,
  RunnerDetectionContext,
  RunnerDetectionResult,
  RunnerExecutionOptions,
  StageGenerationInput,
  StageGenerationResult,
  TaskExecutionInput,
  TaskExecutionResult,
} from './contract.js';
import { runSafeProcess } from './safe-process.js';

/**
 * Honest stub for runners on the roadmap but not implemented in v0.3
 * (codex, ollama, openai-compatible). Detection reports `unavailable` with
 * an explanation; execution refuses with NOT_IMPLEMENTED. Nothing here
 * pretends to work.
 */
export class UnsupportedRunner implements AgentRunner {
  readonly name: string;
  readonly kind = 'unsupported';
  private readonly detectCommand: string | undefined;
  private readonly plannedFor: string;

  constructor(name: string, options: { detectCommand?: string; plannedFor: string }) {
    this.name = name;
    this.detectCommand = options.detectCommand;
    this.plannedFor = options.plannedFor;
  }

  async detect(_context: RunnerDetectionContext): Promise<RunnerDetectionResult> {
    const diagnostics: Diagnostic[] = [];
    if (this.detectCommand !== undefined) {
      const probe = await runSafeProcess({
        executable: this.detectCommand,
        argv: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      if (probe.status === 'ok') {
        diagnostics.push({
          severity: 'info',
          code: 'RUNNER_EXECUTABLE_PRESENT',
          message: `The "${this.detectCommand}" executable is installed, but SpecBridge does not implement ${this.name} execution yet.`,
        });
      }
    }
    diagnostics.push({
      severity: 'info',
      code: 'RUNNER_NOT_IMPLEMENTED',
      message: `The ${this.name} runner is not implemented in v0.3. It is planned for ${this.plannedFor}.`,
    });
    return {
      runner: this.name,
      kind: this.kind,
      status: 'unavailable',
      authentication: 'not-applicable',
      capabilities: [],
      diagnostics,
    };
  }

  generateStage(
    _input: StageGenerationInput,
    _execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult> {
    return Promise.reject(notImplemented(`The ${this.name} runner`, this.plannedFor));
  }

  executeTask(
    _input: TaskExecutionInput,
    _execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return Promise.reject(notImplemented(`The ${this.name} runner`, this.plannedFor));
  }
}
