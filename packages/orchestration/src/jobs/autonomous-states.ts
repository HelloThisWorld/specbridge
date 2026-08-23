import type { WorkspaceInfo } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import type { JobDeps } from './job-service.js';
import { applyJobTransition } from './job-service.js';
import { requireJobState } from './store.js';
import type { AuthorityRequest, JobState, OperationalWait } from './state.js';
import { authorityRequestSchema, operationalWaitSchema } from './state.js';
import type { JobStatus } from './vocabulary.js';
import { isOperationalJobStatus } from './vocabulary.js';

/**
 * The autonomous operational status transitions (vNext.10).
 *
 * Every function here answers the same shape of question: *the runtime hit
 * something that is not the product's fault — where does the job go, and
 * what does it need to remember in order to come back on its own?*
 *
 * Two rules hold across all of them, and they are the difference between an
 * unattended runtime and a runtime that merely logs nicely:
 *
 *   Entering an operational status ALWAYS records why and, where knowable,
 *   when it ends. A status with no recorded reason is a status a supervisor
 *   cannot leave, which is the sticky-BLOCKED failure under a new name.
 *
 *   Leaving one ALWAYS clears the wait. A stale `operationalWait` on a
 *   READY job would make the next audit believe the runtime is still
 *   waiting for a provider that came back an hour ago.
 *
 * `escalateAuthority` is the odd one out and deliberately so: it is the only
 * function in this file that stops for a person, it is the only one that
 * does not schedule its own exit, and it is the one the autonomy telemetry
 * counts as a human intervention.
 */

// ---------------------------------------------------------------------------
// Operational statuses
// ---------------------------------------------------------------------------

export interface OperationalWaitInput {
  /** `ResourceWaitKind` from @specbridge/autonomy. */
  kind: string;
  detail: string;
  /** When the condition is expected to clear, when that is knowable. */
  wakeAt?: string | undefined;
  /** Node the condition is blocking, when it is node-specific. */
  nodeId?: string | undefined;
}

/**
 * Enter WAITING_RESOURCE.
 *
 * `retryAt` is set from `wakeAt` so the EXISTING scheduler wakes the job
 * exactly as it already wakes a WAITING_RETRY job. Reusing that field rather
 * than inventing a parallel one is the point: there is one place a job's
 * "not before" instant lives, so there is one place that can be wrong.
 */
export function enterResourceWait(
  deps: JobDeps,
  jobId: string,
  input: OperationalWaitInput,
): JobState {
  const previous = requireJobState(deps.workspace, jobId);
  const wait = buildWait(deps, previous, input);
  return applyJobTransition(deps, jobId, {
    to: 'WAITING_RESOURCE',
    event: 'resource_wait_started',
    payload: {
      kind: input.kind,
      detail: input.detail.slice(0, 300),
      ...(input.wakeAt !== undefined ? { wakeAt: input.wakeAt } : {}),
      checks: wait.checks,
    },
    patch: {
      operationalWait: wait,
      ...(input.wakeAt !== undefined ? { retryAt: input.wakeAt } : {}),
      autonomyCounters: bump(previous, 'resourceWaits'),
    },
  });
}

/** Enter RECOVERING_PROVIDER: a provider or local runtime is being restored. */
export function enterProviderRecovery(
  deps: JobDeps,
  jobId: string,
  input: OperationalWaitInput,
): JobState {
  const previous = requireJobState(deps.workspace, jobId);
  const wait = buildWait(deps, previous, input);
  return applyJobTransition(deps, jobId, {
    to: 'RECOVERING_PROVIDER',
    event: 'provider_recovery_started',
    payload: { kind: input.kind, detail: input.detail.slice(0, 300), attempt: wait.recoveryAttempts },
    patch: {
      operationalWait: { ...wait, recoveryAttempts: wait.recoveryAttempts + 1 },
      autonomyCounters: bump(previous, 'providerRecoveries'),
    },
  });
}

