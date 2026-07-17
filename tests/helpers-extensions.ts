import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireWorkspace, type WorkspaceInfo } from '@specbridge/core';
import type { ExtensionManifest } from '@specbridge/extension-sdk';
import {
  computeExtensionChecksums,
  describeEnablement,
  enableExtension,
  installExtensionFromDirectory,
  requireEnabledExtension,
  type EnabledExtension,
} from '@specbridge/extensions';

/** A valid analyzer manifest; override fields per test. */
export function analyzerManifest(overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  return {
    schemaVersion: '1.0.0',
    protocolVersion: '1.0.0',
    id: 'demo-analyzer',
    version: '1.0.0',
    displayName: 'Demo Analyzer',
    description: 'A deterministic demo analyzer used by the SpecBridge test suite.',
    kind: 'analyzer',
    entrypoint: 'dist/extension.cjs',
    compatibility: { specbridge: '>=0.7.1 <2.0.0' },
    capabilities: { operations: ['analyzer.analyze'] },
    permissions: {
      specRead: true,
      repositoryRead: false,
      repositoryWrite: false,
      network: false,
      childProcess: false,
      environmentVariables: [],
    },
    license: 'MIT',
    ...overrides,
  };
}

export function verifierManifest(overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  return analyzerManifest({
    id: 'demo-verifier',
    displayName: 'Demo Verifier',
    description: 'A heuristic demo verifier used by the SpecBridge test suite.',
    kind: 'verifier',
    capabilities: { operations: ['verifier.verify'] },
    ...overrides,
  });
}

export function exporterManifest(overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  return analyzerManifest({
    id: 'demo-exporter',
    displayName: 'Demo Exporter',
    description: 'A demo exporter that returns candidate files for the test suite.',
    kind: 'exporter',
    capabilities: { operations: ['exporter.export'] },
    ...overrides,
  });
}

export function runnerManifest(overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  return analyzerManifest({
    id: 'demo-runner',
    displayName: 'Demo Runner',
    description: 'A deterministic mock runner extension used by the test suite.',
    kind: 'runner',
    capabilities: {
      operations: ['runner.detect', 'runner.generateStage', 'runner.executeTask'],
    },
    permissions: {
      specRead: true,
      repositoryRead: true,
      repositoryWrite: true,
      network: false,
      childProcess: false,
      environmentVariables: [],
    },
    ...overrides,
  });
}

export function templateProviderManifest(overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  const manifest = analyzerManifest({
    id: 'demo-template-provider',
    displayName: 'Demo Template Provider',
    description: 'A data-only template provider used by the SpecBridge test suite.',
    kind: 'template-provider',
    capabilities: { operations: [] },
    permissions: {
      specRead: false,
      repositoryRead: false,
      repositoryWrite: false,
      network: false,
      childProcess: false,
      environmentVariables: [],
    },
    ...overrides,
  });
  const { entrypoint: _entrypoint, ...rest } = manifest;
  return rest as ExtensionManifest;
}

export interface ExtensionFileMap {
  readonly [relativePath: string]: string;
}

/** Write an extension package directory into a fresh temp dir. */
export function tempExtensionDir(files: ExtensionFileMap): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sb-ext-'));
  writeExtensionFiles(dir, files);
  return dir;
}

