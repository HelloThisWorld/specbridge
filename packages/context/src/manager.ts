import type { CompactionRecord, ContextItem } from './items.js';
import { contextItemSchema } from './items.js';
import type { ContextBudgetConfig } from './budget.js';
import { assessContextHealth, estimateItemsTokens, usableInputTokens } from './budget.js';
import type { AssembledContext } from './assembler.js';
import { assembleContextPackage } from './assembler.js';
import type { ContextSummarizer } from './compaction.js';
import { microCompact, milestoneCompact } from './compaction.js';
import { appendDelta, foldDeltasIntoCheckpoint } from './delta.js';
import type { ContextHealthLevel } from './vocabulary.js';

/**
 * ContextLifecycleManager: the first-class runtime component that keeps one
 * task's WORKING context healthy across an execution that outlives any
 * single model context window.
 *
 * It composes the pieces:
 *
 *   ContextBudget        (budget.ts)      capacity, reservations, thresholds
 *   ContextAssembler     (assembler.ts)   layered, bounded packages
 *   ContextHealthMonitor (here + budget)  usage → closed health vocabulary
 *   CompactionManager    (compaction.ts)  micro / milestone / emergency
 *   DeltaContextManager  (delta.ts)       recent raw signal preservation
 *   NativeCompaction     (native.ts)      provider working-memory boundary
 *
 * The manager's items are DERIVED working memory. Durable truth lives in
 * SpecBridge state (checkpoints, attempts, decisions); the manager can be
 * discarded at any time and rebuilt from durable state through the
 * reconstruction path. `snapshotItems`/`restoreItems` exist so a host may
 * persist the working set opportunistically — as an optimization, never as
 * the source of truth.
 */

export interface ContextLifecycleOptions {
  budget: ContextBudgetConfig;
  clock?: (() => Date) | undefined;
  /** Bound on retained RECENT_DELTA items (default 20). */
  maxDeltaItems?: number | undefined;
  summarizer?: ContextSummarizer | undefined;
  /** Observer for threshold crossings and compactions (observability). */
  onEvent?: ((event: ContextLifecycleEvent) => void) | undefined;
}

export type ContextLifecycleEvent =
  | { type: 'context_threshold_reached'; health: ContextHealthLevel; estimatedTokens: number }
  | { type: 'context_compacted'; record: CompactionRecord };

export class ContextLifecycleManager {
  private items: ContextItem[] = [];
  private readonly compactions: CompactionRecord[] = [];
  private readonly options: ContextLifecycleOptions;
  private lastReportedHealth: ContextHealthLevel = 'HEALTHY';
  /** Sum of estimated tokens ever ADDED — cumulative pressure, not current. */
  private cumulativeEstimatedTokens = 0;

  constructor(options: ContextLifecycleOptions) {
    this.options = options;
  }

  private now(): string {
    return (this.options.clock ?? (() => new Date()))().toISOString();
  }

  /** Add one item. RECENT_DELTA items go through the bounded delta log. */
  add(item: ContextItem): void {
    const validated = contextItemSchema.parse(item);
    this.cumulativeEstimatedTokens += estimateItemsTokens([validated]);
    if (validated.layer === 'RECENT_DELTA') {
      const deltas = appendDelta(
        this.items.filter((existing) => existing.layer === 'RECENT_DELTA'),
        validated,
        { maxItems: this.options.maxDeltaItems ?? 20 },
      );
      this.items = [...this.items.filter((existing) => existing.layer !== 'RECENT_DELTA'), ...deltas];
    } else {
      this.items.push(validated);
    }
    this.reportHealth();
  }

  /** Replace the entire WORKING_SET layer (it is regenerable by design). */
  replaceWorkingSet(workingSet: readonly ContextItem[]): void {
    for (const item of workingSet) {
      if (item.layer !== 'WORKING_SET') {
        throw new Error(`replaceWorkingSet accepts WORKING_SET items only, got ${item.layer}.`);
      }
    }
    this.items = [
      ...this.items.filter((item) => item.layer !== 'WORKING_SET'),
      ...workingSet.map((item) => contextItemSchema.parse(item)),
    ];
    this.reportHealth();
  }

