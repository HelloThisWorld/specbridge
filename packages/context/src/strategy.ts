import { z } from 'zod';
import {
  CONTEXT_EXPANSION_LEVELS,
  CONTEXT_EXPANSION_LEVEL_DEPTH,
  CONTEXT_STRATEGIES,
  expansionLevelAtDepth,
} from './vocabulary.js';
import type {
  ContextExpansionLevel,
  ContextInsufficiencySignal,
  ContextStrategy,
} from './vocabulary.js';

/**
 * Context strategy and bounded progressive expansion.
 *
 * The expansion rule that gives this phase its name, stated once:
 *
 *   context miss → bounded widening
 *   NOT: context miss → the whole repository
 *
 * A retriever that answers every gap by dumping the repository has not
 * solved retrieval, it has postponed it until the window is full. So
 * widening is deliberately hard to trigger and easy to stop: it needs
 * OBSERVED evidence of insufficiency, it advances exactly one level at a
 * time, it consumes a budget, and when that budget is spent the answer is to
 * hand the problem back to the reliability planner — never to widen again.
 *
 * The ceiling is a BOUNDED FALLBACK, not "everything". A task whose working
 * set genuinely will not fit is a decomposition problem, and Reliability and
 * Planning own that decision. The context layer's job is to report the
 * pressure honestly, not to route around it.
 */

export const contextExpansionPolicySchema = z
  .object({
    /** Expansions permitted per ATTEMPT. */
    maxExpansionsPerAttempt: z.number().int().min(0).max(4).default(1),
    /** Expansions permitted per TASK, across every attempt. */
    maxExpansionsPerTask: z.number().int().min(0).max(12).default(3),
    /** Deepest level widening may reach. */
    maxLevel: z.enum(CONTEXT_EXPANSION_LEVELS).default('MODULE_CONTEXT'),
    /**
     * Ceiling on total estimated working-set growth across a task, as a
     * multiple of the FIRST package's working set. Widening that has already
     * tripled the working set without succeeding is not a context problem.
     */
    maxWorkingSetGrowthFactor: z.number().min(1).max(8).default(3),
    /** Candidate items admitted per expansion level. */
    itemsPerLevel: z.number().int().min(1).max(50).default(4),
  })
  .passthrough();
export type ContextExpansionPolicy = z.infer<typeof contextExpansionPolicySchema>;

export function defaultContextExpansionPolicy(): ContextExpansionPolicy {
  return contextExpansionPolicySchema.parse({});
}

/** Durable-friendly record of how much widening a task has already spent. */
export const contextExpansionStateSchema = z
  .object({
    taskId: z.string().min(1).max(512),
    nodeId: z.string().min(1).max(512).optional(),
    /** Current level future packages are built at. */
    level: z.enum(CONTEXT_EXPANSION_LEVELS).default('TOP_WORKING_SET'),
    expansionsThisTask: z.number().int().min(0).default(0),
    expansionsThisAttempt: z.number().int().min(0).default(0),
    /** Working-set tokens in the first package built for this task. */
    baselineWorkingSetTokens: z.number().int().min(0).nullable().default(null),
    /** Working-set tokens in the most recent package. */
    lastWorkingSetTokens: z.number().int().min(0).nullable().default(null),
    /** Signals observed that justified each expansion, oldest first. */
    observedSignals: z.array(z.enum(['WORKER_REPORTED_MISSING_CONTEXT', 'UNKNOWN_SYMBOL_REFERENCE', 'SELECTED_ARTIFACT_STALE', 'MANDATORY_REFERENCE_DROPPED', 'DIRECT_MODEL_REQUESTED_REPOSITORY', 'FAILURE_IN_UNSELECTED_FILE'])).max(24).default([]),
    updatedAt: z.string().min(1).max(64),
  })
  .passthrough();
export type ContextExpansionState = z.infer<typeof contextExpansionStateSchema>;

export const EXPANSION_REFUSAL_REASONS = [
  'NOT_PROGRESSIVE_STRATEGY',
  'NO_EVIDENCE_OF_CONTEXT_MISS',
  'ATTEMPT_BUDGET_EXHAUSTED',
  'TASK_BUDGET_EXHAUSTED',
  'MAX_LEVEL_REACHED',
  'GROWTH_CEILING_REACHED',
] as const;
export type ExpansionRefusalReason = (typeof EXPANSION_REFUSAL_REASONS)[number];

export interface ExpansionDecision {
  expand: boolean;
  /** The level the next package should be built at. */
  nextLevel: ContextExpansionLevel;
  /** Why widening was refused, when it was. */
  refusalReason?: ExpansionRefusalReason | undefined;
  /** Bounded, safe explanation. Written by policy, never by a model. */
  reason: string;
  /**
   * Set when widening is refused because its budget is spent. The context
   * layer never acts on this — it hands the situation back to the control
   * plane, which owns replanning, mode changes, and escalation.
   */
  returnToReliability: boolean;
}

