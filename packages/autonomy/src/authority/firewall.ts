import type { AutonomyPolicy, DelegationSetting } from '@specbridge/core';
import { isUnattendedMode } from '@specbridge/core';
import type { MissionSeal } from '../seal/state.js';
import { assessSealExecutability } from '../seal/service.js';
import type {
  AuthorityReason,
  AuthorityVerdict,
  AutonomousDecisionSurface,
  NonAuthoritySignal,
} from '../vocabulary.js';
import { NON_AUTHORITY_SIGNALS } from '../vocabulary.js';

/**
 * The Authority Firewall.
 *
 * One pure function over a frozen table, with no I/O, no clock, and no
 * configuration reading of its own. It answers exactly one question:
 *
 *   Does continuing require PRODUCT AUTHORITY the human did not delegate?
 *
 * and it is deliberately unable to answer any other. In particular it cannot
 * see how complex the work is, how large the diff would be, how many
 * attempts already failed, or how confident anybody feels, because none of
 * those are parameters. That is not an omission — a firewall that could see
 * difficulty would eventually be asked to weigh it, and the weighing is
 * exactly the behaviour vNext.10 exists to remove. Difficulty is answered
 * with `ESCALATE_INTELLIGENCE`: a stronger reasoner, not a sleeping human.
 *
 * The `signals` field exists so callers CAN pass those observations along
 * for the record. They are stored on the decision and they never change it;
 * `NON_AUTHORITY_SIGNALS` is enumerable precisely so a test can prove that.
 */

// ---------------------------------------------------------------------------
// The surface table
// ---------------------------------------------------------------------------

/**
 * Which policy switch, if any, governs a delegated engineering surface.
 *
 * A surface mapped to `undefined` is delegated unconditionally under an
 * unattended mode: recovery strategy, provider placement, and context
 * strategy are things the runtime has always decided, and adding a knob for
 * them would only create a way to configure a run into stopping.
 */
/**
 * The delegation switches this table may name.
 *
 * Spelled out rather than derived with `keyof`, because the policy schemas
 * are `passthrough()` and their `keyof` therefore includes an index
 * signature — which would make every typo in the table below compile.
 */
type DelegationKey =
  | 'implementation'
  | 'internalArchitecture'
  | 'dependencySelection'
  | 'toolingCreation'
  | 'testInfrastructure'
  | 'environmentProvisioning'
  | 'browserVerification'
  | 'workDecomposition'
  | 'provider'
  | 'process'
  | 'toolchain'
  | 'context'
  | 'environment'
  | 'controlPlane';

const DELEGATED_SURFACES: Readonly<
  Partial<Record<AutonomousDecisionSurface, DelegationKey | undefined>>
> = Object.freeze({
  'implementation-structure': 'implementation',
  'internal-architecture': 'internalArchitecture',
  'module-layout': 'implementation',
  'algorithm-choice': 'implementation',
  'internal-api-shape': 'implementation',
  'ui-framework': 'implementation',
  'styling-strategy': 'implementation',
  'state-management': 'implementation',
  'new-feature-rest-shape': 'implementation',
  'database-physical-layout': 'internalArchitecture',
  'dependency-choice': 'dependencySelection',
  'build-tooling': 'toolingCreation',
  'testing-tooling': 'testInfrastructure',
  'browser-tooling': 'browserVerification',
  'container-topology': 'environmentProvisioning',
  'broker-topology': 'environmentProvisioning',
  'local-script': 'toolingCreation',
  'test-harness': 'testInfrastructure',
  refactor: 'implementation',
  'debug-instrumentation': 'toolingCreation',
  'benchmark-infrastructure': 'testInfrastructure',
  'work-decomposition': 'workDecomposition',
  'implementation-plan': 'workDecomposition',
  'environment-provisioning': 'environmentProvisioning',
  'toolchain-provisioning': 'toolchain',
  'recovery-strategy': undefined,
  'provider-placement': undefined,
  'context-strategy': undefined,
});

/**
 * The authority surfaces, each with the structural reason it is one.
 *
 * There is no configuration path to any of these. `HARD_HUMAN_AUTHORITY_SURFACES`
 * in @specbridge/core names the same boundary from the configuration side;
 * this table is where it is enforced.
 */
