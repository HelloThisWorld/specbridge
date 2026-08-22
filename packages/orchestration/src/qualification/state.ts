import { z } from 'zod';
import { STATE_LIMITS } from '../state.js';
import {
  DEFECT_SOURCES,
  DOGFOOD_RUN_STATUSES,
  DOGFOOD_TARGET_KINDS,
  FAULT_BOUNDARIES,
  FAULT_CLASSES,
  FAULT_TRIGGER_MODES,
  HUMAN_INTERVENTION_KINDS,
  INVARIANT_AUDIT_PHASES,
  LIMITATION_CLASSES,
  QUALIFICATION_AREAS,
  QUALIFICATION_PROFILES,
  QUALIFICATION_RESOURCES,
  RELEASE_BLOCKER_CLASSES,
  RELEASE_VERDICTS,
  RESOURCE_ATTRIBUTIONS,
  SCENARIO_EXECUTION_KINDS,
  SCENARIO_REQUIREMENTS,
  SCENARIO_RESULT_STATUSES,
  STATE_INVARIANT_IDS,
} from './vocabulary.js';

/**
 * Durable qualification state (vNext.9), persisted under
 * `.specbridge/qualification/<runId>/`.
 *
 * A qualification run is a DURABLE ACCUMULATOR, not a process. Results
 * arrive from more than one executor — the operator CLI runs the policy
 * scenarios, the regression suite runs the driver-level ones, and a real
 * dogfood contributes its Mission evidence over hours or days — and the run
 * has to survive all of them being interrupted. That is why nothing here is
 * a summary computed at the end: every record is written when it is
 * observed, and every report in this module is derived from these records
 * on read.
 *
 * The same exclusions as every other SpecBridge state family apply
 * structurally: no prompts, no transcripts, no model reasoning, no source
 * file contents, nothing credential-shaped. A qualification report exists to
 * be shared, which makes those exclusions load-bearing rather than tidy.
 */

export const DOGFOOD_RUN_SCHEMA_VERSION = '1.0.0';
export const QUALIFICATION_REPORT_SCHEMA_VERSION = '1.0.0';

export const QUALIFICATION_LIMITS = {
  maxListItems: 100,
  maxTextChars: 2_000,
  maxShortTextChars: STATE_LIMITS.maxShortTextChars,
  maxObservations: 200,
  maxEvidenceRefs: 50,
  maxTimelineEntries: 1_000,
} as const;

const shortText = z.string().min(1).max(QUALIFICATION_LIMITS.maxShortTextChars);
const text = z.string().min(1).max(QUALIFICATION_LIMITS.maxTextChars);
const textList = z.array(text).max(QUALIFICATION_LIMITS.maxListItems);
const refList = z.array(shortText).max(QUALIFICATION_LIMITS.maxEvidenceRefs);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const count = z.number().int().min(0);

// ---------------------------------------------------------------------------
// Run identity
// ---------------------------------------------------------------------------

/**
 * Enough identity to say later exactly what was tested.
 *
 * Every field is nullable because "unknown" is a legitimate and frequent
 * answer — a runner that does not report its version, a target repository
 * with no git history — and a guessed version in a release report is worse
 * than an absent one.
 */
export const runtimeVersionsSchema = z
  .object({
    specBridgeVersion: shortText.nullable().default(null),
    specBridgeCommit: shortText.nullable().default(null),
    nodeVersion: shortText.nullable().default(null),
    platform: shortText.nullable().default(null),
    /** Local model identity as configured/reported. */
    localModel: shortText.nullable().default(null),
    /** DeepSeek Harness / DSH SDK versions when the harness reported them. */
    harnessVersion: shortText.nullable().default(null),
    harnessSdkVersion: shortText.nullable().default(null),
    /** Subscription agent CLI version when probed. */
    subscriptionRunnerVersion: shortText.nullable().default(null),
    /** Codex CLI version when that runner was exercised. */
    codexVersion: shortText.nullable().default(null),
    /** vNext.7 context strategy in force. */
    contextStrategy: shortText.nullable().default(null),
    /** vNext.8 adaptive mode in force. */
    adaptiveMode: shortText.nullable().default(null),
    /** Fingerprint of the orchestration policy the run was bound to. */
    policyFingerprint: shortText.nullable().default(null),
  })
  .passthrough();
