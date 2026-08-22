import type { AdaptiveSchedulerPolicy } from '@specbridge/core';
import type { ExecutionCandidate } from './candidates.js';
import { targetKey } from './candidates.js';
import type { TaskSignature } from './signature.js';
import { categoryOnlyKey, categorySignatureKey } from './signature.js';
import type { AdaptiveProfileSet, ExecutionPerformanceProfile, ProfileDrift } from './profiles.js';
import { profileIndexKey, runtimeIdentityOf } from './profiles.js';
import type {
  PredictionConfidence,
  ProfileFallbackLevel,
  RuntimeIdentityMatch,
} from './vocabulary.js';
import { PREDICTION_CONFIDENCE_LEVELS, PREDICTION_CONFIDENCE_RANK } from './vocabulary.js';

/**
 * CandidatePrediction (vNext.8): what history says about ONE candidate.
 *
 * Every field is either an observation-backed estimate or explicitly null.
 * There is no "reasonable default" anywhere in this file: a metric nothing
 * reported stays unknown, and the utility function is built to price
 * unknowns conservatively rather than to receive a fabricated number that
 * happens to be typed as a `number`.
 *
 * The success estimate is the exception that proves the rule — it is ALWAYS
 * present, because a Beta prior always yields a value. With zero
 * observations that value IS the prior, which is the existing deterministic
 * heuristic's own expectation for the task, identical across candidates. So
 * cold start does not produce an arbitrary ranking; it produces a tie, which
 * confidence then refuses to act on.
 */

export interface CandidatePrediction {
  candidate: ExecutionCandidate;
  /** Which hierarchy level answered. HEURISTIC_PRIOR means no data at all. */
  level: ProfileFallbackLevel;
  profileKey: string | null;
  confidence: PredictionConfidence;
  /** Bounded numeric confidence, for auditing the ladder that produced it. */
  confidenceScore: number;
  identityMatch: RuntimeIdentityMatch;
  drift: ProfileDrift;

  // --- success -----------------------------------------------------------
  /** Smoothed probability of VERIFIED completion for one attempt. */
  verifiedSuccessProbability: number;
  /** The heuristic expectation used as the Beta prior's mean. */
  priorSuccessProbability: number;
  /** Observed (unsmoothed) rate, when any resolving attempt exists. */
  observedSuccessRate: number | null;
  /** Observed first-attempt verified success rate, when measured. */
  firstAttemptSuccessRate: number | null;
  /** Availability: probability the machinery does NOT break. */
  availabilityProbability: number | null;
  /** Expected attempts to reach one verified completion. */
  expectedAttempts: number;

  // --- resources ---------------------------------------------------------
  /** Median wall time for ONE attempt. */
  expectedWallTimeMs: number | null;
  /** Wall time to a verified completion, retries included. */
  expectedTotalWallTimeMs: number | null;
  expectedInputTokens: number | null;
  expectedContextTokens: number | null;
  /** P50 five-hour quota burn for one attempt. */
  expectedFiveHourBurnRatio: number | null;
  /** P90 burn: the figure conservative admission uses. Never the mean. */
  conservativeFiveHourBurnRatio: number | null;
  /** P50 metered cost per attempt. Null means UNKNOWN, never free. */
  expectedApiCostUsd: number | null;
  /** Wall time expected to be burned by attempts that do NOT verify. */
  expectedFailedWallTimeMs: number | null;

  // --- risk --------------------------------------------------------------
  stagnationRate: number | null;
  oscillationRate: number | null;
  runawayRate: number | null;
  contextMissRate: number | null;
  contextExpansionRate: number | null;
  /** Undecayed safety-class failures observed for this target. */
  safetyEvents: number;

  // --- provenance --------------------------------------------------------
  sampleCount: number;
  weightedSampleCount: number;
  lastObservedAt: string | null;
  /** Bounded, human-readable notes about what the evidence could not say. */
  notes: string[];
}

export interface PredictCandidateInput {
  candidate: ExecutionCandidate;
  signature: TaskSignature;
  profiles: AdaptiveProfileSet;
  policy: AdaptiveSchedulerPolicy;
  /**
   * The EXISTING heuristic's expectation that one attempt succeeds — the
   * Beta prior's mean. Supplied by the caller from the vNext.2 workload
   * estimate (`1 - retryProbability`), which makes the prior a documented
   * reuse of current policy rather than a new opinion invented here. It is
   * the same for every candidate on a task, so the prior can express
   * uncertainty but can never express provider favouritism.
   */
  priorSuccessProbability: number;
  /** Heuristic fallbacks for resource estimates, when history is silent. */
  heuristicWallTimeMs?: number | null | undefined;
  heuristicInputTokens?: number | null | undefined;
  heuristicContextTokens?: number | null | undefined;
  heuristicFiveHourBurnRatio?: number | null | undefined;
}

