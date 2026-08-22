import type { AdaptiveSchedulerPolicy } from '@specbridge/core';
import type { QuotaForecast } from '../quota/state.js';
import type { AdaptiveObservation } from './outcomes.js';
import type { AdaptiveProfileSet } from './profiles.js';
import { aggregateProfiles } from './profiles.js';
import type { CandidateSet, ExecutionCandidate } from './candidates.js';
import type { TaskSignature } from './signature.js';
import { rankCandidates } from './ranking.js';
import type { AdaptiveFallbackReason } from './vocabulary.js';

/**
 * Offline scheduler replay and benchmark (vNext.8).
 *
 * Two analyses, and the difference between them is the whole point:
 *
 *   REPLAY     re-runs only the scheduler's DECISION logic over recorded
 *              history and reports where the adaptive layer would have
 *              recommended something else. It is recommendation analysis. It
 *              does NOT claim the alternative would have succeeded, because
 *              the alternative was never executed and SpecBridge has no way
 *              to know. Every counter below is about DECISIONS.
 *
 *   BENCHMARK  runs both schedulers over a SYNTHETIC workload whose outcomes
 *              are defined by the fixture, and reports simulated totals.
 *              Every result carries `simulated: true`, and callers are
 *              expected to print that: a synthetic win is evidence that the
 *              ranking logic behaves as designed, and evidence of nothing
 *              whatsoever about real-world savings.
 *
 * Neither function executes a model, spends money, or touches a workspace.
 */

// ---------------------------------------------------------------------------
// Historical replay
// ---------------------------------------------------------------------------

export interface ReplayCase {
  /** Identity of the recorded decision point (node or attempt). */
  id: string;
  signature: TaskSignature;
  candidates: CandidateSet;
  forecast: QuotaForecast;
  /** The heuristic's own success expectation, used as the Beta prior. */
  priorSuccessProbability: number;
  heuristicWallTimeMs?: number | null | undefined;
}

export interface ReplayOutcome {
  id: string;
  heuristicCandidateId: string | null;
  recommendedCandidateId: string | null;
  /** True when the adaptive layer preferred something else. */
  disagreed: boolean;
  /** True when the gates would also have let it act on that preference. */
  wouldApply: boolean;
  confidence: string;
  utilityMargin: number | null;
  fallbackReason: AdaptiveFallbackReason | null;
}

export interface ReplayReport {
  /** Stated on the report itself so a consumer cannot lose the caveat. */
  analysis: 'RECOMMENDATION_ONLY';
  cases: number;
  /** Cases where adaptive preferred the heuristic's own choice. */
  agreements: number;
  /** Cases where adaptive preferred something else. */
  disagreements: number;
  /** Disagreements that would also have cleared every gate. */
  wouldHaveApplied: number;
  /** Why the adaptive layer declined to act, counted by reason. */
  fallbackReasons: Record<string, number>;
  /** Distribution of recommendation confidence. */
  confidence: Record<string, number>;
  outcomes: ReplayOutcome[];
  /**
   * The claim this report does NOT make, carried as data so a renderer
   * cannot omit it by accident.
   */
  disclaimer: string;
}

const REPLAY_DISCLAIMER =
  'Recommendation analysis only. The alternative candidates were never executed, so this report ' +
  'says nothing about whether they would have succeeded, cost less, or finished sooner.';

/**
 * Replay the scheduler's decision logic over recorded decision points.
 *
 * Pure: takes the cases and the profile set, executes no work, and produces
 * counts about DECISIONS rather than outcomes.
 */
