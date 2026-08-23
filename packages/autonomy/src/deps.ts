import { randomUUID } from 'node:crypto';
import type { AgentConfig, AutonomyPolicy, WorkspaceInfo } from '@specbridge/core';
import type { DelegatedAuthorityResolver, JobDeps } from '@specbridge/orchestration';

/**
 * The dependency bundle every autonomy service takes.
 *
 * Same shape as `QualificationDeps` and `JobDeps` on purpose: clock and id
 * factory are injected so every record a test produces is byte-reproducible,
 * and neither one is ever read from a global. A service that called
 * `Date.now()` directly could not be replayed, and replay is how the
 * certification proves what the runtime did.
 */
export interface AutonomyDeps {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
  /** Host label recorded on records this process writes (e.g. "cli"). */
  host?: string | undefined;
  /**
   * The delegated-authority resolver threaded through to the job driver.
   * Present only for jobs governed by an executable seal.
   */
  authorityResolver?: DelegatedAuthorityResolver | undefined;
}

/**
 * The same bundle, viewed as orchestration's `JobDeps`.
 *
 * `AutonomyDeps` is structurally a `JobDeps` by construction, and this
 * function exists so that fact is asserted by the compiler in ONE place
 * rather than re-asserted with a cast at every call site. If the two shapes
 * ever diverge, this line stops compiling, which is where it should.
 */
export function jobDepsOf(deps: AutonomyDeps): JobDeps {
  return deps;
}

export function autonomyPolicyOf(deps: AutonomyDeps): AutonomyPolicy {
  return deps.config.autonomy;
}

export function now(deps: AutonomyDeps): Date {
  return (deps.clock ?? (() => new Date()))();
}

export function nowIso(deps: AutonomyDeps): string {
  return now(deps).toISOString();
}

export function newId(deps: AutonomyDeps): string {
  return (deps.idFactory ?? randomUUID)();
}

export function hostOf(deps: AutonomyDeps): string {
  return deps.host ?? 'cli';
}

/**
 * A short, filesystem-safe id derived from the injected factory.
 *
 * The factory may return a UUID or a test counter; both are normalized to
 * the `[A-Za-z0-9._-]` alphabet the autonomy store validates, so an id that
 * is legal to generate is always legal to persist.
 */
export function newRecordId(deps: AutonomyDeps, prefix: string): string {
  const raw = newId(deps).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  return `${prefix}-${raw.length > 0 ? raw : 'x'}`;
}
