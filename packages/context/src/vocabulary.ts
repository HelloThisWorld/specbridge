/**
 * The stable vocabulary of the context lifecycle (vNext.1 Survival Runtime).
 *
 * Everything here is a closed string enum, additive within 1.x exactly like
 * the orchestration vocabulary: new members may be appended, existing members
 * never change meaning and are never removed, so persisted context packages
 * and compaction records stay readable across upgrades.
 *
 * The organising idea:
 *
 *   Context windows are disposable working memory.
 *   SpecBridge state is durable memory.
 *
 * An agent receives an *assembled context package* built from durable
 * SpecBridge state — never an accumulated conversation it must hope survives
 * the next compaction. No enum below can be set from model output.
 */

// ---------------------------------------------------------------------------
// Context layers
// ---------------------------------------------------------------------------

/**
 * The layered context model. Layers are ordered: assembly emits them in this
 * order, and the drop policy under budget pressure walks them in REVERSE
 * protection order — pinned and durable state are never silently dropped.
 *
 *   PINNED              task contract, acceptance criteria, architecture
 *                       rules, critical invariants. Compaction must NEVER
 *                       summarize these away; reconstruction re-injects them
 *                       deterministically from durable state.
 *   DURABLE_TASK_STATE  checkpoint-backed truth: objective, completed work,
 *                       decisions, failed approaches, unresolved issues.
 *                       Canonical; a provider-native compacted conversation
 *                       is NOT canonical state.
 *   COMPACTED_HISTORY   structured summaries of older execution history that
 *                       has already been folded into checkpoints.
 *   WORKING_SET         replaceable repository context: relevant files,
 *                       current diff, latest test output. Regenerable, so
 *                       droppable under pressure and never pinned forever.
 *   RECENT_DELTA        recent high-value raw information (latest diff, test
 *                       failure, tool result). Survives micro-compaction
 *                       until folded into a checkpoint.
 *   CURRENT_ACTION      what the worker is being asked to do right now.
 */
export const CONTEXT_LAYERS = [
  'PINNED',
  'DURABLE_TASK_STATE',
  'COMPACTED_HISTORY',
  'WORKING_SET',
  'RECENT_DELTA',
  'CURRENT_ACTION',
] as const;
export type ContextLayer = (typeof CONTEXT_LAYERS)[number];

/** Layers that must survive every compaction level intact. */
export const PROTECTED_CONTEXT_LAYERS: readonly ContextLayer[] = [
  'PINNED',
  'DURABLE_TASK_STATE',
  'CURRENT_ACTION',
];

export function isProtectedLayer(layer: ContextLayer): boolean {
  return PROTECTED_CONTEXT_LAYERS.includes(layer);
}

// ---------------------------------------------------------------------------
// Context health
// ---------------------------------------------------------------------------

/**
 * Health of a context relative to its budget. Thresholds are configurable;
 * the levels themselves are the closed policy vocabulary the runtime and its
 * tests branch on.
 *
 *   HEALTHY            below the prepare threshold; proceed freely
 *   PREPARE            approaching pressure; prefer compact additions and
 *                      keep checkpoints fresh
 *   PROACTIVE_COMPACT  compaction should run at the next safe boundary
 *   FORCE_COMPACT      compaction must run before further growth
 *   OVERFLOW           above the hard-stop threshold; no large context
 *                      operation may start until compaction succeeds
 */
export const CONTEXT_HEALTH_LEVELS = [
  'HEALTHY',
  'PREPARE',
  'PROACTIVE_COMPACT',
  'FORCE_COMPACT',
  'OVERFLOW',
] as const;
export type ContextHealthLevel = (typeof CONTEXT_HEALTH_LEVELS)[number];

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Compaction levels. Every level is a NORMAL runtime operation — emergency
 * compaction is designed as ordinary behavior under pressure, never as an
 * unrecoverable failure.
 *
 *   micro      frequently generated low-value bulk data (logs, repeated tool
 *              output, stale file contents) becomes a small structured
 *              representation
 *   milestone  a meaningful unit of work completed: history already folded
 *              into a checkpoint collapses to checkpoint-backed summaries
 *   emergency  the context approached its safe upper bound: disposable
 *              history is dropped, protected layers and checkpoint state are
 *              preserved, and a bounded package is rebuilt
 */
export const COMPACTION_LEVELS = ['micro', 'milestone', 'emergency'] as const;
export type CompactionLevel = (typeof COMPACTION_LEVELS)[number];

