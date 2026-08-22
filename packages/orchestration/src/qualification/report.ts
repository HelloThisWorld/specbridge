import type { WorkspaceInfo } from '@specbridge/core';
import type {
  DogfoodQualificationReport,
  QualificationLimitation,
  ScenarioResult,
} from './state.js';
import { QUALIFICATION_REPORT_SCHEMA_VERSION, dogfoodQualificationReportSchema } from './state.js';
import {
  listDogfoodDefects,
  listFaultInjections,
  listHumanInterventions,
  listInvariantAudits,
  listScenarioResults,
  requireDogfoodRun,
} from './store.js';
import {
  buildAdaptiveReport,
  buildAutonomyScorecard,
  buildContextReport,
  buildEconomicReport,
  buildReliabilityReport,
  buildTimeline,
} from './reports.js';
import { computeVerdict } from './verdict.js';
import { QUALIFICATION_SCENARIOS } from './matrix.js';
import type { QualificationResource, ResourceAttribution } from './vocabulary.js';
import { QUALIFICATION_RESOURCES } from './vocabulary.js';

/**
 * The DogfoodQualificationReport assembler (vNext.9).
 *
 * Pure derivation from the run directory plus the bound Job's durable state.
 * Running it twice on unchanged inputs produces the same report, apart from
 * `generatedAt` — which is exactly the reproducibility §111 asks for, and
 * why the normalizer below exists.
 */

/**
 * Fold per-scenario attribution into one per-resource answer.
 *
 * The rule is conservative on purpose: REAL beats SIMULATED beats
 * NOT_EXERCISED. A resource exercised for real ANYWHERE is reported as real,
 * and one only ever simulated can never be promoted — so a single
 * fake-clock reset cannot make the report claim a real quota window, which
 * is the specific exaggeration §76 exists to prevent.
 */
function foldAttribution(
  results: readonly ScenarioResult[],
): Record<QualificationResource, ResourceAttribution> {
  const rank: Record<ResourceAttribution, number> = {
    NOT_EXERCISED: 0,
    SIMULATED: 1,
    REAL: 2,
  };
  const folded = {} as Record<QualificationResource, ResourceAttribution>;
  for (const resource of QUALIFICATION_RESOURCES) folded[resource] = 'NOT_EXERCISED';
  for (const result of results) {
    // A scenario that did not run tells us nothing about its resources.
    if (result.status !== 'PASS' && result.status !== 'FAIL') continue;
    for (const [resource, attribution] of Object.entries(result.resourceAttribution)) {
      const key = resource as QualificationResource;
      const current = folded[key];
      if (current === undefined) continue;
      if (rank[attribution as ResourceAttribution] > rank[current]) {
        folded[key] = attribution as ResourceAttribution;
      }
    }
  }
  return folded;
}

export interface BuildReportInput {
  workspace: WorkspaceInfo;
  runId: string;
  generatedAt: string;
  /** Extra limitations the operator documented outside the scenario matrix. */
  limitations?: readonly QualificationLimitation[] | undefined;
}

