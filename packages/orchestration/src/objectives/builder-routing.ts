import { z } from 'zod';
import { sha256Hex } from '@specbridge/core';
import type { SchedulerMode } from '../scheduling/vocabulary.js';
import type { SecondaryBuilderPacket } from './secondary-builder.js';
import type {
  SecondaryEligibilityDecision,
  WorkReadinessAssessment,
} from './work-readiness.js';

/** Phase 7 routing is additive runtime policy, never product authority. */
export const BUILDER_ROUTING_DECISION_SCHEMA_VERSION = '1.0.0';
export const BUILDER_ROUTING_STATE_SCHEMA_VERSION = '1.0.0';
export const BUILDER_ROUTING_TELEMETRY_SCHEMA_VERSION = '1.0.0';

export const SECONDARY_BUILD_STRATEGIES = ['OFF', 'AUTO', 'PREFER'] as const;
export type SecondaryBuildStrategy = (typeof SECONDARY_BUILD_STRATEGIES)[number];

export const SECONDARY_AVAILABILITY_STATUSES = [
  'AVAILABLE',
  'UNAVAILABLE',
  'MISCONFIGURED',
  'UNHEALTHY',
  'START_FAILED',
  'TIMEOUT',
] as const;
export type SecondaryAvailabilityStatus = (typeof SECONDARY_AVAILABILITY_STATUSES)[number];

export const BUILDER_ROUTING_BACKENDS = [
  'SECONDARY',
  'STRONG',
  'RESEARCH',
  'AUTHORITY',
  'CONTEXT_RECOVERY',
  'WAIT',
] as const;
export type BuilderRoutingBackend = (typeof BUILDER_ROUTING_BACKENDS)[number];

export const BUILDER_ROUTING_REASON_CODES = [
  'SECONDARY_ELIGIBLE',
  'SECONDARY_PREFERRED_POLICY',
  'SECONDARY_AUTO_POLICY',
  'SECONDARY_AVAILABLE',
  'SECONDARY_UNAVAILABLE',
  'EXPLICIT_SECONDARY_SELECTION',
  'STRATEGY_OFF',
  'STRONG_REQUIRED',
  'RESEARCH_REQUIRED',
  'AUTHORITY_REQUIRED',
  'CONTEXT_RECOVERY_REQUIRED',
  'DEPENDENCY_NOT_READY',
  'SUBSCRIPTION_CONSERVE',
  'SUBSCRIPTION_HARVEST',
  'SUBSCRIPTION_EXHAUSTED',
  'CRITICAL_WORK_PREFERS_STRONG',
  'SECONDARY_REPAIR_EXHAUSTED',
  'SECONDARY_NO_PROGRESS',
  'SECONDARY_VERIFICATION_FAILED',
  'SECONDARY_RESOURCE_FAILURE',
  'PRIOR_CANDIDATE_REPLAY_FAILED',
  'STRONG_FALLBACK',
] as const;
export type BuilderRoutingReasonCode = (typeof BUILDER_ROUTING_REASON_CODES)[number];

