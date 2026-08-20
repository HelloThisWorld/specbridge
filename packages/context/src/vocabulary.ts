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