/**
 * Native-compaction modes a provider can declare.
 *
 *   none       the provider has no native compaction; SpecBridge generic
 *              compaction applies
 *   automatic  the provider compacts its own session transparently (e.g. an
 *              agent CLI managing its own window); SpecBridge cannot trigger
 *              it but may rely on the session surviving
 *   explicit   the provider exposes a compaction operation SpecBridge can
 *              invoke through the adapter
 *
 * Whatever the mode: provider-native compaction is provider/session WORKING
 * MEMORY only. It never replaces the structured SpecBridge checkpoint, and
 * cross-provider continuity never depends on it.
 */
export const NATIVE_COMPACTION_MODES = ['none', 'automatic', 'explicit'] as const;
export type NativeCompactionMode = (typeof NATIVE_COMPACTION_MODES)[number];

// ---------------------------------------------------------------------------
// Context efficiency (vNext.7 Context Efficiency Runtime)
// ---------------------------------------------------------------------------

/**
 * How a ContextPackage is constructed.
 *
 *   LEGACY       vNext.6 assembly, unchanged: durable state plus whatever
 *                working set the caller supplied. No repository retrieval,
 *                no automatic compression, no expansion. The rollback path
 *                and the A/B baseline every measurement is compared against.
 *   SELECTIVE    the repository index and deterministic retrieval choose a
 *                BOUNDED working set once; dedupe, compression, and staleness
 *                removal apply. No automatic widening.
 *   PROGRESSIVE  SELECTIVE, plus bounded widening when a context miss is
 *                DIAGNOSED (never on a schedule, never speculatively).
 *
 * The strategy governs the WORKING SET only. Pinned and durable layers are
 * assembled deterministically from canonical state under every strategy —
 * that is what makes changing strategies a performance decision rather than
 * a correctness one.
 */
export const CONTEXT_STRATEGIES = ['LEGACY', 'SELECTIVE', 'PROGRESSIVE'] as const;
export type ContextStrategy = (typeof CONTEXT_STRATEGIES)[number];

/**
 * How long a context item stays true.
 *
 * Freshness is a property of the ITEM's relationship to canonical state, not
 * a timestamp: SpecBridge invalidates by comparing hashes and identities, so
 * clock skew can never make stale content look current.
 *
 *   IMMUTABLE                     true forever once written (an approved
 *                                 contract, a finished run's exit code)
 *   CURRENT                       true as of assembly; nothing observed
 *                                 invalidates it
 *   STALE_IF_REPO_CHANGES         a file body or diff: invalid the moment
 *                                 its source hash stops matching
 *   STALE_IF_TASK_CHANGES         tied to a task identity/plan revision
 *   STALE_IF_CHECKPOINT_ADVANCES  superseded once a newer checkpoint folds
 *                                 the same information into durable state
 *   EPHEMERAL                     one-shot working information (the current
 *                                 action, a single tool result)
 */
export const CONTEXT_FRESHNESS_KINDS = [
  'IMMUTABLE',
  'CURRENT',
  'STALE_IF_REPO_CHANGES',
  'STALE_IF_TASK_CHANGES',
  'STALE_IF_CHECKPOINT_ADVANCES',
  'EPHEMERAL',
] as const;
export type ContextFreshness = (typeof CONTEXT_FRESHNESS_KINDS)[number];

/**
 * How much authority an item's content carries when two items disagree.
 *
 * Deduplication never merges conflicting facts into an invented compromise:
 * it keeps the highest authority and records that it dropped the other. The
 * ordering is the policy, and it is deliberately the same ordering the rest
 * of SpecBridge uses — approved intent and deterministic evidence outrank
 * anything a model produced.
 *
 *   CANONICAL  approved contract, acceptance criteria, current checkpoint
 *   TRUSTED    deterministic evidence: current repository bytes, verifier
 *              output, Git diff
 *   DERIVED    something SpecBridge computed from the above (a structural
 *              compression, a summary of dropped history)
 *   CLAIM      something a model asserted; never authority over the above
 */
export const CONTEXT_AUTHORITY_LEVELS = ['CANONICAL', 'TRUSTED', 'DERIVED', 'CLAIM'] as const;
export type ContextAuthority = (typeof CONTEXT_AUTHORITY_LEVELS)[number];

/** Numeric rank of each authority level; higher wins deduplication. */
export const CONTEXT_AUTHORITY_RANK: Readonly<Record<ContextAuthority, number>> = Object.freeze({
  CANONICAL: 3,
  TRUSTED: 2,
  DERIVED: 1,
  CLAIM: 0,
});

/**
 * What an item's content ultimately came from. Provenance is structural: an
 * agent should never receive generated context whose origin cannot be named,
 * and diagnostics report the origin rather than the bytes.
 */
