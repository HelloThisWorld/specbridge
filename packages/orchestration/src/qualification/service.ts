import { createHash } from 'node:crypto';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import type {
  DogfoodDefect,
  DogfoodRun,
  DogfoodTarget,
  HumanIntervention,
  InvariantAudit,
  RuntimeVersions,
  ScenarioResult,
} from './state.js';
import { DOGFOOD_RUN_SCHEMA_VERSION, dogfoodRunSchema } from './state.js';
import {
  listDogfoodRuns,
  readDogfoodRun,
  requireDogfoodRun,
  writeDogfoodDefect,
  writeDogfoodRun,
  writeHumanIntervention,
  writeInvariantAudit,
  writeScenarioResult,
} from './store.js';
import { findScenario } from './matrix.js';
import type {
  DogfoodRunStatus,
  HumanInterventionKind,
  QualificationProfile,
  QualificationResource,
  ResourceAttribution,
  ScenarioResultStatus,
} from './vocabulary.js';
import { isFinalDogfoodRunStatus } from './vocabulary.js';
import { economicConfiguration } from './preflight.js';

/**
 * Qualification run lifecycle (vNext.9).
 *
 * A run is a durable accumulator with no scheduler of its own. It binds
 * identity and configuration to a Mission and a Job and then gets out of the
 * way: the Job's existing durability provides start, stop, inspect, restart,
 * resume, and survival across reboots, exactly as §16 requires and exactly
 * as it already works for every other long-running job.
 *
 * The one lifecycle nuance worth stating: PAUSED is a first-class status,
 * separate from any failure. An operator who deliberately stops a dogfood
 * for the night must not have that recorded as a worker failure, or the
 * reliability and adaptive histories learn something untrue from it.
 */

export interface QualificationDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  clock: () => Date;
  idFactory: () => string;
}

export interface StartRunRequest {
  profile: QualificationProfile;
  target: DogfoodTarget;
  versions?: Partial<RuntimeVersions> | undefined;
  missionId?: string | null | undefined;
  jobId?: string | null | undefined;
  missionDirection?: string | null | undefined;
  approvedScope?: readonly string[] | undefined;
  /** Continue a series: the previous run this iteration follows. */
  previousRunId?: string | null | undefined;
  /** Explicit run id (deterministic tests); generated otherwise. */
  runId?: string | undefined;
}

/**
 * Fingerprint of the configuration a run was started under.
 *
 * Deliberately narrow: the values that change what a qualification MEANS —
 * lanes, spend authority, budgets, context strategy, adaptive mode, and the
 * verification commands that decide what counts as done. Operational tuning
 * (poll intervals, record retention) is excluded on purpose, so that
 * adjusting a timeout mid-series does not make run #3 look incomparable to
 * run #2 when nothing that matters changed.
 */
