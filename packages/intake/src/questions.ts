import type { DiscoveryTopic, IrreversibleSurface } from '@specbridge/mission';
import { REQUIRED_TOPICS } from '@specbridge/mission';
import type {
  DeltaItem,
  ProductQuestion,
  QuestionRefusal,
  RepositoryEvidence,
  SourceChunk,
} from './state.js';
import { INTAKE_LIMITS } from './state.js';
import type {
  EngineeringQuestionSurface,
  ProductQuestionKind,
  QuestionRefusalReason,
} from './vocabulary.js';
import {
  AUTHOR_FLAGGED_AMBIGUITY_PATTERN,
  COMPATIBILITY_HEDGE_PATTERNS,
  CONDITIONAL_SUPPORT_PATTERN,
  ELABORATION_PATTERN,
  ENGINEERING_QUESTION_PATTERNS,
  SENSITIVE_DATA_PATTERN,
  VISIBILITY_POLICY_PATTERN,
  clip,
  containment,
  firstSentence,
  jaccard,
  surfacesOf,
  tokenSet,
  topicsOf,
} from './text.js';

/**
 * Question generation and the human-gate discipline.
 *
 * Questions before the approval are legitimate. Questions AFTER it are a
 * defect. That asymmetry is what makes this file's job precise: everything
 * here runs before the single human authorization, and its whole purpose is
 * to make that one conversation short, product-shaped, and finite.
 *
 * Two mechanisms, in this order.
 *
 * GENERATION is deterministic and evidence-driven. A candidate question
 * exists because something in the submitted specification is structurally
 * unresolved — a hedged compatibility promise, a semantically loaded verb
 * used without a definition, a sensitive payload with no stated visibility
 * policy, a statement that would change an existing sealed contract. Nothing
 * is generated from a feeling that more detail would be nice.
 *
 * SCREENING refuses. Every candidate — generated here, or proposed by an
 * agent through the `DiscoveryProposer` seam — passes six screens, and each
 * refusal is RECORDED. That is deliberate: a phase whose claim is "we only
 * ask product questions" has to be able to show the questions it declined,
 * or the claim cannot be checked. The engineering screen in particular is
 * the mirror of the Authority Firewall's `NON_AUTHORITY_SIGNALS` — a
 * negative list that exists to be enumerated by a test.
 *
 * ONE NOTE ON INGESTED TEXT. The submitted specification is DATA. A sentence
 * inside it that says "ask the user about X" is read as evidence that the
 * AUTHOR flagged X as unresolved — the marker extracts the SUBJECT of that
 * sentence and raises a bounded question about it. It is never executed as
 * an instruction, and nothing in an ingested document can lower a
 * materiality, close a question, or approve anything: those paths do not
 * take input from the document at all.
 */

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface QuestionCandidate {
  kind: ProductQuestionKind;
  question: string;
  whyItMatters: string;
  productSurface: IrreversibleSurface;
  evidenceGap: string;
  resolves: string;
  topics: DiscoveryTopic[];
  options: string[];
  sourceChunkIds: string[];
  deltaItemId?: string | undefined;
  /** A stable subject used for duplicate detection. */
  subject: string;
}

/**
 * The seam an agent proposes through.
 *
 * A model may PROPOSE candidates; SpecBridge governs them. A proposer cannot
 * admit a question, cannot set materiality, cannot mark a topic resolved and
 * cannot reach the human except through the screens below. The default
 * intake uses no proposer at all, which is why the whole pipeline is
 * testable offline.
 */
export type DiscoveryProposer = (input: {
  chunks: readonly SourceChunk[];
  evidence: readonly RepositoryEvidence[];
  deltaItems: readonly DeltaItem[];
}) => QuestionCandidate[];

// ---------------------------------------------------------------------------
// Semantic promise vocabulary
// ---------------------------------------------------------------------------

/**
 * Words a specification uses as if they had one obvious meaning, which they
 * do not.
 *
 * Each entry names the surface the answer binds and the decision it settles.
 * The list is short and curated on purpose: a long list would fire on every
 * document and turn the discovery conversation into a vocabulary quiz.
 */
