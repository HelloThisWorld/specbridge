import type { JobStatus } from '@specbridge/orchestration';
import type { ResourceWaitKind } from '../vocabulary.js';

/**
 * Classifying what just went wrong into what the runtime does next.
 *
 * This is the function that turns the vNext.10 thesis into behaviour. Every
 * failure below used to end an overnight run:
 *
 *   the subscription quota ran out           -> a person typed --resume at 8am
 *   llama.cpp crashed                        -> a person restarted it
 *   the driver died                          -> the shell closed with it
 *   a package was missing                    -> a person ran pnpm install
 *   Docker was not running                   -> a person started Docker
 *   the Claude CLI contract had changed      -> a person patched SpecBridge
 *
 * Only the last two of those are ever genuinely a person's problem, and only
 * sometimes. The rest are scheduling and provisioning, and the classifier
 * maps them onto operational statuses the supervisor can leave by itself.
 *
 * It is pure and total. Anything it cannot recognise becomes a bounded
 * retry rather than a human gate: the failure mode to avoid is a runtime
 * that stops for an unfamiliar error message, and a bounded retry that
 * eventually gives up is honest while a question at 3am is not.
 */

export interface FailureObservation {
  /** A DriverStop kind, or `crash` for an exception from the driver. */
  kind: 'crash' | 'blocked' | 'deferred' | 'needs-human' | 'interrupted' | 'final' | 'completed';
  /** The message the driver or the exception carried. Bounded, no secrets. */
  detail: string;
  /** When the runtime already knows capacity returns. */
  retryAt?: string | undefined;
}

export interface RecoveryClassification {
  /** The status the job moves to. */
  status: JobStatus;
  /** Why it is waiting, when it is waiting. */
  waitKind: ResourceWaitKind;
  /** One line for the operational record. */
  detail: string;
  /** When the condition is expected to clear, when that is knowable. */
  wakeAt?: string | undefined;
  /** True when this needs a person and genuinely cannot be recovered. */
  humanRequired: boolean;
}

/**
 * Signature patterns, most specific first.
 *
 * Matched against the failure detail. Ordering matters: "quota" appears in
 * plenty of provider errors, so the quota-with-a-reset case has to be
 * distinguished from the generic provider case before either is considered.
 */
const SIGNATURES: readonly {
  pattern: RegExp;
  status: JobStatus;
  waitKind: ResourceWaitKind;
  detail: string;
}[] = [
  {
    pattern: /\b(quota|rate.?limit|usage limit|too many requests|429)\b/i,
    status: 'WAITING_RESOURCE',
    waitKind: 'SUBSCRIPTION_QUOTA_RESET',
    detail: 'the provider reported no remaining capacity',
  },
  {
    pattern: /\b(overloaded|529|service unavailable|503|upstream connect error)\b/i,
    status: 'WAITING_RESOURCE',
    waitKind: 'PROVIDER_COOLDOWN',
    detail: 'the provider is temporarily unavailable',
  },
  {
    pattern:
      /\b(llama|local model|inference server|model process)\b.*\b(exit(?:ed|s|ing)?|crash(?:ed|es|ing)?|die[ds]?|refused|unavailable|terminated)\b/i,
    status: 'RECOVERING_PROVIDER',
    waitKind: 'LOCAL_RUNTIME_RESTART',
    detail: 'the local inference process stopped answering',
  },
  {
    pattern: /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|network)\b/i,
    status: 'RECOVERING_PROVIDER',
    waitKind: 'EXTERNAL_SERVICE_OUTAGE',
    detail: 'a network dependency did not answer',
  },
  {
    pattern: /\b(command not found|is not recognized|spawn \w+ ENOENT|executable not found)\b/i,
    status: 'REPAIRING_TOOLCHAIN',
    waitKind: 'TOOLCHAIN_PROVISIONING',
    detail: 'a required engineering tool is not installed',
  },
  {
    pattern: /\b(cannot find module|module not found|missing dependency|unmet peer)\b/i,
    status: 'REPAIRING_TOOLCHAIN',
    waitKind: 'TOOLCHAIN_PROVISIONING',
    detail: 'a project dependency is missing',
  },
  {
    pattern: /\b(docker daemon|compose|container .* (unhealthy|exited)|port is already allocated)\b/i,
    status: 'REPAIRING_ENVIRONMENT',
    waitKind: 'ENVIRONMENT_READINESS',
    detail: 'the local runtime environment is not healthy',
  },
  {
    pattern: /\b(context (?:window|length) exceeded|too many tokens|prompt is too long)\b/i,
    status: 'READY',
    waitKind: 'UNKNOWN_CAPACITY',
    detail: 'the context window was exceeded; a fresh session continues from durable state',
  },
  {
    pattern: /\b(unknown (?:option|flag|argument)|unrecognized (?:option|argument)|invalid (?:option|flag))\b/i,
    status: 'REPAIRING_CONTROL_PLANE',
    waitKind: 'TOOLCHAIN_PROVISIONING',
    detail: 'the runner CLI rejected an argument SpecBridge passes',
  },
];

/**
 * Classify one failure.
 *
 * `needs-human` and `final` are passed through as-is: the driver already
 * decided those, and second-guessing a NEEDS_AUTHORITY stop would be the
 * runtime overriding its own authority firewall.
 */
export function classifyFailure(observation: FailureObservation): RecoveryClassification {
  if (observation.kind === 'needs-human') {
    return {
      status: 'NEEDS_CLARIFICATION',
      waitKind: 'UNKNOWN_CAPACITY',
      detail: observation.detail,
      humanRequired: true,
    };
  }
  if (observation.kind === 'deferred') {
    return {
      status: 'WAITING_RESOURCE',
      waitKind: observation.retryAt !== undefined ? 'SUBSCRIPTION_QUOTA_RESET' : 'UNKNOWN_CAPACITY',
      detail: observation.detail,
      ...(observation.retryAt !== undefined ? { wakeAt: observation.retryAt } : {}),
      humanRequired: false,
    };
  }

  for (const signature of SIGNATURES) {
    if (!signature.pattern.test(observation.detail)) continue;
    return {
      status: signature.status,
      waitKind: signature.waitKind,
      detail: `${signature.detail}: ${observation.detail}`.slice(0, 2_000),
      ...(observation.retryAt !== undefined ? { wakeAt: observation.retryAt } : {}),
      humanRequired: false,
    };
  }

  if (observation.kind === 'blocked') {
    // A blocker the classifier does not recognise is the ONE case that
    // genuinely lands on a person: the driver already concluded an external
    // prerequisite is missing and named it.
    return {
      status: 'BLOCKED',
      waitKind: 'UNKNOWN_CAPACITY',
      detail: observation.detail,
      humanRequired: true,
    };
  }

  return {
    status: 'WAITING_RETRY',
    waitKind: 'UNKNOWN_CAPACITY',
    detail: `unclassified failure, retrying with backoff: ${observation.detail}`.slice(0, 2_000),
    humanRequired: false,
  };
}

/**
 * Whether an observation is an ordinary engineering event.
 *
 * Used by the certification to assert the primary property: every
 * engineering-operational fault it injects must classify as recoverable, and
 * a fault that classified as `humanRequired` would be a certification
 * failure rather than a curiosity.
 */
export function isSelfRecoverable(observation: FailureObservation): boolean {
  return !classifyFailure(observation).humanRequired;
}
