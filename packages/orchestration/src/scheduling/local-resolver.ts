import type { LocalExecutionMode, LocalExecutionStrategy } from '@specbridge/core';
import type { LocalHarnessBinding } from './local-binding.js';
import type { ExecutionShapeAssessment } from './execution-shape.js';
import type {
  LocalExecutionModeReason,
  LocalExecutionShape,
  LocalSuitabilityClass,
} from './vocabulary.js';

/**
 * The LocalExecutionResolver (vNext.4).
 *
 * The economic scheduler decides the LANE. This decides, for work already
 * routed LOCAL, HOW that lane's zero-marginal-cost compute is spent:
 *
 *          Economic Scheduler
 *                  |
 *                LOCAL
 *                  |
 *        LocalExecutionResolver
 *          |               |
 *   DIRECT_MODEL        HARNESS
 *
 * Kept deliberately separate from `decideLane`: the quota scheduler must
 * never learn what a harness is, and this resolver must never be able to
 * change the lane. Selecting a harness can therefore never pull work into
 * (or out of) the LOCAL economic lane implicitly — the ordering is always
 * lane first, mode second.
 *
 * Pure, deterministic, and entirely policy: same inputs, same mode, forever
 * replayable from durable state. There is no learned component here, by
 * design (§80) — vNext.4 collects the evidence a later adaptive scheduler
 * would need, and nothing tunes itself yet.
 */

export interface LocalExecutionResolverInput {
  /** Rollout strategy from configuration. */
  strategy: LocalExecutionStrategy;
  /** The lane-level suitability class already assigned to this work. */
  suitability: LocalSuitabilityClass;
  /** Execution shape (one-shot vs agentic). */
  shape: ExecutionShapeAssessment;
  /** The direct structured-inference path is configured and usable. */
  directAvailable: boolean;
  /** The resolved LOCAL harness binding (verified locality included). */
  binding: LocalHarnessBinding;
  /**
   * A durable DIRECT → HARNESS escalation was recorded for this node: a
   * previous direct attempt failed for reasons repository tools address.
   */
  directToHarnessEscalated?: boolean | undefined;
  /** LOCAL attempts already spent on this task (SHARED across modes). */
  localAttemptsUsed: number;
  /** The bounded LOCAL attempt budget (shared across modes). */
  maxLocalAttempts: number;
  /**
   * Explicit per-task diagnostic override (CLI/config). It may choose
   * between modes for eligible local work; it can NEVER pull
   * STRONG_REQUIRED work local, and never bypasses locality verification —
   * an override for HARNESS against an unverified binding still refuses.
   */
  override?: LocalExecutionMode | undefined;
}

export interface LocalExecutionResolution {
  /** RESOLVED carries a mode; LOCAL_UNAVAILABLE means the lane cannot run it. */
  outcome: 'RESOLVED' | 'LOCAL_UNAVAILABLE';
  mode: LocalExecutionMode | null;
  reasonCode: LocalExecutionModeReason | null;
  shape: LocalExecutionShape;
  /** Harness identity/locality when the harness was selected. */
  harness: {
    profileName: string;
    runner: string;
    model: string | null;
    locality: LocalHarnessBinding['locality'];
    localityOverridden: boolean;
  } | null;
  detail: string;
}

function harnessIdentity(binding: LocalHarnessBinding): LocalExecutionResolution['harness'] {
  if (binding.profileName === null || binding.runner === null) return null;
  return {
    profileName: binding.profileName,
    runner: binding.runner,
    model: binding.model,
    locality: binding.locality,
    localityOverridden: binding.localityOverridden,
  };
}

/** The reason a preferred harness could not be used, by binding status. */
function harnessRefusalReason(binding: LocalHarnessBinding): LocalExecutionModeReason {
  return binding.status === 'NOT_VERIFIED_LOCAL' || binding.status === 'REMOTE_COMPUTE'
    ? 'LOCAL_HARNESS_NOT_VERIFIED_LOCAL'
    : 'LOCAL_HARNESS_UNAVAILABLE';
}

