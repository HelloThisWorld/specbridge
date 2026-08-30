import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError, sha256Hex } from '@specbridge/core';
import type {
  DogfoodTarget,
  ProductionCandidateIdentity,
  ProductionEnvironment,
  QualificationProfile,
} from '@specbridge/orchestration';
import {
  PRODUCTION_QUALIFICATION_ARTIFACTS,
  QUALIFICATION_ARTIFACTS,
  QUALIFICATION_PROFILES,
  QUALIFICATION_SCENARIOS,
  buildProductionQualificationManifest,
  buildMissionMetrics,
  buildQualificationReport,
  buildQualificationSummary,
  createProductionCandidate,
  emptyProductionQualificationMetrics,
  economicConfiguration,
  executeQualificationRun,
  findScenario,
  listRuns,
  normalizeTargetPath,
  productionCandidateIdentitySchema,
  productionQualificationEvidenceFileSchema,
  productionQualificationMetricsSchema,
  qualificationArtifactPath,
  renderProductionQualificationMarkdown,
  renderQualificationMarkdown,
  requireDogfoodRun,
  runPreflight,
  startQualificationRun,
  writeQualificationArtifact,
} from '@specbridge/orchestration';
import {
  blockedLine,
  createJsonReport,
  dim,
  failLine,
  infoLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { loadExecutionContext } from '../execution-context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge orchestrate qualify …` — the release-qualification surface
 * (vNext.9).
 *
 * It sits under `orchestrate` rather than becoming a new top-level command
 * family because qualification is not a separate product: it inspects and
 * exercises the same governed orchestration runtime everything else here
 * drives, and a `specbridge dogfood` family would imply otherwise.
 *
 * The whole group is opt-in and inert for a workspace that never runs it: no
 * file is created until `qualify run` is invoked, and nothing here changes
 * how an ordinary job behaves.
 *
 * What these commands deliberately DO NOT do:
 *
 *   they never start a Mission or drive a Job — that is `orchestrate run`,
 *   which already owns durability, pause, and resume, and which a second
 *   scheduler here would only duplicate;
 *
 *   they never authorize spending. `qualify preflight` DISPLAYS the economic
 *   configuration; the vNext.5 spend mode, budget, and per-task approval
 *   remain the only authority, unchanged.
 */

function jsonOut(runtime: CliRuntime, schema: string, data: Record<string, unknown>): void {
  runtime.outRaw(serializeJsonReport(createJsonReport(schema, `${CLI_BIN} ${VERSION}`, data)));
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function commandVersion(cwd: string, command: string, ...args: string[]): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().slice(0, 500) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Files that form the shipped runtime/control-plane identity. */
function isProductionRuntimePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return (
    normalized === 'package.json' ||
    normalized === 'pnpm-lock.yaml' ||
    normalized.startsWith('contracts/') ||
    (/^packages\/[^/]+\/(?:package\.json|src\/)/.test(normalized)) ||
    normalized.startsWith('integrations/github-action/dist/') ||
    normalized.startsWith('integrations/claude-code-plugin/specbridge/dist/') ||
    normalized.startsWith('integrations/claude-code-plugin/specbridge/.claude-plugin/') ||
    normalized.startsWith('integrations/codex-plugin/specbridge/dist/') ||
    normalized.startsWith('integrations/codex-plugin/specbridge/.codex-plugin/') ||
    normalized === 'integrations/codex-plugin/specbridge/.mcp.json'
  );
}

function jsonFile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function collectProductionCandidate(repositoryRoot: string, frozenAt: string): ProductionCandidateIdentity {
  const commit = git(repositoryRoot, 'rev-parse', 'HEAD')?.trim();
  const tracked = git(repositoryRoot, 'ls-files', '-z');
  if (commit === undefined || commit === null || tracked === null) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      'Production qualification requires a readable Git checkout of the SpecBridge release candidate.',
    );
  }
  const runtimePaths = tracked
    .split('\0')
    .filter((entry) => entry.length > 0 && isProductionRuntimePath(entry))
    .sort();
  const runtimeEntries = runtimePaths.map((relativePath) => {
    const absolute = path.join(repositoryRoot, relativePath);
    if (lstatSync(absolute).isSymbolicLink()) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Runtime identity refuses the tracked symlink ${relativePath}.`,
      );
    }
    return { path: relativePath, content: readFileSync(absolute) };
  });
  const dirty = (git(repositoryRoot, 'status', '--porcelain', '--untracked-files=normal') ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('.specbridge/'));
  const rootPackage = jsonFile(path.join(repositoryRoot, 'package.json'));
  const schemaVersions = jsonFile(path.join(repositoryRoot, 'contracts', 'schema-versions.json'));
  const bundleSpecs = [
    {
      name: 'claude-code-plugin',
      manifest: 'integrations/claude-code-plugin/specbridge/.claude-plugin/plugin.json',
      checksums: 'integrations/claude-code-plugin/specbridge/dist/checksums.json',
    },
    {
      name: 'codex-plugin',
      manifest: 'integrations/codex-plugin/specbridge/.codex-plugin/plugin.json',
      checksums: 'integrations/codex-plugin/specbridge/dist/checksums.json',
    },
  ];
  const bundles = bundleSpecs.map((bundle) => {
    const manifest = jsonFile(path.join(repositoryRoot, bundle.manifest));
    return {
      name: bundle.name,
      version: String(manifest['version'] ?? rootPackage['version'] ?? 'unknown'),
      digest: sha256Hex(readFileSync(path.join(repositoryRoot, bundle.checksums))),
    };
  });
  return createProductionCandidate({
    version: String(rootPackage['version'] ?? ''),
    commit,
    runtimeEntries,
    schemaVersions: Object.fromEntries(
      Object.entries(schemaVersions).map(([key, value]) => [key, String(value)]),
    ),
    bundles,
    sourceTreeClean: dirty.length === 0,
    frozenAt,
  });
}

function productionEnvironment(
  repositoryRoot: string,
  candidate: ProductionCandidateIdentity,
): ProductionEnvironment {
  return {
    os: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    pnpmVersion: commandVersion(repositoryRoot, 'pnpm', '--version'),
    gitVersion: commandVersion(repositoryRoot, 'git', '--version'),
    localModel: null,
    deerFlow: null,
    frontends: candidate.bundles.map((bundle) => ({ ...bundle })),
  };
}

/**
 * Inspect the dogfood target repository without importing a git library.
 *
 * Returns `null` when anything could not be determined, which the preflight
 * treats as a refusal. "We could not tell" is not evidence of safety.
 */
function inspectTargetRepository(
  repositoryPath: string,
): {
  isGitRepository: boolean;
  dirtyPaths: string[];
  branch: string | null;
  head: string | null;
  isolatedWorktree: boolean;
} | null {
  if (!existsSync(repositoryPath)) return null;
  const inside = git(repositoryPath, 'rev-parse', '--is-inside-work-tree');
  if (inside === null) return { isGitRepository: false, dirtyPaths: [], branch: null, head: null, isolatedWorktree: false };
  const status = git(repositoryPath, 'status', '--porcelain');
  if (status === null) return null;
  const dirtyPaths = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('.specbridge/'));
  const branch = git(repositoryPath, 'rev-parse', '--abbrev-ref', 'HEAD')?.trim() ?? null;
  const head = git(repositoryPath, 'rev-parse', 'HEAD')?.trim() ?? null;
  // `git rev-parse --git-dir` inside a linked worktree resolves to a path
  // under the main repository's `.git/worktrees/`, which is how a worktree
  // can be recognized without asking the operator to assert it.
  const gitDir = git(repositoryPath, 'rev-parse', '--git-dir')?.trim() ?? '';
  const isolatedWorktree = gitDir.replace(/\\/g, '/').includes('/worktrees/');
  return { isGitRepository: true, dirtyPaths, branch, head, isolatedWorktree };
}

function parseProfile(value: string): QualificationProfile {
  const profile = QUALIFICATION_PROFILES.find((entry) => entry === value);
  if (profile === undefined) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Unknown qualification profile "${value}". Valid profiles: ${QUALIFICATION_PROFILES.join(', ')}.`,
    );
  }
  return profile;
}

