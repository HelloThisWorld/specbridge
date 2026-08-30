import type { Command } from 'commander';
import type { AutonomyDeps } from '@specbridge/autonomy';
import {
  computeExecutionTelemetryReport,
  executionTelemetryReportFile,
} from '@specbridge/autonomy';
import {
  renderExecutionTelemetryReport,
  serializeJsonReport,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { relPath } from '../context.js';
import { loadExecutionContext } from '../execution-context.js';
import { VERSION } from '../version.js';

function deps(runtime: CliRuntime): AutonomyDeps {
  const context = loadExecutionContext(runtime);
  return {
    workspace: context.workspace,
    config: context.config,
    clock: () => runtime.now(),
    host: 'cli',
  };
}

/** Phase 9 durable operational/economic reports. */
export function registerReportCommands(program: Command, runtime: CliRuntime): void {
  const report = program
    .command('report')
    .description('Derived execution telemetry (never completion authority)');

  report
    .command('job <jobId>')
    .description('Report one Job from durable execution facts')
    .option('--json', 'emit the versioned machine-readable report')
    .option('--verbose', 'include bounded WorkUnit accounting and cooldown timeline')
    .option('--no-persist', 'derive without writing .specbridge/reports')
    .action((jobId: string, options: { json?: boolean; verbose?: boolean; persist?: boolean }) => {
      const reportingDeps = deps(runtime);
      const result = computeExecutionTelemetryReport(reportingDeps, jobId, {
        persist: options.persist !== false,
        specbridgeVersion: VERSION,
      });
      if (options.json === true) {
        runtime.outRaw(serializeJsonReport(result));
        return;
      }
      runtime.outRaw(renderExecutionTelemetryReport(result, { verbose: options.verbose === true }));
      if (options.persist !== false) {
        runtime.out(
          `Report: ${relPath(reportingDeps.workspace, executionTelemetryReportFile(reportingDeps.workspace, jobId))}`,
        );
      }
    });
}
