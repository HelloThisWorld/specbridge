#!/usr/bin/env node
/**
 * Validate the published npm package (specbridge-cli) end to end.
 *
 * Usage:
 *   node scripts/validate-npm-package.mjs [--pack-to <dir>]
 *
 * 1. Packs packages/cli with `pnpm pack` — the exact tarball `npm publish`
 *    would upload.
 * 2. Lists its entries and checks them against an explicit allowlist: only
 *    dist/**, package.json, README.md, LICENSE, NOTICE.md may appear; no
 *    source maps, test/fixture files, .env, .kiro, or .specbridge.
 * 3. Scans every packed file for this repo's root path and the current
 *    user's home directory — either would mean the bundle secretly depends
 *    on this machine and is not actually portable.
 * 4. Confirms package.json's bin.specbridge points at dist/index.js and
 *    that file is genuinely present in the tarball.
 * 5. Installs the tarball into a throwaway npm project OUTSIDE this repo
 *    (so none of the @specbridge/* workspace packages are reachable on
 *    disk) and runs the installed CLI from there. If this fails because a
 *    workspace dependency was not bundled into dist/index.js, that is a
 *    release blocker and is called out loudly, distinct from an ordinary
 *    check failure (packages/cli/tsup.config.ts's `noExternal` is what is
 *    supposed to prevent this).
 *
 * Prints a clear ok/FAIL line per check. Exits 1 if any check failed.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = path.join(repoRoot, 'packages', 'cli');

/**
 * Recursively remove a directory, retrying on EBUSY/ENOTEMPTY/EPERM. A
 * directory that just ran an installed binary (npx specbridge ...) can stay
 * momentarily locked on Windows after the process exits; a plain rmSync can
 * lose that race.
 */
