import { z } from 'zod';

/**
 * Governed-orchestration policy (v1.1), stored additively inside
 * `.specbridge/config.json`.
 *
 * This lives in @specbridge/core alongside the other configuration schemas so
 * that the configuration reader stays the single place a policy can come
 * from. @specbridge/orchestration consumes the resolved policy; it never
 * parses configuration itself, and no policy value may ever originate from
 * model output, spec text, plan text, or repository content.
 *
 * Backward compatibility: the whole block is optional with safe defaults, so
 * every existing v1 and v2 configuration file keeps parsing unchanged and no
 * migration is required. The configuration schema version is deliberately NOT
 * bumped — this is an additive optional block, exactly like the optional
 * fields v0.5 added to the run record.
 *
 * Deliberately absent: anything that could weaken a safety boundary. There is
 * no way to configure a command, a shell, a network endpoint, an approval
 * bypass, or a verification bypass from here. The bounds below can only make
 * execution *stop sooner*.
 */

/**
 * Plan review policy.
 *
 * - `review`   the plan must be presented to the user and explicitly
 *              confirmed before the first implementation mutation. This is
 *              the safe default for interactive Claude Code usage.
 * - `auto`     an explicit opt-in for lower-friction execution after the
 *              spec and task have already passed the normal human approval
 *              gates. A plan is still required, still recorded, and material
 *              replanning is still surfaced.
 * - `disabled` no execution plan is required. This does NOT disable any
 *              other gate: approvals, evidence, verification, protected
 *              paths, and budgets all still apply. It exists so the
 *              lower-level `/specbridge:implement` lifecycle keeps its
 *              historical behaviour.
 */
export const PLAN_REVIEW_MODES = ['review', 'auto', 'disabled'] as const;
export type PlanReviewMode = (typeof PLAN_REVIEW_MODES)[number];

export const orchestrationPlanningPolicySchema = z
  .object({
    mode: z.enum(PLAN_REVIEW_MODES).default('review'),
    /** Maximum number of replans in one orchestration run. */
    maxReplans: z.number().int().min(0).max(20).default(2),
    /** Maximum stored size of one execution plan document. */
    maxPlanBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
    /** Maximum ordered implementation steps in one plan. */
    maxPlanSteps: z.number().int().min(1).max(200).default(40),
  })
  .passthrough();
export type OrchestrationPlanningPolicy = z.infer<typeof orchestrationPlanningPolicySchema>;

export const orchestrationExecutionPolicySchema = z
  .object({
    /** Hard ceiling on recorded observe/decide/act iterations. */
    maxIterations: z.number().int().min(1).max(500).default(12),
    /** Hard ceiling on repair cycles triggered by verification failures. */
    maxRepairCycles: z.number().int().min(0).max(50).default(3),
    /** Consecutive no-progress cycles tolerated before replan or block. */
    maxNoProgressCycles: z.number().int().min(1).max(20).default(2),
    /**
     * Wall-clock budget for one orchestration run. Enforced whenever a
     * decision is requested — SpecBridge never interrupts a host agent
     * mid-thought, it refuses the next step.
     */
    maxElapsedMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 3_600_000)
      .default(4 * 3_600_000),
  })
  .passthrough();
export type OrchestrationExecutionPolicy = z.infer<typeof orchestrationExecutionPolicySchema>;

export const orchestrationRetryPolicySchema = z
  .object({
    /** Bounded retries for operations classified as safely transient. */
    maxTransientRetries: z.number().int().min(0).max(10).default(2),
    /** First backoff delay; doubles per attempt up to maxBackoffMs. */
    baseBackoffMs: z.number().int().min(0).max(600_000).default(1_000),
    maxBackoffMs: z.number().int().min(0).max(3_600_000).default(30_000),
  })
  .passthrough();
export type OrchestrationRetryPolicy = z.infer<typeof orchestrationRetryPolicySchema>;

export const orchestrationClarificationPolicySchema = z
  .object({
    /** Bounded clarification rounds before the run blocks. */
    maxRounds: z.number().int().min(1).max(10).default(3),
    maxQuestionsPerRound: z.number().int().min(1).max(20).default(5),
    maxQuestionBytes: z.number().int().min(64).max(8_192).default(1_024),
    maxAnswerBytes: z.number().int().min(64).max(16_384).default(4_096),
  })
  .passthrough();
export type OrchestrationClarificationPolicy = z.infer<
  typeof orchestrationClarificationPolicySchema
>;

export const orchestrationHistoryPolicySchema = z
  .object({
    /** Append-only event ceiling. Reaching it blocks; it never truncates. */
    maxEvents: z.number().int().min(50).max(100_000).default(2_000),
    /** Per-event serialized ceiling; oversized payloads are rejected. */
    maxEventBytes: z.number().int().min(256).max(65_536).default(8_192),
    /** Default number of events returned by bounded views. */
    defaultEventPageSize: z.number().int().min(1).max(500).default(50),
  })
  .passthrough();
export type OrchestrationHistoryPolicy = z.infer<typeof orchestrationHistoryPolicySchema>;

export const orchestrationPolicySchema = z
  .object({
    /**
     * When false, orchestration tools refuse to start a run and report why.
     * Existing task execution (task_begin/task_complete) is unaffected: this
     * flag governs the v1.1 governed workflow only.
     */
    enabled: z.boolean().default(true),
    planning: orchestrationPlanningPolicySchema.default({}),
    execution: orchestrationExecutionPolicySchema.default({}),
    retry: orchestrationRetryPolicySchema.default({}),
    clarification: orchestrationClarificationPolicySchema.default({}),
    history: orchestrationHistoryPolicySchema.default({}),
  })
  .passthrough();
export type OrchestrationPolicy = z.infer<typeof orchestrationPolicySchema>;

export function defaultOrchestrationPolicy(): OrchestrationPolicy {
  return orchestrationPolicySchema.parse({});
}

/**
 * Stable fingerprint of the policy values a run was bound to.
 *
 * Recorded when an orchestration run starts so that a resumed run can say
 * honestly "the policy changed since this run began" instead of silently
 * enforcing different bounds than the ones the plan was reviewed under.
 */
export function orchestrationPolicyFingerprint(policy: OrchestrationPolicy): string {
  const canonical = {
    enabled: policy.enabled,
    planning: {
      mode: policy.planning.mode,
      maxReplans: policy.planning.maxReplans,
    },
    execution: {
      maxIterations: policy.execution.maxIterations,
      maxRepairCycles: policy.execution.maxRepairCycles,
      maxNoProgressCycles: policy.execution.maxNoProgressCycles,
      maxElapsedMs: policy.execution.maxElapsedMs,
    },
    retry: { maxTransientRetries: policy.retry.maxTransientRetries },
    clarification: { maxRounds: policy.clarification.maxRounds },
  };
  return JSON.stringify(canonical);
}
