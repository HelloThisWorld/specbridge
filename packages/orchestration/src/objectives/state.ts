import { z } from 'zod';
import { FAILURE_CATEGORIES } from '../vocabulary.js';
import { AGENT_ROLES } from '../jobs/vocabulary.js';
import {
  CONTRACT_CONFLICT_STATUSES,
  EVALUATION_LAYERS,
  EVALUATION_VERDICTS,
  OBJECTIVE_WORKER_STATUSES,
  WORK_UNIT_KINDS,
  WORK_UNIT_STATUSES,
} from './vocabulary.js';

/**
 * Persisted objective-runtime state
 * (`.specbridge/jobs/<jobId>/objectives/<nodeId>/`).
 *
 * Everything is runtime state: none of it appears in `.kiro`, all of it is
 * versioned, bounded, atomic, and workspace-confined, and none of it can
 * carry model reasoning — candidates carry diffs and structured claims,
 * evaluations carry verdicts with evidence references, projections carry
 * approved truth. Deliberation is neither requested nor representable.
 */

export const WORK_GRAPH_SCHEMA_VERSION = '1.0.0';
export const CONTEXT_PROJECTION_SCHEMA_VERSION = '1.0.0';
export const CANDIDATE_ARTIFACT_SCHEMA_VERSION = '1.0.0';
export const EVALUATION_RECORD_SCHEMA_VERSION = '1.0.0';
export const CONTRACT_CONFLICT_SCHEMA_VERSION = '1.0.0';
export const OBJECTIVE_WORKER_SCHEMA_VERSION = '1.0.0';

export const OBJECTIVE_LIMITS = {
  maxWorkUnits: 30,
  maxDependenciesPerUnit: 20,
  maxShortTextChars: 512,
  maxTextChars: 2_000,
  maxListItems: 30,
  maxChangedFiles: 500,
  maxEvaluationChecks: 40,
  maxProjectionContracts: 30,
  maxProjectionExcerptChars: 20_000,
} as const;

const shortText = z.string().min(1).max(OBJECTIVE_LIMITS.maxShortTextChars);
const text = z.string().min(1).max(OBJECTIVE_LIMITS.maxTextChars);
const optionalText = z.string().max(OBJECTIVE_LIMITS.maxTextChars);
const textList = z.array(text).max(OBJECTIVE_LIMITS.maxListItems);
const idList = z.array(shortText).max(OBJECTIVE_LIMITS.maxListItems);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

// ---------------------------------------------------------------------------
// Work units and the work graph
// ---------------------------------------------------------------------------

export const workUnitSchema = z
  .object({
    workUnitId: shortText,
    /** The objective (job graph node) this unit belongs to. */
    objectiveNodeId: shortText,
    /** The approved task id of the objective (audit convenience). */
    parentTaskId: shortText,
    kind: z.enum(WORK_UNIT_KINDS),
    title: text,
    goal: text,
    /** Work-unit ids that must be VERIFIED_CANDIDATE before this one runs. */
    dependsOn: z.array(shortText).max(OBJECTIVE_LIMITS.maxDependenciesPerUnit).default([]),
    /** Artifacts the unit is expected to produce (paths, report names). */
    expectedArtifacts: textList.default([]),
    /** Product contract ids relevant to this unit (projection input). */
    relevantContractIds: idList.default([]),
    relevantAdrIds: idList.default([]),
    relevantConstitutionRuleIds: idList.default([]),
    /** Source areas the unit is expected to touch (scope screen input). */
    expectedAreas: z.array(shortText).max(OBJECTIVE_LIMITS.maxListItems).default([]),
    status: z.enum(WORK_UNIT_STATUSES),
    /** Builder attempts consumed so far. */
    attempt: z.number().int().min(0).default(0),
    /** Worker currently (or last) bound to this unit. */
    workerId: shortText.optional(),
    contextProjectionHash: shortText.optional(),
    contractSnapshotHash: shortText.optional(),
    /** Latest candidate artifact reference (candidates/<file>). */
    candidateRef: shortText.optional(),
    /** Evaluation record references, oldest first. */
    evaluationRefs: idList.default([]),
    latestFailure: z
      .object({
        category: z.enum(FAILURE_CATEGORIES),
        message: text,
        at: shortText,
      })
      .passthrough()
      .optional(),
    /**
     * Change requests this unit is BLOCKED on, when it is.
     *
     * Recorded so a resume can ask whether they were decided. Without it the
     * link between the question and the decision that answers it lives only
     * in the question's prose, which nothing can reconcile.
     */
    blockedByCcrIds: idList.optional(),
    supersedes: shortText.optional(),
    supersededBy: shortText.optional(),
    integratedAt: shortText.optional(),
  })
  .passthrough();
export type WorkUnit = z.infer<typeof workUnitSchema>;

/**
 * One revision of one objective's work graph. Revisions are append-only
 * documents; unit progress WITHIN a revision rewrites the current revision
 * file atomically — the same discipline as job graphs.
 */
