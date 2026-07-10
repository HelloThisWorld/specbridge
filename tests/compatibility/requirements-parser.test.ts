import { describe, expect, it } from 'vitest';
import { MarkdownDocument, parseRequirements } from '@specbridge/compat-kiro';
import { fixturePath } from '../helpers.js';

describe('requirements parser', () => {
  it('parses Kiro-style requirements with EARS criteria', () => {
    const doc = MarkdownDocument.load(
      fixturePath('standard-feature', '.kiro', 'specs', 'user-authentication', 'requirements.md'),
    );
    const model = parseRequirements(doc);
    expect(model.title).toBe('Requirements Document');
    expect(model.introduction).toBeDefined();
    expect(model.requirements.map((r) => r.id)).toEqual(['1', '2']);

    const first = model.requirements[0]!;
    expect(first.userStory).toContain('As a registered customer');
    expect(first.criteria.map((c) => c.id)).toEqual(['1.1', '1.2', '1.3']);
    expect(first.criteria.every((c) => c.ears)).toBe(true);
    expect(model.requirements[1]!.criteria.map((c) => c.id)).toEqual(['2.1', '2.2', '2.3']);
    expect(model.unknownSections).toEqual([]);
  });

  it('handles requirement headings with titles', () => {
    const doc = MarkdownDocument.load(
      fixturePath('manually-edited-feature', '.kiro', 'specs', 'search-filters', 'requirements.md'),
    );
    const model = parseRequirements(doc);
    expect(model.requirements).toHaveLength(1);
    expect(model.requirements[0]!.id).toBe('1');
    expect(model.requirements[0]!.title).toBe('Filter by category');
    // Custom sections are surfaced, not destroyed.
    expect(model.unknownSections.map((s) => s.title)).toEqual(['Open Questions', 'Team Notes']);
  });

  it('reports zero requirements for custom formats without failing', () => {
    const doc = MarkdownDocument.load(
      fixturePath('unknown-headings', '.kiro', 'specs', 'custom-spec', 'requirements.md'),
    );
    const model = parseRequirements(doc);
    expect(model.requirements).toEqual([]);
    expect(model.unknownSections.map((s) => s.title)).toEqual([
      'Business Goals',
      'Constraints',
      'Success Metrics',
    ]);
    expect(model.diagnostics.some((d) => d.code === 'REQUIREMENTS_NONE_RECOGNIZED')).toBe(true);
    expect(model.diagnostics.every((d) => d.severity !== 'error')).toBe(true);
  });

  it('preserves non-English user content while extracting structure', () => {
    const doc = MarkdownDocument.load(
      fixturePath('utf8-content', '.kiro', 'specs', 'localized-feature', 'requirements.md'),
    );
    const model = parseRequirements(doc);
    expect(model.requirements).toHaveLength(1);
    expect(model.requirements[0]!.criteria).toHaveLength(2);
    expect(model.requirements[0]!.userStory).toContain('désactiver');
  });

  it('flags duplicate requirement ids', () => {
    const doc = MarkdownDocument.fromText(
      ['# R', '### Requirement 1', 'a', '### Requirement 1', 'b', ''].join('\n'),
    );
    const model = parseRequirements(doc);
    expect(model.diagnostics.some((d) => d.code === 'REQUIREMENTS_DUPLICATE_ID')).toBe(true);
  });
});
