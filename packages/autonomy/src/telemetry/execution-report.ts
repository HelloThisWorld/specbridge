import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertInsideWorkspace,
  autonomyPolicyFingerprint,
  sha256Hex,
  writeFileAtomic,
  type AutonomyPolicy,
  type ClosurePolicy,
  type WorkspaceInfo,
} from '@specbridge/core';
import {
  listObjectiveNodes,
  listResearchRecords,
  listResearchUseRecords,
  readBuilderRoutingStates,
  readEvaluations,
  readExecutionLedger,
  readJobEvents,
  readLatestWorkGraph,
  readObjectiveCooldownState,
  readResearchTelemetry,
  requireJobState,
  workedMsOf,
  type BuilderRoutingAttempt,
  type BuilderRoutingState,
  type EvaluationRecord,
  type ExecutionLedgerEntry,
  type JobEvent,
  type JobState,
  type ObjectiveCooldownState,
  type ResearchRecord,
  type ResearchTelemetry,
  type ResearchUseRecord,
  type WorkGraph,
  type WorkUnit,
} from '@specbridge/orchestration';
import { z } from 'zod';
import type { AutonomyDeps } from '../deps.js';
import { nowIso } from '../deps.js';
import { closureRatio, missionMayComplete, summarizeClosure } from '../closure/oracle.js';
import type { ClosureLedger } from '../closure/state.js';
import { readClosureLedger } from '../closure/service.js';
import type { MissionSeal, SealBinding } from '../seal/state.js';
import { readJobSeal, readSealBinding } from '../seal/service.js';
import {
  deriveAutonomyTelemetry,
  type AutonomyTelemetry,
} from './telemetry.js';

/** Stable public-ish contract consumed by CLI, MCP, and Phase 10 qualification. */
export const EXECUTION_TELEMETRY_REPORT_SCHEMA_VERSION = '1.0.0';

const count = z.number().int().min(0);
const shortText = z.string().max(512);
const boundedText = z.string().max(2_000);
const ratio = z.number().min(0).max(1).nullable();
const countMap = z.record(z.string(), count);

export const fractionMetricSchema = z.object({
  numerator: count.nullable(),
  denominator: count.nullable(),
  value: ratio,
}).strict();
export type FractionMetric = z.infer<typeof fractionMetricSchema>;

export const tokenCoverageSchema = z.object({
  attempts: count,
  withAny: count,
  withInput: count,
  withOutput: count,
  ratio,
  complete: z.boolean(),
}).strict();

export const tokenTelemetrySchema = z.object({
  /** Sum of every reported input-token field; null when none reported. */
  inputTokens: count.nullable(),
  /** Sum of every reported output-token field; null when none reported. */
  outputTokens: count.nullable(),
  /** Sum of known components, even when coverage is partial. */
  knownTokens: count.nullable(),
  /** Total only when every attempt reported both components. */
  completeTokens: count.nullable(),
  coverage: tokenCoverageSchema,
}).strict();
export type TokenTelemetry = z.infer<typeof tokenTelemetrySchema>;

const workAccountingSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'waiting',
  'not-ready',
  'human-authority-pending',
  'research-pending',
  'context-pending',
]);

const diagnosticSchema = z.object({
  code: shortText,
  severity: z.enum(['info', 'warning', 'error']),
  message: boundedText,
  evidenceRefs: z.array(shortText).max(20).default([]),
}).strict();

const phaseResearchSchema = z.object({
  considered: count,
  avoided: count,
  reused: count,
  newCalls: count,
  quick: count,
  deep: count,
  failed: count,
}).strict();

export const executionTelemetryReportSchema = z.object({
  schemaVersion: z.literal(EXECUTION_TELEMETRY_REPORT_SCHEMA_VERSION),
  jobId: shortText,
  missionId: shortText.nullable(),
  generatedAt: shortText,
  period: z.object({
    startedAt: shortText,
    endedAt: shortText.nullable(),
    durationMs: count.nullable(),
    activeExecutionMs: count.nullable(),
  }).strict(),
  provenance: z.object({
    sourceJobId: shortText,
    jobGraphRevision: count,
    objectiveGraphRevisions: countMap,
    executionLedgerWatermark: z.string().regex(/^[a-f0-9]{64}$/),
    eventWatermark: count,
    specbridgeVersion: shortText.nullable(),
    sealId: shortText.nullable(),
    sealedAuthorityDigest: shortText.nullable(),
    runtimePolicyChanged: z.boolean().nullable(),
    configuration: z.object({
      secondaryBuildStrategy: shortText,
      researchStrategy: shortText,
      runnerProfiles: z.array(shortText).max(50),
    }).strict(),
  }).strict(),
  outcome: z.object({
    status: z.enum(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'WAITING']),
    authoritativeJobStatus: shortText,
    finalOutcome: boundedText.nullable(),
    verification: z.enum(['PASS', 'FAIL', 'UNAVAILABLE']),
    closure: z.enum(['PASS', 'FAIL', 'UNAVAILABLE']),
  }).strict(),
  work: z.object({
    total: count,
    byKind: countMap,
    accounting: z.record(workAccountingSchema, count),
    completedImplementation: count,
    objectives: z.array(z.object({
      objectiveNodeId: shortText,
      graphRevision: count.nullable(),
      total: count,
      accounting: z.record(workAccountingSchema, count),
      implementationAttempts: count,
      secondaryAttempts: count,
      strongBuilderAttempts: count,
    }).strict()).max(200),
    units: z.array(z.object({
      workUnitId: shortText,
      objectiveNodeId: shortText,
      kind: shortText,
      status: shortText,
      accounting: workAccountingSchema,
      builderPath: z.enum(['SECONDARY', 'SECONDARY_REPAIR', 'STRONG', 'STRONG_FALLBACK', 'NONE', 'UNKNOWN']),
      implementationAttempts: count,
      verification: z.enum(['PASS', 'FAIL', 'PENDING', 'UNAVAILABLE']),
      integration: z.enum(['INTEGRATED', 'NOT_INTEGRATED']),
    }).strict()).max(500),
    omittedUnits: count,
  }).strict(),
  secondary: z.object({
    eligibility: z.object({
      eligible: count,
      ineligible: count,
      strongRequired: count,
      needsResearch: count,
      needsAuthority: count,
      needsContext: count,
      notReady: count,
      unavailable: count,
    }).strict(),
    selection: z.object({
      secondarySelected: count,
      strongSelectedDespiteEligibility: count,
      noBuilderNeeded: count,
      waitingForResource: count,
    }).strict(),
    funnel: z.object({
      initialAttempts: count,
      initialPass: count,
      repairAttempted: count,
      repairPass: count,
      toStrongFallback: count,
      unavailableFallback: count,
    }).strict(),
    initialSuccessRate: fractionMetricSchema,
    repairRecoveryRate: fractionMetricSchema,
    toStrongFallbackRate: fractionMetricSchema,
    fallbackReasons: countMap,
    builderTokens: tokenTelemetrySchema,
  }).strict(),
  strong: z.object({
    builderAttempts: count,
    evaluatorAttempts: count,
    selection: z.object({
      requiredDirect: count,
      byStrategyOff: count,
      byAutoPolicy: count,
      becauseSecondaryUnavailable: count,
      fallbackAfterSecondary: count,
    }).strict(),
    implementationTokens: tokenTelemetrySchema,
    evaluatorTokens: tokenTelemetrySchema,
  }).strict(),
  research: z.object({
    scope: z.enum(['JOB', 'WORKSPACE', 'NONE']),
    considered: count.nullable(),
    decisions: countMap,
    providerCalls: count,
    successful: count,
    inconclusive: count,
    failed: count,
    priorResearchReused: count,
    newQuick: count,
    newDeep: count,
    avoidanceRatio: fractionMetricSchema,
    reuseRate: fractionMetricSchema,
    byPhase: z.record(z.string(), phaseResearchSchema),
    usage: z.object({
      inputTokens: count.nullable(),
      outputTokens: count.nullable(),
      durationMs: count.nullable(),
      providerReportedCost: z.number().min(0).nullable(),
      subagentCount: count.nullable(),
      recordsWithUsage: count,
      providerCalls: count,
      coverage: ratio,
    }).strict(),
  }).strict(),
  cooldown: z.object({
    episodes: count,
    observations: count,
    totalDurationMs: count.nullable(),
    usefulWorkDuringSubscriptionCooldown: count,
    secondaryImplementationWorkDuringCooldown: count,
    researchWorkDuringCooldown: count,
    strongRequiredWaiting: count,
    avoidableIdlePeriods: count,
    intervals: z.array(z.object({
      objectiveNodeId: shortText,
      status: z.enum(['ACTIVE', 'RECOVERED']),
      startedAt: shortText,
      endedAt: shortText.nullable(),
      durationMs: count.nullable(),
      completedWorkUnits: count,
    }).strict()).max(200),
    timeline: z.array(z.object({
      at: shortText,
      type: shortText,
      objectiveNodeId: shortText.nullable(),
      detail: boundedText,
    }).strict()).max(200),
  }).strict(),
  attempts: z.object({
    uniqueImplementationAttempts: count,
    meanPerCompletedWorkUnit: z.number().min(0).nullable(),
    medianPerCompletedWorkUnit: z.number().min(0).nullable(),
    maxPerWorkUnit: count,
    workUnitsWithMultipleAttempts: count,
    byKind: countMap,
    completedWorkUnitsPerImplementationAttempt: z.number().min(0).nullable(),
    completedWorkUnitsPerStrongBuilderCall: z.number().min(0).nullable(),
    completedEligibleWorkUnitsPerSecondaryAttempt: z.number().min(0).nullable(),
  }).strict(),
  verification: z.object({
    attempts: count,
    passes: count,
    failures: count,
    otherVerdicts: count,
    failuresByBuilderBackend: countMap,
    failuresRecoveredByRepair: count,
    failuresRecoveredByStrongFallback: count,
  }).strict(),
  closure: z.object({
    available: z.boolean(),
    items: count,
    earned: count,
    waived: count,
    unresolved: count,
    completionGateOutcome: z.enum(['PASS', 'FAIL', 'UNAVAILABLE']),
    ratio,
  }).strict(),
  human: z.object({
    decisionsBeforeSeal: count.nullable(),
    approvals: count,
    authorityEscalationsAfterSeal: count.nullable(),
    interventionsAfterSeal: count,
    unexpectedBlockersAfterSeal: count,
    zeroTouchAfterSeal: z.boolean(),
    byKind: countMap,
  }).strict(),
  reliability: z.object({
    failureSources: countMap,
    recoveryActions: countMap,
    noProgressDetections: count,
    repeatedProblemFingerprints: count,
    legitimateResourceWaitsExcluded: count,
    processRestarts: count,
    supervisorRestarts: count,
    candidatesPersisted: count,
    candidatesReusedAfterRestart: count,
    candidateRebuildsAfterRestart: count,
    candidatesLostOrUnreadable: count,
    candidateReadyResumes: count,
    integrationRetries: count,
    completedWorkRedoCount: count,
    completedWorkReusedAfterRestart: count,
    attemptsIncorrectlyRepeated: count,
    unexpectedBlocks: count,
    unrecoveredDriverDeaths: count,
  }).strict(),
  efficiency: z.object({
    strongBuilderAvoidanceRatio: fractionMetricSchema,
    strongBuilderCallsAvoided: count,
    completedWorkUnitsPerImplementationAttempt: z.number().min(0).nullable(),
    baseline: z.object({
      kind: z.enum(['OBSERVED', 'QUALIFICATION_FIXTURE']),
      reportId: shortText,
      strongBuilderAttempts: count,
      sameVerificationOutcome: z.boolean(),
      sameClosureOutcome: z.boolean(),
    }).strict().nullable(),
  }).strict(),
  qualificationSummary: z.object({
    strongBuilderAvoidanceRatio: ratio,
    secondaryInitialSuccessRate: ratio,
    secondaryRepairRecoveryRate: ratio,
    secondaryToStrongFallback: count,
    strongImplementationTokens: count.nullable(),
    researchAvoidanceRatio: ratio,
    newResearchCalls: count,
    researchReuse: count,
    usefulWorkDuringSubscriptionCooldown: count,
    humanInterventionsAfterSeal: count,
    completedWorkRedoCount: count,
    unexpectedBlocks: count,
    unrecoveredDriverDeaths: count,
  }).strict(),
  diagnostics: z.array(diagnosticSchema).max(200),
}).strict();

