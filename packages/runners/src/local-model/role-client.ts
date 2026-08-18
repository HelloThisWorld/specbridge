import { buildOpenAiRequestBody, parseOpenAiResponse, indicatesStructuredOutputUnsupported } from '../openai-compatible/client.js';
import { safeHttpRequest } from '../shared/http-client.js';

/**
 * Structured inference over the managed local endpoint.
 *
 * Transport only: this module sends one bounded chat-completions request
 * with a JSON Schema response format and returns the COMPLETE assistant
 * text plus usage. Contract validation (which schema, what the fields mean,
 * correction retries, escalation) belongs to the orchestration layer — the
 * same endpoint serves every logical role without this file knowing what a
 * "planner" is.
 *
 * Reuses the existing OpenAI-compatible request/response shapes and the
 * safe HTTP client: one HTTP stack, one redaction path, one set of bounds.
 */

export interface LocalStructuredRequest {
  /** The managed endpoint base URL (e.g. http://127.0.0.1:8080/v1). */
  baseUrl: string;
  systemPrompt: string;
  userPrompt: string;
  /** JSON Schema for constrained decoding; also validated by the caller. */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  temperature: number;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal | undefined;
}

export type LocalStructuredFailureKind =
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  | 'http-error'
  | 'response-too-large'
  | 'invalid-response'
  | 'empty-response';

export type LocalStructuredResult =
  | {
      ok: true;
      /** The complete assistant text (the caller validates it as a whole). */
      text: string;
      usage?: { inputTokens: number | null; outputTokens: number | null };
      durationMs: number;
      /** True when the endpoint rejected json-schema and json-object was used. */
      downgradedStructuredOutput: boolean;
    }
  | { ok: false; kind: LocalStructuredFailureKind; problem: string; durationMs: number };

async function requestOnce(
  request: LocalStructuredRequest,
  structuredOutput: 'json-schema' | 'json-object',
): Promise<
  | { kind: 'ok'; text: string; usage?: { inputTokens: number | null; outputTokens: number | null }; durationMs: number }
  | { kind: 'schema-unsupported'; durationMs: number }
  | { kind: 'failed'; failure: LocalStructuredFailureKind; problem: string; durationMs: number }
> {
  const body = buildOpenAiRequestBody('chat-completions', {
    // llama-server ignores the model name and answers with the loaded model.
    model: 'local',
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
    temperature: request.temperature,
    structuredOutput,
    jsonSchema: request.jsonSchema,
    schemaName: request.schemaName,
  });
  const result = await safeHttpRequest({
    method: 'POST',
    url: `${request.baseUrl.replace(/\/$/, '')}/chat/completions`,
    body,
    timeoutMs: request.timeoutMs,
    maxResponseBytes: request.maxOutputBytes,
    expectJson: true,
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });
  if (!result.ok) {
    if (
      result.kind === 'http-error' &&
      indicatesStructuredOutputUnsupported(result.status, result.bodyExcerpt)
    ) {
      return { kind: 'schema-unsupported', durationMs: result.durationMs };
    }
    const failure: LocalStructuredFailureKind =
      result.kind === 'timeout'
        ? 'timeout'
        : result.kind === 'cancelled'
          ? 'cancelled'
          : result.kind === 'response-too-large'
            ? 'response-too-large'
            : result.kind === 'http-error'
              ? 'http-error'
              : result.kind === 'invalid-content-type'
                ? 'invalid-response'
                : 'unreachable';
    return { kind: 'failed', failure, problem: result.detail, durationMs: result.durationMs };
  }
  const parsed = parseOpenAiResponse('chat-completions', result.bodyText);
  if (parsed.problem !== undefined || parsed.text === undefined) {
    return {
      kind: 'failed',
      failure: 'invalid-response',
      problem: parsed.problem ?? 'the response carries no assistant text',
      durationMs: result.durationMs,
    };
  }
  if (parsed.text.trim().length === 0) {
    return { kind: 'failed', failure: 'empty-response', problem: 'the assistant text is empty', durationMs: result.durationMs };
  }
  return {
    kind: 'ok',
    text: parsed.text,
    ...(parsed.usage !== undefined
      ? { usage: { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens } }
      : {}),
    durationMs: result.durationMs,
  };
}

/**
 * One bounded structured inference request.
 *
 * Tries native json-schema constrained decoding first; when the endpoint
 * explicitly rejects that mode, downgrades ONCE to json-object for this
 * request and reports the downgrade — the caller's schema validation is the
 * real gate either way, so the downgrade weakens generation guidance, never
 * acceptance criteria.
 */
export async function localStructuredInference(
  request: LocalStructuredRequest,
): Promise<LocalStructuredResult> {
  const first = await requestOnce(request, 'json-schema');
  if (first.kind === 'ok') {
    return {
      ok: true,
      text: first.text,
      ...(first.usage !== undefined ? { usage: first.usage } : {}),
      durationMs: first.durationMs,
      downgradedStructuredOutput: false,
    };
  }
  if (first.kind === 'schema-unsupported') {
    const second = await requestOnce(request, 'json-object');
    if (second.kind === 'ok') {
      return {
        ok: true,
        text: second.text,
        ...(second.usage !== undefined ? { usage: second.usage } : {}),
        durationMs: first.durationMs + second.durationMs,
        downgradedStructuredOutput: true,
      };
    }
    const problem =
      second.kind === 'schema-unsupported'
        ? 'the endpoint rejected both json-schema and json-object response formats'
        : second.problem;
    return {
      ok: false,
      kind: second.kind === 'failed' ? second.failure : 'http-error',
      problem,
      durationMs: first.durationMs + second.durationMs,
    };
  }
  return { ok: false, kind: first.failure, problem: first.problem, durationMs: first.durationMs };
}
