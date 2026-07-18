#!/usr/bin/env node
/**
 * Deterministic repository security scan (v1.0.0).
 *
 * Greps production sources and release-bound assets for patterns that must
 * never appear there: hardcoded credentials, private keys, `.env` files,
 * permission-bypass strings, `eval`/`Function` constructor use, in-process
 * third-party extension imports, absolute build-machine paths in bundles,
 * and source maps in release bundles.
 *
 * Test fixtures MAY contain dangerous-looking strings on purpose (negative
 * fixtures); this scan therefore covers only production trees. It is a
 * regression tripwire, not a substitute for review or a full scanner.
 *
 * Usage: node scripts/security-scan.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Production trees scanned with the full rule set. */
const SOURCE_TREES = [
  'packages',
  'integrations/github-action/src',
  'scripts',
];
/** Release-bound bundles: also checked for absolute paths and source maps. */
const BUNDLE_TREES = [
  'integrations/claude-code-plugin/specbridge/dist',
  'integrations/github-action/dist',
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'builtins']);

const problems = [];
let scanned = 0;

function record(file, rule, line, excerpt) {
  problems.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), rule, line, excerpt });
}

/** rule: [name, regex, allowPredicate?] — allowPredicate(file, lineText) → true = not a finding. */
const SOURCE_RULES = [
  [
    'hardcoded-credential',
    /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i,
    (file, text) =>
      /schema|reject|redact|forbidden|pattern|example|placeholder/i.test(text) ||
      file.includes(`${path.sep}tests${path.sep}`),
  ],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    'eval-call',
    /\beval\s*\(/,
    (_file, text) => /no-eval|never uses eval|reject/i.test(text),
  ],
  [
    'function-constructor',
    /\bnew Function\s*\(/,
  ],
  [
    'permission-bypass-string',
    /(?:bypassPermissions|dangerously-skip-permissions)/,
    // Reviewed exceptions: these files DEFINE the forbidden-fragment
    // blocklists that reject the strings (verified defensive use).
    (file) =>
      [
        `packages${path.sep}core${path.sep}src${path.sep}agent-config.ts`,
        `packages${path.sep}runners${path.sep}src${path.sep}claude-code${path.sep}invocation.ts`,
        `packages${path.sep}runners${path.sep}src${path.sep}gemini-cli${path.sep}invocation.ts`,
        `scripts${path.sep}security-scan.mjs`,
        `scripts${path.sep}validate-plugin.mjs`,
      ].some((allowed) => file.endsWith(allowed)),
  ],
  [
    'in-process-extension-import',
    /(?:require|import)\s*\(\s*[^)]*extensionEntrypoint/,
  ],
];

const BUNDLE_RULES = [
  ['absolute-windows-path', /[A-Z]:\\(?:Users|work|home)\\/i],
  ['absolute-unix-home-path', /\/(?:home|Users)\/[a-z0-9_-]+\//i],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

function scanFile(file, rules) {
  const raw = readFileSync(file, 'utf8');
  scanned += 1;
  const lines = raw.split(/\r?\n/);
  for (const [name, regex, allow] of rules) {
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index];
      if (!regex.test(text)) continue;
      if (allow !== undefined && allow(file, text)) continue;
      record(file, name, index + 1, text.trim().slice(0, 120));
    }
  }
}

function walk(dir, rules) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(p, rules);
      continue;
    }
    if (entry.name === '.env' || entry.name.startsWith('.env.')) {
      record(p, 'env-file', 0, 'environment file must never be committed or packaged');
      continue;
    }
    if (rules === BUNDLE_RULES) {
      if (entry.name.endsWith('.map')) {
        record(p, 'source-map-in-bundle', 0, 'source maps must not ship in release bundles');
        continue;
      }
      if (['.cjs', '.js', '.json', '.txt'].includes(path.extname(entry.name))) scanFile(p, rules);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) scanFile(p, rules);
  }
}

for (const tree of SOURCE_TREES) {
  const dir = path.join(ROOT, tree);
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, SOURCE_RULES);
}
for (const tree of BUNDLE_TREES) {
  const dir = path.join(ROOT, tree);
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, BUNDLE_RULES);
}

// Plugin manifest: forbidden permission grants.
const pluginManifest = path.join(
  ROOT, 'integrations', 'claude-code-plugin', 'specbridge', '.claude-plugin', 'plugin.json',
);
if (existsSync(pluginManifest)) {
  const raw = readFileSync(pluginManifest, 'utf8');
  for (const forbidden of ['bypassPermissions', 'dangerously', 'Bash(*)', 'Bash(rm']) {
    if (raw.includes(forbidden)) {
      record(pluginManifest, 'forbidden-plugin-permission', 0, forbidden);
    }
  }
}

if (problems.length > 0) {
  console.error(`security-scan: ${problems.length} finding(s) in ${scanned} scanned files:`);
  for (const problem of problems) {
    console.error(`  ✗ [${problem.rule}] ${problem.file}${problem.line > 0 ? `:${problem.line}` : ''}`);
    console.error(`      ${problem.excerpt}`);
  }
  process.exit(1);
}
console.log(`security-scan: OK — ${scanned} files scanned, no findings.`);
