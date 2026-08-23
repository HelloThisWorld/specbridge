import { describe, expect, it } from 'vitest';
import type { CompletionGate, JobDeps } from '@specbridge/orchestration';
import { assessCompletion, completeJobIfDone, createJob, requireJobState } from '@specbridge/orchestration';
import {
  attributeNodeToItems,
  bindSealToJob,
  buildClosureLedger,
  createClosureCompletionGate,
  hasClosureLedger,
  registerClosureEvidence,
  runClosureAudit,
} from '@specbridge/autonomy';
import { sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * The completion gate.
 *
 * `completeJobIfDone` is the function that actually writes `COMPLETED`.
 * Every other piece of closure machinery can be correct and the product can
 * still be declared finished with unimplemented requirements if that
 * function does not ask — which is exactly what happened in the previous
 * long-horizon dogfood.
 *
 * These tests hold the seam to three properties: it can only refuse, it
 * fails CLOSED (a broken gate means "not yet", never "done"), and an
 * unsealed job completes exactly as it did in v1.2.
 */

function jobFixture(): {
  fixture: ReturnType<typeof setupAutonomyFixture>;
  jobId: string;
  deps: JobDeps;
} {
  const fixture = setupAutonomyFixture({ spec: true });
  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement the sealed product intent.',
  });
  return { fixture, jobId: job.jobId, deps: fixture.deps };
}

describe('assessCompletion', () => {
  it('abstains when there is no gate', () => {
    expect(assessCompletion(undefined, 'job-1')).toBeUndefined();
  });

  it('fails CLOSED when the gate throws', () => {
    const broken: CompletionGate = {
      assess() {
        throw new Error('the ledger is unreadable');
      },
    };
    const assessment = assessCompletion(broken, 'job-1');
    expect(assessment?.mayComplete).toBe(false);
    expect(assessment?.reason).toMatch(/could not be evaluated/);
    // The opposite asymmetry from the authority seam, and deliberately so: a
    // job that stays open is recoverable; one wrongly declared complete is
    // the failure the whole mechanism exists to prevent.
  });
});

describe('closure completion gate', () => {
  it('abstains for a job with no ledger, so v1.2 jobs are unchanged', () => {
    const { fixture, jobId } = jobFixture();
    expect(hasClosureLedger(fixture.workspace, jobId)).toBe(false);
    const gate = createClosureCompletionGate(fixture.workspace);
    expect(gate.assess(jobId).mayComplete).toBe(true);
  });

  it('refuses while sealed items are unclosed', () => {
    const { fixture, jobId } = jobFixture();
    const { seal } = sealedMission(fixture);
    bindSealToJob(fixture.deps, jobId, seal.sealId);
    buildClosureLedger(fixture.deps, { jobId, seal });

    const gate = createClosureCompletionGate(fixture.workspace);
    const assessment = gate.assess(jobId);
    expect(assessment.mayComplete).toBe(false);
    expect(assessment.unclosed).toBeGreaterThan(0);
    expect(assessment.reason).toMatch(/not closed on trusted evidence/);
  });

  it('allows completion once every item closes', () => {
    const { fixture, jobId } = jobFixture();
    const { seal } = sealedMission(fixture);
    bindSealToJob(fixture.deps, jobId, seal.sealId);
    const ledger = buildClosureLedger(fixture.deps, { jobId, seal });

    for (const [index, entry] of ledger.entries.entries()) {
      attributeNodeToItems(fixture.deps, {
        jobId,
        nodeId: `n${index}`,
        taskId: String(index + 1),
        itemIds: [entry.itemId],
      });
      registerClosureEvidence(fixture.deps, {
        jobId,
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
    runClosureAudit(fixture.deps, {
      jobId,
      completedNodeIds: ledger.entries.map((_, index) => `n${index}`),
      implementationComplete: true,
    });

    expect(createClosureCompletionGate(fixture.workspace).assess(jobId).mayComplete).toBe(true);
  });
});

describe('completeJobIfDone under a gate', () => {
  it('refuses unfinished nodes before it ever consults the gate', () => {
    const { fixture, jobId } = jobFixture();
    // No graph revision exists yet, so the v1.2 rule fires first.
    expect(() =>
      completeJobIfDone({ ...fixture.deps, completionGate: neverCompletes() }, jobId),
    ).toThrowError();
  });

  it('a refusing gate moves the job to QUALIFYING rather than erroring', async () => {
    const { fixture, jobId } = jobFixture();
    const { buildJobGraph } = await import('@specbridge/orchestration');
    await buildJobGraph(fixture.deps, jobId);

    // Drive every node to COMPLETED so the v1.2 rule says yes.
    const { readGraphRevision, storeGraphRevision } = await import('@specbridge/orchestration');
    const job = requireJobState(fixture.workspace, jobId);
    const graph = readGraphRevision(fixture.workspace, jobId, job.graphRevision);
    if (graph === undefined) throw new Error('graph missing');
    storeGraphRevision(fixture.workspace, jobId, {
      ...graph,
      revision: graph.revision + 1,
      supersedes: graph.revision,
      nodes: graph.nodes.map((node) => ({ ...node, status: 'COMPLETED' as const })),
    });
    const bumped = requireJobState(fixture.workspace, jobId);
    const { writeJobState } = await import('@specbridge/orchestration');
    writeJobState(fixture.workspace, { ...bumped, graphRevision: graph.revision + 1 });

    const result = completeJobIfDone(
      { ...fixture.deps, completionGate: neverCompletes() },
      jobId,
    );
    // "The task list is finished and the contract is not" is not a failure:
    // it is the moment the closure lifecycle takes over.
    expect(result.status).toBe('QUALIFYING');
    expect(result.closurePhase).toBe('CONTRACT_CLOSURE_AUDIT');
    expect(result.finalizedAt).toBeUndefined();
  });
});

function neverCompletes(): CompletionGate {
  return {
    assess() {
      return { mayComplete: false, reason: '3 sealed contract item(s) are not closed', unclosed: 3 };
    },
  };
}
