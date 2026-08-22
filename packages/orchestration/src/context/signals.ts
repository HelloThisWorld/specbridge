import type {
  ContextInsufficiencySignal,
  ContextSelectionPlan,
  RepositoryContextIndex,
} from '@specbridge/context';
import {
  extractPathReferences,
  extractSymbolReferences,
  planContextExpansion,
  contextExpansionPolicySchema,
} from '@specbridge/context';
import type { ContextExpansionPolicy, ContextExpansionState, ContextStrategy } from '@specbridge/context';
import type { AgentConfig } from '@specbridge/core';

/**
 * Context-miss detection: telling "we did not give it what it needed" apart
 * from "it is not good enough".
 *
 * This is the single most consequential distinction vNext.7 adds to the
 * reliability layer. Treating a missing file as an intelligence failure
 * spends prepaid quota — or real money — asking a stronger model a question
 * that no model could answer from the package it was handed. Treating an
 * intelligence failure as a context miss wastes bounded widening on work
 * that was never going to succeed. Both errors are expensive; only the first
 * is invisible.
 *
 * So every signal here is OBSERVED, never inferred from the fact that the
 * attempt failed:
 *
 *   the worker's structured output named a repository artifact that the plan
 *     did not include;
 *   the failure points at a file that exists in the index and was never
 *     selected or pointed at;
 *   a selected artifact's hash had already moved when it was read;
 *   a mandatory reference could not be fitted into the budget;
 *   a direct model declined for want of repository access.
 *
 * Nothing here reads model prose for sentiment. A worker asserting "I need
 * more context" with no artifact named produces NO signal, deliberately —
 * that claim is exactly the thing an underperforming model says, and acting
 * on it would let a worker request its own budget increase.
 */

export interface ContextMissInput {
  /** The plan that produced the failing attempt's package. */
  plan: ContextSelectionPlan | undefined;
  /** The repository index, for deciding whether a named artifact exists. */
  index: RepositoryContextIndex | undefined;
  /** Bounded text of the failure (verifier output summary, error message). */
  failureText?: string | undefined;
  /**
   * Bounded text the WORKER produced in its structured result: blocking
   * questions, remaining risks, escalation reason. Structured fields only —
   * never a transcript.
   */
  workerReportedText?: string | undefined;
  /** Paths whose indexed hash no longer matched when the package was built. */
  refreshedPaths?: readonly string[] | undefined;
  /** True when a DIRECT_MODEL attempt declined for want of repository tools. */
  directModelRequestedRepository?: boolean | undefined;
}

export interface ContextMissAssessment {
  signals: ContextInsufficiencySignal[];
  /** Repository paths the evidence says were needed and not provided. */
  missingPaths: string[];
  /** Symbols referenced that the package never carried. */
  missingSymbols: string[];
}

/** Every repository path the package actually carried, materialized or named. */
function providedPaths(plan: ContextSelectionPlan | undefined): Set<string> {
  const paths = new Set<string>();
  for (const entry of plan?.selectedWorkingItems ?? []) paths.add(entry.path);
  for (const pointer of plan?.pointers ?? []) paths.add(pointer.path);
  return paths;
}

/**
 * Assess whether an attempt failed for want of context.
 *
 * Pure and total. An empty signal list is the common and correct answer —
 * most failures are not context misses, and this function is deliberately
 * reluctant to say otherwise.
 */
