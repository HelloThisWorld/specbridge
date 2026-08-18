import { z } from 'zod';
import { OrchestrationError } from '../errors.js';
import type { PlanCandidateInput } from '../planning.js';
import { FAILURE_CATEGORIES } from '../vocabulary.js';
import { COMPLEXITY_CLASSES } from '../jobs/vocabulary.js';

/**
 * Structured local-agent contracts (v1.2).
 *
 * A local model's answer is a machine contract, never prose. Every role has
 * a versioned zod schema, a matching hand-written JSON Schema (sent to the
 * endpoint for constrained decoding, following the existing
 * TASK_RUNNER_REPORT_JSON_SCHEMA pattern), and one validation entry point.
 *
 * Validation rules, deliberately strict:
 *   - the COMPLETE response is parsed as JSON; there is no substring
 *     extraction, no regex mining, and no "repair" of malformed output
 *   - unknown fields are ignored (additive tolerance) but missing or
 *     mistyped required fields are refused
 *   - every text field is bounded, so a runaway generation cannot become a
 *     runaway record
 *   - nothing in an output can name a file to write, a command to run, or a
 *     permission to grant — these schemas carry DECISIONS about work, and
 *     the deterministic core decides what is legal to do with them
 *
 * What is deliberately absent: any field for reasoning, deliberation, or
 * "thoughts". Outputs carry conclusions with evidence references; private
 * chain-of-thought is neither requested nor accepted nor persisted.
 */

export const AGENT_CONTRACT_SCHEMA_VERSION = '1.0.0';

/** Bounds shared by all agent outputs. */
export const AGENT_OUTPUT_LIMITS = {
  maxShortChars: 300,
  maxTextChars: 1_500,
  maxListItems: 20,
  maxSteps: 40,
  maxResponseBytes: 262_144,
} as const;

const shortText = z.string().min(1).max(AGENT_OUTPUT_LIMITS.maxShortChars);
const text = z.string().min(1).max(AGENT_OUTPUT_LIMITS.maxTextChars);
const textList = z.array(text).max(AGENT_OUTPUT_LIMITS.maxListItems);

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export const classifierOutputSchema = z.object({
  /** Proposed complexity class. May only RAISE the deterministic class. */
  complexity: z.enum(COMPLEXITY_CLASSES),
  /** Short factual reasons tied to the task text. */
  reasons: textList.default([]),
});
export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export const plannerStepSchema = z.object({
  id: shortText,
  action: text,
  /** What observable evidence would show this step succeeded. */
  expectedEvidence: text.optional(),
});

export const plannerOutputSchema = z.object({
  decision: z.enum(['PLAN', 'ESCALATE']),
  /** The planner's own complexity impression (informational only). */
  complexity: z.enum(COMPLEXITY_CLASSES).optional(),
  goal: text.optional(),
  steps: z.array(plannerStepSchema).max(AGENT_OUTPUT_LIMITS.maxSteps).default([]),
  testStrategy: text.optional(),
  verificationStrategy: text.optional(),
  assumptions: textList.default([]),
  risks: textList.default([]),
  requiresEscalation: z.boolean().default(false),
  escalationReason: text.optional(),
});
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

// ---------------------------------------------------------------------------
// Critic
// ---------------------------------------------------------------------------

export const criticOutputSchema = z.object({
  verdict: z.enum(['ACCEPT', 'REVISE', 'ESCALATE']),
  /** Specific, factual objections or confirmations. */
  reasons: textList.default([]),
  /** For REVISE: concrete changes the planner should make. */
  requestedChanges: textList.default([]),
  /** Signals the critic believes exceed local capability. */
  escalationReason: text.optional(),
});
export type CriticOutput = z.infer<typeof criticOutputSchema>;

// ---------------------------------------------------------------------------
// Diagnoser
// ---------------------------------------------------------------------------

export const diagnoserOutputSchema = z.object({
  category: z.enum(FAILURE_CATEGORIES),
  rootCause: text,
  planValidity: z.enum(['VALID', 'INVALID', 'UNKNOWN']),
  recommendedAction: z.enum(['REPAIR', 'REPLAN', 'RETRY', 'CLARIFY', 'BLOCK']),
  /** Observable evidence references (test names, error lines), not prose. */
  evidence: textList.default([]),
});
export type DiagnoserOutput = z.infer<typeof diagnoserOutputSchema>;

