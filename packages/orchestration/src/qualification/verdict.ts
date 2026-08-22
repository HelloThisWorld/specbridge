import type {
  DogfoodDefect,
  FaultInjectionRecord,
  HumanIntervention,
  InvariantAudit,
  QualificationLimitation,
  ReleaseBlocker,
  ScenarioResult,
  ScenarioSummary,
  ZeroToleranceReport,
} from './state.js';
import type { QualificationScenario } from './matrix.js';
import { QUALIFICATION_SCENARIOS, RELEASE_GATE_SCENARIO_ID } from './matrix.js';
import type { QualificationProfile, ReleaseVerdict } from './vocabulary.js';
import { BLOCKING_STATE_INVARIANTS } from './vocabulary.js';

/**
 * The release gate (vNext.9).
 *
 * Everything here is a pure function of durable records, and the ORDER is
 * the policy — reading it top to bottom is reading the argument:
 *
 *   1. zero-tolerance integrity conditions, which are counted, not judged
 *   2. required scenarios, where a skip is not a pass
 *   3. the real-product release gate, which a fixture can never satisfy
 *   4. only then, limitations, which can downgrade but never upgrade
 *
 * There is no path in this file from "the Mission produced code" to PASS,
 * and no parameter that relaxes a gate. If qualification fails, the two
 * available responses are to fix the defect or to report FAIL — which is
 * why `computeVerdict` takes no options object at all.
 */

export interface VerdictInput {
  profile: QualificationProfile;
  results: readonly ScenarioResult[];
  audits: readonly InvariantAudit[];
  faults: readonly FaultInjectionRecord[];
  interventions: readonly HumanIntervention[];
  defects: readonly DogfoodDefect[];
  limitations: readonly QualificationLimitation[];
  /** True when the run is bound to the real product repository. */
  realTargetAvailable: boolean;
}

export interface VerdictResult {
  verdict: ReleaseVerdict;
  /** Discrete, auditable statements supporting the verdict. */
  basis: string[];
  blockers: ReleaseBlocker[];
  limitations: QualificationLimitation[];
  zeroTolerance: ZeroToleranceReport;
  scenarios: ScenarioSummary;
  realTargetQualification: 'PASSED' | 'FAILED' | 'NOT_RUN';
  realTargetQualificationReason: string | null;
}

/**
 * Count the zero-tolerance conditions from observed records.
 *
 * Each condition is derived from a DIFFERENT kind of evidence on purpose:
 * blocking invariant violations come from the state auditor, unrecoverable
 * faults from the injection records, manual state repairs from the
 * intervention log. A condition that could only be reported by one
 * subsystem would be one bug away from silently reading zero.
 */
