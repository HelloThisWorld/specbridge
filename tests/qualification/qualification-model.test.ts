import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAgentConfig, resolveAgentConfigFromV1 } from '@specbridge/core';
import type {
  DogfoodRun,
  FaultInjectionRecord,
  HumanIntervention,
  InvariantAudit,
  QualificationScenario,
  ScenarioResult,
} from '@specbridge/orchestration';
import {
  FAULT_CLASSES,
  FaultInjector,
  QUALIFICATION_ARTIFACTS,
  QUALIFICATION_SCENARIOS,
  RELEASE_GATE_SCENARIO_ID,
  buildQualificationReport,
  buildQualificationSummary,
  computeVerdict,
  configurationFingerprint,
  countZeroToleranceConditions,
  dogfoodQualificationReportSchema,
  economicConfiguration,
  faultClassesWithoutScenario,
  isOrchestrationError,
  listScenarioResults,
  normalizeReportForComparison,
  profileSatisfies,
  recordDogfoodDefect,
  recordHumanIntervention,
  recordScenarioResult,
  renderQualificationMarkdown,
  runPolicyScenarios,
  runPreflight,
  scenariosOfKind,
  startQualificationRun,
  summarizeScenarios,
  toFaultRecord,
} from '@specbridge/orchestration';
import { setupQualificationWorkspace, fixtureTarget, realTarget } from '../helpers-qualification.js';

/**
 * vNext.9 qualification data model, aggregation, and release gate.
 *
 * The claims pinned here are the ones that make a release report worth
 * reading:
 *
 *   a skipped required scenario is never a pass
 *   a fixture target can never satisfy the real-product gate
 *   simulated resources are never reported as real
 *   a manual code fix is never filed as an approval
 *   a policy-required intervention must name its boundary
 *   any zero-tolerance condition is a FAIL, whatever else passed
 *   PASS_WITH_LIMITATIONS is unavailable without the real gate
 *   the report is reproducible from durable records alone
 *   fault injection has no production surface
 */

const CONFIG = resolveAgentConfigFromV1(defaultAgentConfig());

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

