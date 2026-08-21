/**
 * Quota-aware scheduling vocabulary (vNext.2 Free & Prepaid Optimizer).
 *
 * Closed string enums, additive within 1.x with the same rules as every
 * other orchestration vocabulary: members may be appended, never removed or
 * repurposed, so persisted scheduling decisions and attempt lanes stay
 * readable across upgrades.
 *
 * The organising idea:
 *
 *   Local compute is effectively free but limited in intelligence.
 *   Claude Max subscription compute is prepaid, strong, and expires in
 *   rolling quota windows.
 *
 * The scheduler reasons about the economic/execution LANE first, then the
 * concrete provider. No enum below can be set from model output.
 */

// ---------------------------------------------------------------------------
// Execution lanes
// ---------------------------------------------------------------------------

/**
 * The economic/execution lanes work can be dispatched through.
 *
 *   LOCAL         a locally served model: zero marginal monetary cost, does
 *                 not consume subscription quota, limited intelligence
 *   SUBSCRIPTION  the prepaid Claude Max subscription worker: the primary
 *                 strong-intelligence engine, limited by rolling five-hour
 *                 and weekly quota windows
 *   API           metered pay-as-you-go execution (vNext.5): the CONTINUITY
 *                 BRIDGE that keeps a long-horizon job moving through a
 *                 subscription outage
 *
 * The ordering is economic, not alphabetical, and API is deliberately not a
 * third equal-priority lane:
 *
 *   LOCAL          zero marginal cost
 *   SUBSCRIPTION   prepaid strong intelligence
 *   API            PAYG continuity bridge
 *
 * The invariant every consumer of this enum must preserve: never pay API
 * cost for work LOCAL can reliably complete or SUBSCRIPTION can reasonably
 * execute. Automatic API selection happens only through the gap-bridge
 * planner, after both other lanes have refused.
 */
export const EXECUTION_LANES = ['LOCAL', 'SUBSCRIPTION', 'API'] as const;
export type ExecutionLane = (typeof EXECUTION_LANES)[number];

/**
 * What the lane scheduler can decide for one candidate dispatch: run it on a
 * lane now, defer it with a recorded reason and (where known) the time
 * capacity is expected to return, or record that paid execution would help
 * but requires a human authorization first.
 *
 * `REQUIRE_APPROVAL` is not a lane — it is the MANUAL spend mode's outcome,
 * and it never dispatches anything. The task stays durably pending exactly
 * as it does under DEFER; the difference is that a bounded, fingerprinted
 * approval request now exists for a human to decide on.
 */
