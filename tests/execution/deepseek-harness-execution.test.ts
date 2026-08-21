import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerProfileConfig } from '@specbridge/core';
import { deepseekHarnessProfileSchema } from '@specbridge/core';
import {
  DeepSeekHarnessRunner,
  RunnerRegistry,
  runRunnerConformance,
  selectRunner,
} from '@specbridge/runners';
import type { RegisteredRunnerProfile, RunnerConformanceResult } from '@specbridge/runners';
import {
  CONFORMANCE_SPEC_NAME,
  EXECUTION_CONFORMANCE_GROUPS,
  createConformanceWorkspace,
  runApprovedTask,
} from '@specbridge/execution';
import { FAKE_DSH_PATH } from '../helpers-execution.js';

/**
 * Execution-level DeepSeek Harness tests: the SHARED evidence pipeline
 * (pre/post Git snapshots, trusted verification, evidence evaluation,
 * verified-only checkbox completion) running a real fake-DSH subprocess
 * through the real official SDK.
 *
 * The point of every scenario: DSH reports CLAIMS; SpecBridge evidence is
 * the only completion authority.
 */

const PASSTHROUGH = ['FAKE_DSH_SCENARIO', 'FAKE_DSH_SESSIONS_DIR', 'FAKE_DSH_EDIT_PATH', 'FAKE_DSH_LOG'];

afterEach(() => {
  for (const name of PASSTHROUGH) delete process.env[name];
});

function dshProfile(overrides: Record<string, unknown> = {}): RegisteredRunnerProfile {
  const config = deepseekHarnessProfileSchema.parse({
    runner: 'deepseek-harness',
    enabled: true,
    command: { executable: process.execPath, args: [FAKE_DSH_PATH] },
    provider: 'fake-provider',
    model: 'fake-model',
    workspaceBoundary: 'runtime-profile',
    sessionPersistence: 'runtime-managed',
    environmentPassthrough: PASSTHROUGH,
    timeoutMs: 60_000,
    ...overrides,
  });
  return {
    name: 'deepseek-harness',
    config: config as RunnerProfileConfig,
    runner: new DeepSeekHarnessRunner(config),
  };
}

function fixtureRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'specbridge-dsh-exec-'));
}

function groupsOf(result: RunnerConformanceResult): Record<string, { applicable: boolean; passed: boolean }> {
  return Object.fromEntries(
    result.groups.map((group) => [group.group, { applicable: group.applicable, passed: group.passed }]),
  );
}

describe('deepseek-harness through the shared evidence pipeline', () => {
  it('Test C: a real DSH edit completes ONLY because SpecBridge evidence passes', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'success';
    const fixture = createConformanceWorkspace(fixtureRoot(), dshProfile());
    if ('error' in fixture) throw new Error(fixture.error);
    const outcome = await runApprovedTask(
      { workspace: fixture.workspace, config: fixture.config, registry: fixture.registry },
      { specName: CONFORMANCE_SPEC_NAME, next: true, runnerName: 'deepseek-harness' },
    );
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('verified');
    expect(outcome.report.checkboxUpdated).toBe(true);
    // Evidence came from the ACTUAL repository change plus the trusted
    // verification command — not from the agent's claim.
    expect(outcome.report.changedFiles.some((file) => file.path === 'src/fake-dsh-change.txt')).toBe(true);
    expect(outcome.report.verification.ran).toBe(true);
    expect(
      readFileSync(path.join(fixture.workspace.rootDir, 'src', 'fake-dsh-change.txt'), 'utf8'),
    ).toContain('fake dsh implementation');
  }, 120_000);

  it('Test D: a false completion claim does NOT complete the task', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'false-claim';
    const fixture = createConformanceWorkspace(fixtureRoot(), dshProfile());
    if ('error' in fixture) throw new Error(fixture.error);
    const outcome = await runApprovedTask(
      { workspace: fixture.workspace, config: fixture.config, registry: fixture.registry },
      { specName: CONFORMANCE_SPEC_NAME, next: true, runnerName: 'deepseek-harness' },
    );
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    // The agent CLAIMED completed with changed files; the repository is
    // byte-identical, so evidence refuses completion.
    expect(outcome.report.evidenceStatus).toBe('no-change');
    expect(outcome.report.checkboxUpdated).toBe(false);
    expect(existsSync(path.join(fixture.workspace.rootDir, 'src', 'fake-dsh-change.txt'))).toBe(false);
  }, 120_000);

  it('a failed trusted verifier leaves the checkbox unchanged despite a real edit', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'success';
    const fixture = createConformanceWorkspace(fixtureRoot(), dshProfile(), { verificationExit: 1 });
    if ('error' in fixture) throw new Error(fixture.error);
    const outcome = await runApprovedTask(
      { workspace: fixture.workspace, config: fixture.config, registry: fixture.registry },
      { specName: CONFORMANCE_SPEC_NAME, next: true, runnerName: 'deepseek-harness' },
    );
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.report.evidenceStatus).toBe('implemented-unverified');
    expect(outcome.report.checkboxUpdated).toBe(false);
  }, 120_000);

  it('§34: the fake-runtime profile passes every applicable conformance group (never production-confirmed)', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'success';
    const workspaceRoot = fixtureRoot();
    const result = await runRunnerConformance(
      {
        profile: dshProfile(),
        workspaceRoot,
        runDir: path.join(workspaceRoot, '.specbridge-conformance-runs'),
        invocationsAllowed: true,
        timeoutMs: 60_000,
      },
      EXECUTION_CONFORMANCE_GROUPS,
    );
    expect(result.failedChecks).toBe(0);
    const groups = groupsOf(result);
    expect(groups['detection']?.applicable).toBe(true);
    expect(groups['task-execution']?.applicable).toBe(true);
    expect(groups['resume']?.applicable).toBe(true);
    // Authoring groups stay NOT applicable: no enforceable read-only boundary.
    expect(groups['stage-generation']?.applicable).toBe(false);
    expect(groups['stage-refinement']?.applicable).toBe(false);
    // A preview adapter can pass its checks but can never be confirmed
    // production by conformance.
    expect(result.productionConfirmed).toBe(false);
  }, 240_000);

  it('an unattested boundary makes task-execution conformance NOT applicable (fail closed, §Test N)', async () => {
    process.env['FAKE_DSH_SCENARIO'] = 'success';
    const workspaceRoot = fixtureRoot();
    const result = await runRunnerConformance(
      {
        profile: dshProfile({ workspaceBoundary: 'unconfirmed' }),
        workspaceRoot,
        runDir: path.join(workspaceRoot, '.specbridge-conformance-runs'),
        invocationsAllowed: true,
        timeoutMs: 60_000,
      },
      EXECUTION_CONFORMANCE_GROUPS,
    );
    const groups = groupsOf(result);
    expect(groups['task-execution']?.applicable).toBe(false);
    expect(result.failedChecks).toBe(0);
  }, 120_000);
});

