import { describe, expect, it } from 'vitest';
import type { BrowserDriver, EnvironmentRuntime, ProbeExecutor } from '@specbridge/autonomy';
import {
  bindSealToJob,
  buildClosureLedger,
  defaultNodeReproducibilitySteps,
  listReproducibilityResults,
  listSystemScenarioResults,
  readClosureLedger,
  runClosureAudit,
  runReproducibilityQualification,
  runSystemScenario,
  saveBrowserScenario,
  saveEnvironmentPlan,
  saveSystemScenario,
} from '@specbridge/autonomy';
import { createJob } from '@specbridge/orchestration';
import { sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * System-scenario and reproducibility qualification.
 *
 * These are the two phases that decide whether a MISSION is finished, as
 * opposed to whether its tasks are. Both are asserted through the closure
 * ledger rather than through their own return values: what matters is not
 * that a scenario reported PASSED, but that the sealed contract item it was
 * evidence for actually closed — and, in the negative cases, that it did not.
 */

const instantSleep = async (): Promise<void> => undefined;

function fakeRuntime(): EnvironmentRuntime {
  return {
    label: 'fake',
    async provision() {
      return { ok: true, detail: 'up' };
    },
    async restart() {
      return { ok: true, detail: 'restarted' };
    },
    async logs() {
      return 'log\n';
    },
    async teardown() {
      return { ok: true, detail: 'down' };
    },
  };
}

function unavailableRuntime(): EnvironmentRuntime {
  return {
    ...fakeRuntime(),
    async provision() {
      return {
        ok: false,
        detail: 'cannot connect to the docker daemon',
        failureKind: 'RUNTIME_UNAVAILABLE',
      };
    },
  };
}

const readyProbe: ProbeExecutor = async () => ({ ready: true, detail: 'answered' });

function setup(): {
  fixture: ReturnType<typeof setupAutonomyFixture>;
  jobId: string;
  systemItem: string;
  browserItem: string;
} {
  const fixture = setupAutonomyFixture();
  const { seal } = sealedMission(fixture);
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement the sealed product intent.',
  });
  bindSealToJob(fixture.deps, job.jobId, seal.sealId);
  const ledger = buildClosureLedger(fixture.deps, { jobId: job.jobId, seal });

  const systemItem = ledger.entries.find((entry) => entry.requiresSystemScenario)
    ?.itemId as string;
  const browserItem = ledger.entries.find((entry) => entry.requiresBrowserScenario)
    ?.itemId as string;

  saveEnvironmentPlan(fixture.deps, {
    planId: 'env-sys',
    name: 'system',
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
        maxRestarts: 1,
        readinessTimeoutMs: 30_000,
        ports: [5432],
      },
    ],
  } as never);

  return { fixture, jobId: job.jobId, systemItem, browserItem };
}

