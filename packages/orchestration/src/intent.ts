import type { OrchestrationPolicy, WorkspaceInfo } from '@specbridge/core';
import { readSpecState } from '@specbridge/core';
import { analyzeSpec, findTask, requireSpec } from '@specbridge/compat-kiro';
import { evaluateWorkflow } from '@specbridge/workflow';
import { readInteractiveLock } from '@specbridge/execution';
import type { IntentAssessment } from './state.js';
import { intentAssessmentSchema } from './state.js';
import type { IntentOutcome, ProvenanceKind } from './vocabulary.js';
import { UNSAFE_PROVENANCE_KINDS } from './vocabulary.js';

/**
 * Intent assessment.
 *
 * Division of labour, stated once because it is the crux of the design:
 *
 *   The HOST AGENT reads the user's request and produces a *structured*
 *   assessment — an outcome, a restated summary, machine-checkable reasons,
 *   and the provenance of each fact it relied on. Natural language is its job;
 *   pretending TypeScript can do it would be dishonest.
 *
 *   SpecBridge VALIDATES and may OVERRIDE that assessment against structural
 *   facts it checks itself: approvals, staleness, task existence, lock
 *   ownership, provenance safety. An agent can talk itself into READY; it
 *   cannot talk a stale approval into being fresh.
 *
 * Overrides only ever move *towards* caution. There is deliberately no path
 * that upgrades a submitted NEEDS_CLARIFICATION/BLOCKED/REJECTED into READY.
 */

export interface StructuralBlocker {
  /** Stable identifier so callers and tests can assert on it. */
  code: string;
  outcome: Exclude<IntentOutcome, 'READY'>;
  message: string;
  remediation: string[];
}

export interface IntentContext {
  workspace: WorkspaceInfo;
  specName: string;
  taskId?: string | undefined;
  policy: OrchestrationPolicy;
  /** The orchestration run being assessed; used for lock-ownership checks. */
  orchestrationId?: string | undefined;
}

/**
 * Deterministic prerequisites, checked by SpecBridge itself.
 *
 * Note what makes these BLOCKED rather than REJECTED: each one is an
 * understandable request whose external prerequisite is unsatisfied. The user
 * can fix them and proceed. Rejection is reserved for requests that must
 * never succeed.
 */
export function detectStructuralBlockers(context: IntentContext): StructuralBlocker[] {
  const blockers: StructuralBlocker[] = [];
  const { workspace, specName } = context;

  const folder = requireSpec(workspace, specName);
  const spec = analyzeSpec(workspace, folder);
  const state = readSpecState(workspace, specName).state;

  if (state === undefined) {
    blockers.push({
      code: 'unmanaged-spec',
      outcome: 'BLOCKED',
      message: `Spec "${specName}" has no SpecBridge workflow state; nothing can be implemented from it yet.`,
      remediation: [
        `Author the stages, then approve them (human action): specbridge spec approve ${specName} --stage <stage>`,
      ],
    });
    return blockers;
  }

  const evaluation = evaluateWorkflow(workspace, state);
  if (evaluation.health === 'stale') {
    const stale = [...evaluation.staleStages, ...evaluation.invalidatedStages];
    blockers.push({
      code: 'stale-approval',
      outcome: 'BLOCKED',
      message: `Approved stage(s) of "${specName}" changed after approval (${stale.join(', ')}); implementation is blocked until they are re-approved.`,
      remediation: [
        `Review the changes and re-approve (human action): specbridge spec approve ${specName} --stage ${stale[0] ?? '<stage>'}`,
      ],
    });
  } else if (evaluation.effectiveStatus !== 'READY_FOR_IMPLEMENTATION') {
    const unapproved = evaluation.stages
      .filter((stage) => stage.effective !== 'approved')
      .map((stage) => stage.stage);
    blockers.push({
      code: 'stages-not-approved',
      outcome: 'BLOCKED',
      message: `Not every stage of "${specName}" is approved yet (missing: ${unapproved.join(', ')}).`,
      remediation: [
        'Author and approve the missing stage(s) first. Approval is a human action; no agent can perform it.',
      ],
    });
  }

  if (context.taskId !== undefined) {
    const task = spec.tasks !== undefined ? findTask(spec.tasks, context.taskId) : undefined;
    if (task === undefined) {
      blockers.push({
        code: 'task-not-found',
        outcome: 'BLOCKED',
        message: `Task ${context.taskId} does not exist in "${specName}".`,
        remediation: ['List the current tasks with the task_list tool and select an existing one.'],
      });
    } else if (task.state === 'done') {
      blockers.push({
        code: 'task-already-complete',
        outcome: 'BLOCKED',
        message: `Task ${context.taskId} in "${specName}" is already marked complete.`,
        remediation: ['Select the next open task, or re-open the task in tasks.md and re-approve.'],
      });
    }
  }

  // Another interactive execution owning the lock is a genuine prerequisite:
  // its Git bracketing is what makes attribution trustworthy.
  const lock = readInteractiveLock(workspace);
  if (lock.state === 'held') {
    blockers.push({
      code: 'interactive-run-active',
      outcome: 'BLOCKED',
      message: `Another interactive execution (run ${lock.lock.runId}) currently owns the repository lock.`,
      remediation: [
        'Finish or abort that run first (task_complete / task_abort),',
        'or diagnose a crashed run with: specbridge run recover-lock',
      ],
    });
  }

  return blockers;
}

