import { z } from 'zod';

/**
 * Governed-orchestration policy (v1.1), stored additively inside
 * `.specbridge/config.json`.
 *
 * This lives in @specbridge/core alongside the other configuration schemas so
 * that the configuration reader stays the single place a policy can come
 * from. @specbridge/orchestration consumes the resolved policy; it never
 * parses configuration itself, and no policy value may ever originate from
 * model output, spec text, plan text, or repository content.
 *
 * Backward compatibility: the whole block is optional with safe defaults, so
 * every existing v1 and v2 configuration file keeps parsing unchanged and no
 * migration is required. The configuration schema version is deliberately NOT
 * bumped — this is an additive optional block, exactly like the optional
 * fields v0.5 added to the run record.
 *
 * Deliberately absent: anything that could weaken a safety boundary. There is
 * no way to configure a command, a shell, a network endpoint, an approval
 * bypass, or a verification bypass from here. The bounds below can only make
 * execution *stop sooner*.
 */

/**
 * Plan review policy.
 *
 * - `review`   the plan must be presented to the user and explicitly
 *              confirmed before the first implementation mutation. This is
 *              the safe default for interactive Claude Code usage.
 * - `auto`     an explicit opt-in for lower-friction execution after the
 *              spec and task have already passed the normal human approval
 *              gates. A plan is still required, still recorded, and material
 *              replanning is still surfaced.
 * - `disabled` no execution plan is required. This does NOT disable any
 *              other gate: approvals, evidence, verification, protected
 *              paths, and budgets all still apply. It exists so the
 *              lower-level `/specbridge:implement` lifecycle keeps its
 *              historical behaviour.
 */
export const PLAN_REVIEW_MODES = ['review', 'auto', 'disabled'] as const;
export type PlanReviewMode = (typeof PLAN_REVIEW_MODES)[number];

export const orchestrationPlanningPolicySchema = z
  .object({
    mode: z.enum(PLAN_REVIEW_MODES).default('review'),
    /** Maximum number of replans in one orchestration run. */
    maxReplans: z.number().int().min(0).max(20).default(2),
    /** Maximum stored size of one execution plan document. */
    maxPlanBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
    /** Maximum ordered implementation steps in one plan. */
    maxPlanSteps: z.number().int().min(1).max(200).default(40),
  })
  .passthrough();
export type OrchestrationPlanningPolicy = z.infer<typeof orchestrationPlanningPolicySchema>;

export const orchestrationExecutionPolicySchema = z
  .object({
    /** Hard ceiling on recorded observe/decide/act iterations. */
    maxIterations: z.number().int().min(1).max(500).default(12),
    /** Hard ceiling on repair cycles triggered by verification failures. */
    maxRepairCycles: z.number().int().min(0).max(50).default(3),
    /** Consecutive no-progress cycles tolerated before replan or block. */
    maxNoProgressCycles: z.number().int().min(1).max(20).default(2),
    /**
     * Wall-clock budget for one orchestration run. Enforced whenever a
     * decision is requested — SpecBridge never interrupts a host agent
     * mid-thought, it refuses the next step.
     */
    maxElapsedMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 3_600_000)
      .default(4 * 3_600_000),
  })
  .passthrough();
export type OrchestrationExecutionPolicy = z.infer<typeof orchestrationExecutionPolicySchema>;

export const orchestrationRetryPolicySchema = z
  .object({
    /** Bounded retries for operations classified as safely transient. */
    maxTransientRetries: z.number().int().min(0).max(10).default(2),
    /** First backoff delay; doubles per attempt up to maxBackoffMs. */
    baseBackoffMs: z.number().int().min(0).max(600_000).default(1_000),
    maxBackoffMs: z.number().int().min(0).max(3_600_000).default(30_000),
  })
  .passthrough();
export type OrchestrationRetryPolicy = z.infer<typeof orchestrationRetryPolicySchema>;

