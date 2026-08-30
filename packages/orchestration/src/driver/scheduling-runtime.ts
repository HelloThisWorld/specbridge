import type {
  AdaptiveSchedulerPolicy,
  AgentConfig,
  JobSchedulerPolicy,
  LocalExecutionMode,
  WorkspaceInfo,
} from '@specbridge/core';
import { validateLocalInferenceConfig } from '@specbridge/core';
import type { ContextStrategy } from '@specbridge/context';
import { estimateTokens, usableInputTokens } from '@specbridge/context';
import type { LocalModelManager } from '@specbridge/runners';
import type { JobDeps } from '../jobs/job-service.js';
import type { LaneSchedulingContext } from '../jobs/scheduler.js';
import type { JobGraph, JobNode, JobState } from '../jobs/state.js';
import type { QuotaForecast } from '../quota/state.js';
import type { QuotaTelemetryProvider } from '../quota/telemetry.js';
import { resolveQuotaTelemetryProvider } from '../quota/telemetry.js';
import { SubscriptionQuotaManager, buildQuotaForecast } from '../quota/manager.js';
import { deriveBurnObservations, observedFiveHourBurnRate } from '../quota/observations.js';
import { readExecutionLedger } from '../survival/service.js';
import { listTaskAttempts, readLatestTaskCheckpoint } from '../survival/store.js';
import { contextBudgetFromPolicy } from '../survival/reconstruction.js';
import type { DynamicReserveResult } from '../scheduling/reserve.js';
import { computeDynamicReserve } from '../scheduling/reserve.js';
import type { NodeLaneRouting } from '../scheduling/scheduler.js';
import { applyApiGapBridge, decideLane } from '../scheduling/scheduler.js';
import type { ApiHarnessBinding } from '../scheduling/api-binding.js';
import { resolveApiHarnessBinding } from '../scheduling/api-binding.js';
import { estimateApiCost } from '../scheduling/api-cost.js';
import { buildSubscriptionGapForecast, subscriptionGapReasonFor } from '../scheduling/api-gap.js';
import { assessDelaySensitivity } from '../scheduling/delay-sensitivity.js';
import { assessApiBudget, readApiBudgetState } from '../scheduling/api-budget.js';
import { checkApiSpendApproval, listApiSpendApprovals, taskSpendFingerprint } from '../scheduling/api-approval.js';
import { planApiGapBridge } from '../scheduling/api-gap-bridge.js';
import { classifyLocalSuitability } from '../scheduling/suitability.js';
import { estimateWorkload } from '../scheduling/profiler.js';
import type { LocalExecutorInference } from '../scheduling/local-execution.js';
import { managedLocalInference } from '../scheduling/local-execution.js';
import type { LocalHarnessBinding } from '../scheduling/local-binding.js';
import { resolveLocalHarnessBinding } from '../scheduling/local-binding.js';
import { classifyLocalExecutionShape } from '../scheduling/execution-shape.js';
import { resolveLocalExecutionMode } from '../scheduling/local-resolver.js';
import { readTaskReliabilityState } from '../reliability/store.js';
import type { AdaptiveProfileSet } from '../adaptive/profiles.js';
import type { AdaptiveRanking } from '../adaptive/ranking.js';
import { rankCandidates } from '../adaptive/ranking.js';
import { generateCandidates } from '../adaptive/candidates.js';
import { buildTaskSignature } from '../adaptive/signature.js';
import type { TaskSignature } from '../adaptive/signature.js';
import { loadAdaptiveProfiles } from '../adaptive/service.js';
import type { LoadedAdaptiveProfiles } from '../adaptive/service.js';

/**
 * The driver's scheduling runtime (vNext.2): gathers everything the pure
 * lane scheduler needs — telemetry forecast, dynamic reserve, per-node
 * suitability/estimate/routing — from durable state and configuration, once
 * per scheduling pass.
 *
 * Everything here is DERIVED: after a restart the same durable inputs
 * (telemetry file, attempts, checkpoints, config, clock) rebuild the same
 * context, so scheduler state never needs its own persistence beyond the
 * decision records and events already written.
 */

