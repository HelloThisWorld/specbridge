import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@specbridge/core';
import { RepositoryContextIndex, buildRepositoryIndex } from '@specbridge/context';
import type { ContextProjection, WorkUnit } from '@specbridge/orchestration';
import {
  SECONDARY_BUILDER_RESULT_SCHEMA_VERSION,
  compileSecondaryBuilderPacket,
  contextProjectionSchema,
  contractSnapshotHashOf,
  executeSecondaryObjectiveBuilder,
  workUnitSchema,
} from '@specbridge/orchestration';
import { emptyTempDir } from '../helpers.js';
import { setupExecutionFixture } from '../helpers-execution.js';

const NOW = '2026-08-30T00:00:00.000Z';

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

function index(root: string, protectedPaths: readonly string[] = []): RepositoryContextIndex {
  return new RepositoryContextIndex(
    buildRepositoryIndex({ rootDir: root, now: NOW, protectedPaths, respectGitignore: true }),
  );
}

function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return workUnitSchema.parse({
    workUnitId: 'wu-1',
    objectiveNodeId: 'node-1',
    parentTaskId: 'task-1',
    kind: 'build',
    title: 'Update FooMapper',
    goal: 'Update FooMapper deterministically.',
    dependsOn: [],
    expectedArtifacts: ['src/foo-mapper.ts'],
    relevantContractIds: [],
    relevantAdrIds: [],
    relevantConstitutionRuleIds: [],
    expectedAreas: ['src'],
    status: 'READY',
    attempt: 0,
    ...overrides,
  });
}

function projection(workUnit: WorkUnit): ContextProjection {
  const body = {
    schemaVersion: '1.0.0',
    projectionId: `${workUnit.workUnitId}-a01`,
    jobId: 'job-1',
    objectiveNodeId: workUnit.objectiveNodeId,
    workUnitId: workUnit.workUnitId,
    attempt: 1,
    createdAt: NOW,
    constitution: { version: 1, rules: [] },
    objective: {
      taskId: workUnit.parentTaskId,
      title: workUnit.title,
      acceptance: ['The mapper follows the approved DTO contract.'],
    },
    workUnit: {
      title: workUnit.title,
      goal: workUnit.goal,
      kind: workUnit.kind,
      expectedArtifacts: workUnit.expectedArtifacts,
      expectedAreas: workUnit.expectedAreas,
    },
    contracts: [],
    adrs: [],
    decisions: [],
    specExcerpts: [],
    workEvidence: [],
    contractSnapshotHash: contractSnapshotHashOf([], 1),
  };
  return contextProjectionSchema.parse({ ...body, contentHash: sha256Hex(JSON.stringify(body)) });
}

function compilerInput(
  root: string,
  workUnit: WorkUnit,
  repositoryIndex = index(root),
  overrides: Partial<Parameters<typeof compileSecondaryBuilderPacket>[0]> = {},
) {
  const fixture = setupExecutionFixture();
  return {
    workspace: fixture.workspace,
    config: fixture.config,
    jobId: 'job-1',
    objectiveNodeId: workUnit.objectiveNodeId,
    workUnit,
    projection: projection(workUnit),
    attempt: 1,
    worktreeRoot: root,
    repositories: [
      {
        repositoryId: 'primary',
        rootDir: root,
        index: repositoryIndex,
        indexReused: true,
      },
    ],
    verificationHints: ['targeted-test'],
    createdAt: NOW,
    persist: false,
    ...overrides,
  };
}