export function replaySchedulingDecisions(input: {
  cases: readonly ReplayCase[];
  profiles: AdaptiveProfileSet;
  policy: AdaptiveSchedulerPolicy;
}): ReplayReport {
  const outcomes: ReplayOutcome[] = [];
  const fallbackReasons: Record<string, number> = {};
  const confidence: Record<string, number> = {};

  for (const entry of input.cases) {
    const ranking = rankCandidates({
      // Replay always evaluates as if ADAPTIVE, so the report answers "what
      // would the adaptive layer do?" rather than "what did the configured
      // mode happen to allow?". The mode gate is reported separately, via
      // `wouldApply`.
      mode: 'ADAPTIVE',
      candidates: entry.candidates,
      signature: entry.signature,
      profiles: input.profiles,
      policy: input.policy,
      forecast: entry.forecast,
      priorSuccessProbability: entry.priorSuccessProbability,
      heuristicWallTimeMs: entry.heuristicWallTimeMs,
    });
    const outcome: ReplayOutcome = {
      id: entry.id,
      heuristicCandidateId: ranking.heuristicCandidate?.candidateId ?? null,
      recommendedCandidateId: ranking.recommendedCandidate?.candidateId ?? null,
      disagreed: ranking.disagreement,
      wouldApply: ranking.adaptiveApplied,
      confidence: ranking.confidence,
      utilityMargin: ranking.utilityMargin,
      fallbackReason: ranking.fallbackReason,
    };
    outcomes.push(outcome);
    confidence[outcome.confidence] = (confidence[outcome.confidence] ?? 0) + 1;
    if (outcome.fallbackReason !== null) {
      fallbackReasons[outcome.fallbackReason] = (fallbackReasons[outcome.fallbackReason] ?? 0) + 1;
    }
  }

  return {
    analysis: 'RECOMMENDATION_ONLY',
    cases: outcomes.length,
    agreements: outcomes.filter((entry) => !entry.disagreed).length,
    disagreements: outcomes.filter((entry) => entry.disagreed).length,
    wouldHaveApplied: outcomes.filter((entry) => entry.wouldApply).length,
    fallbackReasons,
    confidence,
    outcomes,
    disclaimer: REPLAY_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Deterministic offline benchmark
// ---------------------------------------------------------------------------

/**
 * One synthetic task in a benchmark workload.
 *
 * `outcomes` defines what the FIXTURE says each candidate does — the ground
 * truth the simulation draws from. This is the only place in the phase where
 * an outcome is assumed rather than observed, and it exists solely so the
 * two schedulers can be compared on identical, fully specified worlds.
 */
export interface BenchmarkTask {
  id: string;
  signature: TaskSignature;
  candidates: CandidateSet;
  forecast: QuotaForecast;
  priorSuccessProbability: number;
  /** Per-candidate ground truth, keyed by candidateId. */
  outcomes: Record<
    string,
    {
      /** Probability one attempt verifies, in the fixture's world. */
      successProbability: number;
      wallTimeMs: number;
      fiveHourBurnRatio: number;
      costUsd: number;
      contextTokens: number;
    }
  >;
  /** Bounded attempts before the task is abandoned in the simulation. */
  maxAttempts: number;
}

export interface BenchmarkTotals {
  tasks: number;
  completedTasks: number;
  attempts: number;
  /** Attempts that did not verify. */
  failedAttempts: number;
  attemptsPerCompletedTask: number | null;
  simulatedWallTimeMs: number;
  simulatedFailedWallTimeMs: number;
  simulatedFiveHourBurnRatio: number;
  simulatedApiCostUsd: number;
  simulatedContextTokens: number;
  policyVetoes: number;
  heuristicFallbacks: number;
}

export interface BenchmarkReport {
  /** Stated on the report so a consumer cannot lose the caveat. */
  simulated: true;
  heuristic: BenchmarkTotals;
  adaptive: BenchmarkTotals;
  disclaimer: string;
}

const BENCHMARK_DISCLAIMER =
  'Simulated results over a synthetic workload. The outcome probabilities are fixture data, not ' +
  'measurements, and these totals are not a claim about real-world savings.';

/**
 * Deterministic pseudo-random draw.
 *
 * Seeded from the task id and attempt index so a benchmark is byte-identical
 * across runs and machines. `Math.random` would make the report a different
 * document every time it was generated, which is not a benchmark.
 */
function draw(seed: string, index: number): number {
  let hash = 2_166_136_261;
  const material = `${seed}#${index}`;
  for (let position = 0; position < material.length; position += 1) {
    hash ^= material.charCodeAt(position);
    hash = Math.imul(hash, 16_777_619);
  }
  // Map to [0,1) via the unsigned 32-bit value.
  return (hash >>> 0) / 4_294_967_296;
}

function emptyTotals(): BenchmarkTotals {
  return {
    tasks: 0,
    completedTasks: 0,
    attempts: 0,
    failedAttempts: 0,
    attemptsPerCompletedTask: null,
    simulatedWallTimeMs: 0,
    simulatedFailedWallTimeMs: 0,
    simulatedFiveHourBurnRatio: 0,
    simulatedApiCostUsd: 0,
    simulatedContextTokens: 0,
    policyVetoes: 0,
    heuristicFallbacks: 0,
  };
}

function simulate(
  task: BenchmarkTask,
  candidate: ExecutionCandidate | null,
  totals: BenchmarkTotals,
): void {
  totals.tasks += 1;
  totals.policyVetoes += task.candidates.rejected.filter(
    (entry) => entry.code !== 'LANE_NOT_ELIGIBLE',
  ).length;
  if (candidate === null) return;
  const truth = task.outcomes[candidate.candidateId];
  if (truth === undefined) return;
  for (let attempt = 0; attempt < task.maxAttempts; attempt += 1) {
    totals.attempts += 1;
    totals.simulatedWallTimeMs += truth.wallTimeMs;
    totals.simulatedFiveHourBurnRatio += truth.fiveHourBurnRatio;
    totals.simulatedApiCostUsd += truth.costUsd;
    totals.simulatedContextTokens += truth.contextTokens;
    if (draw(`${task.id}/${candidate.candidateId}`, attempt) < truth.successProbability) {
      totals.completedTasks += 1;
      return;
    }
    totals.failedAttempts += 1;
    totals.simulatedFailedWallTimeMs += truth.wallTimeMs;
  }
}

function finalize(totals: BenchmarkTotals): BenchmarkTotals {
  return {
    ...totals,
    attemptsPerCompletedTask:
      totals.completedTasks > 0 ? totals.attempts / totals.completedTasks : null,
  };
}

/**
 * Run both schedulers over the same synthetic workload and report simulated
 * totals for each. Deterministic: same workload and same history in, same
 * report out.
 */
export function benchmarkSchedulers(input: {
  tasks: readonly BenchmarkTask[];
  /** Observed history the adaptive scheduler learns from. */
  history: readonly AdaptiveObservation[];
  policy: AdaptiveSchedulerPolicy;
  now: Date;
}): BenchmarkReport {
  const profiles = aggregateProfiles({
    observations: input.history,
    policy: input.policy,
    now: input.now,
  });
  const heuristic = emptyTotals();
  const adaptive = emptyTotals();

  for (const task of input.tasks) {
    const ranking = rankCandidates({
      mode: 'ADAPTIVE',
      candidates: task.candidates,
      signature: task.signature,
      profiles,
      policy: input.policy,
      forecast: task.forecast,
      priorSuccessProbability: task.priorSuccessProbability,
    });
    if (!ranking.adaptiveApplied) adaptive.heuristicFallbacks += 1;
    simulate(task, ranking.heuristicCandidate, heuristic);
    simulate(task, ranking.selectedCandidate, adaptive);
  }

  return {
    simulated: true,
    heuristic: finalize(heuristic),
    adaptive: finalize(adaptive),
    disclaimer: BENCHMARK_DISCLAIMER,
  };
}