export const LANE_DECISIONS = ['LOCAL', 'SUBSCRIPTION', 'API', 'DEFER', 'REQUIRE_APPROVAL'] as const;
export type LaneDecision = (typeof LANE_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Local suitability
// ---------------------------------------------------------------------------

/**
 * Deterministic local-suitability classes for one unit of work.
 *
 *   LOCAL_SAFE       the local tier should normally perform this without
 *                    consuming subscription quota (summarization, ranking,
 *                    extraction, mechanical reporting)
 *   LOCAL_TRY        the local tier may attempt this FIRST because
 *                    correctness can be verified cheaply and
 *                    deterministically (compile + tests); imperfect output
 *                    is caught by verification, not by a stronger model
 *   STRONG_REQUIRED  route directly to the strong lane; local attempts
 *                    would predictably waste wall time
 *
 * This is ROUTING POLICY derived from deterministic signals — never a claim
 * about model intelligence, and never produced by a model.
 */
export const LOCAL_SUITABILITY_CLASSES = ['LOCAL_SAFE', 'LOCAL_TRY', 'STRONG_REQUIRED'] as const;
export type LocalSuitabilityClass = (typeof LOCAL_SUITABILITY_CLASSES)[number];

// ---------------------------------------------------------------------------
// Local execution modes and shapes (vNext.4)
// ---------------------------------------------------------------------------

/**
 * The LOCAL lane's execution modes and rollout strategies live in
 * @specbridge/core (they are configuration), and are re-exported here so
 * scheduling code has ONE vocabulary import site.
 *
 * The layering this phase depends on, stated once:
 *
 *   Economic lane  !=  Execution mode  !=  Harness  !=  Model
 *
 * LOCAL is an economic resource class. DIRECT_MODEL/HARNESS are how that
 * resource is spent. A harness is a tool loop that could drive any model,
 * anywhere. Compute locality is a separate verified property. No code may
 * collapse these: "DeepSeek Harness" never implies LOCAL, and "qwen" never
 * implies local compute.
 */
export {
  LOCAL_EXECUTION_MODES,
  LOCAL_EXECUTION_STRATEGIES,
  COMPUTE_LOCALITIES,
} from '@specbridge/core';
export type {
  LocalExecutionMode,
  LocalExecutionStrategy,
  ComputeLocality,
} from '@specbridge/core';

/**
 * The SHAPE of one unit of local work — independent of whether local
 * intelligence can handle it at all.
 *
 *   ONE_SHOT  a bounded transformation a single structured request can
 *             complete: known target, small complete context, no repository
 *             search, no expected test/fix loop
 *   AGENTIC   work that needs an autonomous tool loop: repository
 *             exploration, an unknown implementation site, several related
 *             files, or an expected edit → test → repair cycle
 *
 * Deliberately ORTHOGONAL to LocalSuitabilityClass. Suitability answers
 * "can local intelligence reasonably do this?"; shape answers "does doing
 * it require tools?". A task can be LOCAL_SAFE and AGENTIC (easy, but needs
 * to find the file) or STRONG_REQUIRED and ONE_SHOT (a single subtle edit).
 */
export const LOCAL_EXECUTION_SHAPES = ['ONE_SHOT', 'AGENTIC'] as const;
export type LocalExecutionShape = (typeof LOCAL_EXECUTION_SHAPES)[number];

/**
 * Why the local execution resolver chose the mode it chose.
 *
 * Kept separate from SCHEDULING_REASON_CODES on purpose: the lane reason
 * ("why LOCAL rather than SUBSCRIPTION") and the mode reason ("why HARNESS
 * rather than DIRECT_MODEL") are different questions, and encoding both in
 * one string would produce exactly the `LOCAL_DSH`-style compound values
 * this phase forbids. Both are recorded, orthogonally, on every decision.
 */
export const LOCAL_EXECUTION_MODE_REASONS = [
  /** The work is one-shot shaped; a bounded structured request runs it. */
  'LOCAL_DIRECT_SELECTED',
  /** Rollout strategy is DIRECT_ONLY: the harness path is not in play. */
  'LOCAL_DIRECT_ONLY_STRATEGY',
  /** The work is agentic-shaped and a verified-local harness is bound. */
  'LOCAL_HARNESS_SELECTED',
  /** Rollout strategy is HARNESS_ONLY (benchmark/A-B): harness forced. */
  'LOCAL_HARNESS_FORCED',
  /** The harness was preferred but no bound/enabled harness is available. */
  'LOCAL_HARNESS_UNAVAILABLE',
  /** A harness is bound, but its compute is not VERIFIED local: refused. */
  'LOCAL_HARNESS_NOT_VERIFIED_LOCAL',
  /** A direct attempt failed for reasons that call for repository tools. */
  'LOCAL_DIRECT_TO_HARNESS_ESCALATION',
] as const;
export type LocalExecutionModeReason = (typeof LOCAL_EXECUTION_MODE_REASONS)[number];

// ---------------------------------------------------------------------------
// Scheduler modes
// ---------------------------------------------------------------------------

/**
 * Quota-aware scheduler modes. Explicit domain state — never scattered
 * boolean conditions.
 *
 *   NORMAL            subscription capacity is healthy; strong work routes
 *                     to the subscription lane freely
 *   CONSERVE          five-hour capacity is low and the next reset is not
 *                     imminent (or weekly pressure applies); prefer local,
 *                     admit only small safe strong work
 *   HARVEST           the five-hour reset is approaching with significant
 *                     unused capacity and weekly quota is healthy: unused
 *                     prepaid capacity is about to expire, so the reserve
 *                     drops and useful strong work is actively admitted
 *   EXHAUSTED_5H      the five-hour window is genuinely unavailable; local
 *                     work continues, strong work waits for the reset
 *   EXHAUSTED_WEEKLY  the weekly window is genuinely unavailable; local
 *                     work continues, strong work waits for the weekly reset
 *
 * Weekly scarcity DOMINATES five-hour harvesting: an imminent five-hour
 * reset never triggers HARVEST while the weekly window is under pressure.
 */
export const SCHEDULER_MODES = [
  'NORMAL',
  'CONSERVE',
  'HARVEST',
  'EXHAUSTED_5H',
  'EXHAUSTED_WEEKLY',
] as const;
export type SchedulerMode = (typeof SCHEDULER_MODES)[number];

/** Modes in which the subscription lane accepts no new dispatch at all. */
export const SUBSCRIPTION_EXHAUSTED_MODES: readonly SchedulerMode[] = [
  'EXHAUSTED_5H',
  'EXHAUSTED_WEEKLY',
];

export function isSubscriptionExhausted(mode: SchedulerMode): boolean {
  return SUBSCRIPTION_EXHAUSTED_MODES.includes(mode);
}

// ---------------------------------------------------------------------------
// Quota windows and telemetry freshness
// ---------------------------------------------------------------------------

/**
 * The independent subscription quota windows. They are never combined into
 * one percentage: an execution is subscription-admissible only when every
 * relevant window is safe.
 */
export const QUOTA_WINDOWS = ['five-hour', 'weekly'] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

/**
 * Freshness of a quota observation relative to the configured staleness
 * threshold.
 *
 *   FRESH    observed recently enough to act on
 *   STALE    observed, but older than the threshold: the scheduler behaves
 *            conservatively and never makes aggressive HARVEST decisions
 *   UNKNOWN  no observation exists at all: conservative defaults apply and
 *            every decision records that quota state was unknown
 */
export const QUOTA_TELEMETRY_FRESHNESS = ['FRESH', 'STALE', 'UNKNOWN'] as const;
export type QuotaTelemetryFreshness = (typeof QUOTA_TELEMETRY_FRESHNESS)[number];

// ---------------------------------------------------------------------------
// Scheduling reason codes
// ---------------------------------------------------------------------------

/**
 * Why a scheduling decision chose its lane (or deferred). Every routing and
 * admission decision records exactly one primary reason code — structured,
 * so scheduler behavior is debuggable from decision records, never only
 * from prose logs.
 */
export const SCHEDULING_REASON_CODES = [
  /** The work is LOCAL_SAFE; the local lane performs it without quota. */
  'LOCAL_SAFE',
  /** LOCAL_TRY work attempts the local lane first under cheap verification. */
  'LOCAL_TRY_FIRST',
  /** The work requires strong intelligence; the subscription lane runs it. */
  'STRONG_REQUIRED',
  /** HARVEST admitted strong work to consume capacity that would expire. */
  'HARVEST_EXPIRING_CAPACITY',
  /** CONSERVE deferred non-essential strong work to protect low capacity. */
  'CONSERVE_QUOTA',
  /** Weekly scarcity constrained the decision (including suppressing HARVEST). */
  'WEEKLY_QUOTA_PRESSURE',
  /** The five-hour window is exhausted; strong work waits for its reset. */
  'FIVE_HOUR_EXHAUSTED',
  /** The weekly window is exhausted; strong work waits for its reset. */
  'WEEKLY_EXHAUSTED',
  /** Context occupancy required compaction before the dispatch could start. */
  'COMPACT_BEFORE_EXECUTION',
  /** Bounded local attempts were used up; the work escalates to strong. */
  'LOCAL_ESCALATION_REQUIRED',
  /** Expected pre-reset burn fits: the task starts now and crosses the reset. */
  'CROSS_RESET_ADMITTED',
  /** Expected pre-reset burn does not fit inside remaining minus reserve. */
  'PRE_RESET_BURN_UNSAFE',
  /** Telemetry was stale/unknown; the conservative path was taken. */
  'STALE_TELEMETRY_CONSERVATIVE',
  /** No healthy local worker exists; local-eligible work routed strong. */
  'LOCAL_UNAVAILABLE',
  // vNext.5 API gap bridge (additive, never reordered). Every code below
  // describes a decision ABOUT paid execution — including the many that
  // decline it, which are the ones that run most of the time.
  /** Paid execution is not authorized (spendMode DISABLED): the task waits. */
  'API_DISABLED',
  /** Paid execution would help; MANUAL mode requires a human authorization. */
  'API_APPROVAL_REQUIRED',
  /** The subscription gap is short enough that waiting beats paying. */
  'API_GAP_SHORT_DEFER',
  /** A material subscription gap is bridged by one bounded paid attempt. */
  'API_GAP_BRIDGE_SELECTED',
  /** A weekly-exhaustion gap (days, not minutes) is bridged by paid work. */
  'API_WEEKLY_GAP_BRIDGE',
  /** The safe cost estimate exceeds the authorized job/task/attempt budget. */
  'API_BUDGET_EXCEEDED',
  /** Cost cannot be estimated (no pricing or no workload data): never spend. */
  'API_COST_UNKNOWN',
  /** No usable API binding exists (unbound, disabled, or not verified remote). */
  'API_BINDING_UNAVAILABLE',
  /** The bound API provider/runtime is not currently usable. */
  'API_PROVIDER_UNAVAILABLE',
  /** The paid lane takes strong work only; this work stays local. */
  'API_STRONG_TASK_ONLY',
  /** Prepaid capacity returned; the next strong task goes back to it. */
  'API_MAX_RETURNED_NEXT_TASK_SUBSCRIPTION',
  /** Bounded API attempts for this task/job are spent. */
  'API_ATTEMPTS_EXHAUSTED',
  /** Waiting is harmless: the work is not delay-sensitive enough to pay for. */
  'API_DELAY_TOLERABLE',
  /** Prepaid capacity returns before a paid attempt would pay for itself. */
  'API_WASTEFUL_NEAR_RESET',
  /** Ready local work exists; run it before paying to bridge one strong task. */
  'API_LOCAL_BACKLOG_FIRST',
] as const;
export type SchedulingReasonCode = (typeof SCHEDULING_REASON_CODES)[number];

// ---------------------------------------------------------------------------
// API gap bridge (vNext.5)
// ---------------------------------------------------------------------------

/**
 * API spend authorization modes live in @specbridge/core (they are
 * configuration) and are re-exported here so scheduling code keeps ONE
 * vocabulary import site, exactly as with the LOCAL execution modes.
 */
export { API_SPEND_MODES } from '@specbridge/core';
export type { ApiSpendMode } from '@specbridge/core';

/**
 * WHY subscription capacity is unavailable — the gap's cause, which is not
 * the same question as how long it lasts.
 *
 *   FIVE_HOUR_EXHAUSTED                  the rolling five-hour window is spent
 *   WEEKLY_EXHAUSTED                     the weekly window is spent (days)
 *   PRE_RESET_BURN_UNSAFE                capacity exists but admitting this
 *                                        task's pre-reset burn is not safe
 *   SUBSCRIPTION_TEMPORARILY_UNAVAILABLE quota pressure/policy refused it now
 *   SUBSCRIPTION_WORKER_UNAVAILABLE      no subscription worker is configured
 *                                        or healthy at all
 *
 * Not every subscription defer is API-worthy, which is exactly why the
 * cause is modeled separately from the decision: PRE_RESET_BURN_UNSAFE
 * twelve minutes before a reset is a WAIT, while WEEKLY_EXHAUSTED with a
 * 36-hour reset is the scenario this phase exists for.
 */
export const SUBSCRIPTION_GAP_REASONS = [
  'FIVE_HOUR_EXHAUSTED',
  'WEEKLY_EXHAUSTED',
  'PRE_RESET_BURN_UNSAFE',
  'SUBSCRIPTION_TEMPORARILY_UNAVAILABLE',
  'SUBSCRIPTION_WORKER_UNAVAILABLE',
] as const;
export type SubscriptionGapReason = (typeof SUBSCRIPTION_GAP_REASONS)[number];

/**
 * Confidence in the forecast return time.
 *
 *   HIGH     a provider-observed reset timestamp
 *   MEDIUM   derived from a known window boundary, not directly observed
 *   UNKNOWN  no return time exists — never fabricated into a number
 *
 * UNKNOWN is load-bearing: it makes AUTO_BOUNDED MORE cautious, never less.
 */
export const GAP_FORECAST_CONFIDENCE = ['HIGH', 'MEDIUM', 'UNKNOWN'] as const;
export type GapForecastConfidence = (typeof GAP_FORECAST_CONFIDENCE)[number];

/**
 * How much waiting actually costs the JOB — derived from deterministic work
 * graph signals (blocked dependents, critical-path membership, whether any
 * other useful work is ready), never from a model's opinion about urgency.
 *
 *   LOW     waiting is close to free: other work is ready, nothing is blocked
 *   MEDIUM  waiting costs progress but the job is not stalled
 *   HIGH    the job is effectively blocked on this task
 */
export const DELAY_SENSITIVITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DelaySensitivity = (typeof DELAY_SENSITIVITIES)[number];

/**
 * Where a recorded cost figure came from. Estimated and observed cost are
 * never merged into one field, and an estimate is never overwritten by an
 * invented "actual".
 *
 *   PROVIDER_REPORTED       the provider stated a monetary cost
 *   COMPUTED_FROM_USAGE     actual token usage x the configured price table
 *   ESTIMATED_PRE_DISPATCH  a forecast made before the attempt ran
 *   UNKNOWN                 the attempt's real usage is not knowable
 *                           (e.g. it crashed before reporting) — this is
 *                           NEVER silently recorded as zero
 */
export const API_COST_SOURCES = [
  'PROVIDER_REPORTED',
  'COMPUTED_FROM_USAGE',
  'ESTIMATED_PRE_DISPATCH',
  'UNKNOWN',
] as const;
export type ApiCostSource = (typeof API_COST_SOURCES)[number];

/**
 * Lifecycle of one API budget reservation. Reservation exists so two
 * concurrent tasks cannot each see the same remaining budget and both
 * spend it.
 *
 *   RESERVED   funds are held for an attempt that has not finished
 *   COMMITTED  the attempt finished and its cost was reconciled
 *   RELEASED   the attempt provably never spent (refused before dispatch)
 *   UNKNOWN    the attempt was interrupted and remote usage cannot be ruled
 *              out — the hold STAYS against the budget, because releasing
 *              money that may already have been spent corrupts accounting
 */
export const API_BUDGET_RESERVATION_STATES = ['RESERVED', 'COMMITTED', 'RELEASED', 'UNKNOWN'] as const;
export type ApiBudgetReservationState = (typeof API_BUDGET_RESERVATION_STATES)[number];

/** Status of one bounded, fingerprinted human spend authorization. */
export const API_APPROVAL_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'DENIED',
  'CONSUMED',
  'EXPIRED',
  'SUPERSEDED',
] as const;
export type ApiApprovalStatus = (typeof API_APPROVAL_STATUSES)[number];
