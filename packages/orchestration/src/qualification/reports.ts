import type { WorkspaceInfo } from '@specbridge/core';
import { readAdaptiveDecisions } from '../adaptive/decisions.js';
import { readAdaptiveCalibration } from '../adaptive/store.js';
import { listContextMetrics } from '../context/store.js';
import { listGraphRevisions, readGraphRevision, readJobEvents, readJobState } from '../jobs/store.js';
import { readExecutionLedger, summarizeExecutionLedger } from '../survival/service.js';
import { listEvaluationResults, listRecoveryDecisions } from '../reliability/store.js';
import type { ExecutionLedgerEntry } from '../survival/state.js';
import type {
  AdaptiveReport,
  AutonomyScorecard,
  ContextReport,
  EconomicReport,
  HumanIntervention,
  ReliabilityReport,
  TimelineEntry,
} from './state.js';
import { AUTONOMY_FAILURE_INTERVENTION_KINDS } from './vocabulary.js';

/**
 * Derived qualification reports (vNext.9).
 *
 * Every function here is a pure projection of durable records: attempts and
 * the execution ledger, evaluations, recovery decisions, context metrics,
 * adaptive decisions, and job events. Nothing is stored, nothing is
 * recomputed at write time, and nothing is fabricated.
 *
 * The rule that shapes all of it: an unreported measurement is `null`, never
 * `0`. A provider that said nothing about its token usage must not appear
 * cheaper than one that reported honestly, and a Mission with no verified
 * task must not show a 0% success rate that reads like a measured failure
 * when it is really an absence of data. Counts of EVENTS are different —
 * "no oscillation was detected" genuinely is zero — so those stay integers.
 */

