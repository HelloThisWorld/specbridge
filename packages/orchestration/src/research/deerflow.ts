import type { DeerFlowResearchProviderConfig } from '@specbridge/core';
import {
  deerFlowResearchProviderConfigSchema,
  validateRunnerBaseUrl,
} from '@specbridge/core';
import { createBoundedAbort } from '@specbridge/runners';
import { z } from 'zod';
import type {
  ResearchBridge,
  ResearchFailure,
  ResearchProviderExecutionResult,
  ResearchProviderHealth,
  ResearchReport,
  ResearchRequest,
  ResearchUsage,
} from './contracts.js';
import {
  RESEARCH_FINDING_KINDS,
  researchFindingSchema,
  researchReportSchema,
  researchRequestSchema,
  researchSourceRefSchema,
  researchUsageSchema,
} from './contracts.js';

/**
 * DeerFlow API contract implemented here (official `main`, inspected
 * 2026-08-29): GET /health and POST /api/langgraph/runs/stream, with
 * Content-Location run identity and bounded SSE parsing.
 */

type FetchImplementation = typeof globalThis.fetch;

export interface DeerFlowBridgeOptions {
  clock?: () => Date;
  fetch?: FetchImplementation;
  environment?: NodeJS.ProcessEnv;
}

const payloadSchema = z
  .object({
    status: z.enum(['COMPLETED', 'INCONCLUSIVE']),
    findings: z.array(researchFindingSchema).max(64),
    sourceRefs: z.array(researchSourceRefSchema).max(64),
    recommendations: z.array(z.string().trim().min(1).max(2_000)).max(32),
    unresolved: z.array(z.string().trim().min(1).max(2_000)).max(32),
    conflicts: z.array(z.string().trim().min(1).max(2_000)).max(32),
    usage: researchUsageSchema.optional(),
  })
  .strict();

interface SseEvent {
  event: string;
  data: unknown;
}

export interface BoundedSseResult {
  ended: boolean;
  assistantText?: string;
  usage?: ResearchUsage;
  providerRefs?: { threadId?: string; runId?: string };
  providerError?: string;
}

export class DeerFlowStreamError extends Error {
  readonly kind: 'MALFORMED_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'PROVIDER_ERROR' | 'CLOSED_EARLY';

  constructor(
    kind: DeerFlowStreamError['kind'],
    message: string,
  ) {
    super(message);
    this.name = 'DeerFlowStreamError';
    this.kind = kind;
  }
}

function boundedFailure(
  classification: ResearchFailure['classification'],
  failureSource: ResearchFailure['failureSource'],
  message: string,
  retryable: boolean,
): ResearchFailure {
  return {
    classification,
    failureSource,
    message: message.slice(0, 2_000),
    retryable,
  };
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') parts.push(part);
    else if (part !== null && typeof part === 'object') {
      const object = part as { text?: unknown; content?: unknown };
      if (typeof object.text === 'string') parts.push(object.text);
      else if (typeof object.content === 'string') parts.push(object.content);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function assistantTextFromMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const message = value as { role?: unknown; type?: unknown; content?: unknown; text?: unknown };
  const role = message.role ?? message.type;
  if (
    role !== 'assistant' &&
    role !== 'ai' &&
    role !== 'AIMessage' &&
    role !== 'AIMessageChunk' &&
    role !== undefined
  ) {
    return undefined;
  }
  return textFromContent(message.content) ?? (typeof message.text === 'string' ? message.text : undefined);
}

function assistantTextFromEvent(event: SseEvent): string | undefined {
  if (event.event === 'values') {
    if (event.data === null || typeof event.data !== 'object') return undefined;
    const messages = (event.data as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const text = assistantTextFromMessage(messages[index]);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  if (event.event === 'messages' || event.event === 'messages-tuple') {
    if (Array.isArray(event.data)) return assistantTextFromMessage(event.data[0]);
    return assistantTextFromMessage(event.data);
  }
  return undefined;
}

function usageFromEvent(value: unknown): ResearchUsage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const root = value as Record<string, unknown>;
  const candidate =
    (root['usage'] as unknown) ??
    (root['usage_metadata'] as unknown) ??
    (root['response_metadata'] !== null && typeof root['response_metadata'] === 'object'
      ? (root['response_metadata'] as Record<string, unknown>)['usage']
      : undefined);
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const object = candidate as Record<string, unknown>;
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const found = object[key];
      if (typeof found === 'number' && Number.isFinite(found) && found >= 0) return found;
    }
    return undefined;
  };
  const usage = {
    ...(number('inputTokens', 'input_tokens', 'prompt_tokens') !== undefined
      ? { inputTokens: Math.trunc(number('inputTokens', 'input_tokens', 'prompt_tokens') as number) }
      : {}),
    ...(number('outputTokens', 'output_tokens', 'completion_tokens') !== undefined
      ? { outputTokens: Math.trunc(number('outputTokens', 'output_tokens', 'completion_tokens') as number) }
      : {}),
    ...(number('totalTokens', 'total_tokens') !== undefined
      ? { totalTokens: Math.trunc(number('totalTokens', 'total_tokens') as number) }
      : {}),
    ...(number('cost', 'cost_usd', 'providerReportedCost') !== undefined
      ? { providerReportedCost: number('cost', 'cost_usd', 'providerReportedCost') as number }
      : {}),
    ...(number('subagentCount', 'subagent_count') !== undefined
      ? { subagentCount: Math.trunc(number('subagentCount', 'subagent_count') as number) }
      : {}),
  };
  const parsed = researchUsageSchema.safeParse(usage);
  return parsed.success ? parsed.data : undefined;
}

