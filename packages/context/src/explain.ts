import type { ContextItem } from './items.js';
import { itemAuthority, itemFreshness } from './items.js';
import type { ContextEfficiencyMetrics } from './metrics.js';
import { compressionRatio } from './metrics.js';
import type { ContextSelectionPlan } from './selection.js';

/**
 * Context explainability.
 *
 * A user should be able to ask: what context was selected, why was this file
 * included, why was that one excluded, what was compressed, was anything
 * stale, how big was the package, and which runner strategy produced it —
 * and get answers from durable records rather than from a rebuild.
 *
 * The safety rule this module enforces, and the reason it exists as a
 * separate projection rather than as a `console.log` of the plan:
 *
 *   Diagnostics show METADATA, never content.
 *
 * Paths, hashes, ranges, categories, reasons, and sizes are safe to print
 * into a terminal, a CI log, or a bug report. Source bodies and assembled
 * prompts are not: they are the material an operator is least likely to
 * expect a diagnostic to emit, and the most likely to paste somewhere
 * public. Anyone who genuinely needs the bytes already has the path and the
 * hash to fetch them with.
 */

export interface ContextExplanationEntry {
  path: string;
  status: 'selected' | 'pointer' | 'excluded';
  reason: string;
  score?: number | undefined;
  /** Content hash the decision was made against (identity, not content). */
  contentHash?: string | undefined;
  /** Line range, when a section rather than a whole file was selected. */
  range?: string | undefined;
  estimatedTokens?: number | undefined;
  mandatory?: boolean | undefined;
  detail?: string | undefined;
}

export interface ContextExplanation {
  planId: string;
  taskId: string;
  attemptId?: string | undefined;
  strategy: string;
  shape: string;
  role: string;
  expansionLevel: string;
  lane: string | null;
  executionMode: string | null;
  runner: string | null;
  /** Selected, then pointers, then excluded — most informative first. */
  entries: ContextExplanationEntry[];
  layers: { layer: string; items: number; chars: number }[];
  totals: {
    selectedFiles: number;
    pointers: number;
    excluded: number;
    estimatedTokens: number;
    workingSetTokens: number;
    workingSetBudget: number;
    usableInputTokens: number;
  };
  compression: {
    compressedItems: number;
    sourceChars: number;
    outputChars: number;
    ratio: number | null;
  } | null;
  deduplication: { items: number; savedChars: number } | null;
  staleness: { items: number; savedChars: number } | null;
  expansions: number;
  localRerankApplied: boolean;
  /** Freshness/authority census of the assembled items, for spot-checking. */
  itemFreshness: { freshness: string; count: number }[];
  itemAuthority: { authority: string; count: number }[];
  stablePrefixHash: string | null;
}

function census(values: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => (right.count !== left.count ? right.count - left.count : left.key < right.key ? -1 : 1));
}

/**
 * Project a plan (plus, optionally, the assembled items and metrics) into a
 * safe, printable explanation.
 *
 * `items` is used only for layer sizes and the freshness/authority census —
 * their CONTENT is never copied into the projection, only measured.
 */
export function explainContextSelection(input: {
  plan: ContextSelectionPlan;
  items?: readonly ContextItem[] | undefined;
  metrics?: ContextEfficiencyMetrics | undefined;
}): ContextExplanation {
  const { plan } = input;
  const entries: ContextExplanationEntry[] = [];

  for (const selected of plan.selectedWorkingItems) {
    entries.push({
      path: selected.path,
      status: 'selected',
      reason: selected.reason,
      score: selected.score,
      contentHash: selected.contentHash.slice(0, 12),
      ...(selected.startLine !== undefined
        ? { range: `${selected.startLine}-${selected.endLine ?? ''}` }
        : {}),
      estimatedTokens: selected.estimatedTokens,
      mandatory: selected.mandatory,
      detail: selected.detail,
    });
  }
  for (const pointer of plan.pointers) {
    entries.push({
      path: pointer.path,
      status: 'pointer',
      reason: pointer.reason,
      contentHash: pointer.contentHash.slice(0, 12),
      detail: pointer.detail,
    });
  }
  for (const excluded of plan.excludedCandidates) {
    entries.push({
      path: excluded.path,
      status: 'excluded',
      reason: excluded.reason,
      score: excluded.score,
      detail: excluded.detail,
    });
  }

  const items = input.items ?? [];
  const layerNames = [...new Set(items.map((item) => item.layer))];
  const metrics = input.metrics;

  return {
    planId: plan.planId,
    taskId: plan.taskId,
    attemptId: plan.attemptId,
    strategy: plan.strategy,
    shape: plan.shape,
    role: plan.role,
    expansionLevel: plan.expansionLevel,
    lane: plan.executionLane,
    executionMode: plan.executionMode,
    runner: plan.runner,
    entries,
    layers: layerNames.map((layer) => {
      const inLayer = items.filter((item) => item.layer === layer);
      return {
        layer,
        items: inLayer.length,
        chars: inLayer.reduce((sum, item) => sum + item.content.length, 0),
      };
    }),
    totals: {
      selectedFiles: plan.selectedWorkingItems.length,
      pointers: plan.pointers.length,
      excluded: plan.excludedCandidates.length,
      estimatedTokens: plan.estimatedTokens.total,
      workingSetTokens: plan.estimatedTokens.workingSet,
      workingSetBudget: plan.budget.workingSetBudget,
      usableInputTokens: plan.budget.usableInputTokens,
    },
    compression:
      metrics === undefined || metrics.compressedItems === 0
        ? null
        : {
            compressedItems: metrics.compressedItems,
            sourceChars: metrics.compressionSourceChars,
            outputChars: metrics.compressionOutputChars,
            ratio: compressionRatio(metrics),
          },
    deduplication:
      metrics === undefined || metrics.deduplicatedItems === 0
        ? null
        : { items: metrics.deduplicatedItems, savedChars: metrics.deduplicationSavedChars },
    staleness:
      metrics === undefined || metrics.staleItemsRemoved === 0
        ? null
        : { items: metrics.staleItemsRemoved, savedChars: metrics.staleSavedChars },
    expansions: metrics?.contextExpansions ?? 0,
    localRerankApplied: plan.localRerankApplied,
    itemFreshness: census(items.map((item) => itemFreshness(item))).map((entry) => ({
      freshness: entry.key,
      count: entry.count,
    })),
    itemAuthority: census(items.map((item) => itemAuthority(item))).map((entry) => ({
      authority: entry.key,
      count: entry.count,
    })),
    stablePrefixHash: metrics?.stablePrefixHash ?? null,
  };
}