export function configurationFingerprint(config: AgentConfig): string {
  const economics = economicConfiguration(config);
  const budgets = config.orchestration.jobs.budgets;
  const canonical = {
    lanes: {
      localEnabled: economics.localEnabled,
      localStrategy: economics.localExecutionStrategy,
      localHarnessProfile: economics.localHarnessProfile,
      subscriptionConfigured: economics.subscriptionWorkerConfigured,
    },
    api: {
      spendMode: economics.apiSpendMode,
      harnessProfile: economics.apiHarnessProfile,
      pricingConfigured: economics.apiPricingConfigured,
      maxCostPerJobUsd: economics.apiMaxBudgetUsd,
      maxCostPerTaskUsd: economics.apiPerTaskCeilingUsd,
    },
    quota: { telemetrySource: economics.quotaTelemetrySource },
    context: { strategy: economics.contextStrategy },
    adaptive: { mode: economics.adaptiveMode },
    budgets: {
      maxTaskAttempts: budgets.maxTaskAttempts,
      maxRepairCyclesPerTask: budgets.maxRepairCyclesPerTask,
      maxReplansPerTask: budgets.maxReplansPerTask,
      maxNoProgressCycles: budgets.maxNoProgressCycles,
    },
    verification: economics.verificationCommands,
    protectedPaths: economics.protectedPaths,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/** Runtime identity, recorded honestly: unknown stays null, never guessed. */
export function collectVersions(
  config: AgentConfig,
  overrides: Partial<RuntimeVersions> = {},
): RuntimeVersions {
  const economics = economicConfiguration(config);
  return {
    specBridgeVersion: overrides.specBridgeVersion ?? null,
    specBridgeCommit: overrides.specBridgeCommit ?? null,
    nodeVersion: overrides.nodeVersion ?? process.version,
    platform: overrides.platform ?? process.platform,
    localModel: overrides.localModel ?? config.localInference?.model ?? null,
    harnessVersion: overrides.harnessVersion ?? null,
    harnessSdkVersion: overrides.harnessSdkVersion ?? null,
    subscriptionRunnerVersion: overrides.subscriptionRunnerVersion ?? null,
    codexVersion: overrides.codexVersion ?? null,
    contextStrategy: overrides.contextStrategy ?? economics.contextStrategy,
    adaptiveMode: overrides.adaptiveMode ?? economics.adaptiveMode,
    policyFingerprint: overrides.policyFingerprint ?? null,
  };
}

/** Start (or re-open) a qualification run. */
export function startQualificationRun(
  deps: QualificationDeps,
  request: StartRunRequest,
): DogfoodRun {
  const now = deps.clock().toISOString();
  const runId = request.runId ?? `qual-${deps.idFactory()}`;
  const existing = readDogfoodRun(deps.workspace, runId);
  if (existing !== undefined) {
    throw new OrchestrationError('SBO052', `Qualification run "${runId}" already exists.`, {
      remediation: [
        'Resume it with `specbridge orchestrate qualify run --run-id <id>`.',
        'Start a new iteration instead of reusing an id.',
      ],
    });
  }

  const previous =
    request.previousRunId === undefined || request.previousRunId === null
      ? undefined
      : readDogfoodRun(deps.workspace, request.previousRunId);

  const run = dogfoodRunSchema.parse({
    schemaVersion: DOGFOOD_RUN_SCHEMA_VERSION,
    runId,
    status: 'PREFLIGHT',
    profile: request.profile,
    target: request.target,
    versions: collectVersions(deps.config, request.versions ?? {}),
    configurationFingerprint: configurationFingerprint(deps.config),
    missionId: request.missionId ?? null,
    jobId: request.jobId ?? null,
    iteration: previous === undefined ? 1 : previous.iteration + 1,
    previousRunId: request.previousRunId ?? null,
    missionDirection: request.missionDirection ?? null,
    approvedScope: [...(request.approvedScope ?? [])],
    scopeChanges: [],
    startedAt: now,
    updatedAt: now,
    finalizedAt: null,
    activeMs: 0,
    pausedMs: 0,
    note: null,
  } satisfies Record<string, unknown>);

  return writeDogfoodRun(deps.workspace, run);
}

/** The next iteration of an existing run series, against the same target. */
export function nextIteration(
  deps: QualificationDeps,
  previousRunId: string,
  overrides: Partial<StartRunRequest> = {},
): DogfoodRun {
  const previous = requireDogfoodRun(deps.workspace, previousRunId);
  return startQualificationRun(deps, {
    profile: overrides.profile ?? previous.profile,
    target: overrides.target ?? previous.target,
    ...(overrides.versions !== undefined ? { versions: overrides.versions } : {}),
    missionId: overrides.missionId ?? previous.missionId,
    jobId: overrides.jobId ?? previous.jobId,
    missionDirection: overrides.missionDirection ?? previous.missionDirection,
    approvedScope: overrides.approvedScope ?? previous.approvedScope,
    previousRunId,
    ...(overrides.runId !== undefined ? { runId: overrides.runId } : {}),
  });
}

function transition(
  deps: QualificationDeps,
  runId: string,
  status: DogfoodRunStatus,
  note?: string,
): DogfoodRun {
  const run = requireDogfoodRun(deps.workspace, runId);
  if (isFinalDogfoodRunStatus(run.status)) {
    throw new OrchestrationError(
      'SBO052',
      `Qualification run "${runId}" is already ${run.status} and cannot transition to ${status}.`,
    );
  }
  const now = deps.clock();
  const elapsed = Math.max(0, now.getTime() - Date.parse(run.updatedAt));
  // Time spent in PAUSED is paused time; everything else is active. A run
  // that is deliberately stopped overnight must not report twelve hours of
  // execution, or the autonomy report reads as a performance claim it never
  // measured.
  const activeMs = run.status === 'PAUSED' ? run.activeMs : run.activeMs + elapsed;
  const pausedMs = run.status === 'PAUSED' ? run.pausedMs + elapsed : run.pausedMs;

  return writeDogfoodRun(deps.workspace, {
    ...run,
    status,
    activeMs,
    pausedMs,
    updatedAt: now.toISOString(),
    finalizedAt: isFinalDogfoodRunStatus(status) ? now.toISOString() : run.finalizedAt,
    note: note ?? run.note,
  });
}

export function markRunRunning(deps: QualificationDeps, runId: string, note?: string): DogfoodRun {
  return transition(deps, runId, 'RUNNING', note);
}

/**
 * Pause deliberately.
 *
 * A pause is an operator decision, not a worker outcome. Nothing here writes
 * an attempt, a failure, or a reliability observation — poisoning adaptive
 * or reliability history with operator-requested stops would make every
 * later placement decision worse for a reason nobody could find.
 */
export function pauseRun(deps: QualificationDeps, runId: string, note?: string): DogfoodRun {
  return transition(deps, runId, 'PAUSED', note ?? 'Paused by the operator.');
}

export function resumeRun(deps: QualificationDeps, runId: string, note?: string): DogfoodRun {
  return transition(deps, runId, 'RUNNING', note ?? 'Resumed by the operator.');
}

export function completeRun(deps: QualificationDeps, runId: string, note?: string): DogfoodRun {
  return transition(deps, runId, 'COMPLETED', note);
}

export function abandonRun(deps: QualificationDeps, runId: string, note: string): DogfoodRun {
  return transition(deps, runId, 'ABANDONED', note);
}

/** Bind the Mission and Job this run dogfoods. */
export function bindRunSubject(
  deps: QualificationDeps,
  runId: string,
  subject: { missionId?: string | null; jobId?: string | null },
): DogfoodRun {
  const run = requireDogfoodRun(deps.workspace, runId);
  return writeDogfoodRun(deps.workspace, {
    ...run,
    missionId: subject.missionId === undefined ? run.missionId : subject.missionId,
    jobId: subject.jobId === undefined ? run.jobId : subject.jobId,
    updatedAt: deps.clock().toISOString(),
  });
}

/** Record the target's ending state once the Mission stops. */
export function recordTargetOutcome(
  deps: QualificationDeps,
  runId: string,
  outcome: { endingCommit?: string | null; branch?: string | null; worktreePath?: string | null },
): DogfoodRun {
  const run = requireDogfoodRun(deps.workspace, runId);
  return writeDogfoodRun(deps.workspace, {
    ...run,
    target: {
      ...run.target,
      endingCommit: outcome.endingCommit ?? run.target.endingCommit,
      branch: outcome.branch ?? run.target.branch,
      worktreePath: outcome.worktreePath ?? run.target.worktreePath,
    },
    updatedAt: deps.clock().toISOString(),
  });
}

/**
 * Record a Mission scope change with its provenance.
 *
 * The whole point is that a reduced Mission cannot later be reported as
 * though it were the original: the original scope text travels with the
 * change, and the report prints both.
 */
export function recordScopeChange(
  deps: QualificationDeps,
  runId: string,
  change: {
    originalScope: string;
    newScope: string;
    reason: string;
    authority: string;
    effectOnQualification: string;
  },
): DogfoodRun {
  const run = requireDogfoodRun(deps.workspace, runId);
  return writeDogfoodRun(deps.workspace, {
    ...run,
    scopeChanges: [...run.scopeChanges, { at: deps.clock().toISOString(), ...change }],
    updatedAt: deps.clock().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Recording observations
// ---------------------------------------------------------------------------

export interface RecordScenarioInput {
  runId: string;
  scenarioId: string;
  status: ScenarioResultStatus;
  executor: string;
  skipReason?: string | undefined;
  failureDetail?: string | undefined;
  observedTransitions?: ScenarioResult['observedTransitions'] | undefined;
  evidenceRefs?: readonly string[] | undefined;
  resourceAttribution?: Partial<Record<QualificationResource, ResourceAttribution>> | undefined;
  durationMs?: number | null | undefined;
}

/**
 * Record one scenario outcome.
 *
 * The scenario must exist in the matrix, and a skip must carry a reason. Both
 * are enforced here rather than left to callers: a result for an unknown
 * scenario would be coverage nobody could audit, and a reasonless skip is
 * how "we did not run it" quietly becomes "it does not apply".
 */
export function recordScenarioResult(
  deps: QualificationDeps,
  input: RecordScenarioInput,
): ScenarioResult {
  const scenario = findScenario(input.scenarioId);
  if (scenario === undefined) {
    throw new OrchestrationError(
      'SBO052',
      `Unknown qualification scenario "${input.scenarioId}".`,
      { remediation: ['Scenario ids come from the qualification matrix.'] },
    );
  }
  if (input.status === 'SKIPPED_WITH_REASON' && (input.skipReason ?? '').trim().length === 0) {
    throw new OrchestrationError(
      'SBO052',
      `Scenario "${input.scenarioId}" was skipped without a reason.`,
      { remediation: ['A skipped scenario must record why it was skipped.'] },
    );
  }
  if (input.status === 'FAIL' && (input.failureDetail ?? '').trim().length === 0) {
    throw new OrchestrationError(
      'SBO052',
      `Scenario "${input.scenarioId}" failed without a recorded detail.`,
      { remediation: ['A failed scenario must record what was expected and what was observed.'] },
    );
  }

  return writeScenarioResult(deps.workspace, {
    schemaVersion: '1.0.0',
    runId: input.runId,
    scenarioId: scenario.id,
    area: scenario.area,
    executionKind: scenario.executionKind,
    requirement: scenario.requirement,
    status: input.status,
    skipReason: input.skipReason ?? null,
    failureDetail: input.failureDetail ?? null,
    faultClasses: [...scenario.faultClasses],
    expectedInvariant: scenario.invariant,
    observedTransitions: [...(input.observedTransitions ?? [])],
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    resourceAttribution: { ...(input.resourceAttribution ?? {}) },
    executor: input.executor,
    durationMs: input.durationMs ?? null,
    recordedAt: deps.clock().toISOString(),
  });
}

export interface RecordInterventionInput {
  runId: string;
  kind: HumanInterventionKind;
  description: string;
  reason: string;
  jobId?: string | null | undefined;
  nodeId?: string | null | undefined;
  taskId?: string | null | undefined;
  policyBoundary?: string | null | undefined;
  evidenceRefs?: readonly string[] | undefined;
}

/**
 * Record a human intervention.
 *
 * `REQUIRED_BY_POLICY` requires a named boundary. Without that rule the most
 * consequential distinction in the whole autonomy report — governance
 * working versus autonomy failing — would rest on the recorder's choice of
 * adjective.
 */
export function recordHumanIntervention(
  deps: QualificationDeps,
  input: RecordInterventionInput,
): HumanIntervention {
  if (
    input.kind === 'REQUIRED_BY_POLICY' &&
    (input.policyBoundary ?? '').trim().length === 0
  ) {
    throw new OrchestrationError(
      'SBO052',
      'A policy-required intervention must name the governance boundary that required it.',
      {
        remediation: [
          'Record the decision kind, approval gate, or spend mode that made a human necessary.',
          'If no boundary required it, the intervention belongs to another classification.',
        ],
      },
    );
  }
  return writeHumanIntervention(deps.workspace, {
    schemaVersion: '1.0.0',
    runId: input.runId,
    interventionId: `hi-${deps.idFactory()}`,
    kind: input.kind,
    at: deps.clock().toISOString(),
    description: input.description,
    reason: input.reason,
    jobId: input.jobId ?? null,
    nodeId: input.nodeId ?? null,
    taskId: input.taskId ?? null,
    policyBoundary: input.policyBoundary ?? null,
    evidenceRefs: [...(input.evidenceRefs ?? [])],
  });
}

/**
 * Declared field by field rather than as an `Omit` of `InvariantAudit`:
 * the state schemas are `passthrough`, so their inferred types carry an
 * index signature and `Omit` erases the named properties into `unknown`.
 */
export interface RecordAuditInput {
  runId: string;
  phase: InvariantAudit['phase'];
  jobId: string | null;
  checked: InvariantAudit['checked'];
  violations: InvariantAudit['violations'];
  note: string | null;
  auditId?: string | undefined;
  at?: string | undefined;
}

export function recordInvariantAudit(
  deps: QualificationDeps,
  audit: RecordAuditInput,
): InvariantAudit {
  return writeInvariantAudit(deps.workspace, {
    schemaVersion: '1.0.0',
    runId: audit.runId,
    auditId: audit.auditId ?? `au-${deps.idFactory()}`,
    phase: audit.phase,
    jobId: audit.jobId,
    at: audit.at ?? deps.clock().toISOString(),
    checked: audit.checked,
    violations: audit.violations,
    note: audit.note,
  });
}

export interface RecordDefectInput {
  runId: string;
  source: DogfoodDefect['source'];
  observedFailure: string;
  rootCause?: string | null | undefined;
  affectedInvariant?: string | null | undefined;
  fix?: string | null | undefined;
  regressionTest?: string | null | undefined;
  changesPublicContract?: boolean | undefined;
  affectsPriorPhaseGuarantee?: boolean | undefined;
  blocking?: boolean | undefined;
  defectId?: string | undefined;
  resolved?: boolean | undefined;
}

export function recordDogfoodDefect(
  deps: QualificationDeps,
  input: RecordDefectInput,
): DogfoodDefect {
  const now = deps.clock().toISOString();
  return writeDogfoodDefect(deps.workspace, {
    schemaVersion: '1.0.0',
    runId: input.runId,
    defectId: input.defectId ?? `df-${deps.idFactory()}`,
    source: input.source,
    observedFailure: input.observedFailure,
    rootCause: input.rootCause ?? null,
    affectedInvariant: input.affectedInvariant ?? null,
    fix: input.fix ?? null,
    regressionTest: input.regressionTest ?? null,
    changesPublicContract: input.changesPublicContract ?? false,
    affectsPriorPhaseGuarantee: input.affectsPriorPhaseGuarantee ?? false,
    blocking: input.blocking ?? false,
    discoveredAt: now,
    resolvedAt: input.resolved === true ? now : null,
  });
}

/** Every run in the workspace, newest first. */
export function listRuns(workspace: WorkspaceInfo): DogfoodRun[] {
  return listDogfoodRuns(workspace);
}