const shortText = z.string().min(1).max(512);
const boundedText = z.string().min(1).max(2_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const builderRoutingReasonSchema = z.object({
  code: z.enum(BUILDER_ROUTING_REASON_CODES),
  message: boundedText,
  evidenceRefs: z.array(shortText).max(30).default([]),
}).strict();
export type BuilderRoutingReason = z.infer<typeof builderRoutingReasonSchema>;

export const secondaryAvailabilitySchema = z.object({
  status: z.enum(SECONDARY_AVAILABILITY_STATUSES),
  detail: boundedText,
}).strict();
export type SecondaryAvailability = z.infer<typeof secondaryAvailabilitySchema>;

export const builderRoutingDecisionSchema = z.object({
  schemaVersion: z.literal(BUILDER_ROUTING_DECISION_SCHEMA_VERSION),
  decisionId: shortText,
  jobId: shortText,
  objectiveNodeId: shortText,
  workUnitId: shortText,
  workUnitAttempt: z.number().int().min(1),
  workIdentity: sha256,
  strategy: z.enum(SECONDARY_BUILD_STRATEGIES),
  eligibility: z.enum([
    'ELIGIBLE',
    'STRONG_REQUIRED',
    'NEEDS_RESEARCH',
    'NEEDS_AUTHORITY',
    'NEEDS_CONTEXT',
    'NOT_READY',
  ]),
  selectedBackend: z.enum(BUILDER_ROUTING_BACKENDS),
  reasons: z.array(builderRoutingReasonSchema).min(1).max(30),
  secondaryAvailability: z.enum(SECONDARY_AVAILABILITY_STATUSES),
  quotaState: shortText.optional(),
  assessmentRef: shortText,
  assessmentHash: sha256,
  decidedAt: shortText,
  contentHash: sha256,
}).strict();
export type BuilderRoutingDecision = z.infer<typeof builderRoutingDecisionSchema>;

export const BUILDER_ATTEMPT_KINDS = [
  'SECONDARY',
  'SECONDARY_REPAIR',
  'STRONG',
  'STRONG_FALLBACK',
] as const;
export type BuilderAttemptKind = (typeof BUILDER_ATTEMPT_KINDS)[number];

export const BUILDER_ATTEMPT_OUTCOMES = [
  'CANDIDATE_READY',
  'SUCCEEDED',
  'FAILED_VERIFICATION',
  'FAILED_IMPLEMENTATION',
  'FAILED_RESOURCE',
  'FAILED_OUTPUT',
  'CANCELLED',
] as const;
export type BuilderAttemptOutcome = (typeof BUILDER_ATTEMPT_OUTCOMES)[number];

export const builderRoutingAttemptSchema = z.object({
  attemptId: shortText,
  sequence: z.number().int().min(1),
  workUnitAttempt: z.number().int().min(1),
  kind: z.enum(BUILDER_ATTEMPT_KINDS),
  outcome: z.enum(BUILDER_ATTEMPT_OUTCOMES),
  candidateRef: shortText.optional(),
  patchRef: shortText.optional(),
  changedFiles: z.array(shortText).max(500).default([]),
  packetHash: sha256.optional(),
  verificationSummary: z.array(boundedText).max(30).default([]),
  failureSummary: boundedText.optional(),
  problemFingerprint: sha256.optional(),
  candidatePatchHash: sha256.optional(),
  noProgress: z.boolean().default(false),
  durationMs: z.number().int().min(0).optional(),
  inputTokens: z.number().int().min(0).nullable().optional(),
  outputTokens: z.number().int().min(0).nullable().optional(),
  startedAt: shortText,
  completedAt: shortText,
}).strict();
export type BuilderRoutingAttempt = z.infer<typeof builderRoutingAttemptSchema>;

export const builderRoutingStateSchema = z.object({
  schemaVersion: z.literal(BUILDER_ROUTING_STATE_SCHEMA_VERSION),
  jobId: shortText,
  objectiveNodeId: shortText,
  workUnitId: shortText,
  workIdentity: sha256,
  strategy: z.enum(SECONDARY_BUILD_STRATEGIES),
  initialEligibility: z.enum([
    'ELIGIBLE',
    'STRONG_REQUIRED',
    'NEEDS_RESEARCH',
    'NEEDS_AUTHORITY',
    'NEEDS_CONTEXT',
    'NOT_READY',
  ]),
  decisions: z.array(builderRoutingDecisionSchema).max(30),
  attempts: z.array(builderRoutingAttemptSchema).max(12),
  repairAttemptsUsed: z.number().int().min(0).max(10),
  maxRepairAttempts: z.number().int().min(0).max(10),
  escalationStatus: z.enum(['NONE', 'STRONG_FALLBACK_REQUIRED', 'COMPLETE', 'FAILED']),
  finalBackend: z.enum(['SECONDARY', 'STRONG']).optional(),
  createdAt: shortText,
  updatedAt: shortText,
  contentHash: sha256,
}).strict();
export type BuilderRoutingState = z.infer<typeof builderRoutingStateSchema>;

const routingCountsSchema = z.record(z.string(), z.number().int().min(0));
export const builderRoutingTelemetrySchema = z.object({
  schemaVersion: z.literal(BUILDER_ROUTING_TELEMETRY_SCHEMA_VERSION),
  eligibleImplementationUnits: z.number().int().min(0),
  eligibleCompletedUnits: z.number().int().min(0),
  eligibleCompletedWithoutStrong: z.number().int().min(0),
  strongBuilderAvoidanceRatio: z.number().min(0).max(1).nullable(),
  outcomeCounts: routingCountsSchema,
  routeCounts: routingCountsSchema,
  repairAttempts: z.number().int().min(0),
  secondaryInputTokens: z.number().int().min(0).nullable(),
  secondaryOutputTokens: z.number().int().min(0).nullable(),
  secondaryLatencyMs: z.number().int().min(0),
  generatedAt: shortText,
}).strict();
export type BuilderRoutingTelemetry = z.infer<typeof builderRoutingTelemetrySchema>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stateHash(state: Omit<BuilderRoutingState, 'contentHash'>): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...semantic } = state;
  return sha256Hex(stableStringify(semantic));
}