/** Enter REPAIRING_TOOLCHAIN: an engineering tool is being provisioned. */
export function enterToolchainRepair(
  deps: JobDeps,
  jobId: string,
  input: OperationalWaitInput,
): JobState {
  const previous = requireJobState(deps.workspace, jobId);
  return applyJobTransition(deps, jobId, {
    to: 'REPAIRING_TOOLCHAIN',
    event: 'toolchain_repair_started',
    payload: { kind: input.kind, detail: input.detail.slice(0, 300) },
    patch: {
      operationalWait: buildWait(deps, previous, input),
      autonomyCounters: bump(previous, 'toolchainRepairs'),
    },
  });
}

/** Enter REPAIRING_ENVIRONMENT: a product runtime environment is being fixed. */
export function enterEnvironmentRepair(
  deps: JobDeps,
  jobId: string,
  input: OperationalWaitInput,
): JobState {
  const previous = requireJobState(deps.workspace, jobId);
  return applyJobTransition(deps, jobId, {
    to: 'REPAIRING_ENVIRONMENT',
    event: 'environment_failed',
    payload: { kind: input.kind, detail: input.detail.slice(0, 300) },
    patch: {
      operationalWait: buildWait(deps, previous, input),
      autonomyCounters: bump(previous, 'environmentRepairs'),
    },
  });
}

/** Enter REPAIRING_CONTROL_PLANE: a governed SpecBridge repair is running. */
export function enterControlPlaneRepair(
  deps: JobDeps,
  jobId: string,
  input: OperationalWaitInput & { repairId: string },
): JobState {
  const previous = requireJobState(deps.workspace, jobId);
  return applyJobTransition(deps, jobId, {
    to: 'REPAIRING_CONTROL_PLANE',
    event: 'control_plane_repair_started',
    payload: { repairId: input.repairId, kind: input.kind, detail: input.detail.slice(0, 300) },
    patch: {
      operationalWait: buildWait(deps, previous, input),
      autonomyCounters: bump(previous, 'controlPlaneRepairs'),
    },
  });
}

/**
 * Leave an operational status because the condition cleared.
 *
 * Refuses to run from a non-operational status rather than "helpfully"
 * returning the job unchanged: a caller that thinks a job is recovering when
 * it is RUNNING has a bug worth surfacing, and swallowing it here would hide
 * exactly the class of supervisor defect that produces a silently stalled
 * overnight run.
 */
export function clearOperationalState(
  deps: JobDeps,
  jobId: string,
  input: { resolution: string; to?: JobStatus | undefined },
): JobState {
  const job = requireJobState(deps.workspace, jobId);
  if (!isOperationalJobStatus(job.status)) {
    throw new OrchestrationError(
      'SBO027',
      `Job ${jobId} is ${job.status}, not an operational recovery status; nothing to clear.`,
      { details: { status: job.status } },
    );
  }
  const event = eventForOperationalExit(job.status);
  return applyJobTransition(deps, jobId, {
    to: input.to ?? 'READY',
    event,
    payload: {
      resolution: input.resolution.slice(0, 300),
      ...(job.operationalWait !== undefined ? { kind: job.operationalWait.kind } : {}),
    },
    patch: {
      operationalWait: undefined,
      retryAt: undefined,
      autonomyCounters: bump(job, 'autonomousRecoveries'),
    },
  });
}

function eventForOperationalExit(status: JobStatus) {
  switch (status) {
    case 'RECOVERING_PROVIDER':
      return 'provider_recovery_completed' as const;
    case 'REPAIRING_TOOLCHAIN':
      return 'toolchain_repair_completed' as const;
    case 'REPAIRING_ENVIRONMENT':
      return 'environment_repaired' as const;
    case 'REPAIRING_CONTROL_PLANE':
      return 'control_plane_repair_completed' as const;
    default:
      return 'resource_wait_ended' as const;
  }
}