export type RuntimeVersions = z.infer<typeof runtimeVersionsSchema>;

/**
 * The dogfood target. `kind` is the structural guard behind the release
 * gate: a FIXTURE target can never satisfy it, whatever else the run
 * achieved, so there is no path from a synthetic repository to a PASS on the
 * real-product scenario.
 *
 * `repositoryPath` is the operator's configured path, recorded so a report
 * can be reproduced. It is never defaulted to a machine-specific location.
 */
export const dogfoodTargetSchema = z
  .object({
    kind: z.enum(DOGFOOD_TARGET_KINDS),
    /** Product name, e.g. "StepRelay". */
    name: shortText,
    /** Configured repository path, as given. Null when unavailable. */
    repositoryPath: shortText.nullable().default(null),
    /** Whether that path resolved to a readable repository at preflight. */
    available: z.boolean().default(false),
    /** Why the target was unavailable, when it was not. */
    unavailableReason: text.nullable().default(null),
    startingCommit: shortText.nullable().default(null),
    endingCommit: shortText.nullable().default(null),
    branch: shortText.nullable().default(null),
    /** Isolated worktree the dogfood was confined to, when one was used. */
    worktreePath: shortText.nullable().default(null),
    /** The approved spec/mission the Mission was declared against. */
    missionSpec: shortText.nullable().default(null),
  })
  .passthrough();
export type DogfoodTarget = z.infer<typeof dogfoodTargetSchema>;

/**
 * One dogfood/qualification run. Durable, resumable, and deliberately thin:
 * it binds identity and configuration to the Mission and Job that do the
 * work, and owns no scheduling of its own.
 */
export const dogfoodRunSchema = z
  .object({
    schemaVersion: semver,
    runId: shortText,
    status: z.enum(DOGFOOD_RUN_STATUSES),
    profile: z.enum(QUALIFICATION_PROFILES),
    target: dogfoodTargetSchema,
    versions: runtimeVersionsSchema.default({}),
    /**
     * Stable fingerprint of the configuration the run was started under.
     * Comparing it across iterations is how a report can say whether run #3
     * differed from run #1 in the system or only in the weather.
     */
    configurationFingerprint: shortText,
    /** The Mission this run is dogfooding, when one is bound. */
    missionId: shortText.nullable().default(null),
    /** The long-running Job carrying the Mission's work, when one is bound. */
    jobId: shortText.nullable().default(null),
    /** Iteration number within a series of dogfood runs against one target. */
    iteration: z.number().int().min(1).default(1),
    /** The run this iteration continues from, for progress/regression views. */
    previousRunId: shortText.nullable().default(null),
    /** Human-stated Mission direction, recorded verbatim and bounded. */
    missionDirection: text.nullable().default(null),
    /**
     * Approved Mission scope at the time the run started, and any later
     * scope change with its provenance. A reduced Mission reported as the
     * original one is the exact dishonesty this field exists to prevent.
     */
    approvedScope: textList.default([]),
    scopeChanges: z
      .array(
        z
          .object({
            at: shortText,
            originalScope: text,
            newScope: text,
            reason: text,
            authority: shortText,
            effectOnQualification: text,
          })
          .passthrough(),
      )
      .max(QUALIFICATION_LIMITS.maxListItems)
      .default([]),
    startedAt: shortText,
    updatedAt: shortText,
    finalizedAt: shortText.nullable().default(null),
    /** Wall-clock milliseconds the run has been active, excluding pauses. */
    activeMs: count.default(0),
    /** Wall-clock milliseconds the run spent deliberately paused. */
    pausedMs: count.default(0),
    /** Operator-visible note recorded at the last state change. */
    note: text.nullable().default(null),
  })
  .passthrough();
