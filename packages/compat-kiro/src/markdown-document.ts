import { readFileSync } from 'node:fs';
import { SpecBridgeError, ioError } from '@specbridge/core';

/**
 * Line-preserving Markdown document model.
 *
 * This is deliberately NOT an AST. The document is stored as the exact
 * original lines plus their individual line endings, so that:
 *
 *   serialize(load(bytes)) === bytes            (no-op round trip)
 *
 * holds byte-for-byte for every file we can decode as UTF-8, regardless of
 * LF/CRLF/CR endings, BOM, trailing-newline style, or unknown content.
 * Structure (headings, sections) is *detected over* the lines, never used to
 * regenerate them.
 */

export type LineEnding = '' | '\n' | '\r\n' | '\r';

export interface MarkdownLine {
  text: string;
  eol: LineEnding;
}

export interface HeadingInfo {
  /** 0-based line index. */
  line: number;
  /** 1..6 */
  level: number;
  /** Heading text with `#` markers and trailing closing hashes stripped. */
  text: string;
}

export interface DocumentSection {
  heading: HeadingInfo;
  /** Line index of the heading itself. */
  startLine: number;
  /** Exclusive end line (start of the next same-or-higher-level heading). */
  endLine: number;
}

export type DominantEol = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';

const BOM = '\uFEFF';

function splitLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      lines.push({ text: text.slice(start, i), eol: '\n' });
      i += 1;
      start = i;
    } else if (code === 13) {
      const eol: LineEnding = text.charCodeAt(i + 1) === 10 ? '\r\n' : '\r';
      lines.push({ text: text.slice(start, i), eol });
      i += eol.length;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), eol: '' });
  }
  return lines;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:$|[ \t]+(.*))$/;

export class MarkdownDocument {
  readonly filePath: string | undefined;
  readonly hasBom: boolean;
  /**
   * True when decoding the source bytes as UTF-8 and re-encoding reproduces
   * them exactly. False means the file is not valid UTF-8 and MUST NOT be
   * edited through this model (reading is still fine).
   */
  readonly encodingSafe: boolean;
  private readonly documentLines: MarkdownLine[];

  private constructor(
    lines: MarkdownLine[],
    hasBom: boolean,
    encodingSafe: boolean,
    filePath: string | undefined,
  ) {
    this.documentLines = lines;
    this.hasBom = hasBom;
    this.encodingSafe = encodingSafe;
    this.filePath = filePath;
  }

  static fromText(text: string, filePath?: string): MarkdownDocument {
    return MarkdownDocument.create(text, true, filePath);
  }

  static fromBuffer(buffer: Buffer, filePath?: string): MarkdownDocument {
    const text = buffer.toString('utf8');
    const encodingSafe = Buffer.from(text, 'utf8').equals(buffer);
    return MarkdownDocument.create(text, encodingSafe, filePath);
  }

  static load(filePath: string): MarkdownDocument {
    let buffer: Buffer;
    try {
      buffer = readFileSync(filePath);
    } catch (cause) {
      throw ioError('read', filePath, cause);
    }
    return MarkdownDocument.fromBuffer(buffer, filePath);
  }

  private static create(
    text: string,
    encodingSafe: boolean,
    filePath: string | undefined,
  ): MarkdownDocument {
    const hasBom = text.startsWith(BOM);
    const body = hasBom ? text.slice(1) : text;
    return new MarkdownDocument(splitLines(body), hasBom, encodingSafe, filePath);
  }

  get lineCount(): number {
    return this.documentLines.length;
  }

  get lines(): readonly MarkdownLine[] {
    return this.documentLines;
  }

