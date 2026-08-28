import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import {
  CLI_BIN,
  EXIT_CODES,
  HARD_HUMAN_AUTHORITY_SURFACES,
  SpecBridgeError,
  autonomyPolicySchema,
  overnightAutonomyPreset,
  writeFileAtomic,
} from '@specbridge/core';
import type { AutonomyDeps, MissionSeal, PreflightReport } from '@specbridge/autonomy';
import {
  assessSealCompleteness,
  assessSealExecutability,
  createInProcessDriverHost,
  draftSeal,
  latestExecutableSeal,
  listCertificationRuns,
  listControlPlaneRepairs,
  listLeases,
  listSeals,
  listToolsmithRequests,
  readClosureLedger,
  readSeal,
  readSupervisionLog,
  requiredSurfacesFor,
  revokeSeal,
  createComposeRuntime,
  createPlaywrightDriver,
  runOvernightPreflight,
  runUnattendedMission,
  sealMission,
  formatMeasurement,
  computeAutonomyTelemetry,
  waiveClosureItem,
} from '@specbridge/autonomy';
import { createJob, listJobs, requireJobState } from '@specbridge/orchestration';
import { findMissionForSpec, listMissions } from '@specbridge/mission';
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
 * `specbridge autonomy …` and `specbridge overnight …` — the unattended
 * surface.
 *
 * The whole public UX of vNext.10 is four commands, and that is the point:
 *
 *   autonomy setup              once per machine
 *   autonomy seal <mission>     once per intent, the human authorization
 *   overnight preflight <m>     before leaving; must say OVERNIGHT_READY
 *   overnight run <m>           the launch, then go to sleep
 *
 * Everything else here is INSPECTION. It exists because an operator will
 * want to look, and it is carefully not required for anything to progress:
 * `autonomy status`, `autonomy report`, and `autonomy watch` read durable
 * state and change nothing. A runtime whose progress depended on somebody
 * watching would not be unattended.
 *
 * `autonomy seal` is the one command here that carries human authority, and
 * it is deliberately CLI-only. No MCP tool authorizes a seal, exactly as no
 * MCP tool approves a spec stage.
 */

function jsonOut(runtime: CliRuntime, schema: string, data: Record<string, unknown>): void {
  runtime.outRaw(serializeJsonReport(createJsonReport(schema, `${CLI_BIN} ${VERSION}`, data)));
}

function autonomyDeps(runtime: CliRuntime): AutonomyDeps {
  const context = loadExecutionContext(runtime);
  return {
    workspace: context.workspace,
    config: context.config,
    clock: () => runtime.now(),
    host: 'cli',
  };
}

/** Resolve a mission id or spec name to a mission id. */
function resolveMissionId(runtime: CliRuntime, subject: string): string {
  const workspace = runtime.workspace();
  const missions = listMissions(workspace).missions;
  const byId = missions.find((mission) => mission.missionId === subject);
  if (byId !== undefined) return byId.missionId;
  const byName = missions.find((mission) => mission.name === subject);
  if (byName !== undefined) return byName.missionId;
  const bySpec = findMissionForSpec(workspace, subject);
  if (bySpec !== undefined) return bySpec.missionId;
  throw new SpecBridgeError(
    'SPEC_NOT_FOUND',
    `No mission matches "${subject}". List missions with \`${CLI_BIN} mission list\`.`,
  );
}

// ---------------------------------------------------------------------------
// autonomy setup
// ---------------------------------------------------------------------------

