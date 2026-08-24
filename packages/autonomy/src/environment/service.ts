import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace } from '@specbridge/core';
import { recordJobEvent } from '@specbridge/orchestration';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, newRecordId, now, nowIso } from '../deps.js';
import {
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  writeJsonRecord,
} from '../store.js';
import type { EnvironmentFailureKind } from '../vocabulary.js';
import type { ProbeExecutor } from './probe-runner.js';
import { createReadinessProbeExecutor } from './probe-runner.js';
import type {
  EnvironmentEvidence,
  EnvironmentInstance,
  EnvironmentPlan,
  ServicePlan,
  ServiceState,
} from './state.js';
import {
  ENVIRONMENT_SCHEMA_VERSION,
  environmentEvidenceSchema,
  environmentInstanceSchema,
  environmentPlanSchema,
  isApplicationLevelProbe,
} from './state.js';

/**
 * The environment lifecycle service.
 *
 * Provisioning is split from readiness on purpose. `ControlPlaneRuntime`
 * starts and stops things; this service decides WHEN each service is
 * probed, WHEN to give up, WHEN to restart, and what the whole thing proved.
 * The split means a test can drive the entire readiness dependency graph,
 * the timeout behaviour, the restart budget, and the evidence honesty
 * without Docker — and it means the Docker-specific code is small enough to
 * read in one sitting.
 *
 * The readiness loop walks the dependency graph rather than a list. A
 * service is probed only once its dependencies are READY, which is both
 * faster than sequential startup and closer to the truth: an application
 * server that starts before its database is not broken, it is waiting, and
 * probing it early produces a failure that means nothing.
 */

