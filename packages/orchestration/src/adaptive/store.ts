import { existsSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import { jobDir } from '../jobs/store.js';
import type { AdaptiveProfileSet, ExecutionPerformanceProfile } from './profiles.js';
import { profileIndexKey } from './profiles.js';
import { ADAPTIVE_DRIFT_SIGNALS, PROFILE_FALLBACK_LEVELS } from './vocabulary.js';

/**
 * Derived adaptive state (vNext.8): the profile cache and the calibration
 * log.
 *
 * Both are DISPOSABLE. The profile cache lives under `.specbridge/cache/`
 * beside the repository index, for the same reason and with the same
 * guarantee: deleting it costs a rebuild and nothing else. No Job, task,
 * attempt, evaluation, or recovery record depends on any byte in this file.
 *
 * Every failure mode of the cache collapses to one answer — REBUILD:
 *
 *   absent          nothing has been aggregated yet
 *   schema mismatch a version this build does not understand
 *   unparseable     truncated or corrupted on disk
 *   stale           the ledger has advanced past the cached fingerprint
 *
 * A caller that could distinguish "corrupt" from "missing" would eventually
 * be tempted to use the corrupt one, so the reader refuses to offer the
 * distinction. Rebuild is cheap, bounded, and deterministic; a job never
 * blocks on it, and while it happens the scheduler falls back to the
 * heuristics that governed every phase before this one.
 */

export const ADAPTIVE_PROFILE_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().min(1).max(200);

const metricSummarySchema = z
  .object({
    observations: z.number().int().min(0),
    p50: z.number().nullable().default(null),
    p90: z.number().nullable().default(null),
  })
  .passthrough();

const profileSchema = z
  .object({
    level: z.enum(PROFILE_FALLBACK_LEVELS),
    profileKey: z.string().min(1).max(400),
    signaturePart: z.string().max(400),
    targetPart: z.string().max(400),
    lane: shortText.nullable().default(null),
    executionMode: shortText.nullable().default(null),
    runner: shortText.nullable().default(null),
    samples: z.number().int().min(0),
    weightedSamples: z.number().min(0),
    verifiedSuccesses: z.number().int().min(0),
    unverifiedSuccesses: z.number().int().min(0),
    implementationFailures: z.number().int().min(0),
    infrastructureFailures: z.number().int().min(0),
    inconclusive: z.number().int().min(0),
    censored: z.number().int().min(0),
    weightedVerifiedSuccesses: z.number().min(0),
    weightedIntelligenceAttempts: z.number().min(0),
    firstAttempts: z.number().int().min(0),
    firstAttemptSuccesses: z.number().int().min(0),
    wallTimeMs: metricSummarySchema,
    inputTokens: metricSummarySchema,
    contextTokens: metricSummarySchema,
    fiveHourBurnRatio: metricSummarySchema,
    apiCostUsd: metricSummarySchema,
    attemptsPerSuccess: z.number().min(0).nullable().default(null),
    stagnationRate: z.number().min(0).max(1).nullable().default(null),
    oscillationRate: z.number().min(0).max(1).nullable().default(null),
    runawayRate: z.number().min(0).max(1).nullable().default(null),
    contextExpansionRate: z.number().min(0).max(1).nullable().default(null),
    contextMissRate: z.number().min(0).max(1).nullable().default(null),
    infrastructureFailureRate: z.number().min(0).max(1).nullable().default(null),
    failedWallTimeMs: z.number().min(0),
    failedTokens: z.number().min(0).nullable().default(null),
    failedCostUsd: z.number().min(0).nullable().default(null),
    failedFiveHourBurnRatio: z.number().min(0).nullable().default(null),
    failureSources: z.record(z.number().int().min(0)).default({}),
    runtimeIdentities: z.array(z.string().max(300)).max(50).default([]),
    latestRuntimeIdentity: z.string().max(300).nullable().default(null),
    safetyEvents: z.number().int().min(0).default(0),
    firstObservedAt: shortText.nullable().default(null),
    lastObservedAt: shortText.nullable().default(null),
    drift: z
      .object({
        detected: z.boolean().default(false),
        signals: z.array(z.enum(ADAPTIVE_DRIFT_SIGNALS)).max(16).default([]),
        detail: z.string().max(1_000).default(''),
      })
      .passthrough(),
  })
  .passthrough();

export const adaptiveProfileCacheSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /**
     * Fingerprint of the canonical history the cache was built from. A
     * mismatch means the ledger advanced and the cache is stale; it never
     * means the ledger is wrong.
     */
    sourceFingerprint: z.string().min(1).max(200),
    observationCount: z.number().int().min(0).default(0),
    droppedByAge: z.number().int().min(0).default(0),
    builtAt: shortText,
    profiles: z.array(profileSchema).max(20_000).default([]),
  })
  .passthrough();
