import type { Command } from 'commander';
import type { ConcreteSpecType, ConcreteWorkflowMode } from '@specbridge/core';
import { CLI_BIN, SpecBridgeError } from '@specbridge/core';
import type { SpecCreationPlan } from '@specbridge/workflow';
import { createSpec, planSpecCreation } from '@specbridge/workflow';
import {
  createJsonReport,
  dim,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec new <name>` — create a Kiro-compatible spec from offline
 * templates. No model, no network, no API key. Creation is atomic: a failure
 * leaves no partial spec directory behind.
 */

const SPEC_TYPES: ConcreteSpecType[] = ['feature', 'bugfix'];
const WORKFLOW_MODES: ConcreteWorkflowMode[] = ['requirements-first', 'design-first', 'quick'];

interface SpecNewOptions {
  type: string;
  mode: string;
  title?: string;
  description?: string;
  fromFile?: string;
  dryRun?: boolean;
  json?: boolean;
}

function planToJson(plan: SpecCreationPlan, dryRun: boolean): unknown {
  return createJsonReport('specbridge.spec-new/1', `${CLI_BIN} ${VERSION}`, {
    dryRun,
    created: !dryRun,
    specName: plan.specName,
    specType: plan.specType,
    workflowMode: plan.mode,
    title: plan.title,
    dir: plan.dir,
    files: plan.files.map((file) => ({
      fileName: file.fileName,
      stage: file.stage,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      content: file.content,
    })),
    state: plan.state,
    statePath: plan.statePath,
  });
}

function printPlanSummary(runtime: CliRuntime, plan: SpecCreationPlan, dryRun: boolean): void {
  const workspace = runtime.workspace();
  runtime.out(reportTitle(dryRun ? `Dry run — nothing was written` : `Created spec: ${plan.specName}`));
  runtime.out();
  runtime.out(`  Name:  ${plan.specName}`);
  runtime.out(`  Type:  ${plan.specType}`);
  runtime.out(`  Mode:  ${plan.mode}`);
  runtime.out(`  Title: ${plan.title}`);
  runtime.out(`  Dir:   ${relPath(workspace, plan.dir)}`);
  runtime.out();
  runtime.out(sectionTitle(dryRun ? 'Files that would be created' : 'Files created'));
  for (const file of plan.files) {
    runtime.out(okLine(`${relPath(workspace, plan.dir)}/${file.fileName}`, `(${Buffer.byteLength(file.content, 'utf8')} B)`));
  }
  runtime.out(okLine(relPath(workspace, plan.statePath), '(sidecar workflow state)'));
  runtime.out();

  if (dryRun) {
    runtime.out(sectionTitle('Rendered content'));
    for (const file of plan.files) {
      runtime.out(dim(`--- ${file.fileName} ---`));
      runtime.outRaw(file.content);
    }
    runtime.out(dim(`--- sidecar state (${relPath(workspace, plan.statePath)}) ---`));
    runtime.outRaw(`${JSON.stringify(plan.state, null, 2)}\n`);
    return;
  }

  runtime.out(sectionTitle('Next steps'));
  const firstStage = plan.state.specType === 'bugfix' ? 'bugfix' : plan.mode === 'design-first' ? 'design' : 'requirements';
  runtime.out(`  1. Replace the template placeholders in ${firstStage}.md with real content.`);
  runtime.out(`  2. ${CLI_BIN} spec analyze ${plan.specName} --stage ${firstStage}`);
  runtime.out(`  3. ${CLI_BIN} spec approve ${plan.specName} --stage ${firstStage}`);
  runtime.out(`  4. ${CLI_BIN} spec status ${plan.specName}`);
}

export function registerSpecNewCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('new <name>')
    .description('Create a new Kiro-compatible spec from offline templates (no model required)')
    .option('--type <type>', `spec type: ${SPEC_TYPES.join(' | ')}`, 'feature')
    .option(
      '--mode <mode>',
      `workflow mode: ${WORKFLOW_MODES.join(' | ')}`,
      'requirements-first',
    )
    .option('--title <text>', 'human-readable title (default: derived from the spec name)')
    .option('--description <text>', 'initial description inserted into the first document')
    .option('--from-file <path>', 'read the description from a UTF-8 file inside the workspace')
    .option('--dry-run', 'print everything that would be created without writing any file')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
The spec is created under .kiro/specs/<name>/ and stays fully Kiro-compatible:
no front matter, no tool metadata. Workflow state (approvals) lives in
.specbridge/state/specs/<name>.json.

Spec names use lowercase words separated by single hyphens: notification-preferences,
auth-v2, payment-retry.

Examples:
  ${CLI_BIN} spec new notification-preferences
  ${CLI_BIN} spec new notification-preferences --mode requirements-first --title "Notification Preferences"
  ${CLI_BIN} spec new cache-fallback --type bugfix --description "Fix stale cache fallback after upstream timeout"
  ${CLI_BIN} spec new payment-retry --mode quick --from-file feature-description.md
  ${CLI_BIN} spec new payment-retry --dry-run`,
    )
    .action((name: string, options: SpecNewOptions) => {
      if (!SPEC_TYPES.includes(options.type as ConcreteSpecType)) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `Unknown --type "${options.type}". Valid types: ${SPEC_TYPES.join(', ')}.`,
        );
      }
      if (!WORKFLOW_MODES.includes(options.mode as ConcreteWorkflowMode)) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `Unknown --mode "${options.mode}". Valid modes: ${WORKFLOW_MODES.join(', ')}.`,
        );
      }

      const workspace = runtime.workspace();
      const request = {
        name,
        specType: options.type as ConcreteSpecType,
        mode: options.mode as ConcreteWorkflowMode,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.fromFile !== undefined ? { fromFile: options.fromFile } : {}),
        cwd: runtime.cwd,
      };
      const clock = (): Date => runtime.now();

      if (options.dryRun === true) {
        const plan = planSpecCreation(workspace, request, clock);
        if (options.json === true) {
          runtime.outRaw(serializeJsonReport(planToJson(plan, true)));
        } else {
          printPlanSummary(runtime, plan, true);
        }
        return;
      }

      const result = createSpec(workspace, request, clock);
      if (options.json === true) {
        runtime.outRaw(serializeJsonReport(planToJson(result.plan, false)));
        return;
      }
      printPlanSummary(runtime, result.plan, false);
    });
}
