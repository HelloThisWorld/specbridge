import type { PreflightReport, UnattendedResult } from '@specbridge/autonomy';
import {
  assessSealCompleteness,
  draftSeal,
  latestExecutableSeal,
  requestToolsmithCapability,
  requiredSurfacesFor,
  runOvernightPreflight,
  runUnattendedMission,
  sealMission,
} from '@specbridge/autonomy';
import type { ProbeRunner } from '@specbridge/autonomy';
import type { DriverHost } from '@specbridge/autonomy';
import type { ToolsmithCapability } from '@specbridge/core';
import {
  createJob,
  readJobState,
  reconcileDecidedCcrs,
  retryBlockedJob,
} from '@specbridge/orchestration';
import {
  markContractReady,
  readAdrs,
  readCcrs,
  readConstitution,
  readContractRegistry,
  readDecisions,
  requireMissionState,
  synthesizeMissionSpec,
} from '@specbridge/mission';
import { readSpecState } from '@specbridge/core';
import { IntakeError } from './errors.js';
import type { IntakeDeps } from './deps.js';
import { autonomyDepsOf, hostOf, missionDepsOf, newRecordId, nowIso } from './deps.js';
import type { BuildLifecycle, BuildStepRecord, IntakeApproval } from './state.js';
import { INTAKE_LIFECYCLE_SCHEMA_VERSION, INTAKE_LIMITS } from './state.js';
import type { BuildLifecycleStep, BuildOutcome } from './vocabulary.js';
import { BUILD_LIFECYCLE_STEPS, isStepSettled } from './vocabulary.js';
import {
  appendIntakeEvent,
  bindApprovalSeal,
  readLifecycle,
  requireApproval,
  requireIntakeState,
  writeIntakeState,
  writeLifecycle,
  writeProjectionEquivalence,
} from './store.js';
import { canonicalTruthOf, computeIntakeAuthorityDigest } from './approval.js';
import {
  approvedElements,
  checkProjectionEquivalence,
  recordDerivedApprovals,
} from './derived-approval.js';
import { readQuestions } from './store.js';

/**
 * The atomic seal-and-build transition.
 *
 * From the user's side this is ONE thing: they approved, and the machine
 * built it. Underneath it is nine durable transactions, and the gap between
 * those two facts is the entire design problem here.
 *
 * The resolution is a durable STEP LEDGER plus reconciliation. Each step is
 * written as RUNNING before it acts and settled after, so a process that
 * dies in the middle leaves a record saying which step was in flight. On
 * re-entry the lifecycle does NOT trust that record: it asks durable reality
 * whether the step's effect already exists — is the mission CONTRACT_READY,
 * does the spec exist, is the seal authorized, does the job exist — and
 * marks it `RECONCILED` when it does.
 *
 * That distinction matters. A ledger that trusted itself would re-run a step
 * whose write succeeded microseconds before the crash, and "synthesize the
 * spec twice" is not a harmless retry. Reality is the authority; the ledger
 * is the plan.
 *
 * Two refusals are worth naming.
 *
 * A HUMAN-REQUIRED PREREQUISITE STOPS BEFORE THE JOB EXISTS. Preflight runs
 * at step 6 and job creation at step 8, on purpose: discovering at 02:40
 * that docker was never installed is the failure this whole phase exists to
 * prevent, and a job sitting in a workspace nobody launched is a worse
 * artifact than a clear refusal.
 *
 * A PROJECTION THAT DIVERGES STOPS BEFORE THE SEAL. If the compiler emitted
 * authority the human did not approve, sealing it would authorize it. The
 * lifecycle fails at step 3 and says so.
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SealAndBuildOptions {
  intakeId: string;
  /**
   * Run the unattended supervisor. Default true.
   *
   * `false` performs every step through CREATE_JOB and stops — the shape an
   * operator wants when they intend to launch on a different machine, and
   * the shape a test wants when it is asserting the lifecycle rather than
   * the runtime.
   */
  launch?: boolean | undefined;
  /** Injected probe runner for the automatic preflight (tests, offline runs). */
  probeRunner?: ProbeRunner | undefined;
  /** The driver host factory handed to the unattended runtime. */
  host?: DriverHost | ((deps: unknown) => DriverHost) | undefined;
  /** Injected unattended runner. Defaults to `runUnattendedMission`. */
  runUnattended?:
    | ((deps: IntakeDeps, input: { missionId: string; jobId: string }) => Promise<UnattendedResult>)
    | undefined;
  maxCycles?: number | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: { kind: string; message: string }) => void) | undefined;
}