function registerSetup(autonomy: Command, runtime: CliRuntime): void {
  autonomy
    .command('setup')
    .description('Write the autonomy policy into .specbridge/config.json')
    .option('--mode <mode>', 'INTERACTIVE | SUPERVISED | OVERNIGHT | ZERO_TOUCH', 'OVERNIGHT')
    .option('--specbridge-source <path>', 'SpecBridge checkout a control-plane repair may patch')
    .option('--json', 'machine-readable output')
    .action((options: { mode: string; specbridgeSource?: string; json?: boolean }) => {
      const workspace = runtime.workspace();
      const mode = options.mode.toUpperCase();
      if (mode !== 'OVERNIGHT' && mode !== 'ZERO_TOUCH' && mode !== 'SUPERVISED' && mode !== 'INTERACTIVE') {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `Unknown autonomy mode "${options.mode}". Use INTERACTIVE, SUPERVISED, OVERNIGHT, or ZERO_TOUCH.`,
        );
      }
      const preset =
        mode === 'OVERNIGHT' || mode === 'ZERO_TOUCH'
          ? autonomyPolicySchema.parse({
              ...overnightAutonomyPreset(),
              mode,
              ...(options.specbridgeSource !== undefined
                ? {
                    controlPlaneRepair: {
                      enabled: true,
                      sourcePath: path.resolve(runtime.cwd, options.specbridgeSource),
                    },
                  }
                : {}),
            })
          : autonomyPolicySchema.parse({ mode });

      const configPath = path.join(workspace.rootDir, '.specbridge', 'config.json');
      const existing = existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
        : { schemaVersion: '2.0.0' };
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileAtomic(
        configPath,
        `${JSON.stringify({ ...existing, autonomy: preset }, null, 2)}\n`,
      );

      if (options.json === true) {
        jsonOut(runtime, 'autonomy-setup/v1', {
          mode: preset.mode,
          humanGate: preset.humanGate,
          configPath,
          toolsmithCapabilities: preset.toolsmith.capabilities,
        });
        return;
      }
      runtime.out(reportTitle(`Autonomy policy written to ${path.relative(runtime.cwd, configPath)}`));
      runtime.out(okLine(`mode ${preset.mode}, human gate ${preset.humanGate}`));
      runtime.out(
        infoLine(
          `Toolsmith: ${preset.toolsmith.enabled ? preset.toolsmith.capabilities.join(', ') : 'disabled'}`,
        ),
      );
      runtime.out(
        infoLine(
          `supervisor ${preset.supervisor.enabled ? 'on' : 'off'}, environments ` +
            `${preset.environments.enabled ? 'on' : 'off'}, browser ` +
            `${preset.browser.enabled ? 'on' : 'off'}, critic ${preset.critic.mode}`,
        ),
      );
      if (preset.controlPlaneRepair.enabled) {
        runtime.out(infoLine(`control-plane repair: ${preset.controlPlaneRepair.sourcePath}`));
      } else {
        runtime.out(
          dim('control-plane repair is off: pass --specbridge-source to enable it.'),
        );
      }
      runtime.out('');
      runtime.out(sectionTitle('Always a human decision, whatever this file says'));
      for (const surface of HARD_HUMAN_AUTHORITY_SURFACES) runtime.out(dim(`  ${surface}`));
    });
}

// ---------------------------------------------------------------------------
// autonomy policy
// ---------------------------------------------------------------------------

function registerPolicy(autonomy: Command, runtime: CliRuntime): void {
  autonomy
    .command('policy')
    .description('Print the resolved autonomy policy and the authority boundary')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      const deps = autonomyDeps(runtime);
      const policy = deps.config.autonomy;
      if (options.json === true) {
        jsonOut(runtime, 'autonomy-policy/v1', {
          policy: policy as unknown as Record<string, unknown>,
          hardHumanAuthoritySurfaces: [...HARD_HUMAN_AUTHORITY_SURFACES],
        });
        return;
      }
      runtime.out(reportTitle(`Autonomy: ${policy.mode}, human gate ${policy.humanGate}`));
      runtime.out(sectionTitle('Delegated engineering decisions'));
      for (const [surface, setting] of Object.entries(policy.decisions)) {
        runtime.out(setting === 'AUTO' ? okLine(`${surface}: AUTO`) : warnLine(`${surface}: HUMAN`));
      }
      runtime.out(sectionTitle('Delegated recovery'));
      for (const [surface, setting] of Object.entries(policy.recovery)) {
        runtime.out(setting === 'AUTO' ? okLine(`${surface}: AUTO`) : warnLine(`${surface}: HUMAN`));
      }
      runtime.out(sectionTitle('Always a human decision'));
      runtime.out(dim('No configuration, agent, or model can move any of these.'));
      for (const surface of HARD_HUMAN_AUTHORITY_SURFACES) runtime.out(blockedLine(surface));
    });
}