export const CONTEXT_ORIGIN_KINDS = [
  /** Whole file body read from the workspace at a known content hash. */
  'repository-file',
  /** A bounded line/symbol range of a file at a known content hash. */
  'repository-section',
  /** A pointer to a repository artifact the worker is expected to read itself. */
  'repository-pointer',
  /** Durable SpecBridge state (job, task, attempt, decision records). */
  'durable-state',
  /** A specific canonical checkpoint. */
  'checkpoint',
  /** A verification/evaluation run's trusted output. */
  'verification-run',
  /** A Git diff against a named baseline. */
  'diff',
  /** Raw runner/tool output captured during an attempt. */
  'tool-result',
  /** Data derived from other context items (compression, summary, dedupe). */
  'derived',
  /** SpecBridge policy text: control instructions, boundaries, conventions. */
  'policy',
] as const;
export type ContextOriginKind = (typeof CONTEXT_ORIGIN_KINDS)[number];

/**
 * WHY a candidate was selected. Every selected working item records exactly
 * one primary reason, so "why is this file in my prompt?" is answerable from
 * the plan rather than from a ranking score nobody can reconstruct.
 */
export const CONTEXT_SELECTION_REASONS = [
  /** Named literally by the task contract, plan, or acceptance criteria. */
  'EXPLICIT_CONTRACT_REFERENCE',
  /** Named literally by the current failure (stack frame, verifier output). */
  'EXPLICIT_FAILURE_REFERENCE',
  /** Named literally by the current action or recovery decision. */
  'EXPLICIT_ACTION_REFERENCE',
  /** Currently changed in the working tree. */
  'CHANGED_FILE',
  /** Recorded on the checkpoint as already touched by this task. */
  'CHECKPOINT_CHANGED_FILE',
  /** A test file whose source counterpart was selected, or vice versa. */
  'TEST_SOURCE_PAIR',
  /** Imported by, or importing, an already-selected file. */
  'DEPENDENCY_PROXIMITY',
  /** In the same module/package as an already-selected file. */
  'MODULE_PROXIMITY',
  /** A declared symbol matched a query symbol. */
  'SYMBOL_MATCH',
  /** Filename/path tokens overlapped the query tokens. */
  'TOKEN_OVERLAP',
  /** Selected in a previous attempt on this task and still relevant. */
  'PRIOR_TASK_RELEVANCE',
  /** Added by a bounded progressive expansion level. */
  'PROGRESSIVE_EXPANSION',
  /** An advisory local rerank raised it into the selected set. */
  'LOCAL_RERANK',
] as const;
export type ContextSelectionReason = (typeof CONTEXT_SELECTION_REASONS)[number];

/**
 * Selection reasons that are MANDATORY: neither heuristic ranking nor the
 * advisory local reranker may drop an item that carries one.
 *
 * These are the references SpecBridge knows about from DURABLE state — a
 * path the contract names, a file the failure names, a file the working tree
 * has already changed. Losing one of those to a similarity score is the
 * classic retrieval failure this list exists to make structurally impossible.
 */
export const MANDATORY_SELECTION_REASONS: readonly ContextSelectionReason[] = [
  'EXPLICIT_CONTRACT_REFERENCE',
  'EXPLICIT_FAILURE_REFERENCE',
  'EXPLICIT_ACTION_REFERENCE',
  'CHANGED_FILE',
];

export function isMandatorySelectionReason(reason: ContextSelectionReason): boolean {
  return MANDATORY_SELECTION_REASONS.includes(reason);
}

/** WHY a ranked candidate did not make it into the package. */
export const CONTEXT_EXCLUSION_REASONS = [
  /** Ranked below the selected set. */
  'RANKED_BELOW_CUTOFF',
  /** The working-set token budget was already spent. */
  'BUDGET_EXHAUSTED',
  /** A protected/sensitive path policy refused it. */
  'PROTECTED_PATH',
  /** Its indexed content no longer matches the file on disk. */
  'STALE_INDEX_ENTRY',
  /** Materially identical to a higher-authority item already selected. */
  'DUPLICATE',
  /** The runner reads the repository itself; a pointer was sent instead. */
  'HARNESS_READS_REPOSITORY',
  /** Above the per-item size ceiling and no safe section could be cut. */
  'TOO_LARGE',
  /** The advisory local rerank lowered it out of the selected set. */
  'LOCAL_RERANK',
] as const;
export type ContextExclusionReason = (typeof CONTEXT_EXCLUSION_REASONS)[number];

