import path from 'node:path';
import type { AutonomyPolicy, ToolsmithCapability } from '@specbridge/core';
import { isUnattendedMode } from '@specbridge/core';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, hostOf, newRecordId, nowIso } from '../deps.js';
import { autonomyPath, listJsonRecords, readJsonRecord, writeJsonRecord } from '../store.js';
import { assessSealCompleteness, latestExecutableSeal, readSeal } from '../seal/service.js';
import type { MissionSeal } from '../seal/state.js';
import type { PreflightCapability, PreflightOutcome, PreflightVerdict } from '../vocabulary.js';
import type { CapabilityCheck, PreflightReport } from './state.js';
import { PREFLIGHT_SCHEMA_VERSION, preflightReportSchema } from './state.js';
import type { ProbeRunner } from './probes.js';
import {
  createProcessProbeRunner,
  detectBuildTool,
  detectPackageManager,
  freeDiskBytes,
  isWritableDirectory,
  probeCompose,
  probeContainerRuntime,
  probeTool,
} from './probes.js';

/**
 * The overnight preflight.
 *
 * One rule shapes every classification below, and it is worth stating
 * plainly because it is the difference between a useful report and a
 * checklist nobody reads:
 *
 *   A capability the runtime is AUTHORIZED and ABLE to provide is not a
 *   blocker. A capability only a person can provide is, always.
 *
 * So `docker` missing entirely blocks an overnight run that needs
 * containers, because installing a container runtime is a machine-level act
 * a policy cannot delegate. But a missing Playwright browser binary does not
 * block anything when `BROWSER_RUNTIME` is a granted Toolsmith capability:
 * the runtime will fetch it, and reporting that as a blocker would train the
 * operator to ignore preflight output.
 *
 * The verdict fails CLOSED in one specific way: any capability whose probe
 * returned UNKNOWN makes the whole report INDETERMINATE. "We could not tell"
 * is not "probably fine", and launching an unattended run on a guess is how
 * a night gets spent discovering something a five-second check would have
 * told you.
 */

export interface PreflightRequest {
  /** The mission id or spec name this preflight is about. */
  subject: string;
  missionId?: string | undefined;
  sealId?: string | undefined;
  /** The project directory the product is built in. Defaults to the workspace. */
  projectDir?: string | undefined;
  /**
   * Surfaces the mission actually needs, from its sealed acceptance
   * criteria. A mission with no browser criterion does not need a browser,
   * and reporting NOT_APPLICABLE is more honest than reporting READY for
   * something that was never going to run.
   */
  requiresContainers?: boolean | undefined;
  requiresBrowser?: boolean | undefined;
  /** Injected probe runner (tests, offline certification). */
  probeRunner?: ProbeRunner | undefined;
  /** Explicit report id (deterministic tests). */
  reportId?: string | undefined;
  /** Minimum free disk the run should have. Defaults to 5 GiB. */
  minFreeDiskBytes?: number | undefined;
}

const DEFAULT_MIN_FREE_DISK = 5 * 1024 * 1024 * 1024;

export function preflightDir(workspace: { rootDir: string }): string {
  return autonomyPath(workspace as never, 'preflight');
}

