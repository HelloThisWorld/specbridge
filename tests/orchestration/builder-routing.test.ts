import { describe, expect, it } from 'vitest';
import { defaultResolvedAgentConfig, sha256Hex } from '@specbridge/core';
import type {
  BuilderAttemptKind,
  BuilderRoutingDecision,
  BuilderRoutingState,
  SecondaryEligibilityStatus,
} from '@specbridge/orchestration';
import {
  appendBuilderRoutingAttempt,
  builderAttemptKindFor,
  builderProblemFingerprint,
  builderRoutingDecisionSchema,
  decideBuilderRouting,
  readBuilderRoutingState,
  readBuilderRoutingTelemetry,
  recordBuilderRoutingDecision,
  renderBuilderRouting,
  secondaryEligibilityDecisionSchema,
  storeBuilderRoutingState,
  storeBuilderRoutingTelemetry,
  summarizeBuilderRouting,
} from '@specbridge/orchestration';
import { setupExecutionFixture } from '../helpers-execution.js';

const NOW = '2026-08-30T00:00:00.000Z';
const LATER = '2026-08-30T00:05:00.000Z';
const WORK_IDENTITY = sha256Hex('phase-7-work');

function eligibility(status: SecondaryEligibilityStatus = 'ELIGIBLE', attempt = 1) {
  return secondaryEligibilityDecisionSchema.parse({
    schemaVersion: '1.0.0',
    decisionId: `wu-1-a${String(attempt).padStart(2, '0')}-decision`,
    jobId: 'job-1',
    objectiveNodeId: 'node-1',
    workUnitId: 'wu-1',
    attempt,
    status,
    reasons: [{
      code: status === 'ELIGIBLE' ? 'CONCRETE_TARGET' :
        status === 'STRONG_REQUIRED' ? 'HIGH_DECISION_ENTROPY' :
          status === 'NEEDS_RESEARCH' ? 'KNOWLEDGE_EXTERNAL_UNKNOWN' :
            status === 'NEEDS_AUTHORITY' ? 'AUTHORITY_UNRESOLVED' :
              status === 'NEEDS_CONTEXT' ? 'CONTEXT_INSUFFICIENT' : 'DEPENDENCY_NOT_READY',
      message: `fixture ${status}`,
      evidenceRefs: [],
    }],
    assessmentRef: `readiness/wu-1-a${String(attempt).padStart(2, '0')}.json#assessment`,
    assessmentHash: sha256Hex(`assessment-${attempt}`),
    contentHash: sha256Hex(`eligibility-${status}-${attempt}`),
    decidedAt: NOW,
  });
}

function route(options: {
  status?: SecondaryEligibilityStatus;
  strategy?: 'OFF' | 'AUTO' | 'PREFER';
  availability?: 'AVAILABLE' | 'UNAVAILABLE';
  schedulerMode?: 'NORMAL' | 'CONSERVE' | 'HARVEST' | 'EXHAUSTED_5H' | 'EXHAUSTED_WEEKLY';
  explicit?: boolean;
  priorState?: BuilderRoutingState;
  attempt?: number;
  workIdentity?: string;
} = {}): BuilderRoutingDecision {
  const status = options.status ?? 'ELIGIBLE';
  const availability = options.availability ?? 'AVAILABLE';
  return decideBuilderRouting({
    decision: eligibility(status, options.attempt ?? 1),
    workIdentity: options.workIdentity ?? WORK_IDENTITY,
    strategy: options.strategy ?? 'AUTO',
    availability: {
      status: availability,
      detail: availability === 'AVAILABLE' ? 'healthy loopback endpoint' : 'local server unavailable',
    },
    ...(options.schedulerMode !== undefined ? { schedulerMode: options.schedulerMode } : {}),
    ...(options.explicit !== undefined ? { explicitSecondarySelection: options.explicit } : {}),
    ...(options.priorState !== undefined ? { priorState: options.priorState } : {}),
    decidedAt: NOW,
  });
}

function stateFor(decision: BuilderRoutingDecision, maxRepairAttempts = 1): BuilderRoutingState {
  return recordBuilderRoutingDecision({ decision, maxRepairAttempts, at: decision.decidedAt });
}

