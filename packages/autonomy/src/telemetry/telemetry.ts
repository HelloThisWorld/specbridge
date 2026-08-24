import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import type { JobState } from '@specbridge/orchestration';
import { readJobEvents, readJobState, requiresHumanAttention } from '@specbridge/orchestration';
import type { AutonomyDeps } from '../deps.js';
import { nowIso } from '../deps.js';
import { assertAutonomyId, autonomyPath, readJsonRecord, writeJsonRecord } from '../store.js';
import { readClosureLedger } from '../closure/service.js';
import { closureRatio, summarizeClosure } from '../closure/oracle.js';
import { countSelfCreatedTools, listToolsmithRequests } from '../toolsmith/service.js';
import { listBrowserResults } from '../browser/service.js';
import { listCritiques } from '../critic/critic.js';
import { readSupervisionLog } from '../supervisor/store.js';
import { readSeal, readSealBinding } from '../seal/service.js';

/**
 * Autonomy telemetry.
 *
 * One number is the product metric:
 *
 *   humanInterventionsAfterSeal = 0
 *
 * Everything else in this record exists to make that number believable. A
 * run that reports zero interventions and nothing else could be a run that
 * did nothing; a run that reports zero interventions alongside nine provider
 * failovers, four quota waits, two context rollovers, and eleven
 * self-created tools is a run that earned it.
 *
 * The honesty rule, applied without exception: an unknown measurement is
 * `null`, never 0. A provider that reported no cost has not reported a cost
 * of zero, and a telemetry record that printed "$0.00" would be inventing a
 * fact about money. Counters — things SpecBridge itself observed — are
 * genuine integers, because SpecBridge genuinely counted them.
 */

export const TELEMETRY_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

export const autonomyTelemetrySchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    sealId: shortText.optional(),
    missionId: shortText.optional(),
    recordedAt: shortText,
    /** Job status at the moment this was computed. */
    jobStatus: shortText,

    // --- The product metric ------------------------------------------------
    /**
     * Times a human had to act after the intent was sealed, EXCLUDING
     * intentional authority stops. This is the number vNext.10 exists to
     * drive to zero.
     */
    humanInterventionsAfterSeal: z.number().int().min(0),
    /** Times the runtime correctly stopped for product authority. */
    humanAuthorityEscalations: z.number().int().min(0),
    /**
     * Authority escalations that happened AFTER the seal instant.
     *
     * Separate from the counter above because the boundary is what the
     * vNext.10.1 intake path made precise: an escalation recorded before the
     * intent was sealed belongs to discovery, not to the unattended run.
     * `null` when the seal carries no `sealedAt` and the boundary therefore
     * cannot be placed — which is a different fact from zero.
     */
    humanAuthorityEscalationsAfterSeal: z.number().int().min(0).nullable().default(null),
    /** The instant the zero-touch boundary starts: when the intent was sealed. */
    boundaryStartedAt: shortText.nullable().default(null),

    // --- Autonomy at work --------------------------------------------------
    autonomousRecoveryCount: z.number().int().min(0),
    providerFailovers: z.number().int().min(0),
    providerFailures: z.number().int().min(0),
    quotaWaits: z.number().int().min(0),
    contextRollovers: z.number().int().min(0),
    toolsmithActions: z.number().int().min(0),
    selfCreatedTools: z.number().int().min(0),
    toolchainRepairs: z.number().int().min(0),
    environmentRepairs: z.number().int().min(0),
    controlPlaneRepairs: z.number().int().min(0),
    gapClosureCycles: z.number().int().min(0),
    systemQualificationCycles: z.number().int().min(0),
    browserScenariosRun: z.number().int().min(0),
    uxCritiquesRun: z.number().int().min(0),
    driverRestarts: z.number().int().min(0),
    supervisorWakeups: z.number().int().min(0),

    // --- Measurements. null means UNKNOWN, never zero. ---------------------
    elapsedWallTimeMs: z.number().int().min(0).nullable(),
    reportedTokens: z.number().int().min(0).nullable(),
    reportedCostUsd: z.number().min(0).nullable(),
    contractClosureRatio: z.number().min(0).max(1).nullable(),

    /** Closure detail, so the ratio can be read rather than trusted. */
    closure: z
      .object({
        total: z.number().int().min(0),
        verified: z.number().int().min(0),
        implemented: z.number().int().min(0),
        notStarted: z.number().int().min(0),
        waived: z.number().int().min(0),
      })
      .passthrough()
      .optional(),
    /** Human interventions observed, with what each one was. */
    interventions: z
      .array(z.object({ at: shortText, kind: shortText, detail: text }).passthrough())
      .max(200)
      .default([]),
  })
  .passthrough();
export type AutonomyTelemetry = z.infer<typeof autonomyTelemetrySchema>;

function telemetryFile(workspace: WorkspaceInfo, jobId: string): string {
  assertAutonomyId('job', jobId);
  return autonomyPath(workspace, 'telemetry', `${jobId}.json`);
}

export function readAutonomyTelemetry(
  workspace: WorkspaceInfo,
  jobId: string,
): AutonomyTelemetry | undefined {
  return readJsonRecord(telemetryFile(workspace, jobId), (raw) =>
    autonomyTelemetrySchema.parse(raw),
  );
}