export const orchestrationClarificationPolicySchema = z
  .object({
    /** Bounded clarification rounds before the run blocks. */
    maxRounds: z.number().int().min(1).max(10).default(3),
    maxQuestionsPerRound: z.number().int().min(1).max(20).default(5),
    maxQuestionBytes: z.number().int().min(64).max(8_192).default(1_024),
    maxAnswerBytes: z.number().int().min(64).max(16_384).default(4_096),
  })
  .passthrough();
export type OrchestrationClarificationPolicy = z.infer<
  typeof orchestrationClarificationPolicySchema
>;

export const orchestrationHistoryPolicySchema = z
  .object({
    /** Append-only event ceiling. Reaching it blocks; it never truncates. */
    maxEvents: z.number().int().min(50).max(100_000).default(2_000),
    /** Per-event serialized ceiling; oversized payloads are rejected. */
    maxEventBytes: z.number().int().min(256).max(65_536).default(8_192),
    /** Default number of events returned by bounded views. */
    defaultEventPageSize: z.number().int().min(1).max(500).default(50),
  })
  .passthrough();
export type OrchestrationHistoryPolicy = z.infer<typeof orchestrationHistoryPolicySchema>;

// ---------------------------------------------------------------------------
// v1.2 job orchestration policy
// ---------------------------------------------------------------------------

/**
 * How a reasoning role is routed between the local tier and the large agent.
 *
 * - `local-first`  attempt the local model when it is configured, healthy,
 *                  and the deterministic complexity class permits; escalate
 *                  on evidence (never on a whim, never silently)
 * - `large-agent`  route directly to the large agent
 * - `disabled`     skip the role entirely (only roles whose absence is safe
 *                  accept this: classification falls back to deterministic
 *                  signals, critique falls back to plan review policy)
 */
export const ROLE_ROUTES = ['local-first', 'large-agent', 'disabled'] as const;
export type RoleRoute = (typeof ROLE_ROUTES)[number];

/**
 * The executor is the only repository-writing role, and in this version it
 * routes exclusively to the large agent. `local` is deliberately NOT a value
 * of this enum: local source execution is a future explicit opt-in, and
 * adding a new enum member later is additive — while shipping it now "just in
 * case" would make an unreviewed capability reachable by configuration.
 */
export const EXECUTOR_ROUTES = ['large-agent'] as const;
export type ExecutorRoute = (typeof EXECUTOR_ROUTES)[number];

export const jobRoutingPolicySchema = z
  .object({
    classifier: z.enum(ROLE_ROUTES).default('local-first'),
    planner: z.enum(['local-first', 'large-agent'] as const).default('local-first'),
    critic: z.enum(ROLE_ROUTES).default('local-first'),
    diagnoser: z.enum(['local-first', 'large-agent'] as const).default('local-first'),
    replanner: z.enum(['local-first', 'large-agent'] as const).default('local-first'),
    executor: z.enum(EXECUTOR_ROUTES).default('large-agent'),
    /**
     * Objective-runtime reasoning roles (additive; defaults preserve the
     * local-first, escalate-on-evidence philosophy while routing the
     * architecture-sensitive roles — decomposition and semantic aggregation —
     * to the large agent, exactly as the complexity model demands. BUILDER
     * and INTEGRATOR have no route entries: like the executor, repository
     * work structurally requires the large agent.
     */
    decomposer: z.enum(['local-first', 'large-agent'] as const).default('large-agent'),
    evaluator: z.enum(ROLE_ROUTES).default('local-first'),
    aggregator: z.enum(['local-first', 'large-agent'] as const).default('large-agent'),
  })
  .passthrough();
export type JobRoutingPolicy = z.infer<typeof jobRoutingPolicySchema>;

/**
 * When a runtime plan needs an explicit human review before execution.
 *
 * - `high-risk` (default) HIGH-complexity or architecture-flagged plans need
 *               a human; LOW/MEDIUM plans proceed on critic acceptance
 * - `always`    every plan needs a human review
 * - `auto`      no human plan gate (spec approval gates still apply in full)
 */
