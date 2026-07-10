import type { Diagnostic } from '@specbridge/core';
import type { MarkdownDocument } from './markdown-document.js';

/**
 * Tolerant design.md parser.
 *
 * Design documents are free-form; we detect well-known section names to power
 * summaries and future drift checks, and list everything else as unknown
 * sections. Nothing is required and nothing is rewritten.
 */

export type DesignSectionKind =
  | 'overview'
  | 'context'
  | 'goals'
  | 'non-goals'
  | 'architecture'
  | 'components'
  | 'interfaces'
  | 'data-model'
  | 'error-handling'
  | 'security'
  | 'observability'
  | 'testing'
  | 'risks'
  | 'alternatives'
  | 'migration'
  | 'root-cause'
  | 'proposed-fix'
  | 'unknown';

export interface DesignSection {
  title: string;
  kind: DesignSectionKind;
  level: number;
  startLine: number;
  endLine: number;
}

export interface DesignModel {
  filePath?: string;
  title?: string;
  sections: DesignSection[];
  mermaidBlockCount: number;
  diagnostics: Diagnostic[];
}

/** Ordered matchers — first hit wins, so put more specific names first. */
const KIND_MATCHERS: [RegExp, DesignSectionKind][] = [
  [/non[- ]goals?/i, 'non-goals'],
  [/goals?/i, 'goals'],
  [/root cause/i, 'root-cause'],
  [/proposed fix|fix approach/i, 'proposed-fix'],
  [/data model|data models|schema/i, 'data-model'],
  [/error handling|failure handling|failure modes?/i, 'error-handling'],
  [/components?( and interfaces?)?/i, 'components'],
  [/interfaces?|api/i, 'interfaces'],
  [/testing|test strategy|validation strategy/i, 'testing'],
  [/security|threat model/i, 'security'],
  [/observability|monitoring|telemetry/i, 'observability'],
  [/risks?|regression risks?/i, 'risks'],
  [/alternatives?|options considered/i, 'alternatives'],
  [/migration|rollout|deployment/i, 'migration'],
  [/architecture/i, 'architecture'],
  [/overview|introduction|summary/i, 'overview'],
  [/context|background/i, 'context'],
];

export function classifyDesignHeading(text: string): DesignSectionKind {
  for (const [pattern, kind] of KIND_MATCHERS) {
    if (pattern.test(text)) return kind;
  }
  return 'unknown';
}

export function parseDesign(document: MarkdownDocument): DesignModel {
  const diagnostics: Diagnostic[] = [];
  const sections: DesignSection[] = [];

  for (const section of document.sections()) {
    if (section.heading.level < 2 || section.heading.level > 3) continue;
    sections.push({
      title: section.heading.text,
      kind: classifyDesignHeading(section.heading.text),
      level: section.heading.level,
      startLine: section.startLine,
      endLine: section.endLine,
    });
  }

  const mermaidBlockCount = document
    .fenceInfoStrings()
    .filter((info) => info.toLowerCase().startsWith('mermaid')).length;

  if (sections.length === 0) {
    diagnostics.push({
      severity: 'info',
      code: 'DESIGN_NO_SECTIONS',
      message: 'design.md has no level-2/3 headings; the file is preserved as-is.',
      ...(document.filePath !== undefined ? { file: document.filePath } : {}),
    });
  }

  const title = document.title();
  return {
    ...(document.filePath !== undefined ? { filePath: document.filePath } : {}),
    ...(title !== undefined ? { title } : {}),
    sections,
    mermaidBlockCount,
    diagnostics,
  };
}
