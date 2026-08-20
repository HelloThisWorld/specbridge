import type { ContextItem } from '@specbridge/context';
import type { LocalExecutorInference } from './local-execution.js';

/**
 * Local preprocessing before strong execution (vNext.2 intelligence
 * decomposition): reduce subscription context consumption by compressing
 * bulky REGENERABLE context items with the free local lane before the
 * strong worker sees them.
 *
 *   large test log / tool output           small structured summary
 *          (working set)          --->        (working set, compacted)
 *                       then: Claude Max
 *
 * Rules, aligned with the vNext.1 context layering:
 *   - only WORKING_SET and RECENT_DELTA items are ever compressed — pinned
 *     context and durable checkpoint state remain canonical and untouched
 *   - compression failure falls back to the original item (a strong worker
 *     with a big log beats one with a hole in its context)
 *   - the local pass is itself bounded: at most `maxItems` items per call,
 *     each request capped by the local input budget
 *
 * This module is also the decomposition EXTENSION POINT: later phases add
 * further local supporting activities (file ranking, attempt-history
 * summarization) behind the same shape — bounded local passes that shrink
 * strong-lane context, never a multi-agent conversation.
 */

export const LOCAL_PREPROCESS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', maxLength: 4_000 },
    keyFindings: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 } },
  },
};

const PREPROCESS_SYSTEM_PROMPT = [
  'You compress one bulky engineering artifact (a log, test output, tool',
  'result, or diff) into a small structured summary another engineer will',
  'rely on INSTEAD of the original. Preserve: concrete error messages,',
  'failing test names, file paths, line numbers, and counts. Drop:',
  'repetition, timestamps, progress noise. Never invent content.',
].join('\n');

/** Layers the preprocessor may compress. Everything else passes through. */
const COMPRESSIBLE_LAYERS = ['WORKING_SET', 'RECENT_DELTA'] as const;

export interface LocalPreprocessInput {
  items: readonly ContextItem[];
  inference: LocalExecutorInference;
  /** Compress items whose content exceeds this many characters. */
  compressOverChars?: number | undefined;
  /** Upper bound on items compressed in one call. */
  maxItems?: number | undefined;
  /** Character budget for each request's item excerpt. */
  maxRequestChars?: number | undefined;
  /** Called before each inference request (local budget accounting). */
  onInferenceCall?: (() => void) | undefined;
  clock?: (() => Date) | undefined;
}

export interface LocalPreprocessResult {
  items: ContextItem[];
  /** Item ids that were replaced by local summaries. */
  compressedItemIds: string[];
  /** Estimated characters saved across all compressions. */
  savedChars: number;
}

/**
 * Compress oversized regenerable items via the local lane. Non-destructive:
 * returns a NEW item list; sources of truth (run artifacts, checkpoints)
 * are unaffected, and every summary names its source item.
 */
export async function compressContextItemsLocally(
  input: LocalPreprocessInput,
): Promise<LocalPreprocessResult> {
  const threshold = input.compressOverChars ?? 4_000;
  const maxItems = input.maxItems ?? 5;
  const maxRequestChars = input.maxRequestChars ?? 24_000;
  const now = (input.clock ?? (() => new Date()))().toISOString();

  const candidates = input.items
    .filter(
      (item) =>
        (COMPRESSIBLE_LAYERS as readonly string[]).includes(item.layer) &&
        !item.compacted &&
        item.content.length > threshold,
    )
    .sort((a, b) => b.content.length - a.content.length)
    .slice(0, maxItems);

  if (candidates.length === 0) {
    return { items: [...input.items], compressedItemIds: [], savedChars: 0 };
  }

  const replacements = new Map<string, ContextItem>();
  let savedChars = 0;
  for (const item of candidates) {
    input.onInferenceCall?.();
    const result = await input.inference({
      systemPrompt: PREPROCESS_SYSTEM_PROMPT,
      userPrompt: `Artifact "${item.title}" (${item.kind}):\n\n${item.content.slice(0, maxRequestChars)}`,
      jsonSchema: LOCAL_PREPROCESS_JSON_SCHEMA,
      schemaName: 'LOCAL_PREPROCESS',
    });
    if (!result.ok) continue; // Fall back to the original item.
    let summary: string;
    try {
      const parsed = JSON.parse(result.text) as { summary?: unknown; keyFindings?: unknown };
      const findings = Array.isArray(parsed.keyFindings)
        ? parsed.keyFindings.filter((entry): entry is string => typeof entry === 'string')
        : [];
      summary =
        typeof parsed.summary === 'string' && parsed.summary.length > 0
          ? [parsed.summary, ...findings.map((finding) => `- ${finding}`)].join('\n')
          : '';
    } catch {
      continue;
    }
    if (summary.length === 0 || summary.length >= item.content.length) continue;
    savedChars += item.content.length - summary.length;
    replacements.set(item.itemId, {
      ...item,
      itemId: `${item.itemId}-local-summary`,
      title: `${item.title} (locally compressed)`,
      content: summary,
      createdAt: now,
      compacted: true,
    });
  }

  return {
    items: input.items.map((item) => replacements.get(item.itemId) ?? item),
    compressedItemIds: [...replacements.keys()],
    savedChars,
  };
}