export const JOB_PLAN_REVIEW_MODES = ['high-risk', 'always', 'auto'] as const;
export type JobPlanReviewMode = (typeof JOB_PLAN_REVIEW_MODES)[number];

/**
 * How escalation to the large agent behaves when a deterministic trigger
 * fires. `automatic` escalates and records why; `manual` stops the job with
 * NEEDS_CLARIFICATION so the user decides whether to spend paid reasoning.
 */
export const ESCALATION_MODES = ['automatic', 'manual'] as const;
export type EscalationMode = (typeof ESCALATION_MODES)[number];

export const jobComplexityPolicySchema = z
  .object({
    /** Signal score at or above which a task classifies MEDIUM. */
    mediumScore: z.number().int().min(1).max(50).default(3),
    /** Signal score at or above which a task classifies HIGH. */
    highScore: z.number().int().min(2).max(100).default(6),
  })
  .passthrough();
export type JobComplexityPolicy = z.infer<typeof jobComplexityPolicySchema>;

export const jobBudgetPolicySchema = z
  .object({
    /** Hard ceiling on worker dispatches (all roles) in one job. */
    maxAgentRuns: z.number().int().min(1).max(2_000).default(60),
    /** Executor dispatches (implement + repair) per task. */
    maxTaskAttempts: z.number().int().min(1).max(50).default(4),
    maxRepairCyclesPerTask: z.number().int().min(0).max(50).default(3),
    maxReplansPerTask: z.number().int().min(0).max(20).default(2),
    /** Replans across the whole job, whatever task they belong to. */
    maxJobReplans: z.number().int().min(0).max(100).default(6),
    maxNoProgressCycles: z.number().int().min(1).max(20).default(2),
    maxTransientRetries: z.number().int().min(0).max(10).default(2),
    /** Wall-clock budget for the whole job. */
    maxWallClockMs: z
      .number()
      .int()
      .min(60_000)
      .max(14 * 24 * 3_600_000)
      .default(8 * 3_600_000),
    /** Local inference calls (classification, planning, critique, …). */
    maxLocalInferenceCalls: z.number().int().min(1).max(10_000).default(200),
    maxEvents: z.number().int().min(100).max(200_000).default(5_000),
    /**
     * Optional spend ceiling, enforced against provider-REPORTED cost only.
     * Null disables the check; SpecBridge never fabricates a price.
     */
    maxCostUsd: z.number().min(0).nullable().default(null),
    /** Optional token ceiling, enforced against reported usage only. */
    maxTokens: z.number().int().min(1).nullable().default(null),
  })
  .passthrough();
export type JobBudgetPolicy = z.infer<typeof jobBudgetPolicySchema>;

/**
 * Parallel builder execution for objective work units. DISABLED by default:
 * the safe sequential behavior is the baseline, and enabling parallelism is
 * an explicit decision. Even when enabled, the deterministic dispatch-set
 * selection serializes whenever independence cannot be conservatively
 * established — uncertainty always serializes, never guesses parallel.
 */
export const objectiveParallelismSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxConcurrentBuilders: z.number().int().min(1).max(8).default(3),
  })
  .passthrough();
export type ObjectiveParallelismPolicy = z.infer<typeof objectiveParallelismSchema>;

/**
 * When candidate artifacts get a SEMANTIC evaluation on top of the
 * deterministic one:
 *  - `auto`     investigation units always; build units when the
 *               deterministic layer requests judgment (conflict suspicion,
 *               declared assumptions or contract change requests)
 *  - `always`   every candidate
 *  - `disabled` never (deterministic evaluation still always runs)
 */
export const SEMANTIC_EVALUATION_MODES = ['auto', 'always', 'disabled'] as const;
export type SemanticEvaluationMode = (typeof SEMANTIC_EVALUATION_MODES)[number];

