import type { Diagnostic } from '@specbridge/core';
import type { DocumentSection, MarkdownDocument } from './markdown-document.js';

/**
 * Tolerant requirements.md parser.
 *
 * Recognizes the documented Kiro shape:
 *
 *   # Requirements Document
 *   ## Introduction
 *   ## Requirements
 *   ### Requirement 1
 *   **User Story:** As a ..., I want ..., so that ...
 *   #### Acceptance Criteria
 *   1. WHEN ... THEN the system SHALL ...
 *
 * Custom headings are collected as unknown sections and preserved — a file
 * with zero recognized requirements is still a valid file.
 */

export interface AcceptanceCriterion {
  /** `<requirementId>.<listNumber>`, e.g. `1.2` — the id tasks reference. */
  id: string;
  number: string;
  text: string;
  /** 0-based line index. */
  line: number;
  /** True when the criterion uses EARS-style keywords (WHEN/IF ... SHALL). */
  ears: boolean;
}

export interface RequirementBlock {
  id: string;
  title?: string;
  userStory?: string;
  criteria: AcceptanceCriterion[];
  headingLine: number;
  startLine: number;
  endLine: number;
}

export interface UnknownSection {
  title: string;
  line: number;
  level: number;
}

export interface RequirementsModel {
  filePath?: string;
  title?: string;
  introduction?: { startLine: number; endLine: number };
  requirements: RequirementBlock[];
  unknownSections: UnknownSection[];
  diagnostics: Diagnostic[];
}

// The id must contain a digit so document titles like "Requirements Document"
// are never mistaken for a requirement block.
const REQUIREMENT_HEADING =
  /^requirements?[ \t]+((?:[A-Za-z]{1,4}-?)?\d[A-Za-z0-9.]*)[ \t]*[:.–—-]?[ \t]*(.*)$/i;
const REQUIREMENT_ID_HEADING = /^(R-?\d+(?:\.\d+)*)[ \t]*[:.–—-]?[ \t]*(.*)$/;
const USER_STORY = /\*\*[ \t]*user story[ \t]*:?[ \t]*\*\*[ \t]*:?[ \t]*(.*)$/i;
const ORDERED_ITEM = /^[ \t]*(\d+)[.)][ \t]+(.+)$/;
const BULLET_ITEM = /^[ \t]*[-*+][ \t]+(.+)$/;
const EARS = /\b(when|if|while|where)\b[\s\S]*\bshall\b/i;
const KNOWN_TOP_SECTIONS = new Set(['introduction', 'overview', 'summary', 'requirements']);

function matchRequirementHeading(text: string): { id: string; title?: string } | undefined {
  const trimmed = text.trim();
  const named = REQUIREMENT_HEADING.exec(trimmed);
  if (named !== null && named[1] !== undefined) {
    const title = (named[2] ?? '').trim();
    return { id: named[1], ...(title.length > 0 ? { title } : {}) };
  }
  const shorthand = REQUIREMENT_ID_HEADING.exec(trimmed);
  if (shorthand !== null && shorthand[1] !== undefined) {
    const title = (shorthand[2] ?? '').trim();
    return { id: shorthand[1], ...(title.length > 0 ? { title } : {}) };
  }
  return undefined;
}

function parseCriteria(
  document: MarkdownDocument,
  requirementId: string,
  section: DocumentSection,
  mask: boolean[],
  diagnostics: Diagnostic[],
): AcceptanceCriterion[] {
  // Find an "Acceptance Criteria" heading inside the requirement section.
  const acHeading = document
    .headings()
    .find(
      (h) =>
        h.line > section.startLine &&
        h.line < section.endLine &&
        /acceptance criteria/i.test(h.text),
    );
  if (acHeading === undefined) return [];

  // The criteria list runs until the next heading or the end of the requirement.
  const nextHeading = document
    .headings()
    .find((h) => h.line > acHeading.line && h.line < section.endLine);
  const endLine = nextHeading?.line ?? section.endLine;

  const criteria: AcceptanceCriterion[] = [];
  let unnumberedCount = 0;
  for (let i = acHeading.line + 1; i < endLine; i += 1) {
    if (mask[i] === true) continue;
    const text = document.lineAt(i).text;
    const ordered = ORDERED_ITEM.exec(text);
    if (ordered !== null && ordered[1] !== undefined && ordered[2] !== undefined) {
      criteria.push({
        id: `${requirementId}.${ordered[1]}`,
        number: ordered[1],
        text: ordered[2].trim(),
        line: i,
        ears: EARS.test(ordered[2]),
      });
      continue;
    }
    const bullet = BULLET_ITEM.exec(text);
    if (bullet !== null && bullet[1] !== undefined && criteria.length === 0) {
      unnumberedCount += 1;
      criteria.push({
        id: `${requirementId}.${unnumberedCount}`,
        number: String(unnumberedCount),
        text: bullet[1].trim(),
        line: i,
        ears: EARS.test(bullet[1]),
      });
      // Deliberately keep collecting bullets: reset criteria.length guard.
      // (criteria.length is now > 0, so subsequent bullets fall through.)
      continue;
    }
    if (bullet !== null && bullet[1] !== undefined && unnumberedCount > 0) {
      unnumberedCount += 1;
      criteria.push({
        id: `${requirementId}.${unnumberedCount}`,
        number: String(unnumberedCount),
        text: bullet[1].trim(),
        line: i,
        ears: EARS.test(bullet[1]),
      });
    }
  }
  if (unnumberedCount > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'REQUIREMENTS_UNNUMBERED_CRITERIA',
      message: `Requirement ${requirementId} uses unnumbered acceptance criteria; SpecBridge assigned positional numbers.`,
      ...(document.filePath !== undefined ? { file: document.filePath } : {}),
      line: acHeading.line + 1,
    });
  }
  return criteria;
}