/** Add a possibly-absent measurement without inventing a zero. */
function add(current: number | null, reported: number | null | undefined): number | null {
  if (reported === null || reported === undefined) return current;
  return (current ?? 0) + reported;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function eventCounts(workspace: WorkspaceInfo, jobId: string): Map<string, number> {
  const counts = new Map<string, number>();
  const page = readJobEvents(workspace, jobId, { limit: 100_000 });
  for (const event of page.events) {
    const type = String(event['type']);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

function countOf(counts: Map<string, number>, ...types: string[]): number {
  return types.reduce((total, type) => total + (counts.get(type) ?? 0), 0);
}

/** Executor-role ledger entries: the attempts that actually did task work. */
function executorEntries(entries: readonly ExecutionLedgerEntry[]): ExecutionLedgerEntry[] {
  return entries.filter((entry) => entry.role === 'EXECUTOR' || entry.role === 'BUILDER');
}

// ---------------------------------------------------------------------------
// Economic report
// ---------------------------------------------------------------------------

/**
 * Where the compute went, and what it bought.
 *
 * `apiUnknownCostAttempts` is the field that keeps this honest: an API
 * attempt whose real cost is unknowable is counted separately rather than
 * folded into the spend total as a zero, so "we spent $0.42" never quietly
 * means "we spent $0.42 plus three attempts we cannot price".
 */
export function buildEconomicReport(
  workspace: WorkspaceInfo,
  jobId: string,
): EconomicReport {
  const entries = readExecutionLedger(workspace, jobId);
  const summary = summarizeExecutionLedger(entries);
  const counts = eventCounts(workspace, jobId);
  const work = executorEntries(entries);

  const laneEntries = (lane: string): ExecutionLedgerEntry[] =>
    work.filter((entry) => entry.lane === lane);
  const verified = (list: readonly ExecutionLedgerEntry[]): number =>
    list.filter((entry) => entry.status === 'COMPLETED' && entry.evaluationStatus === 'PASS').length;

  const local = laneEntries('LOCAL');
  const subscription = laneEntries('SUBSCRIPTION');
  const api = laneEntries('API');

  let estimated: number | null = null;
  let reconciled: number | null = null;
  let unknownCost = 0;
  for (const entry of api) {
    estimated = add(estimated, entry.metrics.estimatedCostUsd);
    if (entry.metrics.reconciledCostUsd === null) unknownCost += 1;
    else reconciled = add(reconciled, entry.metrics.reconciledCostUsd);
  }

  // The most recent quota observation of each window, when any attempt
  // recorded one. Attempts are returned oldest first.
  let fiveHour: number | null = null;
  let weekly: number | null = null;
  for (const entry of entries) {
    if (entry.metrics.fiveHourQuotaAfter !== null) fiveHour = entry.metrics.fiveHourQuotaAfter;
    else if (entry.metrics.fiveHourQuotaBefore !== null) fiveHour = entry.metrics.fiveHourQuotaBefore;
    if (entry.metrics.weeklyQuotaAfter !== null) weekly = entry.metrics.weeklyQuotaAfter;
    else if (entry.metrics.weeklyQuotaBefore !== null) weekly = entry.metrics.weeklyQuotaBefore;
  }

  return {
    localAttempts: local.length,
    localDirectAttempts: local.filter((entry) => entry.executionMode === 'DIRECT_MODEL').length,
    localHarnessAttempts: local.filter((entry) => entry.executionMode === 'HARNESS').length,
    subscriptionAttempts: subscription.length,
    apiAttempts: api.length,
    localVerifiedSuccesses: verified(local),
    subscriptionVerifiedSuccesses: verified(subscription),
    apiVerifiedSuccesses: verified(api),
    fiveHourRemainingRatio: fiveHour,
    weeklyRemainingRatio: weekly,
    unusedFiveHourCapacityObservations: countOf(counts, 'harvest_entered', 'quota_exhausted'),
    harvestEntries: countOf(counts, 'harvest_entered'),
    weeklyPressureEvents: countOf(counts, 'quota_exhausted', 'api_gap_detected'),
    apiEstimatedSpendUsd: estimated,
    apiReconciledSpendUsd: reconciled,
    apiUnknownCostAttempts: unknownCost,
    failedWorkCostUsd: summary.reliability.failedAttemptCostUsd,
    failedWorkMs: summary.reliability.failedAttemptMs,
    failedWorkTokens: summary.reliability.failedAttemptTokens,
  };
}

// ---------------------------------------------------------------------------
// Reliability report
// ---------------------------------------------------------------------------

/**
 * What went wrong, how it was classified, and whether the strategy changed.
 *
 * The failure-source split is the load-bearing part: a runtime that reported
 * every failure as an implementation failure would look identical to one
 * that genuinely diagnosed each one, and only the source distribution tells
 * them apart.
 */
export function buildReliabilityReport(
  workspace: WorkspaceInfo,
  jobId: string,
): ReliabilityReport {
  const entries = readExecutionLedger(workspace, jobId);
  const summary = summarizeExecutionLedger(entries);
  const counts = eventCounts(workspace, jobId);
  const decisions = listRecoveryDecisions(workspace, jobId);

  const sources = summary.reliability.failureSources;
  const sourceTotal = (...names: string[]): number =>
    names.reduce((total, name) => total + (sources[name] ?? 0), 0);

  // A recovery "succeeded" when the task it responded to later reached a
  // verified completion. Decisions that merely produced another failure are
  // counted as attempted, not as successes.
  const verifiedNodes = new Set(
    listEvaluationResults(workspace, jobId)
      .filter((evaluation) => evaluation.status === 'PASS')
      .map((evaluation) => evaluation.nodeId),
  );
  const successfulRecoveries = decisions.filter((decision) =>
    verifiedNodes.has(decision.nodeId),
  ).length;

  return {
    totalFailures: summary.reliability.failedAttempts,
    infrastructureFailures: sourceTotal(
      'INFRASTRUCTURE',
      'HARNESS_RUNTIME',
      'PROVIDER',
      'RUNNER',
      'LOCAL_RUNTIME',
    ),
    implementationFailures: sourceTotal('IMPLEMENTATION', 'INTELLIGENCE', 'MODEL'),
    contextFailures: sourceTotal('CONTEXT'),
    verificationFailures: sourceTotal('VERIFICATION', 'EVALUATION_INFRASTRUCTURE'),
    stalledEvents: countOf(counts, 'execution_stalled'),
    oscillationEvents: countOf(counts, 'execution_oscillating'),
    runawayEvents: countOf(counts, 'execution_runaway'),
    repairs: countOf(counts, 'repair_started'),
    freshContextRestarts: countOf(counts, 'fresh_context_selected'),
    contextExpansions: countOf(counts, 'context_expanded'),
    replans: countOf(counts, 'replan_started'),
    laneEscalations: countOf(
      counts,
      'lane_escalation_requested',
      'local_harness_to_subscription_escalated',
      'local_escalation_triggered',
    ),
    blockedTasks: countOf(counts, 'task_blocked_after_recovery', 'node_failed'),
    successfulRecoveries,
    recoveryActions: summary.reliability.recoveryActions,
    failureSources: sources,
    healthStates: summary.reliability.healthStates,
    evaluationsPassed: summary.reliability.evaluationsPassed,
    evaluationsFailed: summary.reliability.evaluationsFailed,
    evaluationsInconclusive: summary.reliability.evaluationsInconclusive,
  };
}

// ---------------------------------------------------------------------------
// Context report
// ---------------------------------------------------------------------------

/**
 * What context cost, and what it bought.
 *
 * `contextPerVerifiedTask` exists because a first-prompt token reduction
 * that is paid back in retries is not a saving. Reporting context per
 * ATTEMPT alone would let a strategy that halves the prompt and doubles the
 * attempts look like a 50% win.
 */
export function buildContextReport(workspace: WorkspaceInfo, jobId: string): ContextReport {
  const metrics = listContextMetrics(workspace, jobId);
  const counts = eventCounts(workspace, jobId);
  const entries = readExecutionLedger(workspace, jobId);

  let estimated: number | null = null;
  let providerInput: number | null = null;
  let workingSet: number | null = null;
  let compressionSaved: number | null = null;
  let dedupSaved: number | null = null;
  let expansions = 0;
  let nativeCompactions: number | null = null;
  let strategy: string | null = null;

  for (const metric of metrics) {
    estimated = add(estimated, metric.estimatedContextTokens);
    providerInput = add(providerInput, metric.providerReportedInputTokens);
    workingSet = add(workingSet, metric.selectedFiles + metric.selectedSections);
    const compressionDelta =
      metric.compressionSourceChars > 0
        ? metric.compressionSourceChars - metric.compressionOutputChars
        : null;
    compressionSaved = add(compressionSaved, compressionDelta);
    dedupSaved = add(dedupSaved, metric.deduplicationSavedChars > 0 ? metric.deduplicationSavedChars : null);
    expansions += metric.contextExpansions;
    nativeCompactions = add(nativeCompactions, metric.nativeCompactions);
    strategy = metric.strategy;
  }

  let providerOutput: number | null = null;
  for (const entry of entries) providerOutput = add(providerOutput, entry.metrics.outputTokens);

  const verifiedTasks = new Set(
    listEvaluationResults(workspace, jobId)
      .filter((evaluation) => evaluation.status === 'PASS')
      .map((evaluation) => evaluation.nodeId),
  ).size;

  // Chars are the unit compression and deduplication are measured in; the
  // report states tokens elsewhere, so those two stay in their own unit
  // rather than being converted by a made-up ratio.
  return {
    estimatedInputContextTokens: estimated,
    providerReportedInputTokens: providerInput,
    providerReportedOutputTokens: providerOutput,
    workingSetItems: workingSet,
    compressionSavingsTokens: compressionSaved,
    deduplicationSavingsTokens: dedupSaved,
    progressiveExpansions: Math.max(expansions, countOf(counts, 'context_expanded')),
    expansionExhaustions: countOf(counts, 'context_expansion_exhausted'),
    nativeCompactions,
    contextCompactions: countOf(counts, 'context_compacted', 'context_compaction_before_dispatch'),
    contextMisses: countOf(counts, 'context_insufficient'),
    indexBuilds: countOf(counts, 'context_index_built'),
    indexRefreshes: countOf(counts, 'context_index_refreshed'),
    contextPerVerifiedTask:
      estimated === null || verifiedTasks === 0 ? null : estimated / verifiedTasks,
    retriesAttributableToContext: entries.filter((entry) => entry.failureSource === 'CONTEXT').length,
    strategy,
  };
}

// ---------------------------------------------------------------------------
// Adaptive report
// ---------------------------------------------------------------------------

/**
 * What history did, and did not, change.
 *
 * Shadow recommendations are reported as recommendations. No counterfactual
 * outcome is attributed to them anywhere in this function, because none was
 * observed: an unexecuted candidate has no result, and claiming it would
 * have done better is exactly the self-confirming loop vNext.8 was built to
 * avoid.
 */
export function buildAdaptiveReport(workspace: WorkspaceInfo, jobId: string): AdaptiveReport {
  const decisions = readAdaptiveDecisions(workspace, jobId, { limit: 5_000 });
  const counts = eventCounts(workspace, jobId);
  const calibration = readAdaptiveCalibration(workspace, jobId, { limit: 5_000 });

  const confidenceDistribution: Record<string, number> = {};
  const fallbackReasons: Record<string, number> = {};
  const vetoCodes: Record<string, number> = {};
  let heuristic = 0;
  let shadow = 0;
  let adaptive = 0;
  let disagreements = 0;
  let fallbacks = 0;
  let vetoes = 0;
  let mode: string | null = null;

  for (const decision of decisions) {
    mode = decision.mode;
    if (decision.mode === 'HEURISTIC') heuristic += 1;
    if (decision.mode === 'SHADOW') shadow += 1;
    if (decision.mode === 'ADAPTIVE') adaptive += 1;
    if (decision.disagreement) disagreements += 1;
    confidenceDistribution[decision.confidence] =
      (confidenceDistribution[decision.confidence] ?? 0) + 1;
    if (decision.fallbackReason !== null) {
      fallbacks += 1;
      fallbackReasons[decision.fallbackReason] = (fallbackReasons[decision.fallbackReason] ?? 0) + 1;
    }
    for (const rejected of decision.rejectedCandidates) {
      vetoes += 1;
      vetoCodes[rejected.code] = (vetoCodes[rejected.code] ?? 0) + 1;
    }
  }

  // Mean Brier score over calibration records that resolved one. A record
  // whose forecast or outcome was unknown carries a null score and
  // contributes nothing — averaging it in as zero would report a perfectly
  // calibrated prediction that was never made.
  let brierSum: number | null = null;
  let brierCount = 0;
  for (const record of calibration) {
    if (record.successBrierScore === null) continue;
    brierSum = (brierSum ?? 0) + record.successBrierScore;
    brierCount += 1;
  }

  return {
    mode,
    heuristicDecisions: heuristic,
    shadowRecommendations: shadow,
    shadowDisagreements: disagreements,
    adaptiveDecisions: adaptive,
    confidenceDistribution,
    heuristicFallbacks: Math.max(fallbacks, countOf(counts, 'adaptive_fallback_to_heuristic')),
    fallbackReasons,
    hardPolicyVetoes: Math.max(vetoes, countOf(counts, 'adaptive_candidate_vetoed')),
    vetoCodes,
    driftEvents: countOf(counts, 'adaptive_drift_detected'),
    profileRebuilds: countOf(counts, 'adaptive_profile_rebuilt'),
    calibrationSamples: brierCount,
    calibrationBrierScore: brierSum === null || brierCount === 0 ? null : brierSum / brierCount,
  };
}

// ---------------------------------------------------------------------------
// Autonomy scorecard
// ---------------------------------------------------------------------------

/**
 * The operational scorecard.
 *
 * Deliberately not a single number. A run that verified every task while
 * requiring four manual source repairs and one durable-state repair is not
 * "92% autonomous" — it is a runtime that could not finish that work on its
 * own, and the counters say so in a way an average never could.
 */
export function buildAutonomyScorecard(input: {
  workspace: WorkspaceInfo;
  jobId: string | null;
  interventions: readonly HumanIntervention[];
  wallTimeMs: number | null;
  activeMs: number;
}): AutonomyScorecard {
  const { workspace, jobId, interventions } = input;
  const empty: AutonomyScorecard = {
    missionCompleted: null,
    objectivesTotal: 0,
    objectivesCompleted: 0,
    tasksTotal: 0,
    tasksCompleted: 0,
    tasksVerified: 0,
    verifiedCompletionRate: null,
    firstAttemptSuccessRate: null,
    attemptsPerSuccessfulTask: null,
    manualInterventions: interventions.length,
    manualCodeEdits: interventions.filter((entry) => entry.kind === 'MANUAL_CODE_FIX').length,
    manualSchedulerInterventions: interventions.filter((entry) => entry.kind === 'MANUAL_SCHEDULING')
      .length,
    manualStateRepairs: interventions.filter((entry) => entry.kind === 'MANUAL_STATE_REPAIR').length,
    manualContextRepairs: interventions.filter((entry) => entry.kind === 'MANUAL_CONTEXT_REPAIR')
      .length,
    replans: 0,
    recoveriesAttempted: 0,
    recoveriesSucceeded: 0,
    processRestartsSurvived: 0,
    sessionLossesSurvived: 0,
    contextCompactionsSurvived: 0,
    quotaResetsCrossed: 0,
    localAttempts: 0,
    subscriptionAttempts: 0,
    apiAttempts: 0,
    apiSpendUsd: null,
    failedWorkCostUsd: null,
    wallTimeMs: input.wallTimeMs,
    activeExecutionMs: null,
    reportedInputTokens: null,
    reportedOutputTokens: null,
    tasksCompletedWithoutIntervention: 0,
  };
  if (jobId === null) return empty;

  const read = readJobState(workspace, jobId);
  if (read.kind !== 'ok') return empty;
  const job = read.job;

  const nodes =
    job.graphRevision > 0 ? (readGraphRevision(workspace, jobId, job.graphRevision)?.nodes ?? []) : [];
  const entries = readExecutionLedger(workspace, jobId);
  const work = entries.filter((entry) => entry.role === 'EXECUTOR' || entry.role === 'BUILDER');
  const counts = eventCounts(workspace, jobId);
  const economics = buildEconomicReport(workspace, jobId);

  const verifiedNodes = new Set(
    listEvaluationResults(workspace, jobId)
      .filter((evaluation) => evaluation.status === 'PASS')
      .map((evaluation) => evaluation.nodeId),
  );
  const completed = nodes.filter((node) => node.status === 'COMPLETED');
  const verified = completed.filter((node) => verifiedNodes.has(node.nodeId));
  const attemptedNodes = new Set(work.map((entry) => entry.nodeId));

  const firstAttempts = work.filter((entry) => entry.attemptNumber === 1);
  const firstAttemptSuccesses = firstAttempts.filter(
    (entry) => entry.status === 'COMPLETED' && entry.evaluationStatus === 'PASS',
  ).length;

  const interveningNodes = new Set(
    interventions
      .filter((entry) => entry.nodeId !== null)
      .map((entry) => entry.nodeId as string),
  );

  let activeMs: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const entry of entries) {
    activeMs = add(activeMs, entry.metrics.durationMs);
    inputTokens = add(inputTokens, entry.metrics.inputTokens);
    outputTokens = add(outputTokens, entry.metrics.outputTokens);
  }

  const decisions = listRecoveryDecisions(workspace, jobId);

  return {
    missionCompleted: job.status === 'COMPLETED',
    // Objectives and tasks coincide in the current runtime graph: each node
    // binds to exactly one approved task, and objective decomposition lives
    // inside the node's work graph. Reporting both from the same source is
    // honest; inventing a separate objective count would not be.
    objectivesTotal: nodes.length,
    objectivesCompleted: completed.length,
    tasksTotal: nodes.length,
    tasksCompleted: completed.length,
    tasksVerified: verified.length,
    verifiedCompletionRate: ratio(verified.length, attemptedNodes.size),
    firstAttemptSuccessRate: ratio(firstAttemptSuccesses, firstAttempts.length),
    attemptsPerSuccessfulTask: verified.length === 0 ? null : work.length / verified.length,
    manualInterventions: interventions.length,
    manualCodeEdits: interventions.filter((entry) => entry.kind === 'MANUAL_CODE_FIX').length,
    manualSchedulerInterventions: interventions.filter((entry) => entry.kind === 'MANUAL_SCHEDULING')
      .length,
    manualStateRepairs: interventions.filter((entry) => entry.kind === 'MANUAL_STATE_REPAIR').length,
    manualContextRepairs: interventions.filter((entry) => entry.kind === 'MANUAL_CONTEXT_REPAIR')
      .length,
    replans: countOf(counts, 'replan_started'),
    recoveriesAttempted: decisions.length,
    recoveriesSucceeded: decisions.filter((decision) => verifiedNodes.has(decision.nodeId)).length,
    processRestartsSurvived: countOf(counts, 'job_resumed'),
    sessionLossesSurvived: countOf(counts, 'attempt_interrupted'),
    contextCompactionsSurvived: countOf(
      counts,
      'context_compacted',
      'context_compaction_before_dispatch',
    ),
    quotaResetsCrossed: countOf(counts, 'cross_reset_admitted'),
    localAttempts: economics.localAttempts,
    subscriptionAttempts: economics.subscriptionAttempts,
    apiAttempts: economics.apiAttempts,
    apiSpendUsd: economics.apiReconciledSpendUsd ?? economics.apiEstimatedSpendUsd,
    failedWorkCostUsd: economics.failedWorkCostUsd,
    wallTimeMs: input.wallTimeMs,
    activeExecutionMs: activeMs,
    reportedInputTokens: inputTokens,
    reportedOutputTokens: outputTokens,
    tasksCompletedWithoutIntervention: verified.filter(
      (node) => !interveningNodes.has(node.nodeId),
    ).length,
  };
}

/** Interventions that mean the autonomous runtime failed to carry the work. */
export function autonomyFailureInterventions(
  interventions: readonly HumanIntervention[],
): HumanIntervention[] {
  return interventions.filter((entry) =>
    AUTONOMY_FAILURE_INTERVENTION_KINDS.includes(entry.kind),
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * The milestones a reader needs to follow a long run, projected from durable
 * job events.
 *
 * The allow-list is the mechanism, not an optimization: the timeline can
 * only ever contain event types SpecBridge itself emits, so there is no path
 * by which a prompt, a transcript, or a model's reasoning could reach a
 * shareable release artifact.
 */
const TIMELINE_MILESTONES: Readonly<Record<string, string>> = Object.freeze({
  job_created: 'Mission job created',
  graph_created: 'Objectives created',
  graph_revised: 'Work graph revised',
  job_resumed: 'Process restart survived',
  node_ready: 'Task ready',
  worker_selected: 'Task dispatched',
  worker_escalated: 'Escalated to stronger intelligence',
  task_routed_local: 'Lane selected: LOCAL',
  task_routed_subscription: 'Lane selected: SUBSCRIPTION',
  task_deferred: 'Task deferred for quota',
  local_execution_mode_selected: 'Local execution mode selected',
  local_harness_selected: 'Local harness selected',
  scheduler_mode_changed: 'Quota mode changed',
  harvest_entered: 'HARVEST entered',
  harvest_exited: 'HARVEST exited',
  cross_reset_admitted: 'Task admitted across a quota reset',
  quota_exhausted: 'Subscription quota exhausted',
  context_compacted: 'Context compacted',
  context_expanded: 'Context expanded',
  context_insufficient: 'Context insufficiency detected',
  context_index_built: 'Repository context index built',
  context_index_refreshed: 'Repository context index refreshed',
  attempt_started: 'Attempt started',
  attempt_interrupted: 'Attempt interrupted',
  task_checkpoint_created: 'Checkpoint created',
  task_resumed: 'Task resumed from checkpoint',
  api_gap_detected: 'API gap detected',
  api_approval_required: 'API spend approval required',
  api_approval_granted: 'API spend approved',
  api_budget_reserved: 'API budget reserved',
  api_task_dispatched: 'API bridge entered',
  api_budget_reconciled: 'API spend reconciled',
  api_max_returned: 'Subscription capacity returned',
  evaluation_passed: 'Evaluation PASS',
  evaluation_failed: 'Evaluation FAIL',
  evaluation_inconclusive: 'Evaluation INCONCLUSIVE',
  failure_assessed: 'Failure diagnosed',
  execution_stalled: 'Execution STALLED',
  execution_oscillating: 'Execution OSCILLATING',
  execution_runaway: 'Execution RUNAWAY',
  recovery_decided: 'Recovery selected',
  replan_started: 'Replan started',
  adaptive_candidate_selected: 'Adaptive placement applied',
  adaptive_candidate_vetoed: 'Adaptive candidate vetoed by hard policy',
  adaptive_fallback_to_heuristic: 'Adaptive fell back to heuristic',
  adaptive_profile_rebuilt: 'Adaptive profiles rebuilt',
  integration_started: 'Integration started',
  objective_verified: 'Objective verified',
  node_completed: 'Task completed',
  node_failed: 'Task failed',
  job_blocked: 'Job blocked',
  job_completed: 'Mission completed',
  job_failed: 'Mission failed',
  job_cancelled: 'Mission cancelled',
});

export function buildTimeline(
  workspace: WorkspaceInfo,
  jobId: string,
  options: { limit?: number } = {},
): TimelineEntry[] {
  const limit = options.limit ?? 1_000;
  const page = readJobEvents(workspace, jobId, { limit: 100_000 });
  const entries: TimelineEntry[] = [];
  for (const event of page.events) {
    const type = String(event['type']);
    const milestone = TIMELINE_MILESTONES[type];
    if (milestone === undefined) continue;
    const nodeId = event['nodeId'];
    entries.push({
      at: String(event['at']),
      eventType: type,
      milestone,
      jobId,
      nodeId: typeof nodeId === 'string' ? nodeId : null,
    });
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  return entries.slice(0, limit);
}

/** Graph revisions persisted for a job, for report provenance. */
export function graphRevisionCount(workspace: WorkspaceInfo, jobId: string): number {
  return listGraphRevisions(workspace, jobId).length;
}