/**
 * Objective decomposition policy (additive, defaulted). Governs the runtime
 * level BETWEEN an approved objective (a leaf task in tasks.md) and worker
 * dispatches: dynamic work graphs, isolated builder worktrees, candidate
 * evaluation, aggregation, and single-writer integration. Activates only
 * for mission-driven specs; legacy specs keep the direct executor path
 * untouched.
 */
export const objectivesPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Hard ceiling on work units in one objective's graph. */
    maxWorkUnits: z.number().int().min(1).max(30).default(12),
    /** Hard ceiling on the dependency-chain depth of a proposed graph. */
    maxGraphDepth: z.number().int().min(1).max(10).default(4),
    /** Builder attempts per work unit before the unit fails. */
    maxBuilderAttemptsPerUnit: z.number().int().min(1).max(10).default(2),
    builderTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 3_600_000)
      .default(1_200_000),
    semanticEvaluation: z.enum(SEMANTIC_EVALUATION_MODES).default('auto'),
    parallelism: objectiveParallelismSchema.default({}),
    /** Serialized size ceiling for one candidate patch artifact. */
    maxCandidateBytes: z.number().int().min(10_240).max(20_000_000).default(2_000_000),
    /** Character ceiling for one context projection document. */
    maxProjectionChars: z.number().int().min(4_000).max(400_000).default(60_000),
  })
  .passthrough();
export type ObjectivesPolicy = z.infer<typeof objectivesPolicySchema>;

/**
 * Survival-runtime context policy (vNext.1, additive, defaulted).
 *
 * Governs how worker context is budgeted, monitored, and compacted. These
 * are OPERATIONAL bounds, not safety boundaries: they can only make
 * compaction happen sooner or refuse to start an oversized context
 * operation. Pinned/durable context can never be configured away.
 *
 * The advertised model window is never fully filled: headroom is reserved
 * for output, reasoning, and the next tool result. Thresholds follow the
 * initial policy (~55% prepare, ~70% proactive, ~85% emergency, ~90% hard
 * stop) and are configurable per workspace.
 */
export const jobContextPolicySchema = z
  .object({
    /** Default model context window when the provider does not declare one. */
    defaultModelContextTokens: z.number().int().min(1_000).max(10_000_000).default(200_000),
    reservedOutputTokens: z.number().int().min(0).max(1_000_000).default(16_000),
    reservedReasoningTokens: z.number().int().min(0).max(1_000_000).default(8_000),
    reservedGrowthTokens: z.number().int().min(0).max(1_000_000).default(8_000),
    prepareThreshold: z.number().min(0.05).max(1).default(0.55),
    proactiveCompactionThreshold: z.number().min(0.05).max(1).default(0.7),
    emergencyCompactionThreshold: z.number().min(0.05).max(1).default(0.85),
    hardStopThreshold: z.number().min(0.05).max(1).default(0.9),
    /** Bound on retained recent-delta items per task context. */
    maxRecentDeltaItems: z.number().int().min(1).max(200).default(20),
  })
  .passthrough();
export type JobContextPolicy = z.infer<typeof jobContextPolicySchema>;

/**
 * Dynamic-reserve policy (vNext.2). The reserve is the slice of the current
 * five-hour window the scheduler refuses to spend on newly admitted work —
 * headroom for interactive use and estimate error. It is DYNAMIC, never one
 * permanent percentage:
 *
 *   reset far away  -> larger reserve (an estimate error hurts for hours)
 *   reset near      -> smaller reserve (capacity is about to expire anyway)
 *   reset imminent  -> reserve approaches `minRatio` while weekly is healthy
 *
 * Weekly pressure and stale telemetry ADD reserve — uncertainty always makes
 * admission more conservative, never less.
 */
