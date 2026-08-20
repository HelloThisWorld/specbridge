import type { ObjectivesPolicy } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import type { JobNode } from '../jobs/state.js';
import type { DecomposerOutput, DecomposerUnit } from './contracts.js';
import type { WorkGraph, WorkUnit } from './state.js';
import { WORK_GRAPH_SCHEMA_VERSION, workGraphSchema } from './state.js';
import { assertWorkUnitTransition } from './state-machine.js';
import type { WorkUnitStatus } from './vocabulary.js';
import { isFinalWorkUnitStatus } from './vocabulary.js';

/**
 * The dynamic work graph of one approved objective.
 *
 * The DECOMPOSER (a model) PROPOSES a graph; this module VALIDATES it
 * deterministically and owns every subsequent operation. The model never
 * owns concurrency, ordering, or scope authority:
 *
 *   - all work stays inside the approved objective (units are internal
 *     decomposition, not new scope; scope screens live in evaluation.ts)
 *   - the dependency graph must be acyclic and bounded (count and depth)
 *   - when more than one build unit exists, a terminal integration unit is
 *     required and every build unit must feed into it
 *   - two build units independently declaring the same authoritative
 *     contract are surfaced (parallel dispatch will serialize them)
 *   - unsafe or malformed proposals are refused, never repaired silently
 */

export interface WorkGraphValidationResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/** Deterministic validation of a decomposer proposal. Pure. */
export function validateWorkGraphProposal(
  units: readonly DecomposerUnit[],
  policy: Pick<ObjectivesPolicy, 'maxWorkUnits' | 'maxGraphDepth'>,
): WorkGraphValidationResult {
  const problems: string[] = [];
  const notes: string[] = [];

  if (units.length === 0) {
    return { ok: false, problems: ['the proposal contains no work units'], notes };
  }
  if (units.length > policy.maxWorkUnits) {
    problems.push(`the proposal has ${units.length} units; the bound is ${policy.maxWorkUnits}`);
  }

  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.id)) problems.push(`duplicate unit id "${unit.id}"`);
    ids.add(unit.id);
  }
  for (const unit of units) {
    for (const dependency of unit.dependsOn) {
      if (!ids.has(dependency)) {
        problems.push(`unit "${unit.id}" depends on unknown unit "${dependency}"`);
      }
      if (dependency === unit.id) {
        problems.push(`unit "${unit.id}" depends on itself`);
      }
    }
  }

  // Cycle + depth check via DFS with memoized depth.
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  let cyclic = false;
  const depthOf = (id: string): number => {
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) {
      cyclic = true;
      return 0;
    }
    visiting.add(id);
    const unit = byId.get(id);
    const parentDepth =
      unit === undefined || unit.dependsOn.length === 0
        ? 0
        : Math.max(...unit.dependsOn.map((dependency) => depthOf(dependency))) + 1;
    visiting.delete(id);
    depth.set(id, parentDepth);
    return parentDepth;
  };
  for (const unit of units) depthOf(unit.id);
  if (cyclic) problems.push('the dependency graph contains a cycle');
  const maxDepth = Math.max(0, ...[...depth.values()]);
  if (maxDepth + 1 > policy.maxGraphDepth) {
    problems.push(`the dependency chain depth ${maxDepth + 1} exceeds the bound ${policy.maxGraphDepth}`);
  }

  // Integration requirement: >1 build unit needs a terminal integration
  // unit that (transitively) depends on every build unit.
  const buildUnits = units.filter((unit) => unit.kind === 'build');
  const integrationUnits = units.filter((unit) => unit.kind === 'integration');
  if (integrationUnits.length > 1) {
    problems.push('at most one integration unit is allowed');
  }
  if (buildUnits.length > 1) {
    if (integrationUnits.length === 0) {
      problems.push('multiple build units require a terminal integration unit');
    } else {
      const integration = integrationUnits[0]!;
      const reachable = new Set<string>();
      const walk = (id: string): void => {
        if (reachable.has(id)) return;
        reachable.add(id);
        for (const dependency of byId.get(id)?.dependsOn ?? []) walk(dependency);
      };
      walk(integration.id);
      for (const build of buildUnits) {
        if (!reachable.has(build.id)) {
          problems.push(`build unit "${build.id}" does not feed into the integration unit`);
        }
      }
      const dependents = units.filter((unit) => unit.dependsOn.includes(integration.id));
      if (dependents.length > 0) {
        problems.push('the integration unit must be terminal (nothing may depend on it)');
      }
    }
  }
  if (integrationUnits.length === 1 && buildUnits.length <= 1) {
    notes.push('an integration unit with at most one build unit is redundant but allowed');
  }

  // Contract-ownership surfacing: two build units both naming the same
  // contract will be serialized by the dispatch-set selection; recorded
  // here so the audit trail shows the constraint was seen at validation.
  const contractOwners = new Map<string, string[]>();
  for (const unit of buildUnits) {
    for (const contractId of unit.relevantContractIds) {
      contractOwners.set(contractId, [...(contractOwners.get(contractId) ?? []), unit.id]);
    }
  }
  for (const [contractId, owners] of contractOwners) {
    if (owners.length > 1) {
      notes.push(`contract ${contractId} is relevant to units ${owners.join(', ')}: they will never build in parallel`);
    }
  }

  return { ok: problems.length === 0, problems, notes };
}