const AUTHORITY_SURFACES: Readonly<Partial<Record<AutonomousDecisionSurface, AuthorityReason>>> =
  Object.freeze({
    'sealed-contract-change': 'MODIFIES_SEALED_CONTRACT',
    'product-semantics-change': 'CHANGES_PRODUCT_SEMANTICS',
    'wire-protocol-change': 'CHANGES_WIRE_CONTRACT',
    'persistence-compatibility-change': 'CHANGES_PERSISTENCE_COMPATIBILITY',
    'security-boundary-expansion': 'EXPANDS_SECURITY_BOUNDARY',
    'sealed-requirement-conflict': 'SEALED_REQUIREMENTS_CONFLICT',
    'contract-change-request': 'MODIFIES_SEALED_CONTRACT',
    'human-only-credential': 'REQUIRES_HUMAN_CREDENTIAL',
    'external-irreversible-action': 'IRREVERSIBLE_EXTERNAL_EFFECT',
    'spend-beyond-ceiling': 'EXCEEDS_AUTHORIZED_SPEND',
    'scope-beyond-seal': 'OUTSIDE_SEALED_SCOPE',
  });

export function isAuthoritySurface(surface: AutonomousDecisionSurface): boolean {
  return AUTHORITY_SURFACES[surface] !== undefined;
}

export function isDelegatableSurface(surface: AutonomousDecisionSurface): boolean {
  return surface in DELEGATED_SURFACES;
}

// ---------------------------------------------------------------------------
// Requests and decisions
// ---------------------------------------------------------------------------

export interface AuthorityQuery {
  surface: AutonomousDecisionSurface;
  /** The seal governing this job, when one is bound. */
  seal?: MissionSeal | undefined;
  policy: AutonomyPolicy;
  /**
   * Observations about difficulty. Recorded on the decision, never
   * consulted. Passing every member of `NON_AUTHORITY_SIGNALS` at once still
   * cannot produce NEEDS_AUTHORITY.
   */
  signals?: readonly NonAuthoritySignal[] | undefined;
  /**
   * Whether a stronger reasoning tier exists that has NOT been tried for
   * this decision. Only consulted for delegated surfaces, and only to choose
   * between deciding now and deciding better.
   */
  strongerIntelligenceAvailable?: boolean | undefined;
  /** For spend decisions: what the action would cost and what is authorized. */
  spend?: { requestedUsd: number | null; ceilingUsd: number | null } | undefined;
  /** For contract-shaped decisions: the contract the action would touch. */
  contractId?: string | undefined;
  /** Bounded free text describing the proposal, for the recorded question. */
  detail?: string | undefined;
}

export interface AuthorityDecision {
  verdict: AuthorityVerdict;
  reason: AuthorityReason;
  surface: AutonomousDecisionSurface;
  /** One sentence a person reads at breakfast. Empty unless NEEDS_AUTHORITY. */
  question: string;
  /** Why this is genuinely the human's call and not the runtime's. */
  whyItMatters: string;
  /** Signals observed, carried for the record. Never inputs to the verdict. */
  observedSignals: readonly NonAuthoritySignal[];
}

// ---------------------------------------------------------------------------
// The firewall
// ---------------------------------------------------------------------------

/**
 * Decide who owns one decision.
 *
 * The order of the checks is the policy, and it reads top to bottom as the
 * argument for the whole phase:
 *
 *   1. An authority surface is an authority surface, sealed or not. Nothing
 *      below can rescue it, and no amount of delegation can grant it.
 *   2. Without an executable seal there is no delegated authority at all, so
 *      an unsealed job falls back to asking. Autonomy is something a human
 *      grants, never something a runtime assumes.
 *   3. Inside a seal, a delegated surface is decided by the runtime. If a
 *      stronger reasoner is available and untried, use it — that is what
 *      "hard" means operationally.
 *   4. A surface the policy reserves goes to the human, because the human
 *      said so. This is the only path from configuration to a human gate,
 *      and it is opt-in rather than default under an unattended mode.
 */