export type DogfoodRun = z.infer<typeof dogfoodRunSchema>;

// ---------------------------------------------------------------------------
// Scenario results
// ---------------------------------------------------------------------------

/**
 * One observed state transition a scenario relied on. Recording the
 * transitions rather than a boolean is what makes a PASS auditable: a reader
 * can see WHICH transition proved the claim, and a regression can be told
 * apart from a rewritten assertion.
 */
export const observedTransitionSchema = z
  .object({
    /** What changed: an event type, status transition, or decision code. */
    subject: shortText,
    from: shortText.nullable().default(null),
    to: shortText.nullable().default(null),
    /** Bounded explanation of why this transition mattered to the claim. */
    detail: text.optional(),
  })
  .passthrough();
export type ObservedTransition = z.infer<typeof observedTransitionSchema>;

/** The durable outcome of one qualification scenario. */
export const scenarioResultSchema = z
  .object({
    schemaVersion: semver,
    runId: shortText,
    scenarioId: shortText,
    area: z.enum(QUALIFICATION_AREAS),
    executionKind: z.enum(SCENARIO_EXECUTION_KINDS),
    requirement: z.enum(SCENARIO_REQUIREMENTS),
    status: z.enum(SCENARIO_RESULT_STATUSES),
    /** Required when status is SKIPPED_WITH_REASON; never a silent skip. */
    skipReason: text.nullable().default(null),
    /** Required when status is FAIL: what was expected versus observed. */
    failureDetail: text.nullable().default(null),
    /** Fault classes this scenario injected, when any. */
    faultClasses: z.array(z.enum(FAULT_CLASSES)).max(QUALIFICATION_LIMITS.maxListItems).default([]),
    /** The invariant the scenario asserts, in one sentence. */
    expectedInvariant: text,
    observedTransitions: z
      .array(observedTransitionSchema)
      .max(QUALIFICATION_LIMITS.maxObservations)
      .default([]),
    /** Ledger entries, job events, decision ids, or test files backing this. */
    evidenceRefs: refList.default([]),
    /** How each resource this scenario touched was actually exercised. */
    resourceAttribution: z
      .record(z.enum(QUALIFICATION_RESOURCES), z.enum(RESOURCE_ATTRIBUTIONS))
      .default({}),
    /** Which executor produced this result (`cli`, `regression-suite`, …). */
    executor: shortText,
    durationMs: count.nullable().default(null),
    recordedAt: shortText,
  })
  .passthrough();
export type ScenarioResult = z.infer<typeof scenarioResultSchema>;

// ---------------------------------------------------------------------------
// Human interventions
// ---------------------------------------------------------------------------

/**
 * One recorded human intervention.
 *
 * `kind` is chosen by the recorder and is the whole value of the record: an
 * operator who repaired generated source must not be able to file it as an
 * approval, so the classification is a closed enum and the autonomy report
 * partitions on it rather than on free text.
 */
export const humanInterventionSchema = z
  .object({
    schemaVersion: semver,
    runId: shortText,
    interventionId: shortText,
    kind: z.enum(HUMAN_INTERVENTION_KINDS),
    at: shortText,
    /** What the human did, bounded and non-sensitive. */
    description: text,
    /** Why it was necessary, in the recorder's own words. */
    reason: text,
    /** The Job/node/task the intervention touched, when scoped to one. */
    jobId: shortText.nullable().default(null),
    nodeId: shortText.nullable().default(null),
    taskId: shortText.nullable().default(null),
    /**
     * The governance boundary that required it, when kind is
     * REQUIRED_BY_POLICY — a decision kind, approval gate, or spend mode.
     * Absent on every other kind, which is how a policy-required
     * intervention is told from one that merely claims to be.
     */
    policyBoundary: shortText.nullable().default(null),
    /** Durable references: question id, approval id, commit, decision id. */
    evidenceRefs: refList.default([]),
  })
  .passthrough();
export type HumanIntervention = z.infer<typeof humanInterventionSchema>;

