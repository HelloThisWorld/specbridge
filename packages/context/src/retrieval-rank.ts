import type { RepositoryIndexEntry } from './repo-index-state.js';
import type { RepositoryContextIndex } from './repo-index.js';
import type { ContextRetrievalQuery, RetrievalRole } from './retrieval-query.js';
import { CONTEXT_EXPANSION_LEVEL_DEPTH } from './vocabulary.js';
import type { ContextSelectionReason } from './vocabulary.js';

/**
 * Deterministic candidate generation and ranking.
 *
 * The first ranker is NOT a model. Every signal here is a checkable fact
 * about durable state and the repository index — this path was named, this
 * file is changed, this test covers that source, this module imports that
 * one — combined with configurable integer weights. Two consequences follow,
 * and both are the point:
 *
 *   REPRODUCIBLE  the same durable inputs and the same index produce the
 *                 same ranking, forever. A retrieval layer nobody can replay
 *                 is a retrieval layer nobody can debug.
 *   AUDITABLE     every candidate carries the reasons that scored it, so
 *                 "why is this file here?" is answered with facts rather
 *                 than with a similarity number.
 *
 * An optional local rerank may refine the ORDER of a bounded candidate set
 * afterwards (see `retrieval-rerank.ts`). It is advisory, it runs on
 * metadata only, and it can never remove a mandatory reference.
 */

export interface RankingWeights {
  explicitContractReference: number;
  explicitFailureReference: number;
  explicitActionReference: number;
  changedFile: number;
  checkpointChangedFile: number;
  symbolMatch: number;
  testSourcePair: number;
  dependencyProximity: number;
  moduleProximity: number;
  referencePattern: number;
  tokenOverlapPerToken: number;
  tokenOverlapCap: number;
  priorTaskRelevance: number;
  /** Applied to entries whose kind is 'doc' or 'data' (rarely implementable). */
  nonSourcePenalty: number;
  /** Applied per 10 KiB of file size, so huge files need stronger evidence. */
  sizePenaltyPer10Kib: number;
}

export const DEFAULT_RANKING_WEIGHTS: Readonly<RankingWeights> = Object.freeze({
  explicitContractReference: 1_000,
  explicitFailureReference: 1_200,
  explicitActionReference: 900,
  changedFile: 800,
  checkpointChangedFile: 300,
  symbolMatch: 220,
  testSourcePair: 180,
  dependencyProximity: 120,
  moduleProximity: 40,
  referencePattern: 150,
  tokenOverlapPerToken: 12,
  tokenOverlapCap: 96,
  priorTaskRelevance: 60,
  nonSourcePenalty: 60,
  sizePenaltyPer10Kib: 8,
});

/**
 * Per-role weighting adjustments.
 *
 * Multipliers rather than replacements: a role can say "the failure matters
 * more to me than the contract does" without any role being able to zero out
 * a mandatory reference, which stays mandatory under every profile.
 */
export const ROLE_WEIGHT_MULTIPLIERS: Readonly<Record<RetrievalRole, Partial<Record<keyof RankingWeights, number>>>> =
  Object.freeze({
    EXECUTOR: {},
    DIAGNOSER: { explicitFailureReference: 1.5, testSourcePair: 1.5, moduleProximity: 0.5 },
    REPLANNER: { explicitContractReference: 1.5, dependencyProximity: 1.5, tokenOverlapPerToken: 0.5 },
    EVALUATOR: { explicitContractReference: 1.4, changedFile: 1.4, moduleProximity: 0.25 },
    PLANNER: { explicitContractReference: 1.3, moduleProximity: 1.25 },
    CRITIC: { explicitContractReference: 1.2, changedFile: 1.2 },
  });

export function weightsForRole(role: RetrievalRole, base: RankingWeights = DEFAULT_RANKING_WEIGHTS): RankingWeights {
  const multipliers = ROLE_WEIGHT_MULTIPLIERS[role];
  const adjusted = { ...base };
  for (const [key, multiplier] of Object.entries(multipliers) as [keyof RankingWeights, number][]) {
    adjusted[key] = Math.round(base[key] * multiplier);
  }
  return adjusted;
}

/** One scored reason a candidate is in the running. */
export interface CandidateSignal {
  reason: ContextSelectionReason;
  score: number;
  /** Bounded, safe detail: a path, a symbol, a count. Never model prose. */
  detail?: string | undefined;
}

