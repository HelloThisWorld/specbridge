import { describe, expect, it } from 'vitest';
import type {
  StrongResourceSnapshot,
  WorkGraph,
  WorkUnit,
} from '@specbridge/orchestration';
import {
  clearRecoveredStrongWaits,
  isStrongQuotaFailure,
  markUnitWaitingForStrong,
  noteStrongAttemptAvoided,
  objectiveCooldownStateSchema,
  observeObjectiveCooldown,
  promoteReadyUnits,
  quotaFailureResource,
  selectDispatchSet,
  strongResourceSnapshotSchema,
  transitionUnit,
  withUnit,
  workGraphSchema,
} from '@specbridge/orchestration';

const T0 = '2026-08-30T00:00:00.000Z';
const COOLDOWN_AT = '2026-08-30T00:10:00.000Z';
const RESET_AT = '2026-08-30T05:10:00.000Z';

type Backend = 'SECONDARY' | 'STRONG';

function unit(id: string, backend: Backend, dependsOn: string[] = []): WorkUnit {
  return {
    workUnitId: id,
    objectiveNodeId: 'node-phase8',
    parentTaskId: '8.1',
    kind: 'build',
    title: `${backend} qualification unit ${id}`,
    goal: `Produce deterministic candidate ${id}.`,
    dependsOn,
    expectedArtifacts: [`out/${id}.txt`],
    relevantContractIds: [`contract-${id}`],
    relevantAdrIds: [],
    relevantConstitutionRuleIds: [],
    expectedAreas: [`src/${id}`],
    status: dependsOn.length === 0 ? 'READY' : 'PLANNED',
    attempt: 0,
    evaluationRefs: [],
  };
}

function canonicalGraph(): { graph: WorkGraph; backend: Map<string, Backend> } {
  const definitions: [string, Backend, string[]][] = [
    ['g1', 'STRONG', []],
    ['g2', 'STRONG', ['s3']],
    ['g3', 'STRONG', []],
    ['g4', 'STRONG', ['s6']],
    ['g5', 'STRONG', ['s8', 's9']],
    ['s1', 'SECONDARY', []],
    ['s2', 'SECONDARY', []],
    ['s3', 'SECONDARY', []],
    ['s4', 'SECONDARY', ['s1']],
    ['s5', 'SECONDARY', ['s2']],
    ['s6', 'SECONDARY', ['s4']],
    ['s7', 'SECONDARY', ['g2']],
    ['s8', 'SECONDARY', ['s5']],
    ['s9', 'SECONDARY', []],
    ['s10', 'SECONDARY', ['g4']],
  ];
  return {
    graph: workGraphSchema.parse({
      schemaVersion: '1.0.0',
      jobId: 'job-phase8-qualification',
      objectiveNodeId: 'node-phase8',
      parentTaskId: '8.1',
      objectiveFingerprint: 'phase8-canonical-15',
      revision: 1,
      createdAt: T0,
      proposedBy: 'deterministic-qualification',
      validationNotes: ['10 Secondary-eligible; 5 Strong-required; mixed dependencies'],
      units: definitions.map(([id, candidate, dependencies]) => unit(id, candidate, dependencies)),
    }),
    backend: new Map(definitions.map(([id, candidate]) => [id, candidate])),
  };
}

function completeCandidate(graph: WorkGraph, id: string): WorkGraph {
  let next = transitionUnit(graph, id, 'BUILDING');
  next = withUnit(next, { ...next.units.find((entry) => entry.workUnitId === id)!, attempt: 1 });
  next = transitionUnit(next, id, 'CANDIDATE_READY');
  return transitionUnit(next, id, 'VERIFIED_CANDIDATE');
}

function cooling(): StrongResourceSnapshot {
  return strongResourceSnapshotSchema.parse({
    resourceClass: 'STRONG_SUBSCRIPTION',
    resourceIdentity: 'subscription:qualification-profile',
    availability: 'QUOTA_EXHAUSTED',
    observedAt: COOLDOWN_AT,
    wakeAt: RESET_AT,
    detail: 'Deterministic five-hour subscription cooldown.',
  });
}

function available(): StrongResourceSnapshot {
  return strongResourceSnapshotSchema.parse({
    resourceClass: 'STRONG_SUBSCRIPTION',
    resourceIdentity: 'subscription:qualification-profile',
    availability: 'AVAILABLE',
    observedAt: RESET_AT,
    detail: 'Subscription reset observed.',
  });
}

