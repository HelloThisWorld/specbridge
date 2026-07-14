import { z } from 'zod';
import type { OllamaProfileConfig } from '@specbridge/core';
import type { SafeHttpResult } from '../shared/http-client.js';
import { safeHttpRequest } from '../shared/http-client.js';

/**
 * Native Ollama HTTP API transport (no SDK dependency): /api/version,
 * /api/tags, /api/chat. Every request is bounded (timeout, response size),
 * cancellable, redirect-free, and loopback-by-default (URL safety is
 * validated by the configuration schema AND rechecked by the runner).
 *
 * Thinking/reasoning boundary: some models return a `thinking` field.
 * It is redacted before the raw response is retained and never enters
 * reports or normalized events.
 */

export const ollamaVersionResponseSchema = z.object({ version: z.string() }).passthrough();

export const ollamaModelSchema = z
  .object({
    name: z.string(),
    size: z.number().optional(),
    modified_at: z.string().optional(),
    details: z
      .object({
        family: z.string().optional(),
        parameter_size: z.string().optional(),
        quantization_level: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type OllamaModel = z.infer<typeof ollamaModelSchema>;

export const ollamaTagsResponseSchema = z
  .object({ models: z.array(ollamaModelSchema).default([]) })
  .passthrough();

export const ollamaChatResponseSchema = z
  .object({
    model: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.string().default(''),
        thinking: z.string().optional(),
      })
      .passthrough(),
    done: z.boolean().optional(),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
    total_duration: z.number().optional(),
  })
  .passthrough();
export type OllamaChatResponse = z.infer<typeof ollamaChatResponseSchema>;

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function endpoint(config: OllamaProfileConfig, pathName: string): string {
  return new URL(pathName, config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`).toString();
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 1024 * 1024;

export function fetchOllamaVersion(
  config: OllamaProfileConfig,
  signal?: AbortSignal,
): Promise<SafeHttpResult> {
  return safeHttpRequest({
    method: 'GET',
    url: endpoint(config, 'api/version'),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxResponseBytes: PROBE_MAX_BYTES,
    ...(signal !== undefined ? { signal } : {}),
    expectJson: true,
  });
}

export function fetchOllamaModels(
  config: OllamaProfileConfig,
  signal?: AbortSignal,
): Promise<SafeHttpResult> {
  return safeHttpRequest({
    method: 'GET',
    url: endpoint(config, 'api/tags'),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxResponseBytes: PROBE_MAX_BYTES,
    ...(signal !== undefined ? { signal } : {}),
    expectJson: true,
  });
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  /** JSON Schema sent through Ollama's structured-output `format` field. */
  format: Record<string, unknown>;
  temperature: number;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

/** Non-streaming structured-output chat request. */
export function postOllamaChat(
  config: OllamaProfileConfig,
  request: OllamaChatRequest,
): Promise<SafeHttpResult> {
  return safeHttpRequest({
    method: 'POST',
    url: endpoint(config, 'api/chat'),
    body: {
      model: request.model,
      messages: request.messages,
      stream: false,
      format: request.format,
      options: { temperature: request.temperature },
    },
    timeoutMs: request.timeoutMs,
    maxResponseBytes: request.maxResponseBytes,
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    expectJson: true,
  });
}

/**
 * Redact thinking/reasoning content from a raw chat response body before it
 * is retained as a run artifact. Parse failures return a bounded excerpt.
 */
export function redactOllamaResponseForRetention(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const message = record['message'];
      if (message !== null && typeof message === 'object') {
        const messageRecord = { ...(message as Record<string, unknown>) };
        if (typeof messageRecord['thinking'] === 'string') {
          messageRecord['thinking'] = `[redacted thinking: ${(messageRecord['thinking'] as string).length} chars]`;
        }
        record['message'] = messageRecord;
      }
      return `${JSON.stringify(record, null, 2)}\n`;
    }
  } catch {
    // fall through to the bounded excerpt
  }
  return bodyText.length > 10_000 ? `${bodyText.slice(0, 10_000)}… [truncated]` : bodyText;
}
