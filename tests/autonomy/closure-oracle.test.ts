import { describe, expect, it } from 'vitest';
import { overnightAutonomyPreset } from '@specbridge/core';
import type { ClosureLedger } from '@specbridge/autonomy';
import {
  advanceClosurePhase,
  assertMissionMayComplete,
  attributeNodeToItems,
  buildClosureLedger,
  closureRatio,
  decideClosure,
  generateGapWork,
  listClosureAudits,
  listGapWork,
  missionMayComplete,
  readClosureLedger,
  registerClosureEvidence,
  runClosureAudit,
  summarizeClosure,
  waiveClosureItem,
} from '@specbridge/autonomy';
import { sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * The Contract Closure Oracle.
 *
 * This is the suite that has to hold, because the failure it prevents
 * already happened once: a product declared COMPLETE with seven approved
 * requirements unimplemented, while every task was checked off and the build
 * was green. Every test below is a way that could happen again.
 */

const CLOSURE_POLICY = overnightAutonomyPreset().closure;

function ledgerFor(fixture: ReturnType<typeof setupAutonomyFixture>, jobId = 'job-1') {
  const { seal } = sealedMission(fixture);
  return { seal, ledger: buildClosureLedger(fixture.deps, { jobId, seal }) };
}

describe('closure ledger', () => {
  it('has one entry per sealed requirement, invariant, and acceptance criterion', () => {
    const fixture = setupAutonomyFixture();
    const { seal, ledger } = ledgerFor(fixture);

    const expectedRequirements = seal.contracts.reduce((n, c) => n + c.requirementIds.length, 0);
    const expectedInvariants = seal.contracts.reduce((n, c) => n + c.invariantIds.length, 0);
    expect(ledger.entries.length).toBe(
      expectedRequirements + expectedInvariants + seal.acceptanceCriteria.length,
    );
    expect(ledger.entries.every((entry) => entry.status === 'NOT_STARTED')).toBe(true);
    expect(ledger.phase).toBe('IMPLEMENTATION');
  });

  it('freezes the scenario requirements from the seal', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const systemCriterion = ledger.entries.find((entry) => entry.requiresSystemScenario);
    const browserCriterion = ledger.entries.find((entry) => entry.requiresBrowserScenario);
    expect(systemCriterion).toBeDefined();
    expect(browserCriterion).toBeDefined();
  });
});

