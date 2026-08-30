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
import type { ResearchBridge } from '../research/index.js';
import {
  considerLifecycleResearch,
  investigationPacketSchema,
  listResearchRecords,
  renderResearchEvidence,
  researchRequestSchema,
} from '../research/index.js';
import { OrchestrationError } from '../errors.js';
import type { FailureCategory } from '../vocabulary.js';
import { requiresHuman } from '../jobs/authority.js';
import { fence } from '../agents/prompts.js';
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
import { buildContextProjection, evaluateProjectionFreshness } from './projection.js';
import type { CandidateArtifact, ContextProjection, EvaluationRecord, WorkGraph, WorkUnit } from './state.js';
import {
  CANDIDATE_ARTIFACT_SCHEMA_VERSION,
  CONTRACT_CONFLICT_SCHEMA_VERSION,
  candidateArtifactSchema,
} from './state.js';
import {
  readAggregationReport,
  readCandidate,
  readCandidatePatch,
  readEvaluations,
  readLatestWorkGraph,
  readProjection,
  readSecondaryBuilderAttempt,
  readWorkReadinessRecord,
  readWorkReadinessRecords,
  readWorkerRecords,
  storeAggregationReport,
  storeCandidate,
  storeConflict,
  storeEvaluation,
  storeProjection,
  storeSecondaryBuilderAttempt,
  storeWorkReadinessRecord,
  storeWorkReadinessTelemetry,
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
  readCanonicalHead,
  removeWorkerWorktree,
  runWorktreeVerification,
} from './worktree.js';
import { runLargeObjectiveRole, runLocalObjectiveRole } from './workers.js';
import type {
  SecondaryBuilderAttempt,
  SecondaryBuilderFailureKind,
  SecondaryObjectiveBuilderSelection,
} from './secondary-builder.js';
import { SecondaryBuilderContextCompiler } from './builder-packet-compiler.js';
import type {
  BuilderPacketCompilationResult,
  VerifiedDependencyContextInput,
} from './builder-packet-compiler.js';
import {
  SECONDARY_BUILDER_ATTEMPT_SCHEMA_VERSION,
  buildSecondaryBuilderPacket,
  executeSecondaryObjectiveBuilder,
  managedLocalSecondaryModelInference,
  secondaryBuilderAttemptSchema,
  secondaryBuilderInputCeiling,
} from './secondary-builder.js';
import type { SecondaryBuilderPacket } from './secondary-builder.js';
import type { SecondaryEligibilityDecision, SecondaryEligibilityStatus } from './work-readiness.js';
import {
  assessAndDecideWorkReadiness,
  summarizeWorkReadiness,
} from './work-readiness.js';

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
  /** Injectable Phase 2 bridge; omitted in production to use configured DeerFlow. */
  researchBridge?: ResearchBridge | undefined;
  /** Explicit-only Phase 4 selection. Absence preserves the large builder. */
  secondaryBuilder?: SecondaryObjectiveBuilderSelection | undefined;
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
    goal: [
      `Decompose and implement: ${input.node.title}`,
      ...(input.node.replanReason !== undefined
        ? [`Replan evidence: ${input.node.replanReason}. If it identifies an external knowledge gap, schedule a bounded investigation before rebuilding.`]
        : []),
    ].join('\n').slice(0, 2_000),
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
  unit: WorkUnit;
  kind: WorkUnit['kind'];
  attempt: number;
  workerId: string;
  projection: ContextProjection;
  worktree?: Awaited<ReturnType<typeof createWorkerWorktree>>;
  baselineCommit: string;
  record: ReturnType<typeof beginWorker>;
  dependencyPatches: { workUnitId: string; patch: string }[];
  dependencyContext: VerifiedDependencyContextInput[];
  missingDependencyIds: string[];
}

interface ExecutedAttempt {
  prepared: PreparedAttempt;
  result: Awaited<ReturnType<typeof runLargeObjectiveRole<'BUILDER'>>>;
  collected?: Awaited<ReturnType<typeof collectWorktreeChanges>> | undefined;
  verification?: Awaited<ReturnType<typeof runWorktreeVerification>> | undefined;
  researchId?: string | undefined;
  countedAsWorker?: boolean | undefined;
  secondaryAttempt?: SecondaryBuilderAttempt | undefined;
  secondaryFailure?: { kind: SecondaryBuilderFailureKind; problem: string } | undefined;
  readinessDecision?: SecondaryEligibilityDecision | undefined;
}

