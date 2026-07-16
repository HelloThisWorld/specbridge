import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { FIXED_NOW } from '../helpers';
import { freshKiroWorkspace } from '../helpers-templates';
import {
  exporterManifest,
  installAndEnableTestExtension,
  templateProviderManifest,
} from '../helpers-extensions';

async function cli(cwd: string, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line = '') => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line = '') => stderr.push(`${line}\n`),
    now: () => FIXED_NOW,
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

const EXPORTER_ENTRYPOINT = (files: string) => `'use strict';
const readline = require('node:readline');
const path = require('node:path');
const manifest = require(path.join(process.cwd(), 'specbridge-extension.json'));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(m) { process.stdout.write(JSON.stringify(m) + '\\n'); }
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '1.0.0', extensionId: manifest.id, extensionVersion: manifest.version,
      capabilities: manifest.capabilities,
    } });
  } else if (request.method === 'extension.invoke') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      operation: 'exporter.export',
      output: { files: ${files}, diagnostics: [] },
    } });
  } else if (request.method === 'extension.shutdown') {
    send({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
    process.exit(0);
  }
});
`;

function writeSpec(root: string): void {
  const dir = path.join(root, '.kiro', 'specs', 'demo-spec');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'requirements.md'), '# Requirements\n\n## 1. R\n\nThe system SHALL work.\n', 'utf8');
}

const MINI_PACK = {
  'templates/mini-pack/specbridge-template.json': JSON.stringify({
    schemaVersion: '1.0.0',
    id: 'mini-pack',
    version: '1.0.0',
    displayName: 'Mini Pack',
    description: 'A tiny valid template pack contributed by a template-provider extension.',
    kind: 'feature',
    supportedModes: ['quick'],
    defaultMode: 'quick',
    tags: ['test'],
    files: [
      { source: 'files/requirements.md.template', target: 'requirements.md', stage: 'requirements', required: true },
      { source: 'files/design.md.template', target: 'design.md', stage: 'design', required: true },
      { source: 'files/tasks.md.template', target: 'tasks.md', stage: 'tasks', required: true },
    ],
    variables: [],
    compatibility: { specbridge: '>=0.7.0 <1.0.0', kiroLayout: '1' },
    license: 'MIT',
  }),
  'templates/mini-pack/README.md': '# Mini Pack\n',
  'templates/mini-pack/files/requirements.md.template': '# Requirements for {{specName}}\n',
  'templates/mini-pack/files/design.md.template': '# Design for {{specName}}\n',
  'templates/mini-pack/files/tasks.md.template': '# Tasks\n\n- [ ] 1. Implement {{specName}}\n',
};

describe('spec export via exporter extensions', () => {
  it('previews without writing, writes only with --yes, and never overwrites', async () => {
    const root = freshKiroWorkspace();
    writeSpec(root);
    await installAndEnableTestExtension(root, exporterManifest(), {
      'dist/extension.cjs': EXPORTER_ENTRYPOINT(
        `[{ path: 'summary.md', mediaType: 'text/markdown', content: '# Summary of ' + (request.params.payload.specName) + '\\n' }]`,
      ),
    });
    const outputDir = mkdtempSync(path.join(tmpdir(), 'sb-export-'));

    const dryRun = await cli(root, 'spec', 'export', 'demo-spec', '--extension', 'demo-exporter', '--output', outputDir, '--dry-run', '--json');
    expect(dryRun.code, dryRun.stderr).toBe(0);
    const dryReport = JSON.parse(dryRun.stdout) as { data: { files: Array<{ path: string }>; written: string[]; dryRun: boolean } };
    expect(dryReport.data.dryRun).toBe(true);
    expect(dryReport.data.files[0]?.path).toBe('summary.md');
    expect(dryReport.data.written).toEqual([]);
    expect(existsSync(path.join(outputDir, 'summary.md'))).toBe(false);

    const confirmed = await cli(root, 'spec', 'export', 'demo-spec', '--extension', 'demo-exporter', '--output', outputDir, '--yes', '--json');
    expect(confirmed.code, confirmed.stderr).toBe(0);
    expect(readFileSync(path.join(outputDir, 'summary.md'), 'utf8')).toContain('# Summary of demo-spec');

    // Existing files are protected: the same export cannot overwrite.
    const again = await cli(root, 'spec', 'export', 'demo-spec', '--extension', 'demo-exporter', '--output', outputDir, '--yes');
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('never overwrites');
  });

  it('rejects traversal and absolute candidate paths before any preview', async () => {
    const root = freshKiroWorkspace();
    writeSpec(root);
    await installAndEnableTestExtension(root, exporterManifest({ id: 'evil-exporter' }), {
      'dist/extension.cjs': EXPORTER_ENTRYPOINT(
        `[{ path: '../evil.md', mediaType: 'text/markdown', content: 'x' }]`,
      ),
    });
    const outputDir = mkdtempSync(path.join(tmpdir(), 'sb-export-'));
    const result = await cli(root, 'spec', 'export', 'demo-spec', '--extension', 'evil-exporter', '--output', outputDir, '--dry-run');
    expect(result.code).not.toBe(0);
    expect(existsSync(path.join(path.dirname(outputDir), 'evil.md'))).toBe(false);
  });
});

describe('template-provider extensions in the template catalog', () => {
  it('lists qualified extension templates without starting any process', async () => {
    const root = freshKiroWorkspace();
    await installAndEnableTestExtension(root, templateProviderManifest(), MINI_PACK);

    const list = await cli(root, 'template', 'list', '--json');
    expect(list.code, list.stderr).toBe(0);
    const report = JSON.parse(list.stdout) as { data: { templates: Array<{ ref: string; source: string }> } };
    const entry = report.data.templates.find((template) => template.ref === 'extension:demo-template-provider/mini-pack');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('extension:demo-template-provider');

    const show = await cli(root, 'template', 'show', 'extension:demo-template-provider/mini-pack');
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toContain('Mini Pack');
  });

  it('reports ambiguity instead of shadowing when IDs collide across sources', async () => {
    const root = freshKiroWorkspace();
    const collidingPack = Object.fromEntries(
      Object.entries(MINI_PACK).map(([key, value]) => [
        key.replace('mini-pack', 'rest-api'),
        value.replace('"id":"mini-pack"', '"id":"rest-api"'),
      ]),
    );
    await installAndEnableTestExtension(
      root,
      templateProviderManifest({ id: 'colliding-provider' }),
      collidingPack,
    );
    const result = await cli(root, 'template', 'show', 'rest-api');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('SBT002');
  });
});
