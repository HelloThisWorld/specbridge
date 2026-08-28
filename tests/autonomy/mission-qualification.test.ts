import { describe, expect, it } from 'vitest';
import {
  bindSealToJob,
  buildClosureLedger,
  ensureSystemScenarios,
  listSystemScenarios,
  readClosureLedger,
  runGapRepairs,
  runReleaseQualificationPhase,
  runReproducibilityPhase,
  runSystemScenarioPhase,
} from '@specbridge/autonomy';
import { createJob } from '@specbridge/orchestration';
import { sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * The mission-qualification EXECUTORS.
 *
 * Defect 39 of the vNext.10.1 dogfood: the closure ladder's qualification
 * phases were stamps — counters moved, nothing ran, and a COMPLETED job
 * carried `reproducibilityPassed: false`. These tests hold the executors to
 * the rule that replaced that: every recorded cycle is an EXECUTED cycle,
 * and every flag on the ledger was set by the code path that earned it.
 */

function sealedJob(fixture: ReturnType<typeof setupAutonomyFixture>): { jobId: string } {
  const { seal } = sealedMission(fixture);
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement the sealed product intent.',
  });
  bindSealToJob(fixture.deps, job.jobId, seal.sealId);
  buildClosureLedger(fixture.deps, { jobId: job.jobId, seal });
  return { jobId: job.jobId };
}

describe('system scenario synthesis', () => {
  it('synthesizes a default scenario from the trusted verification commands', () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);

    const { scenarios, uncovered } = ensureSystemScenarios(fixture.deps, { jobId });
    expect(uncovered).toEqual([]);
    expect(scenarios).toHaveLength(1);
    const scenario = scenarios[0];
    expect(scenario?.scenarioId).toBe(`ss-default-${jobId}`);
    // Steps ARE the trusted commands — synthesis composes, it never invents.
    expect(scenario?.steps.map((step) => step.name)).toEqual(['unit-tests']);
    // It covers every open scenario-owned ledger item.
    const ledger = readClosureLedger(fixture.workspace, jobId);
    const owned = (ledger?.entries ?? [])
      .filter((entry) => entry.requiresSystemScenario || entry.requiresBrowserScenario)
      .map((entry) => entry.itemId);
    expect(owned.length).toBeGreaterThan(0);
    expect([...(scenario?.itemIds ?? [])].sort()).toEqual([...owned].sort());
  });

  it('is idempotent: a second pass rewrites the same record', () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);
    ensureSystemScenarios(fixture.deps, { jobId });
    ensureSystemScenarios(fixture.deps, { jobId });
    expect(listSystemScenarios(fixture.workspace)).toHaveLength(1);
  });

  it('reports items uncovered when there is nothing to synthesize from', () => {
    const fixture = setupAutonomyFixture({ spec: true, verificationCommands: [] });
    const { jobId } = sealedJob(fixture);
    const { scenarios, uncovered } = ensureSystemScenarios(fixture.deps, { jobId });
    expect(scenarios).toEqual([]);
    expect(uncovered.length).toBeGreaterThan(0);
  });
});

describe('system scenario phase', () => {
  it('executes the scenarios, registers evidence, and counts the executed cycle', async () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);

    const result = await runSystemScenarioPhase(fixture.deps, {
      jobId,
      commandRunner: async () => ({ ok: true, detail: 'exited 0' }),
    });
    expect(result.executed).toBe(1);
    expect(result.passed).toBe(1);

    const ledger = readClosureLedger(fixture.workspace, jobId);
    expect(ledger?.systemCycles).toBe(1);
    const systemOwned = (ledger?.entries ?? []).filter((entry) => entry.requiresSystemScenario);
    expect(systemOwned.length).toBeGreaterThan(0);
    for (const entry of systemOwned) {
      expect(
        entry.evidence.some((ref) => ref.kind === 'SYSTEM_SCENARIO' && ref.passed),
      ).toBe(true);
    }
  });

  it('records a FAILED run as failing evidence, never as silence', async () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);

    const result = await runSystemScenarioPhase(fixture.deps, {
      jobId,
      commandRunner: async () => ({ ok: false, detail: 'exit 1: 3 tests failed' }),
    });
    expect(result.failed).toBe(1);

    const ledger = readClosureLedger(fixture.workspace, jobId);
    expect(ledger?.systemCycles).toBe(1);
    const owned = (ledger?.entries ?? []).find((entry) => entry.requiresSystemScenario);
    expect(owned?.evidence.some((ref) => ref.kind === 'SYSTEM_SCENARIO' && !ref.passed)).toBe(true);
  });

  it('a cycle in which nothing could run still counts, so the bound can end it', async () => {
    const fixture = setupAutonomyFixture({ spec: true, verificationCommands: [] });
    const { jobId } = sealedJob(fixture);
    const result = await runSystemScenarioPhase(fixture.deps, { jobId });
    expect(result.executed).toBe(0);
    expect(result.uncovered.length).toBeGreaterThan(0);
    expect(readClosureLedger(fixture.workspace, jobId)?.systemCycles).toBe(1);
  });
});