export interface EnvironmentRuntime {
  readonly label: string;
  /** Bring the plan's services up. Returns when the command finishes. */
  provision(input: {
    plan: EnvironmentPlan;
    workspaceRoot: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }): Promise<{ ok: boolean; detail: string; failureKind?: EnvironmentFailureKind }>;
  /** Restart one service. */
  restart(input: {
    plan: EnvironmentPlan;
    service: ServicePlan;
    workspaceRoot: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }): Promise<{ ok: boolean; detail: string }>;
  /** Capture one service's logs, bounded. Returns the text, never a path. */
  logs(input: {
    plan: EnvironmentPlan;
    service: ServicePlan;
    workspaceRoot: string;
    maxBytes: number;
  }): Promise<string>;
  /** Tear the plan's services down. */
  teardown(input: {
    plan: EnvironmentPlan;
    workspaceRoot: string;
    timeoutMs: number;
    /** Keep volumes and containers for diagnosis. */
    retain: boolean;
  }): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function environmentPlanFile(workspace: WorkspaceInfo, planId: string): string {
  assertAutonomyId('environment plan', planId);
  return autonomyPath(workspace, 'environments', 'plans', `${planId}.json`);
}

export function environmentInstanceFile(workspace: WorkspaceInfo, instanceId: string): string {
  assertAutonomyId('environment instance', instanceId);
  return autonomyPath(workspace, 'environments', 'instances', `${instanceId}.json`);
}

export function environmentEvidenceFile(workspace: WorkspaceInfo, instanceId: string): string {
  assertAutonomyId('environment instance', instanceId);
  return autonomyPath(workspace, 'environments', 'evidence', `${instanceId}.json`);
}

export function saveEnvironmentPlan(
  deps: AutonomyDeps,
  input: Omit<EnvironmentPlan, 'schemaVersion' | 'createdAt' | 'planId'> & { planId?: string },
): EnvironmentPlan {
  const plan = environmentPlanSchema.parse({
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    planId: input.planId ?? newRecordId(deps, 'env'),
    createdAt: nowIso(deps),
    ...input,
  });
  if (plan.composeFile !== undefined) {
    // A compose file outside the workspace would let an environment
    // definition reach a file nobody reviewed. Validated here, once.
    assertInsideWorkspace(
      deps.workspace.rootDir,
      path.resolve(deps.workspace.rootDir, plan.composeFile),
    );
  }
  writeJsonRecord(environmentPlanFile(deps.workspace, plan.planId), plan);
  return plan;
}

export function readEnvironmentPlan(
  workspace: WorkspaceInfo,
  planId: string,
): EnvironmentPlan | undefined {
  return readJsonRecord(environmentPlanFile(workspace, planId), (raw) =>
    environmentPlanSchema.parse(raw),
  );
}

export function readEnvironmentInstance(
  workspace: WorkspaceInfo,
  instanceId: string,
): EnvironmentInstance | undefined {
  return readJsonRecord(environmentInstanceFile(workspace, instanceId), (raw) =>
    environmentInstanceSchema.parse(raw),
  );
}

export function listEnvironmentInstances(workspace: WorkspaceInfo): EnvironmentInstance[] {
  return listJsonRecords(autonomyPath(workspace, 'environments', 'instances'), (raw) =>
    environmentInstanceSchema.parse(raw),
  );
}

export function readEnvironmentEvidence(
  workspace: WorkspaceInfo,
  instanceId: string,
): EnvironmentEvidence | undefined {
  return readJsonRecord(environmentEvidenceFile(workspace, instanceId), (raw) =>
    environmentEvidenceSchema.parse(raw),
  );
}

// ---------------------------------------------------------------------------
// Readiness ordering
// ---------------------------------------------------------------------------

/**
 * Topologically order services by readiness dependency.
 *
 * Refuses a cycle rather than breaking it arbitrarily: a plan where A waits
 * for B and B waits for A can never become ready, and discovering that at
 * plan time costs nothing while discovering it via a readiness timeout costs
 * however long the timeout is.
 */
export function orderServicesForReadiness(plan: EnvironmentPlan): ServicePlan[] {
  const byId = new Map(plan.services.map((service) => [service.serviceId, service]));
  const ordered: ServicePlan[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (service: ServicePlan, trail: string[]): void => {
    const mark = state.get(service.serviceId);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new AutonomyError(
        'SBA014',
        `Environment plan ${plan.planId} has a readiness cycle: ${[...trail, service.serviceId].join(' -> ')}.`,
        { remediation: ['Break the dependency cycle; a cyclic plan can never become ready.'] },
      );
    }
    state.set(service.serviceId, 'visiting');
    for (const dependencyId of service.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency !== undefined) visit(dependency, [...trail, service.serviceId]);
    }
    state.set(service.serviceId, 'done');
    ordered.push(service);
  };