// ---------------------------------------------------------------------------
// Fault injections
// ---------------------------------------------------------------------------

/** A durable record that a specific fault was actually injected. */
export const faultInjectionRecordSchema = z
  .object({
    schemaVersion: semver,
    runId: shortText,
    faultId: shortText,
    faultClass: z.enum(FAULT_CLASSES),
    boundary: z.enum(FAULT_BOUNDARIES),
    triggerMode: z.enum(FAULT_TRIGGER_MODES),
    /** Deterministic condition that fired the injection. */
    trigger: text,
    /** The invariant expected to survive it. */
    expectedInvariant: text,
    /** Whether the invariant held. Null while the outcome is unknown. */
    survived: z.boolean().nullable().default(null),
    /** What was observed after injection. */
    observed: text.nullable().default(null),
    /** The scenario that injected it. */
    scenarioId: shortText.nullable().default(null),
    injectedAt: shortText,
    resolvedAt: shortText.nullable().default(null),
  })
  .passthrough();
export type FaultInjectionRecord = z.infer<typeof faultInjectionRecordSchema>;

// ---------------------------------------------------------------------------
// Invariant audits
// ---------------------------------------------------------------------------

export const invariantViolationSchema = z
  .object({
    invariantId: z.enum(STATE_INVARIANT_IDS),
    /** What was found, bounded and specific enough to act on. */
    detail: text,
    /** The record that violates it. */
    subject: shortText,
    /** True when this invariant is release-blocking. */
    blocking: z.boolean(),
  })
  .passthrough();
export type InvariantViolation = z.infer<typeof invariantViolationSchema>;

/**
 * One audit of durable state.
 *
 * Audits are taken before AND after every restart deliberately: state that
 * is valid before a restart and invalid after hydration is a durability bug,
 * and only a paired audit can tell that apart from state that was already
 * wrong.
 */
export const invariantAuditSchema = z
  .object({
    schemaVersion: semver,
    runId: shortText,
    auditId: shortText,
    phase: z.enum(INVARIANT_AUDIT_PHASES),
    jobId: shortText.nullable().default(null),
    at: shortText,
    /** Invariants actually evaluated in this audit. */
    checked: z.array(z.enum(STATE_INVARIANT_IDS)).max(QUALIFICATION_LIMITS.maxListItems).default([]),
    violations: z
      .array(invariantViolationSchema)
      .max(QUALIFICATION_LIMITS.maxObservations)
      .default([]),
    /** Context for the audit, e.g. the fault that preceded it. */
    note: text.nullable().default(null),
  })
  .passthrough();
export type InvariantAudit = z.infer<typeof invariantAuditSchema>;

// ---------------------------------------------------------------------------
// Defects and fixes
// ---------------------------------------------------------------------------

/**
 * A SpecBridge defect discovered by dogfood, and what was done about it.
 *
 * `regressionTest` is not optional in spirit: a fix without one is a one-off
 * patch, and the report shows it as such rather than quietly accepting it.
 */
export const dogfoodDefectSchema = z
  .object({
    schemaVersion: semver,
    runId: shortText,
    defectId: shortText,
    source: z.enum(DEFECT_SOURCES),
    /** What was observed to go wrong. */
    observedFailure: text,
    /** The root cause, once understood. */
    rootCause: text.nullable().default(null),
    /** The invariant or guarantee it violated. */
    affectedInvariant: text.nullable().default(null),
    /** The fix, when one was applied. */
    fix: text.nullable().default(null),
    /** The regression test covering it. Null means the fix is uncovered. */
    regressionTest: shortText.nullable().default(null),
    /** Whether the fix changed a public contract. */
    changesPublicContract: z.boolean().default(false),
    /** Whether the fix affects a guarantee an earlier phase committed to. */
    affectsPriorPhaseGuarantee: z.boolean().default(false),
    /** True while the defect remains open. */
    blocking: z.boolean().default(false),
    discoveredAt: shortText,
    resolvedAt: shortText.nullable().default(null),
  })
  .passthrough();
