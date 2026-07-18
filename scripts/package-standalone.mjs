#!/usr/bin/env node
/**
 * Package SpecBridge as a standalone, offline-installable archive.
 *
 * Reuses the self-contained CommonJS bundles already produced by the Claude
 * Code plugin build (`pnpm build:plugin` → scripts/plugin-artifacts.mjs):
 * integrations/claude-code-plugin/specbridge/dist/{cli.cjs,mcp-server.cjs}
 * and THIRD_PARTY_LICENSES.txt. This script does not rebuild them; it stages
 * them alongside thin launcher scripts, and — for platform targets — a
 * pinned Node.js runtime, into one archive per target.
 *
 * Usage:
 *   node scripts/package-standalone.mjs \
 *     --target <windows-x64|linux-x64|macos-x64|macos-arm64|node> \
 *     --out <dir> [--smoke]
 *
 * ZIP archives (windows-x64, node) are built and read with a small
 * dependency-free STORE/DEFLATE implementation (node:zlib only), so archive
 * creation and extraction behave identically on every OS regardless of
 * which system zip tool (if any) happens to be on PATH. .tar.gz archives
 * (linux-x64, macos-x64, macos-arm64) are built and read with the system
 * `tar`, per the release workflow's own convention.
 *
 * Network access is limited to downloading the pinned Node.js runtime for
 * platform targets (skipped entirely for the "node" target). Downloads are
 * cached under os.tmpdir()/specbridge-standalone-cache and verified against
 * an embedded SHA-256 before use; a mismatch fails closed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

// Referenced via a local binding (not the bare global) so this file lints
// cleanly under this repo's flat ESLint config, which does not list `fetch`
// among the recognized globals for scripts/**/*.mjs.
const { fetch } = globalThis;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const VERSION = rootPackage.version;
const PNPM_VERSION = String(rootPackage.packageManager ?? '').split('@')[1] ?? null;

const pluginDistDir = path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge', 'dist');
const releaseAssetsDir = path.join(repoRoot, 'scripts', 'release-assets');
const schemaVersions = JSON.parse(
  readFileSync(path.join(repoRoot, 'contracts', 'schema-versions.json'), 'utf8'),
);

function fail(message, exitCode = 1) {
  console.error(`package-standalone: ${message}`);
  process.exit(exitCode);
}

/**
 * Recursively remove a directory, retrying on EBUSY/ENOTEMPTY/EPERM. A
 * directory that just held an executed binary (e.g. runtime/node.exe run
 * from a smoke test) can stay locked for a moment after the process exits
 * on Windows; a plain rmSync can lose that race.
 */
function rmRecursive(targetPath) {
  rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---------------------------------------------------------------------------
// Pinned Node.js runtime (Node 20 LTS). This machine's own `node --version`
// is not on the 20.x line, so the latest available 20.x release is pinned
// instead. SHA-256 values below were read from the official, HTTPS-served
// https://nodejs.org/dist/v20.20.2/SHASUMS256.txt and cross-checked with a
// second independent fetch before being embedded here. Every download is
// re-verified against these constants; a mismatch fails closed and nothing
// unverified is ever staged into an archive.
// ---------------------------------------------------------------------------
const NODE_RUNTIME_VERSION = '20.20.2';
const NODE_RUNTIME_SHA256 = {
  'node-v20.20.2-win-x64.zip': 'dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77',
  'node-v20.20.2-linux-x64.tar.gz': '19e56f0825510207dd904f087fe52faa0a4eb6b2aab5f0ea7a33830d04888b8b',
  'node-v20.20.2-darwin-x64.tar.gz': '8be6f5e4bb128c82774f8a0b8d7a1cc1365a7977d9657cece0ca647b3fe04e61',
  'node-v20.20.2-darwin-arm64.tar.gz': '466e05f3477c20dfb723054dfebffe55bc74660ee77f612166fca121dacb65b6',
};
const NODE_CACHE_DIR = path.join(os.tmpdir(), 'specbridge-standalone-cache');

const TARGETS = {
  'windows-x64': {
    platform: 'win32',
    arch: 'x64',
    archiveFormat: 'zip',
    wrappers: 'windows',
    bundlesRuntime: true,
    nodeDistName: 'win-x64',
    nodeArtifactFormat: 'zip',
    nodeBinaryRelPath: 'node.exe',
    runtimeBinaryName: 'node.exe',
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    archiveFormat: 'tar.gz',
    wrappers: 'unix',
    bundlesRuntime: true,
    nodeDistName: 'linux-x64',
    nodeArtifactFormat: 'tar.gz',
    nodeBinaryRelPath: 'bin/node',
    runtimeBinaryName: 'node',
  },
  'macos-x64': {
    platform: 'darwin',
    arch: 'x64',
    archiveFormat: 'tar.gz',
    wrappers: 'unix',
    bundlesRuntime: true,
    nodeDistName: 'darwin-x64',
    nodeArtifactFormat: 'tar.gz',
    nodeBinaryRelPath: 'bin/node',
    runtimeBinaryName: 'node',
  },
  'macos-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    archiveFormat: 'tar.gz',
    wrappers: 'unix',
    bundlesRuntime: true,
    nodeDistName: 'darwin-arm64',
    nodeArtifactFormat: 'tar.gz',
    nodeBinaryRelPath: 'bin/node',
    runtimeBinaryName: 'node',
  },
  node: {
    platform: null,
    arch: null,
    archiveFormat: 'zip',
    wrappers: 'both',
    bundlesRuntime: false,
  },
};

