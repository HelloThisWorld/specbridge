/**
 * Process-level verification of the installed-shape Codex plugin bundle.
 *
 * No Codex model request, network access, or user config is involved. The
 * plugin is copied to a path containing spaces and its real launcher starts
 * the bundled shared MCP server against an outside fixture workspace.
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSource = path.join(repoRoot, 'integrations', 'codex-plugin', 'specbridge');
let checks = 0;
let failures = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail.length > 0 ? ` — ${detail}` : ''}`);
  }
}

function waitForExit(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('process did not exit in time'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function startMcp(launcher, options) {
  const child = spawn(process.execPath, [launcher], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        const segments = stdout.split('\n');
        const complete = stdout.endsWith('\n') ? segments : segments.slice(0, -1);
        for (const line of complete) {
          if (line.trim().length === 0) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              resolve(parsed);
              return;
            }
          } catch {
            reject(new Error(`non-JSON stdout line: ${line.slice(0, 200)}`));
            return;
          }
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`timeout waiting for MCP response ${id}; stderr=${stderr.slice(0, 500)}`));
        } else {
          setTimeout(poll, 40);
        }
      };
      poll();
    });
  return {
    child,
    send,
    waitFor,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function initialize(session) {
  session.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'codex-plugin-bundle-verifier', version: '0.0.0' },
    },
  });
  const response = await session.waitFor(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return response;
}

async function closeSession(session) {
  session.child.stdin.end();
  return waitForExit(session.child);
}

const isolatedBase = mkdtempSync(path.join(os.tmpdir(), 'specbridge codex plugin '));
const pluginCopy = path.join(isolatedBase, 'installed plugin');
const projectRoot = path.join(isolatedBase, 'project with spaces');
const nestedCwd = path.join(projectRoot, 'src', 'nested', 'working-dir');
cpSync(pluginSource, pluginCopy, { recursive: true });
mkdirSync(path.join(projectRoot, '.kiro', 'steering'), { recursive: true });
mkdirSync(path.join(projectRoot, '.kiro', 'specs', 'sample-spec'), { recursive: true });
mkdirSync(nestedCwd, { recursive: true });
mkdirSync(path.join(projectRoot, '.specbridge'), { recursive: true });
writeFileSync(path.join(projectRoot, '.kiro', 'steering', 'product.md'), '# Product\n\nA fixture.\n');
writeFileSync(
  path.join(projectRoot, '.kiro', 'specs', 'sample-spec', 'requirements.md'),
  '# Requirements Document\n\n## Introduction\n\nFixture spec.\n',
);
writeFileSync(
  path.join(projectRoot, '.kiro', 'specs', 'sample-spec', 'tasks.md'),
  '# Implementation Plan\n\n- [ ] 1. Do the thing\n',
);
const configPath = path.join(projectRoot, '.specbridge', 'config.json');
const originalConfig = '{}\n';
writeFileSync(configPath, originalConfig);

const launcher = path.join(pluginCopy, 'dist', 'mcp-launcher.cjs');
const canonicalProjectRoot = path.resolve(projectRoot);

try {
  check('installed-shape launcher exists', existsSync(launcher));
  check(
    'Codex and Claude CLI bundles are byte-identical',
    readFileSync(path.join(pluginCopy, 'dist', 'cli.cjs')).equals(
      readFileSync(path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge', 'dist', 'cli.cjs')),
    ),
  );
  check(
    'Codex and Claude MCP bundles are byte-identical',
    readFileSync(path.join(pluginCopy, 'dist', 'mcp-server.cjs')).equals(
      readFileSync(path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge', 'dist', 'mcp-server.cjs')),
    ),
  );

  const session = startMcp(launcher, { cwd: nestedCwd });
  const initialized = await initialize(session);
  check(
    'launcher starts the shared MCP bundle from a nested path containing spaces',
    initialized.result?.serverInfo?.name === 'specbridge',
    JSON.stringify(initialized.result?.serverInfo),
  );

  session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await session.waitFor(2);
  const toolNames = (listed.result?.tools ?? []).map((tool) => tool.name);
  check(
    'full SpecBridge MCP contract is present',
    [
      'workspace_detect',
      'workspace_bootstrap',
      'spec_intake_start',
      'spec_intake_answer',
      'job_read',
      'task_begin',
      'runner_doctor',
    ].every((name) => toolNames.includes(name)),
    `${toolNames.length} tools`,
  );
  check(
    'MCP catalog contains no approval-shaped tool',
    !toolNames.some((name) => name === 'spec_intake_approve' || /(^|_)approve($|_)/.test(name)),
    toolNames.filter((name) => name.includes('approve')).join(',') || '(none)',
  );

  session.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'workspace_detect', arguments: {} },
  });
  const detected = await session.waitFor(3);
  const detection = detected.result?.structuredContent;
  check(
    'nested working directory resolves to the actual project root',
    detection?.found === true &&
      path.resolve(detection.projectRoot) === canonicalProjectRoot &&
      detection.specCount === 1,
    JSON.stringify(detection)?.slice(0, 300),
  );

  session.send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'workspace_bootstrap', arguments: {} },
  });
  const bootstrapped = await session.waitFor(4, 60_000);
  check(
    'representative SpecBridge state write succeeds through MCP',
    bootstrapped.result?.isError !== true &&
      existsSync(path.join(projectRoot, '.specbridge', 'bootstrap', 'current-system-snapshot.json')),
    JSON.stringify(bootstrapped.result)?.slice(0, 300),
  );
  check(
    'MCP state write does not mutate runner configuration',
    readFileSync(configPath, 'utf8') === originalConfig,
  );

  const closed = await closeSession(session);
  check('stdio close shuts down launcher and server cleanly', closed.code === 0, JSON.stringify(closed));
  const protocolLines = session
    .stdout()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  check(
    'launcher/server stdout contains protocol JSON only',
    protocolLines.length > 0 &&
      protocolLines.every((line) => {
        try {
          return JSON.parse(line).jsonrpc === '2.0';
        } catch {
          return false;
        }
      }),
  );
  const normalizedOutput = `${session.stdout()}\n${session.stderr()}`.replaceAll('\\', '/').toLowerCase();
  check(
    'isolated runtime references no monorepo path',
    !normalizedOutput.includes(repoRoot.replaceAll('\\', '/').toLowerCase()),
  );

  const overrideSession = startMcp(launcher, {
    cwd: pluginCopy,
    env: { SPECBRIDGE_PROJECT_ROOT: projectRoot, PWD: pluginCopy },
  });
  await initialize(overrideSession);
  overrideSession.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'workspace_detect', arguments: {} },
  });
  const overrideDetect = await overrideSession.waitFor(2);
  check(
    'explicit project override prevents plugin-cache root capture',
    path.resolve(overrideDetect.result?.structuredContent?.projectRoot ?? '') === canonicalProjectRoot,
    JSON.stringify(overrideDetect.result?.structuredContent)?.slice(0, 300),
  );
  await closeSession(overrideSession);

  const gitProjectRoot = path.join(isolatedBase, 'git-project');
  const gitNestedCwd = path.join(gitProjectRoot, 'src', 'nested');
  mkdirSync(path.join(gitProjectRoot, '.git'), { recursive: true });
  mkdirSync(gitNestedCwd, { recursive: true });
  const gitSession = startMcp(launcher, { cwd: gitNestedCwd });
  await initialize(gitSession);
  gitSession.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'workspace_detect', arguments: {} },
  });
  const gitDetect = await gitSession.waitFor(2);
  check(
    'a nested simple path resolves to its Git project root before SpecBridge is initialized',
    path.resolve(gitDetect.result?.structuredContent?.projectRoot ?? '') ===
      path.resolve(gitProjectRoot),
    JSON.stringify(gitDetect.result?.structuredContent)?.slice(0, 300),
  );
  await closeSession(gitSession);

  const brokenPlugin = path.join(isolatedBase, 'broken plugin');
  mkdirSync(path.join(brokenPlugin, 'dist'), { recursive: true });
  cpSync(launcher, path.join(brokenPlugin, 'dist', 'mcp-launcher.cjs'));
  const broken = startMcp(path.join(brokenPlugin, 'dist', 'mcp-launcher.cjs'), { cwd: projectRoot });
  const brokenExit = await waitForExit(broken.child);
  check(
    'missing MCP bundle fails usefully on stderr and keeps stdout clean',
    brokenExit.code === 1 && broken.stdout() === '' && broken.stderr().includes('bundle_missing'),
    broken.stderr().slice(0, 300),
  );
} finally {
  rmSync(isolatedBase, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `verify-codex-plugin-bundle: all ${checks} checks passed`
    : `verify-codex-plugin-bundle: ${failures}/${checks} checks FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
