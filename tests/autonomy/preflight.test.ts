import { describe, expect, it } from 'vitest';
import {
  assertOvernightReady,
  requiredSurfacesFor,
  runOvernightPreflight,
  listPreflightReports,
  readPreflightReport,
} from '@specbridge/autonomy';
import {
  allAvailableProbeRunner,
  fakeProbeRunner,
  sealedMission,
  setupAutonomyFixture,
} from '../helpers-autonomy.js';

/**
 * Overnight preflight.
 *
 * Every probe is injected, so what these tests assert is the CLASSIFICATION
 * — which absences a person has to fix tonight and which the runtime will
 * fix itself — rather than whatever tooling happens to exist on the machine
 * running the suite. That distinction is the whole feature.
 */

describe('overnight preflight', () => {
  it('clears a sealed mission on a fully-provisioned machine', async () => {
    const fixture = setupAutonomyFixture();
    const { seal, missionId } = sealedMission(fixture);
    const report = await runOvernightPreflight(fixture.deps, {
      subject: missionId,
      missionId,
      sealId: seal.sealId,
      probeRunner: allAvailableProbeRunner(),
      requiresContainers: true,
      requiresBrowser: true,
      minFreeDiskBytes: 1,
    });

    expect(report.verdict).toBe('OVERNIGHT_READY');
    expect(report.humanActions).toEqual([]);
    expect(() => assertOvernightReady(report)).not.toThrow();
    expect(readPreflightReport(fixture.deps, report.reportId)?.verdict).toBe('OVERNIGHT_READY');
    expect(listPreflightReports(fixture.deps).length).toBe(1);
  });

  it('treats a missing browser runtime as work, not as a blocker', async () => {
    const fixture = setupAutonomyFixture();
    const { seal, missionId } = sealedMission(fixture);
    const report = await runOvernightPreflight(fixture.deps, {
      subject: missionId,
      missionId,
      sealId: seal.sealId,
      // Docker answers; nothing else is asked about the browser.
      probeRunner: fakeProbeRunner({
        git: { ok: true, output: 'git 2.45' },
        'docker info --format {{.ServerVersion}}': { ok: true, output: '27.0' },
        'docker compose version': { ok: true, output: 'v2.29' },
        pnpm: { ok: true, output: '9.15.9' },
      }),
      requiresContainers: true,
      requiresBrowser: true,
      minFreeDiskBytes: 1,
    });

    const browser = report.checks.find((check) => check.capability === 'BROWSER_RUNTIME');
    expect(browser?.outcome).toBe('SATISFIABLE_AUTONOMOUSLY');
    expect(browser?.satisfiedBy).toBe('BROWSER_RUNTIME');
    expect(report.autonomousActions.join(' ')).toContain('BROWSER_RUNTIME');
    expect(report.verdict).toBe('OVERNIGHT_READY');
  });

  it('refuses to launch when a container runtime the mission needs is down', async () => {
    const fixture = setupAutonomyFixture();
    const { seal, missionId } = sealedMission(fixture);
    const report = await runOvernightPreflight(fixture.deps, {
      subject: missionId,
      missionId,
      sealId: seal.sealId,
      probeRunner: fakeProbeRunner({
        git: { ok: true, output: 'git 2.45' },
        docker: { ok: true, output: 'Docker version 27.0' },
        pnpm: { ok: true, output: '9.15.9' },
      }),
      requiresContainers: true,
      minFreeDiskBytes: 1,
    });

    const runtime = report.checks.find((check) => check.capability === 'CONTAINER_RUNTIME');
    expect(runtime?.outcome).toBe('HUMAN_REQUIRED');
    expect(runtime?.observed).toMatch(/daemon did not answer/);
    expect(report.verdict).toBe('HUMAN_ACTION_REQUIRED');
    expect(() => assertOvernightReady(report)).toThrowError(/SBA011|prerequisite/i);
  });

  it('refuses an unsealed mission: delegated authority is granted, never assumed', async () => {
    const fixture = setupAutonomyFixture();
    const report = await runOvernightPreflight(fixture.deps, {
      subject: 'no-such-mission',
      probeRunner: allAvailableProbeRunner(),
      minFreeDiskBytes: 1,
    });
    const seal = report.checks.find((check) => check.capability === 'SEAL_PRESENT');
    expect(seal?.outcome).toBe('HUMAN_REQUIRED');
    expect(report.verdict).toBe('HUMAN_ACTION_REQUIRED');
  });

  it('refuses when no trusted verification command exists', async () => {
    const fixture = setupAutonomyFixture({ verificationCommands: [] });
    const { seal, missionId } = sealedMission(fixture);
    const report = await runOvernightPreflight(fixture.deps, {
      subject: missionId,
      sealId: seal.sealId,
      probeRunner: allAvailableProbeRunner(),
      minFreeDiskBytes: 1,
    });
    const verification = report.checks.find(
      (check) => check.capability === 'TRUSTED_VERIFICATION_CONFIGURED',
    );
    expect(verification?.outcome).toBe('HUMAN_REQUIRED');
    expect(verification?.remediation.join(' ')).toMatch(/COMPLETED/);
  });

  it('refuses an interactive policy for an unattended launch', async () => {
    const fixture = setupAutonomyFixture({ interactive: true });
    const report = await runOvernightPreflight(fixture.deps, {
      subject: 'anything',
      probeRunner: allAvailableProbeRunner(),
      minFreeDiskBytes: 1,
    });
    const policy = report.checks.find((check) => check.capability === 'AUTONOMY_POLICY_COMPLETE');
    expect(policy?.outcome).toBe('HUMAN_REQUIRED');
    const supervisor = report.checks.find((check) => check.capability === 'SUPERVISOR_CAPABLE');
    expect(supervisor?.outcome).toBe('HUMAN_REQUIRED');
  });

  it('is INDETERMINATE rather than optimistic when a probe cannot decide', async () => {
    const fixture = setupAutonomyFixture();
    const { seal, missionId } = sealedMission(fixture);
    const report = await runOvernightPreflight(fixture.deps, {
      subject: missionId,
      sealId: seal.sealId,
      // A package manager the project declares but that does not answer, with
      // PROJECT_LOCAL_TOOLCHAIN granted: the manager is satisfiable, but
      // registry reachability genuinely cannot be established.
      probeRunner: fakeProbeRunner({ git: { ok: true, output: 'git 2.45' } }),
      minFreeDiskBytes: 1,
    });
    const registry = report.checks.find(
      (check) => check.capability === 'PACKAGE_REGISTRY_REACHABLE',
    );
    expect(registry?.outcome).toBe('UNKNOWN');
    expect(report.unknowns.length).toBeGreaterThan(0);
    expect(report.verdict).toBe('INDETERMINATE');
    expect(() => assertOvernightReady(report)).toThrowError(/could not establish/i);
  });

  it('marks surfaces the mission does not need as not applicable', async () => {
    const fixture = setupAutonomyFixture();
    const { seal, missionId } = sealedMission(fixture);
    const report = await runOvernightPreflight(fixture.deps, {
      subject: missionId,
      sealId: seal.sealId,
      probeRunner: allAvailableProbeRunner(),
      requiresContainers: false,
      requiresBrowser: false,
      minFreeDiskBytes: 1,
    });
    expect(report.checks.find((c) => c.capability === 'CONTAINER_RUNTIME')?.outcome).toBe(
      'NOT_APPLICABLE',
    );
    expect(report.checks.find((c) => c.capability === 'BROWSER_RUNTIME')?.outcome).toBe(
      'NOT_APPLICABLE',
    );
  });

  it('derives the surfaces a mission needs from its sealed criteria', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    expect(requiredSurfacesFor(seal)).toEqual({ requiresContainers: true, requiresBrowser: true });
    expect(requiredSurfacesFor(undefined)).toEqual({
      requiresContainers: false,
      requiresBrowser: false,
    });
  });

  it('never reports a credential value, only whether something is configured', async () => {
    const fixture = setupAutonomyFixture();
    const { seal, missionId } = sealedMission(fixture);
    const report = await runOvernightPreflight(fixture.deps, {
      subject: missionId,
      sealId: seal.sealId,
      probeRunner: allAvailableProbeRunner(),
      minFreeDiskBytes: 1,
    });
    const serialized = JSON.stringify(report).toLowerCase();
    for (const forbidden of ['api_key', 'apikey', 'token=', 'secret', 'password', 'bearer ']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});
