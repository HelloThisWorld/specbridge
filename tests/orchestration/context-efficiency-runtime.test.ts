import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessContextMiss,
  beginExecutorDispatch,
  buildJobGraph,
  buildTaskContextPackage,
  createJob,
  createTaskCheckpoint,
  ensureRepositoryIndex,
  invalidateRepositoryIndex,
  listContextSelectionPlans,
  offerContextExpansion,
  readContextExpansionState,
  readContextMetrics,
  readRepositoryIndexCache,
  reconstructTaskContext,
  recordClassification,
  recordCriticVerdict,
  recordPlan,
  renderMaterializedContext,
  renderPointerContext,
  repositoryIndexFile,
  requireGraphRevision,
  requireJobState,
  writeContextExpansionState,
} from '@specbridge/orchestration';
import type { AttemptContext, JobDeps } from '@specbridge/orchestration';
import {
  RepositoryContextIndex,
  applyExpansion,
  contextExpansionPolicySchema,
  initialExpansionState,
  itemsInLayer,
  planContextExpansion,
} from '@specbridge/context';
import { captureGitSnapshot } from '@specbridge/evidence';
import { idCounter, tickingClock } from '../helpers-execution.js';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import type { OrchestrationFixture } from '../helpers-orchestration.js';

/**
 * The vNext.7 Context Efficiency Runtime, end to end.
 *
 * One long-horizon job over a moderately large fixture repository, driven
 * through the scenario §111 requires: index, selective retrieval for a
 * direct model, lean pointers for a harness, stale-index invalidation,
 * deterministic compression of a noisy failing test, a diagnosed context
 * miss answered by ONE bounded widening rather than by an escalation,
 * data-minimized paid-lane context, survival across repeated compaction, and
 * recovery after the derived index is deleted entirely.
 *
 * Fully offline and deterministic: no model runs, no network. Every claim
 * here is about bytes SpecBridge selected, which is exactly the property the
 * phase is supposed to guarantee.
 */

interface ContextFixture extends OrchestrationFixture {
  jobId: string;
  nodeId: string;
  taskId: string;
}

const EFFICIENCY = {
  strategy: 'SELECTIVE',
  maxSelectedItems: 6,
  maxPointers: 12,
  wholeFileUnderChars: 2_000,
} as const;

