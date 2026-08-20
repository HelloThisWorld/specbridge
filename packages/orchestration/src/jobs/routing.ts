import type { AgentConfig, JobPolicy, RoleRoute } from '@specbridge/core';
import { validateLocalInferenceConfig } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import type { JobWorkerProfile } from './state.js';
import type { AgentRole, ComplexityClass, EscalationReason } from './vocabulary.js';

/**
 * Role → worker routing: local-first, escalate-on-evidence.
 *
 * The scheduler asks "which worker holds this role for this node?" and gets
 * back a worker plus, when the local tier was skipped or abandoned, the
 * recorded reason. Nothing here branches on provider names — workers are
 * profiles with roles, tiers, and capabilities, derived from configuration.
 *
 * Two invariants enforced structurally:
 *   - `selectWorker` for the EXECUTOR always resolves to a repository-
 *     writing LARGE_AGENT worker; the local worker never declares
 *     repositoryWrite, so even a mis-edited routing table cannot select it
 *     for source mutation. (vNext.2's LOCAL execution lane deliberately
 *     does NOT pass through here: it is a separate explicit path in which
 *     the local model returns structured edits and SpecBridge itself
 *     applies and verifies them — the model still never writes.)
 *   - every escalation carries an EscalationReason; a paid worker is never
 *     selected silently
 */

export const LOCAL_WORKER_ID = 'local-llamacpp';
export const CLAUDE_WORKER_ID = 'claude-code';

/**
 * Derive the worker roster from configuration. The local worker exists only
 * when local inference is enabled and coherently configured; the Claude Code
 * worker always exists (its availability is probed at dispatch time by the
 * existing runner platform, which owns detection).
 */
export function resolveWorkers(config: AgentConfig): JobWorkerProfile[] {
  const workers: JobWorkerProfile[] = [];

  const local = config.localInference;
  if (local.enabled && validateLocalInferenceConfig(local).ok) {
    workers.push({
      workerId: LOCAL_WORKER_ID,
      // EVALUATOR joins the local roles: judging one bounded candidate
      // against a bounded contract projection is exactly the
      // schema-constrained, read-only reasoning the local tier exists for.
      roles: ['CLASSIFIER', 'PLANNER', 'CRITIC', 'DIAGNOSER', 'REPLANNER', 'EVALUATOR'],
      reasoningTier: 'LOCAL_SMALL',
      costTier: 'LOCAL',
      repositoryRead: false,
      // The local model receives bounded packets and returns structured
      // documents. It never reads the repository itself and NEVER writes.
      repositoryWrite: false,
      structuredOutput: true,
      localOnly: true,
      requiresNetwork: false,
      supportsCancellation: true,
      maxInputCharacters: local.maximumInputCharacters,
    });
  }

  workers.push({
    workerId: CLAUDE_WORKER_ID,
    runnerProfile: config.defaultRunner,
    roles: [
      'CLASSIFIER',
      'PLANNER',
      'CRITIC',
      'DIAGNOSER',
      'REPLANNER',
      'EXECUTOR',
      'DECOMPOSER',
      'BUILDER',
      'EVALUATOR',
      'AGGREGATOR',
      'INTEGRATOR',
    ],
    reasoningTier: 'LARGE_AGENT',
    costTier: 'PAID',
    repositoryRead: true,
    repositoryWrite: true,
    structuredOutput: true,
    localOnly: false,
    requiresNetwork: true,
    supportsCancellation: true,
    maxInputCharacters: 500_000,
  });

  return workers;
}

export interface WorkerSelection {
  worker: JobWorkerProfile;
  /** Present when the local tier was skipped or abandoned. */
  escalation?: { reason: EscalationReason; detail: string };
}

function findWorker(
  workers: readonly JobWorkerProfile[],
  predicate: (worker: JobWorkerProfile) => boolean,
): JobWorkerProfile | undefined {
  return workers.find(predicate);
}

function routeFor(policy: JobPolicy, role: AgentRole): RoleRoute | 'large-agent' {
  switch (role) {
    case 'CLASSIFIER':
      return policy.routing.classifier;
    case 'PLANNER':
      return policy.routing.planner;
    case 'CRITIC':
      return policy.routing.critic;
    case 'DIAGNOSER':
      return policy.routing.diagnoser;
    case 'REPLANNER':
      return policy.routing.replanner;
    case 'EXECUTOR':
      return policy.routing.executor;
    case 'DECOMPOSER':
      return policy.routing.decomposer;
    case 'EVALUATOR':
      return policy.routing.evaluator;
    case 'AGGREGATOR':
      return policy.routing.aggregator;
    // Repository-writing roles have no configurable route: like the
    // executor, they structurally require the large agent.
    case 'BUILDER':
    case 'INTEGRATOR':
      return 'large-agent';
  }
}

