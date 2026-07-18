#!/usr/bin/env node
/**
 * Assemble the final release assets and prove a published release is
 * complete.
 *
 * Usage:
 *   node scripts/assemble-release.mjs --staged <dir> --out <dir> [--allow-missing]
 *   node scripts/assemble-release.mjs --verify-remote <tag>
 *
 * Staged mode copies the expected asset set (by exact filename, derived
 * from the root package version) from --staged into --out, then writes
 * SHA256SUMS.txt, SHA256SUMS.json, and release-manifest.json describing
 * every asset that was copied. Missing expected assets fail the run unless
 * --allow-missing is given, in which case they are printed loudly and the
 * run proceeds with whatever is present (useful for a partial local build).
 *
 * --verify-remote mode checks a already-published GitHub Release (via `gh
 * release view`) actually has every expected asset attached.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const VERSION = rootPackage.version;

const STANDALONE_TARGETS = ['windows-x64', 'linux-x64', 'macos-x64', 'macos-arm64', 'node'];

function fail(message) {
  console.error(`assemble-release: ${message}`);
  process.exit(1);
}

function standaloneArchiveName(target) {
  const ext = target === 'windows-x64' || target === 'node' ? 'zip' : 'tar.gz';
  return `specbridge-v${VERSION}-${target}.${ext}`;
}

/** The complete, versioned set of assets a release must carry. */
function expectedAssets() {
  const assets = [];
  for (const target of STANDALONE_TARGETS) {
    const archive = standaloneArchiveName(target);
    assets.push({ name: archive, target });
    assets.push({ name: `${archive}.manifest.json`, target });
  }
  assets.push({ name: `specbridge-claude-plugin-${VERSION}.zip`, target: null });
  assets.push({ name: `migration-guide-v${VERSION}.md`, target: null });
  assets.push({ name: `specbridge-cli-${VERSION}.tgz`, target: null });
  return assets;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { allowMissing: false, verifyRemoteGiven: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--staged') args.staged = argv[(i += 1)];
    else if (arg === '--out') args.out = argv[(i += 1)];
    else if (arg === '--allow-missing') args.allowMissing = true;
    else if (arg === '--verify-remote') {
      args.verifyRemoteGiven = true;
      args.verifyRemote = argv[(i += 1)];
    } else if (arg === '--help' || arg === '-h') args.help = true;
    else fail(`unrecognized argument: "${arg}"`);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node scripts/assemble-release.mjs --staged <dir> --out <dir> [--allow-missing]',
      '  node scripts/assemble-release.mjs --verify-remote <tag>',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// --staged / --out
// ---------------------------------------------------------------------------

function runStagedMode(args) {
  if (args.staged === undefined || args.out === undefined) {
    printUsage();
    fail('--staged <dir> and --out <dir> are both required (or use --verify-remote <tag>).');
  }
  const stagedDir = path.resolve(args.staged);
  const outDir = path.resolve(args.out);
  if (!existsSync(stagedDir)) fail(`--staged directory does not exist: ${stagedDir}`);

  const expected = expectedAssets();
  const present = [];
  const missing = [];
  for (const asset of expected) {
    const source = path.join(stagedDir, asset.name);
    if (existsSync(source) && statSync(source).isFile()) present.push({ ...asset, source });
    else missing.push(asset.name);
  }

  if (missing.length > 0) {
    console.error(
      `assemble-release: ${missing.length}/${expected.length} expected asset(s) ` +
        `${args.allowMissing ? 'missing (allowed by --allow-missing)' : 'MISSING'}:`,
    );
    for (const name of missing) console.error(`  - ${name}`);
  }
  if (missing.length > 0 && !args.allowMissing) {
    fail('one or more expected release assets are missing. Pass --allow-missing to proceed with a partial set anyway.');
  }

  mkdirSync(outDir, { recursive: true });
  const assetRecords = [];
  for (const asset of present) {
    const destination = path.join(outDir, asset.name);
    copyFileSync(asset.source, destination);
    const bytes = statSync(destination).size;
    const hash = sha256(destination);
    assetRecords.push({ name: asset.name, sha256: hash, bytes, target: asset.target });
    console.log(`ok    ${asset.name} (${bytes} bytes)`);
  }
  assetRecords.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  writeFileSync(
    path.join(outDir, 'SHA256SUMS.txt'),
    `${assetRecords.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`,
  );
  writeFileSync(
    path.join(outDir, 'SHA256SUMS.json'),
    `${JSON.stringify(Object.fromEntries(assetRecords.map((asset) => [asset.name, asset.sha256])), null, 2)}\n`,
  );
  writeFileSync(
    path.join(outDir, 'release-manifest.json'),
    `${JSON.stringify(
      {
        product: 'SpecBridge',
        version: VERSION,
        gitCommit: gitCommit(),
        buildTimestamp: new Date().toISOString(),
        assets: assetRecords,
      },
      null,
      2,
    )}\n`,
  );

  console.log('');
  console.log(
    missing.length === 0
      ? `assemble-release: all ${expected.length} expected assets are present in ${path.relative(repoRoot, outDir) || outDir}.`
      : `assemble-release: ${present.length}/${expected.length} expected assets present in ` +
          `${path.relative(repoRoot, outDir) || outDir} (${missing.length} missing, allowed).`,
  );
}

// ---------------------------------------------------------------------------
// --verify-remote <tag>
// ---------------------------------------------------------------------------

function runVerifyRemoteMode(tag) {
  if (typeof tag !== 'string' || tag.trim().length === 0) {
    printUsage();
    fail('--verify-remote requires a tag, e.g. --verify-remote v1.0.0');
  }

  const result = spawnSync('gh', ['release', 'view', tag, '--json', 'assets'], { encoding: 'utf8' });
  if (result.error) fail(`could not run "gh": ${result.error.message}`);
  if (result.status !== 0) {
    fail(`"gh release view ${tag} --json assets" failed: ${(result.stderr || result.stdout || '').trim()}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    fail(`"gh release view ${tag} --json assets" did not print valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    return;
  }

  const uploaded = new Set((parsed.assets ?? []).map((asset) => asset.name));
  const expected = expectedAssets();
  const missing = expected.filter((asset) => !uploaded.has(asset.name)).map((asset) => asset.name);

  for (const asset of expected) {
    if (uploaded.has(asset.name)) console.log(`ok    ${asset.name}`);
  }
  if (missing.length > 0) {
    console.error(`assemble-release: release "${tag}" is missing ${missing.length}/${expected.length} expected asset(s):`);
    for (const name of missing) console.error(`  - ${name}`);
    process.exit(1);
  }
  console.log(`assemble-release: release "${tag}" has all ${expected.length} expected assets.`);
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  printUsage();
} else if (args.verifyRemoteGiven) {
  runVerifyRemoteMode(args.verifyRemote);
} else {
  runStagedMode(args);
}