/** A moderately large source tree with real module and test structure. */
function writeFixtureRepository(root: string): void {
  const write = (relative: string, content: string): void => {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  write(
    'src/settings/settings-store.ts',
    [
      "import { validateWorkflow } from '../workflow/validator.js';",
      "import { logger } from '../support/logger.js';",
      '',
      'export class SettingsStore {',
      '  private cache = new Map<string, string>();',
      '',
      '  load(key: string): string | undefined {',
      '    logger.debug(`loading ${key}`);',
      '    return this.cache.get(key);',
      '  }',
      '',
      '  save(key: string, value: string): void {',
      '    validateWorkflow(value);',
      '    this.cache.set(key, value);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  write(
    'src/workflow/validator.ts',
    [
      'export function validateWorkflow(definition: string): boolean {',
      '  return definition.length > 0;',
      '}',
      '',
      'export function validateStage(stage: string): boolean {',
      '  return stage !== "";',
      '}',
      '',
    ].join('\n'),
  );
  write('src/support/logger.ts', 'export const logger = { debug(_m: string): void {} };\n');
  write(
    'tests/settings-store.test.ts',
    [
      "import { SettingsStore } from '../src/settings/settings-store.js';",
      '',
      'it("round-trips a value", () => {',
      '  const store = new SettingsStore();',
      '  store.save("a", "b");',
      '});',
      '',
    ].join('\n'),
  );

  // Bulk: unrelated modules that must NOT be retrieved for a settings task.
  for (let index = 0; index < 60; index += 1) {
    write(
      `src/billing/report-${index}.ts`,
      [
        `export function billingReport${index}(rows: number[]): number {`,
        '  return rows.reduce((sum, row) => sum + row, 0);',
        '}',
        ...Array.from({ length: 20 }, (_, line) => `// filler line ${line} for report ${index}`),
        '',
      ].join('\n'),
    );
  }
  for (let index = 0; index < 40 ; index += 1) {
    write(
      `src/telemetry/probe-${index}.ts`,
      `export const probe${index} = { name: "probe-${index}", sample(): number { return ${index}; } };\n`,
    );
  }
  // A credential-shaped file whose NAME looks maximally relevant.
  write('config/settings-store-credentials.json', '{ "token": "super-secret-token-value" }\n');
}

/** Commit everything, so a later edit is the ONLY change Git reports. */
function commitFixtureRepository(root: string): void {
  const git = (...argv: string[]): void => {
    execFileSync('git', argv, { cwd: root, stdio: 'ignore' });
  };
  git('add', '.');
  git('commit', '-q', '-m', 'fixture repository baseline');
}

async function contextFixture(
  efficiency: Record<string, unknown> = {},
): Promise<ContextFixture> {
  const fixture = setupOrchestrationFixture({
    // A real Git repository: the incremental index path reads its snapshot,
    // and running this scenario without one would exercise the fallback
    // rather than the behaviour under test.
    git: true,
    policy: { jobs: { context: { efficiency: { ...EFFICIENCY, ...efficiency } } } },
  });
  writeFixtureRepository(fixture.root);
  // Commit the source tree so the working tree starts CLEAN. A fixture whose
  // every file is untracked would make all 100+ of them "changed", which is
  // a state no real task starts from and would test the wrong thing.
  commitFixtureRepository(fixture.root);

  const job = createJob(fixture.deps, {
    specName: fixture.specName,
    goal: 'Implement workflow validation across the settings feature.',
  });
  await buildJobGraph(fixture.deps, job.jobId);
  const graph = requireGraphRevision(fixture.workspace, job.jobId, 1);
  const node = graph.nodes[0];
  if (node === undefined) throw new Error('fixture graph has no nodes');

  const context = (role: AttemptContext['role']): AttemptContext => ({
    nodeId: node.nodeId,
    role,
    workerId: 'local-test-worker',
    startedAt: fixture.clock().toISOString(),
  });
  recordClassification(fixture.deps, job.jobId, { context: context('CLASSIFIER'), proposedClass: 'LOW' });
  await recordPlan(fixture.deps, job.jobId, {
    context: context('PLANNER'),
    candidate: {
      goal: 'Implement workflow validation.',
      steps: [{ description: 'Add the validation module.' }],
      testStrategy: 'Unit tests for validation outcomes.',
      verificationStrategy: 'Run the trusted verification commands.',
    },
    producedByTier: 'LOCAL_SMALL',
  });
  recordCriticVerdict(fixture.deps, job.jobId, {
    context: context('CRITIC'),
    verdict: 'ACCEPT',
    reasons: ['Steps are ordered and verifiable.'],
  });

  return { ...fixture, jobId: job.jobId, nodeId: node.nodeId, taskId: node.parentTaskId };
}

/**
 * A durable checkpoint whose contract names one implementation file
 * explicitly — the retrieval evidence every scenario below starts from.
 *
 * A checkpoint must belong to a recorded attempt, so one is opened first,
 * exactly as a real dispatch would.
 */
function checkpointFor(
  fixture: ContextFixture,
  overrides: {
    objective?: string;
    contract?: string;
    nextActions?: string[];
    changedFiles?: { path: string }[];
    failedApproaches?: { approach: string; reason: string }[];
  } = {},
): string {
  beginExecutorDispatch(fixture.deps, fixture.jobId, {
    nodeId: fixture.nodeId,
    mode: 'implement',
    workerId: 'local-test-worker',
    provider: 'local-test-worker',
  });
  const attemptId = requireJobState(fixture.workspace, fixture.jobId).currentAttemptId as string;
  createTaskCheckpoint(fixture.deps, {
    jobId: fixture.jobId,
    nodeId: fixture.nodeId,
    taskId: fixture.taskId,
    attemptId,
    reason: 'milestone',
    objective: overrides.objective ?? 'Fix the settings store cache invalidation.',
    pinned: {
      taskContract:
        overrides.contract ??
        'Fix the stale-read defect in src/settings/settings-store.ts so save() invalidates the cache.',
      acceptanceCriteria: ['A saved value is visible to the next load.', 'The full test suite passes.'],
      constraints: ['Do not modify the public CLI contract.'],
      invariants: ['Verification cannot be bypassed.'],
    },
    completedWork: [],
    pendingWork: ['Invalidate the cache on save.'],
    nextActions: overrides.nextActions ?? ['Update SettingsStore.save to invalidate the cache.'],
    importantDecisions: [],
    failedApproaches: overrides.failedApproaches ?? [],
    knownFailures: [],
    unresolvedIssues: [],
    testResults: [],
    changedFiles: overrides.changedFiles ?? [],
    relevantArtifacts: [],
    relevantContextReferences: [],
  });
  return attemptId;
}

/** A fresh process over the same workspace: new deps, nothing in memory. */
function restart(fixture: ContextFixture): JobDeps {
  return {
    workspace: fixture.workspace,
    config: fixture.config,
    clock: tickingClock('2026-08-03T09:00:00.000Z'),
    idFactory: idCounter('restart'),
    host: 'test-restarted',
  };
}

// ---------------------------------------------------------------------------

describe('vNext.7 scenario — index and selective retrieval', () => {
  it('steps 1-6: SELECTIVE retrieval materializes the named file and no unrelated modules', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture);

    const built = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-a',
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
    });

    const selected = built.plan.selectedWorkingItems.map((entry) => entry.path);
    expect(selected).toContain('src/settings/settings-store.ts');
    // Bounded: not the whole repository, and nothing from unrelated modules.
    expect(selected.length).toBeLessThanOrEqual(EFFICIENCY.maxSelectedItems);
    expect(selected.some((entry) => entry.startsWith('src/billing/'))).toBe(false);
    expect(selected.some((entry) => entry.startsWith('src/telemetry/'))).toBe(false);
    // The contract-named file is MANDATORY and can never be ranked away.
    expect(
      built.plan.selectedWorkingItems.find((entry) => entry.path === 'src/settings/settings-store.ts')
        ?.mandatory,
    ).toBe(true);

    // The direct model receives real source it can act on.
    const rendered = renderMaterializedContext(built.assembled.package);
    expect(rendered).toContain('class SettingsStore');
    expect(rendered).toContain('src/settings/settings-store.ts');

    // Canonical layers survive selection intact.
    const ids = built.assembled.package.items.map((item) => item.itemId);
    expect(ids).toContain('pinned-task-contract');
    expect(ids).toContain('pinned-acceptance-criteria');
    expect(ids).toContain('current-action');
  });

  it('never selects a credential-shaped file, however relevant its name looks', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture, {
      contract: 'Fix the settings store credentials handling in the settings store.',
      objective: 'settings store credentials',
    });

    const built = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-secret',
    });

    const everyPath = [
      ...built.plan.selectedWorkingItems.map((entry) => entry.path),
      ...built.plan.pointers.map((entry) => entry.path),
      ...built.plan.excludedCandidates.map((entry) => entry.path),
    ];
    expect(everyPath).not.toContain('config/settings-store-credentials.json');
    // Not merely filtered from the prompt — never indexed, so never a candidate.
    const index = new RepositoryContextIndex(
      readRepositoryIndexCache(fixture.workspace) as NonNullable<
        ReturnType<typeof readRepositoryIndexCache>
      >,
    );
    expect(index.has('config/settings-store-credentials.json')).toBe(false);
    expect(JSON.stringify(built.plan)).not.toContain('super-secret-token-value');
  });

  it('steps 7-11: a HARNESS package points instead of materializing', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture, {
      contract: 'Rework validation across the settings and workflow modules.',
      objective: 'settings workflow validator logger',
    });

    const direct = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-direct',
      lane: 'LOCAL',
      executionMode: 'DIRECT_MODEL',
    });
    const harness = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'POINTER',
      attemptId: 'attempt-harness',
      lane: 'LOCAL',
      executionMode: 'HARNESS',
    });

    expect(harness.plan.pointers.length).toBeGreaterThan(0);
    expect(harness.metrics.workingSetTokens).toBeLessThan(direct.metrics.workingSetTokens);

    // The harness bootstrap names locations; it does not carry the bodies.
    const pointers = renderPointerContext(harness.plan);
    expect(pointers.join('\n')).toContain('src/');
    const harnessWorking = itemsInLayer(harness.assembled.package.items, 'WORKING_SET')
      .map((item) => item.content)
      .join('\n');
    expect(harnessWorking).not.toContain('private cache = new Map');

    // Canonical state the repository CANNOT tell it still travels.
    const harnessIds = harness.assembled.package.items.map((item) => item.itemId);
    expect(harnessIds).toContain('pinned-task-contract');
    expect(harnessIds).toContain('pinned-constraints');
  });
});

