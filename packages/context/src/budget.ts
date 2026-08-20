import { z } from 'zod';
import type { ContextItem, ContextUsage } from './items.js';
import type { ContextHealthLevel } from './vocabulary.js';

/**
 * Context budgets.
 *
 * Every provider/model exposes (or is configured with) a context capacity.
 * The advertised window is never treated as fully fillable prompt input:
 * headroom is reserved for model output, reasoning where applicable, the
 * next tool result, and unexpected growth. Budgets only ever make execution
 * *compact sooner* — nothing here can weaken a safety boundary.
 *
 * Token estimation is a deterministic heuristic (four characters per token,
 * rounded up). It is intentionally conservative and provider-neutral: exact
 * tokenizers differ per model, and the survival guarantee must not depend on
 * any provider's tokenizer being available. Estimates are used for budget
 * policy only — they are never reported as provider usage.
 */

export const contextBudgetConfigSchema = z
  .object({
    /** Advertised model context window, in tokens. */
    modelContextTokens: z.number().int().min(1_000).default(200_000),
    /** Reserved for model output. */
    reservedOutputTokens: z.number().int().min(0).default(16_000),
    /** Reserved for reasoning, where the model interleaves it. */
    reservedReasoningTokens: z.number().int().min(0).default(8_000),
    /** Reserved for the next tool result and unexpected growth. */
    reservedGrowthTokens: z.number().int().min(0).default(8_000),
    /** Below this ratio of usable input: HEALTHY. */
    prepareThreshold: z.number().min(0.05).max(1).default(0.55),
    /** At or above this ratio: compaction should run at the next boundary. */
    proactiveCompactionThreshold: z.number().min(0.05).max(1).default(0.7),
    /** At or above this ratio: compaction must run before further growth. */
    emergencyCompactionThreshold: z.number().min(0.05).max(1).default(0.85),
    /** At or above this ratio: no large context operation may start. */
    hardStopThreshold: z.number().min(0.05).max(1).default(0.9),
  })
  .passthrough()
  .refine(
    (config) =>
      config.prepareThreshold <= config.proactiveCompactionThreshold &&
      config.proactiveCompactionThreshold <= config.emergencyCompactionThreshold &&
      config.emergencyCompactionThreshold <= config.hardStopThreshold,
    { message: 'Context thresholds must be ordered: prepare <= proactive <= emergency <= hard stop.' },
  );
export type ContextBudgetConfig = z.infer<typeof contextBudgetConfigSchema>;

export function defaultContextBudgetConfig(): ContextBudgetConfig {
  return contextBudgetConfigSchema.parse({});
}

/** Deterministic provider-neutral token estimate: ceil(chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Fixed per-item envelope overhead (headers, separators) in tokens. */
const ITEM_ENVELOPE_TOKENS = 8;

export function estimateItemTokens(item: Pick<ContextItem, 'title' | 'content'>): number {
  return estimateTokens(item.title) + estimateTokens(item.content) + ITEM_ENVELOPE_TOKENS;
}

export function estimateItemsTokens(items: readonly Pick<ContextItem, 'title' | 'content'>[]): number {
  return items.reduce((sum, item) => sum + estimateItemTokens(item), 0);
}

/** Tokens actually available for assembled prompt input. */
export function usableInputTokens(config: ContextBudgetConfig): number {
  const usable =
    config.modelContextTokens -
    config.reservedOutputTokens -
    config.reservedReasoningTokens -
    config.reservedGrowthTokens;
  if (usable < 1) {
    throw new ContextBudgetError(
      `The context budget leaves no usable input: ${config.modelContextTokens} total minus ` +
        `${config.reservedOutputTokens + config.reservedReasoningTokens + config.reservedGrowthTokens} reserved.`,
    );
  }
  return usable;
}

export function computeContextUsage(
  config: ContextBudgetConfig,
  estimatedTokens: number,
): ContextUsage {
  const usable = usableInputTokens(config);
  return {
    estimatedTokens,
    usableInputTokens: usable,
    modelContextTokens: config.modelContextTokens,
    ratio: Math.round((estimatedTokens / usable) * 10_000) / 10_000,
  };
}

/** Map a usage ratio onto the closed health vocabulary. */
export function assessContextHealth(
  config: ContextBudgetConfig,
  estimatedTokens: number,
): ContextHealthLevel {
  const ratio = estimatedTokens / usableInputTokens(config);
  if (ratio >= config.hardStopThreshold) return 'OVERFLOW';
  if (ratio >= config.emergencyCompactionThreshold) return 'FORCE_COMPACT';
  if (ratio >= config.proactiveCompactionThreshold) return 'PROACTIVE_COMPACT';
  if (ratio >= config.prepareThreshold) return 'PREPARE';
  return 'HEALTHY';
}

/**
 * Raised when a context budget cannot be satisfied safely. Explicit by
 * design: an incomplete or misleading context is never produced silently.
 */
export class ContextBudgetError extends Error {
  readonly code = 'CONTEXT_BUDGET_UNSATISFIABLE';

  constructor(message: string) {
    super(message);
    this.name = 'ContextBudgetError';
  }
}
