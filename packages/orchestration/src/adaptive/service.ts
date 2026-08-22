import { createHash } from 'node:crypto';
import type { AdaptiveSchedulerPolicy, WorkspaceInfo } from '@specbridge/core';
import type { ContextEfficiencyMetrics } from '@specbridge/context';
import { listJobs } from '../jobs/store.js';
import { readExecutionLedger } from '../survival/service.js';
import { listContextMetricEntries } from '../context/store.js';
import type { ExecutionLedgerEntry } from '../survival/state.js';
import type { AdaptiveObservation } from './outcomes.js';
import { deriveAdaptiveObservations } from './outcomes.js';
import type { AdaptiveProfileSet } from './profiles.js';
import { aggregateProfiles } from './profiles.js';
import type { AdaptiveCalibrationRecord } from './store.js';
import {
  appendAdaptiveCalibration,
  clearAdaptiveProfileCache,
  fromProfileCache,
  readAdaptiveProfileCache,
  toProfileCache,
  writeAdaptiveProfileCache,
} from './store.js';
import { readAdaptiveDecisions } from './decisions.js';
import { buildCalibrationRecord } from './calibration.js';

/**
 * Adaptive profile service (vNext.8): assemble observed history, aggregate
 * it, and cache the result.
 *
 * Scope is WORKSPACE-LOCAL, deliberately and permanently for this phase.
 * Performance is partly a property of the codebase — a small, well-tested
 * repository flatters a weak model in ways a large one does not — so the
 * history that matters most is the history of THIS workspace. It is also the
 * only scope with no privacy question to answer: nothing crosses a
 * repository boundary because nothing ever leaves one. A global aggregation
 * would have to prove it carried no file names, task text, or project
 * identifiers, and the simplest proof is not to build it.
 *
 * Work is bounded on every path. Rebuilds read a capped number of the most
 * recent observations, the cache is keyed by a fingerprint of the canonical
 * history so an unchanged ledger is never re-aggregated, and a cache that is
 * missing, stale, corrupt, or written by another schema version is simply
 * rebuilt. A job never waits on any of this: if it cannot be done, the
 * scheduler uses the heuristics that governed every phase before vNext.8.
 */

export interface LoadAdaptiveProfilesInput {
  workspace: WorkspaceInfo;
  policy: AdaptiveSchedulerPolicy;
  now: Date;
  /** Force a full rebuild even when a valid cache exists. */
  forceRebuild?: boolean | undefined;
  /** Persist the rebuilt cache. Diagnostics may read without writing. */
  persist?: boolean | undefined;
}

export interface LoadedAdaptiveProfiles {
  profiles: AdaptiveProfileSet;
  observations: AdaptiveObservation[];
  /** How the profiles were obtained, for diagnostics and events. */
  source: 'cache' | 'rebuilt';
  /** Set when a cache existed but could not be used. */
  invalidatedReason: 'absent' | 'stale' | 'unreadable' | 'forced' | null;
  fingerprint: string;
  jobsScanned: number;
}

/**
 * Fingerprint of the canonical history the profiles derive from.
 *
 * Built from identity plus terminal state of every EXECUTOR attempt: the
 * attempt id, its status, and its completion timestamp. That is exactly the
 * set of facts that can change what an aggregation produces — a new attempt,
 * an attempt reaching a final status, or an interrupted attempt being
 * reconciled — and nothing else. Hashing whole records instead would
 * invalidate the cache every time an unrelated metric was back-filled.
 */