/** Record another unsuccessful check of the same operational condition. */
export function recordOperationalRecheck(
  deps: JobDeps,
  jobId: string,
  input: { detail?: string | undefined; wakeAt?: string | undefined } = {},
): JobState {
  const job = requireJobState(deps.workspace, jobId);
  if (job.operationalWait === undefined) return job;
  const wait = operationalWaitSchema.parse({
    ...job.operationalWait,
    checks: job.operationalWait.checks + 1,
    ...(input.detail !== undefined ? { detail: input.detail.slice(0, 2_000) } : {}),
    ...(input.wakeAt !== undefined ? { wakeAt: input.wakeAt } : {}),
  });
  return applyJobTransition(deps, jobId, {
    to: job.status,
    event: 'resource_wait_started',
    payload: { kind: wait.kind, checks: wait.checks, recheck: true },
    patch: {
      operationalWait: wait,
      ...(input.wakeAt !== undefined ? { retryAt: input.wakeAt } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Qualification phase
// ---------------------------------------------------------------------------

/** Enter or advance QUALIFYING with the closure phase the oracle chose. */
export function enterQualifying(
  deps: JobDeps,
  jobId: string,
  input: { phase: string; detail?: string | undefined },
): JobState {
  return applyJobTransition(deps, jobId, {
    to: 'QUALIFYING',
    event: 'closure_audit_completed',
    payload: {
      phase: input.phase,
      ...(input.detail !== undefined ? { detail: input.detail.slice(0, 300) } : {}),
    },
    patch: { closurePhase: input.phase, operationalWait: undefined },
  });
}

/** Leave QUALIFYING because the audit generated real implementation work. */
export function returnToImplementation(
  deps: JobDeps,
  jobId: string,
  input: { generatedWork: number; reason: string },
): JobState {
  const job = requireJobState(deps.workspace, jobId);
  return applyJobTransition(deps, jobId, {
    to: 'READY',
    event: 'gap_work_generated',
    payload: { generatedWork: input.generatedWork, reason: input.reason.slice(0, 300) },
    patch: {
      closurePhase: 'GAP_IMPLEMENTATION',
      autonomyCounters: bump(job, 'gapClosureCycles'),
    },
  });
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

export interface AuthorityEscalationInput {
  /** `AutonomousDecisionSurface` from @specbridge/autonomy. */
  surface: string;
  /** `AuthorityReason` from @specbridge/autonomy. */
  reason: string;
  question: string;
  whyItMatters: string;
  nodeId?: string | undefined;
  contractId?: string | undefined;
  options?: readonly string[] | undefined;
  /** Difficulty signals observed. Recorded for audit; never the cause. */
  observedSignals?: readonly string[] | undefined;
}

/**
 * Stop for PRODUCT AUTHORITY.
 *
 * The one operation in this file that costs a human their sleep, so it is
 * the one whose payload is written for a person rather than for a log:
 * the question is a sentence, the rationale explains why it is genuinely
 * theirs, and the options are the ways forward SpecBridge can already see.
 *
 * An existing unresolved request is NOT replaced. A run that escalated once
 * and then discovered a second authority question should surface the first
 * one it hit — overwriting it would mean the human answers the newest
 * question and the run stops again on the older one.
 */
export function escalateAuthority(
  deps: JobDeps,
  jobId: string,
  input: AuthorityEscalationInput,
): JobState {
  const job = requireJobState(deps.workspace, jobId);
  if (job.authorityRequest !== undefined && job.authorityRequest.resolvedAt === undefined) {
    return job.status === 'NEEDS_AUTHORITY'
      ? job
      : applyJobTransition(deps, jobId, {
          to: 'NEEDS_AUTHORITY',
          event: 'authority_escalated',
          payload: { surface: job.authorityRequest.surface, existing: true },
        });
  }
  const request = authorityRequestSchema.parse({
    requestId: `auth-${Date.now().toString(36)}-${job.counters.escalations + 1}`,
    at: new Date(deps.clock !== undefined ? deps.clock().getTime() : Date.now()).toISOString(),
    surface: input.surface,
    reason: input.reason,
    question: input.question.slice(0, 2_000),
    whyItMatters: input.whyItMatters.slice(0, 2_000),
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.contractId !== undefined ? { contractId: input.contractId } : {}),
    options: [...(input.options ?? [])].slice(0, 10),
    observedSignals: [...(input.observedSignals ?? [])].slice(0, 20),
  });
  return applyJobTransition(deps, jobId, {
    to: 'NEEDS_AUTHORITY',
    event: 'authority_escalated',
    payload: { surface: request.surface, reason: request.reason, requestId: request.requestId },
    patch: {
      authorityRequest: request,
      operationalWait: undefined,
      autonomyCounters: bump(job, 'authorityEscalations'),
    },
  });
}

/**
 * Record a human's answer to an authority request and resume.
 *
 * `resolvedBy` is a channel label for audit. It is never evidence that a
 * human acted: the ONLY thing that makes this a human decision is that no
 * agent-reachable surface can call it, which is enforced where the surfaces
 * are defined rather than by a string here.
 */
export function resolveAuthority(
  deps: JobDeps,
  jobId: string,
  input: {
    resolution: 'APPROVED' | 'REJECTED' | 'AMENDED' | 'WITHDRAWN';
    note?: string | undefined;
    resolvedBy?: string | undefined;
    to?: JobStatus | undefined;
  },
): JobState {
  const job = requireJobState(deps.workspace, jobId);
  if (job.authorityRequest === undefined) {
    throw new OrchestrationError('SBO033', `Job ${jobId} has no open authority request.`, {
      remediation: ['Inspect the job with `specbridge orchestrate job <id>`.'],
    });
  }
  const resolved: AuthorityRequest = authorityRequestSchema.parse({
    ...job.authorityRequest,
    resolvedAt: new Date(deps.clock !== undefined ? deps.clock().getTime() : Date.now()).toISOString(),
    resolution: input.resolution,
    ...(input.note !== undefined ? { resolutionNote: input.note.slice(0, 2_000) } : {}),
    ...(input.resolvedBy !== undefined ? { resolvedBy: input.resolvedBy.slice(0, 200) } : {}),
  });
  return applyJobTransition(deps, jobId, {
    to: input.to ?? (input.resolution === 'REJECTED' ? 'REPLANNING' : 'READY'),
    event: 'authority_resolved',
    payload: {
      requestId: resolved.requestId,
      surface: resolved.surface,
      resolution: input.resolution,
    },
    patch: { authorityRequest: resolved },
  });
}

/** The open authority request for a job, or undefined. */
export function readOpenAuthorityRequest(
  workspace: WorkspaceInfo,
  jobId: string,
): AuthorityRequest | undefined {
  const job = requireJobState(workspace, jobId);
  if (job.authorityRequest === undefined) return undefined;
  return job.authorityRequest.resolvedAt === undefined ? job.authorityRequest : undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildWait(deps: JobDeps, job: JobState, input: OperationalWaitInput): OperationalWait {
  const at = new Date(deps.clock !== undefined ? deps.clock().getTime() : Date.now()).toISOString();
  const existing =
    job.operationalWait !== undefined && job.operationalWait.kind === input.kind
      ? job.operationalWait
      : undefined;
  return operationalWaitSchema.parse({
    kind: input.kind,
    detail: input.detail.slice(0, 2_000),
    ...(input.wakeAt !== undefined ? { wakeAt: input.wakeAt } : {}),
    checks: existing?.checks ?? 0,
    startedAt: existing?.startedAt ?? at,
    recoveryAttempts: existing?.recoveryAttempts ?? 0,
  });
}

type AutonomyCounterKey = keyof NonNullable<JobState['autonomyCounters']>;

function bump(job: JobState, key: AutonomyCounterKey): NonNullable<JobState['autonomyCounters']> {
  const counters = job.autonomyCounters ?? {
    authorityEscalations: 0,
    autonomousRecoveries: 0,
    resourceWaits: 0,
    providerRecoveries: 0,
    toolchainRepairs: 0,
    environmentRepairs: 0,
    controlPlaneRepairs: 0,
    contextRollovers: 0,
    gapClosureCycles: 0,
    systemQualificationCycles: 0,
    driverRestarts: 0,
  };
  const current = counters[key];
  return { ...counters, [key]: (typeof current === 'number' ? current : 0) + 1 };
}

/** Increment one autonomy counter without changing status. */
export function countAutonomyEvent(
  deps: JobDeps,
  jobId: string,
  key: AutonomyCounterKey,
  event: Parameters<typeof applyJobTransition>[2]['event'],
  payload: Record<string, unknown> = {},
): JobState {
  const job = requireJobState(deps.workspace, jobId);
  return applyJobTransition(deps, jobId, {
    to: job.status,
    event,
    payload,
    patch: { autonomyCounters: bump(job, key) },
  });
}
