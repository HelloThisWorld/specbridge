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

// ---------------------------------------------------------------------------
// Delegated authority hook (vNext.10)
// ---------------------------------------------------------------------------

/**
 * The seam through which an OVERNIGHT run replaces "ask a human" with
 * "decide, or decide harder".
 *
 * The v1.2 table above is the right default for an interactive session: a
 * person is present, and a plan that mentions restructuring deserves a
 * glance. It is the wrong default at 03:00, when the same glance costs eight
 * hours. Rather than making the table conditional (which would put the
 * authority policy in two places), the driver consults an optional resolver
 * that @specbridge/autonomy supplies from the sealed intent.
 *
 * The dependency points the right way: orchestration defines the CONTRACT,
 * autonomy implements it. Nothing here imports the autonomy package, and a
 * workspace with no seal has no resolver and behaves exactly as it did in
 * v1.2 — which is also what makes this safe to add to an existing runtime.
 *
 * A resolver can only ever move a decision TOWARDS autonomy. It is consulted
 * at points where the driver was already about to stop, so a resolver that
 * throws, returns nothing, or is absent leaves the historical human gate in
 * place. There is deliberately no path by which a resolver can introduce a
 * gate that the v1.2 rules did not already have.
 */
export interface DelegatedAuthorityContext {
  jobId: string;
  nodeId?: string | undefined;
  /** Decision kinds the deterministic screens produced. */
  decisionKinds: readonly JobDecisionKind[];
  /** Human-readable reasons from those screens. */
  reasons: readonly string[];
  /** Bounded proposal text the screens ran against. */
  proposal?: string | undefined;
}

export type DelegatedAuthorityVerdict =
  | { kind: 'AUTONOMOUS'; reason: string }
  | { kind: 'ESCALATE_INTELLIGENCE'; reason: string }
  | {
      kind: 'NEEDS_AUTHORITY';
      surface: string;
      reason: string;
      question: string;
      whyItMatters: string;
      options?: readonly string[] | undefined;
    };

export interface DelegatedAuthorityResolver {
  resolve(context: DelegatedAuthorityContext): DelegatedAuthorityVerdict;
}

/**
 * Consult a resolver, failing closed to the historical behaviour.
 *
 * A resolver that throws is a bug in the autonomy layer, and the correct
 * response to a bug in the thing that grants autonomy is to grant none: the
 * job asks the human exactly as it would have without any resolver at all.
 */
export function resolveDelegatedAuthority(
  resolver: DelegatedAuthorityResolver | undefined,
  context: DelegatedAuthorityContext,
): DelegatedAuthorityVerdict | undefined {
  if (resolver === undefined) return undefined;
  try {
    return resolver.resolve(context);
  } catch {
    return undefined;
  }
}

/**
 * Whether a plan still needs a HUMAN review under delegated authority.
 *
 * Found by the vNext.10 StepRelay dogfood, which is exactly what a dogfood is
 * for. The v1.2 rule is `planReview === 'high-risk' && complexity === 'HIGH'`,
 * and that is a COMPLEXITY gate: the run stopped at
 * `AWAIT_HUMAN: Plan revision 1 ... requires an explicit human review` after
 * successfully classifying and planning the task. Under `humanGate:
 * AUTHORITY_ONLY` that is precisely the 03:00 question vNext.10 exists to
 * remove — a hard plan deserves a stronger reasoner and a critic, not a
 * sleeping person.
 *
 * The plan TEXT is passed through, so the promise-vocabulary screen still
 * runs on it: a plan that proposes changing a public API or a wire format
 * still reaches a human. What no longer reaches one is a plan that is merely
 * large.
 *
 * Fails closed in every ambiguous case. With no resolver (every unsealed
 * workspace) the v1.2 answer is returned unchanged.
 */
export function resolvePlanReviewRequirement(
  resolver: DelegatedAuthorityResolver | undefined,
  input: {
    jobId: string;
    nodeId: string;
    /** What the v1.2 policy concluded. Only ever relaxed, never tightened. */
    policyRequiresReview: boolean;
    /** Why the policy concluded it, for the recorded reason. */
    policyReason: string;
    /** The plan being reviewed, bounded. Screened for promise vocabulary. */
    planText: string;
  },
): { humanReviewRequired: boolean; relaxedBecause?: string } {
  if (!input.policyRequiresReview) return { humanReviewRequired: false };
  const verdict = resolveDelegatedAuthority(resolver, {
    jobId: input.jobId,
    nodeId: input.nodeId,
    decisionKinds: [],
    reasons: [input.policyReason],
    proposal: input.planText.slice(0, 4_000),
  });
  if (verdict?.kind === 'AUTONOMOUS') {
    return { humanReviewRequired: false, relaxedBecause: verdict.reason };
  }
  return { humanReviewRequired: true };
}
