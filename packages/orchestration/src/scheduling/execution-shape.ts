import type { ComplexityClass } from '../jobs/vocabulary.js';
import type { LocalExecutionShape } from './vocabulary.js';

/**
 * Deterministic execution-SHAPE classification (vNext.4).
 *
 * Answers one question, and only this one:
 *
 *   Does this work need an autonomous tool loop (explore → edit → run →
 *   read → repair), or can a single bounded request complete it?
 *
 * It says nothing about difficulty. `classifyLocalSuitability` already
 * answers "can local intelligence attempt this at all?" and its answer is
 * NOT reused as a shape signal: collapsing the two would recreate the exact
 * conflation this phase exists to remove (LOCAL_SAFE would silently mean
 * one-shot, and every hard task would look agentic).
 *
 * Same rules as every other routing classifier here: pure, deterministic,
 * table-driven, and never produced by a model. Editing these tables changes
 * routing policy and is test-visible.
 */

export interface ExecutionShapeInput {
  taskId: string;
  title: string;
  /** Coarse category from the suitability classifier (data, not a verdict). */
  taskCategory?: string | undefined;
  complexity: ComplexityClass | undefined;
  /** Bounded related requirement/design excerpt, when available. */
  relatedSpecText?: string | undefined;
  /**
   * A prior LOCAL DIRECT attempt failed in a way that indicates missing
   * repository knowledge (the durable escalation record, not a guess).
   * Reading a repository is exactly what an agentic run adds.
   */
  priorDirectFailureNeedsRepository?: boolean | undefined;
}

export interface ExecutionShapeSignal {
  signal: string;
  evidence: string;
}

export interface ExecutionShapeAssessment {
  shape: LocalExecutionShape;
  signals: ExecutionShapeSignal[];
}

/**
 * Categories whose work is a bounded transformation by construction: the
 * input is handed over, the output is a document or a small edit, and no
 * repository search or test loop is implied.
 */
const ONE_SHOT_CATEGORIES: readonly string[] = [
  'summarization',
  'log-processing',
  'classification',
  'ranking',
  'extraction',
  'compression',
  'duplicate-detection',
  'reporting',
  'documentation',
  'config-change',
  'data-object',
];

/**
 * Work that requires the repository itself to answer the question. Ordered:
 * the first match wins, and each names WHY tools are needed.
 */
const AGENTIC_PATTERNS: readonly { signal: string; pattern: RegExp }[] = [
  {
    signal: 'repository-exploration',
    pattern: /\b(explore|investigate|locate|find (?:the|where|all)|search (?:the|for)|audit|trace|identify (?:the|all|where))\b/i,
  },
  {
    signal: 'unknown-implementation-site',
    pattern: /\b(wherever|throughout|call ?sites?|every (?:usage|caller|reference)|all (?:usages|callers|references|occurrences))\b/i,
  },
  {
    signal: 'multi-file-change',
    pattern: /\b(across (?:the|all|several|multiple)|multiple files|several files|multi-file|each (?:module|package|component)|end-to-end|wire (?:up|together)|integrate\w*)\b/i,
  },
  {
    signal: 'expected-test-loop',
    pattern: /\b(make [\w\s]{0,40}?tests? pass|fix [\w\s]{0,40}?(?:failing|broken)[\w\s]{0,20}?(?:tests?|specs?|suite)|until [\w\s]{0,20}?tests? pass|run (?:the )?tests? and|debug\w*|reproduce)\b/i,
  },
  {
    signal: 'iterative-repair',
    pattern: /\b(root cause|regression|flaky|failing (?:build|suite|check)|diagnose)\b/i,
  },
  {
    signal: 'shell-interaction',
    pattern: /\b(run (?:the )?(?:build|script|command|migration)|execute (?:the )?(?:build|script)|benchmark)\b/i,
  },
  {
    signal: 'multi-step-implementation',
    pattern: /\b(migrat\w+|refactor\w* (?:the )?(?:module|package|architecture|layer)|port (?:the|all)|rewrite)\b/i,
  },
];

/**
 * One-shot markers strong enough to survive a weak agentic keyword: an
 * explicitly named single target with an explicitly bounded change.
 */
const ONE_SHOT_PATTERNS: readonly { signal: string; pattern: RegExp }[] = [
  { signal: 'named-single-file', pattern: /\bin `?[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|md|json|ya?ml)`?\b/i },
  { signal: 'single-symbol-change', pattern: /\b(add|update|change|set|bump|rename) (?:the )?(?:constant|value|field|flag|option|default|version|comment|docstring)\b/i },
  { signal: 'bounded-transformation', pattern: /\b(summari[sz]e|compress|condense|extract|classify|rank|list|document)\b/i },
];

/**
 * Classify one unit of work. Precedence, most decisive first:
 *
 *   1. a durable "the direct attempt lacked repository knowledge" record —
 *      evidence beats every keyword table
 *   2. an explicit agentic pattern in the title
 *   3. a one-shot CATEGORY (the suitability classifier already matched a
 *      bounded-transformation table against the title)
 *   4. an explicit one-shot pattern
 *   5. complexity: MEDIUM+ work with no bounded-transformation signal is
 *      treated as agentic — an unbounded change with an unknown site is the
 *      case tools help most
 *   6. otherwise ONE_SHOT (the conservative default: it keeps the vNext.2
 *      path, and a wrong guess costs one cheap local attempt, not money)
 *
 * Spec text is consulted ONLY for agentic patterns, never to make work look
 * one-shot: one "summarize" anywhere in a shared requirements document must
 * not turn a repository-wide change into a single request.
 */
export function classifyLocalExecutionShape(
  input: ExecutionShapeInput,
): ExecutionShapeAssessment {
  const signals: ExecutionShapeSignal[] = [];
  const title = input.title;
  const wider = `${input.title}\n${input.relatedSpecText ?? ''}`;

  if (input.priorDirectFailureNeedsRepository === true) {
    signals.push({
      signal: 'prior-direct-failure-needs-repository',
      evidence: 'a recorded direct attempt failed for lack of repository knowledge',
    });
    return { shape: 'AGENTIC', signals };
  }

  for (const entry of AGENTIC_PATTERNS) {
    const match = title.match(entry.pattern) ?? wider.match(entry.pattern);
    if (match !== null) {
      signals.push({
        signal: `agentic:${entry.signal}`,
        evidence: `matched "${(match[0] ?? '').slice(0, 80)}"`,
      });
      return { shape: 'AGENTIC', signals };
    }
  }

  if (input.taskCategory !== undefined && ONE_SHOT_CATEGORIES.includes(input.taskCategory)) {
    signals.push({
      signal: `one-shot:category:${input.taskCategory}`,
      evidence: 'the task category is a bounded transformation',
    });
    return { shape: 'ONE_SHOT', signals };
  }

  for (const entry of ONE_SHOT_PATTERNS) {
    const match = title.match(entry.pattern);
    if (match !== null) {
      signals.push({
        signal: `one-shot:${entry.signal}`,
        evidence: `matched "${(match[0] ?? '').slice(0, 80)}"`,
      });
      return { shape: 'ONE_SHOT', signals };
    }
  }

  if (input.complexity === 'MEDIUM' || input.complexity === 'HIGH') {
    signals.push({
      signal: `agentic:complexity-${input.complexity.toLowerCase()}`,
      evidence: `${input.complexity} complexity with no bounded-transformation signal`,
    });
    return { shape: 'AGENTIC', signals };
  }

  signals.push({
    signal: 'one-shot:default',
    evidence: 'no agentic signal matched; a bounded request is attempted first',
  });
  return { shape: 'ONE_SHOT', signals };
}