export const workGraphSchema = z
  .object({
    schemaVersion: semver,
    jobId: shortText,
    /** The objective node this graph decomposes. */
    objectiveNodeId: shortText,
    parentTaskId: shortText,
    /** Fingerprint of the approved objective at decomposition time. */
    objectiveFingerprint: shortText,
    revision: z.number().int().min(1),
    createdAt: shortText,
    /** Who proposed the decomposition ("deterministic" or a worker id). */
    proposedBy: shortText,
    /** Deterministic validation findings recorded at acceptance time. */
    validationNotes: textList.default([]),
    units: z.array(workUnitSchema).min(1).max(OBJECTIVE_LIMITS.maxWorkUnits),
    supersedes: z.number().int().min(1).optional(),
    revisionReason: optionalText.optional(),
  })
  .passthrough();
export type WorkGraph = z.infer<typeof workGraphSchema>;

// ---------------------------------------------------------------------------
// Context projections
// ---------------------------------------------------------------------------

/**
 * The immutable context one worker attempt sees — approved truth only:
 *
 *   WorkerContext = Mission Constitution Snapshot
 *                 + Current Objective
 *                 + Relevant Contract Versions
 *                 + Relevant ADRs
 *                 + Relevant Approved Spec Excerpts
 *                 + Relevant Prior Decisions
 *                 + Current Work Evidence
 *
 * NOT in a projection, structurally: another worker's conversation, the
 * main session's chat history, hidden reasoning, or unbounded summaries.
 * The projection is hashed; the hash binds the worker attempt, and a
 * contract revision that changes after projection makes it STALE — affected
 * work replans or stops, never continues silently.
 */
export const contextProjectionSchema = z
  .object({
    schemaVersion: semver,
    projectionId: shortText,
    jobId: shortText,
    objectiveNodeId: shortText,
    workUnitId: shortText,
    attempt: z.number().int().min(1),
    createdAt: shortText,
    missionId: shortText.optional(),
    constitution: z
      .object({
        version: z.number().int().min(0),
        rules: z
          .array(
            z
              .object({ ruleId: shortText, version: z.number().int().min(1), statement: text })
              .passthrough(),
          )
          .max(40)
          .default([]),
      })
      .passthrough(),
    objective: z
      .object({
        taskId: shortText,
        title: text,
        acceptance: textList.default([]),
      })
      .passthrough(),
    workUnit: z
      .object({
        title: text,
        goal: text,
        kind: z.enum(WORK_UNIT_KINDS),
        expectedArtifacts: textList.default([]),
        expectedAreas: z.array(shortText).max(OBJECTIVE_LIMITS.maxListItems).default([]),
      })
      .passthrough(),
    contracts: z
      .array(
        z
          .object({
            contractId: shortText,
            revision: z.number().int().min(1),
            title: shortText,
            summary: text,
            requirements: textList.default([]),
            invariants: textList.default([]),
          })
          .passthrough(),
      )
      .max(OBJECTIVE_LIMITS.maxProjectionContracts)
      .default([]),
    adrs: z
      .array(
        z
          .object({ adrId: shortText, title: shortText, decision: text })
          .passthrough(),
      )
      .max(OBJECTIVE_LIMITS.maxListItems)
      .default([]),
    decisions: z
      .array(z.object({ decisionId: shortText, decision: text }).passthrough())
      .max(OBJECTIVE_LIMITS.maxListItems)
      .default([]),
    /** Bounded approved-spec excerpts (requirements/design fragments). */
    specExcerpts: z
      .array(z.string().max(OBJECTIVE_LIMITS.maxProjectionExcerptChars))
      .max(5)
      .default([]),
    /** Bounded summaries of verified dependency candidates (work evidence). */
    workEvidence: textList.default([]),
    /** Hash over the ACTIVE contract registry this projection saw. */
    contractSnapshotHash: shortText,
    /** Hash of this projection's canonical serialization (identity). */
    contentHash: shortText,
  })
  .passthrough();
export type ContextProjection = z.infer<typeof contextProjectionSchema>;

// ---------------------------------------------------------------------------
// Candidate artifacts
// ---------------------------------------------------------------------------

/**
 * What a builder attempt RETURNS: a durable candidate, never chat. The diff
 * and the local verification results are COMPUTED by SpecBridge from the
 * isolated worktree — the structured claims a worker reports ride along as
 * claims and are never treated as evidence.
 *
 * Deliberately absent: any field that could encode commands to run,
 * permissions to grant, files to write outside the diff, or completion
 * authority. A candidate claiming its work unit is done is a claim about a
 * CANDIDATE; objective completion belongs to the evidence pipeline alone.
 */
