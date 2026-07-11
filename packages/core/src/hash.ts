import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ioError } from './errors.js';

/**
 * Approval hashing. Hashes are always computed over the exact file bytes —
 * never over decoded or normalized text — so CRLF/LF, BOMs, and trailing
 * newlines all participate. A one-byte change is a different document.
 */

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of a file's exact bytes. Throws `IO_ERROR` when unreadable. */
export function sha256File(filePath: string): string {
  try {
    return sha256Hex(readFileSync(filePath));
  } catch (cause) {
    throw ioError('hash', filePath, cause);
  }
}

/** SHA-256 of a file's exact bytes, or `undefined` when the file is missing/unreadable. */
export function trySha256File(filePath: string): string | undefined {
  try {
    return sha256Hex(readFileSync(filePath));
  } catch {
    return undefined;
  }
}