// ---------------------------------------------------------------------------
// Launcher script templates. Built as arrays joined with an explicit line
// separator (never template-literal interpolation) so POSIX `$(...)`/`$@`
// and batch `%...%` syntax never risk being read as JavaScript.
// ---------------------------------------------------------------------------

const UNIX_CLI_WRAPPER = [
  '#!/bin/sh',
  'exec "$(dirname "$0")/../runtime/node" "$(dirname "$0")/../lib/cli.cjs" "$@"',
  '',
].join('\n');

const UNIX_MCP_WRAPPER = [
  '#!/bin/sh',
  'exec "$(dirname "$0")/../runtime/node" "$(dirname "$0")/../lib/mcp-server.cjs" "$@"',
  '',
].join('\n');

function nodeTargetUnixWrapper(libFile) {
  return [
    '#!/bin/sh',
    '# This "node" archive bundles no Node.js runtime; it requires Node.js >= 20',
    '# already on PATH.',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "specbridge: Node.js >= 20 was not found on PATH. Install it from https://nodejs.org/ and try again." >&2',
    '  exit 1',
    'fi',
    'NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split(\'.\')[0]))" 2>/dev/null)',
    'if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then',
    '  echo "specbridge: Node.js >= 20 is required (found $(node --version 2>/dev/null || echo an unreadable version))." >&2',
    '  exit 1',
    'fi',
    `exec node "$(dirname "$0")/../lib/${libFile}" "$@"`,
    '',
  ].join('\n');
}

const WINDOWS_CLI_WRAPPER = [
  '@echo off',
  '"%~dp0..\\runtime\\node.exe" "%~dp0..\\lib\\cli.cjs" %*',
  '',
].join('\r\n');

const WINDOWS_MCP_WRAPPER = [
  '@echo off',
  '"%~dp0..\\runtime\\node.exe" "%~dp0..\\lib\\mcp-server.cjs" %*',
  '',
].join('\r\n');

