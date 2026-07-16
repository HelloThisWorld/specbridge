import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExtensionManifest } from '@specbridge/extension-sdk';

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
    compatibility: { specbridge: '>=0.7.1 <1.0.0' },
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

/** A minimal working analyzer extension entrypoint written in plain CJS. */
export const PLAIN_ANALYZER_ENTRYPOINT = `'use strict';
// Minimal SpecBridge analyzer extension implementing the stdio protocol
// directly (no SDK) so tests exercise the protocol, not the SDK.
const readline = require('node:readline');
const manifest = require('./specbridge-extension.json');
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
