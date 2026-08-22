import type { ContextEfficiencyMetrics } from '@specbridge/context';
import type { ExecutionLedgerEntry } from '../survival/state.js';
import type { FailureSource } from '../reliability/vocabulary.js';
import { isInfrastructureSource } from '../reliability/vocabulary.js';
import { candidateKey, targetKey } from './candidates.js';
import type { AdaptiveOutcomeLabel } from './vocabulary.js';

/**
 * Normalized observed outcomes (vNext.8).
 *
 * This module is the ONLY doorway between canonical execution history and
 * the adaptive layer, and the restriction it enforces is the one that keeps
 * the scheduler from learning from itself:
 *
 *   only EXECUTED attempts with REAL observations become evidence.
 *
 * A prediction, a recommendation, an unexecuted candidate, or a shadow-mode
 * counterfactual has no representation here at all. There is no constructor
 * that takes one, which is deliberate: a self-reinforcing routing loop
 * cannot be introduced by a caller who was not paying attention, because
 * the type it would need does not exist.
 *
 * Three further rules are enforced by the label assignment below:
 *
 *   success means VERIFIED    completion plus an evaluation PASS. A worker
 *                             saying it finished is a claim, not evidence.
 *   INCONCLUSIVE is not FAIL  a broken verifier proves nothing about the
 *                             work, and training it as failure would teach
 *                             the scheduler to avoid whichever lane happened
 *                             to be running when the test harness broke.
 *   infrastructure is not     a crashed harness and a wrong implementation
 *   intelligence              are different observations with different
 *                             consequences, and they stay separable forever.
 */

export interface AdaptiveObservation {
  attemptId: string;
  jobId: string;
  nodeId: string;
  taskId: string;
  /** The coarse task signature key recorded at dispatch. Null pre-vNext.8. */
  signatureKey: string | null;
  /** Coarse category/complexity attribution, present since vNext.2. */
  taskCategory: string | null;
  taskComplexity: string | null;
  /** Full orthogonal execution target key. */
  candidateKey: string;
  /** Coarser lane/mode/runner key, for the sparse-data fallback level. */
  targetKey: string;
  lane: string | null;
  executionMode: string | null;
  runner: string;
  model: string | null;
  contextStrategy: string | null;
  runnerVersion: string | null;
  label: AdaptiveOutcomeLabel;
  /** WHERE the failure came from, when the reliability layer assessed one. */
  failureSource: FailureSource | null;
  /** Deterministic health at the time of the observation. */
  executionHealth: string | null;
  /** Recovery action taken afterwards, when one was decided. */
  recoveryAction: string | null;
  /** 1-based attempt number within the task. */
  attemptNumber: number;
  /** Observed wall time, when the attempt reported it. */
  wallTimeMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Five-hour quota consumed, when both endpoints were observed. */
  fiveHourBurnRatio: number | null;
  /** Reconciled monetary cost. Null means UNKNOWN, never zero. */
  costUsd: number | null;
  /** Estimated context tokens the attempt was given (vNext.7 metrics). */
  contextTokens: number | null;
  /** Bounded widenings the attempt needed (vNext.7 metrics). */
  contextExpansions: number | null;
  /** True when the attempt failed for want of CONTEXT rather than ability. */
  contextInsufficient: boolean;
  /**
   * True for failures that are policy-relevant regardless of age: a
   * contract/authorization violation is not an ordinary performance data
   * point and does not age out of relevance the way latency does.
   */
  safetyEvent: boolean;
  observedAt: string;
}

/**
 * Failure sources that describe a boundary being violated rather than work
 * being done badly. Kept exempt from recency decay so a rare serious event
 * stays visible long after ordinary numbers have aged away.
 */
const SAFETY_FAILURE_SOURCES: readonly FailureSource[] = ['AUTHORIZATION', 'REQUIREMENT_CONTRACT'];

function labelFor(entry: ExecutionLedgerEntry): AdaptiveOutcomeLabel {
  // Censored first: an interrupted attempt's outcome is genuinely unknown,
  // and the most common way statistics become falsely optimistic is quietly
  // dropping the runs that did not finish.
  if (entry.status === 'INTERRUPTED' || entry.status === 'CANCELLED') return 'CENSORED';
  if (entry.evaluationStatus === 'INCONCLUSIVE') return 'INCONCLUSIVE';
  if (entry.success) {
    return entry.evaluationStatus === 'PASS' ? 'VERIFIED_SUCCESS' : 'UNVERIFIED_SUCCESS';
  }
  const source = entry.failureSource as FailureSource | null;
  if (source !== null && isInfrastructureSource(source)) return 'INFRASTRUCTURE_FAILURE';
  // A failure the reliability layer never assessed cannot be attributed. It
  // is recorded as an implementation failure only when nothing suggests
  // otherwise, and the failure-source distribution on the profile keeps the
  // ambiguity visible rather than burying it.
  return 'IMPLEMENTATION_FAILURE';
}