export interface ExpansionInput {
  strategy: ContextStrategy;
  policy: ContextExpansionPolicy;
  state: ContextExpansionState;
  /**
   * Observed evidence that the previous package was insufficient. EMPTY
   * means no widening: expansion is evidence-driven, and "the attempt
   * failed" is not by itself evidence that context was the reason.
   */
  signals: readonly ContextInsufficiencySignal[];
}

/**
 * Decide whether to widen retrieval by one level.
 *
 * Pure and total. Every refusal names its reason, and the reasons are a
 * closed set, so "why did context stop growing?" is answerable from durable
 * records rather than from a log line.
 */
export function planContextExpansion(input: ExpansionInput): ExpansionDecision {
  const currentLevel = input.state.level;
  const stay = (
    refusalReason: ExpansionRefusalReason,
    reason: string,
    returnToReliability = false,
  ): ExpansionDecision => ({
    expand: false,
    nextLevel: currentLevel,
    refusalReason,
    reason,
    returnToReliability,
  });

  if (input.strategy !== 'PROGRESSIVE') {
    return stay(
      'NOT_PROGRESSIVE_STRATEGY',
      `Context strategy ${input.strategy} does not widen automatically; retrieval built one bounded package.`,
    );
  }
  if (input.signals.length === 0) {
    return stay(
      'NO_EVIDENCE_OF_CONTEXT_MISS',
      'Nothing observed indicates the package was missing context; widening every turn would be an unbounded token loop.',
    );
  }
  if (input.state.expansionsThisAttempt >= input.policy.maxExpansionsPerAttempt) {
    return stay(
      'ATTEMPT_BUDGET_EXHAUSTED',
      `This attempt already widened context ${input.state.expansionsThisAttempt} time(s); further widening needs a new attempt.`,
    );
  }
  if (input.state.expansionsThisTask >= input.policy.maxExpansionsPerTask) {
    return stay(
      'TASK_BUDGET_EXHAUSTED',
      `Context has been widened ${input.state.expansionsThisTask} time(s) on this task without success; more context is not the answer.`,
      true,
    );
  }

  const currentDepth = CONTEXT_EXPANSION_LEVEL_DEPTH[currentLevel];
  const maxDepth = CONTEXT_EXPANSION_LEVEL_DEPTH[input.policy.maxLevel];
  if (currentDepth >= maxDepth) {
    return stay(
      'MAX_LEVEL_REACHED',
      `Retrieval is already at its widest configured level (${currentLevel}); the remaining options are a different execution mode, a replan, or an escalation.`,
      true,
    );
  }

  const baseline = input.state.baselineWorkingSetTokens;
  const latest = input.state.lastWorkingSetTokens;
  if (baseline !== null && baseline > 0 && latest !== null) {
    const growth = latest / baseline;
    if (growth >= input.policy.maxWorkingSetGrowthFactor) {
      return stay(
        'GROWTH_CEILING_REACHED',
        `The working set has already grown ${growth.toFixed(1)}× since the first package without a verified result; widening further would amplify tokens rather than information.`,
        true,
      );
    }
  }

  const nextLevel = expansionLevelAtDepth(currentDepth + 1);
  return {
    expand: true,
    nextLevel,
    reason:
      `Observed context insufficiency (${input.signals.join(', ')}); retrieval widens one level from ` +
      `${currentLevel} to ${nextLevel} rather than escalating intelligence or materializing the repository.`,
    returnToReliability: false,
  };
}

/** Apply a decision to the durable expansion state. */
export function applyExpansion(
  state: ContextExpansionState,
  decision: ExpansionDecision,
  input: { signals: readonly ContextInsufficiencySignal[]; now: string; workingSetTokens?: number | undefined },
): ContextExpansionState {
  const withMetrics: ContextExpansionState = {
    ...state,
    baselineWorkingSetTokens:
      state.baselineWorkingSetTokens ?? (input.workingSetTokens ?? null),
    lastWorkingSetTokens: input.workingSetTokens ?? state.lastWorkingSetTokens,
    updatedAt: input.now,
  };
  if (!decision.expand) return withMetrics;
  return {
    ...withMetrics,
    level: decision.nextLevel,
    expansionsThisTask: state.expansionsThisTask + 1,
    expansionsThisAttempt: state.expansionsThisAttempt + 1,
    observedSignals: [...state.observedSignals, ...input.signals].slice(-24),
  };
}

/** A fresh expansion state for a task that has not been widened yet. */
export function initialExpansionState(input: {
  taskId: string;
  nodeId?: string | undefined;
  now: string;
}): ContextExpansionState {
  return contextExpansionStateSchema.parse({
    taskId: input.taskId,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    level: 'TOP_WORKING_SET',
    updatedAt: input.now,
  });
}

/** Reset per-attempt counters when a new attempt begins. */
export function beginAttemptExpansion(
  state: ContextExpansionState,
  now: string,
): ContextExpansionState {
  return { ...state, expansionsThisAttempt: 0, updatedAt: now };
}

/** Every strategy value, for configuration validation and diagnostics. */
export const CONTEXT_STRATEGY_VALUES: readonly ContextStrategy[] = CONTEXT_STRATEGIES;
