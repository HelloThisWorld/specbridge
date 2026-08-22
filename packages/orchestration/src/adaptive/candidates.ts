import type { ComputeLocality, LocalExecutionMode } from '@specbridge/core';
import type { ContextStrategy } from '@specbridge/context';
import type { ExecutionLane } from '../scheduling/vocabulary.js';
import type { NodeLaneRouting } from '../scheduling/scheduler.js';
import type { LocalHarnessBinding } from '../scheduling/local-binding.js';
import type { ApiHarnessBinding } from '../scheduling/api-binding.js';
import { strategyKey } from '../reliability/health.js';
import type { AdaptiveVetoCode } from './vocabulary.js';

/**
 * ExecutionCandidate (vNext.8): one concrete way this task could execute.
 *
 * Every dimension is a SEPARATE field, and that is the whole design. A
 * compound identity like `QWEN_LOCAL_DSH_FAST` makes "was this local?",
 * "did this use a harness?", and "which model ran it?" unanswerable
 * separately, and once history is keyed by such a value it can never be
 * re-sliced. Lane, execution mode, runner, model, context strategy, and
 * verified compute locality therefore stay orthogonal here, in the ledger,
 * and in every profile keyed off them.
 *
 * `candidateId` exists only as a DERIVED map key — a deterministic join of
 * the fields below, never an identity of its own and never parsed back.
 *
 * The critical structural property: candidates are generated FROM the hard
 * policy layer's output, never alongside it. `generateCandidates` takes an
 * already-decided `NodeLaneRouting` and can only enumerate ways to spend the
 * lane that decision selected. It has no path to a lane hard policy refused,
 * which is why "adaptive optimization may never make a forbidden choice
 * allowed" is enforced by the call graph rather than by a check somebody
 * could forget to write.
 */
export interface ExecutionCandidate {
  /** Derived map key: `lane/mode/runner/model/contextStrategy`. Never an identity. */
  candidateId: string;
  lane: ExecutionLane;
  /** LOCAL execution mode. Null outside the LOCAL lane. */
  executionMode: LocalExecutionMode | null;
  /** Runner identity (e.g. "local-llamacpp", "deepseek-harness"). */
  runner: string | null;
  /** Model identity when known; null when the provider does not say. */
  model: string | null;
  /** Operator profile name (API lane) when one applies. */
  profile: string | null;
  /** vNext.7 context strategy this candidate would run under. */
  contextStrategy: ContextStrategy;
  /** Verified compute locality of the runner behind this candidate. */
  computeLocality: ComputeLocality;
  /**
   * True when this candidate is what the existing deterministic scheduler
   * would run. The incumbent for hysteresis, and the thing SHADOW mode
   * executes regardless of what ranking prefers.
   */
  heuristicChoice: boolean;
  /** Fixed startup/handoff overhead, in milliseconds, when known. */
  handoffOverheadMs: number;
  /**
   * The vNext.6 strategy key this candidate would execute under. Used to
   * check the reliability veto: a strategy already tried and failed on this
   * task is not resurrected because its cross-task average looks good.
   */
  strategyKey: string;
}

/** A candidate hard policy refused, kept for diagnostics only. */
export interface RejectedCandidate {
  candidateId: string;
  lane: ExecutionLane;
  executionMode: LocalExecutionMode | null;
  runner: string | null;
  code: AdaptiveVetoCode;
  detail: string;
}

export interface CandidateSet {
  /** Candidates that may be ranked and executed. */
  eligible: ExecutionCandidate[];
  /** Candidates that exist but may never execute. Informational. */
  rejected: RejectedCandidate[];
}

/**
 * Deterministic map key over the orthogonal dimensions.
 *
 * Order is fixed and documented so profile keys built today still match
 * profile keys built after a rebuild. Unknown dimensions render as `-`
 * rather than being omitted, so two candidates differing only in a known
 * versus unknown model can never collide.
 */
export function candidateKey(candidate: {
  lane: string;
  executionMode: string | null;
  runner: string | null;
  model: string | null;
  contextStrategy: string;
}): string {
  return [
    candidate.lane,
    candidate.executionMode ?? '-',
    candidate.runner ?? '-',
    candidate.model ?? '-',
    candidate.contextStrategy,
  ].join('/');
}

/**
 * The coarser target key used at fallback level TARGET_CATEGORY: lane and
 * execution mode only.
 *
 * Runner, model, and context strategy are dropped deliberately. This is the
 * level at which "does the harness beat direct inference for this kind of
 * task?" must stay answerable, and that question does not change because an
 * operator renamed a worker profile or upgraded a model point release. The
 * exact level above still carries the full identity for when it matches;
 * this one exists precisely for when it does not.
 */
export function targetKey(candidate: { lane: string; executionMode: string | null }): string {
  return [candidate.lane, candidate.executionMode ?? '-'].join('/');
}

