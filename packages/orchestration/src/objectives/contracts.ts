import { z } from 'zod';
import { EVALUATION_VERDICTS, WORK_UNIT_KINDS } from './vocabulary.js';

/**
 * Structured objective-agent contracts.
 *
 * The same discipline as agents/contracts.ts: a worker's answer is a machine
 * contract, never prose. The COMPLETE response is parsed as JSON, unknown
 * fields are tolerated, required fields are refused when missing, every
 * text field is bounded, and nothing in an output can name a command to
 * run, a permission to grant, or an authority to hold. There is no field
 * for reasoning or deliberation, deliberately.
 *
 * Authority notes, enforced by the deterministic core (not by these shapes
 * alone):
 *   - a DECOMPOSER output is a PROPOSAL; validateWorkGraphProposal decides
 *   - an EVALUATOR verdict never completes anything; it feeds aggregation
 *   - an AGGREGATOR may RECOMMEND a contract change; it cannot approve one
 *   - a BUILDER claiming completion claims a CANDIDATE, nothing more
 */

export const OBJECTIVE_CONTRACT_SCHEMA_VERSION = '1.0.0';

export const OBJECTIVE_OUTPUT_LIMITS = {
  maxShortChars: 300,
  maxTextChars: 1_500,
  maxListItems: 20,
  maxUnits: 30,
  maxResponseBytes: 262_144,
} as const;

const shortText = z.string().min(1).max(OBJECTIVE_OUTPUT_LIMITS.maxShortChars);
const text = z.string().min(1).max(OBJECTIVE_OUTPUT_LIMITS.maxTextChars);
const textList = z.array(text).max(OBJECTIVE_OUTPUT_LIMITS.maxListItems);
const shortList = z.array(shortText).max(OBJECTIVE_OUTPUT_LIMITS.maxListItems);

// ---------------------------------------------------------------------------
// Decomposer
// ---------------------------------------------------------------------------

export const decomposerUnitSchema = z.object({
  /** Proposal-local id ("a", "b", …); SpecBridge assigns the real ids. */
  id: shortText,
  kind: z.enum(WORK_UNIT_KINDS),
  title: text,
  goal: text,
  dependsOn: shortList.default([]),
  expectedArtifacts: textList.default([]),
  relevantContractIds: shortList.default([]),
  expectedAreas: shortList.default([]),
});
export type DecomposerUnit = z.infer<typeof decomposerUnitSchema>;

export const decomposerOutputSchema = z.object({
  decision: z.enum(['WORK_GRAPH', 'SINGLE_UNIT', 'ESCALATE']),
  /** Why this decomposition (bounded, factual). */
  reason: text,
  units: z.array(decomposerUnitSchema).max(OBJECTIVE_OUTPUT_LIMITS.maxUnits).default([]),
  escalationReason: text.optional(),
});
export type DecomposerOutput = z.infer<typeof decomposerOutputSchema>;

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const evaluatorOutputSchema = z.object({
  verdict: z.enum(EVALUATION_VERDICTS),
  /** Specific, factual reasons tied to the candidate and the contracts. */
  reasons: textList.default([]),
  /** Evidence references: file paths, test names, contract requirement ids. */
  evidenceRefs: shortList.default([]),
  affectedContractIds: shortList.default([]),
  /**
   * For CONFLICT / NEEDS_DECISION: which decision kind this is, in the
   * job decision vocabulary ("implementation-detail", "public-api-change",
   * "architecture-contract-change", "product-behavior-change", …). The
   * deterministic authority table routes it; the evaluator only names it.
   */
  decisionKind: shortText.optional(),
});
export type EvaluatorOutput = z.infer<typeof evaluatorOutputSchema>;

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export const aggregatorOutputSchema = z.object({
  /** One bounded synthesis of the input artifacts. */
  synthesis: text,
  /** Structured findings, each tied to its source artifact. */
  findings: z
    .array(
      z.object({
        sourceWorkUnitId: shortText,
        finding: text,
      }),
    )
    .max(OBJECTIVE_OUTPUT_LIMITS.maxListItems)
    .default([]),
  /** A recommendation (data). Approving it stays a human decision. */
  recommendation: text.optional(),
  /** Contract changes the synthesis suggests — requests, never approvals. */
  contractChangeSuggestions: z
    .array(
      z.object({
        contractId: shortText,
        problem: text,
        proposal: text,
      }),
    )
    .max(10)
    .default([]),
  conflictsDetected: z
    .array(
      z.object({
        contractId: shortText,
        claims: z.array(z.object({ sourceWorkUnitId: shortText, claim: text })).min(1).max(10),
      }),
    )
    .max(10)
    .default([]),
});
export type AggregatorOutput = z.infer<typeof aggregatorOutputSchema>;

