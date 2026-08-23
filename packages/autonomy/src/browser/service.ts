import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { recordJobEvent } from '@specbridge/orchestration';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, newRecordId, now, nowIso } from '../deps.js';
import {
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  writeJsonRecord,
} from '../store.js';
import type { BrowserDriver } from './contract.js';
import { parseViewport } from './contract.js';
import type { BrowserScenario, BrowserScenarioResult, StepResult } from './state.js';
import {
  BROWSER_SCHEMA_VERSION,
  browserScenarioResultSchema,
  browserScenarioSchema,
  isAssertionStep,
} from './state.js';

/**
 * Running browser scenarios and turning them into durable evidence.
 *
 * The service is where the honesty rules live, and there are three:
 *
 *   A scenario that could not run is SKIPPED_NO_RUNTIME with a reason. Never
 *   a pass, never a failure. "We have no browser" and "the UI is broken" are
 *   different facts and a closure oracle must be able to tell them apart.
 *
 *   `assertionsRun` is counted, and a PASS with zero assertions cannot close
 *   anything (`isClosingBrowserResult`). A scenario that navigated somewhere
 *   and took a screenshot has demonstrated that a server responded.
 *
 *   Execution stops at the FIRST failed assertion but still captures
 *   evidence. Continuing past a failed precondition produces a cascade of
 *   meaningless failures; capturing nothing produces a morning report that
 *   says "it broke" and cannot say how.
 */

export function browserScenarioFile(workspace: WorkspaceInfo, scenarioId: string): string {
  assertAutonomyId('browser scenario', scenarioId);
  return autonomyPath(workspace, 'browser', `${scenarioId}.json`);
}

export function browserResultFile(workspace: WorkspaceInfo, resultId: string): string {
  assertAutonomyId('browser result', resultId);
  return autonomyPath(workspace, 'browser', 'results', `${resultId}.json`);
}

export function saveBrowserScenario(
  deps: AutonomyDeps,
  input: Omit<BrowserScenario, 'schemaVersion' | 'createdAt' | 'scenarioId'> & {
    scenarioId?: string;
  },
): BrowserScenario {
  const scenario = browserScenarioSchema.parse({
    schemaVersion: BROWSER_SCHEMA_VERSION,
    scenarioId: input.scenarioId ?? newRecordId(deps, 'bs'),
    createdAt: nowIso(deps),
    ...input,
  });
  writeJsonRecord(browserScenarioFile(deps.workspace, scenario.scenarioId), scenario);
  return scenario;
}

export function readBrowserScenario(
  workspace: WorkspaceInfo,
  scenarioId: string,
): BrowserScenario | undefined {
  return readJsonRecord(browserScenarioFile(workspace, scenarioId), (raw) =>
    browserScenarioSchema.parse(raw),
  );
}

export function listBrowserScenarios(workspace: WorkspaceInfo): BrowserScenario[] {
  return listJsonRecords(autonomyPath(workspace, 'browser'), (raw) =>
    browserScenarioSchema.parse(raw),
  );
}

