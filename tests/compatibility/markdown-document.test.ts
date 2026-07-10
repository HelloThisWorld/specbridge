import { describe, expect, it } from 'vitest';
import { MarkdownDocument } from '@specbridge/compat-kiro';

const IDENTITY_CASES: [string, string][] = [
  ['empty file', ''],
  ['single line, no newline', 'hello'],
  ['single line with LF', 'hello\n'],
  ['CRLF endings', 'a\r\nb\r\n'],
  ['lone CR endings', 'a\rb\r'],
  ['mixed endings', 'a\nb\r\nc\rd'],
  ['blank lines and trailing spaces', 'a  \n\n\nb\t\n'],
  ['BOM plus content', '﻿# Title\n\nBody\n'],
  ['BOM only', '﻿'],
  ['unicode content', 'café — Ελληνικά — Русский — ✅🚀\n'],
];

describe('MarkdownDocument line preservation', () => {
  for (const [label, text] of IDENTITY_CASES) {
    it(`serialize(load(x)) === x for ${label}`, () => {
      expect(MarkdownDocument.fromText(text).serialize()).toBe(text);
      const buffer = Buffer.from(text, 'utf8');
      expect(MarkdownDocument.fromBuffer(buffer).toBuffer().equals(buffer)).toBe(true);
    });
  }

  it('flags non-UTF-8 buffers as encoding-unsafe', () => {
    const invalid = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
    const doc = MarkdownDocument.fromBuffer(invalid);
    expect(doc.encodingSafe).toBe(false);
  });

  it('detects headings, strips closing hashes, ignores fenced code', () => {
    const doc = MarkdownDocument.fromText(
      [
        '# Title',
        '',
        '## Section ##',
        '',
        '```md',
        '# not a heading',
        '```',
        '',
        '   ### Indented up to three spaces',
        '#not-a-heading (no space)',
        '',
      ].join('\n'),
    );
    const headings = doc.headings().map((h) => `${h.level}:${h.text}`);
    expect(headings).toEqual(['1:Title', '2:Section', '3:Indented up to three spaces']);
  });

  it('computes sections spanning to the next same-or-higher heading', () => {
    const doc = MarkdownDocument.fromText(
      ['# T', '## A', 'a1', '### A1', 'a2', '## B', 'b1', ''].join('\n'),
    );
    const sections = doc.sections();
    const sectionA = sections.find((s) => s.heading.text === 'A')!;
    expect(sectionA.endLine).toBe(5); // "## B" line index
    const sectionA1 = sections.find((s) => s.heading.text === 'A1')!;
    expect(sectionA1.endLine).toBe(5);
    expect(doc.findSection('a')?.heading.text).toBe('A');
  });

  it('reports dominant line endings and BOM', () => {
    expect(MarkdownDocument.fromText('a\nb\n').dominantEol()).toBe('lf');
    expect(MarkdownDocument.fromText('a\r\nb\r\n').dominantEol()).toBe('crlf');
    expect(MarkdownDocument.fromText('a\nb\r\n').dominantEol()).toBe('mixed');
    expect(MarkdownDocument.fromText('plain').dominantEol()).toBe('none');
    expect(MarkdownDocument.fromText('﻿x\n').hasBom).toBe(true);
  });

  it('setLineText edits exactly one line and rejects line breaks', () => {
    const doc = MarkdownDocument.fromText('a\r\nb\r\nc\r\n');
    doc.setLineText(1, 'B');
    expect(doc.serialize()).toBe('a\r\nB\r\nc\r\n');
    expect(() => doc.setLineText(0, 'x\ny')).toThrowError(/line break/);
  });
});
