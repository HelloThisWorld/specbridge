import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import type {
  RegisteredRunnerProfile,
  RunnerConformanceResult,
  RunnerDetectionResult,
  RunnerOperation,
} from '@specbridge/runners';
import {
  RUNNER_OPERATIONS,
  RUNNER_OPERATION_REQUIREMENTS,
  checkOperationSupport,
  profileModel,
  profileOperations,
  profileTransport,
  runRunnerConformance,
  selectRunner,
} from '@specbridge/runners';
import { EXECUTION_CONFORMANCE_GROUPS } from '@specbridge/execution';
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
 * `specbridge runner …` — profile-based runner diagnostics (v0.6).
 *
 * list / matrix / show / doctor stay strictly read-only: detection runs
 * version/help/auth-status probes (or loopback reachability probes) only and
 * never sends a model request. `runner test` and real-provider
 * `runner conformance` invoke the provider only with explicit `--network`.
 */

interface RunnerOptions {
  json?: boolean;
  verbose?: boolean;
  markdown?: boolean;
  network?: boolean;
  operation?: string;
}

function parseOperation(value: string | undefined): RunnerOperation | undefined {
  if (value === undefined) return undefined;
  if (!RUNNER_OPERATIONS.includes(value as RunnerOperation)) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Unknown --operation "${value}". Valid operations: ${RUNNER_OPERATIONS.join(', ')}.`,
    );
  }
  return value as RunnerOperation;
}

function statusWord(detection: RunnerDetectionResult): string {
  switch (detection.status) {
    case 'available':
      return 'available';
    case 'unauthenticated':
      return 'not authenticated';
    case 'incompatible':
      return 'incompatible version';
    case 'misconfigured':
      return 'disabled or misconfigured';
    case 'error':
      return 'detection error';
    case 'unavailable':
      return 'not installed / unreachable';
  }
}

function profileSummaryJson(profile: RegisteredRunnerProfile, detection?: RunnerDetectionResult): unknown {
  const transport = profileTransport(profile.config);
  return {
    profile: profile.name,
    implementation: profile.runner.name,
    category: profile.runner.category,
    enabled: profile.config.enabled !== false,
    model: profileModel(profile.config),
    networkBacked: transport.networkBacked,
    localExecution: transport.localExecution,
    supportedOperations: profileOperations(profile),
    declaredCapabilities: profile.runner.declaredCapabilities,
    ...(detection !== undefined
      ? {
          availability: detection.status,
          supportLevel: detection.supportLevel,
          detectedCapabilities: detection.capabilitySet,
          version: detection.version ?? null,
          authentication: detection.authentication,
        }
      : {}),
  };
}

function redactedProfileConfig(profile: RegisteredRunnerProfile): Record<string, unknown> {
  // Profiles never store credentials (rejected by the schema); redaction here
  // is defense in depth for passthrough fields.
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile.config as Record<string, unknown>)) {
    redacted[key] = /key|token|secret|password|credential/i.test(key) ? '<redacted>' : value;
  }
  return redacted;
}

const OPERATION_SHORT: Record<RunnerOperation, string> = {
  'stage-generation': 'Author',
  'stage-refinement': 'Refine',
  'task-execution': 'Execute',
  'task-resume': 'Resume',
  'model-list': 'Models',
  'runner-test': 'Test',
};

interface MatrixRow {
  profile: string;
  support: string;
  author: boolean;
  refine: boolean;
  execute: boolean;
  resume: boolean;
  local: boolean;
}

function matrixRows(profiles: RegisteredRunnerProfile[]): MatrixRow[] {
  return profiles.map((profile) => {
    const operations = new Set(profileOperations(profile));
    return {
      profile: profile.name,
      support: 'production',
      author: operations.has('stage-generation'),
      refine: operations.has('stage-refinement'),
      execute: operations.has('task-execution'),
      resume: operations.has('task-resume'),
      local: profileTransport(profile.config).localExecution,
    };
  });
}

/** Markdown capability matrix — the same source feeds docs and README. */
export function renderMatrixMarkdown(rows: MatrixRow[]): string {
  const lines = [
    '| Profile | Support | Author | Refine | Execute | Resume | Local |',
    '|---------|---------|--------|--------|---------|--------|-------|',
  ];
  for (const row of rows) {
    const yn = (value: boolean): string => (value ? 'yes' : 'no');
    lines.push(
      `| ${row.profile} | ${row.support} | ${yn(row.author)} | ${yn(row.refine)} | ${yn(row.execute)} | ${yn(row.resume)} | ${yn(row.local)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function printDoctorReport(
  runtime: CliRuntime,
  profile: RegisteredRunnerProfile,
  detection: RunnerDetectionResult,
  verbose: boolean,
): void {
  runtime.out(reportTitle(`Runner profile: ${profile.name}`));
  runtime.out(`Implementation: ${detection.runner} (${detection.category})`);
  runtime.out(`Status: ${detection.status} · support level: ${detection.supportLevel}`);
  runtime.out();

  runtime.out(sectionTitle('Executable / endpoint'));
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
      runtime.out(failLine('Not authenticated', 'authenticate with the provider CLI (SpecBridge never handles credentials)'));
      break;
    case 'not-applicable':
      runtime.out(infoLine('Not applicable'));
      break;
    case 'unknown':
      runtime.out(
        warnLine(
          'Could not be verified safely',
          `credential files are never read; use "${CLI_BIN} runner test ${profile.name} --network" for a minimal probe`,
        ),
      );
      break;
  }
  runtime.out();

  if (detection.capabilities.length > 0) {
    runtime.out(sectionTitle('Detected capabilities'));
    for (const capability of detection.capabilities) {
      if (capability.available) {
        runtime.out(okLine(capability.label));
      } else if (capability.required) {
        runtime.out(failLine(capability.label, 'REQUIRED — update the provider'));
      } else {
        runtime.out(warnLine(capability.label, capability.detail ?? 'optional; degrades gracefully'));
      }
    }
    runtime.out();
  }

  runtime.out(sectionTitle('Operations (declared capabilities)'));
  for (const operation of RUNNER_OPERATIONS) {
    if (operation === 'model-list' || operation === 'runner-test') continue;
    const support = checkOperationSupport(operation, detection.capabilitySet);
    runtime.out(
      support.supported
        ? okLine(OPERATION_SHORT[operation])
        : infoLine(OPERATION_SHORT[operation], `not supported (missing: ${[...support.missingCapabilities, ...support.unsatisfiedBoundaries.flat()].join(', ')})`),
    );
  }
  runtime.out();

  runtime.out(sectionTitle('Safety'));
  runtime.out(okLine('No permission-bypass or unrestricted sandbox mode can be configured or passed'));
  runtime.out(okLine('No credential values are stored or read by SpecBridge'));
  runtime.out(okLine('Provider claims never complete tasks; evidence stays provider-independent'));
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

function conformanceToJson(result: RunnerConformanceResult): unknown {
  return {
    runner: result.runner,
    profile: result.profile,
    passed: result.passed,
    productionConfirmed: result.productionConfirmed,
    failedChecks: result.failedChecks,
    skippedChecks: result.skippedChecks,
    groups: result.groups,
  };
}

export function registerRunnerCommands(program: Command, runtime: CliRuntime): void {
  const runner = program
    .command('runner')
    .description('Inspect, diagnose, and conformance-test runner profiles');

  runner
    .command('list')
    .description('List configured runner profiles with capabilities and availability')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include informational diagnostics')
    .addHelpText(
      'after',
      `
Profiles are named configurations of runner implementations (claude-code,
codex-cli, ollama, mock). Disabled profiles are listed — and refused at
selection time — so nothing is hidden.

Exit codes: 0 always (listing succeeds even when runners are unavailable).

Examples:
  ${CLI_BIN} runner list
  ${CLI_BIN} runner list --json`,
    )
    .action(async (options: RunnerOptions) => {
      const { registry, workspace, config } = loadExecutionContext(runtime);
      const detections = new Map<string, RunnerDetectionResult>();
      for (const profile of registry.listProfiles()) {
        detections.set(
          profile.name,
          await profile.runner.detect({ workspaceRoot: workspace.rootDir }),
        );
      }
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.runner-list/2', `${CLI_BIN} ${VERSION}`, {
              defaultRunner: config.defaultRunner,
              operationDefaults: config.operationDefaults,
              profiles: registry
                .listProfiles()
                .map((profile) => profileSummaryJson(profile, detections.get(profile.name))),
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle('Runner profiles'));
      runtime.out();
      for (const profile of registry.listProfiles()) {
        const detection = detections.get(profile.name) as RunnerDetectionResult;
        const enabled = profile.config.enabled !== false;
        const transport = profileTransport(profile.config);
        const model = profileModel(profile.config);
        const operations = profileOperations(profile)
          .filter((operation) => operation !== 'model-list' && operation !== 'runner-test')
          .map((operation) => OPERATION_SHORT[operation])
          .join(', ');
        const summary = `${profile.runner.name} · ${profile.runner.category} · ${enabled ? statusWord(detection) : 'disabled'}`;
        const line = !enabled ? infoLine : detection.status === 'available' ? okLine : failLine;
        runtime.out(line(profile.name, summary));
        runtime.out(
          dim(
            `    operations: ${operations || '(none)'} · ${transport.localExecution ? 'local' : transport.networkBacked ? 'network-backed' : 'local process'}${model !== null ? ` · model: ${model}` : ''}`,
          ),
        );
      }
      runtime.out();
      runtime.out(dim(`  Default runner: ${config.defaultRunner} (.specbridge/config.json)`));
      runtime.out(dim(`  Details: ${CLI_BIN} runner show <profile> · ${CLI_BIN} runner doctor <profile>`));
    });

  runner
    .command('matrix')
    .description('Capability matrix generated from registered runner metadata')
    .option('--json', 'output a machine-readable JSON report')
    .option('--markdown', 'output a Markdown table (used to generate docs)')
    .action((options: RunnerOptions) => {
      const { registry } = loadExecutionContext(runtime);
      const rows = matrixRows(registry.listProfiles());
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.runner-matrix/1', `${CLI_BIN} ${VERSION}`, { rows }),
          ),
        );
        return;
      }
      if (options.markdown === true) {
        runtime.outRaw(renderMatrixMarkdown(rows));
        return;
      }
      runtime.out(reportTitle('Runner Capability Matrix'));
      runtime.out();
      const columns = [
        ['Profile', 'Support', 'Author', 'Refine', 'Execute', 'Resume', 'Local'],
        ...rows.map((row) => [
          row.profile,
          row.support,
          row.author ? 'yes' : 'no',
          row.refine ? 'yes' : 'no',
          row.execute ? 'yes' : 'no',
          row.resume ? 'yes' : 'no',
          row.local ? 'yes' : 'no',
        ]),
      ];
      for (const line of renderColumns(columns)) runtime.out(`  ${line}`);
      runtime.out();
      runtime.out(dim('  Generated from registered runner metadata (declared capabilities).'));
    });

  runner
    .command('show <profile>')
    .description('Show a profile: redacted configuration, capabilities, operations, boundaries')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (name: string, options: RunnerOptions) => {
      const context = loadExecutionContext(runtime);
      const profile = context.registry.getProfile(name);
      const detection = await profile.runner.detect({
        workspaceRoot: context.workspace.rootDir,
        probeCapabilities: true,
      });
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.runner-show/2', `${CLI_BIN} ${VERSION}`, {
              ...(profileSummaryJson(profile, detection) as Record<string, unknown>),
              configuration: redactedProfileConfig(profile),
              constraints:
                profile.runner.executionBoundaryNote !== undefined
                  ? [profile.runner.executionBoundaryNote('implementation')]
                  : [],
              isDefault: context.config.defaultRunner === name,
              configPath: context.configPath,
            }),
          ),
        );
        return;
      }
      runtime.out(reportTitle(`Runner profile: ${name}`));
      runtime.out();
      runtime.out(`  Implementation: ${profile.runner.name} (${profile.runner.category})`);
      runtime.out(`  Enabled: ${profile.config.enabled !== false ? 'yes' : 'no'}`);
      runtime.out(`  Availability: ${statusWord(detection)} · support level: ${detection.supportLevel}`);
      const transport = profileTransport(profile.config);
      runtime.out(
        `  Boundary: ${transport.localExecution ? 'local' : transport.networkBacked ? 'NETWORK-BACKED (requests leave this machine)' : 'local process (provider handles its own connectivity)'}`,
      );
      const model = profileModel(profile.config);
      runtime.out(`  Model: ${model ?? '(not configured)'}`);
      runtime.out();
      runtime.out(sectionTitle('Configuration (redacted)'));
      const rows = Object.entries(redactedProfileConfig(profile)).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(', ') : JSON.stringify(value ?? null),
      ]);
      for (const line of renderColumns(rows)) runtime.out(`  ${line}`);
      runtime.out();
      runtime.out(sectionTitle('Declared capabilities'));
      for (const [key, available] of Object.entries(profile.runner.declaredCapabilities)) {
        runtime.out(`  ${available ? '✓' : '○'} ${key}`);
      }
      runtime.out();
      runtime.out(sectionTitle('Operation compatibility'));
      for (const operation of RUNNER_OPERATIONS) {
        if (operation === 'model-list' || operation === 'runner-test') continue;
        const support = checkOperationSupport(operation, profile.runner.declaredCapabilities);
        runtime.out(
          support.supported
            ? okLine(operation)
            : infoLine(operation, `missing: ${[...support.missingCapabilities, ...support.unsatisfiedBoundaries.flat()].join(', ')}`),
        );
      }
      if (profile.runner.executionBoundaryNote !== undefined) {
        runtime.out();
        runtime.out(sectionTitle('Security boundary'));
        runtime.out(`  ${profile.runner.executionBoundaryNote('implementation')}`);
      }
      runtime.out();
      runtime.out(dim(`  Conformance: ${CLI_BIN} runner conformance ${name}`));
      runtime.out(dim(`  Config file: ${context.configPath}${context.configExists ? '' : ' (not present; defaults)'}`));
    });

  runner
    .command('doctor [profile]')
    .description('Diagnose a profile: executable/endpoint, authentication, capabilities (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include informational diagnostics')
    .addHelpText(
      'after',
      `
The doctor is read-only: it runs version/help probes, safe authentication
status commands, or loopback reachability checks — it NEVER sends a model
request, never reads credential files, and never modifies provider
configuration.

Exit codes: 0 runner available · 3 unavailable, unauthenticated, or
incompatible · 2 usage/configuration error.

Examples:
  ${CLI_BIN} runner doctor
  ${CLI_BIN} runner doctor codex-default --json`,
    )
    .action(async (name: string | undefined, options: RunnerOptions) => {
      const context = loadExecutionContext(runtime);
      const profileName = name ?? context.config.defaultRunner;
      const profile = context.registry.getProfile(profileName);
      const detection = await profile.runner.detect({
        workspaceRoot: context.workspace.rootDir,
        probeCapabilities: true,
      });
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.runner-doctor/2', `${CLI_BIN} ${VERSION}`, {
              ...(profileSummaryJson(profile, detection) as Record<string, unknown>),
              capabilities: detection.capabilities,
              diagnostics: detection.diagnostics,
            }),
          ),
        );
      } else {
        printDoctorReport(runtime, profile, detection, options.verbose === true);
      }
      runtime.exitCode = detection.status === 'available' ? EXIT_CODES.ok : EXIT_CODES.runnerUnavailable;
    });

  runner
    .command('test <profile>')
    .description('Minimal bounded structured-output test (a real provider request needs --network)')
    .option('--json', 'output a machine-readable JSON report')
    .option('--network', 'actually send the minimal provider request')
    .action(async (name: string, options: RunnerOptions) => {
      const context = loadExecutionContext(runtime);
      const profile = context.registry.getProfile(name);
      const proposal = {
        profile: name,
        implementation: profile.runner.name,
        request:
          'one minimal structured-output request (a tiny stage report; no repository access, no file modification)',
        boundary: profileTransport(profile.config),
      };
      if (options.network !== true) {
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.runner-test/1', `${CLI_BIN} ${VERSION}`, {
                executed: false,
                proposal,
              }),
            ),
          );
          return;
        }
        runtime.out(reportTitle(`Runner test (proposed): ${name}`));
        runtime.out();
        runtime.out(infoLine('No request was sent.'));
        runtime.out(`  Proposed test: ${proposal.request}`);
        runtime.out();
        runtime.out(dim(`  Send it with: ${CLI_BIN} runner test ${name} --network`));
        return;
      }
      if (profile.runner.selfTest === undefined) {
        runtime.err(`The ${profile.runner.name} runner exposes no self test.`);
        runtime.exitCode = EXIT_CODES.usageError;
        return;
      }
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-runner-test-'));
      try {
        const result = await profile.runner.selfTest({
          workspaceRoot: scratch,
          runDir: path.join(scratch, 'run'),
          timeoutMs: 120_000,
        });
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.runner-test/1', `${CLI_BIN} ${VERSION}`, {
                executed: true,
                ok: result.ok,
                detail: result.detail,
                usage: result.usage ?? null,
              }),
            ),
          );
        } else {
          runtime.out(reportTitle(`Runner test: ${name}`));
          runtime.out();
          runtime.out(result.ok ? okLine('Structured output validated') : failLine('Test failed', result.detail));
          if (!result.ok) runtime.out(`  ${result.detail}`);
          if (result.usage !== undefined) {
            runtime.out(
              infoLine(
                'Usage',
                `input ${result.usage.inputTokens ?? '?'} · output ${result.usage.outputTokens ?? '?'} tokens · ${result.usage.durationMs} ms`,
              ),
            );
          }
        }
        runtime.exitCode = result.ok ? EXIT_CODES.ok : EXIT_CODES.runnerFailure;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

  runner
    .command('models <profile>')
    .description('List locally available models (provider-supported enumeration only)')
    .option('--json', 'output a machine-readable JSON report')
    .action(async (name: string, options: RunnerOptions) => {
      const context = loadExecutionContext(runtime);
      const profile = context.registry.getProfile(name);
      if (profile.runner.listModels === undefined) {
        runtime.err(
          `The ${profile.runner.name} runner has no supported model-listing mechanism; SpecBridge never guesses model names.`,
        );
        runtime.exitCode = EXIT_CODES.usageError;
        return;
      }
      const result = await profile.runner.listModels({ workspaceRoot: context.workspace.rootDir });
      if (options.json === true) {
        runtime.outRaw(
          serializeJsonReport(
            createJsonReport('specbridge.runner-models/1', `${CLI_BIN} ${VERSION}`, {
              profile: name,
              supported: result.supported,
              detail: result.detail ?? null,
              models: result.models,
            }),
          ),
        );
        runtime.exitCode = result.supported && result.detail === undefined ? EXIT_CODES.ok : runtime.exitCode;
        return;
      }
      runtime.out(reportTitle(`Models: ${name}`));
      runtime.out();
      if (!result.supported) {
        runtime.out(infoLine(result.detail ?? 'Model listing is not supported for this runner.'));
        return;
      }
      if (result.detail !== undefined) {
        runtime.out(failLine(result.detail));
        runtime.exitCode = EXIT_CODES.runnerUnavailable;
        return;
      }
      if (result.models.length === 0) {
        runtime.out(infoLine('No local models found. Pull one yourself (SpecBridge never pulls models automatically).'));
        return;
      }
      const rows = [
        ['Name', 'Size', 'Family', 'Parameters', 'Quantization', 'Location'],
        ...result.models.map((model) => [
          model.name,
          model.sizeBytes !== undefined ? `${Math.round(model.sizeBytes / 1024 / 1024)} MiB` : '-',
          model.family ?? '-',
          model.parameterSize ?? '-',
          model.quantization ?? '-',
          model.location ?? 'unknown',
        ]),
      ];
      for (const line of renderColumns(rows)) runtime.out(`  ${line}`);
      runtime.out();
      runtime.out(dim('  Configure one explicitly on the profile ("model"); nothing is selected automatically.'));
    });

  runner
    .command('conformance <profile>')
    .description('Run the applicable conformance groups for a profile (provider runs need --network)')
    .option('--json', 'output a machine-readable JSON report')
    .option('--verbose', 'include every check, not just failures')
    .option('--network', 'allow checks that invoke the provider (process/HTTP, possibly a model request)')
    .addHelpText(
      'after',
      `
Conformance runs against a throwaway fixture workspace — never this
repository. Without --network only invocation-free groups run; the rest are
reported as skipped, and production status is not confirmed while required
checks are skipped. CI runs the full suite against fake providers.

Exit codes: 0 all executed checks passed · 1 failures.

Examples:
  ${CLI_BIN} runner conformance mock
  ${CLI_BIN} runner conformance codex-default --network --verbose`,
    )
    .action(async (name: string, options: RunnerOptions) => {
      const context = loadExecutionContext(runtime);
      const profile = context.registry.getProfile(name);
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-conformance-'));
      try {
        const result = await runRunnerConformance(
          {
            profile,
            workspaceRoot: scratch,
            runDir: path.join(scratch, '.specbridge-conformance-runs'),
            invocationsAllowed: options.network === true,
            timeoutMs: 120_000,
          },
          EXECUTION_CONFORMANCE_GROUPS,
        );
        if (options.json === true) {
          runtime.outRaw(
            serializeJsonReport(
              createJsonReport('specbridge.runner-conformance/1', `${CLI_BIN} ${VERSION}`, conformanceToJson(result)),
            ),
          );
        } else {
          runtime.out(reportTitle(`Conformance: ${name} (${result.runner})`));
          runtime.out();
          for (const group of result.groups) {
            if (!group.applicable) {
              runtime.out(infoLine(`${group.group}`, `not applicable — ${group.reason ?? ''}`));
              continue;
            }
            const failed = group.checks.filter((check) => check.status === 'failed');
            const header =
              failed.length > 0
                ? failLine(group.group, `${failed.length} failed`)
                : group.skipped > 0
                  ? warnLine(group.group, `${group.skipped} skipped (needs --network)`)
                  : okLine(group.group, `${group.checks.length} passed`);
            runtime.out(header);
            for (const check of group.checks) {
              if (check.status === 'failed') {
                runtime.out(failLine(`  ${check.title}`, check.detail));
              } else if (options.verbose === true) {
                const line = check.status === 'skipped' ? warnLine : okLine;
                runtime.out(line(`  ${check.title}`, check.detail));
              }
            }
          }
          runtime.out();
          if (result.failedChecks > 0) {
            runtime.out(failLine(`${result.failedChecks} check(s) failed.`));
          } else if (result.skippedChecks > 0) {
            runtime.out(
              warnLine(
                `All executed checks passed; ${result.skippedChecks} provider check(s) skipped.`,
                'production status is confirmed only when nothing is skipped (rerun with --network)',
              ),
            );
          } else {
            runtime.out(okLine('All applicable conformance checks passed — production confirmed.'));
          }
        }
        runtime.exitCode = result.passed ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

  // Hidden helper used by tests and docs generation: prints the operation
  // requirements table (kept out of `--help` to keep the surface small).
  runner
    .command('requirements', { hidden: true })
    .option('--operation <operation>', 'one operation')
    .action((options: RunnerOptions) => {
      const operation = parseOperation(options.operation);
      const entries = operation !== undefined ? [operation] : [...RUNNER_OPERATIONS];
      for (const entry of entries) {
        const requirements = RUNNER_OPERATION_REQUIREMENTS[entry];
        runtime.out(`${entry}: ${requirements.required.join(', ') || '(none)'}`);
        for (const group of requirements.anyOf) {
          runtime.out(`  boundary (any of): ${group.join(' | ')}`);
        }
      }
    });

  // Guard: selection sanity for scripting (used by smoke tests).
  runner
    .command('select', { hidden: true })
    .option('--operation <operation>', 'operation to select for')
    .option('--runner <profile>', 'explicit profile')
    .action((options: RunnerOptions & { runner?: string }) => {
      const context = loadExecutionContext(runtime);
      const operation = parseOperation(options.operation) ?? 'stage-generation';
      const selection = selectRunner(context.registry, context.config, {
        operation,
        ...(options.runner !== undefined ? { explicitProfile: options.runner } : {}),
      });
      runtime.outRaw(
        serializeJsonReport(
          createJsonReport('specbridge.runner-select/1', `${CLI_BIN} ${VERSION}`, selection),
        ),
      );
      runtime.exitCode = selection.ok ? EXIT_CODES.ok : EXIT_CODES.usageError;
    });
}