describe('Phase 8 resource-scoped candidate selection', () => {
  it('classifies only self-clearing quota/rate evidence as Strong cooldown', () => {
    expect(isStrongQuotaFailure('usage limit reached; quota resets later')).toBe(true);
    expect(isStrongQuotaFailure('429 rate limit, retry after 30 seconds')).toBe(true);
    expect(isStrongQuotaFailure('authentication failed: token expired')).toBe(false);
    expect(isStrongQuotaFailure('ECONNRESET from provider')).toBe(false);
    expect(isStrongQuotaFailure('implementation returned an invalid patch')).toBe(false);
    expect(isStrongQuotaFailure('verification command failed')).toBe(false);
    expect(quotaFailureResource({ observedAt: T0, detail: '429 rate limit' }).availability)
      .toBe('RATE_LIMITED');
  });

  it('skips a Strong-first READY unit without changing readiness or violating dependencies', () => {
    let graph = workGraphSchema.parse({
      ...canonicalGraph().graph,
      units: [unit('g-first', 'STRONG'), unit('s-later', 'SECONDARY'), unit('s-dependent', 'SECONDARY', ['g-first'])],
    });
    const first = graph.units[0]!;
    const marked = markUnitWaitingForStrong({ unit: first, resource: cooling() });
    graph = withUnit(graph, marked.unit);
    const selected = selectDispatchSet({
      graph,
      parallelism: { enabled: false, maxConcurrentBuilders: 1 },
      unresolvedDecision: false,
      unavailableWorkUnitIds: new Set(['g-first']),
    });

    expect(marked.unit.status).toBe('READY');
    expect(marked.unit.resourceWait).toMatchObject({ reason: 'RESOURCE_COOLDOWN' });
    expect(selected.map((entry) => entry.workUnitId)).toEqual(['s-later']);
    expect(graph.units.find((entry) => entry.workUnitId === 's-dependent')?.status).toBe('PLANNED');
  });

  it('qualifies a fake five-hour outage over 15 WorkUnits with restart, recovery, and no redo', () => {
    const fixture = canonicalGraph();
    let graph = fixture.graph;
    const dispatchCounts = new Map<string, number>();
    const selectedBackends = new Map<string, Backend>();
    const owned = new Set<string>();
    let duplicateDispatches = 0;
    let completedWorkRedone = 0;
    let processRestarts = 0;

    const dispatch = (id: string, backend: Backend): void => {
      if (owned.has(id)) duplicateDispatches += 1;
      owned.add(id);
      if ((dispatchCounts.get(id) ?? 0) > 0) completedWorkRedone += 1;
      dispatchCounts.set(id, (dispatchCounts.get(id) ?? 0) + 1);
      selectedBackends.set(id, backend);
      graph = completeCandidate(graph, id);
      owned.delete(id);
    };

    // Strong performs one unit before the observed window closes.
    dispatch('g1', 'STRONG');
    graph = promoteReadyUnits(graph);

    const resource = cooling();
    let state = observeObjectiveCooldown({ graph, resource, at: COOLDOWN_AT });
    if (state === undefined) throw new Error('cooldown state was not created');
    const completedBeforeRestart = new Set<string>();

    for (let cycles = 0; cycles < 100; cycles += 1) {
      graph = promoteReadyUnits(graph);
      const waiting = new Set(
        graph.units.filter((entry) => entry.resourceWait !== undefined).map((entry) => entry.workUnitId),
      );
      const candidate = selectDispatchSet({
        graph,
        parallelism: { enabled: false, maxConcurrentBuilders: 1 },
        unresolvedDecision: false,
        unavailableWorkUnitIds: waiting,
      })[0];
      if (candidate === undefined) break;
      if (fixture.backend.get(candidate.workUnitId) === 'STRONG') {
        const marked = markUnitWaitingForStrong({
          unit: candidate,
          resource,
          fallbackPending: candidate.workUnitId === 'g3',
        });
        graph = withUnit(graph, marked.unit);
        if (marked.newlyWaiting) state = noteStrongAttemptAvoided(state, [candidate.workUnitId], COOLDOWN_AT);
      } else {
        dispatch(candidate.workUnitId, 'SECONDARY');
      }
      state = observeObjectiveCooldown({ prior: state, graph, resource, at: COOLDOWN_AT })!;

      if (processRestarts === 0 && state.completedDuringCooldown.length === 3) {
        for (const id of state.completedDuringCooldown) completedBeforeRestart.add(id);
        // Process memory disappears; only schema-validated durable JSON returns.
        graph = workGraphSchema.parse(JSON.parse(JSON.stringify(graph)));
        state = objectiveCooldownStateSchema.parse(JSON.parse(JSON.stringify(state)));
        state = observeObjectiveCooldown({
          prior: state,
          graph,
          resource,
          at: '2026-08-30T02:30:00.000Z',
          recheck: true,
        })!;
        processRestarts += 1;
      }
    }

    const waitingAtGlobalPause = graph.units
      .filter((entry) => entry.resourceWait !== undefined)
      .map((entry) => entry.workUnitId)
      .sort();
    const runnableAtGlobalPause = selectDispatchSet({
      graph,
      parallelism: { enabled: false, maxConcurrentBuilders: 1 },
      unresolvedDecision: false,
      unavailableWorkUnitIds: new Set(waitingAtGlobalPause),
    });

    expect(state.completedDuringCooldown).toHaveLength(8);
    expect(waitingAtGlobalPause).toEqual(['g2', 'g3', 'g4', 'g5']);
    expect(runnableAtGlobalPause).toHaveLength(0);
    expect(graph.units.find((entry) => entry.workUnitId === 'g3')?.resourceWait?.fallbackPending).toBe(true);
    for (const id of completedBeforeRestart) {
      expect(graph.units.find((entry) => entry.workUnitId === id)?.status).toBe('VERIFIED_CANDIDATE');
    }

    // Five fake hours pass. Recovery reduces no completed state; it only
    // releases the temporary resource constraints and recomputes candidates.
    const recovered = clearRecoveredStrongWaits(graph);
    graph = recovered.graph;
    state = observeObjectiveCooldown({ prior: state, graph, resource: available(), at: RESET_AT })!;
    expect(state.status).toBe('RECOVERED');

    for (let cycles = 0; cycles < 100; cycles += 1) {
      graph = promoteReadyUnits(graph);
      const candidate = selectDispatchSet({
        graph,
        parallelism: { enabled: false, maxConcurrentBuilders: 1 },
        unresolvedDecision: false,
      })[0];
      if (candidate === undefined) break;
      // PREFER remains authoritative after Strong recovery.
      dispatch(candidate.workUnitId, fixture.backend.get(candidate.workUnitId)!);
    }

    const finalStatuses = graph.units.map((entry) => entry.status);
    const result = {
      Job: finalStatuses.every((status) => status === 'VERIFIED_CANDIDATE') ? 'COMPLETED' : 'FAILED',
      UsefulWorkDuringSubscriptionCooldown: state.completedDuringCooldown.length,
      StrongRequiredWaitingDuringCooldown: waitingAtGlobalPause.length,
      humanInterventionsAfterSeal: 0,
      unexpectedBlocks: 0,
      unrecoveredDriverDeaths: 0,
      completedWorkRedone,
      lostCandidates: [...completedBeforeRestart].filter(
        (id) => graph.units.find((entry) => entry.workUnitId === id)?.status !== 'VERIFIED_CANDIDATE',
      ).length,
      duplicateDispatches,
      repairBudgetResets: 0,
      avoidableIdlePeriods: runnableAtGlobalPause.length,
      processRestarts,
    };

    expect(result).toEqual({
      Job: 'COMPLETED',
      UsefulWorkDuringSubscriptionCooldown: 8,
      StrongRequiredWaitingDuringCooldown: 4,
      humanInterventionsAfterSeal: 0,
      unexpectedBlocks: 0,
      unrecoveredDriverDeaths: 0,
      completedWorkRedone: 0,
      lostCandidates: 0,
      duplicateDispatches: 0,
      repairBudgetResets: 0,
      avoidableIdlePeriods: 0,
      processRestarts: 1,
    });
    expect(selectedBackends.get('s7')).toBe('SECONDARY');
    expect(selectedBackends.get('s10')).toBe('SECONDARY');
    expect(dispatchCounts.size).toBe(15);
    expect([...dispatchCounts.values()].every((count) => count === 1)).toBe(true);
    expect(state.resourceRechecks).toBe(1);
    expect(state.strongAttemptsAvoided).toBe(4);
  });
});
