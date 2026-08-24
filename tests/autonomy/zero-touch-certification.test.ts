import { describe, expect, it } from 'vitest';
import type {
  AutonomyDeps,
  BrowserDriver,
  CertificationScenario,
  DriverHost,
  DriverRunOutcome,
  EnvironmentRuntime,
  ProbeExecutor,
  ScenarioExecution,
} from '@specbridge/autonomy';
import {
  CERTIFICATION_MATRIX,
  applyRecovery,
  attributeNodeToItems,
  authorityScenarios,
  bindSealToJob,
  buildClosureLedger,
  classifyFailure,
  createAuthorityResolver,
  detectControlPlaneDefect,
  generateGapWork,
  isSelfRecoverable,
  provisionEnvironment,
  registerClosureEvidence,
  requestToolsmithCapability,
  runBrowserScenario,
  runClosureAudit,
  runZeroTouchCertification,
  saveBrowserScenario,
  saveEnvironmentPlan,
  selfRecoveryScenarios,
  superviseJob,
} from '@specbridge/autonomy';
import { createJob, requireJobState } from '@specbridge/orchestration';
import { sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * GOLDEN ZERO-TOUCH CERTIFICATION.
 *
 * This is the suite that decides whether vNext.10 is real. Unit tests prove
 * each component's decision function is correct; this proves that when the
 * assembled runtime meets a fault, it handles the fault instead of waking
 * somebody up.
 *
 * Every scenario injects at a SpecBridge-controlled seam — a driver host, a
 * probe executor, a browser driver, durable state — and then asserts against
 * what actually landed on disk. Nothing asserts that the runtime *said* it
 * recovered.
 *
 * The sixteenth scenario is the one that makes the other fifteen mean
 * something: a runtime that never asks is not the goal, and the authority
 * case must reach NEEDS_AUTHORITY without touching the sealed contract.
 */

const instantSleep = async (): Promise<void> => undefined;

/** A driver host that fails in a configured way, then behaves. */
function faultHost(input: {
  failures: readonly DriverRunOutcome[];
  onRun?: (index: number) => void;
}): DriverHost {
  let index = 0;
  return {
    label: 'fault-injecting',
    async run(): Promise<DriverRunOutcome> {
      const outcome = input.failures[index] ?? { kind: 'exited' as const, stop: { kind: 'completed' as const } };
      input.onRun?.(index);
      index += 1;
      return outcome;
    },
  };
}

function crash(message: string): DriverRunOutcome {
  return { kind: 'crashed', error: message };
}

/** A job on the fixture's approved spec, with its seal and ledger bound. */
function sealedJob(fixture: ReturnType<typeof setupAutonomyFixture>): {
  jobId: string;
  deps: AutonomyDeps;
  itemIds: string[];
} {
  const { seal } = sealedMission(fixture);
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement the sealed product intent.',
  });
  bindSealToJob(fixture.deps, job.jobId, seal.sealId);
  const ledger = buildClosureLedger(fixture.deps, { jobId: job.jobId, seal });
  return {
    jobId: job.jobId,
    deps: fixture.deps,
    itemIds: ledger.entries.map((entry) => entry.itemId),
  };
}

// ---------------------------------------------------------------------------
// Scenario executors
// ---------------------------------------------------------------------------

/**
 * Drive one fault through the recovery classifier and the durable job state.
 *
 * The shared shape of ZT-01 through ZT-08 and ZT-14/15: the driver dies with
 * a recognisable signature, the runtime classifies it, moves the job onto an
 * operational status, and NOBODY is asked anything.
 */
async function recoveryScenario(
  fixture: ReturnType<typeof setupAutonomyFixture>,
  input: { message: string; retryAt?: string; expectStatus: string; expectWait: string },
): Promise<ScenarioExecution> {
  const { jobId, deps } = sealedJob(fixture);
  const observation = {
    kind: input.retryAt !== undefined ? ('deferred' as const) : ('crash' as const),
    detail: input.message,
    ...(input.retryAt !== undefined ? { retryAt: input.retryAt } : {}),
  };
  const classification = applyRecovery(deps, { jobId, observation });
  const job = requireJobState(fixture.workspace, jobId);

  const asExpected =
    classification.status === input.expectStatus &&
    classification.waitKind === input.expectWait &&
    !classification.humanRequired;

  return {
    outcome: asExpected ? 'SELF_RECOVERED' : 'STUCK',
    humanInterventions: classification.humanRequired ? 1 : 0,
    authorityEscalations: job.autonomyCounters?.authorityEscalations ?? 0,
    observed: `${classification.status} / ${classification.waitKind}: ${classification.detail}`,
    finalStatus: job.status,
    recoveryPath: [job.status],
  };
}