describe('system scenarios', () => {
  it('a passing scenario closes the sealed item it is evidence for', async () => {
    const { fixture, jobId, systemItem } = setup();
    saveSystemScenario(fixture.deps, {
      scenarioId: 'ss-1',
      name: 'end-to-end',
      intent: 'a workflow runs end to end against real infrastructure',
      environmentPlanId: 'env-sys',
      steps: [
        { stepId: 's1', name: 'trigger a workflow', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 60_000 },
      ],
      itemIds: [systemItem],
    } as never);

    const result = await runSystemScenario(fixture.deps, {
      scenarioId: 'ss-1',
      jobId,
      runtime: fakeRuntime(),
      probeExecutor: readyProbe,
      sleep: instantSleep,
      registerClosure: true,
      resultId: 'sr-1',
      commandRunner: async () => ({ ok: true, detail: 'exited 0' }),
    });
    expect(result.status).toBe('PASSED');

    const { ledger } = runClosureAudit(fixture.deps, {
      jobId,
      completedNodeIds: ['n1'],
      implementationComplete: true,
    });
    const entry = ledger.entries.find((item) => item.itemId === systemItem);
    expect(entry?.evidence.some((ref) => ref.kind === 'SYSTEM_SCENARIO' && ref.passed)).toBe(true);
  });

  it('a failing step leaves the item unclosed with EVIDENCE_FAILED', async () => {
    const { fixture, jobId, systemItem } = setup();
    saveSystemScenario(fixture.deps, {
      scenarioId: 'ss-2',
      name: 'end-to-end',
      intent: 'x',
      environmentPlanId: 'env-sys',
      steps: [{ stepId: 's1', name: 'trigger', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 60_000 }],
      itemIds: [systemItem],
    } as never);

    const result = await runSystemScenario(fixture.deps, {
      scenarioId: 'ss-2',
      jobId,
      runtime: fakeRuntime(),
      probeExecutor: readyProbe,
      sleep: instantSleep,
      registerClosure: true,
      resultId: 'sr-2',
      commandRunner: async () => ({ ok: false, detail: 'the redrive path threw' }),
    });
    expect(result.status).toBe('FAILED');
    expect(result.failureDetail).toMatch(/redrive/);

    const { ledger } = runClosureAudit(fixture.deps, {
      jobId,
      completedNodeIds: ['n1'],
      implementationComplete: true,
    });
    const entry = ledger.entries.find((item) => item.itemId === systemItem);
    expect(entry?.status).not.toBe('VERIFIED');
  });

  it('an unavailable environment registers NO evidence in either direction', async () => {
    const { fixture, jobId, systemItem } = setup();
    saveSystemScenario(fixture.deps, {
      scenarioId: 'ss-3',
      name: 'end-to-end',
      intent: 'x',
      environmentPlanId: 'env-sys',
      steps: [{ stepId: 's1', name: 'trigger', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 60_000 }],
      itemIds: [systemItem],
    } as never);

    const result = await runSystemScenario(fixture.deps, {
      scenarioId: 'ss-3',
      jobId,
      runtime: unavailableRuntime(),
      probeExecutor: readyProbe,
      sleep: instantSleep,
      registerClosure: true,
      resultId: 'sr-3',
    });
    expect(result.status).toBe('ENVIRONMENT_UNAVAILABLE');

    // An environment that would not start proved nothing about the product.
    // Recording it as a failure would send gap closure off to repair code
    // that was never exercised.
    const ledger = readClosureLedger(fixture.workspace, jobId);
    const entry = ledger?.entries.find((item) => item.itemId === systemItem);
    expect(entry?.evidence.length).toBe(0);
  });

  it('runs its browser scenarios and records their result ids', async () => {
    const { fixture, jobId, systemItem, browserItem } = setup();
    saveBrowserScenario(fixture.deps, {
      scenarioId: 'bs-sys',
      name: 'dashboard',
      intent: 'the dashboard shows the execution',
      baseUrl: 'http://127.0.0.1:5173',
      contexts: ['default'],
      criterionIds: [browserItem],
      steps: [
        { kind: 'NAVIGATE', context: 'default', url: '/' },
        { kind: 'EXPECT_SELECTOR', context: 'default', selector: '[data-test=row]' },
      ],
    } as never);
    saveSystemScenario(fixture.deps, {
      scenarioId: 'ss-4',
      name: 'end-to-end with UI',
      intent: 'x',
      environmentPlanId: 'env-sys',
      steps: [{ stepId: 's1', name: 'trigger', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 60_000 }],
      browserScenarioIds: ['bs-sys'],
      itemIds: [systemItem],
    } as never);

    const driver: BrowserDriver = {
      label: 'fake',
      async available() {
        return { ok: true };
      },
      async open() {
        return {
          async step() {
            return { ok: true, detail: 'ok' };
          },
          observations: () => [],
          async snapshot() {
            return '';
          },
          async close() {
            return undefined;
          },
        };
      },
    };

    const result = await runSystemScenario(fixture.deps, {
      scenarioId: 'ss-4',
      jobId,
      runtime: fakeRuntime(),
      probeExecutor: readyProbe,
      browserDriver: driver,
      sleep: instantSleep,
      resultId: 'sr-4',
      commandRunner: async () => ({ ok: true, detail: 'exited 0' }),
    });
    expect(result.status).toBe('PASSED');
    expect(result.browserResultIds.length).toBe(1);
    expect(listSystemScenarioResults(fixture.workspace).length).toBe(1);
  });
});

