import type { Command } from 'commander';
import type { CliRuntime } from '../context.js';
import { registerPlannedCommand } from '../context.js';

/**
 * Planned: Phase H (deterministic spec-drift verification; no LLM).
 * The underlying checks already exist as a tested library in
 * @specbridge/drift — this command wires them to live git repositories.
 */
export function registerSpecVerifyCommand(spec: Command, runtime: CliRuntime): void {
  registerPlannedCommand(spec, runtime, {
    name: 'verify',
    args: '[name]',
    summary: 'Deterministically verify spec-to-code alignment against a git diff (CI quality gate)',
    phase: 'the sync-and-drift phase (Phase H)',
    workaround: 'the deterministic checks are available today as the @specbridge/drift library.',
  });
}
