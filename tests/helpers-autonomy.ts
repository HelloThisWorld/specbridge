import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig, AutonomyPolicy, WorkspaceInfo } from '@specbridge/core';
import { overnightAutonomyPreset, readAgentConfig, resolveWorkspace } from '@specbridge/core';
import type { AutonomyDeps, MissionSeal, ProbeRunner } from '@specbridge/autonomy';
import { draftSeal, sealMission } from '@specbridge/autonomy';
import { recordAssessment } from '@specbridge/mission';
import { coveredMission, setupMissionFixture } from './helpers-mission.js';
import type { MissionFixture } from './helpers-mission.js';
import { idCounter, passingCommand, tickingClock } from './helpers-execution.js';

/**
 * Shared setup for vNext.10 autonomy tests.
 *
 * Two properties matter more than convenience here.
 *
 * The clock and id factory are injected and deterministic, so a seal, a
 * lease, and a preflight report are byte-reproducible across runs. Autonomy
 * records are evidence about what a run was allowed to do, and evidence that
 * changes between identical runs is not evidence.
 *
 * Nothing spawns a process. No git, no docker, no model. Every probe the
 * preflight runs is injected, so the suite asserts the CLASSIFICATION logic
 * rather than whatever happens to be installed on the machine running it —
 * which is also the only way `SATISFIABLE_AUTONOMOUSLY` can be tested at all.
 */

export interface AutonomyFixture {
  root: string;
  workspace: WorkspaceInfo;
  config: AgentConfig;
  clock: () => Date;
  deps: AutonomyDeps;
  mission: MissionFixture;
  missionId: string;
}

export interface AutonomyFixtureOptions {
  /** Merged over the OVERNIGHT preset. */
  autonomy?: Record<string, unknown> | undefined;
  /** Start from conservative defaults instead of the OVERNIGHT preset. */
  interactive?: boolean | undefined;
  /** Replaces the verification commands (an empty array is meaningful). */
  verificationCommands?: Record<string, unknown>[] | undefined;
  /** Merged into the top-level configuration. */
  extraTopLevel?: Record<string, unknown> | undefined;
}

export function setupAutonomyFixture(options: AutonomyFixtureOptions = {}): AutonomyFixture {
  const mission = setupMissionFixture();
  const root = mission.root;

  const autonomy = options.interactive === true ? {} : overnightPresetObject(options.autonomy);
  const config: Record<string, unknown> = {
    schemaVersion: '2.0.0',
    defaultRunner: 'mock',
    runnerProfiles: { mock: { runner: 'mock', enabled: true, scenario: 'success' } },
    verification: { commands: options.verificationCommands ?? [passingCommand('unit-tests')] },
    execution: { protectedPaths: ['.kiro/**', '.specbridge/**'] },
    autonomy,
    ...(options.extraTopLevel ?? {}),
  };
  mkdirSync(path.join(root, '.specbridge'), { recursive: true });
  writeFileSync(
    path.join(root, '.specbridge', 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );

  // A declared package manager, so preflight exercises the toolchain probes
  // rather than reporting NOT_APPLICABLE for a project that looks empty.
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'autonomy-fixture', private: true, packageManager: 'pnpm@9.15.9' }, null, 2)}\n`,
    'utf8',
  );

  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('autonomy fixture workspace did not resolve');
  const read = readAgentConfig(workspace);
  if (read.config === undefined) {
    throw new Error(`fixture config invalid: ${read.diagnostics.map((d) => d.message).join('; ')}`);
  }

  const clock = tickingClock('2026-08-20T21:00:00.000Z');
  const deps: AutonomyDeps = {
    workspace,
    config: read.config,
    clock,
    idFactory: idCounter('auto'),
    host: 'test',
  };
  return { root, workspace, config: read.config, clock, deps, mission, missionId: '' };
}

/**
 * The OVERNIGHT preset as a plain object, with overrides merged one level
 * deep so a test can say `{ toolsmith: { enabled: false } }` without having
 * to restate every other capability.
 */
function overnightPresetObject(overrides?: Record<string, unknown>): Record<string, unknown> {
  const preset = overnightAutonomyPreset() as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...preset };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const base = merged[key];
    merged[key] =
      typeof value === 'object' && value !== null && !Array.isArray(value) &&
      typeof base === 'object' && base !== null && !Array.isArray(base)
        ? { ...(base as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
  }
  return merged;
}

/**
 * A fixture whose mission has covered topics, one product contract, and
 * success criteria — the minimum a seal needs to be COMPLETE.
 *
 * The criteria are deliberately chosen so the deterministic screens classify
 * one as implying a system scenario and one as implying a browser scenario:
 * the tests that exercise the closure lifecycle need both surfaces present,
 * and hand-setting the flags would test the schema instead of the compiler.
 */
export function sealableMission(fixture: AutonomyFixture): { missionId: string; contractId: string } {
  const covered = coveredMission(fixture.mission);
  recordAssessment(fixture.mission.deps, covered.missionId, {
    missionUpdates: {
      successCriteria: [
        'A workflow definition runs end-to-end against a real Postgres and Kafka via docker compose.',
        'The dashboard page renders the execution history and a user can click through to one execution.',
        'Every rejected transition is refused before any side effect.',
      ],
      nonGoals: ['No multi-tenant isolation in v1.'],
    },
  });
  return { missionId: covered.missionId, contractId: covered.contractId };
}

/** Draft and authorize a seal for a sealable mission. */
export function sealedMission(
  fixture: AutonomyFixture,
  options: { maxApiSpendUsd?: number | null; allowedLanes?: ('LOCAL' | 'SUBSCRIPTION' | 'API')[] } = {},
): { seal: MissionSeal; missionId: string } {
  const { missionId } = sealableMission(fixture);
  const draft = draftSeal(fixture.deps, {
    missionId,
    maxApiSpendUsd: options.maxApiSpendUsd ?? null,
    allowedLanes: options.allowedLanes ?? ['LOCAL', 'SUBSCRIPTION'],
  });
  const seal = sealMission(fixture.deps, { sealId: draft.sealId, via: 'test' });
  return { seal, missionId };
}

/** The resolved autonomy policy of a fixture. */
export function policyOf(fixture: AutonomyFixture): AutonomyPolicy {
  return fixture.config.autonomy;
}

/**
 * A probe runner that answers from a table.
 *
 * Keys are `executable argv...` joined by spaces. Anything not in the table
 * is reported unavailable, which keeps every test explicit about the world
 * it is asserting against.
 */
export function fakeProbeRunner(table: Record<string, { ok: boolean; output?: string }>): ProbeRunner {
  return async (executable, argv) => {
    // The bare-executable shorthand answers ONLY a `--version` probe. A table
    // entry for `docker` must not silently answer `docker info`: "the CLI is
    // installed" and "the daemon is answering" are exactly the two facts the
    // preflight exists to tell apart, and a helpful fallback here would make
    // that distinction untestable.
    const key = [executable, ...argv].join(' ');
    const hit =
      table[key] ??
      (argv.length === 1 && argv[0] === '--version' ? table[executable] : undefined);
    if (hit === undefined) return { ok: false, output: '', detail: 'not configured in this test' };
    return { ok: hit.ok, output: hit.output ?? '', ...(hit.ok ? {} : { detail: 'configured failure' }) };
  };
}

/** Every probe answers yes. For tests about seal/policy rather than tooling. */
export function allAvailableProbeRunner(): ProbeRunner {
  return async (executable) => ({ ok: true, output: `${executable} 1.0.0` });
}
