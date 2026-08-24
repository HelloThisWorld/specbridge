import type { WorkspaceInfo } from '@specbridge/core';
import { clearOperationalState, enterControlPlaneRepair } from '@specbridge/orchestration';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, newRecordId, nowIso } from '../deps.js';
import {
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  writeJsonRecord,
} from '../store.js';
import type { ControlPlaneDefectKind, ControlPlaneRepairStage } from '../vocabulary.js';
import { CONTROL_PLANE_REPAIR_STAGES } from '../vocabulary.js';
import type { InvariantViolation } from './invariant-screen.js';
import { parseUnifiedDiff, screenPatchForInvariants } from './invariant-screen.js';
import type { ControlPlaneRepair } from './state.js';
import { REPAIR_SCHEMA_VERSION, controlPlaneRepairSchema } from './state.js';

/**
 * Governed control-plane self-repair.
 *
 * The lifecycle is a strict prefix of `CONTROL_PLANE_REPAIR_STAGES`: a
 * repair may only complete the next stage, never skip one, and the ordering
 * is the safety argument. Diagnose before patching; add a regression test
 * before running the focused tests; pass the FULL qualification before
 * rebuilding; rebuild before verifying; verify before canarying; canary
 * before activating; activate before resuming the product job.
 *
 * Two properties are worth stating outright because they are what make this
 * safe to run unattended:
 *
 *   The running control plane is never overwritten. A repair builds into a
 *   STAGED artifact path and records a pointer; the supervisor adopts it on
 *   its next start. A process that rewrites its own executable mid-flight is
 *   a class of failure nobody should debug at 4am.
 *
 *   A patch that weakens a protected invariant is REJECTED, not reviewed.
 *   The screen runs before the tests, so a patch that disables the
 *   verification gate never even gets the chance to make the suite green.
 */

export function repairFile(workspace: WorkspaceInfo, repairId: string): string {
  assertAutonomyId('control-plane repair', repairId);
  return autonomyPath(workspace, 'repairs', `${repairId}.json`);
}

export function readControlPlaneRepair(
  workspace: WorkspaceInfo,
  repairId: string,
): ControlPlaneRepair | undefined {
  return readJsonRecord(repairFile(workspace, repairId), (raw) =>
    controlPlaneRepairSchema.parse(raw),
  );
}

