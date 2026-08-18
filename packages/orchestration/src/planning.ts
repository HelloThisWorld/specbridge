import type { OrchestrationPolicy, WorkspaceInfo } from '@specbridge/core';
import { orchestrationPolicyFingerprint, readSpecState, stateStage } from '@specbridge/core';
import { analyzeSpec, findTask, requireSpec, taskFingerprint } from '@specbridge/compat-kiro';
import { OrchestrationError } from './errors.js';
import type { ExecutionPlan, PlanBinding, PlanStep } from './state.js';
import { EXECUTION_PLAN_SCHEMA_VERSION, executionPlanSchema } from './state.js';
import type { PlanChangeMateriality, PlanStalenessReason } from './vocabulary.js';

/**
 * Execution-plan lifecycle: binding, freshness, and materiality.
 *
 * The distinction that matters: `tasks.md` says *which* tasks exist and is a
 * human-approved `.kiro` artefact; an execution plan says *how* the currently
 * selected task will be approached against *this* repository state. Plans
 * live under `.specbridge/`, never inside `.kiro`.
 *
 * Everything here is deterministic. The host agent proposes plan content;
 * SpecBridge decides whether that content is bindable, fresh, and whether a
 * change is material enough to invalidate a prior review.
 */

/**
 * Capture the context a plan is bound to.
 *
 * Reuses the primitives that already exist — task fingerprints from
 * compat-kiro, approval hashes from the spec state, the Git HEAD from the
 * snapshot the caller already took — rather than inventing parallel notions
 * of "the same task" or "the same spec".
 */
export function capturePlanBinding(
  workspace: WorkspaceInfo,
  options: {
    specName: string;
    taskId: string;
    policy: OrchestrationPolicy;
    gitHead?: string | undefined;
  },
): PlanBinding {
  const folder = requireSpec(workspace, options.specName);
  const spec = analyzeSpec(workspace, folder);
  const tasks = spec.tasks;
  const task = tasks !== undefined ? findTask(tasks, options.taskId) : undefined;
  if (task === undefined) {
    throw new OrchestrationError(
      'SBO010',
      `Task ${options.taskId} does not exist in "${options.specName}"; a plan cannot bind to it.`,
      { remediation: ['List tasks with the task_list tool and select an existing one.'] },
    );
  }

  const approvedStageHashes: Record<string, string> = {};
  const state = readSpecState(workspace, options.specName).state;
  if (state !== undefined) {
    for (const stage of ['requirements', 'bugfix', 'design', 'tasks'] as const) {
      const approval = stateStage(state, stage);
      if (approval?.status === 'approved' && typeof approval.approvedHash === 'string') {
        approvedStageHashes[stage] = approval.approvedHash;
      }
    }
  }

  return {
    taskId: task.id,
    taskFingerprint: taskFingerprint({
      id: task.id,
      title: task.title,
      requirementRefs: task.requirementRefs,
    }),
    approvedStageHashes,
    ...(options.gitHead !== undefined ? { gitHead: options.gitHead } : {}),
    policyFingerprint: orchestrationPolicyFingerprint(options.policy),
  };
}

export interface PlanFreshness {
  fresh: boolean;
  reasons: PlanStalenessReason[];
  /** Human-readable explanation per reason, in the same order. */
  explanations: string[];
}

/**
 * Decide whether a plan still describes the world it was made for.
 *
 * A stale plan is never executed silently. Note what is *not* here: the plan
 * text itself is never re-read for "drift" — only its bindings are compared,
 * so this stays deterministic and cheap.
 */