export function evaluateAuthority(request: AuthorityQuery): AuthorityDecision {
  const signals = request.signals ?? [];
  const surface = request.surface;

  // 1. Hard authority surfaces.
  const authorityReason = AUTHORITY_SURFACES[surface];
  if (authorityReason !== undefined) {
    if (surface === 'spend-beyond-ceiling' && !exceedsCeiling(request.spend)) {
      // A spend decision inside the authorized ceiling is not an authority
      // decision at all; it is ordinary bounded execution.
      return decided('AUTONOMOUS', 'WITHIN_SEALED_INTENT', surface, signals);
    }
    return needsAuthority(surface, authorityReason, request, signals);
  }

  // 2. No executable seal means no delegated authority.
  const executability = assessSealExecutability(request.seal, request.policy);
  if (!executability.executable) {
    const reason: AuthorityReason =
      executability.reason === 'AUTONOMY_POLICY_DRIFT'
        ? 'AUTONOMY_POLICY_DRIFT'
        : executability.reason === 'SEAL_NOT_EXECUTABLE'
          ? 'SEAL_NOT_EXECUTABLE'
          : 'NO_SEAL_BOUND';
    return {
      verdict: 'NEEDS_AUTHORITY',
      reason,
      surface,
      question:
        executability.detail ??
        'This job has no delegated authority; a human decision is required to proceed.',
      whyItMatters:
        'Delegated engineering authority comes from a sealed Mission. Without one, the ' +
        'runtime has not been given permission to decide anything on its own.',
      observedSignals: signals,
    };
  }

  // 3. Delegated engineering surfaces.
  if (isDelegatableSurface(surface)) {
    const key = DELEGATED_SURFACES[surface];
    const setting = key === undefined ? 'AUTO' : delegationFor(request.policy, key);
    if (setting === 'AUTO') {
      if (request.strongerIntelligenceAvailable === true) {
        return decided('ESCALATE_INTELLIGENCE', 'REQUIRES_STRONGER_INTELLIGENCE', surface, signals);
      }
      return decided('AUTONOMOUS', 'DELEGATED_BY_POLICY', surface, signals);
    }
    // 4. The policy reserves this surface. Under an unattended mode this is
    // the operator's explicit choice, and it is worth naming as such.
    return {
      verdict: 'NEEDS_AUTHORITY',
      reason: 'POLICY_RESERVES_TO_HUMAN',
      surface,
      question: `The autonomy policy reserves "${surface}" decisions to a human. ${
        request.detail ?? ''
      }`.trim(),
      whyItMatters: isUnattendedMode(request.policy.mode)
        ? `Unattended execution is on, but "${surface}" is set to HUMAN in the autonomy policy. ` +
          'Delegate it to run this class of decision without waking anyone.'
        : 'Interactive mode leaves ordinary engineering decisions with the human by default.',
      observedSignals: signals,
    };
  }

  // Unknown surface: refuse rather than invent latitude. New members of the
  // surface enum must be classified explicitly, and forgetting to do so
  // fails closed towards asking rather than open towards acting.
  return {
    verdict: 'NEEDS_AUTHORITY',
    reason: 'OUTSIDE_SEALED_SCOPE',
    surface,
    question: `SpecBridge has no authority classification for "${surface}" and will not assume one.`,
    whyItMatters:
      'An unclassified decision surface is not delegated by omission. Classify it in the ' +
      'authority firewall before an autonomous run may take it.',
    observedSignals: signals,
  };
}

function delegationFor(policy: AutonomyPolicy, key: DelegationKey): DelegationSetting {
  const decisions = policy.decisions as Record<string, DelegationSetting | undefined>;
  const recovery = policy.recovery as Record<string, DelegationSetting | undefined>;
  return decisions[key] ?? recovery[key] ?? 'HUMAN';
}

function exceedsCeiling(
  spend: { requestedUsd: number | null; ceilingUsd: number | null } | undefined,
): boolean {
  if (spend === undefined) return true;
  // An unknown ceiling is not an infinite ceiling, and an unknown cost is
  // not a free one. Either unknown means the runtime cannot prove it is
  // inside the authorization, so it is treated as outside it.
  if (spend.ceilingUsd === null || spend.requestedUsd === null) return true;
  return spend.requestedUsd > spend.ceilingUsd;
}

function decided(
  verdict: AuthorityVerdict,
  reason: AuthorityReason,
  surface: AutonomousDecisionSurface,
  signals: readonly NonAuthoritySignal[],
): AuthorityDecision {
  return { verdict, reason, surface, question: '', whyItMatters: '', observedSignals: signals };
}

function needsAuthority(
  surface: AutonomousDecisionSurface,
  reason: AuthorityReason,
  request: AuthorityQuery,
  signals: readonly NonAuthoritySignal[],
): AuthorityDecision {
  return {
    verdict: 'NEEDS_AUTHORITY',
    reason,
    surface,
    question: authorityQuestion(surface, request),
    whyItMatters: authorityRationale(reason),
    observedSignals: signals,
  };
}

