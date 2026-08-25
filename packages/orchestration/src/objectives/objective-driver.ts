import path from 'node:path';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import type {
  MissionAdr,
  MissionConstitution,
  MissionState,
  ProductContract,
} from '@specbridge/mission';
import {
  createContractChangeRequest,
  readAdrs,
  readConstitution,
  readContractRegistry,
  readDecisions,
  readSpecCandidate,
} from '@specbridge/mission';
import type { ClaudeProbe, LocalModelManager } from '@specbridge/runners';
import type { Clock } from '@specbridge/workflow';
import { OrchestrationError } from '../errors.js';
import type { FailureCategory } from '../vocabulary.js';
import { requiresHuman } from '../jobs/authority.js';
import type { JobDecisionKind } from '../jobs/vocabulary.js';
import { JOB_DECISION_KINDS } from '../jobs/vocabulary.js';
import type { JobNode } from '../jobs/state.js';
import { jobDir } from '../jobs/store.js';
import { selectWorker } from '../jobs/routing.js';
import type { JobPolicy } from '@specbridge/core';
import type { JobWorkerProfile } from '../jobs/state.js';
import type { AggregatorOutput, DecomposerOutput, EvaluatorOutput } from './contracts.js';
import {
  buildAggregatorPacket,
  buildBuilderPacket,
  buildDecomposerPacket,
  buildEvaluatorPacket,
} from './prompts.js';
import {
  acceptWorkGraphProposal,
  aggregateStructurally,
  findUnit,
  promoteReadyUnits,
  requireUnit,
  selectDispatchSet,
  singleUnitGraph,
  transitionUnit,
  withUnit,
} from './graph.js';
import type { StructuralAggregation } from './graph.js';
import { integrateObjective } from './integrator.js';
import { buildContextProjection } from './projection.js';
import type { CandidateArtifact, ContextProjection, WorkGraph, WorkUnit } from './state.js';
import {
  CANDIDATE_ARTIFACT_SCHEMA_VERSION,
  CONTRACT_CONFLICT_SCHEMA_VERSION,
  candidateArtifactSchema,
} from './state.js';
import {
  readAggregationReport,
  readCandidate,
  readCandidatePatch,
  readLatestWorkGraph,
  readProjection,
  readWorkerRecords,
  storeAggregationReport,
  storeCandidate,
  storeConflict,
  storeEvaluation,
  storeProjection,
  storeWorkGraph,
} from './store.js';
import {
  evaluateDeterministically,
  isUnavailableStatus,
  nextEvaluationId,
  semanticEvaluationRequired,
} from './evaluation.js';
import { acceptWorkerResult, beginWorker, finishWorker, supersedeWorkers } from './supervisor.js';
import {
  applyDependencyPatches,
  collectWorktreeChanges,
  createWorkerWorktree,
  pruneWorktrees,
  removeWorkerWorktree,
  runWorktreeVerification,
} from './worktree.js';
import { runLargeObjectiveRole, runLocalObjectiveRole } from './workers.js';

/**
 * The objective driver: one approved objective, end to end.
 *
 *   approved Objective (a leaf task of a mission-driven spec)
 *           ↓ DECOMPOSER (proposal) → deterministic validation
 *   dynamic Work Graph
 *           ↓ builders in isolated worktrees → candidate artifacts
 *   deterministic evaluation → semantic evaluation (policy)
 *           ↓ structural aggregation (deterministic)
 *   single-writer INTEGRATOR → unchanged evidence pipeline
 *           ↓
 *   verified objective (or an honest failure the job-level machinery
 *   diagnoses, repairs, replans, or escalates)
 *
 * This function plugs into the job driver EXACTLY where dispatchExecutor
 * does: it returns the same outcome shape, so every existing job-level
 * policy — diagnosis before repair, replans, budgets, no-progress, resume —
 * governs objectives without duplication. Model proposes. SpecBridge
 * governs. Evidence decides.
 */

export interface ObjectiveDriveInput {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  jobId: string;
  specName: string;
  node: JobNode;
  mission: MissionState;
  policy: JobPolicy;
  workers: readonly JobWorkerProfile[];
  allowDirty: boolean;
  runnerProfile: string | undefined;
  localManager?: LocalModelManager | undefined;
  probeCache: { probe: ClaudeProbe | undefined };
  clock?: Clock | undefined;
  idFactory?: (() => string) | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /**
   * Budget + audit hook into the job service: counts one worker dispatch
   * against the job's maxAgentRuns and records the attempt. THROWS when the
   * budget is exhausted — the objective stops mid-flight and the job blocks.
   */
  countWorkerRun: (input: {
    role: 'DECOMPOSER' | 'BUILDER' | 'EVALUATOR' | 'AGGREGATOR' | 'INTEGRATOR';
    workerId: string;
    outcome: 'succeeded' | 'failed' | 'invalid-output';
    usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | undefined;
  }) => void;
  /** Semantic event sink (appends to the job event log). */
  recordEvent: (type: string, payload: Record<string, unknown>) => void;
}