  currentItems(): ContextItem[] {
    return [...this.items];
  }

  estimatedTokens(): number {
    return estimateItemsTokens(this.items);
  }

  /**
   * Total estimated tokens ever added to this manager. When this exceeds the
   * usable budget by multiples while `health()` stays sane, the lifecycle is
   * doing its job: cumulative task context has outgrown any single window.
   */
  cumulativeTokens(): number {
    return this.cumulativeEstimatedTokens;
  }

  health(): ContextHealthLevel {
    return assessContextHealth(this.options.budget, this.estimatedTokens());
  }

  usableBudgetTokens(): number {
    return usableInputTokens(this.options.budget);
  }

  compactionHistory(): CompactionRecord[] {
    return [...this.compactions];
  }

  private reportHealth(): void {
    const health = this.health();
    if (health !== this.lastReportedHealth) {
      this.lastReportedHealth = health;
      if (health !== 'HEALTHY') {
        this.options.onEvent?.({
          type: 'context_threshold_reached',
          health,
          estimatedTokens: this.estimatedTokens(),
        });
      }
    }
  }

  private recordCompaction(record: CompactionRecord): void {
    this.compactions.push(record);
    this.options.onEvent?.({ type: 'context_compacted', record });
  }

  /** Run micro compaction in place. */
  microCompact(): CompactionRecord {
    const result = microCompact(this.items, this.now());
    this.items = result.items;
    this.recordCompaction(result.record);
    this.reportHealth();
    return result.record;
  }

  /**
   * Milestone compaction in place: fold current deltas into the persisted
   * checkpoint, drop everything the checkpoint made durable, and put the
   * checkpoint-backed summary in COMPACTED_HISTORY.
   */
  milestoneCompact(checkpointId: string, checkpointSummaryItem?: ContextItem): CompactionRecord {
    const deltas = this.items.filter((item) => item.layer === 'RECENT_DELTA');
    const folded = foldDeltasIntoCheckpoint(deltas, checkpointId);
    const merged = this.items.map(
      (item) => folded.find((foldedItem) => foldedItem.itemId === item.itemId) ?? item,
    );
    const result = milestoneCompact({
      items: merged,
      at: this.now(),
      checkpointId,
      checkpointSummaryItem,
    });
    this.items = result.items;
    this.recordCompaction(result.record);
    this.reportHealth();
    return result.record;
  }

  /**
   * Assemble the current items into one bounded ContextPackage. Escalating
   * pre-compaction (micro → drop disposable → emergency) happens inside the
   * assembler; whatever it applied is recorded here too.
   */
  assemble(input: {
    createdAt?: string | undefined;
    jobId?: string | undefined;
    taskId?: string | undefined;
    attemptId?: string | undefined;
    checkpointId?: string | undefined;
    checkpointSummaryItem?: ContextItem | undefined;
  }): AssembledContext {
    const assembled = assembleContextPackage({
      items: this.items,
      budget: this.options.budget,
      createdAt: input.createdAt ?? this.now(),
      jobId: input.jobId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      checkpointId: input.checkpointId,
      checkpointSummaryItem: input.checkpointSummaryItem,
      summarizer: this.options.summarizer,
      priorCompactions: this.compactions,
    });
    for (const record of assembled.compactions) this.recordCompaction(record);
    // Assembly IS the bounded view: adopt it so the working memory shrinks
    // with the package instead of re-compacting the same backlog next time.
    this.items = assembled.package.items;
    this.reportHealth();
    return assembled;
  }

  /** Serialize working items (optimization only — never the source of truth). */
  snapshotItems(): ContextItem[] {
    return this.currentItems();
  }

  /** Rebuild a manager from persisted or reconstructed items. */
  static restoreItems(options: ContextLifecycleOptions, items: readonly ContextItem[]): ContextLifecycleManager {
    const manager = new ContextLifecycleManager(options);
    for (const item of items) manager.add(item);
    return manager;
  }
}
