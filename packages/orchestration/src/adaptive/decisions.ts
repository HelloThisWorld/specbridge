import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { ADAPTIVE_SCHEDULER_MODES, assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import { jobDir } from '../jobs/store.js';
import {
  ADAPTIVE_DRIFT_SIGNALS,
  ADAPTIVE_FALLBACK_REASONS,
  ADAPTIVE_VETO_CODES,
  PREDICTION_CONFIDENCE_LEVELS,
  PROFILE_FALLBACK_LEVELS,
  RUNTIME_IDENTITY_MATCHES,
} from './vocabulary.js';

/**
 * AdaptiveSchedulingDecision records (vNext.8): every adaptive evaluation as
 * a structured, persisted explanation — `jobs/<jobId>/adaptive/decisions.jsonl`,
 * append-only within a bounded window.
 *
 * Written in SHADOW mode as well as ADAPTIVE, because a mode whose entire
 * purpose is producing evidence would be useless without a record. Not
 * written in HEURISTIC mode at all: nothing is computed there.
 *
 * Observability and audit, never runtime policy. Nothing reads a decision
 * back to make the next one — profiles come from the ExecutionLedger, and if
 * a decision record could feed the next decision, the scheduler would be
 * learning from its own predictions.
 *
 * Structurally incapable of holding model reasoning: every field below is a
 * closed enum, a number, an identifier, or a bounded string SpecBridge
 * itself composed from those. There is nowhere to put a chain of thought,
 * which is the point.
 */

export const ADAPTIVE_DECISION_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().min(1).max(200);

const candidateShape = z
  .object({
    candidateId: shortText,
    lane: shortText,
    executionMode: shortText.nullable().default(null),
    runner: shortText.nullable().default(null),
    model: shortText.nullable().default(null),
    profile: shortText.nullable().default(null),
    contextStrategy: shortText,
    computeLocality: shortText,
    heuristicChoice: z.boolean().default(false),
  })
  .passthrough();

const predictionShape = z
  .object({
    candidateId: shortText,
    level: z.enum(PROFILE_FALLBACK_LEVELS),
    profileKey: z.string().max(400).nullable().default(null),
    confidence: z.enum(PREDICTION_CONFIDENCE_LEVELS),
    confidenceScore: z.number().min(0).max(1),
    identityMatch: z.enum(RUNTIME_IDENTITY_MATCHES),
    driftDetected: z.boolean().default(false),
    driftSignals: z.array(z.enum(ADAPTIVE_DRIFT_SIGNALS)).max(16).default([]),
    /** Smoothed probability of VERIFIED completion for one attempt. */
    verifiedSuccessProbability: z.number().min(0).max(1),
    priorSuccessProbability: z.number().min(0).max(1),
    observedSuccessRate: z.number().min(0).max(1).nullable().default(null),
    firstAttemptSuccessRate: z.number().min(0).max(1).nullable().default(null),
    availabilityProbability: z.number().min(0).max(1).nullable().default(null),
    expectedAttempts: z.number().min(0),
    expectedWallTimeMs: z.number().min(0).nullable().default(null),
    expectedTotalWallTimeMs: z.number().min(0).nullable().default(null),
    expectedInputTokens: z.number().min(0).nullable().default(null),
    expectedContextTokens: z.number().min(0).nullable().default(null),
    expectedFiveHourBurnRatio: z.number().min(0).max(1).nullable().default(null),
    conservativeFiveHourBurnRatio: z.number().min(0).max(1).nullable().default(null),
    /** Null means UNKNOWN cost, never free. */
    expectedApiCostUsd: z.number().min(0).nullable().default(null),
    expectedFailedWallTimeMs: z.number().min(0).nullable().default(null),
    stagnationRate: z.number().min(0).max(1).nullable().default(null),
    oscillationRate: z.number().min(0).max(1).nullable().default(null),
    runawayRate: z.number().min(0).max(1).nullable().default(null),
    contextMissRate: z.number().min(0).max(1).nullable().default(null),
    contextExpansionRate: z.number().min(0).max(1).nullable().default(null),
    safetyEvents: z.number().int().min(0).default(0),
    sampleCount: z.number().int().min(0),
    weightedSampleCount: z.number().min(0),
    lastObservedAt: shortText.nullable().default(null),
    /** Utility score and its itemized components. */
    score: z.number(),
    scoreComponents: z
      .array(
        z
          .object({
            name: shortText,
            raw: z.number().nullable().default(null),
            unit: shortText,
            normalized: z.number(),
            weight: z.number(),
            contribution: z.number(),
            detail: z.string().max(600).default(''),
          })
          .passthrough(),
      )
      .max(32)
      .default([]),
  })
  .passthrough();

export const adaptiveSchedulingDecisionSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    decisionId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    mode: z.enum(ADAPTIVE_SCHEDULER_MODES),
    /** The coarse grouping key this decision was made under. */
    taskSignature: z.string().max(400),
    /** Fine-grained current features: audit only, never the grouping key. */
    signatureFeatures: z.record(z.unknown()).default({}),
    /** The lane hard policy selected before adaptive ranking ran. */
    heuristicLane: shortText,
    heuristicReasonCode: shortText,
    eligibleCandidates: z.array(candidateShape).max(32).default([]),
    rejectedCandidates: z
      .array(
        z
          .object({
            candidateId: shortText,
            lane: shortText,
            executionMode: shortText.nullable().default(null),
            runner: shortText.nullable().default(null),
            code: z.enum(ADAPTIVE_VETO_CODES),
            detail: z.string().max(600).default(''),
          })
          .passthrough(),
      )
      .max(32)
      .default([]),
    predictions: z.array(predictionShape).max(32).default([]),
    /** What the deterministic scheduler chose. */
    heuristicCandidateId: shortText.nullable().default(null),
    /** What ranking preferred, before gating. */
    recommendedCandidateId: shortText.nullable().default(null),
    /** What actually executes. */
    selectedCandidateId: shortText.nullable().default(null),
    adaptiveApplied: z.boolean().default(false),
    /**
     * True when the recommendation differed from the heuristic choice. In
     * SHADOW mode this records a DISAGREEMENT and nothing else: the
     * alternative was not executed, so no outcome is attributed to it and
     * no regret is computed.
     */
    disagreement: z.boolean().default(false),
    wouldApplyInAdaptiveMode: z.boolean().default(false),
    confidence: z.enum(PREDICTION_CONFIDENCE_LEVELS),
    utilityMargin: z.number().nullable().default(null),
    fallbackReason: z.enum(ADAPTIVE_FALLBACK_REASONS).nullable().default(null),
    /** Bounded, human-readable score breakdown. Never model reasoning. */
    explanation: z.array(z.string().max(600)).max(24).default([]),
    /** Profile-store provenance, so a decision is reproducible. */
    profileObservations: z.number().int().min(0).default(0),
    profileBuiltAt: shortText.nullable().default(null),
    createdAt: shortText,
  })
  .passthrough();