export function buildQualificationReport(
  input: BuildReportInput,
): DogfoodQualificationReport {
  const { workspace, runId } = input;
  const run = requireDogfoodRun(workspace, runId);
  const results = listScenarioResults(workspace, runId);
  const faults = listFaultInjections(workspace, runId);
  const audits = listInvariantAudits(workspace, runId);
  const interventions = listHumanInterventions(workspace, runId);
  const defects = listDogfoodDefects(workspace, runId);

  const jobId = run.jobId;
  const scorecard = buildAutonomyScorecard({
    workspace,
    jobId,
    interventions,
    wallTimeMs:
      run.finalizedAt === null
        ? null
        : Math.max(0, Date.parse(run.finalizedAt) - Date.parse(run.startedAt)),
    activeMs: run.activeMs,
  });

  const verdict = computeVerdict({
    profile: run.profile,
    results,
    audits,
    faults,
    interventions,
    defects,
    limitations: [...(input.limitations ?? [])],
    realTargetAvailable: run.target.kind === 'REAL_REPOSITORY' && run.target.available,
  });

  const report: DogfoodQualificationReport = {
    schemaVersion: QUALIFICATION_REPORT_SCHEMA_VERSION,
    runId: run.runId,
    generatedAt: input.generatedAt,
    profile: run.profile,
    status: run.status,
    target: run.target,
    versions: run.versions,
    configurationFingerprint: run.configurationFingerprint,
    missionId: run.missionId,
    jobId: run.jobId,
    iteration: run.iteration,
    previousRunId: run.previousRunId,
    missionDirection: run.missionDirection,
    approvedScope: run.approvedScope,
    scopeChanges: run.scopeChanges as Record<string, unknown>[],
    startedAt: run.startedAt,
    finalizedAt: run.finalizedAt,
    durationMs:
      run.finalizedAt === null
        ? null
        : Math.max(0, Date.parse(run.finalizedAt) - Date.parse(run.startedAt)),
    activeMs: run.activeMs,
    pausedMs: run.pausedMs,
    resourceAttribution: foldAttribution(results),
    scenarios: verdict.scenarios,
    scenarioResults: results,
    faultInjections: faults,
    invariantAudits: audits,
    humanInterventions: interventions,
    defects,
    scorecard,
    economics:
      jobId === null
        ? emptyEconomics()
        : buildEconomicReport(workspace, jobId),
    reliability:
      jobId === null
        ? emptyReliability()
        : buildReliabilityReport(workspace, jobId),
    context: jobId === null ? emptyContext(run.versions.contextStrategy) : buildContextReport(workspace, jobId),
    adaptive: jobId === null ? emptyAdaptive(run.versions.adaptiveMode) : buildAdaptiveReport(workspace, jobId),
    zeroTolerance: verdict.zeroTolerance,
    timeline: jobId === null ? [] : buildTimeline(workspace, jobId),
    blockers: verdict.blockers,
    limitations: verdict.limitations,
    verdict: verdict.verdict,
    verdictBasis: verdict.basis,
    realTargetQualification: verdict.realTargetQualification,
    realTargetQualificationReason: verdict.realTargetQualificationReason,
  };

  return dogfoodQualificationReportSchema.parse(report);
}

// A run with no bound Job has no execution to report. Zeroes are correct
// here (no attempts happened) except where a measurement would be a claim,
// which stays null.
function emptyEconomics(): DogfoodQualificationReport['economics'] {
  return {
    localAttempts: 0,
    localDirectAttempts: 0,
    localHarnessAttempts: 0,
    subscriptionAttempts: 0,
    apiAttempts: 0,
    localVerifiedSuccesses: 0,
    subscriptionVerifiedSuccesses: 0,
    apiVerifiedSuccesses: 0,
    fiveHourRemainingRatio: null,
    weeklyRemainingRatio: null,
    unusedFiveHourCapacityObservations: 0,
    harvestEntries: 0,
    weeklyPressureEvents: 0,
    apiEstimatedSpendUsd: null,
    apiReconciledSpendUsd: null,
    apiUnknownCostAttempts: 0,
    failedWorkCostUsd: null,
    failedWorkMs: null,
    failedWorkTokens: null,
  };
}

function emptyReliability(): DogfoodQualificationReport['reliability'] {
  return {
    totalFailures: 0,
    infrastructureFailures: 0,
    implementationFailures: 0,
    contextFailures: 0,
    verificationFailures: 0,
    stalledEvents: 0,
    oscillationEvents: 0,
    runawayEvents: 0,
    repairs: 0,
    freshContextRestarts: 0,
    contextExpansions: 0,
    replans: 0,
    laneEscalations: 0,
    blockedTasks: 0,
    successfulRecoveries: 0,
    recoveryActions: {},
    failureSources: {},
    healthStates: {},
    evaluationsPassed: 0,
    evaluationsFailed: 0,
    evaluationsInconclusive: 0,
  };
}

function emptyContext(strategy: string | null): DogfoodQualificationReport['context'] {
  return {
    estimatedInputContextTokens: null,
    providerReportedInputTokens: null,
    providerReportedOutputTokens: null,
    workingSetItems: null,
    compressionSavingsTokens: null,
    deduplicationSavingsTokens: null,
    progressiveExpansions: 0,
    expansionExhaustions: 0,
    nativeCompactions: null,
    contextCompactions: 0,
    contextMisses: 0,
    indexBuilds: 0,
    indexRefreshes: 0,
    contextPerVerifiedTask: null,
    retriesAttributableToContext: 0,
    strategy,
  };
}