async function executeResearchInvestigation(
  context: UnitAttemptContext,
  prepared: PreparedAttempt,
): Promise<ExecutedAttempt | undefined> {
  if (prepared.kind !== 'investigation' || !context.input.config.research.enabled) return undefined;
  const { input } = context;
  const projection = prepared.projection;
  const unit = projection.workUnit;
  const researchId = `research-${input.jobId}-${prepared.unitId}-a${prepared.attempt}`.slice(0, 128);
  const contractFacts = projection.contracts.flatMap((contract) => [
    `${contract.contractId} r${contract.revision}: ${contract.summary}`,
    ...contract.requirements.slice(0, 3),
    ...contract.invariants.slice(0, 3),
  ]).slice(0, 20);
  const packet = investigationPacketSchema.parse({
    investigationId: researchId,
    goal: unit.goal.slice(0, 4_000),
    knownFacts: [
      ...projection.workEvidence,
      ...projection.decisions.map((decision) => decision.decision),
    ].map((fact) => fact.slice(0, 2_000)).slice(0, 20),
    relevantContracts: contractFacts.map((fact) => fact.slice(0, 2_000)).slice(0, 20),
    currentSystemRefs: [
      `projection:${projection.projectionId}`,
      ...projection.contracts.map((contract) => `contract:${contract.contractId}@${contract.revision}`),
    ].map((ref) => ref.slice(0, 512)).slice(0, 20),
    observedFailures: [],
    failedStrategies: [],
    sourceRefs: [],
    constraints: projection.constitution.rules
      .map((rule) => rule.statement.slice(0, 2_000))
      .slice(0, 20),
    questionsToAnswer: unit.expectedArtifacts.length > 0
      ? unit.expectedArtifacts.map((item) => item.slice(0, 1_000)).slice(0, 12)
      : [unit.goal.slice(0, 1_000)],
    topicTags: projection.contracts
      .map((contract) => contract.contractId.slice(0, 64))
      .slice(0, 16),
    currentFactSensitive: false,
  });
  const request = researchRequestSchema.parse({
    researchId: packet.investigationId,
    depth: 'QUICK',
    question: packet.goal,
    topicTags: packet.topicTags,
    context: {
      knownFacts: packet.knownFacts,
      observedFailures: packet.observedFailures,
      failedStrategies: packet.failedStrategies,
      constraints: [...packet.constraints, ...packet.relevantContracts].slice(0, 20),
      contextRefs: [...packet.currentSystemRefs, ...packet.sourceRefs].slice(0, 20),
    },
    expectedOutput: { questionsToAnswer: packet.questionsToAnswer },
    sourcePolicy: { preferPrimarySources: true, requireSources: true },
    freshness: {
      currentFactSensitive: packet.currentFactSensitive,
      ...(packet.subjectVersion !== undefined ? { subjectVersion: packet.subjectVersion } : {}),
    },
  });
  input.onProgress?.(`research investigation ${prepared.unitId}: considering prior evidence and provider eligibility`);
  const lifecycle = await considerLifecycleResearch(
    {
      workspace: input.workspace,
      config: input.config,
      ...(input.clock !== undefined ? { clock: input.clock } : {}),
      ...(input.idFactory !== undefined ? { idFactory: input.idFactory } : {}),
      ...(input.researchBridge !== undefined ? { bridge: input.researchBridge } : {}),
    },
    {
      phase: 'RUNTIME_INVESTIGATION',
      classification: 'EXTERNAL_KNOWLEDGE_GAP',
      reason: `Investigation WorkUnit ${prepared.unitId} requests material external evidence.`,
      requestedEffect: 'EVIDENCE',
      usedBy: prepared.unitId,
      gate: {
        knowledgeGapDeclared: true,
        dependsOnExternalFacts: true,
        dependsOnCurrentFacts: false,
        materialToProductOrArchitecture: true,
        repositoryAnswerAvailable: false,
        priorResearchAvailable: false,
        engineeringDecisionOnly: false,
        requiresHumanAuthority: false,
        repeatedUnknown: false,
        repeatedUnknownAfterDifferentStrategies: false,
        requestedDepth: 'QUICK',
      },
      request,
      operationId: `${input.jobId}-${prepared.unitId}`.slice(0, 128),
      jobId: input.jobId,
      refreshCurrentFacts: false,
    },
    input.signal,
  );
  if (lifecycle.execution?.ok !== true) {
    input.recordEvent('research_degraded', {
      nodeId: input.node.nodeId,
      workUnitId: prepared.unitId,
      gateDecision: lifecycle.gate.decision,
      failure: lifecycle.execution?.ok === false
        ? lifecycle.execution.failure.classification
        : 'NOT_ELIGIBLE',
      fallback: 'STRONG_REASONING',
    });
    return undefined;
  }
  const report = lifecycle.execution.report;
  input.recordEvent('research_used', {
    nodeId: input.node.nodeId,
    workUnitId: prepared.unitId,
    researchId: lifecycle.execution.record.researchId,
    reused: lifecycle.execution.reused,
    phase: 'RUNTIME_INVESTIGATION',
    authority: 'EVIDENCE_ONLY',
  });
  return {
    prepared,
    result: {
      ok: true,
      output: {
        outcome: 'CANDIDATE_COMPLETE',
        summary: `Research evidence produced for ${unit.title}.`,
        changedFiles: [],
        assumptionsDiscovered: report.unresolved,
        contractChangeRequests: [],
        knownLimitations: [
          ...report.conflicts,
          ...(report.classification.includes('PRODUCT_OPTION')
            ? ['Research exposed a product option; a human decision remains required.']
            : []),
        ],
        report: renderResearchEvidence(report),
        blockingQuestions: [],
      },
      raw: JSON.stringify(report),
    },
    collected: { changedFiles: [], patch: '', protectedViolations: [] },
    researchId: lifecycle.execution.record.researchId,
    countedAsWorker: false,
  };
}

function secondarySelected(
  input: ObjectiveDriveInput,
  unit: Pick<WorkUnit, 'workUnitId' | 'kind'>,
): boolean {
  const selection = input.secondaryBuilder;
  if (selection === undefined || unit.kind !== 'build') return false;
  return selection.workUnitIds === undefined || selection.workUnitIds.includes(unit.workUnitId);
}

function secondaryFailureCategory(kind: SecondaryBuilderFailureKind): FailureCategory {
  switch (kind) {
    case 'CANCELLED':
      return 'CANCELLED';
    case 'STALE_SOURCE_CONTEXT':
    case 'STALE_APPROVED_PROJECTION':
      return 'STALE_CONTEXT';
    case 'FORBIDDEN_EDIT':
      return 'SAFETY_POLICY';
    case 'EMPTY_EDIT_SET':
    case 'INVALID_STRUCTURED_OUTPUT':
    case 'APPLY_FAILURE':
      return 'IMPLEMENTATION_DEFECT';
    case 'VERIFICATION_FAILURE':
      return 'VERIFICATION_FAILURE';
    case 'CONTEXT_TOO_LARGE':
    case 'INSUFFICIENT_CONTEXT':
      return 'CAPABILITY_UNAVAILABLE';
    case 'AMBIGUOUS_TARGET':
      return 'AMBIGUITY';
    case 'TIMEOUT':
      return 'TRANSIENT_TRANSPORT';
    case 'INFERENCE_UNAVAILABLE':
      return 'CAPABILITY_UNAVAILABLE';
  }
}

function readinessFailureCategory(status: SecondaryEligibilityStatus): FailureCategory {
  switch (status) {
    case 'NEEDS_AUTHORITY':
      return 'SAFETY_POLICY';
    case 'NOT_READY':
      return 'BLOCKED_DEPENDENCY';
    case 'NEEDS_CONTEXT':
      return 'AMBIGUITY';
    case 'NEEDS_RESEARCH':
    case 'STRONG_REQUIRED':
      return 'CAPABILITY_UNAVAILABLE';
    case 'ELIGIBLE':
      return 'INTERNAL';
  }
}