/**
 * Resolve the dogfood target from operator input.
 *
 * There is no default path and no machine-specific fallback: without an
 * explicit `--target`, the run is honestly a FIXTURE run and can never
 * satisfy the real-product release gate.
 */
function resolveTarget(options: { target?: string; targetName?: string }): DogfoodTarget {
  const repositoryPath = normalizeTargetPath(options.target);
  const name = options.targetName ?? (repositoryPath === null ? 'deterministic fixture' : path.basename(repositoryPath));
  if (repositoryPath === null) {
    return {
      kind: 'FIXTURE',
      name,
      repositoryPath: null,
      available: false,
      unavailableReason:
        'No dogfood target repository was configured for this run; only deterministic scenarios apply.',
      startingCommit: null,
      endingCommit: null,
      branch: null,
      worktreePath: null,
      missionSpec: null,
    };
  }
  const repository = inspectTargetRepository(repositoryPath);
  const available = repository !== null && repository.isGitRepository;
  return {
    kind: 'REAL_REPOSITORY',
    name,
    repositoryPath,
    available,
    unavailableReason: available
      ? null
      : repository === null
        ? `The configured target "${repositoryPath}" could not be inspected.`
        : `The configured target "${repositoryPath}" is not a git repository.`,
    startingCommit: repository?.head ?? null,
    endingCommit: null,
    branch: repository?.branch ?? null,
    worktreePath: repository?.isolatedWorktree === true ? repositoryPath : null,
    missionSpec: null,
  };
}

