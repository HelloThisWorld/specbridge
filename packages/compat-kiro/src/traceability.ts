import type { MarkdownDocument } from './markdown-document.js';
import type { RequirementsModel } from './requirements-parser.js';
import type { TaskItem, TasksModel } from './tasks-parser.js';

/**
 * Traceability extraction: requirement identifiers, task-to-requirement
 * references, test-required language, and explicit repository paths — all
 * read from the tolerant document models without regenerating any Markdown.
 *
 * Every extracted relation records its source line, the extraction method,
 * and whether the extraction is deterministic (explicit syntax) or heuristic
 * (pattern recognition over prose). Heuristic relations must never be
 * presented as proven facts downstream.
 */

export type TraceabilityConfidence = 'deterministic' | 'heuristic';

/* ------------------------------------------------------------------ *
 * Requirement identifier canonicalization
 * ------------------------------------------------------------------ */

const ID_PREFIX = /^(?:requirements?|req|r|ac|criterion)[-_. ]?(?=\d)/i;
const CANONICAL_SHAPE = /^\d+(?:[.-]\d+)*$/;

/**
 * Canonical form of a requirement/criterion reference, or undefined when the
 * text is not identifier-shaped. Documented normalization rules:
 *
 *   - case-insensitive
 *   - optional `R`, `REQ`, `AC`, `Requirement`, `Criterion` prefix with an
 *     optional `-`, `_`, `.`, or space separator is stripped
 *   - `-` separators between numbers are treated as `.`
 *   - leading zeros in each numeric segment are dropped (REQ-001 ≡ REQ-1)
 *
 * Examples: `R1` → `1`, `REQ-001` → `1`, `Requirement 2` → `2`,
 * `AC1.2` → `1.2`, `1.1` → `1.1`. Free text like `TBD` returns undefined.
 */
export function canonicalRequirementRef(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  const withoutPrefix = trimmed.replace(ID_PREFIX, '');
  if (!CANONICAL_SHAPE.test(withoutPrefix)) return undefined;
  return withoutPrefix
    .split(/[.-]/)
    .map((segment) => segment.replace(/^0+(?=\d)/, ''))
    .join('.');
}

/* ------------------------------------------------------------------ *
 * Requirement catalog
 * ------------------------------------------------------------------ */

/** Heuristic recognizer for "this explicitly calls for tests" language. */
const TEST_LANGUAGE = /\btest(?:s|ed|ing)?\b|\bunit[- ]tested\b|\bcovered by tests\b/i;

export function mentionsTests(text: string): boolean {
  return TEST_LANGUAGE.test(text);
}

export interface RequirementCatalogEntry {
  /** Identifier as written in the document (e.g. `REQ-001`, `1.2`). */
  displayId: string;
  canonical: string;
  kind: 'requirement' | 'criterion';
  /** 0-based source line of the heading or criterion. */
  line: number;
  title?: string;
  /** Heuristic: the requirement/criterion text explicitly mentions tests. */
  testRequired: boolean;
  /** Canonical id of the owning requirement (itself for requirements). */
  requirementCanonical: string;
  /** How the identifier was recognized. */
  method: 'requirements-parser' | 'id-heading' | 'explicit-ac-marker';
  confidence: TraceabilityConfidence;
}

export interface RequirementCatalog {
  entries: RequirementCatalogEntry[];
  /** Requirement-kind entries only, in document order. */
  requirements: RequirementCatalogEntry[];
  byCanonical: Map<string, RequirementCatalogEntry>;
}

/** Supplemental ID-style headings the tolerant parser does not treat as requirements. */
const ID_HEADING = /^((?:req)[-_. ]?\d+(?:[.-]\d+)*)[ \t]*[:.–—-]?[ \t]*(.*)$/i;
const EXPLICIT_AC_MARKER = /^(ac[-_. ]?\d+(?:[.-]\d+)*)[ \t]*[:.–—-][ \t]*/i;
const ORDERED_ITEM = /^[ \t]*(\d+)[.)][ \t]+(.+)$/;

/**
 * Build the catalog of identifiable requirements and acceptance criteria.
 *
 * Sources, in order:
 *   1. the tolerant requirements parser (`Requirement 1`, `R1` headings and
 *      their numbered acceptance criteria) — deterministic
 *   2. supplemental `REQ-001`-style level 2–4 headings the parser does not
 *      recognize as requirements — deterministic
 *   3. explicit `AC-1:` markers inside criterion text — deterministic aliases
 */
