import type { JobState } from '@specbridge/orchestration';
import {
  clearOperationalState,
  enterEnvironmentRepair,
  enterProviderRecovery,
  enterQualifying,
  enterResourceWait,
  enterToolchainRepair,
  readGraphRevision,
  recordJobEvent,
  requireJobState,
} from '@specbridge/orchestration';
import { isUnattendedMode } from '@specbridge/core';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, now, nowIso } from '../deps.js';
import { createAuthorityResolver, shouldDelegateAuthority } from '../authority/resolver.js';
import {
  bindSealToJob,
  latestExecutableSeal,
  readJobSeal,
  requireExecutableSeal,
} from '../seal/service.js';
import type { MissionSeal } from '../seal/state.js';
import { assertOvernightReady, requiredSurfacesFor, runOvernightPreflight } from '../preflight/preflight.js';
import type { PreflightReport } from '../preflight/state.js';
import type { DriverHost } from '../supervisor/host.js';
import type { SupervisionResult, SupervisionStop } from '../supervisor/supervisor.js';
import { superviseJob } from '../supervisor/supervisor.js';
import {
  advanceClosurePhase,
  buildClosureLedger,
  generateGapWork,
  readClosureLedger,
  runClosureAudit,
} from '../closure/service.js';
import type { ClosureAudit } from '../closure/state.js';
import { computeAutonomyTelemetry } from '../telemetry/telemetry.js';
import type { AutonomyTelemetry } from '../telemetry/telemetry.js';
import type { FailureObservation, RecoveryClassification } from './recovery.js';
import { classifyFailure } from './recovery.js';

/**
 * The unattended runtime.
 *
 * One call. The user seals an intent in the evening, runs one command, and
 * goes to bed; this is what runs while they are asleep.
 *
 *   preflight  ->  bind seal  ->  build closure ledger  ->  supervise
 *      ^                                                       |
 *      |                                                       v
 *   telemetry  <-  closure lifecycle  <-  classify what stopped it
 *
 * The loop between "supervise" and "closure lifecycle" is the important
 * part. A driver that stops is not the end of the night: the runtime asks
 * WHY it stopped, and only two answers end the run — a terminal product
 * state, or a genuine authority question. Everything else is classified onto
 * an operational status the supervisor already knows how to leave, and the
 * loop goes round again.
 */

export interface UnattendedOptions {
  /** The mission whose sealed intent governs this run. */
  missionId: string;
  /** An existing job to continue; a new one is created when absent. */
  jobId: string;
  /** How the driver runs. Injected; see supervisor/host.ts. */
  host: DriverHost;
  signal?: AbortSignal | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onEvent?: ((event: { kind: string; message: string }) => void) | undefined;
  /**
   * Skip the preflight because one already cleared this run tonight. The
   * report is still REQUIRED — this accepts a prior verdict, it does not
   * accept the absence of one.
   */
  preflightReport?: PreflightReport | undefined;
  /** Bound on supervise/close cycles. A TEST bound, not a policy one. */
  maxCycles?: number | undefined;
  /** Bound on supervisor decision cycles per supervision pass. */
  maxSupervisionCycles?: number | undefined;
  ownerId?: string | undefined;
}

export type UnattendedStop =
  | { kind: 'completed'; rationale: string }
  | { kind: 'needs-authority'; question: string }
  | { kind: 'needs-human'; status: string; detail: string }
  | { kind: 'gave-up'; reason: string }
  | { kind: 'interrupted' }
  | { kind: 'cycles-exhausted' };

export interface UnattendedResult {
  stop: UnattendedStop;
  job: JobState;
  seal: MissionSeal;
  telemetry: AutonomyTelemetry;
  /** Every closure audit taken during this run, newest last. */
  audits: ClosureAudit[];
  /** Operational recoveries the runtime performed by itself. */
  recoveries: RecoveryClassification[];
  cycles: number;
}

/**
 * Run one mission unattended until a terminal product state.
 *
 * Refuses to start in an interactive mode. Autonomy is something a human
 * grants explicitly, and a runtime that quietly went unattended because
 * somebody called the wrong function would be exactly the kind of implicit
 * authority the whole phase exists to prevent.
 */