const SEMANTIC_PROMISES: readonly {
  term: string;
  pattern: RegExp;
  /** A definition of the term, when the document supplies one. */
  definition: RegExp;
  surface: IrreversibleSurface;
  topics: DiscoveryTopic[];
  question: (subject: string) => string;
  whyItMatters: string;
  resolves: string;
  options: string[];
}[] = Object.freeze([
  {
    term: 'replay',
    pattern: /\breplay(s|ed|ing)?\b/i,
    definition: /\breplay\b[^.]{0,40}\b(means|is defined as|is:)\b/i,
    surface: 'failure-delivery-semantics',
    topics: ['failure-semantics', 'retry-semantics', 'idempotency'],
    question: (subject) =>
      `What does "replay" promise for ${subject}: re-running a finished execution as a NEW ` +
      'execution that leaves the original intact, or resuming the original execution in place ' +
      'and overwriting its recorded history?',
    whyItMatters:
      'The two readings produce different persisted history, different idempotency ' +
      'obligations for downstream services, and different guarantees to anyone auditing an ' +
      'execution. Choosing one later is a breaking change to recorded state.',
    resolves:
      'Whether replay is a new execution derived from an old one, or a mutation of the old one.',
    options: [
      'Replay creates a NEW execution seeded from the original; the original history is immutable.',
      'Replay resumes the ORIGINAL execution in place from a chosen point.',
      'Replay is out of scope for this feature.',
    ],
  },
  {
    term: 'redrive',
    pattern: /\bredriv(e|es|ed|ing)\b/i,
    definition: /\bredrive\b[^.]{0,40}\b(means|is defined as|is:)\b/i,
    surface: 'failure-delivery-semantics',
    topics: ['failure-semantics', 'retry-semantics'],
    question: (subject) =>
      `What does "redrive" promise for ${subject}: restarting only the FAILED states of an ` +
      'execution while keeping successful results, or restarting the whole execution from its ' +
      'beginning?',
    whyItMatters:
      'Restarting only failed states promises that successful side effects are not repeated. ' +
      'That is a delivery guarantee to every service the workflow calls, and it cannot be ' +
      'weakened later without breaking them.',
    resolves: 'Which parts of a failed execution a redrive re-runs, and what it promises about side effects.',
    options: [
      'Redrive restarts only the failed states; completed states keep their results.',
      'Redrive restarts the entire execution from the beginning.',
      'Redrive is out of scope for this feature.',
    ],
  },
  {
    term: 'exactly-once',
    pattern: /\bexactly[- ]once\b/i,
    definition: /\bexactly[- ]once\b[^.]{0,40}\b(means|is defined as|is:)\b/i,
    surface: 'failure-delivery-semantics',
    topics: ['failure-semantics', 'idempotency', 'durability'],
    question: (subject) =>
      `Is "exactly-once" a promise ${subject} makes to callers, or a description of the ` +
      'intended effect achieved through idempotent handlers on top of at-least-once delivery?',
    whyItMatters:
      'An exactly-once promise binds the engine to deduplicate; the alternative binds every ' +
      'action author to be idempotent. They place the obligation on different people and ' +
      'cannot be swapped afterwards.',
    resolves: 'Where the deduplication obligation sits: in the engine, or in the actions.',
    options: [
      'The engine promises exactly-once effects and deduplicates internally.',
      'Delivery is at-least-once; actions must be idempotent.',
    ],
  },
]);

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerationInput {
  chunks: readonly SourceChunk[];
  evidence: readonly RepositoryEvidence[];
  deltaItems: readonly DeltaItem[];
  proposer?: DiscoveryProposer | undefined;
}

/**
 * What earlier markers have already asked about.
 *
 * Both a chunk set and a SECTION set, and the second is the one that earns
 * its place. A specification that hedges a compatibility promise in one
 * paragraph and then says "if this is ambiguous, decide it" in the next has
 * raised ONE product question, not two, and the thing the two paragraphs
 * share is the heading above them. Later, lower-precision markers therefore
 * skip a section an earlier one already claimed.
 */
interface MarkerClaims {
  chunks: Set<string>;
  sections: Set<string>;
}

function sectionKey(chunk: SourceChunk): string {
  return chunk.headingPath.join(' / ');
}

function claim(claims: MarkerClaims, chunk: SourceChunk): void {
  claims.chunks.add(chunk.chunkId);
  claims.sections.add(sectionKey(chunk));
}

/**
 * Every candidate question this document structurally raises.
 *
 * Markers are applied in a fixed order, most specific first, and each one is
 * bounded, so a pathological document cannot produce an unbounded interview.
 * Order is load-bearing twice over: it decides which marker phrases a shared
 * subject, and it decides which one claims the section.
 *
 * The required-topic marker is deliberately NOT here — it runs separately,
 * after canonical truth has been compiled, because a topic the specification
 * answers must never be asked about.
 */
