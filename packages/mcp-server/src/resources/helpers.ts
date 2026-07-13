import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerContext } from '../context.js';
import { LIMITS, truncateText } from '../limits.js';

/**
 * Shared resource plumbing: bounded UTF-8 text contents, JSON contents,
 * clear not-found errors, and resource_read logging. Resource read failures
 * surface as protocol-level errors by SDK design; messages stay actionable
 * and never include stack traces.
 */

export function resourceNotFound(what: string, remediation: string): Error {
  return new Error(`${what} was not found. ${remediation}`);
}

export function markdownContents(
  context: ServerContext,
  uri: string,
  text: string,
): ReadResourceResult {
  context.logger.info('resource_read', { resource: uri });
  const bounded = truncateText(text, LIMITS.maximumDocumentBytes);
  return {
    contents: [
      {
        uri,
        mimeType: 'text/markdown',
        text: bounded.truncated
          ? `${bounded.text}\n\n[content truncated at ${LIMITS.maximumDocumentBytes} bytes]\n`
          : bounded.text,
      },
    ],
  };
}

export function jsonContents(
  context: ServerContext,
  uri: string,
  value: unknown,
): ReadResourceResult {
  context.logger.info('resource_read', { resource: uri });
  const serialized = JSON.stringify(value, null, 2);
  const bounded = truncateText(serialized, LIMITS.maximumStructuredResponseBytes);
  // Never emit invalid JSON: when over budget, return a small JSON notice
  // instead of a truncated (broken) document.
  const text = bounded.truncated
    ? JSON.stringify(
        {
          truncated: true,
          message: `The resource exceeded ${LIMITS.maximumStructuredResponseBytes} bytes; use the paginated tools instead.`,
        },
        null,
        2,
      )
    : serialized;
  return { contents: [{ uri, mimeType: 'application/json', text }] };
}

/** Reject template variables that smuggle path syntax. */
export function assertPlainName(kind: string, value: string): string {
  const decoded = decodeURIComponent(value);
  if (
    decoded.length === 0 ||
    decoded.length > 255 ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.includes('..')
  ) {
    throw new Error(`Invalid ${kind} "${decoded}": names must be plain identifiers, never paths.`);
  }
  return decoded;
}