describe('deepseek-harness selection discipline (Tests B/O: defaults unchanged)', () => {
  it('is never selected automatically, even when enabled and set as a default', () => {
    const profile = dshProfile();
    const registry = new RunnerRegistry();
    registry.registerProfile(profile);
    const baseConfig = {
      schemaVersion: '2.0.0',
      sourceSchemaVersion: '2.0.0',
      defaultRunner: 'deepseek-harness',
      operationDefaults: { stageGeneration: null, stageRefinement: null, taskExecution: null },
      runnerProfiles: { 'deepseek-harness': profile.config },
      runnerPolicy: {
        allowAutomaticFallback: false,
        allowNetworkRunners: true,
        requireExplicitRunnerForNetworkAccess: true,
        requireExplicitRunnerForPaidApi: true,
      },
      fallbacks: { stageGeneration: [], stageRefinement: [] },
    };

    // Global default (implicit origin): refused — preview is explicit-only.
    const implicit = selectRunner(registry, baseConfig as never, { operation: 'task-execution' });
    expect(implicit.ok).toBe(false);
    if (!implicit.ok) {
      expect(implicit.failure.error.code).toBe('runner_incompatible');
      expect(implicit.failure.error.message).toContain('never selected automatically');
    }

    // Explicit `--runner deepseek-harness`: allowed.
    const explicit = selectRunner(registry, baseConfig as never, {
      operation: 'task-execution',
      explicitProfile: 'deepseek-harness',
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      expect(explicit.plan.supportLevel).toBe('preview');
      expect(explicit.plan.runner).toBe('deepseek-harness');
    }

    // Authoring is unsupported even explicitly (capability-gated).
    const authoring = selectRunner(registry, baseConfig as never, {
      operation: 'stage-generation',
      explicitProfile: 'deepseek-harness',
    });
    expect(authoring.ok).toBe(false);
    if (!authoring.ok) expect(authoring.failure.error.code).toBe('unsupported_operation');
  });

  it('a disabled profile is registered but refused at selection time', () => {
    const profile = dshProfile({ enabled: false });
    const registry = new RunnerRegistry();
    registry.registerProfile(profile);
    const result = selectRunner(
      registry,
      {
        schemaVersion: '2.0.0',
        sourceSchemaVersion: '2.0.0',
        defaultRunner: 'deepseek-harness',
        operationDefaults: { stageGeneration: null, stageRefinement: null, taskExecution: null },
        runnerProfiles: { 'deepseek-harness': profile.config },
        runnerPolicy: {
          allowAutomaticFallback: false,
          allowNetworkRunners: true,
          requireExplicitRunnerForNetworkAccess: true,
          requireExplicitRunnerForPaidApi: true,
        },
        fallbacks: { stageGeneration: [], stageRefinement: [] },
      } as never,
      { operation: 'task-execution', explicitProfile: 'deepseek-harness' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.error.code).toBe('runner_disabled');
  });
});