export interface RankedCandidate {
  path: string;
  entry: RepositoryIndexEntry;
  score: number;
  /** The single highest-scoring reason; what diagnostics report first. */
  primaryReason: ContextSelectionReason;
  signals: CandidateSignal[];
  /** True when a MANDATORY reference produced this candidate. */
  mandatory: boolean;
  /** Expansion depth at which this candidate first becomes eligible. */
  eligibleAtDepth: number;
}

interface Accumulator {
  entry: RepositoryIndexEntry;
  signals: CandidateSignal[];
  eligibleAtDepth: number;
}

const MANDATORY_REASONS: ReadonlySet<ContextSelectionReason> = new Set([
  'EXPLICIT_CONTRACT_REFERENCE',
  'EXPLICIT_FAILURE_REFERENCE',
  'EXPLICIT_ACTION_REFERENCE',
  'CHANGED_FILE',
]);

export interface RankOptions {
  weights?: RankingWeights | undefined;
  /** Ceiling on returned candidates (default 200). */
  maxCandidates?: number | undefined;
  /**
   * How many CHANGED files may be treated as mandatory (default 12).
   *
   * A changed file is strong evidence when a handful of them are in play:
   * the task is working on exactly those. It stops being evidence when the
   * working tree has two hundred dirty paths — at that point "changed" says
   * something about the branch, not about the task, and making all of them
   * unbounded-mandatory would let the working tree overrule the budget and
   * squeeze out the contract itself.
   *
   * Beyond the bound, changed files still score their full weight and rank
   * normally; they simply stop being undroppable. The paths durable state
   * NAMES — the contract, the failure, the current action — are unaffected
   * and stay mandatory however many there are, because those were chosen by
   * policy rather than observed on disk.
   */
  maxMandatoryChangedFiles?: number | undefined;
  /**
   * How many of the strongest candidates seed structural proximity
   * (default 25). See the proximity pass for why this is bounded.
   */
  maxProximityAnchors?: number | undefined;
  /**
   * Paths policy forbids in retrieved context. Excluded here rather than
   * later, so a forbidden path is never even ranked — a candidate list that
   * contains it has already leaked it into diagnostics.
   */
  excludedPaths?: readonly string[] | undefined;
}

/**
 * Generate and rank candidates for one query.
 *
 * Cost is bounded by the number of REFERENCES plus one linear pass over the
 * index for token/symbol matching — never a read of any file body. That is
 * the §112 requirement in code: dispatch-time retrieval touches metadata
 * only, so it stays practical on a repository with tens of thousands of
 * files.
 */
