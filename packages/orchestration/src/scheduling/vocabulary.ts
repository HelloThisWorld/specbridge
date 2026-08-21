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
 *
 * A future phase appends `API` (pay-as-you-go continuity). It is
 * deliberately NOT a member now: adding an enum member later is additive,
 * while shipping an unused lane would make an unreviewed spending path
 * reachable by configuration.
 */
export const EXECUTION_LANES = ['LOCAL', 'SUBSCRIPTION'] as const;
export type ExecutionLane = (typeof EXECUTION_LANES)[number];

/**
 * What the lane scheduler can decide for one candidate dispatch: run it on a
 * lane now, or defer it with a recorded reason and (where known) the time
 * capacity is expected to return.
 */
export const LANE_DECISIONS = ['LOCAL', 'SUBSCRIPTION', 'DEFER'] as const;
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
] as const;
export type SchedulingReasonCode = (typeof SCHEDULING_REASON_CODES)[number];
