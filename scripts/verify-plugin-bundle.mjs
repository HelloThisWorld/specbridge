/**
 * Isolated plugin bundle verification (`pnpm verify:plugin-bundle`).
 *
 * Proves the installed plugin is truly self-contained:
 *   1. copies the built plugin into an isolated temp directory whose path
 *      contains a space (the hardest real-world case),
 *   2. creates a fixture Kiro project OUTSIDE the monorepo,
 *   3. runs the bundled CLI (POSIX wrapper on POSIX, cmd wrapper syntax is
 *      validated statically) against the fixture,
 *   4. starts the bundled MCP server over stdio, performs a real protocol
 *      handshake with a minimal JSON-RPC client, lists tools, and invokes
 *      workspace_detect,
 *   5. confirms no monorepo path is required (the monorepo could be on
 *      another machine — only node and the copied plugin directory exist).
 *
 * No Claude Code, no network, no model.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSource = path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge');

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1. Isolated copy (path with a space, far from the monorepo).
const isolatedBase = mkdtempSync(path.join(os.tmpdir(), 'specbridge plugin '));
const pluginCopy = path.join(isolatedBase, 'specbridge');
cpSync(pluginSource, pluginCopy, { recursive: true });

// 2. Fixture Kiro project outside the monorepo.
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-fixture-'));
mkdirSync(path.join(fixtureRoot, '.kiro', 'steering'), { recursive: true });
mkdirSync(path.join(fixtureRoot, '.kiro', 'specs', 'sample-spec'), { recursive: true });
writeFileSync(path.join(fixtureRoot, '.kiro', 'steering', 'product.md'), '# Product\n\nA fixture.\n');
writeFileSync(
  path.join(fixtureRoot, '.kiro', 'specs', 'sample-spec', 'requirements.md'),
  '# Requirements Document\n\n## Introduction\n\nFixture spec.\n',
);
writeFileSync(
  path.join(fixtureRoot, '.kiro', 'specs', 'sample-spec', 'tasks.md'),
  '# Implementation Plan\n\n- [ ] 1. Do the thing\n',
);

const cliBundle = path.join(pluginCopy, 'dist', 'cli.cjs');
const serverBundle = path.join(pluginCopy, 'dist', 'mcp-server.cjs');

// 3. Bundled CLI runs from the isolated copy against the outside fixture.
try {
  const version = execFileSync(process.execPath, [cliBundle, '--version'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  }).trim();
  check('bundled CLI starts from an isolated path with spaces', /^\d+\.\d+\.\d+$/.test(version), version);
} catch (cause) {
  check('bundled CLI starts from an isolated path with spaces', false, String(cause));
}
try {
  const doctor = execFileSync(process.execPath, [cliBundle, 'spec', 'list'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  check('bundled CLI reads the fixture workspace', doctor.includes('sample-spec'));
} catch (cause) {
  check('bundled CLI reads the fixture workspace', false, String(cause));
}

// Built-in templates ship inside the bundle: list and preview must work in
// the isolated fixture with no monorepo and no network.
try {
  const list = execFileSync(process.execPath, [cliBundle, 'template', 'list', '--json'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const parsed = JSON.parse(list);
  const refs = (parsed.data?.templates ?? []).map((template) => template.ref);
  check(
    'isolated bundle lists the built-in template catalog',
    refs.includes('builtin:rest-api') && refs.length >= 10,
    refs.join(','),
  );
} catch (cause) {
  check('isolated bundle lists the built-in template catalog', false, String(cause));
}
try {
  const preview = execFileSync(
    process.execPath,
    [cliBundle, 'template', 'preview', 'rest-api', '--name', 'bundle-preview-check', '--json'],
    { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  );
  const parsed = JSON.parse(preview);
  const rendered = (parsed.data?.files ?? []).some(
    (file) => typeof file.content === 'string' && file.content.includes('# Requirements Document'),
  );
  const specsDir = path.join(fixtureRoot, '.kiro', 'specs', 'bundle-preview-check');
  check('isolated bundle previews a template without writing', rendered && !existsSync(specsDir));
} catch (cause) {
  check('isolated bundle previews a template without writing', false, String(cause));
}

// POSIX wrapper end-to-end where a POSIX shell exists.
if (process.platform !== 'win32') {
  try {
    execFileSync('chmod', ['+x', path.join(pluginCopy, 'bin', 'specbridge')]);
    const viaWrapper = execFileSync(path.join(pluginCopy, 'bin', 'specbridge'), ['--version'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    }).trim();
    check('POSIX wrapper forwards arguments and exit code', /^\d+\.\d+\.\d+$/.test(viaWrapper));
  } catch (cause) {
    check('POSIX wrapper forwards arguments and exit code', false, String(cause));
  }
} else {
  // On Windows, run the .cmd wrapper end-to-end instead (cmd.exe /c with
  // the wrapper path as one argv token handles spaces correctly).
  try {
    const viaCmd = execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', path.join(pluginCopy, 'bin', 'specbridge.cmd'), '--version'],
      { cwd: fixtureRoot, encoding: 'utf8', windowsVerbatimArguments: false },
    ).trim();
    check('Windows .cmd wrapper forwards arguments and exit code', /^\d+\.\d+\.\d+$/.test(viaCmd), viaCmd);
  } catch (cause) {
    check('Windows .cmd wrapper forwards arguments and exit code', false, String(cause));
  }
}

// 4. Bundled MCP server: real stdio handshake with a minimal JSON-RPC client.
async function verifyMcpServer() {
  const child = spawn(process.execPath, [serverBundle, '--stdio', '--project-root', fixtureRoot], {
    cwd: fixtureRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
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
  const waitFor = (id, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        for (const line of stdout.split('\n')) {
          if (line.trim().length === 0) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              resolve(parsed);
              return;
            }
          } catch {
            reject(new Error(`non-JSON on stdout: ${line.slice(0, 200)}`));
            return;
          }
        }
        if (Date.now() - startedAt > timeoutMs) reject(new Error(`timeout waiting for response ${id}`));
        else setTimeout(poll, 50);
      };
      poll();
    });

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'bundle-verifier', version: '0.0.0' },
      },
    });
    const initialized = await waitFor(1);
    check(
      'isolated MCP handshake succeeds',
      initialized.result?.serverInfo?.name === 'specbridge',
      JSON.stringify(initialized.result?.serverInfo),
    );
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = await waitFor(2);
    const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name);
    check('isolated server lists the tool registry', toolNames.includes('workspace_detect') && toolNames.includes('task_begin'), toolNames.join(','));
    check(
      'isolated server exposes the template tools',
      ['template_list', 'template_search', 'template_show', 'template_preview', 'template_apply'].every((name) =>
        toolNames.includes(name),
      ),
      toolNames.filter((name) => name.startsWith('template_')).join(','),
    );

    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'workspace_detect', arguments: {} },
    });
    const detect = await waitFor(3);
    const structured = detect.result?.structuredContent;
    check(
      'isolated workspace_detect finds the fixture workspace',
      structured?.found === true && structured?.specCount === 1,
      JSON.stringify(structured)?.slice(0, 200),
    );

    // 5. Every stdout line was protocol JSON; monorepo paths never appear.
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
    check(
      'isolated server stdout is pure protocol framing',
      lines.every((line) => {
        try {
          return JSON.parse(line).jsonrpc === '2.0';
        } catch {
          return false;
        }
      }),
    );
    const repoRootLower = repoRoot.toLowerCase().split(path.sep).join('/');
    const combined = (stdout + stderr).toLowerCase().split('\\').join('/');
    check('isolated run references no monorepo path', !combined.includes(repoRootLower));
  } finally {
    child.kill();
  }
}

await verifyMcpServer();

console.log(failures === 0 ? `verify-plugin-bundle: all ${checks} checks passed` : `verify-plugin-bundle: ${failures}/${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