describe('Phase 5 Builder Packet compiler', () => {
  it('retrieves an explicit target, paired test, direct dependency, and bounded reference pattern', async () => {
    const root = emptyTempDir();
    writeFiles(root, {
      'src/foo-mapper.ts':
        "import { FooRepository } from './foo-repository.js';\nexport class FooMapper { map() { return FooRepository.name; } }\n",
      'src/foo-repository.ts': 'export class FooRepository { static name = "repo"; }\n',
      'src/existing-bar-mapper.ts': 'export class ExistingBarMapper { map() { return "bar"; } }\n',
      'src/foo-service.ts': 'export class FooService {}\n',
      'tests/foo-mapper.test.ts':
        "import { FooMapper } from '../src/foo-mapper.js';\ntest('maps', () => expect(new FooMapper().map()).toBe('repo'));\n",
    });
    const result = await compileSecondaryBuilderPacket(
      compilerInput(root, unit(), index(root), {
        dependencyContext: [
          {
            workUnitId: 'wu-dependency',
            summary: 'Verified repository interface used by the mapper.',
            changedFiles: [{ path: 'src/foo-repository.ts' }],
            verificationPassed: true,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.packet.targets.map((target) => target.path)).toEqual(['src/foo-mapper.ts']);
    expect(result.packet.sourceContext.map((entry) => entry.path)).toContain('src/foo-repository.ts');
    expect(result.packet.tests.map((entry) => entry.path)).toContain('tests/foo-mapper.test.ts');
    expect(result.packet.referencePatterns.map((entry) => entry.path)).toContain(
      'src/existing-bar-mapper.ts',
    );
    expect(result.packet.dependencyContext).toMatchObject([
      { workUnitId: 'wu-dependency', verificationPassed: true },
    ]);
    expect(result.packet.sourceContext.filter((entry) => entry.path === 'src/foo-service.ts')).toEqual([]);
    for (const entry of [
      ...result.packet.sourceContext,
      ...result.packet.tests,
      ...result.packet.referencePatterns,
    ]) {
      expect(entry).toMatchObject({ repositoryId: 'primary' });
      expect(entry.reason).toBeTruthy();
      expect(entry.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sectionHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('discovers conventional Java FooMapperTest-style test names', async () => {
    const root = emptyTempDir();
    writeFiles(root, {
      'src/FooMapper.java': 'public class FooMapper { public int map() { return 1; } }\n',
      'tests/FooMapperTest.java': 'public class FooMapperTest { void maps() { new FooMapper().map(); } }\n',
    });
    const workUnit = unit({
      title: 'Update FooMapper',
      goal: 'Update FooMapper deterministically.',
      expectedArtifacts: ['src/FooMapper.java'],
    });
    const result = await compileSecondaryBuilderPacket(compilerInput(root, workUnit));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.packet.tests.map((entry) => entry.path)).toContain('tests/FooMapperTest.java');
  });

  it('materializes current worktree bytes when a reusable index entry is stale', async () => {
    const root = emptyTempDir();
    writeFiles(root, { 'src/foo-mapper.ts': 'export class FooMapper { old = true; }\n' });
    const stale = index(root);
    writeFiles(root, { 'src/foo-mapper.ts': 'export class FooMapper { current = true; }\n' });
    const result = await compileSecondaryBuilderPacket(compilerInput(root, unit(), stale));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.packet.sourceContext[0]?.content).toContain('current = true');
    expect(result.packet.sourceContext[0]?.contentHash).toBe(
      sha256Hex(readFileSync(path.join(root, 'src/foo-mapper.ts'), 'utf8')),
    );
    expect(result.metrics.staleEntriesEncountered).toBeGreaterThan(0);
  });

  it('uses bounded prior failure paths as strong retrieval evidence', async () => {
    const root = emptyTempDir();
    writeFiles(root, {
      'src/foo-mapper.ts': 'export class FooMapper { map() { return 1; } }\n',
      'src/other.ts': 'export const other = true;\n',
    });
    const result = await compileSecondaryBuilderPacket(
      compilerInput(root, unit(), index(root), {
        priorFailureEvidence: [
          'TypeScript compiler error at src/foo-mapper.ts:1: FooMapper.map returned the wrong type.',
          'x'.repeat(3_000),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const target = result.packet.sourceContext.find((entry) => entry.path === 'src/foo-mapper.ts');
    expect(target?.reason).toBe('EXPLICIT_FAILURE_REFERENCE');
    expect(target?.startLine).toBeUndefined();
    expect(result.packet.priorFailureEvidence).toHaveLength(2);
    expect(result.packet.priorFailureEvidence[1]).toHaveLength(2_000);
  });

  it('reports a missing explicit target honestly', async () => {
    const root = emptyTempDir();
    writeFiles(root, { 'src/other.ts': 'export const other = true;\n' });
    const workUnit = unit({
      goal: 'Update MissingMapper in place.',
      expectedArtifacts: ['src/missing-mapper.ts'],
    });
    const result = await compileSecondaryBuilderPacket(compilerInput(root, workUnit));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('INSUFFICIENT_CONTEXT');
    expect(result.failure.reasons.join(' ')).toContain('missing-mapper.ts');
  });

  it('never materializes a protected matching target', async () => {
    const root = emptyTempDir();
    writeFiles(root, {
      'protected/secret-mapper.ts': 'export class SecretMapper { token = "credential"; }\n',
      'src/safe.ts': 'export const safe = true;\n',
    });
    const workUnit = unit({
      title: 'Update SecretMapper',
      goal: 'Update SecretMapper in place.',
      expectedArtifacts: ['protected/secret-mapper.ts'],
      expectedAreas: ['protected'],
    });
    const result = await compileSecondaryBuilderPacket(
      compilerInput(root, workUnit, index(root, ['protected'])),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('INSUFFICIENT_CONTEXT');
    expect(result.plans.flatMap((plan) => plan.selectedWorkingItems)).toEqual([]);
  });

  it('reports an ambiguous symbol instead of choosing an arbitrary module', async () => {
    const root = emptyTempDir();
    writeFiles(root, {
      'alpha/user-service.ts': 'export class UserService {}\n',
      'beta/user-service.ts': 'export class UserService {}\n',
    });
    const workUnit = unit({
      title: 'Update UserService',
      goal: 'Change UserService behavior.',
      expectedArtifacts: [],
      expectedAreas: [],
    });
    const result = await compileSecondaryBuilderPacket(compilerInput(root, workUnit));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('AMBIGUOUS_TARGET');
    expect(result.quality.targetAmbiguity).toBe(true);
  });

  it('keeps the target and tests under budget pressure and sections a large target', async () => {
    const root = emptyTempDir();
    const large = [
      "import { helper } from './helper.js';",
      ...Array.from({ length: 300 }, (_, index) => `export const noise${index} = ${index};`),
      'export class FooMapper { map() { return helper(); } }',
      ...Array.from({ length: 300 }, (_, index) => `export const tail${index} = ${index};`),
    ].join('\n');
    writeFiles(root, {
      'src/foo-mapper.ts': large,
      'src/helper.ts': 'export const helper = () => 1;\n',
      'tests/foo-mapper.test.ts': "import '../src/foo-mapper.js';\ntest('mapper', () => {});\n",
      ...Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [
          `src/unrelated-${index}.ts`,
          `export class Unrelated${index} {}\n`,
        ]),
      ),
    });
    const result = await compileSecondaryBuilderPacket(
      compilerInput(root, unit(), index(root), {
        budget: {
          maxSelectedFiles: 3,
          maxTests: 1,
          maxReferencePatterns: 0,
          maxSourceCharacters: 8_000,
          maxCharactersPerSection: 2_000,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const target = result.packet.sourceContext.find((entry) => entry.path === 'src/foo-mapper.ts');
    expect(target?.startLine).toBeDefined();
    expect(target?.content.length).toBeLessThan(large.length);
    expect(result.packet.tests).toHaveLength(1);
    expect(result.metrics.selectedFiles).toBeLessThanOrEqual(3);
    expect(result.metrics.indexedFilesConsidered).toBeGreaterThan(80);
    expect(result.metrics.indexReused).toBe(true);
  });

  it('produces a stable semantic hash and changes it when selected source changes', async () => {
    const root = emptyTempDir();
    writeFiles(root, { 'src/foo-mapper.ts': 'export class FooMapper { value = 1; }\n' });
    const workUnit = unit();
    const first = await compileSecondaryBuilderPacket(
      compilerInput(root, workUnit, index(root), { createdAt: '2026-08-30T01:00:00.000Z' }),
    );
    const second = await compileSecondaryBuilderPacket(
      compilerInput(root, workUnit, index(root), { createdAt: '2026-08-30T02:00:00.000Z' }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.packet.contentHash).toBe(second.packet.contentHash);
    writeFiles(root, { 'src/foo-mapper.ts': 'export class FooMapper { value = 2; }\n' });
    const third = await compileSecondaryBuilderPacket(compilerInput(root, workUnit, index(root)));
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.packet.contentHash).not.toBe(first.packet.contentHash);
  });

  it('preserves repository identity for a bounded cross-repo WorkUnit', async () => {
    const backend = emptyTempDir();
    const frontend = emptyTempDir();
    writeFiles(backend, { 'src/client.ts': 'export class BackendApiClient {}\n' });
    writeFiles(frontend, { 'src/client.ts': 'export class FrontendApiClient {}\n' });
    const workUnit = unit({
      title: 'Update BackendApiClient and FrontendApiClient',
      goal: 'Keep BackendApiClient and FrontendApiClient compatible.',
      expectedArtifacts: [],
      expectedAreas: ['backend', 'frontend'],
    });
    const base = compilerInput(backend, workUnit);
    const result = await compileSecondaryBuilderPacket({
      ...base,
      repositories: [
        { repositoryId: 'backend', rootDir: backend, index: index(backend), indexReused: true },
        {
          repositoryId: 'frontend',
          rootDir: frontend,
          index: index(frontend),
          indexReused: true,
          justification: 'The approved WorkUnit spans the API and its client.',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.packet.targets.map((target) => `${target.repositoryId}:${target.path}`).sort()).toEqual([
      'backend:src/client.ts',
      'frontend:src/client.ts',
    ]);
    expect(result.planRefs).toHaveLength(2);
  });

  it('applies the selected-file ceiling globally across repositories', async () => {
    const backend = emptyTempDir();
    const frontend = emptyTempDir();
    writeFiles(backend, { 'src/client.ts': 'export class BackendApiClient {}\n' });
    writeFiles(frontend, { 'src/client.ts': 'export class FrontendApiClient {}\n' });
    const workUnit = unit({
      title: 'Update BackendApiClient and FrontendApiClient',
      goal: 'Keep BackendApiClient and FrontendApiClient compatible.',
      expectedArtifacts: [],
      expectedAreas: ['backend', 'frontend'],
    });
    const base = compilerInput(backend, workUnit);
    const result = await compileSecondaryBuilderPacket({
      ...base,
      budget: { maxSelectedFiles: 1 },
      repositories: [
        { repositoryId: 'backend', rootDir: backend, index: index(backend) },
        {
          repositoryId: 'frontend',
          rootDir: frontend,
          index: index(frontend),
          justification: 'The approved WorkUnit spans the API and its client.',
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.metrics.selectedFiles).toBe(1);
    if (result.ok) return;
    expect(result.failure.kind).toBe('INSUFFICIENT_CONTEXT');
  });

  it('reports a packet that cannot fit the configured input ceiling as insufficient', async () => {
    const root = emptyTempDir();
    writeFiles(root, { 'src/foo-mapper.ts': 'export class FooMapper { map() { return 1; } }\n' });
    const result = await compileSecondaryBuilderPacket(
      compilerInput(root, unit(), index(root), { maximumInputCharacters: 1_000 }),
    );
    expect(result.ok).toBe(false);
    expect(result.quality.contextSufficient).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('INSUFFICIENT_CONTEXT');
    expect(result.failure.reasons.join(' ')).toContain('could not fit within policy');
  });

  it('treats NEEDS_MORE_CONTEXT as a non-candidate outcome with no writes', async () => {
    const root = emptyTempDir();
    writeFiles(root, { 'src/foo-mapper.ts': 'export class FooMapper {}\n' });
    const compiled = await compileSecondaryBuilderPacket(compilerInput(root, unit()));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const execution = await executeSecondaryObjectiveBuilder({
      worktreeRoot: root,
      packet: compiled.packet,
      inference: {
        profile: 'fake',
        provider: 'fake',
        async infer() {
          return {
            ok: true,
            text: JSON.stringify({
              schemaVersion: SECONDARY_BUILDER_RESULT_SCHEMA_VERSION,
              status: 'NEEDS_MORE_CONTEXT',
              summary: 'The required interface is missing.',
              edits: [],
              needsMoreContextReasons: ['The target interface declaration is absent.'],
            }),
            durationMs: 1,
          };
        },
      },
      maximumInputCharacters: 524_288,
      maxOutputBytes: 1_048_576,
    });
    expect(execution.ok).toBe(false);
    if (execution.ok) return;
    expect(execution.failure.kind).toBe('INSUFFICIENT_CONTEXT');
    expect(readFileSync(path.join(root, 'src/foo-mapper.ts'), 'utf8')).toBe(
      'export class FooMapper {}\n',
    );
  });
});
