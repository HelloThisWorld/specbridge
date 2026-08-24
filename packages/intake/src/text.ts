import type { DiscoveryTopic, IrreversibleSurface } from '@specbridge/mission';

/**
 * Deterministic text analysis shared by the delta classifier and the
 * question generator.
 *
 * Everything here is a pure function over strings and frozen tables. There
 * is no model, no scoring model that was trained on anything, and no
 * randomness — an intake that classified differently on a second run would
 * produce a different approval from the same document, and the whole
 * derived-approval argument rests on that not happening.
 *
 * The tables below are the honest limit of the approach: they recognise the
 * VOCABULARY of product commitments, not their meaning. That is why the
 * output of this file is never a decision — it feeds classifications that
 * either resolve against durable evidence or become a question for a person.
 */

// ---------------------------------------------------------------------------
// Tokenisation and overlap
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
  'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'cannot',
  'could', 'did', 'do', 'does', 'doing', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'must', 'my', 'no', 'nor', 'not',
  'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'out', 'over',
  'own', 'same', 'shall', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'use', 'used', 'using', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/** Content tokens: lowercased, stop-worded, de-pluralised, length-filtered. */
export function tokenize(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/**
 * A deliberately crude suffix stemmer.
 *
 * Crude is correct here: an aggressive stemmer conflates words that name
 * different product surfaces ("execution" and "executor" are not the same
 * thing) and a classifier that conflates them mis-files authority.
 */
function stem(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

export function tokenSet(value: string): Set<string> {
  return new Set(tokenize(value));
}

/**
 * How much of `needle` is present in `haystack`, 0..1.
 *
 * Containment rather than Jaccard on purpose. A one-line requirement
 * compared against a whole contract summary scores near zero under Jaccard
 * purely because the summary is longer, and "is this requirement already
 * promised?" is a containment question, not a similarity question.
 */
export function containment(needle: Set<string>, haystack: Set<string>): number {
  if (needle.size === 0) return 0;
  let hits = 0;
  for (const token of needle) if (haystack.has(token)) hits += 1;
  return hits / needle.size;
}

/** Symmetric overlap, for deciding whether two statements are the same one. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Product surfaces
// ---------------------------------------------------------------------------

interface SurfaceRule {
  surface: IrreversibleSurface;
  topics: readonly DiscoveryTopic[];
  pattern: RegExp;
}

/**
 * Vocabulary that marks a statement as touching a durable product surface.
 *
 * Read this as "what would be expensive to change later", not "what sounds
 * important". The list is what the mission package's irreversibility screen
 * already names, expressed in the words real specifications use.
 */
const SURFACE_RULES: readonly SurfaceRule[] = Object.freeze([
  {
    surface: 'public-api',
    topics: ['public-api'],
    pattern:
      /\b(public api|rest (api|endpoint|controller)|endpoint|http api|graphql|sdk|cli command|command-line interface|public interface|console|dashboard|ui|user interface|screen|page|visualization|visualisation|workbench)\b/i,
  },
  {
    surface: 'wire-protocol',
    topics: ['protocol-identity'],
    pattern:
      /\b(wire (format|protocol)|protocol|message format|event schema|payload format|serializ\w+ format|topic layout|envelope)\b/i,
  },
  {
    surface: 'persisted-state',
    topics: ['persistence-model', 'durability'],
    pattern:
      /\b(persist\w*|stored (format|representation)|database (schema|migration)|migration|on-disk|durable (state|record))\b/i,
  },
  {
    surface: 'configuration-language',
    topics: ['configuration-semantics'],
    pattern:
      /\b(configuration (file|format|language|schema)|config format|workflow (definition|configuration|authoring)|dsl|authoring experience|state machine (definition|language))\b/i,
  },
  {
    surface: 'sdk-contract',
    topics: ['public-api', 'extension-seams'],
    pattern: /\b(sdk|client library|action sdk|public library|api client)\b/i,
  },
  {
    surface: 'extension-spi',
    topics: ['extension-seams'],
    pattern: /\b(plugin|extension point|spi|adapter interface|hook interface)\b/i,
  },
  {
    surface: 'compatibility-promise',
    topics: ['compatibility', 'evolution-rules'],
    pattern:
      /\b(compatib\w+|interoperab\w+|conform\w+ to|drop-in|backwards?[- ]compatible|standard-compliant|spec-compliant)\b/i,
  },
  {
    surface: 'security-boundary',
    topics: ['security'],
    pattern:
      /\b(authenticat\w+|authoriz\w+|permission|credential|secret|token|encrypt\w*|biometric|face (photo|data|image)|passport|personal data|pii|privacy|sensitive|redact\w*|retention)\b/i,
  },
  {
    surface: 'failure-delivery-semantics',
    topics: ['failure-semantics', 'retry-semantics', 'timeout-semantics'],
    pattern:
      /\b(at-least-once|at-most-once|exactly-once|delivery semantics|retry|retries|timeout|redriv\w+|replay\w*|resume|rollback|compensat\w+|dead[- ]letter|failure semantics|idempoten\w+)\b/i,
  },
  {
    surface: 'cross-module-architecture',
    topics: ['system-boundaries', 'architecture-ownership'],
    pattern:
      /\b(subproject|submodule|separate (module|service|repository)|module boundary|owns? (control flow|business logic)|architecture)\b/i,
  },
]);

export interface SurfaceMatch {
  surface: IrreversibleSurface;
  topics: readonly DiscoveryTopic[];
}

/** Every durable surface a statement touches, in table order. */
export function surfacesOf(statement: string): SurfaceMatch[] {
  const out: SurfaceMatch[] = [];
  for (const rule of SURFACE_RULES) {
    if (rule.pattern.test(statement)) out.push({ surface: rule.surface, topics: rule.topics });
  }
  return out;
}

/** Topics a statement speaks to, derived from the surfaces it touches. */
export function topicsOf(statement: string): DiscoveryTopic[] {
  const topics = new Set<DiscoveryTopic>();
  for (const match of surfacesOf(statement)) {
    for (const topic of match.topics) topics.add(topic);
  }
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(statement)) topics.add(rule.topic);
  }
  return [...topics];
}

