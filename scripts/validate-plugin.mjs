/**
 * Deterministic Claude Code plugin validation (`pnpm validate:plugin`).
 *
 * Validates manifests, skill frontmatter, required files, wrappers, version
 * consistency, forbidden permission strings, absolute build paths, and the
 * release ZIP — all offline, without Claude Code installed. Exits 0 when
 * everything passes, 1 otherwise, listing every failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge');
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// --- plugin.json ------------------------------------------------------------
const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
let manifest;
if (!existsSync(manifestPath)) {
  fail('.claude-plugin/plugin.json is missing');
} else {
  manifest = readJson(manifestPath);
  for (const field of ['name', 'description', 'version', 'author', 'license']) {
    if (manifest[field] === undefined) fail(`plugin.json is missing "${field}"`);
  }
  if (manifest.name !== 'specbridge') fail(`plugin.json name must be "specbridge" (got "${manifest.name}")`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) fail('plugin.json version is not semver');
}

// Only plugin.json belongs inside .claude-plugin/.
const metaEntries = readdirSync(path.join(pluginRoot, '.claude-plugin'));
if (metaEntries.length !== 1 || metaEntries[0] !== 'plugin.json') {
  fail(`.claude-plugin/ must contain only plugin.json (found: ${metaEntries.join(', ')})`);
}

// --- .mcp.json ---------------------------------------------------------------
const mcpConfigPath = path.join(pluginRoot, '.mcp.json');
if (!existsSync(mcpConfigPath)) {
  fail('.mcp.json is missing at the plugin root');
} else {
  const mcpConfig = readJson(mcpConfigPath);
  const server = mcpConfig.mcpServers?.specbridge;
  if (server === undefined) fail('.mcp.json must define mcpServers.specbridge');
  else {
    if (server.command !== 'node') fail('.mcp.json server command must be "node"');
    const args = server.args ?? [];
    if (!args.some((arg) => String(arg).includes('${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs'))) {
      fail('.mcp.json must launch ${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs');
    }
    if (!args.includes('--stdio')) fail('.mcp.json must pass --stdio');
    if (args.some((arg) => path.isAbsolute(String(arg)) && !String(arg).startsWith('${'))) {
      fail('.mcp.json must not contain absolute build-machine paths');
    }
    if (server.env !== undefined && Object.keys(server.env).length > 0) {
      fail('.mcp.json must not set environment values (no secrets, no overrides)');
    }
  }
}

// --- required files ----------------------------------------------------------
for (const required of [
  'README.md',
  'LICENSE',
  'NOTICE.md',
  'bin/specbridge',
  'bin/specbridge.cmd',
  'dist/cli.cjs',
  'dist/mcp-server.cjs',
  'dist/THIRD_PARTY_LICENSES.txt',
  'dist/checksums.json',
]) {
  if (!existsSync(path.join(pluginRoot, required))) fail(`required plugin file missing: ${required}`);
}

// --- skills -------------------------------------------------------------------
const EXPECTED_SKILLS = ['approve', 'author', 'continue', 'doctor', 'implement', 'new', 'runners', 'status', 'templates', 'verify'];
const skillsDir = path.join(pluginRoot, 'skills');
const skillDirs = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];
if (skillDirs.join(',') !== EXPECTED_SKILLS.join(',')) {
  fail(`skills/ must contain exactly [${EXPECTED_SKILLS.join(', ')}] (found: ${skillDirs.join(', ')})`);
}

function parseFrontmatter(markdown, name) {
  if (!markdown.startsWith('---\n')) {
    fail(`skill ${name}: SKILL.md must start with YAML frontmatter`);
    return {};
  }
  const end = markdown.indexOf('\n---', 4);
  if (end < 0) {
    fail(`skill ${name}: frontmatter is not closed`);
    return {};
  }
  const block = markdown.slice(4, end);
  const data = {};
  let currentKey;
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match) {
      currentKey = match[1];
      data[currentKey] = match[2];
    } else if (currentKey !== undefined && /^\s+/.test(line)) {
      data[currentKey] += ` ${line.trim()}`;
    }
  }
  return data;
}

const FORBIDDEN_ANYWHERE = ['bypassPermissions', 'dangerously-skip-permissions', 'dangerously_skip_permissions'];
const seenSkillNames = new Set();
for (const skill of skillDirs) {
  const skillPath = path.join(skillsDir, skill, 'SKILL.md');
  if (!existsSync(skillPath)) {
    fail(`skill ${skill}: SKILL.md is missing`);
    continue;
  }
  const markdown = readFileSync(skillPath, 'utf8');
  const frontmatter = parseFrontmatter(markdown, skill);
  const name = frontmatter.name ?? skill;
  if (seenSkillNames.has(name)) fail(`duplicate skill name "${name}"`);
  seenSkillNames.add(name);
  if (frontmatter.description === undefined || frontmatter.description.length < 20) {
    fail(`skill ${skill}: description is missing or too short`);
  }
  for (const forbidden of FORBIDDEN_ANYWHERE) {
    if (markdown.includes(forbidden)) fail(`skill ${skill}: contains forbidden string "${forbidden}"`);
  }
  const allowedTools = frontmatter['allowed-tools'] ?? '';
  if (/Bash\(\*\)|Bash\("?\*"?\)|^Write$|,\s*Write\s*(,|$)/.test(allowedTools)) {
    fail(`skill ${skill}: allowed-tools grants unrestricted Bash or Write`);
  }
  if (skill === 'approve') {
    if (frontmatter['disable-model-invocation'] !== 'true') {
      fail('skill approve: frontmatter must set disable-model-invocation: true');
    }
  } else if (frontmatter['allowed-tools'] !== undefined) {
    fail(`skill ${skill}: only the approve skill may declare allowed-tools (found some)`);
  }
  // Nested-agent prohibitions: any line that references a nested-agent
  // invocation must be a negation ("never", "no ", "not"), never an
  // instruction to run one.
  for (const [index, line] of markdown.split('\n').entries()) {
    const mentionsNested = /claude -p|claude\s+--print|spec run\b|spec generate\b|spec refine\b/i.test(line);
    if (!mentionsNested) continue;
    if (!/\bnever\b|\bno\b|\bnot\b/i.test(line)) {
      fail(`skill ${skill}: line ${index + 1} references a nested-agent command without negating it`);
    }
  }
  if (skill === 'implement' || skill === 'continue') {
    if (!markdown.includes('task_begin') || !markdown.includes('task_complete')) {
      fail(`skill ${skill}: must use the task_begin/task_complete lifecycle`);
    }
  }
}

// --- wrappers ------------------------------------------------------------------
const posixWrapper = readFileSync(path.join(pluginRoot, 'bin', 'specbridge'), 'utf8');
if (!posixWrapper.startsWith('#!/bin/sh')) fail('POSIX wrapper must start with #!/bin/sh');
if (!posixWrapper.includes('"$@"')) fail('POSIX wrapper must forward arguments with "$@"');
if (!posixWrapper.includes('dist/cli.cjs')) fail('POSIX wrapper must invoke dist/cli.cjs');
if (posixWrapper.includes('\r')) fail('POSIX wrapper must use LF line endings');
const cmdWrapper = readFileSync(path.join(pluginRoot, 'bin', 'specbridge.cmd'), 'utf8');
if (!/%~dp0/.test(cmdWrapper)) fail('Windows wrapper must resolve its own directory with %~dp0');
if (!/%\*/.test(cmdWrapper)) fail('Windows wrapper must forward arguments with %*');
if (!/exit \/b %errorlevel%/i.test(cmdWrapper)) fail('Windows wrapper must forward the exit code');

