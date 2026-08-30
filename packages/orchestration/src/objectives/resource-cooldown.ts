import { z } from 'zod';
import { sha256Hex } from '@specbridge/core';
import type { SchedulerMode } from '../scheduling/vocabulary.js';
import type { WorkGraph, WorkUnit, WorkUnitResourceWait } from './state.js';

/** Phase 8 resource state is operational evidence, never product truth. */
export const OBJECTIVE_COOLDOWN_STATE_SCHEMA_VERSION = '1.0.0';

export const STRONG_RESOURCE_AVAILABILITIES = [
  'AVAILABLE',
  'QUOTA_EXHAUSTED',
  'COOLDOWN',
  'RATE_LIMITED',
] as const;
export type StrongResourceAvailability = (typeof STRONG_RESOURCE_AVAILABILITIES)[number];

const shortText = z.string().min(1).max(512);
const idList = z.array(shortText).max(30);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const strongResourceSnapshotSchema = z.object({
  resourceClass: z.literal('STRONG_SUBSCRIPTION'),
  /** Narrowest trustworthy identity available without introducing ModelTarget. */
  resourceIdentity: shortText,
  availability: z.enum(STRONG_RESOURCE_AVAILABILITIES),
  observedAt: shortText,
  wakeAt: shortText.optional(),
  detail: z.string().min(1).max(2_000),
}).strict();
export type StrongResourceSnapshot = z.infer<typeof strongResourceSnapshotSchema>;

/**
 * Per-objective qualification/status facts. WorkUnit waits remain on the
 * graph itself; this record aggregates cooldown episodes without becoming a
 * second scheduler or source of readiness truth.
 */
export const objectiveCooldownStateSchema = z.object({
  schemaVersion: z.literal(OBJECTIVE_COOLDOWN_STATE_SCHEMA_VERSION),
  jobId: shortText,
  objectiveNodeId: shortText,
  resourceClass: z.literal('STRONG_SUBSCRIPTION'),
  resourceIdentity: shortText,
  status: z.enum(['ACTIVE', 'RECOVERED']),
  episodes: z.number().int().min(1),
  firstStartedAt: shortText,
  currentStartedAt: shortText.optional(),
  lastEndedAt: shortText.optional(),
  lastAvailability: z.enum(STRONG_RESOURCE_AVAILABILITIES),
  lastObservedAt: shortText,
  wakeAt: shortText.optional(),
  completedBeforeCurrentCooldown: idList.default([]),
  completedDuringCooldown: idList.default([]),
  waitingWorkUnitIds: idList.default([]),
  strongAttemptsAvoided: z.number().int().min(0).default(0),
  resourceRechecks: z.number().int().min(0).default(0),
  candidateReuseAfterRestart: z.number().int().min(0).default(0),
  updatedAt: shortText,
  contentHash: sha256,
}).strict();
export type ObjectiveCooldownState = z.infer<typeof objectiveCooldownStateSchema>;

function stateHash(state: Omit<ObjectiveCooldownState, 'contentHash'>): string {
  return sha256Hex(JSON.stringify(state));
}

function validatedState(base: Omit<ObjectiveCooldownState, 'contentHash'>): ObjectiveCooldownState {
  return objectiveCooldownStateSchema.parse({ ...base, contentHash: stateHash(base) });
}

export function strongResourceFromScheduler(input: {
  schedulerMode?: SchedulerMode | undefined;
  observedAt: string;
  fiveHourResetAt?: string | null | undefined;
  weeklyResetAt?: string | null | undefined;
  resourceIdentity?: string | undefined;
}): StrongResourceSnapshot {
  const identity = input.resourceIdentity ?? 'subscription:strong';
  if (input.schedulerMode === 'EXHAUSTED_5H') {
    return strongResourceSnapshotSchema.parse({
      resourceClass: 'STRONG_SUBSCRIPTION',
      resourceIdentity: identity,
      availability: 'QUOTA_EXHAUSTED',
      observedAt: input.observedAt,
      ...(input.fiveHourResetAt != null ? { wakeAt: input.fiveHourResetAt } : {}),
      detail: 'The five-hour Strong subscription window is exhausted.',
    });
  }
  if (input.schedulerMode === 'EXHAUSTED_WEEKLY') {
    return strongResourceSnapshotSchema.parse({
      resourceClass: 'STRONG_SUBSCRIPTION',
      resourceIdentity: identity,
      availability: 'QUOTA_EXHAUSTED',
      observedAt: input.observedAt,
      ...(input.weeklyResetAt != null ? { wakeAt: input.weeklyResetAt } : {}),
      detail: 'The weekly Strong subscription window is exhausted.',
    });
  }
  return strongResourceSnapshotSchema.parse({
    resourceClass: 'STRONG_SUBSCRIPTION',
    resourceIdentity: identity,
    availability: 'AVAILABLE',
    observedAt: input.observedAt,
    detail: 'Strong subscription capacity is currently available.',
  });
}

