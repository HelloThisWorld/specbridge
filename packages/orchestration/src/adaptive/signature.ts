import type { ComplexityClass } from '../jobs/vocabulary.js';
import type { LocalExecutionShape, LocalSuitabilityClass } from '../scheduling/vocabulary.js';
import type { ExecutionHealth } from '../reliability/vocabulary.js';
import type {
  ContextSizeClass,
  RepositorySizeClass,
  VerificationStrength,
} from './vocabulary.js';

/**
 * TaskSignature (vNext.8): the deterministic grouping key that makes
 * historical data comparable.
 *
 * The whole value of an execution ledger depends on being able to say "tasks
 * LIKE this one". Two failure modes bracket the design:
 *
 *   too specific  every task becomes its own bucket, every bucket has one
 *                 sample, and nothing is ever learned. An exact task-text
 *                 hash plus file names plus a timestamp is the canonical
 *                 example, and is deliberately impossible to build here.
 *   too coarse    unlike work is averaged together and the resulting number
 *                 describes nothing real.
 *
 * The resolution is two layers, kept strictly apart:
 *
 *   the KEY       a small set of coarse, durable, deterministic dimensions.
 *                 This is what profiles are keyed by and what statistics
 *                 accumulate against.
 *   the FEATURES  finer-grained observations about THIS task right now.
 *                 Recorded for auditability and future refinement, and
 *                 deliberately NOT part of the grouping key — a task that
 *                 fails twice must not silently move to a different bucket
 *                 because its failure class changed.
 *
 * Everything here is derived from structural classification SpecBridge
 * already performs. Nothing is read from repository text as an instruction,
 * nothing comes from model output, and no chain-of-thought is representable:
 * a repository that contains the words "always use the API" contributes
 * exactly one thing to this file, which is a task category from the same
 * word-boundary tables vNext.2 has always used.
 */

export interface TaskSignatureFeatures {
  /** Estimated files the task touches, when the graph knows. Null otherwise. */
  estimatedFilesTouched: number | null;
  /** The work spans more than one module/package. */
  multiModule: boolean;
  /** The work changes architecture-level structure. */
  architectureSensitive: boolean;
  /** The work touches security-relevant surface. */
  securitySensitive: boolean;
  /** The work performs a data/schema migration. */
  migration: boolean;
  /** Expected verification loop class: NONE / SINGLE / ITERATIVE. */
  expectedTestLoopClass: 'NONE' | 'SINGLE' | 'ITERATIVE';
  /** Current reliability health of the task, when the task has history. */
  failureClass: ExecutionHealth | null;
  /** Dependents currently blocked on this task (graph-derived). */
  blockedDependents: number;
  /** The task sits on the job's critical path (graph-derived). */
  criticalPath: boolean;
}

export interface TaskSignature {
  /**
   * The grouping key: `category|complexity|suitability|shape|verification`.
   *
   * Readable on purpose rather than hashed — a profile a human cannot read
   * is a profile a human cannot audit, and every diagnostic in this phase
   * prints these keys.
   */
  key: string;
  /** Coarse task category from the vNext.2 suitability classifier. */
  category: string;
  complexity: ComplexityClass;
  localSuitability: LocalSuitabilityClass;
  executionShape: LocalExecutionShape;
  verification: VerificationStrength;
  /** Coarse buckets carried for diagnostics and coarser-level keys. */
  repositorySize: RepositorySizeClass;
  contextSize: ContextSizeClass;
  features: TaskSignatureFeatures;
}

export interface BuildTaskSignatureInput {
  category: string;
  complexity: ComplexityClass;
  localSuitability: LocalSuitabilityClass;
  executionShape: LocalExecutionShape;
  deterministicVerificationAvailable: boolean;
  /** Indexed repository files, when a repository index exists. */
  indexedFiles?: number | null | undefined;
  /** Expected context tokens for the task, when estimable. */
  expectedContextTokens?: number | null | undefined;
  features?: Partial<TaskSignatureFeatures> | undefined;
}

/**
 * Repository-size buckets. Wide on purpose: the question a profile answers
 * is "does this codebase's scale change how a model performs", and that
 * changes at orders of magnitude, not at file counts.
 */
export function repositorySizeClass(indexedFiles: number | null | undefined): RepositorySizeClass {
  if (indexedFiles === null || indexedFiles === undefined || !Number.isFinite(indexedFiles)) {
    return 'UNKNOWN';
  }
  if (indexedFiles < 250) return 'SMALL';
  if (indexedFiles < 2_500) return 'MEDIUM';
  return 'LARGE';
}

/** Context-size buckets, on the same reasoning as repository size. */
export function contextSizeClass(expectedTokens: number | null | undefined): ContextSizeClass {
  if (expectedTokens === null || expectedTokens === undefined || !Number.isFinite(expectedTokens)) {
    return 'UNKNOWN';
  }
  if (expectedTokens < 30_000) return 'SMALL';
  if (expectedTokens < 120_000) return 'MEDIUM';
  return 'LARGE';
}

const DEFAULT_FEATURES: TaskSignatureFeatures = Object.freeze({
  estimatedFilesTouched: null,
  multiModule: false,
  architectureSensitive: false,
  securitySensitive: false,
  migration: false,
  expectedTestLoopClass: 'NONE',
  failureClass: null,
  blockedDependents: 0,
  criticalPath: false,
});

/**
 * Build one task signature. Pure and deterministic: the same inputs always
 * produce the same key, which is what makes profile rebuilds reproducible.
 */
export function buildTaskSignature(input: BuildTaskSignatureInput): TaskSignature {
  const category = input.category.trim().length > 0 ? input.category.trim() : 'general';
  const verification: VerificationStrength = input.deterministicVerificationAvailable
    ? 'DETERMINISTIC'
    : 'NONE';
  return {
    key: [
      category,
      input.complexity,
      input.localSuitability,
      input.executionShape,
      verification,
    ].join('|'),
    category,
    complexity: input.complexity,
    localSuitability: input.localSuitability,
    executionShape: input.executionShape,
    verification,
    repositorySize: repositorySizeClass(input.indexedFiles),
    contextSize: contextSizeClass(input.expectedContextTokens),
    features: { ...DEFAULT_FEATURES, ...(input.features ?? {}) },
  };
}

/**
 * The coarser grouping key used at fallback level TARGET_CATEGORY: category
 * plus complexity only. Drops shape, suitability, and verification strength,
 * which is exactly the information a sparse exact bucket could not support.
 */
export function categorySignatureKey(signature: Pick<TaskSignature, 'category' | 'complexity'>): string {
  return [signature.category, signature.complexity].join('|');
}

/** The coarsest task grouping: category alone (level LANE_CATEGORY). */
export function categoryOnlyKey(signature: Pick<TaskSignature, 'category'>): string {
  return signature.category;
}

/**
 * Reconstruct a signature key from the attribution a ledger entry carries.
 *
 * Historical attempts recorded their category, complexity, suitability, and
 * (from vNext.4) their execution shape. Fields that were never recorded
 * become `unknown` rather than a plausible default: an entry that cannot say
 * what it was must not be silently filed under whatever is most common.
 */
export function ledgerSignatureKey(entry: {
  taskCategory: string | null;
  taskComplexity: string | null;
  localSuitability: string | null;
  executionShape: string | null;
  verification?: string | null | undefined;
}): string {
  return [
    entry.taskCategory ?? 'unknown',
    entry.taskComplexity ?? 'unknown',
    entry.localSuitability ?? 'unknown',
    entry.executionShape ?? 'unknown',
    entry.verification ?? 'unknown',
  ].join('|');
}