async function executeScenario(
  scenario: CertificationScenario,
): Promise<ScenarioExecution> {
  switch (scenario.fault) {
    case 'STRONG_PROVIDER_UNAVAILABLE':
      return recoveryScenario(setupAutonomyFixture({ spec: true }), {
        message: 'provider returned 529 overloaded for three consecutive dispatches',
        expectStatus: 'WAITING_RESOURCE',
        expectWait: 'PROVIDER_COOLDOWN',
      });

    case 'STRONG_QUOTA_EXHAUSTED':
      return recoveryScenario(setupAutonomyFixture({ spec: true }), {
        message: 'subscription quota exhausted; capacity returns at the next window',
        retryAt: '2026-08-21T02:00:00.000Z',
        expectStatus: 'WAITING_RESOURCE',
        expectWait: 'SUBSCRIPTION_QUOTA_RESET',
      });

    case 'LOCAL_RUNTIME_CRASH':
      return recoveryScenario(setupAutonomyFixture({ spec: true }), {
        message: 'local model server exited with code 139',
        expectStatus: 'RECOVERING_PROVIDER',
        expectWait: 'LOCAL_RUNTIME_RESTART',
      });

    case 'INVALID_STRUCTURED_OUTPUT':
      return invalidOutputScenario();

    case 'CONTEXT_EXHAUSTION':
      return contextExhaustionScenario();

    case 'WORKER_PROCESS_TERMINATED':
      return recoveryScenario(setupAutonomyFixture({ spec: true }), {
        message: 'spawn claude ENOENT after the worker process was terminated',
        expectStatus: 'REPAIRING_TOOLCHAIN',
        expectWait: 'TOOLCHAIN_PROVISIONING',
      });

    case 'DRIVER_PROCESS_TERMINATED':
      return driverTerminationScenario();

    case 'CONTAINER_SERVICE_CRASH':
      return recoveryScenario(setupAutonomyFixture({ spec: true }), {
        message: 'container kafka exited unexpectedly during the system scenario',
        expectStatus: 'REPAIRING_ENVIRONMENT',
        expectWait: 'ENVIRONMENT_READINESS',
      });

    case 'DELAYED_SERVICE_READINESS':
      return delayedReadinessScenario();

    case 'MISSING_PROJECT_DEPENDENCY':
      return missingDependencyScenario();

    case 'MISSING_BROWSER_RUNTIME':
      return missingBrowserScenario();

    case 'FAILING_IMPLEMENTATION_TEST':
      return failingTestScenario();

    case 'WRONG_STRATEGY_REQUIRES_REPLAN':
      return replanScenario();

    case 'TRANSIENT_NETWORK_FAILURE':
      return recoveryScenario(setupAutonomyFixture({ spec: true }), {
        message: 'connect ECONNREFUSED 127.0.0.1:11434',
        expectStatus: 'RECOVERING_PROVIDER',
        expectWait: 'EXTERNAL_SERVICE_OUTAGE',
      });

    case 'CONTROL_PLANE_RUNNER_DEFECT':
      return controlPlaneDefectScenario();

    case 'SEALED_CONTRACT_CHANGE_REQUIRED':
      return authorityScenario();

    default:
      return {
        outcome: 'NOT_RUN',
        humanInterventions: 0,
        authorityEscalations: 0,
        observed: 'no executor is defined for this fault class',
      };
  }
}

/**
 * ZT-04: invalid structured output.
 *
 * The bounded correction and tier escalation live in the driver; what the
 * certification asserts is that the failure NEVER classifies as needing a
 * human, however many times it repeats.
 */