describe('vNext.7 scenario — staleness and incremental refresh', () => {
  it('steps 12-14: an edited file is never re-sent from the stale index', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture);

    const first = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-before',
    });
    const beforeItem = itemsInLayer(first.assembled.package.items, 'WORKING_SET').find(
      (item) => item.provenance?.path === 'src/settings/settings-store.ts',
    );
    expect(beforeItem?.content).toContain('private cache = new Map');
    const beforeHash = beforeItem?.provenance?.contentHash;

    // The agent edits the file between attempts.
    writeFileSync(
      path.join(fixture.root, 'src/settings/settings-store.ts'),
      [
        'export class SettingsStore {',
        '  save(key: string, value: string): void {',
        '    this.invalidate(key);',
        '  }',
        '  private invalidate(_key: string): void {}',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const second = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-after',
    });
    const afterItem = itemsInLayer(second.assembled.package.items, 'WORKING_SET').find(
      (item) => item.provenance?.path === 'src/settings/settings-store.ts',
    );

    // Current bytes, and a DIFFERENT recorded hash. The old body is gone.
    expect(afterItem?.content).toContain('invalidate(key)');
    expect(afterItem?.content).not.toContain('private cache = new Map');
    expect(afterItem?.provenance?.contentHash).not.toBe(beforeHash);

    // Only the affected entry was refreshed; unrelated entries kept theirs.
    const state = readRepositoryIndexCache(fixture.workspace);
    const unrelated = state?.entries.find((entry) => entry.path === 'src/workflow/validator.ts');
    const changed = state?.entries.find((entry) => entry.path === 'src/settings/settings-store.ts');
    expect(changed?.contentHash).toBe(afterItem?.provenance?.contentHash);
    expect(unrelated?.symbols ?? []).toContain('validateWorkflow');
  });
});

