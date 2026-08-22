import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adaptiveProfileFile,
  auditJobState,
  buildJobGraph,
  clearAdaptiveProfileCache,
  clearRepositoryIndexCache,
  createJob,
  ensureRepositoryIndex,
  listTaskAttempts,
  loadAdaptiveProfiles,
  readAdaptiveProfileCache,
  readRepositoryIndexCache,
  rebuildAdaptiveProfiles,
  recordScenarioResult,
  repositoryIndexFile,
  requireGraphRevision,
  requireJobState,
  startQualificationRun,
} from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';
import { fixtureTarget, setupQualificationWorkspace } from '../helpers-qualification.js';

/**
 * vNext.9 — derived caches are disposable.
 *
 * The invariant both scenarios here prove is the same one, stated twice
 * because the two caches fail differently:
 *
 *   .specbridge/cache/ is NEVER canonical.
 *   Deleting it costs a rebuild and nothing else.
 *   Corrupting it costs a rebuild and nothing else.
 *   A job never blocks on either.
 *
 * The reason this needs its own qualification scenario rather than only a
 * unit test is the failure mode it guards against: derived-cache corruption
 * mistaken for canonical state loss. A runtime that treated a bad cache file
 * as a durability incident would look, in a release report, exactly like one
 * that had genuinely lost a Mission.
 */

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function writeSource(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

describe('vNext.9 derived cache loss', () => {
  it('rebuilds the repository context index after deletion and after corruption, losing nothing canonical', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    writeSource(
      fixture.root,
      'src/settings/store.ts',
      'export class SettingsStore {\n  save(): void {}\n}\n',
    );
    writeSource(fixture.root, 'src/settings/index.ts', "export * from './store.js';\n");
    git(fixture.root, 'add', '-A');
    git(fixture.root, 'commit', '-q', '-m', 'test: derived cache fixture');

    const deps = {
      workspace: fixture.workspace,
      config: fixture.config,
      clock: fixture.clock,
      idFactory: fixture.deps.idFactory,
      host: 'test',
    };
    const job = createJob(deps, { specName: fixture.specName, goal: 'Implement the plan.' });
    await buildJobGraph(deps, job.jobId);
    const jobId = job.jobId;

    // ---- Build the index once -------------------------------------------
    const built = ensureRepositoryIndex({
      workspace: fixture.workspace,
      config: fixture.config,
      now: fixture.clock().toISOString(),
    });
    expect(built.index.size).toBeGreaterThan(0);
    expect(existsSync(repositoryIndexFile(fixture.workspace))).toBe(true);

    const canonicalBefore = auditJobState({ workspace: fixture.workspace, jobId });
    const attemptsBefore = listTaskAttempts(fixture.workspace, jobId).length;
    const graphBefore = requireGraphRevision(
      fixture.workspace,
      jobId,
      requireJobState(fixture.workspace, jobId).graphRevision,
    );

    // ---- Fault: delete the derived index entirely ------------------------
    clearRepositoryIndexCache(fixture.workspace);
    expect(existsSync(repositoryIndexFile(fixture.workspace))).toBe(false);
    expect(readRepositoryIndexCache(fixture.workspace)).toBeUndefined();

    const afterDelete = ensureRepositoryIndex({
      workspace: fixture.workspace,
      config: fixture.config,
      now: fixture.clock().toISOString(),
    });
    expect(afterDelete.index.size).toBe(built.index.size);
    expect(afterDelete.rebuilt).toBe(true);

    // Canonical state is untouched: the same nodes, the same attempts, the
    // same invariants. A rebuild is a cost, not an incident.
    const canonicalAfterDelete = auditJobState({ workspace: fixture.workspace, jobId });
    expect(canonicalAfterDelete.violations).toEqual(canonicalBefore.violations);
    expect(listTaskAttempts(fixture.workspace, jobId).length).toBe(attemptsBefore);

    // ---- Fault: corrupt the derived index --------------------------------
    writeFileSync(repositoryIndexFile(fixture.workspace), '{ not json at all', 'utf8');
    // An unparseable cache reads as absent, never as a crash.
    expect(readRepositoryIndexCache(fixture.workspace)).toBeUndefined();

    const afterCorrupt = ensureRepositoryIndex({
      workspace: fixture.workspace,
      config: fixture.config,
      now: fixture.clock().toISOString(),
    });
    expect(afterCorrupt.index.size).toBe(built.index.size);

    const canonicalAfterCorrupt = auditJobState({ workspace: fixture.workspace, jobId });
    expect(canonicalAfterCorrupt.violations).toEqual(canonicalBefore.violations);
    const graphAfter = requireGraphRevision(
      fixture.workspace,
      jobId,
      requireJobState(fixture.workspace, jobId).graphRevision,
    );
    expect(graphAfter.nodes.map((node) => node.nodeId)).toEqual(
      graphBefore.nodes.map((node) => node.nodeId),
    );

    // ---- Record the scenario --------------------------------------------
    const qualification = setupQualificationWorkspace();
    const run = startQualificationRun(qualification.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(qualification.deps, {
      runId: run.runId,
      scenarioId: 'context.index-cache-rebuild',
      status: 'PASS',
      executor: 'regression-suite',
      observedTransitions: [
        { subject: 'index deleted', from: 'present', to: 'rebuilt with identical size' },
        { subject: 'index corrupted', from: 'unparseable', to: 'rebuilt with identical size' },
        { subject: 'canonical invariant violations', from: '0', to: '0' },
      ],
      evidenceRefs: [`job:${jobId}`],
      resourceAttribution: { REPOSITORY_CONTEXT_INDEX: 'SIMULATED' },
    });
    expect(run.runId).toBeTruthy();
  });

  it('rebuilds adaptive profiles from the ledger after deletion, and falls back safely when there is nothing to rebuild from', () => {
    const fixture = setupOrchestrationFixture({ git: false });

    // ---- Fault: no cache at all -----------------------------------------
    clearAdaptiveProfileCache(fixture.workspace);
    expect(readAdaptiveProfileCache(fixture.workspace)).toBeUndefined();

    // With no history, loading must produce a safe cold-start result rather
    // than an error — a job never blocks on derived analytics.
    const cold = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: fixture.config.orchestration.jobs.scheduler.adaptive,
      now: fixture.clock(),
    });
    expect(cold.profiles).toBeDefined();
    expect(cold.observations).toEqual([]);
    expect(cold.invalidatedReason).toBe('absent');

    // ---- Fault: a corrupt cache -----------------------------------------
    const cacheFile = adaptiveProfileFile(fixture.workspace);
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, '{"schemaVersion":"0.0.1","garbage":true', 'utf8');
    expect(readAdaptiveProfileCache(fixture.workspace)).toBeUndefined();

    const afterCorrupt = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: fixture.config.orchestration.jobs.scheduler.adaptive,
      now: fixture.clock(),
    });
    expect(afterCorrupt.profiles).toBeDefined();

    // ---- Fault: a schema-mismatched cache --------------------------------
    // A schema bump rebuilds rather than migrating: derived analytics are
    // cheaper to recompute than to carry a migration for.
    writeFileSync(
      cacheFile,
      JSON.stringify({ schemaVersion: '99.0.0', builtAt: fixture.clock().toISOString(), targets: [] }),
      'utf8',
    );
    const afterSchemaBump = loadAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: fixture.config.orchestration.jobs.scheduler.adaptive,
      now: fixture.clock(),
    });
    expect(afterSchemaBump.profiles).toBeDefined();

    // ---- An explicit rebuild is always available -------------------------
    const rebuilt = rebuildAdaptiveProfiles({
      workspace: fixture.workspace,
      policy: fixture.config.orchestration.jobs.scheduler.adaptive,
      now: fixture.clock(),
    });
    expect(rebuilt.profiles).toBeDefined();
    // Deleting the rebuilt cache again costs nothing but another rebuild.
    clearAdaptiveProfileCache(fixture.workspace);
    expect(readAdaptiveProfileCache(fixture.workspace)).toBeUndefined();

    const qualification = setupQualificationWorkspace();
    const run = startQualificationRun(qualification.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(qualification.deps, {
      runId: run.runId,
      scenarioId: 'adaptive.cache-rebuild',
      status: 'PASS',
      executor: 'regression-suite',
      observedTransitions: [
        { subject: 'absent cache', from: 'missing', to: 'safe cold-start profiles' },
        { subject: 'corrupt cache', from: 'unparseable', to: 'rebuilt' },
        { subject: 'schema-mismatched cache', from: 'version 99.0.0', to: 'rebuilt' },
      ],
      resourceAttribution: { ADAPTIVE_PROFILES: 'SIMULATED' },
    });
    expect(run.runId).toBeTruthy();
  });
});
