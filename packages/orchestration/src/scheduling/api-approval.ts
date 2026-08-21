import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, sha256Hex, writeFileAtomic } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import { jobDir } from '../jobs/store.js';
import { API_APPROVAL_STATUSES } from './vocabulary.js';
/**
 * Bounded API spend approvals (vNext.5) — the MANUAL spend mode's surface.
 *
 * The rule this file enforces is the one that makes MANUAL meaningful:
 *
 *   "Allow API?" is never a question SpecBridge asks, because "yes" to it
 *   would authorize unbounded future spending.
 *
 * Every approval is scoped to FOUR things, and all four are checked again
 * at the moment of spend:
 *
 *   - one task (nodeId + taskId)
 *   - one task FINGERPRINT: if the work materially changed, the approval
 *     for the old work does not authorize the new work
 *   - one API profile
 *   - one maximum authorized cost, with an expiry
 *
 * Deciding is a human action through the CLI, exactly like a mission CCR
 * decision: an agent can cause a REQUEST to exist (by doing work that
 * stalls), and can never cause an APPROVAL to exist. Nothing in this module
 * is reachable from model output.
 *
 * Storage sits in the existing job namespace:
 *
 *   .specbridge/jobs/<jobId>/api-approvals/<approvalId>.json
 */

export const API_SPEND_APPROVAL_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().min(1).max(200);

export const apiSpendApprovalSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    approvalId: shortText,
    jobId: shortText,
    nodeId: shortText,
    taskId: shortText,
    /**
     * Deterministic fingerprint of the WORK this approval covers. A
     * materially changed task produces a different fingerprint and the old
     * approval no longer authorizes anything.
     */
    taskFingerprint: shortText,
    /** The API profile the approval is scoped to. */
    profileName: shortText,
    /** Maximum authorized spend for this task, in USD. */
    maxAuthorizedCostUsd: z.number().min(0),
    currency: z.literal('USD').default('USD'),
    /** The safe estimate that justified the request, when one existed. */
    estimatedCostUsd: z.number().min(0).nullable().default(null),
    status: z.enum(API_APPROVAL_STATUSES),
    /** Why the bridge was proposed — recorded verbatim for the decider. */
    rationale: z.string().max(2_000).default(''),
    requestedAt: shortText,
    /** After this the approval is stale even if never used. */
    expiresAt: shortText,
    decidedAt: shortText.nullable().default(null),
    /** Who decided. Human identity only; never a model or a runner. */
    decidedBy: shortText.nullable().default(null),
    decisionNote: z.string().max(1_000).nullable().default(null),
    /** The attempt that consumed this approval, when one did. */
    consumedByAttemptId: shortText.nullable().default(null),
  })
  .passthrough();
export type ApiSpendApproval = z.infer<typeof apiSpendApprovalSchema>;

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * A deterministic fingerprint of the work an approval covers.
 *
 * Chosen inputs, and why each one: the task IDENTITY and TITLE (what was
 * asked), the node's own APPROVED-TASK fingerprint (the contract — it
 * already captures the approved task's content at graph-build time), the
 * PLAN REVISION (how it will be done, since a replan is materially
 * different work), and the dependency set (its position in the graph).
 *
 * Attempt counts, timestamps, and failure history are deliberately
 * excluded: retrying the same work is the same work, and re-asking a human
 * on every retry would train them to click yes.
 */
export interface SpendFingerprintInput {
  nodeId: string;
  parentTaskId: string;
  title: string;
  /** The node's fingerprint of the approved task (jobs/state.ts). */
  taskFingerprint: string;
  planRevision: number;
  dependsOn: readonly string[];
}

export function taskSpendFingerprint(node: SpendFingerprintInput): string {
  const canonical = JSON.stringify({
    nodeId: node.nodeId,
    taskId: node.parentTaskId,
    title: node.title,
    taskFingerprint: node.taskFingerprint,
    planRevision: node.planRevision,
    dependsOn: [...node.dependsOn].sort(),
  });
  return sha256Hex(canonical).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function approvalsDir(workspace: WorkspaceInfo, jobId: string): string {
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(jobDir(workspace, jobId), 'api-approvals'),
  );
}

function approvalFile(workspace: WorkspaceInfo, jobId: string, approvalId: string): string {
  if (!ID_PATTERN.test(approvalId)) {
    throw new OrchestrationError('SBO049', `Invalid approval id "${approvalId}".`);
  }
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(approvalsDir(workspace, jobId), `${approvalId}.json`),
  );
}