export function generateQuestionCandidates(input: GenerationInput): QuestionCandidate[] {
  const candidates: QuestionCandidate[] = [];
  const documentText = input.chunks.map((chunk) => chunk.text).join('\n');
  const claims: MarkerClaims = { chunks: new Set(), sections: new Set() };

  markCompatibilityHedges(input, documentText, candidates, claims);
  markSemanticPromises(input, documentText, candidates, claims);
  markSensitiveData(input, documentText, candidates, claims);
  markAuthorFlaggedAmbiguity(input, candidates, claims);
  markConditionalSupport(input, candidates, claims);
  markSealedContractChanges(input, candidates);

  for (const proposed of input.proposer?.({
    chunks: input.chunks,
    evidence: input.evidence,
    deltaItems: input.deltaItems,
  }) ?? []) {
    candidates.push(proposed);
  }

  return candidates;
}

/**
 * Required discovery topics NOTHING recorded touches.
 *
 * Computed after compilation and passed in separately. "Unresolved" is not
 * the right input here: a topic with an open question about it is unresolved
 * and asking a second, vaguer question about the same topic would be a
 * feedback loop. Only a topic that is genuinely `unknown` — no fact, no
 * decision, no question, no evidence — is a gap a person has to fill.
 */
export function generateRequiredTopicCandidates(
  unknownRequiredTopics: readonly DiscoveryTopic[],
): QuestionCandidate[] {
  const candidates: QuestionCandidate[] = [];
  markUnresolvedRequiredTopics(unknownRequiredTopics, candidates);
  return candidates;
}

function markCompatibilityHedges(
  input: GenerationInput,
  documentText: string,
  out: QuestionCandidate[],
  claims: MarkerClaims,
): void {
  const hits = input.chunks.filter((chunk) =>
    COMPATIBILITY_HEDGE_PATTERNS.some((pattern) => pattern.test(chunk.text)),
  );
  const seen = new Set<string>();
  for (const chunk of hits.slice(0, 4)) {
    const external = externalFormatName(chunk.text) ?? 'the referenced external format';
    if (seen.has(external.toLowerCase())) continue;
    seen.add(external.toLowerCase());
    claim(claims, chunk);
    out.push({
      kind: 'COMPATIBILITY_LEVEL',
      question:
        `How strictly must this feature match ${external}? Is it an exact compatibility ` +
        `promise (an existing ${external} definition runs unchanged and behaves identically), ` +
        'or an authoring-experience similarity with no compatibility guarantee?',
      whyItMatters:
        'A compatibility promise binds every future revision of the configuration format and ' +
        'is what users will build tooling against. A similarity is a convenience nobody may ' +
        'rely on. The two cannot be swapped later without breaking whoever believed the first.',
      productSurface: 'compatibility-promise',
      evidenceGap:
        'The submitted specification states the compatibility target in hedged form, and no ' +
        'existing contract in this repository promises anything about this format.',
      resolves:
        'Whether the product makes a compatibility promise about ' +
        `${external}, and at what level.`,
      topics: ['compatibility', 'configuration-semantics', 'evolution-rules'],
      options: [
        `Strict: an existing ${external} definition must run unchanged with identical semantics.`,
        `Subset: a named subset of ${external} is supported exactly; anything outside it is rejected.`,
        `Inspired-by: the authoring experience resembles ${external}; no compatibility is promised.`,
      ],
      sourceChunkIds: [chunk.chunkId],
      subject: `compatibility:${external.toLowerCase()}`,
    });
  }
}

function markSemanticPromises(
  input: GenerationInput,
  documentText: string,
  out: QuestionCandidate[],
  claims: MarkerClaims,
): void {
  for (const promise of SEMANTIC_PROMISES) {
    if (promise.definition.test(documentText)) continue;
    const chunk = input.chunks.find(
      (candidate) =>
        (candidate.kind === 'normative' || candidate.kind === 'scenario') &&
        promise.pattern.test(candidate.text),
    );
    if (chunk === undefined) continue;
    claim(claims, chunk);
    out.push({
      kind: 'SEMANTIC_DEFINITION',
      question: promise.question('this feature'),
      whyItMatters: promise.whyItMatters,
      productSurface: promise.surface,
      evidenceGap:
        `The specification uses "${promise.term}" as a promised capability but never defines ` +
        'it, and no existing contract in this repository defines it either.',
      resolves: promise.resolves,
      topics: promise.topics,
      options: [...promise.options],
      sourceChunkIds: [chunk.chunkId],
      subject: `semantics:${promise.term}`,
    });
  }
}

