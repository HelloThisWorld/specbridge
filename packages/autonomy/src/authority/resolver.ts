import type { AutonomyPolicy, WorkspaceInfo } from '@specbridge/core';
import { isUnattendedMode } from '@specbridge/core';
import type {
  DelegatedAuthorityContext,
  DelegatedAuthorityResolver,
  DelegatedAuthorityVerdict,
} from '@specbridge/orchestration';
import { readJobSeal } from '../seal/service.js';
import type { AutonomousDecisionSurface } from '../vocabulary.js';
import { evaluateAuthority, refineIntentImpactUnderSeal, screenTextForAuthoritySurfaces } from './firewall.js';

/**
 * The concrete `DelegatedAuthorityResolver` the driver consults.
 *
 * It is a thin adapter, and thin on purpose: all the judgment lives in the
 * pure firewall, which a test can exercise without a workspace, a job, or a
 * clock. This file's whole job is to fetch the seal, run the two screens,
 * and translate the firewall's verdict into the orchestration contract.
 *
 * The translation has one deliberate asymmetry. When the firewall says
 * `AUTONOMOUS` the driver proceeds; when it says anything else the driver
 * keeps whatever gate it already had. So a resolver failure, a missing seal,
 * or an unclassified surface all degrade to the v1.2 behaviour rather than
 * to silent action — this seam can only ever REMOVE a false gate, never add
 * a real one.
 */

export interface AuthorityResolverOptions {
  workspace: WorkspaceInfo;
  policy: AutonomyPolicy;
  /**
   * Whether a stronger reasoning tier is available and untried right now.
   * Supplied by the driver's routing layer; absent means "do not escalate",
   * which is the conservative reading (decide with what we have rather than
   * claim a tier we cannot reach).
   */
  strongerIntelligenceAvailable?: (context: DelegatedAuthorityContext) => boolean;
}

export function createAuthorityResolver(
  options: AuthorityResolverOptions,
): DelegatedAuthorityResolver {
  return {
    resolve(context: DelegatedAuthorityContext): DelegatedAuthorityVerdict {
      const seal = readJobSeal(options.workspace, context.jobId);

      // The two screens produce candidate AUTHORITY surfaces. The v1.2 screen
      // is re-read through the seal (so "architecture" alone stops gating a
      // delegated run), and the proposal text is screened for the vocabulary
      // of promises rather than the vocabulary of difficulty.
      const fromKinds = refineIntentImpactUnderSeal(context.decisionKinds, options.policy);
      const fromText =
        context.proposal !== undefined
          ? screenTextForAuthoritySurfaces(context.proposal).surfaces
          : [];
      const surfaces = dedupe([...fromKinds, ...fromText]);

      if (surfaces.length === 0) {
        // Nothing in the proposal touches a promise. Whether the runtime may
        // act is now an ordinary delegation question about replanning.
        const decision = evaluateAuthority({
          surface: 'implementation-plan',
          seal,
          policy: options.policy,
          strongerIntelligenceAvailable:
            options.strongerIntelligenceAvailable?.(context) ?? false,
        });
        if (decision.verdict === 'AUTONOMOUS') {
          return {
            kind: 'AUTONOMOUS',
            reason:
              context.reasons.length > 0
                ? `no sealed promise is affected (${context.reasons.length} screen hit(s) were engineering-only)`
                : 'no sealed promise is affected',
          };
        }
        if (decision.verdict === 'ESCALATE_INTELLIGENCE') {
          return { kind: 'ESCALATE_INTELLIGENCE', reason: decision.reason };
        }
        return {
          kind: 'NEEDS_AUTHORITY',
          surface: decision.surface,
          reason: decision.reason,
          question: decision.question,
          whyItMatters: decision.whyItMatters,
          options: authorityOptions(decision.surface),
        };
      }

      // At least one surface survived. Report the FIRST one in the enum's
      // own order rather than the most recently matched: a stable choice
      // makes the question a human sees reproducible across re-runs.
      const surface = surfaces[0] as AutonomousDecisionSurface;
      const decision = evaluateAuthority({
        surface,
        seal,
        policy: options.policy,
        detail: context.reasons.slice(0, 3).join('; ').slice(0, 500),
      });
      if (decision.verdict === 'AUTONOMOUS') {
        return { kind: 'AUTONOMOUS', reason: `${surface} is delegated by the sealed intent` };
      }
      if (decision.verdict === 'ESCALATE_INTELLIGENCE') {
        return { kind: 'ESCALATE_INTELLIGENCE', reason: decision.reason };
      }
      return {
        kind: 'NEEDS_AUTHORITY',
        surface: decision.surface,
        reason: decision.reason,
        question: decision.question,
        whyItMatters: decision.whyItMatters,
        options: authorityOptions(decision.surface),
      };
    },
  };
}

function dedupe(values: readonly AutonomousDecisionSurface[]): AutonomousDecisionSurface[] {
  const seen = new Set<AutonomousDecisionSurface>();
  const out: AutonomousDecisionSurface[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * The ways forward SpecBridge can already see for one authority surface.
 *
 * Offered so the human's reply can be a choice rather than an essay. They
 * are never a menu the runtime picks from: every one of them requires the
 * human to perform an operation the agent surfaces cannot reach.
 */
function authorityOptions(surface: string): string[] {
  switch (surface) {
    case 'sealed-contract-change':
    case 'contract-change-request':
      return [
        'Approve the contract change request and re-seal the mission.',
        'Reject it and direct an approach that keeps the contract intact.',
        'Amend the sealed intent, then re-seal.',
      ];
    case 'sealed-requirement-conflict':
      return [
        'Decide which requirement wins and record it as a mission decision.',
        'Amend both requirements and re-seal.',
      ];
    case 'spend-beyond-ceiling':
      return [
        'Raise the authorized spend ceiling and re-seal.',
        'Leave the ceiling and let the run finish what local and subscription compute can.',
      ];
    case 'human-only-credential':
      return [
        'Provide the credential through the provider own authentication flow.',
        'Descope the work that needs it.',
      ];
    default:
      return [
        'Record an explicit decision and resume the job.',
        'Amend the sealed intent and re-seal.',
      ];
  }
}

/**
 * Whether this workspace should install a resolver at all.
 *
 * An INTERACTIVE workspace deliberately keeps the v1.2 gates: a person is
 * present, and removing their glance to save them a keystroke is not a
 * trade anyone asked for.
 */
export function shouldDelegateAuthority(policy: AutonomyPolicy): boolean {
  return isUnattendedMode(policy.mode) && policy.humanGate === 'AUTHORITY_ONLY';
}