function append(
  state: BuilderRoutingState,
  kind: BuilderAttemptKind,
  outcome: 'CANDIDATE_READY' | 'SUCCEEDED' | 'FAILED_VERIFICATION' | 'FAILED_RESOURCE',
  options: { fingerprint?: string; patchHash?: string; at?: string } = {},
): BuilderRoutingState {
  return appendBuilderRoutingAttempt(state, {
    attemptId: `wu-1-${kind.toLowerCase()}-${state.attempts.length + 1}`,
    workUnitAttempt: state.attempts.length + 1,
    kind,
    outcome,
    changedFiles: ['src/mapper.ts'],
    verificationSummary: outcome === 'FAILED_VERIFICATION' ? ['unit-tests: nonzero-exit (1)'] : [],
    ...(options.fingerprint !== undefined ? { problemFingerprint: options.fingerprint } : {}),
    ...(options.patchHash !== undefined ? { candidatePatchHash: options.patchHash } : {}),
    startedAt: NOW,
    completedAt: options.at ?? LATER,
  });
}

describe('Phase 7 builder routing policy', () => {
  it('keeps OFF backward compatible and permits explicit qualification without making Secondary mandatory', () => {
    expect(route({ strategy: 'OFF' }).selectedBackend).toBe('STRONG');
    expect(route({ strategy: 'OFF' }).reasons.map((entry) => entry.code)).toContain('STRATEGY_OFF');
    expect(route({ strategy: 'OFF', explicit: true }).selectedBackend).toBe('SECONDARY');
    expect(route({ strategy: 'OFF', explicit: true, availability: 'UNAVAILABLE' }).selectedBackend)
      .toBe('STRONG');

    const config = defaultResolvedAgentConfig();
    expect(config.orchestration.jobs.objectives.secondaryBuilder).toEqual({
      strategy: 'OFF',
      maxRepairAttempts: 1,
    });
  });

  it('implements PREFER and falls through to Strong without waiting when Secondary is unavailable', () => {
    const selected = route({ strategy: 'PREFER' });
    expect(selected.selectedBackend).toBe('SECONDARY');
    expect(selected.reasons.map((entry) => entry.code)).toContain('SECONDARY_PREFERRED_POLICY');

    const unavailable = route({ strategy: 'PREFER', availability: 'UNAVAILABLE' });
    expect(unavailable.selectedBackend).toBe('STRONG');
    expect(unavailable.reasons.map((entry) => entry.code)).toContain('SECONDARY_UNAVAILABLE');
    expect(unavailable.selectedBackend).not.toBe('WAIT');
    expect(summarizeBuilderRouting([stateFor(unavailable)], LATER).outcomeCounts)
      .toMatchObject({ SecondaryUnavailableFallback: 1, StrongRequiredDirect: 0 });
  });

  it('lets hard readiness statuses override every strategy', () => {
    const expected: Record<Exclude<SecondaryEligibilityStatus, 'ELIGIBLE'>, string> = {
      STRONG_REQUIRED: 'STRONG',
      NEEDS_RESEARCH: 'RESEARCH',
      NEEDS_AUTHORITY: 'AUTHORITY',
      NEEDS_CONTEXT: 'CONTEXT_RECOVERY',
      NOT_READY: 'WAIT',
    };
    for (const [status, backend] of Object.entries(expected)) {
      const decision = route({
        status: status as Exclude<SecondaryEligibilityStatus, 'ELIGIBLE'>,
        strategy: 'PREFER',
      });
      expect(decision.selectedBackend).toBe(backend);
      expect(decision.selectedBackend).not.toBe('SECONDARY');
    }
  });

  it('uses existing AUTO economics: CONSERVE/exhaustion select Secondary and HARVEST may select Strong', () => {
    expect(route({ schedulerMode: 'CONSERVE' }).selectedBackend).toBe('SECONDARY');
    expect(route({ schedulerMode: 'EXHAUSTED_5H' }).selectedBackend).toBe('SECONDARY');
    expect(route({ schedulerMode: 'EXHAUSTED_WEEKLY' }).selectedBackend).toBe('SECONDARY');
    const harvest = route({ schedulerMode: 'HARVEST' });
    expect(harvest.selectedBackend).toBe('STRONG');
    expect(harvest.reasons.map((entry) => entry.code)).toContain('SUBSCRIPTION_HARVEST');
  });

  it('never creates an API route when Strong subscription and Secondary are unavailable', () => {
    const decision = route({ strategy: 'PREFER', availability: 'UNAVAILABLE' });
    expect(decision.selectedBackend).toBe('STRONG');
    expect(JSON.stringify(decision)).not.toContain('API');
  });
});

