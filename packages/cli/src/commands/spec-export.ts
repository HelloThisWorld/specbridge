import type { Command } from 'commander';
import type { CliRuntime } from '../context.js';
import { registerPlannedCommand } from '../context.js';

/** Planned: export bundles for specific agent ecosystems. `spec context` covers most needs today. */
export function registerSpecExportCommand(spec: Command, runtime: CliRuntime): void {
  registerPlannedCommand(spec, runtime, {
    name: 'export',
    args: '<name>',
    summary: 'Export an agent-specific bundle (--target claude-code)',
    phase: 'a post-v0.1 phase',
    workaround: 'use "spec context <name> --target claude-code" — it produces an agent-ready document now.',
  });
}
