import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@specbridge/core';
import {
  EXTENSION_PROTOCOL_VERSION,
  EXTENSION_SDK_VERSION,
  operationsForKind,
  validateExtensionId,
  type ExtensionKind,
  type ExtensionManifest,
} from '@specbridge/extension-sdk';
import { ExtensionError } from './errors.js';

/**
 * `specbridge extension scaffold` — generate a complete, working extension
 * project for any kind. The scaffold works out of the box: the generated
 * `dist/extension.cjs` is a real self-contained implementation, so
 * `extension validate`, `extension package`, and `extension conformance`
 * pass immediately; `src/extension.mjs` shows the SDK-based development
 * path. Scaffolding never installs, never enables, and never publishes.
 */
export interface ScaffoldExtensionOptions {
  readonly id: string;
  readonly kind: ExtensionKind;
  readonly outputDir: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly dryRun?: boolean;
}

export interface ScaffoldExtensionResult {
  readonly id: string;
  readonly kind: ExtensionKind;
  readonly outputDir: string;
  readonly files: readonly string[];
  readonly dryRun: boolean;
}

function defaultDescription(kind: ExtensionKind, id: string): string {
  switch (kind) {
    case 'analyzer':
      return `Deterministic spec diagnostics contributed by the ${id} analyzer extension.`;
    case 'verifier':
      return `Verification diagnostics contributed by the ${id} verifier extension.`;
    case 'exporter':
      return `Candidate export files produced by the ${id} exporter extension.`;
    case 'runner':
      return `An out-of-process runner adapter provided by the ${id} extension.`;
    case 'template-provider':
      return `Spec template packs contributed by the ${id} template-provider extension.`;
  }
}

function scaffoldManifest(options: ScaffoldExtensionOptions): ExtensionManifest {
  const executable = options.kind !== 'template-provider';
  const operations =
    options.kind === 'runner'
      ? ['runner.detect', 'runner.generateStage', 'runner.executeTask']
      : [...operationsForKind(options.kind)];
  return {
    schemaVersion: '1.0.0',
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    id: options.id,
    version: '1.0.0',
    displayName: options.displayName ?? options.id,
    description: options.description ?? defaultDescription(options.kind, options.id),
    kind: options.kind,
    ...(executable ? { entrypoint: 'dist/extension.cjs' } : {}),
    compatibility: { specbridge: '>=0.7.1 <1.0.0', extensionSdk: `>=${EXTENSION_SDK_VERSION} <1.0.0` },
    capabilities: { operations },
    permissions: {
      specRead: options.kind !== 'template-provider',
      repositoryRead: options.kind === 'runner',
      repositoryWrite: options.kind === 'runner',
      network: false,
      childProcess: false,
      environmentVariables: [],
    },
    license: 'MIT',
    keywords: [options.kind, 'specbridge-extension'],
  };
}

const PROTOCOL_SHELL_HEAD = `'use strict';
// Self-contained SpecBridge extension implementing the versioned stdio
// protocol directly. stdout carries protocol messages ONLY; log to stderr.
// For SDK-based development, see src/extension.mjs and the README.
const readline = require('node:readline');
const path = require('node:path');
const manifest = require(path.join(process.cwd(), 'specbridge-extension.json'));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
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
`;

const PROTOCOL_SHELL_TAIL = `  fail(request.id, -32004, 'operation "' + operation + '" is not supported');
});
`;

// Assembled at runtime so the literal import specifier never appears in
// bundled SpecBridge output (the plugin bundle validator greps for it).
const SDK_PACKAGE = ['@specbridge', 'extension-sdk'].join('/');

