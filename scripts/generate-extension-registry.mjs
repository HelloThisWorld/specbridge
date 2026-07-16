// Regenerate the repository extension registry (registry/index.json and
// registry/entries/*.json) from the reference extensions under
// examples/extensions/. Requires a prior `pnpm build` because it packages
// each reference extension deterministically to compute its archive SHA-256.
//
// Archive URLs use the documented placeholder host (example.invalid) until a
// real hosted registry exists; the hashes are real and reproducible because
// extension packaging is deterministic.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examplesDir = path.join(rootDir, 'examples', 'extensions');
const registryDir = path.join(rootDir, 'registry');
const entriesDir = path.join(registryDir, 'entries');

const extensionsDist = path.join(rootDir, 'packages', 'extensions', 'dist', 'index.js');
if (!existsSync(extensionsDist)) {
  console.error('generate-extension-registry: run `pnpm build` first (needs packages/extensions/dist).');
  process.exit(1);
}
const { buildExtensionArchive } = await import(new URL(`file://${extensionsDist.replace(/\\/g, '/')}`).href);

const check = process.argv.includes('--check');

const entries = [];
for (const name of readdirSync(examplesDir).sort()) {
  const dir = path.join(examplesDir, name);
  const manifestPath = path.join(dir, 'specbridge-extension.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const result = buildExtensionArchive(dir, { dryRun: true });
  entries.push({
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    kind: manifest.kind,
    latestVersion: manifest.version,
    versions: [
      {
        version: manifest.version,
        archiveUrl: `https://example.invalid/specbridge-extensions/${manifest.id}-${manifest.version}.specbridge-extension.zip`,
        sha256: result.archiveSha256,
        manifest: {
          protocolVersion: manifest.protocolVersion,
          compatibility: { specbridge: manifest.compatibility.specbridge },
          permissions: manifest.permissions,
        },
      },
    ],
    repository: 'https://github.com/HelloThisWorld/specbridge',
    license: manifest.license,
    keywords: manifest.keywords ?? [],
  });
}

const index = {
  schemaVersion: '1.0.0',
  name: 'specbridge-examples',
  updatedAt: '2026-01-01T00:00:00.000Z',
  extensions: entries,
};
const indexText = `${JSON.stringify(index, null, 2)}\n`;

if (check) {
  const current = existsSync(path.join(registryDir, 'index.json'))
    ? readFileSync(path.join(registryDir, 'index.json'), 'utf8')
    : '';
  if (current !== indexText) {
    console.error('check:extension-registry: registry/index.json is out of date. Run `pnpm generate:extension-registry`.');
    process.exit(1);
  }
  console.log(`check:extension-registry: OK (${entries.length} extensions)`);
  process.exit(0);
}

mkdirSync(entriesDir, { recursive: true });
writeFileSync(path.join(registryDir, 'index.json'), indexText);
for (const entry of entries) {
  writeFileSync(path.join(entriesDir, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}
console.log(`generate-extension-registry: wrote index.json and ${entries.length} entries.`);