function recordSecondaryReadiness(
  context: UnitAttemptContext,
  prepared: PreparedAttempt,
  packet: SecondaryBuilderPacket | undefined,
  compilation: BuilderPacketCompilationResult | undefined,
): SecondaryEligibilityDecision {
  const { input } = context;
  const prior = readWorkReadinessRecord(
    input.workspace,
    input.jobId,
    input.node.nodeId,
    prepared.unitId,
    prepared.attempt,
  );
  const assessedAt = nowIso(input);
  const result = assessAndDecideWorkReadiness(
    {
      jobId: input.jobId,
      objectiveNodeId: input.node.nodeId,
      workUnit: prepared.unit,
      projection: prepared.projection,
      attempt: prepared.attempt,
      parentObjectiveComplexity: input.node.complexity,
      ...(packet !== undefined ? { packet } : {}),
      ...(compilation !== undefined ? { compilation } : {}),
      verificationCommands: input.config.verification.commands,
      missingDependencyIds: prepared.missingDependencyIds,
      researchRecords: listResearchRecords(input.workspace).records,
      assessedAt,
    },
    prior,
  );
  storeWorkReadinessRecord(input.workspace, input.jobId, input.node.nodeId, {
    assessment: result.assessment,
    decision: result.decision,
  });
  storeWorkReadinessTelemetry(
    input.workspace,
    input.jobId,
    input.node.nodeId,
    summarizeWorkReadiness(
      readWorkReadinessRecords(input.workspace, input.jobId, input.node.nodeId),
      assessedAt,
    ),
  );
  input.recordEvent('secondary_readiness_assessed', {
    nodeId: input.node.nodeId,
    workUnitId: prepared.unitId,
    attempt: prepared.attempt,
    assessmentHash: result.assessment.contentHash,
    inputHash: result.assessment.inputHash,
    status: result.decision.status,
    knowledgeState: result.assessment.knowledgeState,
    decisionEntropy: result.assessment.decisionEntropy,
    implementationSpecificity: result.assessment.implementationSpecificity,
    verificationStrength: result.assessment.verificationStrength,
    contextState: result.assessment.contextState,
    repositoryMutationScope: result.assessment.repositoryMutationScope,
    dependencyState: result.assessment.dependencyState,
    authorityRisk: result.assessment.authorityRisk,
    contractMutationRisk: result.assessment.contractMutationRisk,
    reasons: result.decision.reasons.map((entry) => entry.code),
    reused: result.reused,
    routingChanged: false,
  });
  return result.decision;
}

function builderFailureResult(problem: string): Awaited<ReturnType<typeof runLargeObjectiveRole<'BUILDER'>>> {
  return { ok: false, kind: 'worker-unavailable', problem };
}