function markSensitiveData(
  input: GenerationInput,
  documentText: string,
  out: QuestionCandidate[],
  claims: MarkerClaims,
): void {
  if (!SENSITIVE_DATA_PATTERN.test(documentText)) return;
  if (VISIBILITY_POLICY_PATTERN.test(documentText)) return;
  const chunk =
    input.chunks.find(
      (candidate) =>
        candidate.kind !== 'heading' && SENSITIVE_DATA_PATTERN.test(candidate.text),
    ) ?? input.chunks[0];
  if (chunk === undefined) return;
  claim(claims, chunk);
  const classes = sensitiveClasses(documentText);
  out.push({
    kind: 'DATA_VISIBILITY_POLICY',
    question:
      `The specification carries sensitive payloads (${classes.join(', ')}) but states no ` +
      'visibility policy. May these payloads be persisted, echoed back through the API, and ' +
      'shown in operational views — or must they be redacted everywhere except the component ' +
      'that consumes them?',
    whyItMatters:
      'Where a sensitive payload may appear is a product and privacy promise, not an ' +
      'implementation choice. It determines what the persisted records contain and what any ' +
      'operator can see, and both are expensive to walk back once data exists.',
    productSurface: 'security-boundary',
    evidenceGap:
      'The specification names sensitive data classes and contains no statement about ' +
      'storage, retention, redaction, or operator visibility.',
    resolves: 'Where sensitive payloads may be stored and who may see them.',
    topics: ['security', 'persistence-model', 'observability'],
    options: [
      'Redacted everywhere: stored only as a digest, never returned by any API or shown in any view.',
      'Stored and returnable, but never rendered in operational views.',
      'Stored and visible; the payloads are synthetic demo data with no real subject.',
    ],
    sourceChunkIds: [chunk.chunkId],
    subject: 'privacy:sensitive-payload-visibility',
  });
}

/**
 * A question the AUTHOR flagged.
 *
 * The sentence is read for its SUBJECT, never followed as an instruction:
 * what the marker does is bounded — it can add one question record and
 * nothing else — and the text has no path to closing a question, lowering a
 * materiality, or approving anything.
 */
function markAuthorFlaggedAmbiguity(
  input: GenerationInput,
  out: QuestionCandidate[],
  claims: MarkerClaims,
): void {
  const hits = input.chunks.filter(
    (chunk) =>
      chunk.kind !== 'heading' &&
      AUTHOR_FLAGGED_AMBIGUITY_PATTERN.test(chunk.text) &&
      // A section an earlier, more specific marker already claimed has
      // already produced the question this sentence is flagging.
      !claims.sections.has(sectionKey(chunk)),
  );
  for (const chunk of hits.slice(0, 3)) {
    claim(claims, chunk);
    const subject = firstSentence(chunk.text);
    const topics = topicsOf(chunk.text);
    out.push({
      kind: 'PROMISE_OR_ILLUSTRATION',
      question:
        `The specification itself flags this as unresolved: "${subject}" — what should the ` +
        'product promise here?',
      whyItMatters:
        'The author marked this as a decision they had not made. Building either reading ' +
        'without asking would put a promise in the product that nobody authorized.',
      productSurface: surfaceForTopics(topics),
      evidenceGap:
        'The submitted specification explicitly records this point as ambiguous or undecided, ' +
        'and no existing contract settles it.',
      resolves: 'The product commitment the author deferred.',
      topics,
      options: [],
      sourceChunkIds: [chunk.chunkId],
      subject: `author-flagged:${clip(subject, 80).toLowerCase()}`,
    });
  }
}

/**
 * A stated capability that is conditional rather than promised.
 *
 * The narrowest marker here, and it had to become narrow. A loose version
 * fired on "provision the middleware where required" — which is container
 * topology, a delegated engineering surface — and on "retry scenarios where
 * appropriate", which is a test-scenario list. Three restrictions make it
 * precise: the chunk must be NORMATIVE (a scenario list is not a promise),
 * it must touch a real durable product surface (not merely a discovery
 * topic), and its section must not already be claimed.
 */