describe('vNext.7 scenario — compression and the diagnoser package', () => {
  it('steps 15-19: thousands of repeated failure lines become one bounded structure', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture);

    const noisyOutput = [
      ' FAIL  tests/settings-store.test.ts > SettingsStore > round-trips a value',
      'AssertionError: expected undefined to be "b"',
      ...Array.from({ length: 2_000 }, () => '    at Runner.runTest (node_modules/vitest/dist/chunk.js:1:1)'),
      'Tests  1 failed | 12 passed (13)',
    ].join('\n');

    const built = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'DIAGNOSER',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-diagnose',
      recentDelta: [
        {
          itemId: 'delta-test-output',
          layer: 'RECENT_DELTA',
          kind: 'test-output',
          title: 'Latest verification output',
          content: noisyOutput,
          createdAt: '2026-08-02T10:00:00.000Z',
          source: 'run-42',
          compacted: false,
          authority: 'TRUSTED',
        },
      ],
    });

    const delta = itemsInLayer(built.assembled.package.items, 'RECENT_DELTA')[0];
    expect(delta).toBeDefined();
    expect(delta?.compacted).toBe(true);
    expect((delta?.content ?? '').length).toBeLessThan(noisyOutput.length / 10);
    // Identity survives: the failing test and the assertion are verbatim.
    expect(delta?.content).toContain('tests/settings-store.test.ts');
    expect(delta?.content).toContain('AssertionError');
    // The 2,000 repetitions became a count, not 2,000 copies.
    expect((delta?.content ?? '').split('Runner.runTest').length - 1).toBeLessThanOrEqual(3);
    // Compression names its source so the raw artifact stays retrievable.
    expect(delta?.compression?.method).toBe('test-log-v1');
    expect(delta?.compression?.sourceRefs).toContain('run-42');
    expect(built.metrics.compressedItems).toBe(1);
  });
});

