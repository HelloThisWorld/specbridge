import type { ContextExpansionLevel } from './vocabulary.js';

/**
 * The retrieval query: what SpecBridge asks the index for, built ONLY from
 * durable state.
 *
 * The inputs are the task contract, the acceptance criteria, the current
 * action, the latest failure, the recovery decision, and the changed files —
 * all of them records that already exist, are already reviewable, and are
 * already the things a resumed job reconstructs itself from. Nothing here
 * reads a conversation, a transcript, or a model's private reasoning: a
 * query grounded in free-form chat would drift with the conversation and
 * would be unreproducible across a restart, which is exactly the property
 * the rest of this runtime is built to avoid.
 *
 * Two kinds of signal, kept strictly apart:
 *
 *   REFERENCES   literal paths and symbols that durable state NAMES. These
 *                are facts, and the ones that are mandatory can never be
 *                lost to a ranking score.
 *   TOKENS       lexical material for similarity. These are hints, and
 *                losing one costs nothing.
 */

export interface ContextRetrievalQuery {
  taskId: string;
  nodeId?: string | undefined;
  attemptId?: string | undefined;
  /** The role the package is being built for; shapes profile weighting. */
  role: RetrievalRole;
  /** Bounded objective/contract text (used for token overlap only). */
  objective: string;
  /** Paths the approved contract, plan, or criteria name literally. */
  contractPaths: string[];
  /** Paths the current failure names literally (stack frames, verifier output). */
  failurePaths: string[];
  /** Paths the current action or recovery decision names literally. */
  actionPaths: string[];
  /** Paths currently changed in the working tree. */
  changedPaths: string[];
  /** Paths the durable checkpoint records this task as having touched. */
  checkpointChangedPaths: string[];
  /** Paths selected on a previous attempt for this task. */
  priorRelevantPaths: string[];
  /** Symbols named by the contract, the failure, or the action. */
  symbols: string[];
  /** Lexical tokens for filename/path overlap. */
  tokens: string[];
  /**
   * Line citations by path, from stack frames and compiler output. Used to
   * centre a section on the line that actually failed rather than shipping
   * a whole large file.
   */
  lineHints: Record<string, number[]>;
  /** Deterministic failure identity, when the query follows a failure. */
  failureFingerprint?: string | undefined;
  /** How wide retrieval is currently allowed to go. */
  expansionLevel: ContextExpansionLevel;
}

/**
 * Which agent role the package is for.
 *
 * Roles get DIFFERENT context, not the same package at different sizes: a
 * diagnoser needs the failure and the code around it, a replanner needs the
 * contract and the strategy history, an evaluator needs the contract and the
 * diff. Feeding all three an executor package is how a runtime ends up
 * paying implementation-sized context for a planning question.
 */
export const RETRIEVAL_ROLES = [
  'EXECUTOR',
  'DIAGNOSER',
  'REPLANNER',
  'EVALUATOR',
  'PLANNER',
  'CRITIC',
] as const;
export type RetrievalRole = (typeof RETRIEVAL_ROLES)[number];

export const RETRIEVAL_QUERY_LIMITS = {
  maxPathsPerBucket: 60,
  maxSymbols: 40,
  maxTokens: 48,
  maxObjectiveChars: 4_000,
  maxScannedTextChars: 60_000,
} as const;

/**
 * Path-shaped references inside prose.
 *
 * Requires a directory separator or a known source extension, so ordinary
 * English never produces a "path". A trailing `:line[:column]` is accepted
 * and stripped — stack traces and compiler output are the single richest
 * source of exact references this runtime has.
 */