export async function runUnattendedMission(
  deps: AutonomyDeps,
  options: UnattendedOptions,
): Promise<UnattendedResult> {
  const policy = autonomyPolicyOf(deps);
  if (!isUnattendedMode(policy.mode)) {
    throw new AutonomyError(
      'SBA001',
      `Autonomy mode is ${policy.mode}; an unattended run needs OVERNIGHT or ZERO_TOUCH.`,
      { remediation: ['Run `specbridge autonomy setup --mode overnight`, then re-seal.'] },
    );
  }

  const seal = requireExecutableSeal(
    readJobSeal(deps.workspace, options.jobId) ??
      latestExecutableSeal(deps.workspace, options.missionId),
    policy,
  );

  // Preflight is not optional and its verdict is not advisory. A run that
  // starts on HUMAN_ACTION_REQUIRED will discover the same prerequisite at
  // 02:40 with nobody awake to satisfy it.
  const surfaces = requiredSurfacesFor(seal);
  const report =
    options.preflightReport ??
    (await runOvernightPreflight(deps, {
      subject: options.missionId,
      missionId: options.missionId,
      sealId: seal.sealId,
      requiresContainers: surfaces.requiresContainers,
      requiresBrowser: surfaces.requiresBrowser,
    }));
  assertOvernightReady(report);

  const emit = (kind: string, message: string): void => options.onEvent?.({ kind, message });

  if (readJobSeal(deps.workspace, options.jobId) === undefined) {
    bindSealToJob(deps, options.jobId, seal.sealId);
    recordJobEvent(jobDepsOf(deps), options.jobId, 'autonomy_seal_bound', {
      sealId: seal.sealId,
      missionId: seal.missionId,
      mode: policy.mode,
      contracts: seal.contracts.length,
      criteria: seal.acceptanceCriteria.length,
    });
  }
  if (readClosureLedger(deps.workspace, options.jobId) === undefined) {
    const ledger = buildClosureLedger(deps, { jobId: options.jobId, seal });
    emit('closure', `closure ledger built with ${ledger.entries.length} sealed item(s)`);
  }

  // The authority resolver is what makes the driver stop asking about
  // architecture and keep asking about promises. Installed only for a
  // workspace whose human explicitly chose AUTHORITY_ONLY.
  const supervisedDeps: AutonomyDeps = shouldDelegateAuthority(policy)
    ? {
        ...deps,
        authorityResolver: createAuthorityResolver({ workspace: deps.workspace, policy }),
      }
    : deps;

  const startedMs = now(deps).getTime();
  const recoveries: RecoveryClassification[] = [];
  const audits: ClosureAudit[] = [];
  const maxCycles = options.maxCycles ?? 100;
  let stop: UnattendedStop | undefined;
  let cycles = 0;

  while (cycles < maxCycles) {
    cycles += 1;
    if (options.signal?.aborted === true) {
      stop = { kind: 'interrupted' };
      break;
    }

    const supervision: SupervisionResult = await superviseJob(supervisedDeps, options.jobId, {
      host: options.host,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      ...(options.maxSupervisionCycles !== undefined ? { maxCycles: options.maxSupervisionCycles } : {}),
      ...(options.ownerId !== undefined ? { ownerId: `${options.ownerId}-${cycles}` } : {}),
      onEvent: (event) => emit(event.kind, event.message),
    });

    const resolution = await resolveSupervisionStop(supervisedDeps, {
      jobId: options.jobId,
      stop: supervision.stop,
      emit,
    });
    if (resolution.recovery !== undefined) recoveries.push(resolution.recovery);
    if (resolution.stop !== undefined) {
      stop = resolution.stop;
      break;
    }

    // The driver ran out of planned work. That is where the closure
    // lifecycle takes over and decides whether COMPLETED is even available.
    const outcome = runClosureCycle(supervisedDeps, { jobId: options.jobId, emit });
    audits.push(outcome.audit);
    if (outcome.stop !== undefined) {
      stop = outcome.stop;
      break;
    }
  }

  const telemetry = computeAutonomyTelemetry(supervisedDeps, {
    jobId: options.jobId,
    elapsedWallTimeMs: now(deps).getTime() - startedMs,
  });

  return {
    stop: stop ?? { kind: 'cycles-exhausted' },
    job: requireJobState(deps.workspace, options.jobId),
    seal,
    telemetry,
    audits,
    recoveries,
    cycles,
  };
}

// ---------------------------------------------------------------------------
// Supervision outcomes
// ---------------------------------------------------------------------------

interface StopResolution {
  stop?: UnattendedStop | undefined;
  recovery?: RecoveryClassification | undefined;
}

