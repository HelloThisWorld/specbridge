import { sha256Hex } from '@specbridge/core';
import type { DiscoveryTopic, IrreversibleSurface } from '@specbridge/mission';
import type { DeltaAuthorityAnalysis, DeltaItem, RepositoryGrounding, SourceChunk } from './state.js';
import { INTAKE_DELTA_SCHEMA_VERSION, INTAKE_LIMITS } from './state.js';
import type { DeltaAuthorityClass } from './vocabulary.js';
import { AUTHORITY_SENSITIVE_DELTA_CLASSES, DELTA_AUTHORITY_CLASSES, requiresProductAuthority } from './vocabulary.js';
import type { OwnedContract } from './grounding.js';
import {
  CHANGE_INTENT_PATTERN,
  NEGATION_PATTERN,
  TRAILING_PUNCTUATION,
  WHITESPACE_RUN,
  clip,
  containment,
  jaccard,
  surfacesOf,
  tokenSet,
  topicsOf,
} from './text.js';

/**
 * Delta Authority Analysis.
 *
 * The question this file answers, once per material statement in a submitted
 * specification: *does this need authority somebody already gave, authority
 * this specification itself gives, or authority nobody has given yet?*
 *
 * Getting it wrong is expensive in both directions, and the two failures
 * look nothing alike.
 *
 * Over-classifying puts a human gate in front of ordinary product work. A
 * new REST endpoint, a new console screen, a new configuration file for a
 * NEW feature are all public, and none of them modifies an old promise. The
 * specification the human submitted is what authorizes them. Calling every
 * public thing a sealed-contract change would mean a feature spec could not
 * add a feature without a second conversation, which is precisely the
 * friction vNext.10.1 exists to remove.
 *
 * Under-classifying silently rewrites a promise the product already made.
 * That is worse, and it is what `EXISTING_SEALED_CONTRACT_CHANGE` and
 * `CONTRADICTION` exist to make impossible: an item that touches an existing
 * contract with change-shaped language, or that contradicts an active
 * invariant or constitution rule, can never be absorbed into "new feature".
 *
 * Between them sits `EXISTING_CONTRACT_EXTENSION`, which is legal only when
 * the target contract's own compatibility policy says additions are legal.
 * A FROZEN contract cannot be extended, so an item that would extend one is
 * a change to it — which is exactly what "frozen" means.
 *
 * Everything below is a PURE function of durable inputs. No clock, no I/O,
 * no model. The same document against the same repository always produces
 * the same analysis, which is what lets an approval cite it by digest.
 */

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * How much of a statement's content must appear in an existing contract
 * element before the two are considered to be about the same thing.
 *
 * Chosen high. A false MATCH is the dangerous direction here: it routes a
 * brand-new feature into "changes an existing contract" and stops the run
 * for a human. A false MISS lands the item in `NEW_DELEGATED_SURFACE`, where
 * it creates a new contract of its own — which the closure oracle then
 * audits independently, so nothing is lost.
 */
const MATCH_CONTAINMENT = 0.6;

/** Two statements are the SAME promise, not merely related, above this. */
const SAME_STATEMENT_JACCARD = 0.7;

/** Minimum content tokens before overlap scoring means anything at all. */
const MIN_TOKENS_FOR_MATCH = 4;

export interface DeltaAnalysisRequest {
  intakeId: string;
  analyzedAt: string;
  chunks: readonly SourceChunk[];
  grounding: RepositoryGrounding;
  /** Active contracts owned by OTHER missions. Existing product authority. */
  existingContracts: readonly OwnedContract[];
  /** Active constitution rules across the workspace. */
  constitutionRules: readonly {
    missionId: string;
    ruleId: string;
    statement: string;
    guardPatterns: string[];
  }[];
}

/**
 * Classify every material statement in the submitted specification.
 *
 * Scenario and non-goal chunks participate: an edge case the product must
 * handle is a promise, and an explicit exclusion is authority too — it is
 * the authority to NOT build something, and a later feature that quietly
 * builds it should be visible.
 */