export interface SchedulingRuntimeOptions {
  /** Test seam: overrides the configured telemetry provider. */
  quotaTelemetryProvider?: QuotaTelemetryProvider | undefined;
  /** Test seam: overrides the managed local inference for execution. */
  localExecutorInference?: LocalExecutorInference | undefined;
  /**
   * vNext.4 diagnostic override: force one LOCAL execution mode for every
   * eligible local dispatch in this run (controlled A/B evaluation).
   * It cannot pull STRONG_REQUIRED work local and cannot bypass locality
   * verification — an unusable harness still refuses.
   */
  localExecutionMode?: LocalExecutionMode | undefined;
  signal?: AbortSignal | undefined;
}

export interface SchedulingRuntime {
  policy: JobSchedulerPolicy;
  manager: SubscriptionQuotaManager;
  /** Local execution inference, when the local lane can mutate source. */
  localInference: LocalExecutorInference | undefined;
  localWorkerAvailable: boolean;
  localExecutionAvailable: boolean;
  /** vNext.4: the direct structured-inference path is usable. */
  localDirectAvailable: boolean;
  /** vNext.4: the LOCAL lane's harness binding (verified locality included). */
  harnessBinding: LocalHarnessBinding;
  /** vNext.4: explicit per-run mode override, when one was requested. */
  localExecutionOverride: LocalExecutionMode | undefined;
  /** vNext.5: the API lane's harness binding (verified REMOTE locality). */
  apiBinding: ApiHarnessBinding;
  /**
   * vNext.5: whether the gap-bridge planner is consulted at all this run.
   *
   * True whenever an API profile is CONFIGURED — including when spending is
   * DISABLED or the binding fails verification. That is deliberate: an
   * operator who configured an API lane needs to know why a task is waiting
   * instead of using it, and "API_DISABLED" is a far better answer than a
   * bare quota defer. The planner cannot spend in those states; it can only
   * explain.
   *
   * False when nothing is bound at all, in which case no planner runs, no
   * `api_*` event is emitted, and behavior is byte-identical to vNext.4.
   */
  apiBridgeEnabled: boolean;
  /** True while a subscription worker exists in the roster at all. */
  subscriptionWorkerAvailable: boolean;
  verificationAvailable: boolean;
  /**
   * Mission objectives own a finer WorkUnit candidate set. During a Strong
   * cooldown the outer scheduler may enter that controller so it can run
   * Secondary/research candidates instead of globally deferring the node.
   */
  missionDriven: boolean;
  /**
   * vNext.8 adaptive compute scheduler.
   *
   * `adaptiveEnabled` is false in HEURISTIC mode, and when it is false no
   * profile is loaded, no prediction is computed, no adaptive record is
   * written, and no event is emitted — the pass is byte-identical to
   * vNext.7. That is the operational rollback switch, and it costs one
   * configuration value to pull.
   */
  adaptivePolicy: AdaptiveSchedulerPolicy;
  adaptiveEnabled: boolean;
  /** The context strategy in force (vNext.7). Recorded, never chosen here. */
  contextStrategy: ContextStrategy;
  /** Best-effort identity of the runner/model the DIRECT local path uses. */
  localDirectRunner: string | null;
  localDirectModel: string | null;
  /** Mode/reserve/freshness seen by the previous pass (event dedup). */
  lastMode: string | undefined;
  lastReserveRatio: number | undefined;
  lastFreshness: string | undefined;
  lastObservedAt: string | null | undefined;
}

/**
 * Build the per-driver-run scheduling runtime, or undefined when lane
 * scheduling is disabled (vNext.1 behavior applies unchanged).
 *
 * `missionDriven` disables the local EXECUTION lane: objective work units
 * run through the objectives runtime (isolated builder worktrees +
 * evaluation), where local building is a later, separately reviewed step.
 * Local read-only reasoning roles are unaffected either way.
 */
