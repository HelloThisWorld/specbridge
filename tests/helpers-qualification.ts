import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { readAgentConfig, resolveWorkspace } from '@specbridge/core';
import type {
  DogfoodRun,
  DogfoodTarget,
  QualificationDeps,
} from '@specbridge/orchestration';
import { recordScopeChange } from '@specbridge/orchestration';
import { copyFixtureToTemp } from './helpers.js';
import { idCounter, passingCommand, tickingClock } from './helpers-execution.js';

/**
 * Shared setup for vNext.9 qualification tests.
 *
 * A minimal workspace with a resolved configuration and deterministic
 * clock/ids — deliberately lighter than the execution fixture, because most
 * qualification assertions are about the qualification data model rather
 * than about running a job. Tests that need a driving job use
 * `setupExecutionFixtureV2` directly and record their results into a run
 * created here.
 */

export interface QualificationFixture {
  root: string;
  workspace: WorkspaceInfo;
  config: AgentConfig;
  clock: () => Date;
  deps: QualificationDeps;
  recordScopeChange: (
    runId: string,
    change: {
      originalScope: string;
      newScope: string;
      reason: string;
      authority: string;
      effectOnQualification: string;
    },
  ) => DogfoodRun;
}

export interface QualificationFixtureOptions {
  /** Merged into `orchestration.jobs.scheduler.api`. */
  api?: Record<string, unknown>;
  /** Replaces the verification commands (empty array is meaningful). */
  verificationCommands?: Record<string, unknown>[];
  /** Merged into the top-level configuration. */
  extraTopLevel?: Record<string, unknown>;
}

/**
 * Deliberately NO git repository.
 *
 * Nothing this fixture serves needs one: qualification records live under
 * `.specbridge/qualification/`, preflight receives the target's repository
 * status as a value rather than shelling out for it, and `realTarget()`
 * records a path as a string. A per-call `git init` is three blocking
 * subprocess spawns, and this helper is called ~33 times across the suite —
 * ~99 spawns of pure waste on a 4-vCPU CI runner whose coordinator has to
 * stay responsive enough to service the worker RPC.
 *
 * That is not hypothetical: adding this suite starved the coordinator past
 * birpc's 60s `onTaskUpdate` timeout on ubuntu CI, failing the run with
 * every one of its 2,351 tests passing. Same reasoning, and same default, as
 * `setupOrchestrationFixture`.
 *
 * A test that genuinely needs Git evidence builds its own fixture with
 * `setupOrchestrationFixture({ git: true })` or `setupExecutionFixtureV2`.
 */
export function setupQualificationWorkspace(
  options: QualificationFixtureOptions = {},
): QualificationFixture {
  const root = copyFixtureToTemp('v03-ready-feature');

  const config: Record<string, unknown> = {
    schemaVersion: '2.0.0',
    defaultRunner: 'mock',
    runnerProfiles: { mock: { runner: 'mock', enabled: true, scenario: 'success' } },
    verification: {
      commands: options.verificationCommands ?? [passingCommand('unit-tests')],
    },
    ...(options.api === undefined
      ? {}
      : {
          orchestration: {
            jobs: { scheduler: { api: options.api } },
          },
        }),
    ...(options.extraTopLevel ?? {}),
  };
  mkdirSync(path.join(root, '.specbridge'), { recursive: true });
  writeFileSync(
    path.join(root, '.specbridge', 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );

  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('fixture has no .kiro workspace');
  const read = readAgentConfig(workspace);
  if (read.config === undefined) {
    throw new Error(`fixture config invalid: ${read.diagnostics.map((d) => d.message).join('; ')}`);
  }

  const clock = tickingClock('2026-08-01T12:00:00.000Z');
  const idFactory = idCounter('qual');
  const deps: QualificationDeps = { workspace, config: read.config, clock, idFactory };
  return {
    root,
    workspace,
    config: read.config,
    clock,
    deps,
    recordScopeChange: (runId, change) => recordScopeChange(deps, runId, change),
  };
}

/** A deterministic fixture target: it can never satisfy the release gate. */
export function fixtureTarget(name = 'StepRelay (deterministic fixture)'): DogfoodTarget {
  return {
    kind: 'FIXTURE',
    name,
    repositoryPath: null,
    available: false,
    unavailableReason: 'Deterministic qualification fixture; not the real product repository.',
    startingCommit: null,
    endingCommit: null,
    branch: null,
    worktreePath: null,
    missionSpec: null,
  };
}

/**
 * A real-repository target. The path is recorded as data — nothing here
 * inspects it, and preflight receives repository status as a value — so the
 * directory need not be a Git repository for the target to be well-formed.
 */
export function realTarget(repositoryPath: string, name = 'StepRelay'): DogfoodTarget {
  return {
    kind: 'REAL_REPOSITORY',
    name,
    repositoryPath,
    available: true,
    unavailableReason: null,
    startingCommit: null,
    endingCommit: null,
    branch: 'dogfood',
    worktreePath: null,
    missionSpec: null,
  };
}

/** A throwaway directory outside any workspace (verifier state files). */
export function scratchDir(prefix = 'specbridge-qual-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}
