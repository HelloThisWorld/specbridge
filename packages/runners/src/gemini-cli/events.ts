import { z } from 'zod';
import type { NormalizedRunnerEvent, EventEnvelopeContext } from '../contracts/events.js';
import { boundedPayloadText, normalizedRunnerEventSchema } from '../contracts/events.js';
import type { RunnerUsage } from '../contracts/usage.js';

/**
 * Gemini CLI machine-readable output parsing and normalization (v0.6.1).
 *
 * Two documented shapes are supported:
 *   - `--output-format stream-json`: JSON Lines, one event per line, ending
 *     in a `result` event carrying the final response text
 *   - `--output-format json`: one JSON envelope `{response, stats}`
 *
 * Parsing is tolerant — unknown event types are retained (size-limited) but
 * only well-understood shapes are normalized.
 *
 * Reasoning boundary: `thought` events are provider thinking output. Their
 * text is NEVER copied into normalized events, reports, or retained raw
 * output; only the fact that a thought occurred (and its size) is kept.
 */

/** Hard cap on retained raw/normalized events per invocation. */
export const MAX_RETAINED_GEMINI_EVENTS = 5000;

const geminiEventSchema = z
  .object({
    type: z.string(),
    session_id: z.string().optional(),
    text: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    path: z.string().optional(),
    kind: z.string().optional(),
    command: z.string().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cached_input_tokens: z.number().optional(),
    response: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
export type GeminiEvent = z.infer<typeof geminiEventSchema>;

/** The single-envelope `--output-format json` shape. */
export const geminiJsonEnvelopeSchema = z
  .object({
    response: z.string(),
    stats: z
      .object({
        session_id: z.string().optional(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cached_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GeminiJsonEnvelope = z.infer<typeof geminiJsonEnvelopeSchema>;

export interface GeminiEventStream {
  /** Parsed provider events, in order (capped at MAX_RETAINED_GEMINI_EVENTS). */
  events: GeminiEvent[];
  /** Lines that did not parse as JSON objects (count only; content unsafe). */
  unparseableLines: number;
  truncated: boolean;
  sessionId?: string;
  /** The `result` event response text — the structured-result candidate. */
  finalResponse?: string;
  usage?: Omit<RunnerUsage, 'durationMs' | 'model' | 'requestCount'> & { requestCount: number };
  /** error event messages, bounded. */
  errors: string[];
}

/** Parse a `--output-format stream-json` stdout stream. Never throws. */
export function parseGeminiEventStream(stdout: string): GeminiEventStream {
  const stream: GeminiEventStream = {
    events: [],
    unparseableLines: 0,
    truncated: false,
    errors: [],
  };
  let inputTokens: number | null = null;
  let cachedInputTokens: number | null = null;
  let outputTokens: number | null = null;
  let requests = 0;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      stream.unparseableLines += 1;
      continue;
    }
    const event = geminiEventSchema.safeParse(parsed);
    if (!event.success) {
      stream.unparseableLines += 1;
      continue;
    }
    if (stream.events.length < MAX_RETAINED_GEMINI_EVENTS) {
      stream.events.push(event.data);
    } else {
      stream.truncated = true;
    }

    const data = event.data;
    if (data.type === 'session.started' && data.session_id !== undefined) {
      stream.sessionId = data.session_id;
    }
    if (data.type === 'usage') {
      requests += 1;
      inputTokens = (inputTokens ?? 0) + (data.input_tokens ?? 0);
      cachedInputTokens = (cachedInputTokens ?? 0) + (data.cached_input_tokens ?? 0);
      outputTokens = (outputTokens ?? 0) + (data.output_tokens ?? 0);
    }
    if (data.type === 'result' && data.response !== undefined) {
      stream.finalResponse = data.response;
    }
    if (data.type === 'error') {
      const message = data.message ?? data.text;
      if (message !== undefined && stream.errors.length < 20) {
        stream.errors.push(boundedPayloadText(message, 500));
      }
    }
  }

  if (requests > 0 || inputTokens !== null || outputTokens !== null) {
    stream.usage = {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens: null,
      requestCount: Math.max(1, requests),
    };
  }
  return stream;
}

/**
 * Redact thought content from a raw JSONL stdout stream before it is
 * retained as a run artifact. Parsing happens BEFORE this: the retained
 * bytes keep every event's structure but thought text is replaced with a
 * length marker — only safe status metadata for reasoning is ever kept.
 */
export function redactGeminiStdoutForRetention(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.includes('"thought"')) return line;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string; text?: string };
        if (parsed.type === 'thought' && typeof parsed.text === 'string') {
          parsed.text = `[redacted reasoning: ${parsed.text.length} chars]`;
          return JSON.stringify(parsed);
        }
      } catch {
        // Not JSON — leave the line untouched.
      }
      return line;
    })
    .join('\n');
}

/**
 * Normalize parsed Gemini events. Thought events become `message.completed`
 * with a redacted payload — their content is intentionally absent.
 */
export function normalizeGeminiEvents(
  stream: GeminiEventStream,
  context: EventEnvelopeContext,
  timestamp: () => string,
): NormalizedRunnerEvent[] {
  const normalized: NormalizedRunnerEvent[] = [];
  const push = (
    type: NormalizedRunnerEvent['type'],
    providerEventType: string,
    payload: Record<string, string | number | boolean | null>,
  ): void => {
    if (normalized.length >= MAX_RETAINED_GEMINI_EVENTS) return;
    normalized.push(
      normalizedRunnerEventSchema.parse({
        type,
        timestamp: timestamp(),
        runner: context.runner,
        profile: context.profile,
        runId: context.runId,
        attemptId: context.attemptId,
        ...(context.providerSessionId !== undefined || stream.sessionId !== undefined
          ? { providerSessionId: context.providerSessionId ?? stream.sessionId }
          : {}),
        providerEventType,
        payload,
      }),
    );
  };

  for (const event of stream.events) {
    switch (event.type) {
      case 'session.started':
        push('session.started', event.type, {
          ...(event.session_id !== undefined ? { sessionId: event.session_id } : {}),
        });
        break;
      case 'thought':
        // Reasoning content is never normalized — status metadata only.
        push('message.completed', event.type, {
          redacted: true,
          textLength: event.text?.length ?? 0,
        });
        break;
      case 'tool.started':
        push('tool.started', event.type, {
          ...(event.name !== undefined ? { tool: event.name } : {}),
          ...(event.path !== undefined ? { path: boundedPayloadText(event.path, 500) } : {}),
        });
        break;
      case 'tool.completed':
        push(
          event.status === 'failed' || event.status === 'denied' ? 'tool.failed' : 'tool.completed',
          event.type,
          {
            ...(event.name !== undefined ? { tool: event.name } : {}),
            ...(event.status !== undefined ? { status: event.status } : {}),
          },
        );
        break;
      case 'file.edited':
        push('file.changed', event.type, {
          ...(event.path !== undefined ? { path: boundedPayloadText(event.path, 500) } : {}),
          ...(event.kind !== undefined ? { kind: event.kind } : {}),
        });
        break;
      case 'usage':
        push('usage.updated', event.type, {
          inputTokens: event.input_tokens ?? null,
          cachedInputTokens: event.cached_input_tokens ?? null,
          outputTokens: event.output_tokens ?? null,
        });
        break;
      case 'result':
        push('message.completed', event.type, {
          textLength: event.response?.length ?? 0,
        });
        break;
      case 'error':
        push('error', event.type, {
          message: boundedPayloadText(event.message ?? event.text ?? 'error', 500),
        });
        break;
      default:
        break;
    }
  }
  return normalized;
}
