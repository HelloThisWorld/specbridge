import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertInsideWorkspace, readJsonFile } from '@specbridge/core';
import type { RepositoryIndex, RepositoryFileFact } from './repository.js';

export interface RetrievedContext {
  path: string;
  score: number;
  reasons: string[];
  excerpt: string;
}

export interface RetrievalOptions {
  rootDir: string;
  query: string;
  limit?: number;
  maxExcerptChars?: number;
}

function queryTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_.@/-]+/)
        .filter((token) => token.length >= 3),
    ),
  ];
}

function scoreFact(fact: RepositoryFileFact, tokens: string[]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const lowerPath = fact.path.toLowerCase();
  for (const token of tokens) {
    if (lowerPath.includes(token)) {
      score += 8;
      reasons.push(`path:${token}`);
    }
    if (fact.exports.some((item) => item.toLowerCase().includes(token))) {
      score += 6;
      reasons.push(`symbol:${token}`);
    }
    if (fact.imports.some((item) => item.toLowerCase().includes(token))) {
      score += 3;
      reasons.push(`dependency:${token}`);
    }
    if (fact.tokens.includes(token)) score += 1;
  }
  if (fact.isTest && tokens.some((token) => lowerPath.includes(token))) {
    score += 2;
    reasons.push('related-test');
  }
  return { score, reasons: [...new Set(reasons)] };
}

function excerpt(rootDir: string, fact: RepositoryFileFact, maxChars: number): string {
  if (fact.bytes > 512 * 1024) return '';
  try {
    const content = readFileSync(assertInsideWorkspace(rootDir, fact.path), 'utf8');
    return content.slice(0, maxChars);
  } catch {
    return '';
  }
}

export function retrieveRepositoryContext(
  index: RepositoryIndex,
  options: RetrievalOptions,
): RetrievedContext[] {
  const tokens = queryTokens(options.query);
  const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
  const maxChars = Math.max(200, Math.min(options.maxExcerptChars ?? 4_000, 20_000));
  return index.files
    .map((fact) => ({ fact, ...scoreFact(fact, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.fact.path.localeCompare(b.fact.path))
    .slice(0, limit)
    .map((entry) => ({
      path: entry.fact.path,
      score: entry.score,
      reasons: entry.reasons,
      excerpt: excerpt(options.rootDir, entry.fact, maxChars),
    }));
}

export function readRepositoryIndex(rootDir: string): RepositoryIndex {
  return readJsonFile<RepositoryIndex>(
    assertInsideWorkspace(rootDir, path.join('.specbridge', 'repository', 'index.json')),
  );
}