export function buildRequirementCatalog(
  model: RequirementsModel,
  document?: MarkdownDocument,
): RequirementCatalog {
  const entries: RequirementCatalogEntry[] = [];
  const byCanonical = new Map<string, RequirementCatalogEntry>();

  const add = (entry: RequirementCatalogEntry): void => {
    entries.push(entry);
    if (!byCanonical.has(entry.canonical)) byCanonical.set(entry.canonical, entry);
  };

  for (const requirement of model.requirements) {
    const canonical = canonicalRequirementRef(requirement.id);
    if (canonical === undefined) continue;
    const requirementEntry: RequirementCatalogEntry = {
      displayId: requirement.id,
      canonical,
      kind: 'requirement',
      line: requirement.headingLine,
      ...(requirement.title !== undefined ? { title: requirement.title } : {}),
      testRequired:
        (requirement.title !== undefined && mentionsTests(requirement.title)) ||
        requirement.criteria.some((criterion) => mentionsTests(criterion.text)),
      requirementCanonical: canonical,
      method: 'requirements-parser',
      confidence: 'deterministic',
    };
    add(requirementEntry);

    for (const criterion of requirement.criteria) {
      const criterionCanonical = canonicalRequirementRef(criterion.id);
      if (criterionCanonical === undefined) continue;
      add({
        displayId: criterion.id,
        canonical: criterionCanonical,
        kind: 'criterion',
        line: criterion.line,
        testRequired: mentionsTests(criterion.text),
        requirementCanonical: canonical,
        method: 'requirements-parser',
        confidence: 'deterministic',
      });
      // An explicit `AC-3:` marker at the start of the criterion text is an
      // alias the author expects tasks to reference.
      const marker = EXPLICIT_AC_MARKER.exec(criterion.text);
      const markerCanonical =
        marker?.[1] !== undefined ? canonicalRequirementRef(marker[1]) : undefined;
      if (markerCanonical !== undefined && markerCanonical !== criterionCanonical) {
        add({
          displayId: (marker as RegExpExecArray)[1] as string,
          canonical: markerCanonical,
          kind: 'criterion',
          line: criterion.line,
          testRequired: mentionsTests(criterion.text),
          requirementCanonical: canonical,
          method: 'explicit-ac-marker',
          confidence: 'deterministic',
        });
      }
    }
  }

  // Supplemental REQ-### headings (level 2–4) outside recognized requirements.
  if (document !== undefined) {
    const knownHeadingLines = new Set(model.requirements.map((r) => r.headingLine));
    const sections = document.sections();
    const mask = document.codeFenceMask();
    for (const section of sections) {
      if (section.heading.level < 2 || section.heading.level > 4) continue;
      if (knownHeadingLines.has(section.heading.line)) continue;
      const match = ID_HEADING.exec(section.heading.text.trim());
      if (match === null || match[1] === undefined) continue;
      const canonical = canonicalRequirementRef(match[1]);
      if (canonical === undefined || byCanonical.has(canonical)) continue;
      const title = (match[2] ?? '').trim();
      const sectionText = document.getText(section.startLine, section.endLine);
      const entry: RequirementCatalogEntry = {
        displayId: match[1],
        canonical,
        kind: 'requirement',
        line: section.heading.line,
        ...(title.length > 0 ? { title } : {}),
        testRequired: mentionsTests(sectionText),
        requirementCanonical: canonical,
        method: 'id-heading',
        confidence: 'deterministic',
      };
      add(entry);
      // Numbered list items in the section become its criteria.
      for (let i = section.startLine + 1; i < section.endLine; i += 1) {
        if (mask[i] === true) continue;
        const item = ORDERED_ITEM.exec(document.lineAt(i).text);
        if (item === null || item[1] === undefined || item[2] === undefined) continue;
        const criterionCanonical = `${canonical}.${item[1].replace(/^0+(?=\d)/, '')}`;
        if (byCanonical.has(criterionCanonical)) continue;
        add({
          displayId: `${match[1]}.${item[1]}`,
          canonical: criterionCanonical,
          kind: 'criterion',
          line: i,
          testRequired: mentionsTests(item[2]),
          requirementCanonical: canonical,
          method: 'id-heading',
          confidence: 'deterministic',
        });
      }
    }
  }

  return {
    entries,
    requirements: entries.filter((entry) => entry.kind === 'requirement'),
    byCanonical,
  };
}