async function executeSelectedSecondaryBuilder(
  context: UnitAttemptContext,
  prepared: PreparedAttempt,
  worktree: NonNullable<PreparedAttempt['worktree']>,
): Promise<ExecutedAttempt> {
  const { input } = context;
  const selection = input.secondaryBuilder;
  if (selection === undefined) {
    return { prepared, result: builderFailureResult('secondary builder selection disappeared') };
  }

  let packet: SecondaryBuilderPacket | undefined;
  let compilation: BuilderPacketCompilationResult | undefined;
  let repositoryRoots: Readonly<Record<string, string>> = { primary: worktree.dir };
  if (selection.sourceContext !== undefined) {
    try {
      const sourceContext =
        typeof selection.sourceContext === 'function'
          ? await selection.sourceContext({ worktreeRoot: worktree.dir, projection: prepared.projection })
          : selection.sourceContext;
      packet = buildSecondaryBuilderPacket({
        projection: prepared.projection,
        sourceContext,
        verificationHints: input.config.verification.commands.map((command) => command.name),
      });
    } catch (cause) {
      const problem = `source context could not be prepared: ${cause instanceof Error ? cause.message : String(cause)}`;
      return {
        prepared,
        result: builderFailureResult(problem),
        secondaryFailure: { kind: 'STALE_SOURCE_CONTEXT', problem },
      };
    }
  } else {
    const compiler = selection.contextCompiler ?? new SecondaryBuilderContextCompiler();
    let compiled;
    try {
      compiled = await compiler.compile({
        workspace: input.workspace,
        config: input.config,
        jobId: input.jobId,
        objectiveNodeId: input.node.nodeId,
        workUnit: prepared.unit,
        projection: prepared.projection,
        attempt: prepared.attempt,
        worktreeRoot: worktree.dir,
        baselineRef: prepared.baselineCommit,
        dependencyContext: prepared.dependencyContext,
        missingDependencyIds: prepared.missingDependencyIds,
        priorFailureEvidence:
          prepared.unit.latestFailure === undefined
            ? []
            : [`${prepared.unit.latestFailure.category}: ${prepared.unit.latestFailure.message}`],
        verificationHints: input.config.verification.commands.map((command) => command.name),
        maximumInputCharacters: secondaryBuilderInputCeiling(input.config),
        createdAt: nowIso(input),
      });
    } catch (cause) {
      const problem = `builder packet compilation failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      return {
        prepared,
        result: builderFailureResult(problem),
        secondaryFailure: { kind: 'INSUFFICIENT_CONTEXT', problem },
      };
    }
    compilation = compiled;
    input.recordEvent(compiled.ok ? 'context_selected' : 'context_insufficient', {
      nodeId: input.node.nodeId,
      workUnitId: prepared.unitId,
      attempt: prepared.attempt,
      planRefs: compiled.planRefs,
      metrics: compiled.metrics,
      quality: compiled.quality,
      ...(compiled.ok ? {} : { failure: compiled.failure.kind, reasons: compiled.failure.reasons }),
    });
    if (!compiled.ok) {
      const readinessDecision = recordSecondaryReadiness(context, prepared, undefined, compiled);
      const problem = `${compiled.failure.kind}: ${compiled.failure.reasons.join('; ')}`;
      return {
        prepared,
        result: builderFailureResult(problem),
        secondaryFailure: { kind: compiled.failure.kind, problem },
        readinessDecision,
      };
    }
    packet = compiled.packet;
    repositoryRoots = compiled.repositoryRoots;
  }

  if (packet === undefined) {
    return { prepared, result: builderFailureResult('secondary builder packet was not produced') };
  }
  const readinessDecision = recordSecondaryReadiness(context, prepared, packet, compilation);
  if (readinessDecision.status !== 'ELIGIBLE') {
    const problem = [
      `Secondary execution is not eligible: ${readinessDecision.status}`,
      ...readinessDecision.reasons.map((entry) => `${entry.code}: ${entry.message}`),
    ].join('; ').slice(0, 2_000);
    return {
      prepared,
      result: builderFailureResult(problem),
      readinessDecision,
    };
  }

  const inference =
    selection.inference ??
    (input.localManager !== undefined
      ? managedLocalSecondaryModelInference(input.localManager, input.config)
      : undefined);
  const createdAt = nowIso(input);
  let artifact = secondaryBuilderAttemptSchema.parse({
    schemaVersion: SECONDARY_BUILDER_ATTEMPT_SCHEMA_VERSION,
    attemptId: `${prepared.unitId}-a${String(prepared.attempt).padStart(2, '0')}-secondary`,
    jobId: input.jobId,
    objectiveNodeId: input.node.nodeId,
    workUnitId: prepared.unitId,
    attempt: prepared.attempt,
    status: 'PREPARED',
    builderBackend: 'SECONDARY_DIRECT_MODEL',
    selectionReason: selection.selectionReason,
    inferenceProfile: inference?.profile ?? 'localInference',
    provider: inference?.provider ?? input.config.localInference.provider,
    ...(inference?.model !== undefined ? { model: inference.model } : {}),
    packetHash: packet.packetHash,
    sourceContextHash: packet.sourceContextHash,
    packet,
    appliedFiles: [],
    createdAt,
    updatedAt: createdAt,
  });
  const persist = (update: Partial<SecondaryBuilderAttempt>): void => {
    artifact = secondaryBuilderAttemptSchema.parse({ ...artifact, ...update, updatedAt: nowIso(input) });
    storeSecondaryBuilderAttempt(input.workspace, input.jobId, input.node.nodeId, artifact);
  };
  persist({});

  // Reload durable truth immediately before inference. The projection was
  // built from `truth` earlier, but another process may have approved a new
  // contract/constitution revision while source context was assembled.
  const currentTruth = loadMissionTruth(input.workspace, input.mission);
  const freshness = evaluateProjectionFreshness(prepared.projection, {
    contracts: currentTruth.contracts.map((contract) => ({
      contractId: contract.contractId,
      revision: contract.revision,
    })),
    constitutionVersion: currentTruth.constitution?.version ?? 0,
  });
  if (!freshness.fresh) {
    const problem = `approved projection is stale: ${freshness.reasons.join('; ')}`;
    persist({ status: 'FAILED', failure: { kind: 'STALE_APPROVED_PROJECTION', problem } });
    return {
      prepared,
      result: builderFailureResult(problem),
      secondaryAttempt: artifact,
      secondaryFailure: { kind: 'STALE_APPROVED_PROJECTION', problem },
    };
  }

  if (inference === undefined) {
    const problem = 'secondary inference is unavailable: no managed local model or explicit inference was provided';
    persist({ status: 'FAILED', failure: { kind: 'INFERENCE_UNAVAILABLE', problem } });
    return {
      prepared,
      result: builderFailureResult(problem),
      secondaryAttempt: artifact,
      secondaryFailure: { kind: 'INFERENCE_UNAVAILABLE', problem },
    };
  }

  const executed = await executeSecondaryObjectiveBuilder({
    worktreeRoot: worktree.dir,
    packet,
    inference,
    maximumInputCharacters: secondaryBuilderInputCeiling(input.config),
    maxOutputBytes: input.config.localInference.maxOutputBytes,
    protectedPaths: input.config.execution.protectedPaths,
    repositoryRoots,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    onExecutionEvent: (event) => {
      if (event.stage === 'INFERENCE_COMPLETED') {
        persist({
          status: 'INFERENCE_COMPLETED',
          rawOutput: event.rawOutput.slice(0, 1_048_576),
          telemetry: event.telemetry,
        });
      } else if (event.stage === 'PROPOSAL_VALIDATED') {
        persist({ status: 'PROPOSAL_VALIDATED', proposal: event.proposal, telemetry: event.telemetry });
      } else {
        persist({
          status: 'EDITS_APPLIED',
          proposal: event.proposal,
          appliedFiles: event.appliedFiles,
          telemetry: event.telemetry,
        });
      }
    },
  });
  if (!executed.ok) {
    persist({
      status: executed.failure.kind === 'INSUFFICIENT_CONTEXT' ? 'CONTEXT_INSUFFICIENT' : 'FAILED',
      failure: executed.failure,
      ...(executed.rawOutput !== undefined ? { rawOutput: executed.rawOutput.slice(0, 1_048_576) } : {}),
      ...(executed.proposal !== undefined ? { proposal: executed.proposal } : {}),
      appliedFiles: executed.appliedFiles,
      telemetry: executed.telemetry,
    });
    input.recordEvent('secondary_builder_attempted', {
      nodeId: input.node.nodeId,
      workUnitId: prepared.unitId,
      attempt: prepared.attempt,
      backend: 'SECONDARY_DIRECT_MODEL',
      failure: executed.failure.kind,
      durationMs: executed.telemetry.durationMs,
      inputCharacters: executed.telemetry.inputCharacters,
      outputBytes: executed.telemetry.outputBytes,
      inputTokens: executed.telemetry.inputTokens,
      outputTokens: executed.telemetry.outputTokens,
      model: artifact.model ?? null,
      inferenceProfile: artifact.inferenceProfile,
    });
    return {
      prepared,
      result: builderFailureResult(`${executed.failure.kind}: ${executed.failure.problem}`),
      secondaryAttempt: artifact,
      secondaryFailure: executed.failure,
    };
  }

  const collected = await collectWorktreeChanges(worktree, {
    protectedPaths: input.config.execution.protectedPaths,
  });
  const verification = await runWorktreeVerification(
    worktree,
    input.config.verification.commands,
    input.signal,
  );
  if (!verification.passed) {
    persist({
      status: 'VERIFICATION_FAILED',
      failure: { kind: 'VERIFICATION_FAILURE', problem: 'trusted worktree verification failed' },
      verification: {
        ran: verification.ran,
        passed: verification.passed,
        commands: verification.commands.map((command) => ({
          name: command.name,
          status: command.status,
          exitCode: command.exitCode ?? null,
          stdoutTail: command.stdoutTail,
          stderrTail: command.stderrTail,
        })),
      },
    });
  } else {
    persist({
      verification: {
        ran: verification.ran,
        passed: verification.passed,
        commands: verification.commands.map((command) => ({
          name: command.name,
          status: command.status,
          exitCode: command.exitCode ?? null,
          stdoutTail: command.stdoutTail,
          stderrTail: command.stderrTail,
        })),
      },
    });
  }
  input.recordEvent('secondary_builder_attempted', {
    nodeId: input.node.nodeId,
    workUnitId: prepared.unitId,
    attempt: prepared.attempt,
    backend: 'SECONDARY_DIRECT_MODEL',
    candidateProposed: true,
    verificationPassed: verification.passed,
    durationMs: executed.telemetry.durationMs,
    inputCharacters: executed.telemetry.inputCharacters,
    outputBytes: executed.telemetry.outputBytes,
    sourceFiles: executed.telemetry.sourceFiles,
    editedFiles: executed.telemetry.editedFiles,
    inputTokens: executed.telemetry.inputTokens,
    outputTokens: executed.telemetry.outputTokens,
    model: artifact.model ?? null,
    inferenceProfile: artifact.inferenceProfile,
  });
  return {
    prepared,
    result: {
      ok: true,
      output: {
        outcome: 'CANDIDATE_COMPLETE',
        summary: executed.proposal.summary,
        changedFiles: executed.appliedFiles,
        assumptionsDiscovered: [],
        contractChangeRequests: [],
        knownLimitations: executed.proposal.notes ?? [],
        blockingQuestions: [],
      },
      raw: JSON.stringify(executed.proposal),
      usage: {
        inputTokens: executed.telemetry.inputTokens,
        outputTokens: executed.telemetry.outputTokens,
        costUsd: null,
      },
    },
    collected,
    verification,
    secondaryAttempt: artifact,
    ...(!verification.passed
      ? { secondaryFailure: { kind: 'VERIFICATION_FAILURE' as const, problem: 'trusted worktree verification failed' } }
      : {}),
  };
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
  const dependencyContext: VerifiedDependencyContextInput[] = [];
  const missingDependencyIds: string[] = [];
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
      if (candidate.localVerification.passed) {
        dependencyContext.push({
          workUnitId: resolved.workUnitId,
          summary: candidate.claims.summary,
          changedFiles: candidate.changedFiles.map((file) => ({ repositoryId: 'primary', path: file.path })),
          verificationPassed: true,
        });
      } else {
        missingDependencyIds.push(resolved.workUnitId);
      }
    } else {
      missingDependencyIds.push(resolved.workUnitId);
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

  // A configured research investigation is read-only and therefore needs no
  // Git worktree. If research later degrades, executeBuilder creates the
  // ordinary isolated worktree lazily for the existing strong-reasoning path.
  const researchFirst = unit.kind === 'investigation' && input.config.research.enabled;
  const worktree = researchFirst
    ? undefined
    : await createWorkerWorktree({
        workspace: input.workspace,
        jobId: input.jobId,
        workUnitId: unit.workUnitId,
        attempt,
      });
  const baselineCommit = worktree?.baselineCommit ?? await readCanonicalHead(input.workspace);
  const workerId = `${researchFirst ? 'investigator' : 'builder'}-${unit.workUnitId}-a${attempt}`;
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
    workspaceIdentity: worktree === undefined ? 'ephemeral:research' : `worktree:${worktree.name}`,
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
    prepared: {
      unitId,
      unit,
      kind: unit.kind,
      attempt,
      workerId,
      projection,
      ...(worktree !== undefined ? { worktree } : {}),
      baselineCommit,
      record,
      dependencyPatches,
      dependencyContext,
      missingDependencyIds,
    },
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
  const researched = await executeResearchInvestigation(context, prepared);
  if (researched !== undefined) return researched;
  if (prepared.worktree === undefined) {
    prepared.worktree = await createWorkerWorktree({
      workspace: input.workspace,
      jobId: input.jobId,
      workUnitId: prepared.unitId,
      attempt: prepared.attempt,
    });
    input.recordEvent('research_fallback_started', {
      nodeId: input.node.nodeId,
      workUnitId: prepared.unitId,
      fallback: 'STRONG_REASONING',
      workspaceIdentity: `worktree:${prepared.worktree.name}`,
    });
  }
  const worktree = prepared.worktree;
  const useSecondary = secondarySelected(input, {
    workUnitId: prepared.unitId,
    kind: prepared.kind,
  });
  // A dependency patch that no longer applies is an ATTEMPT failure, exactly
  // as applyDependencyPatches's own contract says — never a driver death.
  //
  // The dogfood hit this the ordinary way: wu-2 and wu-3 verified before
  // n-3 integrated; integration moved the shared build files; the fresh
  // worktree for wu-4 then took wu-2's patch with conflicts, the throw went
  // uncaught, and the driver died at the same line on every restart until
  // the supervisor gave up. The failure now folds into the attempt with the
  // thrown category (REPOSITORY_DIVERGED), where recovery can replan the
  // stale sibling instead of the process dying.
  try {
    await applyDependencyPatches(worktree, prepared.dependencyPatches);
  } catch (cause) {
    if (useSecondary) {
      const problem = `dependency candidate application failed before secondary inference: ${cause instanceof Error ? cause.message : String(cause)}`;
      return {
        prepared,
        result: builderFailureResult(problem),
        secondaryFailure: { kind: 'APPLY_FAILURE', problem },
      };
    }
    // The same answer integration already has: one bounded reconciliation by
    // a worker, applying the INTENT of the conflicting sibling patches to
    // this worktree. A conflict is deterministic — retrying the raw apply
    // can only fail identically, which is how three attempts burned on one
    // conflict before this branch existed.
    const message = cause instanceof Error ? cause.message : String(cause);
    input.onProgress?.(
      `dependency patches conflict in ${prepared.unitId}'s worktree; attempting one bounded reconciliation`,
    );
    const packet = [
      `Sibling work units' verified changes must be present in this worktree before ${prepared.unitId} builds, but their patches no longer apply cleanly to the current baseline.`,
      'Apply the INTENT of the patches below with minimal integration edits. Where the baseline already contains an equivalent change, keep the baseline. Change nothing beyond what the patches intend.',
      'Do not touch .kiro/ or .specbridge/. Do not run git commands that rewrite history, push, or merge.',
      '',
      ...prepared.dependencyPatches.flatMap((entry) => [
        `Patch of ${entry.workUnitId}:`,
        fence(entry.patch, 24_000),
        '',
      ]),
      'The apply reported:',
      fence(message.slice(0, 4_000), 4_000),
    ].join('\n');
    const reconcile = await runLargeObjectiveRole({
      workspace: input.workspace,
      config: input.config,
      runnerProfile: input.runnerProfile ?? input.config.defaultRunner,
      role: 'BUILDER',
      packet,
      cwd: worktree.dir,
      scratchDir: path.join(
        jobDir(input.workspace, input.jobId),
        'scratch',
        `${prepared.unitId}-a${prepared.attempt}-depfix`,
      ),
      timeoutMs: input.policy.objectives.builderTimeoutMs,
      signal: input.signal,
      cachedProbe: input.probeCache.probe,
    });
    if (!reconcile.ok || reconcile.output.outcome !== 'CANDIDATE_COMPLETE') {
      // Say why the RECONCILIATION failed, not just why the apply did — the
      // first version reported only the original conflict, which made three
      // identical failures undiagnosable.
      const why = !reconcile.ok
        ? `${reconcile.kind}: ${reconcile.problem.slice(0, 400)}`
        : `worker outcome ${reconcile.output.outcome}: ${(reconcile.output.summary ?? '').slice(0, 300)}`;
      return {
        prepared,
        result: {
          ok: false,
          kind: 'worker-unavailable',
          problem: `dependency reconciliation failed — ${why} (original conflict: ${message.slice(0, 200)})`,
        },
      };
    }
    if (reconcile.probe !== undefined) input.probeCache.probe = reconcile.probe;
  }
  if (useSecondary) {
    return executeSelectedSecondaryBuilder(context, prepared, worktree);
  }
  const packet = buildBuilderPacket({ projection: prepared.projection });
  const result = await runLargeObjectiveRole({
    workspace: input.workspace,
    config: input.config,
    runnerProfile: input.runnerProfile ?? input.config.defaultRunner,
    role: 'BUILDER',
    packet,
    cwd: worktree.dir,
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

  const collected = await collectWorktreeChanges(worktree, {
    protectedPaths: input.config.execution.protectedPaths,
  });
  const verification =
    prepared.kind === 'build' && collected.changedFiles.length > 0
      ? await runWorktreeVerification(worktree, input.config.verification.commands, input.signal)
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

  if (executed.countedAsWorker !== false) {
    input.countWorkerRun({
      role: 'BUILDER',
      workerId,
      outcome: result.ok ? 'succeeded' : result.kind === 'invalid-output' ? 'invalid-output' : 'failed',
      ...(result.ok && result.usage !== undefined ? { usage: result.usage } : {}),
    });
  }

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
        category:
          executed.readinessDecision !== undefined
            ? readinessFailureCategory(executed.readinessDecision.status)
            : executed.secondaryFailure !== undefined
            ? secondaryFailureCategory(executed.secondaryFailure.kind)
            : result.kind === 'cancelled'
              ? 'CANCELLED'
              : 'TRANSIENT_TOOL',
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
    baselineCommit: prepared.baselineCommit,
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
      researchRefs: executed.researchId !== undefined ? [executed.researchId] : [],
    },
    builderProvenance:
      executed.secondaryAttempt !== undefined
        ? {
            backend: 'SECONDARY_DIRECT_MODEL',
            inferenceProfile: executed.secondaryAttempt.inferenceProfile,
            provider: executed.secondaryAttempt.provider,
            ...(executed.secondaryAttempt.model !== undefined
              ? { model: executed.secondaryAttempt.model }
              : {}),
            packetHash: executed.secondaryAttempt.packetHash,
            sourceContextHash: executed.secondaryAttempt.sourceContextHash,
            selectionReason: executed.secondaryAttempt.selectionReason,
            ...(executed.secondaryAttempt.telemetry !== undefined
              ? {
                  durationMs: executed.secondaryAttempt.telemetry.durationMs,
                  inputCharacters: executed.secondaryAttempt.telemetry.inputCharacters,
                  outputBytes: executed.secondaryAttempt.telemetry.outputBytes,
                  inputTokens: executed.secondaryAttempt.telemetry.inputTokens,
                  outputTokens: executed.secondaryAttempt.telemetry.outputTokens,
                }
              : {}),
          }
        : {
            backend: 'LARGE_AGENT',
            inferenceProfile: input.runnerProfile ?? input.config.defaultRunner,
          },
  });
  storeCandidate(input.workspace, input.jobId, input.node.nodeId, candidate, collected.patch, {
    maxCandidateBytes: input.policy.objectives.maxCandidateBytes,
  });
  if (executed.secondaryAttempt !== undefined && verification?.passed === true) {
    executed.secondaryAttempt = storeSecondaryBuilderAttempt(
      input.workspace,
      input.jobId,
      input.node.nodeId,
      secondaryBuilderAttemptSchema.parse({
        ...executed.secondaryAttempt,
        status: 'CANDIDATE_READY',
        updatedAt: nowIso(input),
      }),
    );
    input.recordEvent('secondary_candidate_succeeded', {
      nodeId: input.node.nodeId,
      workUnitId: unitId,
      attempt,
      candidateId: candidate.candidateId,
      packetHash: executed.secondaryAttempt.packetHash,
      model: executed.secondaryAttempt.model ?? null,
    });
  }

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
    if (attempt.worktree !== undefined) {
      await removeWorkerWorktree(input.workspace, input.jobId, attempt.worktree);
    }
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
  // Phase 4 establishes capability, not repair/fallback policy: an
  // explicitly selected secondary attempt runs once. Later phases may make
  // retry and fallback decisions; the generic Objective retry loop must not
  // silently invent them here.
  const budgetLeft =
    !secondarySelected(input, unit) &&
    attempt < input.policy.objectives.maxBuilderAttemptsPerUnit;
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