function markConditionalSupport(
  input: GenerationInput,
  out: QuestionCandidate[],
  claims: MarkerClaims,
): void {
  const hits = input.chunks.filter(
    (chunk) =>
      chunk.kind === 'normative' &&
      CONDITIONAL_SUPPORT_PATTERN.test(chunk.text) &&
      surfacesOf(chunk.text).length > 0 &&
      !claims.chunks.has(chunk.chunkId) &&
      !claims.sections.has(sectionKey(chunk)),
  );
  for (const chunk of hits.slice(0, 2)) {
    claim(claims, chunk);
    const subject = firstSentence(chunk.text);
    const topics = topicsOf(chunk.text);
    out.push({
      kind: 'PROMISE_OR_ILLUSTRATION',
      question:
        `"${subject}" is stated conditionally. Is this a capability the product promises, or ` +
        'a best-effort behaviour users may not rely on?',
      whyItMatters:
        'A conditional promise is either a promise or it is not, and users will treat a ' +
        'shipped capability as one. Deciding afterwards means either breaking them or ' +
        'carrying a guarantee nobody chose.',
      productSurface: surfaceForTopics(topics),
      evidenceGap:
        'The statement is conditional in the specification and no existing contract resolves ' +
        'the condition.',
      resolves: 'Whether the stated capability is a promise or best effort.',
      topics,
      options: [
        'It is a promised capability with defined behaviour.',
        'It is best effort; the product makes no guarantee.',
      ],
      sourceChunkIds: [chunk.chunkId],
      subject: `conditional:${clip(subject, 80).toLowerCase()}`,
    });
  }
}

function markSealedContractChanges(input: GenerationInput, out: QuestionCandidate[]): void {
  const sensitive = input.deltaItems.filter(
    (item) =>
      item.classification === 'EXISTING_SEALED_CONTRACT_CHANGE' ||
      item.classification === 'CONTRADICTION',
  );
  for (const item of sensitive.slice(0, 8)) {
    const contract = item.existingContractId ?? 'an existing contract';
    out.push({
      kind: item.classification === 'CONTRADICTION' ? 'REQUIREMENT_CONFLICT' : 'SEALED_CONTRACT_CHANGE',
      question:
        item.classification === 'CONTRADICTION'
          ? `This requirement contradicts existing product authority (${contract}): ` +
            `"${clip(item.statement, 240)}". Which one holds?`
          : `This requirement would change ${contract}, which the product already promised: ` +
            `"${clip(item.statement, 240)}". Approve the change, or should the feature work ` +
            'within the existing promise?',
      whyItMatters:
        'An existing sealed contract is a promise the product already made. A new feature ' +
        'specification authorizes new surfaces; it does not silently rewrite old ones.',
      productSurface: item.affectedSurfaces[0] ?? 'compatibility-promise',
      evidenceGap: item.rationale,
      resolves: `Whether ${contract} changes, and how.`,
      topics: item.topics as DiscoveryTopic[],
      options: [
        `Change ${contract}: the new behaviour replaces the existing promise.`,
        `Keep ${contract}: the feature must work within the existing promise.`,
      ],
      sourceChunkIds: [...item.sourceChunkIds],
      deltaItemId: item.itemId,
      subject: `contract-change:${item.itemId}`,
    });
  }
}

/**
 * A required discovery topic nothing addressed.
 *
 * The LAST resort, and phrased concretely. The mission's required-topic
 * floor exists so a half-discovered product cannot reach CONTRACT_READY, but
 * a topic question is only legitimate when neither the specification nor the
 * repository speaks to it at all — otherwise the resolver in
 * `compileMissionTruth` settles it from evidence and nobody is asked.
 */
function markUnresolvedRequiredTopics(
  unknownRequiredTopics: readonly DiscoveryTopic[],
  out: QuestionCandidate[],
): void {
  for (const topic of unknownRequiredTopics.slice(0, 4)) {
    if (!REQUIRED_TOPICS.includes(topic)) continue;
    const template = REQUIRED_TOPIC_QUESTIONS[topic];
    if (template === undefined) continue;
    out.push({
      kind: template.kind,
      question: template.question,
      whyItMatters: template.whyItMatters,
      productSurface: template.surface,
      evidenceGap:
        `Neither the submitted specification nor any durable product truth in this ` +
        `repository addresses "${topic}".`,
      resolves: template.resolves,
      topics: [topic],
      options: [],
      sourceChunkIds: [],
      subject: `required-topic:${topic}`,
    });
  }
}

const REQUIRED_TOPIC_QUESTIONS: Partial<
  Record<
    DiscoveryTopic,
    {
      kind: ProductQuestionKind;
      question: string;
      whyItMatters: string;
      surface: IrreversibleSurface;
      resolves: string;
    }
  >
