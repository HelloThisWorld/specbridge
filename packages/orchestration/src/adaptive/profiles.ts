import type { AdaptiveSchedulerPolicy } from '@specbridge/core';
import type { AdaptiveObservation } from './outcomes.js';
import type { AdaptiveDriftSignal, ProfileFallbackLevel } from './vocabulary.js';

/**
 * ExecutionPerformanceProfile (vNext.8): derived analytics over observed
 * history.
 *
 * DERIVED STATE, and the distinction is load-bearing rather than decorative:
 * every number here is recomputable from the ExecutionLedger, nothing here
 * is ever canonical Job state, deleting the cache costs nothing but a
 * rebuild, and a corrupt cache degrades the scheduler to its heuristics
 * rather than failing a job. Attempts are the truth; this is a read model
 * over them.
 *
 * Four things the aggregation refuses to do, each of which would produce a
 * confidently wrong number:
 *
 *   no fabricated metrics    an attempt that reported no token usage
 *                            contributes to no token statistic. It does not
 *                            contribute a zero, because a silent provider
 *                            must never look cheap.
 *   no collapsed failures    implementation failure, infrastructure failure,
 *                            inconclusive evidence, and censored attempts
 *                            stay separate all the way through.
 *   no unbounded history     observations past the configured age are
 *                            dropped, and recency-weighted so a model's
 *                            performance last quarter cannot outvote its
 *                            performance this week.
 *   no decayed safety        contract/authorization violations are counted
 *                            undecayed. Rare and serious is not the same as
 *                            old and irrelevant.
 */

export interface ProfileMetricSummary {
  /** How many observations actually reported this metric (sparsity visible). */
  observations: number;
  p50: number | null;
  p90: number | null;
}

const EMPTY_METRIC: ProfileMetricSummary = Object.freeze({ observations: 0, p50: null, p90: null });

export interface ProfileDrift {
  detected: boolean;
  signals: AdaptiveDriftSignal[];
  detail: string;
}

export interface ExecutionPerformanceProfile {
  level: ProfileFallbackLevel;
  /** `<signature part>::<target part>` — readable, so profiles are auditable. */
  profileKey: string;
  signaturePart: string;
  targetPart: string;
  lane: string | null;
  executionMode: string | null;
  runner: string | null;

  // --- counts ------------------------------------------------------------
  /** Total observations folded in, every label included. */
  samples: number;
  /** Recency-weighted total. The figure evidence floors compare against. */
  weightedSamples: number;
  verifiedSuccesses: number;
  unverifiedSuccesses: number;
  implementationFailures: number;
  infrastructureFailures: number;
  inconclusive: number;
  censored: number;
  /** Weighted verified successes and weighted intelligence-resolving attempts. */
  weightedVerifiedSuccesses: number;
  weightedIntelligenceAttempts: number;
  /** First-attempt statistics: succeeding twice after failing once is not the same. */
  firstAttempts: number;
  firstAttemptSuccesses: number;

  // --- resource distributions -------------------------------------------
  wallTimeMs: ProfileMetricSummary;
  inputTokens: ProfileMetricSummary;
  contextTokens: ProfileMetricSummary;
  fiveHourBurnRatio: ProfileMetricSummary;
  apiCostUsd: ProfileMetricSummary;

  // --- observed derived rates -------------------------------------------
  /** Observed attempts per verified success. Null when nothing verified yet. */
  attemptsPerSuccess: number | null;
  stagnationRate: number | null;
  oscillationRate: number | null;
  runawayRate: number | null;
  contextExpansionRate: number | null;
  /** Share of attempts that failed for want of CONTEXT rather than ability. */
  contextMissRate: number | null;
  /** Availability: share of non-censored attempts that did NOT break. */
  infrastructureFailureRate: number | null;

  // --- cost of failure ---------------------------------------------------
  /** Wall time burned by attempts that did not verify. */
  failedWallTimeMs: number;
  failedTokens: number | null;
  failedCostUsd: number | null;
  failedFiveHourBurnRatio: number | null;

  // --- identity and provenance ------------------------------------------
  failureSources: Record<string, number>;
  /** Distinct runtime identities observed, newest last. */
  runtimeIdentities: string[];
  latestRuntimeIdentity: string | null;
  /** Undecayed count of safety-class failures. */
  safetyEvents: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  drift: ProfileDrift;
}