function emptyAdaptive(mode: string | null): DogfoodQualificationReport['adaptive'] {
  return {
    mode,
    heuristicDecisions: 0,
    shadowRecommendations: 0,
    shadowDisagreements: 0,
    adaptiveDecisions: 0,
    confidenceDistribution: {},
    heuristicFallbacks: 0,
    fallbackReasons: {},
    hardPolicyVetoes: 0,
    vetoCodes: {},
    driftEvents: 0,
    profileRebuilds: 0,
    calibrationSamples: 0,
    calibrationBrierScore: null,
  };
}

/**
 * Normalize a report for reproducibility comparison.
 *
 * Two deterministic runs differ only in identifiers and timestamps, which
 * are unavoidable and meaningless. Everything else — every transition, every
 * verdict, every count — must be identical, and this normalizer is what lets
 * a test assert that without also asserting that time stood still.
 */
export function normalizeReportForComparison(
  report: DogfoodQualificationReport,
): Record<string, unknown> {
  const scrubTimestamps = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrubTimestamps);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (
          key === 'at' ||
          key === 'recordedAt' ||
          key === 'generatedAt' ||
          key === 'startedAt' ||
          key === 'finalizedAt' ||
          key === 'injectedAt' ||
          key === 'resolvedAt' ||
          key === 'discoveredAt' ||
          key === 'updatedAt' ||
          key === 'durationMs' ||
          key === 'activeMs' ||
          key === 'pausedMs' ||
          key === 'wallTimeMs' ||
          key === 'activeExecutionMs' ||
          key === 'runId' ||
          key === 'jobId' ||
          key === 'missionId' ||
          key === 'previousRunId' ||
          key === 'auditId' ||
          key === 'interventionId' ||
          key === 'defectId' ||
          key === 'nodeId' ||
          key === 'evidenceRefs' ||
          key === 'repositoryPath' ||
          key === 'worktreePath' ||
          key === 'startingCommit' ||
          key === 'endingCommit'
        ) {
          continue;
        }
        if (key === 'versions') {
          // Node version and platform legitimately differ between machines.
          const versions = entry as Record<string, unknown>;
          out[key] = {
            contextStrategy: versions['contextStrategy'],
            adaptiveMode: versions['adaptiveMode'],
          };
          continue;
        }
        out[key] = scrubTimestamps(entry);
      }
      return out;
    }
    return value;
  };
  return scrubTimestamps(report) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Human-readable rendering
// ---------------------------------------------------------------------------

function formatNumber(value: number | null, suffix = ''): string {
  return value === null ? 'unknown' : `${value.toLocaleString('en-US')}${suffix}`;
}

