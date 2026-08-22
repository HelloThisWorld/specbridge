import type { AdaptiveSchedulerMode, AdaptiveSchedulerPolicy } from '@specbridge/core';
import type { QuotaForecast } from '../quota/state.js';
import type { CandidateSet, ExecutionCandidate, RejectedCandidate } from './candidates.js';
import type { TaskSignature } from './signature.js';
import type { AdaptiveProfileSet } from './profiles.js';
import type { CandidatePrediction } from './prediction.js';
import { predictCandidate } from './prediction.js';
import type { UtilityScore } from './utility.js';
import { describeCandidate, explainComparison, scoreCandidate } from './utility.js';
import type { AdaptiveFallbackReason, PredictionConfidence } from './vocabulary.js';
import { meetsConfidence } from './vocabulary.js';

/**
 * Candidate ranking (vNext.8): turn predictions into a placement, or decline
 * to.
 *
 * The pipeline this module completes:
 *
 *   Task -> Hard Eligibility/Policy -> Candidate Set -> Adaptive Prediction
 *        -> Candidate Ranking -> Selected ELIGIBLE Candidate
 *
 * Ranking receives the candidate set; it cannot add to it. Everything below
 * therefore decides only ORDER and whether the top of that order has earned
 * the right to displace the deterministic incumbent. Four independent bars
 * must all be cleared before it does:
 *
 *   evidence     both compared candidates carry enough weighted observations
 *   confidence   the winner's confidence clears the configured floor
 *   margin       the winner beats the incumbent by more than hysteresis
 *   mode         the scheduler is in ADAPTIVE, not SHADOW or HEURISTIC
 *
 * Failing any bar is not an error and is not silent: the heuristic executes
 * and the specific bar that was not cleared is persisted as the fallback
 * reason. "Why did it not use the thing history prefers?" always has a
 * mechanical answer.
 */

export interface RankCandidatesInput {
  mode: AdaptiveSchedulerMode;
  candidates: CandidateSet;
  signature: TaskSignature;
  profiles: AdaptiveProfileSet;
  policy: AdaptiveSchedulerPolicy;
  forecast: QuotaForecast;
  /** The heuristic's own expectation that one attempt succeeds (Beta prior). */
  priorSuccessProbability: number;
  heuristicWallTimeMs?: number | null | undefined;
  heuristicInputTokens?: number | null | undefined;
  heuristicContextTokens?: number | null | undefined;
  heuristicFiveHourBurnRatio?: number | null | undefined;
}

export interface RankedCandidate {
  prediction: CandidatePrediction;
  score: UtilityScore;
}

export interface AdaptiveRanking {
  mode: AdaptiveSchedulerMode;
  /** Every eligible candidate, best first. Deterministic tie-break. */
  ranked: RankedCandidate[];
  /** Candidates hard policy refused. Informational, never executable. */
  vetoes: RejectedCandidate[];
  /** What the deterministic scheduler would run. */
  heuristicCandidate: ExecutionCandidate | null;
  /** What ranking prefers, before any gating is applied. */
  recommendedCandidate: ExecutionCandidate | null;
  /** What will actually execute. Equals the heuristic unless adaptive applied. */
  selectedCandidate: ExecutionCandidate | null;
  /** True when adaptive ranking, not the heuristic, chose the selection. */
  adaptiveApplied: boolean;
  /**
   * True when ranking prefers something other than the heuristic choice.
   * Recorded in SHADOW mode as a DISAGREEMENT and nothing more: SpecBridge
   * did not run the alternative and therefore does not know what it would
   * have done. No counterfactual outcome is ever derived from this flag.
   */
  disagreement: boolean;
  /**
   * Whether every gate except the mode gate was cleared — i.e. whether
   * ADAPTIVE mode would have acted on this recommendation. The number
   * SHADOW rollout is actually judged on.
   */
  wouldApplyInAdaptiveMode: boolean;
  confidence: PredictionConfidence;
  /** Utility margin of the recommendation over the incumbent. */
  utilityMargin: number | null;
  fallbackReason: AdaptiveFallbackReason | null;
  explanation: string[];
}

interface GateResult {
  passes: boolean;
  reason: AdaptiveFallbackReason | null;
  detail: string;
}

/**
 * The evidence/confidence/margin gates, evaluated in the order a reader
 * would ask them. The FIRST failing gate is the recorded reason, because
 * "there is no data" and "the margin was thin" are different problems with
 * different fixes.
 */
