import type { ContextItem } from '@specbridge/context';
import { compressArtifact, isWorthCompressing } from '@specbridge/context';
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
 *   - compression failure never leaves a HOLE: when the local call is
 *     unavailable or unusable, the item falls back to the bounded
 *     deterministic view, and when even that found nothing to reduce, to the
 *     original item. A strong worker with a big log beats one missing the
 *     log; a worker with a bounded, source-referenced view beats both.
 *   - the local pass is itself bounded: at most `maxItems` items per call,
 *     each request capped by the local input budget
 *
 * This module is also the decomposition EXTENSION POINT: later phases add
 * further local supporting activities (file ranking, attempt-history
 * summarization) behind the same shape — bounded local passes that shrink
 * strong-lane context, never a multi-agent conversation.
 *
 * vNext.7 STRENGTHENS this rather than replacing it, on one principle:
 *
 *   deterministic extraction first; the local model only for the residue.
 *
 * A test log, a compiler run, a lint report, and a diff are structured, and
 * parsing them is faster, cheaper, reproducible, and — unlike a summary —
 * incapable of quietly dropping the one line the next attempt needed. So
 * every candidate now goes through the deterministic compressors first, and
 * a local inference call happens ONLY where parsing found no structure and
 * bulk remains. That ordering typically removes most of the model calls this
 * pass used to make, and it makes the results replayable.
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
  /** Items reduced by deterministic parsing (no model call was made). */
  deterministicCompressions: number;
  /** Items that needed a bounded local inference call. */
  localCompressions: number;
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
    return {
      items: [...input.items],
      compressedItemIds: [],
      savedChars: 0,
      deterministicCompressions: 0,
      localCompressions: 0,
    };
  }

  const replacements = new Map<string, ContextItem>();
  let savedChars = 0;
  let deterministicCount = 0;
  let localCount = 0;
  for (const item of candidates) {
    // 1. Deterministic structured compression. Reproducible, free, and
    //    identity-preserving: the failing test names, error codes, locations,
    //    and repetition counts a fingerprint depends on survive verbatim.
    const structural = compressArtifact({ kind: item.kind, content: item.content, minChars: threshold });
    if (structural !== undefined && structural.structured && structural.text.length < item.content.length) {
      savedChars += item.content.length - structural.text.length;
      deterministicCount += 1;
      replacements.set(item.itemId, {
        ...item,
        itemId: `${item.itemId}-compressed`,
        title: `${item.title} (structurally compressed)`,
        content: structural.text,
        createdAt: now,
        compacted: true,
        compression: {
          method: structural.method,
          sourceBytes: structural.sourceBytes,
          compressedBytes: structural.compressedBytes,
          sourceHashes: [structural.sourceHash],
          sourceRefs: item.source !== undefined ? [item.source] : [],
          createdAt: now,
        },
      });
      continue;
    }

    // 2. Unstructured bulk the parsers could not READ. The extractors found
    //    no test names, no error codes, no diff structure — only a bounded
    //    fallback view. That is precisely the case a language model is
    //    better at than a regular expression, and it is the only case worth
    //    spending local compute on.
    //
    //    `structuralFallback` is kept as the safety net: if the local call
    //    is unavailable, times out, or returns something unusable, the
    //    bounded deterministic view is still better than shipping the raw
    //    bulk, and far better than dropping the item.
    const structuralFallback =
      structural !== undefined && structural.text.length < item.content.length ? structural : undefined;
    const useFallback = (): void => {
      if (structuralFallback === undefined) return;
      savedChars += item.content.length - structuralFallback.text.length;
      deterministicCount += 1;
      replacements.set(item.itemId, {
        ...item,
        itemId: `${item.itemId}-compressed`,
        title: `${item.title} (structurally compressed)`,
        content: structuralFallback.text,
        createdAt: now,
        compacted: true,
        compression: {
          method: structuralFallback.method,
          sourceBytes: structuralFallback.sourceBytes,
          compressedBytes: structuralFallback.compressedBytes,
          sourceHashes: [structuralFallback.sourceHash],
          sourceRefs: item.source !== undefined ? [item.source] : [],
          createdAt: now,
        },
      });
    };
    // The decision to call the model is made on the ORIGINAL size, not on
    // the fallback's: a 30 KB artifact the parsers could not read is exactly
    // what this pass is for, however small its bounded view happens to be.
    if (!isWorthCompressing(item.content, threshold)) {
      useFallback();
      continue;
    }

    localCount += 1;
    input.onInferenceCall?.();
    const result = await input.inference({
      systemPrompt: PREPROCESS_SYSTEM_PROMPT,
      userPrompt: `Artifact "${item.title}" (${item.kind}):\n\n${item.content.slice(0, maxRequestChars)}`,
      jsonSchema: LOCAL_PREPROCESS_JSON_SCHEMA,
      schemaName: 'LOCAL_PREPROCESS',
    });
    if (!result.ok) {
      // The local lane is unavailable. The bounded deterministic view still
      // beats the raw bulk, and a strong worker with a compact view beats one
      // with a hole in its context.
      localCount -= 1;
      useFallback();
      continue;
    }
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
      localCount -= 1;
      useFallback();
      continue;
    }
    if (summary.length === 0 || summary.length >= item.content.length) {
      localCount -= 1;
      useFallback();
      continue;
    }
    savedChars += item.content.length - summary.length;
    replacements.set(item.itemId, {
      ...item,
      itemId: `${item.itemId}-local-summary`,
      title: `${item.title} (locally compressed)`,
      content: summary,
      createdAt: now,
      compacted: true,
      // Compression is DERIVED data: the record names what it came from so
      // the canonical raw artifact stays retrievable. A local summary is
      // never the only copy of critical evidence.
      compression: {
        method: 'local-model-v1',
        sourceBytes: Buffer.byteLength(item.content, 'utf8'),
        compressedBytes: Buffer.byteLength(summary, 'utf8'),
        sourceHashes: structural !== undefined ? [structural.sourceHash] : [],
        sourceRefs: item.source !== undefined ? [item.source] : [],
        createdAt: now,
      },
    });
  }

  return {
    items: input.items.map((item) => replacements.get(item.itemId) ?? item),
    compressedItemIds: [...replacements.keys()],
    savedChars,
    deterministicCompressions: deterministicCount,
    localCompressions: localCount,
  };
}