/**
 * Progressive expansion levels, in the order they are applied.
 *
 * Each level is one bounded widening step, taken only against EVIDENCE that
 * the previous package was insufficient. The ceiling is deliberately a
 * bounded fallback rather than "the repository": a task whose working set
 * genuinely does not fit is a decomposition problem, and hiding that behind
 * a bigger prompt is how a context layer starts making planning decisions.
 */
export const CONTEXT_EXPANSION_LEVELS = [
  'MINIMAL_BOOTSTRAP',
  'TOP_WORKING_SET',
  'ADJACENT_DEPENDENCIES',
  'MODULE_CONTEXT',
  'BOUNDED_FALLBACK',
] as const;
export type ContextExpansionLevel = (typeof CONTEXT_EXPANSION_LEVELS)[number];

/** Numeric depth of each expansion level (Level 0..4). */
export const CONTEXT_EXPANSION_LEVEL_DEPTH: Readonly<Record<ContextExpansionLevel, number>> =
  Object.freeze({
    MINIMAL_BOOTSTRAP: 0,
    TOP_WORKING_SET: 1,
    ADJACENT_DEPENDENCIES: 2,
    MODULE_CONTEXT: 3,
    BOUNDED_FALLBACK: 4,
  });

/** The level at a given depth, clamped to the closed vocabulary. */
export function expansionLevelAtDepth(depth: number): ContextExpansionLevel {
  const bounded = Math.max(0, Math.min(CONTEXT_EXPANSION_LEVELS.length - 1, Math.trunc(depth)));
  return CONTEXT_EXPANSION_LEVELS[bounded] as ContextExpansionLevel;
}

/**
 * The shape of context a worker receives, decided by what the worker can do
 * for itself rather than by which provider it is.
 *
 *   MATERIALIZED  the worker has no repository tools: everything it needs to
 *                 act must be in the request (a bounded working set)
 *   POINTER       the worker can read the repository: it receives canonical
 *                 state it CANNOT recover, plus high-value pointers, and it
 *                 fetches current bytes itself
 *
 * Sending both — a full working set AND tools — pays for the same
 * information twice, which is the single largest avoidable context cost in
 * an agentic runtime.
 */
export const CONTEXT_SHAPES = ['MATERIALIZED', 'POINTER'] as const;
export type ContextShape = (typeof CONTEXT_SHAPES)[number];

/**
 * How an item's content was compressed. Deterministic methods are preferred
 * everywhere parsing is reliable; the local model handles only the
 * unstructured bulk that deterministic extraction cannot reduce.
 */
export const CONTEXT_COMPRESSION_METHODS = [
  'none',
  /** Bounded head/tail window with an omission marker (vNext.1 behavior). */
  'structural-head-tail',
  /** Failing tests, signatures, locations, counts. */
  'test-log-v1',
  /** Error code, file, line, symbol, message. */
  'compiler-log-v1',
  /** Rule, file, line, message, per-rule counts. */
  'lint-log-v1',
  /** Files changed, insertions/deletions, structural metadata. */
  'diff-summary-v1',
  /** Repeated identical lines collapsed to a signature plus a count. */
  'repetition-collapse-v1',
  /** Bounded local-model structured compression of unstructured bulk. */
  'local-model-v1',
] as const;
export type ContextCompressionMethod = (typeof CONTEXT_COMPRESSION_METHODS)[number];

/**
 * Observable evidence that an attempt failed for want of CONTEXT rather than
 * for want of intelligence.
 *
 * This distinction is why vNext.7 touches reliability at all. A local model
 * that could not find an implementation it was never shown has proved
 * nothing about its own capability, and escalating to a stronger model
 * spends prepaid quota answering a question nobody asked. Every signal here
 * is something SpecBridge can OBSERVE — never a model asserting it was
 * confused.
 */
export const CONTEXT_INSUFFICIENCY_SIGNALS = [
  /** The worker reported a missing repository artifact in structured output. */
  'WORKER_REPORTED_MISSING_CONTEXT',
  /** The worker referenced a symbol/module absent from the package. */
  'UNKNOWN_SYMBOL_REFERENCE',
  /** A selected item's source hash no longer matched at dispatch. */
  'SELECTED_ARTIFACT_STALE',
  /** A mandatory reference could not be included within the budget. */
  'MANDATORY_REFERENCE_DROPPED',
  /** A DIRECT_MODEL attempt declined for want of repository knowledge. */
  'DIRECT_MODEL_REQUESTED_REPOSITORY',
  /** Deterministic evaluation failed inside a file that was never provided. */
  'FAILURE_IN_UNSELECTED_FILE',
] as const;
export type ContextInsufficiencySignal = (typeof CONTEXT_INSUFFICIENCY_SIGNALS)[number];
