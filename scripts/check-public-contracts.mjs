#!/usr/bin/env node
/**
 * Public-contract snapshot generation and drift check (v1.0.0).
 *
 * Usage:
 *   node scripts/check-public-contracts.mjs            # (re)generate contracts/*.json
 *   node scripts/check-public-contracts.mjs --check    # fail when snapshots drift (CI)
 *
 * Snapshots freeze the STABLE public surface: CLI command tree and options,
 * exit codes, JSON report envelope IDs, persisted schema versions,
 * verification rule IDs, runner contract vocabulary, template and extension
 * contracts, MCP tool/resource/prompt names, Claude Code Skill names, and
 * GitHub Action inputs/outputs. Private implementation details are not
 * snapshotted.
 *
 * A drift failure means a stable contract changed. If the change is
 * intentional: regenerate the snapshots, review the diff, and add a
 * CHANGELOG entry describing the contract change (see
 * docs/stability/versioning-policy.md for what is allowed in 1.x).
 *
 * Requires a build (`pnpm build`): values are read from each package's dist
 * so the snapshot reflects what actually ships.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_DIR = path.join(ROOT, 'contracts');
const CHECK = process.argv.includes('--check');

function fail(message) {
  console.error(`check-public-contracts: ${message}`);
  process.exit(1);
}

async function importDist(pkg) {
  const distPath = path.join(ROOT, 'packages', pkg, 'dist', 'index.js');
  if (!existsSync(distPath)) {
    fail(`packages/${pkg}/dist/index.js is missing — run "pnpm build" first.`);
  }
  return import(pathToFileURL(distPath).href);
}

/** Stable stringify: sorted object keys at every level, 2-space indent. */
function stableStringify(value) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted(v[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// CLI command tree — walked through the built CLI's --help output so the
// snapshot reflects the shipped surface, not internal structure.
// ---------------------------------------------------------------------------

const CLI_ENTRY = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');

function cliHelp(commandPath) {
  try {
    return execFileSync(process.execPath, [CLI_ENTRY, ...commandPath, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (cause) {
    fail(
      `"specbridge ${commandPath.join(' ')} --help" failed — ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

function parseHelp(text) {
  const lines = text.split(/\r?\n/);
  const commands = [];
  const options = [];
  let section = null;
  for (const line of lines) {
    if (/^Commands:/.test(line)) { section = 'commands'; continue; }
    if (/^Options:/.test(line)) { section = 'options'; continue; }
    if (/^\S/.test(line) && line.trim() !== '') { section = null; continue; }
    // Entries sit at exactly two spaces of indent; deeper indentation is a
    // wrapped description continuation and must never be parsed as an entry.
    const entry = /^ {2}(?! )(\S.*)$/.exec(line);
    if (entry === null) continue;
    if (section === 'commands') {
      const match = /^([a-z][a-z0-9-]*)/.exec(entry[1]);
      if (match && match[1] !== 'help') commands.push(match[1]);
    } else if (section === 'options' && entry[1].startsWith('-')) {
      for (const long of entry[1].match(/--[a-z][a-z0-9-]*/g) ?? []) {
        if (!options.includes(long)) options.push(long);
      }
    }
  }
  return { commands: [...new Set(commands)], options: options.sort() };
}

function walkCli(commandPath = []) {
  const parsed = parseHelp(cliHelp(commandPath));
  const node = { options: parsed.options };
  if (parsed.commands.length > 0) {
    node.subcommands = {};
    for (const name of parsed.commands.sort()) {
      node.subcommands[name] = walkCli([...commandPath, name]);
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Source-derived values
// ---------------------------------------------------------------------------

function reportIdsFromCliSource() {
  const ids = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts')) {
        for (const match of readFileSync(p, 'utf8').matchAll(/createJsonReport\(\s*'([^']+)'/g)) {
          ids.add(match[1]);
        }
      }
    }
  };
  walk(path.join(ROOT, 'packages', 'cli', 'src'));
  return [...ids].sort();
}

function actionInterface() {
  const raw = readFileSync(path.join(ROOT, 'integrations', 'github-action', 'action.yml'), 'utf8');
  const section = (name) => {
    const match = new RegExp(`^${name}:\\r?\\n((?:(?:  .*|\\s*)\\r?\\n?)*)`, 'm').exec(raw);
    if (!match) return [];
    const keys = [];
    for (const line of match[1].split(/\r?\n/)) {
      const key = /^ {2}([a-z][a-z0-9-]*):/.exec(line);
      if (key) keys.push(key[1]);
      else if (/^[a-z]/i.test(line)) break;
    }
    return keys.sort();
  };
  return { inputs: section('inputs'), outputs: section('outputs') };
}

function skillNames() {
  const skillsDir = path.join(ROOT, 'integrations', 'claude-code-plugin', 'specbridge', 'skills');
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

async function buildSnapshots() {
  const core = await importDist('core');
  const drift = await importDist('drift');
  const runners = await importDist('runners');
  const templates = await importDist('templates');
  const extensionSdk = await importDist('extension-sdk');
  const extensions = await importDist('extensions');
  const registry = await importDist('registry');
  const evidence = await importDist('evidence');
  const execution = await importDist('execution');
  const mcp = await importDist('mcp-server');

  const snapshots = {
    'cli-commands.json': {
      bin: 'specbridge',
      tree: walkCli(),
    },
    'exit-codes.json': core.EXIT_CODES,
    'report-ids.json': { jsonReportIds: reportIdsFromCliSource() },
    'schema-versions.json': {
      specState: core.SPEC_STATE_SCHEMA_VERSION,
      runnerConfig: core.RUNNER_CONFIG_SCHEMA_VERSION,
      agentConfigV1: core.AGENT_CONFIG_SCHEMA_VERSION,
      runnerOutput: core.RUNNER_OUTPUT_SCHEMA_VERSION,
      verificationReport: core.VERIFICATION_REPORT_SCHEMA_VERSION,
      verificationDiagnostic: core.VERIFICATION_DIAGNOSTIC_SCHEMA_VERSION,
      migrationPlan: core.MIGRATION_PLAN_SCHEMA_VERSION,
      recoveryPlan: core.RECOVERY_PLAN_SCHEMA_VERSION,
      verificationPolicy: drift.VERIFICATION_POLICY_SCHEMA_VERSION,
      evidence: evidence.EVIDENCE_SCHEMA_VERSION,
      gitSnapshot: evidence.GIT_SNAPSHOT_SCHEMA_VERSION,
      runRecord: execution.RUN_RECORD_SCHEMA_VERSION,
      attemptRecord: execution.ATTEMPT_RECORD_SCHEMA_VERSION,
      interactiveLock: execution.INTERACTIVE_LOCK_SCHEMA_VERSION,
      templateManifest: templates.TEMPLATE_MANIFEST_SCHEMA_VERSION,
      templateRecord: templates.TEMPLATE_RECORD_SCHEMA_VERSION,
      extensionState: extensions.EXTENSION_STATE_SCHEMA_VERSION,
      extensionManifest: extensionSdk.EXTENSION_MANIFEST_SCHEMA_VERSION,
      extensionChecksums: extensionSdk.EXTENSION_CHECKSUMS_SCHEMA_VERSION,
      extensionProtocol: extensionSdk.EXTENSION_PROTOCOL_VERSION,
      registries: registry.REGISTRIES_SCHEMA_VERSION,
      registryIndex: registry.REGISTRY_INDEX_SCHEMA_VERSION,
      registryCache: registry.REGISTRY_CACHE_SCHEMA_VERSION,
    },
    'verification-rules.json': {
      idPattern: 'SBV\\d{3}',
      ruleIds: drift
        .builtInVerificationRules()
        .map((rule) => rule.id)
        .sort(),
    },
    'runner-contract.json': {
      operations: [...runners.RUNNER_OPERATIONS].sort(),
      capabilityKeys: [...runners.RUNNER_CAPABILITY_KEYS].sort(),
      categories: [...runners.RUNNER_CATEGORIES].sort(),
      supportLevels: [...runners.RUNNER_SUPPORT_LEVELS].sort(),
      errorCodes: [...runners.RUNNER_ERROR_CODES].sort(),
      runnerKinds: [...core.AGENT_RUNNER_KINDS].sort(),
      executionOutcomes: [...core.EXECUTION_OUTCOMES].sort(),
      evidenceStatuses: [...core.EVIDENCE_STATUS_VALUES].sort(),
    },
    'template-contract.json': {
      manifestFileName: templates.TEMPLATE_MANIFEST_FILE_NAME,
      recordTypes: [...templates.TEMPLATE_RECORD_TYPES].sort(),
      builtinTemplateIds: templates.BUILTIN_TEMPLATE_PACKS.map((pack) => pack.id).sort(),
    },
    'extension-contract.json': {
      manifestFileName: extensionSdk.EXTENSION_MANIFEST_FILE_NAME,
      kinds: [...extensionSdk.EXTENSION_KINDS].sort(),
      protocolMethods: [...extensionSdk.EXTENSION_PROTOCOL_METHODS].sort(),
      permissionFlags: [...extensionSdk.EXTENSION_PERMISSION_FLAGS].sort(),
      archiveSuffix: extensions.EXTENSION_ARCHIVE_SUFFIX,
    },
    'mcp-contract.json': {
      serverName: mcp.MCP_SERVER_NAME,
      tools: mcp.TOOL_CATALOG.map((tool) => tool.name).sort(),
      resources: mcp.RESOURCE_CATALOG.map((resource) => resource.uri).sort(),
      prompts: mcp.PROMPT_CATALOG.map((prompt) => prompt.name).sort(),
    },
    'plugin-skills.json': { skills: skillNames() },
    'github-action.json': actionInterface(),
  };
  return snapshots;
}

function diffKeys(expectedRaw, actualRaw) {
  // Line-level summary that is enough to locate the drift in a review.
  const expected = expectedRaw.split('\n');
  const actual = actualRaw.split('\n');
  const notes = [];
  for (const line of actual) {
    if (!expected.includes(line) && line.trim() !== '') notes.push(`+ ${line.trim()}`);
  }
  for (const line of expected) {
    if (!actual.includes(line) && line.trim() !== '') notes.push(`- ${line.trim()}`);
  }
  return notes.slice(0, 20);
}

const snapshots = await buildSnapshots();

if (!CHECK) {
  mkdirSync(CONTRACTS_DIR, { recursive: true });
  for (const [name, value] of Object.entries(snapshots)) {
    writeFileSync(path.join(CONTRACTS_DIR, name), stableStringify(value));
    console.log(`wrote contracts/${name}`);
  }
  console.log(`check-public-contracts: generated ${Object.keys(snapshots).length} snapshot files.`);
  process.exit(0);
}

let drifted = 0;
for (const [name, value] of Object.entries(snapshots)) {
  const file = path.join(CONTRACTS_DIR, name);
  if (!existsSync(file)) {
    console.error(`✗ contracts/${name} is missing — run "pnpm generate:public-contracts".`);
    drifted += 1;
    continue;
  }
  const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const actual = stableStringify(value);
  if (expected !== actual) {
    drifted += 1;
    console.error(`✗ contracts/${name} drifted from the current build:`);
    for (const note of diffKeys(expected, actual)) console.error(`    ${note}`);
  } else {
    console.log(`ok    contracts/${name}`);
  }
}

if (drifted > 0) {
  console.error(
    `\ncheck-public-contracts: ${drifted} snapshot(s) drifted. A stable public contract changed.\n` +
      'If intentional: run "pnpm generate:public-contracts", review the diff against\n' +
      'docs/stability/versioning-policy.md, and add a CHANGELOG entry. Otherwise revert the change.',
  );
  process.exit(1);
}
console.log('check-public-contracts: all snapshots match.');
