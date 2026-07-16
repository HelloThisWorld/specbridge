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
  const CAPS = {
    stageGeneration: true, stageRefinement: false, taskExecution: true, taskResume: false,
    structuredFinalOutput: true, streamingEvents: false, repositoryRead: true,
    repositoryWrite: true, sandbox: false, toolRestriction: true, usageReporting: false,
    costReporting: false, localOnly: true, requiresNetwork: false, supportsSystemPrompt: false,
    supportsJsonSchema: false, supportsCancellation: true,
  };
  if (operation === 'runner.detect') {
    ok(request.id, { operation, output: {
      available: true, authentication: 'not-applicable', capabilitySet: CAPS,
      networkBacked: false, diagnostics: [],
    } });
    return;
  }
  if (operation === 'runner.generateStage') {
    ok(request.id, { operation, output: {
      outcome: 'completed', rawStdout: 'deterministic scaffold runner', rawStderr: '',
      durationMs: 1, warnings: [],
      report: {
        schemaVersion: '1.0.0', stage: payload.stage,
        markdown: '# Deterministic output for ' + payload.specName + '\n',
        summary: 'deterministic scaffold output (no model, no network)',
        assumptions: [], openQuestions: [], referencedFiles: [],
      },
    } });
    return;
  }
  if (operation === 'runner.executeTask') {
    ok(request.id, { operation, output: {
      outcome: 'completed', rawStdout: 'deterministic scaffold runner', rawStderr: '',
      durationMs: 1, warnings: [], resumeSupported: false,
      report: {
        schemaVersion: '1.0.0', outcome: 'completed',
        summary: 'claimed complete — a claim, never evidence',
        changedFiles: [], commandsReported: [], testsReported: [],
        remainingRisks: [], blockingQuestions: [], recommendedNextActions: [],
      },
    } });
    return;
  }
  fail(request.id, -32004, 'operation "' + operation + '" is not supported');
});