function evaluateGates(input: {
  recommended: RankedCandidate;
  incumbent: RankedCandidate;
  policy: AdaptiveSchedulerPolicy;
}): GateResult {
  const { recommended, incumbent, policy } = input;

  if (recommended.prediction.level === 'HEURISTIC_PRIOR') {
    return {
      passes: false,
      reason: 'COLD_START',
      detail: 'No observed history at any profile level; the deterministic heuristic decides.',
    };
  }
  if (recommended.prediction.weightedSampleCount < policy.minimumSamplesForAdaptiveDecision) {
    return {
      passes: false,
      reason: 'INSUFFICIENT_SAMPLES',
      detail:
        `${recommended.prediction.weightedSampleCount.toFixed(1)} weighted sample(s) for ` +
        `${describeCandidate(recommended.prediction)}; ${policy.minimumSamplesForAdaptiveDecision} required ` +
        'before history may override the heuristic.',
    };
  }
  if (incumbent.prediction.weightedSampleCount < policy.minimumComparableSamples) {
    return {
      passes: false,
      reason: 'INSUFFICIENT_COMPARABLE_SAMPLES',
      detail:
        `The heuristic incumbent ${describeCandidate(incumbent.prediction)} carries only ` +
        `${incumbent.prediction.weightedSampleCount.toFixed(1)} weighted sample(s); a comparison ` +
        'against a barely-measured alternative is not evidence.',
    };
  }
  if (!meetsConfidence(recommended.prediction.confidence, policy.minimumConfidence)) {
    // Drift is the more specific and more actionable explanation when it is
    // what pushed confidence under the bar.
    const reason: AdaptiveFallbackReason = recommended.prediction.drift.detected
      ? 'DRIFT_DETECTED'
      : 'CONFIDENCE_BELOW_THRESHOLD';
    return {
      passes: false,
      reason,
      detail:
        `Confidence ${recommended.prediction.confidence} is below the configured ` +
        `${policy.minimumConfidence} floor` +
        (recommended.prediction.drift.detected
          ? ` after drift was detected (${recommended.prediction.drift.detail}).`
          : '.'),
    };
  }
  const margin = recommended.score.score - incumbent.score.score;
  if (margin < policy.minimumUtilityImprovement) {
    return {
      passes: false,
      reason: 'UTILITY_MARGIN_TOO_SMALL',
      detail:
        `Utility advantage ${margin.toFixed(4)} is under the ${policy.minimumUtilityImprovement} ` +
        'hysteresis threshold; the stable choice stands rather than chasing noise.',
    };
  }
  return { passes: true, reason: null, detail: `Utility advantage ${margin.toFixed(4)}.` };
}

/**
 * Rank the eligible candidates and decide whether adaptive placement applies.
 * Pure and deterministic given the same profiles, policy, and forecast.
 */