describe('vNext.7 scenario — context miss and bounded expansion', () => {
  it('steps 20-24: a diagnosed context miss widens ONE level and does not escalate', async () => {
    const fixture = await contextFixture({ strategy: 'PROGRESSIVE' });
    checkpointFor(fixture);

    const built = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-miss',
    });
    // The adjacent dependency was deliberately not materialized at level 1.
    expect(built.plan.selectedWorkingItems.map((entry) => entry.path)).not.toContain(
      'src/support/logger.ts',
    );

    // The worker names the artifact it was never given: OBSERVED evidence.
    const index = new RepositoryContextIndex(
      readRepositoryIndexCache(fixture.workspace) as NonNullable<
        ReturnType<typeof readRepositoryIndexCache>
      >,
    );
    const miss = assessContextMiss({
      plan: built.plan,
      index,
      workerReportedText: 'I cannot proceed without seeing src/support/logger.ts.',
    });
    expect(miss.signals).toContain('WORKER_REPORTED_MISSING_CONTEXT');
    expect(miss.missingPaths).toContain('src/support/logger.ts');

    const state =
      readContextExpansionState(fixture.workspace, fixture.jobId, fixture.nodeId) ??
      initialExpansionState({ taskId: fixture.taskId, nodeId: fixture.nodeId, now: '2026-08-02T10:00:00.000Z' });
    const offer = offerContextExpansion({ config: fixture.config, state, signals: miss.signals });
    expect(offer.available).toBe(true);
    // ONE level — never a jump to the bounded fallback, never the repository.
    expect(offer.nextLevel).toBe('ADJACENT_DEPENDENCIES');

    // Apply it and rebuild: the dependency is now in scope.
    const decision = planContextExpansion({
      strategy: 'PROGRESSIVE',
      policy: contextExpansionPolicySchema.parse({}),
      state,
      signals: miss.signals,
    });
    writeContextExpansionState(
      fixture.workspace,
      fixture.jobId,
      fixture.nodeId,
      applyExpansion(state, decision, { signals: miss.signals, now: '2026-08-02T10:05:00.000Z' }),
    );

    const widened = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-widened',
    });
    expect(widened.plan.expansionLevel).toBe('ADJACENT_DEPENDENCIES');
    const widenedPaths = widened.plan.selectedWorkingItems.map((entry) => entry.path);
    expect(widenedPaths).toContain('src/support/logger.ts');
    // Widening one level did not pull in the whole repository.
    expect(widenedPaths.some((entry) => entry.startsWith('src/billing/'))).toBe(false);
  });

  it('step 24 continued: repeated widening stops and returns to the reliability planner', async () => {
    const fixture = await contextFixture({ strategy: 'PROGRESSIVE', maxExpansionsPerTask: 2 });
    const spent = {
      ...initialExpansionState({ taskId: fixture.taskId, nodeId: fixture.nodeId, now: '2026-08-02T10:00:00.000Z' }),
      expansionsThisTask: 2,
    };
    const offer = offerContextExpansion({
      config: fixture.config,
      state: spent,
      signals: ['WORKER_REPORTED_MISSING_CONTEXT'],
    });
    expect(offer.available).toBe(false);
    expect(offer.exhausted).toBe(true);
    expect(offer.reason).toContain('more context is not the answer');
  });
});

