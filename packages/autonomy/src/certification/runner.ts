import type { WorkspaceInfo } from '@specbridge/core';
import { requireJobState } from '@specbridge/orchestration';
import type { AutonomyDeps } from '../deps.js';
import { hostOf, newRecordId, now, nowIso } from '../deps.js';
import { autonomyPath, listJsonRecords, readJsonRecord, writeJsonRecord } from '../store.js';
import type { CertificationVerdict, ZeroTouchOutcome } from '../vocabulary.js';
import { CERTIFICATION_FAILING_OUTCOMES } from '../vocabulary.js';
import type { CertificationScenario } from './matrix.js';
import { CERTIFICATION_MATRIX } from './matrix.js';
import type { CertificationRun, CertificationScenarioResult } from './state.js';
import {
  CERTIFICATION_SCHEMA_VERSION,
  certificationRunSchema,
  certificationScenarioResultSchema,
} from './state.js';

/**
 * The zero-touch certification runner.
 *
 * The runner owns the BOOKKEEPING — what ran, what happened, what the verdict
 * is — and delegates the actual driving of each scenario to an injected
 * executor. That split is what lets the same matrix be exercised by the test
 * suite against deterministic fixtures and by an operator against a real
 * workspace, without two definitions of what "certified" means.
 *
 * The verdict rule is uncompromising and short:
 *
 *   every scenario met its expectation, AND
 *   humanInterventionsAfterSeal == 0
 *     => CERTIFIED
 *
 *   any scenario asked a human, got stuck, or took authority
 *     => NOT_CERTIFIED
 *
 *   anything skipped or not run
 *     => INCOMPLETE
 *
 * INCOMPLETE exists so a partial run cannot round itself up. A certification
 * that ran twelve of sixteen scenarios has not certified anything, and
 * reporting it as a pass with an asterisk is how a suite stops being read.
 */

export interface ScenarioExecution {
  outcome: ZeroTouchOutcome;
  humanInterventions: number;
  authorityEscalations: number;
  observed: string;
  finalStatus?: string | undefined;
  recoveryPath?: readonly string[] | undefined;
  skipReason?: string | undefined;
}

export type ScenarioExecutor = (
  scenario: CertificationScenario,
) => Promise<ScenarioExecution>;

export interface RunCertificationOptions {
  execute: ScenarioExecutor;
  /** Restrict to specific scenario ids. Absent means the whole matrix. */
  only?: readonly string[] | undefined;
  runId?: string | undefined;
  onEvent?: ((message: string) => void) | undefined;
}

export function certificationRunFile(workspace: WorkspaceInfo, runId: string): string {
  return autonomyPath(workspace, 'certification', `${runId}.json`);
}

export function readCertificationRun(
  workspace: WorkspaceInfo,
  runId: string,
): CertificationRun | undefined {
  return readJsonRecord(certificationRunFile(workspace, runId), (raw) =>
    certificationRunSchema.parse(raw),
  );
}

