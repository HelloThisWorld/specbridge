import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { EventEnvelopeContext, NormalizedRunnerEvent } from '../contracts/events.js';
import { boundedPayloadText, normalizedRunnerEventSchema } from '../contracts/events.js';
import type { RunnerUsage } from '../contracts/usage.js';
import type { DshNotification } from './sdk-adapter.js';

/**
 * DeepSeek Harness notification parsing, normalization, and redaction.
 *
 * The runtime streams `session.event` notifications carrying its append-only
 * session-log envelopes ({type, seq, time, data}), plus `session.status` and
 * `subagent.*` lifecycle notifications. Parsing is tolerant — unknown event
 * types are counted, well-understood shapes are normalized.
 *
 * Reasoning boundary (strict): `reasoning` content blocks, `reasoning-delta`
 * stream chunks, and any other thinking output are provider-private. Their
 * text is NEVER copied into normalized events, reports, or retained
 * artifacts — only the fact that reasoning occurred (and its size) is kept,
 * matching the Codex and Ollama adapters. Retained raw notifications are
 * deep-redacted before they are written anywhere.
 */

/** Tolerant envelope for one session-log event off the wire. */
const dshSessionEventSchema = z
  .object({
    type: z.string(),
    seq: z.number().int().nonnegative(),
    time: z.number(),
    data: z.record(z.unknown()).default({}),
  })
  .passthrough();
export type DshSessionEvent = z.infer<typeof dshSessionEventSchema>;

export interface DshParsedNotification {
  method: string;
  sessionId?: string | undefined;
  event?: DshSessionEvent | undefined;
  params: Record<string, unknown>;
}

/** Parse one notification tolerantly; never throws. */
export function parseDshNotification(notification: DshNotification): DshParsedNotification {
  const sessionId =
    typeof notification.params['sessionId'] === 'string'
      ? notification.params['sessionId']
      : undefined;
  if (notification.method !== 'session.event') {
    return { method: notification.method, sessionId, params: notification.params };
  }
  const parsed = dshSessionEventSchema.safeParse(notification.params['event']);
  return {
    method: notification.method,
    sessionId,
    event: parsed.success ? parsed.data : undefined,
    params: notification.params,
  };
}

/** Aggregated observations folded out of one run's notification stream. */
export interface DshRunCollection {
  /** First observed session-log seq of the root session (continuity evidence). */
  firstRootEventSeq?: number | undefined;
  /** Whether the runtime compacted its own working memory during the run. */
  nativeCompactionObserved: boolean;
  /** Turn-end failure messages (bounded), for failure classification. */
  errors: string[];
  /** True when some turn ended with the `max-tokens` reason. */
  sawMaxTokens: boolean;
  /** Effective provider/model from `request/context`, when the runtime logged it. */
  effectiveProvider?: string | undefined;
  effectiveModel?: string | undefined;
  /** Token accounting summed over every assistant/message that reported it. */
  usage?: Omit<RunnerUsage, 'durationMs' | 'model'> | undefined;
  /** Count of parsed session events by unknown/known (diagnostic only). */
  unparseableEvents: number;
}

function tolerantCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fold the notification stream into bounded, safe aggregate observations. */
export function collectDshRun(
  notifications: readonly DshNotification[],
  rootSessionId: string,
): DshRunCollection {
  const collection: DshRunCollection = {
    nativeCompactionObserved: false,
    errors: [],
    sawMaxTokens: false,
    unparseableEvents: 0,
  };
  let inputTokens: number | null = null;
  let cachedInputTokens: number | null = null;
  let outputTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let requests = 0;

  for (const notification of notifications) {
    const parsed = parseDshNotification(notification);
    if (parsed.method !== 'session.event') continue;
    if (parsed.event === undefined) {
      collection.unparseableEvents += 1;
      continue;
    }
    const event = parsed.event;
    if (parsed.sessionId === rootSessionId && collection.firstRootEventSeq === undefined) {
      collection.firstRootEventSeq = event.seq;
    }
    switch (event.type) {
      case 'compaction/end':
      case 'compaction/prune':
        collection.nativeCompactionObserved = true;
        break;
      case 'turn/end': {
        const reason = event.data['reason'];
        const kind = isRecord(reason) ? reason['kind'] : undefined;
        if (kind === 'max-tokens') collection.sawMaxTokens = true;
        if (kind === 'error' && collection.errors.length < 20) {
          const failure = isRecord(reason) ? reason['error'] : undefined;
          const message = isRecord(failure) && typeof failure['message'] === 'string'
            ? failure['message']
            : 'turn failed';
          const code = isRecord(failure) && typeof failure['code'] === 'string'
            ? ` [${failure['code']}]`
            : '';
          collection.errors.push(boundedPayloadText(`${message}${code}`, 500));
        }
        break;
      }
      case 'request/context': {
        const provider = event.data['provider'];
        const model = event.data['model'];
        if (typeof provider === 'string' && provider.length > 0) {
          collection.effectiveProvider = provider;
        }
        if (typeof model === 'string' && model.length > 0) {
          collection.effectiveModel = model;
        }
        break;
      }
      case 'assistant/message': {
        const usage = event.data['usage'];
        if (isRecord(usage)) {
          requests += 1;
          const input = tolerantCount(usage['inputTokens']);
          const cached = tolerantCount(usage['cacheReadTokens']);
          const output = tolerantCount(usage['outputTokens']);
          const reasoning = tolerantCount(usage['reasoningTokens']);
          if (input !== undefined) inputTokens = (inputTokens ?? 0) + input;
          if (cached !== undefined) cachedInputTokens = (cachedInputTokens ?? 0) + cached;
          if (output !== undefined) outputTokens = (outputTokens ?? 0) + output;
          if (reasoning !== undefined) reasoningTokens = (reasoningTokens ?? 0) + reasoning;
        }
        break;
      }
      default:
        break;
    }
  }

  if (requests > 0 || inputTokens !== null || outputTokens !== null) {
    collection.usage = {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      requestCount: requests,
    };
  }
  return collection;
}