export type DogfoodDefect = z.infer<typeof dogfoodDefectSchema>;

/** A documented non-blocking limitation. */
export const qualificationLimitationSchema = z
  .object({
    class: z.enum(LIMITATION_CLASSES),
    detail: text,
    evidenceRefs: refList.default([]),
  })
  .passthrough();
export type QualificationLimitation = z.infer<typeof qualificationLimitationSchema>;

/** A recorded release blocker. */
export const releaseBlockerSchema = z
  .object({
    class: z.enum(RELEASE_BLOCKER_CLASSES),
    detail: text,
    evidenceRefs: refList.default([]),
  })
  .passthrough();
export type ReleaseBlocker = z.infer<typeof releaseBlockerSchema>;

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * One milestone in the dogfood timeline, derived from durable job events.
 *
 * Derived, never authored: the timeline is a projection of
 * `.specbridge/jobs/<id>/events.jsonl`, which is why it can contain no
 * chain-of-thought — there is none in the source.
 */
export const timelineEntrySchema = z
  .object({
    at: shortText,
    /** The durable event type this milestone came from. */
    eventType: shortText,
    /** Human-readable milestone label. */
    milestone: shortText,
    jobId: shortText.nullable().default(null),
    nodeId: shortText.nullable().default(null),
  })
  .passthrough();
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

/**
 * Scorecard counters. Every field is a count or an explicitly nullable
 * measurement — there is no composite score, deliberately: one number would
 * hide precisely the trade-offs (cheap-but-wrong, correct-but-manual) that a
 * release decision has to see.
 */
export const autonomyScorecardSchema = z
  .object({
    missionCompleted: z.boolean().nullable().default(null),
    objectivesTotal: count,
    objectivesCompleted: count,
    tasksTotal: count,
    tasksCompleted: count,
    /** Tasks completed with a durable PASS verdict on record. */
    tasksVerified: count,
    /** Verified completions divided by tasks attempted. Null when none were. */
    verifiedCompletionRate: z.number().min(0).max(1).nullable().default(null),
    firstAttemptSuccessRate: z.number().min(0).max(1).nullable().default(null),
    attemptsPerSuccessfulTask: z.number().min(0).nullable().default(null),
    manualInterventions: count,
    manualCodeEdits: count,
    manualSchedulerInterventions: count,
    manualStateRepairs: count,
    manualContextRepairs: count,
    replans: count,
    recoveriesAttempted: count,
    recoveriesSucceeded: count,
    processRestartsSurvived: count,
    sessionLossesSurvived: count,
    contextCompactionsSurvived: count,
    quotaResetsCrossed: count,
    localAttempts: count,
    subscriptionAttempts: count,
    apiAttempts: count,
    apiSpendUsd: z.number().min(0).nullable().default(null),
    failedWorkCostUsd: z.number().min(0).nullable().default(null),
    wallTimeMs: count.nullable().default(null),
    activeExecutionMs: count.nullable().default(null),
    reportedInputTokens: count.nullable().default(null),
    reportedOutputTokens: count.nullable().default(null),
    /** Tasks that reached verified completion with no human intervention. */
    tasksCompletedWithoutIntervention: count,
  })
  .passthrough();
export type AutonomyScorecard = z.infer<typeof autonomyScorecardSchema>;

export const economicReportSchema = z
  .object({
    localAttempts: count,
    localDirectAttempts: count,
    localHarnessAttempts: count,
    subscriptionAttempts: count,
    apiAttempts: count,
    localVerifiedSuccesses: count,
    subscriptionVerifiedSuccesses: count,
    apiVerifiedSuccesses: count,
    /** Observed five-hour remaining ratio at the most recent observation. */
    fiveHourRemainingRatio: z.number().min(0).max(1).nullable().default(null),
    weeklyRemainingRatio: z.number().min(0).max(1).nullable().default(null),
    /** Prepaid capacity observed unused at a reset, when observable. */
    unusedFiveHourCapacityObservations: count,
    harvestEntries: count,
    weeklyPressureEvents: count,
    apiEstimatedSpendUsd: z.number().min(0).nullable().default(null),
    apiReconciledSpendUsd: z.number().min(0).nullable().default(null),
    /** API attempts whose real cost is unknowable. Never treated as zero. */
    apiUnknownCostAttempts: count,
    failedWorkCostUsd: z.number().min(0).nullable().default(null),
    failedWorkMs: count.nullable().default(null),
    failedWorkTokens: count.nullable().default(null),
  })
  .passthrough();