export function listControlPlaneRepairs(workspace: WorkspaceInfo): ControlPlaneRepair[] {
  return listJsonRecords(autonomyPath(workspace, 'repairs'), (raw) =>
    controlPlaneRepairSchema.parse(raw),
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectRepairInput {
  productJobId: string;
  defectKind: ControlPlaneDefectKind;
  symptom: string;
  /** The exact operation to re-run once the repair is built. */
  canaryOperation: string;
  repairId?: string | undefined;
}

/**
 * Open a repair and suspend the product job.
 *
 * The product job goes to REPAIRING_CONTROL_PLANE, which is an operational
 * status the supervisor can leave on its own — the whole point being that a
 * SpecBridge defect stops being a reason for a human to wake up.
 */
export function detectControlPlaneDefect(
  deps: AutonomyDeps,
  input: DetectRepairInput,
): ControlPlaneRepair {
  const policy = autonomyPolicyOf(deps).controlPlaneRepair;
  if (!policy.enabled) {
    throw new AutonomyError(
      'SBA022',
      'Control-plane self-repair is disabled by `autonomy.controlPlaneRepair.enabled`.',
      {
        remediation: [
          'Enable it and set `sourcePath` to the SpecBridge checkout a repair may patch.',
        ],
      },
    );
  }
  if (policy.sourcePath === undefined) {
    throw new AutonomyError(
      'SBA022',
      'Control-plane self-repair is enabled but no `sourcePath` names the SpecBridge checkout.',
      { remediation: ['Set autonomy.controlPlaneRepair.sourcePath to an absolute path.'] },
    );
  }
  const existing = listControlPlaneRepairs(deps.workspace).filter(
    (repair) => repair.productJobId === input.productJobId,
  );
  if (existing.length >= policy.maxRepairsPerJob) {
    throw new AutonomyError(
      'SBA022',
      `Job ${input.productJobId} has already used its ${policy.maxRepairsPerJob} control-plane repair(s).`,
      {
        remediation: [
          'A product job that keeps hitting control-plane defects is a signal for a person, ' +
            'not for another self-repair cycle.',
        ],
      },
    );
  }

  const at = nowIso(deps);
  const repair = controlPlaneRepairSchema.parse({
    schemaVersion: REPAIR_SCHEMA_VERSION,
    repairId: input.repairId ?? newRecordId(deps, 'cpr'),
    productJobId: input.productJobId,
    defectKind: input.defectKind,
    symptom: input.symptom.slice(0, 4_000),
    canaryOperation: input.canaryOperation.slice(0, 4_000),
    status: 'IN_PROGRESS',
    stagesCompleted: ['DETECTED'],
    createdAt: at,
    updatedAt: at,
  });
  writeJsonRecord(repairFile(deps.workspace, repair.repairId), repair);

  try {
    enterControlPlaneRepair(jobDepsOf(deps), input.productJobId, {
      repairId: repair.repairId,
      kind: input.defectKind,
      detail: input.symptom,
    });
    completeStage(deps, repair.repairId, 'PRODUCT_JOB_CHECKPOINTED');
  } catch {
    // A repair opened from a certification fixture has no product job. The
    // repair record is still the authority for what happened.
  }
  return readControlPlaneRepair(deps.workspace, repair.repairId) ?? repair;
}

// ---------------------------------------------------------------------------
// Stage progression
// ---------------------------------------------------------------------------

/**
 * Complete the NEXT stage.
 *
 * Refuses anything else. A repair that could jump from DIAGNOSED to
 * ACTIVATED would be a repair with no qualification, and the ordering is the
 * only thing standing between "SpecBridge fixed itself" and "SpecBridge
 * changed itself".
 */
export function completeStage(
  deps: AutonomyDeps,
  repairId: string,
  stage: ControlPlaneRepairStage,
  patch: Partial<ControlPlaneRepair> = {},
): ControlPlaneRepair {
  const repair = requireRepair(deps.workspace, repairId);
  const expectedIndex = repair.stagesCompleted.length;
  const actualIndex = CONTROL_PLANE_REPAIR_STAGES.indexOf(stage);
  if (actualIndex !== expectedIndex) {
    throw new AutonomyError(
      'SBA022',
      `Repair ${repairId} cannot complete ${stage}: the next stage is ` +
        `${CONTROL_PLANE_REPAIR_STAGES[expectedIndex] ?? '(none; the repair is finished)'}.`,
      {
        remediation: ['Stages complete in order; a skipped stage is an unverified repair.'],
        details: { completed: repair.stagesCompleted.length, attempted: stage },
      },
    );
  }
  return save(deps, {
    ...repair,
    ...patch,
    stagesCompleted: [...repair.stagesCompleted, stage],
  });
}

// ---------------------------------------------------------------------------
// The invariant gate
// ---------------------------------------------------------------------------

export interface PatchScreenResult {
  accepted: boolean;
  violations: InvariantViolation[];
  repair: ControlPlaneRepair;
}

/**
 * Screen the patch and record the verdict.
 *
 * An unreadable diff is a REFUSAL rather than a pass. "We could not look at
 * the patch" and "we looked and it was fine" must never produce the same
 * outcome, and this is the one place where the distinction is load-bearing.
 */
export function screenRepairPatch(
  deps: AutonomyDeps,
  input: { repairId: string; diff: string; changedFiles: readonly string[] },
): PatchScreenResult {
  const repair = requireRepair(deps.workspace, input.repairId);
  const lines = parseUnifiedDiff(input.diff);
  if (lines.length === 0 && input.diff.trim().length > 0) {
    const rejected = save(deps, {
      ...repair,
      status: 'ABANDONED',
      finishedAt: nowIso(deps),
      outcomeDetail:
        'the patch diff could not be parsed, so it could not be screened; an unscreened ' +
        'control-plane patch is never activated',
    });
    return { accepted: false, violations: [], repair: rejected };
  }
  const violations = screenPatchForInvariants(lines);
  if (violations.length > 0) {
    const rejected = save(deps, {
      ...repair,
      status: 'REJECTED_WEAKENS_INVARIANT',
      finishedAt: nowIso(deps),
      invariantViolations: violations.map((violation) => ({ ...violation })),
      changedFiles: [...input.changedFiles].slice(0, 200),
      outcomeDetail:
        `the patch weakens ${violations.length} protected invariant(s): ` +
        `${[...new Set(violations.map((v) => v.invariant))].join(', ')}`,
    });
    return { accepted: false, violations, repair: rejected };
  }
  return {
    accepted: true,
    violations: [],
    repair: save(deps, { ...repair, changedFiles: [...input.changedFiles].slice(0, 200) }),
  };
}

// ---------------------------------------------------------------------------
// Terminal outcomes
// ---------------------------------------------------------------------------

/**
 * Activate a fully-verified repair and resume the product job.
 *
 * Refuses unless every stage up to CANARY_PASSED is complete AND a
 * regression test was recorded. The regression test is not optional: a
 * control-plane fix with no test is a fix that will be reintroduced, and the
 * next unattended run will spend another night on it.
 */
export function activateRepair(
  deps: AutonomyDeps,
  input: { repairId: string; artifactPath: string },
): ControlPlaneRepair {
  const repair = requireRepair(deps.workspace, input.repairId);
  if (repair.regressionTestPath === undefined) {
    throw new AutonomyError(
      'SBA022',
      `Repair ${input.repairId} has no regression test; it will not be activated.`,
      {
        remediation: [
          'Add a test that fails against the defect and passes against the fix, then re-run ' +
            'the focused tests.',
        ],
      },
    );
  }
  const required: ControlPlaneRepairStage = 'CANARY_PASSED';
  if (!repair.stagesCompleted.includes(required)) {
    throw new AutonomyError(
      'SBA022',
      `Repair ${input.repairId} has not passed the canary; it will not be activated.`,
      {
        remediation: [
          'Re-run the exact operation that failed against the rebuilt artifact before switching to it.',
        ],
      },
    );
  }
  const activated = completeStage(deps, input.repairId, 'ACTIVATED', {
    artifactPath: input.artifactPath.slice(0, 200),
  });
  const resumed = completeStage(deps, input.repairId, 'PRODUCT_JOB_RESUMED', {
    status: 'SUCCEEDED',
    finishedAt: nowIso(deps),
    outcomeDetail: 'the repaired build passed qualification and the canary; the product job resumed',
  });
  try {
    clearOperationalState(jobDepsOf(deps), activated.productJobId, {
      resolution: `control-plane repair ${input.repairId} activated`,
    });
  } catch {
    // Certification fixtures have no product job to resume.
  }
  return resumed;
}

export function abandonRepair(
  deps: AutonomyDeps,
  input: {
    repairId: string;
    status: 'ABANDONED' | 'FAILED_QUALIFICATION' | 'FAILED_CANARY';
    detail: string;
  },
): ControlPlaneRepair {
  const repair = requireRepair(deps.workspace, input.repairId);
  return save(deps, {
    ...repair,
    status: input.status,
    finishedAt: nowIso(deps),
    outcomeDetail: input.detail.slice(0, 4_000),
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireRepair(workspace: WorkspaceInfo, repairId: string): ControlPlaneRepair {
  const repair = readControlPlaneRepair(workspace, repairId);
  if (repair === undefined) {
    throw new AutonomyError('SBA022', `No control-plane repair "${repairId}" exists.`);
  }
  return repair;
}

function save(deps: AutonomyDeps, repair: ControlPlaneRepair): ControlPlaneRepair {
  const next = controlPlaneRepairSchema.parse({ ...repair, updatedAt: nowIso(deps) });
  writeJsonRecord(repairFile(deps.workspace, next.repairId), next);
  return next;
}

/**
 * Where a repair stages its build.
 *
 * Deliberately NOT the running installation, and deliberately derived rather
 * than configurable: an operator who could point this at the live install
 * would have configured a process that overwrites itself mid-run.
 */
export function stagedArtifactPath(workspace: WorkspaceInfo, repairId: string): string {
  return autonomyPath(workspace, 'repairs', 'artifacts', repairId);
}
