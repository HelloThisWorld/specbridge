import type { ExecutionOutcome } from '@specbridge/core';
import type { NormalizedRunnerError } from '../contracts/errors.js';
import type { RunnerOperation } from '../contracts/operations.js';

/**
 * Authoring fallback policy (v0.6).
 *
 * Automatic fallback is DISABLED by default and exists only for the two
 * authoring operations — never for task execution or resume, never after
 * repository modification, and never as silent provider switching: the
 * chain must be explicitly configured, every attempt gets its own
 * append-only record, and every skipped candidate gets a recorded reason.
 */

export const FALLBACK_OPERATIONS: readonly RunnerOperation[] = [
  'stage-generation',
  'stage-refinement',
];

export function operationAllowsFallback(operation: RunnerOperation): boolean {
  return FALLBACK_OPERATIONS.includes(operation);
}

/** Error codes after which fallback (and retry) must never happen. */
const FALLBACK_BLOCKING_ERROR_CODES = new Set([
  'authentication_required',
  'permission_denied',
  'invalid_configuration',
  'cancelled',
  'quota_exceeded',
  'sandbox_unavailable',
  'unsupported_operation',
  'runner_disabled',
  'runner_not_found',
  'runner_incompatible',
  'protected_path_modified',
  'repository_diverged',
]);

export interface FallbackDecision {
  eligible: boolean;
  reason: string;
}

/**
 * Decide whether the NEXT configured fallback candidate may be attempted
 * after a failed authoring attempt. (Transport retries within the same
 * profile are decided separately by `transientRetryEligible`.)
 */
export function fallbackEligible(
  operation: RunnerOperation,
  outcome: ExecutionOutcome,
  error: NormalizedRunnerError | undefined,
): FallbackDecision {
  if (!operationAllowsFallback(operation)) {
    return { eligible: false, reason: `fallback is never used for ${operation}` };
  }
  if (outcome === 'cancelled') {
    return { eligible: false, reason: 'the user cancelled the run; no fallback after explicit cancellation' };
  }
  if (outcome === 'permission-denied') {
    return { eligible: false, reason: 'no fallback after a permission failure' };
  }
  if (outcome === 'completed' || outcome === 'no-change' || outcome === 'blocked') {
    return { eligible: false, reason: `outcome "${outcome}" is a real result, not a transport failure` };
  }
  if (error !== undefined && FALLBACK_BLOCKING_ERROR_CODES.has(error.code)) {
    return { eligible: false, reason: `no fallback after ${error.code}` };
  }
  return { eligible: true, reason: `outcome "${outcome}" is fallback-eligible` };
}

/** Maximum transient transport retries per profile per authoring run. */
export const MAX_TRANSPORT_RETRIES = 2;
/** Maximum structured-output correction retries per profile per run. */
export const MAX_CORRECTION_RETRIES = 1;

const TRANSIENT_ERROR_CODES = new Set(['network_error', 'endpoint_unreachable', 'rate_limited', 'timed_out']);

/** Whether a same-profile transient transport retry is allowed. */
export function transientRetryEligible(
  operation: RunnerOperation,
  error: NormalizedRunnerError | undefined,
  attemptedTransportRetries: number,
): FallbackDecision {
  if (!operationAllowsFallback(operation)) {
    return { eligible: false, reason: `automatic retries are never used for ${operation}` };
  }
  if (error === undefined || !error.retryable || !TRANSIENT_ERROR_CODES.has(error.code)) {
    return { eligible: false, reason: 'the failure is not a transient transport failure' };
  }
  if (attemptedTransportRetries >= MAX_TRANSPORT_RETRIES) {
    return { eligible: false, reason: `the ${MAX_TRANSPORT_RETRIES}-retry transport budget is exhausted` };
  }
  return { eligible: true, reason: `transient ${error.code} (retry ${attemptedTransportRetries + 1}/${MAX_TRANSPORT_RETRIES})` };
}

/** Bounded exponential backoff with deterministic-jitter bounds (ms). */
export function retryBackoffMs(retryIndex: number, jitterRatio = 0.2): number {
  const base = Math.min(4000, 250 * 2 ** retryIndex);
  const jitter = Math.floor(base * jitterRatio * Math.random());
  return base + jitter;
}