export interface DynamicReservePolicy {
  /** Reserve when the reset is `farResetMs` or further away. */
  baseRatio: number;
  /** Floor the reserve approaches as the reset becomes imminent. */
  minRatio: number;
  /** At or under this time-to-reset the reserve reaches `minRatio`. */
  nearResetMs: number;
  /** At or over this time-to-reset the reserve is `baseRatio`. */
  farResetMs: number;
  /** Added to the reserve while the weekly window is under pressure. */
  weeklyPressureExtraRatio: number;
  /** Added to the reserve while quota telemetry is stale or unknown. */
  staleTelemetryExtraRatio: number;
}

/**
 * Explicitly annotated (here and for the sibling scheduler schemas): the
 * fully inferred zod type would push the enclosing agent-config declaration
 * past the compiler's serializable-type limit (TS7056). The interface is
 * the public contract; the schema still validates and defaults every field.
 */
export const dynamicReservePolicySchema: z.ZodType<DynamicReservePolicy, z.ZodTypeDef, unknown> = z
  .object({
    baseRatio: z.number().min(0).max(0.9).default(0.2),
    minRatio: z.number().min(0).max(0.5).default(0.02),
    nearResetMs: z.number().int().min(60_000).max(18_000_000).default(15 * 60_000),
    farResetMs: z.number().int().min(600_000).max(18_000_000).default(3 * 3_600_000),
    weeklyPressureExtraRatio: z.number().min(0).max(0.5).default(0.15),
    staleTelemetryExtraRatio: z.number().min(0).max(0.5).default(0.1),
  })
  .passthrough();

/**
 * Heuristic workload-estimation defaults by complexity class, used when the
 * execution ledger has too few comparable observations. Burn ratios are
 * fractions of ONE five-hour window's full capacity. These are deliberately
 * coarse: the architecture supports uncertainty, and historical ledger data
 * replaces them as it accumulates.
 */
export interface WorkloadEstimatorPolicy {
  /** Expected wall time by complexity class, in milliseconds. */
  lowWallTimeMs: number;
  mediumWallTimeMs: number;
  highWallTimeMs: number;
  /** Expected five-hour-window quota burn by complexity class (0..1). */
  lowQuotaBurnRatio: number;
  mediumQuotaBurnRatio: number;
  highQuotaBurnRatio: number;
  /**
   * Approximate weekly-to-five-hour capacity factor: one unit of five-hour
   * burn consumes 1/factor of the weekly window. A pure heuristic until
   * telemetry provides real weekly usage; configurable, never learned
   * silently.
   */
  weeklyCapacityFactor: number;
  /** Minimum comparable ledger observations before history informs estimates. */
  minHistoricalObservations: number;
}

export const workloadEstimatorPolicySchema: z.ZodType<WorkloadEstimatorPolicy, z.ZodTypeDef, unknown> = z
  .object({
    lowWallTimeMs: z.number().int().min(1_000).default(10 * 60_000),
    mediumWallTimeMs: z.number().int().min(1_000).default(25 * 60_000),
    highWallTimeMs: z.number().int().min(1_000).default(50 * 60_000),
    lowQuotaBurnRatio: z.number().min(0).max(1).default(0.05),
    mediumQuotaBurnRatio: z.number().min(0).max(1).default(0.15),
    highQuotaBurnRatio: z.number().min(0).max(1).default(0.35),
    weeklyCapacityFactor: z.number().min(1).max(100).default(5),
    minHistoricalObservations: z.number().int().min(1).max(100).default(3),
  })
  .passthrough();

/**
 * vNext.2 quota-aware scheduler policy (additive, defaulted).
 *
 * Governs how work is routed between the LOCAL lane (zero marginal cost) and
 * the SUBSCRIPTION lane (prepaid Claude Max, rolling five-hour + weekly
 * quota windows). These are OPERATIONAL bounds and routing thresholds, not
 * safety boundaries: nothing here can bypass approvals, verification,
 * protected paths, or budgets. Disabling the block simply restores the
 * vNext.1 scheduling behavior unchanged.
 *
 * Admission is cross-reset by design: a task longer than the time to the
 * next quota reset is admitted when its EXPECTED BURN BEFORE THE RESET fits
 * inside remaining capacity minus the dynamic reserve. `task duration <=
 * time to reset` is deliberately not an admission rule anywhere.
 */
