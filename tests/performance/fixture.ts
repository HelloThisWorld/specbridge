import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpecWorkflowState, WorkspaceInfo } from '@specbridge/core';
import {
  SPEC_STATE_SCHEMA_VERSION,
  resolveWorkspace,
  sha256Hex,
  specWorkflowStateSchema,
  writeSpecState,
} from '@specbridge/core';
import type { TaskEvidenceRecord } from '@specbridge/evidence';
import { EVIDENCE_SCHEMA_VERSION, writeTaskEvidence } from '@specbridge/evidence';
import type { ExtensionState, PermissionGrants } from '@specbridge/extensions';
import {
  EXTENSION_STATE_SCHEMA_VERSION,
  writeExtensionState,
  writePermissionGrants,
} from '@specbridge/extensions';
import { EXTENSION_KINDS } from '@specbridge/extension-sdk';
import type { RegistryIndex } from '@specbridge/registry';
import { writeRegistriesConfig, writeRegistryCache } from '@specbridge/registry';
import { featureManifest, featurePackFiles, writePack } from '../helpers-templates.js';

/**
 * Deterministic large-workspace generator for the v1.0.0 performance suite.
 *
 * Everything is derived from loop counters and a fixed-seed LCG — no
 * Math.random, no wall clock (timestamps come from a fixed epoch plus a
 * monotonically increasing tick), so two builds with the same options are
 * byte-identical apart from the temp-directory name.
 *
 * The default `buildLargeWorkspace({ specs: 500, tasksPerSpec: 20 })` yields
 * 500 specs / 10,000 checkbox tasks. Optional layers add sidecar state with
 * real byte-exact approval hashes, append-only evidence history, 490 local
 * template packs, 500 installed-extension entries, a 500-entry cached
 * registry index, a real git repository, and a 2,000-file working-tree diff
 * surface.
 */

const FIXED_EPOCH_MS = Date.parse('2026-07-12T10:00:00.000Z');

/** Deterministic linear congruential generator (numerical-recipes constants). */
export class SeededCounter {
  private state: number;

  constructor(seed = 424242) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }

  /** Integer in [0, bound). */
  nextBelow(bound: number): number {
    return this.next() % bound;
  }
}

export interface LargeWorkspaceOptions {
  /** Number of generated specs (named spec-0000 …). Default 500. */
  specs?: number;
  /** Checkbox tasks per spec (hierarchy up to 4 levels deep). Default 20. */
  tasksPerSpec?: number;
  /** Write sidecar state (with exact approval hashes) for every Nth spec. Default 5. */
  stateEvery?: number;
  /** Give every Nth spec CJK + emoji + combining-character content. Default 50. */
  unicodeEvery?: number;
  /** Give every Nth spec a large (~64 KiB) design document. Default 100. */
  largeDocEvery?: number;
  /** Dense append-only evidence history for one spec. Default: none. */
  evidence?: { spec: string; records: number };
  /** Additionally give specs 1..routedEvidenceSpecs evidence that routes src files. Default 0. */
  routedEvidenceSpecs?: number;
  /** Initialize a real git repository and commit everything as a baseline. Default false. */
  git?: boolean;
  /** Untracked working-tree files written AFTER the baseline commit (requires git). Default 0. */
  diffFiles?: number;
  /** Local template packs installed under .specbridge/templates/. Default 0. */
  templatePacks?: number;
  /** Installed-extension metadata entries in .specbridge/extensions/state.json. Default 0. */
  extensionEntries?: number;
  /** Cached registry index entries under .specbridge/registry-cache/. Default 0. */
  registryEntries?: number;
  /** Extra spec whose tasks are all done leaves without evidence (induces SBV004 diagnostics). */
  diagnosticsSpec?: { name: string; doneTasks: number };
}