/**
 * Requests that must never succeed, whatever they claim about themselves.
 *
 * These are matched against the *host's structured summary of what the user
 * asked for*, not against repository content — repository text is data and
 * can never trigger or suppress a rejection.
 */
export interface RejectionRule {
  code: string;
  /** Matched against the normalized intent summary. */
  pattern: RegExp;
  message: string;
  remediation: string[];
}

/**
 * Ordered most-specific first: "disable the protected-path checks" mentions
 * checks, so the protected-path rule must be consulted before the broader
 * verification-bypass rule or the user gets the less precise explanation.
 */
export const REJECTION_RULES: readonly RejectionRule[] = Object.freeze([
  {
    code: 'agent-approval-requested',
    pattern:
      /\b(approve|approving|approval of|sign off on|signoff)\b[^.]{0,60}\b(spec|design|requirements|bugfix|tasks|stage)\b|\bauto[- ]?approve\b|\bapprove (it|the \w+) (yourself|for me|on my behalf)\b/i,
    message:
      'Stage approval is a human-only action. SpecBridge exposes no agent-accessible approval path, ' +
      'and orchestration cannot create one.',
    remediation: [
      'The user approves explicitly: specbridge spec approve <spec> --stage <stage>',
      'Or in Claude Code: /specbridge:approve (which prints the command; it never approves for you).',
    ],
  },
  {
    code: 'protected-path-bypass-requested',
    pattern: /\b(disable|bypass|turn off|remove|skip|ignore)\b[^.]{0,40}\bprotected[- ]path/i,
    message: 'Protected-path checks are not configurable away.',
    remediation: ['Keep changes outside `.kiro/`, `.specbridge/`, `.git/`, and configured protected paths.'],
  },
  {
    code: 'verification-bypass-requested',
    pattern:
      /\b(skip|bypass|disable|turn off|ignore|without)\b[^.]{0,40}\b(verification|verifying|verifier|tests?|checks?)\b|\bmark (it|the task) (as )?(complete|done)\b[^.]{0,40}\bwithout\b/i,
    message:
      'Completion is decided by Git evidence and the trusted verification commands. ' +
      'Orchestration cannot mark a task complete without them.',
    remediation: [
      'Fix the implementation so verification passes, or accept the task manually with the documented human command.',
    ],
  },
  {
    code: 'nested-agent-requested',
    pattern:
      /\b(launch|spawn|start|run)\b[^.]{0,40}\b(nested|another|sub-?)\s?(agent|claude|session)\b|\bclaude\s+-p\b/i,
    message:
      'The Claude Code plugin is single-agent by contract: the current session is the implementer. ' +
      'SpecBridge never launches a nested coding agent from the plugin path.',
    remediation: [
      'Implement in this session through the task_begin / task_complete lifecycle.',
      'Detached runner execution remains available through the standalone CLI runner architecture.',
    ],
  },
  {
    code: 'kiro-direct-edit-requested',
    pattern: /\b(edit|modify|write to|change|update)\b[^.]{0,30}\.kiro\b/i,
    message:
      '`.kiro` is the human-owned specification source of truth. Agents never edit it directly; ' +
      'stage candidates go through spec_stage_apply and then human approval.',
    remediation: ['Propose a stage candidate with spec_stage_validate / spec_stage_apply.'],
  },
]);