export function countZeroToleranceConditions(input: {
  results: readonly ScenarioResult[];
  audits: readonly InvariantAudit[];
  faults: readonly FaultInjectionRecord[];
  interventions: readonly HumanIntervention[];
}): ZeroToleranceReport {
  const report: ZeroToleranceReport = {
    unauthorizedPaidExecutions: 0,
    canonicalStateLosses: 0,
    adaptiveHardPolicyBypasses: 0,
    evidenceBypassCompletions: 0,
    unrecoverableInjectedFaults: 0,
    acceptedProtectedStateMutations: 0,
    unboundedRetryLoops: 0,
    manualDurableStateRepairs: 0,
    dependentsOnFailedPredecessors: 0,
  };

  for (const audit of input.audits) {
    for (const entry of audit.violations) {
      if (!BLOCKING_STATE_INVARIANTS.includes(entry.invariantId)) continue;
      switch (entry.invariantId) {
        case 'NO_API_SPEND_WITHOUT_AUTHORITY':
          report.unauthorizedPaidExecutions += 1;
          break;
        case 'API_BUDGET_RECONCILES':
          report.unauthorizedPaidExecutions += 1;
          break;
        case 'COMPLETED_TASK_HAS_EVIDENCE':
        case 'COMPLETED_TASK_HAS_EVALUATION':
          report.evidenceBypassCompletions += 1;
          break;
        case 'DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS':
          report.dependentsOnFailedPredecessors += 1;
          break;
        case 'LOCAL_ATTEMPTS_VERIFIED_LOCAL':
          // Remote compute reported as local is an economic-integrity
          // violation and is counted as a canonical-state loss for the
          // purposes of the gate: the record says something untrue.
          report.canonicalStateLosses += 1;
          break;
        case 'GRAPH_REVISION_RESOLVES':
          report.canonicalStateLosses += 1;
          break;
        default:
          report.canonicalStateLosses += 1;
      }
    }
  }

  for (const fault of input.faults) {
    if (fault.survived === false) report.unrecoverableInjectedFaults += 1;
  }

  for (const intervention of input.interventions) {
    if (intervention.kind === 'MANUAL_STATE_REPAIR') report.manualDurableStateRepairs += 1;
  }

  // Scenario failures map onto the conditions their invariant protects. A
  // failed scenario is always a blocker in its own right (below); this
  // mapping exists so the zero-tolerance table stays a faithful summary
  // rather than a second, looser opinion.
  for (const result of input.results) {
    if (result.status !== 'FAIL') continue;
    if (result.faultClasses.includes('PROTECTED_STATE_MUTATION')) {
      report.acceptedProtectedStateMutations += 1;
    }
    if (result.faultClasses.includes('ADAPTIVE_POLICY_VETO')) {
      report.adaptiveHardPolicyBypasses += 1;
    }
    if (
      result.faultClasses.includes('REPEATED_IDENTICAL_FAILURE') ||
      result.faultClasses.includes('HARNESS_RUNAWAY') ||
      result.faultClasses.includes('EDIT_OSCILLATION')
    ) {
      report.unboundedRetryLoops += 1;
    }
    if (
      result.faultClasses.includes('API_BUDGET_EXHAUSTION') ||
      result.faultClasses.includes('API_DISABLED') ||
      result.faultClasses.includes('INTERRUPTED_PAID_ATTEMPT')
    ) {
      report.unauthorizedPaidExecutions += 1;
    }
    if (result.faultClasses.includes('REMOTE_MISCLASSIFIED_AS_LOCAL')) {
      report.canonicalStateLosses += 1;
    }
    if (result.faultClasses.includes('CONTEXT_SATURATION')) {
      report.canonicalStateLosses += 1;
    }
  }

  return report;
}

/**
 * Roll scenario results up against the matrix.
 *
 * Every matrix entry is counted, including ones the current profile could
 * never execute. That is deliberate: a summary that quietly dropped
 * out-of-profile scenarios would understate exactly how much of the release
 * claim is still unproven.
 */
export function summarizeScenarios(
  results: readonly ScenarioResult[],
  realTargetAvailable: boolean,
): ScenarioSummary {
  const byId = new Map(results.map((result) => [result.scenarioId, result]));
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let notRun = 0;
  let requiredTotal = 0;
  let requiredPassed = 0;
  let requiredFailed = 0;
  let requiredUnproven = 0;

  for (const scenario of QUALIFICATION_SCENARIOS) {
    const result = byId.get(scenario.id);
    const status = result?.status ?? 'NOT_RUN';
    if (status === 'PASS') passed += 1;
    else if (status === 'FAIL') failed += 1;
    else if (status === 'SKIPPED_WITH_REASON') skipped += 1;
    else notRun += 1;

    if (scenario.requirement !== 'REQUIRED') continue;
    requiredTotal += 1;
    if (status === 'PASS') requiredPassed += 1;
    else if (status === 'FAIL') requiredFailed += 1;
    else requiredUnproven += 1;
  }

  const gate = byId.get(RELEASE_GATE_SCENARIO_ID);
  const gateStatus = gate?.status ?? 'NOT_RUN';
  const gateReason =
    gateStatus === 'PASS'
      ? null
      : gateStatus === 'FAIL'
        ? (gate?.failureDetail ?? 'The real product Mission did not reach verified completion.')
        : realTargetAvailable
          ? (gate?.skipReason ??
            'The real product Mission has not been run in this qualification run.')
          : 'The real dogfood target repository is not available in this execution environment; ' +
            'the real-product release gate is an unmet external prerequisite.';

  return {
    total: QUALIFICATION_SCENARIOS.length,
    passed,
    failed,
    skipped,
    notRun,
    requiredTotal,
    requiredPassed,
    requiredFailed,
    requiredUnproven,
    releaseGateStatus: gateStatus,
    releaseGateReason: gateReason,
  };
}

function scenarioLabel(scenario: QualificationScenario): string {
  return `${scenario.id} (${scenario.area}) — ${scenario.title}`;
}