// ---------------------------------------------------------------------------
// autonomy seal
// ---------------------------------------------------------------------------

function registerSeal(autonomy: Command, runtime: CliRuntime): void {
  autonomy
    .command('seal <mission>')
    .description('Draft, and with --confirm authorize, the delegated intent seal')
    .option('--confirm', 'authorize the seal (this is the human authorization)')
    .option('--max-spend <usd>', 'monetary ceiling this seal authorizes')
    .option('--lanes <lanes>', 'comma-separated lanes: LOCAL,SUBSCRIPTION,API', 'LOCAL,SUBSCRIPTION')
    .option('--json', 'machine-readable output')
    .action(
      (
        subject: string,
        options: { confirm?: boolean; maxSpend?: string; lanes: string; json?: boolean },
      ) => {
        const deps = autonomyDeps(runtime);
        const missionId = resolveMissionId(runtime, subject);
        const lanes = options.lanes
          .split(',')
          .map((lane) => lane.trim().toUpperCase())
          .filter((lane): lane is 'LOCAL' | 'SUBSCRIPTION' | 'API' =>
            lane === 'LOCAL' || lane === 'SUBSCRIPTION' || lane === 'API',
          );
        const draft = draftSeal(deps, {
          missionId,
          maxApiSpendUsd: options.maxSpend !== undefined ? Number(options.maxSpend) : null,
          allowedLanes: lanes.length > 0 ? lanes : ['LOCAL'],
        });
        const completeness = assessSealCompleteness(draft);
        const seal =
          options.confirm === true && completeness.complete
            ? sealMission(deps, { sealId: draft.sealId, via: 'cli' })
            : draft;

        if (options.json === true) {
          jsonOut(runtime, 'autonomy-seal/v1', {
            sealId: seal.sealId,
            status: seal.status,
            missionId: seal.missionId,
            complete: completeness.complete,
            missing: [...completeness.missing],
            contracts: seal.contracts.length,
            acceptanceCriteria: seal.acceptanceCriteria.length,
            authorityDigest: seal.authorityDigest,
          });
          if (!completeness.complete) runtime.exitCode = EXIT_CODES.gateFailure;
          return;
        }

        runtime.out(reportTitle(`Seal ${seal.sealId} — ${seal.status}`));
        runtime.out(
          infoLine(
            `${seal.contracts.length} contract(s), ` +
              `${seal.contracts.reduce((n, c) => n + c.requirementIds.length, 0)} requirement(s), ` +
              `${seal.acceptanceCriteria.length} acceptance criterion/criteria`,
          ),
        );
        const surfaces = requiredSurfacesFor(seal);
        runtime.out(
          dim(
            `implies system scenarios: ${surfaces.requiresContainers}; ` +
              `implies browser scenarios: ${surfaces.requiresBrowser}`,
          ),
        );
        if (!completeness.complete) {
          runtime.out('');
          runtime.out(failLine(`Not authorizable: missing ${completeness.missing.join(', ')}`));
          for (const gap of completeness.gaps) runtime.out(dim(`  ${gap}`));
          runtime.exitCode = EXIT_CODES.gateFailure;
          return;
        }
        if (seal.status === 'SEALED') {
          runtime.out(okLine(`Authorized. Delegated authority: ${seal.delegatedAuthority.mode}`));
          runtime.out(dim(`Next: ${CLI_BIN} overnight preflight ${subject}`));
        } else {
          runtime.out(warnLine('Draft only. Re-run with --confirm to authorize it.'));
        }
      },
    );

  autonomy
    .command('seals')
    .description('List intent seals')
    .option('--mission <id>', 'restrict to one mission')
    .option('--json', 'machine-readable output')
    .action((options: { mission?: string; json?: boolean }) => {
      const workspace = runtime.workspace();
      const seals = listSeals(workspace, options.mission);
      if (options.json === true) {
        jsonOut(runtime, 'autonomy-seals/v1', {
          seals: seals.map((seal) => ({
            sealId: seal.sealId,
            missionId: seal.missionId,
            status: seal.status,
            sealedAt: seal.sealedAt ?? null,
            authorityDigest: seal.authorityDigest,
          })),
        });
        return;
      }
      if (seals.length === 0) {
        runtime.out(infoLine('No intent seals in this workspace.'));
        return;
      }
      runtime.out(reportTitle(`${seals.length} seal(s)`));
      for (const seal of seals) {
        const line = `${seal.sealId}  ${seal.status}  ${seal.missionId}`;
        runtime.out(seal.status === 'SEALED' ? okLine(line) : dim(line));
      }
    });

  autonomy
    .command('revoke <sealId>')
    .description('Withdraw a seal; delegated execution stops immediately')
    .requiredOption('--reason <reason>', 'why the authorization is withdrawn')
    .action((sealId: string, options: { reason: string }) => {
      const deps = autonomyDeps(runtime);
      const seal = revokeSeal(deps, sealId, options.reason);
      runtime.out(okLine(`Seal ${seal.sealId} is ${seal.status}.`));
    });
}