export function rankCandidates(
  index: RepositoryContextIndex,
  query: ContextRetrievalQuery,
  options: RankOptions = {},
): RankedCandidate[] {
  const weights = options.weights ?? weightsForRole(query.role);
  const maxCandidates = options.maxCandidates ?? 200;
  const excluded = new Set((options.excludedPaths ?? []).map((value) => value.replace(/\\/g, '/')));
  const accumulators = new Map<string, Accumulator>();
  /** Changed paths past the mandatory bound: strong evidence, still droppable. */
  const nonMandatoryChanged = new Set<string>();

  const add = (
    relativePath: string,
    reason: ContextSelectionReason,
    score: number,
    depth: number,
    detail?: string,
  ): void => {
    if (score <= 0) return;
    const normalized = relativePath.replace(/\\/g, '/');
    if (excluded.has(normalized)) return;
    const entry = index.get(normalized);
    if (entry === undefined) return;
    const existing = accumulators.get(entry.path);
    if (existing === undefined) {
      accumulators.set(entry.path, {
        entry,
        signals: [{ reason, score, ...(detail !== undefined ? { detail } : {}) }],
        eligibleAtDepth: depth,
      });
      return;
    }
    // A cheaper level already justified this candidate: keep the shallower
    // eligibility, so widening never has to re-justify what it already had.
    existing.eligibleAtDepth = Math.min(existing.eligibleAtDepth, depth);
    const sameReason = existing.signals.find((signal) => signal.reason === reason);
    if (sameReason === undefined) {
      existing.signals.push({ reason, score, ...(detail !== undefined ? { detail } : {}) });
    } else if (score > sameReason.score) {
      sameReason.score = score;
      if (detail !== undefined) sameReason.detail = detail;
    }
  };

  const level1 = CONTEXT_EXPANSION_LEVEL_DEPTH.TOP_WORKING_SET;
  const level2 = CONTEXT_EXPANSION_LEVEL_DEPTH.ADJACENT_DEPENDENCIES;
  const level3 = CONTEXT_EXPANSION_LEVEL_DEPTH.MODULE_CONTEXT;

  // --- 1. Literal references. Facts, not similarity. ------------------------
  for (const reference of query.failurePaths) {
    add(reference, 'EXPLICIT_FAILURE_REFERENCE', weights.explicitFailureReference, 0, reference);
  }
  for (const reference of query.contractPaths) {
    add(reference, 'EXPLICIT_CONTRACT_REFERENCE', weights.explicitContractReference, 0, reference);
  }
  for (const reference of query.actionPaths) {
    add(reference, 'EXPLICIT_ACTION_REFERENCE', weights.explicitActionReference, 0, reference);
  }
  // Sorted so the mandatory subset is a deterministic function of the set,
  // never of the order Git happened to report.
  const changedLimit = options.maxMandatoryChangedFiles ?? 12;
  const changedSorted = [...query.changedPaths].sort();
  changedSorted.forEach((reference, position) => {
    add(
      reference,
      'CHANGED_FILE',
      weights.changedFile,
      position < changedLimit ? 0 : level1,
      reference,
    );
    if (position >= changedLimit) nonMandatoryChanged.add(reference.replace(/\\/g, '/'));
  });
  for (const reference of query.checkpointChangedPaths) {
    add(reference, 'CHECKPOINT_CHANGED_FILE', weights.checkpointChangedFile, level1, reference);
  }
  for (const reference of query.priorRelevantPaths) {
    add(reference, 'PRIOR_TASK_RELEVANCE', weights.priorTaskRelevance, level1, reference);
  }

  // A bare filename in a failure ("FooService.ts") is still a reference; the
  // index resolves it to real paths rather than guessing a directory.
  for (const bucket of [query.failurePaths, query.contractPaths, query.actionPaths]) {
    for (const reference of bucket) {
      if (reference.includes('/')) continue;
      for (const resolved of index.namedExactly(reference)) {
        add(resolved, 'EXPLICIT_FAILURE_REFERENCE', weights.explicitFailureReference, 0, reference);
      }
    }
  }

  // --- 2. Symbol declarations. ---------------------------------------------
  for (const symbol of query.symbols) {
    for (const declaring of index.declaring(symbol)) {
      add(declaring, 'SYMBOL_MATCH', weights.symbolMatch, level1, symbol);
    }
  }

  // --- 3. Token overlap over index metadata only. --------------------------
  if (query.tokens.length > 0) {
    const queryTokens = new Set(query.tokens);
    for (const entry of index.entries) {
      if (excluded.has(entry.path)) continue;
      let overlap = 0;
      for (const token of entry.tokens) if (queryTokens.has(token)) overlap += 1;
      if (overlap === 0) continue;
      add(
        entry.path,
        'TOKEN_OVERLAP',
        Math.min(weights.tokenOverlapCap, overlap * weights.tokenOverlapPerToken),
        level1,
        `${overlap} token(s)`,
      );
    }
  }

  // --- 4. Structural neighbourhood of what we already have. ----------------
  //
  // Computed from the STRONGEST current candidates, not from every one. Two
  // reasons, and both matter:
  //
  //   RANKING   proximity should mean "near the evidence". A file that
  //             scraped one token match is not evidence, and treating it as
  //             an anchor spreads proximity credit across the repository
  //             until the signal means nothing.
  //   COST      proximity does several index lookups per anchor, so an
  //             unbounded anchor set makes this pass grow with the size of
  //             the repository — on every dispatch of a long-horizon job.
  const anchorLimit = options.maxProximityAnchors ?? 25;
  const anchors = [...accumulators.entries()]
    .map(([path, accumulator]) => ({
      path,
      score: accumulator.signals.reduce((sum, signal) => sum + signal.score, 0),
    }))
    .sort((left, right) =>
      right.score !== left.score ? right.score - left.score : left.path < right.path ? -1 : 1,
    )
    .slice(0, anchorLimit)
    .map((entry) => entry.path);
  for (const anchor of anchors) {
    for (const test of index.testsFor(anchor)) {
      add(test, 'TEST_SOURCE_PAIR', weights.testSourcePair, level2, anchor);
    }
    for (const source of index.sourcesFor(anchor)) {
      add(source, 'TEST_SOURCE_PAIR', weights.testSourcePair, level2, anchor);
    }
    for (const dependency of index.dependenciesOf(anchor)) {
      add(dependency, 'DEPENDENCY_PROXIMITY', weights.dependencyProximity, level2, anchor);
    }
    for (const dependent of index.dependentsOf(anchor)) {
      add(dependent, 'DEPENDENCY_PROXIMITY', weights.dependencyProximity, level2, anchor);
    }
    const anchorEntry = index.get(anchor);
    if (anchorEntry !== undefined && anchorEntry.kind === 'source') {
      const suffixes = structuralSuffixes(anchorEntry.path, anchorEntry.symbols);
      for (const sibling of index.siblingsIn(anchorEntry.module)) {
        if (sibling === anchor) continue;
        const entry = index.get(sibling);
        if (entry === undefined || entry.kind !== 'source' || entry.language !== anchorEntry.language) {
          continue;
        }
        const sharedImportCount = entry.imports.filter((specifier) =>
          anchorEntry.imports.includes(specifier),
        ).length;
        const sameConvention = structuralSuffixes(entry.path, entry.symbols).some((suffix) =>
          suffixes.includes(suffix),
        );
        if (!sameConvention && sharedImportCount < 2) continue;
        add(
          sibling,
          'REFERENCE_PATTERN',
          weights.referencePattern + Math.min(30, sharedImportCount * 10),
          level2,
          sameConvention ? anchor : `${anchor} (${sharedImportCount} shared imports)`,
        );
      }
    }
  }
  const anchorModules = new Set(anchors.map((anchor) => index.get(anchor)?.module ?? ''));
  for (const module of anchorModules) {
    if (module === '') continue;
    for (const sibling of index.siblingsIn(module)) {
      add(sibling, 'MODULE_PROXIMITY', weights.moduleProximity, level3, module);
    }
  }

  // --- 5. Score, penalize, order. ------------------------------------------
  const ranked: RankedCandidate[] = [];
  for (const accumulator of accumulators.values()) {
    const { entry } = accumulator;
    const positive = accumulator.signals.reduce((sum, signal) => sum + signal.score, 0);
    const kindPenalty = entry.kind === 'doc' || entry.kind === 'data' ? weights.nonSourcePenalty : 0;
    const sizePenalty = Math.floor(entry.sizeBytes / 10_240) * weights.sizePenaltyPer10Kib;
    const mandatory = accumulator.signals.some(
      (signal) =>
        MANDATORY_REASONS.has(signal.reason) &&
        !(signal.reason === 'CHANGED_FILE' && nonMandatoryChanged.has(entry.path)),
    );
    // A mandatory reference is never penalized below the field: policy named
    // it, and a size heuristic does not get to overrule the contract.
    const score = mandatory ? positive : Math.max(1, positive - kindPenalty - sizePenalty);
    const primary = [...accumulator.signals].sort((left, right) => right.score - left.score)[0];
    ranked.push({
      path: entry.path,
      entry,
      score,
      primaryReason: primary?.reason ?? 'TOKEN_OVERLAP',
      signals: [...accumulator.signals].sort((left, right) => right.score - left.score),
      mandatory,
      eligibleAtDepth: mandatory ? 0 : accumulator.eligibleAtDepth,
    });
  }

  // Ties break on path, so ordering never depends on Map iteration order.
  ranked.sort((left, right) =>
    right.score !== left.score ? right.score - left.score : left.path < right.path ? -1 : 1,
  );
  return ranked.slice(0, maxCandidates);
}

/** Conservative naming conventions such as Mapper, Controller, DTO, Serializer. */
function structuralSuffixes(relativePath: string, symbols: readonly string[]): string[] {
  const base = relativePath.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? '';
  const values = [base, ...symbols];
  const suffixes = new Set<string>();
  for (const value of values) {
    const match = value.match(/([A-Z][a-z0-9]{2,})$/);
    if (match?.[1] !== undefined) suffixes.add(match[1].toLowerCase());
  }
  return [...suffixes];
}