export type ExecutionTelemetryReport = z.infer<typeof executionTelemetryReportSchema>;

export interface ObjectiveTelemetryFacts {
  objectiveNodeId: string;
  graph?: WorkGraph | undefined;
  routingStates: readonly BuilderRoutingState[];
  cooldown?: ObjectiveCooldownState | undefined;
  evaluations: readonly EvaluationRecord[];
}

/**
 * Normalized durable inputs.  The derivation below is pure: callers can load
 * these facts from disk, an archive, or a future query store without changing
 * metric semantics.
 */
export interface ExecutionTelemetryFacts {
  job: JobState;
  events: readonly JobEvent[];
  eventTotal: number;
  ledger: readonly ExecutionLedgerEntry[];
  objectives: readonly ObjectiveTelemetryFacts[];
  researchTelemetry?: ResearchTelemetry | undefined;
  researchTelemetryDiagnostic?: string | undefined;
  researchRecords: readonly ResearchRecord[];
  researchRecordDiagnostics?: readonly { code: string; message: string }[] | undefined;
  researchUses: readonly ResearchUseRecord[];
  autonomy: AutonomyTelemetry;
  closure?: ClosureLedger | undefined;
  binding?: SealBinding | undefined;
  seal?: MissionSeal | undefined;
  generatedAt: string;
  specbridgeVersion?: string | undefined;
  secondaryBuildStrategy: string;
  researchStrategy: string;
  runnerProfiles: readonly string[];
  currentAutonomyPolicy: AutonomyPolicy;
  closurePolicy: ClosurePolicy;
  baseline?: {
    kind: 'OBSERVED' | 'QUALIFICATION_FIXTURE';
    reportId: string;
    strongBuilderAttempts: number;
    verificationOutcome: 'PASS' | 'FAIL' | 'UNAVAILABLE';
    closureOutcome: 'PASS' | 'FAIL' | 'UNAVAILABLE';
  } | undefined;
}

export interface ComputeExecutionTelemetryOptions {
  persist?: boolean | undefined;
  specbridgeVersion?: string | undefined;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{12,}/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:api[-_ ]?key|auth[-_ ]?token|access[-_ ]?token|password|secret)\s*[:=]\s*\S{8,}/gi,
];

/** Redact bounded diagnostic text before it can enter a high-level report. */
export function redactTelemetryText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted.slice(0, 2_000);
}

function increment(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

function metric(numerator: number | null, denominator: number | null): FractionMetric {
  return {
    numerator,
    denominator,
    value:
      numerator === null || denominator === null || denominator === 0
        ? null
        : numerator / denominator,
  };
}

function tokenTelemetry<T>(
  attempts: readonly T[],
  usage: (attempt: T) => { input: number | null | undefined; output: number | null | undefined },
): TokenTelemetry {
  let input = 0;
  let output = 0;
  let withInput = 0;
  let withOutput = 0;
  let withAny = 0;
  for (const attempt of attempts) {
    const reported = usage(attempt);
    const hasInput = reported.input !== null && reported.input !== undefined;
    const hasOutput = reported.output !== null && reported.output !== undefined;
    if (hasInput) {
      input += reported.input ?? 0;
      withInput += 1;
    }
    if (hasOutput) {
      output += reported.output ?? 0;
      withOutput += 1;
    }
    if (hasInput || hasOutput) withAny += 1;
  }
  const attemptCount = attempts.length;
  const complete = attemptCount > 0 && withInput === attemptCount && withOutput === attemptCount;
  return {
    inputTokens: withInput > 0 ? input : null,
    outputTokens: withOutput > 0 ? output : null,
    knownTokens: withAny > 0 ? input + output : null,
    completeTokens: complete ? input + output : null,
    coverage: {
      attempts: attemptCount,
      withAny,
      withInput,
      withOutput,
      ratio: attemptCount === 0 ? null : withAny / attemptCount,
      complete,
    },
  };
}

function timestampMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function outcomeStatus(status: string): ExecutionTelemetryReport['outcome']['status'] {
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'BLOCKED' || status === 'NEEDS_AUTHORITY' || status === 'NEEDS_CLARIFICATION') {
    return 'BLOCKED';
  }
  return 'WAITING';
}

function verificationOutcome(job: JobState, events: readonly JobEvent[]): 'PASS' | 'FAIL' | 'UNAVAILABLE' {
  const status = job.latestEvidence?.evidenceStatus;
  if (status === 'verified' || status === 'manually-accepted') return 'PASS';
  const lastFailure = [...events].reverse().find((event) => event.type === 'verification_failed');
  if (lastFailure !== undefined && job.latestEvidence === undefined) return 'FAIL';
  return 'UNAVAILABLE';
}

function currentRoutingStates(objectives: readonly ObjectiveTelemetryFacts[]): Map<string, BuilderRoutingState> {
  const current = new Map<string, BuilderRoutingState>();
  for (const objective of objectives) {
    for (const state of objective.routingStates) {
      const key = `${objective.objectiveNodeId}\u0000${state.workUnitId}`;
      const prior = current.get(key);
      if (
        prior === undefined
        || state.updatedAt.localeCompare(prior.updatedAt, 'en') > 0
        || (state.updatedAt === prior.updatedAt && state.contentHash.localeCompare(prior.contentHash, 'en') > 0)
      ) {
        current.set(key, state);
      }
    }
  }
  return current;
}

interface UniqueBuilderAttempt extends BuilderRoutingAttempt {
  objectiveNodeId: string;
  workUnitId: string;
}

function uniqueBuilderAttempts(objectives: readonly ObjectiveTelemetryFacts[]): {
  attempts: UniqueBuilderAttempt[];
  duplicateIds: number;
} {
  const seen = new Map<string, UniqueBuilderAttempt>();
  let duplicateIds = 0;
  for (const objective of objectives) {
    for (const state of objective.routingStates) {
      for (const attempt of state.attempts) {
        const key = `${objective.objectiveNodeId}\u0000${state.workUnitId}\u0000${attempt.attemptId}`;
        if (seen.has(key)) {
          duplicateIds += 1;
          continue;
        }
        seen.set(key, { ...attempt, objectiveNodeId: objective.objectiveNodeId, workUnitId: state.workUnitId });
      }
    }
  }
  return {
    attempts: [...seen.values()].sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt, 'en')
        || left.objectiveNodeId.localeCompare(right.objectiveNodeId, 'en')
        || left.workUnitId.localeCompare(right.workUnitId, 'en')
        || left.sequence - right.sequence,
    ),
    duplicateIds,
  };
}