function contextInsufficiencyFrom(entry: ExecutionLedgerEntry): boolean {
  if (entry.failureSource === 'CONTEXT') return true;
  return entry.recoveryAction === 'EXPAND_CONTEXT';
}

export interface DeriveObservationsInput {
  entries: readonly ExecutionLedgerEntry[];
  /** vNext.7 context metrics, keyed by the attempt they served. */
  contextMetrics?: ReadonlyMap<string, ContextEfficiencyMetrics> | undefined;
}

/**
 * Derive adaptive observations from ledger entries.
 *
 * Only EXECUTOR-role attempts contribute: this phase predicts how well a
 * target performs the WORK, and folding planner/critic runs into the same
 * average would answer a question nobody asked. Attempts still RUNNING are
 * skipped — an unfinished attempt has no outcome yet, and inventing one is
 * how survivorship bias enters.
 */
export function deriveAdaptiveObservations(input: DeriveObservationsInput): AdaptiveObservation[] {
  const observations: AdaptiveObservation[] = [];
  for (const entry of input.entries) {
    if (entry.role !== 'EXECUTOR') continue;
    if (entry.status === 'RUNNING') continue;
    const metrics = input.contextMetrics?.get(entry.attemptId);
    const contextStrategy = entry.contextStrategy ?? metrics?.strategy ?? null;
    const key = candidateKey({
      lane: entry.lane ?? '-',
      executionMode: entry.executionMode,
      runner: entry.provider,
      model: entry.model,
      contextStrategy: contextStrategy ?? '-',
    });
    const source = entry.failureSource as FailureSource | null;
    const burn = quotaBurn(entry);
    observations.push({
      attemptId: entry.attemptId,
      jobId: entry.jobId,
      nodeId: entry.nodeId,
      taskId: entry.taskId,
      signatureKey: entry.taskSignature,
      taskCategory: entry.taskCategory,
      taskComplexity: entry.taskComplexity,
      candidateKey: key,
      targetKey: targetKey({ lane: entry.lane ?? '-', executionMode: entry.executionMode }),
      lane: entry.lane,
      executionMode: entry.executionMode,
      runner: entry.provider,
      model: entry.model,
      contextStrategy,
      runnerVersion: entry.runnerVersion,
      label: labelFor(entry),
      failureSource: source,
      executionHealth: entry.executionHealth,
      recoveryAction: entry.recoveryAction,
      attemptNumber: entry.attemptNumber,
      wallTimeMs: entry.metrics.durationMs,
      inputTokens: entry.metrics.inputTokens,
      outputTokens: entry.metrics.outputTokens,
      fiveHourBurnRatio: burn,
      // Reconciled cost only. An estimate is what SpecBridge guessed before
      // the attempt ran, and folding guesses into observed history is how a
      // prediction quietly becomes its own evidence.
      costUsd: entry.metrics.reconciledCostUsd,
      contextTokens: metrics?.estimatedContextTokens ?? null,
      contextExpansions: metrics?.contextExpansions ?? null,
      contextInsufficient: contextInsufficiencyFrom(entry),
      safetyEvent: source !== null && SAFETY_FAILURE_SOURCES.includes(source),
      observedAt: entry.completedAt ?? entry.startedAt,
    });
  }
  return observations;
}

/**
 * Five-hour quota consumed by one attempt, when both endpoints were
 * observed. A reset inside the attempt makes `after > before`, and the burn
 * across that boundary is not derivable from two endpoints — so the honest
 * answer is null, exactly as the vNext.2 burn observations decided.
 */
function quotaBurn(entry: ExecutionLedgerEntry): number | null {
  const metrics = entry.metrics as Record<string, unknown>;
  const before = metrics['fiveHourQuotaBefore'];
  const after = metrics['fiveHourQuotaAfter'];
  if (typeof before !== 'number' || typeof after !== 'number') return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  const delta = before - after;
  return delta >= 0 ? delta : null;
}