export function registerOrchestrateQualifyCommands(orchestrate: Command, runtime: CliRuntime): void {
  const qualify = orchestrate
    .command('qualify')
    .description(
      'Release qualification: scenario matrix, preflight, deterministic scenarios, and reports',
    );

  // -------------------------------------------------------------------------
  // scenarios — the machine-readable matrix
  // -------------------------------------------------------------------------
  qualify
    .command('scenarios')
    .description('List the qualification scenario matrix (read-only)')
    .option('--area <name>', 'only scenarios in one area')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { area?: string; json?: boolean }) => {
      const scenarios = QUALIFICATION_SCENARIOS.filter(
        (scenario) => options.area === undefined || scenario.area === options.area,
      );
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-qualify-scenarios', {
          scenarios: scenarios.map((scenario) => ({
            id: scenario.id,
            area: scenario.area,
            title: scenario.title,
            invariant: scenario.invariant,
            executionKind: scenario.executionKind,
            requirement: scenario.requirement,
            faultClasses: scenario.faultClasses,
            resources: scenario.resources,
            minimumProfile: scenario.minimumProfile,
            implementedBy: scenario.implementedBy ?? null,
          })),
        });
        return;
      }
      runtime.out(reportTitle(`Qualification scenarios (${scenarios.length})`));
      let area = '';
      for (const scenario of scenarios) {
        if (scenario.area !== area) {
          area = scenario.area;
          runtime.out(sectionTitle(area));
        }
        runtime.out(`  ${scenario.id}  ${dim(`[${scenario.executionKind}/${scenario.requirement}]`)}`);
        runtime.out(dim(`    ${scenario.invariant}`));
        if (scenario.implementedBy !== undefined) {
          runtime.out(dim(`    implemented by ${scenario.implementedBy}`));
        }
      }
    });

  // -------------------------------------------------------------------------
  // preflight — fail-closed safety check for a real dogfood
  // -------------------------------------------------------------------------
  qualify
    .command('preflight')
    .description('Check dogfood safety and show the economic configuration (authorizes nothing)')
    .option('--profile <name>', `qualification profile (${QUALIFICATION_PROFILES.join('|')})`, 'offline')
    .option('--target <path>', 'dogfood target repository path (real dogfood only)')
    .option('--target-name <name>', 'product name recorded on the run')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { profile?: string; target?: string; targetName?: string; json?: boolean }) => {
      const context = loadExecutionContext(runtime);
      const profile = parseProfile(options.profile ?? 'offline');
      const target = resolveTarget(options);
      const repository =
        target.repositoryPath === null ? undefined : inspectTargetRepository(target.repositoryPath);
      const result = runPreflight({
        workspace: context.workspace,
        config: context.config,
        profile,
        target,
        targetRepository: repository,
      });

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-qualify-preflight', {
          profile: result.profile,
          safe: result.safe,
          paidCapable: result.paidCapable,
          target,
          findings: result.findings,
          economics: result.economics,
        });
        runtime.exitCode = result.safe ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
        return;
      }

      runtime.out(reportTitle(`Dogfood preflight — profile ${result.profile}`));
      for (const finding of result.findings) {
        const line = `  ${finding.id}: ${finding.message}`;
        if (finding.severity === 'refuse') runtime.out(failLine(line));
        else if (finding.severity === 'warn') runtime.out(warnLine(line));
        else runtime.out(okLine(line));
        for (const step of finding.remediation) runtime.out(dim(`      - ${step}`));
      }

      runtime.out(sectionTitle('Economic configuration'));
      const economics = result.economics;
      runtime.out(dim(`  LOCAL: ${economics.localEnabled ? 'enabled' : 'disabled'}, model ${economics.localModelConfigured ? 'configured' : 'not configured'}, strategy ${economics.localExecutionStrategy}`));
      runtime.out(dim(`  LOCAL harness profile: ${economics.localHarnessProfile ?? 'none'}`));
      runtime.out(dim(`  SUBSCRIPTION: ${economics.subscriptionWorkerConfigured ? 'configured' : 'not configured'}`));
      runtime.out(dim(`  Quota telemetry: ${economics.quotaTelemetrySource}`));
      runtime.out(dim(`  API spend mode: ${economics.apiSpendMode}`));
      runtime.out(dim(`  API harness profile: ${economics.apiHarnessProfile ?? 'none'}`));
      runtime.out(dim(`  API pricing: ${economics.apiPricingConfigured ? 'configured' : 'not configured'}`));
      runtime.out(
        dim(
          `  API budget: ${economics.apiMaxBudgetUsd === null ? 'no job ceiling' : `$${economics.apiMaxBudgetUsd.toFixed(2)} per job`}` +
            `${economics.apiPerTaskCeilingUsd === null ? '' : `, $${economics.apiPerTaskCeilingUsd.toFixed(2)} per task`}`,
        ),
      );
      runtime.out(dim(`  Context strategy: ${economics.contextStrategy}; adaptive mode: ${economics.adaptiveMode}`));
      runtime.out(
        dim(
          `  Protected paths: ${economics.protectedPaths.length}; verification: ${economics.verificationCommands.join(', ') || 'none'}`,
        ),
      );
      runtime.out('');
      runtime.out(
        result.safe
          ? okLine('Preflight passed. This does NOT authorize spending: API spend mode and budget still decide.')
          : failLine('Preflight REFUSED. Fix the findings above before starting a dogfood run.'),
      );
      runtime.exitCode = result.safe ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
    });

  // -------------------------------------------------------------------------
  // run — execute the scenarios this invocation can honestly execute
  // -------------------------------------------------------------------------
  qualify
    .command('run')
    .description('Run the deterministic qualification scenarios and record a durable result')
    .option('--profile <name>', `qualification profile (${QUALIFICATION_PROFILES.join('|')})`, 'offline')
    .option('--target <path>', 'dogfood target repository path (real dogfood only)')
    .option('--target-name <name>', 'product name recorded on the run')
    .option('--run-id <id>', 'continue an existing qualification run instead of starting one')
    .option('--scenario <id...>', 'run only the named scenarios')
    .option('--failed-only', 'only re-run scenarios currently FAIL or NOT_RUN')
    .option('--direction <text>', 'the high-level Mission direction, recorded verbatim')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      (options: {
        profile?: string;
        target?: string;
        targetName?: string;
        runId?: string;
        scenario?: string[];
        failedOnly?: boolean;
        direction?: string;
        json?: boolean;
      }) => {
        const context = loadExecutionContext(runtime);
        const profile = parseProfile(options.profile ?? 'offline');

        for (const scenarioId of options.scenario ?? []) {
          if (findScenario(scenarioId) === undefined) {
            throw new SpecBridgeError(
              'INVALID_ARGUMENT',
              `Unknown scenario "${scenarioId}". List them with \`${CLI_BIN} orchestrate qualify scenarios\`.`,
            );
          }
        }

        let sequence = 0;
        const deps = {
          workspace: context.workspace,
          config: context.config,
          clock: () => runtime.now(),
          idFactory: () => {
            sequence += 1;
            return `${Date.now().toString(36)}${String(sequence).padStart(3, '0')}`;
          },
        };

        const run =
          options.runId === undefined
            ? startQualificationRun(deps, {
                profile,
                target: resolveTarget(options),
                missionDirection: options.direction ?? null,
                versions: { specBridgeVersion: VERSION },
              })
            : requireDogfoodRun(context.workspace, options.runId);

        // Preflight gates a run that would touch real resources. An offline
        // run against a fixture cannot damage anything, and refusing it for
        // an unconfigured subscription would make the CI-safe path the
        // hardest one to use.
        if (profile !== 'offline') {
          const target = run.target;
          const repository =
            target.repositoryPath === null ? undefined : inspectTargetRepository(target.repositoryPath);
          const preflight = runPreflight({
            workspace: context.workspace,
            config: context.config,
            profile,
            target,
            targetRepository: repository,
          });
          if (!preflight.safe) {
            for (const finding of preflight.findings.filter((entry) => entry.severity === 'refuse')) {
              runtime.out(failLine(`  ${finding.id}: ${finding.message}`));
            }
            throw new SpecBridgeError(
              'INVALID_ARGUMENT',
              `Preflight refused profile "${profile}". Run \`${CLI_BIN} orchestrate qualify preflight --profile ${profile}\` for the full report.`,
            );
          }
        }

        const result = executeQualificationRun({
          deps,
          run,
          executor: 'cli',
          ...(options.scenario === undefined ? {} : { only: options.scenario }),
          ...(options.failedOnly === undefined ? {} : { failedOnly: options.failedOnly }),
        });

        const report = buildQualificationReport({
          workspace: context.workspace,
          runId: run.runId,
          generatedAt: runtime.now().toISOString(),
        });

        if (options.json === true) {
          jsonOut(runtime, 'orchestrate-qualify-run', {
            runId: run.runId,
            executed: result.executed.length,
            passed: result.passed,
            failed: result.failed,
            skipped: result.skipped.length,
            preserved: result.preserved.length,
            verdict: report.verdict,
            realTargetQualification: report.realTargetQualification,
            blockers: report.blockers,
            scenarios: report.scenarios,
          });
          runtime.exitCode = result.failed > 0 ? EXIT_CODES.gateFailure : EXIT_CODES.ok;
          return;
        }

        runtime.out(reportTitle(`Qualification run ${run.runId} — profile ${profile}`));
        for (const scenario of result.executed) {
          runtime.out(
            scenario.status === 'PASS'
              ? okLine(`  ${scenario.scenarioId}`)
              : failLine(`  ${scenario.scenarioId}: ${scenario.failureDetail ?? ''}`),
          );
        }
        runtime.out(
          dim(
            `  ${result.passed} passed, ${result.failed} failed, ${result.skipped.length} skipped with reason, ` +
              `${result.preserved.length} preserved from other executors.`,
          ),
        );
        runtime.out(sectionTitle('Release gate'));
        runtime.out(
          report.verdict === 'PASS'
            ? okLine(`  ${report.verdict}`)
            : report.verdict === 'PASS_WITH_LIMITATIONS'
              ? warnLine(`  ${report.verdict}`)
              : failLine(`  ${report.verdict}`),
        );
        runtime.out(dim(`  Real-product qualification: ${report.realTargetQualification}`));
        for (const blocker of report.blockers.slice(0, 10)) {
          runtime.out(blockedLine(`  ${blocker.class}: ${blocker.detail}`));
        }
        if (report.blockers.length > 10) {
          runtime.out(dim(`  … and ${report.blockers.length - 10} more blocker(s).`));
        }
        runtime.out(
          dim(`  Full report: \`${CLI_BIN} orchestrate qualify report ${run.runId}\`.`),
        );
        runtime.exitCode = result.failed > 0 ? EXIT_CODES.gateFailure : EXIT_CODES.ok;
      },
    );

  // -------------------------------------------------------------------------
  // runs — list qualification runs
  // -------------------------------------------------------------------------
  qualify
    .command('runs')
    .description('List qualification runs (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const runs = listRuns(workspace);
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-qualify-runs', {
          runs: runs.map((run) => ({
            runId: run.runId,
            status: run.status,
            profile: run.profile,
            iteration: run.iteration,
            previousRunId: run.previousRunId,
            target: run.target,
            missionId: run.missionId,
            jobId: run.jobId,
            startedAt: run.startedAt,
            finalizedAt: run.finalizedAt,
          })),
        });
        return;
      }
      runtime.out(reportTitle(`Qualification runs (${runs.length})`));
      if (runs.length === 0) {
        runtime.out(dim('  None recorded. Start one with `orchestrate qualify run`.'));
      }
      for (const run of runs) {
        runtime.out(infoLine(`  ${run.runId}  ${run.status}  profile ${run.profile}  iteration ${run.iteration}`));
        runtime.out(dim(`    target ${run.target.name} (${run.target.kind}); started ${run.startedAt}`));
      }
    });

  // -------------------------------------------------------------------------
  // freeze — bind every later release attestation to one immutable candidate
  // -------------------------------------------------------------------------
  qualify
    .command('freeze')
    .description('Freeze the vNext.10.2 production candidate for one qualification run')
    .argument('<run-id>', 'qualification run id')
    .option('--json', 'output the machine-readable candidate identity')
    .action((runId: string, options: { json?: boolean }) => {
      const context = loadExecutionContext(runtime);
      requireDogfoodRun(context.workspace, runId);
      const repositoryRoot = context.workspace.gitRootDir ?? context.workspace.rootDir;
      const file = qualificationArtifactPath(
        context.workspace,
        runId,
        PRODUCTION_QUALIFICATION_ARTIFACTS.candidate,
      );
      let candidate: ProductionCandidateIdentity;
      if (existsSync(file)) {
        candidate = productionCandidateIdentitySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      } else {
        candidate = collectProductionCandidate(repositoryRoot, runtime.now().toISOString());
        if (!candidate.sourceTreeClean) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            'Refusing to freeze a production candidate from a dirty source tree.',
            { remediation: ['Commit or remove every source/runtime change, then start a fresh candidate freeze.'] },
          );
        }
        writeQualificationArtifact(
          context.workspace,
          runId,
          PRODUCTION_QUALIFICATION_ARTIFACTS.candidate,
          `${JSON.stringify(candidate, null, 2)}\n`,
        );
      }
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-qualify-freeze', { runId, candidate });
        return;
      }
      runtime.out(reportTitle(`Production candidate — ${runId}`));
      runtime.out(okLine(`  commit ${candidate.commit}`));
      runtime.out(dim(`  runtime ${candidate.runtimeDigest} (${candidate.runtimeFileCount} files)`));
      runtime.out(dim(`  identity: .specbridge/qualification/${runId}/reports/${PRODUCTION_QUALIFICATION_ARTIFACTS.candidate}`));
    });

  // -------------------------------------------------------------------------
  // release — deterministic A-T decision over candidate-bound evidence
  // -------------------------------------------------------------------------
  qualify
    .command('release')
    .description('Finalize the vNext.10.2 A-T production qualification (never auto-publishes)')
    .argument('<run-id>', 'qualification run id with a frozen production candidate')
    .option('--evidence <file>', 'candidate-bound gate evidence JSON')
    .option('--json', 'output the compact machine release decision')
    .option('--markdown', 'print the full production qualification report')
    .option('--no-write', 'derive a preview without persisting final artifacts')
    .action(
      (runId: string, options: { evidence?: string; json?: boolean; markdown?: boolean; write?: boolean }) => {
        const context = loadExecutionContext(runtime);
        requireDogfoodRun(context.workspace, runId);
        const repositoryRoot = context.workspace.gitRootDir ?? context.workspace.rootDir;
        const candidateFile = qualificationArtifactPath(
          context.workspace,
          runId,
          PRODUCTION_QUALIFICATION_ARTIFACTS.candidate,
        );
        if (!existsSync(candidateFile)) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `No frozen production candidate exists for ${runId}.`,
            { remediation: [`Run \`${CLI_BIN} orchestrate qualify freeze ${runId}\` before executing qualification gates.`] },
          );
        }
        const candidate = productionCandidateIdentitySchema.parse(
          JSON.parse(readFileSync(candidateFile, 'utf8')),
        );
        const currentCandidate = collectProductionCandidate(repositoryRoot, runtime.now().toISOString());
        const evidence = options.evidence === undefined
          ? productionQualificationEvidenceFileSchema.parse({})
          : productionQualificationEvidenceFileSchema.parse(
              JSON.parse(readFileSync(path.resolve(options.evidence), 'utf8')),
            );
        const baseMetrics = emptyProductionQualificationMetrics();
        const runtimeChanged =
          candidate.commit !== currentCandidate.commit ||
          candidate.runtimeDigest !== currentCandidate.runtimeDigest ||
          !currentCandidate.sourceTreeClean;
        const metrics = productionQualificationMetricsSchema.parse({
          ...baseMetrics,
          ...evidence.metrics,
          runtimeMutation: runtimeChanged ? 1 : 0,
          runtimeStartDigest: candidate.runtimeDigest,
          runtimeEndDigest: currentCandidate.runtimeDigest,
          controlPlaneSelfRepairEnabled: context.config.autonomy.controlPlaneRepair.enabled,
        });
        const baseEnvironment = productionEnvironment(repositoryRoot, candidate);
        const environment = {
          ...baseEnvironment,
          ...(evidence.localModel === undefined ? {} : { localModel: evidence.localModel }),
          ...(evidence.deerFlow === undefined ? {} : { deerFlow: evidence.deerFlow }),
          ...(evidence.frontends === undefined ? {} : { frontends: evidence.frontends }),
        };
        const manifest = buildProductionQualificationManifest({
          qualificationRunId: runId,
          candidate,
          environment,
          gates: evidence.gates,
          historicalFaults: evidence.historicalFaults,
          metrics,
          knownLimitations: evidence.knownLimitations,
          generatedAt: runtime.now().toISOString(),
        });
        const markdown = renderProductionQualificationMarkdown(manifest);

        if (options.write !== false) {
          const manifestFile = qualificationArtifactPath(
            context.workspace,
            runId,
            PRODUCTION_QUALIFICATION_ARTIFACTS.manifest,
          );
          if (existsSync(manifestFile)) {
            throw new SpecBridgeError(
              'INVALID_ARGUMENT',
              `Production qualification ${runId} was already finalized; its evidence is immutable.`,
              { remediation: ['Start a new qualification run for a rerun or a changed release candidate.'] },
            );
          }
          writeQualificationArtifact(
            context.workspace,
            runId,
            PRODUCTION_QUALIFICATION_ARTIFACTS.manifest,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          writeQualificationArtifact(
            context.workspace,
            runId,
            PRODUCTION_QUALIFICATION_ARTIFACTS.report,
            markdown,
          );
          writeQualificationArtifact(
            context.workspace,
            runId,
            PRODUCTION_QUALIFICATION_ARTIFACTS.decision,
            `${JSON.stringify(manifest.decision, null, 2)}\n`,
          );
          writeQualificationArtifact(
            context.workspace,
            runId,
            PRODUCTION_QUALIFICATION_ARTIFACTS.faultCoverage,
            `${JSON.stringify(manifest.historicalFaults, null, 2)}\n`,
          );
          if (manifest.marker !== null) {
            writeQualificationArtifact(
              context.workspace,
              runId,
              PRODUCTION_QUALIFICATION_ARTIFACTS.marker,
              `${JSON.stringify(manifest.marker, null, 2)}\n`,
            );
          }
        }

        if (options.json === true) {
          jsonOut(runtime, 'orchestrate-qualify-release', {
            runId,
            release: manifest.release,
            candidate: manifest.candidate,
            decision: manifest.decision,
            marker: manifest.marker,
          });
        } else if (options.markdown === true) {
          runtime.outRaw(markdown);
        } else {
          runtime.out(reportTitle(`Production qualification — ${manifest.release}`));
          runtime.out(
            manifest.decision.status === 'READY'
              ? okLine('  READY — PRODUCTION_READY marker emitted')
              : failLine(`  NOT_READY — ${manifest.decision.blockers.length} blocker(s)`),
          );
          for (const gateId of manifest.decision.failedRequiredGateIds) {
            runtime.out(blockedLine(`  ${gateId}`));
          }
          if (options.write !== false) {
            runtime.out(dim(`  Final artifacts: .specbridge/qualification/${runId}/reports/`));
          }
          runtime.out(dim('  This command never tags or publishes a release.'));
        }
        runtime.exitCode = manifest.decision.status === 'READY' ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
      },
    );

  // -------------------------------------------------------------------------
  // report — render and persist the release artifacts
  // -------------------------------------------------------------------------
  qualify
    .command('report')
    .description('Build the DogfoodQualificationReport for one run and write its artifacts')
    .argument('<run-id>', 'qualification run id')
    .option('--json', 'output the machine-readable summary')
    .option('--markdown', 'print the human-readable report to stdout')
    .option('--no-write', 'do not persist artifacts into the run directory')
    .action(
      (runId: string, options: { json?: boolean; markdown?: boolean; write?: boolean }) => {
        const workspace = runtime.workspace();
        const report = buildQualificationReport({
          workspace,
          runId,
          generatedAt: runtime.now().toISOString(),
        });
        const markdown = renderQualificationMarkdown(report);
        const summary = buildQualificationSummary(report);

        if (options.write !== false) {
          writeQualificationArtifact(
            workspace,
            runId,
            QUALIFICATION_ARTIFACTS.summary,
            `${JSON.stringify(summary, null, 2)}\n`,
          );
          writeQualificationArtifact(workspace, runId, QUALIFICATION_ARTIFACTS.report, markdown);
          writeQualificationArtifact(
            workspace,
            runId,
            QUALIFICATION_ARTIFACTS.scenarios,
            `${JSON.stringify(report.scenarioResults, null, 2)}\n`,
          );
          writeQualificationArtifact(
            workspace,
            runId,
            QUALIFICATION_ARTIFACTS.metrics,
            `${JSON.stringify(buildMissionMetrics(report), null, 2)}\n`,
          );
        }

        if (options.json === true) {
          jsonOut(runtime, 'orchestrate-qualify-report', summary);
          runtime.exitCode = report.verdict === 'FAIL' ? EXIT_CODES.gateFailure : EXIT_CODES.ok;
          return;
        }
        if (options.markdown === true) {
          runtime.outRaw(markdown);
          runtime.exitCode = report.verdict === 'FAIL' ? EXIT_CODES.gateFailure : EXIT_CODES.ok;
          return;
        }

        runtime.out(reportTitle(`Qualification report — ${report.runId}`));
        runtime.out(
          report.verdict === 'PASS'
            ? okLine(`  Verdict: ${report.verdict}`)
            : report.verdict === 'PASS_WITH_LIMITATIONS'
              ? warnLine(`  Verdict: ${report.verdict}`)
              : failLine(`  Verdict: ${report.verdict}`),
        );
        runtime.out(dim(`  Real-product qualification: ${report.realTargetQualification}`));
        if (report.realTargetQualificationReason !== null) {
          runtime.out(dim(`    ${report.realTargetQualificationReason}`));
        }
        runtime.out(sectionTitle('Scenarios'));
        const s = report.scenarios;
        runtime.out(
          dim(
            `  ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped, ${s.notRun} not run, of ${s.total}. ` +
              `Required: ${s.requiredPassed}/${s.requiredTotal}.`,
          ),
        );
        runtime.out(sectionTitle('Zero-tolerance conditions'));
        for (const [condition, count] of Object.entries(report.zeroTolerance)) {
          const line = `  ${condition}: ${String(count)}`;
          runtime.out(count === 0 ? dim(line) : failLine(line));
        }
        if (report.blockers.length > 0) {
          runtime.out(sectionTitle('Release blockers'));
          for (const blocker of report.blockers) {
            runtime.out(blockedLine(`  ${blocker.class}: ${blocker.detail}`));
          }
        }
        if (report.limitations.length > 0) {
          runtime.out(sectionTitle('Limitations'));
          for (const limitation of report.limitations) {
            runtime.out(warnLine(`  ${limitation.class}: ${limitation.detail}`));
          }
        }
        runtime.out(sectionTitle('Resource attribution'));
        for (const [resource, attribution] of Object.entries(report.resourceAttribution)) {
          if (attribution === 'NOT_EXERCISED') continue;
          runtime.out(dim(`  ${resource}: ${attribution}`));
        }
        if (options.write !== false) {
          runtime.out('');
          runtime.out(dim(`  Artifacts written under .specbridge/qualification/${runId}/reports/.`));
        }
        runtime.exitCode = report.verdict === 'FAIL' ? EXIT_CODES.gateFailure : EXIT_CODES.ok;
      },
    );

  // -------------------------------------------------------------------------
  // economics — the economic configuration alone (authorizes nothing)
  // -------------------------------------------------------------------------
  qualify
    .command('economics')
    .description('Show the resolved economic configuration (read-only; authorizes no spending)')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { json?: boolean }) => {
      const context = loadExecutionContext(runtime);
      const economics = economicConfiguration(context.config);
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-qualify-economics', { ...economics });
        return;
      }
      runtime.out(reportTitle('Economic configuration'));
      runtime.out(sectionTitle('LOCAL'));
      runtime.out(dim(`  enabled: ${String(economics.localEnabled)}`));
      runtime.out(dim(`  model configured: ${String(economics.localModelConfigured)}`));
      runtime.out(dim(`  execution strategy: ${economics.localExecutionStrategy}`));
      runtime.out(dim(`  harness profile: ${economics.localHarnessProfile ?? 'none'}`));
      runtime.out(sectionTitle('SUBSCRIPTION'));
      runtime.out(dim(`  strong worker configured: ${String(economics.subscriptionWorkerConfigured)}`));
      runtime.out(dim(`  quota telemetry: ${economics.quotaTelemetrySource}`));
      runtime.out(sectionTitle('API'));
      runtime.out(dim(`  spend mode: ${economics.apiSpendMode}`));
      runtime.out(dim(`  harness profile: ${economics.apiHarnessProfile ?? 'none'}`));
      runtime.out(dim(`  pricing configured: ${String(economics.apiPricingConfigured)}`));
      runtime.out(
        dim(
          `  budget: ${economics.apiMaxBudgetUsd === null ? 'no job ceiling' : `$${economics.apiMaxBudgetUsd.toFixed(2)} per job`}` +
            `${economics.apiPerTaskCeilingUsd === null ? '' : `, $${economics.apiPerTaskCeilingUsd.toFixed(2)} per task`}`,
        ),
      );
      runtime.out('');
      runtime.out(dim('  Showing configuration is not approval. Spending still requires the configured'));
      runtime.out(dim('  spend mode, an admissible budget, and — in MANUAL mode — an explicit approval.'));
    });
}