// ---------------------------------------------------------------------------
// Building graphs
// ---------------------------------------------------------------------------

function realUnitId(index: number): string {
  return `wu-${index + 1}`;
}

export interface AcceptProposalInput {
  jobId: string;
  node: Pick<JobNode, 'nodeId' | 'parentTaskId' | 'taskFingerprint'>;
  proposal: DecomposerOutput;
  proposedBy: string;
  policy: Pick<ObjectivesPolicy, 'maxWorkUnits' | 'maxGraphDepth'>;
  createdAt: string;
}

/**
 * Turn a VALIDATED decomposer proposal into work graph revision 1. Ids are
 * assigned here — proposal-local ids never persist — and every unit starts
 * PLANNED/READY by dependency shape.
 */
export function acceptWorkGraphProposal(input: AcceptProposalInput): WorkGraph {
  const validation = validateWorkGraphProposal(input.proposal.units, input.policy);
  if (!validation.ok) {
    throw new OrchestrationError(
      'SBO039',
      `The proposed work graph is invalid: ${validation.problems.join('; ')}.`,
      { details: { problems: validation.problems } },
    );
  }
  const idMap = new Map<string, string>();
  input.proposal.units.forEach((unit, index) => idMap.set(unit.id, realUnitId(index)));

  const units: WorkUnit[] = input.proposal.units.map((unit, index) => {
    const dependsOn = unit.dependsOn.map((dependency) => idMap.get(dependency) ?? dependency);
    return {
      workUnitId: realUnitId(index),
      objectiveNodeId: input.node.nodeId,
      parentTaskId: input.node.parentTaskId,
      kind: unit.kind,
      title: unit.title,
      goal: unit.goal,
      dependsOn,
      expectedArtifacts: unit.expectedArtifacts,
      relevantContractIds: unit.relevantContractIds,
      relevantAdrIds: [],
      relevantConstitutionRuleIds: [],
      expectedAreas: unit.expectedAreas,
      status: (dependsOn.length === 0 ? 'READY' : 'PLANNED') as WorkUnitStatus,
      attempt: 0,
      evaluationRefs: [],
    };
  });

  return workGraphSchema.parse({
    schemaVersion: WORK_GRAPH_SCHEMA_VERSION,
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    parentTaskId: input.node.parentTaskId,
    objectiveFingerprint: input.node.taskFingerprint,
    revision: 1,
    createdAt: input.createdAt,
    proposedBy: input.proposedBy,
    validationNotes: validation.notes,
    units,
  });
}

/**
 * The deterministic fallback when no decomposer runs (or its proposal was
 * refused): the whole objective as one build unit. Decomposition is an
 * optimization; the objective pipeline must never depend on a model to make
 * progress.
 */