export async function runOvernightPreflight(
  deps: AutonomyDeps,
  request: PreflightRequest,
): Promise<PreflightReport> {
  const policy = autonomyPolicyOf(deps);
  const projectDir = request.projectDir ?? deps.workspace.rootDir;
  const run = request.probeRunner ?? createProcessProbeRunner(projectDir);
  const at = nowIso(deps);
  const checks: CapabilityCheck[] = [];

  const seal = resolveSeal(deps, request);

  const add = (
    capability: PreflightCapability,
    outcome: PreflightOutcome,
    observed: string,
    extra: {
      remediation?: readonly string[];
      satisfiedBy?: ToolsmithCapability | undefined;
      measurement?: number | null;
    } = {},
  ): void => {
    checks.push({
      capability,
      outcome,
      observed: observed.slice(0, 4_000),
      remediation: [...(extra.remediation ?? [])],
      ...(extra.satisfiedBy !== undefined ? { satisfiedBy: extra.satisfiedBy } : {}),
      measurement: extra.measurement ?? null,
      checkedAt: at,
    });
  };

  // --- Workspace and repository ------------------------------------------
  add(
    'WORKSPACE_WRITABLE',
    isWritableDirectory(deps.workspace.rootDir) ? 'READY' : 'HUMAN_REQUIRED',
    `workspace root ${deps.workspace.rootDir}`,
    { remediation: ['Grant write access to the workspace, or run from a writable checkout.'] },
  );

  const free = freeDiskBytes(deps.workspace.rootDir);
  const minFree = request.minFreeDiskBytes ?? DEFAULT_MIN_FREE_DISK;
  add(
    'DISK_SPACE',
    free === null ? 'UNKNOWN' : free >= minFree ? 'READY' : 'HUMAN_REQUIRED',
    free === null
      ? 'free space could not be measured on this filesystem'
      : `${(free / (1024 * 1024 * 1024)).toFixed(1)} GiB free (minimum ${(minFree / (1024 * 1024 * 1024)).toFixed(1)} GiB)`,
    {
      remediation: ['Free disk space before starting an unattended run.'],
      measurement: free,
    },
  );

  const git = await probeTool(run, 'git');
  add(
    'GIT_AVAILABLE',
    git.available ? 'READY' : 'HUMAN_REQUIRED',
    git.available ? `git ${git.version ?? 'present'}` : (git.detail ?? 'git did not answer'),
    { remediation: ['Install git; SpecBridge evidence is Git-derived and has no fallback.'] },
  );

  add(
    'PROTECTED_PATHS_CONFIGURED',
    deps.config.execution.protectedPaths.length > 0 ? 'READY' : 'HUMAN_REQUIRED',
    `${deps.config.execution.protectedPaths.length} protected path pattern(s)`,
    {
      remediation: [
        'Declare protectedPaths in .specbridge/config.json before running unattended: an ' +
          'overnight run edits files for hours with nobody watching the diff.',
      ],
    },
  );

  // --- Authority ----------------------------------------------------------
  addSealChecks(add, seal, policy);

  // --- Compute ------------------------------------------------------------
  const strongWorkers = Object.entries(deps.config.runnerProfiles).filter(
    ([name]) => name !== 'mock',
  );
  add(
    'STRONG_WORKER_AVAILABLE',
    strongWorkers.length > 0 ? 'READY' : 'HUMAN_REQUIRED',
    `${strongWorkers.length} runner profile(s) configured`,
    {
      remediation: [
        'Configure at least one non-mock runner profile: an unattended run with no worker ' +
          'has nothing to delegate to.',
      ],
    },
  );

  const localInference = deps.config.localInference;
  add(
    'LOCAL_MODEL_STARTABLE',
    localInference.enabled ? 'READY' : 'NOT_APPLICABLE',
    localInference.enabled
      ? 'managed local inference is configured'
      : 'managed local inference is disabled; the run relies on subscription or API compute',
    {
      remediation: [
        'Enable localInference so quota exhaustion has somewhere to fall back to.',
      ],
    },
  );

  const apiPolicy = deps.config.orchestration.jobs.scheduler.api;
  const spendMode = apiPolicy.spendMode;
  add(
    'API_FALLBACK_AUTHORIZED',
    spendMode === 'DISABLED' ? 'NOT_APPLICABLE' : 'READY',
    `API spend mode is ${spendMode}`,
    {
      remediation: [
        'Set orchestration.jobs.scheduler.api.spendMode to AUTO_BOUNDED with a budget to let ' +
          'the run continue through a subscription outage.',
      ],
    },
  );
  const ceiling = apiPolicy.budget.maxCostPerJobUsd;
  add(
    'SPEND_CEILING_DECLARED',
    spendMode === 'DISABLED'
      ? 'NOT_APPLICABLE'
      : ceiling !== null && ceiling !== undefined
        ? 'READY'
        : 'HUMAN_REQUIRED',
    ceiling !== null && ceiling !== undefined
      ? `authorized ceiling $${Number(ceiling).toFixed(2)}`
      : 'no monetary ceiling is declared',
    {
      remediation: [
        'Declare an explicit spend ceiling. SpecBridge never infers one, and an unattended ' +
          'run will not spend money it was not authorized to spend.',
      ],
      measurement: ceiling !== null && ceiling !== undefined ? Number(ceiling) : null,
    },
  );

  add(
    'TRUSTED_VERIFICATION_CONFIGURED',
    deps.config.verification.commands.length > 0 ? 'READY' : 'HUMAN_REQUIRED',
    `${deps.config.verification.commands.length} trusted verification command(s)`,
    {
      remediation: [
        'Configure verification commands. Without them nothing can close a contract item on ' +
          'trusted evidence, and the run cannot legitimately reach COMPLETED.',
      ],
    },
  );

  // --- Toolchain ----------------------------------------------------------
  const declaredManager = detectPackageManager(projectDir);
  if (declaredManager === null) {
    add('PACKAGE_MANAGER_AVAILABLE', 'NOT_APPLICABLE', 'the project declares no package manager');
    add('PACKAGE_REGISTRY_REACHABLE', 'NOT_APPLICABLE', 'no package manager to reach a registry with');
  } else {
    const manager = await probeTool(run, declaredManager);
    add(
      'PACKAGE_MANAGER_AVAILABLE',
      manager.available
        ? 'READY'
        : toolsmithGrants(policy, 'PROJECT_LOCAL_TOOLCHAIN')
          ? 'SATISFIABLE_AUTONOMOUSLY'
          : 'HUMAN_REQUIRED',
      manager.available
        ? `${declaredManager} ${manager.version ?? 'present'}`
        : `${declaredManager} is declared by the project but did not answer`,
      {
        remediation: [`Install ${declaredManager}, or grant the PROJECT_LOCAL_TOOLCHAIN capability.`],
        satisfiedBy: 'PROJECT_LOCAL_TOOLCHAIN',
      },
    );
    add(
      'PACKAGE_REGISTRY_REACHABLE',
      manager.available ? 'READY' : 'UNKNOWN',
      manager.available
        ? 'the package manager answered; registry reachability is verified on first install'
        : 'registry reachability cannot be established without a working package manager',
      { remediation: ['Verify network access to the package registry.'] },
    );
  }

  const buildTool = detectBuildTool(projectDir);
  add(
    'BUILD_TOOLCHAIN_AVAILABLE',
    buildTool === null
      ? 'NOT_APPLICABLE'
      : buildTool.endsWith('-wrapper')
        ? 'READY'
        : toolsmithGrants(policy, 'PROJECT_LOCAL_TOOLCHAIN')
          ? 'SATISFIABLE_AUTONOMOUSLY'
          : 'UNKNOWN',
    buildTool === null
      ? 'the project declares no JVM or native build tool'
      : `detected ${buildTool}`,
    {
      remediation: ['Commit a build wrapper, or grant PROJECT_LOCAL_TOOLCHAIN.'],
      satisfiedBy: 'PROJECT_LOCAL_TOOLCHAIN',
    },
  );

  // --- Environments -------------------------------------------------------
  if (request.requiresContainers === true) {
    const runtime = await probeContainerRuntime(run);
    add(
      'CONTAINER_RUNTIME',
      runtime.available ? 'READY' : 'HUMAN_REQUIRED',
      runtime.available
        ? `docker ${runtime.version ?? 'answering'}`
        : (runtime.detail ?? 'docker is not available'),
      {
        remediation: [
          'Start the container runtime before leaving the machine. A daemon is a machine-level ' +
            'prerequisite: no policy can delegate starting one.',
        ],
      },
    );
    const compose = runtime.available
      ? await probeCompose(run)
      : { tool: 'docker compose', available: false, version: null, detail: 'no runtime' };
    add(
      'CONTAINER_COMPOSE',
      compose.available ? 'READY' : runtime.available ? 'HUMAN_REQUIRED' : 'UNKNOWN',
      compose.available ? `compose ${compose.version ?? 'present'}` : 'compose did not answer',
      { remediation: ['Install the Docker Compose plugin.'] },
    );
    add(
      'ENVIRONMENT_POLICY_SUFFICIENT',
      policy.environments.enabled ? 'READY' : 'HUMAN_REQUIRED',
      policy.environments.enabled
        ? `up to ${policy.environments.maxInstances} concurrent environment instance(s)`
        : 'environment provisioning is disabled by autonomy policy',
      { remediation: ['Enable autonomy.environments so the run can provision what it needs.'] },
    );
  } else {
    add('CONTAINER_RUNTIME', 'NOT_APPLICABLE', 'no sealed criterion implies a container runtime');
    add('CONTAINER_COMPOSE', 'NOT_APPLICABLE', 'no sealed criterion implies compose');
    add('ENVIRONMENT_POLICY_SUFFICIENT', 'NOT_APPLICABLE', 'no environment work is implied');
  }

  // --- Browser ------------------------------------------------------------
  if (request.requiresBrowser === true) {
    add(
      'BROWSER_RUNTIME',
      policy.browser.enabled
        ? toolsmithGrants(policy, 'BROWSER_RUNTIME')
          ? 'SATISFIABLE_AUTONOMOUSLY'
          : 'HUMAN_REQUIRED'
        : 'HUMAN_REQUIRED',
      policy.browser.enabled
        ? 'browser verification is enabled; the runtime installs its own browser when permitted'
        : 'browser verification is disabled by autonomy policy',
      {
        remediation: [
          'Enable autonomy.browser and grant the BROWSER_RUNTIME Toolsmith capability, or ' +
            'install a browser runtime yourself.',
        ],
        satisfiedBy: 'BROWSER_RUNTIME',
      },
    );
  } else {
    add('BROWSER_RUNTIME', 'NOT_APPLICABLE', 'no sealed criterion implies a browser');
  }

  // --- Autonomy machinery -------------------------------------------------
  add(
    'SUPERVISOR_CAPABLE',
    policy.supervisor.enabled ? 'READY' : 'HUMAN_REQUIRED',
    policy.supervisor.enabled
      ? `lease ${Math.round(policy.supervisor.leaseTtlMs / 1_000)}s, up to ${policy.supervisor.maxRestarts} restarts`
      : 'the supervisor is disabled; the job would depend on a foreground terminal',
    { remediation: ['Run `specbridge autonomy setup --mode overnight`.'] },
  );
  add(
    'TOOLSMITH_POLICY_SUFFICIENT',
    policy.toolsmith.enabled && policy.toolsmith.capabilities.length > 0
      ? 'READY'
      : isUnattendedMode(policy.mode)
        ? 'HUMAN_REQUIRED'
        : 'NOT_APPLICABLE',
    policy.toolsmith.enabled
      ? `${policy.toolsmith.capabilities.length} capability class(es) granted`
      : 'the Toolsmith is disabled; a missing package would stop the run',
    { remediation: ['Grant Toolsmith capabilities so missing tooling is engineering, not a wait.'] },
  );
  add(
    'CONTROL_PLANE_REPAIR_CONFIGURED',
    policy.controlPlaneRepair.enabled
      ? policy.controlPlaneRepair.sourcePath !== undefined
        ? 'READY'
        : 'HUMAN_REQUIRED'
      : 'NOT_APPLICABLE',
    policy.controlPlaneRepair.enabled
      ? (policy.controlPlaneRepair.sourcePath ?? 'no SpecBridge source path is configured')
      : 'control-plane self-repair is disabled',
    {
      remediation: [
        'Set autonomy.controlPlaneRepair.sourcePath to the SpecBridge checkout a repair may patch.',
      ],
    },
  );
  add(
    'KNOWN_CREDENTIALS_PRESENT',
    'READY',
    'no additional human-only credential is known to be required for this mission',
    {
      remediation: [
        'Credentials discovered mid-run stop the job in NEEDS_AUTHORITY; SpecBridge never ' +
          'authenticates on your behalf.',
      ],
    },
  );

  const report = buildReport(deps, {
    request,
    policy,
    seal,
    checks,
    at,
  });
  writeJsonRecord(
    autonomyPath(deps.workspace, 'preflight', `${report.reportId}.json`),
    report,
  );
  return report;
}