function nodeTargetWindowsWrapper(libFile) {
  return [
    '@echo off',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo specbridge: Node.js 20 or newer was not found on PATH. Install it from https://nodejs.org/ and try again. 1>&2',
    '  exit /b 1',
    ')',
    'set NODE_MAJOR=',
    "for /f \"delims=\" %%v in ('node -e \"process.stdout.write(String(process.versions.node.split('.')[0]))\"') do set NODE_MAJOR=%%v",
    'if not defined NODE_MAJOR (',
    '  echo specbridge: could not determine the installed Node.js version. 1>&2',
    '  exit /b 1',
    ')',
    'if %NODE_MAJOR% LSS 20 (',
    '  echo specbridge: Node.js 20 or newer is required. 1>&2',
    '  exit /b 1',
    ')',
    `node "%~dp0..\\lib\\${libFile}" %*`,
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// Minimal self-contained ZIP reader/writer (STORE + DEFLATE via node:zlib).
// Adapted from scripts/plugin-artifacts.mjs's deterministic ZIP writer, and
// extended with DEFLATE (these archives bundle a full Node.js runtime; STORE
// would roughly double the download size) and real unix permission bits in
// the central directory's external file attributes, so POSIX launcher
// scripts extracted from the "node" archive on macOS/Linux stay executable.
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

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed: 2026-01-01
const UNIX_FILE_EXECUTABLE = (0o100755 << 16) >>> 0;
const UNIX_FILE_REGULAR = (0o100644 << 16) >>> 0;

/** entries: [{ name, data: Buffer, executable?: boolean }] */
function writeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const uncompressed = entry.data;
    const crc = crc32(uncompressed);
    const deflated = deflateRawSync(uncompressed);
    const useDeflate = deflated.length < uncompressed.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : uncompressed;
    const externalAttr = entry.executable === true ? UNIX_FILE_EXECUTABLE : UNIX_FILE_REGULAR;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt8(20, 4); // version made by (spec version, low byte)
    central.writeUInt8(3, 5); // version made by (host: UNIX, so external attrs carry a mode)
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0x0800, 8); // general purpose flag: UTF-8 name
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra length(30), comment length(32), disk start(34), internal
    // attrs(36) all stay 0 from Buffer.alloc.
    central.writeUInt32LE(externalAttr, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function readZipEntries(buffer) {
  const EOCD_SIGNATURE = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('not a valid zip archive (no end-of-central-directory record found)');
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`corrupt zip central directory entry at offset ${cursor}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttr = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, crc, compressedSize, uncompressedSize, externalAttr, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntryData(buffer, entry) {
  if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
    throw new Error(`corrupt zip local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  const data = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
  const actualCrc = crc32(data);
  if (actualCrc >>> 0 !== entry.crc >>> 0) {
    throw new Error(
      `CRC-32 mismatch extracting ${entry.name}: expected ${entry.crc.toString(16)}, got ${actualCrc.toString(16)}`,
    );
  }
  return data;
}

/** Extract exactly one entry (matched by exact name or by basename) to destFile. */
function extractZipFile(archivePath, entryName, destFile) {
  const buffer = readFileSync(archivePath);
  const entries = readZipEntries(buffer);
  const entry = entries.find((candidate) => candidate.name === entryName);
  if (entry === undefined) {
    throw new Error(`entry "${entryName}" not found in ${archivePath} (found: ${entries.map((e) => e.name).join(', ')})`);
  }
  mkdirSync(path.dirname(destFile), { recursive: true });
  writeFileSync(destFile, extractZipEntryData(buffer, entry));
}

/** Extract every entry into destDir, preserving unix mode bits where present. */
function extractZipAll(archivePath, destDir) {
  const buffer = readFileSync(archivePath);
  const entries = readZipEntries(buffer);
  for (const entry of entries) {
    if (entry.name.endsWith('/')) {
      mkdirSync(path.join(destDir, ...entry.name.split('/')), { recursive: true });
      continue;
    }
    const target = path.join(destDir, ...entry.name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, extractZipEntryData(buffer, entry));
    const mode = (entry.externalAttr >>> 16) & 0o7777;
    if (mode !== 0) {
      try {
        chmodSync(target, mode);
      } catch {
        // Best-effort: not every filesystem tracks unix permission bits.
      }
    }
  }
  return entries.map((entry) => entry.name);
}

// ---------------------------------------------------------------------------
// .tar.gz via the system `tar`, per the release workflow's own convention.
//
// Every invocation below runs with `cwd` set to the directory that holds the
// archive (or will hold it) and passes tar only a bare relative filename —
// never an absolute path, and never `-C <absolute path>`. GNU tar treats an
// -f argument matching `<name-with-no-slash>:...` as a remote "host:file"
// spec, which an absolute Windows path (`C:\...`) matches; some GNU tar
// builds also mis-translate absolute Windows paths passed as other
// arguments (e.g. -C) through their own MSYS path-conversion layer. Bare
// relative names sidestep both failure modes on every platform.
// ---------------------------------------------------------------------------

function extractTarGzFile(archivePath, entryPathInArchive, destFile) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'specbridge-tar-extract-'));
  try {
    const localArchiveName = 'archive.tar.gz';
    copyFileSync(archivePath, path.join(tempDir, localArchiveName));
    execFileSync('tar', ['-xzf', localArchiveName, entryPathInArchive], { cwd: tempDir, stdio: 'pipe' });
    mkdirSync(path.dirname(destFile), { recursive: true });
    copyFileSync(path.join(tempDir, ...entryPathInArchive.split('/')), destFile);
  } finally {
    rmRecursive(tempDir);
  }
}