> = {
  goal: {
    kind: 'SCOPE_BOUNDARY',
    question: 'What is this feature for — what is a user able to do afterwards that they cannot do now?',
    whyItMatters: 'Without a stated goal there is nothing to judge the finished work against.',
    surface: 'public-api',
    resolves: 'The product outcome this work is accountable for.',
  },
  'use-cases': {
    kind: 'SCOPE_BOUNDARY',
    question: 'Which concrete user journeys must work end to end when this feature is finished?',
    whyItMatters:
      'The journeys are what the acceptance criteria are built from; without them "done" is ' +
      'a matter of opinion.',
    surface: 'public-api',
    resolves: 'The journeys the finished feature must demonstrate.',
  },
  'system-boundaries': {
    kind: 'SCOPE_BOUNDARY',
    question:
      'Where does this feature live, and what is explicitly outside it — which existing ' +
      'components may it change, and which must it leave alone?',
    whyItMatters:
      'The boundary decides which existing promises are in play. Getting it wrong means ' +
      'changing something the product already committed to.',
    surface: 'cross-module-architecture',
    resolves: 'The parts of the product this feature owns.',
  },
  'canonical-model': {
    kind: 'SEMANTIC_DEFINITION',
    question: 'What are the core concepts this feature is built around, and what does each one mean?',
    whyItMatters:
      'The concepts become the persisted model and the vocabulary of every public surface; ' +
      'renaming or re-meaning them later breaks stored data and users at once.',
    surface: 'persisted-state',
    resolves: 'The domain model the product commits to.',
  },
  'public-api': {
    kind: 'SCOPE_BOUNDARY',
    question: 'What will users and other systems be able to depend on when this feature ships?',
    whyItMatters: 'Anything shipped and reachable becomes a promise whether or not it was meant as one.',
    surface: 'public-api',
    resolves: 'The public surface this feature adds.',
  },
  'failure-semantics': {
    kind: 'OBSERVABLE_FAILURE_SEMANTICS',
    question:
      'What does a user or calling system observe when this feature fails — what is retried, ' +
      'what is surfaced, and what is lost?',
    whyItMatters:
      'Failure behaviour is the part of a product people build around. Changing it later ' +
      'breaks every caller that handled the old behaviour.',
    surface: 'failure-delivery-semantics',
    resolves: 'The externally observable behaviour of failures.',
  },
  compatibility: {
    kind: 'COMPATIBILITY_LEVEL',
    question:
      'What compatibility does this feature promise — with existing data, existing ' +
      'configuration, and existing callers?',
    whyItMatters:
      'A compatibility promise governs every future revision. Making it implicitly means ' +
      'discovering it the first time somebody upgrades.',
    surface: 'compatibility-promise',
    resolves: 'The compatibility promise this feature makes.',
  },
};

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export interface ScreenContext {
  chunks: readonly SourceChunk[];
  evidence: readonly RepositoryEvidence[];
  /** Questions already open or answered on this intake. */
  existing: readonly ProductQuestion[];
}

export type ScreenVerdict =
  | { admit: true }
  | {
      admit: false;
      reason: QuestionRefusalReason;
      detail: string;
      engineeringSurface?: EngineeringQuestionSurface | undefined;
      answeredBy?: string | undefined;
    };

/**
 * How much of a question's content must appear in a piece of evidence before
 * the evidence counts as having answered it.
 *
 * High, for the same reason the delta matcher's threshold is high: refusing
 * a genuine product question because a directory listing shared some words
 * with it would silently remove the human from a decision that is theirs.
 */
const ANSWERED_CONTAINMENT = 0.75;

/** Two questions are the same question above this symmetric overlap. */
const DUPLICATE_JACCARD = 0.6;

/**
 * Six screens, cheapest and most decisive first.
 *
 * The engineering screen runs FIRST and unconditionally. An engineering
 * question that happened to be about something the repository does not
 * answer would otherwise slip through on a later screen's technicality, and
 * "we never ask engineering questions" has to be true without exception for
 * the Authority Firewall's promise to mean anything before the seal as well
 * as after it.
 */