const PATH_PATTERN =
  /(?:^|[\s('"`[<])((?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,10}|[\w.@-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|scala|c|h|cc|cpp|hpp|sql|sh|ps1|vue|svelte|md|json|ya?ml|toml))(?::(\d+))?(?::(\d+))?(?=$|[\s)'"`\]>,;:.!?])/g;

/** Backticked identifiers and CamelCase words: conservative symbol evidence. */
const BACKTICK_SYMBOL_PATTERN = /`([A-Za-z_$][\w$.]{2,80})`/g;
const CAMEL_SYMBOL_PATTERN = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g;
const STACK_FRAME_SYMBOL_PATTERN = /\bat\s+(?:new\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;

const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'must', 'should', 'when', 'then',
  'test', 'tests', 'src', 'lib', 'index', 'main', 'new', 'add', 'fix', 'use', 'not', 'all', 'any',
  'task', 'file', 'files', 'code', 'error', 'failed', 'failure', 'expected', 'received', 'value',
]);

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .trim();
}

/** One literal path reference, with the line it was cited at when there was one. */
export interface PathReference {
  path: string;
  /** 1-based line from a `path:line[:col]` citation (a stack frame, a compiler). */
  line?: number | undefined;
}

/**
 * Extract literal repository path references from bounded durable text,
 * preserving any `:line` citation.
 *
 * The line is worth keeping: it is the difference between "include this
 * 3,000-line file" and "include the declaration around line 412", which is
 * the single highest-value section hint this runtime ever gets for free.
 */
export function extractPathReferencesWithLines(text: string): PathReference[] {
  const bounded = text.slice(0, RETRIEVAL_QUERY_LIMITS.maxScannedTextChars);
  const found: PathReference[] = [];
  PATH_PATTERN.lastIndex = 0;
  let match = PATH_PATTERN.exec(bounded);
  while (match !== null && found.length < RETRIEVAL_QUERY_LIMITS.maxPathsPerBucket * 4) {
    const candidate = normalizePath(match[1] ?? '');
    const line = match[2] === undefined ? undefined : Number(match[2]);
    if (candidate !== '' && !candidate.startsWith('..')) {
      const existing = found.find((entry) => entry.path === candidate);
      if (existing === undefined) {
        found.push({ path: candidate, ...(line !== undefined && Number.isFinite(line) ? { line } : {}) });
      } else if (existing.line === undefined && line !== undefined && Number.isFinite(line)) {
        existing.line = line;
      }
    }
    match = PATH_PATTERN.exec(bounded);
  }
  return found;
}

/** Extract literal repository paths from bounded durable text. */
export function extractPathReferences(text: string): string[] {
  return extractPathReferencesWithLines(text).map((reference) => reference.path);
}

/** Extract conservative symbol references from bounded durable text. */
export function extractSymbolReferences(text: string): string[] {
  const bounded = text.slice(0, RETRIEVAL_QUERY_LIMITS.maxScannedTextChars);
  const found = new Set<string>();
  for (const pattern of [BACKTICK_SYMBOL_PATTERN, STACK_FRAME_SYMBOL_PATTERN, CAMEL_SYMBOL_PATTERN]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(bounded);
    while (match !== null && found.size < RETRIEVAL_QUERY_LIMITS.maxSymbols) {
      const raw = (match[1] ?? '').trim();
      // A dotted reference contributes its leaf: `FooService.load` is
      // evidence about FooService and about load, and the index stores
      // declarations, not call chains.
      for (const part of raw.split('.')) {
        if (part.length >= 3 && part.length <= 80 && !/^\d+$/.test(part)) found.add(part);
      }
      match = pattern.exec(bounded);
    }
  }
  return [...found].slice(0, RETRIEVAL_QUERY_LIMITS.maxSymbols);
}

/** Lowercased lexical tokens for filename/path overlap scoring. */
export function extractTokens(text: string): string[] {
  const bounded = text.slice(0, RETRIEVAL_QUERY_LIMITS.maxScannedTextChars);
  const tokens = new Set<string>();
  for (const raw of bounded.split(/[^A-Za-z0-9]+/)) {
    if (raw.length < 3 || raw.length > 40) continue;
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const token = part.toLowerCase();
      if (token.length < 3 || STOP_TOKENS.has(token)) continue;
      tokens.add(token);
      if (tokens.size >= RETRIEVAL_QUERY_LIMITS.maxTokens) return [...tokens];
    }
  }
  return [...tokens];
}

