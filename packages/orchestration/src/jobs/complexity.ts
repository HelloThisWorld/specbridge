import type { JobComplexityPolicy } from '@specbridge/core';
import type { ComplexityClass } from './vocabulary.js';

/**
 * Deterministic complexity assessment.
 *
 * The model does not get to decide whether it is capable enough: routing
 * starts from signals a test can replay byte-for-byte. The output class is
 * ROUTING POLICY — which tier attempts the work first — not a claim about
 * intrinsic difficulty, and the signal list is recorded so "why was Claude
 * used here?" always has a structural answer.
 *
 * A local CLASSIFIER role may later *raise* the deterministic class (a
 * cheap second opinion that only errs towards caution); nothing may lower
 * it. That rule lives in the scheduler, not here.
 */

export interface ComplexityInput {
  /** Approved task identity and title. */
  taskId: string;
  title: string;
  /** Requirement references attached to the task (`_Requirements: 1.2_`). */
  requirementRefs: readonly string[];
  /** Number of child tasks (a parent task coordinates more work). */
  childCount: number;
  /**
   * Bounded excerpt of the requirement/design text this task references.
   * Optional: title-only assessment still works, with fewer signals.
   */
  relatedSpecText?: string | undefined;
  /** Failures already observed for this task in this job. */
  previousFailureCount: number;
  /** Replans already consumed by this task in this job. */
  previousReplanCount: number;
}

export interface ComplexitySignal {
  signal: string;
  /** What matched, bounded for the audit record. */
  evidence: string;
  weight: number;
  /** True when this signal alone forces HIGH, whatever the score. */
  forcesHigh: boolean;
}

export interface ComplexityAssessment {
  class: ComplexityClass;
  score: number;
  signals: ComplexitySignal[];
}

/**
 * Keyword classes, deliberately documented data rather than clever
 * heuristics. Word-boundary matched, case-insensitive. Editing this table
 * changes routing policy and is test-visible.
 */
const KEYWORD_SIGNALS: readonly {
  signal: string;
  pattern: RegExp;
  weight: number;
  forcesHigh: boolean;
}[] = [
  {
    signal: 'public-api-impact',
    pattern: /\b(public api|api contract|breaking change|endpoint|public interface|exported)\b/i,
    weight: 3,
    forcesHigh: true,
  },
  {
    signal: 'architecture-impact',
    pattern: /\b(architecture|architectural|redesign|restructure|migration strategy)\b/i,
    weight: 3,
    forcesHigh: true,
  },
  {
    signal: 'security-impact',
    pattern: /\b(security|auth|authentication|authorization|credential|crypto|encryption|permission|token)\b/i,
    weight: 3,
    forcesHigh: true,
  },
  {
    signal: 'distributed-impact',
    pattern: /\b(distributed|consensus|replication|at-least-once|exactly-once|idempoten\w*|partition|eventual consistency)\b/i,
    weight: 3,
    forcesHigh: true,
  },
  {
    signal: 'concurrency-impact',
    pattern: /\b(concurren\w*|race condition|deadlock|mutex|lock-free|parallel|thread)\b/i,
    weight: 2,
    forcesHigh: false,
  },
  {
    signal: 'persistence-impact',
    pattern: /\b(database|schema migration|persistence|storage format|serializ\w*)\b/i,
    weight: 2,
    forcesHigh: false,
  },
  {
    signal: 'new-dependency',
    pattern: /\b(new dependency|add(?:ing)? (?:a |the )?(?:dependency|library|package))\b/i,
    weight: 2,
    forcesHigh: true,
  },
  {
    signal: 'recovery-semantics',
    pattern: /\b(recovery|crash|resume|rollback|retry semantics|failover)\b/i,
    weight: 2,
    forcesHigh: false,
  },
];

/** Assess one task. Pure and deterministic; same input, same output. */
export function assessComplexity(
  input: ComplexityInput,
  policy: JobComplexityPolicy,
): ComplexityAssessment {
  const signals: ComplexitySignal[] = [];

  // Structural breadth signals.
  if (input.requirementRefs.length >= 4) {
    signals.push({
      signal: 'many-requirements',
      evidence: `${input.requirementRefs.length} requirement references`,
      weight: 2,
      forcesHigh: false,
    });
  } else if (input.requirementRefs.length >= 2) {
    signals.push({
      signal: 'several-requirements',
      evidence: `${input.requirementRefs.length} requirement references`,
      weight: 1,
      forcesHigh: false,
    });
  }
  if (input.childCount > 0) {
    signals.push({
      signal: 'parent-task',
      evidence: `${input.childCount} child task(s)`,
      weight: Math.min(input.childCount, 3),
      forcesHigh: false,
    });
  }

  // Keyword classes over the title and any provided spec excerpt.
  const text = `${input.title}\n${input.relatedSpecText ?? ''}`;
  for (const entry of KEYWORD_SIGNALS) {
    const match = text.match(entry.pattern);
    if (match !== null) {
      signals.push({
        signal: entry.signal,
        evidence: `matched "${(match[0] ?? '').slice(0, 80)}"`,
        weight: entry.weight,
        forcesHigh: entry.forcesHigh,
      });
    }
  }

  // History: repeated failure or replanning on this task raises the class —
  // the cheap route already had its chance.
  if (input.previousReplanCount >= 1) {
    signals.push({
      signal: 'previous-replans',
      evidence: `${input.previousReplanCount} replan(s) already consumed`,
      weight: 2 * input.previousReplanCount,
      forcesHigh: input.previousReplanCount >= 2,
    });
  }
  if (input.previousFailureCount >= 2) {
    signals.push({
      signal: 'repeated-failures',
      evidence: `${input.previousFailureCount} failures observed`,
      weight: input.previousFailureCount,
      forcesHigh: false,
    });
  }

  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const forcedHigh = signals.some((signal) => signal.forcesHigh);
  const cls: ComplexityClass =
    forcedHigh || score >= policy.highScore
      ? 'HIGH'
      : score >= policy.mediumScore
        ? 'MEDIUM'
        : 'LOW';

  return { class: cls, score, signals };
}

/** Order for comparisons: may a submitted class LOWER the assessed one? No. */
const CLASS_ORDER: Record<ComplexityClass, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Merge the deterministic assessment with a classifier's proposal. The
 * proposal may only raise the class — a model talking the router into the
 * cheap tier is exactly the failure mode this exists to prevent.
 */
export function mergeComplexity(
  deterministic: ComplexityClass,
  proposed: ComplexityClass | undefined,
): ComplexityClass {
  if (proposed === undefined) return deterministic;
  return CLASS_ORDER[proposed] > CLASS_ORDER[deterministic] ? proposed : deterministic;
}