function resolveSeal(deps: AutonomyDeps, request: PreflightRequest): MissionSeal | undefined {
  if (request.sealId !== undefined) return readSeal(deps.workspace, request.sealId);
  if (request.missionId !== undefined) return latestExecutableSeal(deps.workspace, request.missionId);
  return latestExecutableSeal(deps.workspace, request.subject);
}

function addSealChecks(
  add: (
    capability: PreflightCapability,
    outcome: PreflightOutcome,
    observed: string,
    extra?: { remediation?: readonly string[]; satisfiedBy?: ToolsmithCapability | undefined; measurement?: number | null },
  ) => void,
  seal: MissionSeal | undefined,
  policy: AutonomyPolicy,
): void {
  if (seal === undefined) {
    add('SEAL_PRESENT', 'HUMAN_REQUIRED', 'no sealed intent governs this mission', {
      remediation: [
        'Seal the mission: `specbridge autonomy seal <mission> --confirm`. Delegated authority ' +
          'is something a person grants; the runtime never assumes it.',
      ],
    });
    add('SEAL_COMPLETE', 'HUMAN_REQUIRED', 'there is no seal to assess');
  } else {
    add('SEAL_PRESENT', seal.status === 'SEALED' ? 'READY' : 'HUMAN_REQUIRED', `seal ${seal.sealId} is ${seal.status}`, {
      remediation: ['Authorize the draft seal, or draft a fresh one from current mission state.'],
    });
    const completeness = assessSealCompleteness(seal);
    add(
      'SEAL_COMPLETE',
      completeness.complete ? 'READY' : 'HUMAN_REQUIRED',
      completeness.complete
        ? `${seal.contracts.length} contract(s), ${seal.acceptanceCriteria.length} acceptance criterion/criteria`
        : `missing ${completeness.missing.join(', ')}`,
      { remediation: [...completeness.gaps] },
    );
  }

  add(
    'AUTONOMY_POLICY_COMPLETE',
    isUnattendedMode(policy.mode) && policy.humanGate === 'AUTHORITY_ONLY'
      ? 'READY'
      : 'HUMAN_REQUIRED',
    `mode ${policy.mode}, human gate ${policy.humanGate}`,
    {
      remediation: [
        'Set autonomy.mode to OVERNIGHT and autonomy.humanGate to AUTHORITY_ONLY, or the run ' +
          'will stop for ordinary engineering decisions.',
      ],
    },
  );

  add(
    'REPOSITORY_CLEAN_ENOUGH',
    'READY',
    'the runtime commits its own work; a dirty tree is not by itself a blocker',
  );
}