function rmRecursive(targetPath) {
  rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

let checks = 0;
let failures = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A check failure that specifically indicates the noExternal bundling regressed. */
function blocker(label, detail) {
  checks += 1;
  failures += 1;
  console.error(`FAIL  ${label}`);
  if (detail) console.error(`      ${detail}`);
  console.error(
    '      RELEASE BLOCKER: this looks like a workspace (@specbridge/*) dependency was not bundled ' +
      'into dist/index.js. Check that packages/cli/tsup.config.ts still sets noExternal: [/^@specbridge\\//].',
  );
}

/** npm/npx are .cmd shims on Windows and cannot be spawned directly without a shell. */
function runShell(command, args, options = {}) {
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', command, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  }
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pack-to') args.packTo = argv[(i += 1)];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`validate-npm-package: unrecognized argument: "${arg}"`);
      process.exit(2);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Pack.
// ---------------------------------------------------------------------------

function packTarball(destDir) {
  mkdirSync(destDir, { recursive: true });
  const result = runShell('pnpm', ['pack', '--pack-destination', destDir, '--json'], {
    cwd: cliDir,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(result.stdout ?? '');
    console.error(result.stderr ?? '');
    console.error('validate-npm-package: "pnpm pack" failed; see output above.');
    process.exit(1);
  }
  const jsonStart = result.stdout.indexOf('{');
  const parsed = JSON.parse(result.stdout.slice(jsonStart));
  return parsed.filename;
}

// ---------------------------------------------------------------------------
// Tarball inspection. `tar` runs with cwd set to the tarball's own
// directory and is given only its bare filename: some tar builds misread an
// absolute Windows path (C:\...) passed as the archive argument as a
// "host:file" remote-archive spec, because the drive letter looks like a
// bare hostname followed by a colon.
// ---------------------------------------------------------------------------

function listEntries(tarballPath) {
  const result = spawnSync('tar', ['-tzf', path.basename(tarballPath)], {
    cwd: path.dirname(tarballPath),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stderr ?? '');
    console.error('validate-npm-package: could not list the tarball entries.');
    process.exit(1);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readEntry(tarballPath, entryName) {
  const result = spawnSync('tar', ['-xzOf', path.basename(tarballPath), entryName], {
    cwd: path.dirname(tarballPath),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`could not read "${entryName}" from ${tarballPath}: ${result.stderr}`);
  }
  return result.stdout;
}

// npm/pnpm always wrap tarball contents in a top-level "package/" directory.
const ALLOWED_ENTRY = /^package\/(dist\/.+|package\.json|README\.md|LICENSE|NOTICE\.md)$/;

function validateEntries(entries) {
  const nonAllowlisted = entries.filter((entry) => !ALLOWED_ENTRY.test(entry));
  check(
    'every packed entry is inside the declared "files" allowlist (dist/**, package.json, README.md, LICENSE, NOTICE.md)',
    nonAllowlisted.length === 0,
    nonAllowlisted.join(', '),
  );

  const maps = entries.filter((entry) => entry.endsWith('.map'));
  check('no source maps (*.map) are packed', maps.length === 0, maps.join(', '));

  const testFixtures = entries.filter((entry) => /(^|\/)(tests?|__tests__|fixtures?)(\/|$)/i.test(entry));
  check('no test or fixture files are packed', testFixtures.length === 0, testFixtures.join(', '));

  const envFiles = entries.filter((entry) => /(^|\/)\.env(\.|$)/.test(entry));
  check('no .env files are packed', envFiles.length === 0, envFiles.join(', '));

  const sidecarDirs = entries.filter((entry) => /(^|\/)\.(kiro|specbridge)(\/|$)/.test(entry));
  check('no .kiro or .specbridge directories are packed', sidecarDirs.length === 0, sidecarDirs.join(', '));

  check('dist/index.js is present in the tarball', entries.includes('package/dist/index.js'));
}

function scanForAbsolutePaths(tarballPath, entries) {
  const needles = [repoRoot, os.homedir()]
    .flatMap((needle) => [needle, needle.split(path.sep).join('/'), needle.split(path.sep).join('\\')])
    .filter((needle) => needle.length > 3);
  const offenders = [];
  for (const entry of entries) {
    const content = readEntry(tarballPath, entry);
    if (needles.some((needle) => content.includes(needle))) offenders.push(entry);
  }
  check(
    'no packed file contains the repo-root path or the current home directory',
    offenders.length === 0,
    offenders.join(', '),
  );
}

/** Returns the packed version, or undefined if package.json could not be read. */
function checkBinField(tarballPath) {
  let pkg;
  try {
    pkg = JSON.parse(readEntry(tarballPath, 'package/package.json'));
  } catch (error) {
    check('package.json inside the tarball parses as JSON', false, error instanceof Error ? error.message : String(error));
    return undefined;
  }
  check('package.json inside the tarball parses as JSON', true);
  check('bin.specbridge points at dist/index.js', pkg.bin?.specbridge === 'dist/index.js', JSON.stringify(pkg.bin));
  return pkg.version;
}

// ---------------------------------------------------------------------------
// Isolated install smoke test — proves the tarball needs nothing this
// monorepo provides.
// ---------------------------------------------------------------------------

function isolatedInstallSmoke(tarballPath, expectedVersion) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'specbridge-npm-isolated-'));
  try {
    const init = runShell('npm', ['init', '-y'], { cwd: scratch });
    if (init.status !== 0) {
      check('isolated project scaffolds with "npm init -y"', false, (init.stderr ?? '').slice(0, 1000));
      return;
    }
    check('isolated project scaffolds with "npm init -y"', true);

    const install = runShell('npm', ['install', tarballPath], { cwd: scratch });
    if (install.status !== 0) {
      blocker(
        'isolated "npm install" of the packed tarball succeeds',
        `${install.stdout ?? ''}\n${install.stderr ?? ''}`.trim().slice(0, 4000),
      );
      return;
    }
    check('isolated "npm install" of the packed tarball succeeds (no workspace package required)', true);

    const version = runShell('npx', ['specbridge', '--version'], {
      cwd: scratch,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const versionOut = (version.stdout ?? '').trim();
    const versionCombined = `${version.stdout ?? ''}\n${version.stderr ?? ''}`;
    if (/cannot find module ['"]@specbridge\//i.test(versionCombined)) {
      blocker('"npx specbridge --version" runs from the isolated install', versionCombined.trim().slice(0, 4000));
      return;
    }
    check(
      '"npx specbridge --version" prints the packed version',
      version.status === 0 && versionOut === expectedVersion,
      `exit ${version.status}: ${JSON.stringify(versionOut)}`,
    );

    const exampleDir = path.join(scratch, 'example-project');
    cpSync(path.join(repoRoot, 'examples', 'existing-kiro-project'), exampleDir, { recursive: true });
    const doctor = runShell('npx', ['specbridge', 'doctor'], {
      cwd: exampleDir,
      env: { ...process.env, NO_COLOR: '1' },
    });
    check(
      '"npx specbridge doctor" succeeds against the example Kiro project',
      doctor.status === 0,
      `exit ${doctor.status}: ${(doctor.stdout ?? '').slice(0, 200)}${(doctor.stderr ?? '').slice(0, 200)}`,
    );
  } finally {
    rmRecursive(scratch);
  }
}

// ---------------------------------------------------------------------------

function printUsage() {
  console.log('Usage: node scripts/validate-npm-package.mjs [--pack-to <dir>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    printUsage();
    return;
  }

  const keepPack = args.packTo !== undefined;
  const packDestination = keepPack
    ? path.resolve(args.packTo)
    : mkdtempSync(path.join(os.tmpdir(), 'specbridge-npm-pack-'));

  let tarballPath;
  try {
    tarballPath = packTarball(packDestination);
    check(`"pnpm pack" produced ${path.basename(tarballPath)}`, existsSync(tarballPath));

    const entries = listEntries(tarballPath);
    validateEntries(entries);
    scanForAbsolutePaths(tarballPath, entries);
    const packedVersion = checkBinField(tarballPath);

    if (packedVersion !== undefined) isolatedInstallSmoke(tarballPath, packedVersion);
  } finally {
    if (!keepPack) rmRecursive(packDestination);
  }

  console.log('');
  if (failures > 0) {
    console.error(`validate-npm-package: ${failures}/${checks} check(s) failed.`);
    process.exit(1);
  }
  console.log(`validate-npm-package: all ${checks} checks passed.${keepPack ? ` Tarball kept at ${tarballPath}` : ''}`);
}

main();
