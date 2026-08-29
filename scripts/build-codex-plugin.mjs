/**
 * Deterministic SpecBridge Codex plugin assembly.
 *
 * The Claude Code skills are the canonical behavioral source. This script
 * derives the Codex skills with a small, reviewed host adapter, then copies
 * the exact same CLI/MCP runtime bundles into the Codex plugin. `--check`
 * performs the same derivation in memory and fails on drift without writing.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkOnly = process.argv.includes('--check');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const claudeRoot = path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge');
const codexIntegrationRoot = path.join(repoRoot, 'integrations', 'codex-plugin');
const codexRoot = path.join(codexIntegrationRoot, 'specbridge');
const sourceRoot = path.join(codexIntegrationRoot, 'src');
const rootVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

const failures = [];
const expectedFiles = new Map();

function normalizedText(value) {
  return value.replace(/\r\n?/g, '\n');
}

function text(relativePath, value) {
  expectedFiles.set(relativePath, Buffer.from(normalizedText(value), 'utf8'));
}

function binary(relativePath, sourcePath) {
  if (!existsSync(sourcePath)) {
    throw new Error(`Required Codex plugin input is missing: ${path.relative(repoRoot, sourcePath)}`);
  }
  expectedFiles.set(relativePath, readFileSync(sourcePath));
}

function frontmatter(markdown, skill) {
  if (!markdown.startsWith('---\n')) throw new Error(`${skill}: canonical SKILL.md has no frontmatter`);
  const end = markdown.indexOf('\n---', 4);
  if (end < 0) throw new Error(`${skill}: canonical SKILL.md frontmatter is not closed`);
  const block = markdown.slice(4, end);
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (name === undefined || description === undefined) {
    throw new Error(`${skill}: canonical SKILL.md requires name and description`);
  }
  return { name, description, body: markdown.slice(end + 4).replace(/^\n/, '') };
}

const DESCRIPTION_ADDITIONS = {
  build:
    ' Natural-language triggers include "开始 build 这个 spec", "開始這個 spec 的 intake", and requests to submit a complete feature specification.',
  continue:
    ' Natural-language triggers include "继续刚才那个被中断的任务" and "繼續剛才被中斷的工作".',
  doctor:
    ' Natural-language triggers include "检查一下 SpecBridge 环境有没有问题" and "檢查 SpecBridge 設定".',
  'spec-draft':
    ' Natural-language triggers also include "把我们刚才聊的写成 spec" and "把剛才聊的整理成 spec".',
  status:
    ' Natural-language triggers include "现在跑到哪里了？", "現在跑到哪裡了？", and requests for job progress.',
};

function approvalSkill(description) {
  const codexDescription = description
    .replaceAll('/specbridge:', '$specbridge:')
    .replace(
      'This is an explicit human decision — only ever runs when the user invokes $specbridge:approve themselves.',
      'This is an explicit human decision. In Codex the skill only presents the terminal command for the user.',
    );
  return `---\nname: approve\ndescription: ${JSON.stringify(
    `${codexDescription} It never executes approval.`,
  )}\n---\n\n# SpecBridge approval guidance\n\nArguments: \`<spec-name> <stage>\`.\n\nApproval is a human authority boundary. Codex may inspect and explain the\ncurrent state, but it must never execute an approval command, infer approval\nfrom conversation, or claim approval happened. No SpecBridge MCP approval\ntool exists.\n\n1. Call \`spec_analyze\` for the named stage and \`spec_status\` for the\n   approval context. Show blocking errors, warnings, the current hash-bound\n   state, and which downstream stage the approval would unblock.\n2. If arguments are missing or the stage is not one of \`requirements\`,\n   \`bugfix\`, \`design\`, or \`tasks\`, ask the user; never guess.\n3. Present the exact command for the HUMAN to run in their own terminal and\n   STOP:\n\n   \`\`\`text\n   specbridge spec approve <spec-name> --stage <stage>\n   \`\`\`\n\n4. After the user reports running it, read \`spec_status\` again and report\n   the recorded state. Never treat their intent to approve as evidence that\n   the command succeeded.\n\nFor a converged Spec Intake, the separate final authorization is also\nhuman-only: \`specbridge spec approve <name> --build\`. Codex must never run\neither approval command, even when this skill was explicitly invoked as\n\`$specbridge:approve\`.\n`;
}

function adaptSkill(skill, markdown) {
  const parsed = frontmatter(normalizedText(markdown), skill);
  if (parsed.name !== skill) throw new Error(`${skill}: canonical name is ${parsed.name}`);
  if (skill === 'approve') return approvalSkill(parsed.description);

  let body = parsed.body
    .replaceAll('/specbridge:', '$specbridge:')
    .replaceAll('"${CLAUDE_PLUGIN_ROOT}/bin/specbridge"', 'specbridge')
    .replaceAll('no `claude -p`, no', 'no `codex exec`, no `claude -p`, no')
    .replaceAll('no\n`claude -p`, no', 'no\n`codex exec`, no `claude -p`, no');

  if (skill === 'doctor') {
    body = body
      .replace(
        'Report the plugin version (0.6.1) and the MCP server version from the tool\n   results where shown.',
        'Report the installed plugin version from its manifest and the MCP server\n   version from the tool results where shown; never hard-code either version.',
      )
      .replace(
        'suggest the bundled CLI check:\n   `specbridge mcp doctor` — but do not run it',
        'suggest the bundled CLI check:\n   `specbridge mcp doctor` — but do not run it',
      );
  }

  if (skill === 'orchestrate') {
    body = body
      .replace(
        'and Claude Code —\na SEPARATE, ephemeral worker invocation — for implementation and complex\nreasoning.',
        'and the explicitly configured execution runner (Claude Code, codex-cli, or\nanother compatible runner) — a SEPARATE, ephemeral worker invocation — for\nimplementation and complex reasoning.',
      )
      .replace(
        'The standalone orchestrator invoking the Claude Code runner is the\ndesigned path; this interactive session recursively spawning another Claude\nis the forbidden one.',
        'The standalone orchestrator invoking its explicitly configured runner is the\ndesigned path; this Codex frontend session recursively spawning another coding\nagent is the forbidden one.',
      )
      .replace(
        '`runner_doctor`\n   (Claude Code available?)',
        '`runner_doctor`\n   (the explicitly configured execution runner available?)',
      )
      .replace(
        'reasoning escalates to\n   Claude and costs more',
        'reasoning escalates to\n   the configured subscription runner and may cost more',
      )
      .replace(
        'why the local\nmodel or Claude was used',
        'why the local\nmodel or configured runner was used',
      );
  }

  const description = `${parsed.description}${DESCRIPTION_ADDITIONS[skill] ?? ''}`;
  return `---\nname: ${skill}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
}

const claudeSkillsDir = path.join(claudeRoot, 'skills');
const skillNames = readdirSync(claudeSkillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const skill of skillNames) {
  const source = path.join(claudeSkillsDir, skill, 'SKILL.md');
  text(path.join('skills', skill, 'SKILL.md'), adaptSkill(skill, readFileSync(source, 'utf8')));
}

for (const relativePath of ['LICENSE', 'NOTICE.md', 'bin/specbridge', 'bin/specbridge.cmd']) {
  binary(relativePath, path.join(claudeRoot, relativePath));
}
for (const file of ['cli.cjs', 'mcp-server.cjs']) {
  binary(path.join('dist', file), path.join(claudeRoot, 'dist', file));
}
const thirdPartyLicenses = normalizedText(
  readFileSync(path.join(claudeRoot, 'dist', 'THIRD_PARTY_LICENSES.txt'), 'utf8'),
)
  .split('\n')
  .map((line) => line.trimEnd())
  .join('\n')
  .replace(/\n*$/, '\n');
text(path.join('dist', 'THIRD_PARTY_LICENSES.txt'), thirdPartyLicenses);
binary(
  path.join('dist', 'mcp-launcher.cjs'),
  path.join(sourceRoot, 'mcp-launcher.cjs'),
);

const manifestPath = path.join(codexRoot, '.codex-plugin', 'plugin.json');
if (!existsSync(manifestPath)) throw new Error('Codex plugin manifest is missing');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = rootVersion;
text(path.join('.codex-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const checksumFiles = [
  'cli.cjs',
  'mcp-launcher.cjs',
  'mcp-server.cjs',
  'THIRD_PARTY_LICENSES.txt',
].sort();
const checksumManifest = {
  schema: 'specbridge.codex-plugin-checksums/1',
  version: rootVersion,
  files: Object.fromEntries(
    checksumFiles.map((name) => {
      const data = expectedFiles.get(path.join('dist', name));
      if (data === undefined) throw new Error(`Missing expected checksum input: ${name}`);
      return [
        name,
        {
          sha256: createHash('sha256').update(data).digest('hex'),
          bytes: data.length,
        },
      ];
    }),
  ),
};
text(path.join('dist', 'checksums.json'), `${JSON.stringify(checksumManifest, null, 2)}\n`);

function compareOrWrite(relativePath, expected) {
  const destination = path.join(codexRoot, relativePath);
  if (checkOnly) {
    if (!existsSync(destination)) {
      failures.push(`missing generated file: ${relativePath}`);
      return;
    }
    const actual = readFileSync(destination);
    if (!actual.equals(expected)) failures.push(`generated file is stale: ${relativePath}`);
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, expected);
}

for (const [relativePath, expected] of [...expectedFiles.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  compareOrWrite(relativePath, expected);
}

const codexSkillsDir = path.join(codexRoot, 'skills');
if (existsSync(codexSkillsDir)) {
  const actualSkillDirs = readdirSync(codexSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const skill of actualSkillDirs) {
    if (skillNames.includes(skill)) continue;
    if (checkOnly) failures.push(`unexpected generated skill directory: skills/${skill}`);
    else rmSync(path.join(codexSkillsDir, skill), { recursive: true, force: true });
  }
}

const codexDistDir = path.join(codexRoot, 'dist');
if (existsSync(codexDistDir)) {
  const expectedDistFiles = new Set(
    [...expectedFiles.keys()]
      .filter((relativePath) => path.dirname(relativePath) === 'dist')
      .map((relativePath) => path.basename(relativePath)),
  );
  for (const entry of readdirSync(codexDistDir, { withFileTypes: true })) {
    if (entry.isFile() && expectedDistFiles.has(entry.name)) continue;
    const unexpectedPath = path.join('dist', entry.name);
    if (checkOnly) failures.push(`unexpected generated runtime artifact: ${unexpectedPath}`);
    else rmSync(path.join(codexDistDir, entry.name), { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`build-codex-plugin --check: ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

const runtimeBytes = checksumFiles.reduce(
  (sum, name) => sum + statSync(path.join(codexRoot, 'dist', name)).size,
  0,
);
console.log(
  `${checkOnly ? 'check' : 'build'}-codex-plugin: OK — ${skillNames.length} skills, ` +
    `${checksumFiles.length} runtime artifacts, ${runtimeBytes} bytes, version ${rootVersion}.`,
);