export function createSchedulingRuntime(
  config: AgentConfig,
  workspace: WorkspaceInfo,
  input: {
    localManager: LocalModelManager | undefined;
    missionDriven: boolean;
    /** vNext.5: whether the roster has a subscription-tier worker at all. */
    subscriptionWorkerAvailable?: boolean | undefined;
    options?: SchedulingRuntimeOptions | undefined;
  },
): SchedulingRuntime | undefined {
  const policy = config.orchestration.jobs.scheduler;
  if (!policy.enabled) return undefined;

  const localValid = config.localInference.enabled && validateLocalInferenceConfig(config.localInference).ok;
  const injectedInference = input.options?.localExecutorInference;
  const localInference =
    injectedInference ??
    (localValid && input.localManager !== undefined
      ? managedLocalInference(input.localManager, config, input.options?.signal)
      : undefined);
  const localWorkerAvailable = localValid || injectedInference !== undefined;
  const localDirectAvailable =
    localWorkerAvailable &&
    localInference !== undefined &&
    policy.allowLocalExecution &&
    !input.missionDriven;
  // vNext.4: the harness is an execution MODE inside the LOCAL lane, never a
  // lane of its own. It widens what the local lane can do; it can never
  // decide that work belongs to the local lane, and it is inert under the
  // DIRECT_ONLY default and in mission-driven runs.
  const harnessBinding = resolveLocalHarnessBinding(config);
  const harnessUsable =
    harnessBinding.available &&
    policy.localExecution.strategy !== 'DIRECT_ONLY' &&
    policy.allowLocalExecution &&
    !input.missionDriven;
  const localExecutionAvailable =
    localWorkerAvailable && (localDirectAvailable || harnessUsable);

  // vNext.5: the paid continuity bridge. Three INDEPENDENT controls must
  // all be right before it can spend: an API profile must exist and verify
  // REMOTE, it must be explicitly BOUND to the lane, and spending must be
  // AUTHORIZED. Missing any one leaves vNext.4 behavior exactly in place —
  // which is what makes an upgraded workspace incapable of surprising its
  // owner with a bill.
  const apiBinding = resolveApiHarnessBinding(config);
  const apiBridgeEnabled = policy.api.harnessProfile !== null;

  const provider =
    input.options?.quotaTelemetryProvider ??
    resolveQuotaTelemetryProvider(workspace, policy.telemetrySource);

  return {
    policy,
    manager: new SubscriptionQuotaManager({ provider, policy }),
    localInference,
    localWorkerAvailable,
    localExecutionAvailable,
    localDirectAvailable,
    harnessBinding,
    localExecutionOverride: input.options?.localExecutionMode,
    apiBinding,
    apiBridgeEnabled,
    subscriptionWorkerAvailable: input.subscriptionWorkerAvailable ?? true,
    verificationAvailable: config.verification.commands.length > 0,
    missionDriven: input.missionDriven,
    adaptivePolicy: policy.adaptive,
    adaptiveEnabled: policy.adaptive.mode !== 'HEURISTIC',
    contextStrategy: config.orchestration.jobs.context.efficiency.strategy as ContextStrategy,
    // The runner that will actually record a DIRECT attempt is chosen with
    // the worker, after this point. `defaultRunner` is the best identity
    // available at scheduling time; when it turns out not to match, the
    // exact profile simply misses and the coarser lane/mode level answers —
    // which is what the fallback hierarchy is for.
    localDirectRunner: config.defaultRunner,
    localDirectModel: config.localInference.model ?? null,
    lastMode: undefined,
    lastReserveRatio: undefined,
    lastFreshness: undefined,
    lastObservedAt: undefined,
  };
}

/**
 * Estimate a node's durable-context occupancy: the checkpoint-backed state
 * a fresh dispatch would reconstruct, relative to the configured budget.
 * Deterministic and cheap; null when the node has no checkpoint yet.
 */