// ---------------------------------------------------------------------------
// Builder (the structured claim returned from an isolated worktree)
// ---------------------------------------------------------------------------

export const builderOutputSchema = z.object({
  outcome: z.enum(['CANDIDATE_COMPLETE', 'BLOCKED', 'FAILED']),
  summary: text,
  /** Files the builder believes it changed (a claim; git is the evidence). */
  changedFiles: shortList.default([]),
  assumptionsDiscovered: textList.default([]),
  contractChangeRequests: z
    .array(
      z.object({
        contractId: shortText,
        problem: text,
        proposal: text,
      }),
    )
    .max(10)
    .default([]),
  knownLimitations: textList.default([]),
  /** Investigation units: the structured report body. */
  report: z.string().min(1).max(16_000).optional(),
  blockingQuestions: textList.default([]),
});
export type BuilderOutput = z.infer<typeof builderOutputSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ObjectiveContractRole = 'DECOMPOSER' | 'EVALUATOR' | 'AGGREGATOR' | 'BUILDER';

const SCHEMAS: Record<ObjectiveContractRole, z.ZodTypeAny> = {
  DECOMPOSER: decomposerOutputSchema,
  EVALUATOR: evaluatorOutputSchema,
  AGGREGATOR: aggregatorOutputSchema,
  BUILDER: builderOutputSchema,
};

export type ObjectiveOutputFor<Role extends ObjectiveContractRole> = Role extends 'DECOMPOSER'
  ? DecomposerOutput
  : Role extends 'EVALUATOR'
    ? EvaluatorOutput
    : Role extends 'AGGREGATOR'
      ? AggregatorOutput
      : BuilderOutput;

export type ObjectiveOutputValidation<Role extends ObjectiveContractRole> =
  | { ok: true; output: ObjectiveOutputFor<Role> }
  | { ok: false; problem: string };

/**
 * Validate one COMPLETE model response against an objective-role contract.
 * Exactly one JSON document; no substring extraction, no silent repair.
 */
/** Any run of whitespace, so a refused response reads as one line. */
const WHITESPACE_RUN = /\s+/g;

/** How much of a refused response is worth keeping on the record. */
export const OBJECTIVE_OBSERVED_EXCERPT_CHARS = 600;

/** A single-line, bounded excerpt of what a worker actually returned. */
export function observedObjectiveOutput(text: string): string {
  const flattened = text.replace(WHITESPACE_RUN, ' ').trim();
  if (flattened.length === 0) return '(nothing at all)';
  return flattened.slice(0, OBJECTIVE_OBSERVED_EXCERPT_CHARS);
}