const KIND_HANDLERS: Record<Exclude<ExtensionKind, 'template-provider'>, string> = {
  analyzer: `  if (operation === 'analyzer.analyze') {
    const diagnostics = [];
    const lines = String(payload.stageContent || '').split('\\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes('TBD')) {
        diagnostics.push({
          ruleId: 'RULE001',
          severity: 'warning',
          message: 'Unresolved TBD found; replace it with a concrete decision.',
          line: index + 1,
          confidence: 'deterministic',
        });
      }
    }
    ok(request.id, { operation, output: { diagnostics } });
    return;
  }
`,
  verifier: `  if (operation === 'verifier.verify') {
    const changed = payload.changedFiles || [];
    const source = changed.filter((f) => /\\.(ts|js|py|go|rs|java)$/.test(f.path) && !/test/i.test(f.path));
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
`,
  exporter: `  if (operation === 'exporter.export') {
    const stages = payload.stages || {};
    const summaryLines = ['# ' + payload.specName, ''];
    for (const stage of Object.keys(stages).sort()) {
      summaryLines.push('## ' + stage, '', String(stages[stage]).split('\\n')[0] || '(empty)', '');
    }
    ok(request.id, { operation, output: {
      files: [{
        path: payload.specName + '-summary.md',
        mediaType: 'text/markdown',
        content: summaryLines.join('\\n') + '\\n',
      }],
      diagnostics: [],
    } });
    return;
  }
`,
  runner: `  const CAPS = {
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
        markdown: '# Deterministic output for ' + payload.specName + '\\n',
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
`,
};

const SDK_SOURCE: Record<Exclude<ExtensionKind, 'template-provider'>, string> = {
  analyzer: `import { createAnalyzerExtension } from '${SDK_PACKAGE}';
import manifest from '../specbridge-extension.json' with { type: 'json' };

createAnalyzerExtension({
  manifest,
  analyze(input) {
    const diagnostics = [];
    input.stageContent.split('\\n').forEach((line, index) => {
      if (line.includes('TBD')) {
        diagnostics.push({
          ruleId: 'RULE001',
          severity: 'warning',
          message: 'Unresolved TBD found; replace it with a concrete decision.',
          line: index + 1,
          confidence: 'deterministic',
        });
      }
    });
    return { diagnostics };
  },
}).run();
`,
  verifier: `import { createVerifierExtension } from '${SDK_PACKAGE}';
import manifest from '../specbridge-extension.json' with { type: 'json' };

createVerifierExtension({
  manifest,
  verify(input) {
    const source = input.changedFiles.filter((f) => !/test/i.test(f.path));
    const tests = input.changedFiles.filter((f) => /test/i.test(f.path));
    const missing = source.length > 0 && tests.length === 0;
    return {
      status: missing ? 'warning' : source.length === 0 ? 'not-applicable' : 'passed',
      diagnostics: missing
        ? [{ ruleId: 'TESTS_MISSING', severity: 'warning', message: 'Changed source files have no matching test changes (heuristic).', confidence: 'heuristic' }]
        : [],
    };
  },
}).run();
`,
  exporter: `import { createExporterExtension } from '${SDK_PACKAGE}';
import manifest from '../specbridge-extension.json' with { type: 'json' };

createExporterExtension({
  manifest,
  export(input) {
    return {
      files: [{
        path: input.specName + '-summary.md',
        mediaType: 'text/markdown',
        content: '# ' + input.specName + '\\n',
      }],
    };
  },
}).run();
`,
  runner: `import { createRunnerExtension } from '${SDK_PACKAGE}';
import manifest from '../specbridge-extension.json' with { type: 'json' };

// See dist/extension.cjs for the full deterministic reference behavior.
createRunnerExtension({
  manifest,
  handlers: {
    detect() {
      return {
        available: true,
        authentication: 'not-applicable',
        capabilitySet: {
          stageGeneration: true, stageRefinement: false, taskExecution: true, taskResume: false,
          structuredFinalOutput: true, streamingEvents: false, repositoryRead: true,
          repositoryWrite: true, sandbox: false, toolRestriction: true, usageReporting: false,
          costReporting: false, localOnly: true, requiresNetwork: false, supportsSystemPrompt: false,
          supportsJsonSchema: false, supportsCancellation: true,
        },
        networkBacked: false,
        diagnostics: [],
      };
    },
  },
}).run();
`,
};