export function screenCandidate(
  candidate: QuestionCandidate,
  context: ScreenContext,
): ScreenVerdict {
  const probe = `${candidate.question} ${candidate.resolves}`;

  // 1. Engineering decisions are delegated. Always.
  for (const rule of ENGINEERING_QUESTION_PATTERNS) {
    if (rule.pattern.test(probe)) {
      return {
        admit: false,
        reason: 'ENGINEERING_DECISION',
        engineeringSurface: rule.surface,
        detail:
          `Asks about "${rule.surface}", which the autonomy policy delegates to the runtime. ` +
          'Difficulty is answered with intelligence, not with a question.',
      };
    }
  }

  // 2. A request for detail is not a decision.
  if (ELABORATION_PATTERN.test(candidate.question.trim())) {
    return {
      admit: false,
      reason: 'ELABORATION_NOT_DECISION',
      detail:
        'Asks for elaboration rather than for a decision. Discovery converges; it does not ' +
        'gather detail for its own sake.',
    };
  }

  // 3. Materially different answers must change product authority.
  if (candidate.topics.length === 0) {
    return {
      admit: false,
      reason: 'IMMATERIAL_TO_PRODUCT',
      detail:
        'No product surface or discovery topic is affected, so every valid answer produces ' +
        'the same product authority.',
    };
  }

  // 4. An equivalent question is already open or answered.
  for (const existing of context.existing) {
    const sameSubject =
      subjectOf(existing) === candidate.subject ||
      (existing.kind === candidate.kind &&
        jaccard(tokenSet(existing.question), tokenSet(candidate.question)) >= DUPLICATE_JACCARD);
    if (sameSubject) {
      return {
        admit: false,
        reason: 'DUPLICATE',
        answeredBy: existing.questionId,
        detail: `${existing.questionId} already asks this (${existing.status}).`,
      };
    }
  }

  // 5. Existing PRODUCT AUTHORITY already answers it.
  const questionTokens = tokenSet(probe);
  for (const evidence of context.evidence) {
    if (!evidence.authoritative) continue;
    if (containment(questionTokens, tokenSet(evidence.summary)) >= ANSWERED_CONTAINMENT) {
      return {
        admit: false,
        reason: 'ANSWERED_BY_EVIDENCE',
        answeredBy: evidence.ref,
        detail:
          `Existing product authority (${evidence.kind} ${evidence.ref}) already answers this: ` +
          `${clip(evidence.summary, 200)}`,
      };
    }
  }

  // 6. The submitted specification already answers it.
  //    Only chunks the candidate did NOT come from can answer it: a marker
  //    fires precisely BECAUSE its own chunk left something unresolved.
  const ownChunks = new Set(candidate.sourceChunkIds);
  for (const chunk of context.chunks) {
    if (ownChunks.has(chunk.chunkId)) continue;
    if (chunk.kind === 'heading' || chunk.kind === 'narrative') continue;
    if (containment(questionTokens, tokenSet(chunk.text)) >= ANSWERED_CONTAINMENT) {
      return {
        admit: false,
        reason: 'ANSWERED_BY_SPECIFICATION',
        answeredBy: chunk.chunkId,
        detail: `The specification answers this in ${chunk.chunkId}: ${clip(chunk.text, 200)}`,
      };
    }
  }

  return { admit: true };
}