export function parseRequirements(document: MarkdownDocument): RequirementsModel {
  const diagnostics: Diagnostic[] = [];
  const mask = document.codeFenceMask();
  const sections = document.sections();

  const requirements: RequirementBlock[] = [];
  const seenIds = new Map<string, number>();
  const requirementSections: DocumentSection[] = [];

  for (const section of sections) {
    // Requirement blocks are sub-headings (h2–h4); the h1 is the document title.
    if (section.heading.level < 2 || section.heading.level > 4) continue;
    const match = matchRequirementHeading(section.heading.text);
    if (match === undefined) continue;
    requirementSections.push(section);

    const previous = seenIds.get(match.id);
    if (previous !== undefined) {
      diagnostics.push({
        severity: 'warning',
        code: 'REQUIREMENTS_DUPLICATE_ID',
        message: `Requirement id ${match.id} appears more than once (also on line ${previous}).`,
        ...(document.filePath !== undefined ? { file: document.filePath } : {}),
        line: section.heading.line + 1,
      });
    } else {
      seenIds.set(match.id, section.heading.line + 1);
    }

    let userStory: string | undefined;
    for (let i = section.startLine + 1; i < section.endLine; i += 1) {
      if (mask[i] === true) continue;
      const storyMatch = USER_STORY.exec(document.lineAt(i).text);
      if (storyMatch !== null) {
        userStory = (storyMatch[1] ?? '').trim();
        if (userStory.length === 0) {
          // Story text may wrap to the following line.
          const next = i + 1 < section.endLine ? document.lineAt(i + 1).text.trim() : '';
          userStory = next.length > 0 ? next : undefined;
        }
        break;
      }
    }

    const criteria = parseCriteria(document, match.id, section, mask, diagnostics);
    if (criteria.length === 0) {
      diagnostics.push({
        severity: 'info',
        code: 'REQUIREMENTS_NO_CRITERIA',
        message: `Requirement ${match.id} has no recognized acceptance criteria.`,
        ...(document.filePath !== undefined ? { file: document.filePath } : {}),
        line: section.heading.line + 1,
      });
    }

    requirements.push({
      id: match.id,
      ...(match.title !== undefined ? { title: match.title } : {}),
      ...(userStory !== undefined ? { userStory } : {}),
      criteria,
      headingLine: section.heading.line,
      startLine: section.startLine,
      endLine: section.endLine,
    });
  }

  const introductionSection = sections.find(
    (s) =>
      s.heading.level <= 2 && /^(introduction|overview|summary)$/i.test(s.heading.text.trim()),
  );

  // Unknown sections: level-2 headings that are neither known top-level
  // sections nor requirement headings nor inside a requirement block.
  const unknownSections: UnknownSection[] = [];
  for (const section of sections) {
    if (section.heading.level !== 2) continue;
    const text = section.heading.text.trim().toLowerCase();
    if (KNOWN_TOP_SECTIONS.has(text)) continue;
    if (matchRequirementHeading(section.heading.text) !== undefined) continue;
    const insideRequirement = requirementSections.some(
      (r) => section.heading.line > r.startLine && section.heading.line < r.endLine,
    );
    if (insideRequirement) continue;
    unknownSections.push({
      title: section.heading.text,
      line: section.heading.line,
      level: section.heading.level,
    });
  }

  if (requirements.length === 0) {
    diagnostics.push({
      severity: 'info',
      code: 'REQUIREMENTS_NONE_RECOGNIZED',
      message:
        'No "Requirement N" headings recognized. The file is preserved as-is; task-to-requirement linking is unavailable.',
      ...(document.filePath !== undefined ? { file: document.filePath } : {}),
    });
  }

  const title = document.title();
  return {
    ...(document.filePath !== undefined ? { filePath: document.filePath } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(introductionSection !== undefined
      ? {
          introduction: {
            startLine: introductionSection.startLine,
            endLine: introductionSection.endLine,
          },
        }
      : {}),
    requirements,
    unknownSections,
    diagnostics,
  };
}