// --- marketplace ---------------------------------------------------------------
const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
if (!existsSync(marketplacePath)) {
  fail('.claude-plugin/marketplace.json is missing at the repository root');
} else {
  const marketplace = readJson(marketplacePath);
  if (marketplace.name === undefined || /anthropic|claude|official/i.test(marketplace.name)) {
    fail(`marketplace name "${marketplace.name}" is missing or uses a reserved/official-sounding name`);
  }
  const entry = (marketplace.plugins ?? []).find((plugin) => plugin.name === 'specbridge');
  if (entry === undefined) fail('marketplace.json must list the "specbridge" plugin');
  else {
    const resolved = path.resolve(repoRoot, entry.source);
    if (resolved !== pluginRoot) fail(`marketplace plugin source does not resolve to the plugin root (${entry.source})`);
    if (manifest !== undefined && entry.version !== manifest.version) {
      fail(`marketplace version ${entry.version} != plugin.json version ${manifest.version}`);
    }
  }
}

// --- version consistency ---------------------------------------------------------
const rootVersion = readJson(path.join(repoRoot, 'package.json')).version;
const cliVersion = readJson(path.join(repoRoot, 'packages', 'cli', 'package.json')).version;
if (manifest !== undefined) {
  if (manifest.version !== rootVersion) fail(`plugin version ${manifest.version} != root version ${rootVersion}`);
  if (manifest.version !== cliVersion) fail(`plugin version ${manifest.version} != CLI version ${cliVersion}`);
}
const checksums = readJson(path.join(pluginRoot, 'dist', 'checksums.json'));
if (checksums.version !== manifest?.version) {
  fail(`checksums.json version ${checksums.version} != plugin version ${manifest?.version}`);
}