export type EconomicReport = z.infer<typeof economicReportSchema>;

export const reliabilityReportSchema = z
  .object({
    totalFailures: count,
    infrastructureFailures: count,
    implementationFailures: count,
    contextFailures: count,
    verificationFailures: count,
    stalledEvents: count,
    oscillationEvents: count,
    runawayEvents: count,
    repairs: count,
    freshContextRestarts: count,
    contextExpansions: count,
    replans: count,
    laneEscalations: count,
    blockedTasks: count,
    successfulRecoveries: count,
    /** Recovery actions chosen, by action. */
    recoveryActions: z.record(z.string(), count).default({}),
    /** Failure sources observed, by source. */
    failureSources: z.record(z.string(), count).default({}),
    /** Deterministic health states observed, by state. */
    healthStates: z.record(z.string(), count).default({}),
    evaluationsPassed: count,
    evaluationsFailed: count,
    evaluationsInconclusive: count,
  })
  .passthrough();
export type ReliabilityReport = z.infer<typeof reliabilityReportSchema>;

export const contextReportSchema = z
  .object({
    estimatedInputContextTokens: count.nullable().default(null),
    providerReportedInputTokens: count.nullable().default(null),
    providerReportedOutputTokens: count.nullable().default(null),
    workingSetItems: count.nullable().default(null),
    compressionSavingsTokens: count.nullable().default(null),
    deduplicationSavingsTokens: count.nullable().default(null),
    progressiveExpansions: count,
    expansionExhaustions: count,
    /**
     * Provider-native compactions. Nullable because a runner that says
     * nothing about its own compaction is UNKNOWN, not zero — and a zero
     * here would read as "the provider never compacted", which is a claim
     * SpecBridge was never in a position to make.
     */
    nativeCompactions: count.nullable().default(null),
    contextCompactions: count,
    contextMisses: count,
    indexBuilds: count,
    indexRefreshes: count,
    /** Estimated context consumed per verified task. Null when none verified. */
    contextPerVerifiedTask: z.number().min(0).nullable().default(null),
    /** Attempts retried where the recorded cause was context insufficiency. */
    retriesAttributableToContext: count,
    strategy: shortText.nullable().default(null),
  })
  .passthrough();
export type ContextReport = z.infer<typeof contextReportSchema>;

export const adaptiveReportSchema = z
  .object({
    mode: shortText.nullable().default(null),
    heuristicDecisions: count,
    shadowRecommendations: count,
    shadowDisagreements: count,
    adaptiveDecisions: count,
    /** Predictions by confidence level. */
    confidenceDistribution: z.record(z.string(), count).default({}),
    heuristicFallbacks: count,
    /** Fallbacks by reason code. */
    fallbackReasons: z.record(z.string(), count).default({}),
    hardPolicyVetoes: count,
    /** Vetoes by veto code. */
    vetoCodes: z.record(z.string(), count).default({}),
    driftEvents: count,
    profileRebuilds: count,
    /** Calibration summary, when enough observations existed to compute one. */
    calibrationSamples: count,
    calibrationBrierScore: z.number().min(0).nullable().default(null),
  })
  .passthrough();
export type AdaptiveReport = z.infer<typeof adaptiveReportSchema>;

export const zeroToleranceReportSchema = z
  .object({
    unauthorizedPaidExecutions: count,
    canonicalStateLosses: count,
    adaptiveHardPolicyBypasses: count,
    evidenceBypassCompletions: count,
    unrecoverableInjectedFaults: count,
    acceptedProtectedStateMutations: count,
    unboundedRetryLoops: count,
    manualDurableStateRepairs: count,
    dependentsOnFailedPredecessors: count,
  })
  .passthrough();