/** Human-readable rendering of an explanation. Metadata only, never content. */
export function renderContextExplanation(explanation: ContextExplanation): string {
  const lines: string[] = [
    `Context plan ${explanation.planId} — task ${explanation.taskId}`,
    `  strategy: ${explanation.strategy}   shape: ${explanation.shape}   role: ${explanation.role}   level: ${explanation.expansionLevel}`,
    `  lane: ${explanation.lane ?? '(unassigned)'}   mode: ${explanation.executionMode ?? '(n/a)'}   runner: ${explanation.runner ?? '(n/a)'}`,
    '',
    `Selected ${explanation.totals.selectedFiles} file(s), ${explanation.totals.pointers} pointer(s); ` +
      `${explanation.totals.excluded} candidate(s) excluded.`,
    `Working set ${explanation.totals.workingSetTokens}/${explanation.totals.workingSetBudget} tokens; ` +
      `package ${explanation.totals.estimatedTokens}/${explanation.totals.usableInputTokens} estimated tokens.`,
  ];

  const selected = explanation.entries.filter((entry) => entry.status === 'selected');
  if (selected.length > 0) {
    lines.push('', 'Included:');
    for (const entry of selected) {
      lines.push(
        `  + ${entry.path}${entry.range !== undefined ? ` [${entry.range}]` : ''}` +
          ` — ${entry.reason}${entry.mandatory === true ? ' (mandatory)' : ''}` +
          ` (${entry.estimatedTokens ?? 0} tokens, @${entry.contentHash ?? '?'})`,
      );
    }
  }

  const pointers = explanation.entries.filter((entry) => entry.status === 'pointer');
  if (pointers.length > 0) {
    lines.push('', 'Pointed at (the worker reads these itself):');
    for (const entry of pointers) lines.push(`  → ${entry.path} — ${entry.reason}`);
  }

  const excluded = explanation.entries.filter((entry) => entry.status === 'excluded');
  if (excluded.length > 0) {
    lines.push('', 'Excluded:');
    for (const entry of excluded.slice(0, 40)) {
      lines.push(`  - ${entry.path} — ${entry.reason}${entry.detail !== undefined ? ` (${entry.detail})` : ''}`);
    }
    if (excluded.length > 40) lines.push(`  - … ${excluded.length - 40} further exclusion(s)`);
  }

  if (explanation.compression !== null) {
    lines.push(
      '',
      `Compression: ${explanation.compression.compressedItems} item(s), ` +
        `${explanation.compression.sourceChars} → ${explanation.compression.outputChars} chars` +
        `${explanation.compression.ratio !== null ? ` (ratio ${explanation.compression.ratio})` : ''}.`,
    );
  }
  if (explanation.deduplication !== null) {
    lines.push(
      `Deduplication: ${explanation.deduplication.items} item(s), ${explanation.deduplication.savedChars} chars saved.`,
    );
  }
  if (explanation.staleness !== null) {
    lines.push(
      `Staleness: ${explanation.staleness.items} item(s) removed, ${explanation.staleness.savedChars} chars freed.`,
    );
  }
  if (explanation.expansions > 0) {
    lines.push(`Context expansions on this task: ${explanation.expansions}.`);
  }
  if (explanation.localRerankApplied) {
    lines.push('An advisory local rerank changed the candidate order; the deterministic order is preserved on the plan.');
  }
  lines.push('', 'Diagnostics show paths, hashes, and sizes only — never source content or assembled prompts.');
  return lines.join('\n');
}
