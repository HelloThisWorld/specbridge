import type { Diagnostic } from '@specbridge/core';
import type { MarkdownDocument } from './markdown-document.js';

/**
 * Tolerant bugfix.md parser.
 *
 * Detects common bugfix-spec concepts by heading name. No heading is
 * required; unrecognized sections are listed and preserved.
 */

export type BugfixConcept =
  | 'current-behavior'
  | 'expected-behavior'
  | 'unchanged-behavior'
  | 'root-cause'
  | 'regression-protection'
  | 'reproduction'
  | 'evidence'
  | 'constraints'
  | 'proposed-fix'
  | 'validation-strategy';

export interface BugfixSectionRef {
  title: string;
  level: number;
  startLine: number;
  endLine: number;
}

export interface BugfixModel {
  filePath?: string;
  title?: string;
  concepts: Partial<Record<BugfixConcept, BugfixSectionRef>>;
  unknownSections: BugfixSectionRef[];
  diagnostics: Diagnostic[];
}

function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONCEPT_MATCHERS: [RegExp, BugfixConcept][] = [
  [/^current behaviou?r$|^actual behaviou?r$/, 'current-behavior'],
  [/^expected behaviou?r$|^desired behaviou?r$/, 'expected-behavior'],
  [/^unchanged behaviou?r$|^behaviou?r to preserve$/, 'unchanged-behavior'],
  [/^root cause( analysis)?$/, 'root-cause'],
  [/^regression protection$|^regression risks?$|^regression tests?$/, 'regression-protection'],
  [/^reproduction( steps)?$|^steps to reproduce$|^repro( steps)?$/, 'reproduction'],
  [/^evidence$|^logs?$|^observed evidence$/, 'evidence'],
  [/^constraints?$/, 'constraints'],
  [/^proposed fix$|^fix$|^fix approach$/, 'proposed-fix'],
  [/^validation( strategy)?$|^verification( strategy)?$/, 'validation-strategy'],
];

export function classifyBugfixHeading(text: string): BugfixConcept | undefined {
  const normalized = normalizeHeading(text);
  for (const [pattern, concept] of CONCEPT_MATCHERS) {
    if (pattern.test(normalized)) return concept;
  }
  return undefined;
}

export function parseBugfix(document: MarkdownDocument): BugfixModel {
  const diagnostics: Diagnostic[] = [];
  const concepts: Partial<Record<BugfixConcept, BugfixSectionRef>> = {};
  const unknownSections: BugfixSectionRef[] = [];

  for (const section of document.sections()) {
    if (section.heading.level < 2 || section.heading.level > 4) continue;
    const ref: BugfixSectionRef = {
      title: section.heading.text,
      level: section.heading.level,
      startLine: section.startLine,
      endLine: section.endLine,
    };
    const concept = classifyBugfixHeading(section.heading.text);
    if (concept === undefined) {
      if (section.heading.level === 2) unknownSections.push(ref);
      continue;
    }
    // Keep the first occurrence; duplicates are unusual but harmless.
    if (concepts[concept] === undefined) concepts[concept] = ref;
  }

  const behaviorConcepts: BugfixConcept[] = [
    'current-behavior',
    'expected-behavior',
    'unchanged-behavior',
  ];
  if (behaviorConcepts.every((concept) => concepts[concept] === undefined)) {
    diagnostics.push({
      severity: 'info',
      code: 'BUGFIX_NO_BEHAVIOR_SECTIONS',
      message:
        'bugfix.md has no recognized behavior sections (Current/Expected/Unchanged Behavior); the file is preserved as-is.',
      ...(document.filePath !== undefined ? { file: document.filePath } : {}),
    });
  }

  const title = document.title();
  return {
    ...(document.filePath !== undefined ? { filePath: document.filePath } : {}),
    ...(title !== undefined ? { title } : {}),
    concepts,
    unknownSections,
    diagnostics,
  };
}