/**
 * The durable surfaces a statement touches.
 *
 * The statement's OWN words decide when they name anything; the heading the
 * author filed it under is a FALLBACK, consulted only when the sentence
 * names no surface at all.
 *
 * Both halves were learned from the same document, and so was the LIMIT.
 *
 * Reading the sentence alone missed "the exported format is additive-only
 * within a major version" under a "## Compatibility" heading — no durable
 * surface in the words — and a whole specification compiled to zero product
 * contracts. But letting the heading speak for every statement went further
 * wrong: under "## Infrastructure", "Use one Spring Boot demo application"
 * inherited a product surface and became a public contract REQUIREMENT, which
 * promises a framework choice to users. Thirty delegated implementation
 * details turned into promises that way.
 *
 * So the fallback is restricted to PROSE, which is the case it was introduced
 * for. A normative bullet says what it is in its own words; a paragraph under
 * a section heading is where an author states a policy without repeating the
 * heading in the sentence.
 */
function surfacesFor(chunk: SourceChunk, statement: string): ReturnType<typeof surfacesOf> {
  const own = surfacesOf(statement);
  if (own.length > 0 || chunk.kind !== 'narrative') return own;
  return surfacesOf(chunk.headingPath.join(' '));
}

/** Topics, with the same restriction: the heading speaks only for prose. */
function topicsFor(chunk: SourceChunk, statement: string): ReturnType<typeof topicsOf> {
  const own = topicsOf(statement);
  if (own.length > 0 || chunk.kind !== 'narrative') return own;
  return topicsOf(chunk.headingPath.join(' '));
}

