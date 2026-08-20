import type { IrreversibleSurface, MaterialityLevel } from './vocabulary.js';
import { IRREVERSIBLE_SURFACES } from './vocabulary.js';

/**
 * Deterministic irreversibility / materiality analysis.
 *
 * A question is BLOCKING when changing its answer later could materially
 * affect a surface users depend on: public API, wire protocol, persisted
 * state, configuration language, SDK contract, extension SPI, compatibility
 * promise, security boundary, failure/delivery semantics, or cross-module
 * architecture. Implementation-level uncertainty never blocks discovery.
 *
 * Two inputs feed the classification:
 *   1. the surfaces DECLARED on the question (a model or user proposal), and
 *   2. a keyword screen over the question text — the structural second line,
 *      following the same pattern as the replan intent screen in
 *      orchestration/jobs/authority.ts.
 *
 * The screen may only RAISE the level, never lower it. A proposer can also
 * declare a HIGHER level than the screen finds — caution is always accepted.
 */

const SURFACE_PATTERNS: readonly { surface: IrreversibleSurface; pattern: RegExp }[] = [
  { surface: 'public-api', pattern: /\b(public api|api surface|api contract|sdk method|exported interface)\b/i },
  { surface: 'wire-protocol', pattern: /\b(wire protocol|message format|message envelope|protocol identity|serialization format|on the wire)\b/i },
  { surface: 'persisted-state', pattern: /\b(persist(?:ed|ence)?|durable state|stored state|storage schema|execution.state.durab)\b/i },
  { surface: 'configuration-language', pattern: /\b(config(?:uration)? (?:language|format|schema|file syntax))\b/i },
  { surface: 'sdk-contract', pattern: /\b(sdk contract|client library contract)\b/i },
  { surface: 'extension-spi', pattern: /\b(extension (?:spi|seam|point|interface)|plugin interface|spi\b)\b/i },
  { surface: 'compatibility-promise', pattern: /\b(compatibilit|backward[- ]compat|upgrade path|evolution rule|versioning polic)\b/i },
  { surface: 'security-boundary', pattern: /\b(security boundar|trust boundar|authenticat|authoriz|permission model)\b/i },
  { surface: 'failure-delivery-semantics', pattern: /\b(delivery semantics|at[- ]least[- ]once|at[- ]most[- ]once|exactly[- ]once|duplicate (?:result|message|completion)|late result|idempotenc|redeliver)\b/i },
  { surface: 'cross-module-architecture', pattern: /\b(cross[- ]module|module boundar|ownership of (?:control flow|orchestration|state)|who owns|canonical (?:model|runtime))\b/i },
];

const LEVEL_ORDER: Record<MaterialityLevel, number> = {
  'implementation-detail': 0,
  material: 1,
  blocking: 2,
};

export function maxMateriality(a: MaterialityLevel, b: MaterialityLevel): MaterialityLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

export interface MaterialityAssessment {
  /** Effective level after the deterministic screen. */
  level: MaterialityLevel;
  /** Present when the screen raised the declared level. */
  raisedFrom?: MaterialityLevel;
  /** Surfaces found: declared plus screened, deduplicated. */
  surfaces: IrreversibleSurface[];
  /** Machine-checkable reasons ("surface public-api matched 'api contract'"). */
  reasons: string[];
}

export interface MaterialityInput {
  questionText: string;
  whyItMatters?: string | undefined;
  declaredSurfaces?: readonly IrreversibleSurface[] | undefined;
  declaredLevel?: MaterialityLevel | undefined;
}

/**
 * Classify one question. Deterministic, replayable, and only ever errs
 * towards asking the human.
 */
export function assessMateriality(input: MaterialityInput): MaterialityAssessment {
  const declared = new Set<IrreversibleSurface>(input.declaredSurfaces ?? []);
  const reasons: string[] = [];
  for (const surface of declared) {
    reasons.push(`surface ${surface} was declared by the proposer`);
  }

  const haystack = `${input.questionText}\n${input.whyItMatters ?? ''}`;
  const screened = new Set<IrreversibleSurface>(declared);
  for (const entry of SURFACE_PATTERNS) {
    if (screened.has(entry.surface)) continue;
    const match = entry.pattern.exec(haystack);
    if (match === null) continue;
    screened.add(entry.surface);
    reasons.push(`surface ${entry.surface} matched "${(match[0] ?? '').slice(0, 60)}"`);
  }

  const declaredLevel = input.declaredLevel ?? 'implementation-detail';
  const screenLevel: MaterialityLevel = screened.size > 0 ? 'blocking' : declaredLevel;
  const level = maxMateriality(declaredLevel, screenLevel);

  const ordered = IRREVERSIBLE_SURFACES.filter((surface) => screened.has(surface));
  return {
    level,
    ...(LEVEL_ORDER[level] > LEVEL_ORDER[declaredLevel] ? { raisedFrom: declaredLevel } : {}),
    surfaces: ordered,
    reasons,
  };
}