export interface LargeWorkspace {
  root: string;
  workspace: WorkspaceInfo;
  /** Generated spec names in order (excludes the diagnostics spec). */
  specNames: string[];
  /** Total checkbox tasks across the generated specs (excludes the diagnostics spec). */
  totalTasks: number;
  /** Name of the registry source whose cache was populated (when registryEntries > 0). */
  registrySourceName?: string;
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

function iso(tick: number): string {
  return new Date(FIXED_EPOCH_MS + tick * 1000).toISOString();
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/* ------------------------------------------------------------------ *
 * Document generators
 * ------------------------------------------------------------------ */

const UNICODE_SECTION = [
  '## 国際化サンプル (internationalisation sample)',
  '',
  '大規模リポジトリの性能試験用データです。规模测试涵盖中文、日本語、한국어。',
  'Emoji coverage: \u{1F680} \u{1F4C8} \u{1F9EA} \u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466} ✅',
  'Combining marks: é ä ô ñ ş́ and stacked Z͑ͫā͞l͖g̀ȏ.',
  '',
].join('\n');

function requirementsDocument(specName: string, unicode: boolean): string {
  const lines: string[] = [
    '# Requirements Document',
    '',
    '## Introduction',
    '',
    `Deterministic performance-fixture requirements for ${specName}. This file`,
    'exists to exercise parsing at repository scale; every requirement below',
    'follows the documented Kiro shape with EARS-style acceptance criteria.',
    '',
  ];
  if (unicode) lines.push(UNICODE_SECTION);
  lines.push('## Requirements', '');
  for (let r = 1; r <= 10; r += 1) {
    lines.push(
      `### Requirement ${r}: Capability ${r} of ${specName}`,
      '',
      `**User Story:** As a maintainer, I want capability ${r} of ${specName}, so that behaviour ${r} stays predictable at scale.`,
      '',
      '#### Acceptance Criteria',
      '',
      `1. WHEN event ${r}.1 occurs, THE SYSTEM SHALL complete action ${r}.1 within its documented budget.`,
      `2. IF condition ${r}.2 holds, THEN THE SYSTEM SHALL record outcome ${r}.2 in the audit surface.`,
      `3. WHILE state ${r}.3 is active, THE SYSTEM SHALL preserve invariant ${r}.3 for ${specName}.`,
      '',
    );
  }
  return `${lines.join('\n')}\n`.replace(/\n\n$/, '\n');
}

function designDocument(specName: string, unicode: boolean, large: boolean): string {
  const lines: string[] = [
    '# Design Document',
    '',
    '## Overview',
    '',
    `Design for ${specName} inside the large-workspace performance fixture.`,
    '',
  ];
  if (unicode) lines.push(UNICODE_SECTION);
  lines.push(
    '## Architecture',
    '',
    `The implementation lives in \`src/${specName}/index.ts\` and delegates all`,
    `IO to \`src/${specName}/service.ts\`; both files are deliberately part of`,
    'the diff surface so affected-spec detection has a design-reference path.',
    '',
    '## Components',
    '',
    `- Entry point: \`src/${specName}/index.ts\``,
    `- Service layer: \`src/${specName}/service.ts\``,
    '',
    '## Error Handling',
    '',
    'Errors propagate as structured results; nothing in this fixture throws.',
    '',
  );
  if (large) {
    lines.push('## Deterministic Padding', '');
    for (let i = 0; i < 400; i += 1) {
      lines.push(
        `Padding line ${pad(i, 4)}: 性能テスト データ ${pad(i, 4)} — deterministic filler ` +
          'abcdefghijklmnopqrstuvwxyz0123456789 abcdefghijklmnopqrstuvwxyz0123456789 ' +
          'abcdefghijklmnopqrstuvwxyz0123456789.',
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`.replace(/\n\n$/, '\n');
}

export interface GeneratedTasks {
  content: string;
  /** Total checkbox tasks in the document. */
  total: number;
  /** Deepest-level leaf task ids (block leaves, e.g. `1.1.1.1`). */
  leafIds: string[];
  /** Leaf ids generated as done (`[x]`). */
  doneLeafIds: string[];
}

/**
 * Tasks document: blocks of four tasks nested four levels deep
 * (`b` → `b.1` → `b.1.1` → `b.1.1.1`) with `_Requirements: r.c_` references
 * on detail lines, plus flat top-level tasks for any remainder. The deepest
 * leaf of blocks 1 and 2 is `[x]` so evidence rules have material.
 */
function tasksDocument(specName: string, taskCount: number, refs: SeededCounter): GeneratedTasks {
  const lines: string[] = ['# Implementation Plan', ''];
  const leafIds: string[] = [];
  const doneLeafIds: string[] = [];
  let total = 0;

  const nextRef = (): string => `${1 + refs.nextBelow(10)}.${1 + refs.nextBelow(3)}`;

  const blocks = Math.floor(taskCount / 4);
  for (let b = 1; b <= blocks; b += 1) {
    const leafDone = b <= 2;
    lines.push(
      `- [ ] ${b}. Implement block ${b} of ${specName}`,
      `  - [ ] ${b}.1 Prepare inputs for block ${b}`,
      `    - Detail bullet describing block ${b} of ${specName}`,
      `    - _Requirements: ${nextRef()}, ${nextRef()}_`,
      `    - [ ] ${b}.1.1 Wire adapters for block ${b}`,
      `      - _Requirements: ${nextRef()}_`,
      `      - [${leafDone ? 'x' : ' '}] ${b}.1.1.1 Verify leaf behaviour for block ${b}`,
      `        - _Requirements: ${nextRef()}, ${nextRef()}_`,
    );
    total += 4;
    const leafId = `${b}.1.1.1`;
    leafIds.push(leafId);
    if (leafDone) doneLeafIds.push(leafId);
  }
  for (let extra = blocks * 4 + 1; extra <= taskCount; extra += 1) {
    const id = String(extra);
    lines.push(`- [ ] ${id}. Standalone task ${id} of ${specName}`, `  - _Requirements: ${nextRef()}_`);
    total += 1;
    leafIds.push(id);
  }
  lines.push('');
  return { content: lines.join('\n'), total, leafIds, doneLeafIds };
}

function diagnosticsTasksDocument(specName: string, doneTasks: number, refs: SeededCounter): string {
  const lines: string[] = ['# Implementation Plan', ''];
  for (let n = 1; n <= doneTasks; n += 1) {
    lines.push(
      `- [x] ${n}. Diagnostics task ${n} of ${specName}`,
      `  - _Requirements: ${1 + refs.nextBelow(10)}.${1 + refs.nextBelow(3)}_`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Sidecar layers
 * ------------------------------------------------------------------ */

function approvedState(
  specName: string,
  requirementsBytes: Buffer,
  designBytes: Buffer,
  tick: number,
): SpecWorkflowState {
  const stamp = iso(tick);
  const state = {
    schemaVersion: SPEC_STATE_SCHEMA_VERSION,
    specName,
    specType: 'feature' as const,
    workflowMode: 'requirements-first' as const,
    origin: 'created-by-specbridge' as const,
    status: 'TASKS_DRAFT' as const,
    createdAt: stamp,
    updatedAt: stamp,
    stages: {
      requirements: {
        status: 'approved' as const,
        file: `.kiro/specs/${specName}/requirements.md`,
        approvedAt: stamp,
        approvedHash: sha256Hex(requirementsBytes),
        hashAlgorithm: 'sha256' as const,
        hashSemanticsVersion: '2',
      },
      design: {
        status: 'approved' as const,
        file: `.kiro/specs/${specName}/design.md`,
        approvedAt: stamp,
        approvedHash: sha256Hex(designBytes),
        hashAlgorithm: 'sha256' as const,
        hashSemanticsVersion: '2',
      },
      tasks: {
        status: 'draft' as const,
        file: `.kiro/specs/${specName}/tasks.md`,
        approvedAt: null,
        approvedHash: null,
      },
    },
  };
  // Guarantee the fixture only ever writes schema-valid sidecar state.
  return specWorkflowStateSchema.parse(state);
}

function evidenceRecord(
  specName: string,
  taskId: string,
  sequence: number,
  tick: number,
): TaskEvidenceRecord {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: `perf-run-${pad(sequence, 6)}`,
    specName,
    taskId,
    status: 'verified',
    runner: 'mock',
    repository: { dirtyBefore: false, dirtyAfter: true },
    changedFiles: [
      {
        path: `src/${specName}/service.ts`,
        changeType: 'modified',
        preExisting: true,
        modifiedDuringRun: true,
      },
    ],
    verificationCommands: [
      { name: 'test', argv: ['node', '-e', '0'], required: true, exitCode: 0, durationMs: 5, passed: true },
    ],
    verificationSkipped: false,
    runnerClaims: { changedFiles: [], commandsReported: [], testsReported: [] },
    violations: [],
    warnings: [],
    evaluatedAt: iso(tick),
  };
}

function writeTemplatePacks(root: string, count: number): void {
  const templatesDir = path.join(root, '.specbridge', 'templates');
  for (let i = 0; i < count; i += 1) {
    const id = `perf-pack-${pad(i, 3)}`;
    const telemetry = i % 49 === 0;
    const manifest = featureManifest({
      id,
      displayName: `Perf Pack ${pad(i, 3)}`,
      description:
        `Deterministic performance-fixture template pack ${pad(i, 3)}.` +
        (telemetry ? ' Includes telemetry dashboards for scale testing.' : ''),
      tags: telemetry ? ['perf', 'fixture', 'telemetry'] : ['perf', 'fixture'],
    });
    const dir = path.join(templatesDir, id);
    mkdirSync(dir, { recursive: true });
    writePack(dir, featurePackFiles(manifest));
  }
}

function writeExtensionEntries(workspace: WorkspaceInfo, count: number): void {
  const state: ExtensionState = {
    schemaVersion: EXTENSION_STATE_SCHEMA_VERSION,
    installed: [],
    enabled: {},
  };
  const grants: PermissionGrants = { schemaVersion: EXTENSION_STATE_SCHEMA_VERSION, grants: {} };
  for (let i = 0; i < count; i += 1) {
    const id = `perf-ext-${pad(i, 3)}`;
    const kind = EXTENSION_KINDS[i % EXTENSION_KINDS.length] as string;
    const manifestSha256 = sha256Hex(`manifest-${id}`);
    const permissionHash = sha256Hex(`permissions-${id}`);
    state.installed.push({
      id,
      version: '1.0.0',
      kind,
      displayName: `Perf Extension ${pad(i, 3)}`,
      description:
        `Deterministic installed-extension fixture entry ${pad(i, 3)}.` +
        (i % 25 === 0 ? ' Provides telemetry hooks.' : ''),
      source: 'perf-fixture',
      installedAt: iso(i),
      manifestSha256,
      permissionHash,
      installRecordId: `install-${id}`,
    });
    if (i % 2 === 0) state.enabled[id] = { version: '1.0.0' };
    if (i % 2 === 1) {
      grants.grants[id] = {
        version: '1.0.0',
        manifestSha256,
        permissionHash,
        acceptedAt: iso(i),
      };
    }
  }
  writeExtensionState(workspace, state);
  writePermissionGrants(workspace, grants);
}

export const PERF_REGISTRY_SOURCE = 'perf-remote';

function writeRegistryFixture(workspace: WorkspaceInfo, count: number): void {
  const index: RegistryIndex = {
    schemaVersion: '1.0.0',
    name: 'Perf Fixture Registry',
    updatedAt: iso(0),
    extensions: [],
  };
  for (let i = 0; i < count; i += 1) {
    const id = `reg-ext-${pad(i, 3)}`;
    index.extensions.push({
      id,
      displayName: `Registry Extension ${pad(i, 3)}`,
      description:
        `Deterministic cached registry fixture entry ${pad(i, 3)}.` +
        (i % 25 === 0 ? ' Ships telemetry exporters.' : ''),
      kind: EXTENSION_KINDS[i % EXTENSION_KINDS.length] ?? 'analyzer',
      latestVersion: '1.0.0',
      versions: [
        {
          version: '1.0.0',
          archiveUrl: `https://registry.invalid/archives/${id}-1.0.0.tar.gz`,
          sha256: sha256Hex(`archive-${id}`),
          manifest: {
            protocolVersion: '1.0.0',
            compatibility: { specbridge: '>=0.7.0 <2.0.0' },
            permissions: {
              specRead: true,
              repositoryRead: false,
              repositoryWrite: false,
              network: false,
              childProcess: false,
              environmentVariables: [],
            },
          },
        },
      ],
      license: 'MIT',
      keywords: i % 25 === 0 ? ['perf', 'fixture', 'telemetry'] : ['perf', 'fixture'],
    });
  }
  writeRegistriesConfig(workspace, {
    schemaVersion: '1.0.0',
    registries: [
      { name: PERF_REGISTRY_SOURCE, type: 'https', url: 'https://registry.invalid/index.json', enabled: true },
    ],
  });
  writeRegistryCache(workspace, PERF_REGISTRY_SOURCE, JSON.stringify(index), index, {
    clock: () => new Date(FIXED_EPOCH_MS),
  });
}