export interface JobSchedulerPolicy {
  /** When false, lane scheduling is off and vNext.1 behavior applies. */
  enabled: boolean;
  /**
   * Bounded local execution attempts per task before escalation to the
   * strong lane is mandatory. Local compute is cheap; wall time is not.
   */
  maxLocalAttempts: number;
  /**
   * Whether LOCAL_TRY tasks may be EXECUTED locally (SpecBridge-applied
   * structured edits + deterministic verification). LOCAL_SAFE read-only
   * reasoning is unaffected. Requires localInference to be enabled and
   * coherent; this flag only gates the source-mutating local path.
   */
  allowLocalExecution: boolean;
  /** Enter HARVEST when time-to-reset is at or under this window. */
  harvestWindowMs: number;
  /** HARVEST also requires at least this five-hour remaining ratio. */
  harvestMinRemainingRatio: number;
  /** CONSERVE when five-hour remaining is at or under this ratio. */
  conserveRemainingRatio: number;
  /** Weekly remaining at or under this ratio applies weekly pressure. */
  weeklyPressureRatio: number;
  /** Five-hour remaining at or under this ratio counts as exhausted. */
  fiveHourExhaustedRatio: number;
  /** Weekly remaining at or under this ratio counts as exhausted. */
  weeklyExhaustedRatio: number;
  /** Quota observations older than this are STALE. */
  telemetryStaleMs: number;
  /** Multiplier applied to expected burn before admission comparison. */
  burnSafetyMultiplier: number;
  /**
   * Context-occupancy ratio at or above which a large dispatch must run
   * context compaction/reconstruction first (quota admission and context
   * admission are BOTH required).
   */
  contextCompactBeforeDispatchRatio: number;
  /** How work is deferred when no lane can take it: poll interval bound. */
  deferPollMs: number;
  /**
   * A quota-deferred driver holds (sleeps through) waits up to this long —
   * e.g. an imminent five-hour reset — and STOPS with a resumable
   * WAITING_RETRY job for longer waits, so a days-long weekly cooldown
   * never pins a foreground process.
   */
  maxQuotaHoldMs: number;
  /** Retained scheduling-decision records per job (oldest pruned). */
  maxDecisionRecords: number;
  /**
   * Quota telemetry source. `manual` reads the operator-maintained
   * `.specbridge/quota-telemetry.json` (kept current via the CLI);
   * `none` disables telemetry (mode NORMAL, unknown freshness,
   * conservative reserve). A machine-readable provider adapter is a
   * future additive member — never a scraped UI.
   */
  telemetrySource: 'manual' | 'none';
  reserve: DynamicReservePolicy;
  estimator: WorkloadEstimatorPolicy;
}

export const jobSchedulerPolicySchema: z.ZodType<JobSchedulerPolicy, z.ZodTypeDef, unknown> = z
  .object({
    enabled: z.boolean().default(true),
    maxLocalAttempts: z.number().int().min(1).max(5).default(2),
    allowLocalExecution: z.boolean().default(true),
    harvestWindowMs: z.number().int().min(60_000).max(18_000_000).default(30 * 60_000),
    harvestMinRemainingRatio: z.number().min(0).max(1).default(0.25),
    conserveRemainingRatio: z.number().min(0).max(1).default(0.2),
    weeklyPressureRatio: z.number().min(0).max(1).default(0.1),
    fiveHourExhaustedRatio: z.number().min(0).max(0.2).default(0.01),
    weeklyExhaustedRatio: z.number().min(0).max(0.2).default(0.01),
    telemetryStaleMs: z.number().int().min(10_000).max(86_400_000).default(15 * 60_000),
    burnSafetyMultiplier: z.number().min(1).max(5).default(1.25),
    contextCompactBeforeDispatchRatio: z.number().min(0.05).max(1).default(0.7),
    deferPollMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    maxQuotaHoldMs: z.number().int().min(0).max(86_400_000).default(10 * 60_000),
    maxDecisionRecords: z.number().int().min(10).max(5_000).default(500),
    telemetrySource: z.enum(['manual', 'none'] as const).default('manual'),
    reserve: dynamicReservePolicySchema.default({}),
    estimator: workloadEstimatorPolicySchema.default({}),
  })
  .passthrough();