/** The profile lookup keys for one candidate, most specific first. */
export function profileLookupKeys(
  candidate: ExecutionCandidate,
  signature: TaskSignature,
): readonly { level: ProfileFallbackLevel; profileKey: string }[] {
  return [
    { level: 'EXACT', profileKey: `${signature.key}::${candidate.candidateId}` },
    {
      level: 'TARGET_CATEGORY',
      profileKey: `${categorySignatureKey(signature)}::${targetKey(candidate)}`,
    },
    { level: 'LANE_CATEGORY', profileKey: `${categoryOnlyKey(signature)}::${candidate.lane}` },
    { level: 'LANE_GLOBAL', profileKey: `*::${candidate.lane}` },
  ];
}

interface Resolved {
  level: ProfileFallbackLevel;
  profileKey: string | null;
  profile: ExecutionPerformanceProfile | null;
}

/**
 * Walk the hierarchy from specific to general and stop at the first level
 * with enough evidence.
 *
 * "Enough" is `minimumComparableSamples`, weighted. When no level clears it,
 * the most specific level with ANY observation answers instead — its
 * confidence will be LOW, which is the honest description of a bucket that
 * exists but is thin, and is very different from having no data at all.
 */
function resolveProfile(input: PredictCandidateInput): Resolved {
  const keys = profileLookupKeys(input.candidate, input.signature);
  let sparse: Resolved | null = null;
  for (const { level, profileKey } of keys) {
    const profile = input.profiles.profiles.get(profileIndexKey(level, profileKey));
    if (profile === undefined) continue;
    if (profile.weightedSamples >= input.policy.minimumComparableSamples) {
      return { level, profileKey, profile };
    }
    if (sparse === null && profile.samples > 0) sparse = { level, profileKey, profile };
  }
  if (sparse !== null) return sparse;
  return { level: 'HEURISTIC_PRIOR', profileKey: null, profile: null };
}

/**
 * Compare the runtime identity behind the evidence with the identity that
 * would execute now.
 *
 * Coarser profile levels aggregate across runners by construction, so their
 * identity is genuinely UNKNOWN rather than matching — and UNKNOWN reduces
 * confidence, which is the conservative direction. Nothing here guesses at
 * compatibility between versions it has no policy for.
 */
export function compareRuntimeIdentity(
  candidate: ExecutionCandidate,
  profile: ExecutionPerformanceProfile | null,
): RuntimeIdentityMatch {
  if (profile === null || profile.latestRuntimeIdentity === null) return 'UNKNOWN';
  if (profile.level === 'LANE_CATEGORY' || profile.level === 'LANE_GLOBAL') return 'UNKNOWN';
  const live = runtimeIdentityOf({
    runner: candidate.runner ?? '-',
    model: candidate.model,
    // The live runner version is not observable at scheduling time, so it is
    // 'unknown' on both sides of this comparison unless a runner reported
    // one. Unknown never resolves to "matches".
    runnerVersion: null,
    contextStrategy: candidate.contextStrategy,
  });
  if (live === profile.latestRuntimeIdentity) return 'EXACT';
  const liveParts = live.split('@');
  const historyParts = profile.latestRuntimeIdentity.split('@');
  if (liveParts[0] !== historyParts[0]) return 'CHANGED';
  if (liveParts.includes('unknown') || historyParts.includes('unknown')) return 'UNKNOWN';
  // Same runner family, a version or model moved: history still says
  // something, but not at face value.
  return 'COMPATIBLE';
}

function step(level: PredictionConfidence, downBy: number): PredictionConfidence {
  const rank = Math.max(0, PREDICTION_CONFIDENCE_RANK[level] - downBy);
  return PREDICTION_CONFIDENCE_LEVELS[rank] ?? 'NONE';
}

