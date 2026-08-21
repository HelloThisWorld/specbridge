import type { ApiPricingProfile } from '@specbridge/core';
import type { WorkloadEstimate } from './profiler.js';
import type { ApiCostSource } from './vocabulary.js';

/**
 * API cost estimation (vNext.5).
 *
 * Automatic paid execution must know what it is approximately authorizing.
 * That has one hard consequence, stated up front because everything below
 * follows from it:
 *
 *   UNKNOWN COST IS NEVER ZERO.
 *
 * When pricing is unconfigured or the workload's token usage is not
 * estimable, this module returns an estimate whose `estimatedCostUsd` is
 * `null` — and the gap-bridge planner refuses automatic spend on a null.
 * There is no fallback price, no "typical" default, and no internet lookup:
 * provider prices change, and a hard-coded table would quietly become a
 * lie in the one module that authorizes spending.
 *
 * Two figures are produced and never conflated:
 *
 *   estimatedCostUsd  the mean expectation
 *   safeCostUsd       that mean times the configured safety multiplier
 *
 * Budget admission compares the SAFE figure. A later phase with real
 * distributions can replace the multiplier with a measured P90 without any
 * caller changing.
 */

export type ApiCostConfidence = 'low' | 'medium' | 'high';

export interface ApiCostEstimate {
  /** Expected input tokens for one attempt; null when not estimable. */
  estimatedInputTokens: number | null;
  /** Expected output tokens for one attempt; null when not estimable. */
  estimatedOutputTokens: number | null;
  /**
   * Mean expected monetary cost. NULL means "cannot be estimated" and is
   * never interpreted as free.
   */
  estimatedCostUsd: number | null;
  /**
   * The mean times the safety multiplier — the figure budget admission
   * actually compares. Null exactly when `estimatedCostUsd` is null.
   */
  safeCostUsd: number | null;
  currency: 'USD';
  confidence: ApiCostConfidence;
  /** Operator-declared origin of the price table, verbatim. */
  pricingSource: string | null;
  /** How the token figures were derived ('heuristic' | 'historical' | 'unknown'). */
  estimateBasis: string;
  /** The safety multiplier applied, recorded so the figure is reproducible. */
  safetyMultiplier: number;
  /** Cost source classification for the ledger. */
  costSource: ApiCostSource;
  detail: string;
}

export interface EstimateApiCostInput {
  estimate: Pick<
    WorkloadEstimate,
    'expectedInputTokens' | 'expectedOutputTokens' | 'tokenBasis' | 'confidence'
  >;
  /** Operator-configured pricing; null means cost cannot be computed. */
  pricing: ApiPricingProfile | null;
  /** Conservative multiplier applied to the mean before budget admission. */
  safetyMultiplier: number;
}

function costOf(tokens: number, costPerMillion: number): number {
  return (tokens / 1_000_000) * costPerMillion;
}

/** Round to whole cents-of-a-cent so recorded figures compare stably. */
function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Estimate one API attempt's cost. Pure, offline, deterministic. */
export function estimateApiCost(input: EstimateApiCostInput): ApiCostEstimate {
  const { estimate, pricing } = input;
  const safetyMultiplier = input.safetyMultiplier;
  const unknown = (detail: string): ApiCostEstimate => ({
    estimatedInputTokens: estimate.expectedInputTokens,
    estimatedOutputTokens: estimate.expectedOutputTokens,
    estimatedCostUsd: null,
    safeCostUsd: null,
    currency: 'USD',
    confidence: 'low',
    pricingSource: pricing?.source ?? null,
    estimateBasis: estimate.tokenBasis,
    safetyMultiplier,
    costSource: 'UNKNOWN',
    detail,
  });

  if (pricing === null) {
    return unknown(
      'No API pricing is configured (orchestration.jobs.scheduler.api.pricing is null), so the ' +
        'monetary cost of this attempt cannot be estimated. Unknown cost is never treated as zero.',
    );
  }
  if (estimate.expectedInputTokens === null || estimate.expectedOutputTokens === null) {
    return unknown(
      'The workload profiler could not estimate token usage for this task, so its monetary cost ' +
        'is unknown. Unknown cost is never treated as zero.',
    );
  }

  const inputCost = costOf(estimate.expectedInputTokens, pricing.inputCostPerMillion);
  const outputCost = costOf(estimate.expectedOutputTokens, pricing.outputCostPerMillion);
  const estimatedCostUsd = roundUsd(inputCost + outputCost);
  const safeCostUsd = roundUsd(estimatedCostUsd * safetyMultiplier);
  // Confidence tracks the WEAKER of the two inputs: a precise price table
  // applied to a guessed token count is still a guess.
  const confidence: ApiCostConfidence = estimate.tokenBasis === 'historical' ? 'medium' : 'low';

  return {
    estimatedInputTokens: estimate.expectedInputTokens,
    estimatedOutputTokens: estimate.expectedOutputTokens,
    estimatedCostUsd,
    safeCostUsd,
    currency: 'USD',
    confidence,
    pricingSource: pricing.source,
    estimateBasis: estimate.tokenBasis,
    safetyMultiplier,
    costSource: 'ESTIMATED_PRE_DISPATCH',
    detail:
      `~${estimate.expectedInputTokens.toLocaleString('en-US')} input + ` +
      `${estimate.expectedOutputTokens.toLocaleString('en-US')} output tokens at the configured ` +
      `price table (${pricing.source}) is ~$${estimatedCostUsd.toFixed(4)}; ` +
      `budget admission uses the x${safetyMultiplier} safe figure $${safeCostUsd.toFixed(4)}.`,
  };
}

