import type {
  FaultClass,
  QualificationArea,
  QualificationProfile,
  QualificationResource,
  ScenarioExecutionKind,
  ScenarioRequirement,
} from './vocabulary.js';

/**
 * The qualification scenario matrix (vNext.9).
 *
 * This is the machine-readable contract of what a release must prove. It is
 * a DECLARATION, not a test list: each entry states the invariant, the fault
 * classes it injects, the resources it touches, and — critically — how it
 * can honestly be executed. The runner and the release gate both read this
 * table, so a scenario cannot be quietly dropped from the gate by deleting
 * its implementation: an unimplemented REQUIRED scenario stays `NOT_RUN` and
 * blocks the verdict.
 *
 * `executionKind` is what keeps the report honest across executors:
 *
 *   POLICY         pure production functions; runnable from the CLI on any
 *                  machine, with no workspace, no processes, no providers
 *   RUNTIME        the real job driver over a temporary workspace with
 *                  deterministic doubles; owned by the regression suite
 *   REAL_RESOURCE  needs a real provider, a real quota window, or real money
 *
 * The CLI runner executes POLICY scenarios. The regression qualification
 * suite executes RUNTIME scenarios and writes its results into the same
 * durable run. Both accumulate; neither can claim the other's coverage.
 *
 * Adding a scenario is additive. Removing one, or weakening a `requirement`,
 * is a public-contract change and a release-gate change, which is exactly
 * the kind of quiet relaxation §130 forbids.
 */

export interface QualificationScenario {
  /** Stable id. Appears in reports and in the durable result records. */
  id: string;
  area: QualificationArea;
  title: string;
  /** The single claim this scenario proves, stated as an invariant. */
  invariant: string;
  executionKind: ScenarioExecutionKind;
  requirement: ScenarioRequirement;
  /** Fault classes the scenario injects. Empty for pure policy assertions. */
  faultClasses: readonly FaultClass[];
  /** Resources the scenario touches, for attribution reporting. */
  resources: readonly QualificationResource[];
  /**
   * Lowest profile that can execute it. A scenario whose minimum is
   * `subscription` is honestly skipped in an `offline` run rather than
   * silently omitted from the matrix.
   */
  minimumProfile: QualificationProfile;
  /**
   * Where a RUNTIME or REAL_RESOURCE scenario is implemented, so a reader of
   * the report can go and look. Never used to satisfy the gate by itself.
   */
  implementedBy?: string;
}

const PROFILE_ORDER: readonly QualificationProfile[] = ['offline', 'local', 'subscription', 'full'];

/** True when `profile` is at least as capable as `minimum`. */
export function profileSatisfies(
  profile: QualificationProfile,
  minimum: QualificationProfile,
): boolean {
  return PROFILE_ORDER.indexOf(profile) >= PROFILE_ORDER.indexOf(minimum);
}

