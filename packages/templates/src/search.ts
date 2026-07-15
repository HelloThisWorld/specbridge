import type { TemplateCatalog, TemplateCatalogEntry } from './catalog.js';

/**
 * Deterministic local template search. Pure string matching over ID, display
 * name, description, and tags — no model, no network, no fuzzy scoring that
 * could reorder between runs. This is honest keyword search, not semantic
 * search.
 */

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

/** Ranking tiers, highest first. Token hits within a tier accumulate. */
const SCORE_EXACT_ID = 1000;
const SCORE_ID_PREFIX = 800;
const SCORE_EXACT_TAG = 600;
const SCORE_DISPLAY_NAME_TOKEN = 400;
const SCORE_DESCRIPTION_TOKEN = 200;

export interface TemplateSearchResult {
  entry: TemplateCatalogEntry;
  score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

export function clampSearchLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(Math.trunc(requested), MAX_SEARCH_LIMIT));
}

function scoreEntry(entry: TemplateCatalogEntry, query: string, queryTokens: string[]): number {
  const manifest = entry.pack.manifest;
  const id = entry.id.toLowerCase();
  const tags = (manifest?.tags ?? []).map((tag) => tag.toLowerCase());
  const displayTokens = tokenize(manifest?.displayName ?? '');
  const descriptionTokens = new Set(tokenize(manifest?.description ?? ''));

  let score = 0;
  if (id === query) score += SCORE_EXACT_ID;
  else if (id.startsWith(query)) score += SCORE_ID_PREFIX;

  for (const token of queryTokens) {
    if (tags.includes(token)) score += SCORE_EXACT_TAG;
    if (displayTokens.includes(token)) score += SCORE_DISPLAY_NAME_TOKEN;
    if (descriptionTokens.has(token)) score += SCORE_DESCRIPTION_TOKEN;
    // ID tokens beyond the whole-ID checks above: prefix hits on ID segments.
    if (token !== query && id.split('-').includes(token)) score += SCORE_ID_PREFIX / 2;
  }
  return score;
}

/**
 * Search the catalog. Results are sorted by score (descending), then by
 * qualified reference (ascending) so equal scores have a stable order.
 */
export function searchTemplates(
  catalog: TemplateCatalog,
  rawQuery: string,
  options: { limit?: number } = {},
): TemplateSearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return [];
  const queryTokens = tokenize(query);
  const limit = clampSearchLimit(options.limit);

  return catalog.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query, queryTokens) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => (a.score !== b.score ? b.score - a.score : a.entry.ref.localeCompare(b.entry.ref, 'en')))
    .slice(0, limit);
}
