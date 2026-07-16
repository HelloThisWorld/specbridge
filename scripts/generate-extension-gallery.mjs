// Generate the extension gallery table in docs/extensions.md from
// registry/index.json. Only the region between the marker comments is
// touched; the rest of the document is hand-written. --check detects drift.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const galleryPath = path.join(rootDir, 'docs', 'extensions.md');
const indexPath = path.join(rootDir, 'registry', 'index.json');

const BEGIN = '<!-- BEGIN GENERATED EXTENSION GALLERY (pnpm generate:extension-gallery) -->';
const END = '<!-- END GENERATED EXTENSION GALLERY -->';

if (!existsSync(indexPath) || !existsSync(galleryPath)) {
  console.error('generate-extension-gallery: registry/index.json and docs/extensions.md must exist.');
  process.exit(1);
}
const index = JSON.parse(readFileSync(indexPath, 'utf8'));

function permissionSummary(permissions) {
  const flags = ['specRead', 'repositoryRead', 'repositoryWrite', 'network', 'childProcess']
    .filter((flag) => permissions[flag] === true)
    .map((flag) => flag);
  if (permissions.environmentVariables?.length > 0) {
    flags.push(`env: ${permissions.environmentVariables.join(', ')}`);
  }
  return flags.length > 0 ? flags.join(', ') : 'none';
}

const rows = [...index.extensions]
  .sort((a, b) => a.id.localeCompare(b.id, 'en'))
  .map((entry) => {
    const latest = entry.versions.find((version) => version.version === entry.latestVersion);
    return (
      `| \`${entry.id}\` | ${entry.kind} | ${entry.latestVersion} | ${entry.description} | ` +
      `${permissionSummary(latest?.manifest.permissions ?? {})} | ` +
      `\`${latest?.manifest.compatibility.specbridge ?? ''}\` | [source](${entry.repository ?? ''}) |`
    );
  });

const table = [
  `Registry: **${index.name}** (${index.extensions.length} extensions). Listing is not endorsement; review permissions before enabling.`,
  '',
  '| Extension | Kind | Version | Description | Permissions | SpecBridge | Source |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
].join('\n');

const document = readFileSync(galleryPath, 'utf8');
const beginIndex = document.indexOf(BEGIN);
const endIndex = document.indexOf(END);
if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
  console.error('generate-extension-gallery: marker comments are missing from docs/extensions.md.');
  process.exit(1);
}
const next =
  document.slice(0, beginIndex + BEGIN.length) + '\n\n' + table + '\n\n' + document.slice(endIndex);

if (process.argv.includes('--check')) {
  if (next !== document) {
    console.error('check:extension-gallery: docs/extensions.md is out of date. Run `pnpm generate:extension-gallery`.');
    process.exit(1);
  }
  console.log(`check:extension-gallery: OK (${index.extensions.length} extensions)`);
  process.exit(0);
}
writeFileSync(galleryPath, next);
console.log(`generate-extension-gallery: updated gallery (${index.extensions.length} extensions).`);
