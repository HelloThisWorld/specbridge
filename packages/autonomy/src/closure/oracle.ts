import type { ClosurePolicy } from '@specbridge/core';
import type { ClosureDirective, ClosureGapKind, ClosurePhase, ClosureStatus } from '../vocabulary.js';
import { isClosingEvidence, isClosingStatus } from '../vocabulary.js';
import type { ClosureEntry, ClosureEvidenceRef, ClosureLedger } from './state.js';

/**
 * The Contract Closure Oracle.
 *
 * Pure. No I/O, no clock beyond the `now` it is handed, no configuration
 * reading. It answers two questions:
 *
 *   What is the closure status of this contract item?
 *   Given the whole ledger, what should the runtime do next?
 *
 * Both answers are computed from evidence, never taken from an assertion.
 * There is no input to this module through which an agent can declare
 * something closed — that is the entire design, and everything below is a
 * consequence of it.
 */

export interface ClosureContext {
  now: Date;
  /** The repository state closure is being judged against. */
  gitHead?: string | undefined;
  /** Evidence older than this many ms is stale even at the same head. */
  maxEvidenceAgeMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Per-item closure
// ---------------------------------------------------------------------------

export interface ItemClosure {
  status: ClosureStatus;
  gaps: ClosureGapKind[];
}

/**
 * Decide one item's closure status.
 *
 * The ladder, in order, and every rung is a refusal to accept a weaker
 * signal than the one above it:
 *
 *   A human waiver closes it. Only a human can create one.
 *   Nothing attributed and no evidence: NOT_STARTED.
 *   Attributed to work still in flight: IN_PROGRESS.
 *   Attributed, complete, but no PASSING evidence of a closing kind:
 *     IMPLEMENTED. Something claims to do this and nothing has shown it.
 *   A required scenario kind missing: still IMPLEMENTED, with the specific
 *     gap named. This is the rule that stops a UI acceptance criterion being
 *     closed by a unit test that never opened a browser.
 *   Otherwise VERIFIED.
 *
 * `AGENT_ASSERTION` evidence is deliberately never closing (see
 * `CLOSING_EVIDENCE_KINDS`). It can be recorded — an audit may legitimately
 * want to show that an agent claimed something — and it closes nothing.
 */
export function assessItemClosure(
  entry: ClosureEntry,
  context: ClosureContext,
  input: { attributedNodesComplete: boolean },
): ItemClosure {
  if (entry.waiver !== undefined) return { status: 'WAIVED', gaps: [] };
  if (entry.status === 'NOT_APPLICABLE') return { status: 'NOT_APPLICABLE', gaps: [] };

  const fresh = entry.evidence.filter((ref) => !isStale(ref, context));
  const staleClosing = entry.evidence.filter(
    (ref) => isClosingEvidence(ref.kind) && ref.passed && isStale(ref, context),
  );
  const passing = fresh.filter((ref) => isClosingEvidence(ref.kind) && ref.passed);
  const failing = fresh.filter((ref) => isClosingEvidence(ref.kind) && !ref.passed);

  const gaps: ClosureGapKind[] = [];

  if (entry.attributedNodeIds.length === 0 && entry.evidence.length === 0) {
    return { status: 'NOT_STARTED', gaps: ['NO_IMPLEMENTATION'] };
  }
  if (entry.attributedNodeIds.length > 0 && !input.attributedNodesComplete) {
    return { status: 'IN_PROGRESS', gaps: [] };
  }

  if (failing.length > 0) gaps.push('EVIDENCE_FAILED');
  if (passing.length === 0) {
    if (staleClosing.length > 0) gaps.push('EVIDENCE_STALE');
    else if (failing.length === 0) gaps.push('NO_EVIDENCE');
    // Evidence exists only as an agent assertion: recorded, and not enough.
    if (entry.evidence.some((ref) => ref.kind === 'AGENT_ASSERTION') && failing.length === 0) {
      if (!gaps.includes('EVIDENCE_UNTRUSTED')) gaps.push('EVIDENCE_UNTRUSTED');
    }
    return { status: 'IMPLEMENTED', gaps };
  }

  if (entry.requiresSystemScenario && !passing.some((ref) => ref.kind === 'SYSTEM_SCENARIO')) {
    gaps.push('SCENARIO_MISSING');
  }
  if (entry.requiresBrowserScenario && !passing.some((ref) => ref.kind === 'BROWSER_SCENARIO')) {
    gaps.push('SCENARIO_MISSING');
  }
  if (gaps.length > 0) return { status: 'IMPLEMENTED', gaps };

  return { status: 'VERIFIED', gaps: [] };
}

function isStale(ref: ClosureEvidenceRef, context: ClosureContext): boolean {
  if (context.gitHead !== undefined && ref.gitHead !== undefined && ref.gitHead !== context.gitHead) {
    return true;
  }
  if (context.maxEvidenceAgeMs !== undefined) {
    const at = Date.parse(ref.recordedAt);
    if (Number.isFinite(at) && context.now.getTime() - at > context.maxEvidenceAgeMs) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ledger-level verdict
// ---------------------------------------------------------------------------

export interface ClosureTotals {
  total: number;
  verified: number;
  implemented: number;
  inProgress: number;
  notStarted: number;
  waived: number;
  notApplicable: number;
}

export function summarizeClosure(entries: readonly ClosureEntry[]): ClosureTotals {
  const totals: ClosureTotals = {
    total: entries.length,
    verified: 0,
    implemented: 0,
    inProgress: 0,
    notStarted: 0,
    waived: 0,
    notApplicable: 0,
  };
  for (const entry of entries) {
    switch (entry.status) {
      case 'VERIFIED':
        totals.verified += 1;
        break;
      case 'IMPLEMENTED':
        totals.implemented += 1;
        break;
      case 'IN_PROGRESS':
        totals.inProgress += 1;
        break;
      case 'NOT_STARTED':
        totals.notStarted += 1;
        break;
      case 'WAIVED':
        totals.waived += 1;
        break;
      case 'NOT_APPLICABLE':
        totals.notApplicable += 1;
        break;
      default:
        break;
    }
  }
  return totals;
}

/**
 * Closed items over total, or `null` for an empty ledger.
 *
 * `null` rather than 1.0 is deliberate. A seal that promised nothing has a
 * closure ratio that means nothing, and printing "100%" for it would be the
 * most misleading number in the whole report.
 */
export function closureRatio(totals: ClosureTotals): number | null {
  if (totals.total === 0) return null;
  return (totals.verified + totals.waived + totals.notApplicable) / totals.total;
}

export interface OracleVerdict {
  directive: ClosureDirective;
  nextPhase: ClosurePhase;
  rationale: string;
  /** Items that must close before COMPLETE is available. */
  unclosed: readonly ClosureEntry[];
}

/**
 * Decide what the runtime does next.
 *
 * The phase order encodes the lifecycle from the specification, and each
 * transition is gated on evidence rather than on a step counter:
 *
 *   IMPLEMENTATION -> audit -> gap work -> audit again -> system scenarios
 *   -> release qualification -> reproducibility -> final audit -> COMPLETE
 *
 * The interesting branch is the loop: an audit that finds unclosed items
 * generates work and returns to implementation, however many tasks were
 * already checked off. That loop is bounded by policy — an unattended run
 * that cannot close a requirement must eventually say so rather than
 * regenerating the same task until morning — and exhausting the bound
 * produces BUDGET_EXHAUSTED, which is an honest failure and not a
 * completion.
 */
export function decideClosure(
  ledger: ClosureLedger,
  policy: ClosurePolicy,
  input: { implementationComplete: boolean },
): OracleVerdict {
  const unclosed = ledger.entries.filter((entry) => !isClosingStatus(entry.status));

  if (!input.implementationComplete && ledger.phase === 'IMPLEMENTATION') {
    return {
      directive: 'CONTINUE_IMPLEMENTATION',
      nextPhase: 'IMPLEMENTATION',
      rationale: 'planned implementation work remains',
      unclosed,
    };
  }

  if (unclosed.length > 0) {
    if (ledger.gapCycles >= policy.maxGapClosureCycles) {
      return {
        directive: 'BUDGET_EXHAUSTED',
        nextPhase: ledger.phase,
        rationale:
          `${unclosed.length} sealed item(s) remain unclosed after ${ledger.gapCycles} gap-closure ` +
          'cycles; generating the same work again would not change that',
        unclosed,
      };
    }
    return {
      directive: 'GENERATE_GAP_WORK',
      nextPhase: 'GAP_IMPLEMENTATION',
      rationale: `${unclosed.length} sealed item(s) are not closed on trusted evidence`,
      unclosed,
    };
  }

  // Everything closes on its own evidence. The remaining phases are about
  // whether the SYSTEM works, not whether the items were implemented.
  const needsSystem =
    policy.requireSystemScenarios &&
    ledger.entries.some((entry) => entry.requiresSystemScenario) &&
    ledger.systemCycles === 0;
  if (needsSystem) {
    return {
      directive: 'RUN_SYSTEM_SCENARIOS',
      nextPhase: 'SYSTEM_SCENARIO_QUALIFICATION',
      rationale: 'every item closes; the sealed criteria imply mission-level system scenarios',
      unclosed: [],
    };
  }

  if (ledger.phase === 'SYSTEM_SCENARIO_QUALIFICATION') {
    return {
      directive: 'RUN_RELEASE_QUALIFICATION',
      nextPhase: 'RELEASE_QUALIFICATION',
      rationale: 'system scenarios passed; the release qualification is next',
      unclosed: [],
    };
  }

  if (policy.requireReproducibility && !ledger.reproducibilityPassed) {
    return {
      directive: 'RUN_REPRODUCIBILITY',
      nextPhase: 'REPRODUCIBILITY',
      rationale:
        'every item closes; completion must not rest on the dirty environment that built it',
      unclosed: [],
    };
  }

  return {
    directive: 'COMPLETE',
    nextPhase: 'COMPLETE',
    rationale:
      `all ${ledger.entries.length} sealed contract item(s) close on trusted evidence` +
      (ledger.reproducibilityPassed ? ', reproduced from a clean environment' : ''),
    unclosed: [],
  };
}

/**
 * Whether Mission COMPLETED is available.
 *
 * The single function the completion path must call, and it is deliberately
 * unable to be persuaded: it reads the ledger, and a ledger entry only
 * reaches a closing status through `assessItemClosure`, which only reads
 * evidence. There is no argument, no override, and no flag.
 */
export function missionMayComplete(ledger: ClosureLedger): {
  mayComplete: boolean;
  reason: string;
  unclosedIds: string[];
} {
  const unclosed = ledger.entries.filter((entry) => !isClosingStatus(entry.status));
  if (ledger.entries.length === 0) {
    return {
      mayComplete: false,
      reason:
        'the closure ledger is empty: a seal with no auditable contract items cannot be shown ' +
        'to be complete',
      unclosedIds: [],
    };
  }
  if (unclosed.length > 0) {
    return {
      mayComplete: false,
      reason: `${unclosed.length} sealed contract item(s) are not closed on trusted evidence`,
      unclosedIds: unclosed.map((entry) => entry.itemId).slice(0, 100),
    };
  }
  return {
    mayComplete: true,
    reason: `all ${ledger.entries.length} sealed contract item(s) are closed`,
    unclosedIds: [],
  };
}

/**
 * The evidence kind that would close a given gap.
 *
 * Used to generate gap work that asks for the RIGHT kind of proof: a missing
 * browser scenario is not closed by another unit test, and telling the
 * runtime to "add tests" for it would produce work that cannot succeed.
 */
export function closingEvidenceForGap(
  entry: ClosureEntry,
  gap: ClosureGapKind,
): ClosureEvidenceRef['kind'] {
  if (gap === 'SCENARIO_MISSING' || gap === 'SCENARIO_FAILED') {
    return entry.requiresBrowserScenario ? 'BROWSER_SCENARIO' : 'SYSTEM_SCENARIO';
  }
  if (gap === 'REPRODUCIBILITY_FAILED') return 'REPRODUCIBILITY_RUN';
  if (entry.kind === 'acceptance-criterion') return 'ACCEPTANCE_CRITERION_CHECK';
  return 'TRUSTED_VERIFICATION';
}
