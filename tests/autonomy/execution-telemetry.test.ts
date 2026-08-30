import { describe, expect, it } from 'vitest';
import { defaultResolvedAgentConfig, sha256Hex } from '@specbridge/core';
import {
  builderRoutingStateSchema,
  emptyResearchTelemetry,
  executionLedgerEntrySchema,
  jobStateSchema,
  objectiveCooldownStateSchema,
  workGraphSchema,
  workUnitSchema,
  type BuilderAttemptKind,
  type BuilderRoutingAttempt,
  type BuilderRoutingState,
  type SecondaryEligibilityStatus,
  type WorkUnit,
} from '@specbridge/orchestration';
import {
  autonomyTelemetrySchema,
  closureLedgerSchema,
  compareExecutionTelemetryReports,
  deriveExecutionTelemetryReport,
  executionTelemetryReportSchema,
  type ExecutionTelemetryFacts,
} from '@specbridge/autonomy';

const CREATED = '2026-08-30T00:00:00.000Z';
const FINISHED = '2026-08-30T03:00:00.000Z';
const config = defaultResolvedAgentConfig();

function unit(index: number): WorkUnit {
  return workUnitSchema.parse({
    workUnitId: `wu-${index}`,
    objectiveNodeId: 'node-1',
    parentTaskId: '1',
    kind: 'build',
    title: `Implement unit ${index}`,
    goal: `Complete deterministic fixture unit ${index}`,
    status: 'INTEGRATED',
    attempt: 1,
    integratedAt: '2026-08-30T02:00:00.000Z',
  });
}

function attempt(
  workUnitId: string,
  sequence: number,
  kind: BuilderAttemptKind,
  outcome: BuilderRoutingAttempt['outcome'],
  tokens?: { input: number | null; output: number | null },
): BuilderRoutingAttempt {
  return {
    attemptId: `${workUnitId}-${kind.toLowerCase()}-${sequence}`,
    sequence,
    workUnitAttempt: sequence,
    kind,
    outcome,
    changedFiles: [`src/${workUnitId}.ts`],
    verificationSummary: outcome === 'FAILED_VERIFICATION' ? ['unit: failed'] : [],
    noProgress: false,
    inputTokens: tokens?.input ?? null,
    outputTokens: tokens?.output ?? null,
    startedAt: `2026-08-30T00:${String(sequence).padStart(2, '0')}:00.000Z`,
    completedAt: `2026-08-30T00:${String(sequence + 1).padStart(2, '0')}:00.000Z`,
  };
}

function routing(
  index: number,
  eligibility: SecondaryEligibilityStatus,
  chain: readonly [BuilderAttemptKind, BuilderRoutingAttempt['outcome']][],
): BuilderRoutingState {
  const attempts = chain.map(([kind, outcome], attemptIndex) =>
    attempt(`wu-${index}`, attemptIndex + 1, kind, outcome));
  const last = attempts.at(-1);
  return builderRoutingStateSchema.parse({
    schemaVersion: '1.0.0',
    jobId: 'job-phase-9',
    objectiveNodeId: 'node-1',
    workUnitId: `wu-${index}`,
    workIdentity: sha256Hex(`work-${index}`),
    strategy: 'PREFER',
    initialEligibility: eligibility,
    decisions: [],
    attempts,
    repairAttemptsUsed: attempts.filter((entry) => entry.kind === 'SECONDARY_REPAIR').length,
    maxRepairAttempts: 1,
    escalationStatus: last?.outcome === 'SUCCEEDED' ? 'COMPLETE' : 'FAILED',
    finalBackend:
      last?.kind === 'SECONDARY' || last?.kind === 'SECONDARY_REPAIR' ? 'SECONDARY' : 'STRONG',
    createdAt: CREATED,
    updatedAt: FINISHED,
    contentHash: sha256Hex(`routing-${index}`),
  });
}

