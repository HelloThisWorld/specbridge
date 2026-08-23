import { describe, expect, it } from 'vitest';
import type {
  EnvironmentPlan,
  EnvironmentRuntime,
  ProbeExecutor,
  ReadinessProbe,
} from '@specbridge/autonomy';
import {
  composePlanFromServices,
  orderServicesForReadiness,
  provisionEnvironment,
  readEnvironmentEvidence,
  readEnvironmentInstance,
  saveEnvironmentPlan,
  teardownEnvironment,
} from '@specbridge/autonomy';
import { setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * Environment lifecycle.
 *
 * Nothing here starts a container. The runtime and the probe executor are
 * both injected, which is what lets the suite assert the parts that actually
 * decide whether an overnight run survives: the readiness dependency graph,
 * the restart budget, the timeout, the diagnostics retained on failure, and
 * — the one that matters most — whether the evidence tells the truth about
 * how deeply each service was verified.
 */

function plan(fixture: ReturnType<typeof setupAutonomyFixture>): EnvironmentPlan {
  return saveEnvironmentPlan(fixture.deps, {
    planId: 'env-steprelay',
    name: 'steprelay-system',
    composeFile: 'docker-compose.yml',
    projectName: 'steprelay-qual',
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
        readinessTimeoutMs: 30_000,
        ports: [5432],
      },
      {
        serviceId: 'kafka',
        kind: 'MESSAGE_BROKER',
        name: 'kafka',
        dependsOn: [],
        probes: [
          {
            kind: 'PROTOCOL_HANDSHAKE',
            host: '127.0.0.1',
            protocol: 'kafka',
            argv: ['kafka-topics', '--list'],
            expectStatus: [200],
            timeoutMs: 5_000,
          },
        ],
        maxRestarts: 2,
        readinessTimeoutMs: 30_000,
        ports: [9092],
      },
      {
        serviceId: 'api',
        kind: 'APPLICATION_SERVER',
        name: 'api',
        dependsOn: ['postgres', 'kafka'],
        probes: [
          {
            kind: 'HTTP_STATUS',
            host: '127.0.0.1',
            port: 8080,
            urlPath: '/health',
            expectStatus: [200],
            argv: [],
            timeoutMs: 5_000,
          },
        ],
        maxRestarts: 2,
        readinessTimeoutMs: 30_000,
        ports: [8080],
      },
    ],
  } as never);
}

function fakeRuntime(overrides: Partial<EnvironmentRuntime> = {}): EnvironmentRuntime {
  return {
    label: 'fake',
    async provision() {
      return { ok: true, detail: 'up' };
    },
    async restart() {
      return { ok: true, detail: 'restarted' };
    },
    async logs() {
      return 'log line 1\nlog line 2\n';
    },
    async teardown() {
      return { ok: true, detail: 'down' };
    },
    ...overrides,
  };
}

/** Probe executor that reports readiness after N attempts per service. */
function probeAfter(attempts: Record<string, number>): ProbeExecutor {
  const seen: Record<string, number> = {};
  return async (probe: ReadinessProbe) => {
    const key = probe.protocol ?? `${probe.host}:${probe.port ?? 0}`;
    seen[key] = (seen[key] ?? 0) + 1;
    const needed = attempts[key] ?? 1;
    return seen[key] >= needed
      ? { ready: true, detail: `${key} answered on attempt ${seen[key]}` }
      : { ready: false, detail: `${key} not ready yet` };
  };
}

const instantSleep = async (): Promise<void> => undefined;