function parseFrame(frame: string): SseEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  let meaningful = false;
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
      meaningful = true;
    } else if (field === 'data') {
      data.push(value);
      meaningful = true;
    }
  }
  if (!meaningful) return undefined;
  if (data.length === 0) {
    throw new DeerFlowStreamError('MALFORMED_RESPONSE', `SSE event "${event}" has no data field`);
  }
  const raw = data.join('\n');
  if (raw === '[DONE]') return { event: 'end', data: {} };
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    throw new DeerFlowStreamError('MALFORMED_RESPONSE', `SSE event "${event}" contains malformed JSON`);
  }
}

/** Parse a DeerFlow stream without ever retaining unbounded raw bytes. */
export async function readBoundedDeerFlowSse(
  response: Response,
  limits: { maxEventBytes: number; maxTotalResponseBytes: number },
): Promise<BoundedSseResult> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new DeerFlowStreamError('CLOSED_EARLY', 'DeerFlow returned no SSE response body');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  let ended = false;
  let lastValuesText: string | undefined;
  const messageChunks: string[] = [];
  let usage: ResearchUsage | undefined;
  let providerRefs: { threadId?: string; runId?: string } | undefined;

  const normalizeNewlines = (value: string, final = false): string => {
    const trailingCr = !final && value.endsWith('\r');
    const complete = trailingCr ? value.slice(0, -1) : value;
    return complete.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + (trailingCr ? '\r' : '');
  };

  const accept = (frame: string): void => {
    if (Buffer.byteLength(frame, 'utf8') > limits.maxEventBytes) {
      throw new DeerFlowStreamError('RESPONSE_TOO_LARGE', 'a DeerFlow SSE event exceeded the configured byte limit');
    }
    const event = parseFrame(frame);
    if (event === undefined) return;
    if (event.event === 'error' || event.event.endsWith('.error') || event.event === 'gap') {
      throw new DeerFlowStreamError('PROVIDER_ERROR', `DeerFlow emitted a ${event.event} event`);
    }
    if (event.event === 'end') ended = true;
    if (event.event === 'metadata' && event.data !== null && typeof event.data === 'object') {
      const metadata = event.data as Record<string, unknown>;
      const safe = (value: unknown): string | undefined =>
        typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
          ? value
          : undefined;
      const threadId = safe(metadata['thread_id'] ?? metadata['threadId']);
      const runId = safe(metadata['run_id'] ?? metadata['runId']);
      if (threadId !== undefined || runId !== undefined) {
        providerRefs = {
          ...(providerRefs ?? {}),
          ...(threadId !== undefined ? { threadId } : {}),
          ...(runId !== undefined ? { runId } : {}),
        };
      }
    }
    const found = assistantTextFromEvent(event);
    if (found !== undefined) {
      if (event.event === 'values') lastValuesText = found;
      else messageChunks.push(found);
    }
    usage = usageFromEvent(event.data) ?? usage;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxTotalResponseBytes) {
        await reader.cancel();
        throw new DeerFlowStreamError('RESPONSE_TOO_LARGE', 'the DeerFlow SSE stream exceeded the configured total byte limit');
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = normalizeNewlines(buffer);
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        accept(frame);
        boundary = buffer.indexOf('\n\n');
      }
      if (Buffer.byteLength(buffer, 'utf8') > limits.maxEventBytes) {
        await reader.cancel();
        throw new DeerFlowStreamError('RESPONSE_TOO_LARGE', 'a DeerFlow SSE event exceeded the configured byte limit');
      }
    }
    buffer = normalizeNewlines(buffer + decoder.decode(), true);
    if (buffer.trim() !== '') accept(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!ended) throw new DeerFlowStreamError('CLOSED_EARLY', 'the DeerFlow stream closed before its end event');
  const assistantText = lastValuesText ?? (messageChunks.length > 0 ? messageChunks.join('') : undefined);
  return {
    ended,
    ...(assistantText !== undefined ? { assistantText } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(providerRefs !== undefined ? { providerRefs } : {}),
  };
}