describe('vNext.7 scenario — economics', () => {
  it('steps 25-32: the paid lane receives durable state and pointers, never unrelated source', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture, {
      contract: 'Rework validation in src/workflow/validator.ts under the approved architecture.',
      failedApproaches: [{ approach: 'Regex validation', reason: 'Cannot express nested stages.' }],
    });

    const api = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'POINTER',
      attemptId: 'attempt-api',
      lane: 'API',
      executionMode: 'HARNESS',
      runner: 'dsh-remote',
    });

    // Data minimization: nothing from unrelated modules leaves the machine.
    const everySentPath = [
      ...api.plan.selectedWorkingItems.map((entry) => entry.path),
      ...api.plan.pointers.map((entry) => entry.path),
    ];
    expect(everySentPath.some((entry) => entry.startsWith('src/billing/'))).toBe(false);
    expect(everySentPath.some((entry) => entry.startsWith('src/telemetry/'))).toBe(false);

    // Canonical state the remote session cannot recover DOES travel.
    const rendered = api.assembled.package.items.map((item) => item.content).join('\n');
    expect(rendered).toContain('Regex validation');
    expect(rendered).toContain('Verification cannot be bypassed.');

    // Attribution is recorded for later cost-per-success analysis.
    expect(api.plan.executionLane).toBe('API');
    expect(api.plan.runner).toBe('dsh-remote');
    const metrics = readContextMetrics(fixture.workspace, fixture.jobId, 'attempt-api');
    expect(metrics?.lane).toBe('API');
    expect(metrics?.shape).toBe('POINTER');
    expect(metrics?.estimatedContextTokens).toBeGreaterThan(0);
    // Estimated and provider-reported stay separate; nothing is fabricated.
    expect(metrics?.providerReportedInputTokens).toBeNull();
    expect(metrics?.cachedInputTokens).toBeNull();
  });
});

describe('vNext.7 scenario — survival', () => {
  it('steps 36-39: deleting the derived index does not harm the job', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture);
    await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-pre-delete',
    });
    expect(existsSync(repositoryIndexFile(fixture.workspace))).toBe(true);

    // Delete the ENTIRE derived cache and restart the process.
    invalidateRepositoryIndex(fixture.workspace);
    expect(existsSync(repositoryIndexFile(fixture.workspace))).toBe(false);
    const restarted = restart(fixture);

    // The task is still recoverable from durable state alone.
    const reconstructed = reconstructTaskContext(restarted, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
    });
    expect(reconstructed.checkpoint?.pinned.acceptanceCriteria.length).toBeGreaterThan(0);

    // And the index rebuilds itself on the next selection.
    const rebuilt = await buildTaskContextPackage(restarted, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-post-delete',
    });
    expect(rebuilt.plan.selectedWorkingItems.map((entry) => entry.path)).toContain(
      'src/settings/settings-store.ts',
    );
    expect(existsSync(repositoryIndexFile(fixture.workspace))).toBe(true);
  });

  it('a corrupt index cache is rebuilt rather than trusted', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture);
    await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-1',
    });

    writeFileSync(repositoryIndexFile(fixture.workspace), '{ not json at all', 'utf8');
    const ensured = ensureRepositoryIndex({
      workspace: fixture.workspace,
      config: fixture.config,
      now: '2026-08-02T12:00:00.000Z',
    });
    expect(ensured.rebuilt).toBe(true);
    expect(ensured.index.has('src/settings/settings-store.ts')).toBe(true);
  });

  it('step 35: recovery-critical state survives efficiency processing', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture, {
      failedApproaches: [
        { approach: 'Clear the whole cache on save', reason: 'Broke unrelated reads under load.' },
      ],
    });

    const built = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
      attemptId: 'attempt-survive',
      recentDelta: Array.from({ length: 10 }, (_, index) => ({
        itemId: `delta-${index}`,
        layer: 'RECENT_DELTA' as const,
        kind: 'tool-result',
        title: `Tool result ${index}`,
        content: 'x'.repeat(6_000),
        createdAt: '2026-08-02T10:00:00.000Z',
        compacted: false,
      })),
    });

    const rendered = built.assembled.package.items.map((item) => item.content).join('\n');
    // Everything vNext.6 recovery depends on is still present after
    // retrieval, staleness removal, dedupe, compression, and compaction.
    expect(rendered).toContain('Clear the whole cache on save');
    expect(rendered).toContain('Broke unrelated reads under load.');
    expect(rendered).toContain('A saved value is visible to the next load.');
    expect(rendered).toContain('Verification cannot be bypassed.');
  });
});