function authorityQuestion(surface: AutonomousDecisionSurface, request: AuthorityQuery): string {
  const detail = request.detail !== undefined ? ` ${request.detail}` : '';
  switch (surface) {
    case 'sealed-contract-change':
    case 'contract-change-request':
      return (
        `Completing this work requires changing sealed contract ` +
        `${request.contractId ?? '(unnamed)'}.${detail} Approve the change, amend the sealed ` +
        'intent, or direct a different approach.'
      );
    case 'product-semantics-change':
      return `Completing this work would change externally observable product behavior.${detail}`;
    case 'wire-protocol-change':
      return `Completing this work would change a wire or protocol promise.${detail}`;
    case 'persistence-compatibility-change':
      return `Completing this work would break a persistence compatibility promise.${detail}`;
    case 'security-boundary-expansion':
      return `Completing this work would widen a security boundary.${detail}`;
    case 'sealed-requirement-conflict':
      return `Two sealed requirements contradict each other and cannot both hold.${detail}`;
    case 'human-only-credential':
      return `This work needs a credential or account action only a person can perform.${detail}`;
    case 'external-irreversible-action':
      return `This work would take an irreversible action outside the workspace.${detail}`;
    case 'spend-beyond-ceiling':
      return (
        `Continuing would spend beyond the authorized ceiling ` +
        `(${formatUsd(request.spend?.ceilingUsd ?? null)} authorized, ` +
        `${formatUsd(request.spend?.requestedUsd ?? null)} needed).${detail}`
      );
    case 'scope-beyond-seal':
      return `This work is outside anything the sealed intent authorized.${detail}`;
    default:
      return `A product decision is required for "${surface}".${detail}`;
  }
}

