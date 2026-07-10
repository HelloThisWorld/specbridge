import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@specbridge/core';
import {
  MarkdownDocument,
  extractFrontMatter,
  listSteeringFiles,
  loadSteeringDocument,
  resolveSteeringName,
} from '@specbridge/compat-kiro';
import { fixturePath } from '../helpers.js';

const workspace = () => {
  const ws = resolveWorkspace(fixturePath('standard-feature'));
  if (ws === undefined) throw new Error('fixture workspace missing');
  return ws;
};

describe('steering discovery', () => {
  it('lists default steering files in canonical order', () => {
    const files = listSteeringFiles(workspace());
    expect(files.map((f) => f.fileName)).toEqual(['product.md', 'tech.md', 'structure.md']);
    expect(files.every((f) => f.isDefault)).toBe(true);
    expect(files.every((f) => f.inclusion === 'always')).toBe(true);
  });

  it('returns an empty list when .kiro/steering is absent', () => {
    const ws = resolveWorkspace(fixturePath('partial-spec'));
    expect(ws).toBeDefined();
    expect(listSteeringFiles(ws!)).toEqual([]);
  });

  it('resolves names case-insensitively, with or without .md', () => {
    expect(resolveSteeringName(workspace(), 'product')?.fileName).toBe('product.md');
    expect(resolveSteeringName(workspace(), 'Product.MD')?.fileName).toBe('product.md');
    expect(resolveSteeringName(workspace(), 'missing')).toBeUndefined();
  });

  it('loads a steering document body', () => {
    const { info, body } = loadSteeringDocument(workspace(), 'product');
    expect(info.name).toBe('product');
    expect(body).toContain('Acme Portal');
  });

  it('throws a helpful error listing available steering files', () => {
    expect(() => loadSteeringDocument(workspace(), 'nope')).toThrowError(/product, tech, structure/);
  });

  it('parses front matter inclusion modes tolerantly', () => {
    const doc = MarkdownDocument.fromText(
      ['---', 'inclusion: fileMatch', 'fileMatchPattern: "src/api/**"', '---', '', '# API rules', ''].join(
        '\n',
      ),
    );
    const frontMatter = extractFrontMatter(doc);
    expect(frontMatter.present).toBe(true);
    expect(frontMatter.data?.['inclusion']).toBe('fileMatch');
    expect(frontMatter.data?.['fileMatchPattern']).toBe('src/api/**');
    expect(frontMatter.endLine).toBe(4);
  });

  it('treats an unterminated front matter fence as content', () => {
    const doc = MarkdownDocument.fromText(['---', 'not: closed', '', '# Title'].join('\n'));
    expect(extractFrontMatter(doc).present).toBe(false);
  });
});