export function evaluatePlanFreshness(
  plan: ExecutionPlan,
  current: PlanBinding,
  options: { supersededBy?: number | undefined } = {},
): PlanFreshness {
  const reasons: PlanStalenessReason[] = [];
  const explanations: string[] = [];

  if (options.supersededBy !== undefined) {
    reasons.push('superseded');
    explanations.push(
      `Plan revision ${plan.revision} was superseded by revision ${options.supersededBy}.`,
    );
  }
  if (plan.binding.taskFingerprint !== current.taskFingerprint) {
    reasons.push('task-fingerprint-changed');
    explanations.push(
      `Task ${plan.binding.taskId} changed in tasks.md since the plan was created ` +
        '(title or requirement references differ).',
    );
  }
  for (const [stage, hash] of Object.entries(plan.binding.approvedStageHashes)) {
    if (current.approvedStageHashes[stage] !== hash) {
      reasons.push('approved-stage-changed');
      explanations.push(
        `The approved "${stage}" stage changed after the plan was created; the plan may rest on a document that no longer exists in that form.`,
      );
      break;
    }
  }
  // A stage approved *after* planning is new information the plan never saw.
  for (const stage of Object.keys(current.approvedStageHashes)) {
    if (plan.binding.approvedStageHashes[stage] === undefined) {
      if (!reasons.includes('approved-stage-changed')) {
        reasons.push('approved-stage-changed');
        explanations.push(
          `The "${stage}" stage was approved after the plan was created; the plan was made without it.`,
        );
      }
      break;
    }
  }
  if (plan.binding.gitHead !== current.gitHead) {
    reasons.push('repository-baseline-changed');
    explanations.push(
      `The repository moved from ${plan.binding.gitHead ?? '(no commit)'} to ${current.gitHead ?? '(no commit)'} since the plan was created.`,
    );
  }
  if (plan.binding.policyFingerprint !== current.policyFingerprint) {
    reasons.push('policy-changed');
    explanations.push(
      'The orchestration policy changed after the plan was created; the plan was reviewed under different bounds.',
    );
  }

  return { fresh: reasons.length === 0, reasons, explanations };
}

/** Field-level differences that make a replan material. */
export interface PlanChangeAssessment {
  materiality: PlanChangeMateriality;
  /** Which material rules fired, as stable identifiers. */
  materialChanges: string[];
  /** Changes that were noticed but do not invalidate a review. */
  immaterialChanges: string[];
}

function normalizeSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter((v) => v.length > 0));
}

function setsDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return true;
  for (const value of a) if (!b.has(value)) return true;
  return false;
}

function stepDescriptions(steps: readonly PlanStep[]): string[] {
  return steps.map((step) => step.description.trim().toLowerCase());
}

/**
 * Decide whether a replacement plan differs materially from the reviewed one.
 *
 * Material (a prior review no longer applies):
 *   - the task changed
 *   - the goal or a non-goal changed
 *   - the expected implementation areas changed (different subsystem)
 *   - the constraints changed
 *   - the test or verification strategy changed
 *   - the set of steps changed in content, not merely in order
 *
 * Immaterial (the review stands):
 *   - step reordering
 *   - wording/whitespace-only edits
 *   - added or removed evidence notes and open questions
 *   - step status progress
 *
 * The user must not be asked to re-review a formatting change; they must
 * always be asked to re-review a change of strategy.
 */
export function assessPlanChange(
  previous: ExecutionPlan,
  next: ExecutionPlan,
): PlanChangeAssessment {
  const material: string[] = [];
  const immaterial: string[] = [];

  if (previous.binding.taskId !== next.binding.taskId) material.push('task-changed');
  if (previous.goal.trim() !== next.goal.trim()) material.push('goal-changed');
  if (setsDiffer(normalizeSet(previous.nonGoals), normalizeSet(next.nonGoals))) {
    material.push('non-goals-changed');
  }
  if (setsDiffer(normalizeSet(previous.constraints), normalizeSet(next.constraints))) {
    material.push('constraints-changed');
  }
  if (setsDiffer(normalizeSet(previous.expectedAreas), normalizeSet(next.expectedAreas))) {
    material.push('expected-areas-changed');
  }
  if (previous.testStrategy.trim() !== next.testStrategy.trim()) {
    material.push('test-strategy-changed');
  }
  if (previous.verificationStrategy.trim() !== next.verificationStrategy.trim()) {
    material.push('verification-strategy-changed');
  }

  const previousSteps = normalizeSet(stepDescriptions(previous.steps));
  const nextSteps = normalizeSet(stepDescriptions(next.steps));
  if (setsDiffer(previousSteps, nextSteps)) {
    material.push('steps-changed');
  } else if (stepDescriptions(previous.steps).join('|') !== stepDescriptions(next.steps).join('|')) {
    immaterial.push('steps-reordered');
  }

  if (setsDiffer(normalizeSet(previous.assumptions), normalizeSet(next.assumptions))) {
    immaterial.push('assumptions-changed');
  }
  if (setsDiffer(normalizeSet(previous.relevantEvidence), normalizeSet(next.relevantEvidence))) {
    immaterial.push('evidence-changed');
  }
  if (setsDiffer(normalizeSet(previous.openQuestions), normalizeSet(next.openQuestions))) {
    immaterial.push('open-questions-changed');
  }

  return {
    materiality: material.length > 0 ? 'material' : 'immaterial',
    materialChanges: material,
    immaterialChanges: immaterial,
  };
}

