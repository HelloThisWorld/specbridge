import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkdownDocument, checkNoopRoundTrip, writeDocumentAtomic } from '@specbridge/compat-kiro';
import { copyFixtureToTemp, fixturePath } from '../helpers.js';

const FIXTURES = [
  'standard-feature',
  'manually-edited-feature',
  'bugfix-spec',
  'partial-spec',
  'unknown-headings',
  'crlf-files',
  'utf8-content',
];

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('golden no-op round trip (byte identity)', () => {
  for (const fixture of FIXTURES) {
    it(`every Markdown file in ${fixture} reserializes byte-identically`, () => {
      const kiroDir = fixturePath(fixture, '.kiro');
      const markdownFiles = walkFiles(kiroDir).filter((f) => f.toLowerCase().endsWith('.md'));
      expect(markdownFiles.length).toBeGreaterThan(0);
      for (const file of markdownFiles) {
        const check = checkNoopRoundTrip(file);
        expect(check, `${file}: ${check.reason ?? ''}`).toMatchObject({
          identical: true,
          encodingSafe: true,
        });
      }
    });
  }

  it('full golden workflow: hash → parse → write without modification → hash', () => {
    const tempRoot = copyFixtureToTemp('crlf-files');
    const files = walkFiles(path.join(tempRoot, '.kiro')).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(2);

    for (const file of files) {
      const beforeBytes = readFileSync(file);
      const beforeHash = sha256(beforeBytes);

      const document = MarkdownDocument.load(file);
      writeDocumentAtomic(document, file, { workspaceRoot: tempRoot });

      const afterBytes = readFileSync(file);
      expect(sha256(afterBytes)).toBe(beforeHash);
      expect(afterBytes.equals(beforeBytes)).toBe(true);
    }
  });

  it('preserves the UTF-8 BOM through a real write', () => {
    const tempRoot = copyFixtureToTemp('crlf-files');
    const file = path.join(tempRoot, '.kiro', 'specs', 'crlf-feature', 'requirements.md');
    const before = readFileSync(file);
    expect([before[0], before[1], before[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const document = MarkdownDocument.load(file);
    expect(document.hasBom).toBe(true);
    writeDocumentAtomic(document, file, { workspaceRoot: tempRoot });

    const after = readFileSync(file);
    expect(after.equals(before)).toBe(true);
  });

  it('refuses to write outside the workspace root', () => {
    const tempRoot = copyFixtureToTemp('standard-feature');
    const file = path.join(tempRoot, '.kiro', 'specs', 'user-authentication', 'tasks.md');
    const document = MarkdownDocument.load(file);
    expect(() =>
      writeDocumentAtomic(document, path.join(tempRoot, '..', 'escape.md'), {
        workspaceRoot: tempRoot,
      }),
    ).toThrowError(/outside the workspace root/);
  });
});