/**
 * Stable identity for one routing/repair problem.
 *
 * Attempt numbers, timestamps, prior-failure text, and source bytes changed
 * by the candidate itself are excluded. Approved truth, task meaning,
 * targets, verification, dependencies, and research remain bound. Packet
 * quality is deliberately excluded: retrieval quality and plan references
 * are recomputed after replaying a failed candidate, so including them would
 * make the candidate's own bytes look like an external replan. This is what
 * lets a repair continue the same work while a material replan starts a fresh
 * chain.
 */
export function buildBuilderRoutingWorkIdentity(input: {
  assessment: WorkReadinessAssessment;
  packet?: SecondaryBuilderPacket | undefined;
}): string {
  const identity = input.assessment.inputIdentity;
  return sha256Hex(stableStringify({
    workUnitHash: identity.workUnitHash,
    contractSnapshotHash: input.packet?.contractSnapshotHash ?? null,
    researchEvidenceHash: identity.researchEvidenceHash,
    verificationPolicyHash: identity.verificationPolicyHash,
    dependencyStateHash: identity.dependencyStateHash,
    targets: input.packet?.targets.map((target) => ({
      repositoryId: target.repositoryId,
      path: target.path,
      symbols: target.symbols,
    })) ?? [],
  }));
}

function reason(
  code: BuilderRoutingReasonCode,
  message: string,
  evidenceRefs: readonly string[] = [],
): BuilderRoutingReason {
  return builderRoutingReasonSchema.parse({ code, message, evidenceRefs: [...evidenceRefs].slice(0, 30) });
}

function decisionHash(decision: Omit<BuilderRoutingDecision, 'contentHash'>): string {
  const { decidedAt: _decidedAt, ...semantic } = decision;
  return sha256Hex(stableStringify(semantic));
}

export interface DecideBuilderRoutingInput {
  decision: SecondaryEligibilityDecision;
  workIdentity: string;
  strategy: SecondaryBuildStrategy;
  availability: SecondaryAvailability;
  schedulerMode?: SchedulerMode | undefined;
  critical?: boolean | undefined;
  explicitSecondarySelection?: boolean | undefined;
  priorState?: BuilderRoutingState | undefined;
  forceStrongReason?: string | undefined;
  decidedAt: string;
}