export function estimateNodeContextRatio(
  deps: JobDeps,
  jobId: string,
  nodeId: string,
): number | null {
  const checkpoint = readLatestTaskCheckpoint(deps.workspace, jobId, nodeId);
  if (checkpoint === undefined) return null;
  const budget = contextBudgetFromPolicy(deps.config.orchestration.jobs.context);
  const usable = usableInputTokens(budget);
  const serialized = JSON.stringify({
    objective: checkpoint.objective,
    pinned: checkpoint.pinned,
    completedWork: checkpoint.completedWork,
    pendingWork: checkpoint.pendingWork,
    importantDecisions: checkpoint.importantDecisions,
    failedApproaches: checkpoint.failedApproaches,
    changedFiles: checkpoint.changedFiles,
    testResults: checkpoint.testResults,
    knownFailures: checkpoint.knownFailures,
    unresolvedIssues: checkpoint.unresolvedIssues,
    nextActions: checkpoint.nextActions,
  });
  return Math.round((estimateTokens(serialized) / usable) * 10_000) / 10_000;
}

/** LOCAL-lane executor attempts already spent on a node (durable count). */
export function localExecutorAttemptsUsed(
  deps: JobDeps,
  jobId: string,
  nodeId: string,
): number {
  return listTaskAttempts(deps.workspace, jobId, { nodeId }).filter(
    (attempt) =>
      attempt.lane === 'LOCAL' &&
      attempt.role === 'EXECUTOR' &&
      (attempt.status === 'FAILED' || attempt.status === 'INTERRUPTED'),
  ).length;
}

/**
 * Sticky local-escalation reasons recorded for a node: once one of these is
 * on record, the node never routes back to the LOCAL lane in ANY execution
 * mode. `LOCAL_DIRECT_TO_HARNESS` is deliberately NOT here — it is a
 * LOCAL → LOCAL mode transition, not an escalation off the lane.
 */
const LOCAL_ESCALATION_REASONS: readonly string[] = [
  'INVALID_LOCAL_OUTPUT',
  'REPEATED_LOCAL_FAILURE',
  'LOCAL_EXECUTION_ESCALATED',
];

/** The durable marker that a direct attempt asked for repository tools. */
const DIRECT_TO_HARNESS_REASON = 'LOCAL_DIRECT_TO_HARNESS';

export interface BuiltLaneContext {
  context: LaneSchedulingContext;
  forecast: QuotaForecast;
  reserve: DynamicReserveResult;
  /**
   * A PENDING LOCAL-lane node whose only unfinished predecessors are
   * quota-DEFERRED strong nodes. The driver promotes it (recorded) so local
   * work continues while the subscription lane cools down — the ordering
   * chain is a preference, and deterministic verification stays the arbiter.
   */
  overtakeCandidate: { nodeId: string; detail: string } | undefined;
  /**
   * vNext.8: the adaptive evaluation for this pass, present only when the
   * adaptive scheduler is enabled. Absent in HEURISTIC mode, and absent when
   * the profile store could not be loaded — in both cases the routings above
   * are exactly what vNext.7 would have produced.
   */
  adaptive?:
    | {
        profiles: AdaptiveProfileSet;
        source: LoadedAdaptiveProfiles['source'];
        invalidatedReason: LoadedAdaptiveProfiles['invalidatedReason'];
        jobsScanned: number;
        /** Per-node ranking, keyed by nodeId. */
        rankings: Map<string, AdaptiveRanking>;
        /** Per-node task signature, keyed by nodeId. */
        signatures: Map<string, TaskSignature>;
      }
    | undefined;
}

/**
 * Build the lane-scheduling context for one pass: read telemetry, derive
 * the forecast (with the ledger-observed burn rate), compute the dynamic
 * reserve, and assess every READY node (plus the deferred-prefix PENDING
 * nodes, for the local-continues-during-cooldown promotion).
 */