  for (const service of plan.services) visit(service, []);
  return ordered;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisionOptions {
  planId: string;
  jobId?: string | undefined;
  runtime: EnvironmentRuntime;
  probeExecutor?: ProbeExecutor | undefined;
  signal?: AbortSignal | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  instanceId?: string | undefined;
  onEvent?: ((message: string) => void) | undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Provision an environment and wait for it to become ready.
 *
 * Returns the instance in whatever state it reached. A FAILED environment is
 * a normal outcome and is not thrown: the job's response to an unhealthy
 * broker is REPAIRING_ENVIRONMENT, which is a runtime decision, not an
 * exception for a caller to catch.
 */
export async function provisionEnvironment(
  deps: AutonomyDeps,
  options: ProvisionOptions,
): Promise<EnvironmentInstance> {
  const policy = autonomyPolicyOf(deps).environments;
  if (!policy.enabled) {
    throw new AutonomyError(
      'SBA016',
      'Environment provisioning is disabled by `autonomy.environments.enabled`.',
      { remediation: ['Enable it, or provide the environment yourself before the run.'] },
    );
  }
  const plan = readEnvironmentPlan(deps.workspace, options.planId);
  if (plan === undefined) {
    throw new AutonomyError('SBA014', `No environment plan "${options.planId}" exists.`, {
      details: { planId: options.planId },
    });
  }
  const ordered = orderServicesForReadiness(plan);
  const sleep = options.sleep ?? defaultSleep;
  const probe = options.probeExecutor ?? createReadinessProbeExecutor({ cwd: deps.workspace.rootDir });
  const emit = options.onEvent ?? (() => undefined);

  let instance = writeInstance(
    deps,
    environmentInstanceSchema.parse({
      schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
      instanceId: options.instanceId ?? newRecordId(deps, 'envi'),
      planId: plan.planId,
      ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
      status: 'PROVISIONING',
      createdAt: nowIso(deps),
      services: ordered.map((service) => ({ serviceId: service.serviceId, status: 'PENDING' })),
    }),
  );
  emitJobEvent(deps, options.jobId, 'environment_provision_started', {
    planId: plan.planId,
    instanceId: instance.instanceId,
    services: ordered.length,
  });

  const startedAtMs = now(deps).getTime();
  const provisioned = await options.runtime.provision({
    plan,
    workspaceRoot: deps.workspace.rootDir,
    timeoutMs: policy.readinessTimeoutMs,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!provisioned.ok) {
    emit(`provisioning failed: ${provisioned.detail}`);
    return finishFailed(deps, options, plan, instance, {
      failureKind: provisioned.failureKind ?? 'RUNTIME_UNAVAILABLE',
      detail: provisioned.detail,
    });
  }

  instance = writeInstance(deps, {
    ...instance,
    status: 'WAITING_READY',
    services: instance.services.map((service) => ({
      ...service,
      status: 'STARTING',
      startedAt: nowIso(deps),
    })),
  });

  for (const service of ordered) {
    const result = await waitForService(deps, {
      plan,
      service,
      instance,
      probe,
      sleep,
      policy,
      runtime: options.runtime,
      emit,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    instance = writeInstance(deps, {
      ...instance,
      services: instance.services.map((entry) =>
        entry.serviceId === service.serviceId ? result.state : entry,
      ),
      repairs: instance.repairs + result.restarts,
    });
    if (result.state.status !== 'READY') {
      return finishFailed(deps, options, plan, instance, {
        failureKind: result.state.failureKind ?? 'READINESS_TIMEOUT',
        detail: result.state.lastProbeDetail ?? `service ${service.serviceId} never became ready`,
      });
    }
  }

  const ready = writeInstance(deps, {
    ...instance,
    status: 'READY',
    readyAt: nowIso(deps),
  });
  writeEvidence(deps, plan, ready, now(deps).getTime() - startedAtMs, []);
  emitJobEvent(deps, options.jobId, 'environment_ready', {
    instanceId: ready.instanceId,
    planId: plan.planId,
  });
  return ready;
}

interface WaitResult {
  state: ServiceState;
  restarts: number;
}

/**
 * Wait for one service, restarting it up to its budget.
 *
 * The restart is deliberately INSIDE the readiness wait rather than a
 * separate repair pass. A broker that crashes on first start and comes up
 * clean on the second is an ordinary event; making the whole environment
 * fail and be re-provisioned would turn a three-second hiccup into a
 * full teardown.
 */
async function waitForService(
  deps: AutonomyDeps,
  input: {
    plan: EnvironmentPlan;
    service: ServicePlan;
    instance: EnvironmentInstance;
    probe: ProbeExecutor;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    policy: { probeIntervalMs: number; maxServiceRestarts: number; readinessTimeoutMs: number };
    runtime: EnvironmentRuntime;
    emit: (message: string) => void;
    signal?: AbortSignal | undefined;
  },
): Promise<WaitResult> {
  const { service, probe, sleep, policy } = input;
  const deadlineMs = now(deps).getTime() + Math.min(service.readinessTimeoutMs, policy.readinessTimeoutMs);
  const maxRestarts = Math.min(service.maxRestarts, policy.maxServiceRestarts);

  let state: ServiceState = {
    serviceId: service.serviceId,
    status: 'WAITING_READY',
    startedAt: nowIso(deps),
    restarts: 0,
    probeAttempts: 0,
  };
  let restarts = 0;

  while (now(deps).getTime() < deadlineMs) {
    if (input.signal?.aborted === true) {
      return { state: { ...state, status: 'FAILED', failureKind: 'UNKNOWN' }, restarts };
    }
    let allReady = true;
    let lastDetail = '';
    let lastKind = '';
    for (const definition of service.probes) {
      state = { ...state, probeAttempts: state.probeAttempts + 1 };
      const outcome = await probe(definition, input.signal);
      lastDetail = outcome.detail;
      lastKind = definition.kind;
      if (!outcome.ready) {
        allReady = false;
        break;
      }
    }
    if (allReady) {
      input.emit(`${service.serviceId} ready: ${lastDetail}`);
      return {
        state: {
          ...state,
          status: 'READY',
          readyAt: nowIso(deps),
          lastProbeKind: lastKind,
          lastProbeDetail: lastDetail,
        },
        restarts,
      };
    }
    state = { ...state, lastProbeKind: lastKind, lastProbeDetail: lastDetail };

    // A service that has burned a third of its window without answering gets
    // one restart per budget slot. Restarting immediately would fight the
    // ordinary slow start of a database; never restarting would sit through
    // a crash loop until the timeout.
    const elapsedFraction =
      1 - (deadlineMs - now(deps).getTime()) / Math.max(1, service.readinessTimeoutMs);
    if (restarts < maxRestarts && elapsedFraction > (restarts + 1) / (maxRestarts + 1)) {
      restarts += 1;
      input.emit(`${service.serviceId} not ready after ${state.probeAttempts} probes; restarting`);
      const restarted = await input.runtime.restart({
        plan: input.plan,
        service,
        workspaceRoot: deps.workspace.rootDir,
        timeoutMs: policy.readinessTimeoutMs,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      state = {
        ...state,
        status: 'RESTARTING',
        restarts,
        lastProbeDetail: `${lastDetail}; restart: ${restarted.detail}`,
      };
    }
    await sleep(policy.probeIntervalMs, input.signal);
  }

  return {
    state: {
      ...state,
      status: 'FAILED',
      restarts,
      failureKind: state.probeAttempts === 0 ? 'DEPENDENCY_UNREADY' : 'READINESS_TIMEOUT',
    },
    restarts,
  };
}

async function finishFailed(
  deps: AutonomyDeps,
  options: ProvisionOptions,
  plan: EnvironmentPlan,
  instance: EnvironmentInstance,
  failure: { failureKind: EnvironmentFailureKind; detail: string },
): Promise<EnvironmentInstance> {
  const policy = autonomyPolicyOf(deps).environments;
  const logRefs: string[] = [];
  if (policy.retainDiagnosticsOnFailure) {
    for (const service of plan.services) {
      try {
        const text = await options.runtime.logs({
          plan,
          service,
          workspaceRoot: deps.workspace.rootDir,
          maxBytes: policy.maxLogBytesPerService,
        });
        if (text.length > 0) logRefs.push(retainLog(deps, instance.instanceId, service.serviceId, text));
      } catch {
        // A log we cannot capture is a missing diagnostic, not a second
        // failure: the environment already failed and that is what matters.
      }
    }
  }
  const failed = writeInstance(deps, {
    ...instance,
    status: 'FAILED',
    failureKind: failure.failureKind,
    failureDetail: failure.detail.slice(0, 4_000),
    diagnosticsRetained: logRefs.length > 0,
    services: instance.services.map((service) =>
      service.status === 'READY' ? service : { ...service, status: 'FAILED' },
    ),
  });
  writeEvidence(deps, plan, failed, null, logRefs);
  emitJobEvent(deps, options.jobId, 'environment_failed', {
    instanceId: failed.instanceId,
    planId: plan.planId,
    failureKind: failure.failureKind,
    detail: failure.detail.slice(0, 300),
  });
  return failed;
}

function retainLog(
  deps: AutonomyDeps,
  instanceId: string,
  serviceId: string,
  text: string,
): string {
  const relative = path.posix.join(
    '.specbridge',
    'autonomy',
    'environments',
    'logs',
    instanceId,
    `${serviceId}.log`,
  );
  const absolute = autonomyPath(deps.workspace, 'environments', 'logs', instanceId, `${serviceId}.log`);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, 'utf8');
  return relative;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export async function teardownEnvironment(
  deps: AutonomyDeps,
  input: {
    instanceId: string;
    runtime: EnvironmentRuntime;
    /** Keep containers and volumes for diagnosis. */
    retain?: boolean | undefined;
  },
): Promise<EnvironmentInstance> {
  const instance = readEnvironmentInstance(deps.workspace, input.instanceId);
  if (instance === undefined) {
    throw new AutonomyError('SBA014', `No environment instance "${input.instanceId}" exists.`);
  }
  const plan = readEnvironmentPlan(deps.workspace, instance.planId);
  if (plan === undefined) {
    throw new AutonomyError('SBA014', `Environment plan "${instance.planId}" is missing.`);
  }
  const policy = autonomyPolicyOf(deps).environments;
  const retain = input.retain ?? (instance.status === 'FAILED' && policy.retainDiagnosticsOnFailure);
  await input.runtime.teardown({
    plan,
    workspaceRoot: deps.workspace.rootDir,
    timeoutMs: policy.readinessTimeoutMs,
    retain,
  });
  const stopped = writeInstance(deps, {
    ...instance,
    status: 'STOPPED',
    stoppedAt: nowIso(deps),
    diagnosticsRetained: retain,
    services: instance.services.map((service) => ({ ...service, status: 'STOPPED' })),
  });
  emitJobEvent(deps, instance.jobId, 'environment_torn_down', {
    instanceId: stopped.instanceId,
    retained: retain,
  });
  return stopped;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Record what the environment actually proved.
 *
 * The split between `applicationLevelReady` and `livenessOnlyReady` is the
 * whole point of the record. A closure oracle that reads "READY" and closes
 * a distributed-system requirement on it deserves to know whether anything
 * spoke Postgres or whether four processes merely existed.
 */
function writeEvidence(
  deps: AutonomyDeps,
  plan: EnvironmentPlan,
  instance: EnvironmentInstance,
  totalMs: number | null,
  logRefs: readonly string[],
): EnvironmentEvidence {
  const byId = new Map(plan.services.map((service) => [service.serviceId, service]));
  const applicationLevelReady: string[] = [];
  const livenessOnlyReady: string[] = [];
  const notReady: string[] = [];
  for (const state of instance.services) {
    if (state.status !== 'READY') {
      notReady.push(state.serviceId);
      continue;
    }
    const definition = byId.get(state.serviceId);
    const deep = definition?.probes.some((probe) => isApplicationLevelProbe(probe)) ?? false;
    (deep ? applicationLevelReady : livenessOnlyReady).push(state.serviceId);
  }
  const evidence = environmentEvidenceSchema.parse({
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    instanceId: instance.instanceId,
    planId: plan.planId,
    recordedAt: nowIso(deps),
    status: instance.status,
    applicationLevelReady,
    livenessOnlyReady,
    notReady,
    totalReadinessMs: totalMs,
    logRefs: [...logRefs].slice(0, 60),
  });
  writeJsonRecord(environmentEvidenceFile(deps.workspace, instance.instanceId), evidence);
  return evidence;
}

function writeInstance(deps: AutonomyDeps, instance: EnvironmentInstance): EnvironmentInstance {
  const validated = environmentInstanceSchema.parse(instance);
  writeJsonRecord(environmentInstanceFile(deps.workspace, validated.instanceId), validated);
  return validated;
}

function emitJobEvent(
  deps: AutonomyDeps,
  jobId: string | undefined,
  type:
    | 'environment_provision_started'
    | 'environment_ready'
    | 'environment_failed'
    | 'environment_repaired'
    | 'environment_torn_down',
  payload: Record<string, unknown>,
): void {
  if (jobId === undefined) return;
  try {
    recordJobEvent(jobDepsOf(deps), jobId, type, payload);
  } catch {
    // Environments are provisioned by certification fixtures with no job.
  }
}