/** All profiles for one workspace, indexed by level and key. */
export interface AdaptiveProfileSet {
  /** `${level}::${profileKey}` -> profile. */
  profiles: Map<string, ExecutionPerformanceProfile>;
  /** Observations folded in (after age filtering). */
  observationCount: number;
  /** Observations skipped because they were older than the configured age. */
  droppedByAge: number;
  builtAt: string;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile over the retained window.
 *
 * Deliberately UNWEIGHTED, unlike the success rates: a weighted percentile
 * has no single accepted definition, and picking one silently would make
 * "P90 burn" mean something different from what every other part of the
 * runtime means by it. Recency is applied where it changes a decision — the
 * probability estimates — not where it would only obscure a distribution.
 */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

function summarize(values: readonly number[]): ProfileMetricSummary {
  if (values.length === 0) return { ...EMPTY_METRIC };
  return { observations: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9) };
}

/**
 * Deterministic exponential recency weight.
 *
 *   weight = 0.5 ^ (age / halfLife)
 *
 * Chosen over a rolling window because it is continuous: a window boundary
 * makes one observation worth everything on Monday and nothing on Tuesday,
 * which turns a scheduler's placement into a function of the calendar.
 * Clamped to [0,1]; an observation timestamped in the future (clock skew)
 * weighs exactly as much as one from right now, never more.
 */
export function recencyWeight(ageMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  if (halfLifeMs <= 0) return 1;
  return Math.min(1, Math.max(0, Math.pow(0.5, ageMs / halfLifeMs)));
}