export interface GenerateCandidatesInput {
  /** The hard policy layer's decision for this node. Authoritative. */
  routing: NodeLaneRouting;
  /** The context strategy in force (vNext.7). Recorded, not chosen here. */
  contextStrategy: ContextStrategy;
  /** vNext.4 LOCAL harness binding, including verified locality. */
  harnessBinding: LocalHarnessBinding;
  /** Whether the direct structured-inference path is usable at all. */
  localDirectAvailable: boolean;
  /** Model identity the direct local path would use, when configured. */
  localDirectModel: string | null;
  /** Runner identity the direct local path would use. */
  localDirectRunner: string | null;
  /** vNext.5 API binding, including verified REMOTE locality. */
  apiBinding: ApiHarnessBinding;
  /** Provider identity for the subscription lane, when one is configured. */
  subscriptionProvider: string | null;
  /** vNext.6 strategy keys already tried and failed on this task. */
  exhaustedStrategies: readonly string[];
  /** The task's current plan revision (part of the strategy key). */
  planRevision: number;
}

function makeCandidate(input: {
  lane: ExecutionLane;
  executionMode: LocalExecutionMode | null;
  runner: string | null;
  model: string | null;
  profile: string | null;
  contextStrategy: ContextStrategy;
  computeLocality: ComputeLocality;
  heuristicChoice: boolean;
  handoffOverheadMs: number;
  planRevision: number;
}): ExecutionCandidate {
  return {
    candidateId: candidateKey(input),
    lane: input.lane,
    executionMode: input.executionMode,
    runner: input.runner,
    model: input.model,
    profile: input.profile,
    contextStrategy: input.contextStrategy,
    computeLocality: input.computeLocality,
    heuristicChoice: input.heuristicChoice,
    handoffOverheadMs: input.handoffOverheadMs,
    strategyKey: strategyKey({
      lane: input.lane,
      executionMode: input.executionMode,
      planRevision: input.planRevision,
      freshContext: false,
    }),
  };
}

/**
 * Fixed overhead of starting one attempt in a given execution shape.
 *
 * A harness pays for process startup, tool discovery, and repository
 * orientation before it writes anything; a single structured request does
 * not. Coarse constants rather than measurements on purpose — this is a
 * tie-breaker term, and inventing precision for it would misrepresent how
 * well it is known.
 */
function handoffOverheadMs(lane: ExecutionLane, mode: LocalExecutionMode | null): number {
  if (lane === 'LOCAL') return mode === 'HARNESS' ? 30_000 : 2_000;
  if (lane === 'API') return 30_000;
  return 10_000;
}

/**
 * Enumerate the execution candidates for one already-routed node.
 *
 * Reads the lane hard policy chose and enumerates only ways to spend THAT
 * lane. Consequences worth stating explicitly, because they are the phase's
 * economic invariants and they hold here by construction rather than by
 * convention:
 *
 *   - DEFER and REQUIRE_APPROVAL produce NO eligible candidates. A task
 *     waiting for quota, for a spend authorization, or for a gap that is too
 *     short to bridge stays waiting; there is nothing to rank.
 *   - a LOCAL routing never yields a SUBSCRIPTION or API candidate, so
 *     history can never move mechanical local-capable work onto prepaid
 *     quota, and HARVEST can never be talked into wasting Max on it.
 *   - a SUBSCRIPTION routing never yields an API candidate, so "API succeeds
 *     4% more often" cannot outrank prepaid capacity that is already there.
 *   - an API candidate exists only when the gap-bridge planner ALREADY
 *     selected the API lane, which means spend mode, budget, approval,
 *     pricing, and gap duration all passed first.
 *   - a harness whose compute is not VERIFIED local is rejected, not ranked,
 *     however good its history looks.
 */