export interface RetrievalQueryInput {
  taskId: string;
  nodeId?: string | undefined;
  attemptId?: string | undefined;
  role: RetrievalRole;
  /** Approved task contract text. */
  contract?: string | undefined;
  /** Task objective from the durable checkpoint. */
  objective?: string | undefined;
  acceptanceCriteria?: readonly string[] | undefined;
  /** Bounded text of the current action / next actions. */
  currentAction?: string | undefined;
  /** Bounded text of the latest failure (message, verifier output summary). */
  failureText?: string | undefined;
  failureFingerprint?: string | undefined;
  /** Bounded text of the current recovery decision, when one applies. */
  recoveryText?: string | undefined;
  /** Working-tree changed paths from the Git snapshot. */
  changedPaths?: readonly string[] | undefined;
  /** Changed paths recorded on the durable checkpoint. */
  checkpointChangedPaths?: readonly string[] | undefined;
  /** Paths selected for this task on a previous attempt. */
  priorRelevantPaths?: readonly string[] | undefined;
  expansionLevel?: ContextExpansionLevel | undefined;
}

function bounded(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalizePath).filter((value) => value !== ''))].slice(
    0,
    RETRIEVAL_QUERY_LIMITS.maxPathsPerBucket,
  );
}

/**
 * Build the retrieval query from durable task state.
 *
 * Pure and deterministic: the same records produce the same query, which is
 * what makes `ContextSelectionPlan` replayable and what lets a test assert
 * that a failure naming `src/foo.ts` retrieves `src/foo.ts` rather than
 * asserting that a score came out higher.
 */
export function buildRetrievalQuery(input: RetrievalQueryInput): ContextRetrievalQuery {
  const contractText = [input.contract ?? '', ...(input.acceptanceCriteria ?? [])].join('\n');
  const actionText = [input.currentAction ?? '', input.recoveryText ?? ''].join('\n');
  const failureText = input.failureText ?? '';
  const objective = (input.objective ?? input.contract ?? '').slice(
    0,
    RETRIEVAL_QUERY_LIMITS.maxObjectiveChars,
  );

  const symbols = [
    ...new Set([
      ...extractSymbolReferences(failureText),
      ...extractSymbolReferences(contractText),
      ...extractSymbolReferences(actionText),
    ]),
  ].slice(0, RETRIEVAL_QUERY_LIMITS.maxSymbols);

  const tokens = [
    ...new Set([
      ...extractTokens(objective),
      ...extractTokens(actionText),
      ...extractTokens(failureText),
    ]),
  ].slice(0, RETRIEVAL_QUERY_LIMITS.maxTokens);

  const lineHints: Record<string, number[]> = {};
  for (const reference of [
    ...extractPathReferencesWithLines(failureText),
    ...extractPathReferencesWithLines(actionText),
  ]) {
    if (reference.line === undefined) continue;
    const bucket = lineHints[reference.path];
    if (bucket === undefined) lineHints[reference.path] = [reference.line];
    else if (!bucket.includes(reference.line)) bucket.push(reference.line);
  }

  return {
    taskId: input.taskId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    role: input.role,
    objective,
    contractPaths: bounded(extractPathReferences(contractText)),
    failurePaths: bounded(extractPathReferences(failureText)),
    actionPaths: bounded(extractPathReferences(actionText)),
    lineHints,
    changedPaths: bounded(input.changedPaths),
    checkpointChangedPaths: bounded(input.checkpointChangedPaths),
    priorRelevantPaths: bounded(input.priorRelevantPaths),
    symbols,
    tokens,
    failureFingerprint: input.failureFingerprint,
    expansionLevel: input.expansionLevel ?? 'TOP_WORKING_SET',
  };
}
