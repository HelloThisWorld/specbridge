import { describe, expect, it } from 'vitest';
import { MarkdownDocument, parseBugfix } from '@specbridge/compat-kiro';
import { fixturePath } from '../helpers.js';

describe('bugfix parser', () => {
  it('detects common bugfix concepts by heading', () => {
    const doc = MarkdownDocument.load(
      fixturePath('bugfix-spec', '.kiro', 'specs', 'login-timeout-fix', 'bugfix.md'),
    );
    const model = parseBugfix(doc);
    expect(Object.keys(model.concepts).sort()).toEqual([
      'current-behavior',
      'evidence',
      'expected-behavior',
      'reproduction',
      'unchanged-behavior',
    ]);
    expect(model.diagnostics).toEqual([]);
  });

  it('does not require every heading to be present', () => {
    const doc = MarkdownDocument.fromText(
      ['# Fix', '## Current Behavior', 'x', '## Root Cause', 'y', ''].join('\n'),
    );
    const model = parseBugfix(doc);
    expect(model.concepts['current-behavior']).toBeDefined();
    expect(model.concepts['root-cause']).toBeDefined();
    expect(model.concepts['expected-behavior']).toBeUndefined();
    expect(model.diagnostics).toEqual([]);
  });

  it('tolerates a bugfix file with no recognized sections', () => {
    const model = parseBugfix(
      MarkdownDocument.fromText(['# Fix', '## Whatever', 'prose', ''].join('\n')),
    );
    expect(Object.keys(model.concepts)).toEqual([]);
    expect(model.unknownSections.map((s) => s.title)).toEqual(['Whatever']);
    expect(model.diagnostics.some((d) => d.code === 'BUGFIX_NO_BEHAVIOR_SECTIONS')).toBe(true);
    expect(model.diagnostics.every((d) => d.severity === 'info')).toBe(true);
  });

  it('matches heading variants (behaviour spelling, regression risks)', () => {
    const doc = MarkdownDocument.fromText(
      ['# F', '## Current Behaviour', 'a', '## Regression Risks', 'b', ''].join('\n'),
    );
    const model = parseBugfix(doc);
    expect(model.concepts['current-behavior']).toBeDefined();
    expect(model.concepts['regression-protection']).toBeDefined();
  });
});