function formatUsd(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(4)}`;
}

function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Render the human-readable qualification report.
 *
 * Markdown rather than terminal output because the artifact is meant to be
 * attached to a release, read by somebody who was not in the room, and
 * diffed against the previous iteration. It says "unknown" wherever the data
 * says unknown, which is the whole reason it is generated rather than
 * written.
 */
export function renderQualificationMarkdown(report: DogfoodQualificationReport): string {
  const lines: string[] = [];
  const push = (line = ''): void => {
    lines.push(line);
  };

  push(`# Dogfood qualification report — ${report.runId}`);
  push();
  push(`**Release verdict: ${report.verdict}**`);
  push();
  push(`**Real-product qualification: ${report.realTargetQualification}**`);
  if (report.realTargetQualificationReason !== null) {
    push();
    push(`> ${report.realTargetQualificationReason}`);
  }
  push();

  push('## Identity');
  push();
  push('| Field | Value |');
  push('| --- | --- |');
  push(`| Run | \`${report.runId}\` (iteration ${report.iteration}) |`);
  push(`| Profile | ${report.profile} |`);
  push(`| Status | ${report.status} |`);
  push(`| Target | ${report.target.name} (${report.target.kind}) |`);
  push(`| Target repository | ${report.target.repositoryPath ?? 'not configured'} |`);
  push(`| Target available | ${report.target.available ? 'yes' : `no — ${report.target.unavailableReason ?? 'unknown reason'}`} |`);
  push(`| Starting commit | ${report.target.startingCommit ?? 'unknown'} |`);
  push(`| Ending commit | ${report.target.endingCommit ?? 'unknown'} |`);
  push(`| Branch | ${report.target.branch ?? 'unknown'} |`);
  push(`| Mission | ${report.missionId ?? 'none bound'} |`);
  push(`| Job | ${report.jobId ?? 'none bound'} |`);
  push(`| Configuration fingerprint | \`${report.configurationFingerprint}\` |`);
  push(`| Duration | ${formatDuration(report.durationMs)} (active ${formatDuration(report.activeMs)}, paused ${formatDuration(report.pausedMs)}) |`);
  push();

  push('## Versions');
  push();
  push('| Component | Version |');
  push('| --- | --- |');
  for (const [key, value] of Object.entries(report.versions)) {
    push(`| ${key} | ${value === null ? 'unknown' : String(value)} |`);
  }
  push();

  if (report.missionDirection !== null) {
    push('## Mission direction');
    push();
    push(`> ${report.missionDirection}`);
    push();
  }
  if (report.approvedScope.length > 0) {
    push('## Approved scope');
    push();
    for (const item of report.approvedScope) push(`- ${item}`);
    push();
  }
  if (report.scopeChanges.length > 0) {
    push('## Mission scope changes');
    push();
    for (const change of report.scopeChanges) {
      push(`- **${String(change['at'])}** — ${String(change['reason'])}`);
      push(`  - original: ${String(change['originalScope'])}`);
      push(`  - new: ${String(change['newScope'])}`);
      push(`  - authority: ${String(change['authority'])}`);
      push(`  - effect on qualification: ${String(change['effectOnQualification'])}`);
    }
    push();
  }

  push('## What was real, and what was simulated');
  push();
  push('| Resource | Exercised as |');
  push('| --- | --- |');
  for (const [resource, attribution] of Object.entries(report.resourceAttribution)) {
    push(`| ${resource} | ${attribution} |`);
  }
  push();

  push('## Scenario matrix');
  push();
  const s = report.scenarios;
  push(
    `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped with reason, ${s.notRun} not run, of ${s.total}. ` +
      `Required: ${s.requiredPassed}/${s.requiredTotal} passed, ${s.requiredFailed} failed, ${s.requiredUnproven} unproven.`,
  );
  push();
  push('| Scenario | Area | Kind | Required | Result | Notes |');
  push('| --- | --- | --- | --- | --- | --- |');
  const byId = new Map(report.scenarioResults.map((result) => [result.scenarioId, result]));
  for (const scenario of QUALIFICATION_SCENARIOS) {
    const result = byId.get(scenario.id);
    const status = result?.status ?? 'NOT_RUN';
    const note =
      result?.failureDetail ?? result?.skipReason ?? (result === undefined ? 'not executed' : '');
    push(
      `| \`${scenario.id}\` | ${scenario.area} | ${scenario.executionKind} | ${scenario.requirement} | ${status} | ${note} |`,
    );
  }
  push();

  push('## Zero-tolerance conditions');
  push();
  push('| Condition | Observed |');
  push('| --- | --- |');
  for (const [condition, count] of Object.entries(report.zeroTolerance)) {
    push(`| ${condition} | ${count} |`);
  }
  push();

  push('## Autonomy');
  push();
  const card = report.scorecard;
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| Mission completed | ${card.missionCompleted === null ? 'unknown' : card.missionCompleted ? 'yes' : 'no'} |`);
  push(`| Objectives completed | ${card.objectivesCompleted}/${card.objectivesTotal} |`);
  push(`| Tasks verified | ${card.tasksVerified}/${card.tasksTotal} |`);
  push(`| Verified completion rate | ${formatRatio(card.verifiedCompletionRate)} |`);
  push(`| First-attempt success rate | ${formatRatio(card.firstAttemptSuccessRate)} |`);
  push(`| Attempts per verified task | ${card.attemptsPerSuccessfulTask === null ? 'n/a' : card.attemptsPerSuccessfulTask.toFixed(2)} |`);
  push(`| Tasks verified with no intervention | ${card.tasksCompletedWithoutIntervention} |`);
  push(`| Human interventions | ${card.manualInterventions} |`);
  push(`| — manual code edits | ${card.manualCodeEdits} |`);
  push(`| — manual state repairs | ${card.manualStateRepairs} |`);
  push(`| — manual context repairs | ${card.manualContextRepairs} |`);
  push(`| — manual scheduler interventions | ${card.manualSchedulerInterventions} |`);
  push(`| Process restarts survived | ${card.processRestartsSurvived} |`);
  push(`| Session losses survived | ${card.sessionLossesSurvived} |`);
  push(`| Context compactions survived | ${card.contextCompactionsSurvived} |`);
  push(`| Quota resets crossed | ${card.quotaResetsCrossed} |`);
  push(`| Replans | ${card.replans} |`);
  push(`| Recoveries | ${card.recoveriesSucceeded}/${card.recoveriesAttempted} succeeded |`);
  push(`| Wall time | ${formatDuration(card.wallTimeMs)} |`);
  push(`| Active execution time | ${formatDuration(card.activeExecutionMs)} |`);
  push(`| Reported input tokens | ${formatNumber(card.reportedInputTokens)} |`);
  push(`| Reported output tokens | ${formatNumber(card.reportedOutputTokens)} |`);
  push();

  push('## Human interventions');
  push();
  if (report.humanInterventions.length === 0) {
    push('None recorded.');
  } else {
    push('| Kind | Boundary | Description |');
    push('| --- | --- | --- |');
    for (const entry of report.humanInterventions) {
      push(`| ${entry.kind} | ${entry.policyBoundary ?? '—'} | ${entry.description} |`);
    }
  }
  push();

  push('## Economics');
  push();
  const e = report.economics;
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| LOCAL attempts | ${e.localAttempts} (direct ${e.localDirectAttempts}, harness ${e.localHarnessAttempts}) |`);
  push(`| SUBSCRIPTION attempts | ${e.subscriptionAttempts} |`);
  push(`| API attempts | ${e.apiAttempts} |`);
  push(`| LOCAL verified successes | ${e.localVerifiedSuccesses} |`);
  push(`| SUBSCRIPTION verified successes | ${e.subscriptionVerifiedSuccesses} |`);
  push(`| API verified successes | ${e.apiVerifiedSuccesses} |`);
  push(`| HARVEST entries | ${e.harvestEntries} |`);
  push(`| Weekly pressure events | ${e.weeklyPressureEvents} |`);
  push(`| Five-hour remaining (last observed) | ${formatRatio(e.fiveHourRemainingRatio)} |`);
  push(`| Weekly remaining (last observed) | ${formatRatio(e.weeklyRemainingRatio)} |`);
  push(`| API estimated spend | ${formatUsd(e.apiEstimatedSpendUsd)} |`);
  push(`| API reconciled spend | ${formatUsd(e.apiReconciledSpendUsd)} |`);
  push(`| API attempts with unknown cost | ${e.apiUnknownCostAttempts} |`);
  push(`| Failed-work cost | ${formatUsd(e.failedWorkCostUsd)} |`);
  push(`| Failed-work time | ${formatDuration(e.failedWorkMs)} |`);
  push(`| Failed-work tokens | ${formatNumber(e.failedWorkTokens)} |`);
  push();

  push('## Reliability');
  push();
  const r = report.reliability;
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| Total failures | ${r.totalFailures} |`);
  push(`| — infrastructure | ${r.infrastructureFailures} |`);
  push(`| — implementation | ${r.implementationFailures} |`);
  push(`| — context | ${r.contextFailures} |`);
  push(`| — verification | ${r.verificationFailures} |`);
  push(`| STALLED events | ${r.stalledEvents} |`);
  push(`| OSCILLATING events | ${r.oscillationEvents} |`);
  push(`| RUNAWAY events | ${r.runawayEvents} |`);
  push(`| Repairs | ${r.repairs} |`);
  push(`| Fresh-context restarts | ${r.freshContextRestarts} |`);
  push(`| Context expansions | ${r.contextExpansions} |`);
  push(`| Replans | ${r.replans} |`);
  push(`| Lane escalations | ${r.laneEscalations} |`);
  push(`| Blocked tasks | ${r.blockedTasks} |`);
  push(`| Successful recoveries | ${r.successfulRecoveries} |`);
  push(`| Evaluations | ${r.evaluationsPassed} PASS, ${r.evaluationsFailed} FAIL, ${r.evaluationsInconclusive} INCONCLUSIVE |`);
  push();

  push('## Context');
  push();
  const c = report.context;
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| Strategy | ${c.strategy ?? 'unknown'} |`);
  push(`| Estimated input context tokens | ${formatNumber(c.estimatedInputContextTokens)} |`);
  push(`| Provider-reported input tokens | ${formatNumber(c.providerReportedInputTokens)} |`);
  push(`| Provider-reported output tokens | ${formatNumber(c.providerReportedOutputTokens)} |`);
  push(`| Working-set items | ${formatNumber(c.workingSetItems)} |`);
  push(`| Compression savings (chars) | ${formatNumber(c.compressionSavingsTokens)} |`);
  push(`| Deduplication savings (chars) | ${formatNumber(c.deduplicationSavingsTokens)} |`);
  push(`| Progressive expansions | ${c.progressiveExpansions} |`);
  push(`| Expansion exhaustions | ${c.expansionExhaustions} |`);
  push(`| Native compactions | ${formatNumber(c.nativeCompactions)} |`);
  push(`| Context compactions | ${c.contextCompactions} |`);
  push(`| Context misses | ${c.contextMisses} |`);
  push(`| Index builds / refreshes | ${c.indexBuilds} / ${c.indexRefreshes} |`);
  push(`| Context per verified task | ${c.contextPerVerifiedTask === null ? 'n/a' : Math.round(c.contextPerVerifiedTask).toLocaleString('en-US')} |`);
  push(`| Retries attributed to context | ${c.retriesAttributableToContext} |`);
  push();

  push('## Adaptive scheduler');
  push();
  const a = report.adaptive;
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| Mode | ${a.mode ?? 'unknown'} |`);
  push(`| HEURISTIC decisions | ${a.heuristicDecisions} |`);
  push(`| SHADOW recommendations | ${a.shadowRecommendations} |`);
  push(`| SHADOW disagreements | ${a.shadowDisagreements} |`);
  push(`| ADAPTIVE decisions | ${a.adaptiveDecisions} |`);
  push(`| Heuristic fallbacks | ${a.heuristicFallbacks} |`);
  push(`| Hard-policy vetoes | ${a.hardPolicyVetoes} |`);
  push(`| Drift events | ${a.driftEvents} |`);
  push(`| Profile rebuilds | ${a.profileRebuilds} |`);
  push(`| Calibration samples | ${a.calibrationSamples} |`);
  push(`| Mean Brier score | ${a.calibrationBrierScore === null ? 'n/a' : a.calibrationBrierScore.toFixed(4)} |`);
  push();
  push(
    '> Shadow recommendations were recorded, not executed. No outcome is attributed to an ' +
      'unexecuted candidate anywhere in this report.',
  );
  push();

  push('## Fault injections');
  push();
  if (report.faultInjections.length === 0) {
    push('None recorded.');
  } else {
    push('| Fault | Class | Boundary | Survived | Observed |');
    push('| --- | --- | --- | --- | --- |');
    for (const fault of report.faultInjections) {
      push(
        `| \`${fault.faultId}\` | ${fault.faultClass} | ${fault.boundary} | ` +
          `${fault.survived === null ? 'unresolved' : fault.survived ? 'yes' : 'NO'} | ${fault.observed ?? '—'} |`,
      );
    }
  }
  push();

  push('## State invariant audits');
  push();
  if (report.invariantAudits.length === 0) {
    push('None taken.');
  } else {
    push('| Phase | Checked | Violations | Blocking |');
    push('| --- | --- | --- | --- |');
    for (const audit of report.invariantAudits) {
      push(
        `| ${audit.phase} | ${audit.checked.length} | ${audit.violations.length} | ` +
          `${audit.violations.filter((entry) => entry.blocking).length} |`,
      );
    }
    const violations = report.invariantAudits.flatMap((audit) => audit.violations);
    if (violations.length > 0) {
      push();
      push('Violations:');
      push();
      for (const entry of violations) {
        push(`- \`${entry.invariantId}\` on ${entry.subject}${entry.blocking ? ' **(blocking)**' : ''}: ${entry.detail}`);
      }
    }
  }
  push();

  push('## Defects discovered');
  push();
  if (report.defects.length === 0) {
    push('None recorded.');
  } else {
    for (const defect of report.defects) {
      push(`### ${defect.defectId} (${defect.source})${defect.blocking ? ' — blocking' : ''}`);
      push();
      push(`- **Observed failure:** ${defect.observedFailure}`);
      push(`- **Root cause:** ${defect.rootCause ?? 'not yet determined'}`);
      push(`- **Affected invariant:** ${defect.affectedInvariant ?? 'n/a'}`);
      push(`- **Fix:** ${defect.fix ?? 'not applied'}`);
      push(`- **Regression test:** ${defect.regressionTest ?? '**none — the fix is uncovered**'}`);
      push(`- **Changes public contract:** ${defect.changesPublicContract ? 'yes' : 'no'}`);
      push(`- **Affects a prior-phase guarantee:** ${defect.affectsPriorPhaseGuarantee ? 'yes' : 'no'}`);
      push();
    }
  }

  push('## Release blockers');
  push();
  if (report.blockers.length === 0) {
    push('None.');
  } else {
    for (const blocker of report.blockers) push(`- **${blocker.class}** — ${blocker.detail}`);
  }
  push();

  push('## Limitations');
  push();
  if (report.limitations.length === 0) {
    push('None documented.');
  } else {
    for (const limitation of report.limitations) {
      push(`- **${limitation.class}** — ${limitation.detail}`);
    }
  }
  push();

  push('## Verdict basis');
  push();
  for (const statement of report.verdictBasis) push(`- ${statement}`);
  push();

  if (report.timeline.length > 0) {
    push('## Timeline');
    push();
    push('| When | Milestone |');
    push('| --- | --- |');
    for (const entry of report.timeline) push(`| ${entry.at} | ${entry.milestone} |`);
    push();
  }

  push('---');
  push();
  push(`Generated ${report.generatedAt} from durable qualification records.`);
  push();
  return lines.join('\n');
}