/* ------------------------------------------------------------------ *
 * Task requirement references
 * ------------------------------------------------------------------ */

export type TaskReferenceMethod =
  | 'underscore-refs'
  | 'refs-line'
  | 'bracket-ref'
  | 'keyword-ref';

export interface TaskRequirementReference {
  taskId: string;
  /** Reference text as written (single identifier). */
  raw: string;
  /** Canonical identifier, or undefined when the text is not id-shaped. */
  canonical?: string;
  /** 0-based line the reference appears on. */
  line: number;
  method: TaskReferenceMethod;
  confidence: TraceabilityConfidence;
}

const UNDERSCORE_REFS = /_[ \t]*requirements?[ \t]*:[ \t]*([^_]*)_/i;
const REFS_LINE = /^[ \t]*(?:[-*+][ \t]+)?requirements?[ \t]*:[ \t]*(.+)$/i;
/** `[R1]`-style bracket refs; a following `(` would make it a Markdown link. */
const BRACKET_REF = /\[[ \t]*((?:req|r|ac)[-_. ]?\d+(?:[.-]\d+)*)[ \t]*\](?!\()/gi;
const KEYWORD_REF =
  /\b(?:supports|implements|covers|satisfies|fulfils|fulfills|addresses)[ \t]+((?:requirements?|req|r|ac)[-_. ]?\d+(?:[.-]\d+)*|\d+(?:\.\d+)+)/gi;

function splitReferenceList(list: string): string[] {
  return list
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function ownerTaskAt(tasks: readonly TaskItem[], line: number): TaskItem | undefined {
  let owner: TaskItem | undefined;
  for (const task of tasks) {
    if (task.line <= line) owner = task;
    else break;
  }
  return owner;
}

/**
 * Extract every task-to-requirement reference with source lines.
 *
 * Recognized forms (first three deterministic, keyword form heuristic):
 *   - `_Requirements: 1.1, 2.3_` detail lines (the documented Kiro form)
 *   - `Requirements: R1, R2` detail lines without underscores
 *   - `[R1]` / `[REQ-001]` bracket references in titles or details
 *   - `Supports REQ-001` / `Implements 1.2` keyword references (heuristic)
 */
export function extractTaskRequirementReferences(
  document: MarkdownDocument,
  tasks: TasksModel,
): TaskRequirementReference[] {
  const references: TaskRequirementReference[] = [];
  if (tasks.allTasks.length === 0) return references;
  const mask = document.codeFenceMask();
  const orderedTasks = [...tasks.allTasks].sort((a, b) => a.line - b.line);
  const firstTaskLine = orderedTasks[0]?.line ?? 0;
  const seen = new Set<string>();

  const push = (
    task: TaskItem,
    raw: string,
    line: number,
    method: TaskReferenceMethod,
    confidence: TraceabilityConfidence,
  ): void => {
    const canonical = canonicalRequirementRef(raw);
    const key = `${task.id} ${canonical ?? raw.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({
      taskId: task.id,
      raw,
      ...(canonical !== undefined ? { canonical } : {}),
      line,
      method,
      confidence,
    });
  };

  for (let i = firstTaskLine; i < document.lineCount; i += 1) {
    if (mask[i] === true) continue;
    const owner = ownerTaskAt(orderedTasks, i);
    if (owner === undefined) continue;
    const text = document.lineAt(i).text;
    const isTaskLine = orderedTasks.some((task) => task.line === i);

    if (!isTaskLine) {
      const underscore = UNDERSCORE_REFS.exec(text);
      if (underscore !== null) {
        for (const item of splitReferenceList(underscore[1] ?? '')) {
          push(owner, item, i, 'underscore-refs', 'deterministic');
        }
      } else {
        const refsLine = REFS_LINE.exec(text);
        if (refsLine !== null) {
          for (const item of splitReferenceList(refsLine[1] ?? '')) {
            // Only id-shaped items count — `Requirements: see above` is prose.
            if (canonicalRequirementRef(item) !== undefined) {
              push(owner, item, i, 'refs-line', 'deterministic');
            }
          }
        }
      }
    }

    for (const match of text.matchAll(BRACKET_REF)) {
      if (match[1] !== undefined) push(owner, match[1], i, 'bracket-ref', 'deterministic');
    }
    for (const match of text.matchAll(KEYWORD_REF)) {
      if (match[1] !== undefined) push(owner, match[1], i, 'keyword-ref', 'heuristic');
    }
  }

  return references;
}

/** Heuristic: the task's title or detail lines explicitly mention tests. */
export function taskMentionsTests(
  document: MarkdownDocument,
  tasks: TasksModel,
  task: TaskItem,
): boolean {
  if (mentionsTests(task.title)) return true;
  const orderedTasks = [...tasks.allTasks].sort((a, b) => a.line - b.line);
  const next = orderedTasks.find((candidate) => candidate.line > task.line);
  const endLine = next?.line ?? document.lineCount;
  const mask = document.codeFenceMask();
  for (let i = task.line + 1; i < endLine; i += 1) {
    if (mask[i] === true) continue;
    if (mentionsTests(document.lineAt(i).text)) return true;
  }
  return false;
}

/**
 * Heuristic: tasks that are clearly not requirement-implementing work
 * (documentation, release, cleanup, formatting chores). Used to exclude
 * them from "task has no requirement reference" findings — never to excuse
 * missing evidence.
 */
const NON_REQUIREMENT_TASK =
  /\b(document|documentation|docs|readme|changelog|release|publish|version bump|cleanup|clean up|chore|lint|format|typo)\b/i;

export function isLikelyNonRequirementTask(task: TaskItem): boolean {
  return NON_REQUIREMENT_TASK.test(task.title);
}

/* ------------------------------------------------------------------ *
 * Explicit repository path references
 * ------------------------------------------------------------------ */

export type PathReferenceMethod = 'backtick-path' | 'markdown-link';

export interface PathReference {
  /** Text exactly as written (backtick content or link target). */
  raw: string;
  /** Normalized repo-relative POSIX path candidate (no leading `./`). */
  path: string;
  /** 0-based source line. */
  line: number;
  method: PathReferenceMethod;
  confidence: TraceabilityConfidence;
  /** Contains glob characters — usable as an impact-area hint, not a file. */
  isGlob: boolean;
}

const BACKTICK_SPAN = /`([^`\n]+)`/g;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^()\s]+)\)/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const GLOB_CHARS = /[*?[\]{}]/;
const CODE_TOKEN = /[(){}<>;=,]|::|=>/;

function normalizePathCandidate(raw: string): string | undefined {
  let candidate = raw.trim();
  if (candidate.length === 0 || candidate.includes('\0') || /\s/.test(candidate)) {
    return undefined;
  }
  if (URL_SCHEME.test(candidate) || candidate.startsWith('#')) return undefined;
  if (CODE_TOKEN.test(candidate)) return undefined;
  candidate = candidate.split('\\').join('/');
  candidate = candidate.replace(/^\.\//, '');
  // Absolute paths and traversal cannot be repo-relative references.
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) return undefined;
  if (candidate.split('/').includes('..')) return undefined;
  // Strip anchors/queries from link targets.
  candidate = candidate.replace(/[#?].*$/, '');
  if (candidate.length === 0) return undefined;
  // A path needs a directory separator to be an unambiguous repository path;
  // bare file names (`config.json`) could live anywhere and are skipped.
  if (!candidate.includes('/')) return undefined;
  if (candidate.endsWith('/')) candidate = candidate.slice(0, -1);
  if (candidate.length === 0) return undefined;
  return candidate;
}

/**
 * Explicit repository paths written in a document: backtick spans that look
 * like paths and Markdown links to repository files. Deterministic — the
 * syntax is explicit; no prose inference happens here.
 */
export function extractPathReferences(document: MarkdownDocument): PathReference[] {
  const references: PathReference[] = [];
  const mask = document.codeFenceMask();
  const seen = new Set<string>();

  for (let i = 0; i < document.lineCount; i += 1) {
    if (mask[i] === true) continue;
    const text = document.lineAt(i).text;

    for (const match of text.matchAll(BACKTICK_SPAN)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const path = normalizePathCandidate(raw);
      if (path === undefined) continue;
      const key = `${path} ${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({
        raw,
        path,
        line: i,
        method: 'backtick-path',
        confidence: 'deterministic',
        isGlob: GLOB_CHARS.test(path),
      });
    }

    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const path = normalizePathCandidate(raw);
      if (path === undefined) continue;
      const key = `${path} ${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({
        raw,
        path,
        line: i,
        method: 'markdown-link',
        confidence: 'deterministic',
        isGlob: GLOB_CHARS.test(path),
      });
    }
  }

  return references;
}
