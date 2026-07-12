import { z } from 'zod';

/**
 * Structured runner output contracts.
 *
 * A runner (Claude Code, mock, …) must end every stage-generation or
 * task-execution run with a JSON document matching these schemas. Everything
 * a model *reports* here is treated as an unverified claim: SpecBridge
 * compares claims against actual Git and process evidence and never marks a
 * task complete from this data alone.
 *
 * Both a Zod schema (for validation) and a plain JSON Schema (for runners
 * that support schema-constrained output) are exported. Keep them in sync.
 */

export const RUNNER_OUTPUT_SCHEMA_VERSION = '1.0.0';

const schemaVersionField = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .default(RUNNER_OUTPUT_SCHEMA_VERSION);

/** Model-reported outcome vocabulary (a subset of ExecutionOutcome). */
export const REPORTED_OUTCOMES = ['completed', 'blocked', 'failed', 'no-change'] as const;
export type ReportedOutcome = (typeof REPORTED_OUTCOMES)[number];

export const reportedTestSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped']),
});
export type ReportedTest = z.infer<typeof reportedTestSchema>;

/**
 * The structured result a runner returns for one task execution.
 * `changedFiles`, `commandsReported`, and `testsReported` are informational
 * claims only — actual evidence comes from Git snapshots and trusted
 * verification commands.
 */
export const taskRunnerReportSchema = z
  .object({
    schemaVersion: schemaVersionField,
    outcome: z.enum(REPORTED_OUTCOMES),
    summary: z.string().min(1),
    changedFiles: z.array(z.string()).default([]),
    commandsReported: z.array(z.string()).default([]),
    testsReported: z.array(reportedTestSchema).default([]),
    remainingRisks: z.array(z.string()).default([]),
    blockingQuestions: z.array(z.string()).default([]),
    recommendedNextActions: z.array(z.string()).default([]),
  })
  .strict();
export type TaskRunnerReport = z.infer<typeof taskRunnerReportSchema>;

/** The structured result a runner returns for one stage generation/refinement. */
export const stageRunnerReportSchema = z
  .object({
    schemaVersion: schemaVersionField,
    stage: z.enum(['requirements', 'bugfix', 'design', 'tasks']),
    markdown: z.string().min(1),
    summary: z.string().min(1),
    assumptions: z.array(z.string()).default([]),
    openQuestions: z.array(z.string()).default([]),
    /** Workspace-relative paths the model consulted. Validated before use. */
    referencedFiles: z.array(z.string()).default([]),
  })
  .strict();
export type StageRunnerReport = z.infer<typeof stageRunnerReportSchema>;

/**
 * JSON Schema equivalents, passed to runners that can constrain their final
 * output (e.g. `claude --json-schema`). Kept as plain data so no runner ever
 * needs Zod at runtime.
 */
export const TASK_RUNNER_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'outcome', 'summary'],
  properties: {
    schemaVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    outcome: { type: 'string', enum: [...REPORTED_OUTCOMES] },
    summary: { type: 'string', minLength: 1 },
    changedFiles: { type: 'array', items: { type: 'string' } },
    commandsReported: { type: 'array', items: { type: 'string' } },
    testsReported: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status'],
        properties: {
          name: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
        },
      },
    },
    remainingRisks: { type: 'array', items: { type: 'string' } },
    blockingQuestions: { type: 'array', items: { type: 'string' } },
    recommendedNextActions: { type: 'array', items: { type: 'string' } },
  },
};

export const STAGE_RUNNER_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'stage', 'markdown', 'summary'],
  properties: {
    schemaVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    stage: { type: 'string', enum: ['requirements', 'bugfix', 'design', 'tasks'] },
    markdown: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    referencedFiles: { type: 'array', items: { type: 'string' } },
  },
};

export type RunnerReportParseFailure = {
  ok: false;
  /** Human-readable explanation, safe to show in terminal output. */
  reason: string;
};

/**
 * Extract and validate a task report from raw model text. Accepts either a
 * bare JSON document or the last fenced ```json block. Never guesses at
 * malformed fields — a parse failure is reported, not repaired.
 */
export function parseTaskRunnerReport(
  raw: string,
): { ok: true; report: TaskRunnerReport } | RunnerReportParseFailure {
  return parseReport(raw, taskRunnerReportSchema);
}

export function parseStageRunnerReport(
  raw: string,
): { ok: true; report: StageRunnerReport } | RunnerReportParseFailure {
  return parseReport(raw, stageRunnerReportSchema);
}

function parseReport<S extends z.ZodTypeAny>(
  raw: string,
  schema: S,
): { ok: true; report: z.infer<S> } | RunnerReportParseFailure {
  const candidate = extractJsonCandidate(raw);
  if (candidate === undefined) {
    return { ok: false, reason: 'no JSON document found in the runner output' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (cause) {
    return {
      ok: false,
      reason: `runner output is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `runner output does not match the report schema: ${issues}` };
  }
  return { ok: true, report: result.data as z.infer<S> };
}

const FENCED_JSON = /```(?:json)?\s*\n([\s\S]*?)```/g;

/**
 * Find the JSON document in raw model text: the whole string if it parses
 * as JSON after trimming, otherwise the *last* fenced code block.
 */
export function extractJsonCandidate(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  let lastBlock: string | undefined;
  for (const match of trimmed.matchAll(FENCED_JSON)) {
    if (match[1] !== undefined) lastBlock = match[1].trim();
  }
  return lastBlock;
}