describe('per-item closure', () => {
  it('a checked-off task with no evidence is IMPLEMENTED, never VERIFIED', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const item = ledger.entries[0]?.itemId as string;

    attributeNodeToItems(fixture.deps, {
      jobId: 'job-1',
      nodeId: 'n1',
      taskId: '1',
      itemIds: [item],
    });
    const { ledger: audited } = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ['n1'],
      implementationComplete: true,
      auditId: 'ca-1',
    });

    const entry = audited.entries.find((e) => e.itemId === item);
    expect(entry?.status).toBe('IMPLEMENTED');
    expect(entry?.gaps).toContain('NO_EVIDENCE');
  });

  it('an agent assertion closes nothing', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const item = ledger.entries[0]?.itemId as string;

    attributeNodeToItems(fixture.deps, { jobId: 'job-1', nodeId: 'n1', taskId: '1', itemIds: [item] });
    registerClosureEvidence(fixture.deps, {
      jobId: 'job-1',
      itemIds: [item],
      kind: 'AGENT_ASSERTION',
      ref: 'agent-said-done',
      passed: true,
      detail: 'The executor reported the requirement is implemented.',
    });
    const { ledger: audited } = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ['n1'],
      implementationComplete: true,
      auditId: 'ca-2',
    });

    const entry = audited.entries.find((e) => e.itemId === item);
    expect(entry?.status).toBe('IMPLEMENTED');
    expect(entry?.gaps).toContain('EVIDENCE_UNTRUSTED');
  });

  it('trusted verification closes an ordinary requirement', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const item = ledger.entries[0]?.itemId as string;

    attributeNodeToItems(fixture.deps, { jobId: 'job-1', nodeId: 'n1', taskId: '1', itemIds: [item] });
    registerClosureEvidence(fixture.deps, {
      jobId: 'job-1',
      itemIds: [item],
      kind: 'TRUSTED_VERIFICATION',
      ref: 'run-0001',
      passed: true,
      gitHead: 'abc123',
    });
    const { ledger: audited } = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ['n1'],
      implementationComplete: true,
      gitHead: 'abc123',
      auditId: 'ca-3',
    });
    expect(audited.entries.find((e) => e.itemId === item)?.status).toBe('VERIFIED');
  });

  it('evidence captured against a different repository state is stale', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const item = ledger.entries[0]?.itemId as string;

    attributeNodeToItems(fixture.deps, { jobId: 'job-1', nodeId: 'n1', taskId: '1', itemIds: [item] });
    registerClosureEvidence(fixture.deps, {
      jobId: 'job-1',
      itemIds: [item],
      kind: 'TRUSTED_VERIFICATION',
      ref: 'run-0001',
      passed: true,
      gitHead: 'old-head',
    });
    const { ledger: audited } = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ['n1'],
      implementationComplete: true,
      gitHead: 'new-head',
      auditId: 'ca-4',
    });
    const entry = audited.entries.find((e) => e.itemId === item);
    expect(entry?.status).toBe('IMPLEMENTED');
    expect(entry?.gaps).toContain('EVIDENCE_STALE');
  });

  it('a UI acceptance criterion cannot be closed by a unit test', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const uiItem = ledger.entries.find((entry) => entry.requiresBrowserScenario)?.itemId as string;

    attributeNodeToItems(fixture.deps, { jobId: 'job-1', nodeId: 'n2', taskId: '2', itemIds: [uiItem] });
    registerClosureEvidence(fixture.deps, {
      jobId: 'job-1',
      itemIds: [uiItem],
      kind: 'UNIT_TEST',
      ref: 'vitest-dashboard',
      passed: true,
    });
    let audited = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ['n2'],
      implementationComplete: true,
      auditId: 'ca-5',
    }).ledger;
    let entry = audited.entries.find((e) => e.itemId === uiItem);
    expect(entry?.status).toBe('IMPLEMENTED');
    expect(entry?.gaps).toContain('SCENARIO_MISSING');

    // A passing browser scenario is what actually closes it.
    registerClosureEvidence(fixture.deps, {
      jobId: 'job-1',
      itemIds: [uiItem],
      kind: 'BROWSER_SCENARIO',
      ref: 'br-1',
      passed: true,
    });
    audited = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ['n2'],
      implementationComplete: true,
      auditId: 'ca-6',
    }).ledger;
    entry = audited.entries.find((e) => e.itemId === uiItem);
    expect(entry?.status).toBe('VERIFIED');
  });

  it('records failing evidence as a specific gap rather than hiding it', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const item = ledger.entries[0]?.itemId as string;
    attributeNodeToItems(fixture.deps, { jobId: 'job-1', nodeId: 'n1', taskId: '1', itemIds: [item] });
    registerClosureEvidence(fixture.deps, {
      jobId: 'job-1',
      itemIds: [item],
      kind: 'INTEGRATION_TEST',
      ref: 'it-1',
      passed: false,
      detail: 'the redrive path threw',
    });
    const { ledger: audited } = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ['n1'],
      implementationComplete: true,
      auditId: 'ca-7',
    });
    expect(audited.entries.find((e) => e.itemId === item)?.gaps).toContain('EVIDENCE_FAILED');
  });

  it('a human waiver closes an item and nothing else can', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const item = ledger.entries[0]?.itemId as string;
    const waived = waiveClosureItem(fixture.deps, {
      jobId: 'job-1',
      itemId: item,
      reason: 'descoped for v1 by product decision D-004',
      waivedBy: 'operator',
    });
    expect(waived.entries.find((e) => e.itemId === item)?.status).toBe('WAIVED');
  });
});