function extractTarGzAll(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const localArchiveName = '.specbridge-extract-source.tar.gz';
  const localArchivePath = path.join(destDir, localArchiveName);
  copyFileSync(archivePath, localArchivePath);
  try {
    execFileSync('tar', ['-xzf', localArchiveName], { cwd: destDir, stdio: 'pipe' });
  } finally {
    rmSync(localArchivePath, { force: true });
  }
}

function createTarGz(stagingParentDir, stagingDirName, outPath) {
  const localArchiveName = `${stagingDirName}.tar.gz`;
  execFileSync('tar', ['-czf', localArchiveName, stagingDirName], { cwd: stagingParentDir, stdio: 'pipe' });
  mkdirSync(path.dirname(outPath), { recursive: true });
  copyFileSync(path.join(stagingParentDir, localArchiveName), outPath);
  rmSync(path.join(stagingParentDir, localArchiveName), { force: true });
}

const TAR_BLOCK_SIZE = 512;

function parseTarOctal(buffer, offset, length) {
  const raw = buffer
    .toString('latin1', offset, offset + length)
    .replace(/\0.*$/, '')
    .trim();
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

function writeTarMode(buffer, offset, mode) {
  // The classic tar (and USTAR) mode field is 8 bytes: 7 zero-padded octal
  // digits followed by a NUL.
  buffer.write(mode.toString(8).padStart(7, '0'), offset, 7, 'latin1');
  buffer[offset + 7] = 0;
}

/**
 * Force specific entries in a just-created .tar.gz to mode 0755, fixing up
 * each patched header's checksum.
 *
 * On a POSIX build machine this is a no-op: `chmodSync` already set real
 * exec bits before `tar` read them, so every targeted entry is already
 * 0755 and nothing is rewritten (the archive is not even touched). It only
 * does real work when the archive was staged on a filesystem that cannot
 * express the execute bit (Windows), where `chmodSync` silently succeeds
 * without changing anything — without this fixup, a Windows-built archive's
 * launcher scripts and bundled node binary would extract non-executable on
 * macOS/Linux. Real releases are always built on native Linux/macOS
 * runners (see .github/workflows/release.yml), so this only ever does real
 * work for local, cross-platform validation builds.
 */
function fixupTarGzExecutableBits(archivePath, executableNames) {
  const patched = Buffer.from(gunzipSync(readFileSync(archivePath)));
  let changed = false;
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= patched.length) {
    const header = patched.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break; // end-of-archive padding

    const name = header.toString('latin1', 0, 100).replace(/\0.*$/, '');
    const size = parseTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]);
    const isRegularFile = typeFlag === '0' || typeFlag === '\0';
    const isTarget = executableNames.some((candidate) => name === candidate || name.endsWith(`/${candidate}`));

    if (isRegularFile && isTarget && parseTarOctal(header, 100, 8) !== 0o755) {
      writeTarMode(patched, offset + 100, 0o755);
      patched.fill(0x20, offset + 148, offset + 156); // checksum field := 8 spaces while summing
      let sum = 0;
      for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) sum += patched[offset + i];
      patched.write(`${sum.toString(8).padStart(6, '0')}\0 `, offset + 148, 8, 'latin1');
      changed = true;
    }

    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  if (changed) writeFileSync(archivePath, gzipSync(patched));
  return changed;
}