describe('Phase 7 bounded repair, fallback, persistence, and metrics', () => {
  it('runs initial Secondary, one repair, then sticky Strong fallback', () => {
    const initialDecision = route({ strategy: 'PREFER' });
    let state = stateFor(initialDecision);
    expect(builderAttemptKindFor(initialDecision, state)).toBe('SECONDARY');
    const firstFingerprint = builderProblemFingerprint({
      failureKind: 'VERIFICATION_FAILURE',
      verificationSummary: ['unit-tests: nonzero-exit (1)'],
      candidatePatch: '+ broken one',
    });
    state = append(state, 'SECONDARY', 'FAILED_VERIFICATION', {
      fingerprint: firstFingerprint.problemFingerprint,
      ...(firstFingerprint.candidatePatchHash !== undefined
        ? { patchHash: firstFingerprint.candidatePatchHash }
        : {}),
    });
    expect(state.repairAttemptsUsed).toBe(0);
    expect(state.escalationStatus).toBe('NONE');

    const repairDecision = route({ strategy: 'PREFER', priorState: state, attempt: 2 });
    state = recordBuilderRoutingDecision({ prior: state, decision: repairDecision, maxRepairAttempts: 1, at: LATER });
    expect(builderAttemptKindFor(repairDecision, state)).toBe('SECONDARY_REPAIR');
    state = append(state, 'SECONDARY_REPAIR', 'FAILED_VERIFICATION', {
      fingerprint: sha256Hex('different-failure'),
      patchHash: sha256Hex('different-patch'),
    });
    expect(state.repairAttemptsUsed).toBe(1);
    expect(state.escalationStatus).toBe('STRONG_FALLBACK_REQUIRED');

    const fallback = route({ strategy: 'PREFER', priorState: state, attempt: 3 });
    expect(fallback.selectedBackend).toBe('STRONG');
    expect(fallback.reasons.map((entry) => entry.code)).toContain('STRONG_FALLBACK');
    state = recordBuilderRoutingDecision({ prior: state, decision: fallback, maxRepairAttempts: 1, at: LATER });
    expect(builderAttemptKindFor(fallback, state)).toBe('STRONG_FALLBACK');
  });

  it('detects identical no-progress and exits Secondary without another repair', () => {
    const decision = route({ strategy: 'PREFER' });
    const fingerprint = sha256Hex('same-problem');
    let state = append(stateFor(decision, 2), 'SECONDARY', 'FAILED_VERIFICATION', { fingerprint });
    const repairDecision = route({ strategy: 'PREFER', priorState: state, attempt: 2 });
    state = recordBuilderRoutingDecision({ prior: state, decision: repairDecision, maxRepairAttempts: 2, at: LATER });
    state = append(state, 'SECONDARY_REPAIR', 'FAILED_VERIFICATION', { fingerprint });
    expect(state.attempts.at(-1)?.noProgress).toBe(true);
    expect(state.escalationStatus).toBe('STRONG_FALLBACK_REQUIRED');
    const fallback = route({ strategy: 'PREFER', priorState: state, attempt: 3 });
    expect(fallback.reasons.map((entry) => entry.code)).toContain('SECONDARY_NO_PROGRESS');
  });

  it('does not spend implementation repair budget on provider/resource failure', () => {
    const decision = route({ strategy: 'PREFER' });
    const state = append(stateFor(decision), 'SECONDARY', 'FAILED_RESOURCE');
    expect(state.repairAttemptsUsed).toBe(0);
    expect(state.escalationStatus).toBe('STRONG_FALLBACK_REQUIRED');
    expect(route({ strategy: 'PREFER', priorState: state, attempt: 2 }).selectedBackend).toBe('STRONG');
  });

  it('binds sticky failure to content identity so a material replan gets a fresh cycle', () => {
    const decision = route({ strategy: 'PREFER' });
    const failed = append(stateFor(decision, 0), 'SECONDARY', 'FAILED_VERIFICATION');
    expect(failed.escalationStatus).toBe('STRONG_FALLBACK_REQUIRED');
    expect(route({ strategy: 'PREFER', priorState: failed, attempt: 2 }).selectedBackend).toBe('STRONG');
    expect(route({
      strategy: 'PREFER',
      priorState: failed,
      attempt: 2,
      workIdentity: sha256Hex('materially-replanned-work'),
    }).selectedBackend).toBe('SECONDARY');
  });

  it('persists an inspectable attempt chain and computes StrongBuilderAvoidanceRatio', () => {
    const fixture = setupExecutionFixture({ git: false });
    const secondaryDecision = route({ strategy: 'PREFER' });
    const secondary = append(stateFor(secondaryDecision), 'SECONDARY', 'SUCCEEDED');
    const strongDecision = builderRoutingDecisionSchema.parse({
      ...route({ strategy: 'OFF', workIdentity: sha256Hex('second-work') }),
      workUnitId: 'wu-2',
      decisionId: 'wu-2-a01-route',
      workIdentity: sha256Hex('second-work'),
    });
    const strong = append(
      recordBuilderRoutingDecision({ decision: strongDecision, maxRepairAttempts: 1, at: NOW }),
      'STRONG',
      'SUCCEEDED',
    );
    storeBuilderRoutingState(fixture.workspace, 'job-1', 'node-1', secondary);
    storeBuilderRoutingState(fixture.workspace, 'job-1', 'node-1', strong);
    const telemetry = summarizeBuilderRouting([secondary, strong], LATER);
    storeBuilderRoutingTelemetry(fixture.workspace, 'job-1', 'node-1', telemetry);

    expect(readBuilderRoutingState(
      fixture.workspace,
      'job-1',
      'node-1',
      'wu-1',
      secondary.workIdentity,
    )?.attempts).toHaveLength(1);
    expect(readBuilderRoutingTelemetry(fixture.workspace, 'job-1', 'node-1'))
      .toMatchObject({
        eligibleCompletedUnits: 2,
        eligibleCompletedWithoutStrong: 1,
        strongBuilderAvoidanceRatio: 0.5,
      });
    expect(renderBuilderRouting(secondary)).toContain('Attempt 1: SECONDARY — SUCCEEDED');
  });

  it('qualifies a mixed 15-unit WorkGraph without routing blocked work to a builder', () => {
    const statuses: SecondaryEligibilityStatus[] = [
      ...Array.from({ length: 8 }, () => 'ELIGIBLE' as const),
      ...Array.from({ length: 3 }, () => 'STRONG_REQUIRED' as const),
      'NEEDS_RESEARCH',
      'NEEDS_AUTHORITY',
      'NEEDS_CONTEXT',
      'NOT_READY',
    ];
    const routes = statuses.map((status, index) => decideBuilderRouting({
      decision: secondaryEligibilityDecisionSchema.parse({
        ...eligibility(status),
        workUnitId: `wu-${index + 1}`,
        decisionId: `wu-${index + 1}-a01-decision`,
      }),
      workIdentity: sha256Hex(`mixed-${index}`),
      strategy: 'PREFER',
      availability: { status: 'AVAILABLE', detail: 'healthy' },
      decidedAt: NOW,
    }));
    expect(routes).toHaveLength(15);
    expect(routes.filter((entry) => entry.selectedBackend === 'SECONDARY')).toHaveLength(8);
    expect(routes.filter((entry) => entry.selectedBackend === 'STRONG')).toHaveLength(3);
    expect(routes.filter((entry) => entry.selectedBackend === 'RESEARCH')).toHaveLength(1);
    expect(routes.filter((entry) => entry.selectedBackend === 'AUTHORITY')).toHaveLength(1);
    expect(routes.filter((entry) => entry.selectedBackend === 'CONTEXT_RECOVERY')).toHaveLength(1);
    expect(routes.filter((entry) => entry.selectedBackend === 'WAIT')).toHaveLength(1);
  });
});