describe('mission completion authority', () => {
  it('refuses completion while any sealed item is unclosed', () => {
    const fixture = setupAutonomyFixture();
    ledgerFor(fixture);
    expect(() => assertMissionMayComplete(fixture.deps, 'job-1')).toThrowError(
      /not closed on trusted evidence/,
    );
  });

  it('refuses completion for an empty ledger rather than reporting 100%', () => {
    const empty: ClosureLedger = {
      schemaVersion: '1.0.0',
      jobId: 'job-x',
      sealId: 'seal-x',
      missionId: 'm-x',
      createdAt: '2026-08-20T21:00:00.000Z',
      updatedAt: '2026-08-20T21:00:00.000Z',
      phase: 'IMPLEMENTATION',
      entries: [],
      gapCycles: 0,
      systemCycles: 0,
      reproducibilityPassed: false,
      reproducibilityCycles: 0,
      releaseQualificationPassed: false,
      releaseQualificationCycles: 0,
    };
    const verdict = missionMayComplete(empty, CLOSURE_POLICY);
    expect(verdict.mayComplete).toBe(false);
    expect(closureRatio(summarizeClosure([]))).toBeNull();
  });

  it('allows completion only once every item closes', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    for (const [index, entry] of ledger.entries.entries()) {
      attributeNodeToItems(fixture.deps, {
        jobId: 'job-1',
        nodeId: `n${index}`,
        taskId: String(index),
        itemIds: [entry.itemId],
      });
      registerClosureEvidence(fixture.deps, {
        jobId: 'job-1',
        itemIds: [entry.itemId],
        kind: entry.requiresBrowserScenario
          ? 'BROWSER_SCENARIO'
          : entry.requiresSystemScenario
            ? 'SYSTEM_SCENARIO'
            : 'TRUSTED_VERIFICATION',
        ref: `ev-${index}`,
        passed: true,
      });
    }
    const audited = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ledger.entries.map((_, index) => `n${index}`),
      implementationComplete: true,
      auditId: 'ca-final',
    });
    expect(audited.audit.totals.verified).toBe(ledger.entries.length);
    expect(audited.audit.closureRatio).toBe(1);
    // Item closure is necessary, not sufficient: the whole-tree
    // qualifications are part of what "complete" claims.
    expect(() => assertMissionMayComplete(fixture.deps, 'job-1')).toThrowError(
      /release qualification/,
    );
    advanceClosurePhase(fixture.deps, {
      jobId: 'job-1',
      phase: 'RELEASE_QUALIFICATION',
      releaseQualificationPassed: true,
    });
    expect(() => assertMissionMayComplete(fixture.deps, 'job-1')).toThrowError(/reproducibility/);
    advanceClosurePhase(fixture.deps, {
      jobId: 'job-1',
      phase: 'FINAL_CONTRACT_AUDIT',
      reproducibilityPassed: true,
    });
    expect(() => assertMissionMayComplete(fixture.deps, 'job-1')).not.toThrow();
  });

  it('refuses when there is no ledger at all', () => {
    const fixture = setupAutonomyFixture();
    expect(() => assertMissionMayComplete(fixture.deps, 'job-unknown')).toThrowError(
      /no closure ledger/,
    );
  });
});