export interface SelectWorkerInput {
  role: AgentRole;
  complexity: ComplexityClass | undefined;
  policy: JobPolicy;
  workers: readonly JobWorkerProfile[];
  /** Escalation reasons already recorded for this node (sticky). */
  nodeEscalations: readonly EscalationReason[];
}

/**
 * Select the worker for one role invocation. Deterministic.
 *
 * Local-first means exactly this and nothing more: when the role's route is
 * `local-first`, a healthy local worker exists, the complexity class is not
 * HIGH, and no sticky escalation has been recorded for the node, the local
 * worker is chosen. Every other combination resolves to the large agent
 * with a recorded reason — or throws when no compatible worker exists.
 */
export function selectWorker(input: SelectWorkerInput): WorkerSelection {
  const { role, policy, workers } = input;

  const large = findWorker(
    workers,
    (worker) => worker.reasoningTier === 'LARGE_AGENT' && worker.roles.includes(role),
  );
  const local = findWorker(
    workers,
    (worker) => worker.reasoningTier === 'LOCAL_SMALL' && worker.roles.includes(role),
  );

  // Repository-writing roles require write capability, structurally: the
  // local worker never declares repositoryWrite, so even a mis-edited
  // routing table cannot select it for source mutation — canonical (EXECUTOR,
  // INTEGRATOR) or worktree-isolated (BUILDER) alike.
  if (role === 'EXECUTOR' || role === 'BUILDER' || role === 'INTEGRATOR') {
    const writer = findWorker(
      workers,
      (worker) => worker.roles.includes(role) && worker.repositoryWrite,
    );
    if (writer === undefined) {
      throw new OrchestrationError('SBO034', `No repository-writing worker is available for ${role}.`, {
        remediation: ['Check the Claude Code runner with `specbridge runner doctor claude-code`.'],
        failureCategory: 'CAPABILITY_UNAVAILABLE',
      });
    }
    return { worker: writer };
  }

  const route = routeFor(policy, role);
  if (route === 'disabled') {
    throw new OrchestrationError(
      'SBO034',
      `Role ${role} is disabled by routing policy; the scheduler must not request it.`,
      { failureCategory: 'INVALID_CONFIGURATION' },
    );
  }

  if (route === 'large-agent') {
    if (large === undefined) {
      throw new OrchestrationError('SBO034', `No large-agent worker is available for ${role}.`, {
        failureCategory: 'CAPABILITY_UNAVAILABLE',
      });
    }
    return { worker: large, escalation: { reason: 'ROLE_POLICY', detail: `${role} routes to the large agent by policy.` } };
  }

  // local-first. Evidence-based escalations are STICKY for the node: once
  // local reasoning demonstrably failed or was judged insufficient there,
  // the node never routes back to the local tier. Situational reasons
  // (ROLE_POLICY, LOCAL_WORKER_UNAVAILABLE) re-evaluate naturally instead.
  const STICKY_REASONS: readonly string[] = [
    'INVALID_LOCAL_OUTPUT',
    'REPEATED_LOCAL_FAILURE',
    'COMPLEXITY_HIGH',
    'CRITIC_ESCALATED',
    'PLANNER_CRITIC_DISAGREEMENT',
    'COMPETING_PLANS_DIVERGED',
    'CONTEXT_LIMIT_EXCEEDED',
  ];
  const sticky = input.nodeEscalations.find((reason) => STICKY_REASONS.includes(reason));
  if (sticky !== undefined && large !== undefined) {
    return {
      worker: large,
      escalation: {
        reason: sticky,
        detail: `A previous local attempt for this node escalated (${sticky}); local routing is not retried.`,
      },
    };
  }
  if (input.complexity === 'HIGH') {
    if (large === undefined) {
      throw new OrchestrationError('SBO034', `No large-agent worker is available for HIGH-complexity ${role}.`, {
        failureCategory: 'CAPABILITY_UNAVAILABLE',
      });
    }
    return {
      worker: large,
      escalation: {
        reason: 'COMPLEXITY_HIGH',
        detail: 'Deterministic complexity assessment classified this work HIGH; local reasoning is skipped.',
      },
    };
  }
  if (local !== undefined) {
    return { worker: local };
  }
  if (large === undefined) {
    throw new OrchestrationError('SBO034', `No worker is available for ${role}.`, {
      failureCategory: 'CAPABILITY_UNAVAILABLE',
    });
  }
  return {
    worker: large,
    escalation: {
      reason: 'LOCAL_WORKER_UNAVAILABLE',
      detail: 'No local worker is configured or healthy; the role escalates to the large agent.',
    },
  };
}

/**
 * Whether an escalation may proceed automatically under the configured
 * escalation mode. In `manual` mode a would-be escalation stops the job
 * with a recorded question instead of spending paid reasoning.
 */
export function escalationAllowed(policy: JobPolicy): boolean {
  return policy.escalation === 'automatic';
}