export const QUALIFICATION_SCENARIOS: readonly QualificationScenario[] = Object.freeze([
  // -------------------------------------------------------------------------
  // Survival
  // -------------------------------------------------------------------------
  {
    id: 'survival.process-restart',
    area: 'Survival',
    title: 'SpecBridge process restart',
    invariant:
      'A job interrupted between durable transitions reconciles on restart and continues without manual state reconstruction.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['PROCESS_CRASH'],
    resources: ['PROCESS_RESTART', 'LOCAL_DIRECT_MODEL', 'TRUSTED_VERIFICATION'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },
  {
    id: 'survival.worker-crash',
    area: 'Survival',
    title: 'Worker crash during an active attempt',
    invariant:
      'A worker that dies mid-attempt leaves the attempt INTERRUPTED, the checkpoint intact, and the job resumable.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['WORKER_CRASH'],
    resources: ['WORKER_CRASH', 'LOCAL_DIRECT_MODEL'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },
  {
    id: 'survival.session-loss',
    area: 'Survival',
    title: 'Provider session loss',
    invariant:
      'Discarding every provider session loses no canonical state: the next attempt is reconstructed from SpecBridge records alone.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['SESSION_LOSS'],
    resources: ['SESSION_LOSS'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },
  {
    id: 'survival.invariants-across-restart',
    area: 'Survival',
    title: 'State invariants hold before and after restart',
    invariant:
      'Durable state that satisfies the invariant set before a restart satisfies it after hydration.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['PROCESS_CRASH'],
    resources: ['PROCESS_RESTART'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },
  {
    id: 'survival.soak',
    area: 'Survival',
    title: 'Long-horizon soak with repeated restarts',
    invariant:
      'Many task/attempt cycles with periodic serialization and reconstruction accumulate no state corruption and no unbounded growth.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['PROCESS_CRASH', 'CONTEXT_SATURATION'],
    resources: ['PROCESS_RESTART', 'ADAPTIVE_PROFILES', 'REPOSITORY_CONTEXT_INDEX'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/soak.test.ts',
  },

  // -------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------
  {
    id: 'context.multi-window-compaction',
    area: 'Context',
    title: 'Multi-window context compaction',
    invariant:
      'Crossing several effective context windows compacts context and never terminates the job; pinned contract state survives every compaction.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['CONTEXT_SATURATION'],
    resources: ['CONTEXT_COMPACTION'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },
  {
    id: 'context.index-cache-rebuild',
    area: 'Context',
    title: 'Derived context cache loss',
    invariant:
      'Deleting or corrupting the repository context index rebuilds it and loses no canonical state.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['DERIVED_CONTEXT_CACHE_LOSS'],
    resources: ['REPOSITORY_CONTEXT_INDEX'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/derived-cache.test.ts',
  },
  {
    id: 'context.progressive-expansion',
    area: 'Context',
    title: 'Context miss expands progressively',
    invariant:
      'A failure attributed to missing context widens retrieval by one bounded level rather than escalating intelligence.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['CONTEXT_MISS'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'context.expansion-exhaustion',
    area: 'Context',
    title: 'Progressive expansion exhaustion',
    invariant:
      'When bounded widening is spent, the decision returns to planning or escalation — never to an unbounded repository dump.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['CONTEXT_EXPANSION_EXHAUSTION'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'context.role-specific-packets',
    area: 'Context',
    title: 'Role-specific context, not replayed conversation',
    invariant:
      'Each role receives a context package built for its job; no role receives another agent private session.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: [],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/handoffs.test.ts',
  },
  {
    id: 'context.handoff-durable-truth',
    area: 'Context',
    title: 'Cross-agent handoff carries durable truth',
    invariant:
      'A receiving worker can continue from checkpoints, contracts, and evaluations alone, without the previous worker session.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['SESSION_LOSS'],
    resources: ['SESSION_LOSS'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/handoffs.test.ts',
  },

  // -------------------------------------------------------------------------
  // Local
  // -------------------------------------------------------------------------
  {
    id: 'local.direct-success',
    area: 'Local',
    title: 'LOCAL DIRECT_MODEL verified success',
    invariant:
      'Mechanical, locally-suitable work completes on the local direct lane and is verified by the trusted evidence path.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: ['LOCAL_DIRECT_MODEL', 'TRUSTED_VERIFICATION'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },
  {
    id: 'local.harness-success',
    area: 'Local',
    title: 'LOCAL HARNESS verified success',
    invariant:
      'Agentic locally-solvable work completes through the verified-local harness and is verified by the trusted evidence path.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: ['LOCAL_HARNESS', 'TRUSTED_VERIFICATION'],
    minimumProfile: 'offline',
    implementedBy: 'tests/orchestration/local-harness-driver.test.ts',
  },
  {
    id: 'local.harness-infrastructure-failure',
    area: 'Local',
    title: 'Local harness infrastructure failure',
    invariant:
      'A crashed local harness is assessed as an infrastructure failure, not as an intelligence failure, and recovery stays bounded.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['LOCAL_HARNESS_INFRASTRUCTURE_FAILURE'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'local.intelligence-failure-escalates',
    area: 'Local',
    title: 'Local intelligence failure escalates after bounded recovery',
    invariant:
      'Verifiably wrong local work is recovered locally within bounds and then escalated to the subscription lane.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['LOCAL_INTELLIGENCE_FAILURE'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'local.remote-never-local',
    area: 'Local',
    title: 'Remote compute is never reported as LOCAL',
    invariant:
      'A runner whose compute locality is not verified local is rejected from the local lane regardless of its history.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['REMOTE_MISCLASSIFIED_AS_LOCAL'],
    resources: [],
    minimumProfile: 'offline',
  },

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------
  {
    id: 'quota.five-hour-exhaustion',
    area: 'Quota',
    title: 'Five-hour exhaustion keeps local work moving',
    invariant:
      'With the five-hour window spent, local work continues and strong work defers or bridges according to policy.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['FIVE_HOUR_EXHAUSTION'],
    resources: ['QUOTA_TELEMETRY', 'FIVE_HOUR_WINDOW'],
    minimumProfile: 'offline',
  },
  {
    id: 'quota.reset-readmits',
    area: 'Quota',
    title: 'Quota reset re-admits deferred strong work',
    invariant:
      'Advancing past the five-hour reset makes deferred strong work admissible again on the subscription lane.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['FIVE_HOUR_RESET'],
    resources: ['QUOTA_TELEMETRY', 'FIVE_HOUR_WINDOW'],
    minimumProfile: 'offline',
  },
  {
    id: 'quota.cross-reset-admission',
    area: 'Quota',
    title: 'Cross-reset admission uses pre-reset burn',
    invariant:
      'A task longer than the remaining window is admitted on safe expected pre-reset burn; nothing is killed at the boundary.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['CROSS_RESET_TASK'],
    resources: ['QUOTA_TELEMETRY', 'FIVE_HOUR_WINDOW'],
    minimumProfile: 'offline',
  },
  {
    id: 'quota.harvest',
    area: 'Quota',
    title: 'HARVEST consumes expiring prepaid capacity',
    invariant:
      'Meaningful unused five-hour capacity near a reset, with healthy weekly quota and valuable strong work ready, enters HARVEST.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['HARVEST_WINDOW'],
    resources: ['QUOTA_TELEMETRY', 'HARVEST', 'FIVE_HOUR_WINDOW'],
    minimumProfile: 'offline',
  },
  {
    id: 'quota.weekly-scarcity-suppresses-harvest',
    area: 'Quota',
    title: 'Weekly scarcity suppresses harvesting',
    invariant:
      'Scarce weekly quota overrides an otherwise attractive five-hour harvest.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['WEEKLY_SCARCITY'],
    resources: ['QUOTA_TELEMETRY', 'HARVEST', 'WEEKLY_WINDOW'],
    minimumProfile: 'offline',
  },
  {
    id: 'quota.weekly-exhaustion',
    area: 'Quota',
    title: 'Weekly exhaustion keeps local work moving',
    invariant:
      'A long subscription outage leaves local work running; only critical strong work may reach the API gap bridge.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['WEEKLY_EXHAUSTION'],
    resources: ['QUOTA_TELEMETRY', 'WEEKLY_WINDOW'],
    minimumProfile: 'offline',
  },
  {
    id: 'quota.real-window-observed',
    area: 'Quota',
    title: 'Real subscription quota window observed',
    invariant:
      'A real dogfood crossed an actual subscription quota window and the scheduler behaved as the simulated scenarios predicted.',
    executionKind: 'REAL_RESOURCE',
    requirement: 'REQUIRED_WHEN_EXERCISED',
    faultClasses: ['FIVE_HOUR_RESET'],
    resources: ['QUOTA_TELEMETRY', 'FIVE_HOUR_WINDOW', 'SUBSCRIPTION_RUNNER'],
    minimumProfile: 'subscription',
  },

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  {
    id: 'api.disabled-no-spend',
    area: 'API',
    title: 'API DISABLED spends nothing',
    invariant:
      'With spend mode DISABLED, a legitimate long subscription gap produces no API execution; the task waits.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['API_DISABLED'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'api.bounded-bridge',
    area: 'API',
    title: 'Bounded API gap bridge',
    invariant:
      'API execution occurs only when every vNext.5 condition passes: gap duration, spend mode, approval, budget, and pricing.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'api.budget-exhaustion',
    area: 'API',
    title: 'API budget exhaustion stops paid execution',
    invariant:
      'An exhausted budget admits no further automatic paid execution, and no path bypasses it.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['API_BUDGET_EXHAUSTION'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'api.interrupted-reservation',
    area: 'API',
    title: 'Interrupted paid attempt keeps conservative accounting',
    invariant:
      'A reservation whose final usage is unknown survives restart as UNKNOWN spend, never released as zero.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['INTERRUPTED_PAID_ATTEMPT'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'api.max-returns-mid-attempt',
    area: 'API',
    title: 'Subscription returning mid-attempt causes no ping-pong',
    invariant:
      'An active atomic API attempt completes; the NEXT strong task returns to the subscription lane.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['SUBSCRIPTION_RETURNS_MID_API'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'api.real-bridge-observed',
    area: 'API',
    title: 'Real authorized API bridge',
    invariant:
      'A real dogfood entered the API lane only under genuine gap conditions, within an authorized budget.',
    executionKind: 'REAL_RESOURCE',
    requirement: 'REQUIRED_WHEN_EXERCISED',
    faultClasses: [],
    resources: ['API_PROVIDER'],
    minimumProfile: 'full',
  },

  // -------------------------------------------------------------------------
  // Reliability
  // -------------------------------------------------------------------------
  {
    id: 'reliability.false-completion',
    area: 'Reliability',
    title: 'A completion claim is not a completion',
    invariant:
      'A worker that reports success while trusted verification fails leaves the task incomplete.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['FALSE_COMPLETION_CLAIM'],
    resources: ['TRUSTED_VERIFICATION'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },
  {
    id: 'reliability.stalled',
    area: 'Reliability',
    title: 'Repeated identical failure is STALLED, not retried',
    invariant:
      'The same failure fingerprint with an equivalent diff marks the task STALLED and forces a strategy change.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['REPEATED_IDENTICAL_FAILURE'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'reliability.oscillation',
    area: 'Reliability',
    title: 'Edit oscillation is detected',
    invariant:
      'An A to B to A edit cycle with unchanged failure is OSCILLATING and triggers recovery.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['EDIT_OSCILLATION'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'reliability.runaway',
    area: 'Reliability',
    title: 'Harness runaway is bounded',
    invariant:
      'A repeated identical tool/test/edit loop is RUNAWAY: cancel, checkpoint, recover.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['HARNESS_RUNAWAY'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'reliability.verification-infrastructure',
    area: 'Reliability',
    title: 'Broken verification is INCONCLUSIVE, not a failed implementation',
    invariant:
      'Unavailable required verification yields INCONCLUSIVE and never blames the implementation.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['VERIFICATION_INFRASTRUCTURE_FAILURE'],
    resources: ['TRUSTED_VERIFICATION'],
    minimumProfile: 'offline',
  },
  {
    id: 'reliability.contract-violation',
    area: 'Reliability',
    title: 'Passing tests do not satisfy acceptance criteria',
    invariant:
      'An implementation that compiles and passes tests but violates acceptance criteria leaves the task incomplete.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['CONTRACT_VIOLATION'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'reliability.replan-preserves-intent',
    area: 'Reliability',
    title: 'Replan changes strategy, not approved intent',
    invariant:
      'Repeated strategy failure produces a REPLAN while approved product intent stays unchanged.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['REPLAN_WITHOUT_INTENT_CHANGE'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'reliability.dependents-gated',
    area: 'Reliability',
    title: 'Dependent work waits for verified predecessors',
    invariant:
      'No dependent task becomes eligible until its required predecessor holds a durable PASS.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: ['TRUSTED_VERIFICATION'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },

  // -------------------------------------------------------------------------
  // Adaptive
  // -------------------------------------------------------------------------
  {
    id: 'adaptive.hard-policy-veto',
    area: 'Adaptive',
    title: 'Hard policy vetoes a favoured candidate',
    invariant:
      'History that strongly favours a policy-forbidden candidate does not make it allowed; the candidate is vetoed with a code.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['ADAPTIVE_POLICY_VETO'],
    resources: ['ADAPTIVE_PROFILES'],
    minimumProfile: 'offline',
  },
  {
    id: 'adaptive.low-confidence-fallback',
    area: 'Adaptive',
    title: 'Sparse history falls back to the heuristic',
    invariant:
      'Sparse or version-changed history produces a heuristic fallback rather than overconfident routing.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['ADAPTIVE_LOW_CONFIDENCE'],
    resources: ['ADAPTIVE_PROFILES'],
    minimumProfile: 'offline',
  },
  {
    id: 'adaptive.drift-detection',
    area: 'Adaptive',
    title: 'Materially degraded performance reduces confidence',
    invariant:
      'Observed degradation raises a drift signal and lowers effective confidence, with a safe fallback.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['ADAPTIVE_DRIFT'],
    resources: ['ADAPTIVE_PROFILES'],
    minimumProfile: 'offline',
  },
  {
    id: 'adaptive.cache-rebuild',
    area: 'Adaptive',
    title: 'Adaptive cache loss rebuilds from the ledger',
    invariant:
      'Deleting or corrupting adaptive profiles rebuilds them from the ExecutionLedger, or falls back to the heuristic; the job is unaffected.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['ADAPTIVE_CACHE_LOSS'],
    resources: ['ADAPTIVE_PROFILES'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/derived-cache.test.ts',
  },
  {
    id: 'adaptive.mode-rollback',
    area: 'Adaptive',
    title: 'Instant rollback from ADAPTIVE to HEURISTIC',
    invariant:
      'Switching the scheduler mode back to HEURISTIC continues the same job with no state migration and no job loss.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: ['ADAPTIVE_PROFILES'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/adaptive-rollout.test.ts',
  },
  {
    id: 'adaptive.shadow-diagnostics',
    area: 'Adaptive',
    title: 'SHADOW records recommendations without executing them',
    invariant:
      'In SHADOW mode, placement stays heuristic while adaptive recommendations, disagreements, and vetoes are recorded.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: ['ADAPTIVE_PROFILES'],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/adaptive-rollout.test.ts',
  },

  // -------------------------------------------------------------------------
  // Governance
  // -------------------------------------------------------------------------
  {
    id: 'governance.protected-state-mutation',
    area: 'Governance',
    title: 'Protected control state cannot be mutated by workers',
    invariant:
      'An attempt to edit SpecBridge control state, budget/quota policy, or approval state is refused or fails evidence.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: ['PROTECTED_STATE_MUTATION'],
    resources: [],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/governance.test.ts',
  },
  {
    id: 'governance.invalid-contract-change',
    area: 'Governance',
    title: 'Approved intent cannot be silently changed',
    invariant:
      'A replan or agent proposal that would alter an approved requirement requires human/contract authority.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: ['INVALID_CONTRACT_CHANGE'],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'governance.approval-is-human-only',
    area: 'Governance',
    title: 'Approval authority is human-only',
    invariant:
      'No configuration, policy, worker, or model can hold approval authority.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'governance.fault-injection-scoping',
    area: 'Governance',
    title: 'Fault injection is not a production attack surface',
    invariant:
      'Fault injection exists only as explicit dependency injection; no configuration, environment variable, or agent-reachable surface enables it.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'governance.preflight-fails-closed',
    area: 'Governance',
    title: 'Preflight fails closed on unsafe configuration',
    invariant:
      'An unsafe dogfood configuration — dirty unrelated tree, missing target, unbounded spend — refuses to start.',
    executionKind: 'POLICY',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: [],
    minimumProfile: 'offline',
  },
  {
    id: 'governance.single-writer-integration',
    area: 'Governance',
    title: 'Integration passes through the single-writer path',
    invariant:
      'Dogfood mode does not bypass trusted single-writer integration for convenience.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: [],
    resources: [],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/governance.test.ts',
  },

  // -------------------------------------------------------------------------
  // Mission (the release gate)
  // -------------------------------------------------------------------------
  {
    id: 'mission.offline-full-system',
    area: 'Mission',
    title: 'Mandatory offline full-system qualification',
    invariant:
      'One deterministic run exercises a Mission with multiple objectives across local, subscription, quota, context, reliability, and adaptive behaviour to verified completion.',
    executionKind: 'RUNTIME',
    requirement: 'REQUIRED',
    faultClasses: [
      'WORKER_CRASH',
      'PROCESS_CRASH',
      'SESSION_LOSS',
      'CONTEXT_SATURATION',
      'FALSE_COMPLETION_CLAIM',
    ],
    resources: [
      'LOCAL_DIRECT_MODEL',
      'SUBSCRIPTION_RUNNER',
      'QUOTA_TELEMETRY',
      'TRUSTED_VERIFICATION',
      'PROCESS_RESTART',
    ],
    minimumProfile: 'offline',
    implementedBy: 'tests/qualification/offline-qualification.test.ts',
  },
  {
    id: 'mission.real-target-increment',
    area: 'Mission',
    title: 'Real product Mission reaches verified completion',
    invariant:
      'A meaningful engineering increment of the real dogfood target is carried from high-level direction to verified implementation.',
    executionKind: 'REAL_RESOURCE',
    requirement: 'RELEASE_GATE',
    faultClasses: [],
    resources: ['TARGET_REPOSITORY', 'SUBSCRIPTION_RUNNER', 'TRUSTED_VERIFICATION'],
    minimumProfile: 'subscription',
  },
]);

/** The single release-gate scenario id. */
export const RELEASE_GATE_SCENARIO_ID = 'mission.real-target-increment';

const BY_ID = new Map(QUALIFICATION_SCENARIOS.map((scenario) => [scenario.id, scenario]));

export function findScenario(id: string): QualificationScenario | undefined {
  return BY_ID.get(id);
}

/** Scenarios a given profile is capable of executing at all. */
export function scenariosForProfile(
  profile: QualificationProfile,
): readonly QualificationScenario[] {
  return QUALIFICATION_SCENARIOS.filter((scenario) =>
    profileSatisfies(profile, scenario.minimumProfile),
  );
}

/** Scenarios of one execution kind, in matrix order. */
export function scenariosOfKind(kind: ScenarioExecutionKind): readonly QualificationScenario[] {
  return QUALIFICATION_SCENARIOS.filter((scenario) => scenario.executionKind === kind);
}

/** Every fault class some scenario in the matrix injects. */
export function coveredFaultClasses(): Set<FaultClass> {
  const covered = new Set<FaultClass>();
  for (const scenario of QUALIFICATION_SCENARIOS) {
    for (const faultClass of scenario.faultClasses) covered.add(faultClass);
  }
  return covered;
}

/**
 * Fault classes SpecBridge claims to survive that no scenario injects.
 *
 * Exposed rather than checked privately: an unclaimed fault class is a real
 * coverage gap, and the matrix test that asserts this list is empty is what
 * stands between "we survive these faults" and a list of aspirations.
 */
export function faultClassesWithoutScenario(
  allFaultClasses: readonly FaultClass[],
): FaultClass[] {
  const covered = coveredFaultClasses();
  return allFaultClasses.filter((faultClass) => !covered.has(faultClass));
}