export function detectRejection(summary: string): RejectionRule | undefined {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  return REJECTION_RULES.find((rule) => rule.pattern.test(normalized));
}

export interface IntentSubmission {
  outcome: IntentOutcome;
  summary: string;
  reasons?: string[] | undefined;
  provenance?: { fact: string; source: ProvenanceKind; reference?: string | undefined }[] | undefined;
}

export interface IntentValidationResult {
  assessment: IntentAssessment;
  /** Structural blockers found, whatever the submitted outcome claimed. */
  blockers: StructuralBlocker[];
  /** True when SpecBridge overrode the host's submitted outcome. */
  overridden: boolean;
}

/**
 * Validate a submitted assessment and apply deterministic overrides.
 *
 * Precedence, strongest first:
 *   1. REJECTED — a hard product boundary, checked against the summary.
 *   2. BLOCKED  — an unsatisfied structural prerequisite.
 *   3. NEEDS_CLARIFICATION — the host said so, or it relied on unsafe
 *      provenance (an inference, an unknown, or a conflict) while claiming
 *      READY.
 *   4. READY.
 */
export function validateIntent(
  context: IntentContext,
  submission: IntentSubmission,
  options: { assessedAt: string },
): IntentValidationResult {
  const submitted = submission.outcome;
  const reasons = [...(submission.reasons ?? [])];
  const provenance = submission.provenance ?? [];

  let outcome: IntentOutcome = submitted;
  let overrideReason: string | undefined;

  // 1. Hard product boundaries. Checked even when the host said READY —
  //    especially then.
  const rejection = detectRejection(submission.summary);
  if (rejection !== undefined) {
    outcome = 'REJECTED';
    overrideReason = rejection.message;
    reasons.push(`${rejection.code}: ${rejection.message}`);
  }

  // 2. Structural prerequisites.
  const blockers = outcome === 'REJECTED' ? [] : detectStructuralBlockers(context);
  if (outcome !== 'REJECTED' && blockers.length > 0) {
    if (outcome === 'READY' || outcome === 'NEEDS_CLARIFICATION') {
      overrideReason =
        `${blockers.length} structural prerequisite(s) are unsatisfied: ` +
        blockers.map((blocker) => blocker.code).join(', ');
    }
    outcome = 'BLOCKED';
    for (const blocker of blockers) reasons.push(`${blocker.code}: ${blocker.message}`);
  }

  // 3. A READY assessment resting on an inference, an unknown, or a conflict
  //    is not READY. This is the structural replacement for a confidence
  //    score: the provenance is checkable, a number would not be.
  if (outcome === 'READY') {
    const unsafe = provenance.filter((entry) => UNSAFE_PROVENANCE_KINDS.includes(entry.source));
    if (unsafe.length > 0) {
      outcome = 'NEEDS_CLARIFICATION';
      const kinds = [...new Set(unsafe.map((entry) => entry.source))].join(', ');
      overrideReason =
        `The assessment claimed READY while relying on ${unsafe.length} fact(s) with ${kinds} provenance. ` +
        'Facts that are inferred, unknown, or conflicting need a user decision before implementation.';
      for (const entry of unsafe) {
        reasons.push(`${entry.source}: ${entry.fact}`);
      }
    }
  }

  const assessment = intentAssessmentSchema.parse({
    outcome,
    summary: submission.summary,
    reasons: reasons.slice(0, 50),
    provenance: provenance.slice(0, 50),
    assessedAt: options.assessedAt,
    ...(outcome !== submitted ? { overriddenFrom: submitted } : {}),
    ...(overrideReason !== undefined ? { overrideReason } : {}),
  });

  return { assessment, blockers, overridden: outcome !== submitted };
}