/**
 * Topic vocabulary beyond the durable-surface table.
 *
 * A statement can be squarely about use cases or system boundaries without
 * touching anything irreversible, and the mission's required-topic floor
 * still needs to see it.
 */
const TOPIC_RULES: readonly { topic: DiscoveryTopic; pattern: RegExp }[] = Object.freeze([
  { topic: 'goal', pattern: /\b(goal|objective|purpose|the (feature|product) (must|should|will)|deliver)\b/i },
  {
    topic: 'use-cases',
    pattern:
      /\b(use case|scenario|workflow|user (can|must|should)|end to end|end-to-end|demo|walkthrough|journey|edge case)\b/i,
  },
  {
    topic: 'system-boundaries',
    pattern:
      /\b(inside the (existing )?repository|same repository|subproject|module|service|application|boundary|frontend|backend|console|infrastructure)\b/i,
  },
  {
    topic: 'canonical-model',
    pattern:
      /\b(model|entity|entities|concept|definition|domain|schema|state graph|abstraction|generic (concepts?|model))\b/i,
  },
  {
    topic: 'failure-semantics',
    pattern: /\b(fail\w*|error|invalid|malformed|missing|mismatch\w*|timeout|retry|reject\w*)\b/i,
  },
  { topic: 'observability', pattern: /\b(log|logging|metric|trace|observab\w+|monitor\w*|inspect)\b/i },
  { topic: 'security', pattern: /\b(secur\w+|privacy|sensitive|credential|auth\w*)\b/i },
  { topic: 'performance', pattern: /\b(performance|latency|throughput|scale|concurren\w+)\b/i },
  { topic: 'non-goals', pattern: /\b(non-?goal|out of scope|not in scope|must not|will not)\b/i },
  {
    topic: 'compatibility',
    pattern: /\b(compatib\w+|version\w*|breaking change|backwards?)\b/i,
  },
  {
    topic: 'public-api',
    pattern: /\b(api|endpoint|interface|console|command|contract)\b/i,
  },
]);

