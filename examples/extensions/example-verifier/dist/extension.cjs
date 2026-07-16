'use strict';
// Self-contained SpecBridge extension implementing the versioned stdio
// protocol directly. stdout carries protocol messages ONLY; log to stderr.
// For SDK-based development, see src/extension.mjs and the README.
const readline = require('node:readline');
const path = require('node:path');
const manifest = require(path.join(process.cwd(), 'specbridge-extension.json'));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    ok(request.id, {
      protocolVersion: '1.0.0',
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      capabilities: manifest.capabilities,
    });
    return;
  }
  if (request.method === 'extension.getMetadata') {
    ok(request.id, {
      id: manifest.id, version: manifest.version, kind: manifest.kind,
      displayName: manifest.displayName, protocolVersion: '1.0.0',
    });
    return;
  }
  if (request.method === 'extension.cancel') {
    ok(request.id, { cancelled: false });
    return;
  }
  if (request.method === 'extension.shutdown') {
    ok(request.id, { ok: true });
    process.exit(0);
  }
  if (request.method !== 'extension.invoke') {
    fail(request.id, -32601, 'method not found');
    return;
  }
  const operation = request.params.operation;
  const payload = request.params.payload || {};
  if (operation === 'verifier.verify') {
    const changed = payload.changedFiles || [];
    const source = changed.filter((f) => /\.(ts|js|py|go|rs|java)$/.test(f.path) && !/test/i.test(f.path));
    const tests = changed.filter((f) => /test/i.test(f.path));
    const missing = source.length > 0 && tests.length === 0;
    ok(request.id, { operation, output: {
      status: missing ? 'warning' : source.length === 0 ? 'not-applicable' : 'passed',
      diagnostics: missing ? [{
        ruleId: 'TESTS_MISSING',
        severity: 'warning',
        message: 'Changed source files have no matching test changes (heuristic).',
        confidence: 'heuristic',
      }] : [],
      summary: 'heuristic changed-source-vs-changed-tests check',
    } });
    return;
  }
  fail(request.id, -32004, 'operation "' + operation + '" is not supported');
});
