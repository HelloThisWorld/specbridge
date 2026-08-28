import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { runSafeProcess } from '@specbridge/runners';
import { recordJobEvent } from '@specbridge/orchestration';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { jobDepsOf, newRecordId, now, nowIso } from '../deps.js';
import {
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  writeJsonRecord,
} from '../store.js';
import type { EnvironmentRuntime } from '../environment/service.js';
import { provisionEnvironment, teardownEnvironment } from '../environment/service.js';
import type { ProbeExecutor } from '../environment/probe-runner.js';
import type { BrowserDriver } from '../browser/contract.js';
import { runBrowserScenario } from '../browser/service.js';
import { registerClosureEvidence } from '../closure/service.js';

/**
 * Mission-level system acceptance scenarios.
 *
 * A task-level test proves a unit works. A system scenario proves the
 * PRODUCT works: real persistence, a real broker, a real API, a process
 * restart, a browser looking at the result. The distinction is the reason
 * Mission completion is a different concept from Task completion, and the
 * reason a mission whose sealed criteria imply a distributed system cannot
 * close on unit tests alone.
 *
 * A scenario is a small, declarative composition of things that already
 * exist: an environment plan, some trusted verification commands, and
 * optionally browser scenarios. That is deliberate. This module orchestrates;
 * it does not invent a third way to run a command or a fourth way to decide
 * whether something passed.
 */

export const SYSTEM_SCENARIO_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

/**
 * One command run against a provisioned system.
 *
 * argv arrays only, exactly like trusted verification commands and readiness
 * probes. There is one shell-free command model in SpecBridge and this is it.
 */
export const systemStepSchema = z
  .object({
    stepId: shortText,
    name: shortText,
    argv: z.array(z.string().min(1).max(500)).min(1).max(30),
    /** Workspace-relative working directory. */
    cwd: shortText.optional(),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
    /**
     * A fault injected before this step: restart a service, or stop it.
     * Scoped to services in the scenario's own environment plan, so a
     * scenario cannot reach a container it did not declare.
     */
    injectFault: z
      .object({ kind: z.enum(['RESTART_SERVICE', 'STOP_SERVICE']), serviceId: shortText })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type SystemStep = z.infer<typeof systemStepSchema>;

export const systemScenarioSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    scenarioId: shortText,
    name: shortText,
    intent: text,
    /**
     * The environment this scenario needs. A scenario that declares none
     * runs against the workspace itself — an explicit, recorded claim that
     * the product needs no external services to demonstrate this, not a
     * shortcut around provisioning. Fault injection requires a plan, since
     * a fault can only be scoped to a declared service.
     */
    environmentPlanId: shortText.optional(),
    steps: z.array(systemStepSchema).min(1).max(50),
    /** Browser scenarios to run once the system steps pass. */
    browserScenarioIds: z.array(shortText).max(20).default([]),
    /** Sealed items this scenario is evidence for. */
    itemIds: z.array(shortText).max(100).default([]),
    createdAt: shortText,
    jobId: shortText.optional(),
  })
  .passthrough();
export type SystemScenario = z.infer<typeof systemScenarioSchema>;

export const systemScenarioResultSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    resultId: shortText,
    scenarioId: shortText,
    jobId: shortText.optional(),
    status: z.enum(['PASSED', 'FAILED', 'ENVIRONMENT_UNAVAILABLE', 'NOT_RUN']),
    startedAt: shortText,
    finishedAt: shortText.optional(),
    environmentInstanceId: shortText.optional(),
    steps: z
      .array(
        z
          .object({
            stepId: shortText,
            name: shortText,
            ok: z.boolean(),
            detail: text,
            durationMs: z.number().int().min(0).nullable().default(null),
            faultInjected: shortText.optional(),
          })
          .passthrough(),
      )
      .max(50)
      .default([]),
    browserResultIds: z.array(shortText).max(20).default([]),
    failureDetail: text.optional(),
  })
  .passthrough();
export type SystemScenarioResult = z.infer<typeof systemScenarioResultSchema>;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function scenarioFile(workspace: WorkspaceInfo, scenarioId: string): string {
  assertAutonomyId('system scenario', scenarioId);
  return autonomyPath(workspace, 'system', `${scenarioId}.json`);
}

function resultFile(workspace: WorkspaceInfo, resultId: string): string {
  assertAutonomyId('system result', resultId);
  return autonomyPath(workspace, 'system', 'results', `${resultId}.json`);
}

export function saveSystemScenario(
  deps: AutonomyDeps,
  input: Omit<SystemScenario, 'schemaVersion' | 'createdAt' | 'scenarioId'> & { scenarioId?: string },
): SystemScenario {
  const scenario = systemScenarioSchema.parse({
    schemaVersion: SYSTEM_SCENARIO_SCHEMA_VERSION,
    scenarioId: input.scenarioId ?? newRecordId(deps, 'ss'),
    createdAt: nowIso(deps),
    ...input,
  });
  writeJsonRecord(scenarioFile(deps.workspace, scenario.scenarioId), scenario);
  return scenario;
}