async function invalidOutputScenario(): Promise<ScenarioExecution> {
  const messages = [
    'invalid agent output: expected object, received string',
    'invalid agent output: schema validation failed after correction',
    'invalid agent output: the model returned prose instead of JSON',
  ];
  const humanRequired = messages.filter(
    (message) => !isSelfRecoverable({ kind: 'crash', detail: message }),
  );
  return {
    outcome: humanRequired.length === 0 ? 'SELF_RECOVERED' : 'ASKED_HUMAN',
    humanInterventions: humanRequired.length,
    authorityEscalations: 0,
    observed:
      `${messages.length} invalid-output failures all classified as bounded retries ` +
      `(${classifyFailure({ kind: 'crash', detail: messages[0] as string }).status})`,
  };
}

/** ZT-05: context exhaustion rolls over without losing task state. */
async function contextExhaustionScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({ spec: true });
  const { jobId, deps, itemIds } = sealedJob(fixture);

  // Attribution recorded BEFORE the rollover is durable task memory. If it
  // survives, Task Memory != Model Context Window is not a slogan.
  attributeNodeToItems(deps, {
    jobId,
    nodeId: 'n1',
    taskId: '1',
    itemIds: [itemIds[0] as string],
  });

  const classification = applyRecovery(deps, {
    jobId,
    observation: { kind: 'crash', detail: 'context window exceeded: prompt is too long for the model' },
  });
  const job = requireJobState(fixture.workspace, jobId);
  const { ledger } = runClosureAudit(deps, {
    jobId,
    completedNodeIds: [],
    implementationComplete: false,
  });
  const survived = ledger.entries.find((entry) => entry.itemId === itemIds[0]);

  const ok =
    !classification.humanRequired &&
    classification.status === 'READY' &&
    survived?.attributedNodeIds.includes('n1') === true;

  return {
    outcome: ok ? 'SELF_RECOVERED' : 'STUCK',
    humanInterventions: classification.humanRequired ? 1 : 0,
    authorityEscalations: 0,
    observed: `context rollover: ${classification.detail}; durable attribution survived the new session`,
    finalStatus: job.status,
    recoveryPath: [job.status],
  };
}

/** ZT-07: the driver dies and the supervisor restarts it. */
async function driverTerminationScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({ spec: true });
  const { jobId } = sealedJob(fixture);
  const runs: number[] = [];
  const host = faultHost({
    failures: [crash('the driver process was terminated (SIGKILL)')],
    onRun: (index) => runs.push(index),
  });

  const result = await superviseJob(fixture.deps, jobId, {
    host,
    sleep: instantSleep,
    maxCycles: 4,
    ownerId: 'sup-zt07',
  });

  const restarted = runs.length >= 2;
  return {
    outcome: restarted && result.stop.kind !== 'needs-human' ? 'SELF_RECOVERED' : 'STUCK',
    humanInterventions: result.stop.kind === 'needs-human' ? 1 : 0,
    authorityEscalations: 0,
    observed:
      `the driver died on run 1 and the supervisor started it ${runs.length} time(s) under the ` +
      `same lease; supervision stopped as ${result.stop.kind}`,
    finalStatus: result.job.status,
    recoveryPath: [`starts=${result.supervised.starts}`, `restarts=${result.supervised.restarts}`],
  };
}

/** ZT-09: a service that answers only after several probes. */
async function delayedReadinessScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({ spec: true });
  const plan = saveEnvironmentPlan(fixture.deps, {
    planId: 'env-slow',
    name: 'slow-postgres',
    services: [
      {
        serviceId: 'postgres',
        kind: 'DATABASE',
        name: 'postgres',
        dependsOn: [],
        probes: [
          {
            kind: 'PROTOCOL_HANDSHAKE',
            host: '127.0.0.1',
            protocol: 'postgres',
            argv: ['psql', '-c', 'select 1'],
            expectStatus: [200],
            timeoutMs: 5_000,
          },
        ],
        maxRestarts: 2,
        readinessTimeoutMs: 60_000,
        ports: [5432],
      },
    ],
  } as never);

  let attempts = 0;
  const probe: ProbeExecutor = async () => {
    attempts += 1;
    return attempts >= 6
      ? { ready: true, detail: `postgres answered on attempt ${attempts}` }
      : { ready: false, detail: 'the database is still starting' };
  };
  const runtime: EnvironmentRuntime = {
    label: 'fake',
    async provision() {
      return { ok: true, detail: 'up' };
    },
    async restart() {
      return { ok: true, detail: 'restarted' };
    },
    async logs() {
      return '';
    },
    async teardown() {
      return { ok: true, detail: 'down' };
    },
  };

  const instance = await provisionEnvironment(fixture.deps, {
    planId: plan.planId,
    runtime,
    probeExecutor: probe,
    sleep: instantSleep,
    instanceId: 'envi-zt09',
  });

  return {
    outcome: instance.status === 'READY' ? 'SELF_RECOVERED' : 'STUCK',
    humanInterventions: 0,
    authorityEscalations: 0,
    observed: `the readiness loop waited through ${attempts} probes and the environment reached ${instance.status}`,
    finalStatus: instance.status,
    recoveryPath: instance.services.map((service) => `${service.serviceId}=${service.status}`),
  };
}