export function generateCandidates(input: GenerateCandidatesInput): CandidateSet {
  const eligible: ExecutionCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const lane = input.routing.routing.lane;
  const strategy = input.contextStrategy;

  if (lane === 'DEFER' || lane === 'REQUIRE_APPROVAL') {
    rejected.push({
      candidateId: `${lane}/-/-/-/${strategy}`,
      lane: 'LOCAL',
      executionMode: null,
      runner: null,
      code: 'LANE_NOT_ELIGIBLE',
      detail:
        `Hard policy produced ${lane} (${input.routing.routing.reasonCode}); no lane is eligible, ` +
        'so there is nothing for adaptive ranking to choose between.',
    });
    return { eligible, rejected };
  }

  if (lane === 'LOCAL') {
    const chosenMode = input.routing.localExecution?.mode ?? null;
    // DIRECT_MODEL: available whenever the structured-inference path is.
    if (input.localDirectAvailable) {
      eligible.push(
        makeCandidate({
          lane: 'LOCAL',
          executionMode: 'DIRECT_MODEL',
          runner: input.localDirectRunner,
          model: input.localDirectModel,
          profile: null,
          contextStrategy: strategy,
          computeLocality: 'LOCAL',
          heuristicChoice: chosenMode === 'DIRECT_MODEL',
          handoffOverheadMs: handoffOverheadMs('LOCAL', 'DIRECT_MODEL'),
          planRevision: input.planRevision,
        }),
      );
    } else {
      rejected.push({
        candidateId: candidateKey({
          lane: 'LOCAL',
          executionMode: 'DIRECT_MODEL',
          runner: input.localDirectRunner,
          model: input.localDirectModel,
          contextStrategy: strategy,
        }),
        lane: 'LOCAL',
        executionMode: 'DIRECT_MODEL',
        runner: input.localDirectRunner,
        code: 'RUNNER_UNAVAILABLE',
        detail: 'Local structured inference is not configured or not usable.',
      });
    }

    // HARNESS: available only when BOUND and verified LOCAL. vNext.4 locality
    // is authoritative here — a REMOTE or UNKNOWN profile with excellent
    // history is still not a LOCAL candidate, because "local" is a claim
    // about where compute happens, not about how well it performs.
    const binding = input.harnessBinding;
    const harnessId = candidateKey({
      lane: 'LOCAL',
      executionMode: 'HARNESS',
      runner: binding.runner,
      model: binding.model,
      contextStrategy: strategy,
    });
    if (!binding.available) {
      rejected.push({
        candidateId: harnessId,
        lane: 'LOCAL',
        executionMode: 'HARNESS',
        runner: binding.runner,
        code: 'RUNNER_UNAVAILABLE',
        detail: `Local harness binding is ${binding.status}: ${binding.problems.join('; ') || 'unavailable'}.`,
      });
    } else if (binding.locality !== 'LOCAL') {
      rejected.push({
        candidateId: harnessId,
        lane: 'LOCAL',
        executionMode: 'HARNESS',
        runner: binding.runner,
        code: 'REMOTE_NOT_LOCAL',
        detail:
          `Harness compute locality is ${binding.locality}, not verified LOCAL. ` +
          'Historical performance cannot make remote compute local.',
      });
    } else {
      eligible.push(
        makeCandidate({
          lane: 'LOCAL',
          executionMode: 'HARNESS',
          runner: binding.runner,
          model: binding.model,
          profile: binding.profileName,
          contextStrategy: strategy,
          computeLocality: binding.locality,
          heuristicChoice: chosenMode === 'HARNESS',
          handoffOverheadMs: handoffOverheadMs('LOCAL', 'HARNESS'),
          planRevision: input.planRevision,
        }),
      );
    }
  }

  if (lane === 'SUBSCRIPTION') {
    // One subscription-backed runner, because one subscription quota pool is
    // what SpecBridge actually measures. Inventing a second pool's telemetry
    // in order to have something to rank would be a fabricated observation,
    // and unknown capacity stays unknown.
    eligible.push(
      makeCandidate({
        lane: 'SUBSCRIPTION',
        executionMode: null,
        runner: input.subscriptionProvider,
        model: null,
        profile: null,
        contextStrategy: strategy,
        computeLocality: 'UNKNOWN',
        heuristicChoice: true,
        handoffOverheadMs: handoffOverheadMs('SUBSCRIPTION', null),
        planRevision: input.planRevision,
      }),
    );
  }

  if (lane === 'API') {
    // Reached only after the gap-bridge planner already answered every
    // spending question. This phase supports one authorized profile
    // correctly rather than turning into a provider marketplace.
    const binding = input.apiBinding;
    eligible.push(
      makeCandidate({
        lane: 'API',
        executionMode: 'HARNESS',
        runner: binding.runner,
        model: binding.model,
        profile: binding.profileName,
        contextStrategy: strategy,
        computeLocality: binding.locality,
        heuristicChoice: true,
        handoffOverheadMs: handoffOverheadMs('API', 'HARNESS'),
        planRevision: input.planRevision,
      }),
    );
  }

  // vNext.6 veto: a strategy already tried and failed on this task is
  // removed, not ranked. The adaptive layer does not get to re-run an
  // experiment the reliability runtime has already recorded as spent —
  // its cross-task average is irrelevant to what this task has proved.
  const surviving: ExecutionCandidate[] = [];
  for (const candidate of eligible) {
    if (input.exhaustedStrategies.includes(candidate.strategyKey)) {
      rejected.push({
        candidateId: candidate.candidateId,
        lane: candidate.lane,
        executionMode: candidate.executionMode,
        runner: candidate.runner,
        code: 'RELIABILITY_STRATEGY_FORBIDDEN',
        detail:
          'This strategy is recorded as already tried and failed on this task; ' +
          'reliability governs repetition, not historical averages.',
      });
      continue;
    }
    surviving.push(candidate);
  }

  return { eligible: surviving, rejected };
}