// ---------------------------------------------------------------------------
// overnight preflight / run
// ---------------------------------------------------------------------------

function renderPreflight(runtime: CliRuntime, report: PreflightReport): void {
  runtime.out(reportTitle(`Overnight preflight — ${report.verdict}`));
  for (const check of report.checks) {
    const line = `${check.capability}: ${check.observed}`;
    switch (check.outcome) {
      case 'READY':
        runtime.out(okLine(line));
        break;
      case 'SATISFIABLE_AUTONOMOUSLY':
        runtime.out(infoLine(`${line} (the runtime provides this)`));
        break;
      case 'HUMAN_REQUIRED':
        runtime.out(failLine(line));
        for (const remedy of check.remediation) runtime.out(dim(`    ${remedy}`));
        break;
      case 'UNKNOWN':
        runtime.out(warnLine(`${line} (could not be established)`));
        break;
      default:
        runtime.out(dim(`${line} (not applicable)`));
        break;
    }
  }
  runtime.out('');
  if (report.verdict === 'OVERNIGHT_READY') {
    runtime.out(okLine('OVERNIGHT_READY'));
  } else {
    runtime.out(failLine(report.verdict));
  }
}

function registerOvernight(program: Command, runtime: CliRuntime): void {
  const overnight = program
    .command('overnight')
    .description('Prepare and launch an unattended mission build');

  overnight
    .command('preflight <mission>')
    .description('Find the human-only prerequisites before you leave the machine')
    .option('--json', 'machine-readable output')
    .action(async (subject: string, options: { json?: boolean }) => {
      const deps = autonomyDeps(runtime);
      const missionId = resolveMissionId(runtime, subject);
      const seal = latestExecutableSeal(deps.workspace, missionId);
      const surfaces = requiredSurfacesFor(seal);
      const report = await runOvernightPreflight(deps, {
        subject: missionId,
        missionId,
        ...(seal !== undefined ? { sealId: seal.sealId } : {}),
        requiresContainers: surfaces.requiresContainers,
        requiresBrowser: surfaces.requiresBrowser,
      });
      if (options.json === true) {
        jsonOut(runtime, 'autonomy-preflight/v1', {
          reportId: report.reportId,
          verdict: report.verdict,
          checks: report.checks.map((check) => ({
            capability: check.capability,
            outcome: check.outcome,
            observed: check.observed,
          })),
          humanActions: [...report.humanActions],
          autonomousActions: [...report.autonomousActions],
        });
      } else {
        renderPreflight(runtime, report);
      }
      if (report.verdict !== 'OVERNIGHT_READY') runtime.exitCode = EXIT_CODES.gateFailure;
    });

  overnight
    .command('run <mission>')
    .description('Launch the unattended build. Progress needs nobody after this')
    .option('--job <id>', 'continue an existing job')
    .option('--goal <text>', 'goal recorded on a newly created job')
    .option('--max-cycles <n>', 'bound on supervise/close cycles (diagnostics)')
    .option('--json', 'machine-readable output')
    .action(
      async (
        subject: string,
        options: { job?: string; goal?: string; maxCycles?: string; json?: boolean },
      ) => {
        const context = loadExecutionContext(runtime);
        const deps: AutonomyDeps = {
          workspace: context.workspace,
          config: context.config,
          clock: () => runtime.now(),
          host: 'cli',
        };
        const missionId = resolveMissionId(runtime, subject);
        const seal = latestExecutableSeal(deps.workspace, missionId);
        if (seal === undefined) {
          throw new SpecBridgeError(
            'INVALID_STATE',
            `Mission ${missionId} has no authorized seal. Run \`${CLI_BIN} autonomy seal ${subject} --confirm\` first.`,
          );
        }
        const specName = seal.specName;
        if (options.job === undefined && specName === undefined) {
          throw new SpecBridgeError(
            'INVALID_STATE',
            `Mission ${missionId} has synthesized no spec yet; there is nothing to build.`,
          );
        }
        const jobId =
          options.job ??
          createJob(deps, {
            specName: specName as string,
            goal: options.goal ?? seal.goal,
          }).jobId;

        const result = await runUnattendedMission(deps, {
          missionId,
          jobId,
          // A factory: the runtime hands back deps carrying the authority
          // resolver, and the driver must run under those.
          host: (runDeps) =>
            createInProcessDriverHost({ ...runDeps, registry: context.registry }),
          ...(options.maxCycles !== undefined ? { maxCycles: Number(options.maxCycles) } : {}),
          // The production qualification surfaces. Both are honest about
          // absence at run time: compose reports the daemon down as
          // ENVIRONMENT_UNAVAILABLE, playwright reports itself missing and
          // browser checks record SKIPPED_NO_RUNTIME.
          environmentRuntime: createComposeRuntime({ cwd: context.workspace.rootDir }),
          browserDriver: createPlaywrightDriver(),
          onEvent: (event) => {
            if (options.json !== true) runtime.out(dim(`  ${event.kind}: ${event.message}`));
          },
        });

        if (options.json === true) {
          jsonOut(runtime, 'autonomy-run/v1', {
            jobId,
            stop: result.stop,
            telemetry: result.telemetry as unknown as Record<string, unknown>,
            audits: result.audits.length,
            recoveries: result.recoveries.length,
          });
        } else {
          runtime.out('');
          renderRunOutcome(runtime, result.stop, jobId);
          renderTelemetry(runtime, result.telemetry);
        }
        if (result.stop.kind !== 'completed') runtime.exitCode = EXIT_CODES.gateFailure;
      },
    );
}

