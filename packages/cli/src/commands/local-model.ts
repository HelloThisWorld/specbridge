import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, readAgentConfig } from '@specbridge/core';
import { localModelDoctor } from '@specbridge/runners';
import {
  createJsonReport,
  failLine,
  infoLine,
  okLine,
  reportTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge local-model …` — read-only diagnostics for the managed
 * llama.cpp reasoning server.
 *
 * Nothing here spawns a server, loads a model, or performs inference of any
 * kind: `doctor` checks configuration and files, `status` optionally probes
 * a fixed-port endpoint's /health. Paid or model-driven work never starts
 * from a doctor command.
 */

export function registerLocalModelCommands(program: Command, runtime: CliRuntime): void {
  const localModel = program
    .command('local-model')
    .description('Managed local reasoning model (llama.cpp) diagnostics — read-only');

  const renderReport = async (options: { json?: boolean; probe?: boolean }): Promise<void> => {
    const workspace = runtime.workspace();
    const configResult = readAgentConfig(workspace);
    const config = configResult.config;
    if (config === undefined) {
      runtime.err('The configuration file is invalid; fix it before diagnosing the local model.');
      runtime.exitCode = EXIT_CODES.usageError;
      return;
    }
    const report = await localModelDoctor(config.localInference, {
      ...(options.probe === true ? { probeEndpoint: true } : {}),
    });

    if (options.json === true) {
      runtime.outRaw(
        serializeJsonReport(
          createJsonReport('local-model-doctor', `${CLI_BIN} ${VERSION}`, { ...report }),
        ),
      );
      runtime.exitCode = report.startable ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
      return;
    }

    runtime.out(reportTitle('Local model (llama.cpp)'));
    runtime.out(report.enabled ? okLine('enabled') : warnLine('disabled (localInference.enabled is false)'));
    runtime.out(
      report.executable.found
        ? okLine(`server executable: ${report.executable.configured}`)
        : failLine(`server executable: ${report.executable.configured ?? '(not set)'} — not found`),
    );
    runtime.out(
      report.model.found
        ? okLine(
            `model: ${report.model.configured} (${((report.model.sizeBytes ?? 0) / 1_048_576).toFixed(0)} MiB)`,
          )
        : failLine(`model: ${report.model.configured ?? '(not set)'} — not found`),
    );
    runtime.out(infoLine(`binding: ${report.binding}; port: ${String(report.port)}`));
    runtime.out(
      infoLine(`context ${report.contextSize} tokens, ${report.parallel} parallel slot(s) shared by all roles`),
    );
    runtime.out(infoLine(`structured output: ${report.structuredOutput}`));
    if (report.endpoint !== undefined) {
      runtime.out(
        report.endpoint.healthy
          ? okLine(`endpoint ${report.endpoint.url}: healthy`)
          : warnLine(`endpoint ${report.endpoint.url}: not answering /health`),
      );
    }
    for (const problem of report.configProblems) runtime.out(warnLine(problem));
    runtime.out(
      report.startable
        ? okLine('startable: the orchestrator can manage this server')
        : blockedNote(),
    );
    runtime.exitCode = report.startable ? EXIT_CODES.ok : EXIT_CODES.gateFailure;

    function blockedNote(): string {
      return warnLine(
        'not startable — local reasoning roles will escalate to the large agent until this is fixed',
      );
    }
  };

  localModel
    .command('doctor')
    .description('Validate the local model configuration and files (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (options: { json?: boolean }) => renderReport(options));

  localModel
    .command('status')
    .description('Doctor checks plus a /health probe of a fixed-port endpoint (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (options: { json?: boolean }) => renderReport({ ...options, probe: true }));
}