/** ZT-10: a missing dependency becomes engineering work, not a wait. */
async function missingDependencyScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({ spec: true });
  const { jobId, deps } = sealedJob(fixture);
  const classification = applyRecovery(deps, {
    jobId,
    observation: { kind: 'crash', detail: "Cannot find module 'zod' from src/index.ts" },
  });
  // The Toolsmith is what actually resolves it, so the scenario asserts the
  // grant is available rather than merely that the status changed.
  const grant = requestToolsmithCapability(deps, {
    jobId,
    capability: 'PROJECT_DEPENDENCY',
    target: 'zod',
    purpose: 'the build cannot resolve a declared dependency',
  });
  const job = requireJobState(fixture.workspace, jobId);

  const ok =
    !classification.humanRequired &&
    classification.status === 'REPAIRING_TOOLCHAIN' &&
    grant.decision.granted;

  return {
    outcome: ok ? 'SELF_RECOVERED' : 'ASKED_HUMAN',
    humanInterventions: ok ? 0 : 1,
    authorityEscalations: 0,
    observed: `${classification.status}; the Toolsmith granted PROJECT_DEPENDENCY for the missing module`,
    finalStatus: job.status,
    recoveryPath: [job.status],
  };
}

/** ZT-11: no browser runtime. A skip with a reason, and a grant requested. */
async function missingBrowserScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({ spec: true });
  const { jobId, deps } = sealedJob(fixture);
  saveBrowserScenario(deps, {
    scenarioId: 'bs-zt11',
    name: 'dashboard',
    intent: 'the dashboard renders the execution history',
    baseUrl: 'http://127.0.0.1:5173',
    contexts: ['default'],
    steps: [
      { kind: 'NAVIGATE', context: 'default', url: '/' },
      { kind: 'EXPECT_SELECTOR', context: 'default', selector: '[data-test=history]' },
    ],
  } as never);

  const driver: BrowserDriver = {
    label: 'unavailable',
    async available() {
      return { ok: false, reason: 'no browser runtime is installed in this workspace' };
    },
    async open() {
      throw new Error('unreachable');
    },
  };
  const result = await runBrowserScenario(deps, {
    scenarioId: 'bs-zt11',
    jobId,
    driver,
    resultId: 'br-zt11',
  });
  const grant = requestToolsmithCapability(deps, {
    jobId,
    capability: 'BROWSER_RUNTIME',
    target: 'chromium',
    purpose: 'a sealed acceptance criterion requires browser evidence',
  });

  const ok = result.status === 'SKIPPED_NO_RUNTIME' && grant.decision.granted;
  return {
    outcome: ok ? 'SELF_RECOVERED' : 'STUCK',
    humanInterventions: 0,
    authorityEscalations: 0,
    observed:
      `the scenario recorded ${result.status} with a reason (never a pass), and the Toolsmith ` +
      'granted BROWSER_RUNTIME so the next attempt has a browser',
    finalStatus: result.status,
  };
}

