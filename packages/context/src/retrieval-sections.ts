/**
 * File-section selection.
 *
 * For a large file, sending the whole body spends context on material the
 * worker will not read. For a small one, sending a fragment saves nothing
 * and costs comprehension. So sectioning is applied only where BOTH hold:
 * the file is genuinely large, and a structural boundary can be located
 * confidently.
 *
 * The rule that governs the uncertain case is stated once and enforced
 * below: when the structure cannot be read reliably, include the whole
 * bounded file rather than inventing a boundary. A fabricated "relevant
 * region" is worse than a big one — it looks authoritative, it is missing
 * the part that mattered, and nothing downstream can tell.
 *
 * Sections always carry enough surrounding material to stay meaningful:
 * the file's leading import/package block, the enclosing declaration, and a
 * margin of neighbouring lines. Tiny disconnected snippets make
 * implementation reasoning worse, not cheaper.
 */

export interface SectionOptions {
  /** Files at or below this many characters are always sent whole. */
  wholeFileUnderChars?: number | undefined;
  /** Target size for an extracted section, in characters. */
  targetSectionChars?: number | undefined;
  /** Lines of margin kept above and below a located region. */
  marginLines?: number | undefined;
  /** Maximum leading lines kept as the import/header preamble. */
  maxPreambleLines?: number | undefined;
}

/** Options with every field resolved; no optionality inside the algorithm. */
interface ResolvedSectionOptions {
  wholeFileUnderChars: number;
  targetSectionChars: number;
  marginLines: number;
  maxPreambleLines: number;
}

export const DEFAULT_SECTION_OPTIONS: ResolvedSectionOptions = {
  wholeFileUnderChars: 6_000,
  targetSectionChars: 4_000,
  marginLines: 12,
  maxPreambleLines: 40,
};

export interface ExtractedSection {
  content: string;
  /** 1-based inclusive line range of the primary region, when sectioned. */
  startLine?: number | undefined;
  endLine?: number | undefined;
  /** The declaration the section is centred on, when one was located. */
  symbol?: string | undefined;
  /** False when the whole file was returned unchanged. */
  sectioned: boolean;
  /** Why the whole file was returned, when it was. */
  wholeFileReason?: 'small-enough' | 'no-reliable-structure' | undefined;
}

/**
 * Declaration starts we can locate with confidence across the languages the
 * index already classifies. Anything not matched here simply yields no
 * anchor, which routes to "send the whole bounded file".
 */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:public|private|protected|internal|static|final|open|sealed|data)\s+.*?\b(?:class|interface|record|enum|struct|object)\s+([A-Za-z_][\w]*)/,
  /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
];

const PREAMBLE_PATTERN =
  /^\s*(?:import\b|from\s+[\w.]+\s+import\b|package\b|using\b|use\b|require\(|#include\b|@\w|\/\*|\*|\/\/|#)/;

interface Declaration {
  name: string;
  line: number; // 0-based
}

/** Locate declaration starts. Empty when the language is unreadable to us. */
export function findDeclarations(lines: readonly string[]): Declaration[] {
  const declarations: Declaration[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.length > 400) continue;
    for (const pattern of DECLARATION_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined) {
        declarations.push({ name: match[1], line: index });
        break;
      }
    }
  }
  return declarations;
}

/** The file's leading import/comment block, bounded. */
function preamble(lines: readonly string[], maxLines: number): { text: string; endLine: number } {
  let end = 0;
  for (let index = 0; index < Math.min(lines.length, maxLines); index += 1) {
    const line = lines[index] as string;
    if (line.trim() === '' || PREAMBLE_PATTERN.test(line)) {
      end = index + 1;
      continue;
    }
    break;
  }
  return { text: lines.slice(0, end).join('\n'), endLine: end };
}

export interface ExtractSectionInput {
  content: string;
  /** Symbols the query named; the section is centred on the best match. */
  symbols?: readonly string[] | undefined;
  /** Line numbers the failure named (1-based), e.g. from a stack frame. */
  lines?: readonly number[] | undefined;
  options?: SectionOptions | undefined;
}