function toolsmithGrants(policy: AutonomyPolicy, capability: ToolsmithCapability): boolean {
  return policy.toolsmith.enabled && policy.toolsmith.capabilities.includes(capability);
}

function buildReport(
  deps: AutonomyDeps,
  input: {
    request: PreflightRequest;
    policy: AutonomyPolicy;
    seal: MissionSeal | undefined;
    checks: CapabilityCheck[];
    at: string;
  },
): PreflightReport {
  const humanActions: string[] = [];
  const autonomousActions: string[] = [];
  const unknowns: string[] = [];
  for (const check of input.checks) {
    if (check.outcome === 'HUMAN_REQUIRED') {
      humanActions.push(`${check.capability}: ${check.observed}`);
    } else if (check.outcome === 'SATISFIABLE_AUTONOMOUSLY') {
      autonomousActions.push(
        `${check.capability}: ${check.observed} (provided by ${check.satisfiedBy ?? 'the runtime'})`,
      );
    } else if (check.outcome === 'UNKNOWN') {
      unknowns.push(`${check.capability}: ${check.observed}`);
    }
  }
  const verdict: PreflightVerdict =
    humanActions.length > 0
      ? 'HUMAN_ACTION_REQUIRED'
      : unknowns.length > 0
        ? 'INDETERMINATE'
        : 'OVERNIGHT_READY';

  return preflightReportSchema.parse({
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    reportId: input.request.reportId ?? newRecordId(deps, 'pf'),
    createdAt: input.at,
    host: hostOf(deps),
    subject: input.request.subject,
    ...(input.request.missionId !== undefined ? { missionId: input.request.missionId } : {}),
    ...(input.seal !== undefined ? { sealId: input.seal.sealId } : {}),
    autonomyMode: input.policy.mode,
    humanGate: input.policy.humanGate,
    verdict,
    checks: input.checks,
    humanActions: humanActions.slice(0, 40),
    autonomousActions: autonomousActions.slice(0, 40),
    unknowns: unknowns.slice(0, 40),
  });
}