function latestUnits(objectives: readonly ObjectiveTelemetryFacts[]): Array<{
  objectiveNodeId: string;
  unit: WorkUnit;
}> {
  const units: Array<{ objectiveNodeId: string; unit: WorkUnit }> = [];
  for (const objective of objectives) {
    for (const unit of objective.graph?.units ?? []) {
      units.push({ objectiveNodeId: objective.objectiveNodeId, unit });
    }
  }
  return units.sort(
    (left, right) =>
      left.objectiveNodeId.localeCompare(right.objectiveNodeId, 'en')
      || left.unit.workUnitId.localeCompare(right.unit.workUnitId, 'en'),
  );
}

function workAccounting(
  unit: WorkUnit,
  routing: BuilderRoutingState | undefined,
): z.infer<typeof workAccountingSchema> {
  if (unit.status === 'INTEGRATED') return 'completed';
  if (unit.status === 'FAILED') return 'failed';
  if (unit.status === 'SUPERSEDED') return 'cancelled';
  const eligibility = routing?.initialEligibility;
  if (eligibility === 'NEEDS_AUTHORITY') return 'human-authority-pending';
  if (eligibility === 'NEEDS_RESEARCH') return 'research-pending';
  if (eligibility === 'NEEDS_CONTEXT') return 'context-pending';
  if (eligibility === 'NOT_READY' || unit.status === 'PLANNED') return 'not-ready';
  return 'waiting';
}

function builderPath(attempts: readonly UniqueBuilderAttempt[]): ExecutionTelemetryReport['work']['units'][number]['builderPath'] {
  if (attempts.some((attempt) => attempt.kind === 'STRONG_FALLBACK')) return 'STRONG_FALLBACK';
  if (attempts.some((attempt) => attempt.kind === 'STRONG')) return 'STRONG';
  if (attempts.some((attempt) => attempt.kind === 'SECONDARY_REPAIR')) return 'SECONDARY_REPAIR';
  if (attempts.some((attempt) => attempt.kind === 'SECONDARY')) return 'SECONDARY';
  return attempts.length === 0 ? 'NONE' : 'UNKNOWN';
}

function verificationFor(
  evaluations: readonly EvaluationRecord[],
): ExecutionTelemetryReport['work']['units'][number]['verification'] {
  if (evaluations.some((entry) => entry.verdict === 'FAIL')) return 'FAIL';
  if (evaluations.some((entry) => entry.verdict === 'PASS')) return 'PASS';
  if (evaluations.length > 0) return 'PENDING';
  return 'UNAVAILABLE';
}

