import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { StageName } from '@specbridge/core';
import { CLI_BIN, STAGE_NAMES, SpecBridgeError } from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { readSpecState } from '@specbridge/core';
import type { ExtensionAnalysisRun } from '@specbridge/extensions';
import { runAnalyzerExtension } from '@specbridge/extensions';
import type { WorkflowEvaluation } from '@specbridge/workflow';
import {
  analyzeSpecWorkflow,
  evaluateWorkflow,
  isStageApplicable,
  applicableStages,
} from '@specbridge/workflow';
import {
  createJsonReport,
  dim,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  severityLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec analyze <name>` — deterministic, offline spec analysis.
 * No model is involved: the same bytes always produce the same findings.
 * Exit codes: 0 no errors, 1 errors (or warnings with --strict), 2 usage.
 */

const STAGE_CHOICES = [...STAGE_NAMES, 'all'] as const;

interface SpecAnalyzeOptions {
  stage: string;
  json?: boolean;
  strict?: boolean;
  extension: string[];
}

function collectExtension(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerSpecAnalyzeCommand(spec: Command, runtime: CliRuntime): void {
  spec
    .command('analyze <name>')
    .description('Analyze a spec for structural and consistency problems (deterministic, offline)')
    .option('--stage <stage>', `stage to analyze: ${STAGE_CHOICES.join(' | ')}`, 'all')
    .option('--strict', 'treat warnings as failures (exit 1)')
    .option(
      '--extension <extension-id>',
      'also run an installed, enabled analyzer extension (repeatable)',
      collectExtension,
      [],
    )
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Findings come in three levels: error (blocks approval), warning (reported,
never blocks unless --strict), and info. Placeholders left over from
generated templates are errors for active stages and warnings for stages
still blocked behind an unapproved prerequisite.

Exit codes: 0 no errors · 1 errors found (or warnings with --strict) · 2 usage/runtime error.

Examples:
  ${CLI_BIN} spec analyze notification-preferences
  ${CLI_BIN} spec analyze notification-preferences --stage requirements
  ${CLI_BIN} spec analyze login-timeout-fix --stage bugfix --json
  ${CLI_BIN} spec analyze notification-preferences --strict`,
    )
    .action(async (name: string, options: SpecAnalyzeOptions) => {
      if (!STAGE_CHOICES.includes(options.stage as (typeof STAGE_CHOICES)[number])) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `Unknown --stage "${options.stage}". Valid stages: ${STAGE_CHOICES.join(', ')}.`,
        );
      }

      const workspace = runtime.workspace();
      const folder = requireSpec(workspace, name);
      const spec = analyzeSpec(workspace, folder);

      const stateRead = readSpecState(workspace, folder.name);
      let evaluation: WorkflowEvaluation | undefined;
      if (stateRead.state !== undefined) {
        evaluation = evaluateWorkflow(workspace, stateRead.state);
      }

      let stages: StageName[] | undefined;
      if (options.stage !== 'all') {
        const stage = options.stage as StageName;
        const specType = stateRead.state?.specType ?? (spec.classification.type === 'bugfix' ? 'bugfix' : 'feature');
        if (!isStageApplicable(specType, stage)) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `Stage "${stage}" does not apply to a ${specType} spec. Applicable stages: ${applicableStages(specType).join(', ')}.`,
          );
        }
        stages = [stage];
      }

      const result = analyzeSpecWorkflow(spec, evaluation, stages);

      // Explicitly requested analyzer extensions run after built-in analysis.
      // Their diagnostics are namespaced and additive: they never replace or
      // overwrite built-in findings and carry no approval authority.
      const specType =
        stateRead.state?.specType ?? (spec.classification.type === 'bugfix' ? 'bugfix' : 'feature');
      const workflowMode = stateRead.state?.workflowMode ?? 'requirements-first';
      const extensionRuns: ExtensionAnalysisRun[] = [];
      const extensionFailures: Array<{ extensionId: string; message: string }> = [];
      for (const extensionId of options.extension) {
        for (const stage of result.stages) {
          if (!stage.fileExists) {
            continue;
          }
          try {
            const stageContent = readFileSync(path.join(folder.dir, stage.fileName), 'utf8');
            extensionRuns.push(
              await runAnalyzerExtension(workspace, extensionId, {
                specName: folder.name,
                specType,
                workflowMode,
                stage: stage.stage,
                stageFile: stage.fileName,
                stageContent,
              }),
            );
          } catch (error) {
            extensionFailures.push({
              extensionId,
              message: error instanceof Error ? error.message : String(error),
            });
            break;
          }
        }
      }
      const extensionErrorCount = extensionRuns
        .flatMap((run) => run.diagnostics)
        .filter((diagnostic) => diagnostic.severity === 'error').length;
      const extensionWarningCount = extensionRuns
        .flatMap((run) => run.diagnostics)
        .filter((diagnostic) => diagnostic.severity === 'warning').length;

      const failed =
        result.hasErrors ||
        extensionErrorCount > 0 ||
        extensionFailures.length > 0 ||
        (options.strict === true && result.warningCount + extensionWarningCount > 0);

      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.spec-analyze/1', `${CLI_BIN} ${VERSION}`, {
              specName: result.specName,
              strict: options.strict === true,
              managed: evaluation !== undefined,
              stages: result.stages.map((stage) => ({
                stage: stage.stage,
                fileName: stage.fileName,
                fileExists: stage.fileExists,
                diagnostics: stage.diagnostics,
              })),
              errorCount: result.errorCount,
              warningCount: result.warningCount,
              extensions: extensionRuns.map((run) => ({
                extensionId: run.extensionId,
                extensionVersion: run.extensionVersion,
                diagnostics: run.diagnostics,
                summary: run.summary ?? null,
              })),
              extensionFailures,
              failed,
            }),
          ),
        );
        runtime.exitCode = failed ? 1 : 0;
        return;
      }

      runtime.out(reportTitle(`Analysis: ${folder.name}`));
      if (stateRead.diagnostics.length > 0) {
        for (const diagnostic of stateRead.diagnostics) {
          runtime.out(severityLine(diagnostic.severity, diagnostic.message));
        }
      }
      if (evaluation === undefined) {
        runtime.out(dim('  Approval state: unmanaged (no sidecar state) — analyzing all present stages at full strictness.'));
      }
      runtime.out();

      for (const stage of result.stages) {
        runtime.out(sectionTitle(`${stage.stage} (${stage.fileName})`));
        if (!stage.fileExists && stage.diagnostics.length === 0) {
          runtime.out(dim('  not present'));
        } else if (stage.diagnostics.length === 0) {
          runtime.out(okLine('no findings'));
        } else {
          for (const diagnostic of stage.diagnostics) {
            const location =
              diagnostic.file !== undefined
                ? ` [${relPath(workspace, diagnostic.file)}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}]`
                : '';
            runtime.out(severityLine(diagnostic.severity, `${diagnostic.message}${location}`));
          }
        }
        runtime.out();
      }

      if (options.extension.length > 0) {
        runtime.out(sectionTitle('extension analyzers'));
        for (const run of extensionRuns) {
          if (run.diagnostics.length === 0) {
            runtime.out(okLine(`${run.extensionId}@${run.extensionVersion}: no findings`));
            continue;
          }
          for (const diagnostic of run.diagnostics) {
            const location =
              diagnostic.file !== undefined
                ? ` [${diagnostic.file}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}]`
                : '';
            runtime.out(
              severityLine(
                diagnostic.severity,
                `${diagnostic.ruleId} (${diagnostic.confidence}): ${diagnostic.message}${location}`,
              ),
            );
          }
        }
        for (const failure of extensionFailures) {
          runtime.out(severityLine('error', `extension "${failure.extensionId}" failed: ${failure.message}`));
        }
        runtime.out();
      }

      const extensionSummary =
        extensionRuns.length > 0 || extensionFailures.length > 0
          ? ` (+${extensionErrorCount} extension error${extensionErrorCount === 1 ? '' : 's'}, ` +
            `${extensionWarningCount} extension warning${extensionWarningCount === 1 ? '' : 's'})`
          : '';
      const summary = `${result.errorCount} error${result.errorCount === 1 ? '' : 's'}, ${result.warningCount} warning${result.warningCount === 1 ? '' : 's'}${extensionSummary}`;
      if (failed) {
        runtime.out(`Result: ${reportTitle('FAIL')} — ${summary}${options.strict === true && !result.hasErrors ? ' (strict mode)' : ''}`);
      } else {
        runtime.out(`Result: ${reportTitle('OK')} — ${summary}`);
      }
      runtime.exitCode = failed ? 1 : 0;
    });
}
