import { Buffer } from 'node:buffer';
import { McpToolError } from './errors.js';

/**
 * Bounded inputs and outputs.
 *
 * Every potentially large tool response is paginated or truncated before
 * serialization, and every large input is rejected with `SBMCP018` before
 * any work happens. Truncation is always explicit: results state that they
 * were truncated and, for lists, return a continuation cursor.
 */

export const LIMITS = {
  /** Default page size for list tools. */
  defaultListLimit: 50,
  /** Maximum accepted page size for list tools. */
  maximumListLimit: 200,
  /** Maximum document content returned by read tools/resources (bytes). */
  maximumDocumentBytes: 1024 * 1024,
  /** Maximum accepted candidate Markdown input (bytes). */
  maximumCandidateBytes: 1024 * 1024,
  /** Maximum serialized structured response (bytes). */
  maximumStructuredResponseBytes: 2 * 1024 * 1024,
  /** Maximum diagnostics returned in one response. */
  maximumDiagnostics: 500,
  /** Maximum characters for spec_context output (default; caller may lower). */
  maximumContextCharacters: 200_000,
  /** Maximum summary / reason / instruction string inputs (characters). */
  maximumShortTextChars: 20_000,
} as const;

/** Clamp a requested list limit into [1, maximumListLimit]. */
export function clampListLimit(requested: number | undefined): number {
  if (requested === undefined) return LIMITS.defaultListLimit;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new McpToolError('SBMCP002', `limit must be a positive integer (got ${requested}).`);
  }
  return Math.min(requested, LIMITS.maximumListLimit);
}

/**
 * Offset-based pagination cursor. The cursor encodes the next offset plus a
 * stability token; a cursor from a different listing (or a tampered one) is
 * rejected instead of silently returning the wrong page.
 */
export interface DecodedCursor {
  offset: number;
  token: string;
}

export function encodeCursor(offset: number, token: string): string {
  return Buffer.from(JSON.stringify({ o: offset, t: token }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, expectedToken: string): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new McpToolError('SBMCP002', 'The cursor is not valid; restart the listing without a cursor.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { o?: unknown }).o !== 'number' ||
    typeof (parsed as { t?: unknown }).t !== 'string'
  ) {
    throw new McpToolError('SBMCP002', 'The cursor is not valid; restart the listing without a cursor.');
  }
  const { o, t } = parsed as { o: number; t: string };
  if (!Number.isInteger(o) || o < 0) {
    throw new McpToolError('SBMCP002', 'The cursor is not valid; restart the listing without a cursor.');
  }
  if (t !== expectedToken) {
    throw new McpToolError(
      'SBMCP002',
      'The cursor belongs to a different listing; restart the listing without a cursor.',
    );
  }
  return { offset: o, token: t };
}

export interface Page<T> {
  items: T[];
  truncated: boolean;
  nextCursor?: string;
  totalCount: number;
}

/** Slice one page out of a fully materialized list. */
export function paginate<T>(
  all: readonly T[],
  options: { limit?: number; cursor?: string; token: string },
): Page<T> {
  const limit = clampListLimit(options.limit);
  const offset = options.cursor !== undefined ? decodeCursor(options.cursor, options.token).offset : 0;
  const items = all.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const truncated = nextOffset < all.length;
  return {
    items: [...items],
    truncated,
    ...(truncated ? { nextCursor: encodeCursor(nextOffset, options.token) } : {}),
    totalCount: all.length,
  };
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

/** Truncate UTF-8 text to a byte budget on a character boundary. */
export function truncateText(text: string, maximumBytes: number): TruncatedText {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maximumBytes) {
    return { text, truncated: false, originalBytes };
  }
  const buffer = Buffer.from(text, 'utf8').subarray(0, maximumBytes);
  // Decode-then-strip the replacement character a cut multi-byte sequence
  // leaves behind, so truncated output is always valid UTF-8.
  const decoded = buffer.toString('utf8').replace(/�+$/u, '');
  return { text: decoded, truncated: true, originalBytes };
}

/** Cap a diagnostics list, reporting how many were dropped. */
export function capDiagnostics<T>(diagnostics: readonly T[]): { items: T[]; dropped: number } {
  if (diagnostics.length <= LIMITS.maximumDiagnostics) {
    return { items: [...diagnostics], dropped: 0 };
  }
  return {
    items: diagnostics.slice(0, LIMITS.maximumDiagnostics) as T[],
    dropped: diagnostics.length - LIMITS.maximumDiagnostics,
  };
}

/** Reject an oversized text input with SBMCP018 before doing any work. */
export function assertInputSize(field: string, value: string, maximumBytes: number): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) {
    throw new McpToolError(
      'SBMCP018',
      `${field} is too large: ${bytes} bytes (limit ${maximumBytes}).`,
      { remediation: [`Reduce ${field} below ${maximumBytes} bytes.`] },
    );
  }
}

/** Enforce the structured-response ceiling just before returning. */
export function assertStructuredSize(toolName: string, structured: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(structured), 'utf8');
  if (bytes > LIMITS.maximumStructuredResponseBytes) {
    throw new McpToolError(
      'SBMCP019',
      `The ${toolName} response is too large to return safely (${bytes} bytes; limit ${LIMITS.maximumStructuredResponseBytes}). ` +
        'Narrow the request (filters, limit, or a smaller document selection).',
    );
  }
}
