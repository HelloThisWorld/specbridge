/**
 * EARS-style acceptance-criterion classification.
 *
 * Recognized shapes (case-insensitive):
 *
 *   WHEN <condition or event>, THE SYSTEM SHALL <behavior>.
 *   IF <condition>, THEN THE SYSTEM SHALL <behavior>.
 *   WHILE <state>, THE SYSTEM SHALL <behavior>.
 *   WHERE <feature>, THE SYSTEM SHALL <behavior>.
 *   THE SYSTEM SHALL <behavior>.               (ubiquitous requirement)
 *
 * EARS is encouraged, not required: a criterion that uses none of the
 * keywords is `plain` (fine on its own); only a criterion that *starts* an
 * EARS pattern without finishing it is `malformed`.
 */

export type EarsClassification = 'ears' | 'ears-malformed' | 'plain';

const EARS_TRIGGER = /^(when|if|while|where)\b/i;
const SHALL = /\bshall\b/i;
/** Modal verbs that make a plain criterion read as a testable statement. */
const TESTABLE_MODAL = /\b(shall|must|should|will)\b/i;

export function classifyEars(text: string): EarsClassification {
  const trimmed = text.trim();
  if (EARS_TRIGGER.test(trimmed)) {
    return SHALL.test(trimmed) ? 'ears' : 'ears-malformed';
  }
  if (SHALL.test(trimmed)) return 'ears';
  return 'plain';
}

/** True when the criterion contains a modal verb that marks expected behavior. */
export function looksTestable(text: string): boolean {
  return TESTABLE_MODAL.test(text);
}

/**
 * Vague phrasing that hides untestable requirements. Matching is
 * word-boundary based and case-insensitive; multiword phrases first.
 */
const VAGUE_PHRASES: readonly string[] = [
  'work correctly',
  'works correctly',
  'work properly',
  'works properly',
  'work as expected',
  'works as expected',
  'as appropriate',
  'as needed',
  'as necessary',
  'if appropriate',
  'user-friendly',
  'user friendly',
  'and so on',
  'etc',
  'handle',
  'handles',
  'support',
  'supports',
  'properly',
  'appropriately',
  'gracefully',
  'seamlessly',
  'efficiently',
  'robustly',
  'intuitively',
  'intuitive',
];

const VAGUE_PATTERN = new RegExp(
  `\\b(?:${VAGUE_PHRASES.map((phrase) => phrase.replace(/[-\s]+/g, '[-\\s]+')).join('|')})\\b`,
  'gi',
);

/** Distinct vague phrases found in the text (lowercased), in order. */
export function findVaguePhrases(text: string): string[] {
  const found: string[] = [];
  VAGUE_PATTERN.lastIndex = 0;
  for (let match = VAGUE_PATTERN.exec(text); match !== null; match = VAGUE_PATTERN.exec(text)) {
    const phrase = match[0].toLowerCase().replace(/\s+/g, ' ');
    if (!found.includes(phrase)) found.push(phrase);
  }
  return found;
}

/**
 * Vague verbs that make a *task* unactionable when used as the leading verb.
 */
const VAGUE_TASK_VERBS = new Set(['support', 'handle', 'manage', 'improve', 'address', 'deal', 'ensure']);

export function taskStartsWithVagueVerb(title: string): string | undefined {
  const first = title.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
  return first !== undefined && VAGUE_TASK_VERBS.has(first) ? first : undefined;
}