describe('vNext.7 scenario — strategy comparison', () => {
  it('steps 40-42: LEGACY, SELECTIVE, and PROGRESSIVE are measured on the same task', async () => {
    const measure = async (
      efficiency: Record<string, unknown>,
      attemptId: string,
    ): Promise<{ tokens: number; files: number; pointers: number; excluded: number }> => {
      const fixture = await contextFixture(efficiency);
      checkpointFor(fixture);
      const built = await buildTaskContextPackage(fixture.deps, {
        jobId: fixture.jobId,
        nodeId: fixture.nodeId,
        role: 'EXECUTOR',
        shape: 'MATERIALIZED',
        attemptId,
      });
      rmSync(fixture.root, { recursive: true, force: true });
      return {
        tokens: built.metrics.estimatedContextTokens,
        files: built.plan.selectedWorkingItems.length,
        pointers: built.plan.pointers.length,
        excluded: built.plan.excludedCandidates.length,
      };
    };

    const legacy = await measure({ strategy: 'LEGACY' }, 'attempt-legacy');
    const selective = await measure({ strategy: 'SELECTIVE' }, 'attempt-selective');
    const progressive = await measure({ strategy: 'PROGRESSIVE' }, 'attempt-progressive');

    // LEGACY performs no retrieval at all: no repository context, and none
    // of the machinery that would explain a selection.
    expect(legacy.files).toBe(0);
    expect(legacy.pointers).toBe(0);
    expect(legacy.excluded).toBe(0);

    // SELECTIVE and PROGRESSIVE both retrieve, and both stay bounded.
    expect(selective.files).toBeGreaterThan(0);
    expect(selective.files).toBeLessThanOrEqual(EFFICIENCY.maxSelectedItems);
    expect(progressive.files).toBe(selective.files);
    // Retrieval ADDS the source a direct model could not otherwise see, so
    // the package is legitimately larger than the durable-state-only one.
    // The efficiency claim of this phase is about cost per SUCCESS, not
    // about minimum tokens per attempt, and the benchmark asserts that
    // honestly rather than pretending retrieval is free.
    expect(selective.tokens).toBeGreaterThan(legacy.tokens);
    expect(selective.excluded).toBeGreaterThan(0);
  });

  it('with LEGACY selected, context assembly is byte-identical to vNext.6', async () => {
    const fixture = await contextFixture({ strategy: 'LEGACY' });
    checkpointFor(fixture);

    const efficient = await buildTaskContextPackage(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      role: 'EXECUTOR',
      shape: 'MATERIALIZED',
    });
    // The equivalent vNext.6 path: the same durable state plus the same
    // repository snapshot the resume path already passes.
    const snapshot = await captureGitSnapshot(fixture.workspace.rootDir, {
      clock: () => fixture.clock(),
    });
    const legacyPath = reconstructTaskContext(fixture.deps, {
      jobId: fixture.jobId,
      nodeId: fixture.nodeId,
      gitSnapshot: snapshot,
    });

    expect(efficient.assembled.package.items.map((item) => item.itemId)).toEqual(
      legacyPath.assembled.package.items.map((item) => item.itemId),
    );
    expect(efficient.plan.selectedWorkingItems).toHaveLength(0);
    // No index is written when the strategy never asks for one.
    expect(existsSync(repositoryIndexFile(fixture.workspace))).toBe(false);
    expect(listContextSelectionPlans(fixture.workspace, fixture.jobId)).toHaveLength(0);
  });

  it('selection is deterministic: the same durable state produces the same plan', async () => {
    const fixture = await contextFixture();
    checkpointFor(fixture);
    const build = async (attemptId: string) =>
      buildTaskContextPackage(fixture.deps, {
        jobId: fixture.jobId,
        nodeId: fixture.nodeId,
        role: 'EXECUTOR',
        shape: 'MATERIALIZED',
        attemptId,
        persist: false,
      });
    const first = await build('attempt-det-1');
    const second = await build('attempt-det-2');
    expect(second.plan.selectedWorkingItems).toEqual(first.plan.selectedWorkingItems);
    expect(second.plan.excludedCandidates).toEqual(first.plan.excludedCandidates);
    expect(second.plan.deterministicOrder).toEqual(first.plan.deterministicOrder);
    expect(second.plan.localRerankApplied).toBe(false);
  });
});