/**
 * Decide what a supervision stop means for the night.
 *
 * The `needs-human` branch is the one that has to be exactly right. A
 * NEEDS_AUTHORITY job ends the run and wakes somebody — correctly, and it is
 * the only thing that should. A NEEDS_CLARIFICATION or BLOCKED job also ends
 * the run, and the telemetry counts it as an intervention, because the
 * runtime asked for something it should have handled and that is a failure
 * of this phase rather than of the person asleep upstairs.
 */
async function resolveSupervisionStop(
  deps: AutonomyDeps,
  input: {
    jobId: string;
    stop: SupervisionStop;
    emit: (kind: string, message: string) => void;
  },
): Promise<StopResolution> {
  switch (input.stop.kind) {
    case 'completed':
      return { stop: { kind: 'completed', rationale: 'the job reached a terminal COMPLETED status' } };
    case 'interrupted':
      return { stop: { kind: 'interrupted' } };
    case 'gave-up':
      return { stop: { kind: 'gave-up', reason: input.stop.reason } };
    case 'needs-human': {
      const job = requireJobState(deps.workspace, input.jobId);
      if (input.stop.status === 'NEEDS_AUTHORITY') {
        return {
          stop: {
            kind: 'needs-authority',
            question: job.authorityRequest?.question ?? input.stop.detail,
          },
        };
      }
      return {
        stop: { kind: 'needs-human', status: input.stop.status, detail: input.stop.detail },
      };
    }
    case 'released':
    case 'cycles-exhausted':
    default: {
      // The supervisor released the job without a terminal status. Either
      // there is more to do (the closure lifecycle decides), or something
      // operational happened that the classifier can name.
      const job = requireJobState(deps.workspace, input.jobId);
      if (job.status === 'BLOCKED' && job.blocker !== undefined) {
        const recovery = applyRecovery(deps, {
          jobId: input.jobId,
          observation: { kind: 'blocked', detail: job.blocker.message },
          emit: input.emit,
        });
        return recovery.humanRequired
          ? { stop: { kind: 'needs-human', status: 'BLOCKED', detail: job.blocker.message }, recovery }
          : { recovery };
      }
      return {};
    }
  }
}

/**
 * Move the job onto the operational status its failure implies.
 *
 * The classifier decides; this function performs. Keeping them apart means
 * the interesting logic — which failures are engineering and which are not —
 * is a pure function a certification can enumerate.
 */
export function applyRecovery(
  deps: AutonomyDeps,
  input: {
    jobId: string;
    observation: FailureObservation;
    emit?: ((kind: string, message: string) => void) | undefined;
  },
): RecoveryClassification {
  const classification = classifyFailure(input.observation);
  input.emit?.('recovery', `${classification.status}: ${classification.detail}`);
  const jobDeps = jobDepsOf(deps);
  const payload = {
    kind: classification.waitKind,
    detail: classification.detail,
    ...(classification.wakeAt !== undefined ? { wakeAt: classification.wakeAt } : {}),
  };
  switch (classification.status) {
    case 'WAITING_RESOURCE':
      enterResourceWait(jobDeps, input.jobId, payload);
      break;
    case 'RECOVERING_PROVIDER':
      enterProviderRecovery(jobDeps, input.jobId, payload);
      break;
    case 'REPAIRING_TOOLCHAIN':
      enterToolchainRepair(jobDeps, input.jobId, payload);
      break;
    case 'REPAIRING_ENVIRONMENT':
      enterEnvironmentRepair(jobDeps, input.jobId, payload);
      break;
    case 'READY': {
      // A context rollover: durable state is intact, a fresh session
      // continues from it, and nothing waits on anything.
      recordJobEvent(jobDeps, input.jobId, 'context_rollover', {
        detail: classification.detail.slice(0, 300),
      });
      break;
    }
    case 'REPAIRING_CONTROL_PLANE':
      // Deliberately NOT transitioned here. A control-plane repair needs a
      // repair id, and the record that carries it is created by
      // `detectControlPlaneDefect`, which performs the transition itself.
      // Doing it in both places would let a job enter the status with no
      // repair to leave it.
      break;
    default:
      break;
  }
  return classification;
}

// ---------------------------------------------------------------------------
// The closure lifecycle
// ---------------------------------------------------------------------------

interface ClosureCycleOutcome {
  audit: ClosureAudit;
  stop?: UnattendedStop | undefined;
}

