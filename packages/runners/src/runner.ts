import { SpecBridgeError } from '@specbridge/core';

/**
 * Runner adapters make SpecBridge model- and agent-agnostic. A runner wraps
 * one way of invoking an AI coding agent (a local CLI, a local model, an
 * HTTP API). Default SpecBridge commands never require a runner; runner
 * execution is always explicit.
 *
 * Safety requirements for every implementation:
 *   - never log secrets or environment variables
 *   - never execute commands suggested by model output
 *   - record command, duration, and exit status for auditability
 */

export interface AgentGenerationInput {
  kind: 'requirements' | 'design' | 'tasks' | 'bugfix' | 'free-form';
  specName: string;
  prompt: string;
  /** Pre-assembled context (e.g. from `specbridge spec context`). */
  contextMarkdown?: string;
}

export interface AgentGenerationResult {
  runner: string;
  content: string;
  durationMs: number;
  meta?: Record<string, unknown>;
}

export interface TaskExecutionInput {
  specName: string;
  taskId: string;
  contextMarkdown: string;
  workingDirectory: string;
}

export interface TaskExecutionResult {
  runner: string;
  exitCode: number | undefined;
  durationMs: number;
  /** Paths of artifacts the runner produced (transcripts, patches). */
  artifacts: string[];
}

export interface AgentRunner {
  readonly name: string;

  isAvailable(): Promise<boolean>;

  generate(input: AgentGenerationInput): Promise<AgentGenerationResult>;

  executeTask?(input: TaskExecutionInput): Promise<TaskExecutionResult>;
}

export class RunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  register(runner: AgentRunner): void {
    this.runners.set(runner.name, runner);
  }

  get(name: string): AgentRunner {
    const runner = this.runners.get(name);
    if (runner === undefined) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Unknown runner "${name}". Registered runners: ${[...this.runners.keys()].join(', ')}.`,
      );
    }
    return runner;
  }

  has(name: string): boolean {
    return this.runners.has(name);
  }

  list(): AgentRunner[] {
    return [...this.runners.values()];
  }
}