  lineAt(index: number): MarkdownLine {
    const line = this.documentLines[index];
    if (line === undefined) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        `Line index ${index} is out of range (document has ${this.documentLines.length} lines).`,
      );
    }
    return line;
  }

  /** Replace the text of one line. The line ending is preserved untouched. */
  setLineText(index: number, text: string): void {
    if (text.includes('\n') || text.includes('\r')) {
      throw new SpecBridgeError(
        'INVALID_ARGUMENT',
        'setLineText received text containing a line break; surgical edits must stay on one line.',
      );
    }
    const line = this.lineAt(index);
    line.text = text;
  }

  /** Reconstruct the exact document text (including BOM when present). */
  serialize(): string {
    let out = this.hasBom ? BOM : '';
    for (const line of this.documentLines) {
      out += line.text + line.eol;
    }
    return out;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.serialize(), 'utf8');
  }

  /**
   * Per-line mask marking lines that are part of a fenced code block
   * (including the fence markers themselves). Heading and checkbox detection
   * must ignore masked lines.
   */
  codeFenceMask(): boolean[] {
    const mask = new Array<boolean>(this.documentLines.length).fill(false);
    let open: { char: string; length: number } | null = null;
    for (let i = 0; i < this.documentLines.length; i += 1) {
      const text = this.documentLines[i]?.text ?? '';
      const match = FENCE_OPEN.exec(text);
      if (open !== null) {
        mask[i] = true;
        if (
          match !== null &&
          match[1] !== undefined &&
          match[1].startsWith(open.char) &&
          match[1].length >= open.length &&
          (match[2] ?? '').trim() === ''
        ) {
          open = null;
        }
      } else if (match !== null && match[1] !== undefined) {
        const char = match[1].charAt(0);
        const info = match[2] ?? '';
        // CommonMark: an info string on a backtick fence cannot contain backticks.
        if (char === '`' && info.includes('`')) continue;
        open = { char, length: match[1].length };
        mask[i] = true;
      }
    }
    return mask;
  }

  /** Info strings of opening code fences (e.g. `mermaid`, `ts`). */
  fenceInfoStrings(): string[] {
    const infos: string[] = [];
    let open: { char: string; length: number } | null = null;
    for (const line of this.documentLines) {
      const match = FENCE_OPEN.exec(line.text);
      if (open !== null) {
        if (
          match !== null &&
          match[1] !== undefined &&
          match[1].startsWith(open.char) &&
          match[1].length >= open.length &&
          (match[2] ?? '').trim() === ''
        ) {
          open = null;
        }
      } else if (match !== null && match[1] !== undefined) {
        const char = match[1].charAt(0);
        const info = (match[2] ?? '').trim();
        if (char === '`' && info.includes('`')) continue;
        open = { char, length: match[1].length };
        infos.push(info);
      }
    }
    return infos;
  }

  /** ATX headings outside code fences. Recomputed on demand (documents are small). */
  headings(): HeadingInfo[] {
    const mask = this.codeFenceMask();
    const headings: HeadingInfo[] = [];
    for (let i = 0; i < this.documentLines.length; i += 1) {
      if (mask[i] === true) continue;
      const match = HEADING.exec(this.documentLines[i]?.text ?? '');
      if (match === null || match[1] === undefined) continue;
      let text = (match[2] ?? '').trim();
      // Strip an optional closing hash sequence: `## Title ##`.
      text = text.replace(/[ \t]+#+[ \t]*$/, '').trim();
      headings.push({ line: i, level: match[1].length, text });
    }
    return headings;
  }

  /**
   * Sections derived from headings. A section spans from its heading line to
   * the next heading with the same or a higher (smaller-number) level.
   */
  sections(): DocumentSection[] {
    const headings = this.headings();
    return headings.map((heading, index) => {
      let endLine = this.documentLines.length;
      for (let j = index + 1; j < headings.length; j += 1) {
        const next = headings[j];
        if (next !== undefined && next.level <= heading.level) {
          endLine = next.line;
          break;
        }
      }
      return { heading, startLine: heading.line, endLine };
    });
  }

  /** First section whose heading text matches (case-insensitive, trimmed). */
  findSection(
    matcher: string | RegExp,
    options?: { maxLevel?: number },
  ): DocumentSection | undefined {
    const maxLevel = options?.maxLevel ?? 6;
    for (const section of this.sections()) {
      if (section.heading.level > maxLevel) continue;
      const text = section.heading.text.trim();
      const matched =
        typeof matcher === 'string'
          ? text.toLowerCase() === matcher.trim().toLowerCase()
          : matcher.test(text);
      if (matched) return section;
    }
    return undefined;
  }

  /** Text of lines [startLine, endLine), joined with their original endings. */
  getText(startLine: number, endLine: number): string {
    let out = '';
    const end = Math.min(endLine, this.documentLines.length);
    for (let i = Math.max(0, startLine); i < end; i += 1) {
      const line = this.documentLines[i];
      if (line !== undefined) out += line.text + line.eol;
    }
    return out;
  }

  /** Full body text without the BOM. */
  bodyText(): string {
    return this.getText(0, this.documentLines.length);
  }

  dominantEol(): DominantEol {
    let lf = 0;
    let crlf = 0;
    let cr = 0;
    for (const line of this.documentLines) {
      if (line.eol === '\n') lf += 1;
      else if (line.eol === '\r\n') crlf += 1;
      else if (line.eol === '\r') cr += 1;
    }
    const kinds = [lf > 0, crlf > 0, cr > 0].filter(Boolean).length;
    if (kinds === 0) return 'none';
    if (kinds > 1) return 'mixed';
    if (lf > 0) return 'lf';
    if (crlf > 0) return 'crlf';
    return 'cr';
  }

  endsWithNewline(): boolean {
    const last = this.documentLines[this.documentLines.length - 1];
    return last !== undefined && last.eol !== '';
  }

  /** First level-1 heading text, if any. Used as the document title. */
  title(): string | undefined {
    return this.headings().find((h) => h.level === 1)?.text;
  }
}