export type AdaptiveSchedulingDecisionRecord = z.infer<typeof adaptiveSchedulingDecisionSchema>;

function adaptiveDir(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(jobDir(workspace, jobId), 'adaptive'));
}

function decisionsFile(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(adaptiveDir(workspace, jobId), 'decisions.jsonl'),
  );
}

/** Append one adaptive decision record, pruning to the retention bound. */
export function appendAdaptiveDecision(
  workspace: WorkspaceInfo,
  record: AdaptiveSchedulingDecisionRecord,
  options: { maxRecords: number },
): AdaptiveSchedulingDecisionRecord {
  const validated = adaptiveSchedulingDecisionSchema.parse(record);
  const dir = adaptiveDir(workspace, record.jobId);
  mkdirSync(dir, { recursive: true });
  const file = decisionsFile(workspace, record.jobId);
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

/** Read adaptive decision records, oldest first. Corrupt lines are skipped. */
export function readAdaptiveDecisions(
  workspace: WorkspaceInfo,
  jobId: string,
  options: { limit?: number | undefined; nodeId?: string | undefined } = {},
): AdaptiveSchedulingDecisionRecord[] {
  const file = decisionsFile(workspace, jobId);
  if (!existsSync(file)) return [];
  const records: AdaptiveSchedulingDecisionRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed = adaptiveSchedulingDecisionSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      if (options.nodeId !== undefined && parsed.data.nodeId !== options.nodeId) continue;
      records.push(parsed.data);
    } catch {
      // A corrupt line is skipped, never repaired in place.
    }
  }
  return options.limit !== undefined ? records.slice(-options.limit) : records;
}