/**
 * Re-enter evaluation for a unit whose candidate is already on disk.
 *
 * Loads the stored artifacts the interrupted attempt persisted and hands
 * them to the SAME evaluation path a fresh build uses. When any artifact is
 * missing the unit returns to READY for a rebuild rather than failing — a
 * lost file is a reason to rebuild, not a verdict about the work.
 */
async function resumeStoredCandidate(
  context: UnitAttemptContext,
  graph: WorkGraph,
  unitId: string,
): Promise<WorkGraph> {
  const { input } = context;
  const unit = requireUnit(graph, unitId);
  const attempt = Math.max(1, unit.attempt);
  const candidate = readCandidate(input.workspace, input.jobId, input.node.nodeId, unitId, attempt);
  const projection = readProjection(input.workspace, input.jobId, input.node.nodeId, unitId, attempt);
  if (candidate === undefined || projection === undefined) {
    input.recordEvent('candidate_resume_missing', {
      nodeId: input.node.nodeId,
      workUnitId: unitId,
      attempt,
    });
    return persistGraph(input, transitionUnit(graph, unitId, 'READY'));
  }
  const patch = readCandidatePatch(input.workspace, input.jobId, input.node.nodeId, unitId, attempt);
  // Reconcile the unit's evaluation history with what is actually on disk.
  // Ids are numbered from evaluationRefs and the records are immutable; refs
  // that undercount the stored records make the next write collide.
  const stored = readEvaluations(input.workspace, input.jobId, input.node.nodeId, unitId);
  if (stored.length > requireUnit(graph, unitId).evaluationRefs.length) {
    graph = persistGraph(
      input,
      withUnit(graph, {
        ...requireUnit(graph, unitId),
        evaluationRefs: stored.map((record) => `evaluations/${record.evaluationId}.json`).slice(-20),
      }),
    );
  }

  // A deterministic verdict already stored for this attempt is a FACT, not
  // something to recompute: the record is immutable (so re-running collides
  // on its id — that collision killed the driver in a loop), and the verdict
  // is a pure function of stored inputs, so recomputation could only agree.
  // Resume downstream of it instead.
  const priorDeterministic = stored.find(
    (record) => record.attempt === attempt && record.layer === 'deterministic',
  );
  if (priorDeterministic !== undefined) {
    if (priorDeterministic.verdict !== 'PASS') {
      // A stored non-PASS cannot resume into evaluation; the candidate is
      // already judged. Back to READY for a rebuild.
      graph = persistGraph(input, transitionUnit(graph, unitId, 'REJECTED'));
      return persistGraph(input, transitionUnit(graph, unitId, 'READY'));
    }
    if (
      !semanticEvaluationRequired(
        input.policy.objectives.semanticEvaluation,
        requireUnit(graph, unitId),
        candidate,
        priorDeterministic,
      )
    ) {
      return persistGraph(input, transitionUnit(graph, unitId, 'VERIFIED_CANDIDATE'));
    }
    input.onProgress?.(
      `resuming semantic evaluation for ${unitId} (deterministic verdict already stored)`,
    );
    return persistGraph(input, transitionUnit(graph, unitId, 'EVALUATING'));
  }
  input.onProgress?.(`resuming stored candidate for ${unitId} (attempt ${attempt})`);
  return evaluateCandidate(context, graph, unitId, attempt, candidate, projection, patch);
}

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

