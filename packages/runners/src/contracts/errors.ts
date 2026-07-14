import { z } from 'zod';

/**
 * Normalized runner errors (v0.6, frozen).
 *
 * Every provider failure is classified into one stable code before it enters
 * shared orchestration, reports, or attempt records. Raw provider errors may
 * contain credentials or account details — normalized errors never do:
 * messages are adapter-authored, provider codes are short identifiers, and
 * details are explicitly redacted structured data.
 *
 * Stack traces are never exposed by default.
 */

export const RUNNER_ERROR_SCHEMA_VERSION = '1.0.0';

export const RUNNER_ERROR_CODES = [
  'runner_not_found',
  'runner_disabled',
  'runner_incompatible',
  'executable_not_found',
  'endpoint_unreachable',
  'authentication_required',
  'permission_denied',
  'sandbox_unavailable',
  'structured_output_unsupported',
  'structured_output_invalid',
  'model_not_found',
  'quota_exceeded',
  'rate_limited',
  'network_error',
  'process_failed',
  'api_error',
  'cancelled',
  'timed_out',
  'output_limit_exceeded',
  'repository_diverged',
  'protected_path_modified',
  'verification_failed',
  'invalid_configuration',
  'unsupported_operation',
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export const normalizedRunnerErrorSchema = z
  .object({
    schemaVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default(RUNNER_ERROR_SCHEMA_VERSION),
    code: z.enum(RUNNER_ERROR_CODES),
    /** Safe, human-readable message. Never contains credentials or env values. */
    message: z.string().min(1),
    /** Actionable next steps for the local user. */
    remediation: z.array(z.string()).default([]),
    /** Whether an identical retry could plausibly succeed. */
    retryable: z.boolean(),
    /** Short provider-specific code when one exists and is safe (e.g. "429"). */
    providerCode: z.string().max(120).optional(),
    /** Redacted structured details (never raw provider payloads). */
    details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();
export type NormalizedRunnerError = z.infer<typeof normalizedRunnerErrorSchema>;

/** Codes for which an identical automatic retry is never performed. */
export const NON_RETRYABLE_ERROR_CODES: readonly RunnerErrorCode[] = [
  'runner_not_found',
  'runner_disabled',
  'runner_incompatible',
  'executable_not_found',
  'authentication_required',
  'permission_denied',
  'sandbox_unavailable',
  'structured_output_unsupported',
  'model_not_found',
  'quota_exceeded',
  'cancelled',
  'repository_diverged',
  'protected_path_modified',
  'invalid_configuration',
  'unsupported_operation',
];

export interface RunnerErrorInput {
  code: RunnerErrorCode;
  message: string;
  remediation?: string[];
  retryable?: boolean;
  providerCode?: string;
  details?: Record<string, string | number | boolean | null>;
}

/** Build a validated normalized error with a safe retryable default. */
export function runnerError(input: RunnerErrorInput): NormalizedRunnerError {
  return normalizedRunnerErrorSchema.parse({
    schemaVersion: RUNNER_ERROR_SCHEMA_VERSION,
    code: input.code,
    message: input.message,
    remediation: input.remediation ?? [],
    retryable: input.retryable ?? !NON_RETRYABLE_ERROR_CODES.includes(input.code),
    ...(input.providerCode !== undefined ? { providerCode: input.providerCode } : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
  });
}
