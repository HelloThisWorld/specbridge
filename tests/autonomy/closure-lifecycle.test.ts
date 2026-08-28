import { describe, expect, it } from 'vitest';
import {
  advanceClosurePhase,
  assertMissionMayComplete,
  attributeNodeToItems,
  bindSealToJob,
  buildClosureLedger,
  generateGapWork,
  listClosureAudits,
  readClosureLedger,
  registerClosureEvidence,
  runClosureAudit,
} from '@specbridge/autonomy';
import { createJob } from '@specbridge/orchestration';
import { sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * The closure lifecycle, driven through the service rather than the pure
 * oracle.
 *
 * `closure-oracle.test.ts` proves the decision function is right. This proves
 * the LOOP converges: an audit that finds gaps generates work and returns to
 * implementation, and once every sealed item closes the phases run in order
 * to COMPLETE — with the completion gate refusing at every point before that.
 */

function sealedJob(fixture: ReturnType<typeof setupAutonomyFixture>): {
  jobId: string;
  itemIds: string[];
} {
  const { seal } = sealedMission(fixture);
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement the sealed product intent.',
  });
  bindSealToJob(fixture.deps, job.jobId, seal.sealId);
  const ledger = buildClosureLedger(fixture.deps, { jobId: job.jobId, seal });
  return { jobId: job.jobId, itemIds: ledger.entries.map((entry) => entry.itemId) };
}

/** Close every item on the evidence kind its sealed flags actually require. */
function closeEverything(
  fixture: ReturnType<typeof setupAutonomyFixture>,
  jobId: string,
  options: { scenarios?: boolean } = {},
): string[] {
  const ledger = readClosureLedger(fixture.workspace, jobId);
  const nodeIds: string[] = [];
  for (const [index, entry] of (ledger?.entries ?? []).entries()) {
    const nodeId = `n${index}`;
    nodeIds.push(nodeId);
    attributeNodeToItems(fixture.deps, {
      jobId,
      nodeId,
      taskId: String(index + 1),
      itemIds: [entry.itemId],
    });
    registerClosureEvidence(fixture.deps, {
      jobId,
      itemIds: [entry.itemId],
      kind: 'TRUSTED_VERIFICATION',
      ref: `run-${index}`,
      passed: true,
    });
    if (options.scenarios === false) continue;
    if (entry.requiresSystemScenario) {
      registerClosureEvidence(fixture.deps, {
        jobId,
        itemIds: [entry.itemId],
        kind: 'SYSTEM_SCENARIO',
        ref: `sr-${index}`,
        passed: true,
      });
    }
    if (entry.requiresBrowserScenario) {
      registerClosureEvidence(fixture.deps, {
        jobId,
        itemIds: [entry.itemId],
        kind: 'BROWSER_SCENARIO',
        ref: `br-${index}`,
        passed: true,
      });
    }
  }
  return nodeIds;
}

/** What the scenario EXECUTOR does when its scenarios pass: evidence + cycle. */
function simulateExecutedScenarioCycle(
  fixture: ReturnType<typeof setupAutonomyFixture>,
  jobId: string,
): void {
  const ledger = readClosureLedger(fixture.workspace, jobId);
  for (const [index, entry] of (ledger?.entries ?? []).entries()) {
    if (entry.requiresSystemScenario) {
      registerClosureEvidence(fixture.deps, {
        jobId,
        itemIds: [entry.itemId],
        kind: 'SYSTEM_SCENARIO',
        ref: `sr-${index}`,
        passed: true,
      });
    }
    if (entry.requiresBrowserScenario) {
      registerClosureEvidence(fixture.deps, {
        jobId,
        itemIds: [entry.itemId],
        kind: 'BROWSER_SCENARIO',
        ref: `br-${index}`,
        passed: true,
      });
    }
  }
  advanceClosurePhase(fixture.deps, {
    jobId,
    phase: 'SYSTEM_SCENARIO_QUALIFICATION',
    systemCycle: true,
  });
}

