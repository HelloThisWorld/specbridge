import type { Command } from 'commander';
import type { CliRuntime } from '../context.js';
import { registerPlannedCommand } from '../context.js';

/** Planned: Phase H (report-only by default; --apply requires deterministic evidence). */
export function registerSpecSyncCommand(spec: Command, runtime: CliRuntime): void {
  registerPlannedCommand(spec, runtime, {
    name: 'sync',
    args: '<name>',
    summary: 'Detect whether tasks appear implemented based on repository evidence (report-only by default)',
    phase: 'the sync-and-drift phase (Phase H)',
  });
}