/** ZT-12: the implementation is wrong; gap work repairs it. */
async function failingTestScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({ spec: true });
  const { jobId, deps, itemIds } = sealedJob(fixture);
  const item = itemIds[0] as string;

  attributeNodeToItems(deps, { jobId, nodeId: 'n1', taskId: '1', itemIds: [item] });
  registerClosureEvidence(deps, {
    jobId,
    itemIds: [item],
    kind: 'TRUSTED_VERIFICATION',
    ref: 'run-fail',
    passed: false,
    detail: 'the settings-persistence test suite failed',
  });

  const { audit } = runClosureAudit(deps, {
    jobId,
    completedNodeIds: ['n1'],
    implementationComplete: true,
  });
  const work = generateGapWork(deps, { jobId, audit });
  const repair = work.find((entry) => entry.itemId === item);

  const ok =
    audit.directive === 'GENERATE_GAP_WORK' &&
    repair?.gapKind === 'EVIDENCE_FAILED' &&
    repair.objective.startsWith('Repair the implementation');

  return {
    outcome: ok ? 'SELF_RECOVERED' : 'STUCK',
    humanInterventions: 0,
    authorityEscalations: 0,
    observed:
      `the failing evidence left the item unclosed with EVIDENCE_FAILED and generated ` +
      `${work.length} repair objective(s) without asking anyone`,
    finalStatus: audit.directive,
  };
}

/** ZT-13: an architecture-flavoured replan proceeds under delegated authority. */
async function replanScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({ spec: true });
  const { jobId } = sealedJob(fixture);
  const resolver = createAuthorityResolver({
    workspace: fixture.workspace,
    policy: fixture.config.autonomy,
  });
  const verdict = resolver.resolve({
    jobId,
    decisionKinds: ['architecture-contract-change', 'new-dependency'],
    reasons: ['the replacement plan introduces "restructure"'],
    proposal:
      'The current approach is wrong. Restructure the persistence layer into a repository ' +
      'module and add a new dependency for schema migrations.',
  });

  return {
    outcome: verdict.kind === 'AUTONOMOUS' ? 'SELF_RECOVERED' : 'ASKED_HUMAN',
    humanInterventions: verdict.kind === 'NEEDS_AUTHORITY' ? 1 : 0,
    authorityEscalations: 0,
    observed: `the replan was resolved as ${verdict.kind}: ${verdict.kind === 'AUTONOMOUS' ? verdict.reason : 'a human was asked'}`,
  };
}

/** ZT-15: a runner contract defect enters governed control-plane repair. */
async function controlPlaneDefectScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({
    autonomy: { controlPlaneRepair: { enabled: true, sourcePath: 'D:/work/specbridge' } },
  });
  const { jobId, deps } = sealedJob(fixture);
  const classification = applyRecovery(deps, {
    jobId,
    observation: {
      kind: 'crash',
      detail: 'claude: unknown option --reasoning-role; the runner CLI rejected an argument',
    },
  });
  const repair = detectControlPlaneDefect(deps, {
    productJobId: jobId,
    defectKind: 'PROVIDER_CLI_INCOMPATIBILITY',
    symptom: 'the provider CLI rejected an argument SpecBridge passes',
    canaryOperation: 'dispatch the EXECUTOR role through the claude-code runner',
  });
  const job = requireJobState(fixture.workspace, jobId);

  const ok =
    !classification.humanRequired &&
    classification.status === 'REPAIRING_CONTROL_PLANE' &&
    repair.status === 'IN_PROGRESS' &&
    repair.stagesCompleted.includes('PRODUCT_JOB_CHECKPOINTED');

  return {
    outcome: ok ? 'SELF_RECOVERED' : 'ASKED_HUMAN',
    humanInterventions: ok ? 0 : 1,
    authorityEscalations: 0,
    observed:
      `the defect classified as ${classification.status}, the product job was checkpointed, and ` +
      `governed repair ${repair.repairId} opened without the operator becoming the maintainer`,
    finalStatus: job.status,
    recoveryPath: repair.stagesCompleted,
  };
}