/** Pure, bounded routing. Hard eligibility precedes every preference. */
export function decideBuilderRouting(input: DecideBuilderRoutingInput): BuilderRoutingDecision {
  const eligibility = input.decision.status;
  const reasons: BuilderRoutingReason[] = [];
  let selectedBackend: BuilderRoutingBackend;

  if (eligibility === 'NEEDS_RESEARCH') {
    selectedBackend = 'RESEARCH';
    reasons.push(reason('RESEARCH_REQUIRED', 'External knowledge must be resolved before implementation.'));
  } else if (eligibility === 'NEEDS_AUTHORITY') {
    selectedBackend = 'AUTHORITY';
    reasons.push(reason('AUTHORITY_REQUIRED', 'Human or approved-contract authority is required before implementation.'));
  } else if (eligibility === 'NEEDS_CONTEXT') {
    selectedBackend = 'CONTEXT_RECOVERY';
    reasons.push(reason('CONTEXT_RECOVERY_REQUIRED', 'Bounded context recovery must run before implementation.'));
  } else if (eligibility === 'NOT_READY') {
    selectedBackend = 'WAIT';
    reasons.push(reason('DEPENDENCY_NOT_READY', 'Dependencies or durable state are not ready; no builder tokens are spent.'));
  } else if (eligibility === 'STRONG_REQUIRED') {
    selectedBackend = 'STRONG';
    reasons.push(reason('STRONG_REQUIRED', 'Phase 6 requires Strong reasoning for this WorkUnit.'));
  } else {
    reasons.push(reason('SECONDARY_ELIGIBLE', 'Phase 6 admits this WorkUnit to Secondary routing.'));
    const prior = input.priorState?.workIdentity === input.workIdentity ? input.priorState : undefined;
    const last = prior?.attempts.at(-1);
    const stickyStrong =
      prior?.escalationStatus === 'STRONG_FALLBACK_REQUIRED'
      || prior?.escalationStatus === 'FAILED'
      || prior?.attempts.some((attempt) => attempt.kind === 'STRONG_FALLBACK') === true;
    if (input.forceStrongReason !== undefined) {
      selectedBackend = 'STRONG';
      reasons.push(reason('PRIOR_CANDIDATE_REPLAY_FAILED', input.forceStrongReason.slice(0, 2_000)));
      reasons.push(reason('STRONG_FALLBACK', 'Strong receives the preserved patch as evidence and reconciles it explicitly.'));
    } else if (stickyStrong) {
      selectedBackend = 'STRONG';
      reasons.push(reason(
        last?.noProgress === true ? 'SECONDARY_NO_PROGRESS' : 'SECONDARY_REPAIR_EXHAUSTED',
        last?.noProgress === true
          ? 'Secondary repeated the same problem for this content identity.'
          : 'The bounded Secondary repair budget is exhausted for this content identity.',
      ));
      reasons.push(reason('STRONG_FALLBACK', 'Strong continues from the preserved Secondary candidate and failure evidence.'));
    } else if (input.explicitSecondarySelection === true) {
      if (input.availability.status === 'AVAILABLE') {
        selectedBackend = 'SECONDARY';
        reasons.push(reason('EXPLICIT_SECONDARY_SELECTION', 'The caller explicitly selected Secondary for qualification or controlled execution.'));
        reasons.push(reason('SECONDARY_AVAILABLE', input.availability.detail));
      } else {
        selectedBackend = 'STRONG';
        reasons.push(reason('SECONDARY_UNAVAILABLE', input.availability.detail));
        reasons.push(reason('STRONG_FALLBACK', 'Optional Secondary is unavailable; Strong remains the runnable builder.'));
      }
    } else if (input.strategy === 'OFF') {
      selectedBackend = 'STRONG';
      reasons.push(reason('STRATEGY_OFF', 'Automatic Secondary execution is disabled.'));
    } else if (input.availability.status !== 'AVAILABLE') {
      selectedBackend = 'STRONG';
      reasons.push(reason('SECONDARY_UNAVAILABLE', input.availability.detail));
      reasons.push(reason('STRONG_FALLBACK', 'Optional Secondary is unavailable; Strong remains the runnable builder.'));
    } else if (input.strategy === 'PREFER') {
      selectedBackend = 'SECONDARY';
      reasons.push(reason('SECONDARY_PREFERRED_POLICY', 'PREFER routes eligible work to a usable Secondary first.'));
      reasons.push(reason('SECONDARY_AVAILABLE', input.availability.detail));
    } else if (input.schedulerMode === 'HARVEST') {
      selectedBackend = 'STRONG';
      reasons.push(reason('SUBSCRIPTION_HARVEST', 'HARVEST uses prepaid Strong capacity that would otherwise expire.'));
    } else if (input.critical === true) {
      selectedBackend = 'STRONG';
      reasons.push(reason('CRITICAL_WORK_PREFERS_STRONG', 'Existing criticality policy prefers Strong execution.'));
    } else {
      selectedBackend = 'SECONDARY';
      reasons.push(reason('SECONDARY_AUTO_POLICY', 'AUTO selected Secondary from current deterministic scheduler facts.'));
      reasons.push(reason('SECONDARY_AVAILABLE', input.availability.detail));
      if (input.schedulerMode === 'CONSERVE') {
        reasons.push(reason('SUBSCRIPTION_CONSERVE', 'CONSERVE protects scarce prepaid Strong capacity.'));
      } else if (input.schedulerMode === 'EXHAUSTED_5H' || input.schedulerMode === 'EXHAUSTED_WEEKLY') {
        reasons.push(reason('SUBSCRIPTION_EXHAUSTED', 'Prepaid Strong capacity is exhausted; eligible local work remains runnable.'));
      }
    }
  }

  const base = {
    schemaVersion: BUILDER_ROUTING_DECISION_SCHEMA_VERSION,
    decisionId: `${input.decision.workUnitId}-a${String(input.decision.attempt).padStart(2, '0')}-route`,
    jobId: input.decision.jobId,
    objectiveNodeId: input.decision.objectiveNodeId,
    workUnitId: input.decision.workUnitId,
    workUnitAttempt: input.decision.attempt,
    workIdentity: input.workIdentity,
    strategy: input.strategy,
    eligibility,
    selectedBackend,
    reasons,
    secondaryAvailability: input.availability.status,
    ...(input.schedulerMode !== undefined ? { quotaState: input.schedulerMode } : {}),
    assessmentRef: input.decision.assessmentRef,
    assessmentHash: input.decision.assessmentHash,
    decidedAt: input.decidedAt,
  } satisfies Omit<BuilderRoutingDecision, 'contentHash'>;
  return builderRoutingDecisionSchema.parse({ ...base, contentHash: decisionHash(base) });
}