/** Reasoning metadata for one assistant message: sizes only, never content. */
function assistantMessagePayload(
  event: DshSessionEvent,
): Record<string, string | number | boolean | null> {
  const payload: Record<string, string | number | boolean | null> = {};
  const message = event.data['message'];
  let textChars = 0;
  let reasoningParts = 0;
  let reasoningChars = 0;
  if (isRecord(message) && Array.isArray(message['content'])) {
    for (const block of message['content']) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        textChars += block['text'].length;
      }
      if (block['type'] === 'reasoning') {
        reasoningParts += 1;
        if (typeof block['text'] === 'string') reasoningChars += block['text'].length;
      }
    }
  }
  payload['textChars'] = textChars;
  if (reasoningParts > 0) {
    // Status metadata ONLY — reasoning content is never normalized.
    payload['reasoningRedacted'] = true;
    payload['reasoningParts'] = reasoningParts;
    payload['reasoningChars'] = reasoningChars;
  }
  if (event.data['interrupted'] === true) payload['interrupted'] = true;
  return payload;
}

/**
 * Normalize the parsed notification stream into bounded, provider-neutral
 * runner events. Reasoning content is intentionally absent — see the module
 * header. Timestamps derive from the runtime's own event clock so the
 * normalized record is deterministic for a given stream.
 */