/** Canonical artifact names, following the project's report conventions. */
export const QUALIFICATION_ARTIFACTS = Object.freeze({
  summary: 'qualification-summary.json',
  report: 'qualification-report.md',
  scenarios: 'scenario-results.json',
  metrics: 'mission-metrics.json',
});

/**
 * The compact machine-readable summary CI reads.
 *
 * Everything a release pipeline needs to gate on, and nothing else: the
 * verdict, the blockers, and which required scenarios are unproven. A
 * pipeline that had to parse the full report to find out whether it may ship
 * would end up encoding its own opinion of what counts as a failure.
 */
export function buildQualificationSummary(
  report: DogfoodQualificationReport,
): Record<string, unknown> {
  return {
    schemaVersion: report.schemaVersion,
    runId: report.runId,
    generatedAt: report.generatedAt,
    profile: report.profile,
    verdict: report.verdict,
    realTargetQualification: report.realTargetQualification,
    realTargetQualificationReason: report.realTargetQualificationReason,
    releaseBlockers: report.blockers.map((blocker) => ({
      class: blocker.class,
      detail: blocker.detail,
    })),
    limitations: report.limitations.map((limitation) => ({
      class: limitation.class,
      detail: limitation.detail,
    })),
    zeroTolerance: report.zeroTolerance,
    scenarios: report.scenarios,
    requiredScenarioFailures: report.scenarioResults
      .filter((result) => result.requirement === 'REQUIRED' && result.status === 'FAIL')
      .map((result) => result.scenarioId),
    requiredScenariosUnproven: QUALIFICATION_SCENARIOS.filter(
      (scenario) => scenario.requirement === 'REQUIRED',
    )
      .filter((scenario) => {
        const result = report.scenarioResults.find((entry) => entry.scenarioId === scenario.id);
        return result === undefined || result.status !== 'PASS';
      })
      .map((scenario) => scenario.id),
    resourceAttribution: report.resourceAttribution,
  };
}

/** The mission-metrics artifact: the scorecard plus the derived reports. */
export function buildMissionMetrics(
  report: DogfoodQualificationReport,
): Record<string, unknown> {
  return {
    schemaVersion: report.schemaVersion,
    runId: report.runId,
    missionId: report.missionId,
    jobId: report.jobId,
    scorecard: report.scorecard,
    economics: report.economics,
    reliability: report.reliability,
    context: report.context,
    adaptive: report.adaptive,
  };
}