export function parseDeerFlowContentLocation(
  value: string | null,
): { threadId: string; runId: string } | undefined {
  if (value === null || value.length > 1_024) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^https?:/i.test(value)) return undefined;
  const match = /\/threads\/([^/?#]+)\/runs\/([^/?#]+)/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  let threadId: string;
  let runId: string;
  try {
    threadId = decodeURIComponent(match[1]);
    runId = decodeURIComponent(match[2]);
  } catch {
    return undefined;
  }
  return safe.test(threadId) && safe.test(runId) ? { threadId, runId } : undefined;
}

function promptFor(request: ResearchRequest): string {
  return [
    'You are answering a bounded SpecBridge research request. Research is evidence, never product or completion authority.',
    'Use external sources only as needed. Do not expose chain-of-thought. Return ONLY one JSON object with this exact shape:',
    '{"status":"COMPLETED|INCONCLUSIVE","findings":[{"findingId":"finding-1","statement":"...","kind":"DOMAIN_FACT|ENGINEERING_CONSTRAINT|COMPATIBILITY_FACT|PRODUCT_OPTION|UNRESOLVED_CONFLICT","confidence":"LOW|MEDIUM|HIGH","sourceRefs":["source-1"]}],"sourceRefs":[{"refId":"source-1","url":"https://...","title":"...","providerSourceId":"optional","attribution":"short"}],"recommendations":["..."],"unresolved":["..."],"conflicts":["..."]}',
    'Keep every field bounded. A recommendation is not a requirement. Preserve source disagreement as UNRESOLVED_CONFLICT.',
    `REQUEST=${JSON.stringify(request)}`,
  ].join('\n');
}

function parsePayload(text: string): z.infer<typeof payloadSchema> | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(trimmed.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readSmallText(response: Response, maxBytes: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length <= maxBytes ? buffer.toString('utf8') : undefined;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

export class DeerFlowResearchBridge implements ResearchBridge {
  readonly config: DeerFlowResearchProviderConfig;
  private readonly clock: () => Date;
  private readonly fetchImpl: FetchImplementation;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(config: DeerFlowResearchProviderConfig, options: DeerFlowBridgeOptions = {}) {
    this.config = deerFlowResearchProviderConfigSchema.parse(config);
    const safety = validateRunnerBaseUrl(this.config.baseUrl, {
      allowInsecureHttp: this.config.allowInsecureHttp,
    });
    if (!safety.ok) throw new Error(`Unsafe DeerFlow base URL: ${safety.problems.join('; ')}`);
    this.clock = options.clock ?? (() => new Date());
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.environment = options.environment ?? process.env;
  }

  providerId(): string {
    return 'deerflow';
  }

  private endpoint(relative: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${relative}`;
  }

  private headers():
    | { ok: true; headers: Record<string, string> }
    | { ok: false; failure: ResearchFailure } {
    const name = this.config.internalAuthTokenEnvironmentVariable;
    if (name === null) return { ok: true, headers: {} };
    const token = this.environment[name];
    if (token === undefined || token.length === 0) {
      return {
        ok: false,
        failure: boundedFailure(
          'AUTHENTICATION',
          'AUTHORIZATION',
          `DeerFlow internal authentication is configured through environment variable ${name}, but that variable is not set.`,
          false,
        ),
      };
    }
    return {
      ok: true,
      headers: {
        'X-DeerFlow-Internal-Token': token,
        'X-DeerFlow-Owner-User-Id': this.config.ownerUserId,
      },
    };
  }

  async health(signal?: AbortSignal): Promise<ResearchProviderHealth> {
    const checkedAt = this.clock().toISOString();
    const started = Date.now();
    const headers = this.headers();
    if (!headers.ok) {
      return { provider: 'deerflow', status: 'AUTH_FAILED', checkedAt, detail: headers.failure.message };
    }
    const bounded = createBoundedAbort(Math.min(this.config.timeoutMs, 30_000), signal);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint('/health'), {
          method: 'GET',
          headers: headers.headers,
          redirect: 'error',
          signal: bounded.signal,
        });
      } catch {
        return {
          provider: 'deerflow',
          status: 'UNAVAILABLE',
          checkedAt,
          latencyMs: Math.max(0, Date.now() - started),
          detail: signal?.aborted === true ? 'health check cancelled' : 'health endpoint could not be reached or timed out',
        };
      }
      if (response.status === 401 || response.status === 403) {
        return { provider: 'deerflow', status: 'AUTH_FAILED', checkedAt, latencyMs: Math.max(0, Date.now() - started), detail: `health endpoint answered HTTP ${response.status}` };
      }
      if (!response.ok) {
        return { provider: 'deerflow', status: 'UNAVAILABLE', checkedAt, latencyMs: Math.max(0, Date.now() - started), detail: `health endpoint answered HTTP ${response.status}` };
      }
      const text = await readSmallText(response, 32 * 1024);
      if (text === undefined) {
        return { provider: 'deerflow', status: 'UNKNOWN', checkedAt, latencyMs: Math.max(0, Date.now() - started), detail: 'health response was oversized' };
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return { provider: 'deerflow', status: 'UNKNOWN', checkedAt, latencyMs: Math.max(0, Date.now() - started), detail: 'health response was not valid JSON' };
      }
      const status =
        value !== null && typeof value === 'object'
          ? (value as { status?: unknown }).status
          : undefined;
      if (typeof status !== 'string') {
        return { provider: 'deerflow', status: 'UNKNOWN', checkedAt, latencyMs: Math.max(0, Date.now() - started), detail: 'health response did not contain a status' };
      }
      const normalized = status.toLocaleLowerCase('en-US');
      return {
        provider: 'deerflow',
        status: normalized === 'ok' || normalized === 'healthy' ? 'HEALTHY' : 'DEGRADED',
        checkedAt,
        latencyMs: Math.max(0, Date.now() - started),
        ...(normalized === 'ok' || normalized === 'healthy' ? {} : { detail: `provider reported ${status.slice(0, 100)}` }),
      };
    } finally {
      bounded.release();
    }
  }

  async investigate(
    raw: ResearchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchProviderExecutionResult> {
    const request = researchRequestSchema.parse(raw);
    const startedAt = this.clock().toISOString();
    const headers = this.headers();
    if (!headers.ok) return { ok: false, failure: headers.failure };
    const bounded = createBoundedAbort(this.config.timeoutMs, signal);
    let providerRefs: { threadId?: string; runId?: string } | undefined;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint('/api/langgraph/runs/stream'), {
          method: 'POST',
          redirect: 'error',
          signal: bounded.signal,
          headers: { ...headers.headers, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            assistant_id: 'lead_agent',
            input: { messages: [{ type: 'human', content: [{ type: 'text', text: promptFor(request) }] }] },
            stream_mode: ['values', 'messages-tuple', 'custom'],
            stream_subgraphs: request.depth === 'DEEP',
            config: { recursion_limit: request.depth === 'DEEP' ? 300 : 100 },
            context: {
              thinking_enabled: request.depth === 'DEEP',
              is_plan_mode: request.depth === 'DEEP',
              subagent_enabled: request.depth === 'DEEP',
            },
          }),
        });
      } catch {
        if (signal?.aborted === true) {
          return { ok: false, failure: boundedFailure('CANCELLED', 'TRANSIENT', 'research was cancelled', false) };
        }
        if (bounded.signal.aborted) {
          return { ok: false, failure: boundedFailure('TIMEOUT', 'PROVIDER', `DeerFlow did not complete within ${this.config.timeoutMs} ms`, true) };
        }
        return { ok: false, failure: boundedFailure('NETWORK', 'PROVIDER', 'DeerFlow could not be reached', true) };
      }

      providerRefs = parseDeerFlowContentLocation(response.headers.get('content-location'));
      if (response.status === 401 || response.status === 403) {
        return { ok: false, failure: boundedFailure('AUTHENTICATION', 'AUTHORIZATION', `DeerFlow refused authentication (HTTP ${response.status})`, false), ...(providerRefs !== undefined ? { providerRefs } : {}) };
      }
      if (!response.ok) {
        const classification = response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'MALFORMED_RESPONSE';
        return { ok: false, failure: boundedFailure(classification, 'PROVIDER', `DeerFlow answered HTTP ${response.status}`, response.status >= 500), ...(providerRefs !== undefined ? { providerRefs } : {}) };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLocaleLowerCase('en-US').includes('text/event-stream')) {
        return { ok: false, failure: boundedFailure('MALFORMED_RESPONSE', 'PROVIDER', 'DeerFlow did not return an SSE response', false), ...(providerRefs !== undefined ? { providerRefs } : {}) };
      }

      let stream: BoundedSseResult;
      try {
        stream = await readBoundedDeerFlowSse(response, {
          maxEventBytes: this.config.maxEventBytes,
          maxTotalResponseBytes: this.config.maxTotalResponseBytes,
        });
      } catch (cause) {
        if (signal?.aborted === true) {
          return { ok: false, failure: boundedFailure('CANCELLED', 'TRANSIENT', 'research was cancelled', false), ...(providerRefs !== undefined ? { providerRefs } : {}) };
        }
        if (bounded.signal.aborted) {
          return { ok: false, failure: boundedFailure('TIMEOUT', 'PROVIDER', `DeerFlow did not complete within ${this.config.timeoutMs} ms`, true), ...(providerRefs !== undefined ? { providerRefs } : {}) };
        }
        const message = cause instanceof DeerFlowStreamError ? cause.message : 'DeerFlow returned an unreadable stream';
        return { ok: false, failure: boundedFailure('MALFORMED_RESPONSE', 'PROVIDER', message, cause instanceof DeerFlowStreamError && cause.kind === 'CLOSED_EARLY'), ...(providerRefs !== undefined ? { providerRefs } : {}) };
      }
      if (stream.assistantText === undefined) {
        return { ok: false, failure: boundedFailure('MALFORMED_RESPONSE', 'PROVIDER', 'DeerFlow completed without a final structured answer', false), ...(providerRefs !== undefined ? { providerRefs } : {}) };
      }
      const payload = parsePayload(stream.assistantText);
      if (payload === undefined) {
        return { ok: false, failure: boundedFailure('MALFORMED_RESPONSE', 'PROVIDER', 'DeerFlow final output did not match the bounded ResearchReport payload', false), ...(providerRefs !== undefined ? { providerRefs } : {}) };
      }

      const missingRequiredSources =
        request.sourcePolicy.requireSources &&
        payload.findings.some((finding) => finding.sourceRefs.length === 0);
      const completedAt = this.clock().toISOString();
      const providerUsage = payload.usage ?? stream.usage;
      providerRefs = providerRefs ?? stream.providerRefs;
      const parsedReport = researchReportSchema.safeParse({
        researchId: request.researchId,
        provider: 'deerflow',
        depth: request.depth,
        status: missingRequiredSources ? 'INCONCLUSIVE' : payload.status,
        question: request.question,
        findings: payload.findings,
        sourceRefs: payload.sourceRefs,
        recommendations: payload.recommendations,
        unresolved: [
          ...payload.unresolved,
          ...(missingRequiredSources ? ['The provider returned no source references although sources were required.'] : []),
        ],
        conflicts: payload.conflicts,
        classification: [...new Set(payload.findings.map((finding) => finding.kind))].filter(
          (kind): kind is (typeof RESEARCH_FINDING_KINDS)[number] => RESEARCH_FINDING_KINDS.includes(kind),
        ),
        ...(providerUsage !== undefined ? { usage: providerUsage } : {}),
        startedAt,
        completedAt,
      });
      if (!parsedReport.success) {
        return {
          ok: false,
          failure: boundedFailure(
            'MALFORMED_RESPONSE',
            'PROVIDER',
            'DeerFlow final output contained inconsistent findings or source references',
            false,
          ),
          ...(providerRefs !== undefined ? { providerRefs } : {}),
        };
      }
      const report: ResearchReport = parsedReport.data;
      if (report.status === 'INCONCLUSIVE') {
        return {
          ok: true,
          report,
          ...(providerRefs !== undefined ? { providerRefs } : {}),
        };
      }
      return { ok: true, report, ...(providerRefs !== undefined ? { providerRefs } : {}) };
    } finally {
      bounded.release();
    }
  }
}
