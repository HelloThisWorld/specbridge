import type { AgentConfig, OrchestrationPolicy, WorkspaceInfo } from '@specbridge/core';
import { defaultOrchestrationPolicy, orchestrationPolicySchema } from '@specbridge/core';
import type { OrchestrationDeps, OrchestrationState } from '@specbridge/orchestration';
import {
  ORCHESTRATION_STATE_SCHEMA_VERSION,
  beginOrchestration,
  orchestrationStateSchema,
} from '@specbridge/orchestration';
import type { ExecutionFixtureOptions } from './helpers-execution.js';
import { idCounter, setupExecutionFixture, tickingClock } from './helpers-execution.js';

/**
 * Shared setup for orchestration tests: the same git-committed, fully
 * approved `v03-ready-feature` fixture the execution tests use, plus a
 * resolved orchestration policy. Fully offline and deterministic.
 */

export interface OrchestrationFixture {
  root: string;
  workspace: WorkspaceInfo;
  config: AgentConfig;
  specName: string;
  clock: () => Date;
  deps: OrchestrationDeps;
}

export interface OrchestrationFixtureOptions extends ExecutionFixtureOptions {
  /** Partial orchestration policy merged over the defaults. */
  policy?: Record<string, unknown>;
}

/**
 * Orchestration fixtures default to NO git repository.
 *
 * Most orchestration behaviour — the state machine, intent, clarification,
 * budgets, persistence, bounds — never touches Git evidence, and a per-test
 * `git init` is the single largest cost in this suite. Tests that genuinely
 * exercise the Git baseline (plan binding, staleness, divergence, resume)
 * opt in with `git: true`.
 */
export function setupOrchestrationFixture(
  options: OrchestrationFixtureOptions = {},
): OrchestrationFixture {
  const base = setupExecutionFixture({
    ...options,
    // After the spread: an explicit `git: undefined` must not re-enable it.
    git: options.git ?? false,
    extraConfig: {
      ...(options.extraConfig ?? {}),
      ...(options.policy !== undefined ? { orchestration: options.policy } : {}),
    },
  });
  const clock = tickingClock('2026-08-01T09:00:00.000Z');
  const idFactory = idCounter('orc');
  return {
    root: base.root,
    workspace: base.workspace,
    config: base.config,
    specName: base.specName,
    clock,
    deps: {
      workspace: base.workspace,
      config: base.config,
      clock,
      idFactory,
      host: 'test',
    },
  };
}

/** A policy object with the given overrides applied over the defaults. */
export function testPolicy(overrides: Record<string, unknown> = {}): OrchestrationPolicy {
  return orchestrationPolicySchema.parse({ ...defaultOrchestrationPolicy(), ...overrides });
}

/** Config with an overridden orchestration policy (no file rewrite needed). */
export function withPolicy(config: AgentConfig, policy: Record<string, unknown>): AgentConfig {
  return { ...config, orchestration: orchestrationPolicySchema.parse(policy) };
}

/** A schema-valid state record for pure state-machine/store tests. */
export function testOrchestrationState(
  overrides: Partial<OrchestrationState> = {},
): OrchestrationState {
  const policy = defaultOrchestrationPolicy();
  return orchestrationStateSchema.parse({
    schemaVersion: ORCHESTRATION_STATE_SCHEMA_VERSION,
    orchestrationId: 'orc-000001',
    specName: 'settings-persistence',
    phase: 'CREATED',
    goal: 'test goal',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    host: 'test',
    planningMode: policy.planning.mode,
    policyFingerprint: 'test-fingerprint',
    budgets: {
      maxIterations: policy.execution.maxIterations,
      maxRepairCycles: policy.execution.maxRepairCycles,
      maxReplans: policy.planning.maxReplans,
      maxNoProgressCycles: policy.execution.maxNoProgressCycles,
      maxTransientRetries: policy.retry.maxTransientRetries,
      maxClarificationRounds: policy.clarification.maxRounds,
      maxElapsedMs: policy.execution.maxElapsedMs,
      maxEvents: policy.history.maxEvents,
    },
    ...overrides,
  });
}

/** Begin a run and assess intent as READY in one step (the common path). */
export function beginReadyRun(
  fixture: OrchestrationFixture,
  options: { taskId?: string; goal?: string } = {},
): OrchestrationState {
  return beginOrchestration(fixture.deps, {
    specName: fixture.specName,
    goal: options.goal ?? 'Implement the selected task as specified.',
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
  });
}

/** A minimal valid plan candidate for the fixture spec. */
export function testPlanCandidate(
  taskId: string,
  overrides: Record<string, unknown> = {},
): {
  taskId: string;
  goal: string;
  steps: { description: string }[];
  testStrategy: string;
  verificationStrategy: string;
} & Record<string, unknown> {
  return {
    taskId,
    goal: 'Implement the selected task.',
    steps: [{ description: 'Add the settings module.' }],
    testStrategy: 'Add a unit test for the new module.',
    verificationStrategy: 'Run the configured trusted verification commands.',
    ...overrides,
  };
}