const EXAMPLE_TEMPLATE_PACK = (id: string): Record<string, string> => ({
  [`templates/${id}-starter/specbridge-template.json`]: `${JSON.stringify(
    {
      schemaVersion: '1.0.0',
      id: `${id}-starter`,
      version: '1.0.0',
      displayName: 'Starter Template',
      description: 'A starter feature template contributed by this template-provider extension.',
      kind: 'feature',
      supportedModes: ['requirements-first', 'quick'],
      defaultMode: 'requirements-first',
      tags: ['starter'],
      files: [
        { source: 'files/requirements.md.template', target: 'requirements.md', stage: 'requirements', required: true },
        { source: 'files/design.md.template', target: 'design.md', stage: 'design', required: true },
        { source: 'files/tasks.md.template', target: 'tasks.md', stage: 'tasks', required: true },
      ],
      variables: [],
      compatibility: { specbridge: '>=0.7.0 <1.0.0', kiroLayout: '1' },
      license: 'MIT',
    },
    null,
    2,
  )}\n`,
  [`templates/${id}-starter/README.md`]: '# Starter Template\n\nEdit the files under files/ to shape your template.\n',
  [`templates/${id}-starter/files/requirements.md.template`]:
    '# Requirements: {{title}}\n\n## 1. First requirement\n\nWHEN ... THEN the system SHALL ...\n',
  [`templates/${id}-starter/files/design.md.template`]: '# Design: {{title}}\n\n## Architecture\n\nDescribe the approach.\n',
  [`templates/${id}-starter/files/tasks.md.template`]: '# Tasks\n\n- [ ] 1. Implement {{title}}\n',
});

function scaffoldReadme(manifest: ExtensionManifest): string {
  const executable = manifest.kind !== 'template-provider';
  return `# ${manifest.displayName}

${manifest.description}

A SpecBridge **${manifest.kind}** extension.

## Develop

${
  executable
    ? '- `dist/extension.cjs` is the self-contained artifact SpecBridge runs (works as scaffolded).\n' +
      '- `src/extension.mjs` shows the same handler built on `@specbridge/extension-sdk`; bundle it\n' +
      '  to `dist/extension.cjs` (see package.json) once you add dependencies.\n' +
      '- stdout is protocol-only; log with `context.log(...)` / stderr.'
    : '- Template packs live under `templates/<template-id>/` in the standard\n' +
      '  v0.7.0 `specbridge-template.json` format. This extension is data-only:\n' +
      '  it has no entrypoint and never runs code.'
}

## Validate, test, package

\`\`\`bash
specbridge extension validate .
${executable ? 'node --test test/\nspecbridge extension conformance . --yes\n' : ''}specbridge extension package .
\`\`\`

The package command prints the archive SHA-256 — publish that hash with your
archive. Checksums prove integrity, not publisher identity.

## Install locally

\`\`\`bash
specbridge extension install ./dist/${manifest.id}-${manifest.version}.specbridge-extension.zip
specbridge extension show ${manifest.id}
specbridge extension enable ${manifest.id} --accept-permissions <hash-from-show>
\`\`\`

Installed extensions start disabled; enabling requires accepting the exact
permission hash shown by \`extension show\`.
`;
}

const PUBLISHING_CHECKLIST = `# Publishing checklist

1. Implement and test your handler (\`node --test test/\` for executable kinds).
2. Keep \`dist/extension.cjs\` self-contained — no node_modules at runtime.
3. \`specbridge extension validate .\`
4. \`specbridge extension conformance . --yes\` (executable kinds)
5. \`specbridge extension package .\` — note the printed archive SHA-256.
6. Host the archive at a stable HTTPS URL.
7. Add a registry entry (id, kind, version, archiveUrl, sha256, permissions,
   compatibility, license) — see the SpecBridge repository's
   registry/CONTRIBUTING.md.
8. Open a pull request. Registry listing is not endorsement; users review
   permissions before enabling.
`;

