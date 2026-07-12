import type { Command } from 'commander';
import type { StageName } from '@specbridge/core';
import { CLI_BIN, STAGE_NAMES, SpecBridgeError } from '@specbridge/core';
import { authorStage } from '@specbridge/execution';
import type { CliRuntime } from '../context.js';
import {
  loadExecutionContext,
  parsePositiveInt,
  parsePositiveNumber,
  parseTimeout,
} from '../execution-context.js';
import { renderAuthoringOutcome } from '../authoring-view.js';

/**
 * `specbridge spec generate <name> --stage <stage>` — model-assisted stage
 * authoring. The runner drafts; SpecBridge validates deterministically and
 * writes atomically. Generated stages are always DRAFT.
 */

interface SpecGenerateOptions {
  stage?: string;
  runner?: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
  model?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  timeout?: string;
}

export function parseStageOption(stage: string | undefined): StageName {
  if (stage === undefined || !STAGE_NAMES.includes(stage as StageName)) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Unknown --stage "${stage ?? ''}". Valid stages: ${STAGE_NAMES.join(', ')}.`,
    );
  }
  return stage as StageName;
}

export function registerSpecGenerateCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('generate <name>')
    .description('Generate one spec stage with a configured agent runner (result stays draft)')
    .requiredOption('--stage <stage>', `stage to generate: ${STAGE_NAMES.join(' | ')}`)
    .option('--runner <name>', 'runner to use (default: config defaultRunner)')
    .option('--dry-run', 'plan only: print the prompt and invocation, invoke nothing, write nothing')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include diffs and extra warnings')
    .option('--model <model>', 'model override passed to the runner')
    .option('--max-turns <number>', 'maximum agent turns for this run')
    .option('--max-budget-usd <number>', 'maximum budget for this run (when supported)')
    .option('--timeout <duration>', 'runner timeout (e.g. 90s, 15m)')
    .addHelpText(
      'after',
      `
Workflow prerequisites (enforced; nothing is auto-approved):
  requirements-first  requirements while draft → design needs approved
                      requirements → tasks needs approved requirements+design
  design-first        design while draft → requirements needs approved design
  quick               requirements/design in either order; tasks may use the
                      current (even unapproved) documents
  bugfix              bugfix first → design → tasks

An approved stage is never overwritten — revoke the approval first.
Requirements/bugfix generation gives the runner read-only tools (Read, Glob,
Grep); design/tasks generation allows repository inspection only. SpecBridge
validates the generated Markdown deterministically; invalid candidates are
kept under .specbridge/runs/<run-id>/ and NOT applied.

Exit codes: 0 applied · 1 workflow gate or invalid candidate · 2 usage ·
3 runner unavailable · 4 runner failure · 5 timeout/cancel · 6 permission.

Examples:
  ${CLI_BIN} spec generate notification-preferences --stage requirements --runner claude-code
  ${CLI_BIN} spec generate notification-preferences --stage design
  ${CLI_BIN} spec generate notification-preferences --stage tasks --dry-run`,
    )
    .action(async (name: string, options: SpecGenerateOptions) => {
      const stage = parseStageOption(options.stage);
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
          intent: 'generate',
          ...(options.runner !== undefined ? { runnerName: options.runner } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.maxTurns !== undefined
            ? { maxTurns: parsePositiveInt('--max-turns', options.maxTurns) }
            : {}),
          ...(options.maxBudgetUsd !== undefined
            ? { maxBudgetUsd: parsePositiveNumber('--max-budget-usd', options.maxBudgetUsd) }
            : {}),
          ...(options.timeout !== undefined ? { timeoutMs: parseTimeout(options.timeout) } : {}),
          ...(options.dryRun === true ? { dryRun: true } : {}),
        },
      );
      renderAuthoringOutcome(runtime, context.workspace, name, stage, outcome, {
        ...(options.json !== undefined ? { json: options.json } : {}),
        ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
        schema: 'specbridge.spec-generate/1',
      });
    });
}
