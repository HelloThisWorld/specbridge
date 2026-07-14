import { z } from 'zod';
import { RUNNER_CATEGORIES, RUNNER_SUPPORT_LEVELS } from './capabilities.js';
import { RUNNER_OPERATIONS } from './operations.js';
import { normalizedRunnerErrorSchema } from './errors.js';
import { runnerCostSchema, runnerUsageSchema } from './usage.js';

/**
 * Normalized execution result (v0.6, frozen).
 *
 * The shared, validated result every runner invocation produces before its
 * output enters orchestration, attempt records, or reports.
 *
 * Everything "reported*" is an unverified provider CLAIM. Task-completion
 * authority remains exclusively with actual Git snapshots, actual repository
 * changes, trusted verification commands, valid SpecBridge evidence, and
 * explicit manual acceptance.
 */

export const NORMALIZED_RESULT_SCHEMA_VERSION = '1.0.0';

export const NORMALIZED_EXECUTION_OUTCOMES = [
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'timed-out',
  'permission-denied',
  'malformed-output',
  'no-change',
  'unavailable',
  'incompatible',
  'authentication-required',
  'quota-exceeded',
  'rate-limited',
] as const;
export type NormalizedExecutionOutcome = (typeof NORMALIZED_EXECUTION_OUTCOMES)[number];

export const reportedTestClaimSchema = z
  .object({
    name: z.string().min(1),
    status: z.enum(['passed', 'failed', 'skipped']),
  })
  .strict();

export const normalizedExecutionResultSchema = z
  .object({
    schemaVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default(NORMALIZED_RESULT_SCHEMA_VERSION),
    /** Runner implementation name (e.g. "codex-cli"). */
    runner: z.string().min(1),
    /** Runner profile name (e.g. "codex-default"). */
    profile: z.string().min(1),
    category: z.enum(RUNNER_CATEGORIES),
    supportLevel: z.enum(RUNNER_SUPPORT_LEVELS),
    operation: z.enum(RUNNER_OPERATIONS),
    outcome: z.enum(NORMALIZED_EXECUTION_OUTCOMES),
    summary: z.string().default(''),
    providerSessionId: z.string().optional(),
    /** Provider claims — informational only, never evidence. */
    reportedChangedFiles: z.array(z.string()).default([]),
    reportedCommands: z.array(z.string()).default([]),
    reportedTests: z.array(reportedTestClaimSchema).default([]),
    blockingQuestions: z.array(z.string()).default([]),
    remainingRisks: z.array(z.string()).default([]),
    usage: runnerUsageSchema,
    cost: runnerCostSchema,
    error: normalizedRunnerErrorSchema.optional(),
    warnings: z.array(z.string()).default([]),
  })
  .strict();
export type NormalizedExecutionResult = z.infer<typeof normalizedExecutionResultSchema>;