/**
 * Extract the relevant section of a file, or return it whole.
 *
 * Order of evidence: an explicit line reference beats a symbol match, and a
 * symbol match beats nothing. Absent both, the file is returned whole —
 * "large" is not by itself a reason to guess which part matters.
 */
export function extractSection(input: ExtractSectionInput): ExtractedSection {
  const supplied = input.options ?? {};
  const options: ResolvedSectionOptions = {
    wholeFileUnderChars: supplied.wholeFileUnderChars ?? DEFAULT_SECTION_OPTIONS.wholeFileUnderChars,
    targetSectionChars: supplied.targetSectionChars ?? DEFAULT_SECTION_OPTIONS.targetSectionChars,
    marginLines: supplied.marginLines ?? DEFAULT_SECTION_OPTIONS.marginLines,
    maxPreambleLines: supplied.maxPreambleLines ?? DEFAULT_SECTION_OPTIONS.maxPreambleLines,
  };
  const content = input.content;
  if (content.length <= options.wholeFileUnderChars) {
    return { content, sectioned: false, wholeFileReason: 'small-enough' };
  }

  const lines = content.split('\n');
  const declarations = findDeclarations(lines);

  let anchorLine: number | undefined;
  let anchorSymbol: string | undefined;

  const referenced = (input.lines ?? []).filter((line) => line >= 1 && line <= lines.length);
  if (referenced.length > 0) {
    anchorLine = (referenced[0] as number) - 1;
    anchorSymbol = [...declarations].reverse().find((entry) => entry.line <= (anchorLine as number))?.name;
  } else if ((input.symbols?.length ?? 0) > 0 && declarations.length > 0) {
    const wanted = new Set((input.symbols ?? []).map((symbol) => symbol.toLowerCase()));
    const hit = declarations.find((entry) => wanted.has(entry.name.toLowerCase()));
    if (hit !== undefined) {
      anchorLine = hit.line;
      anchorSymbol = hit.name;
    }
  }

  if (anchorLine === undefined) {
    // No reliable anchor. Send the whole bounded file: a fabricated
    // "relevant region" would look authoritative and be wrong.
    return { content, sectioned: false, wholeFileReason: 'no-reliable-structure' };
  }

  // Grow from the enclosing declaration to the next one, then apply margin
  // and the character target — so the section is a whole unit of code plus
  // context, never a window cut through the middle of a function.
  const declarationStart =
    [...declarations].reverse().find((entry) => entry.line <= (anchorLine as number))?.line ?? anchorLine;
  const nextDeclaration = declarations.find((entry) => entry.line > declarationStart)?.line ?? lines.length;

  let start = Math.max(0, declarationStart - options.marginLines);
  let end = Math.min(lines.length, nextDeclaration + options.marginLines);

  // Trim toward the anchor when the unit alone already exceeds the target.
  while (lines.slice(start, end).join('\n').length > options.targetSectionChars && end - start > 20) {
    if (end - (anchorLine as number) > (anchorLine as number) - start) end -= 1;
    else start += 1;
  }

  const head = preamble(lines, options.maxPreambleLines);
  const body = lines.slice(start, end).join('\n');
  const includeHead = head.text.trim() !== '' && head.endLine <= start;
  const omittedBefore = start - (includeHead ? head.endLine : 0);
  const omittedAfter = lines.length - end;

  const parts: string[] = [];
  if (includeHead) {
    parts.push(head.text);
    if (omittedBefore > 0) parts.push(`… [${omittedBefore} line(s) omitted] …`);
  } else if (start > 0) {
    parts.push(`… [${start} line(s) omitted] …`);
  }
  parts.push(body);
  if (omittedAfter > 0) parts.push(`… [${omittedAfter} line(s) omitted] …`);

  return {
    content: parts.join('\n'),
    startLine: start + 1,
    endLine: end,
    symbol: anchorSymbol,
    sectioned: true,
  };
}