export type AdaptiveProfileCache = z.infer<typeof adaptiveProfileCacheSchema>;

export function adaptiveCacheDir(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(workspace.sidecarDir, 'cache'));
}

export function adaptiveProfileFile(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(adaptiveCacheDir(workspace), 'adaptive-profiles.json'),
  );
}

/**
 * Read the cached profiles, or undefined when they are absent, unreadable,
 * schema-invalid, or built from a different history fingerprint.
 *
 * A version mismatch triggers a rebuild rather than a migration. These are
 * derived numbers: recomputing them is always correct and always cheaper
 * than writing code to translate one generation of a cache into the next.
 */
export function readAdaptiveProfileCache(
  workspace: WorkspaceInfo,
  expectedFingerprint?: string | undefined,
): AdaptiveProfileCache | undefined {
  const file = adaptiveProfileFile(workspace);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = adaptiveProfileCacheSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) return undefined;
    if (parsed.data.schemaVersion !== ADAPTIVE_PROFILE_SCHEMA_VERSION) return undefined;
    if (expectedFingerprint !== undefined && parsed.data.sourceFingerprint !== expectedFingerprint) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

export function writeAdaptiveProfileCache(
  workspace: WorkspaceInfo,
  cache: AdaptiveProfileCache,
): void {
  const validated = adaptiveProfileCacheSchema.parse(cache);
  const file = adaptiveProfileFile(workspace);
  mkdirSync(path.dirname(file), { recursive: true });
  // Machine state, potentially thousands of entries: no indentation.
  writeFileAtomic(file, `${JSON.stringify(validated)}\n`);
}

/** Delete the derived profile cache. Always safe: no Job state depends on it. */
export function clearAdaptiveProfileCache(workspace: WorkspaceInfo): void {
  const file = adaptiveProfileFile(workspace);
  if (existsSync(file)) rmSync(file, { force: true });
}

/** Serialize an in-memory profile set for caching. */
export function toProfileCache(
  set: AdaptiveProfileSet,
  sourceFingerprint: string,
): AdaptiveProfileCache {
  return adaptiveProfileCacheSchema.parse({
    schemaVersion: ADAPTIVE_PROFILE_SCHEMA_VERSION,
    sourceFingerprint,
    observationCount: set.observationCount,
    droppedByAge: set.droppedByAge,
    builtAt: set.builtAt,
    profiles: [...set.profiles.values()],
  });
}

/** Rehydrate a cached profile set. */
export function fromProfileCache(cache: AdaptiveProfileCache): AdaptiveProfileSet {
  const profiles = new Map<string, ExecutionPerformanceProfile>();
  for (const entry of cache.profiles) {
    const profile = entry as unknown as ExecutionPerformanceProfile;
    profiles.set(profileIndexKey(profile.level, profile.profileKey), profile);
  }
  return {
    profiles,
    observationCount: cache.observationCount,
    droppedByAge: cache.droppedByAge,
    builtAt: cache.builtAt,
  };
}

// ---------------------------------------------------------------------------
// Prediction calibration
// ---------------------------------------------------------------------------