describe('readiness ordering', () => {
  it('orders services so dependencies are probed first', () => {
    const fixture = setupAutonomyFixture();
    const ordered = orderServicesForReadiness(plan(fixture)).map((s) => s.serviceId);
    expect(ordered.indexOf('api')).toBeGreaterThan(ordered.indexOf('postgres'));
    expect(ordered.indexOf('api')).toBeGreaterThan(ordered.indexOf('kafka'));
  });

  it('refuses a cyclic plan rather than breaking the cycle arbitrarily', () => {
    const fixture = setupAutonomyFixture();
    const cyclic = saveEnvironmentPlan(fixture.deps, {
      planId: 'env-cycle',
      name: 'cycle',
      services: [
        {
          serviceId: 'a',
          kind: 'PROCESS',
          name: 'a',
          dependsOn: ['b'],
          probes: [{ kind: 'PROCESS_ALIVE', host: '127.0.0.1', expectStatus: [200], argv: [], timeoutMs: 1_000 }],
          maxRestarts: 0,
          readinessTimeoutMs: 1_000,
          ports: [],
        },
        {
          serviceId: 'b',
          kind: 'PROCESS',
          name: 'b',
          dependsOn: ['a'],
          probes: [{ kind: 'PROCESS_ALIVE', host: '127.0.0.1', expectStatus: [200], argv: [], timeoutMs: 1_000 }],
          maxRestarts: 0,
          readinessTimeoutMs: 1_000,
          ports: [],
        },
      ],
    } as never);
    expect(() => orderServicesForReadiness(cyclic)).toThrowError(/readiness cycle/);
  });
});