export function quotaFailureResource(input: {
  observedAt: string;
  detail: string;
  resourceIdentity?: string | undefined;
  wakeAt?: string | undefined;
}): StrongResourceSnapshot {
  return strongResourceSnapshotSchema.parse({
    resourceClass: 'STRONG_SUBSCRIPTION',
    resourceIdentity: input.resourceIdentity ?? 'subscription:strong',
    availability: /rate.?limit|\b429\b/i.test(input.detail) ? 'RATE_LIMITED' : 'QUOTA_EXHAUSTED',
    observedAt: input.observedAt,
    ...(input.wakeAt !== undefined ? { wakeAt: input.wakeAt } : {}),
    detail: input.detail.slice(0, 2_000),
  });
}

export function isStrongResourceCooling(snapshot: StrongResourceSnapshot): boolean {
  return snapshot.availability !== 'AVAILABLE';
}

function completedIds(graph: WorkGraph): string[] {
  return graph.units
    .filter((unit) => unit.status === 'VERIFIED_CANDIDATE' || unit.status === 'INTEGRATED')
    .map((unit) => unit.workUnitId)
    .sort();
}

export function observeObjectiveCooldown(input: {
  prior?: ObjectiveCooldownState | undefined;
  graph: WorkGraph;
  resource: StrongResourceSnapshot;
  at: string;
  recheck?: boolean | undefined;
}): ObjectiveCooldownState | undefined {
  const { prior, resource } = input;
  if (!isStrongResourceCooling(resource)) {
    if (prior === undefined) return undefined;
    const base = {
      ...prior,
      status: 'RECOVERED' as const,
      lastEndedAt: prior.status === 'ACTIVE' ? input.at : prior.lastEndedAt,
      currentStartedAt: undefined,
      lastAvailability: resource.availability,
      lastObservedAt: resource.observedAt,
      wakeAt: undefined,
      waitingWorkUnitIds: [],
      updatedAt: input.at,
    };
    const { contentHash: _contentHash, ...withoutHash } = base;
    return validatedState(withoutHash);
  }

  if (prior === undefined || prior.status === 'RECOVERED') {
    return validatedState({
      schemaVersion: OBJECTIVE_COOLDOWN_STATE_SCHEMA_VERSION,
      jobId: input.graph.jobId,
      objectiveNodeId: input.graph.objectiveNodeId,
      resourceClass: 'STRONG_SUBSCRIPTION',
      resourceIdentity: resource.resourceIdentity,
      status: 'ACTIVE',
      episodes: (prior?.episodes ?? 0) + 1,
      firstStartedAt: prior?.firstStartedAt ?? input.at,
      currentStartedAt: input.at,
      ...(prior?.lastEndedAt !== undefined ? { lastEndedAt: prior.lastEndedAt } : {}),
      lastAvailability: resource.availability,
      lastObservedAt: resource.observedAt,
      ...(resource.wakeAt !== undefined ? { wakeAt: resource.wakeAt } : {}),
      completedBeforeCurrentCooldown: completedIds(input.graph),
      completedDuringCooldown: prior?.completedDuringCooldown ?? [],
      waitingWorkUnitIds: [],
      strongAttemptsAvoided: prior?.strongAttemptsAvoided ?? 0,
      resourceRechecks: prior?.resourceRechecks ?? 0,
      candidateReuseAfterRestart: prior?.candidateReuseAfterRestart ?? 0,
      updatedAt: input.at,
    });
  }

  const before = new Set(prior.completedBeforeCurrentCooldown);
  const during = new Set(prior.completedDuringCooldown);
  for (const id of completedIds(input.graph)) if (!before.has(id)) during.add(id);
  const base = {
    ...prior,
    lastAvailability: resource.availability,
    lastObservedAt: resource.observedAt,
    ...(resource.wakeAt !== undefined ? { wakeAt: resource.wakeAt } : {}),
    completedDuringCooldown: [...during].sort(),
    waitingWorkUnitIds: input.graph.units
      .filter((unit) => unit.resourceWait?.resourceClass === 'STRONG_SUBSCRIPTION')
      .map((unit) => unit.workUnitId)
      .sort(),
    resourceRechecks: prior.resourceRechecks + (input.recheck === true ? 1 : 0),
    updatedAt: input.at,
  };
  const { contentHash: _contentHash, ...withoutHash } = base;
  return validatedState(withoutHash);
}