export function readSystemScenario(
  workspace: WorkspaceInfo,
  scenarioId: string,
): SystemScenario | undefined {
  return readJsonRecord(scenarioFile(workspace, scenarioId), (raw) =>
    systemScenarioSchema.parse(raw),
  );
}

export function listSystemScenarios(workspace: WorkspaceInfo): SystemScenario[] {
  return listJsonRecords(autonomyPath(workspace, 'system'), (raw) =>
    systemScenarioSchema.parse(raw),
  ).sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

export function listSystemScenarioResults(workspace: WorkspaceInfo): SystemScenarioResult[] {
  return listJsonRecords(autonomyPath(workspace, 'system', 'results'), (raw) =>
    systemScenarioResultSchema.parse(raw),
  ).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RunSystemScenarioOptions {
  scenarioId: string;
  jobId?: string | undefined;
  /** Required when the scenario declares an environment plan. */
  runtime?: EnvironmentRuntime | undefined;
  probeExecutor?: ProbeExecutor | undefined;
  browserDriver?: BrowserDriver | undefined;
  /** Injected command runner (tests). Production shells out safely. */
  commandRunner?:
    | ((input: { argv: readonly string[]; cwd: string; timeoutMs: number }) => Promise<{ ok: boolean; detail: string }>)
    | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  signal?: AbortSignal | undefined;
  resultId?: string | undefined;
  /** Register the outcome against the closure ledger for these items. */
  registerClosure?: boolean | undefined;
  /** Tear the environment down afterwards. Default true. */
  teardown?: boolean | undefined;
}

/**
 * Run one system scenario end to end.
 *
 * `ENVIRONMENT_UNAVAILABLE` is a distinct status from `FAILED`, and the
 * distinction is the same one the reliability runtime already makes between
 * FAIL and INCONCLUSIVE: an environment that would not start has proved
 * nothing about the product, and repairing the product because Docker was
 * down is exactly the wasted overnight cycle that classification prevents.
 */
export async function runSystemScenario(
  deps: AutonomyDeps,
  options: RunSystemScenarioOptions,
): Promise<SystemScenarioResult> {
  const scenario = readSystemScenario(deps.workspace, options.scenarioId);
  if (scenario === undefined) {
    throw new AutonomyError('SBA024', `No system scenario "${options.scenarioId}" exists.`);
  }
  const resultId = options.resultId ?? newRecordId(deps, 'sr');
  const startedAt = nowIso(deps);
  emit(deps, options.jobId, 'system_qualification_started', {
    scenarioId: scenario.scenarioId,
    resultId,
  });

  if (scenario.environmentPlanId !== undefined && options.runtime === undefined) {
    return finish(deps, options, scenario, {
      resultId,
      startedAt,
      status: 'ENVIRONMENT_UNAVAILABLE',
      failureDetail:
        `the scenario declares environment plan ${scenario.environmentPlanId} and no ` +
        'environment runtime is available in this session; the product was never exercised',
    });
  }

  // A scenario without an environment plan runs against the workspace
  // itself. A scenario WITH one gets nothing until the environment is READY.
  const instance =
    scenario.environmentPlanId === undefined || options.runtime === undefined
      ? undefined
      : await provisionEnvironment(deps, {
          planId: scenario.environmentPlanId,
          ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
          runtime: options.runtime,
          ...(options.probeExecutor !== undefined ? { probeExecutor: options.probeExecutor } : {}),
          ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });

  if (instance !== undefined && instance.status !== 'READY') {
    return finish(deps, options, scenario, {
      resultId,
      startedAt,
      status: 'ENVIRONMENT_UNAVAILABLE',
      environmentInstanceId: instance.instanceId,
      failureDetail:
        instance.failureDetail ??
        `the environment reached ${instance.status}; the product was never exercised`,
    });
  }

  const steps: SystemScenarioResult['steps'] = [];
  const runCommand =
    options.commandRunner ??
    (async (input) => {
      const [executable, ...argv] = input.argv;
      if (executable === undefined) return { ok: false, detail: 'empty command' };
      const result = await runSafeProcess({
        executable,
        argv,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 512 * 1024,
      });
      return {
        ok: result.status === 'ok',
        detail:
          result.status === 'ok'
            ? 'exited 0'
            : `${result.status}: ${(result.stderr || result.stdout).split('\n')[0] ?? ''}`.slice(0, 400),
      };
    });

  let failureDetail: string | undefined;
  for (const step of scenario.steps) {
    if (options.signal?.aborted === true) {
      failureDetail = 'the scenario was cancelled';
      break;
    }
    let faultInjected: string | undefined;
    if (step.injectFault !== undefined) {
      if (scenario.environmentPlanId === undefined || options.runtime === undefined) {
        // A fault can only be scoped to a declared service. A scenario that
        // asks for one without a plan is malformed, and running its steps
        // anyway would record a pass for a scenario that never happened.
        failureDetail = `step "${step.name}" declares a fault but the scenario declares no environment plan`;
        break;
      }
      faultInjected = await injectFault(deps, {
        environmentPlanId: scenario.environmentPlanId,
        runtime: options.runtime,
        fault: step.injectFault,
      });
    }
    const before = now(deps).getTime();
    const outcome = await runCommand({
      argv: step.argv,
      cwd: deps.workspace.rootDir,
      timeoutMs: step.timeoutMs,
    });
    steps.push({
      stepId: step.stepId,
      name: step.name,
      ok: outcome.ok,
      detail: outcome.detail.slice(0, 4_000),
      durationMs: Math.max(0, now(deps).getTime() - before),
      ...(faultInjected !== undefined ? { faultInjected } : {}),
    });
    if (!outcome.ok) {
      failureDetail = `system step "${step.name}" failed: ${outcome.detail}`;
      break;
    }
  }

  const browserResultIds: string[] = [];
  if (failureDetail === undefined && options.browserDriver !== undefined) {
    for (const browserScenarioId of scenario.browserScenarioIds) {
      const browserResult = await runBrowserScenario(deps, {
        scenarioId: browserScenarioId,
        driver: options.browserDriver,
        ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      browserResultIds.push(browserResult.resultId);
      if (browserResult.status === 'FAILED' || browserResult.status === 'ERRORED') {
        failureDetail = `browser scenario ${browserScenarioId}: ${browserResult.failureDetail ?? 'failed'}`;
        break;
      }
      if (browserResult.status === 'SKIPPED_NO_RUNTIME') {
        // A skipped browser check does not fail the system scenario, and it
        // also does not let it close a browser-requiring item: the closure
        // ledger sees no BROWSER_SCENARIO evidence and says so.
        continue;
      }
    }
  }

  const result = await finish(deps, options, scenario, {
    resultId,
    startedAt,
    status: failureDetail === undefined ? 'PASSED' : 'FAILED',
    ...(instance !== undefined ? { environmentInstanceId: instance.instanceId } : {}),
    steps,
    browserResultIds,
    ...(failureDetail !== undefined ? { failureDetail } : {}),
  });

  if (options.teardown !== false && instance !== undefined && options.runtime !== undefined) {
    await teardownEnvironment(deps, {
      instanceId: instance.instanceId,
      runtime: options.runtime,
      retain: result.status !== 'PASSED',
    });
  }
  return result;
}

async function injectFault(
  deps: AutonomyDeps,
  input: {
    environmentPlanId: string;
    runtime: EnvironmentRuntime;
    fault: { kind: 'RESTART_SERVICE' | 'STOP_SERVICE'; serviceId: string };
  },
): Promise<string> {
  const plan = readJsonRecord(
    autonomyPath(deps.workspace, 'environments', 'plans', `${input.environmentPlanId}.json`),
    (raw) => raw as { services: { serviceId: string; name: string }[]; planId: string },
  );
  const service = plan?.services.find((entry) => entry.serviceId === input.fault.serviceId);
  if (service === undefined) return `unknown service ${input.fault.serviceId}`;
  await input.runtime.restart({
    plan: plan as never,
    service: service as never,
    workspaceRoot: deps.workspace.rootDir,
    timeoutMs: 120_000,
  });
  return `${input.fault.kind} ${input.fault.serviceId}`;
}

async function finish(
  deps: AutonomyDeps,
  options: RunSystemScenarioOptions,
  scenario: SystemScenario,
  input: Omit<SystemScenarioResult, 'schemaVersion' | 'scenarioId'>,
): Promise<SystemScenarioResult> {
  const result = systemScenarioResultSchema.parse({
    schemaVersion: SYSTEM_SCENARIO_SCHEMA_VERSION,
    scenarioId: scenario.scenarioId,
    ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
    finishedAt: nowIso(deps),
    ...input,
  });
  writeJsonRecord(resultFile(deps.workspace, result.resultId), result);

  if (options.registerClosure === true && scenario.itemIds.length > 0 && options.jobId !== undefined) {
    // ENVIRONMENT_UNAVAILABLE registers nothing at all: it is neither
    // evidence that the product works nor evidence that it does not, and
    // recording it as a failure would send the gap-closure loop off to
    // repair code that was never exercised.
    if (result.status !== 'ENVIRONMENT_UNAVAILABLE') {
      registerClosureEvidence(deps, {
        jobId: options.jobId,
        itemIds: scenario.itemIds,
        kind: 'SYSTEM_SCENARIO',
        ref: result.resultId,
        passed: result.status === 'PASSED',
        ...(result.failureDetail !== undefined ? { detail: result.failureDetail } : {}),
      });
    }
  }

  emit(deps, options.jobId, 'system_qualification_completed', {
    scenarioId: scenario.scenarioId,
    resultId: result.resultId,
    status: result.status,
  });
  return result;
}

function emit(
  deps: AutonomyDeps,
  jobId: string | undefined,
  type: 'system_qualification_started' | 'system_qualification_completed',
  payload: Record<string, unknown>,
): void {
  if (jobId === undefined) return;
  try {
    recordJobEvent(jobDepsOf(deps), jobId, type, payload);
  } catch {
    // Certification fixtures run scenarios with no job record.
  }
}
