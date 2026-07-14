import { z } from 'zod';

/**
 * Normalized runner usage and cost (v0.6, frozen).
 *
 * Usage is provider-reported and best-effort: every field except durationMs
 * is nullable because most providers report only a subset. Cost is NEVER
 * computed from hardcoded pricing — it is either provider-reported, an
 * explicit user-configured estimate, or `unavailable`. Local execution
 * (e.g. Ollama) is reported as `unavailable`, not as zero: local compute
 * is not free, SpecBridge just cannot price it.
 */

export const RUNNER_USAGE_SCHEMA_VERSION = '1.0.0';

export const runnerUsageSchema = z
  .object({
    model: z.string().nullable().default(null),
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    cachedInputTokens: z.number().int().nonnegative().nullable().default(null),
    outputTokens: z.number().int().nonnegative().nullable().default(null),
    reasoningTokens: z.number().int().nonnegative().nullable().default(null),
    requestCount: z.number().int().nonnegative().nullable().default(null),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type RunnerUsage = z.infer<typeof runnerUsageSchema>;

export const RUNNER_COST_SOURCES = [
  'provider-reported',
  'configured-estimate',
  'unavailable',
] as const;
export type RunnerCostSource = (typeof RUNNER_COST_SOURCES)[number];

export const runnerCostSchema = z
  .object({
    currency: z.string().nullable().default(null),
    amount: z.number().nonnegative().nullable().default(null),
    source: z.enum(RUNNER_COST_SOURCES),
  })
  .strict();
export type RunnerCost = z.infer<typeof runnerCostSchema>;

export function emptyUsage(durationMs: number): RunnerUsage {
  return runnerUsageSchema.parse({ durationMs: Math.max(0, Math.round(durationMs)) });
}

export function unavailableCost(): RunnerCost {
  return { currency: null, amount: null, source: 'unavailable' };
}