// ---------------------------------------------------------------------------
// Pinned Node.js runtime download, cache, and verification.
// ---------------------------------------------------------------------------

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function downloadNodeArtifact(fileName) {
  const expectedSha256 = NODE_RUNTIME_SHA256[fileName];
  if (expectedSha256 === undefined) {
    fail(`no pinned SHA-256 for "${fileName}"; refusing to download an unverified artifact.`);
  }
  mkdirSync(NODE_CACHE_DIR, { recursive: true });
  const cachedPath = path.join(NODE_CACHE_DIR, fileName);

  if (existsSync(cachedPath)) {
    if (sha256File(cachedPath) === expectedSha256) {
      console.log(`package-standalone: using cached ${fileName}`);
      return cachedPath;
    }
    console.warn(`package-standalone: cached ${fileName} failed checksum verification; re-downloading.`);
    rmSync(cachedPath, { force: true });
  }

  const url = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${fileName}`;
  console.log(`package-standalone: downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) fail(`failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(buffer).digest('hex');
  if (actualSha256 !== expectedSha256) {
    fail(
      `SHA-256 mismatch for ${fileName}: expected ${expectedSha256}, got ${actualSha256}. ` +
        'Refusing to stage an unverified Node.js runtime.',
    );
  }
  const partialPath = `${cachedPath}.partial-${process.pid}`;
  writeFileSync(partialPath, buffer);
  // Rename after the hash check so a killed/interrupted download never
  // leaves a cache entry that a later run would trust without re-checking.
  copyFileSync(partialPath, cachedPath);
  rmSync(partialPath, { force: true });
  return cachedPath;
}

async function stageNodeRuntime(stagingDir, spec) {
  const artifactFileName = `node-v${NODE_RUNTIME_VERSION}-${spec.nodeDistName}.${spec.nodeArtifactFormat}`;
  const archivePath = await downloadNodeArtifact(artifactFileName);
  const runtimeDir = path.join(stagingDir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const destFile = path.join(runtimeDir, spec.runtimeBinaryName);
  const entryInArchive = `node-v${NODE_RUNTIME_VERSION}-${spec.nodeDistName}/${spec.nodeBinaryRelPath}`;

  if (spec.nodeArtifactFormat === 'zip') extractZipFile(archivePath, entryInArchive, destFile);
  else extractTarGzFile(archivePath, entryInArchive, destFile);

  try {
    chmodSync(destFile, 0o755);
  } catch {
    // Best-effort: unix exec bits are only meaningful on a POSIX filesystem.
  }
  return { version: NODE_RUNTIME_VERSION, sha256: NODE_RUNTIME_SHA256[artifactFileName] };
}

// ---------------------------------------------------------------------------
// Staging.
// ---------------------------------------------------------------------------

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content);
  try {
    chmodSync(filePath, 0o755);
  } catch {
    // Best-effort: unix exec bits are only meaningful on a POSIX filesystem.
  }
}

function writeWrappers(binDir, spec) {
  if (spec.wrappers === 'unix' || spec.wrappers === 'both') {
    writeExecutable(
      path.join(binDir, 'specbridge'),
      spec.bundlesRuntime ? UNIX_CLI_WRAPPER : nodeTargetUnixWrapper('cli.cjs'),
    );
    writeExecutable(
      path.join(binDir, 'specbridge-mcp'),
      spec.bundlesRuntime ? UNIX_MCP_WRAPPER : nodeTargetUnixWrapper('mcp-server.cjs'),
    );
  }
  if (spec.wrappers === 'windows' || spec.wrappers === 'both') {
    writeFileSync(
      path.join(binDir, 'specbridge.cmd'),
      spec.bundlesRuntime ? WINDOWS_CLI_WRAPPER : nodeTargetWindowsWrapper('cli.cjs'),
    );
    writeFileSync(
      path.join(binDir, 'specbridge-mcp.cmd'),
      spec.bundlesRuntime ? WINDOWS_MCP_WRAPPER : nodeTargetWindowsWrapper('mcp-server.cjs'),
    );
  }
}

function writeQuickstart(stagingDir, target, spec) {
  const template = readFileSync(path.join(releaseAssetsDir, 'QUICKSTART.md'), 'utf8');
  const runtimeRow = spec.bundlesRuntime
    ? '| `runtime/` | bundled Node.js runtime (pinned; nothing to install separately) |\n'
    : '';
  const windowsRun = ['```', 'bin\\specbridge.cmd doctor', 'bin\\specbridge-mcp.cmd --stdio', '```'].join('\n');
  const unixRun = ['```', './bin/specbridge doctor', './bin/specbridge-mcp --stdio', '```'].join('\n');
  const bundledRuntimeNote = 'No separate Node.js install is required — this archive bundles its own pinned runtime.';

  let runSection;
  if (!spec.bundlesRuntime) {
    runSection = [
      'This archive bundles no Node.js runtime; it requires Node.js >= 20',
      'already on PATH ([nodejs.org](https://nodejs.org/)).',
      '',
      unixRun,
      '',
      'On Windows, use `bin\\specbridge.cmd` and `bin\\specbridge-mcp.cmd` instead.',
    ].join('\n');
  } else if (spec.wrappers === 'windows') {
    runSection = [bundledRuntimeNote, '', windowsRun].join('\n');
  } else {
    runSection = [bundledRuntimeNote, '', unixRun].join('\n');
  }
  const rendered = template
    .replaceAll('{{VERSION}}', VERSION)
    .replaceAll('{{TARGET}}', target)
    .replaceAll('{{RUNTIME_ROW}}', runtimeRow)
    .replaceAll('{{RUN_SECTION}}', runSection);
  writeFileSync(path.join(stagingDir, 'QUICKSTART.md'), rendered);
}

async function stageCommonFiles(stagingDir, target, spec) {
  const libDir = path.join(stagingDir, 'lib');
  mkdirSync(libDir, { recursive: true });
  for (const bundle of ['cli.cjs', 'mcp-server.cjs']) {
    const source = path.join(pluginDistDir, bundle);
    if (!existsSync(source)) {
      fail(
        `${path.relative(repoRoot, source)} is missing — run "pnpm build:plugin" before packaging.`,
        2,
      );
    }
    copyFileSync(source, path.join(libDir, bundle));
  }

  const licenses = path.join(pluginDistDir, 'THIRD_PARTY_LICENSES.txt');
  if (!existsSync(licenses)) {
    fail(`${path.relative(repoRoot, licenses)} is missing — run "pnpm build:plugin" before packaging.`, 2);
  }
  copyFileSync(licenses, path.join(stagingDir, 'THIRD_PARTY_LICENSES.txt'));

  copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stagingDir, 'LICENSE'));
  copyFileSync(path.join(repoRoot, 'NOTICE.md'), path.join(stagingDir, 'NOTICE.md'));

  const binDir = path.join(stagingDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeWrappers(binDir, spec);

  writeQuickstart(stagingDir, target, spec);
}

// ---------------------------------------------------------------------------
// Manifest.
// ---------------------------------------------------------------------------

function walkFiles(rootDir, visit) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) visit(full, path.relative(rootDir, full).split(path.sep).join('/'));
    }
  };
  walk(rootDir);
}

function collectManifestFiles(stagingDir) {
  const files = [];
  walkFiles(stagingDir, (full, relative) => {
    const data = readFileSync(full);
    files.push({ path: relative, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length });
  });
  return files;
}

/** Files whose POSIX exec bit must survive packaging. */
function isExecutableEntry(relativePath) {
  return relativePath === 'bin/specbridge' || relativePath === 'bin/specbridge-mcp' || relativePath === 'runtime/node';
}

/**
 * Zip entry names are prefixed with archiveBaseName/ so extracting the zip
 * recreates the same specbridge-v<version>-<target>/... layout that `tar -C
 * stagingParent archiveBaseName` produces for the .tar.gz targets.
 */
function collectZipEntries(stagingDir, archiveBaseName) {
  const entries = [];
  walkFiles(stagingDir, (full, relative) => {
    entries.push({
      name: `${archiveBaseName}/${relative}`,
      data: readFileSync(full),
      executable: isExecutableEntry(relative),
    });
  });
  return entries;
}

function assertNoAbsolutePaths(rootDir, needles, describe) {
  const normalized = [
    ...new Set(needles.flatMap((needle) => [needle, needle.split(path.sep).join('/'), needle.split(path.sep).join('\\')])),
  ].filter((needle) => needle.length > 3);
  walkFiles(rootDir, (full, relative) => {
    const content = readFileSync(full).toString('latin1');
    for (const needle of normalized) {
      if (content.includes(needle)) {
        fail(`${describe(relative)} contains an absolute build-machine path ("${needle}"); refusing to package it.`);
      }
    }
  });
}

function assertNoAbsolutePathsInManifest(manifest, needles) {
  const json = JSON.stringify(manifest);
  for (const needle of needles) {
    const variants = [needle, needle.split(path.sep).join('/'), needle.split(path.sep).join('\\')];
    if (variants.some((variant) => variant.length > 3 && json.includes(variant))) {
      fail(`release-manifest.json contains an absolute build-machine path ("${needle}"); refusing to package it.`);
    }
  }
}

function buildManifest({ target, spec, archiveFileName, nodeRuntimeInfo, files }) {
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  return {
    product: 'SpecBridge',
    version: VERSION,
    gitCommit,
    buildTimestamp: new Date().toISOString(),
    nodeRuntime: nodeRuntimeInfo ?? { version: null, sha256: null },
    toolchain: { node: process.version, pnpm: PNPM_VERSION },
    platform: spec.platform,
    arch: spec.arch,
    target,
    archive: archiveFileName,
    files,
    schemaVersions,
    pluginVersion: VERSION,
    kiroLayout: '1',
    runnerAdapterContractVersion: '1.0.0',
    extensionProtocolVersion: '1.0.0',
  };
}

// ---------------------------------------------------------------------------
// Smoke test.
// ---------------------------------------------------------------------------

let smokeFailures = 0;

function smokeCheck(target, label, condition, detail = '') {
  if (condition) {
    console.log(`ok    [smoke:${target}] ${label}`);
  } else {
    smokeFailures += 1;
    console.error(`FAIL  [smoke:${target}] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function currentHostTarget() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'macos-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64';
  return undefined;
}

