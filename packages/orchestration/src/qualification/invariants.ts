import type { WorkspaceInfo } from '@specbridge/core';
import { listApiSpendApprovals } from '../scheduling/api-approval.js';
import { readApiBudgetState } from '../scheduling/api-budget.js';
import { listEvaluationResults } from '../reliability/store.js';
import { listTaskAttempts, listTaskCheckpointSeqs } from '../survival/store.js';
import { listGraphRevisions, readGraphRevision, readJobState } from '../jobs/store.js';
import { listRecoveryDecisions } from '../reliability/store.js';
import type { JobNode, JobState } from '../jobs/state.js';
import type { InvariantAudit, InvariantViolation } from './state.js';
import { BLOCKING_STATE_INVARIANTS, STATE_INVARIANT_IDS } from './vocabulary.js';
import type { InvariantAuditPhase, StateInvariantId } from './vocabulary.js';

/**
 * The durable-state invariant auditor (vNext.9).
 *
 * Reads persisted state and answers one question: is what is on disk RIGHT
 * NOW self-consistent, and does it still say what governance requires it to
 * say? Nothing here runs the job, dispatches anything, or repairs anything —
 * an auditor that could write would be able to launder the very corruption
 * it exists to find.
 *
 * It is deliberately callable at any moment, including immediately after a
 * simulated crash and immediately after hydration, because the durability
 * bug this phase is most likely to find is state that is valid before a
 * restart and invalid after it. A checker that needed a running runtime
 * could not be used exactly when it matters most.
 *
 * Every violation carries the record that violates it, so a report reader
 * can go and look rather than take the auditor's word for it.
 */

export interface AuditInput {
  workspace: WorkspaceInfo;
  jobId: string;
  /** Restrict to a subset; defaults to every invariant. */
  invariants?: readonly StateInvariantId[] | undefined;
}

export interface AuditResult {
  jobId: string;
  checked: StateInvariantId[];
  violations: InvariantViolation[];
  /** True when no BLOCKING invariant was violated. */
  clean: boolean;
}

function violation(
  invariantId: StateInvariantId,
  subject: string,
  detail: string,
): InvariantViolation {
  return {
    invariantId,
    subject,
    detail,
    blocking: BLOCKING_STATE_INVARIANTS.includes(invariantId),
  };
}

/** All nodes across all persisted graph revisions, newest revision last. */
function allNodes(workspace: WorkspaceInfo, jobId: string): Map<string, JobNode> {
  const nodes = new Map<string, JobNode>();
  for (const revision of listGraphRevisions(workspace, jobId)) {
    const graph = readGraphRevision(workspace, jobId, revision);
    if (graph === undefined) continue;
    for (const node of graph.nodes) nodes.set(node.nodeId, node);
  }
  return nodes;
}

/** Nodes of the ACTIVE graph revision only. */
function activeNodes(workspace: WorkspaceInfo, job: JobState): JobNode[] {
  if (job.graphRevision === 0) return [];
  return readGraphRevision(workspace, job.jobId, job.graphRevision)?.nodes ?? [];
}

/**
 * Audit one job's durable state.
 *
 * A job whose state file is missing or unreadable is itself the finding: it
 * reports as a canonical-state violation rather than throwing, because an
 * auditor that crashed on corrupt input would turn the most serious defect
 * class into a stack trace.
 */