/**
 * Job events that mean a HUMAN had to do something the runtime should have
 * handled.
 *
 * `authority_escalated` is deliberately NOT here: an authority stop is
 * governance working, it is counted separately, and folding the two together
 * would make the primary metric unfalsifiable — every run could claim zero
 * interventions by escalating everything, or claim failure by escalating
 * once correctly.
 */
const INTERVENTION_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  clarification_requested: 'the runtime asked a question it should have resolved itself',
  job_blocked: 'the job stopped in BLOCKED, needing an explicit user action',
  // `blockJob` records `budget_exhausted` rather than `job_blocked` when the
  // blocker is a budget. The vNext.10 dogfood ended exactly there — "all 4
  // execution attempts for this task are spent" — and the metric reported
  // ZERO interventions for a job sitting in BLOCKED. A budget stop still
  // needs a person; only the event name differed.
  budget_exhausted: 'the job stopped on an exhausted budget, needing an explicit user action',
});

export interface ComputeTelemetryInput {
  jobId: string;
  /** Wall time of the unattended session, when it is known. */
  elapsedWallTimeMs?: number | null | undefined;
}

/**
 * Compute the telemetry record from durable state.
 *
 * Derived, not accumulated: every number is recomputed from the job event
 * log, the ledgers, and the records on disk. A counter incremented in memory
 * would be wrong after the first process restart, and process restarts are
 * the normal case here.
 */
export function computeAutonomyTelemetry(
  deps: AutonomyDeps,
  input: ComputeTelemetryInput,
): AutonomyTelemetry {
  const read = readJobState(deps.workspace, input.jobId);
  const job: JobState | undefined = read.kind === 'ok' ? read.job : undefined;
  const events = safeEvents(deps.workspace, input.jobId);
  const counters = job?.autonomyCounters;

  const interventions: AutonomyTelemetry['interventions'] = [];
  let providerFailovers = 0;
  let providerFailures = 0;
  let quotaWaits = 0;
  let contextRollovers = 0;
  let supervisorWakeups = 0;
  let escalationsAfterBoundary = 0;

  // The zero-touch boundary starts when the intent was SEALED. Before
  // vNext.10.1 that instant and the job's own start were effectively the
  // same, because a person sealed by hand and launched immediately. The
  // intake path seals from an approval, so the two can differ, and an
  // intervention recorded before the authorization is not an intervention
  // "after the seal" whatever the metric is called. When the boundary cannot
  // be placed, everything counts — the conservative direction.
  const bindingForBoundary = readSealBinding(deps.workspace, input.jobId);
  const boundary =
    bindingForBoundary !== undefined
      ? readSealedAt(deps, bindingForBoundary.sealId)
      : undefined;
  const boundaryMs = boundary !== undefined ? Date.parse(boundary) : Number.NaN;
  const afterBoundary = (at: string): boolean => {
    if (!Number.isFinite(boundaryMs)) return true;
    const eventMs = Date.parse(at);
    return !Number.isFinite(eventMs) || eventMs >= boundaryMs;
  };

  for (const event of events) {
    const type = String(event['type'] ?? '');
    const at = String(event['at'] ?? '');
    const explanation = INTERVENTION_EVENTS[type];
    if (explanation !== undefined && afterBoundary(at)) {
      interventions.push({ at, kind: type, detail: explanation });
    }
    if (type === 'authority_escalated' && afterBoundary(at)) escalationsAfterBoundary += 1;
    if (type === 'worker_escalated' || type === 'local_harness_to_subscription_escalated') {
      providerFailovers += 1;
    }
    if (type === 'local_model_stopped' || type === 'local_harness_unavailable') providerFailures += 1;
    if (type === 'quota_exhausted' || type === 'task_deferred' || type === 'resource_wait_started') {
      quotaWaits += 1;
    }
    if (type === 'context_rollover' || type === 'fresh_context_selected') contextRollovers += 1;
    if (type === 'driver_restarted' || type === 'supervisor_attached') supervisorWakeups += 1;
  }

  const supervisionLog = readSupervisionLog(deps.workspace, 2_000);
  supervisorWakeups += supervisionLog.filter(
    (entry) => entry.action === 'WOKEN_ON_SCHEDULE' || entry.action === 'WOKEN_ON_RESOURCE_RETURN',
  ).length;

  // Belt and braces on the PRIMARY metric. The event map above is a list of
  // known causes, and a list can be incomplete — as it was. The job's CURRENT
  // status is not a list: if it is sitting in a human-attention status right
  // now, a human is needed right now, whatever event carried it there.
  //
  // NEEDS_AUTHORITY is deliberately excluded, because an authority stop is
  // governance working and is counted separately. Folding it in here would
  // make the metric unfalsifiable in the other direction.
  if (
    job !== undefined &&
    requiresHumanAttention(job.status) &&
    job.status !== 'NEEDS_AUTHORITY' &&
    interventions.length === 0
  ) {
    interventions.push({
      at: job.updatedAt,
      kind: `status:${job.status}`,
      detail:
        job.blocker?.message ??
        `the job is ${job.status} and cannot proceed without a person`,
    });
  }

  const ledger = readClosureLedger(deps.workspace, input.jobId);
  const totals = ledger !== undefined ? summarizeClosure(ledger.entries) : undefined;
  const toolsmith = listToolsmithRequests(deps.workspace, input.jobId);
  const browserResults = listBrowserResults(deps.workspace).filter(
    (result) => result.jobId === input.jobId,
  );
  const critiques = listCritiques(deps.workspace).filter(
    (critique) => critique.jobId === input.jobId,
  );
  const binding = readSealBinding(deps.workspace, input.jobId);

  const telemetry = autonomyTelemetrySchema.parse({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    jobId: input.jobId,
    ...(binding !== undefined ? { sealId: binding.sealId, missionId: binding.missionId } : {}),
    recordedAt: nowIso(deps),
    jobStatus: job?.status ?? 'UNKNOWN',

    humanInterventionsAfterSeal: interventions.length,
    humanAuthorityEscalations: counters?.authorityEscalations ?? 0,
    humanAuthorityEscalationsAfterSeal: boundary === undefined ? null : escalationsAfterBoundary,
    boundaryStartedAt: boundary ?? null,

    autonomousRecoveryCount: counters?.autonomousRecoveries ?? 0,
    providerFailovers,
    providerFailures,
    quotaWaits: Math.max(quotaWaits, counters?.resourceWaits ?? 0),
    contextRollovers: Math.max(contextRollovers, counters?.contextRollovers ?? 0),
    toolsmithActions: toolsmith.length,
    selfCreatedTools: countSelfCreatedTools(deps.workspace, input.jobId),
    toolchainRepairs: counters?.toolchainRepairs ?? 0,
    environmentRepairs: counters?.environmentRepairs ?? 0,
    controlPlaneRepairs: counters?.controlPlaneRepairs ?? 0,
    gapClosureCycles: ledger?.gapCycles ?? counters?.gapClosureCycles ?? 0,
    systemQualificationCycles: ledger?.systemCycles ?? counters?.systemQualificationCycles ?? 0,
    browserScenariosRun: browserResults.length,
    uxCritiquesRun: critiques.length,
    driverRestarts: counters?.driverRestarts ?? 0,
    supervisorWakeups,

    elapsedWallTimeMs: input.elapsedWallTimeMs ?? elapsedFromJob(job),
    // Provider-reported only. `null` when nothing reported, which is a
    // different fact from "it was free".
    reportedTokens: job?.counters.reportedTokens ?? null,
    reportedCostUsd: job?.counters.reportedCostUsd ?? null,
    contractClosureRatio: totals !== undefined ? closureRatio(totals) : null,
    ...(totals !== undefined
      ? {
          closure: {
            total: totals.total,
            verified: totals.verified,
            implemented: totals.implemented,
            notStarted: totals.notStarted,
            waived: totals.waived,
          },
        }
      : {}),
    interventions: interventions.slice(0, 200),
  });

  writeJsonRecord(telemetryFile(deps.workspace, input.jobId), telemetry);
  return telemetry;
}