// --- bundles: no absolute build paths, no forbidden strings, version match ------
const repoRootVariants = [
  repoRoot.split(path.sep).join('/'),
  repoRoot.split(path.sep).join('\\\\'),
];
for (const bundleName of ['cli.cjs', 'mcp-server.cjs']) {
  const bundle = readFileSync(path.join(pluginRoot, 'dist', bundleName), 'utf8');
  for (const variant of repoRootVariants) {
    if (bundle.includes(variant)) fail(`${bundleName} embeds the absolute build path ${variant}`);
  }
  if (/require\(['"]@specbridge\//.test(bundle) || /from ['"]@specbridge\//.test(bundle)) {
    fail(`${bundleName} still references workspace packages at runtime`);
  }
}
const bundledCliVersion = execFileSync(process.execPath, [path.join(pluginRoot, 'dist', 'cli.cjs'), '--version'], {
  encoding: 'utf8',
}).trim();
if (manifest !== undefined && bundledCliVersion !== manifest.version) {
  fail(`bundled CLI reports ${bundledCliVersion}, expected ${manifest.version} — rebuild the plugin`);
}
const bundledServerVersion = execFileSync(
  process.execPath,
  [path.join(pluginRoot, 'dist', 'mcp-server.cjs'), '--version'],
  { encoding: 'utf8' },
).trim();
if (manifest !== undefined && bundledServerVersion !== manifest.version) {
  fail(`bundled MCP server reports ${bundledServerVersion}, expected ${manifest.version} — rebuild the plugin`);
}

// --- ZIP ---------------------------------------------------------------------------
const zipPath = path.join(repoRoot, 'dist', `specbridge-claude-plugin-${manifest?.version}.zip`);
if (!existsSync(zipPath)) {
  fail(`release ZIP missing: ${path.relative(repoRoot, zipPath)} — run pnpm build:plugin`);
} else {
  const zip = readFileSync(zipPath);
  const names = [];
  // Walk the central directory for entry names.
  let offset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (offset < 0) {
    fail('release ZIP has no end-of-central-directory record');
  } else {
    const centralOffset = zip.readUInt32LE(offset + 16);
    let cursor = centralOffset;
    while (cursor < offset && zip.readUInt32LE(cursor) === 0x02014b50) {
      const nameLength = zip.readUInt16LE(cursor + 28);
      const extraLength = zip.readUInt16LE(cursor + 30);
      const commentLength = zip.readUInt16LE(cursor + 32);
      names.push(zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    for (const required of [
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'README.md',
      'LICENSE',
      'NOTICE.md',
      'bin/specbridge',
      'bin/specbridge.cmd',
      'dist/cli.cjs',
      'dist/mcp-server.cjs',
      'dist/THIRD_PARTY_LICENSES.txt',
    ]) {
      if (!names.includes(required)) fail(`release ZIP is missing ${required}`);
    }
    for (const name of names) {
      if (/^(node_modules|\.git|\.kiro|\.specbridge)\//.test(name) || /\.(map|log)$/.test(name)) {
        fail(`release ZIP contains forbidden entry ${name}`);
      }
    }
    notes.push(`ZIP contains ${names.length} entries`);
  }
}

// -----------------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`validate-plugin: ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(
  `validate-plugin: OK — manifest, marketplace, ${EXPECTED_SKILLS.length} skills, wrappers, bundles, versions (${manifest?.version}), ZIP.` +
    (notes.length > 0 ? ` ${notes.join('; ')}.` : ''),
);