// ---------------------------------------------------------------------------
// Replanner
// ---------------------------------------------------------------------------

export const replannerOutputSchema = z.object({
  decision: z.enum(['REVISED_PLAN', 'SUPERSEDE_NODE', 'ESCALATE', 'BLOCKED']),
  /** Why the previous plan failed, in one bounded statement. */
  reason: text,
  goal: text.optional(),
  steps: z.array(plannerStepSchema).max(AGENT_OUTPUT_LIMITS.maxSteps).default([]),
  testStrategy: text.optional(),
  verificationStrategy: text.optional(),
  assumptions: textList.default([]),
  /**
   * True when the replacement approach would change APPROVED behavior,
   * public API, architecture constraints, or product intent. A true value
   * always stops autonomous execution for a human decision — and the
   * deterministic core additionally screens for it, so a false claim here
   * is not the only line of defense.
   */
  impactsApprovedIntent: z.boolean(),
  escalationReason: text.optional(),
});
export type ReplannerOutput = z.infer<typeof replannerOutputSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type AgentContractRole = 'CLASSIFIER' | 'PLANNER' | 'CRITIC' | 'DIAGNOSER' | 'REPLANNER';

const SCHEMAS: Record<AgentContractRole, z.ZodTypeAny> = {
  CLASSIFIER: classifierOutputSchema,
  PLANNER: plannerOutputSchema,
  CRITIC: criticOutputSchema,
  DIAGNOSER: diagnoserOutputSchema,
  REPLANNER: replannerOutputSchema,
};

export type AgentOutputFor<Role extends AgentContractRole> = Role extends 'CLASSIFIER'
  ? ClassifierOutput
  : Role extends 'PLANNER'
    ? PlannerOutput
    : Role extends 'CRITIC'
      ? CriticOutput
      : Role extends 'DIAGNOSER'
        ? DiagnoserOutput
        : ReplannerOutput;

export type AgentOutputValidation<Role extends AgentContractRole> =
  | { ok: true; output: AgentOutputFor<Role> }
  | { ok: false; problem: string };

/**
 * Validate one COMPLETE model response against a role contract.
 *
 * The text must be exactly one JSON document. Leading/trailing whitespace is
 * tolerated; leading/trailing prose is not — a model that wraps its answer
 * in commentary has not followed the contract, and mining the JSON out of
 * the commentary is precisely the "silent malformed-output repair" this
 * function exists to refuse.
 */
