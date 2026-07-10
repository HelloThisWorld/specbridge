import { describe, expect, it } from 'vitest';
import { MarkdownDocument, parseDesign } from '@specbridge/compat-kiro';
import { fixturePath } from '../helpers.js';

describe('design parser', () => {
  it('recognizes well-known section kinds and counts mermaid blocks', () => {
    const doc = MarkdownDocument.load(
      fixturePath('standard-feature', '.kiro', 'specs', 'user-authentication', 'design.md'),
    );
    const model = parseDesign(doc);
    expect(model.title).toBe('Design Document');
    expect(model.sections.map((s) => s.kind)).toEqual([
      'overview',
      'architecture',
      'components',
      'data-model',
      'error-handling',
      'testing',
    ]);
    expect(model.mermaidBlockCount).toBe(1);
  });

  it('classifies bugfix-style design sections', () => {
    const doc = MarkdownDocument.load(
      fixturePath('bugfix-spec', '.kiro', 'specs', 'login-timeout-fix', 'design.md'),
    );
    const model = parseDesign(doc);
    const kinds = model.sections.map((s) => s.kind);
    expect(kinds).toContain('root-cause');
    expect(kinds).toContain('proposed-fix');
    expect(kinds).toContain('risks');
    expect(kinds).toContain('testing');
  });

  it('keeps unknown sections as unknown without diagnostics noise', () => {
    const doc = MarkdownDocument.fromText(
      ['# D', '## Frobnication Strategy', 'x', '## Overview', 'y', ''].join('\n'),
    );
    const model = parseDesign(doc);
    expect(model.sections.map((s) => `${s.kind}:${s.title}`)).toEqual([
      'unknown:Frobnication Strategy',
      'overview:Overview',
    ]);
    expect(model.diagnostics).toEqual([]);
  });

  it('handles a design file with no sections', () => {
    const model = parseDesign(MarkdownDocument.fromText('just prose\n'));
    expect(model.sections).toEqual([]);
    expect(model.diagnostics.some((d) => d.code === 'DESIGN_NO_SECTIONS')).toBe(true);
  });
});
