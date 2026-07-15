#!/usr/bin/env node
/**
 * Generate the built-in template gallery in docs/templates.md from the
 * template manifests under packages/templates/builtins/.
 *
 * The gallery table between the BEGIN/END markers is machine-maintained;
 * everything else in docs/templates.md is hand-written documentation.
 *
 * Usage:
 *   node scripts/generate-template-gallery.mjs          # rewrite the gallery
 *   node scripts/generate-template-gallery.mjs --check  # fail on drift (CI)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtinsDir = path.join(rootDir, 'packages', 'templates', 'builtins');
const galleryPath = path.join(rootDir, 'docs', 'templates.md');

const BEGIN_MARKER = '<!-- BEGIN GENERATED TEMPLATE GALLERY (pnpm generate:template-gallery) -->';
const END_MARKER = '<!-- END GENERATED TEMPLATE GALLERY -->';

function fail(message) {
  console.error(`template-gallery: ${message}`);
  process.exit(1);
}

const manifests = readdirSync(builtinsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, 'en'))
  .map((id) => {
    const manifestPath = path.join(builtinsDir, id, 'specbridge-template.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (cause) {
      fail(`cannot parse ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (manifest.id !== id) fail(`manifest id "${manifest.id}" does not match directory "${id}"`);
    return manifest;
  });

if (manifests.length === 0) fail(`no built-in template manifests found under ${builtinsDir}`);

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const rows = manifests.map((manifest) => {
  const example = manifest.examples?.[0] ?? `specbridge template apply ${manifest.id} --name <spec-name>`;
  return (
    `| \`${manifest.id}\` — ${escapeCell(manifest.displayName)} ` +
    `| ${escapeCell(manifest.description)} ` +
    `| ${manifest.kind} ` +
    `| ${manifest.supportedModes.join(', ')} ` +
    `| ${manifest.tags.join(', ')} ` +
    `| \`${escapeCell(example)}\` |`
  );
});

const generated = [
  BEGIN_MARKER,
  '',
  `${manifests.length} built-in templates ship with SpecBridge. This table is generated from the`,
  'template manifests — do not edit it by hand.',
  '',
  '| Template | Description | Kind | Modes | Tags | Example |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
  END_MARKER,
].join('\n');

let document;
try {
  document = readFileSync(galleryPath, 'utf8');
} catch {
  fail(`missing ${galleryPath}; create it with the gallery markers first`);
}

const beginIndex = document.indexOf(BEGIN_MARKER);
const endIndex = document.indexOf(END_MARKER);
if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
  fail(`gallery markers not found in ${galleryPath}`);
}

const updated =
  document.slice(0, beginIndex) + generated + document.slice(endIndex + END_MARKER.length);

if (process.argv.includes('--check')) {
  if (document !== updated) {
    fail('docs/templates.md gallery is out of date with built-in manifests; run pnpm generate:template-gallery and commit the result');
  }
  console.log(`check:template-gallery: OK (${manifests.length} templates)`);
} else {
  writeFileSync(galleryPath, updated);
  console.log(`generated gallery in docs/templates.md (${manifests.length} templates)`);
}