// ---------------------------------------------------------------------------
// Change and contradiction vocabulary
// ---------------------------------------------------------------------------

/**
 * Verbs that mean "the existing promise becomes something else".
 *
 * Matching one of these against a statement that ALSO matches an existing
 * contract is what separates extending a product from rewriting it.
 */
/** Any run of whitespace, including the newlines a re-wrapped paragraph gains. */
export const WHITESPACE_RUN = /\s+/g;

/** Sentence-final punctuation, which carries no promise. */
export const TRAILING_PUNCTUATION = /[.;:,\s]+$/;

export const CHANGE_INTENT_PATTERN =
  /\b(change|changes|changed|replace|replaces|replaced|rename|renames|renamed|remove|removes|removed|delete|deletes|drop|drops|dropped|migrate away|deprecate\w*|break|breaks|breaking|rework|redefine\w*|no longer|instead of|supersede\w*|overrid\w+)\b/i;

/** Phrases that state the opposite of something. */
export const NEGATION_PATTERN =
  /\b(must not|shall not|will not|may not|never|no longer|cannot|is not|are not|without)\b/i;

/**
 * Words that hedge a compatibility claim.
 *
 * "-compatible or -like" is the canonical shape, and it is the exact shape
 * that must become a question rather than an assumption: one reading is a
 * hard promise about an external format and the other is a family
 * resemblance, and the two produce completely different products.
 */
export const COMPATIBILITY_HEDGE_PATTERNS: readonly RegExp[] = Object.freeze([
  /-compatible\s+or\s+[\w .-]*-like\b/i,
  /-like\s+or\s+[\w .-]*-compatible\b/i,
  /\b(degree|level|extent)\s+of\s+[\w .-]*compatibilit/i,
  /\bconceptually\s+similar\b/i,
  /\bcompatible\b[^.]{0,60}\bor\b[^.]{0,40}\bsimilar\b/i,
  /\b(roughly|broadly|loosely|largely)\s+compatible\b/i,
  /\bcompatible[- ]?ish\b/i,
]);

/** Phrases that make a stated capability conditional rather than promised. */
export const CONDITIONAL_SUPPORT_PATTERN =
  /\b(where|if|when)\s+(supported|available|applicable|appropriate|required|possible|the\s+\w+\s+semantics?\s+(allow|support|permit))\b/i;

/** Phrases in which the author flags an unresolved product commitment. */
export const AUTHOR_FLAGGED_AMBIGUITY_PATTERN =
  /\b(is ambiguous|are ambiguous|ambiguity|unclear|to be (decided|determined)|tbd|undecided|open question|needs? a (product )?decision)\b/i;

/**
 * Sensitive data classes whose visibility is a product decision.
 *
 * Not a security scanner: this is about who the PRODUCT promises may see a
 * payload, which is a promise a person makes and an engineer implements.
 */
export const SENSITIVE_DATA_PATTERN =
  /\b(biometric|face (photo|image|data|scan)|facial|fingerprint|passport|national id|identity document|boarding[- ]pass|personal data|personally identifiable|pii|health (record|data)|payment (card|details)|credit card|ssn|social security)\b/i;

/** Statements that already settle a visibility or retention policy. */
export const VISIBILITY_POLICY_PATTERN =
  /\b(redact\w*|not (stored|persisted|logged|retained)|retention|encrypt\w*|in memory only|ephemeral|never (stored|logged|persisted)|privacy policy|data (handling|visibility|protection) policy|masked?|anonymi[sz]ed?)\b/i;

// ---------------------------------------------------------------------------
// Engineering vocabulary — the refusal side
// ---------------------------------------------------------------------------

/**
 * Vocabulary that makes a QUESTION an engineering question.
 *
 * The mirror of `NON_AUTHORITY_SIGNALS` in @specbridge/autonomy. A test
 * enumerates this table and proves no candidate matching it can reach a
 * human, which is the only way "we ask product questions only" is a claim
 * rather than an aspiration.
 */
