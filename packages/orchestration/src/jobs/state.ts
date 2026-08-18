import { z } from 'zod';
import { FAILURE_CATEGORIES } from '../vocabulary.js';
import {
  STATE_LIMITS,
  clarificationDecisionSchema,
  clarificationQuestionSchema,
  observationFingerprintSchema,
  orchestrationBlockerSchema,
} from '../state.js';
import {
  AGENT_ROLES,
  COMPLEXITY_CLASSES,
  COST_TIERS,
  ESCALATION_REASONS,
  JOB_NODE_STATUSES,
  JOB_STATUSES,
  REASONING_TIERS,
} from './vocabulary.js';

/**
 * Persisted job state (`.specbridge/jobs/<jobId>/`).
 *
 * A job is the persistent, long-running unit of work against one approved
 * spec: it owns the runtime execution graph, scheduling position, budgets,
 * counters, and blockers, and survives any number of process interruptions
 * and worker sessions. Workers are ephemeral; the job is not.
 *
 * Versioned from day one, additive with the same rules as the v1.1 run
 * state: unknown fields survive via passthrough, and an unknown MAJOR
 * version is refused rather than coerced.
 *
 * Deliberately NOT in here, in any field, ever:
 *   - model reasoning, prompts, transcripts, or conversation history
 *   - source file contents
 *   - environment values or anything credential-shaped
 * Agent results are persisted separately as bounded, schema-validated
 * structured documents (see agents/contracts.ts) that carry decisions and
 * provenance — never deliberation.
 */

export const JOB_STATE_SCHEMA_VERSION = '1.0.0';
export const JOB_GRAPH_SCHEMA_VERSION = '1.0.0';
export const JOB_CHECKPOINT_SCHEMA_VERSION = '1.0.0';

/** Bounds applied at the schema level, independent of policy bounds. */
export const JOB_STATE_LIMITS = {
  maxNodes: 200,
  maxDependenciesPerNode: 50,
  maxAttemptsPerNode: 50,
  maxEscalationsRecorded: 100,
  maxGoalChars: 4_000,
} as const;

const shortText = z.string().max(STATE_LIMITS.maxShortTextChars);
const text = z.string().max(STATE_LIMITS.maxTextChars);

// ---------------------------------------------------------------------------
// Worker identity
// ---------------------------------------------------------------------------

/**
 * A worker as the scheduler sees it: roles it may hold, tiers it belongs to,
 * and the capability facts routing needs. Derived from configuration at
 * scheduling time — worker profiles are never persisted as authority, only
 * the *assignments* made from them are recorded for audit.
 */
export const jobWorkerProfileSchema = z
  .object({
    workerId: shortText,
    /** Runner profile name this worker dispatches through, when it has one. */
    runnerProfile: shortText.optional(),
    roles: z.array(z.enum(AGENT_ROLES)).min(1).max(AGENT_ROLES.length),
    reasoningTier: z.enum(REASONING_TIERS),
    costTier: z.enum(COST_TIERS),
    repositoryRead: z.boolean(),
    repositoryWrite: z.boolean(),
    structuredOutput: z.boolean(),
    localOnly: z.boolean(),
    requiresNetwork: z.boolean(),
    supportsCancellation: z.boolean(),
    /** Approximate input budget in characters for bounded packets. */
    maxInputCharacters: z.number().int().min(1_000),
  })
  .passthrough();
export type JobWorkerProfile = z.infer<typeof jobWorkerProfileSchema>;

// ---------------------------------------------------------------------------
// Node attempts
// ---------------------------------------------------------------------------

export const NODE_ATTEMPT_OUTCOMES = [
  'succeeded',
  'failed',
  'invalid-output',
  'escalated',
  'cancelled',
] as const;
export type NodeAttemptOutcome = (typeof NODE_ATTEMPT_OUTCOMES)[number];

/**
 * One bounded worker run against a node. This is the ephemeral-worker
 * record: which role ran, on which worker, what it produced, and what it
 * cost — never what it "thought".
 */