export function singleUnitGraph(input: {
  jobId: string;
  node: Pick<JobNode, 'nodeId' | 'parentTaskId' | 'taskFingerprint' | 'title'>;
  relevantContractIds: readonly string[];
  createdAt: string;
  reason: string;
}): WorkGraph {
  return workGraphSchema.parse({
    schemaVersion: WORK_GRAPH_SCHEMA_VERSION,
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    parentTaskId: input.node.parentTaskId,
    objectiveFingerprint: input.node.taskFingerprint,
    revision: 1,
    createdAt: input.createdAt,
    proposedBy: 'deterministic',
    validationNotes: [input.reason.slice(0, 500)],
    units: [
      {
        workUnitId: 'wu-1',
        objectiveNodeId: input.node.nodeId,
        parentTaskId: input.node.parentTaskId,
        kind: 'build',
        title: input.node.title.slice(0, 2_000),
        goal: `Implement the approved objective in full: ${input.node.title}`.slice(0, 2_000),
        dependsOn: [],
        expectedArtifacts: [],
        relevantContractIds: [...input.relevantContractIds].slice(0, 30),
        relevantAdrIds: [],
        relevantConstitutionRuleIds: [],
        expectedAreas: [],
        status: 'READY',
        attempt: 0,
        evaluationRefs: [],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Pure graph operations
// ---------------------------------------------------------------------------

export function findUnit(graph: WorkGraph, workUnitId: string): WorkUnit | undefined {
  return graph.units.find((unit) => unit.workUnitId === workUnitId);
}

export function requireUnit(graph: WorkGraph, workUnitId: string): WorkUnit {
  const unit = findUnit(graph, workUnitId);
  if (unit === undefined) {
    throw new OrchestrationError('SBO040', `Work unit "${workUnitId}" does not exist in revision ${graph.revision}.`);
  }
  return unit;
}

export function withUnit(graph: WorkGraph, updated: WorkUnit): WorkGraph {
  return {
    ...graph,
    units: graph.units.map((unit) => (unit.workUnitId === updated.workUnitId ? updated : unit)),
  };
}

export function transitionUnit(graph: WorkGraph, workUnitId: string, to: WorkUnitStatus): WorkGraph {
  const unit = requireUnit(graph, workUnitId);
  assertWorkUnitTransition(workUnitId, unit.status, to);
  return withUnit(graph, { ...unit, status: to });
}

/** A dependency is satisfied when it (or its successor chain) is verified or integrated. */
function dependencySatisfied(graph: WorkGraph, workUnitId: string, seen: Set<string> = new Set()): boolean {
  if (seen.has(workUnitId)) return false;
  seen.add(workUnitId);
  const unit = findUnit(graph, workUnitId);
  if (unit === undefined) return false;
  if (unit.status === 'VERIFIED_CANDIDATE' || unit.status === 'INTEGRATED') return true;
  if (unit.status === 'SUPERSEDED' && unit.supersededBy !== undefined) {
    return dependencySatisfied(graph, unit.supersededBy, seen);
  }
  return false;
}

/** Recompute PLANNED → READY promotions. Pure. */
export function promoteReadyUnits(graph: WorkGraph): WorkGraph {
  return {
    ...graph,
    units: graph.units.map((unit) => {
      if (unit.status !== 'PLANNED') return unit;
      const ready = unit.dependsOn.every((dependency) => dependencySatisfied(graph, dependency));
      return ready ? { ...unit, status: 'READY' as WorkUnitStatus } : unit;
    }),
  };
}

/** Non-integration units that still need work, in graph order. */
export function readyUnits(graph: WorkGraph): WorkUnit[] {
  return graph.units.filter((unit) => unit.status === 'READY' && unit.kind !== 'integration');
}

export function unfinishedUnits(graph: WorkGraph): WorkUnit[] {
  return graph.units.filter(
    (unit) => !isFinalWorkUnitStatus(unit.status) && unit.status !== 'VERIFIED_CANDIDATE',
  );
}

/**
 * Runtime replanning within the approved objective: replace one unfinished
 * unit with a fresh successor (same goal by default, or a revised one) in
 * the NEXT graph revision. Completed candidates are never superseded, and a
 * revision can never change WHICH objective is being implemented.
 */
export function reviseWorkGraphSuperseding(
  graph: WorkGraph,
  input: {
    supersedeWorkUnitId: string;
    reason: string;
    createdAt: string;
    revisedGoal?: string | undefined;
  },
): WorkGraph {
  const unit = requireUnit(graph, input.supersedeWorkUnitId);
  if (unit.status === 'INTEGRATED' || unit.status === 'VERIFIED_CANDIDATE') {
    throw new OrchestrationError(
      'SBO039',
      `Work unit ${unit.workUnitId} is ${unit.status}; verified work is never superseded.`,
    );
  }
  if (unit.status === 'SUPERSEDED') {
    throw new OrchestrationError('SBO039', `Work unit ${unit.workUnitId} is already superseded.`);
  }
  const base = unit.workUnitId.replace(/-r\d+$/, '');
  let counter = 2;
  const ids = new Set(graph.units.map((candidate) => candidate.workUnitId));
  while (ids.has(`${base}-r${counter}`)) counter += 1;
  const successorId = `${base}-r${counter}`;

  const successor: WorkUnit = {
    ...unit,
    workUnitId: successorId,
    status: 'READY',
    attempt: 0,
    goal: input.revisedGoal !== undefined ? input.revisedGoal.slice(0, 2_000) : unit.goal,
    supersedes: unit.workUnitId,
    evaluationRefs: [],
  };
  delete (successor as Partial<WorkUnit>).workerId;
  delete (successor as Partial<WorkUnit>).contextProjectionHash;
  delete (successor as Partial<WorkUnit>).contractSnapshotHash;
  delete (successor as Partial<WorkUnit>).candidateRef;
  delete (successor as Partial<WorkUnit>).latestFailure;
  delete (successor as Partial<WorkUnit>).supersededBy;
  delete (successor as Partial<WorkUnit>).integratedAt;

  const units = graph.units.map((candidate) =>
    candidate.workUnitId === unit.workUnitId
      ? { ...candidate, status: 'SUPERSEDED' as WorkUnitStatus, supersededBy: successorId }
      : candidate,
  );
  return workGraphSchema.parse({
    ...graph,
    revision: graph.revision + 1,
    createdAt: input.createdAt,
    units: [...units, successor],
    supersedes: graph.revision,
    revisionReason: input.reason.slice(0, 2_000),
  });
}

// ---------------------------------------------------------------------------
// Structural aggregation (deterministic)
// ---------------------------------------------------------------------------

export interface StructuralAggregation {
  /** True when every required unit is VERIFIED_CANDIDATE (or INTEGRATED). */
  integrationReady: boolean;
  /** True when no unit can make further progress and the objective failed. */
  exhausted: boolean;
  verified: string[];
  pending: string[];
  failed: string[];
  blocked: string[];
  reasons: string[];
}

/**
 * The deterministic aggregation stage: no model, ever. Integration is ready
 * exactly when every non-integration, non-superseded unit reached
 * VERIFIED_CANDIDATE; a FAILED or BLOCKED required unit makes the objective
 * structurally unable to integrate.
 */
export function aggregateStructurally(graph: WorkGraph): StructuralAggregation {
  const verified: string[] = [];
  const pending: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];
  for (const unit of graph.units) {
    if (unit.kind === 'integration' || unit.status === 'SUPERSEDED') continue;
    switch (unit.status) {
      case 'VERIFIED_CANDIDATE':
      case 'INTEGRATED':
        verified.push(unit.workUnitId);
        break;
      case 'FAILED':
        failed.push(unit.workUnitId);
        break;
      case 'BLOCKED':
        blocked.push(unit.workUnitId);
        break;
      default:
        pending.push(unit.workUnitId);
    }
  }
  const reasons: string[] = [];
  if (failed.length > 0) reasons.push(`required unit(s) failed: ${failed.join(', ')}`);
  if (blocked.length > 0) reasons.push(`required unit(s) blocked: ${blocked.join(', ')}`);
  if (pending.length > 0) reasons.push(`unit(s) still in progress: ${pending.join(', ')}`);
  const integrationReady = failed.length === 0 && blocked.length === 0 && pending.length === 0 && verified.length > 0;
  if (integrationReady) reasons.push('every required work unit holds a verified candidate');
  return {
    integrationReady,
    exhausted: failed.length > 0 && pending.length === 0,
    verified,
    pending,
    failed,
    blocked,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Parallel dispatch-set selection (deterministic)
// ---------------------------------------------------------------------------

export interface DispatchSetInput {
  graph: WorkGraph;
  parallelism: { enabled: boolean; maxConcurrentBuilders: number };
  /** True when an unresolved NEEDS_DECISION / conflict exists right now. */
  unresolvedDecision: boolean;
}

/**
 * Which READY units may build CONCURRENTLY. Deterministic and conservative:
 *
 *   - parallelism disabled → exactly the first ready unit
 *   - an unresolved decision anywhere → serialize
 *   - candidates must have pairwise-disjoint relevantContractIds (two units
 *     independently working against the same authoritative contract never
 *     run together) and pairwise-disjoint declared expectedAreas
 *   - a unit with NO declared contracts or areas cannot prove independence
 *     from anything → it runs alone
 *
 * When uncertain: serialize — never guess parallel.
 */
export function selectDispatchSet(input: DispatchSetInput): WorkUnit[] {
  const ready = readyUnits(input.graph);
  if (ready.length === 0) return [];
  const first = ready[0]!;
  if (!input.parallelism.enabled || input.unresolvedDecision) return [first];

  const selected: WorkUnit[] = [first];
  const claimedContracts = new Set(first.relevantContractIds);
  const claimedAreas = new Set(first.expectedAreas);
  const provable = (unit: WorkUnit): boolean =>
    unit.relevantContractIds.length > 0 || unit.expectedAreas.length > 0;
  if (!provable(first)) return [first];

  for (const candidate of ready.slice(1)) {
    if (selected.length >= input.parallelism.maxConcurrentBuilders) break;
    if (!provable(candidate)) continue;
    const contractOverlap = candidate.relevantContractIds.some((id) => claimedContracts.has(id));
    const areaOverlap = candidate.expectedAreas.some((area) => claimedAreas.has(area));
    if (contractOverlap || areaOverlap) continue;
    selected.push(candidate);
    for (const id of candidate.relevantContractIds) claimedContracts.add(id);
    for (const area of candidate.expectedAreas) claimedAreas.add(area);
  }
  return selected;
}
