import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import type { QuotaTelemetryFile, QuotaWindowSnapshot } from './state.js';
import { QUOTA_SNAPSHOT_SCHEMA_VERSION, quotaTelemetryFileSchema } from './state.js';

/**
 * Quota telemetry providers (vNext.2).
 *
 * A clean acquisition abstraction so the scheduling architecture never
 * depends on one fragile quota source:
 *
 *   ManualQuotaTelemetryProvider   the operator-maintained telemetry file
 *                                  (`.specbridge/quota-telemetry.json`),
 *                                  kept current via the CLI — real usage
 *                                  today, no scraping
 *   FakeQuotaTelemetryProvider     deterministic, test-controlled
 *   (future) provider adapters     additive implementations of the same
 *                                  interface when a RELIABLE machine-
 *                                  readable source exists
 *
 * Deliberately absent, by requirement: UI scraping and invented quota APIs.
 * No provider here fabricates a number — an unobserved window is null, and
 * freshness policy (quota/manager.ts) treats missing data conservatively.
 */

export interface QuotaTelemetryProvider {
  /** Stable adapter identity, recorded on every snapshot for audit. */
  readonly source: string;
  getFiveHourQuota(): Promise<QuotaWindowSnapshot | null>;
  getWeeklyQuota(): Promise<QuotaWindowSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Manual (file-backed) provider
// ---------------------------------------------------------------------------

export const QUOTA_TELEMETRY_FILE_NAME = 'quota-telemetry.json';
export const MANUAL_TELEMETRY_SOURCE = 'manual-file';

export function quotaTelemetryFilePath(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, QUOTA_TELEMETRY_FILE_NAME),
  );
}

/** Read the manual telemetry file; absent or unreadable yields empty state. */
export function readQuotaTelemetryFile(workspace: WorkspaceInfo): QuotaTelemetryFile {
  const file = quotaTelemetryFilePath(workspace);
  if (!existsSync(file)) return quotaTelemetryFileSchema.parse({});
  try {
    const parsed = quotaTelemetryFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    // A corrupt file is treated as no observation — never as fabricated data.
    return parsed.success ? parsed.data : quotaTelemetryFileSchema.parse({});
  } catch {
    return quotaTelemetryFileSchema.parse({});
  }
}

export interface RecordQuotaObservationInput {
  window: 'five-hour' | 'weekly';
  remainingRatio: number;
  /** Optional; recorded when the operator/source reports it. */
  usedRatio?: number | undefined;
  resetAt?: string | undefined;
  observedAt: string;
  source?: string | undefined;
}

/** Persist one observation into the manual telemetry file (atomic). */
export function recordQuotaObservation(
  workspace: WorkspaceInfo,
  input: RecordQuotaObservationInput,
): QuotaTelemetryFile {
  const current = readQuotaTelemetryFile(workspace);
  const snapshot: QuotaWindowSnapshot = {
    window: input.window,
    remainingRatio: Math.min(1, Math.max(0, input.remainingRatio)),
    usedRatio: input.usedRatio !== undefined ? Math.min(1, Math.max(0, input.usedRatio)) : null,
    resetAt: input.resetAt ?? null,
    observedAt: input.observedAt,
    source: input.source ?? MANUAL_TELEMETRY_SOURCE,
  };
  const next: QuotaTelemetryFile = {
    ...current,
    schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION,
    ...(input.window === 'five-hour' ? { fiveHour: snapshot } : { weekly: snapshot }),
  };
  writeFileAtomic(quotaTelemetryFilePath(workspace), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * The operator-maintained telemetry file as a provider. Reads are cheap and
 * repeated every scheduling pass, so the freshest recorded observation is
 * always used.
 */
export class ManualQuotaTelemetryProvider implements QuotaTelemetryProvider {
  readonly source = MANUAL_TELEMETRY_SOURCE;

  constructor(private readonly workspace: WorkspaceInfo) {}

  getFiveHourQuota(): Promise<QuotaWindowSnapshot | null> {
    return Promise.resolve(readQuotaTelemetryFile(this.workspace).fiveHour);
  }

  getWeeklyQuota(): Promise<QuotaWindowSnapshot | null> {
    return Promise.resolve(readQuotaTelemetryFile(this.workspace).weekly);
  }
}

// ---------------------------------------------------------------------------
// Fake (deterministic) provider
// ---------------------------------------------------------------------------

export interface FakeQuotaState {
  fiveHour: QuotaWindowSnapshot | null;
  weekly: QuotaWindowSnapshot | null;
}

/**
 * Deterministic test provider. Tests mutate `state` directly (or via `set`)
 * to simulate burns, resets, and stale observations without ever touching a
 * real subscription.
 */
export class FakeQuotaTelemetryProvider implements QuotaTelemetryProvider {
  readonly source = 'fake';
  state: FakeQuotaState;

  constructor(initial?: Partial<FakeQuotaState>) {
    this.state = { fiveHour: initial?.fiveHour ?? null, weekly: initial?.weekly ?? null };
  }

  set(window: 'five-hour' | 'weekly', snapshot: QuotaWindowSnapshot | null): void {
    if (window === 'five-hour') this.state.fiveHour = snapshot;
    else this.state.weekly = snapshot;
  }

  getFiveHourQuota(): Promise<QuotaWindowSnapshot | null> {
    return Promise.resolve(this.state.fiveHour);
  }

  getWeeklyQuota(): Promise<QuotaWindowSnapshot | null> {
    return Promise.resolve(this.state.weekly);
  }
}

/** No telemetry at all: every window is unobserved. */
export class NullQuotaTelemetryProvider implements QuotaTelemetryProvider {
  readonly source = 'none';

  getFiveHourQuota(): Promise<QuotaWindowSnapshot | null> {
    return Promise.resolve(null);
  }

  getWeeklyQuota(): Promise<QuotaWindowSnapshot | null> {
    return Promise.resolve(null);
  }
}

/**
 * Resolve the configured provider. The seam future machine-readable
 * adapters plug into — resolution branches on the configured source name,
 * never on provider probing.
 */
export function resolveQuotaTelemetryProvider(
  workspace: WorkspaceInfo,
  telemetrySource: string,
): QuotaTelemetryProvider {
  if (telemetrySource === 'manual') return new ManualQuotaTelemetryProvider(workspace);
  return new NullQuotaTelemetryProvider();
}