export function validateObjectiveOutput<Role extends ObjectiveContractRole>(
  role: Role,
  responseText: string,
): ObjectiveOutputValidation<Role> {
  if (Buffer.byteLength(responseText, 'utf8') > OBJECTIVE_OUTPUT_LIMITS.maxResponseBytes) {
    return { ok: false, problem: `the response exceeds ${OBJECTIVE_OUTPUT_LIMITS.maxResponseBytes} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText.trim());
  } catch {
    // Say what was actually returned.
    //
    // "the response is not a single valid JSON document" is technically true
    // and the least useful sentence available. The vNext.10.1 dogfood lost a
    // work unit to it three times over: the builder finished in nineteen
    // seconds, the record kept nothing, and neither a person nor the runtime
    // could tell an expired credential from a rate limit from a model that
    // wrapped its JSON in prose. The task driver already carries the observed
    // text for exactly this reason; the objective path did not.
    return {
      ok: false,
      problem:
        'the response is not a single valid JSON document. The worker returned: ' +
        observedObjectiveOutput(responseText),
    };
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
  return { ok: true, output: result.data as ObjectiveOutputFor<Role> };
}

// ---------------------------------------------------------------------------
// JSON Schemas (constrained decoding)
// ---------------------------------------------------------------------------

const stringItem = (maxLength: number): Record<string, unknown> => ({
  type: 'string',
  minLength: 1,
  maxLength,
});

const textListJson = {
  type: 'array',
  maxItems: OBJECTIVE_OUTPUT_LIMITS.maxListItems,
  items: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
} as const;

const shortListJson = {
  type: 'array',
  maxItems: OBJECTIVE_OUTPUT_LIMITS.maxListItems,
  items: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxShortChars),
} as const;

export const OBJECTIVE_OUTPUT_JSON_SCHEMAS: Record<ObjectiveContractRole, Record<string, unknown>> = {
  DECOMPOSER: {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'reason'],
    properties: {
      decision: { type: 'string', enum: ['WORK_GRAPH', 'SINGLE_UNIT', 'ESCALATE'] },
      reason: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
      units: {
        type: 'array',
        maxItems: OBJECTIVE_OUTPUT_LIMITS.maxUnits,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'kind', 'title', 'goal'],
          properties: {
            id: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxShortChars),
            kind: { type: 'string', enum: [...WORK_UNIT_KINDS] },
            title: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
            goal: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
            dependsOn: shortListJson,
            expectedArtifacts: textListJson,
            relevantContractIds: shortListJson,
            expectedAreas: shortListJson,
          },
        },
      },
      escalationReason: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
    },
  },
  EVALUATOR: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict'],
    properties: {
      verdict: { type: 'string', enum: [...EVALUATION_VERDICTS] },
      reasons: textListJson,
      evidenceRefs: shortListJson,
      affectedContractIds: shortListJson,
      decisionKind: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxShortChars),
    },
  },
  AGGREGATOR: {
    type: 'object',
    additionalProperties: false,
    required: ['synthesis'],
    properties: {
      synthesis: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
      findings: {
        type: 'array',
        maxItems: OBJECTIVE_OUTPUT_LIMITS.maxListItems,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceWorkUnitId', 'finding'],
          properties: {
            sourceWorkUnitId: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxShortChars),
            finding: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
          },
        },
      },
      recommendation: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
      contractChangeSuggestions: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['contractId', 'problem', 'proposal'],
          properties: {
            contractId: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxShortChars),
            problem: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
            proposal: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
          },
        },
      },
      conflictsDetected: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['contractId', 'claims'],
          properties: {
            contractId: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxShortChars),
            claims: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sourceWorkUnitId', 'claim'],
                properties: {
                  sourceWorkUnitId: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxShortChars),
                  claim: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
                },
              },
            },
          },
        },
      },
    },
  },
  BUILDER: {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'summary'],
    properties: {
      outcome: { type: 'string', enum: ['CANDIDATE_COMPLETE', 'BLOCKED', 'FAILED'] },
      summary: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
      changedFiles: shortListJson,
      assumptionsDiscovered: textListJson,
      contractChangeRequests: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['contractId', 'problem', 'proposal'],
          properties: {
            contractId: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxShortChars),
            problem: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
            proposal: stringItem(OBJECTIVE_OUTPUT_LIMITS.maxTextChars),
          },
        },
      },
      knownLimitations: textListJson,
      report: { type: 'string', minLength: 1, maxLength: 16_000 },
      blockingQuestions: textListJson,
    },
  },
};