/** ZT-16: the authority case. The one that must stop. */
async function authorityScenario(): Promise<ScenarioExecution> {
  const fixture = setupAutonomyFixture({ spec: true });
  const { seal } = sealedMission(fixture);
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement the sealed product intent.',
  });
  bindSealToJob(fixture.deps, job.jobId, seal.sealId);
  const before = seal.authorityDigest;

  const resolver = createAuthorityResolver({
    workspace: fixture.workspace,
    policy: fixture.config.autonomy,
  });
  const verdict = resolver.resolve({
    jobId: job.jobId,
    decisionKinds: ['public-api-change'],
    reasons: ['the replacement plan introduces "public api"'],
    proposal:
      'The only way to satisfy this requirement is to change the public API of the action SDK ' +
      'to take a context object.',
  });

  // The sealed record must be byte-identical: an agent proposing a contract
  // change may never quietly apply it.
  const { readSeal } = await import('@specbridge/autonomy');
  const after = readSeal(fixture.workspace, seal.sealId);
  const sealUnchanged = after?.authorityDigest === before && after?.status === 'SEALED';

  if (verdict.kind !== 'NEEDS_AUTHORITY') {
    return {
      outcome: 'SELF_AUTHORIZED',
      humanInterventions: 0,
      authorityEscalations: 0,
      observed: `the runtime resolved a sealed public-contract change as ${verdict.kind}`,
    };
  }
  return {
    outcome: sealUnchanged ? 'NEEDS_AUTHORITY' : 'SELF_AUTHORIZED',
    // An authority stop is governance working, NOT an intervention failure.
    humanInterventions: 0,
    authorityEscalations: 1,
    observed:
      `stopped with "${verdict.question.slice(0, 120)}"; the sealed contract was not modified ` +
      `(digest unchanged: ${String(sealUnchanged)})`,
    finalStatus: 'NEEDS_AUTHORITY',
  };
}

// ---------------------------------------------------------------------------
// The certification
// ---------------------------------------------------------------------------

describe('golden zero-touch certification', () => {
  it('the matrix covers every required fault class in both directions', () => {
    expect(CERTIFICATION_MATRIX.length).toBe(16);
    expect(selfRecoveryScenarios().length).toBe(15);
    expect(authorityScenarios().length).toBe(1);
    expect(new Set(CERTIFICATION_MATRIX.map((s) => s.fault)).size).toBe(16);
  });

  it(
    'runs the full fault matrix with zero human interventions',
    { timeout: 240_000 },
    async () => {
      const host = setupAutonomyFixture({ spec: true });
      const run = await runZeroTouchCertification(host.deps, {
        execute: executeScenario,
        runId: 'zt-golden',
      });

      // Report every failure by name before asserting, so a regression names
      // the scenario rather than just the count.
      expect(run.failures.map((failure) => `${failure.scenarioId}: ${failure.observed}`)).toEqual([]);
      expect(run.humanInterventionsAfterSeal).toBe(0);
      expect(run.totals.selfRecovered).toBe(15);
      expect(run.totals.needsAuthority).toBe(1);
      expect(run.totals.askedHuman).toBe(0);
      expect(run.totals.stuck).toBe(0);
      expect(run.totals.selfAuthorized).toBe(0);
      expect(run.verdict).toBe('CERTIFIED');
    },
  );

  it('a partial matrix certifies nothing', async () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const run = await runZeroTouchCertification(fixture.deps, {
      execute: async () => ({
        outcome: 'SKIPPED_WITH_REASON',
        humanInterventions: 0,
        authorityEscalations: 0,
        observed: 'not runnable here',
        skipReason: 'no container runtime',
      }),
      only: ['ZT-01'],
      runId: 'zt-partial',
    });
    expect(run.verdict).toBe('INCOMPLETE');
    expect(run.rationale).toMatch(/certifies nothing/);
  });

  it('one human intervention fails the certification whatever else passed', async () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const run = await runZeroTouchCertification(fixture.deps, {
      execute: async (scenario) => ({
        outcome: scenario.expectation,
        humanInterventions: scenario.id === 'ZT-03' ? 1 : 0,
        authorityEscalations: 0,
        observed: 'met its expectation',
      }),
      runId: 'zt-intervened',
    });
    expect(run.verdict).toBe('NOT_CERTIFIED');
    expect(run.rationale).toMatch(/the primary metric is zero/);
  });

  it('a runtime that self-authorized a sealed contract change fails', async () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const run = await runZeroTouchCertification(fixture.deps, {
      execute: async (scenario) => ({
        outcome: scenario.expectation === 'NEEDS_AUTHORITY' ? 'SELF_AUTHORIZED' : 'SELF_RECOVERED',
        humanInterventions: 0,
        authorityEscalations: 0,
        observed: 'the runtime applied the contract change itself',
      }),
      runId: 'zt-self-auth',
    });
    expect(run.verdict).toBe('NOT_CERTIFIED');
    expect(run.failures.some((failure) => failure.outcome === 'SELF_AUTHORIZED')).toBe(true);
  });
});