function invokeCli(cliBin, args, cwd) {
  const useWindowsShim = process.platform === 'win32';
  const options = { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } };
  if (useWindowsShim) {
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cliBin, ...args], options);
  }
  return execFileSync(cliBin, args, options);
}

function invokeCliAllowFailure(cliBin, args, cwd) {
  try {
    return { status: 0, stdout: invokeCli(cliBin, args, cwd), stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
    };
  }
}

async function runSmoke(target, spec, archivePath) {
  const hostTarget = currentHostTarget();
  if (target !== 'node' && target !== hostTarget) {
    console.log(`smoke  [smoke:${target}] smoke skipped (cross-platform build)`);
    return;
  }

  const extractDir = mkdtempSync(path.join(os.tmpdir(), 'specbridge-smoke-extract-'));
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'specbridge-smoke-empty-'));
  const exampleDir = mkdtempSync(path.join(os.tmpdir(), 'specbridge-smoke-example-'));
  try {
    if (spec.archiveFormat === 'zip') extractZipAll(archivePath, extractDir);
    else extractTarGzAll(archivePath, extractDir);

    const root = path.join(extractDir, `specbridge-v${VERSION}-${target}`);
    const useWindowsShim = process.platform === 'win32';
    const cliBin = path.join(root, 'bin', useWindowsShim ? 'specbridge.cmd' : 'specbridge');
    if (!useWindowsShim) {
      try {
        chmodSync(cliBin, 0o755);
      } catch {
        // Best-effort.
      }
    }

    const version = invokeCli(cliBin, ['--version'], root).trim();
    smokeCheck(target, '--version prints exactly the release version', version === VERSION, version);

    const doctorEmpty = invokeCliAllowFailure(cliBin, ['doctor'], emptyDir);
    smokeCheck(
      target,
      'doctor in an empty directory fails with guidance, not a crash',
      doctorEmpty.status !== 0 && doctorEmpty.stdout.includes('No .kiro directory found'),
      `exit ${doctorEmpty.status}`,
    );

    cpSync(path.join(repoRoot, 'examples', 'existing-kiro-project'), exampleDir, { recursive: true });
    const doctorExample = invokeCliAllowFailure(cliBin, ['doctor'], exampleDir);
    smokeCheck(
      target,
      'doctor on the example Kiro project succeeds',
      doctorExample.status === 0,
      `exit ${doctorExample.status}: ${doctorExample.stderr.slice(0, 300)}`,
    );
  } finally {
    rmRecursive(extractDir);
    rmRecursive(emptyDir);
    rmRecursive(exampleDir);
  }
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

