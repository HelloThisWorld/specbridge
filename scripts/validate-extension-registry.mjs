// Deterministic, dependency-free validation of the repository extension
// registry (registry/index.json + registry/entries/*.json). Structural rules
// mirror @specbridge/registry's schema; the full zod validation additionally
// runs in the vitest suite against the same files. This script never touches
// the network and never executes extension code.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const registryDir = path.join(rootDir, 'registry');
const failures = [];

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS = new Set(['template-provider', 'analyzer', 'verifier', 'exporter', 'runner']);

function fail(message) {
  failures.push(message);
}

function checkEntry(entry, label) {
  if (!ID_PATTERN.test(entry.id ?? '')) fail(`${label}: invalid id "${entry.id}"`);
  if (!KINDS.has(entry.kind)) fail(`${label}: invalid kind "${entry.kind}"`);
  if (!SEMVER.test(entry.latestVersion ?? '')) fail(`${label}: invalid latestVersion`);
  if (typeof entry.license !== 'string' || entry.license.length === 0) fail(`${label}: missing license`);
  if (typeof entry.displayName !== 'string' || typeof entry.description !== 'string') {
    fail(`${label}: missing displayName/description`);
  }
  const versions = Array.isArray(entry.versions) ? entry.versions : [];
  if (versions.length === 0) fail(`${label}: no versions`);
  if (!versions.some((v) => v.version === entry.latestVersion)) {
    fail(`${label}: latestVersion is not in versions`);
  }
  for (const version of versions) {
    const vLabel = `${label}@${version.version}`;
    if (!SEMVER.test(version.version ?? '')) fail(`${vLabel}: invalid version`);
    if (!SHA256.test(version.sha256 ?? '')) fail(`${vLabel}: archive sha256 is required and must be 64 hex chars`);
    let url;
    try {
      url = new URL(version.archiveUrl);
    } catch {
      fail(`${vLabel}: invalid archiveUrl`);
      continue;
    }
    if (url.protocol !== 'https:') fail(`${vLabel}: archiveUrl must be https`);
    if (url.username !== '' || url.password !== '') fail(`${vLabel}: archiveUrl must not embed credentials`);
    const manifest = version.manifest ?? {};
    if (!SEMVER.test(manifest.protocolVersion ?? '')) fail(`${vLabel}: manifest.protocolVersion missing`);
    if (typeof manifest.compatibility?.specbridge !== 'string') {
      fail(`${vLabel}: manifest.compatibility.specbridge missing`);
    }
    const permissions = manifest.permissions ?? {};
    for (const key of ['specRead', 'repositoryRead', 'repositoryWrite', 'network', 'childProcess']) {
      if (typeof permissions[key] !== 'boolean') fail(`${vLabel}: permissions.${key} must be boolean`);
    }
    if (!Array.isArray(permissions.environmentVariables)) {
      fail(`${vLabel}: permissions.environmentVariables must be an array of names`);
    }
  }
}

const indexPath = path.join(registryDir, 'index.json');
if (!existsSync(indexPath)) {
  console.error('validate-extension-registry: registry/index.json is missing.');
  process.exit(1);
}
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
if (index.schemaVersion !== '1.0.0') fail('index: unsupported schemaVersion');
if (typeof index.name !== 'string' || index.name.length === 0) fail('index: missing name');
const seen = new Set();
for (const entry of index.extensions ?? []) {
  if (seen.has(entry.id)) fail(`index: duplicate extension "${entry.id}"`);
  seen.add(entry.id);
  checkEntry(entry, `index:${entry.id}`);
}

const entriesDir = path.join(registryDir, 'entries');
if (existsSync(entriesDir)) {
  for (const file of readdirSync(entriesDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const entry = JSON.parse(readFileSync(path.join(entriesDir, file), 'utf8'));
    checkEntry(entry, `entries/${file}`);
    if (`${entry.id}.json` !== file) fail(`entries/${file}: file name does not match id "${entry.id}"`);
    if (!seen.has(entry.id)) fail(`entries/${file}: not present in index.json`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(`validate-extension-registry: ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`validate-extension-registry: OK (${(index.extensions ?? []).length} extensions).`);
