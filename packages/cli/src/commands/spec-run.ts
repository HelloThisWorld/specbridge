import type { Command } from 'commander';
import type { CliRuntime } from '../context.js';
import { registerPlannedCommand } from '../context.js';

/**
 * Planned: Phase G (task execution). Tasks will only ever be marked complete
 * after evidence exists — never because an agent replied "done".
 */
export function registerSpecRunCommand(spec: Command, runtime: CliRuntime): void {
  registerPlannedCommand(spec, runtime, {
    name: 'run',
    args: '<name>',
    summary: 'Execute spec tasks through a configured runner, recording evidence per task',
    phase: 'the task-execution phase (Phase G)',
    workaround:
      'use "spec context <name>" to hand full context to your agent, then update the task checkbox yourself.',
  });
}
