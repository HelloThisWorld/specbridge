import { Buffer } from 'node:buffer';

/**
 * Safe bounded HTTP client for model-API runners (v0.6).
 *
 * Guarantees:
 *   - total request timeout (connect + headers + body)
 *   - AbortSignal cancellation (no request outlives its caller)
 *   - response size limit enforced while STREAMING (the connection is
 *     aborted at the limit; an oversized body is never buffered)
 *   - redirects are never followed (a redirect is a failure — a model
 *     endpoint must answer directly, not send data elsewhere)
 *   - no credentials in URLs (validated before any request is built)
 *   - errors are safe messages, never raw provider payload dumps
 */

export interface SafeHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  /** JSON body (POST only). */
  body?: unknown;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  /** Expected content type (substring match, e.g. "application/json"). */
  expectJson?: boolean;
}

export type SafeHttpFailureKind =
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  | 'redirect-rejected'
  | 'response-too-large'
  | 'invalid-content-type'
  | 'http-error';

export type SafeHttpResult =
  | {
      ok: true;
      status: number;
      bodyText: string;
      bodyBytes: number;
      durationMs: number;
    }
  | {
      ok: false;
      kind: SafeHttpFailureKind;
      /** Present for http-error responses. */
      status?: number;
      /** Safe, bounded diagnostic message. */
      detail: string;
      durationMs: number;
      /** Bounded response body excerpt for http-error diagnostics. */
      bodyExcerpt?: string;
    };

function composeSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (external !== undefined) signals.push(external);
  return AbortSignal.any(signals);
}

/** Read a body stream up to the limit; abort the connection beyond it. */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number } | 'too-large'> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? 'too-large' : { text, bytes: Buffer.byteLength(text, 'utf8') };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return 'too-large';
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: total };
}

/** One bounded HTTP request. Never throws for transport-level failures. */
export async function safeHttpRequest(request: SafeHttpRequest): Promise<SafeHttpResult> {
  const started = Date.now();
  const duration = (): number => Math.max(0, Date.now() - started);
  const externalAborted = (): boolean => request.signal?.aborted === true;

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      redirect: 'manual',
      signal: composeSignals(request.timeoutMs, request.signal),
      ...(request.body !== undefined
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request.body),
          }
        : {}),
    });
  } catch (cause) {
    if (externalAborted()) {
      return { ok: false, kind: 'cancelled', detail: 'the request was cancelled', durationMs: duration() };
    }
    if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      return {
        ok: false,
        kind: 'timeout',
        detail: `the request did not complete within ${request.timeoutMs} ms`,
        durationMs: duration(),
      };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      kind: 'unreachable',
      detail: `the endpoint could not be reached (${message.slice(0, 300)})`,
      durationMs: duration(),
    };
  }

  // Redirects are rejected outright: following one could send spec content
  // to a different host than the one the user configured.
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      kind: 'redirect-rejected',
      status: response.status,
      detail: `the endpoint answered with a redirect (${response.status}); redirects are never followed`,
      durationMs: duration(),
    };
  }

  let body: { text: string; bytes: number } | 'too-large';
  try {
    body = await readBounded(response, request.maxResponseBytes);
  } catch (cause) {
    if (externalAborted()) {
      return { ok: false, kind: 'cancelled', detail: 'the request was cancelled', durationMs: duration() };
    }
    if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      return {
        ok: false,
        kind: 'timeout',
        detail: `the response body did not complete within ${request.timeoutMs} ms`,
        durationMs: duration(),
      };
    }
    return {
      ok: false,
      kind: 'unreachable',
      detail: `the response body could not be read (${cause instanceof Error ? cause.message.slice(0, 300) : 'unknown error'})`,
      durationMs: duration(),
    };
  }
  if (body === 'too-large') {
    return {
      ok: false,
      kind: 'response-too-large',
      status: response.status,
      detail: `the response exceeded the configured limit of ${request.maxResponseBytes} bytes and was aborted`,
      durationMs: duration(),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: 'http-error',
      status: response.status,
      detail: `the endpoint answered HTTP ${response.status}`,
      durationMs: duration(),
      bodyExcerpt: body.text.slice(0, 500),
    };
  }

  if (request.expectJson === true) {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        kind: 'invalid-content-type',
        status: response.status,
        detail: `expected application/json but the endpoint answered "${contentType.slice(0, 100) || '(none)'}"`,
        durationMs: duration(),
      };
    }
  }

  return {
    ok: true,
    status: response.status,
    bodyText: body.text,
    bodyBytes: body.bytes,
    durationMs: duration(),
  };
}