/** Resolve how one LOCAL-lane dispatch executes. Pure. */
export function resolveLocalExecutionMode(
  input: LocalExecutionResolverInput,
): LocalExecutionResolution {
  const shape = input.shape.shape;
  const binding = input.binding;
  const harnessSelectable = binding.available;

  const unavailable = (detail: string): LocalExecutionResolution => ({
    outcome: 'LOCAL_UNAVAILABLE',
    mode: null,
    reasonCode: null,
    shape,
    harness: null,
    detail,
  });
  const direct = (
    reasonCode: LocalExecutionModeReason,
    detail: string,
  ): LocalExecutionResolution =>
    input.directAvailable
      ? { outcome: 'RESOLVED', mode: 'DIRECT_MODEL', reasonCode, shape, harness: null, detail }
      : harnessSelectable
        ? {
            outcome: 'RESOLVED',
            mode: 'HARNESS',
            reasonCode: 'LOCAL_HARNESS_SELECTED',
            shape,
            harness: harnessIdentity(binding),
            detail: `${detail} The direct local path is unavailable, so the verified-local harness runs it.`,
          }
        : unavailable(`${detail} No local execution path is available.`);
  const harness = (
    reasonCode: LocalExecutionModeReason,
    detail: string,
  ): LocalExecutionResolution => ({
    outcome: 'RESOLVED',
    mode: 'HARNESS',
    reasonCode,
    shape,
    harness: harnessIdentity(binding),
    detail,
  });

  // The shared LOCAL attempt budget is one budget for the whole lane. Two
  // execution modes must never mean two budgets: that would silently double
  // the wall time a task may burn before escalating to the strong lane.
  if (input.localAttemptsUsed >= input.maxLocalAttempts) {
    return unavailable(
      `The shared LOCAL attempt budget is spent (${input.localAttemptsUsed}/${input.maxLocalAttempts}); the work escalates to the strong lane.`,
    );
  }

  // An explicit override chooses between modes for eligible local work. It
  // is a debugging/evaluation tool, not an authority: it cannot make an
  // unverified harness local, and it cannot conjure a missing path.
  if (input.override === 'HARNESS') {
    return harnessSelectable
      ? harness('LOCAL_HARNESS_FORCED', 'An explicit override selected the local harness path.')
      : direct(
          harnessRefusalReason(binding),
          `An explicit override requested the harness, but it is unusable (${binding.status}): ${binding.problems[0] ?? 'no bound harness'}.`,
        );
  }
  if (input.override === 'DIRECT_MODEL') {
    return direct('LOCAL_DIRECT_SELECTED', 'An explicit override selected the direct local path.');
  }

  if (input.strategy === 'DIRECT_ONLY') {
    return direct(
      'LOCAL_DIRECT_ONLY_STRATEGY',
      'The local execution strategy is DIRECT_ONLY; the harness path is not in play.',
    );
  }

  if (input.strategy === 'HARNESS_ONLY') {
    // Benchmark/A-B mode: force the harness for TASK dispatch. Local
    // preprocessing (context compression) never reaches this resolver — it
    // is not a task dispatch, and wrapping a single compression request in
    // an agent loop would be pure overhead.
    return harnessSelectable
      ? harness(
          'LOCAL_HARNESS_FORCED',
          'The local execution strategy is HARNESS_ONLY; eligible local task work runs on the verified-local harness.',
        )
      : direct(
          harnessRefusalReason(binding),
          `The strategy is HARNESS_ONLY but the harness is unusable (${binding.status}): ${binding.problems[0] ?? 'no bound harness'}. The direct path keeps the lane working.`,
        );
  }

  // ADAPTIVE.
  if (input.directToHarnessEscalated === true) {
    return harnessSelectable
      ? harness(
          'LOCAL_DIRECT_TO_HARNESS_ESCALATION',
          'A previous direct attempt failed for lack of repository knowledge; the same LOCAL budget continues on the harness path.',
        )
      : direct(
          harnessRefusalReason(binding),
          'A previous direct attempt indicated agentic work, but no usable harness is bound.',
        );
  }
  if (shape === 'AGENTIC') {
    return harnessSelectable
      ? harness(
          'LOCAL_HARNESS_SELECTED',
          `Agentic work (${input.shape.signals[0]?.signal ?? 'agentic'}) runs on the verified-local harness: it needs repository tools, not a bigger single request.`,
        )
      : direct(
          harnessRefusalReason(binding),
          `Agentic work would prefer the harness, but it is unusable (${binding.status}); the bounded direct attempt runs instead and deterministic verification still decides.`,
        );
  }
  return direct(
    'LOCAL_DIRECT_SELECTED',
    `One-shot work (${input.shape.signals[0]?.signal ?? 'bounded'}) runs as a single bounded local request; a tool loop would add cost without adding capability.`,
  );
}