describe('reproducibility qualification', () => {
  it('passes and advances the closure phase when every step runs', async () => {
    const { fixture, jobId, systemItem } = setup();
    const result = await runReproducibilityQualification(fixture.deps, {
      jobId,
      checkoutPath: 'D:/tmp/clean-checkout',
      gitHead: 'abc123',
      itemIds: [systemItem],
      runId: 'rp-1',
      steps: defaultNodeReproducibilitySteps('pnpm'),
      commandRunner: async () => ({ outcome: 'PASSED', detail: 'exited 0' }),
    });

    expect(result.status).toBe('PASSED');
    expect(result.dimensions).toContain('NO_BUILD_CACHE');
    expect(readClosureLedger(fixture.workspace, jobId)?.reproducibilityPassed).toBe(true);
    expect(listReproducibilityResults(fixture.workspace).length).toBe(1);
  });

  it('is INCONCLUSIVE, not PASSED, when a step cannot run here', async () => {
    const { fixture, jobId } = setup();
    const result = await runReproducibilityQualification(fixture.deps, {
      jobId,
      checkoutPath: 'D:/tmp/clean-checkout',
      runId: 'rp-2',
      steps: defaultNodeReproducibilitySteps('pnpm'),
      commandRunner: async (input) =>
        input.argv[1] === 'build'
          ? { outcome: 'UNAVAILABLE', detail: 'pnpm could not be started in the clean checkout' }
          : { outcome: 'PASSED', detail: 'exited 0' },
    });

    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.inconclusiveReason).toMatch(/could not be started/);
    // An INCONCLUSIVE run leaves the flag false, so the oracle keeps asking.
    expect(readClosureLedger(fixture.workspace, jobId)?.reproducibilityPassed).toBe(false);
  });

  it('a failing step is a FAILURE and registers failing evidence', async () => {
    const { fixture, jobId, systemItem } = setup();
    const result = await runReproducibilityQualification(fixture.deps, {
      jobId,
      checkoutPath: 'D:/tmp/clean-checkout',
      itemIds: [systemItem],
      runId: 'rp-3',
      steps: defaultNodeReproducibilitySteps('pnpm'),
      commandRunner: async (input) =>
        input.argv[1] === 'test'
          ? { outcome: 'FAILED', detail: 'nonzero-exit: 3 tests failed' }
          : { outcome: 'PASSED', detail: 'exited 0' },
    });

    expect(result.status).toBe('FAILED');
    const ledger = readClosureLedger(fixture.workspace, jobId);
    const entry = ledger?.entries.find((item) => item.itemId === systemItem);
    expect(entry?.evidence.some((ref) => ref.kind === 'REPRODUCIBILITY_RUN' && !ref.passed)).toBe(
      true,
    );
    expect(ledger?.reproducibilityPassed).toBe(false);
  });

  it('an INCONCLUSIVE run registers no evidence at all', async () => {
    const { fixture, jobId, systemItem } = setup();
    await runReproducibilityQualification(fixture.deps, {
      jobId,
      checkoutPath: 'D:/tmp/clean-checkout',
      itemIds: [systemItem],
      runId: 'rp-4',
      steps: defaultNodeReproducibilitySteps('pnpm'),
      commandRunner: async () => ({ outcome: 'UNAVAILABLE', detail: 'no package manager' }),
    });
    const ledger = readClosureLedger(fixture.workspace, jobId);
    const entry = ledger?.entries.find((item) => item.itemId === systemItem);
    expect(entry?.evidence.length).toBe(0);
  });
});