export const candidateArtifactSchema = z
  .object({
    schemaVersion: semver,
    candidateId: shortText,
    jobId: shortText,
    objectiveNodeId: shortText,
    workUnitId: shortText,
    attempt: z.number().int().min(1),
    workerId: shortText,
    createdAt: shortText,
    /** Git commit the worktree was created from. */
    baselineCommit: shortText,
    contextProjectionHash: shortText,
    contractSnapshotHash: shortText,
    /** Files changed in the worktree, as observed by git. */
    changedFiles: z
      .array(
        z
          .object({
            path: shortText,
            changeType: z.enum(['added', 'modified', 'deleted', 'renamed']),
          })
          .passthrough(),
      )
      .max(OBJECTIVE_LIMITS.maxChangedFiles)
      .default([]),
    /** Reference to the stored normalized patch (candidates/<file>.patch). */
    patchRef: shortText.optional(),
    /** Local verification observed by SpecBridge inside the worktree. */
    localVerification: z
      .object({
        ran: z.boolean(),
        passed: z.boolean(),
        commands: z
          .array(
            z
              .object({
                name: shortText,
                status: shortText,
                exitCode: z.number().int().nullable().default(null),
              })
              .passthrough(),
          )
          .max(OBJECTIVE_LIMITS.maxListItems)
          .default([]),
      })
      .passthrough(),
    /** The worker's structured claims (data, never authority). */
    claims: z
      .object({
        summary: text,
        assumptionsDiscovered: textList.default([]),
        contractChangeRequests: z
          .array(
            z
              .object({
                contractId: shortText,
                problem: text,
                proposal: text,
              })
              .passthrough(),
          )
          .max(10)
          .default([]),
        knownLimitations: textList.default([]),
        /** Investigation units: the structured report body. */
        report: z.string().max(16_000).optional(),
      })
      .passthrough(),
    /** Set when identity/staleness guards rejected the candidate. */
    rejectedReason: optionalText.optional(),
  })
  .passthrough();
export type CandidateArtifact = z.infer<typeof candidateArtifactSchema>;

// ---------------------------------------------------------------------------
// Evaluation records
// ---------------------------------------------------------------------------

export const evaluationRecordSchema = z
  .object({
    schemaVersion: semver,
    evaluationId: shortText,
    jobId: shortText,
    objectiveNodeId: shortText,
    workUnitId: shortText,
    attempt: z.number().int().min(1),
    layer: z.enum(EVALUATION_LAYERS),
    verdict: z.enum(EVALUATION_VERDICTS),
    /** Named deterministic checks with their outcomes (deterministic layer). */
    checks: z
      .array(
        z
          .object({ name: shortText, passed: z.boolean(), detail: optionalText.optional() })
          .passthrough(),
      )
      .max(OBJECTIVE_LIMITS.maxEvaluationChecks)
      .default([]),
    reasons: textList.default([]),
    evidenceRefs: idList.default([]),
    affectedContractIds: idList.default([]),
    /** Decision kind for CONFLICT / NEEDS_DECISION verdicts (authority routing). */
    decisionKind: shortText.optional(),
    /** The evaluator worker, when the layer is semantic. */
    evaluatorWorkerId: shortText.optional(),
    createdAt: shortText,
  })
  .passthrough();
export type EvaluationRecord = z.infer<typeof evaluationRecordSchema>;

// ---------------------------------------------------------------------------
// Contract conflicts
// ---------------------------------------------------------------------------

export const contractConflictSchema = z
  .object({
    schemaVersion: semver,
    conflictId: shortText,
    jobId: shortText,
    objectiveNodeId: shortText,
    contractId: shortText,
    contractRevision: z.number().int().min(1),
    claims: z
      .array(
        z
          .object({
            workUnitId: shortText,
            candidateRef: shortText.optional(),
            claim: text,
          })
          .passthrough(),
      )
      .min(1)
      .max(OBJECTIVE_LIMITS.maxListItems),
    evidenceRefs: idList.default([]),
    affectedWorkUnitIds: idList.default([]),
    decisionKind: shortText,
    status: z.enum(CONTRACT_CONFLICT_STATUSES),
    resolution: optionalText.optional(),
    createdAt: shortText,
    resolvedAt: shortText.optional(),
  })
  .passthrough();
export type ContractConflict = z.infer<typeof contractConflictSchema>;

// ---------------------------------------------------------------------------
// Worker records
// ---------------------------------------------------------------------------

/**
 * One supervised worker attempt: the identity every result must present.
 * A result whose identity does not match the RUNNING record for its work
 * unit and attempt is rejected even if its content looks valid.
 */
export const objectiveWorkerRecordSchema = z
  .object({
    schemaVersion: semver,
    workerId: shortText,
    agentRole: z.enum(AGENT_ROLES),
    jobId: shortText,
    objectiveNodeId: shortText,
    workUnitId: shortText,
    attempt: z.number().int().min(1),
    contextProjectionHash: shortText,
    contractSnapshotHash: shortText,
    /** "worktree:<name>", "canonical", or "ephemeral" (read-only reasoning). */
    workspaceIdentity: shortText,
    status: z.enum(OBJECTIVE_WORKER_STATUSES),
    budget: z
      .object({
        timeoutMs: z.number().int().min(1),
        maxOutputBytes: z.number().int().min(1).optional(),
      })
      .passthrough(),
    startedAt: shortText,
    finishedAt: shortText.optional(),
  })
  .passthrough();
export type ObjectiveWorkerRecord = z.infer<typeof objectiveWorkerRecordSchema>;
