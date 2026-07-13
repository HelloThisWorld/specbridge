/**
 * Post-bundle plugin artifacts: third-party license report, deterministic
 * checksum manifest, and the release ZIP.
 *
 * Runs after tsup has written specbridge/dist/cli.cjs and mcp-server.cjs.
 * Everything here is deterministic for identical inputs: the license report
 * is sorted, the checksum manifest is sorted, and the ZIP uses fixed
 * timestamps with sorted entries (store method, no compression) so the same
 * bundle always produces the same archive bytes.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge');
const distDir = path.join(pluginRoot, 'dist');

const PLUGIN_VERSION = JSON.parse(
  readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
).version;

// ---------------------------------------------------------------------------
// 1. Third-party license report
// ---------------------------------------------------------------------------

/**
 * Runtime dependencies that end up inside the bundles. Workspace packages
 * are all MIT (this repository); external packages are read from the
 * installed node_modules so versions and license texts are authoritative.
 */
function collectExternalRuntimeDeps() {
  const seen = new Map();
  const queue = [];
  const packageDirs = readdirSync(path.join(repoRoot, 'packages'));
  for (const dir of packageDirs) {
    const manifestPath = path.join(repoRoot, 'packages', dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (String(range).startsWith('workspace:')) continue;
      queue.push({ name, from: path.join(repoRoot, 'packages', dir) });
    }
  }
  while (queue.length > 0) {
    const { name, from } = queue.pop();
    let manifestPath;
    try {
      manifestPath = require.resolve(`${name}/package.json`, { paths: [from] });
    } catch {
      // Packages without an exported package.json: resolve the entry and walk up.
      try {
        let dir = path.dirname(require.resolve(name, { paths: [from] }));
        while (!existsSync(path.join(dir, 'package.json'))) {
          const parent = path.dirname(dir);
          if (parent === dir) throw new Error('no package.json');
          dir = parent;
        }
        manifestPath = path.join(dir, 'package.json');
      } catch {
        continue;
      }
    }
    let packageDir = path.dirname(manifestPath);
    let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Dual-package stubs (dist/esm/package.json with only {"type": ...})
    // are not the real manifest; walk up to the named one.
    while (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      const parent = path.dirname(packageDir);
      if (parent === packageDir) break;
      packageDir = parent;
      const candidate = path.join(packageDir, 'package.json');
      if (existsSync(candidate)) manifest = JSON.parse(readFileSync(candidate, 'utf8'));
    }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) continue;
    // License-file discovery must behave identically on case-sensitive and
    // case-insensitive filesystems: list the directory, match names
    // case-insensitively, and pick deterministically (sorted, first match).
    let licenseText = '';
    let entries = [];
    try {
      entries = readdirSync(packageDir);
    } catch {
      entries = [];
    }
    const licenseFile = entries
      .filter((name) => /^licen[cs]e(\.(md|txt|markdown))?$/i.test(name))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en') || a.localeCompare(b, 'en'))[0];
    if (licenseFile !== undefined) {
      licenseText = readFileSync(path.join(packageDir, licenseFile), 'utf8');
    }
    seen.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? '(see repository)',
      licenseText,
    });
    for (const [depName, range] of Object.entries(manifest.dependencies ?? {})) {
      if (String(range).startsWith('workspace:')) continue;
      queue.push({ name: depName, from: packageDir });
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
  );
}

function writeLicenseReport() {
  const deps = collectExternalRuntimeDeps();
  const lines = [
    'Third-party licenses for the SpecBridge Claude Code plugin bundles',
    '(dist/cli.cjs and dist/mcp-server.cjs).',
    '',
    'SpecBridge itself is MIT-licensed (see LICENSE at the plugin root).',
    `This report covers ${deps.length} bundled external package(s).`,
    '',
  ];
  for (const dep of deps) {
    lines.push('='.repeat(72));
    lines.push(`${dep.name} ${dep.version} — ${dep.license}`);
    lines.push('='.repeat(72));
    lines.push(dep.licenseText.trim().length > 0 ? dep.licenseText.trim() : '(license text not shipped in the package; see its repository)');
    lines.push('');
  }
  // Upstream license files mix CRLF and LF; normalize to LF so the committed
  // artifact, its checksum, and git's eol normalization always agree.
  const report = `${lines.join('\n')}\n`.replace(/\r\n?/g, '\n');
  writeFileSync(path.join(distDir, 'THIRD_PARTY_LICENSES.txt'), report);
  return deps.length;
}

// ---------------------------------------------------------------------------
// 2. Checksum manifest
// ---------------------------------------------------------------------------

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function writeChecksums() {
  const files = ['cli.cjs', 'mcp-server.cjs', 'THIRD_PARTY_LICENSES.txt']
    .filter((name) => existsSync(path.join(distDir, name)))
    .sort();
  const manifest = {
    schema: 'specbridge.plugin-checksums/1',
    version: PLUGIN_VERSION,
    files: Object.fromEntries(
      files.map((name) => [
        name,
        { sha256: sha256(path.join(distDir, name)), bytes: statSync(path.join(distDir, name)).size },
      ]),
    ),
  };
  writeFileSync(path.join(distDir, 'checksums.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

// ---------------------------------------------------------------------------
// 3. Deterministic ZIP (store method) — release artifact
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fixed DOS timestamp (2026-01-01 00:00:00) for reproducible archives. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 36); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

/** Paths (relative to the plugin root) allowed into the release ZIP. */
const ZIP_FORBIDDEN = [
  /^node_modules(\/|$)/,
  /^\.git(\/|$)/,
  /^\.kiro(\/|$)/,
  /^\.specbridge(\/|$)/,
  /\.map$/,
  /\.log$/,
  /^tests?(\/|$)/,
];

function collectZipFiles(dir, base = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const relative = base.length > 0 ? `${base}/${entry.name}` : entry.name;
    if (ZIP_FORBIDDEN.some((pattern) => pattern.test(relative))) continue;
    if (entry.isDirectory()) files.push(...collectZipFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function writeZip() {
  const files = collectZipFiles(pluginRoot);
  const required = ['.claude-plugin/plugin.json', '.mcp.json', 'README.md', 'LICENSE', 'NOTICE.md', 'dist/cli.cjs', 'dist/mcp-server.cjs'];
  for (const name of required) {
    if (!files.includes(name)) throw new Error(`ZIP is missing required file: ${name}`);
  }
  const zip = zipEntries(
    files.map((name) => ({ name, data: readFileSync(path.join(pluginRoot, name)) })),
  );
  const outDir = path.join(repoRoot, 'dist');
  mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `specbridge-claude-plugin-${PLUGIN_VERSION}.zip`);
  writeFileSync(zipPath, zip);
  return { zipPath, fileCount: files.length, bytes: zip.length };
}

// ---------------------------------------------------------------------------

for (const bundle of ['cli.cjs', 'mcp-server.cjs']) {
  if (!existsSync(path.join(distDir, bundle))) {
    console.error(`plugin-artifacts: ${bundle} is missing — run the tsup bundle step first.`);
    process.exit(2);
  }
}
const licenseCount = writeLicenseReport();
const checksummed = writeChecksums();
const zip = writeZip();
console.log(
  `plugin-artifacts: licenses for ${licenseCount} package(s); checksums for ${checksummed.join(', ')}; ` +
    `${path.relative(repoRoot, zip.zipPath)} (${zip.fileCount} files, ${zip.bytes} bytes).`,
);