export const nodeAttemptSchema = z
  .object({
    attempt: z.number().int().min(1),
    role: z.enum(AGENT_ROLES),
    workerId: shortText,
    startedAt: shortText,
    finishedAt: shortText.optional(),
    outcome: z.enum(NODE_ATTEMPT_OUTCOMES),
    failureCategory: z.enum(FAILURE_CATEGORIES).optional(),
    failureFingerprint: shortText.optional(),
    /** Execution run id (`.specbridge/runs/<id>`) for executor dispatches. */
    runId: shortText.optional(),
    /** Stored agent-result document reference (agents/<file>). */
    agentResultRef: shortText.optional(),
    escalationReason: z.enum(ESCALATION_REASONS).optional(),
    /** Provider-reported usage only; absent when the provider reports none. */
    usage: z
      .object({
        inputTokens: z.number().int().min(0).nullable().default(null),
        outputTokens: z.number().int().min(0).nullable().default(null),
        costUsd: z.number().min(0).nullable().default(null),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type NodeAttempt = z.infer<typeof nodeAttemptSchema>;

// ---------------------------------------------------------------------------
// Graph nodes
// ---------------------------------------------------------------------------

/**
 * One runtime execution-graph node: one approved task plus the runtime state
 * of getting it implemented. Node ids are runtime identity and are NEVER
 * written into `.kiro`; the parent task id is the only link back to the
 * approved plan.
 */
export const jobNodeSchema = z
  .object({
    nodeId: shortText,
    /** The approved task this node implements. */
    parentTaskId: shortText,
    /** Task title snapshot (display only; the fingerprint is authoritative). */
    title: text,
    /** Fingerprint of the approved task at graph-build time. */
    taskFingerprint: shortText,
    /** Node ids that must be COMPLETED before this node is READY. */
    dependsOn: z.array(shortText).max(JOB_STATE_LIMITS.maxDependenciesPerNode).default([]),
    status: z.enum(JOB_NODE_STATUSES),
    /** Active execution-plan revision for this node; 0 when none exists. */
    planRevision: z.number().int().min(0).default(0),
    /** True when the plan is cleared for execution (critic/human as policy requires). */
    planApproved: z.boolean().default(false),
    /** Verdict of the critic on `criticPlanRevision`, when one ran. */
    criticVerdict: z.enum(['ACCEPT', 'REVISE', 'ESCALATE']).optional(),
    criticPlanRevision: z.number().int().min(0).optional(),
    /** True when policy requires an explicit human review of the active plan. */
    humanReviewRequired: z.boolean().default(false),
    /** Worker that produced the active plan (audit). */
    planProducedBy: shortText.optional(),
    /** Tier of that worker — what critique policy branches on, never a name. */
    planProducedByTier: z.enum(REASONING_TIERS).optional(),
    complexity: z.enum(COMPLEXITY_CLASSES).optional(),
    /** Why the complexity class was assigned (deterministic signal names). */
    complexitySignals: z.array(shortText).max(STATE_LIMITS.maxListItems).default([]),
    attempts: z.array(nodeAttemptSchema).max(JOB_STATE_LIMITS.maxAttemptsPerNode).default([]),
    repairCycles: z.number().int().min(0).default(0),
    replans: z.number().int().min(0).default(0),
    consecutiveNoProgress: z.number().int().min(0).default(0),
    lastObservation: observationFingerprintSchema.optional(),
    latestFailure: z
      .object({
        category: z.enum(FAILURE_CATEGORIES),
        fingerprint: shortText,
        message: text,
        at: shortText,
      })
      .passthrough()
      .optional(),
    /** Evidence linkage: the run and status that completed (or last tried). */
    latestEvidence: z
      .object({ runId: shortText, evidenceStatus: shortText, at: shortText })
      .passthrough()
      .optional(),
    /** Compact summary of the latest diagnosis (full document in agents/). */
    latestDiagnosis: z
      .object({
        category: z.enum(FAILURE_CATEGORIES),
        planValidity: z.enum(['VALID', 'INVALID', 'UNKNOWN']),
        recommendedAction: shortText,
        at: shortText,
        agentResultRef: shortText.optional(),
      })
      .passthrough()
      .optional(),
    /** Supersession lineage across graph revisions. */
    supersedes: shortText.optional(),
    supersededBy: shortText.optional(),
    completedAt: shortText.optional(),
  })
  .passthrough();
export type JobNode = z.infer<typeof jobNodeSchema>;

/**
 * One revision of the runtime execution graph. Revisions are append-only
 * documents (`graphs/0001.json`, …): a replan writes a successor revision
 * and records lineage; it never rewrites history.
 */
export const jobGraphSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    revision: z.number().int().min(1),
    specName: shortText,
    createdAt: shortText,
    /** What the graph was built against; staleness is measured from this. */
    baseline: z
      .object({
        /** Normalized approved task-plan hash at build time. */
        taskPlanHash: shortText.optional(),
        approvedStageHashes: z.record(shortText).default({}),
        gitHead: shortText.optional(),
      })
      .passthrough(),
    nodes: z.array(jobNodeSchema).min(1).max(JOB_STATE_LIMITS.maxNodes),
    /** The revision this one replaces. */
    supersedes: z.number().int().min(1).optional(),
    replanReason: text.optional(),
  })
  .passthrough();
export type JobGraph = z.infer<typeof jobGraphSchema>;

// ---------------------------------------------------------------------------
// Budgets and counters
// ---------------------------------------------------------------------------

/**
 * The budget snapshot a job executes under, recorded at creation so a
 * resumed job enforces the bounds it started with. Cost and token budgets
 * are enforced against provider-REPORTED usage only: SpecBridge never
 * fabricates a price for usage a provider did not report.
 */
export const jobBudgetsSchema = z
  .object({
    maxAgentRuns: z.number().int().min(1),
    maxTaskAttempts: z.number().int().min(1),
    maxRepairCyclesPerTask: z.number().int().min(0),
    maxReplansPerTask: z.number().int().min(0),
    maxJobReplans: z.number().int().min(0),
    maxNoProgressCycles: z.number().int().min(1),
    maxTransientRetries: z.number().int().min(0),
    maxWallClockMs: z.number().int().min(1),
    maxLocalInferenceCalls: z.number().int().min(1),
    maxEvents: z.number().int().min(1),
    maxCostUsd: z.number().min(0).nullable().default(null),
    maxTokens: z.number().int().min(1).nullable().default(null),
  })
  .passthrough();
export type JobBudgets = z.infer<typeof jobBudgetsSchema>;

export const jobCountersSchema = z
  .object({
    agentRuns: z.number().int().min(0).default(0),
    localInferenceCalls: z.number().int().min(0).default(0),
    jobReplans: z.number().int().min(0).default(0),
    transientRetries: z.number().int().min(0).default(0),
    clarificationRounds: z.number().int().min(0).default(0),
    escalations: z.number().int().min(0).default(0),
    events: z.number().int().min(0).default(0),
    /** Accumulated provider-reported usage; null until anything is reported. */
    reportedCostUsd: z.number().min(0).nullable().default(null),
    reportedTokens: z.number().int().min(0).nullable().default(null),
  })
  .passthrough();
export type JobCounters = z.infer<typeof jobCountersSchema>;

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

export const jobStateSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    specName: shortText,
    status: z.enum(JOB_STATUSES),
    /** The user's stated goal, verbatim and bounded. Data, not instructions. */
    goal: z.string().max(JOB_STATE_LIMITS.maxGoalChars),
    createdAt: shortText,
    updatedAt: shortText,
    /** Label of the host driving the job (e.g. "cli", "daemon"). */
    host: shortText,
    policyFingerprint: z.string().max(8_000),
    budgets: jobBudgetsSchema,
    counters: jobCountersSchema.default({}),
    /** Active graph revision; 0 when no graph has been built. */
    graphRevision: z.number().int().min(0).default(0),
    /** The node the scheduler is currently advancing. */
    currentNodeId: shortText.optional(),
    /** Present in WAITING_RETRY: when the next attempt may run. */
    retryAt: shortText.optional(),
    openQuestions: z.array(clarificationQuestionSchema).max(STATE_LIMITS.maxQuestions).default([]),
    decisions: z.array(clarificationDecisionSchema).max(STATE_LIMITS.maxDecisions).default([]),
    /** Escalations recorded for audit, newest last, bounded. */
    escalations: z
      .array(
        z
          .object({
            at: shortText,
            nodeId: shortText.optional(),
            role: z.enum(AGENT_ROLES),
            reason: z.enum(ESCALATION_REASONS),
            detail: text.optional(),
          })
          .passthrough(),
      )
      .max(JOB_STATE_LIMITS.maxEscalationsRecorded)
      .default([]),
    blocker: orchestrationBlockerSchema.optional(),
    latestEvidence: z
      .object({ taskId: shortText, runId: shortText, evidenceStatus: shortText, at: shortText })
      .passthrough()
      .optional(),
    /** Set exactly once, when the job reaches a final status. */
    finalizedAt: shortText.optional(),
    finalOutcome: shortText.optional(),
  })
  .passthrough();