export function rankCandidates(input: RankCandidatesInput): AdaptiveRanking {
  const eligible = input.candidates.eligible;
  const vetoes = input.candidates.rejected;

  if (eligible.length === 0) {
    const blocking = vetoes.filter((entry) => entry.code !== 'LANE_NOT_ELIGIBLE');
    return {
      mode: input.mode,
      ranked: [],
      vetoes,
      heuristicCandidate: null,
      recommendedCandidate: null,
      selectedCandidate: null,
      adaptiveApplied: false,
      disagreement: false,
      wouldApplyInAdaptiveMode: false,
      confidence: 'NONE',
      utilityMargin: null,
      fallbackReason: blocking.length > 0 ? 'ALL_PREFERRED_CANDIDATES_VETOED' : null,
      explanation:
        blocking.length > 0
          ? blocking.map((entry) => `${entry.code}: ${entry.detail}`)
          : ['Hard policy left no eligible candidate; there is nothing to rank.'],
    };
  }

  const ranked: RankedCandidate[] = eligible
    .map((candidate) => {
      const prediction = predictCandidate({
        candidate,
        signature: input.signature,
        profiles: input.profiles,
        policy: input.policy,
        priorSuccessProbability: input.priorSuccessProbability,
        heuristicWallTimeMs: input.heuristicWallTimeMs,
        heuristicInputTokens: input.heuristicInputTokens,
        heuristicContextTokens: input.heuristicContextTokens,
        heuristicFiveHourBurnRatio: input.heuristicFiveHourBurnRatio,
      });
      return {
        prediction,
        score: scoreCandidate({ prediction, policy: input.policy, forecast: input.forecast }),
      };
    })
    // Highest score first; ties break on the derived candidate key so the
    // order is reproducible across processes rather than dependent on the
    // order candidates happened to be generated in.
    .sort((left, right) =>
      right.score.score !== left.score.score
        ? right.score.score - left.score.score
        : left.prediction.candidate.candidateId < right.prediction.candidate.candidateId
          ? -1
          : 1,
    );

  const first = ranked[0] as RankedCandidate;
  const incumbent = ranked.find((entry) => entry.prediction.candidate.heuristicChoice) ?? first;
  const heuristicCandidate = incumbent.prediction.candidate;
  const recommendedCandidate = first.prediction.candidate;
  const disagreement = recommendedCandidate.candidateId !== heuristicCandidate.candidateId;
  const utilityMargin = first.score.score - incumbent.score.score;

  const explanation = explainComparison(
    first,
    ranked.find((entry) => entry.prediction.candidate.candidateId !== first.prediction.candidate.candidateId),
  );

  // Nothing to choose between: one candidate is not a ranking.
  if (eligible.length === 1) {
    return {
      mode: input.mode,
      ranked,
      vetoes,
      heuristicCandidate,
      recommendedCandidate,
      selectedCandidate: heuristicCandidate,
      adaptiveApplied: false,
      disagreement: false,
      wouldApplyInAdaptiveMode: false,
      confidence: first.prediction.confidence,
      utilityMargin: 0,
      fallbackReason: 'SINGLE_CANDIDATE',
      explanation,
    };
  }

  if (!disagreement) {
    return {
      mode: input.mode,
      ranked,
      vetoes,
      heuristicCandidate,
      recommendedCandidate,
      selectedCandidate: heuristicCandidate,
      adaptiveApplied: false,
      disagreement: false,
      wouldApplyInAdaptiveMode: false,
      confidence: first.prediction.confidence,
      utilityMargin: 0,
      fallbackReason: 'AGREES_WITH_HEURISTIC',
      explanation: [
        ...explanation,
        'Adaptive ranking prefers the same candidate the deterministic scheduler chose.',
      ],
    };
  }

  const gate = evaluateGates({ recommended: first, incumbent, policy: input.policy });

  if (input.mode === 'SHADOW') {
    return {
      mode: input.mode,
      ranked,
      vetoes,
      heuristicCandidate,
      recommendedCandidate,
      selectedCandidate: heuristicCandidate,
      adaptiveApplied: false,
      disagreement: true,
      wouldApplyInAdaptiveMode: gate.passes,
      confidence: first.prediction.confidence,
      utilityMargin,
      fallbackReason: 'MODE_SHADOW',
      explanation: [
        ...explanation,
        `SHADOW mode: ${describeCandidate(first.prediction)} is recommended but ` +
          `${describeCandidate(incumbent.prediction)} executes. The alternative was NOT run, so no ` +
          'claim is made about what it would have produced.',
        gate.passes
          ? 'In ADAPTIVE mode this recommendation would have been applied.'
          : `In ADAPTIVE mode this recommendation would NOT have been applied: ${gate.detail}`,
      ],
    };
  }

  if (input.mode === 'HEURISTIC') {
    return {
      mode: input.mode,
      ranked,
      vetoes,
      heuristicCandidate,
      recommendedCandidate,
      selectedCandidate: heuristicCandidate,
      adaptiveApplied: false,
      disagreement: true,
      wouldApplyInAdaptiveMode: gate.passes,
      confidence: first.prediction.confidence,
      utilityMargin,
      fallbackReason: 'MODE_HEURISTIC',
      explanation: [...explanation, 'Adaptive scheduling is disabled; the heuristic decides.'],
    };
  }

  if (!gate.passes) {
    return {
      mode: input.mode,
      ranked,
      vetoes,
      heuristicCandidate,
      recommendedCandidate,
      selectedCandidate: heuristicCandidate,
      adaptiveApplied: false,
      disagreement: true,
      wouldApplyInAdaptiveMode: false,
      confidence: first.prediction.confidence,
      utilityMargin,
      fallbackReason: gate.reason,
      explanation: [...explanation, gate.detail],
    };
  }

  return {
    mode: input.mode,
    ranked,
    vetoes,
    heuristicCandidate,
    recommendedCandidate,
    selectedCandidate: recommendedCandidate,
    adaptiveApplied: true,
    disagreement: true,
    wouldApplyInAdaptiveMode: true,
    confidence: first.prediction.confidence,
    utilityMargin,
    fallbackReason: null,
    explanation: [...explanation, gate.detail],
  };
}
