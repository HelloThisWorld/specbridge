/**
 * Adaptive compute scheduler vocabulary (vNext.8 Adaptive Compute Scheduler).
 *
 * Closed string enums, additive within 1.x on the same terms as every other
 * orchestration vocabulary: members may be appended, never removed or
 * repurposed, so persisted adaptive decisions and derived profiles stay
 * readable across upgrades.
 *
 * The organising idea, and the one invariant every symbol below serves:
 *
 *   Adaptive optimization may RANK allowed choices.
 *   It may never make a forbidden choice allowed.
 *
 * Hard policy — locality (vNext.4), spend authorization and budget
 * (vNext.5), quota windows and HARVEST (vNext.2), reliability vetoes
 * (vNext.6), context safety (vNext.7) — runs FIRST and produces the
 * candidate set. Nothing in this file can add a candidate to that set,
 * and nothing in it can be set from model output.
 */

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * Rollout modes live in @specbridge/core (they are configuration) and are
 * re-exported here so adaptive code keeps ONE vocabulary import site,
 * exactly as scheduling does for the LOCAL execution modes.
 */
export { ADAPTIVE_SCHEDULER_MODES } from '@specbridge/core';
export type { AdaptiveSchedulerMode } from '@specbridge/core';

// ---------------------------------------------------------------------------
// Observed outcomes
// ---------------------------------------------------------------------------

/**
 * The normalized label an OBSERVED attempt contributes to history.
 *
 * Only executed attempts with real observations ever produce one of these.
 * A prediction, a recommendation, an unexecuted candidate, or a worker's own
 * opinion about how it did can never become an outcome label — that is the
 * structural block on a scheduler that learns from its own guesses.
 *
 *   VERIFIED_SUCCESS        completed AND evaluation PASS. The only label
 *                           that counts as success anywhere in this phase.
 *   UNVERIFIED_SUCCESS      the attempt completed but no PASS evaluation
 *                           exists (pre-vNext.6 history, or an acceptance
 *                           that bypassed automated evidence). Counted and
 *                           reported SEPARATELY: completion provenance is
 *                           preserved rather than rounded up to success.
 *   IMPLEMENTATION_FAILURE  the work was wrong — a failure whose source
 *                           permits an inference about intelligence.
 *   INFRASTRUCTURE_FAILURE  the machinery broke (harness, provider, sandbox,
 *                           verifier). Says nothing about whether the model
 *                           could have done the task.
 *   INCONCLUSIVE            evaluation could not reach a verdict. NOT a
 *                           failure, and never trained as one.
 *   CENSORED                interrupted or cancelled: the outcome is
 *                           genuinely unknowable. Its RESOURCE cost still
 *                           counts, because the compute was really spent.
 *
 * Rate denominators differ by question, which is the entire point of
 * keeping six labels instead of a boolean:
 *
 *   intelligence success  VERIFIED_SUCCESS / (VERIFIED_SUCCESS + IMPLEMENTATION_FAILURE)
 *   availability          1 - INFRASTRUCTURE_FAILURE / (all non-censored)
 */
export const ADAPTIVE_OUTCOME_LABELS = [
  'VERIFIED_SUCCESS',
  'UNVERIFIED_SUCCESS',
  'IMPLEMENTATION_FAILURE',
  'INFRASTRUCTURE_FAILURE',
  'INCONCLUSIVE',
  'CENSORED',
] as const;
export type AdaptiveOutcomeLabel = (typeof ADAPTIVE_OUTCOME_LABELS)[number];

/** Labels that resolve the intelligence question one way or the other. */
export const INTELLIGENCE_OUTCOME_LABELS: readonly AdaptiveOutcomeLabel[] = [
  'VERIFIED_SUCCESS',
  'IMPLEMENTATION_FAILURE',
];

export function informsIntelligenceRate(label: AdaptiveOutcomeLabel): boolean {
  return INTELLIGENCE_OUTCOME_LABELS.includes(label);
}

// ---------------------------------------------------------------------------
// Prediction confidence
// ---------------------------------------------------------------------------

/**
 * How much a prediction may be trusted.
 *
 *   NONE    no usable evidence: cold start. The heuristic decides.
 *   LOW     evidence exists but is sparse, stale, coarse, or drifting.
 *   MEDIUM  enough comparable, recent, same-identity evidence to act on.
 *   HIGH    ample evidence at the exact profile level with no drift and a
 *           matching runtime identity.
 *
 * Confidence is a CEILING, not a vote: a prediction below the configured
 * floor cannot place work no matter how attractive its score.
 */
export const PREDICTION_CONFIDENCE_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type PredictionConfidence = (typeof PREDICTION_CONFIDENCE_LEVELS)[number];