export function validateAgentOutput<Role extends AgentContractRole>(
  role: Role,
  responseText: string,
): AgentOutputValidation<Role> {
  if (Buffer.byteLength(responseText, 'utf8') > AGENT_OUTPUT_LIMITS.maxResponseBytes) {
    return { ok: false, problem: `the response exceeds ${AGENT_OUTPUT_LIMITS.maxResponseBytes} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText.trim());
  } catch {
    return { ok: false, problem: 'the response is not a single valid JSON document' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problem: 'the response must be a JSON object' };
  }
  const result = SCHEMAS[role].safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, problem: `the response does not match the ${role} contract — ${issues}` };
  }
  return { ok: true, output: result.data as AgentOutputFor<Role> };
}

/**
 * The bounded correction message for one invalid output. Sent back exactly
 * once (policy-bounded); a second invalid answer escalates instead.
 */
export function correctionMessage(role: AgentContractRole, problem: string): string {
  return (
    `Your previous response was invalid: ${problem}. ` +
    `Respond again with ONLY a single JSON object matching the ${role} schema. ` +
    'No prose, no code fences, no explanation outside the JSON.'
  );
}

/** Convert a PLAN-decision planner output into a plan candidate. */
export function plannerOutputToCandidate(output: PlannerOutput): PlanCandidateInput {
  if (output.decision !== 'PLAN') {
    throw new OrchestrationError('SBO037', 'Only a PLAN decision carries a plan candidate.');
  }
  if (output.steps.length === 0 || output.goal === undefined) {
    throw new OrchestrationError('SBO037', 'A PLAN decision requires a goal and at least one step.', {
      remediation: ['The planner must return goal, steps, testStrategy, and verificationStrategy.'],
    });
  }
  return {
    goal: output.goal,
    steps: output.steps.map((step) => ({
      id: step.id,
      description: step.action,
      ...(step.expectedEvidence !== undefined ? { expectedEvidence: step.expectedEvidence } : {}),
    })),
    testStrategy: output.testStrategy ?? 'Cover the change with the existing test suite.',
    verificationStrategy:
      output.verificationStrategy ?? 'Run the configured trusted verification commands.',
    assumptions: output.assumptions,
    ...(output.risks.length > 0 ? { openQuestions: [], relevantEvidence: [] } : {}),
  };
}

/** Convert a REVISED_PLAN replanner output into a plan candidate. */
export function replannerOutputToCandidate(output: ReplannerOutput): PlanCandidateInput {
  if (output.decision !== 'REVISED_PLAN') {
    throw new OrchestrationError('SBO037', 'Only a REVISED_PLAN decision carries a plan candidate.');
  }
  if (output.steps.length === 0 || output.goal === undefined) {
    throw new OrchestrationError('SBO037', 'A REVISED_PLAN decision requires a goal and at least one step.');
  }
  return {
    goal: output.goal,
    steps: output.steps.map((step) => ({
      id: step.id,
      description: step.action,
      ...(step.expectedEvidence !== undefined ? { expectedEvidence: step.expectedEvidence } : {}),
    })),
    testStrategy: output.testStrategy ?? 'Cover the change with the existing test suite.',
    verificationStrategy:
      output.verificationStrategy ?? 'Run the configured trusted verification commands.',
    assumptions: output.assumptions,
    replanReason: output.reason,
  };
}

// ---------------------------------------------------------------------------
// JSON Schemas (constrained decoding)
// ---------------------------------------------------------------------------

/**
 * Hand-written JSON Schemas mirroring the zod contracts, sent to the local
 * endpoint as `json_schema` response format. Kept intentionally flat and
 * strict — small models follow simple schemas far more reliably.
 */
const stringItem = (maxLength: number): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength });

const stepSchemaJson = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'action'],
  properties: {
    id: stringItem(AGENT_OUTPUT_LIMITS.maxShortChars),
    action: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
    expectedEvidence: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
  },
} as const;

const textListJson = {
  type: 'array',
  maxItems: AGENT_OUTPUT_LIMITS.maxListItems,
  items: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
} as const;

export const AGENT_OUTPUT_JSON_SCHEMAS: Record<AgentContractRole, Record<string, unknown>> = {
  CLASSIFIER: {
    type: 'object',
    additionalProperties: false,
    required: ['complexity'],
    properties: {
      complexity: { type: 'string', enum: [...COMPLEXITY_CLASSES] },
      reasons: textListJson,
    },
  },
  PLANNER: {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'steps'],
    properties: {
      decision: { type: 'string', enum: ['PLAN', 'ESCALATE'] },
      complexity: { type: 'string', enum: [...COMPLEXITY_CLASSES] },
      goal: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
      steps: { type: 'array', maxItems: AGENT_OUTPUT_LIMITS.maxSteps, items: stepSchemaJson },
      testStrategy: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
      verificationStrategy: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
      assumptions: textListJson,
      risks: textListJson,
      requiresEscalation: { type: 'boolean' },
      escalationReason: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
    },
  },
  CRITIC: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict'],
    properties: {
      verdict: { type: 'string', enum: ['ACCEPT', 'REVISE', 'ESCALATE'] },
      reasons: textListJson,
      requestedChanges: textListJson,
      escalationReason: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
    },
  },
  DIAGNOSER: {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'rootCause', 'planValidity', 'recommendedAction'],
    properties: {
      category: { type: 'string', enum: [...FAILURE_CATEGORIES] },
      rootCause: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
      planValidity: { type: 'string', enum: ['VALID', 'INVALID', 'UNKNOWN'] },
      recommendedAction: { type: 'string', enum: ['REPAIR', 'REPLAN', 'RETRY', 'CLARIFY', 'BLOCK'] },
      evidence: textListJson,
    },
  },
  REPLANNER: {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'reason', 'impactsApprovedIntent'],
    properties: {
      decision: { type: 'string', enum: ['REVISED_PLAN', 'SUPERSEDE_NODE', 'ESCALATE', 'BLOCKED'] },
      reason: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
      goal: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
      steps: { type: 'array', maxItems: AGENT_OUTPUT_LIMITS.maxSteps, items: stepSchemaJson },
      testStrategy: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
      verificationStrategy: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
      assumptions: textListJson,
      impactsApprovedIntent: { type: 'boolean' },
      escalationReason: stringItem(AGENT_OUTPUT_LIMITS.maxTextChars),
    },
  },
};