describe('provisioning', () => {
  it('reaches READY and records application-level evidence', async () => {
    const fixture = setupAutonomyFixture();
    const definition = plan(fixture);
    const instance = await provisionEnvironment(fixture.deps, {
      planId: definition.planId,
      jobId: 'job-1',
      runtime: fakeRuntime(),
      probeExecutor: probeAfter({}),
      sleep: instantSleep,
      instanceId: 'envi-1',
    });

    expect(instance.status).toBe('READY');
    expect(instance.services.every((s) => s.status === 'READY')).toBe(true);

    const evidence = readEnvironmentEvidence(fixture.workspace, 'envi-1');
    expect(evidence?.applicationLevelReady.sort()).toEqual(['api', 'kafka', 'postgres']);
    expect(evidence?.livenessOnlyReady).toEqual([]);
    expect(evidence?.notReady).toEqual([]);
  });

  it('marks liveness-only readiness as shallow rather than calling it ready', async () => {
    const fixture = setupAutonomyFixture();
    const shallow = saveEnvironmentPlan(fixture.deps, {
      planId: 'env-shallow',
      name: 'shallow',
      services: [
        {
          serviceId: 'worker',
          kind: 'WORKER',
          name: 'worker',
          dependsOn: [],
          probes: [{ kind: 'PROCESS_ALIVE', host: '127.0.0.1', expectStatus: [200], argv: [], timeoutMs: 1_000 }],
          maxRestarts: 0,
          readinessTimeoutMs: 10_000,
          ports: [],
        },
      ],
    } as never);
    const instance = await provisionEnvironment(fixture.deps, {
      planId: shallow.planId,
      runtime: fakeRuntime(),
      probeExecutor: probeAfter({}),
      sleep: instantSleep,
      instanceId: 'envi-shallow',
    });
    expect(instance.status).toBe('READY');
    const evidence = readEnvironmentEvidence(fixture.workspace, 'envi-shallow');
    expect(evidence?.livenessOnlyReady).toEqual(['worker']);
    expect(evidence?.applicationLevelReady).toEqual([]);
  });

  it('tolerates a slow service that answers after several probes', async () => {
    const fixture = setupAutonomyFixture();
    const definition = plan(fixture);
    const instance = await provisionEnvironment(fixture.deps, {
      planId: definition.planId,
      runtime: fakeRuntime(),
      probeExecutor: probeAfter({ postgres: 4, kafka: 2 }),
      sleep: instantSleep,
      instanceId: 'envi-slow',
    });
    expect(instance.status).toBe('READY');
    const postgres = instance.services.find((s) => s.serviceId === 'postgres');
    expect(postgres?.probeAttempts).toBeGreaterThanOrEqual(4);
  });

  it('fails honestly when a service never becomes ready, retaining diagnostics', async () => {
    const fixture = setupAutonomyFixture();
    const definition = plan(fixture);
    const instance = await provisionEnvironment(fixture.deps, {
      planId: definition.planId,
      jobId: 'job-1',
      runtime: fakeRuntime(),
      // Kafka needs more attempts than the ticking clock allows before the
      // 30s readiness deadline: the clock advances 1s per call.
      probeExecutor: probeAfter({ kafka: 10_000 }),
      sleep: instantSleep,
      instanceId: 'envi-fail',
    });

    expect(instance.status).toBe('FAILED');
    expect(instance.failureKind).toBe('READINESS_TIMEOUT');
    expect(instance.diagnosticsRetained).toBe(true);

    const evidence = readEnvironmentEvidence(fixture.workspace, 'envi-fail');
    expect(evidence?.notReady).toContain('kafka');
    expect(evidence?.logRefs.length).toBeGreaterThan(0);
    expect(evidence?.logRefs[0]).toMatch(/^\.specbridge\/autonomy\/environments\/logs\//);
  });

  it('classifies a runtime that will not start at all', async () => {
    const fixture = setupAutonomyFixture();
    const definition = plan(fixture);
    const instance = await provisionEnvironment(fixture.deps, {
      planId: definition.planId,
      runtime: fakeRuntime({
        async provision() {
          return {
            ok: false,
            detail: 'cannot connect to the docker daemon',
            failureKind: 'RUNTIME_UNAVAILABLE',
          };
        },
      }),
      probeExecutor: probeAfter({}),
      sleep: instantSleep,
      instanceId: 'envi-nodocker',
    });
    expect(instance.status).toBe('FAILED');
    expect(instance.failureKind).toBe('RUNTIME_UNAVAILABLE');
  });

  it('refuses to provision when the policy disables environments', async () => {
    const fixture = setupAutonomyFixture({ autonomy: { environments: { enabled: false } } });
    const definition = plan(fixture);
    await expect(
      provisionEnvironment(fixture.deps, {
        planId: definition.planId,
        runtime: fakeRuntime(),
        probeExecutor: probeAfter({}),
        sleep: instantSleep,
      }),
    ).rejects.toThrowError(/SBA016|disabled/);
  });

  it('tears down and records that it did', async () => {
    const fixture = setupAutonomyFixture();
    const definition = plan(fixture);
    await provisionEnvironment(fixture.deps, {
      planId: definition.planId,
      runtime: fakeRuntime(),
      probeExecutor: probeAfter({}),
      sleep: instantSleep,
      instanceId: 'envi-td',
    });
    const stopped = await teardownEnvironment(fixture.deps, {
      instanceId: 'envi-td',
      runtime: fakeRuntime(),
    });
    expect(stopped.status).toBe('STOPPED');
    expect(readEnvironmentInstance(fixture.workspace, 'envi-td')?.status).toBe('STOPPED');
  });

  it('retains a failed environment rather than deleting the evidence', async () => {
    const fixture = setupAutonomyFixture();
    const definition = plan(fixture);
    await provisionEnvironment(fixture.deps, {
      planId: definition.planId,
      runtime: fakeRuntime(),
      probeExecutor: probeAfter({ postgres: 10_000 }),
      sleep: instantSleep,
      instanceId: 'envi-retain',
    });
    let retained: boolean | undefined;
    const stopped = await teardownEnvironment(fixture.deps, {
      instanceId: 'envi-retain',
      runtime: fakeRuntime({
        async teardown(input) {
          retained = input.retain;
          return { ok: true, detail: 'stopped' };
        },
      }),
    });
    expect(retained).toBe(true);
    expect(stopped.diagnosticsRetained).toBe(true);
  });
});

describe('compose plan helper', () => {
  it('defaults an unspecified service to a healthcheck probe, not to liveness', () => {
    const built = composePlanFromServices({
      name: 'demo',
      composeFile: 'docker-compose.yml',
      services: [{ serviceId: 'redis', kind: 'CACHE' }],
    });
    expect(built.services[0]?.probes[0]?.kind).toBe('CONTAINER_HEALTHCHECK');
  });
});
