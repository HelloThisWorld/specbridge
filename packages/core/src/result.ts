import { SpecBridgeError } from './errors.js';

/**
 * Minimal discriminated-union result type for operations that want to report
 * recoverable failures without exceptions (e.g. tolerant parsing).
 */
export type Result<T, E = SpecBridgeError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  if (result.error instanceof Error) throw result.error;
  throw new SpecBridgeError('INVALID_STATE', `Unwrapped a failed result: ${String(result.error)}`);
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}