/**
 * Compute the release verdict.
 *
 * Takes no policy parameters, deliberately. Every input is an observation,
 * and there is no argument by which a caller can make a gate more permissive
 * for one run than for another.
 */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const blockers: ReleaseBlocker[] = [];
  const basis: string[] = [];
  const byId = new Map(input.results.map((result) => [result.scenarioId, result]));

  const zeroTolerance = countZeroToleranceConditions({
    results: input.results,
    audits: input.audits,
    faults: input.faults,
    interventions: input.interventions,
  });
  const scenarios = summarizeScenarios(input.results, input.realTargetAvailable);

  // -- 1. Zero-tolerance integrity conditions -------------------------------
  const zeroToleranceBlockers: [keyof ZeroToleranceReport, ReleaseBlocker['class'], string][] = [
    ['unauthorizedPaidExecutions', 'UNAUTHORIZED_API_SPEND', 'paid execution without authority or budget'],
    ['canonicalStateLosses', 'CANONICAL_STATE_LOSS', 'canonical state loss or an untrue durable record'],
    ['adaptiveHardPolicyBypasses', 'ADAPTIVE_HARD_POLICY_BYPASS', 'adaptive placement bypassing hard policy'],
    ['evidenceBypassCompletions', 'EVIDENCE_BYPASS', 'a completion accepted without trusted evidence'],
    ['unrecoverableInjectedFaults', 'UNRECOVERABLE_AFTER_FAULT', 'an injected fault the runtime did not survive'],
    ['acceptedProtectedStateMutations', 'PROTECTED_STATE_MUTATION', 'an accepted mutation of protected control state'],
    ['unboundedRetryLoops', 'UNBOUNDED_RETRY_LOOP', 'unbounded retry or runaway behaviour'],
    ['manualDurableStateRepairs', 'MANUAL_STATE_REPAIR_REQUIRED', 'a human had to repair durable state'],
    ['dependentsOnFailedPredecessors', 'DEPENDENT_WORK_ON_UNVERIFIED_PREDECESSOR', 'dependent work built on an unverified predecessor'],
  ];
  for (const [condition, blockerClass, description] of zeroToleranceBlockers) {
    const count = zeroTolerance[condition];
    if (count === 0) continue;
    blockers.push({
      class: blockerClass,
      detail: `Zero-tolerance condition "${condition}" was observed ${count} time(s): ${description}.`,
      evidenceRefs: [],
    });
  }

  // -- 2. Required scenarios ------------------------------------------------
  for (const scenario of QUALIFICATION_SCENARIOS) {
    if (scenario.requirement !== 'REQUIRED') continue;
    const result = byId.get(scenario.id);
    const status = result?.status ?? 'NOT_RUN';
    if (status === 'PASS') continue;
    if (status === 'FAIL') {
      blockers.push({
        class: 'REQUIRED_SCENARIO_FAILED',
        detail: `${scenarioLabel(scenario)} FAILED: ${result?.failureDetail ?? 'no detail recorded'}`,
        evidenceRefs: result?.evidenceRefs ?? [],
      });
      continue;
    }
    // A skip and a never-run are the same thing for a REQUIRED scenario: the
    // claim is unproven. The reason is carried through so the report can say
    // which it was.
    blockers.push({
      class: 'REQUIRED_SCENARIO_NOT_PROVEN',
      detail:
        `${scenarioLabel(scenario)} is ${status}: ` +
        `${result?.skipReason ?? 'it has not been executed in this qualification run'}`,
      evidenceRefs: result?.evidenceRefs ?? [],
    });
  }

  // -- 3. REQUIRED_WHEN_EXERCISED -------------------------------------------
  //
  // A scenario that was attempted and failed blocks; one that was honestly
  // skipped does not, and is recorded as a coverage limitation instead.
  const limitations: QualificationLimitation[] = [...input.limitations];
  for (const scenario of QUALIFICATION_SCENARIOS) {
    if (scenario.requirement !== 'REQUIRED_WHEN_EXERCISED') continue;
    const result = byId.get(scenario.id);
    if (result === undefined || result.status === 'NOT_RUN' || result.status === 'SKIPPED_WITH_REASON') {
      limitations.push({
        class: 'COVERAGE_NOT_EXERCISED',
        detail:
          `${scenarioLabel(scenario)} was not exercised: ` +
          `${result?.skipReason ?? 'the required real resource was not available in this environment'}`,
        evidenceRefs: [],
      });
      continue;
    }
    if (result.status === 'FAIL') {
      blockers.push({
        class: 'REQUIRED_SCENARIO_FAILED',
        detail: `${scenarioLabel(scenario)} was exercised and FAILED: ${result.failureDetail ?? 'no detail recorded'}`,
        evidenceRefs: result.evidenceRefs,
      });
    }
  }

  // -- 4. Open blocking defects ---------------------------------------------
  for (const defect of input.defects) {
    if (!defect.blocking || defect.resolvedAt !== null) continue;
    blockers.push({
      class: 'REQUIRED_SCENARIO_FAILED',
      detail: `Open blocking defect ${defect.defectId} (${defect.source}): ${defect.observedFailure}`,
      evidenceRefs: [],
    });
  }

  // -- 5. The real-product release gate -------------------------------------
  let realTargetQualification: VerdictResult['realTargetQualification'];
  if (scenarios.releaseGateStatus === 'PASS') realTargetQualification = 'PASSED';
  else if (scenarios.releaseGateStatus === 'FAIL') realTargetQualification = 'FAILED';
  else realTargetQualification = 'NOT_RUN';

  if (realTargetQualification === 'FAILED') {
    blockers.push({
      class: 'REQUIRED_SCENARIO_FAILED',
      detail: `The real-product release gate FAILED: ${scenarios.releaseGateReason ?? 'no detail recorded'}`,
      evidenceRefs: byId.get(RELEASE_GATE_SCENARIO_ID)?.evidenceRefs ?? [],
    });
  }

  // -- Verdict ---------------------------------------------------------------
  //
  // The release gate is a HARD requirement for PASS and for
  // PASS_WITH_LIMITATIONS alike. A run that proved every deterministic
  // scenario but never qualified the real product has demonstrated the
  // machinery, not the release — and calling that PASS_WITH_LIMITATIONS
  // would be exactly the exaggeration §140 forbids.
  let verdict: ReleaseVerdict;
  if (blockers.length > 0) {
    verdict = 'FAIL';
  } else if (realTargetQualification !== 'PASSED') {
    verdict = 'FAIL';
    blockers.push({
      class: 'REQUIRED_SCENARIO_NOT_PROVEN',
      detail:
        `The real-product release gate is ${scenarios.releaseGateStatus}: ` +
        `${scenarios.releaseGateReason ?? 'not run'}`,
      evidenceRefs: [],
    });
  } else if (limitations.length > 0) {
    verdict = 'PASS_WITH_LIMITATIONS';
  } else {
    verdict = 'PASS';
  }

  // -- Basis -----------------------------------------------------------------
  basis.push(
    `Required scenarios: ${scenarios.requiredPassed} passed, ${scenarios.requiredFailed} failed, ` +
      `${scenarios.requiredUnproven} unproven, of ${scenarios.requiredTotal}.`,
  );
  const observedConditions = (
    Object.entries(zeroTolerance) as [keyof ZeroToleranceReport, number][]
  )
    .filter(([, count]) => count > 0)
    .map(([condition, count]) => `${condition}=${count}`);
  basis.push(
    observedConditions.length === 0
      ? 'Zero-tolerance conditions observed: none.'
      : `Zero-tolerance conditions observed: ${observedConditions.join(', ')}.`,
  );
  basis.push(
    `Invariant audits: ${input.audits.length} taken, ` +
      `${input.audits.reduce((total, audit) => total + audit.violations.filter((v) => v.blocking).length, 0)} blocking violation(s).`,
  );
  basis.push(
    `Fault injections: ${input.faults.length} recorded, ` +
      `${input.faults.filter((fault) => fault.survived === true).length} survived, ` +
      `${input.faults.filter((fault) => fault.survived === false).length} not survived, ` +
      `${input.faults.filter((fault) => fault.survived === null).length} unresolved.`,
  );
  basis.push(
    `Human interventions: ${input.interventions.length} recorded ` +
      `(${input.interventions.filter((entry) => entry.kind === 'REQUIRED_BY_POLICY').length} required by policy, ` +
      `${input.interventions.filter((entry) => entry.kind === 'MANUAL_CODE_FIX').length} manual code fixes, ` +
      `${input.interventions.filter((entry) => entry.kind === 'MANUAL_STATE_REPAIR').length} manual state repairs).`,
  );
  basis.push(
    `Real-product qualification: ${realTargetQualification}` +
      (scenarios.releaseGateReason === null ? '.' : ` — ${scenarios.releaseGateReason}`),
  );
  if (limitations.length > 0) {
    basis.push(`Documented non-blocking limitations: ${limitations.length}.`);
  }

  return {
    verdict,
    basis,
    blockers,
    limitations,
    zeroTolerance,
    scenarios,
    realTargetQualification,
    realTargetQualificationReason: scenarios.releaseGateReason,
  };
}