function renderRunOutcome(
  runtime: CliRuntime,
  stop: Awaited<ReturnType<typeof runUnattendedMission>>['stop'],
  jobId: string,
): void {
  switch (stop.kind) {
    case 'completed':
      runtime.out(reportTitle('COMPLETED'));
      runtime.out(okLine(stop.rationale));
      break;
    case 'needs-authority':
      runtime.out(reportTitle('NEEDS_AUTHORITY'));
      runtime.out(blockedLine(stop.question));
      runtime.out(dim(`Answer it, then re-run: ${CLI_BIN} overnight run --job ${jobId}`));
      break;
    case 'needs-human':
      runtime.out(reportTitle(stop.status));
      runtime.out(failLine(stop.detail));
      break;
    case 'gave-up':
      runtime.out(reportTitle('STOPPED'));
      runtime.out(failLine(stop.reason));
      break;
    case 'interrupted':
      runtime.out(warnLine('Interrupted. The job is resumable.'));
      break;
    default:
      runtime.out(warnLine('The run reached its cycle bound. The job is resumable.'));
      break;
  }
}

function renderTelemetry(
  runtime: CliRuntime,
  telemetry: ReturnType<typeof computeAutonomyTelemetry>,
): void {
  runtime.out('');
  runtime.out(sectionTitle('Autonomy'));
  const primary = `humanInterventionsAfterSeal: ${telemetry.humanInterventionsAfterSeal}`;
  runtime.out(telemetry.humanInterventionsAfterSeal === 0 ? okLine(primary) : failLine(primary));
  runtime.out(infoLine(`authority escalations: ${telemetry.humanAuthorityEscalations}`));
  runtime.out(
    dim(
      `recoveries ${telemetry.autonomousRecoveryCount} · failovers ${telemetry.providerFailovers} · ` +
        `quota waits ${telemetry.quotaWaits} · context rollovers ${telemetry.contextRollovers}`,
    ),
  );
  runtime.out(
    dim(
      `toolsmith ${telemetry.toolsmithActions} (${telemetry.selfCreatedTools} self-created) · ` +
        `gap cycles ${telemetry.gapClosureCycles} · driver restarts ${telemetry.driverRestarts}`,
    ),
  );
  runtime.out(
    dim(
      `closure ${formatMeasurement(telemetry.contractClosureRatio, 'ratio')} · ` +
        `elapsed ${formatMeasurement(telemetry.elapsedWallTimeMs, 'ms')} · ` +
        `tokens ${formatMeasurement(telemetry.reportedTokens, 'tokens')} · ` +
        `cost ${formatMeasurement(telemetry.reportedCostUsd, 'usd')}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

function registerInspection(autonomy: Command, runtime: CliRuntime): void {
  autonomy
    .command('status')
    .description('What the supervisor owns right now (read-only)')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const leases = listLeases(workspace);
      const jobs = listJobs(workspace).jobs;
      if (options.json === true) {
        jsonOut(runtime, 'autonomy-status/v1', {
          leases: leases.map((lease) => ({
            jobId: lease.jobId,
            ownerId: lease.ownerId,
            generation: lease.generation,
            expiresAt: lease.expiresAt,
            released: lease.released,
          })),
          jobs: jobs.map((job) => ({ jobId: job.jobId, status: job.status })),
        });
        return;
      }
      runtime.out(reportTitle('Autonomy status'));
      if (leases.length === 0) runtime.out(dim('No supervised job leases.'));
      for (const lease of leases) {
        const line = `${lease.jobId}  owner ${lease.ownerId}  gen ${lease.generation}  expires ${lease.expiresAt}`;
        runtime.out(lease.released ? dim(line) : okLine(line));
      }
      for (const job of jobs) {
        runtime.out(
          job.status === 'NEEDS_AUTHORITY' ? blockedLine(`${job.jobId}  ${job.status}`) : infoLine(`${job.jobId}  ${job.status}`),
        );
      }
    });

  autonomy
    .command('report <jobId>')
    .description('The autonomy report for one job (read-only)')
    .option('--json', 'machine-readable output')
    .action((jobId: string, options: { json?: boolean }) => {
      const deps = autonomyDeps(runtime);
      // Always RECOMPUTED, never read back. Telemetry is derived from durable
      // state by design, and preferring a stored record would make `report`
      // show the numbers as of whenever the last run happened to write them —
      // which for a job still executing is exactly the wrong answer.
      const telemetry = computeAutonomyTelemetry(deps, { jobId });
      const ledger = readClosureLedger(deps.workspace, jobId);
      const job = requireJobState(deps.workspace, jobId);

      if (options.json === true) {
        jsonOut(runtime, 'autonomy-report/v1', {
          jobId,
          status: job.status,
          telemetry: telemetry as unknown as Record<string, unknown>,
          closure:
            ledger === undefined
              ? null
              : {
                  phase: ledger.phase,
                  entries: ledger.entries.length,
                  unclosed: ledger.entries.filter((entry) => entry.status !== 'VERIFIED').length,
                },
        });
        return;
      }
      runtime.out(reportTitle(`Job ${jobId} — ${job.status}`));
      if (job.authorityRequest !== undefined && job.authorityRequest.resolvedAt === undefined) {
        runtime.out(blockedLine(job.authorityRequest.question));
        runtime.out(dim(`  why: ${job.authorityRequest.whyItMatters}`));
        for (const option of job.authorityRequest.options) runtime.out(dim(`  - ${option}`));
      }
      if (job.operationalWait !== undefined) {
        runtime.out(
          infoLine(
            `waiting on ${job.operationalWait.kind} since ${job.operationalWait.startedAt}` +
              (job.operationalWait.wakeAt !== undefined ? ` until ${job.operationalWait.wakeAt}` : ''),
          ),
        );
      }
      renderTelemetry(runtime, telemetry);
      if (ledger !== undefined) {
        runtime.out('');
        runtime.out(sectionTitle(`Contract closure — phase ${ledger.phase}`));
        for (const entry of ledger.entries) {
          const line = `${entry.itemId}  ${entry.status}  ${entry.statement.slice(0, 70)}`;
          runtime.out(
            entry.status === 'VERIFIED'
              ? okLine(line)
              : entry.status === 'NOT_STARTED'
                ? failLine(line)
                : warnLine(line),
          );
        }
      }
    });

  autonomy
    .command('toolsmith <jobId>')
    .description('Tools this job requested, granted, and created (read-only)')
    .option('--json', 'machine-readable output')
    .action((jobId: string, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const requests = listToolsmithRequests(workspace, jobId);
      if (options.json === true) {
        jsonOut(runtime, 'autonomy-toolsmith/v1', {
          requests: requests.map((request) => ({
            requestId: request.requestId,
            capability: request.capability,
            target: request.target,
            status: request.status,
            denialReason: request.denialReason ?? null,
          })),
        });
        return;
      }
      if (requests.length === 0) {
        runtime.out(infoLine('This job requested no Toolsmith capabilities.'));
        return;
      }
      runtime.out(reportTitle(`${requests.length} Toolsmith request(s)`));
      for (const request of requests) {
        const line = `${request.capability}  ${request.target}  ${request.status}`;
        if (request.status === 'APPLIED') runtime.out(okLine(line));
        else if (request.status === 'DENIED') {
          runtime.out(failLine(`${line}  (${request.denialReason ?? 'denied'})`));
          if (request.suggestedAlternative !== undefined) {
            runtime.out(dim(`    ${request.suggestedAlternative}`));
          }
        } else runtime.out(infoLine(line));
      }
    });

  autonomy
    .command('supervision')
    .description('The supervision log (read-only)')
    .option('--limit <n>', 'entries to show', '50')
    .action((options: { limit: string }) => {
      const workspace = runtime.workspace();
      const entries = readSupervisionLog(workspace, Number(options.limit));
      if (entries.length === 0) {
        runtime.out(infoLine('No supervision has been recorded in this workspace.'));
        return;
      }
      runtime.out(reportTitle(`${entries.length} supervision event(s)`));
      for (const entry of entries) {
        runtime.out(
          dim(`${entry.at}  ${entry.jobId ?? '-'}  ${entry.action}  ${entry.detail ?? ''}`),
        );
      }
    });

  autonomy
    .command('repairs')
    .description('Governed control-plane repairs (read-only)')
    .action(() => {
      const workspace = runtime.workspace();
      const repairs = listControlPlaneRepairs(workspace);
      if (repairs.length === 0) {
        runtime.out(infoLine('No control-plane repairs have been attempted.'));
        return;
      }
      runtime.out(reportTitle(`${repairs.length} control-plane repair(s)`));
      for (const repair of repairs) {
        const line = `${repair.repairId}  ${repair.defectKind}  ${repair.status}`;
        runtime.out(repair.status === 'SUCCEEDED' ? okLine(line) : warnLine(line));
        if (repair.invariantViolations.length > 0) {
          runtime.out(
            failLine(
              `    rejected: weakens ${[...new Set(repair.invariantViolations.map((v) => v.invariant))].join(', ')}`,
            ),
          );
        }
      }
    });

  autonomy
    .command('certification')
    .description('Zero-touch certification runs (read-only)')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const runs = listCertificationRuns(workspace);
      if (options.json === true) {
        jsonOut(runtime, 'autonomy-certification/v1', {
          runs: runs.map((run) => ({
            runId: run.runId,
            verdict: run.verdict,
            humanInterventionsAfterSeal: run.humanInterventionsAfterSeal,
            totals: run.totals,
          })),
        });
        return;
      }
      if (runs.length === 0) {
        runtime.out(infoLine('No certification runs recorded in this workspace.'));
        return;
      }
      for (const run of runs) {
        const line = `${run.runId}  ${run.verdict}  interventions ${run.humanInterventionsAfterSeal}`;
        runtime.out(run.verdict === 'CERTIFIED' ? okLine(line) : failLine(line));
        runtime.out(dim(`  ${run.rationale}`));
      }
    });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerClosure(autonomy: Command, runtime: CliRuntime): void {
  const closure = autonomy.command('closure').description('Inspect and decide on the contract-closure ledger');
  closure
    .command('waive <jobId> <itemId>')
    .description(
      'Waive one sealed closure item with YOUR authority (human decision). ' +
        'A waiver is an attestation, not a shortcut: name the evidence you inspected.',
    )
    .requiredOption('--reason <text>', 'why this item is satisfied or does not apply — name the evidence')
    .option('--by <name>', 'who attests', 'operator')
    .action((jobId: string, itemId: string, options: { reason: string; by: string }) => {
      const deps = autonomyDeps(runtime);
      const ledger = waiveClosureItem(deps, {
        jobId,
        itemId,
        reason: options.reason,
        waivedBy: options.by,
      });
      const entry = ledger.entries.find((candidate) => candidate.itemId === itemId);
      runtime.out(
        entry?.status === 'WAIVED'
          ? okLine(`${itemId} waived by ${options.by}. The waiver is durable and appears in every audit.`)
          : failLine(`${itemId} was not waived (status ${entry?.status ?? 'unknown'}).`),
      );
    });
}

export function registerAutonomyCommands(program: Command, runtime: CliRuntime): void {
  const autonomy = program
    .command('autonomy')
    .description('Delegated authority, supervision, and the unattended runtime');
  registerSetup(autonomy, runtime);
  registerPolicy(autonomy, runtime);
  registerSeal(autonomy, runtime);
  registerInspection(autonomy, runtime);
  registerClosure(autonomy, runtime);
  registerOvernight(program, runtime);
}

/** Whether a seal is currently executable, for other CLI surfaces. */
export function sealStatusLine(seal: MissionSeal | undefined, runtime: CliRuntime): string {
  if (seal === undefined) return failLine('no seal');
  const deps = autonomyDeps(runtime);
  const assessment = assessSealExecutability(seal, deps.config.autonomy);
  return assessment.executable
    ? okLine(`seal ${seal.sealId} is executable`)
    : warnLine(`seal ${seal.sealId}: ${assessment.detail ?? assessment.reason ?? 'not executable'}`);
}

/** Re-exported for the plugin surface, which reads seals but never writes. */
export { readSeal };