export function historyFingerprint(entries: readonly ExecutionLedgerEntry[]): string {
  const hash = createHash('sha256');
  const relevant = entries
    .filter((entry) => entry.role === 'EXECUTOR')
    .map((entry) => `${entry.attemptId}:${entry.status}:${entry.completedAt ?? '-'}`)
    .sort();
  for (const line of relevant) hash.update(line).update('\n');
  return `${relevant.length}-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Read every job's ledger in the workspace and derive adaptive observations.
 *
 * Context metrics are joined per job by attempt id, so a target's context
 * cost can be read beside its success rate. A job with no context metrics
 * simply contributes observations with null context figures — vNext.7 may
 * not have been enabled when they ran, and an absent measurement is not a
 * zero.
 */
export function collectAdaptiveHistory(workspace: WorkspaceInfo): {
  entries: ExecutionLedgerEntry[];
  observations: AdaptiveObservation[];
  jobsScanned: number;
} {
  const { jobs } = listJobs(workspace);
  const entries: ExecutionLedgerEntry[] = [];
  const observations: AdaptiveObservation[] = [];
  for (const job of jobs) {
    let ledger: ExecutionLedgerEntry[];
    try {
      ledger = readExecutionLedger(workspace, job.jobId);
    } catch {
      // One unreadable job never blocks learning from the others.
      continue;
    }
    entries.push(...ledger);
    let metrics = new Map<string, ContextEfficiencyMetrics>();
    try {
      metrics = new Map(
        listContextMetricEntries(workspace, job.jobId).map(
          (entry) => [entry.attemptId, entry.metrics] as const,
        ),
      );
    } catch {
      metrics = new Map();
    }
    observations.push(...deriveAdaptiveObservations({ entries: ledger, contextMetrics: metrics }));
  }
  return { entries, observations, jobsScanned: jobs.length };
}

/**
 * Load the workspace's adaptive profiles, rebuilding when the cache cannot
 * be used. Never throws: every failure degrades to an empty profile set,
 * which the ranking layer reads as cold start and answers with the
 * heuristic.
 */
export function loadAdaptiveProfiles(input: LoadAdaptiveProfilesInput): LoadedAdaptiveProfiles {
  const empty: AdaptiveProfileSet = {
    profiles: new Map(),
    observationCount: 0,
    droppedByAge: 0,
    builtAt: input.now.toISOString(),
  };
  let history: ReturnType<typeof collectAdaptiveHistory>;
  try {
    history = collectAdaptiveHistory(input.workspace);
  } catch {
    return {
      profiles: empty,
      observations: [],
      source: 'rebuilt',
      invalidatedReason: 'unreadable',
      fingerprint: '0-',
      jobsScanned: 0,
    };
  }

  const fingerprint = historyFingerprint(history.entries);
  let invalidatedReason: LoadedAdaptiveProfiles['invalidatedReason'] = null;

  if (input.forceRebuild !== true) {
    const cached = readAdaptiveProfileCache(input.workspace, fingerprint);
    if (cached !== undefined) {
      return {
        profiles: fromProfileCache(cached),
        observations: history.observations,
        source: 'cache',
        invalidatedReason: null,
        fingerprint,
        jobsScanned: history.jobsScanned,
      };
    }
    // The cache was unusable. Distinguish "never built" from "superseded or
    // damaged" for the diagnostic, then rebuild either way.
    const anyCache = readAdaptiveProfileCache(input.workspace);
    invalidatedReason = anyCache === undefined ? 'absent' : 'stale';
  } else {
    invalidatedReason = 'forced';
  }

  let profiles: AdaptiveProfileSet;
  try {
    profiles = aggregateProfiles({
      observations: history.observations,
      policy: input.policy,
      now: input.now,
    });
  } catch {
    return {
      profiles: empty,
      observations: history.observations,
      source: 'rebuilt',
      invalidatedReason: 'unreadable',
      fingerprint,
      jobsScanned: history.jobsScanned,
    };
  }

  if (input.persist !== false) {
    try {
      writeAdaptiveProfileCache(input.workspace, toProfileCache(profiles, fingerprint));
    } catch {
      // A cache that cannot be written costs a rebuild next pass, nothing
      // more. It must never fail the job that happened to trigger it.
    }
  }

  return {
    profiles,
    observations: history.observations,
    source: 'rebuilt',
    invalidatedReason,
    fingerprint,
    jobsScanned: history.jobsScanned,
  };
}

/**
 * Discard and rebuild the derived profile cache.
 *
 * The documented recovery for a corrupt or superseded cache, and the
 * operation the CLI exposes. Deleting first is deliberate: a rebuild that
 * failed halfway must not leave a file that looks valid.
 */
export function rebuildAdaptiveProfiles(input: {
  workspace: WorkspaceInfo;
  policy: AdaptiveSchedulerPolicy;
  now: Date;
}): LoadedAdaptiveProfiles {
  clearAdaptiveProfileCache(input.workspace);
  return loadAdaptiveProfiles({ ...input, forceRebuild: true, persist: true });
}

/**
 * Compare the forecast made before one attempt with what the attempt
 * actually did, and persist the comparison.
 *
 * Calibrates the prediction for the candidate that ACTUALLY RAN — the
 * selected one, which in SHADOW mode is the heuristic incumbent. The
 * recommended-but-not-executed candidate is deliberately never scored: its
 * outcome is unknown, and manufacturing one from a prediction is exactly the
 * counterfactual this phase refuses to invent.
 *
 * Best-effort throughout: nothing here may fail an attempt that has already
 * finished, and a missing decision, missing prediction, or unreadable ledger
 * simply means no calibration record for this attempt.
 */
export function recordCalibrationForAttempt(input: {
  workspace: WorkspaceInfo;
  policy: AdaptiveSchedulerPolicy;
  jobId: string;
  nodeId: string;
  attemptId: string;
  now: Date;
}): AdaptiveCalibrationRecord | undefined {
  if (input.policy.mode === 'HEURISTIC') return undefined;
  try {
    const decisions = readAdaptiveDecisions(input.workspace, input.jobId, {
      nodeId: input.nodeId,
    });
    const decision = decisions[decisions.length - 1];
    if (decision === undefined) return undefined;
    const candidateId = decision.selectedCandidateId;
    if (candidateId === null) return undefined;
    const predicted = decision.predictions.find((entry) => entry.candidateId === candidateId);
    if (predicted === undefined) return undefined;

    const ledger = readExecutionLedger(input.workspace, input.jobId, { nodeId: input.nodeId });
    const entry = ledger.find((candidate) => candidate.attemptId === input.attemptId);
    if (entry === undefined) return undefined;
    let metrics = new Map<string, ContextEfficiencyMetrics>();
    try {
      metrics = new Map(
        listContextMetricEntries(input.workspace, input.jobId).map(
          (record) => [record.attemptId, record.metrics] as const,
        ),
      );
    } catch {
      metrics = new Map();
    }
    const [observation] = deriveAdaptiveObservations({
      entries: [entry],
      contextMetrics: metrics,
    });
    if (observation === undefined) return undefined;

    return appendAdaptiveCalibration(
      input.workspace,
      buildCalibrationRecord({
        jobId: input.jobId,
        nodeId: input.nodeId,
        taskId: entry.taskId,
        attemptId: input.attemptId,
        decisionId: decision.decisionId,
        prediction: {
          candidateId,
          verifiedSuccessProbability: predicted.verifiedSuccessProbability,
          expectedWallTimeMs: predicted.expectedWallTimeMs,
          expectedInputTokens: predicted.expectedInputTokens,
          expectedContextTokens: predicted.expectedContextTokens,
          expectedFiveHourBurnRatio: predicted.expectedFiveHourBurnRatio,
          expectedApiCostUsd: predicted.expectedApiCostUsd,
          confidence: predicted.confidence,
        },
        observation,
        createdAt: input.now.toISOString(),
      }),
      { maxRecords: input.policy.maxCalibrationRecords },
    );
  } catch {
    return undefined;
  }
}