async function buildTarget(target, outDir, smoke) {
  const spec = TARGETS[target];
  const archiveBaseName = `specbridge-v${VERSION}-${target}`;
  const archiveFileName = `${archiveBaseName}.${spec.archiveFormat}`;
  const stagingParent = mkdtempSync(path.join(os.tmpdir(), 'specbridge-package-'));
  const stagingDir = path.join(stagingParent, archiveBaseName);
  mkdirSync(stagingDir, { recursive: true });

  try {
    await stageCommonFiles(stagingDir, target, spec);

    let nodeRuntimeInfo = null;
    if (spec.bundlesRuntime) nodeRuntimeInfo = await stageNodeRuntime(stagingDir, spec);

    const absolutePathNeedles = [repoRoot, os.homedir()];
    assertNoAbsolutePaths(stagingDir, absolutePathNeedles, (relative) => `staged file "${relative}"`);

    const files = collectManifestFiles(stagingDir);
    const manifest = buildManifest({ target, spec, archiveFileName, nodeRuntimeInfo, files });
    assertNoAbsolutePathsInManifest(manifest, absolutePathNeedles);
    writeFileSync(path.join(stagingDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    mkdirSync(outDir, { recursive: true });
    const archivePath = path.join(outDir, archiveFileName);
    if (spec.archiveFormat === 'zip') {
      writeFileSync(archivePath, writeZip(collectZipEntries(stagingDir, archiveBaseName)));
    } else {
      createTarGz(stagingParent, archiveBaseName, archivePath);
      fixupTarGzExecutableBits(archivePath, ['bin/specbridge', 'bin/specbridge-mcp', 'runtime/node']);
    }
    writeFileSync(path.join(outDir, `${archiveFileName}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(
      `ok    ${target}: ${path.relative(repoRoot, archivePath)} ` +
        `(${statSync(archivePath).size} bytes, ${files.length} staged files)`,
    );

    if (smoke) await runSmoke(target, spec, archivePath);
  } finally {
    rmRecursive(stagingParent);
  }
}

function parseArgs(argv) {
  const args = { smoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') args.target = argv[(i += 1)];
    else if (arg === '--out') args.out = argv[(i += 1)];
    else if (arg === '--smoke') args.smoke = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else fail(`unrecognized argument: "${arg}"`, 2);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/package-standalone.mjs --target <target> --out <dir> [--smoke]',
      '',
      `  --target   one of: ${Object.keys(TARGETS).join(', ')}`,
      '  --out      directory to write the archive and its manifest into',
      '  --smoke    extract and run the archive when this host can execute it',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    printUsage();
    return;
  }
  if (args.target === undefined || !(args.target in TARGETS)) {
    printUsage();
    fail(`--target must be one of ${Object.keys(TARGETS).join(', ')} (got ${JSON.stringify(args.target)}).`, 2);
  }
  if (args.out === undefined) {
    printUsage();
    fail('--out <dir> is required.', 2);
  }

  await buildTarget(args.target, path.resolve(args.out), args.smoke);

  if (smokeFailures > 0) fail(`${smokeFailures} smoke check(s) failed for target "${args.target}".`);
  console.log(`package-standalone: ${args.target} packaged successfully.`);
}

await main();