/* ------------------------------------------------------------------ *
 * Workspace builder
 * ------------------------------------------------------------------ */

export function buildLargeWorkspace(options: LargeWorkspaceOptions = {}): LargeWorkspace {
  const specs = options.specs ?? 500;
  const tasksPerSpec = options.tasksPerSpec ?? 20;
  const stateEvery = options.stateEvery ?? 5;
  const unicodeEvery = options.unicodeEvery ?? 50;
  const largeDocEvery = options.largeDocEvery ?? 100;

  const root = mkdtempSync(path.join(os.tmpdir(), 'specbridge-perf-'));
  const specsDir = path.join(root, '.kiro', 'specs');
  mkdirSync(specsDir, { recursive: true });
  mkdirSync(path.join(root, '.kiro', 'steering'), { recursive: true });
  writeFileSync(
    path.join(root, '.kiro', 'steering', 'product.md'),
    '# Product Steering\n\nDeterministic performance-fixture workspace. No model calls; offline only.\n',
    'utf8',
  );

  const refs = new SeededCounter(20260712);
  const specNames: string[] = [];
  let totalTasks = 0;
  let evidenceTick = 100_000;
  let evidenceSequence = 0;

  interface PendingState {
    specName: string;
    requirements: Buffer;
    design: Buffer;
  }
  const pendingStates: PendingState[] = [];
  const generatedTasks = new Map<string, GeneratedTasks>();

  for (let i = 0; i < specs; i += 1) {
    const specName = `spec-${pad(i, 4)}`;
    specNames.push(specName);
    const unicode = unicodeEvery > 0 && i % unicodeEvery === 0;
    const large = largeDocEvery > 0 && i % largeDocEvery === 0;

    const requirements = requirementsDocument(specName, unicode);
    const design = designDocument(specName, unicode, large);
    const tasks = tasksDocument(specName, tasksPerSpec, refs);
    generatedTasks.set(specName, tasks);
    totalTasks += tasks.total;

    const dir = path.join(specsDir, specName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'requirements.md'), requirements, 'utf8');
    writeFileSync(path.join(dir, 'design.md'), design, 'utf8');
    writeFileSync(path.join(dir, 'tasks.md'), tasks.content, 'utf8');

    if (stateEvery > 0 && i % stateEvery === 0) {
      pendingStates.push({
        specName,
        requirements: Buffer.from(requirements, 'utf8'),
        design: Buffer.from(design, 'utf8'),
      });
    }
  }

  if (options.diagnosticsSpec !== undefined) {
    const { name, doneTasks } = options.diagnosticsSpec;
    const dir = path.join(specsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'requirements.md'), requirementsDocument(name, false), 'utf8');
    writeFileSync(path.join(dir, 'design.md'), designDocument(name, false, false), 'utf8');
    writeFileSync(path.join(dir, 'tasks.md'), diagnosticsTasksDocument(name, doneTasks, refs), 'utf8');
  }

  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('perf fixture: workspace did not resolve');

  // Sidecar state with approval hashes over the exact bytes on disk.
  let stateTick = 0;
  for (const pending of pendingStates) {
    writeSpecState(
      workspace,
      approvedState(pending.specName, pending.requirements, pending.design, stateTick),
    );
    stateTick += 1;
  }

  // Dense evidence history for one spec (round-robin across its leaf tasks).
  if (options.evidence !== undefined) {
    const tasks = generatedTasks.get(options.evidence.spec);
    if (tasks === undefined) {
      throw new Error(`perf fixture: evidence target ${options.evidence.spec} was not generated`);
    }
    const leafIds = tasks.leafIds;
    if (leafIds.length === 0) throw new Error('perf fixture: evidence target has no leaf tasks');
    for (let n = 0; n < options.evidence.records; n += 1) {
      const taskId = leafIds[n % leafIds.length] as string;
      evidenceSequence += 1;
      writeTaskEvidence(
        workspace,
        evidenceRecord(options.evidence.spec, taskId, evidenceSequence, evidenceTick),
      );
      evidenceTick += 1;
    }
  }

  // Thin evidence on a handful of other specs so affected-spec routing has
  // an evidence-path surface beyond design references.
  const routed = options.routedEvidenceSpecs ?? 0;
  for (let i = 1; i <= routed && i < specNames.length; i += 1) {
    const specName = specNames[i] as string;
    const tasks = generatedTasks.get(specName);
    const taskId = tasks?.doneLeafIds[0] ?? tasks?.leafIds[0];
    if (taskId === undefined) continue;
    for (let r = 0; r < 2; r += 1) {
      evidenceSequence += 1;
      writeTaskEvidence(workspace, evidenceRecord(specName, taskId, evidenceSequence, evidenceTick));
      evidenceTick += 1;
    }
  }

  if (options.templatePacks !== undefined && options.templatePacks > 0) {
    writeTemplatePacks(root, options.templatePacks);
  }
  if (options.extensionEntries !== undefined && options.extensionEntries > 0) {
    writeExtensionEntries(workspace, options.extensionEntries);
  }
  const registryEntries = options.registryEntries ?? 0;
  if (registryEntries > 0) {
    writeRegistryFixture(workspace, registryEntries);
  }

  if (options.git === true) {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'perf@specbridge.invalid');
    git(root, 'config', 'user.name', 'SpecBridge Perf Fixture');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'perf fixture baseline');
  }

  const diffFiles = options.diffFiles ?? 0;
  if (diffFiles > 0) {
    if (options.git !== true) throw new Error('perf fixture: diffFiles requires git: true');
    // Round-robin across specs; the first two waves land on the exact paths
    // design.md references (`index.ts`, `service.ts`), later waves are
    // deliberately unmapped extras.
    const kinds = ['index.ts', 'service.ts', 'extra-0.txt', 'extra-1.txt', 'extra-2.txt'];
    for (let j = 0; j < diffFiles; j += 1) {
      const specName = specNames[j % specNames.length] as string;
      const wave = Math.floor(j / specNames.length);
      const fileName = kinds[wave % kinds.length] as string;
      const dir = path.join(root, 'src', specName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, fileName),
        `// perf diff surface file ${pad(j, 4)} for ${specName}\n`,
        'utf8',
      );
    }
  }

  const result: LargeWorkspace = { root, workspace, specNames, totalTasks };
  if (registryEntries > 0) result.registrySourceName = PERF_REGISTRY_SOURCE;
  return result;
}