export type JobState = z.infer<typeof jobStateSchema>;

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * A compact structured checkpoint: what a fresh process needs in order to
 * continue honestly. Never a transcript, and never a claim to remember a
 * previous worker's reasoning.
 */
export const jobCheckpointSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    jobId: shortText,
    createdAt: shortText,
    specName: shortText,
    status: z.enum(JOB_STATUSES),
    graphRevision: z.number().int().min(0),
    currentNodeId: shortText.optional(),
    completedNodes: z.array(shortText).max(JOB_STATE_LIMITS.maxNodes).default([]),
    remainingNodes: z.array(shortText).max(JOB_STATE_LIMITS.maxNodes).default([]),
    latestEvidence: z
      .object({ taskId: shortText, runId: shortText, evidenceStatus: shortText, at: shortText })
      .passthrough()
      .optional(),
    latestDiagnosis: z
      .object({ nodeId: shortText, category: z.enum(FAILURE_CATEGORIES), recommendedAction: shortText })
      .passthrough()
      .optional(),
    counters: jobCountersSchema,
    budgets: jobBudgetsSchema,
    blocker: orchestrationBlockerSchema.optional(),
    /** The exact next legal action, in one line. */
    nextAction: text,
  })
  .passthrough();
export type JobCheckpoint = z.infer<typeof jobCheckpointSchema>;
