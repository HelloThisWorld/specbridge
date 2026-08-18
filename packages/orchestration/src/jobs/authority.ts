import { OrchestrationError } from '../errors.js';
import type { DecisionAuthority, JobDecisionKind } from './vocabulary.js';

/**
 * The decision-authority policy: who may make which kind of decision during
 * autonomous execution.
 *
 * Represented as a frozen table consulted by code — never encoded only in a
 * prompt, where a model could argue with it. The scheduler and driver call
 * `assertAutonomousDecisionAllowed` before acting on any agent proposal
 * whose decision kind is not plainly automatic.
 *
 * `approval` is `human-only` and is additionally hard-enforced elsewhere:
 * stage approval APIs simply do not exist on any agent-reachable surface.
 * The row is here so the policy is complete and printable, not because the
 * table is the only thing standing in the way.
 */
export const DECISION_AUTHORITY_TABLE: Readonly<Record<JobDecisionKind, DecisionAuthority>> =
  Object.freeze({
    'compile-repair': 'auto',
    'unit-test-repair': 'auto',
    'implementation-detail': 'auto',
    'internal-refactor': 'auto',
    'runtime-replan': 'auto',
    'plan-strategy-disagreement': 'escalate',
    'new-dependency': 'policy',
    'public-api-change': 'human',
    'architecture-contract-change': 'human',
    'product-behavior-change': 'human',
    'spec-conflict': 'human',
    approval: 'human-only',
  });

export function authorityFor(kind: JobDecisionKind): DecisionAuthority {
  return DECISION_AUTHORITY_TABLE[kind];
}

/** Decision kinds a fully autonomous cycle may act on without any gate. */
export function isAutonomous(kind: JobDecisionKind): boolean {
  return DECISION_AUTHORITY_TABLE[kind] === 'auto';
}

/** Decision kinds that always require a human, whatever the configuration. */
export function requiresHuman(kind: JobDecisionKind): boolean {
  const authority = DECISION_AUTHORITY_TABLE[kind];
  return authority === 'human' || authority === 'human-only';
}

/**
 * Deterministic screen for replans that would touch approved intent.
 *
 * A replanner's own `impactsApprovedIntent` flag is a proposal; this screen
 * is the structural second line: keyword classes that indicate approved-
 * intent surface area (public API, architecture, security, dependencies,
 * product behavior) appearing in the REPLACEMENT plan but not in the plan it
 * replaces force a human decision, whatever the model claimed. Only ever
 * errs towards asking.
 */
const INTENT_IMPACT_PATTERNS: readonly { kind: JobDecisionKind; pattern: RegExp }[] = [
  { kind: 'public-api-change', pattern: /\b(public api|api contract|breaking change|public interface)\b/i },
  { kind: 'architecture-contract-change', pattern: /\b(architecture|architectural|redesign|restructure)\b/i },
  { kind: 'new-dependency', pattern: /\b(new dependency|add(?:ing)? (?:a |the )?(?:dependency|library|package))\b/i },
  { kind: 'product-behavior-change', pattern: /\b(product behavior|user-facing behavior|delivery semantics|compatibility promise)\b/i },
];

export function screenReplanForApprovedIntentImpact(
  candidate: { goal: string; steps: { description: string }[] },
  previous: { goal: string; steps: { description: string }[] } | undefined,
): { impacts: boolean; decisionKinds: JobDecisionKind[]; reasons: string[] } {
  const candidateText = `${candidate.goal}\n${candidate.steps.map((step) => step.description).join('\n')}`;
  const previousText =
    previous !== undefined ? `${previous.goal}\n${previous.steps.map((step) => step.description).join('\n')}` : '';
  const decisionKinds: JobDecisionKind[] = [];
  const reasons: string[] = [];
  for (const entry of INTENT_IMPACT_PATTERNS) {
    const inCandidate = entry.pattern.exec(candidateText);
    if (inCandidate === null) continue;
    if (previousText.length > 0 && entry.pattern.test(previousText)) continue;
    decisionKinds.push(entry.kind);
    reasons.push(`the replacement plan introduces "${(inCandidate[0] ?? '').slice(0, 60)}" (${entry.kind})`);
  }
  return { impacts: decisionKinds.length > 0, decisionKinds, reasons };
}

export interface AuthorityCheckOptions {
  /** Resolution for `policy`-gated kinds (from configuration). */
  policyAllowsNewDependency?: boolean;
}

/**
 * Assert that an autonomous job may proceed with a decision of this kind.
 * Throws SBO033 when a human is required — the caller turns that into
 * NEEDS_CLARIFICATION or BLOCKED, never into a silent continuation.
 */
export function assertAutonomousDecisionAllowed(
  kind: JobDecisionKind,
  options: AuthorityCheckOptions = {},
): void {
  const authority = DECISION_AUTHORITY_TABLE[kind];
  if (authority === 'auto' || authority === 'escalate') return;
  if (authority === 'policy') {
    if (kind === 'new-dependency' && options.policyAllowsNewDependency === true) return;
    throw new OrchestrationError(
      'SBO033',
      `The decision "${kind}" is policy-gated and the current policy does not allow deciding it autonomously.`,
      {
        remediation: ['Record an explicit user decision, then continue the job.'],
        failureCategory: 'SAFETY_POLICY',
      },
    );
  }
  throw new OrchestrationError(
    'SBO033',
    `The decision "${kind}" requires an explicit human decision; autonomous execution stops here.`,
    {
      remediation: [
        'The job transitions to NEEDS_CLARIFICATION with the specific question recorded.',
        'Answer it (or change the spec and re-approve), then resume the job.',
      ],
      failureCategory: 'SAFETY_POLICY',
    },
  );
}