/** Stable runtime identity string for one observation. Unknown stays unknown. */
export function runtimeIdentityOf(observation: {
  runner: string;
  model: string | null;
  runnerVersion: string | null;
  contextStrategy: string | null;
}): string {
  return [
    observation.runner,
    observation.runnerVersion ?? 'unknown',
    observation.model ?? 'unknown',
    observation.contextStrategy ?? 'unknown',
  ].join('@');
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Bucket {
  level: ProfileFallbackLevel;
  signaturePart: string;
  targetPart: string;
  lane: string | null;
  executionMode: string | null;
  runner: string | null;
  observations: AdaptiveObservation[];
}

/**
 * The four grouping levels one observation contributes to.
 *
 * An observation is folded into EVERY level it belongs to, not just the most
 * specific: that is what makes the sparse-data fallback work at all. A
 * coarser level is not a different dataset, it is the same dataset with a
 * dimension dropped.
 */
function bucketsFor(observation: AdaptiveObservation): readonly Omit<Bucket, 'observations'>[] {
  const lane = observation.lane ?? '-';
  const category = observation.taskCategory ?? 'unknown';
  const complexity = observation.taskComplexity ?? 'unknown';
  return [
    {
      level: 'EXACT',
      signaturePart: observation.signatureKey ?? 'unknown',
      targetPart: observation.candidateKey,
      lane: observation.lane,
      executionMode: observation.executionMode,
      runner: observation.runner,
    },
    {
      level: 'TARGET_CATEGORY',
      signaturePart: `${category}|${complexity}`,
      targetPart: observation.targetKey,
      lane: observation.lane,
      executionMode: observation.executionMode,
      runner: observation.runner,
    },
    {
      level: 'LANE_CATEGORY',
      signaturePart: category,
      targetPart: lane,
      lane: observation.lane,
      executionMode: null,
      runner: null,
    },
    {
      level: 'LANE_GLOBAL',
      signaturePart: '*',
      targetPart: lane,
      lane: observation.lane,
      executionMode: null,
      runner: null,
    },
  ];
}

export function profileIndexKey(level: ProfileFallbackLevel, profileKey: string): string {
  return `${level}::${profileKey}`;
}

export interface AggregateProfilesInput {
  observations: readonly AdaptiveObservation[];
  policy: AdaptiveSchedulerPolicy;
  now: Date;
}

/**
 * Aggregate observations into the full profile set. Pure and deterministic:
 * the same observations and the same `now` always produce byte-identical
 * profiles, which is what makes "delete the cache and rebuild" a safe
 * operation rather than a hopeful one.
 */
export function aggregateProfiles(input: AggregateProfilesInput): AdaptiveProfileSet {
  const { policy } = input;
  const nowMs = input.now.getTime();
  const buckets = new Map<string, Bucket>();
  let dropped = 0;
  let kept = 0;

  // Newest first, then bounded: when history exceeds the ceiling the RECENT
  // observations are the ones retained. Truncating the other way would make
  // a long-lived workspace permanently reason about its own distant past.
  const ordered = [...input.observations].sort((left, right) =>
    left.observedAt < right.observedAt ? 1 : left.observedAt > right.observedAt ? -1 : 0,
  );

  for (const observation of ordered) {
    if (kept >= policy.maxObservations) break;
    const observedMs = Date.parse(observation.observedAt);
    const ageMs = Number.isFinite(observedMs) ? nowMs - observedMs : 0;
    // Safety events never age out: the rule they violated is still the rule.
    const tooOld = ageMs > policy.maxObservationAgeMs;
    if (tooOld && !(observation.safetyEvent && policy.safetyFailuresExemptFromDecay)) {
      dropped += 1;
      continue;
    }
    kept += 1;
    for (const shape of bucketsFor(observation)) {
      const profileKey = `${shape.signaturePart}::${shape.targetPart}`;
      const index = profileIndexKey(shape.level, profileKey);
      let bucket = buckets.get(index);
      if (bucket === undefined) {
        bucket = { ...shape, observations: [] };
        buckets.set(index, bucket);
      }
      bucket.observations.push(observation);
    }
  }

  const profiles = new Map<string, ExecutionPerformanceProfile>();
  for (const [index, bucket] of buckets) {
    profiles.set(index, buildProfile(bucket, policy, nowMs));
  }

  return {
    profiles,
    observationCount: kept,
    droppedByAge: dropped,
    builtAt: input.now.toISOString(),
  };
}

function buildProfile(
  bucket: Bucket,
  policy: AdaptiveSchedulerPolicy,
  nowMs: number,
): ExecutionPerformanceProfile {
  // Oldest first inside the bucket, so drift windows and identity ordering
  // both read chronologically.
  const observations = [...bucket.observations].sort((left, right) =>
    left.observedAt < right.observedAt ? -1 : left.observedAt > right.observedAt ? 1 : 0,
  );

  let verified = 0;
  let unverified = 0;
  let implementationFailures = 0;
  let infrastructureFailures = 0;
  let inconclusive = 0;
  let censored = 0;
  let weightedSamples = 0;
  let weightedVerified = 0;
  let weightedIntelligence = 0;
  let firstAttempts = 0;
  let firstAttemptSuccesses = 0;
  let stagnation = 0;
  let oscillation = 0;
  let runaway = 0;
  let contextMisses = 0;
  let safetyEvents = 0;
  let failedWallTimeMs = 0;
  let failedTokens: number | null = null;
  let failedCostUsd: number | null = null;
  let failedBurn: number | null = null;

  const wallTimes: number[] = [];
  const inputTokens: number[] = [];
  const contextTokens: number[] = [];
  const burns: number[] = [];
  const costs: number[] = [];
  const expansions: number[] = [];
  const failureSources: Record<string, number> = {};
  const identities: string[] = [];

  for (const observation of observations) {
    const observedMs = Date.parse(observation.observedAt);
    const ageMs = Number.isFinite(observedMs) ? nowMs - observedMs : 0;
    const weight = recencyWeight(ageMs, policy.recencyHalfLifeMs);
    weightedSamples += weight;

    switch (observation.label) {
      case 'VERIFIED_SUCCESS':
        verified += 1;
        weightedVerified += weight;
        weightedIntelligence += weight;
        break;
      case 'UNVERIFIED_SUCCESS':
        // Completion without verified evidence. Counted, reported, and
        // deliberately excluded from BOTH sides of the intelligence rate:
        // treating it as success would launder manual acceptance into
        // measured capability, and treating it as failure would punish a
        // target for a gap in evidence collection.
        unverified += 1;
        break;
      case 'IMPLEMENTATION_FAILURE':
        implementationFailures += 1;
        weightedIntelligence += weight;
        break;
      case 'INFRASTRUCTURE_FAILURE':
        infrastructureFailures += 1;
        break;
      case 'INCONCLUSIVE':
        inconclusive += 1;
        break;
      case 'CENSORED':
        censored += 1;
        break;
    }

    if (observation.attemptNumber === 1) {
      firstAttempts += 1;
      if (observation.label === 'VERIFIED_SUCCESS') firstAttemptSuccesses += 1;
    }
    if (observation.executionHealth === 'STALLED') stagnation += 1;
    if (observation.executionHealth === 'OSCILLATING') oscillation += 1;
    if (observation.executionHealth === 'RUNAWAY') runaway += 1;
    if (observation.contextInsufficient) contextMisses += 1;
    if (observation.safetyEvent) safetyEvents += 1;
    if (observation.failureSource !== null) {
      failureSources[observation.failureSource] = (failureSources[observation.failureSource] ?? 0) + 1;
    }

    if (observation.wallTimeMs !== null) wallTimes.push(observation.wallTimeMs);
    if (observation.inputTokens !== null) inputTokens.push(observation.inputTokens);
    if (observation.contextTokens !== null) contextTokens.push(observation.contextTokens);
    if (observation.fiveHourBurnRatio !== null) burns.push(observation.fiveHourBurnRatio);
    if (observation.costUsd !== null) costs.push(observation.costUsd);
    if (observation.contextExpansions !== null) expansions.push(observation.contextExpansions);

    // Cost of failure: what was spent by attempts that did not verify.
    // Censored attempts count here too — the compute was really consumed,
    // and pretending otherwise makes an unreliable target look cheap.
    if (observation.label !== 'VERIFIED_SUCCESS' && observation.label !== 'UNVERIFIED_SUCCESS') {
      if (observation.wallTimeMs !== null) failedWallTimeMs += observation.wallTimeMs;
      if (observation.inputTokens !== null) {
        failedTokens = (failedTokens ?? 0) + observation.inputTokens;
      }
      if (observation.costUsd !== null) failedCostUsd = (failedCostUsd ?? 0) + observation.costUsd;
      if (observation.fiveHourBurnRatio !== null) {
        failedBurn = (failedBurn ?? 0) + observation.fiveHourBurnRatio;
      }
    }

    const identity = runtimeIdentityOf(observation);
    if (identities[identities.length - 1] !== identity) {
      const existing = identities.indexOf(identity);
      if (existing >= 0) identities.splice(existing, 1);
      identities.push(identity);
    }
  }

  const nonCensored = observations.length - censored;
  const intelligenceAttempts = verified + implementationFailures;
  const first = observations[0];
  const last = observations[observations.length - 1];

  return {
    level: bucket.level,
    profileKey: `${bucket.signaturePart}::${bucket.targetPart}`,
    signaturePart: bucket.signaturePart,
    targetPart: bucket.targetPart,
    lane: bucket.lane,
    executionMode: bucket.executionMode,
    runner: bucket.runner,
    samples: observations.length,
    weightedSamples,
    verifiedSuccesses: verified,
    unverifiedSuccesses: unverified,
    implementationFailures,
    infrastructureFailures,
    inconclusive,
    censored,
    weightedVerifiedSuccesses: weightedVerified,
    weightedIntelligenceAttempts: weightedIntelligence,
    firstAttempts,
    firstAttemptSuccesses,
    wallTimeMs: summarize(wallTimes),
    inputTokens: summarize(inputTokens),
    contextTokens: summarize(contextTokens),
    fiveHourBurnRatio: summarize(burns),
    apiCostUsd: summarize(costs),
    attemptsPerSuccess: verified > 0 ? intelligenceAttempts / verified : null,
    stagnationRate: nonCensored > 0 ? stagnation / nonCensored : null,
    oscillationRate: nonCensored > 0 ? oscillation / nonCensored : null,
    runawayRate: nonCensored > 0 ? runaway / nonCensored : null,
    contextExpansionRate:
      expansions.length > 0
        ? expansions.filter((value) => value > 0).length / expansions.length
        : null,
    contextMissRate: nonCensored > 0 ? contextMisses / nonCensored : null,
    infrastructureFailureRate: nonCensored > 0 ? infrastructureFailures / nonCensored : null,
    failedWallTimeMs,
    failedTokens,
    failedCostUsd,
    failedFiveHourBurnRatio: failedBurn,
    failureSources,
    runtimeIdentities: identities,
    latestRuntimeIdentity: identities[identities.length - 1] ?? null,
    safetyEvents,
    firstObservedAt: first?.observedAt ?? null,
    lastObservedAt: last?.observedAt ?? null,
    drift: detectDrift(observations, policy),
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/**
 * Deterministic drift detection: split the bucket's observations into an
 * older and a recent half and compare them.
 *
 * Simple on purpose. Drift here has exactly one consequence — confidence
 * goes DOWN, which moves placement back toward the deterministic heuristics.
 * It never retrains anything, never reweights a model, and never picks a new
 * favourite. A mechanism whose only power is to make the system less certain
 * does not need to be clever, and a clever one would be harder to trust.
 */
export function detectDrift(
  observations: readonly AdaptiveObservation[],
  policy: AdaptiveSchedulerPolicy,
): ProfileDrift {
  const signals: AdaptiveDriftSignal[] = [];
  const details: string[] = [];

  // A runtime identity change is drift regardless of sample counts: the
  // thing being measured is not the thing that would run.
  const identities = new Set(observations.map((observation) => runtimeIdentityOf(observation)));
  if (identities.size > 1) {
    const recent = observations[observations.length - 1];
    signals.push('RUNTIME_IDENTITY_CHANGED');
    details.push(
      `runtime identity changed across the window (${identities.size} distinct; newest ` +
        `${recent !== undefined ? runtimeIdentityOf(recent) : 'unknown'})`,
    );
  }

  const half = Math.floor(observations.length / 2);
  if (half >= policy.driftMinimumSamples) {
    const older = observations.slice(0, half);
    const recent = observations.slice(observations.length - half);
    const olderRate = intelligenceRate(older);
    const recentRate = intelligenceRate(recent);
    if (olderRate !== null && recentRate !== null && olderRate > 0) {
      const drop = (olderRate - recentRate) / olderRate;
      if (drop >= policy.driftSuccessDropRatio) {
        signals.push('SUCCESS_RATE_DROP');
        details.push(
          `verified success fell from ${(olderRate * 100).toFixed(0)}% to ${(recentRate * 100).toFixed(0)}%`,
        );
      }
    }
    const olderWall = percentile(
      older.map((entry) => entry.wallTimeMs).filter((value): value is number => value !== null),
      0.5,
    );
    const recentWall = percentile(
      recent.map((entry) => entry.wallTimeMs).filter((value): value is number => value !== null),
      0.5,
    );
    if (olderWall !== null && recentWall !== null && olderWall > 0) {
      if (recentWall / olderWall >= policy.driftWallTimeGrowthFactor) {
        signals.push('WALL_TIME_GROWTH');
        details.push(
          `median wall time grew from ${Math.round(olderWall / 1_000)}s to ${Math.round(recentWall / 1_000)}s`,
        );
      }
    }
    const olderContext = percentile(
      older.map((entry) => entry.contextTokens).filter((value): value is number => value !== null),
      0.5,
    );
    const recentContext = percentile(
      recent.map((entry) => entry.contextTokens).filter((value): value is number => value !== null),
      0.5,
    );
    if (olderContext !== null && recentContext !== null && olderContext > 0) {
      if (recentContext / olderContext >= policy.driftWallTimeGrowthFactor) {
        signals.push('CONTEXT_GROWTH');
        details.push(
          `median context grew from ${Math.round(olderContext)} to ${Math.round(recentContext)} tokens`,
        );
      }
    }
    const olderSource = dominantFailureSource(older);
    const recentSource = dominantFailureSource(recent);
    if (olderSource !== null && recentSource !== null && olderSource !== recentSource) {
      signals.push('FAILURE_SOURCE_SHIFT');
      details.push(`dominant failure source moved from ${olderSource} to ${recentSource}`);
    }
  }

  return {
    detected: signals.length > 0,
    signals,
    detail: details.join('; '),
  };
}

function intelligenceRate(observations: readonly AdaptiveObservation[]): number | null {
  const resolving = observations.filter(
    (entry) => entry.label === 'VERIFIED_SUCCESS' || entry.label === 'IMPLEMENTATION_FAILURE',
  );
  if (resolving.length === 0) return null;
  return resolving.filter((entry) => entry.label === 'VERIFIED_SUCCESS').length / resolving.length;
}

function dominantFailureSource(observations: readonly AdaptiveObservation[]): string | null {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    if (observation.failureSource === null) continue;
    counts.set(observation.failureSource, (counts.get(observation.failureSource) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  // Ties resolve by name so the result is deterministic rather than
  // dependent on insertion order.
  for (const [source, count] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > bestCount) {
      best = source;
      bestCount = count;
    }
  }
  return best;
}
