import type { DogfoodRun, ScenarioResult } from './state.js';
import type { QualificationDeps } from './service.js';
import { markRunRunning, recordScenarioResult } from './service.js';
import { QUALIFICATION_SCENARIOS, profileSatisfies } from './matrix.js';
import { runPolicyScenarios } from './policy-scenarios.js';
import { listScenarioResults } from './store.js';
import type { QualificationProfile } from './vocabulary.js';

/**
 * The qualification scenario runner (vNext.9).
 *
 * Executes the POLICY scenarios — real production policy functions against
 * deterministic inputs — and records honest placeholders for everything it
 * cannot reach. That second half is the important one: a runner that
 * silently omitted the scenarios it could not execute would produce a report
 * whose "12 passed" looked like coverage instead of a fraction.
 *
 * So every matrix entry gets a durable result on every run:
 *
 *   POLICY scenarios          executed here, PASS or FAIL
 *   RUNTIME scenarios         SKIPPED_WITH_REASON naming where they run,
 *                             unless the regression suite already recorded a
 *                             result into this run — in which case that
 *                             result is preserved untouched
 *   REAL_RESOURCE scenarios   SKIPPED_WITH_REASON naming the missing resource
 *
 * A REQUIRED scenario in any skipped state blocks the release verdict, which
 * is what makes the honesty load-bearing rather than decorative.
 */

export interface RunScenariosInput {
  deps: QualificationDeps;
  run: DogfoodRun;
  executor: string;
  /** Restrict to specific scenario ids. */
  only?: readonly string[] | undefined;
  /** Re-run only scenarios that are currently FAIL or NOT_RUN. */
  failedOnly?: boolean | undefined;
}

export interface RunScenariosResult {
  executed: ScenarioResult[];
  skipped: ScenarioResult[];
  preserved: ScenarioResult[];
  passed: number;
  failed: number;
}

function skipReasonFor(
  scenario: (typeof QUALIFICATION_SCENARIOS)[number],
  profile: QualificationProfile,
  targetAvailable: boolean,
): string {
  if (!profileSatisfies(profile, scenario.minimumProfile)) {
    return (
      `Profile "${profile}" cannot execute this scenario; it requires at least ` +
      `"${scenario.minimumProfile}".`
    );
  }
  if (scenario.executionKind === 'RUNTIME') {
    return (
      'This scenario drives the real job runtime over a temporary workspace and is executed by ' +
      `the regression qualification suite${scenario.implementedBy === undefined ? '' : ` (${scenario.implementedBy})`}, ` +
      'not from the operator CLI.'
    );
  }
  if (scenario.executionKind === 'REAL_RESOURCE') {
    return targetAvailable
      ? 'This scenario requires a real provider, quota window, or authorized spend, which this invocation did not exercise.'
      : 'The real dogfood target and its resources are not available in this execution environment.';
  }
  return 'No executable implementation is registered for this scenario in this invocation.';
}

/**
 * Run the scenarios this invocation can honestly execute, and record a
 * durable result for every other matrix entry.
 */
export function runQualificationScenarios(input: RunScenariosInput): RunScenariosResult {
  const { deps, run, executor } = input;
  const only = input.only === undefined ? null : new Set(input.only);
  const existing = new Map(
    listScenarioResults(deps.workspace, run.runId).map((result) => [result.scenarioId, result]),
  );
  const targetAvailable = run.target.kind === 'REAL_REPOSITORY' && run.target.available;

  const executed: ScenarioResult[] = [];
  const skipped: ScenarioResult[] = [];
  const preserved: ScenarioResult[] = [];

  const outcomes = new Map(
    runPolicyScenarios(deps.config).map((outcome) => [outcome.scenarioId, outcome]),
  );

  for (const scenario of QUALIFICATION_SCENARIOS) {
    if (only !== null && !only.has(scenario.id)) {
      const current = existing.get(scenario.id);
      if (current !== undefined) preserved.push(current);
      continue;
    }
    const current = existing.get(scenario.id);
    if (
      input.failedOnly === true &&
      current !== undefined &&
      current.status !== 'FAIL' &&
      current.status !== 'NOT_RUN'
    ) {
      preserved.push(current);
      continue;
    }

    const outcome = outcomes.get(scenario.id);
    const runnable =
      outcome !== undefined && profileSatisfies(run.profile, scenario.minimumProfile);

    if (runnable) {
      executed.push(
        recordScenarioResult(deps, {
          runId: run.runId,
          scenarioId: scenario.id,
          status: outcome.passed ? 'PASS' : 'FAIL',
          executor,
          ...(outcome.failureDetail === undefined ? {} : { failureDetail: outcome.failureDetail }),
          observedTransitions: outcome.transitions,
          resourceAttribution: outcome.resourceAttribution,
        }),
      );
      continue;
    }

    // A result already recorded by another executor — typically the
    // regression suite — is authoritative and must not be overwritten by a
    // skip from an executor that could never have run it.
    if (current !== undefined && current.status !== 'NOT_RUN' && current.executor !== executor) {
      preserved.push(current);
      continue;
    }

    skipped.push(
      recordScenarioResult(deps, {
        runId: run.runId,
        scenarioId: scenario.id,
        status: 'SKIPPED_WITH_REASON',
        executor,
        skipReason: skipReasonFor(scenario, run.profile, targetAvailable),
      }),
    );
  }

  return {
    executed,
    skipped,
    preserved,
    passed: executed.filter((result) => result.status === 'PASS').length,
    failed: executed.filter((result) => result.status === 'FAIL').length,
  };
}

/** Mark the run RUNNING and execute its scenarios in one step. */
export function executeQualificationRun(input: RunScenariosInput): RunScenariosResult {
  const run =
    input.run.status === 'PREFLIGHT' || input.run.status === 'PAUSED'
      ? markRunRunning(input.deps, input.run.runId, 'Qualification scenarios started.')
      : input.run;
  return runQualificationScenarios({ ...input, run });
}
