/**
 * Offline-first structural validation plus current-Codex local install test.
 *
 * When `codex` is available, validation uses an isolated CODEX_HOME and a
 * temporary project. It never reads or mutates the user's Codex config.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codexIntegrationRoot = path.join(repoRoot, 'integrations', 'codex-plugin');
const pluginRoot = path.join(codexIntegrationRoot, 'specbridge');
const claudeRoot = path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge');
const marketplacePath = path.join(
  codexIntegrationRoot,
  '.agents',
  'plugins',
  'marketplace.json',
);
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

for (const required of [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'README.md',
  'LICENSE',
  'NOTICE.md',
  'bin/specbridge',
  'bin/specbridge.cmd',
  'dist/cli.cjs',
  'dist/mcp-launcher.cjs',
  'dist/mcp-server.cjs',
  'dist/THIRD_PARTY_LICENSES.txt',
  'dist/checksums.json',
]) {
  check(existsSync(path.join(pluginRoot, required)), `required Codex plugin file missing: ${required}`);
}
check(existsSync(marketplacePath), '.agents/plugins/marketplace.json is missing');

const rootVersion = readJson(path.join(repoRoot, 'package.json')).version;
const cliVersion = readJson(path.join(repoRoot, 'packages', 'cli', 'package.json')).version;
const claudeManifest = readJson(path.join(claudeRoot, '.claude-plugin', 'plugin.json'));
const manifest = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
for (const field of ['name', 'version', 'description', 'author', 'license', 'skills', 'mcpServers']) {
  check(manifest[field] !== undefined, `plugin.json is missing ${field}`);
}
check(manifest.name === 'specbridge', `plugin name must be specbridge (got ${manifest.name})`);
check(manifest.version === rootVersion, `Codex plugin version ${manifest.version} != root ${rootVersion}`);
check(manifest.version === cliVersion, `Codex plugin version ${manifest.version} != CLI ${cliVersion}`);
check(
  manifest.version === claudeManifest.version,
  `Codex plugin version ${manifest.version} != Claude plugin ${claudeManifest.version}`,
);
check(manifest.skills === './skills/', 'plugin.json skills must be ./skills/');
check(manifest.mcpServers === './.mcp.json', 'plugin.json mcpServers must be ./.mcp.json');
for (const field of ['skills', 'mcpServers']) {
  const resolved = path.resolve(pluginRoot, manifest[field]);
  check(inside(pluginRoot, resolved), `plugin.json ${field} escapes the plugin root`);
  check(existsSync(resolved), `plugin.json ${field} target does not exist`);
}

const marketplace = readJson(marketplacePath);
check(marketplace.name === 'specbridge-local', 'marketplace name must be specbridge-local');
const marketplaceEntry = (marketplace.plugins ?? []).find((entry) => entry.name === 'specbridge');
check(marketplaceEntry !== undefined, 'marketplace must contain specbridge');
if (marketplaceEntry !== undefined) {
  check(marketplaceEntry.source?.source === 'local', 'marketplace source must be local');
  const resolvedSource = path.resolve(codexIntegrationRoot, marketplaceEntry.source?.path ?? '');
  check(resolvedSource === pluginRoot, `marketplace source does not resolve to plugin root: ${resolvedSource}`);
  check(marketplaceEntry.policy?.installation === 'AVAILABLE', 'install policy must be AVAILABLE');
  check(marketplaceEntry.policy?.authentication === 'ON_USE', 'auth policy must be ON_USE');
}

const mcp = readJson(path.join(pluginRoot, '.mcp.json'));
const server = mcp.mcpServers?.specbridge;
check(server !== undefined, '.mcp.json must define mcpServers.specbridge');
if (server !== undefined) {
  check(server.command === 'node', 'Codex MCP command must be node');
  check(
    Array.isArray(server.args) &&
      server.args.length === 2 &&
      server.args[0] === '-e' &&
      server.args[1].includes('SPECBRIDGE_PLUGIN_CACHE_ROOT') &&
      server.args[1].includes('process._eval') &&
      server.args[1].includes("manifest.name==='specbridge'") &&
      server.args[1].includes('installed.birthtimeMs') &&
      server.args[1].includes('b.installedAt-a.installedAt') &&
      server.args[1].includes("readFileSync(file,'utf8')") &&
      server.args[1].includes('loaded._compile(') &&
      !server.args.some((arg) => arg.includes('${PLUGIN_ROOT}')),
    'Codex MCP must locate its matching installed cache entry and memory-load the launcher without placeholder or Node realpath walks',
  );
  check(server.cwd === undefined, 'Codex MCP config must not force cwd to the plugin cache');
  check(server.env === undefined, 'Codex MCP config must not inject environment values');
}

const claudeSkillsDir = path.join(claudeRoot, 'skills');
const codexSkillsDir = path.join(pluginRoot, 'skills');
const skillDirs = (root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
const claudeSkills = skillDirs(claudeSkillsDir);
const codexSkills = skillDirs(codexSkillsDir);
check(
  JSON.stringify(codexSkills) === JSON.stringify(claudeSkills),
  `skill parity failed: Claude [${claudeSkills.join(', ')}], Codex [${codexSkills.join(', ')}]`,
);

for (const skill of codexSkills) {
  const markdown = readFileSync(path.join(codexSkillsDir, skill, 'SKILL.md'), 'utf8');
  const end = markdown.indexOf('\n---', 4);
  check(markdown.startsWith('---\n') && end > 0, `${skill}: invalid SKILL.md frontmatter`);
  const block = end > 0 ? markdown.slice(4, end) : '';
  const keys = [...block.matchAll(/^([A-Za-z-]+):/gm)].map((match) => match[1]);
  check(keys.includes('name') && keys.includes('description'), `${skill}: name/description required`);
  check(keys.every((key) => key === 'name' || key === 'description'), `${skill}: unsupported Codex frontmatter key`);
  check(new RegExp(`^name:\\s*${skill}$`, 'm').test(block), `${skill}: frontmatter name mismatch`);
  check(/^description:\s*"?.{20}/m.test(block), `${skill}: description is missing or too short`);
  for (const forbidden of [
    'CLAUDE_PLUGIN_ROOT',
    '/specbridge:',
    'disable-model-invocation',
    'allowed-tools',
    'dangerously-skip-permissions',
    'bypassPermissions',
  ]) {
    check(!markdown.includes(forbidden), `${skill}: contains Claude/unsafe residue ${forbidden}`);
  }
}

const approve = readFileSync(path.join(codexSkillsDir, 'approve', 'SKILL.md'), 'utf8');
const build = readFileSync(path.join(codexSkillsDir, 'build', 'SKILL.md'), 'utf8');
for (const markdown of [approve, build]) {
  check(markdown.includes('specbridge spec approve'), 'approval guidance must show the human CLI command');
  check(!markdown.includes('spec_intake_approve'), 'no skill may reference spec_intake_approve');
}
check(/never (execute|run)/i.test(approve), 'approve skill must forbid Codex from executing approval');
check(build.includes('You cannot run it, and no MCP tool can.'), 'build skill must preserve the human-only boundary');

const descriptions = Object.fromEntries(
  codexSkills.map((skill) => [
    skill,
    readFileSync(path.join(codexSkillsDir, skill, 'SKILL.md'), 'utf8').split('\n').slice(0, 4).join('\n'),
  ]),
);
for (const [skill, phrase] of [
  ['spec-draft', '把我们刚才聊的写成 spec'],
  ['build', '开始 build 这个 spec'],
  ['status', '现在跑到哪里了？'],
  ['continue', '继续刚才那个被中断的任务'],
  ['doctor', '检查一下 SpecBridge 环境有没有问题'],
]) {
  check(descriptions[skill]?.includes(phrase), `${skill}: missing natural-language trigger ${phrase}`);
}

const checksums = readJson(path.join(pluginRoot, 'dist', 'checksums.json'));
check(checksums.version === rootVersion, 'Codex checksum version must match root version');
for (const [name, expected] of Object.entries(checksums.files ?? {})) {
  const filePath = path.join(pluginRoot, 'dist', name);
  check(existsSync(filePath), `checksummed file missing: ${name}`);
  if (!existsSync(filePath)) continue;
  const data = readFileSync(filePath);
  check(data.length === expected.bytes, `${name}: checksum byte length mismatch`);
  check(
    createHash('sha256').update(data).digest('hex') === expected.sha256,
    `${name}: checksum mismatch`,
  );
}
for (const shared of ['cli.cjs', 'mcp-server.cjs']) {
  const codexData = readFileSync(path.join(pluginRoot, 'dist', shared));
  const claudeData = readFileSync(path.join(claudeRoot, 'dist', shared));
  check(codexData.equals(claudeData), `${shared}: Codex and Claude runtime bundles diverged`);
}

function runCodex(args, options) {
  return spawnSync('codex', args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
}

const codexProbe = spawnSync('codex', ['--version'], {
  encoding: 'utf8',
  windowsHide: true,
  shell: false,
});
if (codexProbe.status === 0) {
  const validationRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-codex-validation-'));
  const codexHome = path.join(validationRoot, 'codex-home');
  const projectRoot = path.join(validationRoot, 'project with spaces');
  mkdirSync(path.join(projectRoot, '.specbridge'), { recursive: true });
  const runnerConfigPath = path.join(projectRoot, '.specbridge', 'config.json');
  const runnerConfig = `${JSON.stringify(
    { runnerProfiles: { 'codex-default': { runner: 'codex-cli', enabled: false } } },
    null,
    2,
  )}\n`;
  writeFileSync(runnerConfigPath, runnerConfig);
  mkdirSync(codexHome, { recursive: true });
  const env = { ...process.env, CODEX_HOME: codexHome };
  try {
    const addMarketplace = runCodex(
      ['plugin', 'marketplace', 'add', codexIntegrationRoot, '--json'],
      { cwd: projectRoot, env },
    );
    check(addMarketplace.status === 0, `Codex marketplace add failed: ${addMarketplace.stderr.trim()}`);
    const available = runCodex(
      ['plugin', 'list', '--marketplace', 'specbridge-local', '--available', '--json'],
      { cwd: projectRoot, env },
    );
    check(available.status === 0 && available.stdout.includes('specbridge@specbridge-local'), 'Codex did not discover the marketplace plugin');
    const install = runCodex(
      ['plugin', 'add', 'specbridge@specbridge-local', '--json'],
      { cwd: projectRoot, env },
    );
    check(install.status === 0, `Codex plugin install failed: ${install.stderr.trim()}`);
    let installedPath;
    try {
      installedPath = JSON.parse(install.stdout).installedPath;
    } catch {
      fail('Codex plugin install returned invalid JSON');
    }
    if (typeof installedPath === 'string') {
      check(existsSync(path.join(installedPath, 'dist', 'mcp-launcher.cjs')), 'installed plugin is missing its MCP launcher');
    }
    const mcpList = runCodex(['mcp', 'list'], { cwd: projectRoot, env });
    check(
      mcpList.status === 0 && mcpList.stdout.includes('specbridge') && mcpList.stdout.includes('mcp-launcher.cjs'),
      'installed plugin did not register its MCP overlay',
    );
    const removePlugin = runCodex(
      ['plugin', 'remove', 'specbridge@specbridge-local', '--json'],
      { cwd: projectRoot, env },
    );
    check(removePlugin.status === 0, `Codex plugin remove failed: ${removePlugin.stderr.trim()}`);
    const removeMarketplace = runCodex(
      ['plugin', 'marketplace', 'remove', 'specbridge-local', '--json'],
      { cwd: projectRoot, env },
    );
    check(removeMarketplace.status === 0, `Codex marketplace remove failed: ${removeMarketplace.stderr.trim()}`);
    check(
      readFileSync(runnerConfigPath, 'utf8') === runnerConfig,
      'Codex frontend install/remove mutated SpecBridge runner configuration',
    );
    notes.push(`validated with ${codexProbe.stdout.trim()}`);
  } finally {
    rmSync(validationRoot, { recursive: true, force: true });
  }
} else {
  notes.push('Codex CLI unavailable; current-CLI install validation skipped');
}

if (failures.length > 0) {
  console.error(`validate-codex-plugin: ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(
  `validate-codex-plugin: OK — manifest, marketplace, ${codexSkills.length} skills, MCP overlay, ` +
    `shared bundles, checksums, authority, natural-language contracts. ${notes.join('; ')}.`,
);