/**
 * The confidence ladder. Deterministic, and stated here in one place so the
 * diagnostic can print exactly why a prediction was or was not trusted.
 *
 *   base, by weighted evidence:
 *     >= 4x the adaptive-decision floor  HIGH
 *     >= the adaptive-decision floor     MEDIUM
 *     >  0                               LOW
 *     none                               NONE
 *
 *   demotions (cumulative, floored at NONE):
 *     answered at TARGET_CATEGORY        -1   coarser task grouping
 *     answered at LANE_CATEGORY/GLOBAL   -2   much coarser; no target identity
 *     answered at HEURISTIC_PRIOR        NONE cold start
 *     runtime identity COMPATIBLE        -1   a version moved
 *     runtime identity UNKNOWN           -1   identity was never recorded
 *     runtime identity CHANGED           NONE measured thing is not this thing
 *     drift detected                     -1   recent behavior diverged
 *     high wall-time spread (P90/P50>4)  -1   the distribution is not stable
 */
export function assessConfidence(input: {
  profile: ExecutionPerformanceProfile | null;
  level: ProfileFallbackLevel;
  identityMatch: RuntimeIdentityMatch;
  policy: AdaptiveSchedulerPolicy;
}): { confidence: PredictionConfidence; score: number; notes: string[] } {
  const notes: string[] = [];
  const profile = input.profile;
  if (profile === null || input.level === 'HEURISTIC_PRIOR') {
    return {
      confidence: 'NONE',
      score: 0,
      notes: ['No observed history at any profile level; the deterministic heuristic decides.'],
    };
  }

  const floor = input.policy.minimumSamplesForAdaptiveDecision;
  let level: PredictionConfidence =
    profile.weightedSamples >= floor * 4
      ? 'HIGH'
      : profile.weightedSamples >= floor
        ? 'MEDIUM'
        : profile.weightedSamples > 0
          ? 'LOW'
          : 'NONE';

  if (input.level === 'TARGET_CATEGORY') {
    level = step(level, 1);
    notes.push('Evidence came from the coarser task-category profile, not an exact match.');
  } else if (input.level === 'LANE_CATEGORY' || input.level === 'LANE_GLOBAL') {
    level = step(level, 2);
    notes.push('Evidence came from lane-level defaults; no target-specific history exists.');
  }

  if (input.identityMatch === 'CHANGED') {
    level = 'NONE';
    notes.push('The runner behind this history is not the runner that would execute: cold start.');
  } else if (input.identityMatch === 'COMPATIBLE') {
    level = step(level, 1);
    notes.push('A model/runtime version moved since this history was measured.');
  } else if (input.identityMatch === 'UNKNOWN') {
    level = step(level, 1);
    notes.push('Runtime identity behind this history is unknown and is not assumed to match.');
  }

  if (profile.drift.detected) {
    level = step(level, 1);
    notes.push(`Performance drift detected: ${profile.drift.detail}.`);
  }

  const p50 = profile.wallTimeMs.p50;
  const p90 = profile.wallTimeMs.p90;
  if (p50 !== null && p90 !== null && p50 > 0 && p90 / p50 > 4) {
    level = step(level, 1);
    notes.push('Wall-time distribution is highly variable; the median predicts weakly.');
  }
  if (profile.wallTimeMs.observations === 0) {
    notes.push('No attempt in this profile reported wall time; timing falls back to the heuristic.');
  }

  // The numeric score is an audit aid, not a second opinion: it is derived
  // from the same ladder, so it can never disagree with the level above it.
  const score = PREDICTION_CONFIDENCE_RANK[level] / 3;
  return { confidence: level, score, notes };
}

const NO_DRIFT: ProfileDrift = Object.freeze({ detected: false, signals: [], detail: '' });

/**
 * Predict one candidate's behavior on one task.
 *
 * The smoothing formula, documented once and unit-tested:
 *
 *   P(verified) = (weightedVerifiedSuccesses + priorStrength * priorMean)
 *                 -------------------------------------------------------
 *                 (weightedIntelligenceAttempts + priorStrength)
 *
 * Only attempts that RESOLVED the intelligence question appear in the
 * denominator: verified successes and implementation failures. A crashed
 * harness, an inconclusive verdict, and an interrupted run are all excluded
 * from it — they are real events with real costs, priced elsewhere in this
 * prediction, but none of them is evidence about whether the model can do
 * the work.
 *
 * With `priorStrength` at its default of 4, one success out of one attempt
 * yields (1 + 4 * prior) / (1 + 4) — around 0.68 for a prior of 0.6, not the
 * 100% a naive rate would report.
 */
