import type { FaultInjectionRecord } from './state.js';
import type { FaultBoundary, FaultClass, FaultTriggerMode } from './vocabulary.js';

/**
 * The fault-injection plan model (vNext.9).
 *
 * Two things this module is, and one thing it deliberately is not.
 *
 * It IS a declarative description of a fault — id, boundary, trigger,
 * expected invariant, one-shot or repeated — so a qualification report can
 * say precisely what was injected and what was expected to survive it, and
 * so an injection is reproducible rather than a story about a test run.
 *
 * It IS a tiny arming mechanism (`FaultPlan`) that a HARNESS holds and asks
 * before it decides to break something at a seam it already controls: the
 * injected quota telemetry provider, the injected local inference, the
 * injected clock, the runner registry, a verification command, or durable
 * state on disk.
 *
 * It is NOT reachable from production execution. There is no configuration
 * key, no environment variable, no CLI flag, and no MCP tool that constructs
 * a `FaultPlan`, and nothing in the driver, scheduler, reliability, context,
 * or adaptive runtime imports this file. The only way a fault fires is for a
 * caller to build the plan in code and hand it to a seam it is already
 * injecting — which is to say, for a test to do what a test may already do.
 * That is the whole scoping argument, and it is structural rather than
 * conventional: a production process has no expression that reaches this
 * module's behaviour.
 */

export interface FaultSpec {
  /** Stable id, unique within a qualification run. */
  faultId: string;
  faultClass: FaultClass;
  boundary: FaultBoundary;
  /** Deterministic condition under which the harness should fire it. */
  trigger: string;
  /** The invariant expected to hold despite the fault. */
  expectedInvariant: string;
  triggerMode: FaultTriggerMode;
  /**
   * For ONE_SHOT faults: how many eligible occasions to let pass before
   * firing. Zero fires on the first. Deterministic by construction — there
   * is no probability anywhere in this module, because a fault that fires
   * randomly cannot be a regression test.
   */
  after?: number;
}

/**
 * An armed fault. `shouldFire()` is the entire runtime surface: it advances
 * a counter and answers yes or no. It cannot kill a process, delete a file,
 * or change a budget — the harness that owns the seam does that, which keeps
 * the destructive capability where it already existed.
 */
export class FaultPlan {
  private occasions = 0;
  private fired = 0;

  constructor(readonly spec: FaultSpec) {}

  get faultId(): string {
    return this.spec.faultId;
  }

  /** True when this occasion should carry the fault. */
  shouldFire(): boolean {
    this.occasions += 1;
    if (this.spec.triggerMode === 'REPEATED') {
      this.fired += 1;
      return true;
    }
    if (this.fired > 0) return false;
    if (this.occasions <= (this.spec.after ?? 0)) return false;
    this.fired += 1;
    return true;
  }

  /** How many times this fault actually fired. */
  get fireCount(): number {
    return this.fired;
  }

  /** True once a ONE_SHOT fault has been spent. */
  get spent(): boolean {
    return this.spec.triggerMode === 'ONE_SHOT' && this.fired > 0;
  }
}

/** A set of armed faults, addressed by id. */
export class FaultInjector {
  private readonly plans = new Map<string, FaultPlan>();

  constructor(specs: readonly FaultSpec[] = []) {
    for (const spec of specs) this.arm(spec);
  }

  arm(spec: FaultSpec): FaultPlan {
    const plan = new FaultPlan(spec);
    this.plans.set(spec.faultId, plan);
    return plan;
  }

  /**
   * Ask whether a named fault should fire now.
   *
   * An unknown id answers `false` rather than throwing: a harness that
   * checks for a fault it did not arm is running the un-faulted path, which
   * is exactly what should happen.
   */
  shouldFire(faultId: string): boolean {
    return this.plans.get(faultId)?.shouldFire() ?? false;
  }

  plan(faultId: string): FaultPlan | undefined {
    return this.plans.get(faultId);
  }

  get armed(): FaultPlan[] {
    return [...this.plans.values()];
  }

  /** Faults that were armed but never fired — an incomplete injection plan. */
  unfired(): FaultPlan[] {
    return this.armed.filter((plan) => plan.fireCount === 0);
  }
}

/** Build the durable record for an injected fault. */
export function toFaultRecord(input: {
  runId: string;
  spec: FaultSpec;
  injectedAt: string;
  scenarioId?: string | undefined;
  survived?: boolean | undefined;
  observed?: string | undefined;
  resolvedAt?: string | undefined;
}): FaultInjectionRecord {
  return {
    schemaVersion: '1.0.0',
    runId: input.runId,
    faultId: input.spec.faultId,
    faultClass: input.spec.faultClass,
    boundary: input.spec.boundary,
    triggerMode: input.spec.triggerMode,
    trigger: input.spec.trigger,
    expectedInvariant: input.spec.expectedInvariant,
    survived: input.survived ?? null,
    observed: input.observed ?? null,
    scenarioId: input.scenarioId ?? null,
    injectedAt: input.injectedAt,
    resolvedAt: input.resolvedAt ?? null,
  };
}
