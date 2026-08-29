/*
 * Codex plugin MCP launcher.
 *
 * Codex expands ${PLUGIN_ROOT} to locate this file, while the child process
 * inherits the active task's working directory. This launcher keeps those
 * two roots separate: it resolves the user's project, then starts the shared
 * SpecBridge MCP bundle with an argv array and inherited stdio. No shell is
 * involved, so Windows paths and paths containing spaces stay intact.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, process */
'use strict';

const { existsSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pluginRoot = path.resolve(__dirname, '..');
const serverBundle = path.join(__dirname, 'mcp-server.cjs');

function diagnostic(event, message, detail) {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event,
      message,
      ...(detail === undefined ? {} : { detail }),
    })}\n`,
  );
}

function canonicalDirectory(candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0 || candidate.includes('\0')) {
    return undefined;
  }
  try {
    const canonical = realpathSync(path.resolve(candidate));
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function nearestProjectMarker(start) {
  let current = start;
  for (;;) {
    if (
      existsSync(path.join(current, '.kiro')) ||
      existsSync(path.join(current, '.specbridge')) ||
      existsSync(path.join(current, '.git'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveProjectRoot() {
  const explicit = process.env.SPECBRIDGE_PROJECT_ROOT;
  const candidates = [
    ...(explicit === undefined ? [] : [{ source: 'SPECBRIDGE_PROJECT_ROOT', value: explicit }]),
    { source: 'cwd', value: process.cwd() },
    ...(process.env.PWD === undefined ? [] : [{ source: 'PWD', value: process.env.PWD }]),
  ];

  const failures = [];
  for (const candidate of candidates) {
    const canonical = canonicalDirectory(candidate.value);
    if (canonical === undefined) {
      failures.push(`${candidate.source} is not an existing readable directory`);
      continue;
    }
    if (isInside(pluginRoot, canonical)) {
      failures.push(`${candidate.source} resolves inside the installed plugin`);
      continue;
    }
    return nearestProjectMarker(canonical) ?? canonical;
  }

  diagnostic(
    'project_root_unavailable',
    'SpecBridge could not resolve the active Codex project. Open Codex in a project directory or set SPECBRIDGE_PROJECT_ROOT to an existing project directory.',
    failures.join('; '),
  );
  return undefined;
}

if (!existsSync(serverBundle)) {
  diagnostic(
    'bundle_missing',
    'The bundled SpecBridge MCP server is missing. Reinstall or rebuild the SpecBridge Codex plugin.',
    serverBundle,
  );
  process.exitCode = 1;
} else {
  const projectRoot = resolveProjectRoot();
  if (projectRoot === undefined) {
    process.exitCode = 1;
  } else {
    const child = spawn(
      process.execPath,
      [serverBundle, '--stdio', '--project-root', projectRoot],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
      },
    );

    let finished = false;
    child.once('error', (cause) => {
      if (finished) return;
      finished = true;
      diagnostic(
        'server_spawn_failed',
        'The bundled SpecBridge MCP server could not be started.',
        cause instanceof Error ? cause.message : String(cause),
      );
      process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      if (signal !== null && process.platform !== 'win32') {
        try {
          process.kill(process.pid, signal);
          return;
        } catch {
          // Fall through to a non-zero exit when signal propagation fails.
        }
      }
      process.exitCode = code ?? 1;
    });

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        if (!finished) child.kill(signal);
      });
    }
  }
}