export function noteStrongAttemptAvoided(
  state: ObjectiveCooldownState,
  waitingWorkUnitIds: readonly string[],
  at: string,
): ObjectiveCooldownState {
  const waiting = new Set([...state.waitingWorkUnitIds, ...waitingWorkUnitIds]);
  const base = {
    ...state,
    waitingWorkUnitIds: [...waiting].sort(),
    strongAttemptsAvoided: state.strongAttemptsAvoided + waitingWorkUnitIds.length,
    updatedAt: at,
  };
  const { contentHash: _contentHash, ...withoutHash } = base;
  return validatedState(withoutHash);
}

export function noteCandidateReuseAfterRestart(
  state: ObjectiveCooldownState,
  at: string,
): ObjectiveCooldownState {
  const base = {
    ...state,
    candidateReuseAfterRestart: state.candidateReuseAfterRestart + 1,
    updatedAt: at,
  };
  const { contentHash: _contentHash, ...withoutHash } = base;
  return validatedState(withoutHash);
}

export function markUnitWaitingForStrong(input: {
  unit: WorkUnit;
  resource: StrongResourceSnapshot;
  routingWorkIdentity?: string | undefined;
  fallbackPending?: boolean | undefined;
}): { unit: WorkUnit; newlyWaiting: boolean } {
  const prior = input.unit.resourceWait;
  const wait: WorkUnitResourceWait = {
    reason: 'RESOURCE_COOLDOWN',
    resourceClass: 'STRONG_SUBSCRIPTION',
    availability:
      input.resource.availability === 'AVAILABLE' ? 'COOLDOWN' : input.resource.availability,
    since: prior?.since ?? input.resource.observedAt,
    lastObservedAt: input.resource.observedAt,
    ...(input.resource.wakeAt !== undefined ? { wakeAt: input.resource.wakeAt } : {}),
    ...(input.routingWorkIdentity !== undefined
      ? { routingWorkIdentity: input.routingWorkIdentity }
      : prior?.routingWorkIdentity !== undefined
        ? { routingWorkIdentity: prior.routingWorkIdentity }
        : {}),
    fallbackPending: input.fallbackPending ?? prior?.fallbackPending ?? false,
  };
  return { unit: { ...input.unit, resourceWait: wait }, newlyWaiting: prior === undefined };
}

export function clearRecoveredStrongWaits(graph: WorkGraph): {
  graph: WorkGraph;
  recoveredWorkUnitIds: string[];
} {
  const recoveredWorkUnitIds: string[] = [];
  const units = graph.units.map((unit) => {
    if (unit.resourceWait?.resourceClass !== 'STRONG_SUBSCRIPTION') return unit;
    recoveredWorkUnitIds.push(unit.workUnitId);
    const { resourceWait: _resourceWait, ...rest } = unit;
    return rest as WorkUnit;
  });
  return { graph: { ...graph, units }, recoveredWorkUnitIds };
}

export function isStrongQuotaFailure(detail: string): boolean {
  return /\b(quota|usage limit|rate.?limit|too many requests|429|plan limit|capacity exhausted)\b/i.test(detail);
}
