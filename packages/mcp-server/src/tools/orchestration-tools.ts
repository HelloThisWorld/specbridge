import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import type { OrchestrationDeps, OrchestrationState } from '@specbridge/orchestration';
import {
  ACTION_CATEGORIES,
  FAILURE_CATEGORIES,
  INTENT_OUTCOMES,
  OBSERVATION_RESULTS,
  PROVENANCE_KINDS,
  assessIntent,
  beginOrchestration,
  createCheckpoint,
  describeOrchestration,
  finalizeOrchestration,
  listOrchestrationRuns,
  recordActionChecked,
  requestClarification,
  requireOrchestrationState,
  resolveClarification,
  resumeOrchestration,
  reviewPlan,
  submitPlan,
} from '@specbridge/orchestration';
import type { ServerContext } from '../context.js';
import { specNameArg } from '../schemas/common.js';
import { registerDefinedTool } from './helpers.js';
import { requireAgentConfig } from './interactive-shared.js';

/**
 * Governed orchestration tools (v1.1).
 *
 * Every handler is a thin adapter: it validates and bounds input, calls one
 * shared @specbridge/orchestration operation, and shapes the result. No state
 * transition, budget, retry rule, freshness check, or completion decision is
 * re-implemented here.
 *
 * What these tools deliberately cannot do, by construction rather than by
 * instruction: approve a spec stage, run a command, read or write an
 * arbitrary path, invoke a model, switch provider, or mark a task complete
 * without a verified evidence status from `task_complete`.
 */

function orchestrationDeps(context: ServerContext, workspace: WorkspaceInfo): OrchestrationDeps {
  return {
    workspace,
    config: requireAgentConfig(workspace),
    clock: context.clock,
    idFactory: context.idFactory,
    host: 'mcp',
  };
}

const orchestrationIdArg = z
  .string()
  .min(1)
  .max(64)
  .describe('Orchestration run id returned by orchestration_begin');

/** Bounded free-text: untrusted content, never interpreted as instructions. */
const boundedText = (max: number) => z.string().min(1).max(max);

const stateSummaryShape = {
  orchestrationId: z.string(),
  specName: z.string(),
  taskId: z.string().optional(),
  phase: z.string(),
  final: z.boolean(),
  summary: z.string(),
  nextAction: z.string(),
  executionBlockedBecause: z.string().optional(),
  planRevision: z.number().int(),
  planStale: z.boolean(),
  planStaleReasons: z.array(z.string()),
  planReviewed: z.boolean(),
  openQuestions: z.array(z.object({ id: z.string(), question: z.string(), whyItMatters: z.string() })),
  budgets: z.array(
    z.object({ name: z.string(), used: z.number(), limit: z.number(), exhausted: z.boolean() }),
  ),
  exhaustedBudgets: z.array(z.string()),
  blocker: z
    .object({
      category: z.string(),
      code: z.string(),
      message: z.string(),
      remediation: z.array(z.string()),
    })
    .optional(),
  allowedActions: z.array(z.string()),
};

function stateSummary(workspace: WorkspaceInfo, state: OrchestrationState) {
  const detail = describeOrchestration(workspace, state, { eventLimit: 1 });
  return {
    orchestrationId: detail.orchestrationId,
    specName: detail.specName,
    ...(detail.taskId !== undefined ? { taskId: detail.taskId } : {}),
    phase: detail.phase,
    final: detail.final,
    summary: detail.summary,
    nextAction: detail.nextAction,
    ...(detail.executionBlockedBecause !== undefined
      ? { executionBlockedBecause: detail.executionBlockedBecause }
      : {}),
    planRevision: detail.planRevision,
    planStale: detail.planStale,
    planStaleReasons: detail.planStaleReasons,
    planReviewed: detail.planReviewed,
    openQuestions: detail.openQuestions,
    budgets: detail.budgets,
    exhaustedBudgets: detail.exhaustedBudgets,
    ...(detail.blocker !== undefined ? { blocker: detail.blocker } : {}),
    allowedActions: detail.allowedActions,
  };
}

