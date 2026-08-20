import { describe, expect, it } from 'vitest';
import type { DecomposerUnit, WorkGraph } from '@specbridge/orchestration';
import {
  WORK_UNIT_STATUSES,
  acceptWorkGraphProposal,
  aggregateStructurally,
  allowedWorkUnitTransitions,
  canWorkUnitTransition,
  promoteReadyUnits,
  reviseWorkGraphSuperseding,
  selectDispatchSet,
  singleUnitGraph,
  transitionUnit,
  validateWorkGraphProposal,
  withUnit,
  requireUnit,
} from '@specbridge/orchestration';

const POLICY = { maxWorkUnits: 12, maxGraphDepth: 4 };
const NODE = {
  nodeId: 'n-1',
  parentTaskId: '1',
  taskFingerprint: 'fp-1',
  title: 'Event-driven execution',
};

function unit(partial: Partial<DecomposerUnit> & { id: string }): DecomposerUnit {
  return {
    kind: 'build',
    title: `Unit ${partial.id}`,
    goal: `Implement unit ${partial.id}.`,
    dependsOn: [],
    expectedArtifacts: [],
    relevantContractIds: [],
    expectedAreas: [],
    ...partial,
  };
}

describe('work graph proposal validation (deterministic)', () => {
  it('accepts a well-formed multi-unit graph with a terminal integration unit', () => {
    const result = validateWorkGraphProposal(
      [
        unit({ id: 'a', relevantContractIds: ['CTR-002'] }),
        unit({ id: 'b', relevantContractIds: ['CTR-003'] }),
        unit({ id: 'i', kind: 'integration', dependsOn: ['a', 'b'] }),
      ],
      POLICY,
    );
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('refuses cycles, unknown dependencies, duplicates, self-loops, and depth violations', () => {
    expect(
      validateWorkGraphProposal([unit({ id: 'a', dependsOn: ['b'] }), unit({ id: 'b', dependsOn: ['a'] })], POLICY)
        .problems.join(' '),
    ).toMatch(/cycle/);
    expect(
      validateWorkGraphProposal([unit({ id: 'a', dependsOn: ['ghost'] })], POLICY).problems.join(' '),
    ).toMatch(/unknown unit/);
    expect(
      validateWorkGraphProposal([unit({ id: 'a' }), unit({ id: 'a' })], POLICY).problems.join(' '),
    ).toMatch(/duplicate/);
    expect(
      validateWorkGraphProposal([unit({ id: 'a', dependsOn: ['a'] })], POLICY).problems.join(' '),
    ).toMatch(/itself/);
    const deep = validateWorkGraphProposal(
      [
        unit({ id: 'a' }),
        unit({ id: 'b', dependsOn: ['a'] }),
        unit({ id: 'c', dependsOn: ['b'] }),
        unit({ id: 'd', dependsOn: ['c'] }),
        unit({ id: 'e', dependsOn: ['d'] }),
      ],
      { maxWorkUnits: 12, maxGraphDepth: 3 },
    );
    expect(deep.problems.join(' ')).toMatch(/depth/);
  });

  it('requires an integration unit when several build units exist, fed by all of them', () => {
    const missing = validateWorkGraphProposal([unit({ id: 'a' }), unit({ id: 'b' })], POLICY);
    expect(missing.problems.join(' ')).toMatch(/integration unit/);

    const orphan = validateWorkGraphProposal(
      [unit({ id: 'a' }), unit({ id: 'b' }), unit({ id: 'i', kind: 'integration', dependsOn: ['a'] })],
      POLICY,
    );
    expect(orphan.problems.join(' ')).toMatch(/does not feed/);

    const nonTerminal = validateWorkGraphProposal(
      [
        unit({ id: 'a' }),
        unit({ id: 'b' }),
        unit({ id: 'i', kind: 'integration', dependsOn: ['a', 'b'] }),
        unit({ id: 'z', dependsOn: ['i'] }),
      ],
      POLICY,
    );
    expect(nonTerminal.problems.join(' ')).toMatch(/terminal/);
  });

  it('enforces the unit-count bound and surfaces shared-contract ownership', () => {
    const oversized = validateWorkGraphProposal(
      Array.from({ length: 13 }, (_, index) => unit({ id: `u${index}` })),
      POLICY,
    );
    expect(oversized.problems.join(' ')).toMatch(/bound is 12/);

    const shared = validateWorkGraphProposal(
      [
        unit({ id: 'a', relevantContractIds: ['CTR-004'] }),
        unit({ id: 'b', relevantContractIds: ['CTR-004'] }),
        unit({ id: 'i', kind: 'integration', dependsOn: ['a', 'b'] }),
      ],
      POLICY,
    );
    expect(shared.ok).toBe(true);
    expect(shared.notes.join(' ')).toMatch(/CTR-004.*never build in parallel/);
  });
});

describe('accepting proposals and the deterministic fallback', () => {
  it('assigns runtime ids, maps dependencies, and marks dependency-free units READY', () => {
    const graph = acceptWorkGraphProposal({
      jobId: 'job-1',
      node: NODE,
      proposal: {
        decision: 'WORK_GRAPH',
        reason: 'protocol and transport are separable',
        units: [
          unit({ id: 'envelope', relevantContractIds: ['CTR-002'] }),
          unit({ id: 'transport', dependsOn: ['envelope'], relevantContractIds: ['CTR-004'] }),
          unit({ id: 'integrate', kind: 'integration', dependsOn: ['envelope', 'transport'] }),
        ],
      },
      proposedBy: 'claude-code',
      policy: POLICY,
      createdAt: '2026-08-10T10:00:00.000Z',
    });
    expect(graph.units.map((entry) => entry.workUnitId)).toEqual(['wu-1', 'wu-2', 'wu-3']);
    expect(graph.units[1]?.dependsOn).toEqual(['wu-1']);
    expect(graph.units[0]?.status).toBe('READY');
    expect(graph.units[1]?.status).toBe('PLANNED');
    expect(graph.objectiveFingerprint).toBe('fp-1');
  });

  it('refuses an invalid proposal instead of repairing it', () => {
    expect(() =>
      acceptWorkGraphProposal({
        jobId: 'job-1',
        node: NODE,
        proposal: {
          decision: 'WORK_GRAPH',
          reason: 'broken',
          units: [unit({ id: 'a', dependsOn: ['ghost'] })],
        },
        proposedBy: 'claude-code',
        policy: POLICY,
        createdAt: '2026-08-10T10:00:00.000Z',
      }),
    ).toThrow(/invalid/);
  });

  it('the deterministic single-unit fallback needs no model at all', () => {
    const graph = singleUnitGraph({
      jobId: 'job-1',
      node: NODE,
      relevantContractIds: ['CTR-001'],
      createdAt: '2026-08-10T10:00:00.000Z',
      reason: 'decomposer unavailable',
    });
    expect(graph.units).toHaveLength(1);
    expect(graph.units[0]?.status).toBe('READY');
    expect(graph.proposedBy).toBe('deterministic');
    expect(graph.units[0]?.relevantContractIds).toEqual(['CTR-001']);
  });
});

describe('work-unit state machine', () => {
  it('INTEGRATED is reachable only from VERIFIED_CANDIDATE', () => {
    for (const from of WORK_UNIT_STATUSES) {
      const allowed = canWorkUnitTransition(from, 'INTEGRATED');
      expect(allowed, from).toBe(from === 'VERIFIED_CANDIDATE');
    }
  });

  it('a unit can never be born verified', () => {
    expect(canWorkUnitTransition('PLANNED', 'VERIFIED_CANDIDATE')).toBe(false);
    expect(canWorkUnitTransition('READY', 'VERIFIED_CANDIDATE')).toBe(false);
  });

  it('final statuses have no exits except FAILED → SUPERSEDED', () => {
    expect(allowedWorkUnitTransitions('INTEGRATED')).toEqual([]);
    expect(allowedWorkUnitTransitions('SUPERSEDED')).toEqual([]);
    expect(allowedWorkUnitTransitions('FAILED')).toEqual(['SUPERSEDED']);
  });
});

function builtGraph(): WorkGraph {
  return acceptWorkGraphProposal({
    jobId: 'job-1',
    node: NODE,
    proposal: {
      decision: 'WORK_GRAPH',
      reason: 'test',
      units: [
        unit({ id: 'a', relevantContractIds: ['CTR-002'], expectedAreas: ['src/envelope'] }),
        unit({ id: 'b', relevantContractIds: ['CTR-003'], expectedAreas: ['src/transport'] }),
        unit({ id: 'c', dependsOn: ['a', 'b'], relevantContractIds: ['CTR-005'] }),
        unit({ id: 'i', kind: 'integration', dependsOn: ['a', 'b', 'c'] }),
      ],
    },
    proposedBy: 'claude-code',
    policy: POLICY,
    createdAt: '2026-08-10T10:00:00.000Z',
  });
}

function verify(graph: WorkGraph, id: string): WorkGraph {
  let next = transitionUnit(graph, id, 'BUILDING');
  next = transitionUnit(next, id, 'CANDIDATE_READY');
  return transitionUnit(next, id, 'VERIFIED_CANDIDATE');
}

describe('promotion, aggregation, supersession', () => {
  it('promotes PLANNED units when every dependency holds a verified candidate', () => {
    let graph = builtGraph();
    expect(requireUnit(graph, 'wu-3').status).toBe('PLANNED');
    graph = verify(graph, 'wu-1');
    graph = promoteReadyUnits(graph);
    expect(requireUnit(graph, 'wu-3').status).toBe('PLANNED');
    graph = verify(graph, 'wu-2');
    graph = promoteReadyUnits(graph);
    expect(requireUnit(graph, 'wu-3').status).toBe('READY');
  });

  it('structural aggregation is deterministic: a failed required unit prevents integration', () => {
    let graph = builtGraph();
    graph = verify(graph, 'wu-1');
    graph = verify(graph, 'wu-2');
    graph = promoteReadyUnits(graph);
    graph = transitionUnit(transitionUnit(graph, 'wu-3', 'BUILDING'), 'wu-3', 'FAILED');
    const aggregation = aggregateStructurally(graph);
    expect(aggregation.integrationReady).toBe(false);
    expect(aggregation.failed).toEqual(['wu-3']);
    expect(aggregation.exhausted).toBe(true);
    expect(aggregation.reasons.join(' ')).toMatch(/failed: wu-3/);
  });

  it('integration readiness requires every required unit verified', () => {
    let graph = builtGraph();
    graph = verify(graph, 'wu-1');
    graph = verify(graph, 'wu-2');
    expect(aggregateStructurally(graph).integrationReady).toBe(false);
    graph = promoteReadyUnits(graph);
    graph = verify(graph, 'wu-3');
    const aggregation = aggregateStructurally(graph);
    expect(aggregation.integrationReady).toBe(true);
    expect(aggregation.verified.sort()).toEqual(['wu-1', 'wu-2', 'wu-3']);
  });

  it('supersession replaces an unfinished unit with lineage; verified work is untouchable', () => {
    let graph = builtGraph();
    graph = transitionUnit(transitionUnit(graph, 'wu-1', 'BUILDING'), 'wu-1', 'FAILED');
    const revised = reviseWorkGraphSuperseding(graph, {
      supersedeWorkUnitId: 'wu-1',
      reason: 'the strategy was invalid',
      createdAt: '2026-08-10T11:00:00.000Z',
    });
    expect(revised.revision).toBe(2);
    expect(requireUnit(revised, 'wu-1').status).toBe('SUPERSEDED');
    expect(requireUnit(revised, 'wu-1').supersededBy).toBe('wu-1-r2');
    expect(requireUnit(revised, 'wu-1-r2').status).toBe('READY');
    expect(requireUnit(revised, 'wu-1-r2').supersedes).toBe('wu-1');

    let verified = builtGraph();
    verified = verify(verified, 'wu-2');
    expect(() =>
      reviseWorkGraphSuperseding(verified, {
        supersedeWorkUnitId: 'wu-2',
        reason: 'no',
        createdAt: '2026-08-10T11:00:00.000Z',
      }),
    ).toThrow(/never superseded/);
  });

  it('a superseded dependency satisfies dependents through its successor', () => {
    let graph = builtGraph();
    graph = transitionUnit(transitionUnit(graph, 'wu-1', 'BUILDING'), 'wu-1', 'FAILED');
    let revised = reviseWorkGraphSuperseding(graph, {
      supersedeWorkUnitId: 'wu-1',
      reason: 'restart',
      createdAt: '2026-08-10T11:00:00.000Z',
    });
    revised = verify(revised, 'wu-1-r2');
    revised = verify(revised, 'wu-2');
    revised = promoteReadyUnits(revised);
    expect(requireUnit(revised, 'wu-3').status).toBe('READY');
  });
});

describe('parallel dispatch-set selection (deterministic, conservative)', () => {
  it('parallelism disabled: exactly the first ready unit', () => {
    const graph = builtGraph();
    const set = selectDispatchSet({
      graph,
      parallelism: { enabled: false, maxConcurrentBuilders: 3 },
      unresolvedDecision: false,
    });
    expect(set.map((entry) => entry.workUnitId)).toEqual(['wu-1']);
  });

  it('enabled: disjoint contracts and areas run together, bounded by maxConcurrentBuilders', () => {
    const graph = builtGraph();
    const set = selectDispatchSet({
      graph,
      parallelism: { enabled: true, maxConcurrentBuilders: 3 },
      unresolvedDecision: false,
    });
    expect(set.map((entry) => entry.workUnitId)).toEqual(['wu-1', 'wu-2']);
  });

  it('an unresolved decision anywhere serializes everything', () => {
    const graph = builtGraph();
    const set = selectDispatchSet({
      graph,
      parallelism: { enabled: true, maxConcurrentBuilders: 3 },
      unresolvedDecision: true,
    });
    expect(set.map((entry) => entry.workUnitId)).toEqual(['wu-1']);
  });

  it('shared contracts serialize; a unit that cannot prove independence runs alone', () => {
    let graph = builtGraph();
    graph = withUnit(graph, { ...requireUnit(graph, 'wu-2'), relevantContractIds: ['CTR-002'], expectedAreas: [] });
    const shared = selectDispatchSet({
      graph,
      parallelism: { enabled: true, maxConcurrentBuilders: 3 },
      unresolvedDecision: false,
    });
    expect(shared.map((entry) => entry.workUnitId)).toEqual(['wu-1']);

    let blank = builtGraph();
    blank = withUnit(blank, { ...requireUnit(blank, 'wu-1'), relevantContractIds: [], expectedAreas: [] });
    const alone = selectDispatchSet({
      graph: blank,
      parallelism: { enabled: true, maxConcurrentBuilders: 3 },
      unresolvedDecision: false,
    });
    expect(alone.map((entry) => entry.workUnitId)).toEqual(['wu-1']);
  });
});