export async function buildLaneContext(
  runtime: SchedulingRuntime,
  deps: JobDeps,
  jobId: string,
  job: JobState,
  graph: JobGraph | undefined,
): Promise<BuiltLaneContext> {
  const ledger = readExecutionLedger(deps.workspace, jobId);
  const observations = deriveBurnObservations(ledger);
  const { fiveHour, weekly } = await runtime.manager.snapshot();
  const forecast = buildQuotaForecast({
    fiveHour,
    weekly,
    now: (deps.clock ?? (() => new Date()))(),
    policy: runtime.policy,
    observedFiveHourBurnRatePerMinute: observedFiveHourBurnRate(observations),
  });

  const reserve = computeDynamicReserve({
    forecast,
    policy: runtime.policy.reserve,
    weeklyPressureRatio: runtime.policy.weeklyPressureRatio,
  });

  const routings = new Map<string, NodeLaneRouting>();
  const ready = (graph?.nodes ?? []).filter((node) => node.status === 'READY');
  for (const node of ready) {
    routings.set(node.nodeId, assessNode(runtime, deps, jobId, job, node, forecast, reserve, observations));
  }

  // vNext.5: the API gap bridge runs as a SECOND pass, after every ready
  // node already has a lane. That ordering is what lets the planner see the
  // whole picture it needs — which other tasks could run locally right now,
  // and whether anything at all can proceed — and it structurally
  // guarantees the paid lane is only ever considered for work LOCAL and
  // SUBSCRIPTION have both already refused.
  if (runtime.apiBridgeEnabled && ready.length > 0) {
    const readyLocalNodeIds = ready
      .filter((node) => routings.get(node.nodeId)?.routing.lane === 'LOCAL')
      .map((node) => node.nodeId);
    const readyRunnableNodeIds = ready
      .filter((node) => {
        const lane = routings.get(node.nodeId)?.routing.lane;
        return lane !== undefined && lane !== 'DEFER' && lane !== 'REQUIRE_APPROVAL';
      })
      .map((node) => node.nodeId);
    for (const node of ready) {
      const assessment = routings.get(node.nodeId);
      if (assessment === undefined || assessment.routing.lane !== 'DEFER') continue;
      const bridged = assessApiGapBridge(runtime, deps, jobId, job, node, assessment, {
        forecast,
        readyLocalNodeIds,
        readyRunnableNodeIds,
        graph,
        now: (deps.clock ?? (() => new Date()))(),
      });
      if (bridged !== undefined) routings.set(node.nodeId, bridged);
    }
  }

  // Overtake scan: walk the graph prefix in which every node is COMPLETED,
  // SUPERSEDED, or assessed as quota-DEFERRED. The first PENDING node in
  // that prefix that would route LOCAL becomes the promotion candidate.
  let overtakeCandidate: BuiltLaneContext['overtakeCandidate'];
  if (graph !== undefined && ready.some((node) => routings.get(node.nodeId)?.routing.lane === 'DEFER')) {
    for (const node of graph.nodes) {
      if (node.status === 'COMPLETED' || node.status === 'SUPERSEDED') continue;
      if (node.status === 'READY') {
        if (routings.get(node.nodeId)?.routing.lane === 'DEFER') continue;
        break; // A runnable ready node ends the deferred-only prefix.
      }
      if (node.status !== 'PENDING') break;
      const assessment = assessNode(runtime, deps, jobId, job, node, forecast, reserve, observations);
      if (assessment.routing.lane === 'LOCAL') {
        routings.set(node.nodeId, assessment);
        overtakeCandidate = {
          nodeId: node.nodeId,
          detail: `Predecessors are quota-deferred; ${assessment.suitability.class} task ${node.parentTaskId} runs locally in the meantime.`,
        };
        break;
      }
      // A PENDING node that would itself defer extends the prefix; a
      // strong-but-runnable one ends the scan.
      if (assessment.routing.lane !== 'DEFER') break;
    }
  }

  // vNext.8: the adaptive pass runs LAST, over routings hard policy has
  // already fixed. It can reorder how an eligible lane is spent; it cannot
  // reach a lane that was refused, and by the time it runs every lane
  // decision on the map is final.
  const adaptive = runtime.adaptiveEnabled
    ? applyAdaptiveRanking(runtime, deps, jobId, job, ready, routings, forecast)
    : undefined;

  return {
    context: {
      policy: runtime.policy,
      forecast,
      reserveRatio: reserve.ratio,
      routings,
      ...(runtime.missionDriven
        ? { resourceAwareObjectiveNodes: new Set(ready.map((node) => node.nodeId)) }
        : {}),
    },
    forecast,
    reserve,
    overtakeCandidate,
    adaptive,
  };
}