function elapsedFromJob(job: JobState | undefined): number | null {
  if (job === undefined) return null;
  const created = Date.parse(job.createdAt);
  const updated = Date.parse(job.finalizedAt ?? job.updatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return null;
  return Math.max(0, updated - created);
}

/**
 * The instant the bound seal was authorized.
 *
 * `undefined` when there is no binding, no seal, or no `sealedAt` — each of
 * which means the boundary cannot be placed, and the caller then counts
 * everything rather than guessing.
 */
function readSealedAt(deps: AutonomyDeps, sealId: string): string | undefined {
  try {
    return readSeal(deps.workspace, sealId)?.sealedAt;
  } catch {
    return undefined;
  }
}

function safeEvents(workspace: WorkspaceInfo, jobId: string): Record<string, unknown>[] {
  try {
    return readJobEvents(workspace, jobId, { limit: 10_000 }).events as Record<string, unknown>[];
  } catch {
    // A job with no event log yet (or an unreadable one) yields no derived
    // counts rather than failing the report that exists to explain the run.
    return [];
  }
}

/**
 * Render a measurement for humans.
 *
 * Exported so every surface renders `null` the same way. "n/a" is the only
 * honest rendering of an unknown, and a formatter that printed 0 would
 * quietly turn every unreported cost into a claim of free.
 */
export function formatMeasurement(value: number | null, unit: 'ms' | 'tokens' | 'usd' | 'ratio'): string {
  if (value === null) return 'n/a';
  switch (unit) {
    case 'ms':
      return value >= 3_600_000
        ? `${(value / 3_600_000).toFixed(1)}h`
        : value >= 60_000
          ? `${Math.round(value / 60_000)}m`
          : `${Math.round(value / 1_000)}s`;
    case 'tokens':
      return value.toLocaleString('en-US');
    case 'usd':
      return `$${value.toFixed(4)}`;
    case 'ratio':
      return `${Math.round(value * 100)}%`;
    default:
      return String(value);
  }
}