function formatUsd(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(2)}`;
}

function authorityRationale(reason: AuthorityReason): string {
  switch (reason) {
    case 'MODIFIES_SEALED_CONTRACT':
      return 'A sealed contract is a promise a human made. An agent may propose a change to one; it may never make it.';
    case 'CHANGES_PRODUCT_SEMANTICS':
      return 'What the product does for its users is product authority, not engineering latitude.';
    case 'CHANGES_WIRE_CONTRACT':
      return 'Wire and protocol semantics are promises to systems outside this repository.';
    case 'CHANGES_PERSISTENCE_COMPATIBILITY':
      return 'Persisted data outlives the code that wrote it; compatibility is a human commitment.';
    case 'EXPANDS_SECURITY_BOUNDARY':
      return 'Autonomy means taking responsibility inside granted authority, never expanding it.';
    case 'SEALED_REQUIREMENTS_CONFLICT':
      return 'A genuine contradiction between approved requirements can only be resolved by whoever approved them.';
    case 'REQUIRES_HUMAN_CREDENTIAL':
      return 'SpecBridge never creates accounts, enters credentials, or authenticates on a person behalf.';
    case 'IRREVERSIBLE_EXTERNAL_EFFECT':
      return 'Local engineering authority does not imply authority to change anything outside the workspace.';
    case 'EXCEEDS_AUTHORIZED_SPEND':
      return 'Money is spent only inside an explicit, pre-authorized bound. There is no implicit ceiling.';
    case 'OUTSIDE_SEALED_SCOPE':
      return 'Work the seal never authorized is new product intent, and new product intent is the human decision.';
    default:
      return 'This decision is reserved to a human.';
  }
}

// ---------------------------------------------------------------------------
// Structural screens
// ---------------------------------------------------------------------------

/**
 * Deterministic screen mapping proposal text onto AUTHORITY surfaces.
 *
 * This is the second line behind an agent's own declaration, and it is
 * deliberately narrower than the v1.2 replan screen it complements. That
 * screen fires on the WORD "architecture", which is correct when a human is
 * at the keyboard and wrong at 03:00: internal architecture is delegated,
 * and a plan that says "restructure the module layout" must not wake anyone.
 *
 * So the patterns here look for the vocabulary of PROMISES — public API,
 * wire format, migration compatibility, auth boundaries — rather than the
 * vocabulary of DIFFICULTY. Each pattern is paired with the surface it
 * implies so the caller can run the firewall rather than guess.
 */
const AUTHORITY_TEXT_PATTERNS: readonly {
  surface: AutonomousDecisionSurface;
  pattern: RegExp;
}[] = [
  {
    surface: 'sealed-contract-change',
    pattern: /\b(change|modify|amend|break|revise)\b[^.]{0,40}\b(sealed contract|approved contract|contract [A-Z]{2,4}-\d+)\b/i,
  },
  {
    surface: 'wire-protocol-change',
    pattern: /\b(wire format|wire protocol|message schema|event schema|protocol version|serialization format)\b/i,
  },
  {
    surface: 'persistence-compatibility-change',
    pattern: /\b(destructive migration|drop (?:the )?(?:table|column)|backward[- ]incompatible|breaking migration|data loss)\b/i,
  },
  {
    surface: 'security-boundary-expansion',
    pattern: /\b(disable (?:auth|authentication|authorization)|bypass (?:permission|permissions|sandbox|security)|widen (?:the )?(?:scope|permission)|grant (?:admin|root|elevated))\b/i,
  },
  {
    surface: 'product-semantics-change',
    pattern: /\b(change (?:the )?(?:delivery|retry|ordering|idempotency|consistency) semantics|user[- ]facing behaviou?r change|deprecate (?:the )?(?:endpoint|feature))\b/i,
  },
  {
    surface: 'human-only-credential',
    pattern: /\b(create an account|sign up|api key from|obtain credentials|log in to|two[- ]factor)\b/i,
  },
  {
    surface: 'external-irreversible-action',
    pattern: /\b(deploy to production|publish to (?:npm|pypi|maven)|delete (?:the )?(?:production|remote) |force[- ]push)\b/i,
  },
];

export interface AuthorityTextScreen {
  /** Authority surfaces the text implies. Empty means "engineering only". */
  surfaces: AutonomousDecisionSurface[];
  /** The matched fragments, bounded, for the recorded question. */
  matches: string[];
}

export function screenTextForAuthoritySurfaces(text: string): AuthorityTextScreen {
  const surfaces: AutonomousDecisionSurface[] = [];
  const matches: string[] = [];
  for (const entry of AUTHORITY_TEXT_PATTERNS) {
    const match = entry.pattern.exec(text);
    if (match === null) continue;
    if (!surfaces.includes(entry.surface)) surfaces.push(entry.surface);
    matches.push((match[0] ?? '').slice(0, 80));
  }
  return { surfaces, matches };
}

/**
 * Refine a v1.2 intent-impact screen under delegated authority.
 *
 * The v1.2 screen returns `JobDecisionKind`s; only two of them are genuinely
 * about promises rather than about engineering weight. Under a seal with
 * delegated internal architecture and dependency selection, the other two
 * are noise, and treating them as gates is precisely the "repeated stage
 * approval after product authority was already settled" failure this phase
 * removes.
 *
 * Returns the authority surfaces that SURVIVE the refinement. An empty
 * result means the replan is ordinary engineering and proceeds.
 */
export function refineIntentImpactUnderSeal(
  decisionKinds: readonly string[],
  policy: AutonomyPolicy,
): AutonomousDecisionSurface[] {
  const surfaces: AutonomousDecisionSurface[] = [];
  for (const kind of decisionKinds) {
    switch (kind) {
      case 'public-api-change':
        // A public API IS a sealed promise. It stays.
        surfaces.push('sealed-contract-change');
        break;
      case 'product-behavior-change':
        surfaces.push('product-semantics-change');
        break;
      case 'architecture-contract-change':
        // Delegated when internal architecture is delegated; an ARCHITECTURE
        // CONTRACT change that also touches a public surface will have been
        // caught by the public-api or text screens above.
        if (policy.decisions.internalArchitecture !== 'AUTO') surfaces.push('sealed-contract-change');
        break;
      case 'new-dependency':
        if (policy.decisions.dependencySelection !== 'AUTO') surfaces.push('scope-beyond-seal');
        break;
      case 'spec-conflict':
        surfaces.push('sealed-requirement-conflict');
        break;
      default:
        break;
    }
  }
  return surfaces;
}

/**
 * Prove that no difficulty signal can produce a human gate.
 *
 * Exported rather than kept in the test file on purpose: the guarantee it
 * checks is a PRODUCT promise, so the runtime carries the means to
 * demonstrate it, and `specbridge autonomy policy --explain` prints the
 * result. A property that is only asserted in a test is a property that
 * quietly stops being true.
 */
export function verifyNonAuthoritySignalsCannotGate(
  policy: AutonomyPolicy,
  seal: MissionSeal,
): { holds: boolean; violations: string[] } {
  const violations: string[] = [];
  const delegated = Object.keys(DELEGATED_SURFACES) as AutonomousDecisionSurface[];
  for (const surface of delegated) {
    const key = DELEGATED_SURFACES[surface];
    if (key !== undefined && delegationFor(policy, key) !== 'AUTO') continue;
    const decision = evaluateAuthority({
      surface,
      seal,
      policy,
      signals: [...NON_AUTHORITY_SIGNALS],
    });
    if (decision.verdict === 'NEEDS_AUTHORITY') {
      violations.push(
        `${surface} produced NEEDS_AUTHORITY from difficulty signals alone (${decision.reason})`,
      );
    }
  }
  return { holds: violations.length === 0, violations };
}