// ---------------------------------------------------------------------------
// Reading and gating
// ---------------------------------------------------------------------------

export function readPreflightReport(
  deps: AutonomyDeps,
  reportId: string,
): PreflightReport | undefined {
  return readJsonRecord(autonomyPath(deps.workspace, 'preflight', `${reportId}.json`), (raw) =>
    preflightReportSchema.parse(raw),
  );
}

export function listPreflightReports(deps: AutonomyDeps): PreflightReport[] {
  return listJsonRecords(autonomyPath(deps.workspace, 'preflight'), (raw) =>
    preflightReportSchema.parse(raw),
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Refuse an unattended launch that preflight did not clear.
 *
 * Throwing rather than warning, and thrown at LAUNCH rather than at report
 * time: the report is diagnostic and an operator may legitimately run one to
 * see where they stand. Starting an unattended run on a report that says a
 * person is needed is the thing that must not happen quietly.
 */
export function assertOvernightReady(report: PreflightReport): void {
  if (report.verdict === 'OVERNIGHT_READY') return;
  throw new AutonomyError(
    'SBA011',
    report.verdict === 'HUMAN_ACTION_REQUIRED'
      ? `Overnight preflight found ${report.humanActions.length} prerequisite(s) only a person can satisfy.`
      : `Overnight preflight could not establish ${report.unknowns.length} prerequisite(s).`,
    {
      remediation: [
        ...report.checks
          .filter((check) => check.outcome === 'HUMAN_REQUIRED' || check.outcome === 'UNKNOWN')
          .flatMap((check) => check.remediation)
          .slice(0, 10),
        `Full report: ${path.posix.join('.specbridge', 'autonomy', 'preflight', `${report.reportId}.json`)}`,
      ],
      details: { verdict: report.verdict, reportId: report.reportId },
    },
  );
}

/**
 * Which surfaces a sealed mission actually needs, read from its criteria.
 *
 * Derived from the seal rather than from configuration so a mission that
 * says nothing about browsers is never blocked on one, and a mission that
 * does cannot have the requirement configured away.
 */
export function requiredSurfacesFor(seal: MissionSeal | undefined): {
  requiresContainers: boolean;
  requiresBrowser: boolean;
} {
  if (seal === undefined) return { requiresContainers: false, requiresBrowser: false };
  return {
    requiresContainers: seal.acceptanceCriteria.some((c) => c.impliesSystemScenario),
    requiresBrowser: seal.acceptanceCriteria.some((c) => c.impliesBrowserScenario),
  };
}