export function listCertificationRuns(workspace: WorkspaceInfo): CertificationRun[] {
  return listJsonRecords(autonomyPath(workspace, 'certification'), (raw) =>
    certificationRunSchema.parse(raw),
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function runZeroTouchCertification(
  deps: AutonomyDeps,
  options: RunCertificationOptions,
): Promise<CertificationRun> {
  const runId = options.runId ?? newRecordId(deps, 'zt');
  const createdAt = nowIso(deps);
  const scenarios = CERTIFICATION_MATRIX.filter(
    (scenario) => options.only === undefined || options.only.includes(scenario.id),
  );
  const results: CertificationScenarioResult[] = [];

  for (const scenario of scenarios) {
    const startedAt = nowIso(deps);
    const startedMs = now(deps).getTime();
    options.onEvent?.(`${scenario.id} ${scenario.title}`);
    let execution: ScenarioExecution;
    try {
      execution = await options.execute(scenario);
    } catch (cause) {
      // A scenario that threw is a certification failure, not a crashed
      // suite: the runtime under test was supposed to handle whatever this
      // was, and reporting the exception as STUCK is exactly right.
      execution = {
        outcome: 'STUCK',
        humanInterventions: 0,
        authorityEscalations: 0,
        observed: `the scenario threw: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 500)}`,
      };
    }
    results.push(
      certificationScenarioResultSchema.parse({
        scenarioId: scenario.id,
        fault: scenario.fault,
        expectation: scenario.expectation,
        outcome: execution.outcome,
        humanInterventions: execution.humanInterventions,
        authorityEscalations: execution.authorityEscalations,
        observed: execution.observed.slice(0, 4_000),
        ...(execution.finalStatus !== undefined ? { finalStatus: execution.finalStatus } : {}),
        recoveryPath: [...(execution.recoveryPath ?? [])].slice(0, 30),
        ...(execution.skipReason !== undefined ? { skipReason: execution.skipReason } : {}),
        startedAt,
        finishedAt: nowIso(deps),
        durationMs: Math.max(0, now(deps).getTime() - startedMs),
      }),
    );
  }

  const run = buildRun(deps, { runId, createdAt, results, expected: scenarios.length });
  writeJsonRecord(certificationRunFile(deps.workspace, runId), run);
  return run;
}

function buildRun(
  deps: AutonomyDeps,
  input: {
    runId: string;
    createdAt: string;
    results: readonly CertificationScenarioResult[];
    expected: number;
  },
): CertificationRun {
  const totals = {
    total: input.results.length,
    selfRecovered: count(input.results, 'SELF_RECOVERED'),
    needsAuthority: count(input.results, 'NEEDS_AUTHORITY'),
    askedHuman: count(input.results, 'ASKED_HUMAN'),
    stuck: count(input.results, 'STUCK'),
    selfAuthorized: count(input.results, 'SELF_AUTHORIZED'),
    skipped: count(input.results, 'SKIPPED_WITH_REASON'),
    notRun: count(input.results, 'NOT_RUN') + Math.max(0, input.expected - input.results.length),
  };
  const humanInterventions = input.results.reduce(
    (sum, result) => sum + result.humanInterventions,
    0,
  );

  const failures = input.results
    .filter(
      (result) =>
        CERTIFICATION_FAILING_OUTCOMES.includes(result.outcome) ||
        result.outcome !== result.expectation,
    )
    .filter((result) => result.outcome !== 'SKIPPED_WITH_REASON' && result.outcome !== 'NOT_RUN')
    .map((result) => ({
      scenarioId: result.scenarioId,
      outcome: result.outcome,
      observed: result.observed,
    }));

  const verdict: CertificationVerdict =
    failures.length > 0 || humanInterventions > 0
      ? 'NOT_CERTIFIED'
      : totals.skipped > 0 || totals.notRun > 0
        ? 'INCOMPLETE'
        : 'CERTIFIED';

  const rationale =
    verdict === 'CERTIFIED'
      ? `all ${totals.total} matrix scenarios met their expectation with ${humanInterventions} human intervention(s)`
      : verdict === 'NOT_CERTIFIED'
        ? humanInterventions > 0
          ? `${humanInterventions} human intervention(s) were required; the primary metric is zero`
          : `${failures.length} scenario(s) did not meet their expectation`
        : `${totals.skipped} skipped and ${totals.notRun} not-run scenario(s): a partial matrix certifies nothing`;

  return certificationRunSchema.parse({
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    runId: input.runId,
    createdAt: input.createdAt,
    finishedAt: nowIso(deps),
    host: hostOf(deps),
    verdict,
    results: input.results,
    totals,
    humanInterventionsAfterSeal: humanInterventions,
    rationale,
    failures,
  });
}

function count(results: readonly CertificationScenarioResult[], outcome: ZeroTouchOutcome): number {
  return results.filter((result) => result.outcome === outcome).length;
}

/**
 * Read the recovery path a job actually took, from its durable statuses.
 *
 * Used by scenario executors to report `recoveryPath` honestly: the point of
 * a certification is that it inspects what happened rather than what the
 * runtime says happened.
 */
export function observedRecoveryPath(
  deps: AutonomyDeps,
  jobId: string,
  events: readonly string[],
): string[] {
  const path = [...events];
  try {
    path.push(requireJobState(deps.workspace, jobId).status);
  } catch {
    // A scenario whose job never existed reports what it observed.
  }
  return path.slice(0, 30);
}