/** Ordinal rank of a confidence level, for threshold comparison. */
export const PREDICTION_CONFIDENCE_RANK: Readonly<Record<PredictionConfidence, number>> =
  Object.freeze({ NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 });

export function meetsConfidence(
  actual: PredictionConfidence,
  required: PredictionConfidence,
): boolean {
  return PREDICTION_CONFIDENCE_RANK[actual] >= PREDICTION_CONFIDENCE_RANK[required];
}

// ---------------------------------------------------------------------------
// Hierarchical profile fallback
// ---------------------------------------------------------------------------

/**
 * Which level of the profile hierarchy produced a prediction.
 *
 * Maintaining a profile for every Cartesian product of task, runner, model,
 * version, context strategy, and repository would produce thousands of
 * one-sample buckets, each confidently wrong. Instead the lookup walks from
 * specific to general and STOPS at the first level with enough evidence,
 * recording which level answered so the reduced confidence is explainable.
 *
 *   EXACT            full task signature x full execution target
 *   TARGET_CATEGORY  coarse task category + complexity x lane/mode/runner
 *   LANE_CATEGORY    coarse task category x lane
 *   LANE_GLOBAL      lane defaults across all task classes
 *   HEURISTIC_PRIOR  no observations at any level: prior only (cold start)
 */
export const PROFILE_FALLBACK_LEVELS = [
  'EXACT',
  'TARGET_CATEGORY',
  'LANE_CATEGORY',
  'LANE_GLOBAL',
  'HEURISTIC_PRIOR',
] as const;
export type ProfileFallbackLevel = (typeof PROFILE_FALLBACK_LEVELS)[number];

/** Numeric depth of each level (0 = most specific). */
export const PROFILE_FALLBACK_LEVEL_DEPTH: Readonly<Record<ProfileFallbackLevel, number>> =
  Object.freeze({
    EXACT: 0,
    TARGET_CATEGORY: 1,
    LANE_CATEGORY: 2,
    LANE_GLOBAL: 3,
    HEURISTIC_PRIOR: 4,
  });

// ---------------------------------------------------------------------------
// Runtime identity compatibility
// ---------------------------------------------------------------------------

/**
 * How well the runtime identity behind historical observations matches the
 * identity that would execute NOW.
 *
 * Performance measured on one model or harness version does not transfer to
 * another at face value, and pretending otherwise is how a scheduler keeps
 * routing work to a version that regressed.
 *
 *   EXACT       identical runner, model, and versions: full confidence
 *   COMPATIBLE  same family, a version moved: confidence reduced one step
 *   CHANGED     a material identity change: treated as cold start
 *   UNKNOWN     identity was never recorded. Unknown stays unknown — it is
 *               not optimistically assumed to match.
 */
export const RUNTIME_IDENTITY_MATCHES = ['EXACT', 'COMPATIBLE', 'CHANGED', 'UNKNOWN'] as const;
export type RuntimeIdentityMatch = (typeof RUNTIME_IDENTITY_MATCHES)[number];

// ---------------------------------------------------------------------------
// Policy vetoes
// ---------------------------------------------------------------------------

/**
 * Why hard policy refused a candidate the adaptive layer might otherwise
 * have ranked.
 *
 * Every code here is a VETO the adaptive layer cannot appeal. They are
 * persisted on the decision record so "the scheduler had a favourite and
 * did not use it" is answerable from durable state rather than from a log
 * line someone happened to write.
 *
 * These deliberately mirror the vocabulary of the subsystems that own the
 * rules — locality, spend, quota, context, reliability, capability — because
 * the adaptive layer reports those subsystems' decisions; it does not make
 * its own.
 */
export const ADAPTIVE_VETO_CODES = [
  /** The candidate's compute is not VERIFIED local (vNext.4 authority). */
  'REMOTE_NOT_LOCAL',
  /** Paid execution is not authorized at all (spendMode DISABLED). */
  'API_DISABLED',
  /** Paid execution requires a human authorization that does not exist. */
  'API_APPROVAL_REQUIRED',
  /** The safe cost estimate exceeds the authorized budget. */
  'API_BUDGET_EXCEEDED',
  /** Current pricing is unknown; historical cost may not substitute for it. */
  'API_COST_UNKNOWN',
  /** A previously granted authorization no longer covers this dispatch. */
  'STALE_APPROVAL',
  /** The weekly subscription window is under pressure or exhausted. */
  'WEEKLY_QUOTA_PRESSURE',
  /** The five-hour window cannot safely admit this work. */
  'FIVE_HOUR_QUOTA_PRESSURE',
  /** Required context does not fit safely in the available budget. */
  'CONTEXT_UNSAFE',
  /** The candidate cannot satisfy the task's capability requirements. */
  'CAPABILITY_MISSING',
  /** vNext.6 recorded this strategy as already tried and failed on this task. */
  'RELIABILITY_STRATEGY_FORBIDDEN',
  /** The candidate's runner/binding is not usable right now. */
  'RUNNER_UNAVAILABLE',
  /** The lane itself was not selected by hard policy; no candidate exists. */
  'LANE_NOT_ELIGIBLE',
] as const;
export type AdaptiveVetoCode = (typeof ADAPTIVE_VETO_CODES)[number];