export function analyzeDeltaAuthority(request: DeltaAnalysisRequest): DeltaAuthorityAnalysis {
  const items: DeltaItem[] = [];
  const material = request.chunks.filter((chunk) => {
    if (chunk.kind === 'normative' || chunk.kind === 'scenario' || chunk.kind === 'non-goal') {
      return true;
    }
    // A PROSE statement under a heading that names a durable product surface
    // is a promise too. Specifications state their compatibility policy and
    // their canonical model in paragraphs, not in bullet lists with modal
    // verbs, and a classifier that only reads grammatical mood misses them.
    return chunk.kind === 'narrative' && surfacesOf(chunk.headingPath.join(' ')).length > 0;
  });

  const index = buildContractIndex(request.existingContracts);
  let sequence = 0;

  for (const chunk of material) {
    if (items.length >= INTAKE_LIMITS.maxItems) break;
    const statement = statementOf(chunk);
    if (statement.length === 0) continue;
    const tokens = tokenSet(statement);
    const surfaces = surfacesFor(chunk, statement);
    const publicSurface = surfaces.length > 0;
    const item = classifyStatement({
      itemId: `D-${String(++sequence).padStart(3, '0')}`,
      statement,
      chunkId: chunk.chunkId,
      tokens,
      surfaces: surfaces.map((match) => match.surface),
      topics: topicsFor(chunk, statement),
      publicSurface,
      index,
      constitutionRules: request.constitutionRules,
      isNonGoal: chunk.kind === 'non-goal',
    });
    items.push(item);
  }

  const counts: Record<string, number> = {};
  for (const cls of DELTA_AUTHORITY_CLASSES) counts[cls] = 0;
  for (const item of items) counts[item.classification] = (counts[item.classification] ?? 0) + 1;

  const modifiedContractIds = unique(
    items
      .filter(
        (item) =>
          item.classification === 'EXISTING_SEALED_CONTRACT_CHANGE' ||
          item.classification === 'CONTRADICTION',
      )
      .map((item) => item.existingContractId)
      .filter((id): id is string => id !== undefined),
  );
  const extendedContractIds = unique(
    items
      .filter((item) => item.classification === 'EXISTING_CONTRACT_EXTENSION')
      .map((item) => item.existingContractId)
      .filter((id): id is string => id !== undefined),
  );
  // The same contracts, qualified by their owning mission. Contract ids are
  // unique only within a mission, so a bare id is ambiguous the moment the
  // feature's own registry also has one.
  const owners = new Map<string, OwnedContract>();
  for (const owned of request.existingContracts) {
    owners.set(`${owned.missionId}/${owned.contract.contractId}`, owned);
  }
  const affectedContracts: DeltaAuthorityAnalysis['affectedContracts'] = [];
  const seenAffected = new Set<string>();
  for (const item of items) {
    const relation =
      item.classification === 'EXISTING_CONTRACT_EXTENSION'
        ? ('EXTENDED' as const)
        : item.classification === 'EXISTING_SEALED_CONTRACT_CHANGE' ||
            item.classification === 'CONTRADICTION'
          ? ('CHANGED' as const)
          : undefined;
    if (relation === undefined) continue;
    if (item.existingContractId === undefined || item.existingMissionId === undefined) continue;
    const key = `${item.existingMissionId}/${item.existingContractId}/${relation}`;
    if (seenAffected.has(key)) continue;
    seenAffected.add(key);
    const owned = owners.get(`${item.existingMissionId}/${item.existingContractId}`);
    affectedContracts.push({
      contractId: item.existingContractId,
      missionId: item.existingMissionId,
      ...(owned !== undefined ? { missionName: owned.missionName } : {}),
      title: owned?.contract.title ?? item.existingContractId,
      revision: item.existingContractRevision ?? owned?.contract.revision ?? 1,
      relation,
    });
  }

  const newSurfaces = unique(
    items
      .filter((item) => item.classification === 'NEW_DELEGATED_SURFACE')
      .flatMap((item) => item.affectedSurfaces),
  );

  // "Complete" means every statement is classified AND none of them needs
  // product authority nobody has given. Reporting completeness on
  // classification alone would let a caller that checks one boolean proceed
  // past a would-be sealed-contract change, which is the single thing this
  // analysis exists to catch.
  const reasons: string[] = [];
  const authoritySensitive = items.filter((item) => requiresProductAuthority(item.classification));
  if (items.length === 0) {
    reasons.push(
      'The submitted specification contains no statements the classifier recognised as ' +
        'material. Delta authority analysis has nothing to classify.',
    );
  }
  for (const cls of AUTHORITY_SENSITIVE_DELTA_CLASSES) {
    const count = counts[cls] ?? 0;
    if (count === 0) continue;
    reasons.push(
      `${count} statement(s) classified ${cls} and need a product decision before this ` +
        'specification can be approved.',
    );
  }

  const complete = items.length > 0 && authoritySensitive.length === 0;

  return {
    schemaVersion: INTAKE_DELTA_SCHEMA_VERSION,
    intakeId: request.intakeId,
    analyzedAt: request.analyzedAt,
    basisDigest: computeBasisDigest(request),
    items,
    counts,
    modifiedContractIds: modifiedContractIds.slice(0, INTAKE_LIMITS.maxRefsPerRecord),
    extendedContractIds: extendedContractIds.slice(0, INTAKE_LIMITS.maxRefsPerRecord),
    affectedContracts: affectedContracts.slice(0, INTAKE_LIMITS.maxRefsPerRecord),
    newSurfaces: newSurfaces.slice(0, INTAKE_LIMITS.maxItems),
    complete,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// The contract index
// ---------------------------------------------------------------------------

interface IndexedElement {
  owner: OwnedContract;
  /** "requirement" | "invariant" | "summary". */
  elementKind: string;
  elementId: string;
  statement: string;
  tokens: Set<string>;
  guardPatterns: readonly string[];
}

interface ContractIndex {
  elements: IndexedElement[];
  /** Contract ids and titles, for explicit-reference detection. */
  byId: Map<string, OwnedContract>;
}

function buildContractIndex(contracts: readonly OwnedContract[]): ContractIndex {
  const elements: IndexedElement[] = [];
  const byId = new Map<string, OwnedContract>();
  for (const owned of contracts) {
    byId.set(owned.contract.contractId.toLowerCase(), owned);
    elements.push({
      owner: owned,
      elementKind: 'summary',
      elementId: owned.contract.contractId,
      statement: `${owned.contract.title}. ${owned.contract.summary}`,
      tokens: tokenSet(`${owned.contract.title} ${owned.contract.summary}`),
      guardPatterns: [],
    });
    for (const requirement of owned.contract.requirements) {
      elements.push({
        owner: owned,
        elementKind: 'requirement',
        elementId: requirement.requirementId,
        statement: requirement.statement,
        tokens: tokenSet(requirement.statement),
        guardPatterns: [],
      });
    }
    for (const invariant of owned.contract.invariants) {
      elements.push({
        owner: owned,
        elementKind: 'invariant',
        elementId: invariant.invariantId,
        statement: invariant.statement,
        tokens: tokenSet(invariant.statement),
        guardPatterns: invariant.guardPatterns,
      });
    }
  }
  return { elements, byId };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface ClassifyInput {
  itemId: string;
  statement: string;
  chunkId: string;
  tokens: Set<string>;
  surfaces: IrreversibleSurface[];
  topics: DiscoveryTopic[];
  publicSurface: boolean;
  index: ContractIndex;
  constitutionRules: DeltaAnalysisRequest['constitutionRules'];
  isNonGoal: boolean;
}

function classifyStatement(input: ClassifyInput): DeltaItem {
  const base = {
    itemId: input.itemId,
    statement: clip(input.statement, INTAKE_LIMITS.maxTextChars),
    sourceChunkIds: [input.chunkId],
    topics: input.topics.slice(0, INTAKE_LIMITS.maxRefsPerRecord),
    affectedSurfaces: input.surfaces,
    publicSurface: input.publicSurface,
    existingElementIds: [] as string[],
  };

  // --- 1. A constitution rule this statement contradicts -------------------
  const constitutionClash = findConstitutionClash(input);
  if (constitutionClash !== undefined) {
    return {
      ...base,
      classification: 'CONTRADICTION',
      rationale:
        `Contradicts active constitution rule ${constitutionClash.ruleId} ` +
        `("${clip(constitutionClash.statement, 200)}") from mission ${constitutionClash.missionId}. ` +
        'A constitution rule is a durable invariant; a feature cannot overrule one implicitly.',
      existingMissionId: constitutionClash.missionId,
      existingElementIds: [constitutionClash.ruleId],
    };
  }

  // --- 2. The best existing-contract match ---------------------------------
  const match = findBestMatch(input);
  if (match !== undefined) {
    const contract = match.element.owner.contract;
    const shared = {
      ...base,
      existingContractId: contract.contractId,
      existingContractRevision: contract.revision,
      existingMissionId: match.element.owner.missionId,
      existingElementIds: [match.element.elementId],
    };

    // 2a. A statement whose text contradicts what the matched element says.
    if (contradicts(input.statement, match.element.statement)) {
      return {
        ...shared,
        classification: 'CONTRADICTION',
        rationale:
          `Contradicts ${contract.contractId} r${contract.revision} ` +
          `${match.element.elementKind} ${match.element.elementId}: ` +
          `"${clip(match.element.statement, 200)}". Both cannot hold.`,
      };
    }

    // 2b. The promise, restated.
    //
    // This has to precede every change branch below. The StepRelay Golden
    // Spec, re-submitted against the repository its own first run had
    // sealed, gated a human on CTR-005 R9 — a requirement whose text it
    // matched BYTE FOR BYTE — because the sealed sentence ends "without
    // frontend code changes" and the word "changes" reads as change intent.
    // Resubmitting a specification must not manufacture authority questions
    // out of promises the product already made in those exact words.
    if (match.restates) {
      return {
        ...shared,
        classification: 'EXISTING_CONTRACT_COMPATIBLE',
        rationale:
          `Restates ${contract.contractId} r${contract.revision} ` +
          `${match.element.elementKind} ${match.element.elementId} word for word. ` +
          'A promise repeated is not a promise changed.',
      };
    }

    // 2c. Change-shaped language aimed at an existing promise.
    if (CHANGE_INTENT_PATTERN.test(input.statement)) {
      return {
        ...shared,
        classification: 'EXISTING_SEALED_CONTRACT_CHANGE',
        rationale:
          `Names a change to ${contract.contractId} r${contract.revision} ` +
          `${match.element.elementKind} ${match.element.elementId}. Modifying an existing ` +
          'sealed promise is human authority, whatever the new specification asks for.',
      };
    }

    // 2d. An invariant is never "extended". Touching one is changing it.
    if (match.element.elementKind === 'invariant' && match.containment >= MATCH_CONTAINMENT) {
      return {
        ...shared,
        classification: 'EXISTING_SEALED_CONTRACT_CHANGE',
        rationale:
          `Touches invariant ${match.element.elementId} of ${contract.contractId} ` +
          `r${contract.revision}. An invariant has no additive form: any statement that ` +
          'engages it either restates it or changes it.',
      };
    }

    // 2e. The same promise, near enough to read as already made.
    if (match.same) {
      return {
        ...shared,
        classification: 'EXISTING_CONTRACT_COMPATIBLE',
        rationale:
          `${contract.contractId} r${contract.revision} ${match.element.elementKind} ` +
          `${match.element.elementId} already promises this. Nothing changes.`,
      };
    }

    // 2f. An addition to a contract whose policy permits additions.
    if (contract.compatibilityPolicy === 'frozen') {
      return {
        ...shared,
        classification: 'EXISTING_SEALED_CONTRACT_CHANGE',
        rationale:
          `${contract.contractId} r${contract.revision} is FROZEN: no change of any kind is ` +
          'permitted without a new product decision, so adding to it is changing it.',
      };
    }
    return {
      ...shared,
      classification: 'EXISTING_CONTRACT_EXTENSION',
      rationale:
        `Adds capability to ${contract.contractId} r${contract.revision} ` +
        `(${contract.compatibilityPolicy}) without changing the meaning of anything already ` +
        `in it. Closest existing element: ${match.element.elementId}.`,
    };
  }

  // --- 3. Nothing existing is engaged --------------------------------------
  if (input.isNonGoal) {
    return {
      ...base,
      classification: 'NEW_DELEGATED_SURFACE',
      rationale:
        'An explicit exclusion stated by this specification. It creates authority — the ' +
        'authority not to build something — and engages no existing contract.',
    };
  }

  if (input.publicSurface) {
    return {
      ...base,
      classification: 'NEW_DELEGATED_SURFACE',
      rationale:
        `Creates a new public product surface (${input.surfaces.join(', ')}) that no existing ` +
        'contract covers. This specification is the authority for it; being public does not ' +
        'make it a change to an older promise.',
    };
  }

  return {
    ...base,
    classification: 'IMPLEMENTATION_DETAIL',
    rationale:
      'Names no durable product surface and engages no existing contract: ordinary ' +
      'engineering latitude the seal delegates.',
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface ElementMatch {
  element: IndexedElement;
  containment: number;
  same: boolean;
  /**
   * The statement IS the sealed one, allowing for case, spacing and trailing
   * punctuation. Stronger than `same`, which is a token-overlap threshold and
   * so admits "retries up to 3 times" / "retries up to 5 times".
   */
  restates: boolean;
}

/**
 * The form of a statement that survives being written down twice: case,
 * spacing and a trailing full stop carry no promise.
 */
function normalizeStatement(value: string): string {
  return value.toLowerCase().replace(WHITESPACE_RUN, ' ').replace(TRAILING_PUNCTUATION, '').trim();
}

function findBestMatch(input: ClassifyInput): ElementMatch | undefined {
  // An explicit contract id in the text is a match on its own — a
  // specification that says "CTR-004" is talking about CTR-004 whatever its
  // token overlap happens to be.
  const explicit = /\bCTR-\d{3,}\b/gi.exec(input.statement);
  if (explicit !== null) {
    const owned = input.index.byId.get((explicit[0] ?? '').toLowerCase());
    if (owned !== undefined) {
      const element = input.index.elements.find(
        (candidate) =>
          candidate.owner.contract.contractId === owned.contract.contractId &&
          candidate.elementKind === 'summary',
      );
      if (element !== undefined) {
        return { element, containment: 1, same: false, restates: false };
      }
    }
  }

  if (input.tokens.size < MIN_TOKENS_FOR_MATCH) return undefined;

  let best: ElementMatch | undefined;
  for (const element of input.index.elements) {
    if (element.tokens.size === 0) continue;
    const score = containment(input.tokens, element.tokens);
    if (score < MATCH_CONTAINMENT) continue;
    const same = jaccard(input.tokens, element.tokens) >= SAME_STATEMENT_JACCARD;
    const restates = normalizeStatement(input.statement) === normalizeStatement(element.statement);
    if (best === undefined || score > best.containment) {
      best = { element, containment: score, same, restates };
    }
  }
  return best;
}

/**
 * Whether two statements assert opposite things.
 *
 * Deliberately narrow. Real contradiction detection is a semantic problem
 * and this is a lexical function, so it only claims a contradiction in the
 * one shape it can actually see: two statements about the same subject where
 * exactly one is negated. Everything subtler is left to the classifier's
 * other branches, and ultimately to the vNext.10 NEEDS_AUTHORITY path during
 * implementation — which is the honest place for a conflict nobody could see
 * from the text.
 */
function contradicts(statement: string, existing: string): boolean {
  const statementNegated = NEGATION_PATTERN.test(statement);
  const existingNegated = NEGATION_PATTERN.test(existing);
  if (statementNegated === existingNegated) return false;
  const positive = statementNegated ? existing : statement;
  const negative = statementNegated ? statement : existing;
  // Strip the negation so the two are compared on their subject, not on the
  // word "not".
  const strippedNegative = negative.replace(NEGATION_PATTERN, ' ');
  return jaccard(tokenSet(positive), tokenSet(strippedNegative)) >= SAME_STATEMENT_JACCARD;
}

function findConstitutionClash(
  input: ClassifyInput,
): { missionId: string; ruleId: string; statement: string } | undefined {
  for (const rule of input.constitutionRules) {
    for (const source of rule.guardPatterns) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(source, 'i');
      } catch {
        continue;
      }
      if (pattern.test(input.statement)) {
        return { missionId: rule.missionId, ruleId: rule.ruleId, statement: rule.statement };
      }
    }
    if (contradicts(input.statement, rule.statement)) {
      return { missionId: rule.missionId, ruleId: rule.ruleId, statement: rule.statement };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Raising items
// ---------------------------------------------------------------------------

/**
 * Raise one item to `UNKNOWN_PRODUCT_AUTHORITY` because a question blocks it.
 *
 * RAISES ONLY, exactly like the mission package's materiality screen. A
 * question can make an item less settled than the classifier thought; it can
 * never make one MORE settled, because a question by definition means
 * something is unresolved.
 */
export function raiseItemForQuestion(
  item: DeltaItem,
  questionId: string,
  why: string,
): DeltaItem {
  if (item.classification === 'CONTRADICTION') {
    // Already the strongest classification; only the question link is added.
    return { ...item, questionId };
  }
  return {
    ...item,
    classification: 'UNKNOWN_PRODUCT_AUTHORITY',
    questionId,
    rationale: `${item.rationale} Raised to UNKNOWN_PRODUCT_AUTHORITY: ${why}`,
  };
}

/**
 * Re-settle an item whose blocking question a human answered.
 *
 * The answer is recorded as a mission decision with user provenance, so the
 * item is settled by AUTHORITY rather than by inference. Its class becomes
 * whatever it would have been without the question — recorded here as the
 * pre-raise class, which is why `raiseItemForQuestion` keeps the original
 * rationale in the text.
 */
export function settleItemWithAnswer(
  item: DeltaItem,
  settledClass: DeltaAuthorityClass,
  answer: string,
): DeltaItem {
  return {
    ...item,
    classification: settledClass,
    rationale: `${item.rationale} Settled by the recorded human answer: "${clip(answer, 300)}".`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statementOf(chunk: SourceChunk): string {
  return chunk.text.replace(/^(\s*)([-*+]|\d+[.)])\s+/, '').trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Digest of exactly what the analysis was computed FROM.
 *
 * Recorded on the analysis and copied onto the approval. If the repository's
 * contracts move afterwards, the digest moves, and the mismatch is visible
 * rather than absorbed — the same trick the seal's `policyFingerprint` plays
 * for autonomy policy.
 */
function computeBasisDigest(request: DeltaAnalysisRequest): string {
  const canonical = {
    chunks: request.chunks.map((chunk) => chunk.contentHash),
    contracts: request.existingContracts
      .map((owned) => `${owned.missionId}/${owned.contract.contractId}@${owned.contract.revision}`)
      .sort(),
    rules: request.constitutionRules
      .map((rule) => `${rule.missionId}/${rule.ruleId}`)
      .sort(),
    baselineCommit: request.grounding.baselineCommit,
  };
  return sha256Hex(JSON.stringify(canonical)).slice(0, 32);
}
