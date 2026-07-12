import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES } from '@specbridge/core';
import type { AgentRunner, RunnerDetectionResult } from '@specbridge/runners';
import {
  createJsonReport,
  dim,
  failLine,
  infoLine,
  okLine,
  renderColumns,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { loadExecutionContext } from '../execution-context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge runner list|doctor|show` — read-only runner diagnostics.
 * Nothing here executes an agent; detection runs version/help/auth-status
 * probes only and never prints credential material.
 */

interface RunnerOptions {
  json?: boolean;
  verbose?: boolean;
}

function statusLine(detection: RunnerDetectionResult): string {
  switch (detection.status) {
    case 'available':
      return okLine(`${detection.runner}`, `${detection.kind} — available`);
    case 'unauthenticated':
      return failLine(`${detection.runner}`, `${detection.kind} — installed but not authenticated`);
    case 'incompatible':
      return failLine(`${detection.runner}`, `${detection.kind} — installed but missing required capabilities`);
    case 'misconfigured':
      return failLine(`${detection.runner}`, `${detection.kind} — disabled or misconfigured`);
    case 'error':
      return failLine(`${detection.runner}`, `${detection.kind} — detection error`);
    case 'unavailable':
      return detection.kind === 'unsupported'
        ? infoLine(`${detection.runner}`, 'not implemented in v0.3 (roadmap)')
        : failLine(`${detection.runner}`, `${detection.kind} — not installed`);
  }
}

function detectionToJson(detection: RunnerDetectionResult): unknown {
  return {
    runner: detection.runner,
    kind: detection.kind,
    status: detection.status,
    executable: detection.executable ?? null,
    version: detection.version ?? null,
    authentication: detection.authentication,
    capabilities: detection.capabilities,
    diagnostics: detection.diagnostics,
  };
}

function printDoctorReport(
  runtime: CliRuntime,
  detection: RunnerDetectionResult,
  configLines: string[],
  verbose: boolean,
): void {
  runtime.out(reportTitle(`Runner: ${detection.runner}`));
  runtime.out(`Status: ${detection.status}`);
  runtime.out();

  runtime.out(sectionTitle('Executable'));
  if (detection.executable !== undefined) {
    const line = detection.status === 'unavailable' ? failLine : okLine;
    runtime.out(line(detection.executable, detection.version));
  } else {
    runtime.out(infoLine('(not applicable)'));
  }
  runtime.out();

  runtime.out(sectionTitle('Authentication'));
  switch (detection.authentication) {
    case 'authenticated':
      runtime.out(okLine('Authenticated'));
      break;
    case 'unauthenticated':
      runtime.out(failLine('Not authenticated', 'run "claude auth login" (SpecBridge never handles credentials)'));
      break;
    case 'not-applicable':
      runtime.out(infoLine('Not applicable'));
      break;
    case 'unknown':
      runtime.out(warnLine('Could not be verified', 'it will surface at execution time'));
      break;
  }
  runtime.out();

  if (detection.capabilities.length > 0) {
    runtime.out(sectionTitle('Capabilities'));
    for (const capability of detection.capabilities) {
      if (capability.available) {
        runtime.out(okLine(capability.label));
      } else if (capability.required) {
        runtime.out(failLine(capability.label, 'REQUIRED — update the runner'));
      } else {
        runtime.out(warnLine(capability.label, capability.detail ?? 'optional; degrades gracefully'));
      }
    }
    runtime.out();
  }

  if (configLines.length > 0) {
    runtime.out(sectionTitle('Configuration'));
    for (const line of configLines) runtime.out(`  ${line}`);
    runtime.out();
  }

  runtime.out(sectionTitle('Safety'));
  runtime.out(okLine('bypassPermissions is not enabled', 'rejected at three layers, never passed'));
  runtime.out(okLine('No credential values are stored by SpecBridge'));
  runtime.out();

  const diagnostics = verbose
    ? detection.diagnostics
    : detection.diagnostics.filter((d) => d.severity !== 'info');
  if (diagnostics.length > 0) {
    runtime.out(sectionTitle('Findings'));
    for (const diagnostic of diagnostics) {
      const line =
        diagnostic.severity === 'error'
          ? failLine
          : diagnostic.severity === 'warning'
            ? warnLine
            : infoLine;
      runtime.out(line(diagnostic.message));
    }
    runtime.out();
  }

  runtime.out(
    `Result: ${detection.status === 'available' ? 'OK — runner is ready' : `NOT READY (${detection.status})`}`,
  );
}

function claudeConfigLines(runtime: CliRuntime): string[] {
  const { config } = loadExecutionContext(runtime);
  const claude = config.runners['claude-code'];
  return [
    `Model: ${claude.model ?? 'default'}`,
    `Permission mode: ${claude.permissionMode}`,
    `Maximum turns: ${claude.maxTurns}`,
    `Timeout: ${Math.round(claude.timeoutMs / 60000)} minutes`,
    `Tools: ${claude.tools.join(', ')}`,
    `Bash allow rules: ${claude.allowedBashRules.length} configured`,
  ];
}

export function registerRunnerCommands(program: Command, runtime: CliRuntime): void {
  const runner = program
    .command('runner')
    .description('Inspect and diagnose agent runners (read-only)');

  runner
    .command('list')
    .description('List configured runners with availability status')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include informational diagnostics')
    .addHelpText(
      'after',
      `
Runner kinds: mock (offline, deterministic), claude-code (local Claude Code
CLI), unsupported (honest stubs for codex/ollama/openai-compatible).

Exit codes: 0 always (listing succeeds even when runners are unavailable).

Examples:
  ${CLI_BIN} runner list
  ${CLI_BIN} runner list --json`,
    )
    .action(async (options: RunnerOptions) => {
      const { registry, workspace, config } = loadExecutionContext(runtime);
      const detections: RunnerDetectionResult[] = [];
      for (const agentRunner of registry.list()) {
        detections.push(await agentRunner.detect({ workspaceRoot: workspace.rootDir }));
      }
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.runner-list/1', `${CLI_BIN} ${VERSION}`, {
              defaultRunner: config.defaultRunner,
              runners: detections.map(detectionToJson),
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle('Runners'));
      runtime.out();
      for (const detection of detections) {
        runtime.out(statusLine(detection));
      }
      runtime.out();
      runtime.out(dim(`  Default runner: ${config.defaultRunner} (change with .specbridge/config.json)`));
      runtime.out(dim(`  Details: ${CLI_BIN} runner doctor <name>`));
    });

  runner
    .command('doctor [name]')
    .description('Diagnose a runner: executable, authentication, capabilities, safety')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include informational diagnostics')
    .addHelpText(
      'after',
      `
The doctor is read-only: it runs version/help probes and "claude auth status"
(when supported) but never invokes the agent and never prints credentials.

Exit codes: 0 runner available · 3 unavailable, unauthenticated, or
incompatible · 2 usage/configuration error.

Examples:
  ${CLI_BIN} runner doctor claude-code
  ${CLI_BIN} runner doctor            (diagnoses the default runner)
  ${CLI_BIN} runner doctor claude-code --json`,
    )
    .action(async (name: string | undefined, options: RunnerOptions) => {
      const context = loadExecutionContext(runtime);
      const runnerName = name ?? context.config.defaultRunner;
      const agentRunner: AgentRunner = context.registry.get(runnerName);
      const detection = await agentRunner.detect({
        workspaceRoot: context.workspace.rootDir,
        probeCapabilities: true,
      });
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.runner-doctor/1', `${CLI_BIN} ${VERSION}`, detectionToJson(detection)),
          ),
        );
      } else {
        const configLines = runnerName === 'claude-code' ? claudeConfigLines(runtime) : [];
        printDoctorReport(runtime, detection, configLines, options.verbose === true);
      }
      runtime.exitCode = detection.status === 'available' ? EXIT_CODES.ok : EXIT_CODES.runnerUnavailable;
    });

  runner
    .command('show <name>')
    .description('Show a runner\'s effective configuration (secrets are never stored)')
    .option('--json', 'output a machine-readable JSON report')
    .addHelpText(
      'after',
      `
Examples:
  ${CLI_BIN} runner show claude-code
  ${CLI_BIN} runner show mock --json`,
    )
    .action((name: string, options: RunnerOptions) => {
      const context = loadExecutionContext(runtime);
      context.registry.get(name); // validates the name with a helpful error
      const entry = context.config.runners[name] ?? {};
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.runner-show/1', `${CLI_BIN} ${VERSION}`, {
              runner: name,
              isDefault: context.config.defaultRunner === name,
              configPath: context.configPath,
              configExists: context.configExists,
              configuration: entry,
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle(`Runner configuration: ${name}`));
      runtime.out();
      const rows = Object.entries(entry as Record<string, unknown>).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(', ') : String(value ?? 'null'),
      ]);
      if (rows.length === 0) {
        runtime.out(infoLine('No explicit configuration; safe defaults apply.'));
      } else {
        for (const line of renderColumns(rows)) runtime.out(line);
      }
      runtime.out();
      runtime.out(dim(`  Config file: ${context.configPath}${context.configExists ? '' : ' (not present; defaults)'}`));
      runtime.out(dim(`  Default runner: ${context.config.defaultRunner}`));
    });
}
