import { sha256Hex } from '@specbridge/core';
import { IntakeError } from './errors.js';
import type { SourceChunk } from './state.js';
import { INTAKE_LIMITS } from './state.js';
import type { SourceChunkKind } from './vocabulary.js';
import { PROCESS_INSTRUCTION_PATTERN } from './text.js';

/**
 * Deterministic parsing of a submitted specification.
 *
 * The whole point of this file is that a long document is INDEXED rather
 * than summarized. A model summary is a lossy re-statement, and vNext.10.1
 * refuses to let one replace the thing the human actually wrote: every chunk
 * below points back into the stored bytes by offset, and the coverage
 * reconciliation in convergence.ts holds the intake open until every
 * normative chunk is accounted for.
 *
 * Everything here is PURE and deterministic. The same bytes always produce
 * the same chunks with the same ids, which is what makes an approval
 * reproducible and a re-ingestion recognisable as a no-op.
 *
 * The parser is deliberately structural rather than clever. It knows about
 * Markdown headings, fenced code, list items, and paragraphs — nothing about
 * any particular product. A classifier that recognised domain vocabulary
 * would work beautifully on the document it was written against and quietly
 * mis-file the next one.
 */

// ---------------------------------------------------------------------------
// Lexical tables
// ---------------------------------------------------------------------------

/**
 * Modal and imperative markers that make a statement normative.
 *
 * `must` / `shall` / `will` are the classic ones. The imperative list is
 * what actually carries most real product specifications, which tend to say
 * "Add a console" rather than "the system shall provide a console".
 */
const MODAL_PATTERN = /\b(must|shall|should|will|has to|have to|needs? to|is required to|are required to)\b/i;

const IMPERATIVE_VERBS = [
  'add',
  'allow',
  'build',
  'cover',
  'create',
  'define',
  'deliver',
  'display',
  'emit',
  'enable',
  'ensure',
  'expose',
  'generate',
  'handle',
  'implement',
  'include',
  'inspect',
  'list',
  'load',
  'perform',
  'persist',
  'produce',
  'provide',
  'record',
  'reject',
  'render',
  'replay',
  'report',
  'represent',
  'return',
  'run',
  'show',
  'simulate',
  'start',
  'store',
  'submit',
  'support',
  'use',
  'validate',
  'verify',
  'visualize',
  'visualise',
] as const;

const IMPERATIVE_PATTERN = new RegExp(`^(${IMPERATIVE_VERBS.join('|')})\\b`, 'i');

/** Headings (or lines) that make everything under them a stated exclusion. */
const NON_GOAL_PATTERN = /\b(non-?goals?|out of scope|explicitly not|not in scope|excluded)\b/i;

/**
 * Statements that are themselves exclusions, wherever they appear.
 *
 * Deliberately does NOT include a bare "never". A positive promise routinely
 * carries one as a qualification — "fields may be added, never removed" is a
 * compatibility COMMITMENT, not a non-goal — and treating it as an exclusion
 * dropped the only contract-bearing statement in a specification, which then
 * failed synthesis with "needs at least one recorded product contract". A
 * genuine exclusion says "must not"; a `## Non-goals` heading still marks
 * everything beneath it however it is phrased.
 */
const NEGATIVE_REQUIREMENT_PATTERN = /\b(must not|shall not|will not|may not|cannot)\b/i;

/** Headings (or lines) that make everything under them a scenario/edge case. */
const SCENARIO_PATTERN =
  /\b(edge cases?|scenarios?|test cases?|examples? including|cases? including|acceptance)\b/i;

/** Lines that are structurally illustrations rather than promises. */
const EXAMPLE_PATTERN = /\b(for example|e\.g\.|such as, for instance|sample)\b/i;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawBlock {
  lines: string[];
  startOffset: number;
  endOffset: number;
  headingPath: string[];
  /** True when the block is a Markdown heading line. */
  heading: boolean;
  /** True when the block is a fenced code block. */
  fenced: boolean;
  /** True when the block is one list item. */
  listItem: boolean;
  /** True when this paragraph ends in ":" and introduces the list below it. */
  introducesList?: boolean;
}

export interface ParsedDocument {
  outline: string[];
  chunks: SourceChunk[];
  /** Count of chunks classified normative, non-goal, or scenario. */
  normativeCount: number;
}

/**
 * Split a specification into chunks and classify each one.
 *
 * Bounded on both axes: at most `maxChunks` chunks, and each chunk's stored
 * text is capped at `maxChunkChars` with `truncated: true` set rather than
 * silently shortened. The byte offsets always describe the WHOLE block, so
 * the original text is recoverable from the stored source either way.
 */