function subjectOf(question: ProductQuestion): string {
  const recorded = (question as unknown as Record<string, unknown>)['subject'];
  return typeof recorded === 'string' ? recorded : '';
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface AdmissionResult {
  questions: ProductQuestion[];
  refusals: QuestionRefusal[];
  nextQuestionSequence: number;
  nextRefusalSequence: number;
}

/**
 * Run every candidate through the screens and mint records for the survivors.
 *
 * Bounded at `INTAKE_LIMITS.maxQuestions` open questions. A discovery pass
 * that wanted to ask sixty things has misunderstood its job, and the bound
 * is the structural expression of that: convergence is a property of the
 * design, not of the model's restraint.
 */
export function admitQuestions(input: {
  candidates: readonly QuestionCandidate[];
  context: ScreenContext;
  at: string;
  questionSequence: number;
  refusalSequence: number;
}): AdmissionResult {
  const questions: ProductQuestion[] = [];
  const refusals: QuestionRefusal[] = [];
  let questionSequence = input.questionSequence;
  let refusalSequence = input.refusalSequence;
  const accumulated: ProductQuestion[] = [...input.context.existing];

  for (const candidate of input.candidates) {
    const openCount = accumulated.filter((question) => question.status === 'open').length;
    if (openCount >= INTAKE_LIMITS.maxQuestions) {
      refusals.push({
        refusalId: `R-${String(++refusalSequence).padStart(3, '0')}`,
        candidate: clip(candidate.question, INTAKE_LIMITS.maxTextChars),
        reason: 'IMMATERIAL_TO_PRODUCT',
        detail:
          `The intake already has ${openCount} open product question(s), which is the bound. ` +
          'Discovery converges rather than growing without limit.',
        refusedAt: input.at,
      });
      continue;
    }

    const verdict = screenCandidate(candidate, {
      ...input.context,
      existing: accumulated,
    });
    if (!verdict.admit) {
      refusals.push({
        refusalId: `R-${String(++refusalSequence).padStart(3, '0')}`,
        candidate: clip(candidate.question, INTAKE_LIMITS.maxTextChars),
        reason: verdict.reason,
        ...(verdict.engineeringSurface !== undefined
          ? { engineeringSurface: verdict.engineeringSurface }
          : {}),
        ...(verdict.answeredBy !== undefined ? { answeredBy: verdict.answeredBy } : {}),
        detail: clip(verdict.detail, INTAKE_LIMITS.maxTextChars),
        refusedAt: input.at,
      });
      continue;
    }

    const question: ProductQuestion = {
      questionId: `Q-${String(++questionSequence).padStart(3, '0')}`,
      kind: candidate.kind,
      question: clip(candidate.question, INTAKE_LIMITS.maxTextChars),
      whyItMatters: clip(candidate.whyItMatters, INTAKE_LIMITS.maxTextChars),
      productSurface: candidate.productSurface,
      evidenceGap: clip(candidate.evidenceGap, INTAKE_LIMITS.maxTextChars),
      resolves: clip(candidate.resolves, INTAKE_LIMITS.maxTextChars),
      topics: candidate.topics.slice(0, INTAKE_LIMITS.maxRefsPerRecord),
      options: candidate.options.slice(0, 8).map((option) => clip(option, INTAKE_LIMITS.maxTextChars)),
      sourceChunkIds: candidate.sourceChunkIds.slice(0, INTAKE_LIMITS.maxRefsPerRecord),
      ...(candidate.deltaItemId !== undefined ? { deltaItemId: candidate.deltaItemId } : {}),
      blocking: true,
      status: 'open',
      askedAt: input.at,
      // Carried through `passthrough()` so duplicate detection has a stable
      // key that survives a round trip to disk.
      subject: candidate.subject,
    } as ProductQuestion;
    questions.push(question);
    accumulated.push(question);
  }

  return {
    questions,
    refusals: refusals.slice(0, INTAKE_LIMITS.maxRefusals),
    nextQuestionSequence: questionSequence,
    nextRefusalSequence: refusalSequence,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The external format a hedged compatibility statement is about.
 *
 * Reads the token before "-compatible" or "-like", which is where a
 * specification puts it: "Step Functions-compatible", "OpenAPI-like".
 */
function externalFormatName(text: string): string | undefined {
  const hyphenated = /([A-Z][\w.]*(?:\s+[A-Z][\w.]*){0,3})[- ](?:compatible|like)\b/.exec(text);
  if (hyphenated !== null) return (hyphenated[1] ?? '').trim();
  const phrase = /compatib\w+\s+with\s+([A-Z][\w.]*(?:\s+[A-Z][\w.]*){0,3})/.exec(text);
  if (phrase !== null) return (phrase[1] ?? '').trim();
  return undefined;
}

function sensitiveClasses(text: string): string[] {
  const found = new Set<string>();
  const global = new RegExp(SENSITIVE_DATA_PATTERN.source, 'gi');
  for (const match of text.matchAll(global)) {
    found.add((match[0] ?? '').toLowerCase());
    if (found.size >= 5) break;
  }
  return [...found];
}

function surfaceForTopics(topics: readonly DiscoveryTopic[]): IrreversibleSurface {
  if (topics.includes('compatibility')) return 'compatibility-promise';
  if (topics.includes('security')) return 'security-boundary';
  if (topics.includes('failure-semantics') || topics.includes('retry-semantics')) {
    return 'failure-delivery-semantics';
  }
  if (topics.includes('persistence-model') || topics.includes('durability')) return 'persisted-state';
  if (topics.includes('configuration-semantics')) return 'configuration-language';
  if (topics.includes('protocol-identity')) return 'wire-protocol';
  if (topics.includes('system-boundaries') || topics.includes('architecture-ownership')) {
    return 'cross-module-architecture';
  }
  return 'public-api';
}