describe('closure lifecycle convergence', () => {
  it('runs the specified phase order and reaches COMPLETE', () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);
    // Scenario-owned items start WITHOUT scenario evidence: producing it is
    // the scenario phase's job, and the sequence below only reaches COMPLETE
    // through what each phase's executor actually records.
    const nodeIds = closeEverything(fixture, jobId, { scenarios: false });

    const directives: string[] = [];
    const phases: string[] = [];

    // The loop the unattended runtime runs, written out so the sequence is
    // visible rather than implied. Each RUN_* directive is answered with
    // exactly the ledger writes its EXECUTOR performs on success — a phase
    // that merely stamped would leave the oracle asking forever.
    for (let cycle = 0; cycle < 8; cycle += 1) {
      const { audit } = runClosureAudit(fixture.deps, {
        jobId,
        completedNodeIds: nodeIds,
        implementationComplete: true,
        auditId: `ca-${cycle}`,
      });
      directives.push(audit.directive);
      phases.push(audit.phase);
      if (audit.directive === 'COMPLETE') break;
      if (audit.directive === 'RUN_SYSTEM_SCENARIOS') {
        simulateExecutedScenarioCycle(fixture, jobId);
        continue;
      }
      if (audit.directive === 'RUN_RELEASE_QUALIFICATION') {
        advanceClosurePhase(fixture.deps, {
          jobId,
          phase: 'RELEASE_QUALIFICATION',
          releaseQualificationCycle: true,
          releaseQualificationPassed: true,
        });
        continue;
      }
      if (audit.directive === 'RUN_REPRODUCIBILITY') {
        advanceClosurePhase(fixture.deps, {
          jobId,
          phase: 'FINAL_CONTRACT_AUDIT',
          reproducibilityCycle: true,
          reproducibilityPassed: true,
        });
        continue;
      }
      throw new Error(`unexpected directive ${audit.directive}`);
    }

    expect(directives).toEqual([
      'RUN_SYSTEM_SCENARIOS',
      'RUN_RELEASE_QUALIFICATION',
      'RUN_REPRODUCIBILITY',
      'COMPLETE',
    ]);
    expect(phases[phases.length - 1]).toBe('COMPLETE');
    expect(() => assertMissionMayComplete(fixture.deps, jobId)).not.toThrow();
  });

  it('refuses completion at every point before COMPLETE', () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);

    // Nothing closed.
    expect(() => assertMissionMayComplete(fixture.deps, jobId)).toThrowError(/not closed/);

    // Everything IMPLEMENTED but nothing verified.
    const ledger = readClosureLedger(fixture.workspace, jobId);
    for (const [index, entry] of (ledger?.entries ?? []).entries()) {
      attributeNodeToItems(fixture.deps, {
        jobId,
        nodeId: `n${index}`,
        taskId: String(index + 1),
        itemIds: [entry.itemId],
      });
    }
    runClosureAudit(fixture.deps, {
      jobId,
      completedNodeIds: (ledger?.entries ?? []).map((_, index) => `n${index}`),
      implementationComplete: true,
      auditId: 'ca-implemented',
    });
    expect(() => assertMissionMayComplete(fixture.deps, jobId)).toThrowError(/not closed/);
  });

  it('a single unclosed item blocks the whole mission', () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);
    const nodeIds = closeEverything(fixture, jobId);

    // Take ONE item's evidence away by registering a failing result over it.
    const first = readClosureLedger(fixture.workspace, jobId)?.entries[0]?.itemId as string;
    registerClosureEvidence(fixture.deps, {
      jobId,
      itemIds: [first],
      kind: 'TRUSTED_VERIFICATION',
      ref: 'run-0',
      passed: false,
      detail: 'the suite regressed',
    });

    const { audit } = runClosureAudit(fixture.deps, {
      jobId,
      completedNodeIds: nodeIds,
      implementationComplete: true,
      auditId: 'ca-regressed',
    });
    expect(audit.directive).toBe('GENERATE_GAP_WORK');
    expect(audit.unclosed.map((entry) => entry.itemId)).toEqual([first]);
    expect(() => assertMissionMayComplete(fixture.deps, jobId)).toThrowError(/1 sealed/);

    const work = generateGapWork(fixture.deps, { jobId, audit });
    expect(work[0]?.gapKind).toBe('EVIDENCE_FAILED');
  });

  it('every audit is retained, so the completion claim stays re-checkable', () => {
    const fixture = setupAutonomyFixture({ spec: true });
    const { jobId } = sealedJob(fixture);
    const nodeIds = closeEverything(fixture, jobId);
    for (const id of ['a', 'b', 'c']) {
      runClosureAudit(fixture.deps, {
        jobId,
        completedNodeIds: nodeIds,
        implementationComplete: true,
        auditId: `ca-${id}`,
      });
    }
    const audits = listClosureAudits(fixture.workspace, jobId);
    expect(audits.map((audit) => audit.auditId)).toEqual(['ca-a', 'ca-b', 'ca-c']);
    // Each one carries the totals it saw, not a pointer to today's ledger.
    expect(audits.every((audit) => audit.totals.total === audits[0]?.totals.total)).toBe(true);
  });
});