function fallbackReason(attempts: readonly UniqueBuilderAttempt[]): string {
  const preceding = [...attempts]
    .reverse()
    .find((attempt) => attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR');
  if (preceding === undefined) return 'other';
  if (preceding.noProgress) return 'no-progress';
  switch (preceding.outcome) {
    case 'FAILED_VERIFICATION': return 'verification-failure';
    case 'FAILED_OUTPUT': return 'malformed-model-result';
    case 'FAILED_RESOURCE': return 'capability-failure';
    case 'FAILED_IMPLEMENTATION':
      return /context|stale source|insufficient/i.test(preceding.failureSummary ?? '')
        ? 'context-insufficiency'
        : 'implementation-failure';
    default: return 'other';
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Pure derivation from durable facts. No counter is incremented or persisted. */
export function deriveExecutionTelemetryReport(
  facts: ExecutionTelemetryFacts,
): ExecutionTelemetryReport {
  const diagnostics: ExecutionTelemetryReport['diagnostics'] = [];
  const generatedMs = timestampMs(facts.generatedAt) ?? 0;
  const eventTypes = (type: string): JobEvent[] => facts.events.filter((event) => event.type === type);
  const currentRouting = currentRoutingStates(facts.objectives);
  const { attempts: implementationAttempts, duplicateIds } = uniqueBuilderAttempts(facts.objectives);
  const units = latestUnits(facts.objectives);
  const evaluations = facts.objectives
    .flatMap((objective) => objective.evaluations)
    .filter((entry, index, values) => values.findIndex((other) => other.evaluationId === entry.evaluationId) === index)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt, 'en'));

  if (facts.eventTotal > facts.events.length) {
    diagnostics.push({
      code: 'EVENT_WINDOW_BOUNDED',
      severity: 'info',
      message: `The report used the newest ${facts.events.length} of ${facts.eventTotal} job events; ledgers and current state remain authoritative for aggregates.`,
      evidenceRefs: [],
    });
  }
  if (facts.objectives.length === 0) {
    diagnostics.push({
      code: 'OBJECTIVE_TELEMETRY_UNAVAILABLE',
      severity: 'info',
      message: 'No objective-runtime records exist; Phase 7/8 metrics are unavailable for this older or direct-execution job.',
      evidenceRefs: [],
    });
  }
  if (facts.autonomy.boundaryStartedAt === null) {
    diagnostics.push({
      code: 'ZERO_TOUCH_BOUNDARY_UNAVAILABLE',
      severity: 'info',
      message: 'No durable seal boundary exists; intervention counting conservatively includes the whole recorded Job history.',
      evidenceRefs: [],
    });
  }
  if (duplicateIds > 0) {
    diagnostics.push({
      code: 'ATTEMPT_REPLAY_DEDUPLICATED',
      severity: 'info',
      message: `${duplicateIds} replayed builder-attempt record${duplicateIds === 1 ? '' : 's'} were ignored by durable attempt id.`,
      evidenceRefs: [],
    });
  }
  if (facts.researchTelemetryDiagnostic !== undefined) {
    diagnostics.push({
      code: 'RESEARCH_TELEMETRY_UNREADABLE',
      severity: 'warning',
      message: redactTelemetryText(facts.researchTelemetryDiagnostic),
      evidenceRefs: [],
    });
  }
  for (const diagnostic of facts.researchRecordDiagnostics ?? []) {
    diagnostics.push({
      code: diagnostic.code.slice(0, 512),
      severity: 'warning',
      message: redactTelemetryText(diagnostic.message),
      evidenceRefs: [],
    });
  }

  const attemptsByUnit = new Map<string, UniqueBuilderAttempt[]>();
  for (const attempt of implementationAttempts) {
    const key = `${attempt.objectiveNodeId}\u0000${attempt.workUnitId}`;
    const list = attemptsByUnit.get(key) ?? [];
    list.push(attempt);
    attemptsByUnit.set(key, list);
  }
  const evaluationsByUnit = new Map<string, EvaluationRecord[]>();
  for (const evaluation of evaluations) {
    const key = `${evaluation.objectiveNodeId}\u0000${evaluation.workUnitId}`;
    const list = evaluationsByUnit.get(key) ?? [];
    list.push(evaluation);
    evaluationsByUnit.set(key, list);
  }

  const workAccountingCounts: Record<z.infer<typeof workAccountingSchema>, number> = {
    completed: 0,
    failed: 0,
    cancelled: 0,
    waiting: 0,
    'not-ready': 0,
    'human-authority-pending': 0,
    'research-pending': 0,
    'context-pending': 0,
  };
  const workByKind: Record<string, number> = {};
  const unitSummaries: ExecutionTelemetryReport['work']['units'] = [];
  for (const entry of units) {
    const key = `${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`;
    const routing = currentRouting.get(key);
    const unitAttempts = attemptsByUnit.get(key) ?? [];
    const unitEvaluations = evaluationsByUnit.get(key) ?? [];
    const accounting = workAccounting(entry.unit, routing);
    workAccountingCounts[accounting] += 1;
    increment(workByKind, entry.unit.kind);
    if (unitSummaries.length < 500) {
      unitSummaries.push({
        workUnitId: entry.unit.workUnitId,
        objectiveNodeId: entry.objectiveNodeId,
        kind: entry.unit.kind,
        status: entry.unit.status,
        accounting,
        builderPath: builderPath(unitAttempts),
        implementationAttempts: unitAttempts.length,
        verification: verificationFor(unitEvaluations),
        integration: entry.unit.status === 'INTEGRATED' ? 'INTEGRATED' : 'NOT_INTEGRATED',
      });
    }
  }

  const eligibility = {
    eligible: 0,
    ineligible: 0,
    strongRequired: 0,
    needsResearch: 0,
    needsAuthority: 0,
    needsContext: 0,
    notReady: 0,
    unavailable: units.filter((entry) =>
      entry.unit.kind === 'build'
      && !currentRouting.has(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`)).length,
  };
  const selection = {
    secondarySelected: 0,
    strongSelectedDespiteEligibility: 0,
    noBuilderNeeded: 0,
    waitingForResource: 0,
  };
  const strongSelection = {
    requiredDirect: 0,
    byStrategyOff: 0,
    byAutoPolicy: 0,
    becauseSecondaryUnavailable: 0,
    fallbackAfterSecondary: 0,
  };
  const fallbackReasons: Record<string, number> = {};

  for (const entry of units) {
    if (entry.unit.kind !== 'build') {
      selection.noBuilderNeeded += 1;
      continue;
    }
    const key = `${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`;
    const state = currentRouting.get(key);
    if (state === undefined) continue;
    switch (state.initialEligibility) {
      case 'ELIGIBLE': eligibility.eligible += 1; break;
      case 'STRONG_REQUIRED': eligibility.strongRequired += 1; break;
      case 'NEEDS_RESEARCH': eligibility.needsResearch += 1; break;
      case 'NEEDS_AUTHORITY': eligibility.needsAuthority += 1; break;
      case 'NEEDS_CONTEXT': eligibility.needsContext += 1; break;
      case 'NOT_READY': eligibility.notReady += 1; break;
      default: break;
    }
    const decisions = state.decisions;
    const unitAttempts = attemptsByUnit.get(key) ?? [];
    if (entry.unit.resourceWait !== undefined) selection.waitingForResource += 1;
    if (state.initialEligibility === 'ELIGIBLE') {
      if (decisions.some((decision) => decision.selectedBackend === 'SECONDARY')) {
        selection.secondarySelected += 1;
      } else if (decisions.some((decision) => decision.selectedBackend === 'STRONG')) {
        selection.strongSelectedDespiteEligibility += 1;
      }
    }
    const directStrong = decisions.find((decision) => decision.selectedBackend === 'STRONG');
    if (directStrong !== undefined && !unitAttempts.some((attempt) => attempt.kind === 'STRONG_FALLBACK')) {
      if (state.initialEligibility === 'STRONG_REQUIRED') strongSelection.requiredDirect += 1;
      else if (directStrong.reasons.some((reason) => reason.code === 'STRATEGY_OFF')) strongSelection.byStrategyOff += 1;
      else if (directStrong.reasons.some((reason) => reason.code === 'SECONDARY_UNAVAILABLE')) {
        strongSelection.becauseSecondaryUnavailable += 1;
      } else if (
        directStrong.reasons.some((reason) =>
          reason.code === 'SUBSCRIPTION_HARVEST'
          || reason.code === 'SECONDARY_AUTO_POLICY'
          || reason.code === 'CRITICAL_WORK_PREFERS_STRONG')
      ) {
        strongSelection.byAutoPolicy += 1;
      }
    }
    if (unitAttempts.some((attempt) => attempt.kind === 'STRONG_FALLBACK')) {
      strongSelection.fallbackAfterSecondary += 1;
      increment(fallbackReasons, fallbackReason(unitAttempts));
    }
  }
  eligibility.ineligible =
    eligibility.strongRequired
    + eligibility.needsResearch
    + eligibility.needsAuthority
    + eligibility.needsContext
    + eligibility.notReady;

  const eligibleUnits = units.filter((entry) => {
    const state = currentRouting.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`);
    return entry.unit.kind === 'build' && state?.initialEligibility === 'ELIGIBLE';
  });
  const eligibleCompleted = eligibleUnits.filter((entry) => entry.unit.status === 'INTEGRATED');
  const eligibleCompletedWithoutStrong = eligibleCompleted.filter((entry) => {
    const attempts = attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [];
    return !attempts.some((attempt) => attempt.kind === 'STRONG' || attempt.kind === 'STRONG_FALLBACK');
  });
  const secondaryAttemptedUnits = eligibleUnits.filter((entry) => {
    const attempts = attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [];
    return attempts.some((attempt) =>
      (attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR')
      && attempt.outcome !== 'FAILED_RESOURCE'
      && attempt.outcome !== 'CANCELLED');
  });
  const initialAttemptedUnits = eligibleUnits.filter((entry) => {
    const attempts = attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [];
    return attempts.some((attempt) =>
      attempt.kind === 'SECONDARY'
      && attempt.outcome !== 'FAILED_RESOURCE'
      && attempt.outcome !== 'CANCELLED');
  });
  const initialPassUnits = initialAttemptedUnits.filter((entry) => {
    const attempts = attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [];
    return attempts.some((attempt) => attempt.kind === 'SECONDARY' && attempt.outcome === 'SUCCEEDED');
  });
  const repairAttemptedUnits = eligibleUnits.filter((entry) => {
    const attempts = attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [];
    return attempts.some((attempt) =>
      attempt.kind === 'SECONDARY_REPAIR'
      && attempt.outcome !== 'FAILED_RESOURCE'
      && attempt.outcome !== 'CANCELLED');
  });
  const repairPassUnits = repairAttemptedUnits.filter((entry) => {
    const attempts = attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [];
    return attempts.some((attempt) => attempt.kind === 'SECONDARY_REPAIR' && attempt.outcome === 'SUCCEEDED');
  });
  const fallbackUnits = eligibleUnits.filter((entry) => {
    const attempts = attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [];
    return attempts.some((attempt) => attempt.kind === 'STRONG_FALLBACK');
  });
  const unavailableFallbackUnits = eligibleUnits.filter((entry) => {
    const state = currentRouting.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`);
    return state?.decisions.some((decision) =>
      decision.selectedBackend === 'STRONG'
      && decision.reasons.some((reason) => reason.code === 'SECONDARY_UNAVAILABLE')) === true;
  });

  const secondaryAttempts = implementationAttempts.filter((attempt) =>
    attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR');
  const strongAttempts = implementationAttempts.filter((attempt) =>
    attempt.kind === 'STRONG' || attempt.kind === 'STRONG_FALLBACK');
  const strongEvaluatorAttempts = facts.ledger.filter((entry) =>
    entry.role === 'EVALUATOR' && entry.lane !== 'LOCAL');
  const secondaryTokens = tokenTelemetry(secondaryAttempts, (attempt) => ({
    input: attempt.inputTokens,
    output: attempt.outputTokens,
  }));
  const strongTokens = tokenTelemetry(strongAttempts, (attempt) => ({
    input: attempt.inputTokens,
    output: attempt.outputTokens,
  }));
  const evaluatorTokens = tokenTelemetry(strongEvaluatorAttempts, (attempt) => ({
    input: attempt.metrics.inputTokens,
    output: attempt.metrics.outputTokens,
  }));

  // Research records carry provider executions and usage. Gate telemetry is
  // currently workspace-scoped, so a job report labels that scope instead of
  // pretending the aggregate belongs exclusively to this job.
  const jobResearchRecords = facts.researchRecords.filter((record) => record.scope?.jobId === facts.job.jobId);
  const jobResearchIds = new Set(jobResearchRecords.map((record) => record.researchId));
  const jobResearchUses = facts.researchUses.filter((use) => jobResearchIds.has(use.researchId));
  const hasJobResearch = jobResearchRecords.length > 0 || jobResearchUses.length > 0;
  const hasWorkspaceResearch =
    (facts.researchTelemetry?.gateConsidered ?? 0) > 0
    || facts.researchRecords.length > 0
    || facts.researchUses.length > 0;
  const researchScope: ExecutionTelemetryReport['research']['scope'] = hasJobResearch
    ? 'JOB'
    : hasWorkspaceResearch
      ? 'WORKSPACE'
      : 'NONE';
  const reportResearchRecords = hasJobResearch ? jobResearchRecords : facts.researchRecords;
  const reportResearchUses = hasJobResearch ? jobResearchUses : facts.researchUses;
  const useIds = new Set(reportResearchUses.map((use) => use.useId));
  const uniqueUses = reportResearchUses.filter((use) => {
    if (!useIds.has(use.useId)) return false;
    useIds.delete(use.useId);
    return true;
  });
  const providerRecords = reportResearchRecords.filter((record) => record.status !== 'PENDING');
  const workspaceResearch = researchScope === 'WORKSPACE';
  const providerCallCount = workspaceResearch
    ? facts.researchTelemetry?.providerCalls ?? providerRecords.length
    : providerRecords.length;
  const successfulResearch = workspaceResearch
    ? facts.researchTelemetry?.successfulResearch ?? providerRecords.filter((record) => record.status === 'COMPLETED').length
    : providerRecords.filter((record) => record.status === 'COMPLETED').length;
  const inconclusiveResearch = workspaceResearch
    ? facts.researchTelemetry?.inconclusiveResearch ?? providerRecords.filter((record) => record.status === 'INCONCLUSIVE').length
    : providerRecords.filter((record) => record.status === 'INCONCLUSIVE').length;
  const failedResearch = workspaceResearch
    ? facts.researchTelemetry?.failedResearch ?? providerRecords.filter((record) => record.status === 'FAILED').length
    : providerRecords.filter((record) => record.status === 'FAILED').length;
  const reuseCount = workspaceResearch
    ? facts.researchTelemetry?.reusedReports ?? uniqueUses.filter((use) => use.useKind === 'REUSED').length
    : uniqueUses.filter((use) => use.useKind === 'REUSED').length;
  const newQuick = workspaceResearch
    ? facts.researchTelemetry?.newQuick ?? providerRecords.filter((record) => record.depth === 'QUICK').length
    : providerRecords.filter((record) => record.depth === 'QUICK').length;
  const newDeep = workspaceResearch
    ? facts.researchTelemetry?.newDeep ?? providerRecords.filter((record) => record.depth === 'DEEP').length
    : providerRecords.filter((record) => record.depth === 'DEEP').length;
  const researchConsidered = researchScope === 'WORKSPACE'
    ? facts.researchTelemetry?.gateConsidered ?? null
    : null;
  const researchAvoided = researchScope === 'WORKSPACE'
    ? facts.researchTelemetry?.researchAvoided ?? null
    : null;
  const researchDecisions = researchScope === 'WORKSPACE'
    ? { ...(facts.researchTelemetry?.decisions ?? {}) }
    : {};
  const byPhase: Record<string, z.infer<typeof phaseResearchSchema>> = {};
  for (const phase of ['CONVERSATION', 'SPEC_DRAFT', 'INTAKE_DECISION', 'RUNTIME_INVESTIGATION']) {
    const aggregate = researchScope === 'WORKSPACE' ? facts.researchTelemetry?.byPhase[phase as keyof ResearchTelemetry['byPhase']] : undefined;
    const phaseRecords = providerRecords.filter((record) => record.lifecycle?.phase === phase);
    const phaseUses = uniqueUses.filter((use) => use.phase === phase);
    byPhase[phase] = {
      considered: aggregate?.considered ?? 0,
      avoided: aggregate?.avoided ?? 0,
      reused: researchScope === 'WORKSPACE' ? aggregate?.reused ?? phaseUses.filter((use) => use.useKind === 'REUSED').length : phaseUses.filter((use) => use.useKind === 'REUSED').length,
      newCalls: researchScope === 'WORKSPACE' ? (aggregate?.newQuick ?? 0) + (aggregate?.newDeep ?? 0) : phaseRecords.length,
      quick: researchScope === 'WORKSPACE' ? aggregate?.newQuick ?? phaseRecords.filter((record) => record.depth === 'QUICK').length : phaseRecords.filter((record) => record.depth === 'QUICK').length,
      deep: researchScope === 'WORKSPACE' ? aggregate?.newDeep ?? phaseRecords.filter((record) => record.depth === 'DEEP').length : phaseRecords.filter((record) => record.depth === 'DEEP').length,
      failed: phaseRecords.filter((record) => record.status === 'FAILED').length,
    };
  }
  let researchInputTokens = 0;
  let researchOutputTokens = 0;
  let researchDurationMs = 0;
  let researchCost = 0;
  let researchSubagents = 0;
  let researchInputObserved = false;
  let researchOutputObserved = false;
  let researchDurationObserved = false;
  let researchCostObserved = false;
  let researchSubagentsObserved = false;
  let recordsWithUsage = 0;
  for (const record of providerRecords) {
    const usage = record.usage ?? record.report?.usage;
    if (usage === undefined) continue;
    recordsWithUsage += 1;
    if (usage.inputTokens !== undefined) {
      researchInputObserved = true;
      researchInputTokens += usage.inputTokens;
    }
    if (usage.outputTokens !== undefined) {
      researchOutputObserved = true;
      researchOutputTokens += usage.outputTokens;
    }
    if (usage.durationMs !== undefined) {
      researchDurationObserved = true;
      researchDurationMs += usage.durationMs;
    }
    if (usage.providerReportedCost !== undefined) {
      researchCostObserved = true;
      researchCost += usage.providerReportedCost;
    }
    if (usage.subagentCount !== undefined) {
      researchSubagentsObserved = true;
      researchSubagents += usage.subagentCount;
    }
  }
  if (researchScope === 'WORKSPACE' && providerRecords.length === 0 && facts.researchTelemetry !== undefined) {
    const reported = facts.researchTelemetry.reportedUsage;
    if (reported.reports > 0) {
      recordsWithUsage = reported.reports;
      // Legacy aggregate telemetry did not preserve per-field coverage. A
      // positive aggregate is safe evidence that the provider reported that
      // field; zero remains ambiguous and therefore stays null.
      if (reported.inputTokens > 0) {
        researchInputObserved = true;
        researchInputTokens = reported.inputTokens;
      }
      if (reported.outputTokens > 0) {
        researchOutputObserved = true;
        researchOutputTokens = reported.outputTokens;
      }
      if (reported.providerReportedCost > 0) {
        researchCostObserved = true;
        researchCost = reported.providerReportedCost;
      }
      if (reported.subagentCount > 0) {
        researchSubagentsObserved = true;
        researchSubagents = reported.subagentCount;
      }
    }
    if (facts.researchTelemetry.totalDurationMs > 0) {
      researchDurationObserved = true;
      researchDurationMs = facts.researchTelemetry.totalDurationMs;
    }
  }

  const cooldownStates = facts.objectives
    .map((objective) => objective.cooldown)
    .filter((state): state is ObjectiveCooldownState => state !== undefined);
  const cooldownIntervals: ExecutionTelemetryReport['cooldown']['intervals'] = [];
  let cooldownDurationMs = 0;
  let cooldownDurationKnown = cooldownStates.length > 0;
  let cooldownEpisodes = 0;
  for (const state of cooldownStates) {
    cooldownEpisodes += state.episodes;
    const startedAt = state.currentStartedAt ?? state.firstStartedAt;
    const endedAt = state.status === 'RECOVERED' ? state.lastEndedAt ?? null : null;
    const startMs = timestampMs(startedAt);
    const endMs = state.status === 'ACTIVE' ? generatedMs : timestampMs(endedAt);
    const durationMs = startMs !== undefined && endMs !== undefined && endMs >= startMs
      ? endMs - startMs
      : null;
    if (state.episodes !== 1) cooldownDurationKnown = false;
    if (durationMs === null) cooldownDurationKnown = false;
    else cooldownDurationMs += durationMs;
    cooldownIntervals.push({
      objectiveNodeId: state.objectiveNodeId,
      status: state.status,
      startedAt,
      endedAt,
      durationMs,
      completedWorkUnits: state.completedDuringCooldown.length,
    });
    if (state.episodes > 1) {
      diagnostics.push({
        code: 'COOLDOWN_DURATION_PARTIAL',
        severity: 'info',
        message: `Objective ${state.objectiveNodeId} records ${state.episodes} cooldown episodes but retains only bounded interval endpoints; total duration is unavailable.`,
        evidenceRefs: [state.objectiveNodeId],
      });
    }
  }
  const cooldownCompletedKeys = new Set<string>();
  const cooldownWaitingKeys = new Set<string>();
  for (const state of cooldownStates) {
    for (const workUnitId of state.completedDuringCooldown) {
      cooldownCompletedKeys.add(`${state.objectiveNodeId}\u0000${workUnitId}`);
    }
    for (const workUnitId of state.waitingWorkUnitIds) {
      cooldownWaitingKeys.add(`${state.objectiveNodeId}\u0000${workUnitId}`);
    }
  }
  let secondaryImplementationDuringCooldown = 0;
  for (const entry of units) {
    const key = `${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`;
    if (!cooldownCompletedKeys.has(key) || entry.unit.kind !== 'build') continue;
    const unitAttempts = attemptsByUnit.get(key) ?? [];
    if (
      unitAttempts.some((attempt) => attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR')
      && !unitAttempts.some((attempt) => attempt.kind === 'STRONG' || attempt.kind === 'STRONG_FALLBACK')
    ) {
      secondaryImplementationDuringCooldown += 1;
    }
  }
  const withinCooldown = (at: string): boolean => {
    const atMs = timestampMs(at);
    if (atMs === undefined) return false;
    return cooldownIntervals.some((interval) => {
      const start = timestampMs(interval.startedAt);
      const end = timestampMs(interval.endedAt) ?? generatedMs;
      return start !== undefined && atMs >= start && atMs <= end;
    });
  };
  const researchDuringCooldown = providerRecords.filter((record) =>
    (record.status === 'COMPLETED' || record.status === 'INCONCLUSIVE')
    && withinCooldown(record.report?.completedAt ?? record.updatedAt)).length;
  let avoidableIdlePeriods = 0;
  for (const objective of facts.objectives) {
    if (objective.cooldown?.status !== 'ACTIVE' || objective.graph === undefined) continue;
    for (const unit of objective.graph.units) {
      if (unit.kind !== 'build' || unit.status !== 'READY' || unit.resourceWait !== undefined) continue;
      const key = `${objective.objectiveNodeId}\u0000${unit.workUnitId}`;
      const state = currentRouting.get(key);
      if (state?.initialEligibility !== 'ELIGIBLE' || state.strategy === 'OFF') continue;
      const startMs = timestampMs(objective.cooldown.currentStartedAt);
      const dispatched = (attemptsByUnit.get(key) ?? []).some((attempt) => {
        const attemptMs = timestampMs(attempt.startedAt);
        return (attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR')
          && attemptMs !== undefined
          && (startMs === undefined || attemptMs >= startMs);
      });
      if (!dispatched) avoidableIdlePeriods += 1;
    }
  }
  if (avoidableIdlePeriods > 0) {
    diagnostics.push({
      code: 'AVOIDABLE_IDLE_DURING_COOLDOWN',
      severity: 'warning',
      message: `${avoidableIdlePeriods} runnable Secondary work period(s) had no durable Secondary dispatch during an active Strong cooldown.`,
      evidenceRefs: [],
    });
  }
  const cooldownEventTypes = new Set([
    'resource_cooldown_started',
    'resource_cooldown_observed',
    'work_unit_resource_wait_started',
    'work_unit_resource_wait_ended',
    'resource_wait_entered',
    'useful_work_during_cooldown',
    'resource_recovered',
  ]);
  const cooldownTimeline = facts.events
    .filter((event) => cooldownEventTypes.has(event.type))
    .slice(-200)
    .map((event) => ({
      at: String(event.at ?? ''),
      type: event.type,
      objectiveNodeId: typeof event['nodeId'] === 'string' ? event['nodeId'].slice(0, 512) : null,
      detail: cooldownEventDetail(event),
    }));

  const evaluationFailures = evaluations.filter((entry) => entry.verdict === 'FAIL');
  const evaluationPasses = evaluations.filter((entry) => entry.verdict === 'PASS');
  const failuresByBackend: Record<string, number> = {};
  let failuresRecoveredByRepair = 0;
  let failuresRecoveredByStrongFallback = 0;
  const failedUnitKeys = new Set<string>();
  for (const evaluation of evaluationFailures) {
    const key = `${evaluation.objectiveNodeId}\u0000${evaluation.workUnitId}`;
    failedUnitKeys.add(key);
    const unitAttempts = attemptsByUnit.get(key) ?? [];
    const matching = [...unitAttempts]
      .reverse()
      .find((attempt) => attempt.workUnitAttempt === evaluation.attempt);
    increment(failuresByBackend, matching?.kind ?? 'UNKNOWN');
  }
  for (const key of failedUnitKeys) {
    const unitAttempts = attemptsByUnit.get(key) ?? [];
    if (unitAttempts.some((attempt) => attempt.kind === 'SECONDARY_REPAIR' && attempt.outcome === 'SUCCEEDED')) {
      failuresRecoveredByRepair += 1;
    }
    if (unitAttempts.some((attempt) => attempt.kind === 'STRONG_FALLBACK' && attempt.outcome === 'SUCCEEDED')) {
      failuresRecoveredByStrongFallback += 1;
    }
  }

  const failureSources: Record<string, number> = {};
  const recoveryActions: Record<string, number> = {};
  for (const entry of facts.ledger) {
    if (entry.failureSource !== null) increment(failureSources, entry.failureSource);
    else if (!entry.success && entry.failureReason !== null) increment(failureSources, 'UNCLASSIFIED');
    if (entry.recoveryAction !== null) increment(recoveryActions, entry.recoveryAction);
  }
  const repairAttempts = implementationAttempts.filter((attempt) => attempt.kind === 'SECONDARY_REPAIR').length;
  const strongFallbackAttempts = implementationAttempts.filter((attempt) => attempt.kind === 'STRONG_FALLBACK').length;
  if (repairAttempts > 0) increment(recoveryActions, 'repair', repairAttempts);
  if (strongFallbackAttempts > 0) increment(recoveryActions, 'strong-fallback', strongFallbackAttempts);
  const resourceWaitEvents = eventTypes('resource_wait_started').length
    + eventTypes('resource_wait_entered').length
    + eventTypes('work_unit_resource_wait_started').length;
  if (resourceWaitEvents > 0) increment(recoveryActions, 'resource-wait', resourceWaitEvents);
  const restartEvents = eventTypes('job_resumed').length + eventTypes('driver_restarted').length;
  if (restartEvents > 0) increment(recoveryActions, 'restart-resume', restartEvents);

  const noProgressDetections = implementationAttempts.filter((attempt) => attempt.noProgress).length;
  const fingerprintCounts = new Map<string, number>();
  for (const attempt of implementationAttempts) {
    if (attempt.problemFingerprint !== undefined) {
      fingerprintCounts.set(
        attempt.problemFingerprint,
        (fingerprintCounts.get(attempt.problemFingerprint) ?? 0) + 1,
      );
    }
  }
  const repeatedProblemFingerprints = [...fingerprintCounts.values()].filter((value) => value > 1).length;
  const candidatesPersisted = new Set(
    implementationAttempts
      .map((attempt) => attempt.candidateRef)
      .filter((ref): ref is string => ref !== undefined),
  ).size;
  const candidateRebuilds = eventTypes('candidate_resume_missing').length;
  const candidatesReused = cooldownStates.reduce(
    (sum, state) => sum + state.candidateReuseAfterRestart,
    0,
  );
  const integrationRetries = eventTypes('integration_failed').length;
  let completedWorkRedoCount = 0;
  for (const entry of units) {
    if (entry.unit.integratedAt === undefined) continue;
    const integratedMs = timestampMs(entry.unit.integratedAt);
    if (integratedMs === undefined) continue;
    const attemptsAfterIntegration = (attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [])
      .filter((attempt) => (timestampMs(attempt.startedAt) ?? 0) > integratedMs);
    if (attemptsAfterIntegration.length > 0) completedWorkRedoCount += 1;
  }
  const lastRestartMs = Math.max(
    0,
    ...facts.events
      .filter((event) => event.type === 'job_resumed' || event.type === 'driver_restarted')
      .map((event) => timestampMs(event.at) ?? 0),
  );
  const completedWorkReusedAfterRestart = lastRestartMs === 0
    ? 0
    : units.filter((entry) => {
        if (entry.unit.status !== 'INTEGRATED') return false;
        const unitAttempts = attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? [];
        return unitAttempts.length > 0
          && unitAttempts.every((attempt) => (timestampMs(attempt.completedAt) ?? Number.MAX_SAFE_INTEGER) <= lastRestartMs);
      }).length;
  const unresolvedInterrupted = facts.ledger.filter((entry) => {
    if (entry.status !== 'INTERRUPTED') return false;
    return !facts.ledger.some((candidate) =>
      candidate.taskId === entry.taskId
      && candidate.attemptNumber > entry.attemptNumber
      && candidate.status === 'COMPLETED');
  }).length;
  const unrecoveredDriverDeaths = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(facts.job.status)
    ? unresolvedInterrupted
    : 0;
  const unexpectedBlocks = facts.autonomy.interventions.filter((intervention) =>
    intervention.kind === 'job_blocked'
    || intervention.kind === 'budget_exhausted'
    || intervention.kind.startsWith('status:')).length;
  if (completedWorkRedoCount > 0) {
    diagnostics.push({
      code: 'COMPLETED_WORK_REDONE',
      severity: 'error',
      message: `${completedWorkRedoCount} authoritatively integrated WorkUnit(s) have a later implementation attempt without recorded invalidation.`,
      evidenceRefs: [],
    });
  }

  const completedImplementation = units.filter((entry) =>
    entry.unit.kind === 'build' && entry.unit.status === 'INTEGRATED').length;
  const attemptCountsForCompleted = units
    .filter((entry) => entry.unit.status === 'INTEGRATED' && entry.unit.kind === 'build')
    .map((entry) =>
      (attemptsByUnit.get(`${entry.objectiveNodeId}\u0000${entry.unit.workUnitId}`) ?? []).length);
  const totalAttemptsForCompleted = attemptCountsForCompleted.reduce((sum, value) => sum + value, 0);
  const meanAttempts = attemptCountsForCompleted.length === 0
    ? null
    : totalAttemptsForCompleted / attemptCountsForCompleted.length;
  const completedPerAttempt = implementationAttempts.length === 0
    ? null
    : completedImplementation / implementationAttempts.length;
  const completedPerStrong = strongAttempts.length === 0
    ? null
    : completedImplementation / strongAttempts.length;
  const completedEligiblePerSecondary = secondaryAttempts.length === 0
    ? null
    : eligibleCompleted.length / secondaryAttempts.length;

  const closureTotals = facts.closure === undefined ? undefined : summarizeClosure(facts.closure.entries);
  const closureGate = facts.closure === undefined
    ? undefined
    : missionMayComplete(facts.closure, facts.closurePolicy);
  const closureOutcome: 'PASS' | 'FAIL' | 'UNAVAILABLE' = facts.closure === undefined
    ? 'UNAVAILABLE'
    : closureGate?.mayComplete === true
      ? 'PASS'
      : 'FAIL';
  const overallVerification = verificationOutcome(facts.job, facts.events);
  const boundaryMs = timestampMs(facts.autonomy.boundaryStartedAt);
  const decisionsBeforeSeal = boundaryMs === undefined
    ? null
    : facts.events.filter((event) =>
        (event.type === 'clarification_resolved' || event.type === 'authority_resolved')
        && (timestampMs(event.at) ?? Number.MAX_SAFE_INTEGER) < boundaryMs).length;
  const humanByKind: Record<string, number> = {};
  for (const intervention of facts.autonomy.interventions) increment(humanByKind, intervention.kind);

  const objectiveRevisions: Record<string, number> = {};
  for (const objective of facts.objectives) {
    if (objective.graph !== undefined) objectiveRevisions[objective.objectiveNodeId] = objective.graph.revision;
  }
  const ledgerWatermark = sha256Hex(JSON.stringify(
    facts.ledger.map((entry) => [entry.attemptId, entry.status, entry.completedAt]),
  ));
  const currentPolicyFingerprint = autonomyPolicyFingerprint(facts.currentAutonomyPolicy);
  const runtimePolicyChanged = facts.binding === undefined
    ? null
    : currentPolicyFingerprint !== facts.binding.boundPolicyFingerprint;

  const strongAvoidance = metric(eligibleCompletedWithoutStrong.length, eligibleCompleted.length);
  const secondaryInitial = metric(initialPassUnits.length, initialAttemptedUnits.length);
  const secondaryRepair = metric(repairPassUnits.length, repairAttemptedUnits.length);
  const secondaryFallback = metric(fallbackUnits.length, secondaryAttemptedUnits.length);
  const researchAvoidance = metric(researchAvoided, researchConsidered);
  const researchReuse = metric(
    reuseCount,
    reuseCount + providerCallCount,
  );
  const implementationByKind: Record<string, number> = {};
  for (const attempt of implementationAttempts) increment(implementationByKind, attempt.kind);
  const objectiveSummaries: ExecutionTelemetryReport['work']['objectives'] = facts.objectives
    .slice(0, 200)
    .map((objective) => {
      const accounting: Record<z.infer<typeof workAccountingSchema>, number> = {
        completed: 0,
        failed: 0,
        cancelled: 0,
        waiting: 0,
        'not-ready': 0,
        'human-authority-pending': 0,
        'research-pending': 0,
        'context-pending': 0,
      };
      for (const unit of objective.graph?.units ?? []) {
        const key = `${objective.objectiveNodeId}\u0000${unit.workUnitId}`;
        accounting[workAccounting(unit, currentRouting.get(key))] += 1;
      }
      const attempts = implementationAttempts.filter((entry) =>
        entry.objectiveNodeId === objective.objectiveNodeId);
      return {
        objectiveNodeId: objective.objectiveNodeId,
        graphRevision: objective.graph?.revision ?? null,
        total: objective.graph?.units.length ?? 0,
        accounting,
        implementationAttempts: attempts.length,
        secondaryAttempts: attempts.filter((entry) =>
          entry.kind === 'SECONDARY' || entry.kind === 'SECONDARY_REPAIR').length,
        strongBuilderAttempts: attempts.filter((entry) =>
          entry.kind === 'STRONG' || entry.kind === 'STRONG_FALLBACK').length,
      };
    });

  const report = executionTelemetryReportSchema.parse({
    schemaVersion: EXECUTION_TELEMETRY_REPORT_SCHEMA_VERSION,
    jobId: facts.job.jobId,
    missionId: facts.binding?.missionId ?? facts.seal?.missionId ?? null,
    generatedAt: facts.generatedAt,
    period: {
      startedAt: facts.job.createdAt,
      endedAt: facts.job.finalizedAt ?? null,
      durationMs:
        timestampMs(facts.job.createdAt) === undefined
          ? null
          : Math.max(
              0,
              (timestampMs(facts.job.finalizedAt ?? facts.generatedAt) ?? generatedMs)
                - (timestampMs(facts.job.createdAt) ?? generatedMs),
            ),
      activeExecutionMs:
        timestampMs(facts.job.createdAt) === undefined
          ? null
          : workedMsOf(facts.job, timestampMs(facts.job.finalizedAt ?? facts.generatedAt) ?? generatedMs),
    },
    provenance: {
      sourceJobId: facts.job.jobId,
      jobGraphRevision: facts.job.graphRevision,
      objectiveGraphRevisions: objectiveRevisions,
      executionLedgerWatermark: ledgerWatermark,
      eventWatermark: facts.eventTotal,
      specbridgeVersion: facts.specbridgeVersion ?? null,
      sealId: facts.binding?.sealId ?? null,
      sealedAuthorityDigest: facts.seal?.authorityDigest ?? null,
      runtimePolicyChanged,
      configuration: {
        secondaryBuildStrategy: facts.secondaryBuildStrategy,
        researchStrategy: facts.researchStrategy,
        runnerProfiles: [...facts.runnerProfiles].sort().slice(0, 50),
      },
    },
    outcome: {
      status: outcomeStatus(facts.job.status),
      authoritativeJobStatus: facts.job.status,
      finalOutcome:
        facts.job.finalOutcome === undefined
          ? null
          : redactTelemetryText(facts.job.finalOutcome).slice(0, 2_000),
      verification: overallVerification,
      closure: closureOutcome,
    },
    work: {
      total: units.length,
      byKind: workByKind,
      accounting: workAccountingCounts,
      completedImplementation,
      objectives: objectiveSummaries,
      units: unitSummaries,
      omittedUnits: Math.max(0, units.length - unitSummaries.length),
    },
    secondary: {
      eligibility,
      selection,
      funnel: {
        initialAttempts: initialAttemptedUnits.length,
        initialPass: initialPassUnits.length,
        repairAttempted: repairAttemptedUnits.length,
        repairPass: repairPassUnits.length,
        toStrongFallback: fallbackUnits.length,
        unavailableFallback: unavailableFallbackUnits.length,
      },
      initialSuccessRate: secondaryInitial,
      repairRecoveryRate: secondaryRepair,
      toStrongFallbackRate: secondaryFallback,
      fallbackReasons,
      builderTokens: secondaryTokens,
    },
    strong: {
      builderAttempts: strongAttempts.length,
      evaluatorAttempts: strongEvaluatorAttempts.length,
      selection: strongSelection,
      implementationTokens: strongTokens,
      evaluatorTokens,
    },
    research: {
      scope: researchScope,
      considered: researchConsidered,
      decisions: researchDecisions,
      providerCalls: providerCallCount,
      successful: successfulResearch,
      inconclusive: inconclusiveResearch,
      failed: failedResearch,
      priorResearchReused: reuseCount,
      newQuick,
      newDeep,
      avoidanceRatio: researchAvoidance,
      reuseRate: researchReuse,
      byPhase,
      usage: {
        inputTokens: researchInputObserved ? researchInputTokens : null,
        outputTokens: researchOutputObserved ? researchOutputTokens : null,
        durationMs: researchDurationObserved ? researchDurationMs : null,
        providerReportedCost: researchCostObserved ? researchCost : null,
        subagentCount: researchSubagentsObserved ? researchSubagents : null,
        recordsWithUsage,
        providerCalls: providerCallCount,
        coverage: providerCallCount === 0 ? null : Math.min(1, recordsWithUsage / providerCallCount),
      },
    },
    cooldown: {
      episodes: cooldownEpisodes,
      observations: eventTypes('resource_cooldown_observed').length,
      totalDurationMs: cooldownDurationKnown ? cooldownDurationMs : null,
      usefulWorkDuringSubscriptionCooldown: cooldownCompletedKeys.size,
      secondaryImplementationWorkDuringCooldown: secondaryImplementationDuringCooldown,
      researchWorkDuringCooldown: researchDuringCooldown,
      strongRequiredWaiting: cooldownWaitingKeys.size,
      avoidableIdlePeriods,
      intervals: cooldownIntervals.sort((left, right) =>
        left.startedAt.localeCompare(right.startedAt, 'en')
        || left.objectiveNodeId.localeCompare(right.objectiveNodeId, 'en')),
      timeline: cooldownTimeline,
    },
    attempts: {
      uniqueImplementationAttempts: implementationAttempts.length,
      meanPerCompletedWorkUnit: meanAttempts,
      medianPerCompletedWorkUnit: median(attemptCountsForCompleted),
      maxPerWorkUnit: attemptCountsForCompleted.length === 0 ? 0 : Math.max(...attemptCountsForCompleted),
      workUnitsWithMultipleAttempts: attemptCountsForCompleted.filter((value) => value > 1).length,
      byKind: implementationByKind,
      completedWorkUnitsPerImplementationAttempt: completedPerAttempt,
      completedWorkUnitsPerStrongBuilderCall: completedPerStrong,
      completedEligibleWorkUnitsPerSecondaryAttempt: completedEligiblePerSecondary,
    },
    verification: {
      attempts: evaluations.length,
      passes: evaluationPasses.length,
      failures: evaluationFailures.length,
      otherVerdicts: evaluations.length - evaluationPasses.length - evaluationFailures.length,
      failuresByBuilderBackend: failuresByBackend,
      failuresRecoveredByRepair,
      failuresRecoveredByStrongFallback,
    },
    closure: {
      available: closureTotals !== undefined,
      items: closureTotals?.total ?? 0,
      earned: closureTotals?.verified ?? 0,
      waived: closureTotals?.waived ?? 0,
      unresolved:
        closureTotals === undefined
          ? 0
          : closureTotals.total - closureTotals.verified - closureTotals.waived - closureTotals.notApplicable,
      completionGateOutcome: closureOutcome,
      ratio: closureTotals === undefined ? null : closureRatio(closureTotals),
    },
    human: {
      decisionsBeforeSeal,
      approvals: facts.seal?.sealedAt === undefined ? 0 : 1,
      authorityEscalationsAfterSeal: facts.autonomy.humanAuthorityEscalationsAfterSeal,
      interventionsAfterSeal: facts.autonomy.humanInterventionsAfterSeal,
      unexpectedBlockersAfterSeal: unexpectedBlocks,
      zeroTouchAfterSeal: facts.autonomy.humanInterventionsAfterSeal === 0,
      byKind: humanByKind,
    },
    reliability: {
      failureSources,
      recoveryActions,
      noProgressDetections,
      repeatedProblemFingerprints,
      legitimateResourceWaitsExcluded: resourceWaitEvents,
      processRestarts: eventTypes('job_resumed').length,
      supervisorRestarts: eventTypes('driver_restarted').length + eventTypes('supervisor_lease_reclaimed').length,
      candidatesPersisted,
      candidatesReusedAfterRestart: candidatesReused,
      candidateRebuildsAfterRestart: candidateRebuilds,
      candidatesLostOrUnreadable: candidateRebuilds,
      candidateReadyResumes: candidatesReused,
      integrationRetries,
      completedWorkRedoCount,
      completedWorkReusedAfterRestart,
      attemptsIncorrectlyRepeated: completedWorkRedoCount,
      unexpectedBlocks,
      unrecoveredDriverDeaths,
    },
    efficiency: {
      strongBuilderAvoidanceRatio: strongAvoidance,
      strongBuilderCallsAvoided: eligibleCompletedWithoutStrong.length,
      completedWorkUnitsPerImplementationAttempt: completedPerAttempt,
      baseline: facts.baseline === undefined
        ? null
        : {
            kind: facts.baseline.kind,
            reportId: facts.baseline.reportId,
            strongBuilderAttempts: facts.baseline.strongBuilderAttempts,
            sameVerificationOutcome: facts.baseline.verificationOutcome === overallVerification,
            sameClosureOutcome: facts.baseline.closureOutcome === closureOutcome,
          },
    },
    qualificationSummary: {
      strongBuilderAvoidanceRatio: strongAvoidance.value,
      secondaryInitialSuccessRate: secondaryInitial.value,
      secondaryRepairRecoveryRate: secondaryRepair.value,
      secondaryToStrongFallback: fallbackUnits.length,
      strongImplementationTokens: strongTokens.completeTokens,
      researchAvoidanceRatio: researchAvoidance.value,
      newResearchCalls: providerCallCount,
      researchReuse: reuseCount,
      usefulWorkDuringSubscriptionCooldown: cooldownCompletedKeys.size,
      humanInterventionsAfterSeal: facts.autonomy.humanInterventionsAfterSeal,
      completedWorkRedoCount,
      unexpectedBlocks,
      unrecoveredDriverDeaths,
    },
    diagnostics: diagnostics.slice(0, 200),
  });
  return report;
}

function cooldownEventDetail(event: JobEvent): string {
  switch (event.type) {
    case 'resource_cooldown_started':
      return `Strong resource cooldown started (${String(event['availability'] ?? 'availability unknown')}).`;
    case 'resource_cooldown_observed':
      return 'Strong resource cooldown was observed again; this is not a new episode.';
    case 'work_unit_resource_wait_started':
      return `WorkUnit ${String(event['workUnitId'] ?? '(unknown)')} entered a Strong resource wait.`;
    case 'work_unit_resource_wait_ended':
      return `WorkUnit ${String(event['workUnitId'] ?? '(unknown)')} left its Strong resource wait.`;
    case 'resource_wait_entered':
      return 'The job entered a global resource wait because no permitted work remained runnable.';
    case 'useful_work_during_cooldown':
      return `${Number(event['newlyCompleted'] ?? 0)} additional WorkUnit(s) completed during cooldown.`;
    case 'resource_recovered':
      return 'The Strong resource recovered and waiting work was released.';
    default:
      return event.type;
  }
}

/** Load the current job's durable facts through existing package read APIs. */
export function collectExecutionTelemetryFacts(
  deps: AutonomyDeps,
  jobId: string,
  options: ComputeExecutionTelemetryOptions = {},
): ExecutionTelemetryFacts {
  const job = requireJobState(deps.workspace, jobId);
  const eventPage = readJobEvents(deps.workspace, jobId, { limit: 500 });
  const objectives: ObjectiveTelemetryFacts[] = listObjectiveNodes(deps.workspace, jobId).map(
    (objectiveNodeId) => ({
      objectiveNodeId,
      graph: readLatestWorkGraph(deps.workspace, jobId, objectiveNodeId),
      routingStates: readBuilderRoutingStates(deps.workspace, jobId, objectiveNodeId),
      cooldown: readObjectiveCooldownState(deps.workspace, jobId, objectiveNodeId),
      evaluations: readEvaluations(deps.workspace, jobId, objectiveNodeId),
    }),
  );
  const researchTelemetryRead = readResearchTelemetry(deps.workspace);
  const researchRecords = listResearchRecords(deps.workspace);
  const binding = readSealBinding(deps.workspace, jobId);
  const seal = readJobSeal(deps.workspace, jobId);
  return {
    job,
    events: eventPage.events,
    eventTotal: eventPage.total,
    ledger: readExecutionLedger(deps.workspace, jobId),
    objectives,
    researchTelemetry: researchTelemetryRead.telemetry,
    ...(researchTelemetryRead.diagnostic !== undefined
      ? { researchTelemetryDiagnostic: researchTelemetryRead.diagnostic }
      : {}),
    researchRecords: researchRecords.records,
    researchRecordDiagnostics: researchRecords.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
    })),
    researchUses: listResearchUseRecords(deps.workspace),
    autonomy: deriveAutonomyTelemetry(deps, { jobId }),
    closure: readClosureLedger(deps.workspace, jobId),
    ...(binding !== undefined ? { binding } : {}),
    ...(seal !== undefined ? { seal } : {}),
    generatedAt: nowIso(deps),
    ...(options.specbridgeVersion !== undefined ? { specbridgeVersion: options.specbridgeVersion } : {}),
    secondaryBuildStrategy: deps.config.orchestration.jobs.objectives.secondaryBuilder.strategy,
    researchStrategy: deps.config.research.strategy,
    runnerProfiles: Object.keys(deps.config.runnerProfiles),
    currentAutonomyPolicy: deps.config.autonomy,
    closurePolicy: deps.config.autonomy.closure,
  };
}

export function executionTelemetryReportFile(workspace: WorkspaceInfo, jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(jobId)) {
    throw new Error(`Invalid job id "${jobId}".`);
  }
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, 'reports', `job-${jobId}-telemetry.json`),
  );
}

export function persistExecutionTelemetryReport(
  workspace: WorkspaceInfo,
  report: ExecutionTelemetryReport,
): string {
  const validated = executionTelemetryReportSchema.parse(report);
  const file = executionTelemetryReportFile(workspace, validated.jobId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return file;
}

export type ExecutionTelemetryReportReadResult =
  | { kind: 'ok'; report: ExecutionTelemetryReport }
  | { kind: 'missing' }
  | { kind: 'invalid'; problem: string };

export function readExecutionTelemetryReport(
  workspace: WorkspaceInfo,
  jobId: string,
): ExecutionTelemetryReportReadResult {
  const file = executionTelemetryReportFile(workspace, jobId);
  try {
    const parsed = executionTelemetryReportSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success
      ? { kind: 'ok', report: parsed.data }
      : { kind: 'invalid', problem: 'stored execution telemetry report is schema-invalid' };
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', problem: 'stored execution telemetry report is unreadable' };
  }
}

/** Derive a fresh report; persistence is explicit and never required by MCP reads. */
export function computeExecutionTelemetryReport(
  deps: AutonomyDeps,
  jobId: string,
  options: ComputeExecutionTelemetryOptions = {},
): ExecutionTelemetryReport {
  const report = deriveExecutionTelemetryReport(
    collectExecutionTelemetryFacts(deps, jobId, options),
  );
  if (options.persist === true) persistExecutionTelemetryReport(deps.workspace, report);
  return report;
}

export interface ExecutionTelemetryComparison {
  strongOnlyJobId: string;
  mixedJobId: string;
  strongBuilderAttempts: { strongOnly: number; mixed: number; avoided: number };
  secondaryBuilderAttempts: { strongOnly: number; mixed: number };
  implementationAttempts: { strongOnly: number; mixed: number };
  acceptanceEqual: boolean;
  verificationEqual: boolean;
  closureEqual: boolean;
  evidenceAvailable: boolean;
  correctnessEqual: boolean;
  /** Engineering evidence only; no statistical claim is made. */
  qualificationOnly: true;
}

/** Bounded Strong-only vs mixed-compute qualification comparison. */
export function compareExecutionTelemetryReports(
  strongOnly: ExecutionTelemetryReport,
  mixed: ExecutionTelemetryReport,
): ExecutionTelemetryComparison {
  const verificationEqual = strongOnly.outcome.verification === mixed.outcome.verification;
  const closureEqual = strongOnly.outcome.closure === mixed.outcome.closure;
  const acceptanceEqual = strongOnly.outcome.status === mixed.outcome.status;
  const evidenceAvailable =
    strongOnly.outcome.verification !== 'UNAVAILABLE'
    && mixed.outcome.verification !== 'UNAVAILABLE'
    && strongOnly.outcome.closure !== 'UNAVAILABLE'
    && mixed.outcome.closure !== 'UNAVAILABLE';
  return {
    strongOnlyJobId: strongOnly.jobId,
    mixedJobId: mixed.jobId,
    strongBuilderAttempts: {
      strongOnly: strongOnly.strong.builderAttempts,
      mixed: mixed.strong.builderAttempts,
      avoided: Math.max(0, strongOnly.strong.builderAttempts - mixed.strong.builderAttempts),
    },
    secondaryBuilderAttempts: {
      strongOnly: strongOnly.attempts.byKind['SECONDARY'] ?? 0,
      mixed: mixed.attempts.byKind['SECONDARY'] ?? 0,
    },
    implementationAttempts: {
      strongOnly: strongOnly.attempts.uniqueImplementationAttempts,
      mixed: mixed.attempts.uniqueImplementationAttempts,
    },
    acceptanceEqual,
    verificationEqual,
    closureEqual,
    evidenceAvailable,
    correctnessEqual: acceptanceEqual && verificationEqual && closureEqual && evidenceAvailable,
    qualificationOnly: true,
  };
}