// ---------------------------------------------------------------------------
// Fallback reasons
// ---------------------------------------------------------------------------

/**
 * Why the heuristic choice executed instead of an adaptive one.
 *
 * `null` fallback reason means adaptive actually decided. Everything else
 * names the specific bar the adaptive layer failed to clear, so a user
 * asking "why is this not using the thing history prefers?" gets a
 * mechanical answer.
 */
export const ADAPTIVE_FALLBACK_REASONS = [
  /** Mode is HEURISTIC: adaptive ranking is switched off. */
  'MODE_HEURISTIC',
  /** Mode is SHADOW: recommendations are recorded, never executed. */
  'MODE_SHADOW',
  /** No history at any hierarchy level for any candidate (cold start). */
  'COLD_START',
  /** Evidence exists but sits below the configured sample floor. */
  'INSUFFICIENT_SAMPLES',
  /** Candidates could not be compared: one side lacks comparable evidence. */
  'INSUFFICIENT_COMPARABLE_SAMPLES',
  /** The best prediction's confidence is below the configured floor. */
  'CONFIDENCE_BELOW_THRESHOLD',
  /** The adaptive winner IS the heuristic choice; nothing changed. */
  'AGREES_WITH_HEURISTIC',
  /** The utility advantage was too small to justify moving (hysteresis). */
  'UTILITY_MARGIN_TOO_SMALL',
  /** Only one candidate was eligible: there was nothing to rank. */
  'SINGLE_CANDIDATE',
  /** Hard policy vetoed every candidate the adaptive layer preferred. */
  'ALL_PREFERRED_CANDIDATES_VETOED',
  /** Observed performance diverged from history; confidence was withdrawn. */
  'DRIFT_DETECTED',
  /** The derived profile store was unusable and is being rebuilt. */
  'PROFILE_STORE_UNAVAILABLE',
] as const;
export type AdaptiveFallbackReason = (typeof ADAPTIVE_FALLBACK_REASONS)[number];

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/**
 * Observable ways recent behavior can diverge from what history predicted.
 *
 * Every signal is a deterministic comparison between two windows of REAL
 * observations, or a recorded identity change. None of them retrain
 * anything — drift only ever REDUCES confidence, which moves placement back
 * toward the deterministic heuristics rather than toward a new guess.
 */
export const ADAPTIVE_DRIFT_SIGNALS = [
  /** Verified success rate fell materially between the older and recent windows. */
  'SUCCESS_RATE_DROP',
  /** Median wall time to completion grew materially. */
  'WALL_TIME_GROWTH',
  /** Median context consumption grew materially. */
  'CONTEXT_GROWTH',
  /** The dominant failure source changed. */
  'FAILURE_SOURCE_SHIFT',
  /** The runner/model/harness identity behind the profile changed. */
  'RUNTIME_IDENTITY_CHANGED',
] as const;
export type AdaptiveDriftSignal = (typeof ADAPTIVE_DRIFT_SIGNALS)[number];

// ---------------------------------------------------------------------------
// Task signature dimensions
// ---------------------------------------------------------------------------

/**
 * Coarse repository-size classes. Bucketed rather than exact so that a
 * repository growing by a few files does not silently re-key every profile.
 * UNKNOWN when no repository index exists — never guessed from a default.
 */
export const REPOSITORY_SIZE_CLASSES = ['SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN'] as const;
export type RepositorySizeClass = (typeof REPOSITORY_SIZE_CLASSES)[number];

/** Coarse expected-context-size classes, bucketed for the same reason. */
export const CONTEXT_SIZE_CLASSES = ['SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN'] as const;
export type ContextSizeClass = (typeof CONTEXT_SIZE_CLASSES)[number];

/**
 * Whether the task has trusted deterministic verification available.
 *
 * Load-bearing for grouping: a task class whose correctness is machine
 * checkable behaves completely differently under a weak model than one whose
 * correctness is not, and averaging the two together produces a number that
 * describes neither.
 */
export const VERIFICATION_STRENGTHS = ['DETERMINISTIC', 'NONE'] as const;
export type VerificationStrength = (typeof VERIFICATION_STRENGTHS)[number];