// ---------------------------------------------------------------------------
// orchestration_status
// ---------------------------------------------------------------------------

export function registerOrchestrationStatusTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_status',
    title: 'Orchestration status',
    description:
      'Inspect governed orchestration state: current phase, why execution has or has not started, ' +
      'the active plan revision and whether it is still fresh, open clarifications, budget usage, ' +
      'and the exact next safe action. Read-only: looking at a run never changes it. ' +
      'Omit orchestrationId to list recent runs.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg.optional(),
      eventLimit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Recent events to include (default 20; history is persisted in full)'),
    },
    outputSchema: {
      ...stateSummaryShape,
      runs: z
        .array(
          z.object({
            orchestrationId: z.string(),
            specName: z.string(),
            phase: z.string(),
            createdAt: z.string(),
          }),
        )
        .optional(),
      warnings: z.array(z.string()),
      recentEvents: z.array(z.object({ at: z.string(), type: z.string() })).optional(),
      totalEvents: z.number().int().optional(),
      activeInteractiveRun: z
        .object({
          runId: z.string(),
          lifecycleStatus: z.string().optional(),
          lockHeld: z.boolean(),
        })
        .optional(),
      diagnostics: z.array(z.string()).optional(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const deps = orchestrationDeps(context, workspace);

      if (args.orchestrationId === undefined) {
        const listed = listOrchestrationRuns(workspace);
        const latest = listed.runs[0];
        const base =
          latest !== undefined
            ? stateSummary(workspace, latest)
            : {
                orchestrationId: '',
                specName: '',
                phase: 'none',
                final: false,
                summary: 'No orchestration runs exist in this workspace.',
                nextAction: 'Start one with orchestration_begin.',
                planRevision: 0,
                planStale: false,
                planStaleReasons: [],
                planReviewed: false,
                openQuestions: [],
                budgets: [],
                exhaustedBudgets: [],
                allowedActions: [],
              };
        return {
          text:
            latest === undefined
              ? 'No orchestration runs yet. Start one with orchestration_begin.'
              : `${listed.runs.length} orchestration run(s). Most recent: ${latest.orchestrationId} (${latest.phase}).`,
          structured: {
            ...base,
            runs: listed.runs.slice(0, 20).map((run) => ({
              orchestrationId: run.orchestrationId,
              specName: run.specName,
              phase: run.phase,
              createdAt: run.createdAt,
            })),
            warnings: [],
            ...(listed.diagnostics.length > 0
              ? { diagnostics: listed.diagnostics.map((d) => d.message) }
              : {}),
          },
        };
      }

      // A status read of a specific run performs the full resume
      // reconciliation: plan freshness, policy drift, and the state of any
      // interactive execution run it owns — all without writing.
      const report = await resumeOrchestration(deps, args.orchestrationId);
      const detail = describeOrchestration(workspace, report.state, {
        eventLimit: args.eventLimit ?? 20,
      });

      const lines = [
        `Orchestration ${report.state.orchestrationId} — ${report.state.phase}`,
        report.explanation.summary,
        '',
        `Next action: ${report.nextAction}`,
      ];
      if (report.planStale) {
        lines.push('', 'The recorded execution plan is STALE:');
        for (const explanation of report.planStaleExplanations) lines.push(`  - ${explanation}`);
      }
      for (const warning of report.warnings) lines.push(`  ! ${warning}`);

      return {
        text: lines.join('\n'),
        structured: {
          ...stateSummary(workspace, report.state),
          planStale: report.planStale,
          planStaleReasons: report.planStaleReasons,
          nextAction: report.nextAction,
          warnings: report.warnings,
          recentEvents: detail.recentEvents,
          totalEvents: detail.totalEvents,
          ...(report.activeInteractiveRun !== undefined
            ? {
                activeInteractiveRun: {
                  runId: report.activeInteractiveRun.runId,
                  ...(report.activeInteractiveRun.lifecycleStatus !== undefined
                    ? { lifecycleStatus: report.activeInteractiveRun.lifecycleStatus }
                    : {}),
                  lockHeld: report.activeInteractiveRun.lockHeld,
                },
              }
            : {}),
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// orchestration_begin
// ---------------------------------------------------------------------------

export function registerOrchestrationBeginTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_begin',
    title: 'Begin governed orchestration',
    description:
      'Start a governed orchestration run for one spec. Records the stated goal and the policy ' +
      'budgets the run will execute under. Modifies no source, invokes no model, and starts no ' +
      'implementation: intent must be assessed next.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      specName: specNameArg,
      goal: boundedText(4_000).describe(
        "The user's stated goal, verbatim. Recorded as data, never executed as instructions.",
      ),
      taskId: z.string().max(64).optional().describe('Target task, when the user named one'),
    },
    outputSchema: {
      ...stateSummaryShape,
      planningMode: z.string(),
      budgetSummary: z.record(z.number()),
      instructions: z.array(z.string()),
    },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const state = beginOrchestration(deps, {
          specName: args.specName,
          goal: args.goal,
          ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
        });
        context.logger.info('orchestration_started', { orchestrationId: state.orchestrationId });

        const instructions = [
          'Assess intent next with orchestration_assess_intent.',
          'Do not edit source before a plan exists and, under the "review" policy, has been reviewed.',
          'Never approve a spec stage: approval is a human-only CLI action.',
          'Completion is decided by task_complete evidence, never by your assessment.',
        ];
        return {
          text: [
            `Orchestration ${state.orchestrationId} started for "${state.specName}" (planning mode: ${state.planningMode}).`,
            '',
            ...instructions.map((line) => `- ${line}`),
          ].join('\n'),
          structured: {
            ...stateSummary(workspace, state),
            planningMode: state.planningMode,
            budgetSummary: {
              maxIterations: state.budgets.maxIterations,
              maxRepairCycles: state.budgets.maxRepairCycles,
              maxReplans: state.budgets.maxReplans,
              maxNoProgressCycles: state.budgets.maxNoProgressCycles,
              maxTransientRetries: state.budgets.maxTransientRetries,
              maxClarificationRounds: state.budgets.maxClarificationRounds,
            },
            instructions,
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// orchestration_assess_intent
// ---------------------------------------------------------------------------

export function registerOrchestrationAssessIntentTool(
  server: McpServer,
  context: ServerContext,
): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_assess_intent',
    title: 'Assess intent',
    description:
      'Submit a structured intent assessment (READY / NEEDS_CLARIFICATION / REJECTED / BLOCKED) ' +
      'with the provenance of each fact relied on. SpecBridge validates it against facts it checks ' +
      'itself — approvals, staleness, task existence, lock ownership, hard product boundaries — and ' +
      'may override the submitted outcome towards caution. A READY claim resting on inferred, ' +
      'unknown, or conflicting provenance is downgraded to NEEDS_CLARIFICATION.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg,
      outcome: z.enum(INTENT_OUTCOMES).describe('Your assessment; SpecBridge may override it'),
      summary: boundedText(2_000).describe("One-line restatement of the user's request"),
      reasons: z.array(boundedText(2_000)).max(20).optional(),
      provenance: z
        .array(
          z.object({
            fact: boundedText(2_000),
            source: z.enum(PROVENANCE_KINDS),
            reference: z.string().max(512).optional(),
          }),
        )
        .max(50)
        .optional()
        .describe('Where each fact came from. Structural provenance, not a confidence score.'),
    },
    outputSchema: {
      ...stateSummaryShape,
      outcome: z.string(),
      overridden: z.boolean(),
      submittedOutcome: z.string().optional(),
      overrideReason: z.string().optional(),
      blockers: z.array(
        z.object({ code: z.string(), message: z.string(), remediation: z.array(z.string()) }),
      ),
    },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const result = assessIntent(deps, args.orchestrationId, {
          outcome: args.outcome,
          summary: args.summary,
          ...(args.reasons !== undefined ? { reasons: args.reasons } : {}),
          ...(args.provenance !== undefined ? { provenance: args.provenance } : {}),
        });
        const intent = result.state.intent;

        const lines = [`Intent: ${intent?.outcome ?? 'unknown'}.`];
        if (result.overridden) {
          lines.push(
            `SpecBridge overrode the submitted outcome (${intent?.overriddenFrom}): ${intent?.overrideReason ?? ''}`,
          );
        }
        for (const blocker of result.blockers) lines.push(`  - ${blocker.code}: ${blocker.message}`);
        lines.push('', `Next action: ${stateSummary(workspace, result.state).nextAction}`);

        return {
          text: lines.join('\n'),
          structured: {
            ...stateSummary(workspace, result.state),
            outcome: intent?.outcome ?? 'unknown',
            overridden: result.overridden,
            ...(intent?.overriddenFrom !== undefined ? { submittedOutcome: intent.overriddenFrom } : {}),
            ...(intent?.overrideReason !== undefined ? { overrideReason: intent.overrideReason } : {}),
            blockers: result.blockers,
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// orchestration_clarify
// ---------------------------------------------------------------------------

export function registerOrchestrationClarifyTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_clarify',
    title: 'Request clarification',
    description:
      'Record a bounded round of targeted clarification questions. Every question must state why ' +
      'its answer changes the implementation; generic questionnaires, duplicates, and re-asked ' +
      'questions are refused. The run stays in NEEDS_CLARIFICATION until the answers are recorded.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg,
      questions: z
        .array(
          z.object({
            question: boundedText(1_024),
            whyItMatters: boundedText(1_024).describe(
              'What the answer changes about the implementation. Required.',
            ),
            options: z.array(boundedText(512)).max(10).optional(),
            relatedTaskId: z.string().max(64).optional(),
          }),
        )
        .min(1)
        .max(20),
    },
    outputSchema: {
      ...stateSummaryShape,
      round: z.number().int(),
      questionIds: z.array(z.string()),
    },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const state = requestClarification(
          deps,
          args.orchestrationId,
          args.questions.map((question) => ({
            question: question.question,
            whyItMatters: question.whyItMatters,
            ...(question.options !== undefined ? { options: question.options } : {}),
            ...(question.relatedTaskId !== undefined ? { relatedTaskId: question.relatedTaskId } : {}),
          })),
        );
        const round = state.counters.clarificationRounds;
        const asked = state.openQuestions.filter((question) => question.round === round);

        return {
          text: [
            `Clarification round ${round}: ${asked.length} question(s). Implementation cannot start until they are answered.`,
            '',
            ...asked.map((question) => `- ${question.question}\n  (why: ${question.whyItMatters})`),
          ].join('\n'),
          structured: {
            ...stateSummary(workspace, state),
            round,
            questionIds: asked.map((question) => question.id),
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// orchestration_resolve_clarification
// ---------------------------------------------------------------------------

export function registerOrchestrationResolveClarificationTool(
  server: McpServer,
  context: ServerContext,
): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_resolve_clarification',
    title: 'Record clarification decisions',
    description:
      "Record the user's answers to open clarification questions as durable decisions with " +
      'provenance. An answer whose provenance is inferred, unknown, or conflicting is refused — ' +
      'that is the ambiguity the question existed to remove. A decision never amends an approved ' +
      '.kiro document: when the answer changes the specification, re-author the stage and re-enter ' +
      'the human approval lifecycle.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg,
      decisions: z
        .array(
          z.object({
            questionId: z.string().min(1).max(64),
            answer: boundedText(4_096),
            source: z
              .enum(PROVENANCE_KINDS)
              .describe('Use known-from-user for a direct answer from the user'),
            impact: boundedText(2_000).optional().describe('What this changes about the build'),
            supersedes: z.string().max(64).optional(),
          }),
        )
        .min(1)
        .max(20),
    },
    outputSchema: {
      ...stateSummaryShape,
      decisionIds: z.array(z.string()),
      requiresSpecChange: z.array(z.string()),
      specChangeGuidance: z.array(z.string()),
    },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const result = resolveClarification(
          deps,
          args.orchestrationId,
          args.decisions.map((decision) => ({
            questionId: decision.questionId,
            answer: decision.answer,
            source: decision.source,
            ...(decision.impact !== undefined ? { impact: decision.impact } : {}),
            ...(decision.supersedes !== undefined ? { supersedes: decision.supersedes } : {}),
          })),
        );

        const guidance =
          result.requiresSpecChange.length > 0
            ? [
                'One or more decisions change what the specification says.',
                'A clarification decision does not amend an approved .kiro document.',
                'Re-author the affected stage (spec_stage_validate / spec_stage_apply), then the USER re-approves it.',
              ]
            : [];

        return {
          text: [
            `Recorded ${result.state.decisions.length} decision(s); ${result.state.openQuestions.length} question(s) still open.`,
            ...guidance.map((line) => `  ! ${line}`),
            '',
            `Next action: ${stateSummary(workspace, result.state).nextAction}`,
          ].join('\n'),
          structured: {
            ...stateSummary(workspace, result.state),
            decisionIds: result.state.decisions.map((decision) => decision.id),
            requiresSpecChange: result.requiresSpecChange,
            specChangeGuidance: guidance,
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// orchestration_submit_plan
// ---------------------------------------------------------------------------

export function registerOrchestrationSubmitPlanTool(
  server: McpServer,
  context: ServerContext,
): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_submit_plan',
    title: 'Submit execution plan',
    description:
      'Submit an execution plan for the selected approved task: how it will be approached against ' +
      'the CURRENT repository state. Distinct from tasks.md, which is a human-approved .kiro ' +
      'artefact. The plan is bound to the task fingerprint, the approved stage hashes, the Git ' +
      'baseline, and the policy — so it can go stale and be refused later. Submitting again is a ' +
      'replan: material changes re-open review, immaterial ones (reordering, wording) do not.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg,
      taskId: z.string().min(1).max(64).describe('The approved task this plan implements'),
      goal: boundedText(2_000),
      steps: z
        .array(
          z.object({
            id: z.string().max(64).optional(),
            description: boundedText(2_000),
            expectedAreas: z.array(z.string().max(512)).max(20).optional(),
            expectedEvidence: boundedText(2_000).optional(),
          }),
        )
        .min(1)
        .max(200),
      testStrategy: boundedText(2_000),
      verificationStrategy: boundedText(2_000),
      nonGoals: z.array(boundedText(2_000)).max(50).optional(),
      constraints: z.array(boundedText(2_000)).max(50).optional(),
      relevantEvidence: z.array(boundedText(2_000)).max(50).optional(),
      assumptions: z
        .array(boundedText(2_000))
        .max(50)
        .optional()
        .describe('Labelled assumptions. Planning information, never presented as facts.'),
      openQuestions: z.array(boundedText(2_000)).max(50).optional(),
      expectedAreas: z
        .array(z.string().max(512))
        .max(50)
        .optional()
        .describe('Expected implementation areas. Planning information, not a prediction of fact.'),
      rollbackConsiderations: boundedText(2_000).optional(),
      replanTriggers: z.array(boundedText(2_000)).max(50).optional(),
      replanReason: boundedText(2_000).optional().describe('Required in spirit when replacing a plan'),
    },
    outputSchema: {
      ...stateSummaryShape,
      planId: z.string(),
      planHash: z.string().describe('Pass this exact hash to orchestration_review_plan'),
      revision: z.number().int(),
      reviewRequired: z.boolean(),
      materiality: z.string().optional(),
      materialChanges: z.array(z.string()).optional(),
      planText: z.string().describe('Human-readable plan to present to the user for review'),
    },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const result = await submitPlan(deps, args.orchestrationId, {
          taskId: args.taskId,
          goal: args.goal,
          steps: args.steps.map((step) => ({
            ...(step.id !== undefined ? { id: step.id } : {}),
            description: step.description,
            ...(step.expectedAreas !== undefined ? { expectedAreas: step.expectedAreas } : {}),
            ...(step.expectedEvidence !== undefined ? { expectedEvidence: step.expectedEvidence } : {}),
          })),
          testStrategy: args.testStrategy,
          verificationStrategy: args.verificationStrategy,
          ...(args.nonGoals !== undefined ? { nonGoals: args.nonGoals } : {}),
          ...(args.constraints !== undefined ? { constraints: args.constraints } : {}),
          ...(args.relevantEvidence !== undefined ? { relevantEvidence: args.relevantEvidence } : {}),
          ...(args.assumptions !== undefined ? { assumptions: args.assumptions } : {}),
          ...(args.openQuestions !== undefined ? { openQuestions: args.openQuestions } : {}),
          ...(args.expectedAreas !== undefined ? { expectedAreas: args.expectedAreas } : {}),
          ...(args.rollbackConsiderations !== undefined
            ? { rollbackConsiderations: args.rollbackConsiderations }
            : {}),
          ...(args.replanTriggers !== undefined ? { replanTriggers: args.replanTriggers } : {}),
          ...(args.replanReason !== undefined ? { replanReason: args.replanReason } : {}),
        });

        const plan = result.plan;
        const planText = [
          `Execution plan revision ${plan.revision} — ${plan.specName}, task ${plan.binding.taskId}`,
          '',
          `Goal: ${plan.goal}`,
          ...(plan.nonGoals.length > 0 ? ['', 'Non-goals:', ...plan.nonGoals.map((v) => `  - ${v}`)] : []),
          ...(plan.constraints.length > 0
            ? ['', 'Constraints:', ...plan.constraints.map((v) => `  - ${v}`)]
            : []),
          ...(plan.assumptions.length > 0
            ? ['', 'Assumptions (not facts):', ...plan.assumptions.map((v) => `  - ${v}`)]
            : []),
          ...(plan.openQuestions.length > 0
            ? ['', 'Open questions:', ...plan.openQuestions.map((v) => `  - ${v}`)]
            : []),
          '',
          'Steps:',
          ...plan.steps.map((step, index) => `  ${index + 1}. ${step.description}`),
          '',
          `Test strategy: ${plan.testStrategy}`,
          `Verification strategy: ${plan.verificationStrategy}`,
          ...(plan.expectedAreas.length > 0 ? ['', `Expected areas: ${plan.expectedAreas.join(', ')}`] : []),
        ].join('\n');

        return {
          text: [
            planText,
            '',
            result.reviewRequired
              ? `Review REQUIRED before any source edit. Present this plan to the user, then call orchestration_review_plan with planHash "${result.planHash}".`
              : 'Planning policy does not require review; execution may begin.',
          ].join('\n'),
          structured: {
            ...stateSummary(workspace, result.state),
            planId: plan.planId,
            planHash: result.planHash,
            revision: plan.revision,
            reviewRequired: result.reviewRequired,
            ...(result.materiality !== undefined
              ? {
                  materiality: result.materiality.materiality,
                  materialChanges: result.materiality.materialChanges,
                }
              : {}),
            planText,
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// orchestration_review_plan
// ---------------------------------------------------------------------------

export function registerOrchestrationReviewPlanTool(
  server: McpServer,
  context: ServerContext,
): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_review_plan',
    title: 'Record plan review',
    description:
      "Record the USER's explicit decision on the active execution plan, bound to its exact hash. " +
      'This is a PLAN review, not a spec approval: it never approves a requirements, bugfix, ' +
      'design, or tasks stage, and there is no tool that can. Present the plan and ask before ' +
      'calling this; the hash binding is contract-enforced, the asking is skill-guided.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg,
      planHash: z.string().min(1).max(64).describe('Exact planHash from orchestration_submit_plan'),
      decision: z.enum(['approved', 'rejected']).describe("The user's decision, not yours"),
      note: boundedText(2_000).optional(),
    },
    outputSchema: { ...stateSummaryShape, decision: z.string(), planRevision: z.number().int() },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const state = reviewPlan(deps, args.orchestrationId, {
          planHash: args.planHash,
          decision: args.decision,
          ...(args.note !== undefined ? { note: args.note } : {}),
          channel: 'user-relayed',
        });
        return {
          text:
            args.decision === 'approved'
              ? `Plan revision ${state.planRevision} approved by the user. Begin the task with task_begin, then record actions as you go.`
              : `Plan revision ${state.planRevision} rejected. Submit a revised plan.`,
          structured: {
            ...stateSummary(workspace, state),
            decision: args.decision,
            planRevision: state.planRevision,
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// orchestration_record_action
// ---------------------------------------------------------------------------

export function registerOrchestrationRecordActionTool(
  server: McpServer,
  context: ServerContext,
): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_record_action',
    title: 'Record action and get the next directive',
    description:
      'Record one bounded observe/decide/act iteration and receive the DETERMINISTIC next ' +
      'directive (CONTINUE, RETRY, VERIFY, REPAIR, REPLAN, CLARIFY, BLOCK, or a budget stop). ' +
      'Record what you did operationally — category, target, expected evidence, plan step, result ' +
      '— never your reasoning; no field stores it. Source edits are refused before the plan gate ' +
      'and against a stale plan. You do not choose the directive; you read it.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg,
      action: z.enum(ACTION_CATEGORIES),
      target: boundedText(512).describe('What the action targeted: a path, a verifier, a step'),
      result: z.enum(OBSERVATION_RESULTS),
      planStepId: z.string().max(64).optional(),
      expectedEvidence: boundedText(2_000).optional(),
      changedFiles: z
        .array(z.object({ path: z.string().max(1_024), contentHash: z.string().max(128).optional() }))
        .max(500)
        .optional()
        .describe('Observed changes. Claims: the completion gate re-derives them from Git.'),
      failure: z
        .object({
          category: z.enum(FAILURE_CATEGORIES),
          message: boundedText(2_000),
          source: boundedText(512).describe('Verifier name, tool, or step that failed'),
          exitCode: z.number().int().optional(),
          output: z.string().max(16_384).optional().describe('Normalized before fingerprinting'),
        })
        .optional(),
      readyToVerify: z
        .boolean()
        .optional()
        .describe('Assert the implementation is ready for trusted verification'),
    },
    outputSchema: {
      ...stateSummaryShape,
      directive: z.string(),
      reason: z.string(),
      backoffMs: z.number(),
      remediation: z.array(z.string()),
      failureCategory: z.string().optional(),
      exhaustedBudget: z.string().optional(),
      progressed: z.boolean(),
      consecutiveNoProgress: z.number().int(),
      stagnated: z.boolean(),
      progressReason: z.string(),
    },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const result = await recordActionChecked(deps, args.orchestrationId, {
          action: args.action,
          target: args.target,
          result: args.result,
          ...(args.planStepId !== undefined ? { planStepId: args.planStepId } : {}),
          ...(args.expectedEvidence !== undefined ? { expectedEvidence: args.expectedEvidence } : {}),
          ...(args.changedFiles !== undefined ? { changedFiles: args.changedFiles } : {}),
          ...(args.failure !== undefined ? { failure: args.failure } : {}),
          ...(args.readyToVerify !== undefined ? { readyToVerify: args.readyToVerify } : {}),
        });

        const decision = result.decision;
        return {
          text: [
            `Directive: ${decision.directive}`,
            decision.reason,
            ...(decision.backoffMs > 0 ? [`Wait ${decision.backoffMs}ms before retrying.`] : []),
            ...(decision.remediation.length > 0
              ? ['', ...decision.remediation.map((step) => `  - ${step}`)]
              : []),
          ].join('\n'),
          structured: {
            ...stateSummary(workspace, result.state),
            directive: decision.directive,
            reason: decision.reason,
            backoffMs: decision.backoffMs,
            remediation: decision.remediation,
            ...(decision.failureCategory !== undefined
              ? { failureCategory: decision.failureCategory }
              : {}),
            ...(decision.exhaustedBudget !== undefined
              ? { exhaustedBudget: decision.exhaustedBudget }
              : {}),
            progressed: result.progress.progressed,
            consecutiveNoProgress: result.progress.consecutiveNoProgress,
            stagnated: result.progress.stagnated,
            progressReason: result.progress.reason,
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// orchestration_checkpoint
// ---------------------------------------------------------------------------

export function registerOrchestrationCheckpointTool(
  server: McpServer,
  context: ServerContext,
): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_checkpoint',
    title: 'Create orchestration checkpoint',
    description:
      'Write a compact structured checkpoint: phase, plan revision, completed and unresolved ' +
      'steps, key observations, counters, blocker, and the exact next safe action. Deliberately ' +
      'small — never a transcript. A later session recovers this, not your reasoning.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg,
      nextAction: boundedText(2_000).describe('The exact next safe action, in one line'),
      observations: z.array(boundedText(2_000)).max(50).optional(),
      latestVerifier: boundedText(2_000).optional(),
    },
    outputSchema: {
      orchestrationId: z.string(),
      phase: z.string(),
      planRevision: z.number().int(),
      completedSteps: z.array(z.string()),
      unresolvedSteps: z.array(z.string()),
      nextAction: z.string(),
      checkpointBytes: z.number().int(),
    },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const checkpoint = createCheckpoint(deps, args.orchestrationId, {
          nextAction: args.nextAction,
          ...(args.observations !== undefined ? { observations: args.observations } : {}),
          ...(args.latestVerifier !== undefined ? { latestVerifier: args.latestVerifier } : {}),
        });
        return {
          text: `Checkpoint written for ${checkpoint.orchestrationId} (${checkpoint.phase}). Next action: ${checkpoint.nextAction}`,
          structured: {
            orchestrationId: checkpoint.orchestrationId,
            phase: checkpoint.phase,
            planRevision: checkpoint.planRevision,
            completedSteps: checkpoint.completedSteps,
            unresolvedSteps: checkpoint.unresolvedSteps,
            nextAction: checkpoint.nextAction,
            checkpointBytes: Buffer.byteLength(JSON.stringify(checkpoint), 'utf8'),
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// orchestration_finalize
// ---------------------------------------------------------------------------

export function registerOrchestrationFinalizeTool(
  server: McpServer,
  context: ServerContext,
): void {
  registerDefinedTool(server, context, {
    name: 'orchestration_finalize',
    title: 'Finalize orchestration',
    description:
      'Close a governed orchestration run as completed, aborted, or cancelled. Completion is ' +
      'accepted ONLY with a verified evidence status actually returned by task_complete ' +
      '(verified or manually-accepted); orchestration has no independent notion of "done" and ' +
      'cannot create one. Repeat calls are idempotent and never re-run anything.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      orchestrationId: orchestrationIdArg,
      outcome: z.enum(['completed', 'aborted', 'cancelled']),
      reason: boundedText(2_000),
      evidenceStatus: z
        .string()
        .max(64)
        .optional()
        .describe('The evidenceStatus task_complete actually returned. Required for completion.'),
      interactiveRunId: z.string().max(64).optional(),
    },
    outputSchema: { ...stateSummaryShape, finalOutcome: z.string(), finalizedAt: z.string().optional() },
    handler: async (args) =>
      context.withWriteLock(async () => {
        const workspace = context.requireWorkspace();
        const deps = orchestrationDeps(context, workspace);
        const state = finalizeOrchestration(deps, args.orchestrationId, {
          outcome: args.outcome,
          reason: args.reason,
          ...(args.evidenceStatus !== undefined ? { evidenceStatus: args.evidenceStatus } : {}),
          ...(args.interactiveRunId !== undefined ? { interactiveRunId: args.interactiveRunId } : {}),
        });
        return {
          text: `Orchestration ${state.orchestrationId} is ${state.phase}.`,
          structured: {
            ...stateSummary(workspace, state),
            finalOutcome: state.finalOutcome ?? state.phase,
            ...(state.finalizedAt !== undefined ? { finalizedAt: state.finalizedAt } : {}),
          },
        };
      }),
  });
}

/** Read the current state without reconciliation (internal helper for tests). */
export function readOrchestrationSummary(workspace: WorkspaceInfo, orchestrationId: string) {
  return stateSummary(workspace, requireOrchestrationState(workspace, orchestrationId));
}