export interface SealAndBuildResult {
  lifecycle: BuildLifecycle;
  outcome: BuildOutcome;
  /** Present when the unattended runtime ran. */
  unattended?: UnattendedResult | undefined;
  /** Prerequisites only a person can satisfy, when the launch refused. */
  humanPrerequisites: string[];
  preflight?: PreflightReport | undefined;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

function emptyLedger(
  deps: IntakeDeps,
  approval: IntakeApproval,
): BuildLifecycle {
  const at = nowIso(deps);
  return {
    schemaVersion: INTAKE_LIFECYCLE_SCHEMA_VERSION,
    intakeId: approval.intakeId,
    approvalId: approval.approvalId,
    missionId: approval.missionId,
    startedAt: at,
    updatedAt: at,
    steps: BUILD_LIFECYCLE_STEPS.map((step) => ({
      step,
      status: 'PENDING' as const,
      attempts: 0,
    })),
    resolvedPrerequisites: [],
    humanPrerequisites: [],
  };
}

function stepOf(ledger: BuildLifecycle, step: BuildLifecycleStep): BuildStepRecord {
  const found = ledger.steps.find((record) => record.step === step);
  if (found !== undefined) return found;
  return { step, status: 'PENDING', attempts: 0 };
}

function withStep(
  ledger: BuildLifecycle,
  step: BuildLifecycleStep,
  patch: Partial<BuildStepRecord>,
): BuildLifecycle {
  const existing = stepOf(ledger, step);
  const merged: BuildStepRecord = { ...existing, ...patch, step };
  const steps = ledger.steps.some((record) => record.step === step)
    ? ledger.steps.map((record) => (record.step === step ? merged : record))
    : [...ledger.steps, merged];
  return { ...ledger, steps };
}

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

/**
 * Run — or resume — the seal-and-build lifecycle for an approved intake.
 *
 * Idempotent by construction. Calling it on a finished lifecycle performs no
 * work and returns the recorded outcome; calling it on a half-finished one
 * continues from the first unsettled step.
 */
export async function runSealAndBuild(
  deps: IntakeDeps,
  options: SealAndBuildOptions,
): Promise<SealAndBuildResult> {
  const approval = requireApproval(deps.workspace, options.intakeId);
  let ledger = readLifecycle(deps.workspace, options.intakeId) ?? emptyLedger(deps, approval);
  const emit = (kind: string, message: string): void => options.onEvent?.({ kind, message });
  const autonomy = autonomyDepsOf(deps);

  let preflight: PreflightReport | undefined;
  let unattended: UnattendedResult | undefined;
  const outcome: BuildOutcome | undefined = ledger.outcome;

  // Only COMPLETED is genuinely terminal. Re-entering that is a read.
  //
  // Every other recorded outcome is a state a resume EXISTS TO LEAVE. The
  // vNext.10.1 dogfood proved the point: the build stopped on
  // HUMAN_PREREQUISITE_REQUIRED because a container daemon was not running,
  // the operator started it and ran `--resume`, and an earlier version of
  // this guard short-circuited on the stale outcome and repeated the same
  // refusal verbatim. A resume that cannot resume is not a resume.
  //
  // Re-entry is safe because the step ledger is reconciled against durable
  // reality rather than trusted, and a FAILED step is not settled — so the
  // work already done is skipped and the step that stopped it is retried.
  if (outcome === 'COMPLETED') {
    return {
      lifecycle: ledger,
      outcome,
      humanPrerequisites: [...ledger.humanPrerequisites],
    };
  }
  if (outcome !== undefined) {
    // Clear the recorded ending: this run has not finished, and leaving the
    // old outcome on the ledger would make an in-flight resume read as a
    // completed failure to anything inspecting it.
    ledger = writeLifecycle(deps.workspace, {
      ...ledger,
      outcome: undefined,
      finishedAt: undefined,
      humanPrerequisites: [],
      updatedAt: nowIso(deps),
    } as never);
  }

  const persist = (next: BuildLifecycle): BuildLifecycle => {
    const written = writeLifecycle(deps.workspace, {
      ...next,
      updatedAt: nowIso(deps),
    });
    ledger = written;
    return written;
  };

  const begin = (step: BuildLifecycleStep): void => {
    const record = stepOf(ledger, step);
    persist(
      withStep(ledger, step, {
        status: 'RUNNING',
        startedAt: nowIso(deps),
        attempts: record.attempts + 1,
      }),
    );
    appendIntakeEvent(deps.workspace, options.intakeId, {
      at: nowIso(deps),
      type: 'build_step_started',
      step,
    });
    emit('lifecycle', `${step} started`);
  };

  const settle = (
    step: BuildLifecycleStep,
    status: 'COMPLETED' | 'RECONCILED' | 'SKIPPED',
    detail: string,
    result?: string,
  ): void => {
    persist(
      withStep(ledger, step, {
        status,
        settledAt: nowIso(deps),
        detail: detail.slice(0, INTAKE_LIMITS.maxTextChars),
        ...(result !== undefined ? { result } : {}),
      }),
    );
    appendIntakeEvent(deps.workspace, options.intakeId, {
      at: nowIso(deps),
      type: 'build_step_completed',
      step,
      status,
      ...(result !== undefined ? { result } : {}),
    });
    emit('lifecycle', `${step} ${status.toLowerCase()}${result !== undefined ? `: ${result}` : ''}`);
  };

  const fail = (step: BuildLifecycleStep, detail: string): void => {
    persist(
      withStep(ledger, step, {
        status: 'FAILED',
        settledAt: nowIso(deps),
        detail: detail.slice(0, INTAKE_LIMITS.maxTextChars),
      }),
    );
    appendIntakeEvent(deps.workspace, options.intakeId, {
      at: nowIso(deps),
      type: 'build_step_failed',
      step,
      detail: detail.slice(0, 600),
    });
    emit('lifecycle', `${step} FAILED: ${detail}`);
  };

  // --- 1. CONTRACT_READY ---------------------------------------------------
  if (!isStepSettled(stepOf(ledger, 'CONTRACT_READY').status)) {
    const mission = requireMissionState(deps.workspace, approval.missionId);
    if (mission.status !== 'IDEA' && mission.status !== 'DISCOVERING' && mission.status !== 'NEEDS_DECISION') {
      settle('CONTRACT_READY', 'RECONCILED', `the mission is already ${mission.status}`);
    } else {
      begin('CONTRACT_READY');
      try {
        const { mission: ready } = markContractReady(missionDepsOf(deps), approval.missionId);
        settle('CONTRACT_READY', 'COMPLETED', `the mission is ${ready.status}`);
      } catch (cause) {
        fail('CONTRACT_READY', messageOf(cause));
        return finish(deps, options, ledger, 'FAILED', { preflight });
      }
    }
  }

  // --- 2. SYNTHESIZE -------------------------------------------------------
  let specName = ledger.specName;
  if (!isStepSettled(stepOf(ledger, 'SYNTHESIZE').status)) {
    const mission = requireMissionState(deps.workspace, approval.missionId);
    if (mission.specName !== undefined) {
      specName = mission.specName;
      ledger = persist({ ...ledger, specName });
      settle('SYNTHESIZE', 'RECONCILED', `the mission already synthesized "${specName}"`, specName);
    } else {
      begin('SYNTHESIZE');
      try {
        const intake = requireIntakeState(deps.workspace, options.intakeId);
        const result = synthesizeMissionSpec(missionDepsOf(deps), approval.missionId, {
          specName: intake.specName ?? undefined,
        });
        specName = result.specName;
        ledger = persist({ ...ledger, specName });
        settle(
          'SYNTHESIZE',
          'COMPLETED',
          `${result.objectiveCount} objective(s) compiled`,
          result.specName,
        );
      } catch (cause) {
        fail('SYNTHESIZE', messageOf(cause));
        return finish(deps, options, ledger, 'FAILED', { preflight });
      }
    }
  }
  specName = specName ?? requireMissionState(deps.workspace, approval.missionId).specName;
  if (specName === undefined) {
    fail('SYNTHESIZE', 'no spec name is recorded after synthesis');
    return finish(deps, options, ledger, 'FAILED', { preflight });
  }

  // --- 3. VALIDATE_PROJECTION ---------------------------------------------
  if (!isStepSettled(stepOf(ledger, 'VALIDATE_PROJECTION').status)) {
    begin('VALIDATE_PROJECTION');
    try {
      const equivalence = validateProjection(deps, approval, specName);
      writeProjectionEquivalence(deps.workspace, equivalence);
      if (!equivalence.equivalent) {
        appendIntakeEvent(deps.workspace, options.intakeId, {
          at: nowIso(deps),
          type: 'projection_diverged',
          divergences: equivalence.divergences.length,
        });
        fail(
          'VALIDATE_PROJECTION',
          `${equivalence.divergences.length} divergence(s): ` +
            equivalence.divergences
              .slice(0, 3)
              .map((divergence) => `${divergence.kind} — ${divergence.detail}`)
              .join(' | '),
        );
        return finish(deps, options, ledger, 'FAILED', { preflight });
      }
      appendIntakeEvent(deps.workspace, options.intakeId, {
        at: nowIso(deps),
        type: 'projection_validated',
        checked: equivalence.checkedStatements,
        traced: equivalence.tracedStatements,
      });
      settle(
        'VALIDATE_PROJECTION',
        'COMPLETED',
        `${equivalence.tracedStatements}/${equivalence.checkedStatements} normative statements ` +
          'trace to approved product truth',
      );
    } catch (cause) {
      fail('VALIDATE_PROJECTION', messageOf(cause));
      return finish(deps, options, ledger, 'FAILED', { preflight });
    }
  }

  // --- 4. DERIVE_APPROVALS -------------------------------------------------
  if (!isStepSettled(stepOf(ledger, 'DERIVE_APPROVALS').status)) {
    const state = readSpecState(deps.workspace, specName).state;
    if (state?.status === 'READY_FOR_IMPLEMENTATION') {
      settle('DERIVE_APPROVALS', 'RECONCILED', 'every stage of the spec is already approved');
    } else {
      begin('DERIVE_APPROVALS');
      try {
        const equivalence = validateProjection(deps, approval, specName);
        const derived = recordDerivedApprovals({
          workspace: deps.workspace,
          approval,
          specName,
          equivalence,
          clock: deps.clock ?? ((): Date => new Date()),
        });
        for (const stage of derived.approved) {
          appendIntakeEvent(deps.workspace, options.intakeId, {
            at: nowIso(deps),
            type: 'derived_approval_recorded',
            stage,
            approvalId: approval.approvalId,
            authorityDigest: approval.authorityDigest,
          });
        }
        settle(
          'DERIVE_APPROVALS',
          'COMPLETED',
          `${derived.approved.join(', ')} approved with DERIVED_FROM_INTENT_APPROVAL provenance`,
        );
      } catch (cause) {
        fail('DERIVE_APPROVALS', messageOf(cause));
        return finish(deps, options, ledger, 'FAILED', { preflight });
      }
    }
  }

  // --- 5. SEAL -------------------------------------------------------------
  let sealId = ledger.sealId ?? approval.sealId;
  if (!isStepSettled(stepOf(ledger, 'SEAL').status)) {
    const existing = latestExecutableSeal(deps.workspace, approval.missionId);
    if (approval.sealId !== undefined && existing?.sealId === approval.sealId) {
      sealId = existing.sealId;
      ledger = persist({ ...ledger, sealId });
      settle('SEAL', 'RECONCILED', `seal ${sealId} is already authorized`, sealId);
    } else {
      begin('SEAL');
      try {
        const draft = draftSeal(autonomy, {
          missionId: approval.missionId,
          sealId: newRecordId(deps, 'seal'),
          maxApiSpendUsd: approval.maxApiSpendUsd,
          allowedLanes: approval.allowedLanes,
        });
        const completeness = assessSealCompleteness(draft);
        if (!completeness.complete) {
          fail(
            'SEAL',
            `the seal is missing authority required for unattended execution: ` +
              `${completeness.missing.join(', ')}`,
          );
          return finish(deps, options, ledger, 'FAILED', { preflight });
        }
        // The CHANNEL is the intake approval. Recording "cli" here would say
        // a person typed a seal command, and nobody did — they approved the
        // product truth this seal was compiled from.
        const seal = sealMission(autonomy, {
          sealId: draft.sealId,
          via: `intake-approval:${approval.approvalId}`,
        });
        sealId = seal.sealId;
        bindApprovalSeal(deps.workspace, options.intakeId, seal.sealId);
        ledger = persist({ ...ledger, sealId });
        appendIntakeEvent(deps.workspace, options.intakeId, {
          at: nowIso(deps),
          type: 'seal_created',
          sealId: seal.sealId,
          approvalId: approval.approvalId,
          contracts: seal.contracts.length,
          criteria: seal.acceptanceCriteria.length,
        });
        settle(
          'SEAL',
          'COMPLETED',
          `${seal.contracts.length} contract(s), ${seal.acceptanceCriteria.length} criterion/criteria`,
          seal.sealId,
        );
      } catch (cause) {
        fail('SEAL', messageOf(cause));
        return finish(deps, options, ledger, 'FAILED', { preflight });
      }
    }
  }

  // --- 6. PREFLIGHT --------------------------------------------------------
  if (!isStepSettled(stepOf(ledger, 'PREFLIGHT').status)) {
    begin('PREFLIGHT');
    try {
      preflight = await runPreflight(deps, options, approval.missionId, sealId);
      ledger = persist({ ...ledger, preflightReportId: preflight.reportId });
      appendIntakeEvent(deps.workspace, options.intakeId, {
        at: nowIso(deps),
        type: 'preflight_completed',
        reportId: preflight.reportId,
        verdict: preflight.verdict,
      });
      settle('PREFLIGHT', 'COMPLETED', preflight.verdict, preflight.reportId);
    } catch (cause) {
      fail('PREFLIGHT', messageOf(cause));
      return finish(deps, options, ledger, 'FAILED', { preflight });
    }
  }

  // --- 7. RESOLVE_PREREQUISITES -------------------------------------------
  if (!isStepSettled(stepOf(ledger, 'RESOLVE_PREREQUISITES').status)) {
    begin('RESOLVE_PREREQUISITES');
    try {
      if (preflight === undefined) {
        // A RESUMED run reaches here with the PREFLIGHT step already settled
        // and no report in memory, so it takes a fresh one — and that fresh
        // verdict is the one the launch acts on. Recording it back onto the
        // PREFLIGHT step matters: the dogfood resumed after a person started
        // the container runtime, and the ledger went on displaying the
        // original HUMAN_ACTION_REQUIRED beside a build that proceeded. A
        // report must never show a verdict the run did not rely on.
        preflight = await runPreflight(deps, options, approval.missionId, sealId);
        ledger = persist(
          withStep({ ...ledger, preflightReportId: preflight.reportId }, 'PREFLIGHT', {
            detail: preflight.verdict,
            result: preflight.reportId,
            settledAt: nowIso(deps),
          }),
        );
        appendIntakeEvent(deps.workspace, options.intakeId, {
          at: nowIso(deps),
          type: 'preflight_completed',
          reportId: preflight.reportId,
          verdict: preflight.verdict,
          rechecked: true,
        });
      }
      const resolution = resolvePrerequisites(deps, options.intakeId, preflight);
      ledger = persist({
        ...ledger,
        resolvedPrerequisites: resolution.resolved.slice(0, INTAKE_LIMITS.maxItems),
        humanPrerequisites: resolution.human.slice(0, INTAKE_LIMITS.maxItems),
      });
      for (const resolved of resolution.resolved) {
        appendIntakeEvent(deps.workspace, options.intakeId, {
          at: nowIso(deps),
          type: 'prerequisite_resolved',
          detail: resolved.slice(0, 400),
        });
      }
      if (resolution.human.length > 0) {
        fail(
          'RESOLVE_PREREQUISITES',
          `${resolution.human.length} prerequisite(s) only a person can satisfy: ` +
            resolution.human.slice(0, 4).join(' | '),
        );
        return finish(deps, options, ledger, 'HUMAN_PREREQUISITE_REQUIRED', { preflight });
      }
      settle(
        'RESOLVE_PREREQUISITES',
        resolution.resolved.length === 0 ? 'SKIPPED' : 'COMPLETED',
        resolution.resolved.length === 0
          ? 'nothing needed resolving'
          : `${resolution.resolved.length} prerequisite(s) provided by the runtime`,
      );
    } catch (cause) {
      fail('RESOLVE_PREREQUISITES', messageOf(cause));
      return finish(deps, options, ledger, 'FAILED', { preflight });
    }
  }

  // --- 8. CREATE_JOB -------------------------------------------------------
  let jobId = ledger.jobId;
  if (!isStepSettled(stepOf(ledger, 'CREATE_JOB').status)) {
    if (jobId !== undefined && readJobState(deps.workspace, jobId).kind === 'ok') {
      settle('CREATE_JOB', 'RECONCILED', `job ${jobId} already exists`, jobId);
    } else {
      begin('CREATE_JOB');
      try {
        const job = createJob(deps, { specName, goal: approval.goal });
        jobId = job.jobId;
        ledger = persist({ ...ledger, jobId });
        const intake = requireIntakeState(deps.workspace, options.intakeId);
        writeIntakeState(deps.workspace, { ...intake, jobId, specName, sealId, status: 'BUILDING' });
        appendIntakeEvent(deps.workspace, options.intakeId, {
          at: nowIso(deps),
          type: 'job_created',
          jobId,
          specName,
        });
        settle('CREATE_JOB', 'COMPLETED', `job created for spec "${specName}"`, jobId);
      } catch (cause) {
        fail('CREATE_JOB', messageOf(cause));
        return finish(deps, options, ledger, 'FAILED', { preflight });
      }
    }
  }
  jobId = jobId ?? stepOf(ledger, 'CREATE_JOB').result;
  if (jobId === undefined) {
    fail('CREATE_JOB', 'no job id is recorded after job creation');
    return finish(deps, options, ledger, 'FAILED', { preflight });
  }

  // A person running `--resume` after fixing an environmental cause is the
  // signal "I fixed it, continue". Without this the intake is a dead end:
  // the dogfood blocked on an expired OAuth token, which takes five seconds
  // to fix, and the supervisor then answered WAIT_FOR_HUMAN forever because
  // nothing could tell it the machine had changed.
  //
  // Narrow by construction — `retryBlockedJob` refuses any blocker that is
  // not operator-fixable, so this cannot turn "I installed docker" into
  // "ignore the failing tests".
  {
    const retry = retryBlockedJob(deps, jobId, {
      reason: 'the operator resumed the intake after fixing the cause',
    });
    if (retry.cleared) {
      emit('lifecycle', `job ${jobId} unblocked and returned to the schedulable path`);
      appendIntakeEvent(deps.workspace, options.intakeId, {
        at: nowIso(deps),
        type: 'build_step_started',
        step: 'LAUNCH',
        unblocked: true,
      });
    }
  }

  // The same signal for a PRODUCT decision rather than an environmental one.
  //
  // A clarification question that says "CCR-001 awaits a human decision" is
  // answered BY that decision; there is no second answer to type. The dogfood
  // wedged here for sixteen hours after the change request was approved,
  // because the job knew only that it was NEEDS_CLARIFICATION and the
  // supervisor gates on status alone.
  {
    const ccrs = new Map(
      readCcrs(deps.workspace, approval.missionId).map((ccr) => [ccr.ccrId, ccr.status]),
    );
    const reconciled = reconcileDecidedCcrs(
      deps,
      jobId,
      (ccrId) => ccrs.has(ccrId) && ccrs.get(ccrId) !== 'NEEDS_HUMAN',
    );
    if (reconciled.closed.length > 0) {
      emit(
        'lifecycle',
        `${reconciled.closed.length} clarification question(s) answered by a recorded change-request decision`,
      );
    }
  }

  // --- 9. LAUNCH -----------------------------------------------------------
  if (options.launch === false) {
    settle('LAUNCH', 'SKIPPED', 'launch was not requested; the job is ready to run');
    return finish(deps, options, ledger, 'LAUNCHED', { preflight });
  }

  begin('LAUNCH');
  try {
    appendIntakeEvent(deps.workspace, options.intakeId, {
      at: nowIso(deps),
      type: 'unattended_launched',
      jobId,
      sealId: sealId ?? null,
    });
    unattended = await launchUnattended(deps, options, {
      missionId: approval.missionId,
      jobId,
      preflight,
    });
    settle('LAUNCH', 'COMPLETED', `the unattended run stopped: ${unattended.stop.kind}`, jobId);
    const finalOutcome: BuildOutcome =
      unattended.stop.kind === 'completed'
        ? 'COMPLETED'
        : unattended.stop.kind === 'needs-authority'
          ? 'NEEDS_AUTHORITY'
          : 'LAUNCHED';
    return finish(deps, options, ledger, finalOutcome, { preflight, unattended });
  } catch (cause) {
    fail('LAUNCH', messageOf(cause));
    return finish(deps, options, ledger, 'FAILED', { preflight });
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function validateProjection(
  deps: IntakeDeps,
  approval: IntakeApproval,
  specName: string,
): ReturnType<typeof checkProjectionEquivalence> {
  const mission = requireMissionState(deps.workspace, approval.missionId);
  const contracts = readContractRegistry(deps.workspace, approval.missionId);
  const constitution = readConstitution(deps.workspace, approval.missionId);
  const adrs = readAdrs(deps.workspace, approval.missionId);
  const decisions = readDecisions(deps.workspace, approval.missionId).filter(
    (decision) => decision.status === 'active',
  );
  const questions = readQuestions(deps.workspace, approval.intakeId);
  const currentDigest = computeIntakeAuthorityDigest(
    canonicalTruthOf({
      mission,
      contracts,
      decisionIds: decisions.map((decision) => decision.decisionId),
      constitutionRuleIds: (constitution?.rules ?? [])
        .filter((rule) => rule.status === 'active')
        .map((rule) => rule.ruleId),
      adrIds: adrs.map((adr) => adr.adrId),
      questions,
    }),
  );
  return checkProjectionEquivalence({
    workspace: deps.workspace,
    approval,
    specName,
    checkedAt: nowIso(deps),
    approvedElements: approvedElements(
      approval,
      contracts.map((contract) => ({
        contractId: contract.contractId,
        title: contract.title,
        summary: contract.summary,
        requirements: contract.requirements,
        invariants: contract.invariants,
      })),
      decisions,
    ),
    currentAuthorityDigest: currentDigest,
  });
}

async function runPreflight(
  deps: IntakeDeps,
  options: SealAndBuildOptions,
  missionId: string,
  sealId: string | undefined,
): Promise<PreflightReport> {
  const autonomy = autonomyDepsOf(deps);
  const seal = latestExecutableSeal(deps.workspace, missionId);
  const surfaces = requiredSurfacesFor(seal);
  return runOvernightPreflight(autonomy, {
    subject: missionId,
    missionId,
    ...(sealId !== undefined ? { sealId } : {}),
    requiresContainers: surfaces.requiresContainers,
    requiresBrowser: surfaces.requiresBrowser,
    ...(options.probeRunner !== undefined ? { probeRunner: options.probeRunner } : {}),
  });
}

interface PrerequisiteResolution {
  resolved: string[];
  human: string[];
}

/**
 * Resolve what the runtime is authorized and able to provide.
 *
 * A `SATISFIABLE_AUTONOMOUSLY` check never blocked a launch, but leaving it
 * at that would waste the one moment when a person is still awake: if the
 * Toolsmith broker is going to DENY the capability the preflight said the
 * runtime would provide, that is worth discovering now rather than at 03:00.
 * So each satisfiable check is pre-authorized through the broker, and a
 * denial is promoted to a human prerequisite.
 *
 * `UNKNOWN` checks are human prerequisites too. A launch on a report that
 * could not establish something is a launch on a guess, and
 * `assertOvernightReady` would refuse it anyway — reporting it here means
 * the refusal arrives with the reason attached.
 */
function resolvePrerequisites(
  deps: IntakeDeps,
  intakeId: string,
  report: PreflightReport,
): PrerequisiteResolution {
  const resolved: string[] = [];
  const human: string[] = [];
  const autonomy = autonomyDepsOf(deps);

  for (const check of report.checks) {
    if (check.outcome === 'HUMAN_REQUIRED') {
      human.push(
        `${check.capability}: ${check.observed}` +
          (check.remediation.length > 0 ? ` — ${check.remediation[0]}` : ''),
      );
      continue;
    }
    if (check.outcome === 'UNKNOWN') {
      human.push(
        `${check.capability}: could not be established (${check.observed})` +
          (check.remediation.length > 0 ? ` — ${check.remediation[0]}` : ''),
      );
      continue;
    }
    if (check.outcome !== 'SATISFIABLE_AUTONOMOUSLY') continue;

    const capability = check.satisfiedBy as ToolsmithCapability | undefined;
    if (capability === undefined) {
      resolved.push(`${check.capability}: the runtime provides this during the run`);
      continue;
    }
    const decision = requestToolsmithCapability(autonomy, {
      jobId: intakeId,
      capability,
      target: check.capability,
      purpose:
        `Overnight preflight classified ${check.capability} as satisfiable by the runtime; ` +
        'pre-authorizing it before the unattended launch.',
      requestId: newRecordId(deps, 'ts'),
    });
    if (decision.request.status === 'GRANTED') {
      resolved.push(`${check.capability}: pre-authorized as ${capability}`);
      continue;
    }
    human.push(
      `${check.capability}: the preflight expected the runtime to provide this, but the ` +
        `Toolsmith broker denied ${capability} (${decision.request.denialReason ?? 'no reason recorded'}). ` +
        'Grant the capability in the autonomy policy, or provide it manually.',
    );
  }

  return { resolved, human };
}

async function launchUnattended(
  deps: IntakeDeps,
  options: SealAndBuildOptions,
  input: { missionId: string; jobId: string; preflight: PreflightReport | undefined },
): Promise<UnattendedResult> {
  if (options.runUnattended !== undefined) {
    return options.runUnattended(deps, { missionId: input.missionId, jobId: input.jobId });
  }
  if (options.host === undefined) {
    throw new IntakeError(
      'SBI014',
      'The unattended launch needs a driver host. Pass one, or run with --no-launch and ' +
        'launch with `specbridge overnight run`.',
    );
  }
  return runUnattendedMission(autonomyDepsOf(deps), {
    missionId: input.missionId,
    jobId: input.jobId,
    host: options.host as never,
    ...(input.preflight !== undefined ? { preflightReport: input.preflight } : {}),
    ...(options.maxCycles !== undefined ? { maxCycles: options.maxCycles } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    ownerId: hostOf(deps),
  });
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

function finish(
  deps: IntakeDeps,
  options: SealAndBuildOptions,
  ledger: BuildLifecycle,
  outcome: BuildOutcome,
  extras: { preflight?: PreflightReport | undefined; unattended?: UnattendedResult | undefined },
): SealAndBuildResult {
  const finished = writeLifecycle(deps.workspace, {
    ...ledger,
    outcome,
    updatedAt: nowIso(deps),
    finishedAt: nowIso(deps),
  });
  appendIntakeEvent(deps.workspace, options.intakeId, {
    at: nowIso(deps),
    type: 'build_finished',
    outcome,
    ...(finished.jobId !== undefined ? { jobId: finished.jobId } : {}),
  });

  const intake = requireIntakeState(deps.workspace, options.intakeId);
  const status =
    outcome === 'COMPLETED'
      ? 'BUILT'
      : outcome === 'LAUNCHED'
        ? 'BUILDING'
        : outcome === 'NEEDS_AUTHORITY'
          ? 'BUILDING'
          : 'BLOCKED';
  writeIntakeState(deps.workspace, {
    ...intake,
    status,
    ...(finished.jobId !== undefined ? { jobId: finished.jobId } : {}),
    ...(finished.sealId !== undefined ? { sealId: finished.sealId } : {}),
    ...(finished.specName !== undefined ? { specName: finished.specName } : {}),
  });

  return {
    lifecycle: finished,
    outcome,
    humanPrerequisites: [...finished.humanPrerequisites],
    ...(extras.preflight !== undefined ? { preflight: extras.preflight } : {}),
    ...(extras.unattended !== undefined ? { unattended: extras.unattended } : {}),
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