/**
 * A host-supplied plan candidate. Note the absence of `specName`: the spec is
 * a property of the orchestration run, not something a candidate may choose.
 */
export interface PlanCandidateInput {
  goal: string;
  steps: { id?: string; description: string; expectedAreas?: string[]; expectedEvidence?: string }[];
  testStrategy: string;
  verificationStrategy: string;
  nonGoals?: string[];
  constraints?: string[];
  relevantEvidence?: string[];
  assumptions?: string[];
  openQuestions?: string[];
  expectedAreas?: string[];
  rollbackConsiderations?: string | undefined;
  replanTriggers?: string[];
  replanReason?: string | undefined;
}

/**
 * Build and validate a plan document from a host-supplied candidate.
 *
 * The candidate is untrusted *content*: it is bounded, schema-validated, and
 * bound to a context the host cannot choose. Nothing in it can widen a
 * boundary — plan text never becomes a command, a path, or a permission.
 */
export function buildExecutionPlan(input: {
  candidate: PlanCandidateInput;
  specName: string;
  binding: PlanBinding;
  revision: number;
  planId: string;
  createdAt: string;
  policy: OrchestrationPolicy;
  supersedes?: string | undefined;
}): ExecutionPlan {
  const { candidate, policy } = input;
  if (candidate.steps.length === 0) {
    throw new OrchestrationError('SBO010', 'An execution plan needs at least one step.', {
      remediation: ['Describe the ordered implementation steps for the selected task.'],
    });
  }
  if (candidate.steps.length > policy.planning.maxPlanSteps) {
    throw new OrchestrationError(
      'SBO010',
      `An execution plan may contain at most ${policy.planning.maxPlanSteps} steps ` +
        `(received ${candidate.steps.length}). A plan this large usually means the task should be split.`,
      { remediation: ['Split the work across tasks, or plan a smaller slice.'] },
    );
  }

  const plan: ExecutionPlan = executionPlanSchema.parse({
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    planId: input.planId,
    revision: input.revision,
    specName: input.specName,
    createdAt: input.createdAt,
    binding: input.binding,
    goal: candidate.goal,
    nonGoals: candidate.nonGoals ?? [],
    constraints: candidate.constraints ?? [],
    relevantEvidence: candidate.relevantEvidence ?? [],
    assumptions: candidate.assumptions ?? [],
    openQuestions: candidate.openQuestions ?? [],
    expectedAreas: candidate.expectedAreas ?? [],
    steps: candidate.steps.map((step, index) => ({
      id: step.id ?? `s${index + 1}`,
      description: step.description,
      expectedAreas: step.expectedAreas ?? [],
      ...(step.expectedEvidence !== undefined ? { expectedEvidence: step.expectedEvidence } : {}),
      status: 'pending' as const,
    })),
    testStrategy: candidate.testStrategy,
    verificationStrategy: candidate.verificationStrategy,
    ...(candidate.rollbackConsiderations !== undefined
      ? { rollbackConsiderations: candidate.rollbackConsiderations }
      : {}),
    replanTriggers: candidate.replanTriggers ?? [],
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    ...(candidate.replanReason !== undefined ? { replanReason: candidate.replanReason } : {}),
  });

  const serialized = Buffer.byteLength(JSON.stringify(plan), 'utf8');
  if (serialized > policy.planning.maxPlanBytes) {
    throw new OrchestrationError(
      'SBO021',
      `The execution plan serializes to ${serialized} bytes, over the ${policy.planning.maxPlanBytes}-byte limit.`,
      { remediation: ['Shorten the plan; detailed evidence belongs in the run record.'] },
    );
  }
  return plan;
}