export function recordBuilderRoutingDecision(input: {
  prior?: BuilderRoutingState | undefined;
  decision: BuilderRoutingDecision;
  maxRepairAttempts: number;
  at: string;
}): BuilderRoutingState {
  const same = input.prior?.workIdentity === input.decision.workIdentity ? input.prior : undefined;
  const base = {
    schemaVersion: BUILDER_ROUTING_STATE_SCHEMA_VERSION,
    jobId: input.decision.jobId,
    objectiveNodeId: input.decision.objectiveNodeId,
    workUnitId: input.decision.workUnitId,
    workIdentity: input.decision.workIdentity,
    strategy: input.decision.strategy,
    initialEligibility: same?.initialEligibility ?? input.decision.eligibility,
    decisions: [...(same?.decisions ?? []), input.decision].slice(-30),
    attempts: same?.attempts ?? [],
    repairAttemptsUsed: same?.repairAttemptsUsed ?? 0,
    maxRepairAttempts: input.maxRepairAttempts,
    escalationStatus: same?.escalationStatus ?? 'NONE',
    ...(same?.finalBackend !== undefined ? { finalBackend: same.finalBackend } : {}),
    createdAt: same?.createdAt ?? input.at,
    updatedAt: input.at,
  } satisfies Omit<BuilderRoutingState, 'contentHash'>;
  return builderRoutingStateSchema.parse({ ...base, contentHash: stateHash(base) });
}