/**
 * The deterministic check a blocking semantic reason wrongly re-adjudicates,
 * if any.
 *
 * Narrow on purpose: only a BLOCKING verdict is screened, and only a reason
 * that names a check the deterministic record shows as PASSED while calling
 * it failed. Anything subtler is the evaluator's honest judgment and stands.
 */
function deterministicReadjudication(
  output: EvaluatorOutput,
  deterministic: EvaluationRecord,
): string | undefined {
  if (output.verdict !== 'FAIL' && output.verdict !== 'CONFLICT') return undefined;
  const passed = deterministic.checks.filter((check) => check.passed).map((check) => check.name);
  for (const reason of output.reasons) {
    for (const name of passed) {
      if (!reason.includes(name)) continue;
      const claimsFailed = new RegExp(
        `${name}[^.]{0,80}(FAILED|failed)|deterministic[^.]{0,80}${name}`,
      ).test(reason) && /FAILED|failed/.test(reason);
      if (claimsFailed) return name;
    }
  }
  return undefined;
}

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
  // The deterministic verdict for this attempt, stored if it exists —
  // recomputed only when it does not (the first pass, moments after the
  // build, when live truth IS build truth).
  //
  // Recomputing against LIVE truth broke identity binding for any candidate
  // that outlived a truth append: n-3 completed, the mission recorded its
  // facts, every projection hash moved, and n-4's stored candidate — built
  // and deterministically PASSED against the truth of its own build — began
  // failing identity binding on every semantic resume. The evaluator then
  // reported that mismatch, verbatim and honestly, and was read as
  // fabricating; the burn was blamed on the messenger. Sibling progress must
  // not invalidate in-flight work: identity binds a candidate to the
  // snapshot it was BUILT against, and whether moved truth demands a rebuild
  // is the projection-freshness check's question, answered by what actually
  // changed (contract revisions, constitution version) rather than by any
  // byte of the world having moved.
  const storedDeterministic = readEvaluations(
    input.workspace,
    input.jobId,
    input.node.nodeId,
    unitId,
  ).find((record) => record.attempt === attempt && record.layer === 'deterministic');
  const deterministicRecord =
    storedDeterministic ??
    evaluateDeterministically({
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
    question:
      `Does this candidate satisfy work unit "${unit.title}" without contradicting the approved contracts?` +
      // A recorded human decision resolves a prior NEEDS_DECISION. Shown to
      // the evaluator so it does not ask the same question a second time —
      // an evaluator given nothing new will conclude nothing new.
      (unit.operatorDecision !== undefined
        ? ` A recorded operator decision resolves the prior NEEDS_DECISION and is binding: ${unit.operatorDecision}`
        : ''),
  });
  input.onProgress?.(`EVALUATOR on ${selection.worker.workerId} for ${unitId}`);
  const runLarge = async (
    packetOverride?: string,
  ): Promise<Awaited<ReturnType<typeof runLargeObjectiveRole>>> => {
    const large = await runLargeObjectiveRole({
      workspace: input.workspace,
      config: input.config,
      runnerProfile: selection.worker.runnerProfile ?? input.config.defaultRunner,
      role: 'EVALUATOR',
      packet: packetOverride ?? packet,
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
  let output: EvaluatorOutput = result.output;
  // A semantic verdict may not overturn the deterministic layer. The
  // deterministic checks ran real comparisons; the evaluator only READS
  // them. In the dogfood the evaluator asserted, three attempts running,
  // that the identity-binding check had FAILED while its own evidence
  // packet said "passed" — a fabricated blocking reason that cost the unit
  // its whole attempt budget. A reason that re-adjudicates a passed check
  // gets one bounded re-ask naming the contradiction; if the re-ask stands
  // its ground the verdict is kept, because a screen must not become a
  // rubber stamp in the other direction.
  const reaskEvaluator = async (correction: string): Promise<EvaluatorOutput | undefined> => {
    const followUp = `${packet}

CORRECTION REQUIRED:
${correction}`;
    const second =
      ranLocally && input.localManager !== undefined
        ? await runLocalObjectiveRole({
            manager: input.localManager,
            config: input.config,
            role: 'EVALUATOR',
            packet: followUp,
            maxCorrections: input.policy.maxLocalOutputCorrections,
            onInferenceCall: () => undefined,
            signal: input.signal,
          })
        : await runLarge(followUp);
    input.countWorkerRun({
      role: 'EVALUATOR',
      workerId: selection.worker.workerId,
      outcome: second.ok ? 'succeeded' : 'failed',
      ...(second.ok && second.usage !== undefined ? { usage: second.usage } : {}),
    });
    return second.ok ? (second.output as EvaluatorOutput) : undefined;
  };
  const contradiction = deterministicReadjudication(output, deterministicRecord);
  if (contradiction !== undefined) {
    input.recordEvent('evaluation_contradiction_screened', {
      nodeId: input.node.nodeId,
      workUnitId: unitId,
      attempt,
      check: contradiction,
    });
    input.onProgress?.(
      `EVALUATOR re-adjudicated settled deterministic check "${contradiction}" for ${unitId}; re-asking once`,
    );
    const reasked = await reaskEvaluator(
      `Your previous answer claimed the deterministic "${contradiction}" check FAILED. ` +
        `The deterministic evidence in your packet says it PASSED, and that layer ran the real ` +
        `comparison — it is settled fact. Re-judge on semantic grounds only. ` +
        `If nothing else blocks, say so.`,
    );
    if (reasked !== undefined) output = reasked;
  }
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
export function acceptanceForObjective(
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
      // A mission-level success criterion assigned to this objective by the
      // compiler. Resolved from the mission itself so the statement is
      // byte-identical to the sealed acceptance criterion it closes.
      const successCriterion = /^mission\/sc\/(\d+)$/.exec(source);
      if (successCriterion !== null) {
        const statement = mission.successCriteria[Number.parseInt(successCriterion[1] ?? '', 10)];
        if (statement !== undefined) statements.push(statement);
        continue;
      }
      const [contractId, , itemId] = source.split('/');
      const contract = contracts.find((candidate) => candidate.contractId === contractId);
      if (contract === undefined) continue;
      const requirement = contract.requirements.find((candidate) => candidate.requirementId === itemId);
      if (requirement !== undefined) statements.push(requirement.statement);
      const invariant = contract.invariants.find((candidate) => candidate.invariantId === itemId);
      if (invariant !== undefined) statements.push(invariant.statement);
    }
    // High enough that no objective's real criteria are ever cut: a dropped
    // line here silently breaks closure attribution for that criterion.
    return statements.slice(0, 80);
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
  // FAILED counts too: a unit whose bounded attempts ran out while it was
  // waiting on a person is still waiting on a person. Reporting it as an
  // implementation defect burned four task attempts on re-observing the same
  // stale unit — each dispatch did no work, spent an attempt, and the job
  // ended BUDGET_EXHAUSTED with the human's answer already recorded.
  const blockedUnits = graph.units.filter(
    (unit) => unit.status === 'BLOCKED' || unit.status === 'FAILED',
  );
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
        if (unit.status === 'BUILDING') {
          const candidate = readCandidate(
            input.workspace,
            input.jobId,
            input.node.nodeId,
            unit.workUnitId,
            unit.attempt,
          );
          const projection = readProjection(
            input.workspace,
            input.jobId,
            input.node.nodeId,
            unit.workUnitId,
            unit.attempt,
          );
          const worker = workerRecords.find(
            (record) =>
              record.workUnitId === unit.workUnitId &&
              record.attempt === unit.attempt &&
              record.agentRole === 'BUILDER',
          );
          const patchPresent =
            candidate?.patchRef === undefined ||
            readCandidatePatch(
              input.workspace,
              input.jobId,
              input.node.nodeId,
              unit.workUnitId,
              unit.attempt,
            ) !== undefined;
          const identityMatches =
            candidate !== undefined &&
            projection !== undefined &&
            worker !== undefined &&
            (worker.status === 'RUNNING' || worker.status === 'FINISHED') &&
            candidate.jobId === input.jobId &&
            candidate.objectiveNodeId === input.node.nodeId &&
            candidate.workUnitId === unit.workUnitId &&
            candidate.attempt === unit.attempt &&
            candidate.workerId === unit.workerId &&
            candidate.workerId === worker.workerId &&
            candidate.contextProjectionHash === unit.contextProjectionHash &&
            candidate.contextProjectionHash === projection.contentHash &&
            candidate.contextProjectionHash === worker.contextProjectionHash &&
            candidate.contractSnapshotHash === unit.contractSnapshotHash &&
            candidate.contractSnapshotHash === projection.contractSnapshotHash &&
            candidate.contractSnapshotHash === worker.contractSnapshotHash &&
            patchPresent;

          // `storeCandidate` happens before the worker/graph completion
          // markers. If the process dies in that narrow window, the complete
          // identity-bound candidate is the durable continuation point. Do
          // not spend another builder attempt merely because the status write
          // was interrupted. A partial/mismatched artifact still falls
          // through to the ordinary BUILDING -> READY reconciliation below.
          if (identityMatches) {
            if (worker.status === 'RUNNING') {
              const accepted = acceptWorkerResult(
                input.workspace,
                input.jobId,
                input.node.nodeId,
                graph,
                {
                  workerId: candidate.workerId,
                  agentRole: 'BUILDER',
                  workUnitId: unit.workUnitId,
                  attempt: unit.attempt,
                  contextProjectionHash: candidate.contextProjectionHash,
                  contractSnapshotHash: candidate.contractSnapshotHash,
                },
              );
              if (!accepted.ok) {
                supersedeWorkers(
                  input.workspace,
                  input.jobId,
                  input.node.nodeId,
                  workerRecords,
                  unit.workUnitId,
                  nowIso(input),
                );
                reconciled = transitionUnit(reconciled, unit.workUnitId, 'READY');
                continue;
              }
              finishWorker(input.workspace, accepted.record, 'FINISHED', nowIso(input));
            }
            reconciled = transitionUnit(reconciled, unit.workUnitId, 'CANDIDATE_READY');
            reconciled = withUnit(reconciled, {
              ...requireUnit(reconciled, unit.workUnitId),
              candidateRef: `candidates/${candidate.candidateId}.json`,
            });
            if (
              candidate.builderProvenance?.backend === 'SECONDARY_DIRECT_MODEL' &&
              candidate.localVerification.passed
            ) {
              const secondaryAttempt = readSecondaryBuilderAttempt(
                input.workspace,
                input.jobId,
                input.node.nodeId,
                unit.workUnitId,
                unit.attempt,
              );
              if (secondaryAttempt !== undefined && secondaryAttempt.status !== 'CANDIDATE_READY') {
                storeSecondaryBuilderAttempt(
                  input.workspace,
                  input.jobId,
                  input.node.nodeId,
                  secondaryBuilderAttemptSchema.parse({
                    ...secondaryAttempt,
                    status: 'CANDIDATE_READY',
                    updatedAt: nowIso(input),
                  }),
                );
              }
            }
            input.recordEvent('candidate_ready', {
              nodeId: input.node.nodeId,
              workUnitId: unit.workUnitId,
              attempt: unit.attempt,
              changedFiles: candidate.changedFiles.length,
              localVerificationPassed: candidate.localVerification.passed,
              resumed: true,
            });
            continue;
          }
        }
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

    // A unit holding a stored candidate resumes into evaluation here.
    //
    // This state was invisible to the loop: CANDIDATE_READY units are not
    // READY (never dispatched), not EVALUATING (not resumed above), and not
    // final (aggregation counts them as pending) — so a drive that found one
    // had nothing to do and fell through to failureFromAggregation, which
    // burned a task attempt on "unit(s) still in progress". Five attempts
    // died that way in the vNext.10.1 dogfood, on a unit whose candidate was
    // sound and whose ambiguity a person had already resolved. The same hole
    // swallowed any unit whose process died between the deterministic and
    // semantic evaluation layers.
    //
    // Evaluating a stored candidate consumes NO builder attempt: the bound
    // gates BUILDING, and this unit is past building.
    const candidateReady = graph.units.find((unit) => unit.status === 'CANDIDATE_READY');
    if (candidateReady !== undefined) {
      graph = await resumeStoredCandidate(context, graph, candidateReady.workUnitId);
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
        if (prepared.worktree !== undefined) {
          await removeWorkerWorktree(input.workspace, input.jobId, prepared.worktree);
        }
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
    // Reconciling a conflicting candidate is a BUILD-sized job, not a
    // question-sized one: the worker reads the conflict, understands two
    // change sets, and re-applies one against the other in a real
    // repository. The default 10-minute ceiling killed four reconciliations
    // in a row on the dogfood — same fingerprint, one attempt each — while
    // the operator's configured builder timeout sat at an hour. The
    // reconciliation now gets the same budget a build gets.
    reconcileTimeoutMs: input.policy.objectives.builderTimeoutMs,
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