/** Persist an approval record atomically. */
export function writeApiSpendApproval(
  workspace: WorkspaceInfo,
  approval: ApiSpendApproval,
): ApiSpendApproval {
  const validated = apiSpendApprovalSchema.parse(approval);
  const file = approvalFile(workspace, validated.jobId, validated.approvalId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

/** Every approval record for a job, oldest first. Corrupt records are skipped. */
export function listApiSpendApprovals(
  workspace: WorkspaceInfo,
  jobId: string,
  options: { nodeId?: string | undefined } = {},
): ApiSpendApproval[] {
  const dir = approvalsDir(workspace, jobId);
  if (!existsSync(dir)) return [];
  const approvals: ApiSpendApproval[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = apiSpendApprovalSchema.safeParse(
        JSON.parse(readFileSync(path.join(dir, name), 'utf8')),
      );
      if (parsed.success) approvals.push(parsed.data);
    } catch {
      // A corrupt record is skipped, never repaired in place.
    }
  }
  approvals.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  return options.nodeId === undefined
    ? approvals
    : approvals.filter((entry) => entry.nodeId === options.nodeId);
}

export function readApiSpendApproval(
  workspace: WorkspaceInfo,
  jobId: string,
  approvalId: string,
): ApiSpendApproval | undefined {
  const file = approvalFile(workspace, jobId, approvalId);
  if (!existsSync(file)) return undefined;
  const parsed = apiSpendApprovalSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface RequestApiSpendApprovalInput {
  workspace: WorkspaceInfo;
  jobId: string;
  nodeId: string;
  taskId: string;
  taskFingerprint: string;
  profileName: string;
  maxAuthorizedCostUsd: number;
  estimatedCostUsd: number | null;
  rationale: string;
  approvalId: string;
  now: Date;
  ttlMs: number;
}

/**
 * Record a durable approval REQUEST, or return the live one that already
 * covers this exact work. Re-asking on every scheduling pass would turn a
 * deliberate spending decision into notification noise, which is the
 * fastest way to make approvals meaningless.
 */
export function requestApiSpendApproval(
  input: RequestApiSpendApprovalInput,
): { approval: ApiSpendApproval; created: boolean } {
  const existing = listApiSpendApprovals(input.workspace, input.jobId, { nodeId: input.nodeId })
    .filter(
      (entry) =>
        entry.taskFingerprint === input.taskFingerprint &&
        (entry.status === 'REQUESTED' || entry.status === 'APPROVED'),
    )
    .filter((entry) => Date.parse(entry.expiresAt) > input.now.getTime());
  const live = existing[existing.length - 1];
  if (live !== undefined) return { approval: live, created: false };

  const approval: ApiSpendApproval = {
    schemaVersion: API_SPEND_APPROVAL_SCHEMA_VERSION,
    approvalId: input.approvalId,
    jobId: input.jobId,
    nodeId: input.nodeId,
    taskId: input.taskId,
    taskFingerprint: input.taskFingerprint,
    profileName: input.profileName,
    maxAuthorizedCostUsd: input.maxAuthorizedCostUsd,
    currency: 'USD',
    estimatedCostUsd: input.estimatedCostUsd,
    status: 'REQUESTED',
    rationale: input.rationale.slice(0, 2_000),
    requestedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    consumedByAttemptId: null,
  };
  return { approval: writeApiSpendApproval(input.workspace, approval), created: true };
}

export interface DecideApiSpendApprovalInput {
  workspace: WorkspaceInfo;
  jobId: string;
  approvalId: string;
  decision: 'APPROVED' | 'DENIED';
  decidedBy: string;
  /** A human may authorize LESS than was requested, never silently more. */
  maxAuthorizedCostUsd?: number | undefined;
  note?: string | undefined;
  now: Date;
}

/** Record a human decision on one approval request. */
export function decideApiSpendApproval(
  input: DecideApiSpendApprovalInput,
): ApiSpendApproval {
  const approval = readApiSpendApproval(input.workspace, input.jobId, input.approvalId);
  if (approval === undefined) {
    throw new OrchestrationError(
      'SBO049',
      `API spend approval ${input.approvalId} of job ${input.jobId} was not found.`,
    );
  }
  if (approval.status !== 'REQUESTED') {
    throw new OrchestrationError(
      'SBO049',
      `Approval ${input.approvalId} is already ${approval.status}; decided approvals are immutable.`,
    );
  }
  return writeApiSpendApproval(input.workspace, {
    ...approval,
    status: input.decision,
    decidedAt: input.now.toISOString(),
    decidedBy: input.decidedBy.slice(0, 200),
    decisionNote: input.note?.slice(0, 1_000) ?? null,
    maxAuthorizedCostUsd: input.maxAuthorizedCostUsd ?? approval.maxAuthorizedCostUsd,
  });
}

/** Mark an approval as spent by one attempt. Approvals are single-use. */
export function consumeApiSpendApproval(
  workspace: WorkspaceInfo,
  jobId: string,
  approvalId: string,
  attemptId: string,
): ApiSpendApproval {
  const approval = readApiSpendApproval(workspace, jobId, approvalId);
  if (approval === undefined) {
    throw new OrchestrationError('SBO049', `API spend approval ${approvalId} was not found.`);
  }
  return writeApiSpendApproval(workspace, {
    ...approval,
    status: 'CONSUMED',
    consumedByAttemptId: attemptId,
  });
}

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------

export type ApiApprovalInvalidity =
  | 'NONE_FOUND'
  | 'NOT_DECIDED'
  | 'DENIED'
  | 'EXPIRED'
  | 'CONSUMED'
  | 'FINGERPRINT_CHANGED'
  | 'PROFILE_CHANGED'
  | 'COST_EXCEEDS_AUTHORIZATION';

export interface ApiApprovalCheck {
  valid: boolean;
  approval: ApiSpendApproval | undefined;
  /** The most recent live REQUESTED record, when one exists. */
  pending: ApiSpendApproval | undefined;
  reason: ApiApprovalInvalidity | undefined;
  detail: string;
}

export interface CheckApiSpendApprovalInput {
  approvals: readonly ApiSpendApproval[];
  nodeId: string;
  taskFingerprint: string;
  profileName: string;
  /** The safe cost this dispatch would incur. Null means unknown. */
  safeCostUsd: number | null;
  now: Date;
}

/**
 * Is there a live, bounded authorization covering exactly this work?
 *
 * Every failure mode is named rather than collapsed into "no": the
 * difference between "nobody decided yet", "the task changed since you
 * approved it", and "this costs more than you authorized" is the
 * difference between a useful prompt and a mystery.
 */
export function checkApiSpendApproval(input: CheckApiSpendApprovalInput): ApiApprovalCheck {
  const forNode = input.approvals.filter((entry) => entry.nodeId === input.nodeId);
  const pending = [...forNode]
    .reverse()
    .find(
      (entry) =>
        entry.status === 'REQUESTED' &&
        entry.taskFingerprint === input.taskFingerprint &&
        Date.parse(entry.expiresAt) > input.now.getTime(),
    );
  const approved = [...forNode].reverse().find((entry) => entry.status === 'APPROVED');

  if (approved === undefined) {
    const denied = [...forNode].reverse().find((entry) => entry.status === 'DENIED');
    if (denied !== undefined && denied.taskFingerprint === input.taskFingerprint) {
      return {
        valid: false,
        approval: denied,
        pending,
        reason: 'DENIED',
        detail: `Paid execution for task ${denied.taskId} was explicitly denied${denied.decisionNote !== null ? `: ${denied.decisionNote}` : '.'}`,
      };
    }
    return {
      valid: false,
      approval: undefined,
      pending,
      reason: pending !== undefined ? 'NOT_DECIDED' : 'NONE_FOUND',
      detail:
        pending !== undefined
          ? `An API spend approval request is open (${pending.approvalId}) and has not been decided.`
          : 'No API spend approval exists for this task.',
    };
  }
  if (approved.taskFingerprint !== input.taskFingerprint) {
    return {
      valid: false,
      approval: approved,
      pending,
      reason: 'FINGERPRINT_CHANGED',
      detail:
        `Approval ${approved.approvalId} covers a different version of this task ` +
        `(fingerprint ${approved.taskFingerprint} vs ${input.taskFingerprint}); materially changed ` +
        'work needs a fresh authorization.',
    };
  }
  if (Date.parse(approved.expiresAt) <= input.now.getTime()) {
    return {
      valid: false,
      approval: approved,
      pending,
      reason: 'EXPIRED',
      detail: `Approval ${approved.approvalId} expired at ${approved.expiresAt}.`,
    };
  }
  if (approved.profileName !== input.profileName) {
    return {
      valid: false,
      approval: approved,
      pending,
      reason: 'PROFILE_CHANGED',
      detail:
        `Approval ${approved.approvalId} authorizes profile "${approved.profileName}", but the ` +
        `bound API profile is now "${input.profileName}".`,
    };
  }
  if (input.safeCostUsd === null) {
    return {
      valid: false,
      approval: approved,
      pending,
      reason: 'COST_EXCEEDS_AUTHORIZATION',
      detail:
        'The cost of this attempt is unknown, so it cannot be shown to fall inside the authorized ' +
        `maximum of $${approved.maxAuthorizedCostUsd.toFixed(4)}.`,
    };
  }
  if (input.safeCostUsd > approved.maxAuthorizedCostUsd) {
    return {
      valid: false,
      approval: approved,
      pending,
      reason: 'COST_EXCEEDS_AUTHORIZATION',
      detail:
        `The safe estimate $${input.safeCostUsd.toFixed(4)} exceeds the authorized maximum ` +
        `$${approved.maxAuthorizedCostUsd.toFixed(4)} on approval ${approved.approvalId}.`,
    };
  }
  return {
    valid: true,
    approval: approved,
    pending,
    reason: undefined,
    detail:
      `Approval ${approved.approvalId} authorizes up to $${approved.maxAuthorizedCostUsd.toFixed(4)} ` +
      `for this exact task version on profile "${approved.profileName}".`,
  };
}