/**
 * Rank each ready node's eligible candidates against observed history and,
 * in ADAPTIVE mode, apply the result.
 *
 * The ONLY mutation this function may perform on a routing is the LOCAL
 * execution MODE — the single dimension where a genuine within-lane choice
 * exists in this checkout. It never writes `routing.lane`, never touches the
 * gap-bridge plan, and never revisits an admission decision. A reader can
 * confirm that by looking at what it assigns.
 */
function applyAdaptiveRanking(
  runtime: SchedulingRuntime,
  deps: JobDeps,
  jobId: string,
  job: JobState,
  ready: readonly JobNode[],
  routings: Map<string, NodeLaneRouting>,
  forecast: QuotaForecast,
): BuiltLaneContext['adaptive'] {
  const now = (deps.clock ?? (() => new Date()))();
  let loaded: LoadedAdaptiveProfiles;
  try {
    loaded = loadAdaptiveProfiles({
      workspace: deps.workspace,
      policy: runtime.adaptivePolicy,
      now,
    });
  } catch {
    // Derived analytics must never fail a job. Without profiles the ranking
    // layer sees cold start and answers with the heuristic, which is the
    // behavior this whole subsystem degrades to by design.
    return undefined;
  }

  const rankings = new Map<string, AdaptiveRanking>();
  const signatures = new Map<string, TaskSignature>();
  for (const node of ready) {
    const assessment = routings.get(node.nodeId);
    if (assessment === undefined) continue;
    const signature = assessment.signature;
    if (signature === undefined) continue;
    const reliability = readTaskReliabilityState(deps.workspace, jobId, node.nodeId);
    signatures.set(node.nodeId, signature);

    const candidates = generateCandidates({
      routing: assessment,
      contextStrategy: runtime.contextStrategy,
      harnessBinding: runtime.harnessBinding,
      localDirectAvailable: runtime.localDirectAvailable,
      localDirectModel: runtime.localDirectModel,
      localDirectRunner: runtime.localDirectRunner,
      apiBinding: runtime.apiBinding,
      subscriptionProvider: null,
      exhaustedStrategies: reliability?.exhaustedStrategies ?? [],
      planRevision: job.graphRevision,
    });

    const ranking = rankCandidates({
      mode: runtime.adaptivePolicy.mode,
      candidates,
      signature,
      profiles: loaded.profiles,
      policy: runtime.adaptivePolicy,
      forecast,
      // The Beta prior's mean is the EXISTING heuristic's own expectation
      // that one attempt succeeds. Identical across candidates on a task, so
      // it expresses uncertainty and never a preference for a provider.
      priorSuccessProbability: 1 - assessment.estimate.retryProbability,
      heuristicWallTimeMs: assessment.estimate.expectedWallTimeMs,
      heuristicInputTokens: assessment.estimate.expectedInputTokens,
      heuristicContextTokens: assessment.estimate.expectedContextGrowthTokens,
      heuristicFiveHourBurnRatio: assessment.estimate.expectedFiveHourBurnRatio,
    });
    rankings.set(node.nodeId, ranking);

    // Apply, in the one dimension that has an alternative here.
    const selected = ranking.selectedCandidate;
    if (
      !ranking.adaptiveApplied ||
      selected === null ||
      selected.executionMode === null ||
      assessment.routing.lane !== 'LOCAL' ||
      assessment.localExecution === undefined ||
      assessment.localExecution.mode === selected.executionMode
    ) {
      continue;
    }
    routings.set(node.nodeId, {
      ...assessment,
      localExecution: {
        ...assessment.localExecution,
        mode: selected.executionMode,
        detail:
          `${assessment.localExecution.detail} Adaptive scheduler selected ${selected.executionMode} ` +
          `on observed history (confidence ${ranking.confidence}).`,
      },
    });
  }

  return {
    profiles: loaded.profiles,
    source: loaded.source,
    invalidatedReason: loaded.invalidatedReason,
    jobsScanned: loaded.jobsScanned,
    rankings,
    signatures,
  };
}