export interface ObjectiveDriveResult {
  evidenceStatus: string | undefined;
  runId: string | undefined;
  failure?:
    | {
        category: FailureCategory;
        message: string;
        source: string;
        output?: string | undefined;
      }
    | undefined;
  changedFiles?: { path: string; contentHash?: string | undefined }[] | undefined;
  /**
   * Worker usage is accounted per dispatch through countWorkerRun, never
   * summed here; the field exists so the result is shape-compatible with
   * ExecutorDispatchResult at the fold-in point.
   */
  usage?:
    | { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
    | undefined;
}

interface MissionTruth {
  mission: MissionState;
  constitution: MissionConstitution | undefined;
  contracts: ProductContract[];
  adrs: MissionAdr[];
  decisions: ReturnType<typeof readDecisions>;
}

function loadMissionTruth(workspace: WorkspaceInfo, mission: MissionState): MissionTruth {
  return {
    mission,
    constitution: readConstitution(workspace, mission.missionId),
    contracts: readContractRegistry(workspace, mission.missionId),
    adrs: readAdrs(workspace, mission.missionId),
    decisions: readDecisions(workspace, mission.missionId),
  };
}

/**
 * Which product contracts an objective implements against, from the
 * synthesis provenance map (objective N ↔ requirement N ↔ contract). Falls
 * back to the whole registry when the map cannot answer — a projection with
 * more truth is safe; one with silently missing truth is not.
 */
export function contractsForObjective(
  workspace: WorkspaceInfo,
  mission: MissionState,
  taskId: string,
): string[] {
  const all = readContractRegistry(workspace, mission.missionId).map((contract) => contract.contractId);
  try {
    const raw = readSpecCandidate(workspace, mission.missionId, 'provenance.json');
    if (raw === undefined) return all;
    const parsed = JSON.parse(raw) as {
      requirements?: { requirementNumber?: number; contractId?: string }[];
    };
    const objectiveNumber = Number.parseInt(taskId.split('.')[0] ?? '', 10);
    if (!Number.isInteger(objectiveNumber)) return all;
    const matches = (parsed.requirements ?? [])
      .filter((row) => row.requirementNumber === objectiveNumber && typeof row.contractId === 'string')
      .map((row) => row.contractId as string);
    return matches.length > 0 ? matches : all;
  } catch {
    return all;
  }
}

function decisionKindOf(raw: string | undefined): JobDecisionKind {
  return (JOB_DECISION_KINDS as readonly string[]).includes(raw ?? '')
    ? (raw as JobDecisionKind)
    : 'architecture-contract-change';
}

/** Persist graph state after every mutation — the resume anchor. */
function persistGraph(input: ObjectiveDriveInput, graph: WorkGraph): WorkGraph {
  return storeWorkGraph(input.workspace, input.jobId, graph);
}

function nowIso(input: ObjectiveDriveInput): string {
  return (input.clock ?? (() => new Date()))().toISOString();
}

function failResult(
  category: FailureCategory,
  message: string,
  source: string,
  output?: string,
): ObjectiveDriveResult {
  return {
    evidenceStatus: undefined,
    runId: undefined,
    failure: { category, message, source, ...(output !== undefined ? { output } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

async function decomposeObjective(
  input: ObjectiveDriveInput,
  truth: MissionTruth,
  relevantContractIds: string[],
  acceptance: string[],
): Promise<WorkGraph> {
  const at = nowIso(input);
  const fallback = (reason: string): WorkGraph =>
    singleUnitGraph({
      jobId: input.jobId,
      node: input.node,
      relevantContractIds,
      createdAt: at,
      reason,
    });

  if (!input.policy.objectives.enabled) {
    const graph = persistGraph(input, fallback('objective decomposition is disabled by policy'));
    input.recordEvent('workgraph_created', { nodeId: input.node.nodeId, revision: 1, units: 1, proposedBy: 'deterministic' });
    return graph;
  }

  // Build the decomposer's projection over a synthetic whole-objective unit.
  const syntheticUnit: WorkUnit = {
    workUnitId: 'wu-0',
    objectiveNodeId: input.node.nodeId,
    parentTaskId: input.node.parentTaskId,
    kind: 'build',
    title: input.node.title.slice(0, 2_000),
    goal: `Decompose and implement: ${input.node.title}`.slice(0, 2_000),
    dependsOn: [],
    expectedArtifacts: [],
    relevantContractIds: relevantContractIds.slice(0, 30),
    relevantAdrIds: truth.adrs.filter((adr) => adr.status === 'accepted').map((adr) => adr.adrId).slice(0, 30),
    relevantConstitutionRuleIds: [],
    expectedAreas: [],
    status: 'READY',
    attempt: 0,
    evaluationRefs: [],
  };
  const projection = buildContextProjection({
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    objective: { taskId: input.node.parentTaskId, title: input.node.title, acceptance },
    workUnit: syntheticUnit,
    attempt: 1,
    source: {
      missionId: truth.mission.missionId,
      constitutionVersion: truth.constitution?.version ?? 0,
      constitutionRules: truth.constitution?.rules ?? [],
      contracts: truth.contracts,
      adrs: truth.adrs,
      decisions: truth.decisions,
    },
    createdAt: at,
    maxProjectionChars: input.policy.objectives.maxProjectionChars,
  });
  const packet = buildDecomposerPacket({
    projection,
    maxUnits: input.policy.objectives.maxWorkUnits,
    maxDepth: input.policy.objectives.maxGraphDepth,
  });

  const selection = selectWorker({
    role: 'DECOMPOSER',
    complexity: input.node.complexity,
    policy: input.policy,
    workers: input.workers,
    nodeEscalations: [],
  });
  input.onProgress?.(`DECOMPOSER on ${selection.worker.workerId} for objective ${input.node.parentTaskId}`);

  let output: DecomposerOutput | undefined;
  const result =
    selection.worker.reasoningTier === 'LOCAL_SMALL' && input.localManager !== undefined
      ? await runLocalObjectiveRole({
          manager: input.localManager,
          config: input.config,
          role: 'DECOMPOSER',
          packet,
          maxCorrections: input.policy.maxLocalOutputCorrections,
          onInferenceCall: () => undefined,
          signal: input.signal,
        })
      : await (async () => {
          const large = await runLargeObjectiveRole({
            workspace: input.workspace,
            config: input.config,
            runnerProfile: selection.worker.runnerProfile ?? input.config.defaultRunner,
            role: 'DECOMPOSER',
            packet,
            cwd: input.workspace.rootDir,
            scratchDir: path.join(jobDir(input.workspace, input.jobId), 'scratch'),
            timeoutMs: 600_000,
            signal: input.signal,
            cachedProbe: input.probeCache.probe,
          });
          if (large.probe !== undefined) input.probeCache.probe = large.probe;
          return large;
        })();
  input.countWorkerRun({
    role: 'DECOMPOSER',
    workerId: selection.worker.workerId,
    outcome: result.ok ? 'succeeded' : result.kind === 'invalid-output' ? 'invalid-output' : 'failed',
    ...(result.ok && result.usage !== undefined ? { usage: result.usage } : {}),
  });
  if (result.ok) output = result.output;

  let graph: WorkGraph;
  if (output === undefined || output.decision === 'ESCALATE' || output.units.length === 0) {
    // Decomposition is an optimization, never a dependency: any failure or
    // escalation degrades to the deterministic single-unit graph.
    graph = fallback(
      output === undefined
        ? `the decomposer produced no usable proposal (${result.ok ? 'empty' : result.problem.slice(0, 200)})`
        : output.decision === 'ESCALATE'
          ? `the decomposer escalated: ${output.escalationReason ?? output.reason}`.slice(0, 400)
          : 'the decomposer proposed no units',
    );
  } else {
    input.recordEvent('workgraph_proposed', {
      nodeId: input.node.nodeId,
      proposedBy: selection.worker.workerId,
      decision: output.decision,
      units: output.units.length,
    });
    try {
      graph = acceptWorkGraphProposal({
        jobId: input.jobId,
        node: input.node,
        proposal: output,
        proposedBy: selection.worker.workerId,
        policy: input.policy.objectives,
        createdAt: at,
      });
      // The DECLARED contract sets stay as proposed: they are the
      // independence signal parallel dispatch reasons over. Units that
      // declared nothing still receive the objective's contracts in their
      // PROJECTIONS (prepareUnitAttempt) — truth always flows; independence
      // is never assumed from silence.
    } catch (cause) {
      graph = fallback(
        `the proposed work graph was refused: ${cause instanceof Error ? cause.message.slice(0, 300) : 'invalid'}`,
      );
    }
  }
  graph = persistGraph(input, graph);
  input.recordEvent('workgraph_created', {
    nodeId: input.node.nodeId,
    revision: graph.revision,
    units: graph.units.length,
    proposedBy: graph.proposedBy,
  });
  return graph;
}

// ---------------------------------------------------------------------------
// One work-unit attempt
// ---------------------------------------------------------------------------

interface UnitAttemptContext {
  input: ObjectiveDriveInput;
  truth: MissionTruth;
  acceptance: string[];
  /** The objective's contract set: the projection fallback for units that declared none. */
  objectiveContractIds: string[];
}

interface PreparedAttempt {
  unitId: string;
  kind: WorkUnit['kind'];
  attempt: number;
  workerId: string;
  projection: ContextProjection;
  worktree: Awaited<ReturnType<typeof createWorkerWorktree>>;
  record: ReturnType<typeof beginWorker>;
  dependencyPatches: { workUnitId: string; patch: string }[];
}

interface ExecutedAttempt {
  prepared: PreparedAttempt;
  result: Awaited<ReturnType<typeof runLargeObjectiveRole<'BUILDER'>>>;
  collected?: Awaited<ReturnType<typeof collectWorktreeChanges>> | undefined;
  verification?: Awaited<ReturnType<typeof runWorktreeVerification>> | undefined;
}

/**
 * Phase 1 (SEQUENTIAL): projection, worktree, worker identity, and the
 * BUILDING transition — all graph writes happen here, one unit at a time,
 * so parallel execution can never race the persisted graph.
 */
async function prepareUnitAttempt(
  context: UnitAttemptContext,
  graph: WorkGraph,
  unitId: string,
): Promise<{ graph: WorkGraph; prepared: PreparedAttempt }> {
  const { input, truth } = context;
  const unit = requireUnit(graph, unitId);
  const attempt = unit.attempt + 1;
  const at = nowIso(input);

  // Dependency evidence: verified candidates only — never chat.
  const workEvidence: string[] = [];
  const dependencyPatches: { workUnitId: string; patch: string }[] = [];
  for (const dependencyId of unit.dependsOn) {
    const dependency = findUnit(graph, dependencyId);
    if (dependency === undefined) continue;
    const resolved =
      dependency.status === 'SUPERSEDED' && dependency.supersededBy !== undefined
        ? findUnit(graph, dependency.supersededBy)
        : dependency;
    if (resolved === undefined) continue;
    const candidate = readCandidate(
      input.workspace,
      input.jobId,
      input.node.nodeId,
      resolved.workUnitId,
      Math.max(1, resolved.attempt),
    );
    if (candidate !== undefined) {
      workEvidence.push(
        `${resolved.workUnitId} (${resolved.title.slice(0, 120)}): ${candidate.claims.summary.slice(0, 400)}`,
      );
      if (candidate.claims.report !== undefined) {
        workEvidence.push(`${resolved.workUnitId} report: ${candidate.claims.report.slice(0, 800)}`);
      }
      const patch = readCandidatePatch(
        input.workspace,
        input.jobId,
        input.node.nodeId,
        resolved.workUnitId,
        Math.max(1, resolved.attempt),
      );
      if (patch !== undefined && patch.trim().length > 0) {
        dependencyPatches.push({ workUnitId: resolved.workUnitId, patch });
      }
    }
  }

  const projectedUnit: WorkUnit =
    unit.relevantContractIds.length > 0
      ? unit
      : { ...unit, relevantContractIds: context.objectiveContractIds.slice(0, 30) };
  const projection = buildContextProjection({
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    objective: { taskId: input.node.parentTaskId, title: input.node.title, acceptance: context.acceptance },
    workUnit: projectedUnit,
    attempt,
    source: {
      missionId: truth.mission.missionId,
      constitutionVersion: truth.constitution?.version ?? 0,
      constitutionRules: truth.constitution?.rules ?? [],
      contracts: truth.contracts,
      adrs: truth.adrs,
      decisions: truth.decisions,
    },
    workEvidence,
    createdAt: at,
    maxProjectionChars: input.policy.objectives.maxProjectionChars,
  });
  storeProjection(input.workspace, input.jobId, input.node.nodeId, projection);

  const worktree = await createWorkerWorktree({
    workspace: input.workspace,
    jobId: input.jobId,
    workUnitId: unit.workUnitId,
    attempt,
  });
  const workerId = `builder-${unit.workUnitId}-a${attempt}`;
  const record = beginWorker({
    workspace: input.workspace,
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    workUnitId: unit.workUnitId,
    attempt,
    agentRole: 'BUILDER',
    workerId,
    contextProjectionHash: projection.contentHash,
    contractSnapshotHash: projection.contractSnapshotHash,
    workspaceIdentity: `worktree:${worktree.name}`,
    timeoutMs: input.policy.objectives.builderTimeoutMs,
    startedAt: at,
  });
  input.recordEvent('worker_started', {
    nodeId: input.node.nodeId,
    workUnitId: unit.workUnitId,
    attempt,
    role: 'BUILDER',
    workerId,
    projectionHash: projection.contentHash.slice(0, 16),
  });
  const building = transitionUnit(graph, unit.workUnitId, 'BUILDING');
  const nextGraph = persistGraph(
    input,
    withUnit(building, {
      ...requireUnit(building, unit.workUnitId),
      attempt,
      workerId,
      contextProjectionHash: projection.contentHash,
      contractSnapshotHash: projection.contractSnapshotHash,
    }),
  );
  return {
    graph: nextGraph,
    prepared: { unitId, kind: unit.kind, attempt, workerId, projection, worktree, record, dependencyPatches },
  };
}

/**
 * Phase 2 (PARALLEL-SAFE): the builder dispatch and worktree observation.
 * Touches only its own worktree and processes — never the graph, never
 * another unit's state, never shared files.
 */
async function executeBuilder(
  context: UnitAttemptContext,
  prepared: PreparedAttempt,
): Promise<ExecutedAttempt> {
  const { input } = context;
  await applyDependencyPatches(prepared.worktree, prepared.dependencyPatches);
  const packet = buildBuilderPacket({ projection: prepared.projection });
  const result = await runLargeObjectiveRole({
    workspace: input.workspace,
    config: input.config,
    runnerProfile: input.runnerProfile ?? input.config.defaultRunner,
    role: 'BUILDER',
    packet,
    cwd: prepared.worktree.dir,
    scratchDir: path.join(
      jobDir(input.workspace, input.jobId),
      'scratch',
      `${prepared.unitId}-a${prepared.attempt}`,
    ),
    timeoutMs: input.policy.objectives.builderTimeoutMs,
    signal: input.signal,
    cachedProbe: input.probeCache.probe,
  });
  if (result.probe !== undefined) input.probeCache.probe = result.probe;
  if (!result.ok) return { prepared, result };

  const collected = await collectWorktreeChanges(prepared.worktree, { protectedPaths: [] });
  const verification =
    prepared.kind === 'build' && collected.changedFiles.length > 0
      ? await runWorktreeVerification(prepared.worktree, input.config.verification.commands, input.signal)
      : undefined;
  return { prepared, result, collected, verification };
}

/**
 * Phase 3 (SEQUENTIAL): fold one executed attempt back into the graph —
 * candidate storage, identity gate, evaluation, CCRs, transitions.
 */
async function foldBuilderOutcome(
  context: UnitAttemptContext,
  graph: WorkGraph,
  executed: ExecutedAttempt,
): Promise<WorkGraph> {
  const { input } = context;
  const { prepared, result } = executed;
  const { unitId, attempt, workerId, projection, record } = prepared;

  input.countWorkerRun({
    role: 'BUILDER',
    workerId,
    outcome: result.ok ? 'succeeded' : result.kind === 'invalid-output' ? 'invalid-output' : 'failed',
    ...(result.ok && result.usage !== undefined ? { usage: result.usage } : {}),
  });

  if (!result.ok) {
    finishWorker(input.workspace, record, 'FAILED', nowIso(input));
    input.recordEvent('candidate_failed', {
      nodeId: input.node.nodeId,
      workUnitId: unitId,
      attempt,
      problem: result.problem.slice(0, 300),
    });
    return persistGraph(
      input,
      applyUnitRejection(input, graph, unitId, attempt, {
        category: result.kind === 'cancelled' ? 'CANCELLED' : 'TRANSIENT_TOOL',
        message: `The builder worker failed: ${result.problem.slice(0, 400)}`,
      }),
    );
  }
  const collected = executed.collected;
  if (collected === undefined) {
    return persistGraph(
      input,
      applyUnitRejection(input, graph, unitId, attempt, {
        category: 'INTERNAL',
        message: 'The worktree observation is missing for a successful builder run.',
      }),
    );
  }
  const verification = executed.verification;

  const candidate: CandidateArtifact = candidateArtifactSchema.parse({
    schemaVersion: CANDIDATE_ARTIFACT_SCHEMA_VERSION,
    candidateId: `${unitId}-a${String(attempt).padStart(2, '0')}`,
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    workUnitId: unitId,
    attempt,
    workerId,
    createdAt: nowIso(input),
    baselineCommit: prepared.worktree.baselineCommit,
    contextProjectionHash: projection.contentHash,
    contractSnapshotHash: projection.contractSnapshotHash,
    changedFiles: collected.changedFiles,
    ...(collected.patch.trim().length > 0
      ? { patchRef: `candidates/${unitId}-a${String(attempt).padStart(2, '0')}.patch` }
      : {}),
    localVerification: {
      ran: verification !== undefined && verification.ran,
      passed: verification?.passed ?? true,
      commands: (verification?.commands ?? []).map((command) => ({
        name: command.name,
        status: command.status,
        exitCode: command.exitCode ?? null,
      })),
    },
    claims: {
      summary: result.output.summary,
      assumptionsDiscovered: result.output.assumptionsDiscovered,
      contractChangeRequests: result.output.contractChangeRequests,
      knownLimitations: result.output.knownLimitations,
      ...(result.output.report !== undefined ? { report: result.output.report } : {}),
    },
  });
  storeCandidate(input.workspace, input.jobId, input.node.nodeId, candidate, collected.patch, {
    maxCandidateBytes: input.policy.objectives.maxCandidateBytes,
  });

  // Identity gate: the supervisor accepts only the RUNNING record's own
  // identity — a forged, duplicate, or superseded delivery never lands.
  const acceptance = acceptWorkerResult(input.workspace, input.jobId, input.node.nodeId, graph, {
    workerId,
    agentRole: 'BUILDER',
    workUnitId: unitId,
    attempt,
    contextProjectionHash: candidate.contextProjectionHash,
    contractSnapshotHash: candidate.contractSnapshotHash,
  });
  if (!acceptance.ok) {
    finishWorker(input.workspace, record, 'FAILED', nowIso(input));
    return persistGraph(
      input,
      applyUnitRejection(input, graph, unitId, attempt, {
        category: 'SAFETY_POLICY',
        message: `Worker result rejected: ${acceptance.problem}`,
      }),
    );
  }
  finishWorker(input.workspace, record, 'FINISHED', nowIso(input));
  graph = persistGraph(input, transitionUnit(graph, unitId, 'CANDIDATE_READY'));
  input.recordEvent('candidate_ready', {
    nodeId: input.node.nodeId,
    workUnitId: unitId,
    attempt,
    changedFiles: candidate.changedFiles.length,
    localVerificationPassed: candidate.localVerification.passed,
  });

  if (collected.protectedViolations.length > 0) {
    return persistGraph(
      input,
      applyUnitRejection(input, graph, unitId, attempt, {
        category: 'PROTECTED_PATH',
        message: `The candidate touches protected path(s): ${collected.protectedViolations.slice(0, 5).join(', ')}`,
      }),
    );
  }
  if (result.output.outcome === 'BLOCKED') {
    const blocked = transitionUnit(graph, unitId, 'BLOCKED');
    graph = persistGraph(
      input,
      withUnit(blocked, {
        ...requireUnit(blocked, unitId),
        latestFailure: {
          category: 'AMBIGUITY',
          message: `The builder is blocked: ${[...result.output.blockingQuestions, result.output.summary]
            .join('; ')
            .slice(0, 1_500)}`,
          at: nowIso(input),
        },
      }),
    );
    input.recordEvent('needs_decision', {
      nodeId: input.node.nodeId,
      workUnitId: unitId,
      questions: result.output.blockingQuestions.slice(0, 5),
    });
    return graph;
  }
  if (result.output.outcome === 'FAILED') {
    return persistGraph(
      input,
      applyUnitRejection(input, graph, unitId, attempt, {
        category: 'IMPLEMENTATION_DEFECT',
        message: `The builder reported failure: ${result.output.summary.slice(0, 400)}`,
      }),
    );
  }
  return evaluateCandidate(context, graph, unitId, attempt, candidate, projection, collected.patch);
}

/** The sequential path: prepare → execute → fold for one unit. */
async function runUnitAttempt(
  context: UnitAttemptContext,
  graph: WorkGraph,
  unitId: string,
): Promise<WorkGraph> {
  const { input } = context;
  const { graph: prepared, prepared: attempt } = await prepareUnitAttempt(context, graph, unitId);
  try {
    const executed = await executeBuilder(context, attempt);
    return await foldBuilderOutcome(context, prepared, executed);
  } finally {
    await removeWorkerWorktree(input.workspace, input.jobId, attempt.worktree);
  }
}

/** Fold a rejected attempt: bounded retry or unit failure. */
function applyUnitRejection(
  input: ObjectiveDriveInput,
  graph: WorkGraph,
  unitId: string,
  attempt: number,
  failure: { category: FailureCategory; message: string },
): WorkGraph {
  const unit = requireUnit(graph, unitId);
  const at = nowIso(input);
  const rejected = transitionUnit(graph, unitId, unit.status === 'READY' ? 'FAILED' : 'REJECTED');
  const withFailure = withUnit(rejected, {
    ...requireUnit(rejected, unitId),
    latestFailure: { category: failure.category, message: failure.message.slice(0, 2_000), at },
  });
  const budgetLeft = attempt < input.policy.objectives.maxBuilderAttemptsPerUnit;
  const current = requireUnit(withFailure, unitId);
  if (current.status === 'REJECTED') {
    if (budgetLeft && failure.category !== 'CANCELLED') {
      return transitionUnit(withFailure, unitId, 'READY');
    }
    return transitionUnit(withFailure, unitId, 'FAILED');
  }
  return withFailure;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

async function evaluateCandidate(
  context: UnitAttemptContext,
  graph: WorkGraph,
  unitId: string,
  attempt: number,
  candidate: CandidateArtifact,
  projection: ContextProjection,
  patch: string | undefined,
): Promise<WorkGraph> {
  const { input, truth } = context;
  const unit = requireUnit(graph, unitId);
  const at = nowIso(input);

  const deterministic = evaluateDeterministically({
    candidate,
    workUnit: unit,
    projection,
    contracts: truth.contracts,
    constitutionRules: truth.constitution?.rules ?? [],
    constitutionVersion: truth.constitution?.version ?? 0,
    protectedViolations: [],
    patch,
    createdAt: at,
    evaluationId: nextEvaluationId(unitId, attempt, 1),
  });
  const detStored = storeEvaluation(input.workspace, input.jobId, input.node.nodeId, deterministic);
  graph = withUnit(graph, {
    ...requireUnit(graph, unitId),
    candidateRef: `candidates/${candidate.candidateId}.json`,
    evaluationRefs: [...requireUnit(graph, unitId).evaluationRefs, detStored.ref].slice(-20),
  });
  input.recordEvent(deterministic.verdict === 'PASS' ? 'evaluation_passed' : 'evaluation_failed', {
    nodeId: input.node.nodeId,
    workUnitId: unitId,
    attempt,
    layer: 'deterministic',
    verdict: deterministic.verdict,
  });

  if (deterministic.verdict === 'CONFLICT') {
    return persistGraph(input, recordConflict(input, graph, unitId, candidate, deterministic.reasons, deterministic.affectedContractIds, deterministic.decisionKind));
  }
  if (deterministic.verdict === 'FAIL') {
    const stale = deterministic.checks.some(
      (check) => check.name === 'projection-freshness' && !check.passed,
    );
    // A verification command that never STARTED is a toolchain failure, not a
    // code failure. Categorising it as VERIFICATION_FAILURE sends the
    // reliability runtime off to repair an implementation that was never
    // tested — which is exactly what the vNext.10 dogfood spent three
    // repair/replan cycles doing when `gradlew.bat` could not be spawned in
    // the builder's worktree.
    //
    // Only when local verification is the SOLE failing check: a candidate
    // that also tripped a guard or changed nothing has real problems whether
    // or not its tests could run.
    const failedChecks = deterministic.checks.filter((check) => !check.passed);
    const failedCommands = candidate.localVerification.commands.filter(
      (command) => command.status !== 'ok',
    );
    const verificationUnavailable =
      failedChecks.length === 1 &&
      failedChecks[0]?.name === 'local-verification' &&
      failedCommands.length > 0 &&
      failedCommands.every((command) => isUnavailableStatus(command.status));
    return persistGraph(
      input,
      applyUnitRejection(input, graph, unitId, attempt, {
        category: stale
          ? 'STALE_CONTEXT'
          : verificationUnavailable
            ? 'CAPABILITY_UNAVAILABLE'
            : 'VERIFICATION_FAILURE',
        message: `Deterministic evaluation failed: ${deterministic.reasons.join('; ').slice(0, 1_200)}`,
      }),
    );
  }

  // Contract change requests discovered by the builder become durable CCRs
  // BEFORE semantic evaluation: a material one stops this unit for a human.
  const materialCcrs: string[] = [];
  for (const request of candidate.claims.contractChangeRequests) {
    try {
      const created = createContractChangeRequest(
        { workspace: input.workspace, clock: input.clock, idFactory: input.idFactory, host: 'orchestrator' },
        truth.mission.missionId,
        {
          contractId: request.contractId,
          problem: request.problem,
          proposal: request.proposal,
          raisedBy: candidate.workerId,
          originJobId: input.jobId,
          originWorkUnitId: unitId,
        },
      );
      input.recordEvent('contract_change_requested', {
        nodeId: input.node.nodeId,
        workUnitId: unitId,
        ccrId: created.ccr.ccrId,
        contractId: request.contractId,
        status: created.ccr.status,
      });
      if (created.material) materialCcrs.push(created.ccr.ccrId);
    } catch (cause) {
      input.recordEvent('contract_change_requested', {
        nodeId: input.node.nodeId,
        workUnitId: unitId,
        contractId: request.contractId,
        refused: cause instanceof Error ? cause.message.slice(0, 200) : 'invalid',
      });
    }
  }
  if (materialCcrs.length > 0) {
    graph = transitionUnit(graph, unitId, 'BLOCKED');
    graph = withUnit(graph, {
      ...requireUnit(graph, unitId),
      blockedByCcrIds: [...materialCcrs],
      latestFailure: {
        category: 'AMBIGUITY',
        message:
          `The builder discovered the approved contract cannot express what the implementation needs; ` +
          `change request(s) ${materialCcrs.join(', ')} await a human decision.`,
        at,
      },
    });
    input.recordEvent('needs_decision', { nodeId: input.node.nodeId, workUnitId: unitId, ccrIds: materialCcrs });
    return persistGraph(input, graph);
  }

  // Semantic evaluation where judgment is genuinely required. The unit
  // parks in EVALUATING; the drive loop picks it up (which is also the
  // crash-resume path for an interrupted evaluation).
  if (!semanticEvaluationRequired(input.policy.objectives.semanticEvaluation, unit, candidate, deterministic)) {
    return persistGraph(input, transitionUnit(graph, unitId, 'VERIFIED_CANDIDATE'));
  }
  return persistGraph(input, transitionUnit(graph, unitId, 'EVALUATING'));
}

function recordConflict(
  input: ObjectiveDriveInput,
  graph: WorkGraph,
  unitId: string,
  candidate: CandidateArtifact,
  reasons: readonly string[],
  affectedContractIds: readonly string[],
  decisionKindRaw: string | undefined,
): WorkGraph {
  const at = nowIso(input);
  const kind = decisionKindOf(decisionKindRaw);
  const contractId = affectedContractIds[0] ?? 'unknown-contract';
  const conflict = storeConflict(input.workspace, input.jobId, input.node.nodeId, {
    schemaVersion: CONTRACT_CONFLICT_SCHEMA_VERSION,
    conflictId: `conflict-${unitId}-a${String(candidate.attempt).padStart(2, '0')}`,
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    contractId,
    contractRevision: 1,
    claims: [
      {
        workUnitId: unitId,
        candidateRef: `candidates/${candidate.candidateId}.json`,
        claim: reasons.join('; ').slice(0, 2_000) || 'the candidate contradicts the approved contract',
      },
    ],
    evidenceRefs: [`candidates/${candidate.candidateId}.json`],
    affectedWorkUnitIds: [unitId],
    decisionKind: kind,
    status: 'OPEN',
    createdAt: at,
  });
  input.recordEvent('contract_conflict_detected', {
    nodeId: input.node.nodeId,
    workUnitId: unitId,
    conflictId: conflict.conflictId,
    contractId,
    decisionKind: kind,
  });
  const blocked = transitionUnit(graph, unitId, 'BLOCKED');
  return withUnit(blocked, {
    ...requireUnit(blocked, unitId),
    latestFailure: {
      category: requiresHuman(kind) ? 'AMBIGUITY' : 'IMPLEMENTATION_DEFECT',
      message: `Contract conflict ${conflict.conflictId} (${kind}): ${reasons.join('; ').slice(0, 1_200)}`,
      at,
    },
  });
}

// ---------------------------------------------------------------------------
// Semantic evaluation dispatch
// ---------------------------------------------------------------------------

async function runSemanticEvaluation(
  context: UnitAttemptContext,
  graph: WorkGraph,
  unitId: string,
): Promise<WorkGraph> {
  const { input, truth } = context;
  const unit = requireUnit(graph, unitId);
  const attempt = Math.max(1, unit.attempt);
  const at = nowIso(input);
  const candidate = readCandidate(input.workspace, input.jobId, input.node.nodeId, unitId, attempt);
  const projection = readProjection(input.workspace, input.jobId, input.node.nodeId, unitId, attempt);
  if (candidate === undefined || projection === undefined) {
    return persistGraph(
      input,
      applyUnitRejection(input, graph, unitId, attempt, {
        category: 'INTERNAL',
        message: 'The candidate or projection for semantic evaluation is missing.',
      }),
    );
  }
  const patch = readCandidatePatch(input.workspace, input.jobId, input.node.nodeId, unitId, attempt);
  const evaluations = requireUnit(graph, unitId).evaluationRefs.length;
  const deterministicRecord = evaluateDeterministically({
    candidate,
    workUnit: unit,
    projection,
    contracts: truth.contracts,
    constitutionRules: truth.constitution?.rules ?? [],
    constitutionVersion: truth.constitution?.version ?? 0,
    protectedViolations: [],
    patch,
    createdAt: at,
    evaluationId: nextEvaluationId(unitId, attempt, evaluations + 1),
  });

  const selection = selectWorker({
    role: 'EVALUATOR',
    complexity: input.node.complexity,
    policy: input.policy,
    workers: input.workers,
    nodeEscalations: [],
  });
  // Independence, structurally: the evaluator identity can never be the
  // builder identity — different role, different worker record, and the
  // packet is built from stored artifacts only.
  const packet = buildEvaluatorPacket({
    projection,
    candidate,
    diff: patch,
    deterministic: deterministicRecord,
    question: `Does this candidate satisfy work unit "${unit.title}" without contradicting the approved contracts?`,
  });
  input.onProgress?.(`EVALUATOR on ${selection.worker.workerId} for ${unitId}`);
  const runLarge = async (): Promise<Awaited<ReturnType<typeof runLargeObjectiveRole>>> => {
    const large = await runLargeObjectiveRole({
      workspace: input.workspace,
      config: input.config,
      runnerProfile: selection.worker.runnerProfile ?? input.config.defaultRunner,
      role: 'EVALUATOR',
      packet,
      cwd: input.workspace.rootDir,
      scratchDir: path.join(jobDir(input.workspace, input.jobId), 'scratch'),
      timeoutMs: 600_000,
      signal: input.signal,
      cachedProbe: input.probeCache.probe,
    });
    if (large.probe !== undefined) input.probeCache.probe = large.probe;
    return large;
  };
  const ranLocally =
    selection.worker.reasoningTier === 'LOCAL_SMALL' && input.localManager !== undefined;
  let result = ranLocally
    ? await runLocalObjectiveRole({
        manager: input.localManager!,
        config: input.config,
        role: 'EVALUATOR',
        packet,
        maxCorrections: input.policy.maxLocalOutputCorrections,
        onInferenceCall: () => undefined,
        signal: input.signal,
      })
    : await runLarge();

  // A packet too big for the small tier is not a failure of anything. It is a
  // ROUTING fact, and the answer is the tier that can hold it.
  //
  // The task driver has always done this — a `context-exceeded` local result
  // escalates with CONTEXT_LIMIT_EXCEEDED and never fails the task. The
  // objective driver did not, so an oversize evaluator packet rejected the
  // work unit instead. In the vNext.10.1 dogfood the evaluator packet was
  // 35,287 characters against a 14,745 ceiling: a candidate that had passed
  // local verification AND deterministic evaluation was thrown away because
  // nobody asked the bigger model.
  if (!result.ok && result.kind === 'context-exceeded' && ranLocally) {
    input.onProgress?.(
      `EVALUATOR packet exceeds the local tier for ${unitId}; escalating to ${
        selection.worker.runnerProfile ?? input.config.defaultRunner
      }`,
    );
    result = await runLarge();
  }
  input.countWorkerRun({
    role: 'EVALUATOR',
    workerId: selection.worker.workerId,
    outcome: result.ok ? 'succeeded' : result.kind === 'invalid-output' ? 'invalid-output' : 'failed',
    ...(result.ok && result.usage !== undefined ? { usage: result.usage } : {}),
  });

  if (!result.ok) {
    // A failed evaluator is a WORKER failure: the candidate is neither
    // accepted nor rejected; fail closed by rejecting the attempt.
    return persistGraph(
      input,
      applyUnitRejection(input, graph, unitId, attempt, {
        category: 'TRANSIENT_TOOL',
        message: `The semantic evaluator failed: ${result.problem.slice(0, 400)}`,
      }),
    );
  }
  const output: EvaluatorOutput = result.output;
  const record = storeEvaluation(input.workspace, input.jobId, input.node.nodeId, {
    schemaVersion: '1.0.0',
    evaluationId: nextEvaluationId(unitId, attempt, evaluations + 2),
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    workUnitId: unitId,
    attempt,
    layer: 'semantic',
    verdict: output.verdict,
    checks: [],
    reasons: output.reasons,
    evidenceRefs: output.evidenceRefs,
    affectedContractIds: output.affectedContractIds,
    ...(output.decisionKind !== undefined ? { decisionKind: output.decisionKind } : {}),
    evaluatorWorkerId: selection.worker.workerId,
    createdAt: nowIso(input),
  });
  graph = withUnit(graph, {
    ...requireUnit(graph, unitId),
    evaluationRefs: [...requireUnit(graph, unitId).evaluationRefs, record.ref].slice(-20),
  });
  input.recordEvent(output.verdict === 'PASS' ? 'evaluation_passed' : 'evaluation_failed', {
    nodeId: input.node.nodeId,
    workUnitId: unitId,
    attempt,
    layer: 'semantic',
    verdict: output.verdict,
    evaluator: selection.worker.workerId,
  });

  switch (output.verdict) {
    case 'PASS':
      return persistGraph(input, transitionUnit(graph, unitId, 'VERIFIED_CANDIDATE'));
    case 'FAIL':
      return persistGraph(
        input,
        applyUnitRejection(input, graph, unitId, attempt, {
          category: 'IMPLEMENTATION_DEFECT',
          message: `Semantic evaluation failed: ${output.reasons.join('; ').slice(0, 1_200)}`,
        }),
      );
    case 'CONFLICT':
      return persistGraph(
        input,
        recordConflict(input, graph, unitId, candidate, output.reasons, output.affectedContractIds, output.decisionKind),
      );
    case 'NEEDS_DECISION': {
      const kind = decisionKindOf(output.decisionKind);
      if (!requiresHuman(kind)) {
        // Implementation-detail decisions resolve autonomously: the verdict
        // and reasons are recorded; the candidate proceeds.
        input.recordEvent('needs_decision', {
          nodeId: input.node.nodeId,
          workUnitId: unitId,
          decisionKind: kind,
          resolution: 'autonomous',
        });
        return persistGraph(input, transitionUnit(graph, unitId, 'VERIFIED_CANDIDATE'));
      }
      const blocked = transitionUnit(graph, unitId, 'BLOCKED');
      input.recordEvent('needs_decision', {
        nodeId: input.node.nodeId,
        workUnitId: unitId,
        decisionKind: kind,
        resolution: 'human',
      });
      return persistGraph(
        input,
        withUnit(blocked, {
          ...requireUnit(blocked, unitId),
          latestFailure: {
            category: 'AMBIGUITY',
            message: `The evaluator needs a ${kind} decision: ${output.reasons.join('; ').slice(0, 1_200)}`,
            at: nowIso(input),
          },
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The objective drive loop
// ---------------------------------------------------------------------------

/** Acceptance criteria of the objective, from the mission provenance map. */
function acceptanceForObjective(
  workspace: WorkspaceInfo,
  mission: MissionState,
  taskId: string,
): string[] {
  try {
    const raw = readSpecCandidate(workspace, mission.missionId, 'provenance.json');
    if (raw === undefined) return [];
    const parsed = JSON.parse(raw) as {
      requirements?: { requirementNumber?: number; criteria?: { source?: string }[]; title?: string }[];
    };
    const objectiveNumber = Number.parseInt(taskId.split('.')[0] ?? '', 10);
    const row = (parsed.requirements ?? []).find((entry) => entry.requirementNumber === objectiveNumber);
    if (row === undefined) return [];
    const contracts = readContractRegistry(workspace, mission.missionId);
    const sources = (row.criteria ?? [])
      .map((criterion) => criterion.source)
      .filter((source): source is string => typeof source === 'string');
    const statements: string[] = [];
    for (const source of sources) {
      const [contractId, , itemId] = source.split('/');
      const contract = contracts.find((candidate) => candidate.contractId === contractId);
      if (contract === undefined) continue;
      const requirement = contract.requirements.find((candidate) => candidate.requirementId === itemId);
      if (requirement !== undefined) statements.push(requirement.statement);
      const invariant = contract.invariants.find((candidate) => candidate.invariantId === itemId);
      if (invariant !== undefined) statements.push(invariant.statement);
    }
    return statements.slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * Failure categories that say the MACHINERY failed, not the code.
 *
 * A unit carrying one of these was never actually judged: the builder
 * produced a candidate, the candidate passed whatever ran before the
 * machinery broke, and then a tool, a transport, a credential, or a
 * configuration failed. Nothing about the implementation was learned.
 */
const NON_IMPLEMENTATION_UNIT_FAILURES: readonly FailureCategory[] = [
  'TRANSIENT_TOOL',
  'TRANSIENT_TRANSPORT',
  'CAPABILITY_UNAVAILABLE',
  'AUTHENTICATION',
  'PERMISSION',
  'INVALID_CONFIGURATION',
  'BLOCKED_DEPENDENCY',
];

/**
 * The failure an objective reports when its units could not integrate.
 *
 * Exported for the same reason `aggregateStructurally` is: it decides what a
 * recovery loop will spend its budget on, and getting it wrong is expensive
 * and silent.
 */
export function failureFromAggregation(graph: WorkGraph, aggregation: StructuralAggregation): ObjectiveDriveResult {
  const blockedUnits = graph.units.filter((unit) => unit.status === 'BLOCKED');
  const humanBlocked = blockedUnits.filter((unit) => unit.latestFailure?.category === 'AMBIGUITY');
  if (humanBlocked.length > 0) {
    return failResult(
      'AMBIGUITY',
      humanBlocked
        .map((unit) => `${unit.workUnitId}: ${unit.latestFailure?.message ?? 'needs a decision'}`)
        .join(' | ')
        .slice(0, 1_800),
      'objective:aggregation',
    );
  }
  // A unit that failed because the MACHINERY failed must not be reported as
  // an implementation defect.
  //
  // The vNext.10.1 dogfood lost a whole task budget to this. The builder
  // produced a candidate; local verification passed; the deterministic
  // evaluation passed; then the semantic evaluator's endpoint answered HTTP
  // 400 and the unit was rejected as TRANSIENT_TOOL. Aggregation dropped that
  // category on the floor and reported IMPLEMENTATION_DEFECT, so the
  // DIAGNOSER and the REPLANNER spent four attempts rewriting code that had
  // already passed every trusted check, converged on the same fingerprint
  // each time, and handed the job to a human.
  //
  // Only when NO failed unit blames the implementation: one unit that
  // genuinely failed its checks makes IMPLEMENTATION_DEFECT the honest answer
  // for the objective, whatever else also broke.
  const failedUnits = graph.units.filter((unit) => unit.status === 'FAILED');
  const categories = failedUnits.map((unit) => unit.latestFailure?.category);
  const infrastructure = categories.filter(
    (category): category is FailureCategory =>
      category !== undefined && NON_IMPLEMENTATION_UNIT_FAILURES.includes(category),
  );
  if (failedUnits.length > 0 && infrastructure.length === failedUnits.length) {
    const category = infrastructure[0] ?? 'TRANSIENT_TOOL';
    const detail = failedUnits
      .map((unit) => `${unit.workUnitId}: ${unit.latestFailure?.message ?? 'no detail recorded'}`)
      .join(' | ');
    return failResult(
      category,
      `The objective could not integrate because the machinery failed, not the ` +
        `implementation: ${detail.slice(0, 1_400)}`,
      'objective:aggregation',
    );
  }

  return failResult(
    'IMPLEMENTATION_DEFECT',
    `The objective cannot integrate: ${aggregation.reasons.join('; ').slice(0, 1_500)}`,
    'objective:aggregation',
  );
}

/**
 * Drive one approved objective to a verified completion or an honest
 * failure. Every step persists before the next begins; a killed process
 * resumes from the stored work graph with in-flight statuses reconciled.
 */
export async function driveObjective(input: ObjectiveDriveInput): Promise<ObjectiveDriveResult> {
  const truth = loadMissionTruth(input.workspace, input.mission);
  const relevantContractIds = contractsForObjective(input.workspace, input.mission, input.node.parentTaskId);
  const acceptance = acceptanceForObjective(input.workspace, input.mission, input.node.parentTaskId);
  const context: UnitAttemptContext = { input, truth, acceptance, objectiveContractIds: relevantContractIds };

  // Load or create the work graph, reconciling interruptions first.
  let graph = readLatestWorkGraph(input.workspace, input.jobId, input.node.nodeId);
  if (graph !== undefined && graph.objectiveFingerprint !== input.node.taskFingerprint) {
    return failResult(
      'STALE_CONTEXT',
      'The approved objective changed after its work graph was built; the graph is stale.',
      'objective:staleness',
    );
  }
  if (graph !== undefined) {
    const workerRecords = readWorkerRecords(input.workspace, input.jobId, input.node.nodeId);
    let reconciled = graph;
    for (const unit of graph.units) {
      if (unit.status === 'BUILDING' || unit.status === 'EVALUATING') {
        // A previous process died mid-dispatch: supersede its workers (late
        // results are refused from now on) and return the unit to its safe
        // predecessor. The interrupted attempt stays consumed.
        supersedeWorkers(input.workspace, input.jobId, input.node.nodeId, workerRecords, unit.workUnitId, nowIso(input));
        reconciled = transitionUnit(reconciled, unit.workUnitId, unit.status === 'BUILDING' ? 'READY' : 'CANDIDATE_READY');
      } else if (unit.status === 'BLOCKED') {
        // Being dispatched again means the job-level machinery decided to
        // continue (a clarification was answered, a CCR was decided, a
        // repair was ordered). A blocked unit gets another bounded attempt;
        // an exhausted one fails honestly instead of retrying forever.
        reconciled = transitionUnit(
          reconciled,
          unit.workUnitId,
          unit.attempt < input.policy.objectives.maxBuilderAttemptsPerUnit ? 'READY' : 'FAILED',
        );
      }
    }
    if (reconciled !== graph) {
      await pruneWorktrees(input.workspace, input.jobId);
      graph = persistGraph(input, reconciled);
      input.recordEvent('workgraph_revised', { nodeId: input.node.nodeId, reconciled: true, revision: graph.revision });
    }
  } else {
    graph = await decomposeObjective(input, truth, relevantContractIds, acceptance);
  }

  // The bounded drive loop: each iteration either dispatches at least one
  // worker, integrates, or exits — countWorkerRun throws on budget
  // exhaustion, and this valve guards against a cycle that dispatches
  // nothing (a driver defect, not a task failure).
  const maxLoops = input.policy.objectives.maxWorkUnits * (input.policy.objectives.maxBuilderAttemptsPerUnit + 2) + 10;
  for (let loop = 0; loop < maxLoops; loop += 1) {
    if (input.signal?.aborted === true) {
      return failResult('CANCELLED', 'The objective drive was interrupted.', 'objective:cancelled');
    }
    graph = persistGraph(input, promoteReadyUnits(graph));

    // Units awaiting semantic evaluation resume here (also the crash path).
    const evaluating = graph.units.find((unit) => unit.status === 'EVALUATING');
    if (evaluating !== undefined) {
      graph = await runSemanticEvaluation(context, graph, evaluating.workUnitId);
      continue;
    }

    const aggregation = aggregateStructurally(graph);
    if (aggregation.integrationReady) {
      input.recordEvent('aggregation_completed', {
        nodeId: input.node.nodeId,
        verified: aggregation.verified.length,
        reasons: aggregation.reasons.slice(0, 5),
      });
      // Semantic aggregation: only when SEVERAL verified investigation
      // reports genuinely require synthesis (§10.2). Its output is a
      // structured report — it may surface conflicts and RECOMMEND contract
      // changes; it approves nothing and never gates a deterministic answer.
      const semanticStop = await maybeAggregateSemantically(context, graph);
      if (semanticStop !== undefined) return semanticStop;
      return integrateVerifiedCandidates(input, graph);
    }
    const anyReady = selectDispatchSet({
      graph,
      parallelism: input.policy.objectives.parallelism,
      unresolvedDecision: graph.units.some((unit) => unit.status === 'BLOCKED'),
    });
    if (anyReady.length === 0) {
      // Nothing dispatchable: either genuinely finished-with-failures or
      // structurally stuck. Both are honest failures for job-level policy.
      input.recordEvent('aggregation_completed', {
        nodeId: input.node.nodeId,
        integrationReady: false,
        reasons: aggregation.reasons.slice(0, 5),
      });
      return failureFromAggregation(graph, aggregation);
    }

    if (anyReady.length === 1) {
      graph = await runUnitAttempt(context, graph, anyReady[0]!.workUnitId);
      continue;
    }
    // Parallel builders: preparation and folding stay SEQUENTIAL (they are
    // the only graph writers); only the isolated builder dispatches — each
    // confined to its own worktree, contracts, and areas by the
    // deterministic dispatch-set selection — run concurrently.
    input.onProgress?.(
      `dispatching ${anyReady.length} independent builders in parallel: ${anyReady.map((unit) => unit.workUnitId).join(', ')}`,
    );
    const preparedAttempts: PreparedAttempt[] = [];
    for (const unit of anyReady) {
      const step = await prepareUnitAttempt(context, graph, unit.workUnitId);
      graph = step.graph;
      preparedAttempts.push(step.prepared);
    }
    try {
      const executed = await Promise.all(
        preparedAttempts.map((prepared) => executeBuilder(context, prepared)),
      );
      for (const outcome of executed) {
        graph = await foldBuilderOutcome(context, graph, outcome);
      }
    } finally {
      for (const prepared of preparedAttempts) {
        await removeWorkerWorktree(input.workspace, input.jobId, prepared.worktree);
      }
    }
  }
  return failResult(
    'INTERNAL',
    'The objective drive loop exceeded its bound without finishing; this indicates a scheduling defect.',
    'objective:loop-bound',
  );
}

/**
 * Run the AGGREGATOR over verified investigation reports (when at least two
 * exist and no synthesis is stored yet for this graph revision). Returns a
 * stop result only when the synthesis surfaces a MATERIAL conflict; every
 * other outcome records artifacts and lets integration proceed.
 */
async function maybeAggregateSemantically(
  context: UnitAttemptContext,
  graph: WorkGraph,
): Promise<ObjectiveDriveResult | undefined> {
  const { input, truth } = context;
  const investigations = graph.units.filter(
    (unit) => unit.kind === 'investigation' && unit.status === 'VERIFIED_CANDIDATE',
  );
  if (investigations.length < 2) return undefined;
  const reportName = `aggregation-r${String(graph.revision).padStart(3, '0')}`;
  if (readAggregationReport(input.workspace, input.jobId, input.node.nodeId, reportName) !== undefined) {
    return undefined; // Already synthesized for this revision (resume path).
  }

  const reports = investigations
    .map((unit) => {
      const candidate = readCandidate(input.workspace, input.jobId, input.node.nodeId, unit.workUnitId, Math.max(1, unit.attempt));
      const body = candidate?.claims.report ?? candidate?.claims.summary;
      return body === undefined ? undefined : { workUnitId: unit.workUnitId, title: unit.title, body };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (reports.length < 2) return undefined;

  const contractContext = truth.contracts
    .map((contract) => `${contract.contractId} r${contract.revision}: ${contract.title} — ${contract.summary}`)
    .join('\n');
  const packet = buildAggregatorPacket({
    question: `Synthesize the investigation reports for objective "${input.node.title}" against the approved contracts.`,
    reports,
    contractContext,
  });
  const selection = selectWorker({
    role: 'AGGREGATOR',
    complexity: input.node.complexity,
    policy: input.policy,
    workers: input.workers,
    nodeEscalations: [],
  });
  input.onProgress?.(`AGGREGATOR on ${selection.worker.workerId} over ${reports.length} investigation report(s)`);
  const result =
    selection.worker.reasoningTier === 'LOCAL_SMALL' && input.localManager !== undefined
      ? await runLocalObjectiveRole({
          manager: input.localManager,
          config: input.config,
          role: 'AGGREGATOR',
          packet,
          maxCorrections: input.policy.maxLocalOutputCorrections,
          onInferenceCall: () => undefined,
          signal: input.signal,
        })
      : await (async () => {
          const large = await runLargeObjectiveRole({
            workspace: input.workspace,
            config: input.config,
            runnerProfile: selection.worker.runnerProfile ?? input.config.defaultRunner,
            role: 'AGGREGATOR',
            packet,
            cwd: input.workspace.rootDir,
            scratchDir: path.join(jobDir(input.workspace, input.jobId), 'scratch'),
            timeoutMs: 600_000,
            signal: input.signal,
            cachedProbe: input.probeCache.probe,
          });
          if (large.probe !== undefined) input.probeCache.probe = large.probe;
          return large;
        })();
  input.countWorkerRun({
    role: 'AGGREGATOR',
    workerId: selection.worker.workerId,
    outcome: result.ok ? 'succeeded' : result.kind === 'invalid-output' ? 'invalid-output' : 'failed',
    ...(result.ok && result.usage !== undefined ? { usage: result.usage } : {}),
  });
  if (!result.ok) {
    // Synthesis is additive insight, not a gate: a failed aggregator worker
    // is recorded and integration proceeds on the deterministic result.
    input.recordEvent('aggregation_completed', {
      nodeId: input.node.nodeId,
      semantic: true,
      failed: true,
      problem: result.problem.slice(0, 300),
    });
    return undefined;
  }
  const output: AggregatorOutput = result.output;
  storeAggregationReport(input.workspace, input.jobId, input.node.nodeId, reportName, {
    synthesizedAt: nowIso(input),
    aggregator: selection.worker.workerId,
    sources: reports.map((report) => report.workUnitId),
    ...output,
  });
  input.recordEvent('aggregation_completed', {
    nodeId: input.node.nodeId,
    semantic: true,
    sources: reports.map((report) => report.workUnitId),
    conflicts: output.conflictsDetected.length,
    suggestions: output.contractChangeSuggestions.length,
  });

  // Recommendations become durable CCRs (never approvals).
  for (const suggestion of output.contractChangeSuggestions) {
    try {
      const created = createContractChangeRequest(
        { workspace: input.workspace, clock: input.clock, idFactory: input.idFactory, host: 'orchestrator' },
        truth.mission.missionId,
        {
          contractId: suggestion.contractId,
          problem: suggestion.problem,
          proposal: suggestion.proposal,
          raisedBy: selection.worker.workerId,
          originJobId: input.jobId,
        },
      );
      input.recordEvent('contract_change_requested', {
        nodeId: input.node.nodeId,
        ccrId: created.ccr.ccrId,
        contractId: suggestion.contractId,
        status: created.ccr.status,
        source: 'aggregator',
      });
    } catch {
      // An unknown contract id in a suggestion is recorded implicitly by its absence.
    }
  }

  // Cross-report contract conflicts: never silently pick a side.
  for (const conflict of output.conflictsDetected) {
    const kind = decisionKindOf('architecture-contract-change');
    const record = storeConflict(input.workspace, input.jobId, input.node.nodeId, {
      schemaVersion: CONTRACT_CONFLICT_SCHEMA_VERSION,
      conflictId: `conflict-agg-${graph.revision}-${conflict.contractId}`,
      jobId: input.jobId,
      objectiveNodeId: input.node.nodeId,
      contractId: conflict.contractId,
      contractRevision: truth.contracts.find((c) => c.contractId === conflict.contractId)?.revision ?? 1,
      claims: conflict.claims.map((claim) => ({ workUnitId: claim.sourceWorkUnitId, claim: claim.claim })),
      evidenceRefs: [`reports/${reportName}.json`],
      affectedWorkUnitIds: conflict.claims.map((claim) => claim.sourceWorkUnitId),
      decisionKind: kind,
      status: 'OPEN',
      createdAt: nowIso(input),
    });
    input.recordEvent('contract_conflict_detected', {
      nodeId: input.node.nodeId,
      conflictId: record.conflictId,
      contractId: conflict.contractId,
      source: 'aggregator',
    });
  }
  if (output.conflictsDetected.length > 0) {
    return failResult(
      'AMBIGUITY',
      `The aggregated investigation reports contradict each other about ${output.conflictsDetected
        .map((conflict) => conflict.contractId)
        .join(', ')}; a decision is required before integration.`,
      'objective:semantic-aggregation',
    );
  }
  return undefined;
}

async function integrateVerifiedCandidates(
  input: ObjectiveDriveInput,
  graph: WorkGraph,
): Promise<ObjectiveDriveResult> {
  // Dependency-ordered verified build candidates.
  const order: WorkUnit[] = [];
  const placed = new Set<string>();
  const place = (unit: WorkUnit): void => {
    if (placed.has(unit.workUnitId)) return;
    for (const dependency of unit.dependsOn) {
      const dependencyUnit = findUnit(graph, dependency);
      if (dependencyUnit !== undefined) place(dependencyUnit);
    }
    placed.add(unit.workUnitId);
    order.push(unit);
  };
  for (const unit of graph.units) place(unit);

  const candidates = order
    .filter((unit) => unit.status === 'VERIFIED_CANDIDATE' && unit.kind === 'build')
    .map((unit) => {
      const attempt = Math.max(1, unit.attempt);
      const candidate = readCandidate(input.workspace, input.jobId, input.node.nodeId, unit.workUnitId, attempt);
      const patch = readCandidatePatch(input.workspace, input.jobId, input.node.nodeId, unit.workUnitId, attempt);
      return candidate === undefined ? undefined : { unit, candidate, patch };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (candidates.length === 0) {
    return failResult(
      'IMPLEMENTATION_DEFECT',
      'No verified build candidate carries repository changes; the objective produced nothing to integrate.',
      'objective:integration',
    );
  }

  input.recordEvent('integration_ready', {
    nodeId: input.node.nodeId,
    candidates: candidates.map((entry) => entry.unit.workUnitId),
  });
  input.recordEvent('integration_started', { nodeId: input.node.nodeId });
  const result = await integrateObjective({
    workspace: input.workspace,
    config: input.config,
    jobId: input.jobId,
    specName: input.specName,
    taskId: input.node.parentTaskId,
    objectiveNodeId: input.node.nodeId,
    candidates,
    allowDirty: input.allowDirty,
    runnerProfile: input.runnerProfile,
    clock: input.clock,
    idFactory: input.idFactory,
    signal: input.signal,
    cachedProbe: input.probeCache.probe,
    onProgress: input.onProgress,
  });
  if (!result.ok) {
    input.recordEvent('integration_failed', {
      nodeId: input.node.nodeId,
      category: result.category,
      source: result.source,
    });
    return {
      evidenceStatus: undefined,
      runId: result.runId,
      failure: {
        category: result.category,
        message: result.message,
        source: result.source,
        ...(result.output !== undefined ? { output: result.output } : {}),
      },
    };
  }

  let integrated = graph;
  const at = nowIso(input);
  for (const entry of candidates) {
    integrated = withUnit(transitionUnit(integrated, entry.unit.workUnitId, 'INTEGRATED'), {
      ...requireUnit(transitionUnit(integrated, entry.unit.workUnitId, 'INTEGRATED'), entry.unit.workUnitId),
      integratedAt: at,
    });
  }
  persistGraph(input, integrated);
  input.recordEvent('objective_verified', {
    nodeId: input.node.nodeId,
    taskId: input.node.parentTaskId,
    runId: result.runId,
    evidenceStatus: result.evidenceStatus,
  });
  return {
    evidenceStatus: result.evidenceStatus,
    runId: result.runId,
    changedFiles: result.changedFiles,
  };
}

export function assertObjectiveDriveSupported(node: JobNode): void {
  if (node.parentTaskId.length === 0) {
    throw new OrchestrationError('SBO039', 'An objective drive needs a bound approved task.');
  }
}
