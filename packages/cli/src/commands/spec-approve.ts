import type { Command } from 'commander';
import type { CliRuntime } from '../context.js';
import { registerPlannedCommand } from '../context.js';

/** Planned: Phase E. Approvals will live in .specbridge/state, never in .kiro files. */
export function registerSpecApproveCommand(spec: Command, runtime: CliRuntime): void {
  registerPlannedCommand(spec, runtime, {
    name: 'approve',
    args: '<name>',
    summary: 'Record requirements/design approval in sidecar state (.specbridge/state)',
    phase: 'the spec-workflow phase (Phase E)',
  });
}
