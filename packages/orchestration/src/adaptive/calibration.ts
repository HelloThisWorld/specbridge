import type { AdaptiveObservation } from './outcomes.js';
import type { CandidatePrediction } from './prediction.js';
import type { AdaptiveCalibrationRecord } from './store.js';
import { ADAPTIVE_CALIBRATION_SCHEMA_VERSION } from './store.js';

/**
 * Prediction calibration (vNext.8): how well did the forecast match reality?
 *
 * Built AFTER an attempt resolves, from the prediction recorded before it
 * started and the observation the ledger recorded when it ended. The
 * direction of authority is strict and one-way:
 *
 *   observed execution is canonical.
 *   a prediction is derived metadata about a decision.
 *
 * So a calibration record NEVER edits an attempt, an evaluation, a recovery
 * decision, or the ledger. When the forecast was wrong, the record says the
 * forecast was wrong; the measurement stands exactly as it was taken. And
 * because calibration is not evidence, nothing reads this log to make a
 * placement — feeding a prediction's own error back into the predictor is
 * how a scheduler starts agreeing with itself.
 */

/**
 * The predicted figures a calibration record compares against.
 *
 * A structural subset rather than the full `CandidatePrediction` so the
 * record can be built from a PERSISTED decision as easily as from a live
 * one — the comparison happens after the attempt finishes, often in a later
 * process than the one that made the forecast.
 */
export interface PredictedForCalibration {
  candidateId: string;
  verifiedSuccessProbability: number | null;
  expectedWallTimeMs: number | null;
  expectedInputTokens: number | null;
  expectedContextTokens: number | null;
  expectedFiveHourBurnRatio: number | null;
  expectedApiCostUsd: number | null;
  confidence: string;
}

/** Narrow a live prediction to the figures calibration compares. */
export function predictedFrom(prediction: CandidatePrediction): PredictedForCalibration {
  return {
    candidateId: prediction.candidate.candidateId,
    verifiedSuccessProbability: prediction.verifiedSuccessProbability,
    expectedWallTimeMs: prediction.expectedWallTimeMs,
    expectedInputTokens: prediction.expectedInputTokens,
    expectedContextTokens: prediction.expectedContextTokens,
    expectedFiveHourBurnRatio: prediction.expectedFiveHourBurnRatio,
    expectedApiCostUsd: prediction.expectedApiCostUsd,
    confidence: prediction.confidence,
  };
}

export interface BuildCalibrationInput {
  jobId: string;
  nodeId: string;
  taskId: string;
  attemptId: string;
  decisionId: string | null;
  prediction: PredictedForCalibration;
  observation: AdaptiveObservation;
  createdAt: string;
}

/** Signed relative error, or null when either side is unknown. */
function relativeError(predicted: number | null, observed: number | null): number | null {
  if (predicted === null || observed === null) return null;
  if (!Number.isFinite(predicted) || !Number.isFinite(observed)) return null;
  const denominator = Math.max(Math.abs(observed), 1e-9);
  return (predicted - observed) / denominator;
}

/**
 * Brier score for the success forecast: `(p - outcome)^2`, in [0,1], lower
 * is better.
 *
 * Resolvable only for observations that actually answered the intelligence
 * question. An interrupted attempt, an inconclusive verdict, an
 * infrastructure crash, and a completion with no verification evidence all
 * return null — scoring a success forecast against an outcome that was never
 * determined would manufacture accuracy data out of missing data.
 */
export function successBrierScore(
  predicted: number | null,
  label: AdaptiveObservation['label'],
): number | null {
  if (predicted === null) return null;
  if (label !== 'VERIFIED_SUCCESS' && label !== 'IMPLEMENTATION_FAILURE') return null;
  const outcome = label === 'VERIFIED_SUCCESS' ? 1 : 0;
  const error = predicted - outcome;
  return Math.min(1, Math.max(0, error * error));
}

/** Build one calibration record. Pure and deterministic. */
export function buildCalibrationRecord(input: BuildCalibrationInput): AdaptiveCalibrationRecord {
  const { prediction, observation } = input;
  const observedVerified =
    observation.label === 'VERIFIED_SUCCESS'
      ? true
      : observation.label === 'IMPLEMENTATION_FAILURE'
        ? false
        : null;
  return {
    schemaVersion: ADAPTIVE_CALIBRATION_SCHEMA_VERSION,
    jobId: input.jobId,
    nodeId: input.nodeId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    decisionId: input.decisionId,
    candidateId: prediction.candidateId,
    predictedSuccessProbability: prediction.verifiedSuccessProbability,
    predictedWallTimeMs: prediction.expectedWallTimeMs,
    predictedInputTokens: prediction.expectedInputTokens,
    predictedContextTokens: prediction.expectedContextTokens,
    predictedFiveHourBurnRatio: prediction.expectedFiveHourBurnRatio,
    predictedApiCostUsd: prediction.expectedApiCostUsd,
    predictedConfidence: prediction.confidence,
    observedOutcome: observation.label,
    observedVerified,
    observedWallTimeMs: observation.wallTimeMs,
    observedInputTokens: observation.inputTokens,
    observedContextTokens: observation.contextTokens,
    observedFiveHourBurnRatio: observation.fiveHourBurnRatio,
    observedApiCostUsd: observation.costUsd,
    wallTimeError: relativeError(prediction.expectedWallTimeMs, observation.wallTimeMs),
    inputTokenError: relativeError(prediction.expectedInputTokens, observation.inputTokens),
    contextTokenError: relativeError(prediction.expectedContextTokens, observation.contextTokens),
    costError: relativeError(prediction.expectedApiCostUsd, observation.costUsd),
    successBrierScore: successBrierScore(prediction.verifiedSuccessProbability, observation.label),
    createdAt: input.createdAt,
  };
}

export interface CalibrationSummary {
  records: number;
  /** Records whose success forecast was resolvable. */
  scoredRecords: number;
  /** Mean Brier score; null when nothing was resolvable. Lower is better. */
  meanBrierScore: number | null;
  /** Mean absolute relative wall-time error; null when never comparable. */
  meanAbsoluteWallTimeError: number | null;
  meanAbsoluteContextTokenError: number | null;
  meanAbsoluteCostError: number | null;
}

/** Summarize recent calibration. Missing data reduces counts, never scores. */
export function summarizeCalibration(
  records: readonly AdaptiveCalibrationRecord[],
): CalibrationSummary {
  const brier = records
    .map((record) => record.successBrierScore)
    .filter((value): value is number => value !== null);
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  const absolute = (pick: (record: AdaptiveCalibrationRecord) => number | null): number[] =>
    records
      .map(pick)
      .filter((value): value is number => value !== null)
      .map((value) => Math.abs(value));
  return {
    records: records.length,
    scoredRecords: brier.length,
    meanBrierScore: mean(brier),
    meanAbsoluteWallTimeError: mean(absolute((record) => record.wallTimeError)),
    meanAbsoluteContextTokenError: mean(absolute((record) => record.contextTokenError)),
    meanAbsoluteCostError: mean(absolute((record) => record.costError)),
  };
}
