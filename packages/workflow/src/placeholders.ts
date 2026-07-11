import type { MarkdownDocument } from '@specbridge/compat-kiro';
import { TEMPLATE_PLACEHOLDER_LINES } from './templates.js';

/**
 * Deterministic placeholder detection.
 *
 * Generated templates intentionally contain recognizable placeholders; a
 * stage must not be approvable while they remain. Detection is precise on
 * purpose — a false positive would block approval of a legitimate document:
 *
 * 1. Angle-bracket tokens such as `<role>` or `<expected behavior>`
 *    (HTML tag names and autolinks are excluded).
 * 2. `TBD` / `TODO` markers.
 * 3. Instruction lines that start with a fill-me-in verb and end in
 *    "here", e.g. "Add edge cases here." or "Describe the correct behavior here.".
 * 4. Exact pending-stage lines from the generated templates.
 *
 * Content inside fenced code blocks is never scanned.
 */

export interface PlaceholderHit {
  /** 0-based line index. */
  line: number;
  /** The placeholder token or the trimmed matching line. */
  text: string;
}

export interface PlaceholderScan {
  hits: PlaceholderHit[];
  /** True when the document has body content and all of it is placeholders. */
  placeholderOnly: boolean;
  /** Number of body lines considered (non-blank, non-heading, non-structural). */
  bodyLineCount: number;
}

const ANGLE_TOKEN = /<([a-z][a-z0-9]*(?:[ _-][a-z0-9]+)*)>/g;

/** Common HTML element names that may legitimately appear in Markdown prose. */
const HTML_TAGS = new Set([
  'a', 'b', 'br', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'em', 'hr', 'i',
  'img', 'kbd', 'li', 'ol', 'p', 'pre', 'small', 'span', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

const TBD_TODO = /\b(?:TBD|TODO)\b/i;

/**
 * A line whose content (after list markers and an optional `Label:` or
 * `**Label:**` prefix) is an instruction to fill something in.
 */
const INSTRUCTION_PREFIX = /^(?:[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]*)*(?:\*\*[^*]{1,60}\*\*:?[ \t]*|[A-Za-z][A-Za-z /-]{0,40}:[ \t]*)?/;
const INSTRUCTION_LINE = /^(?:add|list|describe|document|identify)\b.*\bhere\b[.!]?$/i;

const TEMPLATE_LINES = new Set(TEMPLATE_PLACEHOLDER_LINES.map((line) => line.toLowerCase()));

function stripListPrefix(line: string): string {
  const match = INSTRUCTION_PREFIX.exec(line);
  return match !== null ? line.slice(match[0].length) : line;
}

/** Strip checkbox/list/quote markers only (keep any `Label:` text). */
const STRUCTURAL_PREFIX = /^(?:[-*+][ \t]+(?:\[[^\]]?\]\*?[ \t]*)?|\d+[.)][ \t]+|>[ \t]*)*/;

function bodyOf(line: string): string {
  const match = STRUCTURAL_PREFIX.exec(line);
  return (match !== null ? line.slice(match[0].length) : line).trim();
}

export function findPlaceholdersInLine(text: string): string[] {
  const found: string[] = [];
  ANGLE_TOKEN.lastIndex = 0;
  for (let match = ANGLE_TOKEN.exec(text); match !== null; match = ANGLE_TOKEN.exec(text)) {
    const token = match[1] ?? '';
    if (!HTML_TAGS.has(token)) found.push(`<${token}>`);
  }
  const tbd = TBD_TODO.exec(text);
  if (tbd !== null) found.push(tbd[0]);

  const body = bodyOf(text);
  const instruction = stripListPrefix(text.trim());
  if (INSTRUCTION_LINE.test(instruction) || INSTRUCTION_LINE.test(body)) {
    found.push(text.trim());
  } else if (TEMPLATE_LINES.has(body.toLowerCase())) {
    found.push(text.trim());
  }
  return found;
}

const HEADING_LINE = /^ {0,3}#{1,6}(?:$|[ \t])/;
const TABLE_RULE = /^[ \t]*\|?[ \t:-]*-{3,}[ \t:|-]*$/;
const STATUS_NOTE = /^>[ \t]*status:/i;

/** Scan a document for placeholder content, ignoring fenced code blocks. */
export function scanPlaceholders(document: MarkdownDocument): PlaceholderScan {
  const mask = document.codeFenceMask();
  const hits: PlaceholderHit[] = [];
  let bodyLineCount = 0;
  let placeholderLineCount = 0;

  for (let i = 0; i < document.lineCount; i += 1) {
    if (mask[i] === true) continue;
    const text = document.lineAt(i).text;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;

    const lineHits = findPlaceholdersInLine(text);
    for (const hit of lineHits) hits.push({ line: i, text: hit });

    // Structure does not count as body content when judging "placeholder-only":
    // headings, table rules, and the human-readable "> Status:" note.
    if (HEADING_LINE.test(text) || TABLE_RULE.test(trimmed) || STATUS_NOTE.test(trimmed)) {
      continue;
    }
    bodyLineCount += 1;
    if (lineHits.length > 0) placeholderLineCount += 1;
  }

  return {
    hits,
    placeholderOnly: bodyLineCount > 0 && placeholderLineCount === bodyLineCount,
    bodyLineCount,
  };
}