export function auditJobState(input: AuditInput): AuditResult {
  const { workspace, jobId } = input;
  const checked = [...(input.invariants ?? STATE_INVARIANT_IDS)];
  const violations: InvariantViolation[] = [];
  const wants = (id: StateInvariantId): boolean => checked.includes(id);

  const read = readJobState(workspace, jobId);
  if (read.kind !== 'ok') {
    violations.push(
      violation(
        'GRAPH_REVISION_RESOLVES',
        `jobs/${jobId}/job.json`,
        read.kind === 'missing'
          ? 'Job state is missing.'
          : read.kind === 'corrupt'
            ? `Job state is corrupt: ${read.problem}`
            : `Job state declares unsupported schema version ${read.version}.`,
      ),
    );
    return { jobId, checked, violations, clean: false };
  }
  const job = read.job;

  const nodes = activeNodes(workspace, job);
  const known = allNodes(workspace, jobId);
  const attempts = listTaskAttempts(workspace, jobId);
  const evaluations = listEvaluationResults(workspace, jobId);
  const evaluationsByNode = new Map<string, string[]>();
  for (const evaluation of evaluations) {
    const list = evaluationsByNode.get(evaluation.nodeId) ?? [];
    list.push(evaluation.status);
    evaluationsByNode.set(evaluation.nodeId, list);
  }

  // -- GRAPH_REVISION_RESOLVES ---------------------------------------------
  if (wants('GRAPH_REVISION_RESOLVES') && job.graphRevision > 0) {
    if (readGraphRevision(workspace, jobId, job.graphRevision) === undefined) {
      violations.push(
        violation(
          'GRAPH_REVISION_RESOLVES',
          `job ${jobId}`,
          `Job points at graph revision ${job.graphRevision}, which is not persisted.`,
        ),
      );
    }
  }

  // -- ATTEMPT_OWNERSHIP_COHERENT ------------------------------------------
  //
  // A RUNNING attempt is only coherent while the job is genuinely mid-
  // dispatch and names that attempt as the one in flight. A RUNNING attempt
  // the job does not claim is an orphan: the process that owned it is gone
  // and resume never reconciled it.
  if (wants('ATTEMPT_OWNERSHIP_COHERENT')) {
    for (const attempt of attempts) {
      if (attempt.status !== 'RUNNING') continue;
      if (job.currentAttemptId === attempt.attemptId) continue;
      violations.push(
        violation(
          'ATTEMPT_OWNERSHIP_COHERENT',
          `attempt ${attempt.attemptId}`,
          `Attempt is RUNNING but the job does not own it (job.currentAttemptId=${job.currentAttemptId ?? 'none'}, job.status=${job.status}).`,
        ),
      );
    }
  }

  // -- ATTEMPTS_REFERENCE_KNOWN_NODES --------------------------------------
  if (wants('ATTEMPTS_REFERENCE_KNOWN_NODES')) {
    for (const attempt of attempts) {
      if (known.has(attempt.nodeId)) continue;
      violations.push(
        violation(
          'ATTEMPTS_REFERENCE_KNOWN_NODES',
          `attempt ${attempt.attemptId}`,
          `Attempt references node ${attempt.nodeId}, which appears in no persisted graph revision.`,
        ),
      );
    }
  }

  // -- COMPLETED_TASK_HAS_EVIDENCE / _EVALUATION ---------------------------
  //
  // The evidence-bypass check. A node that is COMPLETED without a durable
  // trusted-evidence reference means a claim was accepted as a completion,
  // which is the one thing the whole evidence pipeline exists to prevent.
  for (const node of nodes) {
    if (node.status !== 'COMPLETED') continue;
    if (wants('COMPLETED_TASK_HAS_EVIDENCE') && node.latestEvidence === undefined) {
      violations.push(
        violation(
          'COMPLETED_TASK_HAS_EVIDENCE',
          `node ${node.nodeId}`,
          'Node is COMPLETED but carries no trusted-evidence reference.',
        ),
      );
    }
    if (wants('COMPLETED_TASK_HAS_EVALUATION')) {
      const statuses = evaluationsByNode.get(node.nodeId) ?? [];
      if (!statuses.includes('PASS')) {
        violations.push(
          violation(
            'COMPLETED_TASK_HAS_EVALUATION',
            `node ${node.nodeId}`,
            statuses.length === 0
              ? 'Node is COMPLETED but has no recorded evaluation verdict.'
              : `Node is COMPLETED but no evaluation reached PASS (recorded: ${statuses.join(', ')}).`,
          ),
        );
      }
    }
  }

  // -- DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS ----------------------------
  //
  // "Verified" here means the predecessor node reached COMPLETED, which the
  // two checks above already tie to trusted evidence. A dependent that ran
  // while a required predecessor had not is how unverified work silently
  // becomes a foundation.
  if (wants('DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS')) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const attemptedNodes = new Set(attempts.map((attempt) => attempt.nodeId));
    for (const node of nodes) {
      if (!attemptedNodes.has(node.nodeId) && node.status !== 'COMPLETED') continue;
      for (const dependencyId of node.dependsOn) {
        const dependency = byId.get(dependencyId);
        if (dependency === undefined) {
          violations.push(
            violation(
              'DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS',
              `node ${node.nodeId}`,
              `Declared dependency ${dependencyId} is absent from the active graph revision.`,
            ),
          );
          continue;
        }
        if (dependency.status === 'COMPLETED') continue;
        violations.push(
          violation(
            'DEPENDENTS_RESPECT_VERIFIED_PREDECESSORS',
            `node ${node.nodeId}`,
            `Node ran or completed while its required predecessor ${dependencyId} was ${dependency.status}.`,
          ),
        );
      }
    }
  }

  // -- LOCAL_ATTEMPTS_VERIFIED_LOCAL ---------------------------------------
  //
  // The economic-integrity check: an attempt recorded on the LOCAL lane whose
  // compute locality is anything other than verified-local would mean remote
  // compute was reported as free, which corrupts every economic conclusion
  // downstream. Attempts predating vNext.4 carry no locality field at all and
  // are not violations — an absent field is not a false claim.
  if (wants('LOCAL_ATTEMPTS_VERIFIED_LOCAL')) {
    for (const attempt of attempts) {
      if (attempt.lane !== 'LOCAL') continue;
      if (attempt.computeLocality === undefined) continue;
      if (attempt.computeLocality === 'LOCAL') continue;
      violations.push(
        violation(
          'LOCAL_ATTEMPTS_VERIFIED_LOCAL',
          `attempt ${attempt.attemptId}`,
          `Attempt is recorded on lane LOCAL with computeLocality=${attempt.computeLocality}.`,
        ),
      );
    }
  }

  // -- NO_API_SPEND_WITHOUT_AUTHORITY --------------------------------------
  //
  // Every API-lane attempt must name the spend mode it ran under, and a
  // MANUAL-mode attempt must additionally name the bounded approval it
  // consumed. AUTO_BOUNDED is authority in itself, granted in configuration;
  // DISABLED is never authority for anything.
  if (wants('NO_API_SPEND_WITHOUT_AUTHORITY')) {
    const approvals = new Set(
      listApiSpendApprovals(workspace, jobId).map((approval) => approval.approvalId),
    );
    for (const attempt of attempts) {
      if (attempt.lane !== 'API') continue;
      const mode = attempt.apiSpendMode;
      if (mode === undefined || mode === 'DISABLED') {
        violations.push(
          violation(
            'NO_API_SPEND_WITHOUT_AUTHORITY',
            `attempt ${attempt.attemptId}`,
            `API-lane attempt recorded spend mode ${mode ?? 'none'}.`,
          ),
        );
        continue;
      }
      if (mode === 'MANUAL') {
        const approvalId = attempt.apiApprovalId;
        if (approvalId === undefined || !approvals.has(approvalId)) {
          violations.push(
            violation(
              'NO_API_SPEND_WITHOUT_AUTHORITY',
              `attempt ${attempt.attemptId}`,
              `MANUAL-mode API attempt references approval ${approvalId ?? 'none'}, which is not on record.`,
            ),
          );
        }
      }
      if (attempt.apiBudgetReservationId === undefined) {
        violations.push(
          violation(
            'NO_API_SPEND_WITHOUT_AUTHORITY',
            `attempt ${attempt.attemptId}`,
            'API-lane attempt holds no budget reservation.',
          ),
        );
      }
    }
  }

  // -- API_BUDGET_RECONCILES -----------------------------------------------
  //
  // Reservation states must be coherent, and — the point of the check — a
  // reservation whose attempt was interrupted must NOT have been released to
  // zero. Uncertain spend stays uncertain.
  if (wants('API_BUDGET_RECONCILES')) {
    const budget = readApiBudgetState(workspace, jobId);
    const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
    for (const reservation of budget.reservations) {
      if (reservation.state === 'COMMITTED' && reservation.reconciledUsd === null) {
        violations.push(
          violation(
            'API_BUDGET_RECONCILES',
            `reservation ${reservation.reservationId}`,
            'Reservation is COMMITTED with no reconciled cost recorded.',
          ),
        );
      }
      if (reservation.attemptId === null) continue;
      const attempt = attemptById.get(reservation.attemptId);
      if (attempt === undefined) {
        violations.push(
          violation(
            'API_BUDGET_RECONCILES',
            `reservation ${reservation.reservationId}`,
            `Reservation funds attempt ${reservation.attemptId}, which is not on record.`,
          ),
        );
        continue;
      }
      if (attempt.status === 'INTERRUPTED' && reservation.state === 'RELEASED') {
        violations.push(
          violation(
            'API_BUDGET_RECONCILES',
            `reservation ${reservation.reservationId}`,
            'Reservation for an INTERRUPTED paid attempt was RELEASED; uncertain spend must not be freed as zero.',
          ),
        );
      }
    }
  }

  // -- RECOVERY_REFERENCES_REAL_ATTEMPTS -----------------------------------
  if (wants('RECOVERY_REFERENCES_REAL_ATTEMPTS')) {
    const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));
    for (const decision of listRecoveryDecisions(workspace, jobId)) {
      const attemptId = decision.attemptId;
      if (attemptIds.has(attemptId)) continue;
      violations.push(
        violation(
          'RECOVERY_REFERENCES_REAL_ATTEMPTS',
          `recovery ${decision.decisionId}`,
          `Recovery decision references attempt ${attemptId}, which is not on record.`,
        ),
      );
    }
  }

  // -- CHECKPOINT_LINEAGE_VALID --------------------------------------------
  //
  // Checkpoint sequences are 1-based and dense per task. A gap means a
  // checkpoint was lost; a duplicate means two writers believed they owned
  // the same task.
  if (wants('CHECKPOINT_LINEAGE_VALID')) {
    for (const nodeId of new Set(attempts.map((attempt) => attempt.nodeId))) {
      const seqs = listTaskCheckpointSeqs(workspace, jobId, nodeId);
      if (seqs.length === 0) continue;
      const sorted = [...seqs].sort((a, b) => a - b);
      for (const [index, seq] of sorted.entries()) {
        if (seq === index + 1) continue;
        violations.push(
          violation(
            'CHECKPOINT_LINEAGE_VALID',
            `node ${nodeId}`,
            `Checkpoint sequence is not dense and 1-based: found [${sorted.join(', ')}].`,
          ),
        );
        break;
      }
    }
  }

  return {
    jobId,
    checked,
    violations,
    clean: !violations.some((entry) => entry.blocking),
  };
}

/** Build a durable audit record from an audit result. */
export function toInvariantAudit(input: {
  runId: string;
  auditId: string;
  phase: InvariantAuditPhase;
  at: string;
  result: AuditResult;
  note?: string | undefined;
}): InvariantAudit {
  return {
    schemaVersion: '1.0.0',
    runId: input.runId,
    auditId: input.auditId,
    phase: input.phase,
    jobId: input.result.jobId,
    at: input.at,
    checked: input.result.checked,
    violations: input.result.violations,
    note: input.note ?? null,
  };
}

/**
 * Compare two audits of the same job taken either side of a restart.
 *
 * Violations that appear only AFTER hydration are durability defects: the
 * state was coherent when written and incoherent when read back. Violations
 * present in both are pre-existing and belong to whatever caused them, not
 * to the restart.
 */
export function restartRegressions(
  before: AuditResult,
  after: AuditResult,
): InvariantViolation[] {
  const key = (entry: InvariantViolation): string => `${entry.invariantId}::${entry.subject}`;
  const seen = new Set(before.violations.map(key));
  return after.violations.filter((entry) => !seen.has(key(entry)));
}