describe('release qualification phase', () => {
  it('a passing suite sets the flag the gate reads, and counts the cycle', async () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);

    const result = await runReleaseQualificationPhase(fixture.deps, { jobId });
    expect(result.passed).toBe(true);

    const ledger = readClosureLedger(fixture.workspace, jobId);
    expect(ledger?.releaseQualificationPassed).toBe(true);
    expect(ledger?.releaseQualificationCycles).toBe(1);
  });

  it('a failing suite leaves the flag down', async () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);

    const result = await runReleaseQualificationPhase(fixture.deps, {
      jobId,
      verify: async () => ({ passed: false, requiredFailed: ['unit-tests'] }),
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/unit-tests/);

    const ledger = readClosureLedger(fixture.workspace, jobId);
    expect(ledger?.releaseQualificationPassed).toBe(false);
    expect(ledger?.releaseQualificationCycles).toBe(1);
  });

  it('no configured commands is a refusal with a named remedy, not a pass', async () => {
    const fixture = setupAutonomyFixture({ spec: true, verificationCommands: [] });
    const { jobId } = sealedJob(fixture);
    const result = await runReleaseQualificationPhase(fixture.deps, { jobId });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/no trusted verification commands/);
    expect(readClosureLedger(fixture.workspace, jobId)?.releaseQualificationPassed).toBe(false);
  });
});

describe('reproducibility phase', () => {
  it('a clean-checkout PASS is the only thing that flips reproducibilityPassed', async () => {
    const fixture = setupAutonomyFixture({ spec: true, git: true });
    const { jobId } = sealedJob(fixture);

    const result = await runReproducibilityPhase(fixture.deps, {
      jobId,
      commandRunner: async () => ({ outcome: 'PASSED', detail: 'exited 0' }),
    });
    expect(result.status).toBe('PASSED');

    const ledger = readClosureLedger(fixture.workspace, jobId);
    expect(ledger?.reproducibilityPassed).toBe(true);
    expect(ledger?.reproducibilityCycles).toBe(1);
  });

  it('an UNAVAILABLE step makes the run INCONCLUSIVE, and the flag stays down', async () => {
    const fixture = setupAutonomyFixture({ spec: true, git: true });
    const { jobId } = sealedJob(fixture);

    const result = await runReproducibilityPhase(fixture.deps, {
      jobId,
      commandRunner: async () => ({
        outcome: 'UNAVAILABLE',
        detail: 'gradle is not installed here',
      }),
    });
    expect(result.status).toBe('INCONCLUSIVE');

    const ledger = readClosureLedger(fixture.workspace, jobId);
    expect(ledger?.reproducibilityPassed).toBe(false);
    expect(ledger?.reproducibilityCycles).toBe(1);
  });

  it('a workspace that is not a git repository reports INCONCLUSIVE honestly', async () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);
    const result = await runReproducibilityPhase(fixture.deps, { jobId });
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.detail).toMatch(/clean checkout could not be created/);
    expect(readClosureLedger(fixture.workspace, jobId)?.reproducibilityPassed).toBe(false);
  });
});

describe('gap repair execution', () => {
  it('an unavailable repair worker is an accounted failure, never silent and never evidence', async () => {
    const fixture = setupAutonomyFixture({ spec: true, git: true });
    const { jobId } = sealedJob(fixture);
    const itemId = readClosureLedger(fixture.workspace, jobId)?.entries[0]?.itemId as string;

    const result = await runGapRepairs(fixture.deps, {
      jobId,
      items: [
        {
          gapId: 'gap-test-1',
          itemId,
          gapKind: 'NO_EVIDENCE',
          objective: 'Produce trusted evidence for: the first sealed requirement.',
          closingEvidence: 'TRUSTED_VERIFICATION',
          createdAt: '2026-08-20T21:00:00.000Z',
          auditId: 'ca-test',
        },
      ],
    });
    expect(result.repaired).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toMatch(/repair builder unavailable/);

    // No evidence appeared: a failed repair proves nothing about the item.
    const entry = readClosureLedger(fixture.workspace, jobId)?.entries.find(
      (candidate) => candidate.itemId === itemId,
    );
    expect(entry?.evidence.some((ref) => ref.ref === 'gap:gap-test-1')).toBe(false);
  });
});
