import type { Command } from 'commander';
import type { CliRuntime } from '../context.js';
import { registerPlannedCommand } from '../context.js';

/** Planned: Phase E (spec creation and approval workflow). */
export function registerSpecAnalyzeCommand(spec: Command, runtime: CliRuntime): void {
  registerPlannedCommand(spec, runtime, {
    name: 'analyze',
    args: '<name>',
    summary: 'Analyze a spec for gaps and inconsistencies before approval',
    phase: 'the spec-workflow phase (Phase E)',
    workaround: 'use "spec show <name>" — it already reports structure, progress, and diagnostics.',
  });
}
