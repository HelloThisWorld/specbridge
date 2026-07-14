import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, STAGE_NAMES, SpecBridgeError } from '@specbridge/core';
import { authorStage } from '@specbridge/execution';
import type { CliRuntime } from '../context.js';
import { loadExecutionContext, parseTimeout } from '../execution-context.js';
import { renderAuthoringOutcome } from '../authoring-view.js';
import { parseStageOption } from './spec-generate.js';

/**
 * `specbridge spec refine <name> --stage <stage> --instruction <text>` —
 * model-assisted refinement of an existing draft stage. Shows a unified
 * diff, validates deterministically, writes atomically, and invalidates
 * dependent approvals. Approved stages are never refined in place.
 */

interface SpecRefineOptions {
  stage?: string;
  instruction?: string;
  instructionFile?: string;
  runner?: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
  showRunnerPlan?: boolean;
  timeout?: string;
}

const MAX_INSTRUCTION_BYTES = 256 * 1024;

function resolveInstruction(runtime: CliRuntime, options: SpecRefineOptions): string {
  if (options.instruction !== undefined && options.instructionFile !== undefined) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      'Use either --instruction or --instruction-file, not both.',
    );
  }
  if (options.instruction !== undefined) {
    if (options.instruction.trim().length === 0) {
      throw new SpecBridgeError('INVALID_ARGUMENT', 'The --instruction text must not be empty.');
    }
    return options.instruction;
  }
  if (options.instructionFile !== undefined) {
    const filePath = path.resolve(runtime.cwd, options.instructionFile);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (cause) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Could not read --instruction-file ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_INSTRUCTION_BYTES) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `The instruction file exceeds ${MAX_INSTRUCTION_BYTES} bytes.`,
      );
    }
    if (content.trim().length === 0) {
      throw new SpecBridgeError('INVALID_ARGUMENT', 'The instruction file is empty.');
    }
    return content;
  }
  throw new SpecBridgeError(
    'INVALID_ARGUMENT',
    'Refinement needs an instruction: pass --instruction "<text>" or --instruction-file <path>.',
  );
}

export function registerSpecRefineCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('refine <name>')
    .description('Refine an existing draft stage with a configured agent runner')
    .requiredOption('--stage <stage>', `stage to refine: ${STAGE_NAMES.join(' | ')}`)
    .option('--instruction <text>', 'refinement instruction')
    .option('--instruction-file <path>', 'file containing the refinement instruction')
    .option('--runner <profile>', 'runner profile to use (default: operation default, then config defaultRunner)')
    .option('--dry-run', 'plan only: print the prompt and invocation, invoke nothing, write nothing')
    .option('--show-runner-plan', 'print the capability-checked runner plan before the result')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'print the unified diff and extra warnings')
    .option('--timeout <duration>', 'runner timeout (e.g. 90s, 15m)')
    .addHelpText(
      'after',
      `
Refinement loads the current document, applies your instruction through the
runner, prints a unified diff, validates the candidate deterministically,
and writes atomically. The original file is retained in the run directory.
Approvals that depended on the refined stage are invalidated (files stay).

An approved stage cannot be refined — revoke its approval first.

Exit codes: 0 applied · 1 gate/invalid candidate · 2 usage ·
3 runner unavailable · 4 runner failure · 5 timeout/cancel · 6 permission.

Examples:
  ${CLI_BIN} spec refine notification-preferences --stage requirements \\
    --instruction "Add explicit behavior for email delivery failures."
  ${CLI_BIN} spec refine notification-preferences --stage design --instruction-file notes.md --dry-run`,
    )
    .action(async (name: string, options: SpecRefineOptions) => {
      const stage = parseStageOption(options.stage);
      const instruction = resolveInstruction(runtime, options);
      const context = loadExecutionContext(runtime);
      const outcome = await authorStage(
        {
          workspace: context.workspace,
          config: context.config,
          registry: context.registry,
          clock: () => runtime.now(),
        },
        {
          specName: name,
          stage,
          intent: 'refine',
          instruction,
          ...(options.runner !== undefined ? { runnerName: options.runner } : {}),
          ...(options.timeout !== undefined ? { timeoutMs: parseTimeout(options.timeout) } : {}),
          ...(options.dryRun === true ? { dryRun: true } : {}),
        },
      );
      // Refinement always shows the diff (that is its point) unless --json.
      renderAuthoringOutcome(runtime, context.workspace, name, stage, outcome, {
        ...(options.json !== undefined ? { json: options.json } : {}),
        verbose: options.verbose === true || outcome.kind === 'applied',
        ...(options.showRunnerPlan !== undefined ? { showRunnerPlan: options.showRunnerPlan } : {}),
        schema: 'specbridge.spec-refine/1',
      });
    });
}
