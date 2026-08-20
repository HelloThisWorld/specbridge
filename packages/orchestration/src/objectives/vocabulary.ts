/**
 * The stable vocabulary of the objective runtime.
 *
 * An OBJECTIVE is one approved leaf task of a mission-driven spec — the
 * human contract. A WORK UNIT is runtime-internal decomposition of that
 * objective: it lives in `.specbridge/jobs/<jobId>/objectives/`, never in
 * `.kiro`, and no work-unit id ever appears in an approved document.
 *
 * Everything here is a closed string enum, additive within 1.x, snapshotted
 * into `contracts/orchestration-contract.json` alongside the job vocabulary.
 */

// ---------------------------------------------------------------------------
// Work units
// ---------------------------------------------------------------------------

/**
 * Statuses of one work unit. Every status is observable and resumable after
 * a process interruption; in-flight statuses (BUILDING, EVALUATING,
 * INTEGRATING) are reconciled to their safe predecessor on resume, exactly
 * like job nodes.
 *
 * `VERIFIED_CANDIDATE` means "this unit's candidate passed deterministic
 * (and, where required, semantic) evaluation" — a prerequisite for
 * integration, NEVER completion. `INTEGRATED` means the single-writer
 * integration path applied it to the canonical tree. Objective completion
 * is a separate fact owned by the unchanged evidence pipeline.
 */
export const WORK_UNIT_STATUSES = [
  /** Declared in the work graph; dependencies not yet satisfied. */
  'PLANNED',
  /** Dependencies satisfied; the unit can be dispatched. */
  'READY',
  /** A builder attempt is in flight in an isolated worktree. */
  'BUILDING',
  /** A candidate artifact exists and awaits evaluation. */
  'CANDIDATE_READY',
  /** A semantic evaluation dispatch is in flight. */
  'EVALUATING',
  /** The candidate passed every required evaluation layer. */
  'VERIFIED_CANDIDATE',
  /** The candidate was rejected; the unit may retry within budget. */
  'REJECTED',
  /** The unit ended without a verified candidate. */
  'FAILED',
  /** The unit cannot proceed without an explicit decision. */
  'BLOCKED',
  /** The unit was replaced in a later work-graph revision. */
  'SUPERSEDED',
  /** The unit's candidate was applied by the canonical integrator. */
  'INTEGRATED',
] as const;
export type WorkUnitStatus = (typeof WORK_UNIT_STATUSES)[number];

export const FINAL_WORK_UNIT_STATUSES: readonly WorkUnitStatus[] = [
  'FAILED',
  'SUPERSEDED',
  'INTEGRATED',
];

export function isFinalWorkUnitStatus(status: WorkUnitStatus): boolean {
  return FINAL_WORK_UNIT_STATUSES.includes(status);
}

/**
 * What kind of output a work unit produces.
 *
 *  - `build`         source changes, delivered as a candidate patch
 *  - `investigation` a structured report (no repository mutation at all)
 *  - `integration`   the reserved final unit: it has no builder — the
 *                    deterministic integrator (plus, at most, one bounded
 *                    INTEGRATOR reconciliation dispatch) owns it
 */
export const WORK_UNIT_KINDS = ['build', 'investigation', 'integration'] as const;
export type WorkUnitKind = (typeof WORK_UNIT_KINDS)[number];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export const EVALUATION_LAYERS = ['deterministic', 'semantic'] as const;
export type EvaluationLayer = (typeof EVALUATION_LAYERS)[number];

/**
 * The closed verdict vocabulary of both evaluation layers. `CONFLICT` and
 * `NEEDS_DECISION` are first-class outcomes, not failures: they carry the
 * affected contracts and the decision kind, and route through the existing
 * decision-authority table — an aggregator can never silently pick a side.
 */
export const EVALUATION_VERDICTS = ['PASS', 'FAIL', 'CONFLICT', 'NEEDS_DECISION'] as const;
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

/** Lifecycle of one supervised worker attempt. */
export const OBJECTIVE_WORKER_STATUSES = [
  'RUNNING',
  'FINISHED',
  'FAILED',
  /** A later attempt or graph revision replaced this worker; results from it are refused. */
  'SUPERSEDED',
] as const;
export type ObjectiveWorkerStatus = (typeof OBJECTIVE_WORKER_STATUSES)[number];

// ---------------------------------------------------------------------------
// Contract conflicts
// ---------------------------------------------------------------------------

export const CONTRACT_CONFLICT_STATUSES = [
  'OPEN',
  /** Resolved autonomously (implementation-detail conflicts only). */
  'RESOLVED_AUTO',
  /** Resolved by an explicit human decision. */
  'RESOLVED_HUMAN',
] as const;
export type ContractConflictStatus = (typeof CONTRACT_CONFLICT_STATUSES)[number];