/**
 * v1.2 long-running job policy, additive inside the orchestration block.
 * Absent in every existing configuration file, in which case the defaults
 * below apply and no migration is required.
 *
 * Deliberately absent, exactly like the v1.1 block: nothing here can weaken
 * a safety boundary. There is no way to configure an approval bypass, a
 * verification bypass, an arbitrary command, or a repository-writing local
 * model from this block.
 */
export const jobPolicySchema = z
  .object({
    /** When false, job operations refuse to start and report why. */
    enabled: z.boolean().default(true),
    /**
     * Concurrent source-mutating dispatches. Fixed at 1 in this version:
     * sequential mutation matches the evidence model. The field exists (and
     * is validated) so a future parallel scheduler is a config change, not a
     * schema break — raising the max is additive.
     */
    maxConcurrentTasks: z.number().int().min(1).max(1).default(1),
    routing: jobRoutingPolicySchema.default({}),
    planReview: z.enum(JOB_PLAN_REVIEW_MODES).default('high-risk'),
    escalation: z.enum(ESCALATION_MODES).default('automatic'),
    complexity: jobComplexityPolicySchema.default({}),
    budgets: jobBudgetPolicySchema.default({}),
    /**
     * Optional competing-plan evaluation for MEDIUM-complexity tasks: two
     * local plans are produced and compared; material divergence escalates.
     * Off by default — it doubles local planning cost.
     */
    competingPlans: z.boolean().default(false),
    /** Bounded correction retries for invalid local structured output. */
    maxLocalOutputCorrections: z.number().int().min(0).max(3).default(1),
    /** Serialized size ceiling for one stored structured agent result. */
    maxAgentResultBytes: z.number().int().min(1_024).max(262_144).default(65_536),
    /** Base delay before a WAITING_RETRY job may resume. */
    retryDelayMs: z.number().int().min(100).max(3_600_000).default(5_000),
    /** Objective decomposition policy (additive; safe defaults). */
    objectives: objectivesPolicySchema.default({}),
    /** Survival-runtime context policy (additive; safe defaults). */
    context: jobContextPolicySchema.default({}),
    /**
     * vNext.2 quota-aware scheduler policy (additive; safe defaults).
     * Deliberately NOT part of jobPolicyFingerprint, exactly like `context`:
     * quota thresholds are operational tuning — adjusting them mid-job must
     * not make a resumed job falsely report "the policy changed".
     */
    scheduler: jobSchedulerPolicySchema.default({}),
  })
  .passthrough();
export type JobPolicy = z.infer<typeof jobPolicySchema>;

export const orchestrationPolicySchema = z
  .object({
    /**
     * When false, orchestration tools refuse to start a run and report why.
     * Existing task execution (task_begin/task_complete) is unaffected: this
     * flag governs the v1.1 governed workflow only.
     */
    enabled: z.boolean().default(true),
    planning: orchestrationPlanningPolicySchema.default({}),
    execution: orchestrationExecutionPolicySchema.default({}),
    retry: orchestrationRetryPolicySchema.default({}),
    clarification: orchestrationClarificationPolicySchema.default({}),
    history: orchestrationHistoryPolicySchema.default({}),
    /** v1.2 long-running job policy (additive; safe defaults). */
    jobs: jobPolicySchema.default({}),
  })
  .passthrough();
