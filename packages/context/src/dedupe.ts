import { createHash } from 'node:crypto';
import type { ContextItem } from './items.js';
import { itemAuthority } from './items.js';
import { CONTEXT_AUTHORITY_RANK, isProtectedLayer } from './vocabulary.js';
import type { ContextAuthority } from './vocabulary.js';

/**
 * Authority-aware deduplication.
 *
 * The same fact reaches a context package by several routes: a file read
 * twice, a checkpoint fact also present in compacted history, a diff sent
 * both raw and as a narrative summary, an architecture rule injected by two
 * builders. Every duplicate is paid for in full, and past two or three of
 * them the repetition also degrades the signal — a model that sees a rule
 * five times has no way to know it is one rule.
 *
 * The policy, stated once:
 *
 *   Keep the CANONICAL / highest-authority representation.
 *   Never merge conflicting facts into an invented compromise.
 *
 * That second half is the important one. When two items disagree, the
 * temptation is to synthesize a reconciled version; doing so would fabricate
 * a statement nothing in the system actually asserts. Instead the higher
 * authority survives verbatim and the drop is RECORDED, so a diagnostic can
 * say "an older model summary contradicted the current checkpoint and was
 * discarded" rather than silently shipping an average of the two.
 */

export interface DuplicateRecord {
  /** The item that was dropped. */
  itemId: string;
  /** The item it was a duplicate of. */
  supersededBy: string;
  /** Why: identical bytes, same source, or a lower-authority restatement. */
  kind: 'identical-content' | 'same-source' | 'lower-authority';
  authority: ContextAuthority;
  /** Estimated characters saved by the drop. */
  savedChars: number;
}

export interface DedupeResult {
  items: ContextItem[];
  duplicates: DuplicateRecord[];
  savedChars: number;
}

/** Content identity for exact-duplicate detection. */
function contentDigest(item: ContextItem): string {
  return createHash('sha256').update(item.content).digest('hex').slice(0, 32);
}

/**
 * The identity of the underlying THING an item describes.
 *
 * A file path plus its content hash identifies one version of one file
 * regardless of who read it; a run reference identifies one verification
 * result; an explicit `dedupeKey` identifies whatever the caller says it
 * does. Absent all three, an item is treated as unique — guessing that two
 * differently sourced items are "the same fact" is how deduplication starts
 * dropping information.
 */
function sourceIdentity(item: ContextItem): string | undefined {
  if (item.dedupeKey !== undefined) return `key:${item.dedupeKey}`;
  const provenance = item.provenance;
  if (provenance?.path !== undefined) {
    const range =
      provenance.startLine !== undefined ? `#${provenance.startLine}-${provenance.endLine ?? ''}` : '';
    return `path:${provenance.path}${range}`;
  }
  if (provenance?.artifactRefs !== undefined && provenance.artifactRefs.length > 0) {
    return `artifact:${[...provenance.artifactRefs].sort().join(',')}`;
  }
  return undefined;
}

/**
 * Whether `candidate` may replace `incumbent` as the survivor.
 *
 * Strictly higher authority wins. Equal authority breaks toward the LATER
 * item, because a later observation of the same source is the fresher one —
 * which is the same rule vNext.1 micro-compaction already applies to
 * `dedupeKey`, kept consistent here on purpose.
 */
function supersedes(candidate: ContextItem, incumbent: ContextItem): boolean {
  const candidateRank = CONTEXT_AUTHORITY_RANK[itemAuthority(candidate)];
  const incumbentRank = CONTEXT_AUTHORITY_RANK[itemAuthority(incumbent)];
  if (candidateRank !== incumbentRank) return candidateRank > incumbentRank;
  return true;
}

export interface DedupeOptions {
  /**
   * Also deduplicate across PROTECTED layers. Off by default: pinned and
   * durable items are assembled deterministically from canonical state, and
   * a duplicate there is a builder bug worth seeing rather than something to
   * quietly absorb.
   */
  includeProtectedLayers?: boolean | undefined;
}

/**
 * Deduplicate a context item list, keeping the highest-authority
 * representation of each distinct fact.
 *
 * Order-stable: surviving items keep their original relative order, so
 * deduplication never reshuffles a package and never changes the stable
 * prefix as a side effect.
 */
export function deduplicateItems(
  items: readonly ContextItem[],
  options: DedupeOptions = {},
): DedupeResult {
  const includeProtected = options.includeProtectedLayers === true;
  const duplicates: DuplicateRecord[] = [];
  /** identity → index of the current survivor in `survivors`. */
  const byContent = new Map<string, number>();
  const bySource = new Map<string, number>();
  const survivors: (ContextItem | undefined)[] = [];

  const drop = (
    dropped: ContextItem,
    supersededBy: ContextItem,
    kind: DuplicateRecord['kind'],
  ): void => {
    duplicates.push({
      itemId: dropped.itemId,
      supersededBy: supersededBy.itemId,
      kind,
      authority: itemAuthority(dropped),
      savedChars: dropped.content.length,
    });
  };

  for (const item of items) {
    if (!includeProtected && isProtectedLayer(item.layer)) {
      survivors.push(item);
      continue;
    }

    const digest = contentDigest(item);
    const identity = sourceIdentity(item);

    const contentIndex = byContent.get(digest);
    if (contentIndex !== undefined) {
      const incumbent = survivors[contentIndex];
      if (incumbent !== undefined) {
        // Byte-identical content: authority decides which copy stays, and
        // no information is lost either way.
        if (supersedes(item, incumbent)) {
          drop(incumbent, item, 'identical-content');
          survivors[contentIndex] = undefined;
          survivors.push(item);
          byContent.set(digest, survivors.length - 1);
          if (identity !== undefined) bySource.set(identity, survivors.length - 1);
        } else {
          drop(item, incumbent, 'identical-content');
        }
        continue;
      }
    }

    if (identity !== undefined) {
      const sourceIndex = bySource.get(identity);
      const incumbent = sourceIndex === undefined ? undefined : survivors[sourceIndex];
      if (sourceIndex !== undefined && incumbent !== undefined) {
        const sameBytes = contentDigest(incumbent) === digest;
        const kind: DuplicateRecord['kind'] = sameBytes ? 'same-source' : 'lower-authority';
        if (supersedes(item, incumbent)) {
          drop(incumbent, item, kind);
          survivors[sourceIndex] = undefined;
          survivors.push(item);
          bySource.set(identity, survivors.length - 1);
          byContent.set(digest, survivors.length - 1);
        } else {
          drop(item, incumbent, kind);
        }
        continue;
      }
      bySource.set(identity, survivors.length);
    }

    byContent.set(digest, survivors.length);
    survivors.push(item);
  }

  const kept = survivors.filter((item): item is ContextItem => item !== undefined);
  return {
    items: kept,
    duplicates,
    savedChars: duplicates.reduce((sum, record) => sum + record.savedChars, 0),
  };
}