// ---------------------------------------------------------------------------
// Observed cost
// ---------------------------------------------------------------------------

export interface ObservedApiCost {
  costUsd: number | null;
  source: ApiCostSource;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  detail: string;
}

export interface ComputeObservedApiCostInput {
  /** Whatever the runner reported. Every field tolerates absence. */
  usage?:
    | {
        inputTokens?: number | null | undefined;
        outputTokens?: number | null | undefined;
        cachedInputTokens?: number | null | undefined;
        /** Provider-stated monetary cost, when the provider states one. */
        costUsd?: number | null | undefined;
      }
    | undefined;
  pricing: ApiPricingProfile | null;
  /** True when the attempt was interrupted and its usage is unknowable. */
  interrupted?: boolean | undefined;
}

/**
 * Determine what an API attempt actually cost, and say honestly how that
 * was determined.
 *
 * The precedence is evidence-first:
 *
 *   1. the provider REPORTED a cost            → PROVIDER_REPORTED
 *   2. the provider reported token usage and
 *      a price table exists                    → COMPUTED_FROM_USAGE
 *   3. anything else                           → UNKNOWN, cost null
 *
 * Case 2 is named honestly: it is a computation over a configured table,
 * not an invoice. Case 3 is never silently rendered as $0 — an interrupted
 * paid attempt may well have burned tokens remotely, and pretending
 * otherwise would corrupt every later cost-per-success figure.
 */
export function computeObservedApiCost(input: ComputeObservedApiCostInput): ObservedApiCost {
  const usage = input.usage;
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  const cachedTokens = usage?.cachedInputTokens ?? null;

  if (typeof usage?.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
    return {
      costUsd: roundUsd(usage.costUsd),
      source: 'PROVIDER_REPORTED',
      inputTokens,
      outputTokens,
      cachedTokens,
      detail: 'The provider reported the monetary cost of this attempt directly.',
    };
  }

  if (input.pricing !== null && (inputTokens !== null || outputTokens !== null)) {
    const pricing = input.pricing;
    // Cached input, when both reported and priced, is billed at the cached
    // rate and NOT double-counted against the standard input rate.
    const billableInput =
      cachedTokens !== null && pricing.cachedInputCostPerMillion !== null && inputTokens !== null
        ? Math.max(0, inputTokens - cachedTokens)
        : inputTokens;
    const cachedCost =
      cachedTokens !== null && pricing.cachedInputCostPerMillion !== null
        ? costOf(cachedTokens, pricing.cachedInputCostPerMillion)
        : 0;
    const computed =
      costOf(billableInput ?? 0, pricing.inputCostPerMillion) +
      costOf(outputTokens ?? 0, pricing.outputCostPerMillion) +
      cachedCost;
    return {
      costUsd: roundUsd(computed),
      source: 'COMPUTED_FROM_USAGE',
      inputTokens,
      outputTokens,
      cachedTokens,
      detail:
        'Computed from the attempt’s reported token usage and the configured price table ' +
        `(${pricing.source}); the provider did not state a monetary cost.`,
    };
  }

  return {
    costUsd: null,
    source: 'UNKNOWN',
    inputTokens,
    outputTokens,
    cachedTokens,
    detail:
      input.interrupted === true
        ? 'The attempt was interrupted before usage was reported; remote usage cannot be ruled ' +
          'out, so its cost stays UNKNOWN and its budget reservation is not released.'
        : 'Neither a provider-reported cost nor priceable token usage is available; the cost of ' +
          'this attempt is UNKNOWN, which is not the same as zero.',
  };
}