/**
 * Run the vNext.5 gap-bridge planner for ONE deferred node, gathering every
 * input from durable state so the resulting decision replays exactly.
 *
 * Returns undefined when the defer is not a subscription-CAPACITY problem —
 * a context refusal, an escalation, or a local-worker gap is not a gap the
 * paid lane may bridge, and treating every defer as a spending opportunity
 * is precisely how a continuity bridge turns into a default lane.
 */
function assessApiGapBridge(
  runtime: SchedulingRuntime,
  deps: JobDeps,
  jobId: string,
  job: JobState,
  node: JobNode,
  assessment: NodeLaneRouting,
  context: {
    forecast: QuotaForecast;
    readyLocalNodeIds: readonly string[];
    readyRunnableNodeIds: readonly string[];
    graph: JobGraph | undefined;
    now: Date;
  },
): NodeLaneRouting | undefined {
  const apiPolicy = runtime.policy.api;
  const gapReason = runtime.subscriptionWorkerAvailable
    ? subscriptionGapReasonFor(assessment.routing.reasonCode)
    : 'SUBSCRIPTION_WORKER_UNAVAILABLE';
  if (gapReason === undefined) return undefined;

  const gap = buildSubscriptionGapForecast({
    reason: gapReason,
    forecast: context.forecast,
    deferUntil: assessment.routing.deferUntil,
    now: context.now,
  });
  const delaySensitivity = assessDelaySensitivity({
    graph: context.graph,
    nodeId: node.nodeId,
    readyLocalNodeIds: context.readyLocalNodeIds,
    readyRunnableNodeIds: context.readyRunnableNodeIds,
  });
  const cost = estimateApiCost({
    estimate: assessment.estimate,
    pricing: apiPolicy.pricing,
    safetyMultiplier: apiPolicy.gap.costSafetyMultiplier,
  });
  // Budget admission reads the DURABLE reservation state, not a cached
  // total: a reservation another task made moments ago must already be
  // visible here, or two tasks could each be told the same dollar is free.
  const budget = assessApiBudget({
    state: readApiBudgetState(deps.workspace, jobId),
    policy: apiPolicy.budget,
    taskId: node.parentTaskId,
    safeCostUsd: cost.safeCostUsd,
  });
  const approval =
    runtime.apiBinding.profileName === null
      ? null
      : checkApiSpendApproval({
          approvals: listApiSpendApprovals(deps.workspace, jobId, { nodeId: node.nodeId }),
          nodeId: node.nodeId,
          taskFingerprint: taskSpendFingerprint(node),
          profileName: runtime.apiBinding.profileName,
          safeCostUsd: cost.safeCostUsd,
          now: context.now,
        });

  const plan = planApiGapBridge({
    policy: apiPolicy,
    binding: runtime.apiBinding,
    gap,
    delaySensitivity,
    estimate: assessment.estimate,
    cost,
    budget,
    approval,
    // The planner is only ever reached through a subscription refusal, and
    // it re-asserts that fact rather than trusting the call site.
    subscriptionAvailable: false,
    now: context.now,
  });
  void job;
  return { ...assessment, routing: applyApiGapBridge(assessment.routing, plan), apiBridge: plan };
}