function mixedFacts(): ExecutionTelemetryFacts {
  const units = Array.from({ length: 20 }, (_, index) => unit(index + 1));
  const states: BuilderRoutingState[] = [];
  for (let index = 1; index <= 8; index += 1) {
    states.push(routing(index, 'ELIGIBLE', [['SECONDARY', 'SUCCEEDED']]));
  }
  for (let index = 9; index <= 10; index += 1) {
    states.push(routing(index, 'ELIGIBLE', [
      ['SECONDARY', 'FAILED_VERIFICATION'],
      ['SECONDARY_REPAIR', 'SUCCEEDED'],
    ]));
  }
  for (let index = 11; index <= 12; index += 1) {
    states.push(routing(index, 'ELIGIBLE', [
      ['SECONDARY', 'FAILED_VERIFICATION'],
      ['SECONDARY_REPAIR', 'FAILED_VERIFICATION'],
      ['STRONG_FALLBACK', 'SUCCEEDED'],
    ]));
  }
  for (let index = 13; index <= 20; index += 1) {
    states.push(routing(index, 'STRONG_REQUIRED', [['STRONG', 'SUCCEEDED']]));
  }

  const research = emptyResearchTelemetry(new Date(FINISHED));
  research.gateConsidered = 10;
  research.researchAvoided = 8;
  research.researchAvoidanceRatio = 0.8;
  research.decisions.ANSWER_DIRECTLY = 4;
  research.decisions.ENGINEERING_DECISION = 2;
  research.decisions.REUSE_EXISTING = 2;
  research.decisions.RESEARCH_QUICK = 1;
  research.decisions.RESEARCH_DEEP = 1;
  research.providerCalls = 2;
  research.successfulResearch = 2;
  research.reusedReports = 3;
  research.newQuick = 1;
  research.newDeep = 1;
  research.byPhase.RUNTIME_INVESTIGATION = {
    considered: 10,
    avoided: 8,
    reused: 3,
    newQuick: 1,
    newDeep: 1,
  };

  return {
    job: jobStateSchema.parse({
      schemaVersion: '1.0.0',
      jobId: 'job-phase-9',
      specName: 'phase-9',
      status: 'COMPLETED',
      goal: 'Qualify Phase 9 telemetry',
      createdAt: CREATED,
      updatedAt: FINISHED,
      finalizedAt: FINISHED,
      finalOutcome: 'completed',
      latestEvidence: {
        taskId: '1',
        runId: 'run-qualified',
        evidenceStatus: 'verified',
        at: FINISHED,
      },
      host: 'test',
      policyFingerprint: 'fixture-policy',
      budgets: {
        maxAgentRuns: 100,
        maxTaskAttempts: 10,
        maxRepairCyclesPerTask: 2,
        maxReplansPerTask: 2,
        maxJobReplans: 2,
        maxNoProgressCycles: 2,
        maxTransientRetries: 2,
        maxWallClockMs: 86_400_000,
        maxLocalInferenceCalls: 100,
        maxEvents: 1_000,
      },
      graphRevision: 1,
    }),
    events: [],
    eventTotal: 0,
    ledger: [executionLedgerEntrySchema.parse({
      attemptId: 'strong-evaluator-1',
      jobId: 'job-phase-9',
      nodeId: 'node-1',
      taskId: '1',
      role: 'EVALUATOR',
      provider: 'strong-provider',
      model: 'strong-model',
      lane: 'SUBSCRIPTION',
      status: 'COMPLETED',
      attemptNumber: 1,
      startedAt: CREATED,
      completedAt: FINISHED,
      success: true,
      failureReason: null,
      metrics: { inputTokens: 100, outputTokens: 20 },
    })],
    objectives: [{
      objectiveNodeId: 'node-1',
      graph: workGraphSchema.parse({
        schemaVersion: '1.0.0',
        jobId: 'job-phase-9',
        objectiveNodeId: 'node-1',
        parentTaskId: '1',
        objectiveFingerprint: sha256Hex('objective'),
        revision: 1,
        createdAt: CREATED,
        proposedBy: 'fixture',
        units,
      }),
      // Replaying the first state models a resume reading overlapping durable
      // history. Attempt IDs, not array position, define uniqueness.
      routingStates: [...states, states[0]!],
      cooldown: objectiveCooldownStateSchema.parse({
        schemaVersion: '1.0.0',
        jobId: 'job-phase-9',
        objectiveNodeId: 'node-1',
        resourceClass: 'STRONG_SUBSCRIPTION',
        resourceIdentity: 'subscription:strong',
        status: 'RECOVERED',
        episodes: 1,
        firstStartedAt: '2026-08-30T00:30:00.000Z',
        lastEndedAt: '2026-08-30T01:30:00.000Z',
        lastAvailability: 'AVAILABLE',
        lastObservedAt: '2026-08-30T01:30:00.000Z',
        completedBeforeCurrentCooldown: [],
        completedDuringCooldown: ['wu-1', 'wu-2', 'wu-3', 'wu-4', 'wu-5', 'wu-6'],
        waitingWorkUnitIds: [],
        updatedAt: FINISHED,
        contentHash: sha256Hex('cooldown'),
      }),
      evaluations: [],
    }],
    researchTelemetry: research,
    researchRecords: [],
    researchUses: [],
    autonomy: autonomyTelemetrySchema.parse({
      schemaVersion: '1.0.0',
      jobId: 'job-phase-9',
      recordedAt: FINISHED,
      jobStatus: 'COMPLETED',
      humanInterventionsAfterSeal: 0,
      humanAuthorityEscalations: 0,
      humanAuthorityEscalationsAfterSeal: 0,
      boundaryStartedAt: CREATED,
      autonomousRecoveryCount: 0,
      providerFailovers: 0,
      providerFailures: 0,
      quotaWaits: 1,
      contextRollovers: 0,
      toolsmithActions: 0,
      selfCreatedTools: 0,
      toolchainRepairs: 0,
      environmentRepairs: 0,
      controlPlaneRepairs: 0,
      gapClosureCycles: 0,
      systemQualificationCycles: 0,
      browserScenariosRun: 0,
      uxCritiquesRun: 0,
      driverRestarts: 0,
      supervisorWakeups: 1,
      elapsedWallTimeMs: 10_800_000,
      reportedTokens: null,
      reportedCostUsd: null,
      contractClosureRatio: null,
    }),
    closure: closureLedgerSchema.parse({
      schemaVersion: '1.0.0',
      jobId: 'job-phase-9',
      sealId: 'seal-phase-9',
      missionId: 'mission-phase-9',
      createdAt: CREATED,
      updatedAt: FINISHED,
      phase: 'COMPLETE',
      entries: [{
        itemId: 'CTR-001/R1',
        kind: 'requirement',
        statement: 'The qualification fixture completes correctly.',
        status: 'VERIFIED',
        evidence: [{
          kind: 'TRUSTED_VERIFICATION',
          ref: 'run-qualified',
          passed: true,
          recordedAt: FINISHED,
        }],
        updatedAt: FINISHED,
      }],
      reproducibilityPassed: true,
      releaseQualificationPassed: true,
    }),
    generatedAt: FINISHED,
    secondaryBuildStrategy: 'PREFER',
    researchStrategy: 'AUTO',
    runnerProfiles: ['mock'],
    currentAutonomyPolicy: config.autonomy,
    closurePolicy: config.autonomy.closure,
  };
}