/**
 * One predicted-versus-observed comparison.
 *
 * Written AFTER an attempt finishes, against the prediction that was
 * recorded before it started. Derived metadata in both directions: a
 * calibration record never edits the attempt, the evaluation, or the ledger.
 * When the prediction was wrong, the prediction was wrong — the observation
 * stands exactly as it was measured.
 *
 * Predictions are also never fed back as evidence. This log answers "how
 * well is the scheduler forecasting?", and nothing reads it to make a
 * placement decision.
 */
export const adaptiveCalibrationRecordSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    attemptId: shortText,
    decisionId: shortText.nullable().default(null),
    candidateId: shortText,
    /** What was predicted before dispatch. */
    predictedSuccessProbability: z.number().min(0).max(1).nullable().default(null),
    predictedWallTimeMs: z.number().min(0).nullable().default(null),
    predictedInputTokens: z.number().min(0).nullable().default(null),
    predictedContextTokens: z.number().min(0).nullable().default(null),
    predictedFiveHourBurnRatio: z.number().min(0).max(1).nullable().default(null),
    predictedApiCostUsd: z.number().min(0).nullable().default(null),
    predictedConfidence: shortText,
    /** What was observed. Null stays null; nothing is back-filled. */
    observedOutcome: shortText,
    observedVerified: z.boolean().nullable().default(null),
    observedWallTimeMs: z.number().min(0).nullable().default(null),
    observedInputTokens: z.number().min(0).nullable().default(null),
    observedContextTokens: z.number().min(0).nullable().default(null),
    observedFiveHourBurnRatio: z.number().min(0).nullable().default(null),
    observedApiCostUsd: z.number().min(0).nullable().default(null),
    /** Signed relative errors, when both sides are known. */
    wallTimeError: z.number().nullable().default(null),
    inputTokenError: z.number().nullable().default(null),
    contextTokenError: z.number().nullable().default(null),
    costError: z.number().nullable().default(null),
    /** Brier-style squared error of the success forecast, when resolvable. */
    successBrierScore: z.number().min(0).max(1).nullable().default(null),
    createdAt: shortText,
  })
  .passthrough();
export type AdaptiveCalibrationRecord = z.infer<typeof adaptiveCalibrationRecordSchema>;

export const ADAPTIVE_CALIBRATION_SCHEMA_VERSION = '1.0.0';

function adaptiveJobDir(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(jobDir(workspace, jobId), 'adaptive'));
}

function calibrationFile(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(adaptiveJobDir(workspace, jobId), 'calibration.jsonl'),
  );
}

export function appendAdaptiveCalibration(
  workspace: WorkspaceInfo,
  record: AdaptiveCalibrationRecord,
  options: { maxRecords: number },
): AdaptiveCalibrationRecord {
  const validated = adaptiveCalibrationRecordSchema.parse(record);
  const dir = adaptiveJobDir(workspace, record.jobId);
  mkdirSync(dir, { recursive: true });
  const file = calibrationFile(workspace, record.jobId);
  const line = `${JSON.stringify(validated)}\n`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = existing.split('\n').filter((entry) => entry.length > 0);
  if (lines.length + 1 > options.maxRecords) {
    const retained = [...lines, line.trimEnd()].slice(-options.maxRecords);
    writeFileAtomic(file, `${retained.join('\n')}\n`);
  } else {
    appendFileSync(file, line, 'utf8');
  }
  return validated;
}

export function readAdaptiveCalibration(
  workspace: WorkspaceInfo,
  jobId: string,
  options: { limit?: number | undefined } = {},
): AdaptiveCalibrationRecord[] {
  const file = calibrationFile(workspace, jobId);
  if (!existsSync(file)) return [];
  const records: AdaptiveCalibrationRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed = adaptiveCalibrationRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // A corrupt line is skipped, never repaired in place.
    }
  }
  return options.limit !== undefined ? records.slice(-options.limit) : records;
}
