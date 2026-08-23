import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  BrowserDriver,
  BrowserObservation,
  BrowserScenario,
  BrowserSession,
  BrowserStep,
  BrowserStepOutcome,
} from '@specbridge/autonomy';
import {
  createPlaywrightDriver,
  critiqueEffect,
  isClosingBrowserResult,
  listBrowserResults,
  normalizeSeverity,
  readCritique,
  recordCritique,
  runBrowserScenario,
  runResponsiveMatrix,
  saveBrowserScenario,
} from '@specbridge/autonomy';
import { setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * Browser evidence and the UX critic.
 *
 * The driver is injected, so these tests assert the EVIDENCE MODEL: what
 * counts as proof, what a skip means, what a critique may cause. The real
 * Playwright driver is exercised only for its availability contract, because
 * a suite that downloaded three browsers to assert a schema would be a poor
 * trade for everyone who ever runs it.
 */

interface FakeDriverOptions {
  available?: { ok: true } | { ok: false; reason: string };
  /** Step kinds that should report failure. */
  failing?: readonly string[];
  observations?: readonly BrowserObservation[];
}

function fakeDriver(options: FakeDriverOptions = {}): BrowserDriver {
  const observations = [...(options.observations ?? [])];
  return {
    label: 'fake-browser',
    async available() {
      return options.available ?? { ok: true };
    },
    async open(): Promise<BrowserSession> {
      return {
        async step(step: BrowserStep): Promise<BrowserStepOutcome> {
          if ((options.failing ?? []).includes(step.kind)) {
            return { ok: false, detail: `${step.kind} did not hold` };
          }
          if (step.kind === 'SCREENSHOT') {
            return {
              ok: true,
              detail: 'captured',
              evidence: { kind: 'SCREENSHOT', label: step.label ?? 'shot', data: Buffer.from('png') },
            };
          }
          return { ok: true, detail: `${step.kind} ok` };
        },
        observations: () => observations,
        async snapshot() {
          return '<html><body>snapshot</body></html>';
        },
        async close() {
          return undefined;
        },
      };
    },
  };
}

function scenario(fixture: ReturnType<typeof setupAutonomyFixture>): BrowserScenario {
  return saveBrowserScenario(fixture.deps, {
    scenarioId: 'bs-dashboard',
    name: 'dashboard-multi-user',
    intent: 'Two players and a spectator see the same execution transition.',
    baseUrl: 'http://127.0.0.1:5173',
    contexts: ['player-a', 'player-b', 'spectator'],
    criterionIds: ['AC-002'],
    contractIds: ['CTR-001'],
    steps: [
      { kind: 'NAVIGATE', context: 'player-a', url: '/executions', expectStatus: [] },
      { kind: 'NAVIGATE', context: 'player-b', url: '/executions' },
      { kind: 'NAVIGATE', context: 'spectator', url: '/executions' },
      { kind: 'CLICK', context: 'player-a', selector: '[data-test=trigger]' },
      { kind: 'WAIT_FOR_SELECTOR', context: 'player-b', selector: '[data-test=execution-row]' },
      { kind: 'EXPECT_SELECTOR', context: 'player-b', selector: '[data-test=execution-row]' },
      { kind: 'EXPECT_TEXT', context: 'spectator', value: 'RUNNING' },
      { kind: 'SCREENSHOT', context: 'spectator', label: 'history' },
      { kind: 'EXPECT_NO_CONSOLE_ERRORS', context: 'player-a' },
    ],
  } as never);
}

describe('browser scenarios', () => {
  it('refuses a scenario that asserts nothing', () => {
    const fixture = setupAutonomyFixture();
    expect(() =>
      saveBrowserScenario(fixture.deps, {
        name: 'no-assertions',
        intent: 'navigate and hope',
        baseUrl: 'http://127.0.0.1:5173',
        contexts: ['default'],
        steps: [{ kind: 'NAVIGATE', context: 'default', url: '/' }],
      } as never),
    ).toThrowError(/at least one assertion/);
  });

  it('refuses a step naming a context the scenario never declared', () => {
    const fixture = setupAutonomyFixture();
    expect(() =>
      saveBrowserScenario(fixture.deps, {
        name: 'ghost-context',
        intent: 'x',
        baseUrl: 'http://127.0.0.1:5173',
        contexts: ['default'],
        steps: [
          { kind: 'NAVIGATE', context: 'default', url: '/' },
          { kind: 'EXPECT_SELECTOR', context: 'player-z', selector: 'body' },
        ],
      } as never),
    ).toThrowError(/does not declare/);
  });

  it('passes and produces closing evidence with real assertions', async () => {
    const fixture = setupAutonomyFixture();
    scenario(fixture);
    const result = await runBrowserScenario(fixture.deps, {
      scenarioId: 'bs-dashboard',
      jobId: 'job-1',
      driver: fakeDriver(),
      resultId: 'br-1',
    });

    expect(result.status).toBe('PASSED');
    expect(result.assertionsRun).toBe(3);
    expect(result.assertionsPassed).toBe(3);
    expect(isClosingBrowserResult(result)).toBe(true);
    expect(result.evidence.some((entry) => entry.kind === 'SCREENSHOT')).toBe(true);
    expect(
      existsSync(path.join(fixture.root, '.specbridge', 'autonomy', 'browser', 'evidence', 'br-1')),
    ).toBe(true);
  });

  it('stops at the first failed assertion and captures the DOM at that moment', async () => {
    const fixture = setupAutonomyFixture();
    scenario(fixture);
    const result = await runBrowserScenario(fixture.deps, {
      scenarioId: 'bs-dashboard',
      driver: fakeDriver({ failing: ['EXPECT_SELECTOR'] }),
      resultId: 'br-fail',
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureDetail).toMatch(/EXPECT_SELECTOR/);
    expect(isClosingBrowserResult(result)).toBe(false);
    // Steps after the failing assertion did not run.
    expect(result.steps.length).toBe(6);
    expect(result.evidence.some((entry) => entry.kind === 'DOM_SNAPSHOT')).toBe(true);
  });

  it('records a missing runtime as a skip with a reason, never as a pass', async () => {
    const fixture = setupAutonomyFixture();
    scenario(fixture);
    const result = await runBrowserScenario(fixture.deps, {
      scenarioId: 'bs-dashboard',
      driver: fakeDriver({ available: { ok: false, reason: 'playwright is not installed' } }),
      resultId: 'br-skip',
    });

    expect(result.status).toBe('SKIPPED_NO_RUNTIME');
    expect(result.skipReason).toMatch(/not installed/);
    expect(result.assertionsRun).toBe(0);
    expect(isClosingBrowserResult(result)).toBe(false);
  });

  it('captures console and network observations as evidence', async () => {
    const fixture = setupAutonomyFixture();
    scenario(fixture);
    const result = await runBrowserScenario(fixture.deps, {
      scenarioId: 'bs-dashboard',
      driver: fakeDriver({
        observations: [
          {
            context: 'player-a',
            kind: 'request-failed',
            detail: 'GET /api/executions: net::ERR_CONNECTION_REFUSED',
            at: '2026-08-20T22:00:00.000Z',
          },
        ],
      }),
      resultId: 'br-obs',
    });
    expect(result.observations.length).toBe(1);
    expect(result.evidence.some((entry) => entry.kind === 'CONSOLE_LOG')).toBe(true);
  });

  it('refuses more contexts than policy allows', async () => {
    const fixture = setupAutonomyFixture({ autonomy: { browser: { maxContexts: 2 } } });
    scenario(fixture);
    await expect(
      runBrowserScenario(fixture.deps, { scenarioId: 'bs-dashboard', driver: fakeDriver() }),
    ).rejects.toThrowError(/maxContexts|contexts/);
  });

  it('produces one result per viewport in the responsive matrix', async () => {
    const fixture = setupAutonomyFixture();
    scenario(fixture);
    const results = await runResponsiveMatrix(fixture.deps, {
      scenarioId: 'bs-dashboard',
      driver: fakeDriver(),
      resultId: 'br-matrix',
    });
    expect(results.length).toBe(2);
    expect(new Set(results.map((r) => r.resultId)).size).toBe(2);
    expect(listBrowserResults(fixture.workspace).length).toBe(2);
  });

  it('refuses to run when browser verification is disabled', async () => {
    const fixture = setupAutonomyFixture({ autonomy: { browser: { enabled: false } } });
    scenario(fixture);
    await expect(
      runBrowserScenario(fixture.deps, { scenarioId: 'bs-dashboard', driver: fakeDriver() }),
    ).rejects.toThrowError(/SBA018|disabled/);
  });

  it('the real Playwright driver reports absence rather than throwing', async () => {
    const availability = await createPlaywrightDriver().available();
    // Whether Playwright is installed on this machine is not the assertion.
    // The contract is: it answers, and when it cannot run it says why.
    if (!availability.ok) expect(availability.reason.length).toBeGreaterThan(0);
    else expect(availability.ok).toBe(true);
  });
});

describe('ux critic', () => {
  async function passingResult(fixture: ReturnType<typeof setupAutonomyFixture>) {
    scenario(fixture);
    return runBrowserScenario(fixture.deps, {
      scenarioId: 'bs-dashboard',
      driver: fakeDriver(),
      resultId: 'br-ok',
    });
  }

  it('demotes aesthetic preference to cosmetic whatever the critic claimed', () => {
    expect(normalizeSeverity('AESTHETIC_PREFERENCE', 'MATERIAL')).toBe('COSMETIC');
    expect(normalizeSeverity('OVERLAPPING_ELEMENTS', 'MATERIAL')).toBe('MATERIAL');
  });

  it('generates repair work from a material finding on a passing scenario', async () => {
    const fixture = setupAutonomyFixture();
    const result = await passingResult(fixture);
    const critique = recordCritique(fixture.deps, {
      result,
      producedBy: 'test-critic',
      jobId: 'job-1',
      critiqueId: 'ux-1',
      findings: [
        {
          kind: 'OVERLAPPING_ELEMENTS',
          severity: 'MATERIAL',
          statement: 'The execution detail modal renders behind the header at 1280x800.',
          locus: '[data-test=execution-modal]',
        },
      ],
    });

    expect(critique.verdict).toBe('MATERIAL_FINDINGS');
    expect(critique.advisoryOnly).toBe(false);
    const effect = critiqueEffect(critique, result);
    expect(effect.requiresRepair).toBe(true);
    expect(effect.materialFindings.length).toBe(1);
  });

  it('cannot generate work from taste alone', async () => {
    const fixture = setupAutonomyFixture();
    const result = await passingResult(fixture);
    const critique = recordCritique(fixture.deps, {
      result,
      producedBy: 'test-critic',
      findings: [
        {
          kind: 'AESTHETIC_PREFERENCE',
          severity: 'MATERIAL',
          statement: 'The spacing feels cramped and the palette is dated.',
        },
      ],
    });
    expect(critique.findings[0]?.severity).toBe('COSMETIC');
    expect(critique.verdict).toBe('NO_MATERIAL_FINDINGS');
    expect(critiqueEffect(critique, result).requiresRepair).toBe(false);
  });

  it('never overrides a deterministic failure', async () => {
    const fixture = setupAutonomyFixture();
    scenario(fixture);
    const failed = await runBrowserScenario(fixture.deps, {
      scenarioId: 'bs-dashboard',
      driver: fakeDriver({ failing: ['EXPECT_SELECTOR'] }),
      resultId: 'br-det-fail',
    });
    const critique = recordCritique(fixture.deps, {
      result: failed,
      producedBy: 'over-eager-critic',
      findings: [
        { kind: 'INCONSISTENT_UX', severity: 'MINOR', statement: 'Looks fine to me, ship it.' },
      ],
    });
    // The critique is recorded, is advisory, and changes nothing about the
    // failed result. There is no path from a critique to a passing scenario.
    expect(critique.advisoryOnly).toBe(true);
    expect(failed.status).toBe('FAILED');
    const effect = critiqueEffect(critique, failed);
    expect(effect.requiresRepair).toBe(false);
    expect(effect.reason).toMatch(/already failed deterministically/);
  });

  it('stops creating work once its repair budget is spent', async () => {
    const fixture = setupAutonomyFixture({ autonomy: { critic: { maxCriticRepairCycles: 1 } } });
    const result = await passingResult(fixture);
    const material = [
      { kind: 'CLIPPED_CONTENT' as const, severity: 'MATERIAL' as const, statement: 'Submit is off-screen.' },
    ];

    const first = recordCritique(fixture.deps, {
      result,
      producedBy: 'critic',
      findings: material,
      repairCycle: 0,
      critiqueId: 'ux-c1',
    });
    expect(critiqueEffect(first, result).requiresRepair).toBe(true);

    const second = recordCritique(fixture.deps, {
      result,
      producedBy: 'critic',
      findings: material,
      repairCycle: 1,
      critiqueId: 'ux-c2',
    });
    expect(second.advisoryOnly).toBe(true);
    expect(critiqueEffect(second, result).requiresRepair).toBe(false);
    expect(readCritique(fixture.workspace, 'ux-c2')?.verdict).toBe('MATERIAL_FINDINGS');
  });

  it('is advisory in ADVISORY mode however material the finding', async () => {
    const fixture = setupAutonomyFixture({ autonomy: { critic: { mode: 'ADVISORY' } } });
    const result = await passingResult(fixture);
    const critique = recordCritique(fixture.deps, {
      result,
      producedBy: 'critic',
      findings: [
        { kind: 'DEAD_INTERACTION', severity: 'MATERIAL', statement: 'The retry button does nothing.' },
      ],
    });
    expect(critique.advisoryOnly).toBe(true);
    expect(critiqueEffect(critique, result).requiresRepair).toBe(false);
  });

  it('records INSUFFICIENT_EVIDENCE rather than guessing', async () => {
    const fixture = setupAutonomyFixture();
    const result = await passingResult(fixture);
    const critique = recordCritique(fixture.deps, {
      result,
      producedBy: 'critic',
      findings: [],
      insufficientReason: 'no screenshots were captured for the mobile viewport',
    });
    expect(critique.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(critiqueEffect(critique, result).requiresRepair).toBe(false);
  });
});