describe('qualification scenario matrix', () => {
  it('is complete, uniquely identified, and covers every claimed fault class', () => {
    const ids = QUALIFICATION_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of QUALIFICATION_SCENARIOS) {
      expect(scenario.invariant.length).toBeGreaterThan(20);
      expect(scenario.title.length).toBeGreaterThan(3);
    }
    // A fault class SpecBridge claims to survive with no scenario that
    // injects it is a coverage gap, not a rounding error.
    expect(faultClassesWithoutScenario(FAULT_CLASSES)).toEqual([]);
  });

  it('names exactly one release gate, and it needs a real resource', () => {
    const gates = QUALIFICATION_SCENARIOS.filter(
      (scenario) => scenario.requirement === 'RELEASE_GATE',
    );
    expect(gates.map((scenario) => scenario.id)).toEqual([RELEASE_GATE_SCENARIO_ID]);
    expect(gates[0]?.executionKind).toBe('REAL_RESOURCE');
    // Structural: the gate cannot be reached by an offline profile at all.
    expect(profileSatisfies('offline', gates[0]?.minimumProfile ?? 'offline')).toBe(false);
  });

  it('gives every RUNTIME and REAL_RESOURCE scenario an execution home or an honest gap', () => {
    for (const scenario of scenariosOfKind('RUNTIME')) {
      expect(scenario.implementedBy, `${scenario.id} must say where it runs`).toBeDefined();
    }
    // REAL_RESOURCE scenarios have no local implementation by definition.
    for (const scenario of scenariosOfKind('REAL_RESOURCE')) {
      expect(scenario.implementedBy).toBeUndefined();
    }
  });

  /**
   * The completeness check that keeps the matrix honest.
   *
   * Every RUNTIME scenario must be recorded as PASS by the test file that
   * OBSERVES it. Scanning the sources rather than the results is deliberate:
   * a run-time aggregation would only tell us what happened in one process,
   * whereas this fails the moment a scenario is added to the matrix without
   * anything to prove it — which is precisely how a release gate quietly
   * stops meaning anything.
   */
  it('has a regression-suite recorder for every RUNTIME scenario in the matrix', () => {
    const testsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const recorded = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.test.ts')) continue;
        const contents = readFileSync(full, 'utf8');
        for (const match of contents.matchAll(/scenarioId:\s*'([^']+)'/g)) {
          const id = match[1];
          // Only count a recording that also claims PASS in the same call.
          const index = match.index ?? 0;
          const window = contents.slice(index, index + 400);
          if (/status:\s*'PASS'/.test(window) && id !== undefined) recorded.add(id);
        }
      }
    };
    walk(testsRoot);

    const missing = scenariosOfKind('RUNTIME')
      .map((scenario) => scenario.id)
      .filter((id) => !recorded.has(id));
    expect(missing).toEqual([]);
  });

  it('registers a runnable implementation for every POLICY scenario it claims', () => {
    const executed = new Set(runPolicyScenarios(CONFIG).map((outcome) => outcome.scenarioId));
    const unimplemented = scenariosOfKind('POLICY')
      .map((scenario) => scenario.id)
      .filter((id) => !executed.has(id));
    // Two governance scenarios are proved by inspecting the package itself
    // and the preflight function, in this file, rather than from the policy
    // table — a module that graded its own scoping would be worthless.
    expect(unimplemented).toEqual([
      'governance.fault-injection-scoping',
      'governance.preflight-fails-closed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// POLICY scenarios
// ---------------------------------------------------------------------------

describe('deterministic policy scenarios', () => {
  it('all pass against the default configuration', () => {
    const failures = runPolicyScenarios(CONFIG).filter((outcome) => !outcome.passed);
    expect(
      failures.map((outcome) => `${outcome.scenarioId}: ${outcome.failureDetail ?? ''}`),
    ).toEqual([]);
  });

  it('records observed transitions, not just a boolean', () => {
    for (const outcome of runPolicyScenarios(CONFIG)) {
      expect(outcome.transitions.length, outcome.scenarioId).toBeGreaterThan(0);
      for (const transition of outcome.transitions) {
        expect(transition.subject.length).toBeGreaterThan(0);
        expect(transition.to).not.toBeNull();
      }
    }
  });

  it('attributes every resource it touches as SIMULATED, never REAL', () => {
    // The deterministic scenarios use fixtures and fake telemetry. If one of
    // them ever reported REAL, an offline CI run would be claiming to have
    // exercised a subscription window it never touched.
    for (const outcome of runPolicyScenarios(CONFIG)) {
      for (const attribution of Object.values(outcome.resourceAttribution)) {
        expect(attribution, outcome.scenarioId).not.toBe('REAL');
      }
    }
  });

  it('is deterministic: the same configuration produces the same outcomes', () => {
    const first = runPolicyScenarios(CONFIG);
    const second = runPolicyScenarios(CONFIG);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ---------------------------------------------------------------------------
// Scenario recording
// ---------------------------------------------------------------------------

describe('scenario result recording', () => {
  it('refuses a skip with no reason and a failure with no detail', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    expect(() =>
      recordScenarioResult(fixture.deps, {
        runId: run.runId,
        scenarioId: 'quota.harvest',
        status: 'SKIPPED_WITH_REASON',
        executor: 'test',
      }),
    ).toThrowError(/skipped without a reason/i);
    expect(() =>
      recordScenarioResult(fixture.deps, {
        runId: run.runId,
        scenarioId: 'quota.harvest',
        status: 'FAIL',
        executor: 'test',
      }),
    ).toThrowError(/without a recorded detail/i);
  });

  it('refuses a result for a scenario that is not in the matrix', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    try {
      recordScenarioResult(fixture.deps, {
        runId: run.runId,
        scenarioId: 'quota.invented-scenario',
        status: 'PASS',
        executor: 'test',
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isOrchestrationError(error)).toBe(true);
      expect((error as Error).message).toMatch(/Unknown qualification scenario/);
    }
  });

  it('replaces a scenario result on re-run so a fixed defect can turn FAIL into PASS', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(fixture.deps, {
      runId: run.runId,
      scenarioId: 'quota.harvest',
      status: 'FAIL',
      executor: 'test',
      failureDetail: 'the first iteration found a defect',
    });
    recordScenarioResult(fixture.deps, {
      runId: run.runId,
      scenarioId: 'quota.harvest',
      status: 'PASS',
      executor: 'test',
    });
    const results = listScenarioResults(fixture.workspace, run.runId);
    expect(results.filter((entry) => entry.scenarioId === 'quota.harvest')).toHaveLength(1);
    expect(results[0]?.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// Human interventions
// ---------------------------------------------------------------------------

describe('human intervention classification', () => {
  it('requires a policy-required intervention to name its boundary', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    expect(() =>
      recordHumanIntervention(fixture.deps, {
        runId: run.runId,
        kind: 'REQUIRED_BY_POLICY',
        description: 'approved the design stage',
        reason: 'governance',
      }),
    ).toThrowError(/must name the governance boundary/i);

    const recorded = recordHumanIntervention(fixture.deps, {
      runId: run.runId,
      kind: 'REQUIRED_BY_POLICY',
      description: 'approved the design stage',
      reason: 'stage approval is human-only',
      policyBoundary: 'approval',
    });
    expect(recorded.policyBoundary).toBe('approval');
  });

  it('counts a manual code fix as an autonomy failure, never as an approval', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    const fix = recordHumanIntervention(fixture.deps, {
      runId: run.runId,
      kind: 'MANUAL_CODE_FIX',
      description: 'the operator repaired the generated implementation by hand',
      reason: 'the runtime could not complete this task independently',
    });
    expect(fix.policyBoundary).toBeNull();

    const report = buildQualificationReport({
      workspace: fixture.workspace,
      runId: run.runId,
      generatedAt: '2026-08-01T12:00:00.000Z',
    });
    expect(report.scorecard.manualCodeEdits).toBe(1);
    expect(report.humanInterventions[0]?.kind).toBe('MANUAL_CODE_FIX');
  });

  it('treats a manual durable-state repair as release-blocking', () => {
    const interventions: HumanIntervention[] = [
      {
        schemaVersion: '1.0.0',
        runId: 'r1',
        interventionId: 'hi-1',
        kind: 'MANUAL_STATE_REPAIR',
        at: '2026-08-01T12:00:00.000Z',
        description: 'hand-edited the job checkpoint',
        reason: 'resume could not reconcile',
        jobId: null,
        nodeId: null,
        taskId: null,
        policyBoundary: null,
        evidenceRefs: [],
      },
    ];
    const zero = countZeroToleranceConditions({
      results: [],
      audits: [],
      faults: [],
      interventions,
    });
    expect(zero.manualDurableStateRepairs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Release gate
// ---------------------------------------------------------------------------

function passResult(scenarioId: string): ScenarioResult {
  const scenario = QUALIFICATION_SCENARIOS.find(
    (entry) => entry.id === scenarioId,
  ) as QualificationScenario;
  return {
    schemaVersion: '1.0.0',
    runId: 'r1',
    scenarioId,
    area: scenario.area,
    executionKind: scenario.executionKind,
    requirement: scenario.requirement,
    status: 'PASS',
    skipReason: null,
    failureDetail: null,
    faultClasses: [...scenario.faultClasses],
    expectedInvariant: scenario.invariant,
    observedTransitions: [],
    evidenceRefs: [],
    resourceAttribution: {},
    executor: 'test',
    durationMs: null,
    recordedAt: '2026-08-01T12:00:00.000Z',
  };
}

/** Every REQUIRED scenario passing, plus the real-product gate. */
function allRequiredPassing(): ScenarioResult[] {
  return QUALIFICATION_SCENARIOS.filter(
    (scenario) => scenario.requirement === 'REQUIRED' || scenario.requirement === 'RELEASE_GATE',
  ).map((scenario) => passResult(scenario.id));
}

describe('release verdict', () => {
  const base = {
    profile: 'full' as const,
    audits: [] as InvariantAudit[],
    faults: [] as FaultInjectionRecord[],
    interventions: [] as HumanIntervention[],
    defects: [],
    limitations: [],
    realTargetAvailable: true,
  };

  it('returns an unqualified PASS only when nothing at all is left unproven', () => {
    // Every REQUIRED scenario, the real-product gate, AND both
    // REQUIRED_WHEN_EXERCISED scenarios actually exercised. Anything short of
    // that is honestly PASS_WITH_LIMITATIONS, which the next test pins.
    const results = QUALIFICATION_SCENARIOS.map((scenario) => passResult(scenario.id));
    const verdict = computeVerdict({ ...base, results });
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.blockers).toEqual([]);
    expect(verdict.limitations).toEqual([]);
    expect(verdict.realTargetQualification).toBe('PASSED');
  });

  it('reports PASS_WITH_LIMITATIONS when correctness held but coverage was incomplete', () => {
    // Every REQUIRED scenario and the release gate pass, but the two
    // real-resource scenarios were never exercised. Correct and governed, yet
    // meaningfully less than fully proven — and the report says which.
    const verdict = computeVerdict({ ...base, results: allRequiredPassing() });
    expect(verdict.verdict).toBe('PASS_WITH_LIMITATIONS');
    expect(verdict.blockers).toEqual([]);
    expect(verdict.limitations.every((entry) => entry.class === 'COVERAGE_NOT_EXERCISED')).toBe(true);
  });

  it('never returns PASS when the real-product gate was not run', () => {
    const results = allRequiredPassing().filter(
      (result) => result.scenarioId !== RELEASE_GATE_SCENARIO_ID,
    );
    const verdict = computeVerdict({ ...base, results, realTargetAvailable: false });
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.realTargetQualification).toBe('NOT_RUN');
    expect(verdict.blockers.some((blocker) => blocker.class === 'REQUIRED_SCENARIO_NOT_PROVEN')).toBe(
      true,
    );
  });

  it('treats a skipped required scenario as unproven, not as a pass', () => {
    const results = allRequiredPassing().map((result) =>
      result.scenarioId === 'survival.worker-crash'
        ? {
            ...result,
            status: 'SKIPPED_WITH_REASON' as const,
            skipReason: 'not runnable in this environment',
          }
        : result,
    );
    const verdict = computeVerdict({ ...base, results });
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.scenarios.requiredUnproven).toBe(1);
    expect(
      verdict.blockers.some(
        (blocker) =>
          blocker.class === 'REQUIRED_SCENARIO_NOT_PROVEN' &&
          blocker.detail.includes('survival.worker-crash'),
      ),
    ).toBe(true);
  });

  it('fails on any zero-tolerance condition even when every scenario passed', () => {
    const audits: InvariantAudit[] = [
      {
        schemaVersion: '1.0.0',
        runId: 'r1',
        auditId: 'au-1',
        phase: 'FINAL',
        jobId: 'job-1',
        at: '2026-08-01T12:00:00.000Z',
        checked: ['COMPLETED_TASK_HAS_EVIDENCE'],
        violations: [
          {
            invariantId: 'COMPLETED_TASK_HAS_EVIDENCE',
            detail: 'node n1 is COMPLETED with no evidence reference',
            subject: 'node n1',
            blocking: true,
          },
        ],
        note: null,
      },
    ];
    const verdict = computeVerdict({ ...base, results: allRequiredPassing(), audits });
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.zeroTolerance.evidenceBypassCompletions).toBe(1);
    expect(verdict.blockers.some((blocker) => blocker.class === 'EVIDENCE_BYPASS')).toBe(true);
  });

  it('fails when an injected fault was not survived', () => {
    const faults: FaultInjectionRecord[] = [
      {
        schemaVersion: '1.0.0',
        runId: 'r1',
        faultId: 'f-1',
        faultClass: 'PROCESS_CRASH',
        boundary: 'PROCESS',
        triggerMode: 'ONE_SHOT',
        trigger: 'after the first checkpoint',
        expectedInvariant: 'the job resumes without manual state reconstruction',
        survived: false,
        observed: 'the job could not be resumed',
        scenarioId: 'survival.process-restart',
        injectedAt: '2026-08-01T12:00:00.000Z',
        resolvedAt: null,
      },
    ];
    const verdict = computeVerdict({ ...base, results: allRequiredPassing(), faults });
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.zeroTolerance.unrecoverableInjectedFaults).toBe(1);
    expect(verdict.blockers.some((blocker) => blocker.class === 'UNRECOVERABLE_AFTER_FAULT')).toBe(
      true,
    );
  });

  it('downgrades to PASS_WITH_LIMITATIONS only when correctness and governance held', () => {
    const verdict = computeVerdict({
      ...base,
      results: allRequiredPassing(),
      limitations: [
        {
          class: 'HIGHER_THAN_EXPECTED_CONTEXT',
          detail: 'context per verified task exceeded the heuristic baseline by 40%',
          evidenceRefs: [],
        },
      ],
    });
    expect(verdict.verdict).toBe('PASS_WITH_LIMITATIONS');
    expect(verdict.blockers).toEqual([]);
  });

  it('does not offer PASS_WITH_LIMITATIONS as a softer landing for a real failure', () => {
    const results = allRequiredPassing().map((result) =>
      result.scenarioId === 'reliability.stalled'
        ? { ...result, status: 'FAIL' as const, failureDetail: 'blind retry observed' }
        : result,
    );
    const verdict = computeVerdict({
      ...base,
      results,
      limitations: [
        { class: 'PERFORMANCE_INEFFICIENCY', detail: 'slow but correct', evidenceRefs: [] },
      ],
    });
    expect(verdict.verdict).toBe('FAIL');
  });

  it('records an honestly skipped REQUIRED_WHEN_EXERCISED scenario as a limitation, not a blocker', () => {
    const verdict = computeVerdict({ ...base, results: allRequiredPassing() });
    expect(
      verdict.limitations.some(
        (limitation) =>
          limitation.class === 'COVERAGE_NOT_EXERCISED' &&
          limitation.detail.includes('quota.real-window-observed'),
      ),
    ).toBe(true);
    // …but it does not become a blocker, so an offline CI run is not
    // penalized for lacking a real subscription window.
    expect(verdict.blockers).toEqual([]);
  });

  it('blocks when a REQUIRED_WHEN_EXERCISED scenario was exercised and failed', () => {
    const results = [
      ...allRequiredPassing(),
      { ...passResult('api.real-bridge-observed'), status: 'FAIL' as const, failureDetail: 'spent without approval' },
    ];
    const verdict = computeVerdict({ ...base, results });
    expect(verdict.verdict).toBe('FAIL');
    expect(
      verdict.blockers.some((blocker) => blocker.detail.includes('api.real-bridge-observed')),
    ).toBe(true);
  });

  it('summarizes every matrix entry, including ones the profile cannot reach', () => {
    const summary = summarizeScenarios([], false);
    expect(summary.total).toBe(QUALIFICATION_SCENARIOS.length);
    expect(summary.notRun).toBe(QUALIFICATION_SCENARIOS.length);
    expect(summary.releaseGateStatus).toBe('NOT_RUN');
    expect(summary.releaseGateReason).toMatch(/unmet external prerequisite/i);
  });
});

// ---------------------------------------------------------------------------
// Real vs simulated attribution
// ---------------------------------------------------------------------------

describe('real-versus-simulated attribution', () => {
  it('never promotes a simulated resource to real, and never demotes a real one', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'subscription',
      target: realTarget(fixture.root),
    });
    recordScenarioResult(fixture.deps, {
      runId: run.runId,
      scenarioId: 'quota.harvest',
      status: 'PASS',
      executor: 'test',
      resourceAttribution: { FIVE_HOUR_WINDOW: 'SIMULATED', QUOTA_TELEMETRY: 'SIMULATED' },
    });
    recordScenarioResult(fixture.deps, {
      runId: run.runId,
      scenarioId: 'local.direct-success',
      status: 'PASS',
      executor: 'test',
      resourceAttribution: { LOCAL_DIRECT_MODEL: 'REAL', FIVE_HOUR_WINDOW: 'SIMULATED' },
    });
    const report = buildQualificationReport({
      workspace: fixture.workspace,
      runId: run.runId,
      generatedAt: '2026-08-01T12:00:00.000Z',
    });
    expect(report.resourceAttribution.LOCAL_DIRECT_MODEL).toBe('REAL');
    expect(report.resourceAttribution.FIVE_HOUR_WINDOW).toBe('SIMULATED');
    expect(report.resourceAttribution.API_PROVIDER).toBe('NOT_EXERCISED');
  });

  it('ignores attribution from a scenario that did not actually run', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordScenarioResult(fixture.deps, {
      runId: run.runId,
      scenarioId: 'api.real-bridge-observed',
      status: 'SKIPPED_WITH_REASON',
      executor: 'test',
      skipReason: 'no API resource in this environment',
      resourceAttribution: { API_PROVIDER: 'REAL' },
    });
    const report = buildQualificationReport({
      workspace: fixture.workspace,
      runId: run.runId,
      generatedAt: '2026-08-01T12:00:00.000Z',
    });
    expect(report.resourceAttribution.API_PROVIDER).toBe('NOT_EXERCISED');
  });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

describe('qualification report', () => {
  it('validates against its schema and carries the machine-readable summary CI needs', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    const report = buildQualificationReport({
      workspace: fixture.workspace,
      runId: run.runId,
      generatedAt: '2026-08-01T12:00:00.000Z',
    });
    expect(() => dogfoodQualificationReportSchema.parse(report)).not.toThrow();

    const summary = buildQualificationSummary(report);
    expect(summary['verdict']).toBe('FAIL');
    expect(summary['realTargetQualification']).toBe('NOT_RUN');
    expect(Array.isArray(summary['requiredScenariosUnproven'])).toBe(true);
    expect((summary['requiredScenariosUnproven'] as string[]).length).toBeGreaterThan(0);
  });

  it('renders a human-readable report that states unknown rather than zero', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    const markdown = renderQualificationMarkdown(
      buildQualificationReport({
        workspace: fixture.workspace,
        runId: run.runId,
        generatedAt: '2026-08-01T12:00:00.000Z',
      }),
    );
    expect(markdown).toContain('Release verdict: FAIL');
    expect(markdown).toContain('Real-product qualification: NOT_RUN');
    expect(markdown).toContain('What was real, and what was simulated');
    // An unmeasured API spend prints as unknown, never as $0.0000.
    expect(markdown).toMatch(/API reconciled spend \| unknown/);
    // No prompt, transcript, or reasoning can reach a shared artifact.
    expect(markdown).not.toMatch(/chain-of-thought|transcript|system prompt/i);
  });

  it('is reproducible: two runs with the same records normalize identically', () => {
    const build = (): Record<string, unknown> => {
      const fixture = setupQualificationWorkspace();
      const run = startQualificationRun(fixture.deps, {
        profile: 'offline',
        target: fixtureTarget(),
      });
      for (const outcome of runPolicyScenarios(fixture.config)) {
        recordScenarioResult(fixture.deps, {
          runId: run.runId,
          scenarioId: outcome.scenarioId,
          status: outcome.passed ? 'PASS' : 'FAIL',
          executor: 'test',
          ...(outcome.failureDetail === undefined ? {} : { failureDetail: outcome.failureDetail }),
          observedTransitions: outcome.transitions,
          resourceAttribution: outcome.resourceAttribution,
        });
      }
      return normalizeReportForComparison(
        buildQualificationReport({
          workspace: fixture.workspace,
          runId: run.runId,
          generatedAt: '2026-08-01T12:00:00.000Z',
        }),
      );
    };
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('records dogfood run identity without storing credentials', () => {
    const fixture = setupQualificationWorkspace();
    const run: DogfoodRun = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
      missionDirection: 'Implement a meaningful StepRelay increment.',
      versions: { specBridgeVersion: '1.9.0' },
    });
    expect(run.configurationFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(run.versions.nodeVersion).toBe(process.version);
    expect(run.versions.harnessVersion).toBeNull();
    expect(run.iteration).toBe(1);

    const serialized = JSON.stringify(run);
    expect(serialized).not.toMatch(/api[_-]?key|secret|password|token/i);
  });

  it('chains iterations so progress and regression across runs stay visible', () => {
    const fixture = setupQualificationWorkspace();
    const first = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
      runId: 'qual-iteration-1',
    });
    const second = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
      previousRunId: first.runId,
      runId: 'qual-iteration-2',
    });
    expect(second.iteration).toBe(2);
    expect(second.previousRunId).toBe('qual-iteration-1');
  });

  it('records a Mission scope change with its provenance', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
      approvedScope: ['Deliver the broker-neutral transport seam'],
    });
    const changed = fixture.recordScopeChange(run.runId, {
      originalScope: 'Deliver the broker-neutral transport seam',
      newScope: 'Deliver the in-memory transport only',
      reason: 'the operator reduced scope for this iteration',
      authority: 'operator',
      effectOnQualification: 'the release gate now covers less than the original Mission',
    });
    expect(changed.scopeChanges).toHaveLength(1);
    const report = buildQualificationReport({
      workspace: fixture.workspace,
      runId: run.runId,
      generatedAt: '2026-08-01T12:00:00.000Z',
    });
    const markdown = renderQualificationMarkdown(report);
    // The ORIGINAL scope survives in the report: a reduced Mission can never
    // be presented as though it were the one that was approved.
    expect(markdown).toContain('Deliver the broker-neutral transport seam');
    expect(markdown).toContain('Deliver the in-memory transport only');
  });

  it('shows a defect whose fix has no regression test as uncovered', () => {
    const fixture = setupQualificationWorkspace();
    const run = startQualificationRun(fixture.deps, {
      profile: 'offline',
      target: fixtureTarget(),
    });
    recordDogfoodDefect(fixture.deps, {
      runId: run.runId,
      source: 'RUNTIME_STATE',
      observedFailure: 'resume lost the latest checkpoint',
      rootCause: 'the checkpoint sequence was not fsynced before the state write',
      fix: 'write the checkpoint atomically before the state',
    });
    const markdown = renderQualificationMarkdown(
      buildQualificationReport({
        workspace: fixture.workspace,
        runId: run.runId,
        generatedAt: '2026-08-01T12:00:00.000Z',
      }),
    );
    expect(markdown).toContain('**none — the fix is uncovered**');
  });
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe('preflight', () => {
  it('fails closed on an unknown target repository', () => {
    const fixture = setupQualificationWorkspace();
    const result = runPreflight({
      workspace: fixture.workspace,
      config: fixture.config,
      profile: 'subscription',
      target: {
        ...realTarget(fixture.root),
        repositoryPath: path.join(fixture.root, 'does-not-exist'),
        available: false,
      },
      targetRepository: null,
    });
    expect(result.safe).toBe(false);
    expect(result.findings.some((finding) => finding.id === 'target.repository' && finding.severity === 'refuse')).toBe(
      true,
    );
  });

  it('refuses a dirty working tree that is not an isolated worktree', () => {
    const fixture = setupQualificationWorkspace();
    const result = runPreflight({
      workspace: fixture.workspace,
      config: fixture.config,
      profile: 'subscription',
      target: realTarget(fixture.root),
      targetRepository: {
        isGitRepository: true,
        dirtyPaths: ['src/unrelated.ts'],
        branch: 'main',
        head: 'abc',
        isolatedWorktree: false,
      },
    });
    expect(result.safe).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.id === 'target.working-tree' && finding.severity === 'refuse',
      ),
    ).toBe(true);
  });

  it('refuses spending enabled with no budget ceiling', () => {
    const fixture = setupQualificationWorkspace({
      api: { spendMode: 'MANUAL', harnessProfile: 'api-remote' },
    });
    const result = runPreflight({
      workspace: fixture.workspace,
      config: fixture.config,
      profile: 'offline',
      target: fixtureTarget(),
    });
    expect(result.safe).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.id === 'economics.api-budget' && finding.severity === 'refuse',
      ),
    ).toBe(true);
  });

  it('refuses AUTO_BOUNDED spending with no pricing profile', () => {
    const fixture = setupQualificationWorkspace({
      api: {
        spendMode: 'AUTO_BOUNDED',
        harnessProfile: 'api-remote',
        budget: { maxCostPerJobUsd: 5 },
      },
    });
    const result = runPreflight({
      workspace: fixture.workspace,
      config: fixture.config,
      profile: 'offline',
      target: fixtureTarget(),
    });
    expect(result.safe).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.id === 'economics.api-pricing' && finding.severity === 'refuse',
      ),
    ).toBe(true);
  });

  it('refuses a workspace with no trusted verification commands', () => {
    const fixture = setupQualificationWorkspace({ verificationCommands: [] });
    const result = runPreflight({
      workspace: fixture.workspace,
      config: fixture.config,
      profile: 'offline',
      target: fixtureTarget(),
    });
    expect(result.safe).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.id === 'verification.commands' && finding.severity === 'refuse',
      ),
    ).toBe(true);
  });

  it('passes an offline fixture run and states that it authorizes nothing', () => {
    const fixture = setupQualificationWorkspace();
    const result = runPreflight({
      workspace: fixture.workspace,
      config: fixture.config,
      profile: 'offline',
      target: fixtureTarget(),
    });
    expect(result.safe).toBe(true);
    expect(result.paidCapable).toBe(false);
    expect(result.economics.apiSpendMode).toBe('DISABLED');
  });

  it('surfaces the economic configuration without revealing any credential value', () => {
    const fixture = setupQualificationWorkspace({
      api: {
        spendMode: 'MANUAL',
        harnessProfile: 'api-remote',
        budget: { maxCostPerJobUsd: 12.5, maxCostPerTaskUsd: 3 },
      },
    });
    const economics = economicConfiguration(fixture.config);
    expect(economics.apiSpendMode).toBe('MANUAL');
    expect(economics.apiMaxBudgetUsd).toBe(12.5);
    expect(economics.apiPerTaskCeilingUsd).toBe(3);
    const serialized = JSON.stringify(economics);
    expect(serialized).not.toMatch(/api[_-]?key|secret|password|token|bearer/i);
  });

  it('a full profile with spending disabled is a valid, zero-spend configuration', () => {
    const fixture = setupQualificationWorkspace();
    const result = runPreflight({
      workspace: fixture.workspace,
      config: fixture.config,
      profile: 'full',
      target: fixtureTarget(),
    });
    expect(result.paidCapable).toBe(true);
    expect(
      result.findings.some((finding) => finding.id === 'economics.api-spend' && finding.severity === 'ok'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Configuration fingerprint
// ---------------------------------------------------------------------------

describe('configuration fingerprint', () => {
  it('changes when an economically meaningful value changes', () => {
    const baseline = setupQualificationWorkspace();
    const changed = setupQualificationWorkspace({
      api: { spendMode: 'MANUAL', harnessProfile: 'api-remote', budget: { maxCostPerJobUsd: 5 } },
    });
    expect(configurationFingerprint(changed.config)).not.toBe(
      configurationFingerprint(baseline.config),
    );
  });

  it('is stable across two identical workspaces, so iterations stay comparable', () => {
    expect(configurationFingerprint(setupQualificationWorkspace().config)).toBe(
      configurationFingerprint(setupQualificationWorkspace().config),
    );
  });
});

// ---------------------------------------------------------------------------
// Fault injection scoping
// ---------------------------------------------------------------------------

describe('fault injection', () => {
  it('fires a one-shot fault once and a repeated fault every time', () => {
    const injector = new FaultInjector([
      {
        faultId: 'once',
        faultClass: 'WORKER_CRASH',
        boundary: 'LOCAL_INFERENCE',
        trigger: 'the first executor dispatch',
        expectedInvariant: 'the attempt is INTERRUPTED and the job resumes',
        triggerMode: 'ONE_SHOT',
      },
      {
        faultId: 'always',
        faultClass: 'VERIFICATION_INFRASTRUCTURE_FAILURE',
        boundary: 'VERIFICATION_COMMAND',
        trigger: 'every verification run',
        expectedInvariant: 'the evaluation is INCONCLUSIVE',
        triggerMode: 'REPEATED',
      },
    ]);
    expect(injector.shouldFire('once')).toBe(true);
    expect(injector.shouldFire('once')).toBe(false);
    expect(injector.plan('once')?.spent).toBe(true);
    expect([1, 2, 3].map(() => injector.shouldFire('always'))).toEqual([true, true, true]);
  });

  it('honours an "after N occasions" trigger deterministically', () => {
    const injector = new FaultInjector([
      {
        faultId: 'third',
        faultClass: 'PROCESS_CRASH',
        boundary: 'PROCESS',
        trigger: 'after two checkpoints',
        expectedInvariant: 'state reconciles on restart',
        triggerMode: 'ONE_SHOT',
        after: 2,
      },
    ]);
    expect([1, 2, 3, 4].map(() => injector.shouldFire('third'))).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it('answers false for a fault that was never armed', () => {
    expect(new FaultInjector().shouldFire('not-armed')).toBe(false);
  });

  it('reports armed faults that never fired as an incomplete injection plan', () => {
    const injector = new FaultInjector([
      {
        faultId: 'unused',
        faultClass: 'SESSION_LOSS',
        boundary: 'DURABLE_STATE',
        trigger: 'never',
        expectedInvariant: 'n/a',
        triggerMode: 'ONE_SHOT',
      },
    ]);
    expect(injector.unfired().map((plan) => plan.faultId)).toEqual(['unused']);
  });

  it('produces a durable record naming the boundary and the expected invariant', () => {
    const record = toFaultRecord({
      runId: 'r1',
      spec: {
        faultId: 'f-1',
        faultClass: 'DERIVED_CONTEXT_CACHE_LOSS',
        boundary: 'DERIVED_CACHE',
        trigger: 'after the index is first built',
        expectedInvariant: 'the index rebuilds and no canonical state is lost',
        triggerMode: 'ONE_SHOT',
      },
      injectedAt: '2026-08-01T12:00:00.000Z',
      survived: true,
      observed: 'the index was rebuilt on the next dispatch',
    });
    expect(record.boundary).toBe('DERIVED_CACHE');
    expect(record.survived).toBe(true);
  });

  /**
   * The scoping proof for `governance.fault-injection-scoping`.
   *
   * Structural rather than behavioural: no production runtime module imports
   * the fault module, and no configuration key, environment variable, or
   * agent-reachable surface constructs one. A fault can therefore only fire
   * when a caller builds the plan in code and hands it to a seam it is
   * already injecting.
   */
  it('has no production runtime importer and no configuration surface', () => {
    const srcRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'packages',
    );
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const relative = path.relative(srcRoot, full).split(path.sep).join('/');
        // The qualification module itself and its own index legitimately
        // reference the fault model; nothing else may.
        if (relative.includes('/qualification/')) continue;
        const contents = readFileSync(full, 'utf8');
        if (/from '.*qualification\/faults\.js'/.test(contents)) importers.push(relative);
      }
    };
    walk(srcRoot);
    expect(importers).toEqual([]);

    // No configuration schema mentions fault injection anywhere.
    const configSource = readFileSync(
      path.join(srcRoot, 'core', 'src', 'orchestration-config.ts'),
      'utf8',
    );
    expect(configSource).not.toMatch(/faultInjection|injectFault|FAULT_/);
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe('release artifacts', () => {
  it('names the four canonical artifacts', () => {
    expect(Object.values(QUALIFICATION_ARTIFACTS).sort()).toEqual([
      'mission-metrics.json',
      'qualification-report.md',
      'qualification-summary.json',
      'scenario-results.json',
    ]);
  });
});