export function writeExtensionFiles(dir: string, files: ExtensionFileMap): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(dir, ...relativePath.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

/**
 * Build a complete, valid extension package file map: manifest, README,
 * LICENSE, entrypoint (for executable kinds), and computed checksums.
 */
export function buildExtensionPackageFiles(
  manifest: ExtensionManifest,
  extras: ExtensionFileMap = {},
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  files.set('specbridge-extension.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  files.set('README.md', Buffer.from(`# ${manifest.displayName}\n\n${manifest.description}\n`, 'utf8'));
  files.set('LICENSE', Buffer.from('MIT License (test fixture)\n', 'utf8'));
  if (manifest.entrypoint !== undefined && extras[manifest.entrypoint] === undefined) {
    files.set(manifest.entrypoint, Buffer.from(PLAIN_ANALYZER_ENTRYPOINT, 'utf8'));
  }
  for (const [name, content] of Object.entries(extras)) {
    files.set(name, Buffer.from(content, 'utf8'));
  }
  const checksums = computeExtensionChecksums(files);
  files.set('checksums.json', Buffer.from(`${JSON.stringify(checksums, null, 2)}\n`, 'utf8'));
  return files;
}

/** Write a package file map to a fresh temp directory. */
export function writePackageDir(files: ReadonlyMap<string, Buffer>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sb-extpkg-'));
  for (const [name, content] of files) {
    const target = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/** Install a package into a workspace and return the workspace info. */
export function installTestExtension(
  workspaceRoot: string,
  manifest: ExtensionManifest,
  extras: ExtensionFileMap = {},
): WorkspaceInfo {
  const workspace = requireWorkspace(workspaceRoot);
  const dir = writePackageDir(buildExtensionPackageFiles(manifest, extras));
  installExtensionFromDirectory(dir, { workspace, sourceLabel: `local-directory:${dir}` });
  return workspace;
}

/** Install + enable in one step; returns the enabled extension gate result. */
export async function installAndEnableTestExtension(
  workspaceRoot: string,
  manifest: ExtensionManifest,
  extras: ExtensionFileMap = {},
): Promise<{ workspace: WorkspaceInfo; enabled: EnabledExtension }> {
  const workspace = installTestExtension(workspaceRoot, manifest, extras);
  const preview = describeEnablement(workspace, manifest.id);
  await enableExtension({
    workspace,
    id: manifest.id,
    acceptPermissions: preview.permissionHash,
  });
  return { workspace, enabled: requireEnabledExtension(workspace, manifest.id) };
}

/**
 * A verifier entrypoint whose status is driven by the invocation
 * configuration (`{"status": "failed"}` etc.), so policy fixtures control
 * the outcome deterministically.
 */
export const PLAIN_VERIFIER_ENTRYPOINT = `'use strict';
const readline = require('node:readline');
const path = require('node:path');
const manifest = require(path.join(process.cwd(), 'specbridge-extension.json'));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '1.0.0',
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      capabilities: manifest.capabilities,
    } });
    return;
  }
  if (request.method === 'extension.invoke') {
    const cfg = (request.params && request.params.configuration) || {};
    const status = cfg.status || 'passed';
    const diagnostics = status === 'failed' || status === 'warning'
      ? [{
          ruleId: 'TESTS_MISSING',
          severity: status === 'failed' ? 'error' : 'warning',
          message: 'changed source files have no matching test changes (heuristic)',
          confidence: 'heuristic',
        }]
      : [];
    send({ jsonrpc: '2.0', id: request.id, result: {
      operation: 'verifier.verify',
      output: { status, diagnostics, summary: 'heuristic test-coverage check' },
    } });
    return;
  }
  if (request.method === 'extension.shutdown') {
    send({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
    process.exit(0);
  }
});
`;

/** A deterministic mock runner extension: no model, no network, valid claims. */
export const PLAIN_RUNNER_ENTRYPOINT = `'use strict';
const readline = require('node:readline');
const path = require('node:path');
const manifest = require(path.join(process.cwd(), 'specbridge-extension.json'));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
const CAPS = {
  stageGeneration: true, stageRefinement: false, taskExecution: true, taskResume: false,
  structuredFinalOutput: true, streamingEvents: false, repositoryRead: true,
  repositoryWrite: true, sandbox: false, toolRestriction: true, usageReporting: false,
  costReporting: false, localOnly: true, requiresNetwork: false, supportsSystemPrompt: false,
  supportsJsonSchema: false, supportsCancellation: true,
};
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '1.0.0',
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      capabilities: manifest.capabilities,
    } });
    return;
  }
  if (request.method === 'extension.invoke') {
    const op = request.params.operation;
    const payload = request.params.payload || {};
    if (op === 'runner.detect') {
      send({ jsonrpc: '2.0', id: request.id, result: { operation: op, output: {
        available: true, authentication: 'not-applicable', capabilitySet: CAPS,
        networkBacked: false, diagnostics: [],
      } } });
      return;
    }
    if (op === 'runner.generateStage') {
      send({ jsonrpc: '2.0', id: request.id, result: { operation: op, output: {
        outcome: 'completed', rawStdout: 'deterministic mock stage', rawStderr: '',
        durationMs: 5, warnings: [],
        report: {
          schemaVersion: '1.0.0', stage: payload.stage,
          markdown: '# Generated by example runner\\n', summary: 'deterministic mock output',
          assumptions: [], openQuestions: [], referencedFiles: [],
        },
      } } });
      return;
    }
    if (op === 'runner.executeTask') {
      send({ jsonrpc: '2.0', id: request.id, result: { operation: op, output: {
        outcome: 'completed', rawStdout: 'deterministic mock task', rawStderr: '',
        durationMs: 5, warnings: [], resumeSupported: false,
        report: {
          schemaVersion: '1.0.0', outcome: 'completed',
          summary: 'claimed complete (a claim, never evidence)',
          changedFiles: [], commandsReported: [], testsReported: [],
          remainingRisks: [], blockingQuestions: [], recommendedNextActions: [],
        },
      } } });
      return;
    }
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32004, message: 'unsupported' } });
    return;
  }
  if (request.method === 'extension.shutdown') {
    send({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
    process.exit(0);
  }
});
`;

/** A minimal working analyzer extension entrypoint written in plain CJS. */
export const PLAIN_ANALYZER_ENTRYPOINT = `'use strict';
// Minimal SpecBridge analyzer extension implementing the stdio protocol
// directly (no SDK) so tests exercise the protocol, not the SDK.
const readline = require('node:readline');
const path = require('node:path');
// cwd is always the installed extension directory.
const manifest = require(path.join(process.cwd(), 'specbridge-extension.json'));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '1.0.0',
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      capabilities: manifest.capabilities,
    } });
    return;
  }
  if (request.method === 'extension.invoke') {
    const content = String(request.params.payload.stageContent || '');
    const diagnostics = [];
    if (content.includes('TBD')) {
      diagnostics.push({
        ruleId: 'RULE001',
        severity: 'warning',
        message: 'unresolved TBD found',
        confidence: 'deterministic',
      });
    }
    send({ jsonrpc: '2.0', id: request.id, result: {
      operation: 'analyzer.analyze',
      output: { diagnostics },
    } });
    return;
  }
  if (request.method === 'extension.shutdown') {
    send({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
    process.exit(0);
  }
});
`;