export type ZeroToleranceReport = z.infer<typeof zeroToleranceReportSchema>;

/** Per-scenario roll-up used by both the summary and the release gate. */
export const scenarioSummarySchema = z
  .object({
    total: count,
    passed: count,
    failed: count,
    skipped: count,
    notRun: count,
    requiredTotal: count,
    requiredPassed: count,
    requiredFailed: count,
    requiredUnproven: count,
    releaseGateStatus: z.enum(SCENARIO_RESULT_STATUSES),
    releaseGateReason: text.nullable().default(null),
  })
  .passthrough();
export type ScenarioSummary = z.infer<typeof scenarioSummarySchema>;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * The DogfoodQualificationReport: the machine-readable release artifact.
 *
 * Derived entirely from durable records, so it is reproducible from a run
 * directory alone and cannot drift from what actually happened. CI reads
 * `verdict`, `blockers`, and `scenarios` and needs nothing else to decide
 * whether a release may proceed.
 */
export const dogfoodQualificationReportSchema = z
  .object({
    schemaVersion: semver,
    runId: shortText,
    generatedAt: shortText,
    profile: z.enum(QUALIFICATION_PROFILES),
    status: z.enum(DOGFOOD_RUN_STATUSES),
    target: dogfoodTargetSchema,
    versions: runtimeVersionsSchema,
    configurationFingerprint: shortText,
    missionId: shortText.nullable().default(null),
    jobId: shortText.nullable().default(null),
    iteration: z.number().int().min(1),
    previousRunId: shortText.nullable().default(null),
    missionDirection: text.nullable().default(null),
    approvedScope: textList,
    scopeChanges: z.array(z.record(z.string(), z.unknown())).max(QUALIFICATION_LIMITS.maxListItems),
    startedAt: shortText,
    finalizedAt: shortText.nullable(),
    durationMs: count.nullable(),
    activeMs: count,
    pausedMs: count,
    /** What was REAL, SIMULATED, or NOT_EXERCISED, per resource. */
    resourceAttribution: z.record(
      z.enum(QUALIFICATION_RESOURCES),
      z.enum(RESOURCE_ATTRIBUTIONS),
    ),
    scenarios: scenarioSummarySchema,
    scenarioResults: z.array(scenarioResultSchema).max(500),
    faultInjections: z.array(faultInjectionRecordSchema).max(500),
    invariantAudits: z.array(invariantAuditSchema).max(500),
    humanInterventions: z.array(humanInterventionSchema).max(500),
    defects: z.array(dogfoodDefectSchema).max(500),
    scorecard: autonomyScorecardSchema,
    economics: economicReportSchema,
    reliability: reliabilityReportSchema,
    context: contextReportSchema,
    adaptive: adaptiveReportSchema,
    zeroTolerance: zeroToleranceReportSchema,
    timeline: z.array(timelineEntrySchema).max(QUALIFICATION_LIMITS.maxTimelineEntries),
    blockers: z.array(releaseBlockerSchema).max(QUALIFICATION_LIMITS.maxListItems),
    limitations: z.array(qualificationLimitationSchema).max(QUALIFICATION_LIMITS.maxListItems),
    verdict: z.enum(RELEASE_VERDICTS),
    /** The reasoning behind the verdict, as discrete auditable statements. */
    verdictBasis: textList,
    /**
     * Whether the real product Mission was actually qualified. Reported
     * separately from the verdict so that a run which built and proved all
     * the machinery but never met the external prerequisite cannot read as
     * though it had.
     */
    realTargetQualification: z.enum(['PASSED', 'FAILED', 'NOT_RUN']),
    realTargetQualificationReason: text.nullable().default(null),
  })
  .passthrough();
export type DogfoodQualificationReport = z.infer<typeof dogfoodQualificationReportSchema>;