export function parseSpecificationDocument(content: string): ParsedDocument {
  if (content.trim().length === 0) {
    throw new IntakeError('SBI007', 'The submitted specification is empty.', {
      remediation: ['Provide a specification file with content, or pass --text.'],
    });
  }
  const blocks = splitBlocks(content);
  const outline: string[] = [];
  const chunks: SourceChunk[] = [];
  let normativeCount = 0;

  for (const block of blocks) {
    if (chunks.length >= INTAKE_LIMITS.maxChunks) break;
    const raw = block.lines.join('\n');
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (block.heading) {
      const heading = trimmed.replace(/^#+\s*/, '').trim();
      if (heading.length > 0) outline.push(heading.slice(0, INTAKE_LIMITS.maxShortTextChars));
    }
    const kind = classifyBlock(block, trimmed);
    if (kind === 'normative' || kind === 'non-goal' || kind === 'scenario') normativeCount += 1;
    const truncated = trimmed.length > INTAKE_LIMITS.maxChunkChars;
    chunks.push({
      chunkId: `C-${String(chunks.length + 1).padStart(4, '0')}`,
      headingPath: block.headingPath.slice(-8).map((h) => h.slice(0, INTAKE_LIMITS.maxShortTextChars)),
      kind,
      text: truncated ? trimmed.slice(0, INTAKE_LIMITS.maxChunkChars) : trimmed,
      truncated,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      contentHash: sha256Hex(raw).slice(0, 32),
    });
  }

  return { outline: outline.slice(0, 200), chunks, normativeCount };
}

/**
 * Cut the document into blocks.
 *
 * A block is one heading, one fenced code region, one list item (including
 * its indented continuation lines), or one paragraph. List items are cut
 * INDIVIDUALLY on purpose: a real specification enumerates its edge cases as
 * a bullet list, and treating the whole list as one chunk would let a
 * discovery pass account for "the edge cases" collectively while quietly
 * dropping four of them.
 */
function splitBlocks(content: string): RawBlock[] {
  const lines = content.split('\n');
  const blocks: RawBlock[] = [];
  const headingPath: string[] = [];
  const headingLevels: number[] = [];

  let offset = 0;
  let index = 0;
  /** The most recent "…:" paragraph, while a list directly follows it. */
  let listIntro: string | undefined;

  const lineBytes = (line: string): number => Buffer.byteLength(`${line}\n`, 'utf8');

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const start = offset;

    // Blank line: consume and move on.
    if (line.trim().length === 0) {
      offset += lineBytes(line);
      index += 1;
      continue;
    }

    // Heading.
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch !== undefined && headingMatch !== null) {
      const level = headingMatch[1]?.length ?? 1;
      const title = (headingMatch[2] ?? '').trim();
      while (headingLevels.length > 0 && (headingLevels[headingLevels.length - 1] ?? 0) >= level) {
        headingLevels.pop();
        headingPath.pop();
      }
      headingLevels.push(level);
      headingPath.push(title);
      listIntro = undefined;
      offset += lineBytes(line);
      index += 1;
      blocks.push({
        lines: [line],
        startOffset: start,
        endOffset: offset,
        headingPath: [...headingPath],
        heading: true,
        fenced: false,
        listItem: false,
      });
      continue;
    }

    // Fenced code block: consumed whole, including the closing fence.
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch !== null) {
      const fence = fenceMatch[1] ?? '```';
      const collected: string[] = [line];
      offset += lineBytes(line);
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? '';
        collected.push(next);
        offset += lineBytes(next);
        index += 1;
        if (next.trimStart().startsWith(fence)) break;
      }
      listIntro = undefined;
      blocks.push({
        lines: collected,
        startOffset: start,
        endOffset: offset,
        headingPath: [...headingPath],
        heading: false,
        fenced: true,
        listItem: false,
      });
      continue;
    }

    // A horizontal rule is a separator, never content.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      offset += lineBytes(line);
      index += 1;
      continue;
    }

    // List item: the marker line plus any deeper-indented continuation.
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (listMatch !== null) {
      // A list introduced by "…:" belongs to its intro. Without this the
      // intro becomes an acceptance criterion nobody can close ("The console
      // must support:") while its ten actual capabilities become neither a
      // requirement nor a criterion — which is exactly what the dogfood's
      // sealed ledger showed. Carrying the intro on the item's heading path
      // gives each capability the intro's framing and vocabulary.
      const intro = listIntro;
      const indent = (listMatch[1] ?? '').length;
      const collected: string[] = [line];
      offset += lineBytes(line);
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (next.trim().length === 0) break;
        const nextIndent = next.length - next.trimStart().length;
        const nextIsItem = /^(\s*)([-*+]|\d+[.)])\s+/.test(next);
        if (nextIsItem || nextIndent <= indent) break;
        collected.push(next);
        offset += lineBytes(next);
        index += 1;
      }
      blocks.push({
        lines: collected,
        startOffset: start,
        endOffset: offset,
        headingPath: intro === undefined ? [...headingPath] : [...headingPath, intro],
        heading: false,
        fenced: false,
        listItem: true,
      });
      continue;
    }

    // Paragraph: run of non-blank, non-structural lines.
    const collected: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.trim().length === 0) break;
      if (/^(#{1,6})\s+/.test(next)) break;
      if (/^\s*(```|~~~)/.test(next)) break;
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(next)) break;
      collected.push(next);
      offset += lineBytes(next);
      index += 1;
    }
    if (collected.length === 0) {
      // Defensive: never spin. Consume the line as its own block.
      collected.push(line);
      offset += lineBytes(line);
      index += 1;
    }
    const paragraph = collected.join(' ').trim();
    listIntro = paragraph.endsWith(':')
      ? paragraph.replace(/:$/, '').trim().slice(0, 160)
      : undefined;
    blocks.push({
      lines: collected,
      startOffset: start,
      endOffset: offset,
      headingPath: [...headingPath],
      heading: false,
      fenced: false,
      listItem: false,
      /** True when this paragraph introduces the list beneath it. */
      introducesList: listIntro !== undefined,
    });
  }

  return blocks;
}

function classifyBlock(block: RawBlock, trimmed: string): SourceChunkKind {
  if (block.heading) return 'heading';
  if (block.fenced) return 'example';

  const headingContext = block.headingPath.join(' / ');
  const body = trimmed.replace(/^(\s*)([-*+]|\d+[.)])\s+/, '');

  // An instruction to go and get a product decision is guidance to whoever
  // is writing the specification, not a promise the product makes.
  //
  // The StepRelay Golden Spec said "if the degree of Step Functions
  // compatibility is ambiguous, ask a product question during discovery".
  // That sealed as the ONLY requirement of a contract named "Compatibility
  // Promise", and the builder stopped: it could satisfy the requirement in
  // full while promising nothing, so it raised a change request and waited
  // for a human. The sentence still marks an ambiguity worth asking about —
  // the question generator reads every kind but `heading` — but the ANSWER
  // is the durable truth, and the instruction to ask is spent once asked.
  if (PROCESS_INSTRUCTION_PATTERN.test(body)) return 'process-guidance';

  // An exclusion is an exclusion wherever it appears, and a non-goal heading
  // makes everything beneath it one.
  if (NON_GOAL_PATTERN.test(headingContext) || NON_GOAL_PATTERN.test(body)) return 'non-goal';
  if (NEGATIVE_REQUIREMENT_PATTERN.test(body)) return 'non-goal';

  // Scenario lists are normative in the sense that matters here — they name
  // behaviour the product owes — but they are kept as their own kind so a
  // reader can see the coverage of edge cases separately.
  if (SCENARIO_PATTERN.test(headingContext)) return 'scenario';
  if (SCENARIO_PATTERN.test(body)) return 'scenario';

  if (MODAL_PATTERN.test(body)) return 'normative';

  // A BULLET IS AN OBLIGATION unless it is plainly an illustration.
  //
  // This is the deliberate, asymmetric choice. Real specifications enumerate
  // what they owe: noun phrases ("passport present, boarding pass missing"),
  // declarative sentences ("Sequential execution is deterministic"), and
  // bare concept names. An earlier version demanded a modal or an imperative
  // verb and quietly filed every one of those as narrative — which dropped
  // them out of the normative set, and therefore out of the coverage gate
  // that exists to stop exactly that.
  //
  // Erring toward normative errs toward accounting for MORE of the submitted
  // document. An over-inclusive normative set makes the gate stricter; an
  // under-inclusive one makes it a formality.
  if (block.listItem) return EXAMPLE_PATTERN.test(body) ? 'example' : 'normative';

  if (IMPERATIVE_PATTERN.test(body)) return 'normative';
  if (EXAMPLE_PATTERN.test(body)) return 'example';
  return 'narrative';
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Recover the exact original text of one chunk from the stored source.
 *
 * Offsets are BYTE offsets, so the recovery goes through a Buffer rather
 * than string indices — a specification containing any non-ASCII character
 * would otherwise be sliced at the wrong place, and specifications contain
 * non-ASCII characters constantly.
 */
export function chunkText(sourceContent: string, chunk: SourceChunk): string {
  const buffer = Buffer.from(sourceContent, 'utf8');
  const start = Math.min(chunk.startOffset, buffer.byteLength);
  const end = Math.min(Math.max(chunk.endOffset, start), buffer.byteLength);
  return buffer.subarray(start, end).toString('utf8');
}

/** Chunks whose text matches a bounded pattern. Deterministic, ordered. */
export function chunksMatching(
  chunks: readonly SourceChunk[],
  pattern: RegExp,
): SourceChunk[] {
  return chunks.filter((chunk) => pattern.test(chunk.text));
}

/** The normative chunks — the ones coverage reconciliation must account for. */
export function normativeChunks(chunks: readonly SourceChunk[]): SourceChunk[] {
  return chunks.filter(
    (chunk) => chunk.kind === 'normative' || chunk.kind === 'non-goal' || chunk.kind === 'scenario',
  );
}