describe('Phase 9 execution telemetry qualification', () => {
  it('derives the exact mixed-route ratios and excludes Strong evaluators from builder calls', () => {
    const report = deriveExecutionTelemetryReport(mixedFacts());

    expect(executionTelemetryReportSchema.parse(report)).toEqual(report);
    expect(report.work.total).toBe(20);
    expect(Object.values(report.work.accounting).reduce((sum, value) => sum + value, 0)).toBe(20);
    expect(report.work.objectives).toEqual([expect.objectContaining({
      objectiveNodeId: 'node-1',
      total: 20,
      implementationAttempts: 26,
      secondaryAttempts: 16,
      strongBuilderAttempts: 10,
    })]);
    expect(report.secondary.eligibility).toMatchObject({ eligible: 12, ineligible: 8, strongRequired: 8 });
    expect(report.efficiency.strongBuilderAvoidanceRatio).toEqual({
      numerator: 10,
      denominator: 12,
      value: 10 / 12,
    });
    expect(report.secondary.initialSuccessRate.value).toBe(8 / 12);
    expect(report.secondary.repairRecoveryRate.value).toBe(2 / 4);
    expect(report.secondary.toStrongFallbackRate.value).toBe(2 / 12);
    expect(report.strong.builderAttempts).toBe(10);
    expect(report.strong.evaluatorAttempts).toBe(1);
    expect(report.attempts.uniqueImplementationAttempts).toBe(26);
    expect(report.diagnostics.map((entry) => entry.code)).toContain('ATTEMPT_REPLAY_DEDUPLICATED');
  });

  it('preserves unknown token usage while reporting evaluator coverage separately', () => {
    const report = deriveExecutionTelemetryReport(mixedFacts());

    expect(report.secondary.builderTokens.completeTokens).toBeNull();
    expect(report.secondary.builderTokens.knownTokens).toBeNull();
    expect(report.secondary.builderTokens.coverage.ratio).toBe(0);
    expect(report.strong.implementationTokens.completeTokens).toBeNull();
    expect(report.strong.evaluatorTokens).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      completeTokens: 120,
      coverage: { ratio: 1, complete: true },
    });
  });

  it('reports partial provider usage as known components without inventing a complete total', () => {
    const facts = mixedFacts();
    const objective = facts.objectives[0]!;
    const first = objective.routingStates[0]!;
    objective.routingStates = [
      builderRoutingStateSchema.parse({
        ...first,
        attempts: [{ ...first.attempts[0]!, inputTokens: 321, outputTokens: null }],
        contentHash: sha256Hex('routing-partial-token-coverage'),
      }),
      ...objective.routingStates.slice(1),
    ];
    const report = deriveExecutionTelemetryReport(facts);

    expect(report.secondary.builderTokens).toMatchObject({
      inputTokens: 321,
      outputTokens: null,
      knownTokens: 321,
      completeTokens: null,
      coverage: { attempts: 16, withAny: 1, withInput: 1, withOutput: 0, complete: false },
    });
    expect(report.secondary.builderTokens.coverage.ratio).toBe(1 / 16);
  });

  it('uses labeled workspace research aggregates and records cooldown productivity', () => {
    const report = deriveExecutionTelemetryReport(mixedFacts());

    expect(report.research).toMatchObject({
      scope: 'WORKSPACE',
      considered: 10,
      providerCalls: 2,
      successful: 2,
      priorResearchReused: 3,
      newQuick: 1,
      newDeep: 1,
      avoidanceRatio: { numerator: 8, denominator: 10, value: 0.8 },
      reuseRate: { numerator: 3, denominator: 5, value: 0.6 },
      usage: { inputTokens: null, outputTokens: null, coverage: 0 },
    });
    expect(report.cooldown.usefulWorkDuringSubscriptionCooldown).toBe(6);
    expect(report.research.decisions).toMatchObject({
      ANSWER_DIRECTLY: 4,
      ENGINEERING_DECISION: 2,
      REUSE_EXISTING: 2,
      RESEARCH_QUICK: 1,
      RESEARCH_DEEP: 1,
    });
    expect(report.qualificationSummary.newResearchCalls).toBe(2);
  });

  it('compares a deterministic Strong-only replay without claiming statistical significance', () => {
    const mixed = deriveExecutionTelemetryReport(mixedFacts());
    const strongFacts = mixedFacts();
    const objective = strongFacts.objectives[0]!;
    objective.routingStates = Array.from({ length: 20 }, (_, index) =>
      routing(
        index + 1,
        index < 12 ? 'ELIGIBLE' : 'STRONG_REQUIRED',
        [['STRONG', 'SUCCEEDED']],
      ));
    const strongOnly = deriveExecutionTelemetryReport(strongFacts);
    const comparison = compareExecutionTelemetryReports(strongOnly, mixed);

    expect(comparison).toMatchObject({
      strongBuilderAttempts: { strongOnly: 20, mixed: 10, avoided: 10 },
      secondaryBuilderAttempts: { strongOnly: 0, mixed: 12 },
      acceptanceEqual: true,
      verificationEqual: true,
      closureEqual: true,
      evidenceAvailable: true,
      correctnessEqual: true,
      qualificationOnly: true,
    });
  });

  it('detects avoidable idle when eligible READY work is ignored during an active cooldown', () => {
    const facts = mixedFacts();
    const objective = facts.objectives[0]!;
    const firstUnit = objective.graph!.units[0]!;
    objective.graph = workGraphSchema.parse({
      ...objective.graph,
      units: [
        workUnitSchema.parse({ ...firstUnit, status: 'READY', integratedAt: undefined }),
        ...objective.graph!.units.slice(1),
      ],
    });
    const priorRouting = objective.routingStates.find((entry) => entry.workUnitId === 'wu-1')!;
    const idleRouting = builderRoutingStateSchema.parse({
      ...priorRouting,
      attempts: [],
      repairAttemptsUsed: 0,
      escalationStatus: 'NONE',
      finalBackend: undefined,
      contentHash: sha256Hex('idle-routing'),
    });
    objective.routingStates = [
      idleRouting,
      ...objective.routingStates.filter((entry) => entry.workUnitId !== 'wu-1'),
    ];
    objective.cooldown = objectiveCooldownStateSchema.parse({
      ...objective.cooldown,
      status: 'ACTIVE',
      currentStartedAt: '2026-08-30T00:30:00.000Z',
      lastAvailability: 'COOLDOWN',
      completedDuringCooldown: ['wu-2', 'wu-3', 'wu-4', 'wu-5', 'wu-6'],
      contentHash: sha256Hex('active-cooldown'),
    });

    const report = deriveExecutionTelemetryReport(facts);
    expect(report.cooldown.episodes).toBe(1);
    expect(report.cooldown.avoidableIdlePeriods).toBe(1);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'AVOIDABLE_IDLE_DURING_COOLDOWN',
      severity: 'warning',
    }));
  });

  it('separates legitimate authority from a post-seal operational intervention', () => {
    const facts = mixedFacts();
    facts.autonomy = autonomyTelemetrySchema.parse({
      ...facts.autonomy,
      humanInterventionsAfterSeal: 1,
      humanAuthorityEscalations: 1,
      humanAuthorityEscalationsAfterSeal: 1,
      interventions: [{
        at: '2026-08-30T01:00:00.000Z',
        kind: 'job_blocked',
        detail: 'manual resume was required',
      }],
    });

    const report = deriveExecutionTelemetryReport(facts);
    expect(report.human).toMatchObject({
      authorityEscalationsAfterSeal: 1,
      interventionsAfterSeal: 1,
      zeroTouchAfterSeal: false,
    });
    expect(report.reliability.unexpectedBlocks).toBe(1);
  });

  it('reports completed-work redo regressions and candidate reuse independently', () => {
    const facts = mixedFacts();
    const objective = facts.objectives[0]!;
    objective.graph = workGraphSchema.parse({
      ...objective.graph,
      units: objective.graph!.units.map((entry) =>
        entry.workUnitId === 'wu-1'
          ? workUnitSchema.parse({ ...entry, integratedAt: CREATED })
          : entry),
    });
    objective.cooldown = objectiveCooldownStateSchema.parse({
      ...objective.cooldown,
      candidateReuseAfterRestart: 2,
      contentHash: sha256Hex('candidate-reuse'),
    });

    const report = deriveExecutionTelemetryReport(facts);
    expect(report.reliability.completedWorkRedoCount).toBe(1);
    expect(report.reliability.candidatesReusedAfterRestart).toBe(2);
    expect(report.reliability.candidateRebuildsAfterRestart).toBe(0);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPLETED_WORK_REDONE' }));
  });

  it('keeps quota, environment, verification, and model-output failure sources distinct', () => {
    const facts = mixedFacts();
    const template = facts.ledger[0]!;
    facts.ledger = ['QUOTA', 'ENVIRONMENT', 'VERIFICATION', 'MODEL_OUTPUT'].map((failureSource, index) =>
      executionLedgerEntrySchema.parse({
        ...template,
        attemptId: `failed-ledger-${index}`,
        role: 'EXECUTOR',
        status: 'FAILED',
        success: false,
        failureReason: failureSource.toLowerCase(),
        failureSource,
        recoveryAction: index === 0 ? 'WAIT_FOR_RESOURCE' : 'RETRY',
      }));

    const report = deriveExecutionTelemetryReport(facts);
    expect(report.reliability.failureSources).toMatchObject({
      QUOTA: 1,
      ENVIRONMENT: 1,
      VERIFICATION: 1,
      MODEL_OUTPUT: 1,
    });
    expect(report.reliability.recoveryActions).toMatchObject({ WAIT_FOR_RESOURCE: 1, RETRY: 3 });
  });

  it('is deterministic for the same durable facts and emits no credential-shaped content', () => {
    const facts = mixedFacts();
    facts.researchTelemetryDiagnostic =
      'provider failed with Authorization: Bearer super-secret-token and api_key=also-secret';
    facts.job.finalOutcome = 'completed after Authorization: Bearer final-outcome-secret';
    const first = deriveExecutionTelemetryReport(facts);
    const second = deriveExecutionTelemetryReport(facts);
    const serialized = JSON.stringify(first);

    expect(second).toEqual(first);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('also-secret');
    expect(serialized).not.toContain('final-outcome-secret');
    expect(serialized).toContain('[REDACTED]');
    expect(first.human.zeroTouchAfterSeal).toBe(true);
    expect(first.reliability.completedWorkRedoCount).toBe(0);
  });
});