export const ENGINEERING_QUESTION_PATTERNS: readonly {
  surface:
    | 'framework-choice'
    | 'library-choice'
    | 'build-tool-choice'
    | 'package-naming'
    | 'module-decomposition'
    | 'transport-choice'
    | 'database-schema'
    | 'broker-topology'
    | 'test-framework'
    | 'test-structure'
    | 'retry-implementation'
    | 'tooling-creation'
    | 'file-layout'
    | 'code-style'
    | 'deployment-topology';
  pattern: RegExp;
}[] = Object.freeze([
  {
    surface: 'framework-choice',
    pattern:
      /\b(react|vue|angular|svelte|next\.js|nuxt|spring boot|django|rails|express|fastify|which (ui )?framework|what framework)\b/i,
  },
  {
    surface: 'library-choice',
    pattern:
      /\b(which library|what library|which (npm|maven|pip) package|use (lodash|axios|jackson|gson)|dependency (choice|selection))\b/i,
  },
  {
    surface: 'build-tool-choice',
    pattern: /\b(maven or gradle|gradle or maven|webpack|vite|esbuild|which build (tool|system)|bazel)\b/i,
  },
  {
    surface: 'package-naming',
    pattern: /\b(package name|namespace|module name|class name|what should (we|it) be called|naming convention)\b/i,
  },
  {
    surface: 'module-decomposition',
    pattern:
      /\b(how many (classes|services|controllers|modules)|controller decomposition|split into|how should (we|i) (structure|organi[sz]e|decompose)|layering)\b/i,
  },
  {
    surface: 'transport-choice',
    pattern:
      /\b(websocket|web socket|server-sent events|\bsse\b|long polling|grpc or rest|rest or grpc|which transport|polling or push)\b/i,
  },
  {
    surface: 'database-schema',
    pattern:
      /\b(table (layout|design|schema)|column|index(es)? on|normali[sz]ed|which database|postgres or mysql|denormali[sz]|primary key)\b/i,
  },
  {
    surface: 'broker-topology',
    pattern:
      /\b(how many (\w+\s+)?(topics?|queues?|partitions?)|one\s+(\w+\s+)?topic\s+or|partition count|topic (layout|topology|naming)|queue (layout|topology)|which broker|kafka or rabbit)\b/i,
  },
  {
    surface: 'test-framework',
    pattern: /\b(playwright|cypress|selenium|junit|jest|vitest|pytest|which test (framework|runner)|testing library)\b/i,
  },
  {
    surface: 'test-structure',
    pattern:
      /\b(test (structure|layout|organi[sz]ation)|how many tests|unit or integration|where should the tests|test naming)\b/i,
  },
  {
    surface: 'retry-implementation',
    pattern:
      /\b(retry (implementation|mechanism|library)|exponential backoff implementation|how (should|do) (we|i) implement (the )?retr)/i,
  },
  {
    surface: 'tooling-creation',
    pattern:
      /\b(should (we|i) (create|build|write) a (helper|script|tool|utility)|helper tool|internal tooling|scaffolding)\b/i,
  },
  {
    surface: 'file-layout',
    pattern: /\b(file (layout|structure)|directory (layout|structure)|where should the (file|code) (go|live)|folder structure)\b/i,
  },
  {
    surface: 'code-style',
    pattern: /\b(code style|formatting|lint(ing)? rules|naming style|tabs or spaces)\b/i,
  },
  {
    surface: 'deployment-topology',
    pattern:
      /\b(how many (containers|replicas|instances)|kubernetes|helm|docker[- ]?compose|deployment topology|ci (pipeline )?layout|provision(ing)? the (real )?(middleware|infrastructure)|middleware needed)\b/i,
  },
]);

/** A question that asks for detail rather than for a decision. */
export const ELABORATION_PATTERN =
  /^(how should (we|i)|what is the best way|can you (describe|explain|detail)|please (describe|detail|explain)|tell me more|what are the details|could you elaborate)\b/i;

/** Collapse whitespace and bound a string for a record field. */
export function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, Math.max(1, max - 1))}…` : collapsed;
}

/** The first sentence of a statement, for a question subject. */
export function firstSentence(value: string, max = 220): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  const match = /^(.{10,}?[.!?])(\s|$)/.exec(collapsed);
  return clip(match?.[1] ?? collapsed, max);
}
