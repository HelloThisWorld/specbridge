import type { Command } from 'commander';
import type { CliRuntime } from '../context.js';
import { registerPlannedCommand } from '../context.js';

/** Planned: Phase E (spec creation and approval workflow). */
export function registerSpecNewCommand(spec: Command, runtime: CliRuntime): void {
  registerPlannedCommand(spec, runtime, {
    name: 'new',
    args: '<name>',
    summary:
      'Create a new spec (--type feature|bugfix, --mode requirements-first|design-first|quick; offline template mode or runner mode)',
    phase: 'the spec-workflow phase (Phase E)',
    workaround: 'create .kiro/specs/<name>/requirements.md by hand or in Kiro; SpecBridge reads it immediately.',
  });
}