export function listBrowserResults(workspace: WorkspaceInfo): BrowserScenarioResult[] {
  return listJsonRecords(autonomyPath(workspace, 'browser', 'results'), (raw) =>
    browserScenarioResultSchema.parse(raw),
  ).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function readBrowserResult(
  workspace: WorkspaceInfo,
  resultId: string,
): BrowserScenarioResult | undefined {
  return readJsonRecord(browserResultFile(workspace, resultId), (raw) =>
    browserScenarioResultSchema.parse(raw),
  );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RunBrowserScenarioOptions {
  scenarioId: string;
  driver: BrowserDriver;
  jobId?: string | undefined;
  signal?: AbortSignal | undefined;
  resultId?: string | undefined;
  /** Override the viewport for this run (responsive matrix). */
  viewport?: string | undefined;
}

export async function runBrowserScenario(
  deps: AutonomyDeps,
  options: RunBrowserScenarioOptions,
): Promise<BrowserScenarioResult> {
  const policy = autonomyPolicyOf(deps).browser;
  if (!policy.enabled) {
    throw new AutonomyError(
      'SBA018',
      'Browser verification is disabled by `autonomy.browser.enabled`.',
      { remediation: ['Enable it, or close UI criteria on other evidence.'] },
    );
  }
  const scenario = readBrowserScenario(deps.workspace, options.scenarioId);
  if (scenario === undefined) {
    throw new AutonomyError('SBA017', `No browser scenario "${options.scenarioId}" exists.`);
  }
  if (scenario.contexts.length > policy.maxContexts) {
    throw new AutonomyError(
      'SBA017',
      `Scenario ${scenario.scenarioId} declares ${scenario.contexts.length} contexts; policy allows ${policy.maxContexts}.`,
      { remediation: ['Raise autonomy.browser.maxContexts, or split the scenario.'] },
    );
  }

  const resultId = options.resultId ?? newRecordId(deps, 'br');
  const startedAt = nowIso(deps);
  const startedMs = now(deps).getTime();
  emitJobEvent(deps, options.jobId, 'browser_scenario_started', {
    scenarioId: scenario.scenarioId,
    resultId,
    contexts: scenario.contexts.length,
  });

  const availability = await options.driver.available();
  if (!availability.ok) {
    return persist(
      deps,
      browserScenarioResultSchema.parse({
        schemaVersion: BROWSER_SCHEMA_VERSION,
        resultId,
        scenarioId: scenario.scenarioId,
        ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
        status: 'SKIPPED_NO_RUNTIME',
        startedAt,
        finishedAt: nowIso(deps),
        driver: options.driver.label,
        skipReason: availability.reason,
      }),
      options.jobId,
    );
  }

  const steps: StepResult[] = [];
  const evidence: BrowserScenarioResult['evidence'] = [];
  let assertionsRun = 0;
  let assertionsPassed = 0;
  let failureDetail: string | undefined;
  let session;

  try {
    session = await options.driver.open({
      scenario,
      viewport: parseViewport(options.viewport ?? policy.viewports[0] ?? '1280x800'),
      navigationTimeoutMs: policy.navigationTimeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    return persist(
      deps,
      browserScenarioResultSchema.parse({
        schemaVersion: BROWSER_SCHEMA_VERSION,
        resultId,
        scenarioId: scenario.scenarioId,
        ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
        status: 'ERRORED',
        startedAt,
        finishedAt: nowIso(deps),
        driver: options.driver.label,
        failureDetail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_000),
      }),
      options.jobId,
    );
  }

  try {
    for (const [index, step] of scenario.steps.entries()) {
      if (options.signal?.aborted === true) {
        failureDetail = 'the scenario was cancelled';
        break;
      }
      const before = now(deps).getTime();
      const outcome = await session.step(step);
      const assertion = isAssertionStep(step);
      if (assertion) {
        assertionsRun += 1;
        if (outcome.ok) assertionsPassed += 1;
      }
      let evidenceRef: string | undefined;
      if (outcome.evidence !== undefined && policy.captureScreenshots) {
        evidenceRef = writeEvidenceFile(
          deps,
          resultId,
          `${String(index).padStart(3, '0')}-${outcome.evidence.label}`,
          outcome.evidence.kind === 'SCREENSHOT' ? 'png' : 'html',
          outcome.evidence.data,
        );
        evidence.push({
          kind: outcome.evidence.kind,
          ref: evidenceRef,
          label: outcome.evidence.label,
          context: step.context,
        });
      }
      steps.push({
        index,
        kind: step.kind,
        context: step.context,
        ok: outcome.ok,
        detail: outcome.detail.slice(0, 4_000),
        durationMs: Math.max(0, now(deps).getTime() - before),
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
      });
      if (!outcome.ok) {
        failureDetail = `step ${index} (${step.kind}) in context "${step.context}": ${outcome.detail}`;
        // Capture the DOM at the moment of failure. Doing it here rather than
        // in a cleanup pass is the difference between evidence about the
        // failure and evidence about whatever the page settled into.
        const snapshot = await session.snapshot(step.context, policy.maxEvidenceBytes);
        if (snapshot.length > 0) {
          evidence.push({
            kind: 'DOM_SNAPSHOT',
            ref: writeEvidenceFile(deps, resultId, `${String(index).padStart(3, '0')}-dom`, 'html', snapshot),
            label: 'dom-at-failure',
            context: step.context,
          });
        }
        break;
      }
    }

    const observations = policy.captureConsole ? [...session.observations()] : [];
    if (observations.length > 0) {
      evidence.push({
        kind: 'CONSOLE_LOG',
        ref: writeEvidenceFile(
          deps,
          resultId,
          'console',
          'json',
          `${JSON.stringify(observations, null, 2)}\n`,
        ),
        label: 'console-and-network',
      });
    }

    const status =
      failureDetail !== undefined ? 'FAILED' : assertionsRun > 0 ? 'PASSED' : 'FAILED';
    return persist(
      deps,
      browserScenarioResultSchema.parse({
        schemaVersion: BROWSER_SCHEMA_VERSION,
        resultId,
        scenarioId: scenario.scenarioId,
        ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
        status,
        startedAt,
        finishedAt: nowIso(deps),
        driver: options.driver.label,
        steps,
        assertionsRun,
        assertionsPassed,
        observations: observations.slice(0, 200),
        evidence,
        ...(failureDetail !== undefined
          ? { failureDetail }
          : assertionsRun === 0
            ? { failureDetail: 'the scenario ran no assertions and therefore proved nothing' }
            : {}),
        durationMs: now(deps).getTime() - startedMs,
      }),
      options.jobId,
    );
  } finally {
    await session.close();
  }
}

function writeEvidenceFile(
  deps: AutonomyDeps,
  resultId: string,
  name: string,
  extension: string,
  data: Buffer | string,
): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  const absolute = autonomyPath(
    deps.workspace,
    'browser',
    'evidence',
    resultId,
    `${safe}.${extension}`,
  );
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, data);
  return path.posix.join(
    '.specbridge',
    'autonomy',
    'browser',
    'evidence',
    resultId,
    `${safe}.${extension}`,
  );
}

function persist(
  deps: AutonomyDeps,
  result: BrowserScenarioResult,
  jobId: string | undefined,
): BrowserScenarioResult {
  writeJsonRecord(browserResultFile(deps.workspace, result.resultId), result);
  emitJobEvent(deps, jobId, 'browser_scenario_completed', {
    scenarioId: result.scenarioId,
    resultId: result.resultId,
    status: result.status,
    assertionsRun: result.assertionsRun,
    assertionsPassed: result.assertionsPassed,
  });
  return result;
}

function emitJobEvent(
  deps: AutonomyDeps,
  jobId: string | undefined,
  type: 'browser_scenario_started' | 'browser_scenario_completed',
  payload: Record<string, unknown>,
): void {
  if (jobId === undefined) return;
  try {
    recordJobEvent(jobDepsOf(deps), jobId, type, payload);
  } catch {
    // Scenarios also run from certification fixtures with no job.
  }
}

/**
 * Run one scenario across the configured responsive viewports.
 *
 * Every viewport produces its own result record. Collapsing them into one
 * would hide WHICH viewport broke, which is the only interesting fact a
 * responsive check produces.
 */
export async function runResponsiveMatrix(
  deps: AutonomyDeps,
  options: RunBrowserScenarioOptions,
): Promise<BrowserScenarioResult[]> {
  const viewports = autonomyPolicyOf(deps).browser.viewports;
  const results: BrowserScenarioResult[] = [];
  for (const viewport of viewports) {
    results.push(
      await runBrowserScenario(deps, {
        ...options,
        viewport,
        resultId: options.resultId !== undefined ? `${options.resultId}-${viewport}` : undefined,
      }),
    );
  }
  return results;
}