function assessNode(
  runtime: SchedulingRuntime,
  deps: JobDeps,
  jobId: string,
  job: JobState,
  node: JobNode,
  forecast: QuotaForecast,
  reserve: DynamicReserveResult,
  observations: ReturnType<typeof deriveBurnObservations>,
): NodeLaneRouting {
  const attemptsUsed = localExecutorAttemptsUsed(deps, jobId, node.nodeId);
  const stickyEscalation = job.escalations.some(
    (entry) => entry.nodeId === node.nodeId && LOCAL_ESCALATION_REASONS.includes(entry.reason),
  );
  // Suitability matches the TASK TITLE only, deliberately: matching against
  // the shared spec text would let one "summarize"-style word anywhere in
  // the requirements classify EVERY task local — the opposite of
  // conservative. (Complexity signals still read the spec text; they only
  // ever RAISE the class, which is the safe direction.)
  const suitability = classifyLocalSuitability({
    taskId: node.parentTaskId,
    title: node.title,
    complexity: node.complexity,
    deterministicVerificationAvailable: runtime.verificationAvailable,
    localWorkerAvailable: runtime.localWorkerAvailable && !stickyEscalation,
    localAttemptsUsed: attemptsUsed,
    maxLocalAttempts: runtime.policy.maxLocalAttempts,
  });
  const estimate = estimateWorkload({
    taskId: node.parentTaskId,
    complexity: node.complexity ?? 'MEDIUM',
    localSuitability: suitability.class,
    taskCategory: suitability.category,
    policy: runtime.policy.estimator,
    observations,
    // vNext.8: the measured conservative tail feeds admission only while the
    // adaptive scheduler is on. It makes admission STRICTER, and an operator
    // running in HEURISTIC mode asked for vNext.7 behavior.
    conservativeBurnFromHistory: runtime.adaptiveEnabled,
  });
  const routing = decideLane({
    estimate,
    forecast,
    reserveRatio: reserve.ratio,
    staleReserveExtraRatio: reserve.basis.staleTelemetryExtra,
    localWorkerAvailable: runtime.localWorkerAvailable && !stickyEscalation,
    localExecutionAvailable: runtime.localExecutionAvailable && !stickyEscalation,
    localEscalationRequired: stickyEscalation || attemptsUsed >= runtime.policy.maxLocalAttempts,
    contextUsageRatio: estimateNodeContextRatio(deps, jobId, node.nodeId),
    policy: runtime.policy,
  });

  const directToHarness = job.escalations.some(
    (entry) => entry.nodeId === node.nodeId && entry.reason === DIRECT_TO_HARNESS_REASON,
  );
  const shape = classifyLocalExecutionShape({
    taskId: node.parentTaskId,
    title: node.title,
    taskCategory: suitability.category,
    complexity: node.complexity,
    priorDirectFailureNeedsRepository: directToHarness,
  });

  // vNext.8: the grouping key, computed on every pass regardless of adaptive
  // mode so history stays comparable from the first attempt onward. Pure
  // classification over values already derived above; it decides nothing.
  const reliability = readTaskReliabilityState(deps.workspace, jobId, node.nodeId);
  const signature = buildTaskSignature({
    category: suitability.category,
    complexity: node.complexity ?? 'MEDIUM',
    localSuitability: suitability.class,
    executionShape: shape.shape,
    deterministicVerificationAvailable: runtime.verificationAvailable,
    expectedContextTokens: estimate.expectedContextGrowthTokens,
    features: {
      failureClass: reliability?.health ?? null,
      expectedTestLoopClass: runtime.verificationAvailable ? 'ITERATIVE' : 'NONE',
    },
  });

  // vNext.4: the LANE is now decided. Only then — and only for the LOCAL
  // lane — is the execution MODE resolved. This ordering is load-bearing:
  // a harness must never be able to pull work into the local lane, so mode
  // resolution reads the lane decision and can never write it.
  if (routing.lane !== 'LOCAL') {
    return { suitability, estimate, routing, signature };
  }
  const localExecution = resolveLocalExecutionMode({
    strategy: runtime.policy.localExecution.strategy,
    suitability: suitability.class,
    shape,
    directAvailable: runtime.localDirectAvailable,
    binding: runtime.harnessBinding,
    directToHarnessEscalated: directToHarness,
    localAttemptsUsed: attemptsUsed,
    maxLocalAttempts: runtime.policy.maxLocalAttempts,
    ...(runtime.localExecutionOverride !== undefined
      ? { override: runtime.localExecutionOverride }
      : {}),
  });
  return { suitability, estimate, routing, shape, localExecution, signature };
}