export function normalizeDshEvents(
  notifications: readonly DshNotification[],
  rootSessionId: string,
  context: EventEnvelopeContext,
  fallbackTimestamp: () => string,
): NormalizedRunnerEvent[] {
  const normalized: NormalizedRunnerEvent[] = [];
  const push = (
    type: NormalizedRunnerEvent['type'],
    providerEventType: string,
    payload: Record<string, string | number | boolean | null>,
    at?: number,
  ): void => {
    if (normalized.length >= 5000) return;
    normalized.push(
      normalizedRunnerEventSchema.parse({
        type,
        timestamp:
          at !== undefined && Number.isFinite(at)
            ? new Date(at).toISOString()
            : fallbackTimestamp(),
        runner: context.runner,
        profile: context.profile,
        runId: context.runId,
        attemptId: context.attemptId,
        providerSessionId: context.providerSessionId ?? rootSessionId,
        providerEventType,
        payload,
      }),
    );
  };

  let sessionStarted = false;
  for (const notification of notifications) {
    const parsed = parseDshNotification(notification);
    if (parsed.method === 'subagent.started') {
      push('tool.started', 'subagent.started', {
        subagent: boundedPayloadText(String(parsed.params['childSessionId'] ?? 'unknown'), 200),
      });
      continue;
    }
    if (parsed.method === 'subagent.finished') {
      const status = parsed.params['status'];
      push(status === 'error' ? 'tool.failed' : 'tool.completed', 'subagent.finished', {
        subagent: boundedPayloadText(String(parsed.params['childSessionId'] ?? 'unknown'), 200),
        status: typeof status === 'string' ? status : null,
      });
      continue;
    }
    if (parsed.method !== 'session.event' || parsed.event === undefined) continue;
    const event = parsed.event;
    const rootEvent = parsed.sessionId === rootSessionId;
    const provider = `session.event:${event.type}`;
    if (!sessionStarted && rootEvent) {
      sessionStarted = true;
      push('session.started', provider, { firstEventSeq: event.seq }, event.time);
    }
    if (!rootEvent && event.type !== 'assistant/message') continue;
    switch (event.type) {
      case 'turn/start':
        push('turn.started', provider, { turn: tolerantCount(event.data['turn']) ?? null }, event.time);
        break;
      case 'turn/end': {
        const reason = event.data['reason'];
        const kind = isRecord(reason) && typeof reason['kind'] === 'string' ? reason['kind'] : 'unknown';
        push('turn.completed', provider, { turn: tolerantCount(event.data['turn']) ?? null, reason: kind }, event.time);
        if (kind === 'error') {
          const failure = isRecord(reason) ? reason['error'] : undefined;
          push(
            'error',
            provider,
            {
              message: boundedPayloadText(
                isRecord(failure) && typeof failure['message'] === 'string'
                  ? failure['message']
                  : 'turn failed',
                500,
              ),
              ...(isRecord(failure) && typeof failure['code'] === 'string'
                ? { code: boundedPayloadText(failure['code'], 120) }
                : {}),
            },
            event.time,
          );
        }
        break;
      }
      case 'assistant/message': {
        push('message.completed', provider, {
          ...(rootEvent ? {} : { subagentSession: boundedPayloadText(parsed.sessionId ?? '?', 200) }),
          ...assistantMessagePayload(event),
        }, event.time);
        const usage = event.data['usage'];
        if (isRecord(usage)) {
          push('usage.updated', provider, {
            inputTokens: tolerantCount(usage['inputTokens']) ?? null,
            cachedInputTokens: tolerantCount(usage['cacheReadTokens']) ?? null,
            outputTokens: tolerantCount(usage['outputTokens']) ?? null,
            reasoningTokens: tolerantCount(usage['reasoningTokens']) ?? null,
          }, event.time);
        }
        break;
      }
      case 'tool/call':
        push('tool.started', provider, {
          tool: boundedPayloadText(String(event.data['name'] ?? 'unknown'), 200),
          argumentChars:
            typeof event.data['arguments'] === 'string' ? event.data['arguments'].length : null,
        }, event.time);
        break;
      case 'tool/result': {
        const error = event.data['error'];
        if (isRecord(error)) {
          push('tool.failed', provider, {
            errorName: boundedPayloadText(String(error['name'] ?? 'error'), 200),
            errorCode: boundedPayloadText(String(error['code'] ?? 'unknown'), 120),
          }, event.time);
        } else {
          push('tool.completed', provider, {}, event.time);
        }
        break;
      }
      case 'command/run':
        push('command.started', provider, {
          ...(typeof event.data['command'] === 'string'
            ? { command: boundedPayloadText(event.data['command'], 500) }
            : {}),
        }, event.time);
        break;
      case 'command/done':
        push('command.completed', provider, {
          ...(tolerantCount(event.data['exitCode']) !== undefined
            ? { exitCode: tolerantCount(event.data['exitCode']) ?? null }
            : {}),
        }, event.time);
        break;
      case 'todo/write':
        push('plan.updated', provider, {
          todoCount: Array.isArray(event.data['todos']) ? event.data['todos'].length : null,
        }, event.time);
        break;
      case 'compaction/end':
      case 'compaction/prune':
        // Attempt-local working-memory optimization, observed and recorded —
        // never canonical state and never a SpecBridge checkpoint.
        push('compaction.occurred', provider, { kind: event.type }, event.time);
        break;
      default:
        break;
    }
  }
  return normalized;
}

/** Deep-redact reasoning and prompt material from one JSON-ish value. */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isRecord(value)) return value;
  const type = value['type'];
  if (
    (type === 'reasoning' || type === 'reasoning-delta') &&
    typeof value['text'] === 'string'
  ) {
    return { ...value, text: `[redacted reasoning: ${value['text'].length} chars]` };
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = redactValue(child);
  }
  return out;
}

/**
 * Serialize notifications for retention as one JSON-lines artifact:
 *   - reasoning/thinking content is replaced by a length marker;
 *   - `request/header` payloads (system prompt, tool schemas) are elided;
 *   - the byte budget is enforced with an explicit truncation marker.
 * This is the ONLY form in which raw DSH output is retained by SpecBridge.
 */
export function redactDshNotificationsForRetention(
  notifications: readonly DshNotification[],
  maxBytes: number,
): string {
  const lines: string[] = [];
  let bytes = 0;
  let truncatedAt = -1;
  for (let index = 0; index < notifications.length; index++) {
    const notification = notifications[index];
    if (notification === undefined) continue;
    let value: unknown = notification;
    const parsed = parseDshNotification(notification);
    if (parsed.event?.type === 'request/header') {
      value = {
        method: notification.method,
        params: {
          sessionId: parsed.sessionId ?? null,
          event: {
            type: parsed.event.type,
            seq: parsed.event.seq,
            time: parsed.event.time,
            data: '[request header elided: system prompt and tool schemas are not retained]',
          },
        },
      };
    } else {
      value = redactValue(notification);
    }
    const line = JSON.stringify(value);
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + lineBytes > maxBytes) {
      truncatedAt = index;
      break;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  if (truncatedAt >= 0) {
    lines.push(
      JSON.stringify({
        method: 'specbridge/retention-truncated',
        params: { retained: truncatedAt, dropped: notifications.length - truncatedAt },
      }),
    );
  }
  return lines.join('\n');
}
