import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import { jobDir } from '../jobs/store.js';
import { quotaForecastSchema } from '../quota/state.js';
import {
  COMPUTE_LOCALITIES,
  LANE_DECISIONS,
  LOCAL_EXECUTION_MODES,
  LOCAL_EXECUTION_MODE_REASONS,
  LOCAL_EXECUTION_SHAPES,
  SCHEDULER_MODES,
  SCHEDULING_REASON_CODES,
} from './vocabulary.js';

/**
 * SchedulingDecision records (vNext.2): every routing/admission decision as
 * a structured, persisted explanation — `jobs/<jobId>/scheduling/
 * decisions.jsonl`, append-only within a bounded window (the newest
 * `maxDecisionRecords` are retained; debugging scheduler behavior weeks
 * later must not require unbounded growth).
 *
 * Records are observability and audit, never runtime policy: nothing reads
 * a decision back to decide the next one. Prose logs summarize; these
 * records carry the actual quota snapshot, estimate, reserve, and context
 * status the decision saw.
 */

export const SCHEDULING_DECISION_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().min(1).max(200);

export const schedulingDecisionSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    decisionId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    selectedLane: z.enum(LANE_DECISIONS),
    /** Worker/provider identity for run lanes; null for DEFER. */
    selectedProvider: shortText.nullable(),
    schedulerMode: z.enum(SCHEDULER_MODES),
    reasonCode: z.enum(SCHEDULING_REASON_CODES),
    /** The forecast the decision was made against. */
    quotaSnapshot: quotaForecastSchema,
    /** Bounded copy of the workload estimate. */
    workloadEstimate: z
      .object({
        complexity: shortText,
        localSuitability: shortText,
        taskCategory: shortText.nullable().default(null),
        expectedWallTimeMs: z.number().int().min(0),
        expectedFiveHourBurnRatio: z.number().min(0).max(1),
        expectedWeeklyBurnRatio: z.number().min(0).max(1),
        confidence: shortText,
        basis: shortText,
      })
      .passthrough()
      .nullable(),
    /** The dynamic reserve ratio in force. */
    reserveRatio: z.number().min(0).max(1).nullable(),
    /** Expected five-hour burn before the coming reset, when computed. */
    preResetBurnRatio: z.number().min(0).max(1).nullable().default(null),
    /** True when the admitted task is expected to cross the reset. */
    crossesReset: z.boolean().default(false),
    contextStatus: z
      .object({
        usageRatio: z.number().min(0).nullable(),
        compactFirst: z.boolean(),
      })
      .passthrough()
      .nullable(),
    /**
     * vNext.4 LOCAL execution-mode attribution. Null for every decision that
     * did not select the LOCAL lane, and absent in records written before
     * vNext.4 (additive by construction).
     *
     * Every field is ORTHOGONAL on purpose: the lane above says LOCAL, this
     * says how the lane was spent, which runner ran it, which model it used,
     * and how that runner's compute locality was verified. Nothing here is
     * ever encoded as a compound value like "LOCAL_DSH" — that would make
     * "was this local?" and "did this use a harness?" unanswerable
     * separately, which is exactly the confusion this phase removes.
     */
    localExecution: z
      .object({
        mode: z.enum(LOCAL_EXECUTION_MODES),
        reasonCode: z.enum(LOCAL_EXECUTION_MODE_REASONS),
        shape: z.enum(LOCAL_EXECUTION_SHAPES),
        /** Runner identity for the mode (e.g. "local-llamacpp", "deepseek-harness"). */
        runner: shortText.nullable().default(null),
        /** Model identity when known; null when the provider does not say. */
        model: shortText.nullable().default(null),
        /** Verified compute locality of the selected runner. */
        computeLocality: z.enum(COMPUTE_LOCALITIES).default('UNKNOWN'),
        /** Grounds for the locality verdict (bounded, recorded verbatim). */
        localityEvidence: z.string().max(500).nullable().default(null),
        /** Status of the LOCAL harness binding when the decision was made. */
        harnessBindingStatus: shortText.nullable().default(null),
        detail: z.string().max(1_000).default(''),
      })
      .passthrough()
      .nullable()
      .default(null),
    /** For DEFER: when capacity is expected to return, when known. */
    deferUntil: shortText.nullable().default(null),
    detail: z.string().max(2_000),
    createdAt: shortText,
  })
  .passthrough();
export type SchedulingDecisionRecord = z.infer<typeof schedulingDecisionSchema>;

function schedulingDir(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(jobDir(workspace, jobId), 'scheduling'));
}

function decisionsFile(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(schedulingDir(workspace, jobId), 'decisions.jsonl'),
  );
}

/** Append one decision record, pruning to the retention bound. */
export function appendSchedulingDecision(
  workspace: WorkspaceInfo,
  record: SchedulingDecisionRecord,
  options: { maxRecords: number },
): SchedulingDecisionRecord {
  const validated = schedulingDecisionSchema.parse(record);
  const dir = schedulingDir(workspace, record.jobId);
  mkdirSync(dir, { recursive: true });
  const file = decisionsFile(workspace, record.jobId);
  const line = `${JSON.stringify(validated)}\n`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = existing.split('\n').filter((entry) => entry.length > 0);
  if (lines.length + 1 > options.maxRecords) {
    // Rewrite atomically with the newest records only. Decision records are
    // observability, not evidence; bounded retention is the documented deal.
    const retained = [...lines, line.trimEnd()].slice(-options.maxRecords);
    writeFileAtomic(file, `${retained.join('\n')}\n`);
  } else {
    appendFileSync(file, line, 'utf8');
  }
  return validated;
}

/** Read decision records, oldest first. Unparseable lines are skipped. */
export function readSchedulingDecisions(
  workspace: WorkspaceInfo,
  jobId: string,
  options: { limit?: number | undefined } = {},
): SchedulingDecisionRecord[] {
  const file = decisionsFile(workspace, jobId);
  if (!existsSync(file)) return [];
  const records: SchedulingDecisionRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed = schedulingDecisionSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // A corrupt line is skipped, never repaired in place.
    }
  }
  return options.limit !== undefined ? records.slice(-options.limit) : records;
}
