import { randomUUID } from 'node:crypto';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import type { AutonomyDeps } from '@specbridge/autonomy';
import type { MissionDeps } from '@specbridge/mission';

/**
 * The dependency bundle every intake service takes.
 *
 * Structurally an `AutonomyDeps`, which is itself structurally a `JobDeps`.
 * That is not an accident of convenience: the intake path is a higher-level
 * ORCHESTRATION of the mission, autonomy, and orchestration authorities, and
 * a bundle that could not be handed straight to them would mean the intake
 * had built its own parallel versions of things that already exist.
 *
 * Clock and id factory are injected exactly as they are everywhere else, so
 * an intake record, its approval, and its lifecycle ledger are
 * byte-reproducible across identical runs. An approval whose bytes changed
 * between replays would not be evidence of anything.
 */
export interface IntakeDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
  /** Host label recorded on records this process writes (e.g. "cli"). */
  host?: string | undefined;
}

/**
 * The same bundle, viewed as autonomy's deps.
 *
 * Asserted by the compiler in ONE place rather than re-asserted with a cast
 * at every call site. If the two shapes ever diverge, this line stops
 * compiling, which is where it should.
 */
export function autonomyDepsOf(deps: IntakeDeps): AutonomyDeps {
  return deps;
}

/** The same bundle, viewed as the mission package's deps. */
export function missionDepsOf(deps: IntakeDeps): MissionDeps {
  return {
    workspace: deps.workspace,
    clock: deps.clock,
    idFactory: deps.idFactory,
    host: deps.host,
  };
}

export function now(deps: IntakeDeps): Date {
  return (deps.clock ?? (() => new Date()))();
}

export function nowIso(deps: IntakeDeps): string {
  return now(deps).toISOString();
}

export function hostOf(deps: IntakeDeps): string {
  return deps.host ?? 'cli';
}

export function newId(deps: IntakeDeps): string {
  return (deps.idFactory ?? randomUUID)();
}

/**
 * A short, filesystem-safe id derived from the injected factory.
 *
 * The factory may return a UUID or a test counter; both are normalized to
 * the `[A-Za-z0-9._-]` alphabet the intake store validates, so an id that is
 * legal to generate is always legal to persist.
 */
export function newRecordId(deps: IntakeDeps, prefix: string): string {
  const raw = newId(deps).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  return `${prefix}-${raw.length > 0 ? raw : 'x'}`;
}