describe('gap-closure lifecycle', () => {
  it('generates work from unclosed items and returns to implementation', () => {
    const fixture = setupAutonomyFixture();
    ledgerFor(fixture);
    const { audit } = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: [],
      implementationComplete: true,
      auditId: 'ca-gap',
    });
    expect(audit.directive).toBe('GENERATE_GAP_WORK');
    expect(audit.unclosed.length).toBeGreaterThan(0);

    const work = generateGapWork(fixture.deps, { jobId: 'job-1', audit });
    expect(work.length).toBeGreaterThan(0);
    expect(work[0]?.objective).toMatch(/Implement and prove:/);
    expect(listGapWork(fixture.workspace, 'job-1').length).toBe(work.length);
    expect(readClosureLedger(fixture.workspace, 'job-1')?.gapCycles).toBe(1);
  });

  it('asks for the RIGHT kind of evidence for a missing scenario', () => {
    const fixture = setupAutonomyFixture();
    const { ledger } = ledgerFor(fixture);
    const uiItem = ledger.entries.find((entry) => entry.requiresBrowserScenario)?.itemId as string;
    attributeNodeToItems(fixture.deps, { jobId: 'job-1', nodeId: 'n2', taskId: '2', itemIds: [uiItem] });
    registerClosureEvidence(fixture.deps, {
      jobId: 'job-1',
      itemIds: [uiItem],
      kind: 'UNIT_TEST',
      ref: 'ut-1',
      passed: true,
    });
    const { audit } = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: ['n2'],
      implementationComplete: true,
      auditId: 'ca-scenario',
    });
    const work = generateGapWork(fixture.deps, { jobId: 'job-1', audit });
    const uiGap = work.find((item) => item.itemId === uiItem);
    expect(uiGap?.gapKind).toBe('SCENARIO_MISSING');
    expect(uiGap?.closingEvidence).toBe('BROWSER_SCENARIO');
    expect(uiGap?.objective).toMatch(/Build and run the scenario/);
  });

  it('stops regenerating the same work once the cycle budget is spent', () => {
    const fixture = setupAutonomyFixture({ autonomy: { closure: { maxGapClosureCycles: 1 } } });
    ledgerFor(fixture);
    const first = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: [],
      implementationComplete: true,
      auditId: 'ca-b1',
    });
    expect(first.audit.directive).toBe('GENERATE_GAP_WORK');
    generateGapWork(fixture.deps, { jobId: 'job-1', audit: first.audit });

    const second = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: [],
      implementationComplete: true,
      auditId: 'ca-b2',
    });
    expect(second.audit.directive).toBe('BUDGET_EXHAUSTED');
    expect(second.audit.rationale).toMatch(/would not change that/);
  });

  it('keeps implementing while planned work remains', () => {
    const fixture = setupAutonomyFixture();
    ledgerFor(fixture);
    const { audit } = runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: [],
      implementationComplete: false,
      auditId: 'ca-early',
    });
    expect(audit.directive).toBe('CONTINUE_IMPLEMENTATION');
  });

  it('sequences the qualification phases on recorded outcomes, never on visits', () => {
    const base: ClosureLedger = {
      schemaVersion: '1.0.0',
      jobId: 'job-1',
      sealId: 'seal-1',
      missionId: 'm-1',
      createdAt: '2026-08-20T21:00:00.000Z',
      updatedAt: '2026-08-20T21:00:00.000Z',
      phase: 'CONTRACT_CLOSURE_AUDIT',
      entries: [
        {
          itemId: 'AC-001',
          kind: 'acceptance-criterion',
          statement: 'runs end-to-end against docker compose',
          status: 'IMPLEMENTED',
          attributedNodeIds: ['n1'],
          attributedTaskIds: ['1'],
          evidence: [],
          requiresSystemScenario: true,
          requiresBrowserScenario: false,
          gaps: ['SCENARIO_MISSING'],
          updatedAt: '2026-08-20T21:00:00.000Z',
        },
      ],
      gapCycles: 0,
      systemCycles: 0,
      reproducibilityPassed: false,
      reproducibilityCycles: 0,
      releaseQualificationPassed: false,
      releaseQualificationCycles: 0,
    };
    const verified = {
      ...(base.entries[0] as NonNullable<(typeof base.entries)[0]>),
      status: 'VERIFIED' as const,
      gaps: [],
    };

    // A scenario-owned item still open sends the ladder to the scenario
    // phase — however many times the phase was merely ENTERED before.
    const system = decideClosure(base, CLOSURE_POLICY, { implementationComplete: true });
    expect(system.directive).toBe('RUN_SYSTEM_SCENARIOS');
    expect(system.unclosed.map((entry) => entry.itemId)).toEqual(['AC-001']);

    // Executed cycles without evidence exhaust the phase honestly.
    const exhausted = decideClosure(
      { ...base, systemCycles: CLOSURE_POLICY.maxSystemQualificationCycles },
      CLOSURE_POLICY,
      { implementationComplete: true },
    );
    expect(exhausted.directive).toBe('BUDGET_EXHAUSTED');
    expect(exhausted.rationale).toMatch(/executed system-scenario cycle/);

    // Every item closed: the release qualification is gated on ITS recorded
    // pass, not on the ledger having reached some phase.
    const release = decideClosure({ ...base, entries: [verified] }, CLOSURE_POLICY, {
      implementationComplete: true,
    });
    expect(release.directive).toBe('RUN_RELEASE_QUALIFICATION');

    const releaseExhausted = decideClosure(
      {
        ...base,
        entries: [verified],
        releaseQualificationCycles: CLOSURE_POLICY.maxSystemQualificationCycles,
      },
      CLOSURE_POLICY,
      { implementationComplete: true },
    );
    expect(releaseExhausted.directive).toBe('BUDGET_EXHAUSTED');
    expect(releaseExhausted.rationale).toMatch(/release qualification/);

    const reproducibility = decideClosure(
      { ...base, entries: [verified], releaseQualificationPassed: true },
      CLOSURE_POLICY,
      { implementationComplete: true },
    );
    expect(reproducibility.directive).toBe('RUN_REPRODUCIBILITY');

    const done = decideClosure(
      {
        ...base,
        entries: [verified],
        releaseQualificationPassed: true,
        reproducibilityPassed: true,
      },
      CLOSURE_POLICY,
      { implementationComplete: true },
    );
    expect(done.directive).toBe('COMPLETE');
    expect(done.rationale).toMatch(/reproduced from a clean environment/);
  });

  it('routes a failed scenario to repair, and a repaired item back to the scenario', () => {
    const failedRun = {
      kind: 'SYSTEM_SCENARIO' as const,
      ref: 'sr-1',
      passed: false,
      recordedAt: '2026-08-20T22:00:00.000Z',
      detail: 'step "end-to-end" failed',
    };
    const entry = {
      itemId: 'AC-001',
      kind: 'acceptance-criterion' as const,
      statement: 'runs end-to-end against docker compose',
      status: 'IMPLEMENTED' as const,
      attributedNodeIds: ['n1'],
      attributedTaskIds: ['1'],
      evidence: [failedRun],
      requiresSystemScenario: true,
      requiresBrowserScenario: false,
      gaps: ['SCENARIO_FAILED', 'EVIDENCE_FAILED'] as ('SCENARIO_FAILED' | 'EVIDENCE_FAILED')[],
      updatedAt: '2026-08-20T22:00:00.000Z',
    };
    const ledger: ClosureLedger = {
      schemaVersion: '1.0.0',
      jobId: 'job-1',
      sealId: 'seal-1',
      missionId: 'm-1',
      createdAt: '2026-08-20T21:00:00.000Z',
      updatedAt: '2026-08-20T22:00:00.000Z',
      phase: 'SYSTEM_SCENARIO_QUALIFICATION',
      entries: [entry],
      gapCycles: 0,
      systemCycles: 1,
      reproducibilityPassed: false,
      reproducibilityCycles: 0,
      releaseQualificationPassed: false,
      releaseQualificationCycles: 0,
    };

    // Re-running the identical scenario against unrepaired code can only
    // fail identically: the failure goes to the repair loop first.
    const repair = decideClosure(ledger, CLOSURE_POLICY, { implementationComplete: true });
    expect(repair.directive).toBe('GENERATE_GAP_WORK');

    // A repair recorded AFTER the failure routes the item back to the
    // scenario phase — only the scenario can close it.
    const repaired = decideClosure(
      {
        ...ledger,
        entries: [
          {
            ...entry,
            evidence: [
              failedRun,
              {
                kind: 'TRUSTED_VERIFICATION' as const,
                ref: 'gap:g-1',
                passed: true,
                recordedAt: '2026-08-20T23:00:00.000Z',
              },
            ],
          },
        ],
      },
      CLOSURE_POLICY,
      { implementationComplete: true },
    );
    expect(repaired.directive).toBe('RUN_SYSTEM_SCENARIOS');
  });

  it('writes an append-only audit trail', () => {
    const fixture = setupAutonomyFixture();
    ledgerFor(fixture);
    runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: [],
      implementationComplete: true,
      auditId: 'ca-a',
    });
    runClosureAudit(fixture.deps, {
      jobId: 'job-1',
      completedNodeIds: [],
      implementationComplete: true,
      auditId: 'ca-b',
    });
    const audits = listClosureAudits(fixture.workspace, 'job-1');
    expect(audits.map((audit) => audit.auditId)).toEqual(['ca-a', 'ca-b']);
  });
});