/**
 * Run one closure cycle and decide whether the night is over.
 *
 * COMPLETE is the only directive that ends the run successfully, and it is
 * reachable only when every sealed item closed on trusted evidence. A run
 * whose task list is finished but whose ledger is not simply goes round
 * again with new work — which is the whole point.
 */
function runClosureCycle(
  deps: AutonomyDeps,
  input: { jobId: string; emit: (kind: string, message: string) => void },
): ClosureCycleOutcome {
  const job = requireJobState(deps.workspace, input.jobId);
  const graph = safeGraph(deps, job);
  const completedNodeIds = graph
    .filter((node) => node.status === 'COMPLETED')
    .map((node) => node.nodeId);
  const implementationComplete =
    graph.length > 0 &&
    graph.every((node) => node.status === 'COMPLETED' || node.status === 'SUPERSEDED');

  const { audit } = runClosureAudit(deps, {
    jobId: input.jobId,
    completedNodeIds,
    implementationComplete,
  });
  input.emit('closure', `${audit.directive}: ${audit.rationale}`);

  switch (audit.directive) {
    case 'COMPLETE':
      return { audit, stop: { kind: 'completed', rationale: audit.rationale } };
    case 'BUDGET_EXHAUSTED':
      return { audit, stop: { kind: 'gave-up', reason: audit.rationale } };
    case 'NEEDS_AUTHORITY':
      return { audit, stop: { kind: 'needs-authority', question: audit.rationale } };
    case 'GENERATE_GAP_WORK': {
      const generated = generateGapWork(deps, { jobId: input.jobId, audit });
      input.emit('closure', `generated ${generated.length} gap work item(s)`);
      // The generated work is durable and the job returns to implementation.
      // A run that generated no work despite unclosed items would loop, so it
      // is treated as a budget outcome rather than a silent spin.
      if (generated.length === 0) {
        return {
          audit,
          stop: {
            kind: 'gave-up',
            reason: 'items remain unclosed but no gap work could be generated for them',
          },
        };
      }
      clearOperationalStateIfNeeded(deps, input.jobId);
      return { audit };
    }
    case 'RUN_SYSTEM_SCENARIOS':
      enterQualifying(jobDepsOf(deps), input.jobId, {
        phase: 'SYSTEM_SCENARIO_QUALIFICATION',
        detail: audit.rationale,
      });
      advanceClosurePhase(deps, {
        jobId: input.jobId,
        phase: 'SYSTEM_SCENARIO_QUALIFICATION',
        systemCycle: true,
      });
      return { audit };
    case 'RUN_RELEASE_QUALIFICATION':
      enterQualifying(jobDepsOf(deps), input.jobId, { phase: 'RELEASE_QUALIFICATION' });
      advanceClosurePhase(deps, { jobId: input.jobId, phase: 'RELEASE_QUALIFICATION' });
      return { audit };
    case 'RUN_REPRODUCIBILITY':
      enterQualifying(jobDepsOf(deps), input.jobId, { phase: 'REPRODUCIBILITY' });
      advanceClosurePhase(deps, { jobId: input.jobId, phase: 'REPRODUCIBILITY' });
      return { audit };
    case 'CONTINUE_IMPLEMENTATION':
    default:
      clearOperationalStateIfNeeded(deps, input.jobId);
      return { audit };
  }
}

function clearOperationalStateIfNeeded(deps: AutonomyDeps, jobId: string): void {
  const job = requireJobState(deps.workspace, jobId);
  if (job.status === 'QUALIFYING' || job.operationalWait !== undefined) {
    try {
      clearOperationalState(jobDepsOf(deps), jobId, {
        resolution: 'the closure audit returned work to implementation',
      });
    } catch {
      // QUALIFYING is not an operational status, so clearing refuses; the
      // transition happens through the ordinary scheduler instead.
    }
  }
}

function safeGraph(
  deps: AutonomyDeps,
  job: JobState,
): { nodeId: string; status: string }[] {
  try {
    const graph = readGraphRevision(deps.workspace, job.jobId, job.graphRevision);
    return graph?.nodes.map((node) => ({ nodeId: node.nodeId, status: node.status })) ?? [];
  } catch {
    return [];
  }
}

/** The instant this runtime considers "now", for reports. */
export function unattendedNow(deps: AutonomyDeps): string {
  return nowIso(deps);
}
