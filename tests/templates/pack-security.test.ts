import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_PACK_LIMITS,
  checkPackRendering,
  loadTemplatePack,
  readTemplatePackDirectory,
} from '@specbridge/templates';
import { emptyTempDir, fixedClock } from '../helpers';
import { featureManifest, featurePackFiles, tempPack, tryCreateSymlink } from '../helpers-templates';

function loadDir(dir: string) {
  return loadTemplatePack(readTemplatePackDirectory(dir));
}

describe('pack loading security', () => {
  it('loads a valid feature pack from disk', () => {
    const dir = tempPack(featurePackFiles());
    const pack = loadDir(dir);
    expect(pack.valid).toBe(true);
    expect(pack.manifest?.id).toBe('sample-feature');
    expect(pack.readme).toContain('Sample Feature');
  });

  it('rejects a symlinked file with SBT009', () => {
    const dir = tempPack(featurePackFiles());
    const outside = path.join(emptyTempDir(), 'outside.txt');
    writeFileSync(outside, 'outside content', 'utf8');
    if (!tryCreateSymlink(outside, path.join(dir, 'files', 'link.md.template'))) {
      return; // Platform forbids symlink creation (Windows without dev mode).
    }
    expect(() => readTemplatePackDirectory(dir)).toThrowError(/SBT009/);
  });

  it('rejects a symlinked pack directory with SBT009', () => {
    const real = tempPack(featurePackFiles());
    const link = path.join(emptyTempDir(), 'pack-link');
    if (!tryCreateSymlink(real, link)) return;
    expect(() => readTemplatePackDirectory(link)).toThrowError(/SBT009/);
  });

  it('rejects binary (null-byte) content', () => {
    const dir = tempPack(featurePackFiles());
    writeFileSync(path.join(dir, 'files', 'requirements.md.template'), Buffer.from([0x23, 0x00, 0x01, 0xff]));
    expect(() => readTemplatePackDirectory(dir)).toThrowError(/SBT025|SBT009/);
  });

  it('rejects invalid UTF-8 content', () => {
    const dir = tempPack(featurePackFiles());
    writeFileSync(path.join(dir, 'files', 'design.md.template'), Buffer.from([0xc3, 0x28, 0x41]));
    expect(() => readTemplatePackDirectory(dir)).toThrowError(/UTF-8/);
  });

  it('rejects packs with too many files with SBT019', () => {
    const dir = tempPack(featurePackFiles());
    for (let index = 0; index <= TEMPLATE_PACK_LIMITS.maxPackFiles; index += 1) {
      writeFileSync(path.join(dir, `extra-${index}.md`), 'x', 'utf8');
    }
    expect(() => readTemplatePackDirectory(dir)).toThrowError(/SBT019/);
  });

  it('rejects an oversized template file with SBT019', () => {
    const dir = tempPack(featurePackFiles());
    writeFileSync(
      path.join(dir, 'files', 'design.md.template'),
      `# Design\n${'x'.repeat(TEMPLATE_PACK_LIMITS.maxTemplateFileBytes + 1)}`,
      'utf8',
    );
    expect(() => readTemplatePackDirectory(dir)).toThrowError(/SBT019/);
  });

  it('rejects an oversized manifest with SBT019', () => {
    const manifest = featureManifest({ description: 'd' });
    const dir = tempPack({
      ...featurePackFiles(),
      'specbridge-template.json': JSON.stringify({
        ...manifest,
        description: 'x'.repeat(TEMPLATE_PACK_LIMITS.maxManifestBytes),
      }),
    });
    // Per-file read limit tolerates it; the manifest-specific limit rejects it.
    const pack = loadDir(dir);
    expect(pack.valid).toBe(false);
    expect(pack.issues.some((issue) => issue.code === 'SBT019')).toBe(true);
  });

  it('rejects deeply nested packs', () => {
    const dir = tempPack(featurePackFiles());
    const deep = path.join(dir, 'a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, 'x.md'), 'x', 'utf8');
    expect(() => readTemplatePackDirectory(dir)).toThrowError(/SBT019/);
  });

  it('rejects undeclared files with SBT010', () => {
    const dir = tempPack({ ...featurePackFiles(), 'files/sneaky.md.template': '# Sneaky\n' });
    const pack = loadDir(dir);
    expect(pack.valid).toBe(false);
    expect(pack.issues.some((issue) => issue.code === 'SBT010')).toBe(true);
  });

  it('allows LICENSE alongside declared files', () => {
    const dir = tempPack({ ...featurePackFiles(), LICENSE: 'MIT License\n' });
    expect(loadDir(dir).valid).toBe(true);
  });

  it('reports a declared source that is missing from the pack with SBT007', () => {
    const files = featurePackFiles();
    delete (files as Record<string, string>)['files/tasks.md.template'];
    const pack = loadDir(tempPack(files));
    expect(pack.valid).toBe(false);
    expect(pack.issues.some((issue) => issue.code === 'SBT007')).toBe(true);
  });

  it('flags undeclared placeholders during static validation with SBT016', () => {
    const files = featurePackFiles();
    files['files/design.md.template'] = '# Design Document\n\n{{surprise}}\n';
    const pack = loadDir(tempPack(files));
    expect(pack.valid).toBe(false);
    expect(pack.issues.some((issue) => issue.code === 'SBT016')).toBe(true);
  });

  it('flags generatedDate use without the manifest opt-in', () => {
    const files = featurePackFiles();
    files['files/design.md.template'] = '# Design Document\n\nGenerated: {{generatedDate}}\n';
    const pack = loadDir(tempPack(files));
    expect(pack.valid).toBe(false);
    expect(pack.issues.some((issue) => issue.message.includes('generatedDate'))).toBe(true);
  });

  it('rejects an incompatible SpecBridge range with SBT006', () => {
    const dir = tempPack(
      featurePackFiles(featureManifest({ compatibility: { specbridge: '>=9.0.0 <10.0.0', kiroLayout: '1' } })),
    );
    const pack = loadDir(dir);
    expect(pack.valid).toBe(false);
    expect(pack.issues.some((issue) => issue.code === 'SBT006')).toBe(true);
  });

  it('render-checks a pack deterministically with the injected clock', () => {
    const dir = tempPack(featurePackFiles());
    const pack = loadDir(dir);
    const first = checkPackRendering(pack, fixedClock);
    const second = checkPackRendering(pack, fixedClock);
    expect(first).toEqual(second);
    expect(first.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('render-check reports an empty rendered document with SBT017', () => {
    const files = featurePackFiles();
    files['files/tasks.md.template'] = '{{actor}}';
    const dir = tempPack(files);
    const pack = loadDir(dir);
    // 'actor' defaults to 'user' -> renders to a non-empty doc without heading.
    const issues = checkPackRendering(pack, fixedClock);
    expect(issues.some((issue) => issue.code === 'SBT017')).toBe(true);
  });
});