export function assessContextMiss(input: ContextMissInput): ContextMissAssessment {
  const signals = new Set<ContextInsufficiencySignal>();
  const provided = providedPaths(input.plan);
  const missingPaths: string[] = [];
  const missingSymbols: string[] = [];

  // 1. The worker named a repository artifact it did not have. The index is
  //    what makes this checkable: a path that does not exist in the
  //    repository is a model hallucinating a filename, not a context miss.
  const workerPaths = extractPathReferences(input.workerReportedText ?? '');
  for (const candidate of workerPaths) {
    if (provided.has(candidate)) continue;
    if (input.index?.has(candidate) !== true) continue;
    signals.add('WORKER_REPORTED_MISSING_CONTEXT');
    if (!missingPaths.includes(candidate)) missingPaths.push(candidate);
  }

  // 2. The worker referenced a symbol the repository declares somewhere the
  //    package never covered.
  for (const symbol of extractSymbolReferences(input.workerReportedText ?? '')) {
    const declaring = input.index?.declaring(symbol) ?? [];
    if (declaring.length === 0) continue;
    if (declaring.some((path) => provided.has(path))) continue;
    signals.add('UNKNOWN_SYMBOL_REFERENCE');
    if (!missingSymbols.includes(symbol)) missingSymbols.push(symbol);
    for (const path of declaring) if (!missingPaths.includes(path)) missingPaths.push(path);
  }

  // 3. The failure itself points into a file that exists and was never sent.
  for (const candidate of extractPathReferences(input.failureText ?? '')) {
    if (provided.has(candidate)) continue;
    if (input.index?.has(candidate) !== true) continue;
    signals.add('FAILURE_IN_UNSELECTED_FILE');
    if (!missingPaths.includes(candidate)) missingPaths.push(candidate);
  }

  // 4. A selected artifact had already moved when it was read. The package
  //    used the CURRENT bytes (selection re-reads and hash-checks), so this
  //    is not a correctness problem — it is evidence that the repository is
  //    changing under the task faster than the index, and a reason to widen
  //    rather than to conclude anything about the model.
  const staleSelected = (input.refreshedPaths ?? []).filter((path) => provided.has(path));
  if (staleSelected.length > 0) signals.add('SELECTED_ARTIFACT_STALE');

  // 5. A MANDATORY reference — one durable state named — could not be fitted.
  const droppedMandatory = (input.plan?.excludedCandidates ?? []).filter(
    (entry) => entry.reason === 'BUDGET_EXHAUSTED' || entry.reason === 'TOO_LARGE',
  );
  const mandatoryPaths = new Set(
    (input.plan?.selectedWorkingItems ?? [])
      .filter((entry) => entry.mandatory)
      .map((entry) => entry.path),
  );
  for (const entry of droppedMandatory) {
    if (!mandatoryPaths.has(entry.path)) continue;
    signals.add('MANDATORY_REFERENCE_DROPPED');
    if (!missingPaths.includes(entry.path)) missingPaths.push(entry.path);
  }

  // 6. A direct model with no tools said it needed the repository. This one
  //    comes from a STRUCTURED decision the local executor already records
  //    (its ESCALATE outcome), not from prose.
  if (input.directModelRequestedRepository === true) {
    signals.add('DIRECT_MODEL_REQUESTED_REPOSITORY');
  }

  return { signals: [...signals], missingPaths, missingSymbols };
}

/** Map the configured efficiency policy onto the pure expansion policy. */
export function expansionPolicyFrom(config: AgentConfig): ContextExpansionPolicy {
  const policy = config.orchestration.jobs.context.efficiency;
  return contextExpansionPolicySchema.parse({
    maxExpansionsPerAttempt: policy.maxExpansionsPerAttempt,
    maxExpansionsPerTask: policy.maxExpansionsPerTask,
    maxLevel: policy.maxExpansionLevel,
    maxWorkingSetGrowthFactor: policy.maxWorkingSetGrowthFactor,
  });
}

export interface ContextExpansionOffer {
  available: boolean;
  nextLevel: string;
  reason: string;
  exhausted: boolean;
}

/**
 * Turn observed context-miss evidence into the OFFER the recovery planner
 * reads.
 *
 * An offer, emphatically not a decision. The context layer says what
 * widening would mean and whether its budget permits it; the reliability
 * planner decides whether widening is the right response at all, and may
 * ignore the offer entirely — a hard boundary, an exhausted budget, or a
 * broken verifier all outrank it. Context prepares; Reliability decides;
 * the Scheduler places.
 */
export function offerContextExpansion(input: {
  config: AgentConfig;
  state: ContextExpansionState;
  signals: readonly ContextInsufficiencySignal[];
}): ContextExpansionOffer {
  const strategy = input.config.orchestration.jobs.context.efficiency.strategy as ContextStrategy;
  const decision = planContextExpansion({
    strategy,
    policy: expansionPolicyFrom(input.config),
    state: input.state,
    signals: input.signals,
  });
  return {
    available: decision.expand,
    nextLevel: decision.nextLevel,
    reason: decision.reason,
    exhausted: decision.returnToReliability,
  };
}
