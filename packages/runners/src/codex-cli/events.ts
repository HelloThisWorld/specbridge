import { z } from 'zod';
import type { NormalizedRunnerEvent, EventEnvelopeContext } from '../contracts/events.js';
import { boundedPayloadText, normalizedRunnerEventSchema } from '../contracts/events.js';
import type { RunnerUsage } from '../contracts/usage.js';

/**
 * Codex CLI `--json` event-stream parsing and normalization.
 *
 * The stream is JSON Lines: one event object per line. Parsing is tolerant —
 * unknown event or item types are retained as raw events (size-limited) but
 * only well-understood shapes are normalized.
 *
 * Reasoning boundary: `reasoning` items are provider thinking output. Their
 * text is NEVER copied into normalized events or reports; only the fact that
 * a reasoning item occurred (and its size) is kept as status metadata.
 */

/** Hard cap on retained raw/normalized events per invocation. */
export const MAX_RETAINED_EVENTS = 5000;

const codexItemSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    text: z.string().optional(),
    command: z.string().optional(),
    exit_code: z.number().optional(),
    status: z.string().optional(),
    changes: z.array(z.object({ path: z.string().optional(), kind: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

const codexEventSchema = z
  .object({
    type: z.string(),
    thread_id: z.string().optional(),
    item: codexItemSchema.optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        cached_input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        reasoning_output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
    message: z.string().optional(),
  })
  .passthrough();
export type CodexEvent = z.infer<typeof codexEventSchema>;

export interface CodexEventStream {
  /** Parsed provider events, in order (capped at MAX_RETAINED_EVENTS). */
  events: CodexEvent[];
  /** Lines that did not parse as JSON objects (count only; content unsafe). */
  unparseableLines: number;
  truncated: boolean;
  threadId?: string;
  /** The LAST agent_message item text — the structured-result candidate. */
  lastAgentMessage?: string;
  /** Token usage accumulated over turn.completed events. */
  usage?: Omit<RunnerUsage, 'durationMs' | 'model' | 'requestCount'> & { requestCount: number };
  /** error / turn.failed messages, bounded. */
  errors: string[];
}

/** Parse a `--json` stdout stream. Never throws on malformed lines. */
export function parseCodexEventStream(stdout: string): CodexEventStream {
  const stream: CodexEventStream = {
    events: [],
    unparseableLines: 0,
    truncated: false,
    errors: [],
  };
  let inputTokens: number | null = null;
  let cachedInputTokens: number | null = null;
  let outputTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let turns = 0;

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
    const event = codexEventSchema.safeParse(parsed);
    if (!event.success) {
      stream.unparseableLines += 1;
      continue;
    }
    if (stream.events.length < MAX_RETAINED_EVENTS) {
      stream.events.push(event.data);
    } else {
      stream.truncated = true;
    }

    const data = event.data;
    if (data.type === 'thread.started' && data.thread_id !== undefined) {
      stream.threadId = data.thread_id;
    }
    if (data.type === 'turn.completed') {
      turns += 1;
      const usage = data.usage;
      if (usage !== undefined) {
        inputTokens = (inputTokens ?? 0) + (usage.input_tokens ?? 0);
        cachedInputTokens = (cachedInputTokens ?? 0) + (usage.cached_input_tokens ?? 0);
        outputTokens = (outputTokens ?? 0) + (usage.output_tokens ?? 0);
        if (usage.reasoning_output_tokens !== undefined) {
          reasoningTokens = (reasoningTokens ?? 0) + usage.reasoning_output_tokens;
        }
      }
    }
    if (data.type === 'item.completed' && data.item?.type === 'agent_message' && data.item.text !== undefined) {
      stream.lastAgentMessage = data.item.text;
    }
    if (data.type === 'error' || data.type === 'turn.failed') {
      const message = data.error?.message ?? data.message;
      if (message !== undefined && stream.errors.length < 20) {
        stream.errors.push(boundedPayloadText(message, 500));
      }
    }
  }

  if (turns > 0 || inputTokens !== null || outputTokens !== null) {
    stream.usage = {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      requestCount: turns,
    };
  }
  return stream;
}

const ITEM_EVENT_TYPES: Record<string, { started: NormalizedRunnerEvent['type']; completed: NormalizedRunnerEvent['type']; failed: NormalizedRunnerEvent['type'] }> = {
  command_execution: { started: 'command.started', completed: 'command.completed', failed: 'tool.failed' },
  mcp_tool_call: { started: 'tool.started', completed: 'tool.completed', failed: 'tool.failed' },
  web_search: { started: 'tool.started', completed: 'tool.completed', failed: 'tool.failed' },
  file_change: { started: 'tool.started', completed: 'file.changed', failed: 'tool.failed' },
  todo_list: { started: 'plan.updated', completed: 'plan.updated', failed: 'plan.updated' },
};

function itemPayload(item: z.infer<typeof codexItemSchema>): Record<string, string | number | boolean | null> {
  const payload: Record<string, string | number | boolean | null> = {};
  if (item.type !== undefined) payload['itemType'] = item.type;
  if (item.type === 'reasoning') {
    // Reasoning content is never normalized — status metadata only.
    payload['redacted'] = true;
    payload['textLength'] = item.text?.length ?? 0;
    return payload;
  }
  if (item.command !== undefined) payload['command'] = boundedPayloadText(item.command, 500);
  if (item.exit_code !== undefined) payload['exitCode'] = item.exit_code;
  if (item.status !== undefined) payload['status'] = item.status;
  if (item.type === 'agent_message' && item.text !== undefined) {
    payload['textLength'] = item.text.length;
  }
  if (item.changes !== undefined) {
    payload['changedPaths'] = boundedPayloadText(
      item.changes.map((change) => `${change.kind ?? 'edit'} ${change.path ?? '?'}`).join(', '),
      2000,
    );
    payload['changeCount'] = item.changes.length;
  }
  return payload;
}

/**
 * Normalize parsed Codex events. Reasoning items become `message.completed`
 * with a redacted payload — their content is intentionally absent.
 */
export function normalizeCodexEvents(
  stream: CodexEventStream,
  context: EventEnvelopeContext,
  timestamp: () => string,
): NormalizedRunnerEvent[] {
  const normalized: NormalizedRunnerEvent[] = [];
  const push = (
    type: NormalizedRunnerEvent['type'],
    providerEventType: string,
    payload: Record<string, string | number | boolean | null>,
  ): void => {
    if (normalized.length >= MAX_RETAINED_EVENTS) return;
    normalized.push(
      normalizedRunnerEventSchema.parse({
        type,
        timestamp: timestamp(),
        runner: context.runner,
        profile: context.profile,
        runId: context.runId,
        attemptId: context.attemptId,
        ...(context.providerSessionId !== undefined || stream.threadId !== undefined
          ? { providerSessionId: context.providerSessionId ?? stream.threadId }
          : {}),
        providerEventType,
        payload,
      }),
    );
  };

  for (const event of stream.events) {
    switch (event.type) {
      case 'thread.started':
        push('session.started', event.type, {
          ...(event.thread_id !== undefined ? { threadId: event.thread_id } : {}),
        });
        break;
      case 'turn.started':
        push('turn.started', event.type, {});
        break;
      case 'turn.completed':
        push('turn.completed', event.type, {});
        if (event.usage !== undefined) {
          push('usage.updated', event.type, {
            inputTokens: event.usage.input_tokens ?? null,
            cachedInputTokens: event.usage.cached_input_tokens ?? null,
            outputTokens: event.usage.output_tokens ?? null,
          });
        }
        break;
      case 'turn.failed':
        push('error', event.type, {
          message: boundedPayloadText(event.error?.message ?? 'turn failed', 500),
        });
        break;
      case 'error':
        push('error', event.type, {
          message: boundedPayloadText(event.error?.message ?? event.message ?? 'error', 500),
        });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item;
        if (item === undefined || item.type === undefined) break;
        if (item.type === 'agent_message' || item.type === 'reasoning') {
          if (event.type === 'item.completed') {
            push('message.completed', `${event.type}:${item.type}`, itemPayload(item));
          }
          break;
        }
        const mapping = ITEM_EVENT_TYPES[item.type];
        if (mapping === undefined) break;
        const type =
          event.type === 'item.started'
            ? mapping.started
            : item.status === 'failed'
              ? mapping.failed
              : mapping.completed;
        if (event.type === 'item.updated' && item.type !== 'todo_list') break;
        push(type, `${event.type}:${item.type}`, itemPayload(item));
        break;
      }
      default:
        break;
    }
  }
  return normalized;
}