export function predictCandidate(input: PredictCandidateInput): CandidatePrediction {
  const { policy } = input;
  const resolved = resolveProfile(input);
  const profile = resolved.profile;
  const identityMatch = compareRuntimeIdentity(input.candidate, profile);
  const confidence = assessConfidence({
    profile,
    level: resolved.level,
    identityMatch,
    policy,
  });

  const prior = Math.min(1, Math.max(0, input.priorSuccessProbability));
  const successNumerator = (profile?.weightedVerifiedSuccesses ?? 0) + policy.priorStrength * prior;
  const successDenominator = (profile?.weightedIntelligenceAttempts ?? 0) + policy.priorStrength;
  const smoothedSuccess = Math.min(1, Math.max(0, successNumerator / successDenominator));

  // Expected attempts to one verified completion, under the geometric
  // reading of a per-attempt success probability. Clamped so a pessimistic
  // estimate cannot produce an unbounded cost term.
  const expectedAttempts = Math.min(8, 1 / Math.max(smoothedSuccess, 0.05));

  const wallTime = profile?.wallTimeMs.p50 ?? input.heuristicWallTimeMs ?? null;
  const totalWallTime =
    wallTime === null ? null : Math.round(wallTime * expectedAttempts + input.candidate.handoffOverheadMs);

  const notes = [...confidence.notes];
  if (profile !== null && profile.unverifiedSuccesses > 0) {
    notes.push(
      `${profile.unverifiedSuccesses} attempt(s) completed without a PASS evaluation and are ` +
        'excluded from the success rate; completion provenance is preserved, not rounded up.',
    );
  }
  if (profile !== null && profile.censored > 0) {
    notes.push(
      `${profile.censored} interrupted attempt(s) are counted as censored: their cost is priced, ` +
        'their outcome is not guessed.',
    );
  }
  if (profile !== null && profile.safetyEvents > 0) {
    notes.push(
      `${profile.safetyEvents} safety-class failure(s) recorded for this target; these do not decay.`,
    );
  }

  // Expected wall time burned by attempts that will NOT verify: the failure
  // cost that makes "cheap first attempt, three retries" stop looking cheap.
  const expectedFailedWallTimeMs =
    wallTime === null ? null : Math.round(wallTime * Math.max(0, expectedAttempts - 1));

  return {
    candidate: input.candidate,
    level: resolved.level,
    profileKey: resolved.profileKey,
    confidence: confidence.confidence,
    confidenceScore: confidence.score,
    identityMatch,
    drift: profile?.drift ?? NO_DRIFT,
    verifiedSuccessProbability: smoothedSuccess,
    priorSuccessProbability: prior,
    observedSuccessRate:
      profile !== null && profile.verifiedSuccesses + profile.implementationFailures > 0
        ? profile.verifiedSuccesses / (profile.verifiedSuccesses + profile.implementationFailures)
        : null,
    firstAttemptSuccessRate:
      profile !== null && profile.firstAttempts > 0
        ? profile.firstAttemptSuccesses / profile.firstAttempts
        : null,
    availabilityProbability:
      profile !== null && profile.infrastructureFailureRate !== null
        ? 1 - profile.infrastructureFailureRate
        : null,
    expectedAttempts,
    expectedWallTimeMs: wallTime,
    expectedTotalWallTimeMs: totalWallTime,
    expectedInputTokens: profile?.inputTokens.p50 ?? input.heuristicInputTokens ?? null,
    expectedContextTokens: profile?.contextTokens.p50 ?? input.heuristicContextTokens ?? null,
    expectedFiveHourBurnRatio:
      profile?.fiveHourBurnRatio.p50 ?? input.heuristicFiveHourBurnRatio ?? null,
    conservativeFiveHourBurnRatio:
      profile?.fiveHourBurnRatio.p90 ?? input.heuristicFiveHourBurnRatio ?? null,
    expectedApiCostUsd: profile?.apiCostUsd.p50 ?? null,
    expectedFailedWallTimeMs,
    stagnationRate: profile?.stagnationRate ?? null,
    oscillationRate: profile?.oscillationRate ?? null,
    runawayRate: profile?.runawayRate ?? null,
    contextMissRate: profile?.contextMissRate ?? null,
    contextExpansionRate: profile?.contextExpansionRate ?? null,
    safetyEvents: profile?.safetyEvents ?? 0,
    sampleCount: profile?.samples ?? 0,
    weightedSampleCount: profile?.weightedSamples ?? 0,
    lastObservedAt: profile?.lastObservedAt ?? null,
    notes,
  };
}