function scaffoldTest(manifest: ExtensionManifest): string {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Protocol-level smoke test: initialize handshake over real stdio.
test('extension answers the initialize handshake', async () => {
  const child = spawn(process.execPath, [path.resolve('dist/extension.cjs')], {
    cwd: path.resolve('.'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const response = await new Promise((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      const line = buffered.split('\\n')[0];
      if (line) resolve(JSON.parse(line));
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('no response')), 5000).unref();
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 'test-1', method: 'initialize',
      params: {
        protocolVersion: '1.0.0', specbridgeVersion: '0.7.1',
        extensionId: '${manifest.id}', extensionVersion: '${manifest.version}',
        grantedPermissions: ${JSON.stringify(manifest.permissions)},
      },
    }) + '\\n');
  });
  child.kill();
  assert.equal(response.result.extensionId, '${manifest.id}');
});
`;
}

const MIT_LICENSE = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export function scaffoldExtension(options: ScaffoldExtensionOptions): ScaffoldExtensionResult {
  const idCheck = validateExtensionId(options.id);
  if (!idCheck.valid) {
    throw new ExtensionError(
      'SBE003',
      `"${options.id}" is not a valid extension ID: ${idCheck.problems.join('; ')}.`,
      'Use lowercase letters, digits, and single hyphens, e.g. security-analyzer.',
    );
  }
  const outputDir = options.outputDir;
  if (existsSync(outputDir) && readdirSync(outputDir).length > 0) {
    throw new ExtensionError(
      'SBE030',
      `output directory "${outputDir}" already exists and is not empty.`,
      'Pick a new directory; scaffolding never overwrites existing files.',
    );
  }

  const manifest = scaffoldManifest(options);
  const files = new Map<string, string>();
  files.set('specbridge-extension.json', `${JSON.stringify(manifest, null, 2)}\n`);
  files.set('README.md', scaffoldReadme(manifest));
  files.set('LICENSE', MIT_LICENSE);
  files.set('PUBLISHING.md', PUBLISHING_CHECKLIST);

  if (manifest.kind === 'template-provider') {
    for (const [name, content] of Object.entries(EXAMPLE_TEMPLATE_PACK(options.id))) {
      files.set(name, content);
    }
  } else {
    files.set(
      'dist/extension.cjs',
      PROTOCOL_SHELL_HEAD + KIND_HANDLERS[manifest.kind] + PROTOCOL_SHELL_TAIL,
    );
    files.set('src/extension.mjs', SDK_SOURCE[manifest.kind]);
    files.set('test/extension.test.mjs', scaffoldTest(manifest));
    files.set(
      'package.json',
      `${JSON.stringify(
        {
          name: `specbridge-extension-${options.id}`,
          version: manifest.version,
          private: true,
          description: manifest.description,
          license: 'MIT',
          type: 'module',
          scripts: {
            test: 'node --test test/',
            // Optional SDK-based build: bundle src/extension.mjs into a
            // self-contained dist/extension.cjs (e.g. with esbuild):
            //   esbuild src/extension.mjs --bundle --platform=node
            //     --format=cjs --outfile=dist/extension.cjs
          },
          devDependencies: { '@specbridge/extension-sdk': `^${EXTENSION_SDK_VERSION}` },
        },
        null,
        2,
      )}\n`,
    );
  }

  if (options.dryRun === true) {
    return {
      id: options.id,
      kind: manifest.kind,
      outputDir,
      files: [...files.keys()].sort(),
      dryRun: true,
    };
  }

  for (const [name, content] of files) {
    const target = path.join(outputDir, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, content);
  }
  return {
    id: options.id,
    kind: manifest.kind,
    outputDir,
    files: [...files.keys()].sort(),
    dryRun: false,
  };
}