export function builderAttemptKindFor(
  decision: BuilderRoutingDecision,
  state: BuilderRoutingState,
): BuilderAttemptKind {
  if (decision.selectedBackend === 'SECONDARY') {
    const ranSecondary = state.attempts.some((attempt) =>
      (attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR')
      && attempt.outcome !== 'FAILED_RESOURCE'
      && attempt.outcome !== 'CANCELLED');
    return ranSecondary ? 'SECONDARY_REPAIR' : 'SECONDARY';
  }
  const hasSecondaryEvidence = state.attempts.some((attempt) =>
    attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR');
  return hasSecondaryEvidence ? 'STRONG_FALLBACK' : 'STRONG';
}

export function builderProblemFingerprint(input: {
  failureKind: string;
  verificationSummary?: readonly string[] | undefined;
  candidatePatch?: string | undefined;
}): { problemFingerprint: string; candidatePatchHash?: string | undefined } {
  const candidatePatchHash = input.candidatePatch === undefined
    ? undefined
    : sha256Hex(input.candidatePatch.replace(/\r\n/g, '\n').trim());
  return {
    problemFingerprint: sha256Hex(stableStringify({
      failureKind: input.failureKind,
      verificationSummary: [...(input.verificationSummary ?? [])],
      candidatePatchHash: candidatePatchHash ?? null,
    })),
    ...(candidatePatchHash !== undefined ? { candidatePatchHash } : {}),
  };
}

export function appendBuilderRoutingAttempt(
  state: BuilderRoutingState,
  attemptInput: Omit<BuilderRoutingAttempt, 'sequence' | 'noProgress'>,
): BuilderRoutingState {
  const previousFingerprints = new Set(
    state.attempts
      .filter((entry) => entry.kind === 'SECONDARY' || entry.kind === 'SECONDARY_REPAIR')
      .map((entry) => entry.problemFingerprint)
      .filter((entry): entry is string => entry !== undefined),
  );
  const noProgress =
    attemptInput.problemFingerprint !== undefined
    && previousFingerprints.has(attemptInput.problemFingerprint);
  const attempt = builderRoutingAttemptSchema.parse({
    ...attemptInput,
    sequence: state.attempts.length + 1,
    noProgress,
  });
  const attempts = [...state.attempts, attempt].slice(-12);
  const repairAttemptsUsed = attempts.filter((entry) =>
    entry.kind === 'SECONDARY_REPAIR'
    && entry.outcome !== 'FAILED_RESOURCE'
    && entry.outcome !== 'CANCELLED').length;
  const passed = attempt.outcome === 'SUCCEEDED';
  const secondaryFailure =
    (attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR')
    && attempt.outcome !== 'CANDIDATE_READY'
    && attempt.outcome !== 'SUCCEEDED'
    && attempt.outcome !== 'CANCELLED';
  const requiresStrong = secondaryFailure && (
    attempt.outcome === 'FAILED_RESOURCE'
    || attempt.noProgress
    || repairAttemptsUsed >= state.maxRepairAttempts
  );
  const escalationStatus: BuilderRoutingState['escalationStatus'] = passed
    ? 'COMPLETE'
    : requiresStrong
      ? 'STRONG_FALLBACK_REQUIRED'
      : attempt.kind === 'STRONG' || attempt.kind === 'STRONG_FALLBACK'
        ? 'FAILED'
        : 'NONE';
  const base = {
    ...state,
    attempts,
    repairAttemptsUsed,
    escalationStatus,
    ...(passed
      ? { finalBackend: attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR' ? 'SECONDARY' as const : 'STRONG' as const }
      : {}),
    updatedAt: attempt.completedAt,
  };
  const { contentHash: _contentHash, ...withoutHash } = base;
  return builderRoutingStateSchema.parse({ ...withoutHash, contentHash: stateHash(withoutHash) });
}

export function finalizeBuilderRoutingAttempt(input: {
  state: BuilderRoutingState;
  workUnitAttempt: number;
  kind: BuilderAttemptKind;
  outcome: Exclude<BuilderAttemptOutcome, 'CANDIDATE_READY'>;
  failureSummary?: string | undefined;
  verificationSummary?: readonly string[] | undefined;
  problemFingerprint?: string | undefined;
  candidatePatchHash?: string | undefined;
  completedAt: string;
}): BuilderRoutingState {
  const index = input.state.attempts.findIndex((attempt) =>
    attempt.workUnitAttempt === input.workUnitAttempt && attempt.kind === input.kind);
  if (index < 0) return input.state;
  const attempts = input.state.attempts.map((attempt, attemptIndex) => {
    if (attemptIndex !== index) return attempt;
    return builderRoutingAttemptSchema.parse({
      ...attempt,
      outcome: input.outcome,
      ...(input.failureSummary !== undefined ? { failureSummary: input.failureSummary.slice(0, 2_000) } : {}),
      ...(input.verificationSummary !== undefined
        ? { verificationSummary: [...input.verificationSummary].map((entry) => entry.slice(0, 2_000)).slice(0, 30) }
        : {}),
      ...(input.problemFingerprint !== undefined ? { problemFingerprint: input.problemFingerprint } : {}),
      ...(input.candidatePatchHash !== undefined ? { candidatePatchHash: input.candidatePatchHash } : {}),
      completedAt: input.completedAt,
    });
  });
  const updatedAttempt = attempts[index]!;
  const repairAttemptsUsed = attempts.filter((entry) =>
    entry.kind === 'SECONDARY_REPAIR'
    && entry.outcome !== 'FAILED_RESOURCE'
    && entry.outcome !== 'CANCELLED').length;
  const previousFingerprints = new Set(
    attempts
      .slice(0, index)
      .filter((entry) => entry.kind === 'SECONDARY' || entry.kind === 'SECONDARY_REPAIR')
      .map((entry) => entry.problemFingerprint)
      .filter((entry): entry is string => entry !== undefined),
  );
  const noProgress =
    updatedAttempt.problemFingerprint !== undefined
    && previousFingerprints.has(updatedAttempt.problemFingerprint);
  attempts[index] = builderRoutingAttemptSchema.parse({ ...updatedAttempt, noProgress });
  const secondaryFailure =
    (input.kind === 'SECONDARY' || input.kind === 'SECONDARY_REPAIR')
    && input.outcome !== 'SUCCEEDED'
    && input.outcome !== 'CANCELLED';
  const requiresStrong = secondaryFailure && (
    input.outcome === 'FAILED_RESOURCE'
    || noProgress
    || repairAttemptsUsed >= input.state.maxRepairAttempts
  );
  const escalationStatus: BuilderRoutingState['escalationStatus'] = input.outcome === 'SUCCEEDED'
    ? 'COMPLETE'
    : requiresStrong
      ? 'STRONG_FALLBACK_REQUIRED'
      : input.kind === 'STRONG' || input.kind === 'STRONG_FALLBACK'
        ? 'FAILED'
        : 'NONE';
  const base = {
    ...input.state,
    attempts,
    repairAttemptsUsed,
    escalationStatus,
    ...(input.outcome === 'SUCCEEDED'
      ? { finalBackend: input.kind === 'SECONDARY' || input.kind === 'SECONDARY_REPAIR' ? 'SECONDARY' as const : 'STRONG' as const }
      : {}),
    updatedAt: input.completedAt,
  };
  const { contentHash: _contentHash, ...withoutHash } = base;
  return builderRoutingStateSchema.parse({ ...withoutHash, contentHash: stateHash(withoutHash) });
}

export function summarizeBuilderRouting(
  states: readonly BuilderRoutingState[],
  generatedAt: string,
): BuilderRoutingTelemetry {
  const current = [...states].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const eligible = current.filter((state) => state.initialEligibility === 'ELIGIBLE');
  const completed = eligible.filter((state) => state.escalationStatus === 'COMPLETE');
  const withoutStrong = completed.filter((state) =>
    !state.attempts.some((attempt) => attempt.kind === 'STRONG' || attempt.kind === 'STRONG_FALLBACK'));
  const outcomeCounts: Record<string, number> = {
    SecondaryEligible: eligible.length,
    SecondarySelected: 0,
    SecondaryInitialPass: 0,
    SecondaryRepairPass: 0,
    SecondaryToStrongFallback: 0,
    StrongRequiredDirect: 0,
    SecondaryUnavailableFallback: 0,
    NoModelNeeded: 0,
  };
  const routeCounts: Record<string, number> = {};
  let secondaryInputTokens = 0;
  let secondaryOutputTokens = 0;
  let inputTokensObserved = false;
  let outputTokensObserved = false;
  let secondaryLatencyMs = 0;
  for (const state of current) {
    for (const decision of state.decisions) {
      routeCounts[decision.selectedBackend] = (routeCounts[decision.selectedBackend] ?? 0) + 1;
      if (decision.selectedBackend === 'SECONDARY') outcomeCounts['SecondarySelected']! += 1;
      if (decision.eligibility === 'STRONG_REQUIRED' && decision.selectedBackend === 'STRONG') {
        outcomeCounts['StrongRequiredDirect']! += 1;
      }
      if (
        decision.selectedBackend === 'STRONG'
        && decision.reasons.some((entry) => entry.code === 'SECONDARY_UNAVAILABLE')
      ) {
        outcomeCounts['SecondaryUnavailableFallback']! += 1;
      }
      if (['RESEARCH', 'AUTHORITY', 'CONTEXT_RECOVERY', 'WAIT'].includes(decision.selectedBackend)) {
        outcomeCounts['NoModelNeeded']! += 1;
      }
    }
    for (const attempt of state.attempts) {
      if (attempt.kind === 'SECONDARY' && attempt.outcome === 'SUCCEEDED') outcomeCounts['SecondaryInitialPass']! += 1;
      if (attempt.kind === 'SECONDARY_REPAIR' && attempt.outcome === 'SUCCEEDED') outcomeCounts['SecondaryRepairPass']! += 1;
      if (attempt.kind === 'STRONG_FALLBACK') outcomeCounts['SecondaryToStrongFallback']! += 1;
      if (attempt.kind === 'SECONDARY' || attempt.kind === 'SECONDARY_REPAIR') {
        secondaryLatencyMs += attempt.durationMs ?? 0;
        if (attempt.inputTokens !== undefined && attempt.inputTokens !== null) {
          inputTokensObserved = true;
          secondaryInputTokens += attempt.inputTokens;
        }
        if (attempt.outputTokens !== undefined && attempt.outputTokens !== null) {
          outputTokensObserved = true;
          secondaryOutputTokens += attempt.outputTokens;
        }
      }
    }
  }
  return builderRoutingTelemetrySchema.parse({
    schemaVersion: BUILDER_ROUTING_TELEMETRY_SCHEMA_VERSION,
    eligibleImplementationUnits: eligible.length,
    eligibleCompletedUnits: completed.length,
    eligibleCompletedWithoutStrong: withoutStrong.length,
    strongBuilderAvoidanceRatio: completed.length === 0 ? null : withoutStrong.length / completed.length,
    outcomeCounts,
    routeCounts,
    repairAttempts: current.reduce((sum, state) => sum + state.repairAttemptsUsed, 0),
    secondaryInputTokens: inputTokensObserved ? secondaryInputTokens : null,
    secondaryOutputTokens: outputTokensObserved ? secondaryOutputTokens : null,
    secondaryLatencyMs,
    generatedAt,
  });
}

export function renderBuilderRouting(state: BuilderRoutingState): string {
  const latest = state.decisions.at(-1);
  const lines = [
    state.workUnitId,
    `Readiness: ${latest?.eligibility ?? state.initialEligibility}`,
    `Strategy: ${latest?.strategy ?? state.strategy}`,
    `Route: ${latest?.selectedBackend ?? '(none)'}`,
  ];
  for (const attempt of state.attempts) {
    lines.push(`Attempt ${attempt.sequence}: ${attempt.kind} — ${attempt.outcome}${attempt.noProgress ? ' (no progress)' : ''}`);
  }
  lines.push(`Repair budget: ${state.repairAttemptsUsed}/${state.maxRepairAttempts}`);
  lines.push(`Escalation: ${state.escalationStatus}`);
  if (state.finalBackend !== undefined) lines.push(`Final: PASS via ${state.finalBackend}`);
  return lines.join('\n');
}