export type OrchestrationPolicy = z.infer<typeof orchestrationPolicySchema>;

export function defaultOrchestrationPolicy(): OrchestrationPolicy {
  return orchestrationPolicySchema.parse({});
}

/**
 * Stable fingerprint of the policy values a run was bound to.
 *
 * Recorded when an orchestration run starts so that a resumed run can say
 * honestly "the policy changed since this run began" instead of silently
 * enforcing different bounds than the ones the plan was reviewed under.
 */
export function orchestrationPolicyFingerprint(policy: OrchestrationPolicy): string {
  const canonical = {
    enabled: policy.enabled,
    planning: {
      mode: policy.planning.mode,
      maxReplans: policy.planning.maxReplans,
    },
    execution: {
      maxIterations: policy.execution.maxIterations,
      maxRepairCycles: policy.execution.maxRepairCycles,
      maxNoProgressCycles: policy.execution.maxNoProgressCycles,
      maxElapsedMs: policy.execution.maxElapsedMs,
    },
    retry: { maxTransientRetries: policy.retry.maxTransientRetries },
    clarification: { maxRounds: policy.clarification.maxRounds },
  };
  return JSON.stringify(canonical);
}

/**
 * Stable fingerprint of the values a JOB is bound to. Separate from
 * `orchestrationPolicyFingerprint` deliberately: v1.1 run records already
 * persist that fingerprint, and folding job values into it would make every
 * existing resumed run falsely report "the policy changed".
 */
export function jobPolicyFingerprint(policy: OrchestrationPolicy): string {
  const jobs = policy.jobs;
  const canonical = {
    enabled: jobs.enabled,
    maxConcurrentTasks: jobs.maxConcurrentTasks,
    routing: {
      classifier: jobs.routing.classifier,
      planner: jobs.routing.planner,
      critic: jobs.routing.critic,
      diagnoser: jobs.routing.diagnoser,
      replanner: jobs.routing.replanner,
      executor: jobs.routing.executor,
      decomposer: jobs.routing.decomposer,
      evaluator: jobs.routing.evaluator,
      aggregator: jobs.routing.aggregator,
    },
    planReview: jobs.planReview,
    escalation: jobs.escalation,
    complexity: { mediumScore: jobs.complexity.mediumScore, highScore: jobs.complexity.highScore },
    budgets: {
      maxAgentRuns: jobs.budgets.maxAgentRuns,
      maxTaskAttempts: jobs.budgets.maxTaskAttempts,
      maxRepairCyclesPerTask: jobs.budgets.maxRepairCyclesPerTask,
      maxReplansPerTask: jobs.budgets.maxReplansPerTask,
      maxJobReplans: jobs.budgets.maxJobReplans,
      maxNoProgressCycles: jobs.budgets.maxNoProgressCycles,
      maxTransientRetries: jobs.budgets.maxTransientRetries,
      maxWallClockMs: jobs.budgets.maxWallClockMs,
      maxLocalInferenceCalls: jobs.budgets.maxLocalInferenceCalls,
      maxCostUsd: jobs.budgets.maxCostUsd,
      maxTokens: jobs.budgets.maxTokens,
    },
    competingPlans: jobs.competingPlans,
    objectives: {
      enabled: jobs.objectives.enabled,
      maxWorkUnits: jobs.objectives.maxWorkUnits,
      maxGraphDepth: jobs.objectives.maxGraphDepth,
      maxBuilderAttemptsPerUnit: jobs.objectives.maxBuilderAttemptsPerUnit,
      semanticEvaluation: jobs.objectives.semanticEvaluation,
      parallelism: {
        enabled: jobs.objectives.parallelism.enabled,
        maxConcurrentBuilders: jobs.objectives.parallelism.maxConcurrentBuilders,
      },
    },
  };
  return JSON.stringify(canonical);
}
