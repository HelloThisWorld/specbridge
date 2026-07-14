import { z } from 'zod';
import type { OpenAiCompatibleProfileConfig } from '@specbridge/core';

/**
 * OpenAI-compatible request/response shapes (v0.6.1) — AUTHORING ONLY.
 *
 * Two API styles are supported: `chat-completions` (POST /chat/completions)
 * and `responses` (POST /responses). Not every compatible endpoint
 * implements both, or implements native structured output — the profile
 * declares what its endpoint supports, and nothing is probed by paid
 * inference.
 *
 * Credential rule: the configuration holds only an environment-variable
 * NAME. The value is read at request time, sent as the Authorization
 * header, and redacted from anything retained.
 */

export interface OpenAiChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OpenAiRequestInput {
  model: string;
  messages: OpenAiChatMessage[];
  temperature: number;
  /** Structured-output mode actually used for this request. */
  structuredOutput: 'json-schema' | 'json-object' | 'strict-json-prompt';
  /** JSON Schema for the report (json-schema mode only). */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
}

/** Build the POST body for the configured API style. */
export function buildOpenAiRequestBody(
  style: OpenAiCompatibleProfileConfig['apiStyle'],
  input: OpenAiRequestInput,
): Record<string, unknown> {
  if (style === 'chat-completions') {
    const responseFormat =
      input.structuredOutput === 'json-schema'
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: input.schemaName, strict: true, schema: input.jsonSchema },
            },
          }
        : input.structuredOutput === 'json-object'
          ? { response_format: { type: 'json_object' } }
          : {};
    return {
      model: input.model,
      messages: input.messages,
      temperature: input.temperature,
      stream: false,
      ...responseFormat,
    };
  }
  // responses style
  const textFormat =
    input.structuredOutput === 'json-schema'
      ? {
          text: {
            format: {
              type: 'json_schema',
              name: input.schemaName,
              strict: true,
              schema: input.jsonSchema,
            },
          },
        }
      : input.structuredOutput === 'json-object'
        ? { text: { format: { type: 'json_object' } } }
        : {};
  return {
    model: input.model,
    input: input.messages.map((message) => ({
      role: message.role,
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }],
    })),
    temperature: input.temperature,
    stream: false,
    ...textFormat,
  };
}

const chatCompletionResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().nullable() }).passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    model: z.string().optional(),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const responsesResponseSchema = z
  .object({
    output: z
      .array(
        z
          .object({
            type: z.string().optional(),
            content: z
              .array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough())
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    output_text: z.string().optional(),
    model: z.string().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        input_tokens_details: z.object({ cached_tokens: z.number().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface ParsedProviderResponse {
  /** The complete assistant text (validated as a whole; never substring-extracted). */
  text?: string;
  usage?: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
  };
  model?: string;
  /** Why no text could be extracted (safe, bounded). */
  problem?: string;
}

/** Extract the assistant text and usage from a provider response body. */
export function parseOpenAiResponse(
  style: OpenAiCompatibleProfileConfig['apiStyle'],
  bodyText: string,
): ParsedProviderResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { problem: 'the endpoint response is not valid JSON' };
  }
  if (style === 'chat-completions') {
    const result = chatCompletionResponseSchema.safeParse(parsed);
    if (!result.success) {
      return { problem: 'the endpoint response does not match the chat-completions shape' };
    }
    const content = result.data.choices[0]?.message.content;
    return {
      ...(content !== null && content !== undefined ? { text: content } : { problem: 'the response carries no message content' }),
      ...(result.data.model !== undefined ? { model: result.data.model } : {}),
      ...(result.data.usage !== undefined
        ? {
            usage: {
              inputTokens: result.data.usage.prompt_tokens ?? null,
              cachedInputTokens: result.data.usage.prompt_tokens_details?.cached_tokens ?? null,
              outputTokens: result.data.usage.completion_tokens ?? null,
            },
          }
        : {}),
    };
  }
  const result = responsesResponseSchema.safeParse(parsed);
  if (!result.success) {
    return { problem: 'the endpoint response does not match the responses shape' };
  }
  let text: string | undefined = result.data.output_text;
  if (text === undefined && result.data.output !== undefined) {
    const parts: string[] = [];
    for (const item of result.data.output) {
      if (item.type !== undefined && item.type !== 'message') continue;
      for (const content of item.content ?? []) {
        if ((content.type === undefined || content.type === 'output_text') && content.text !== undefined) {
          parts.push(content.text);
        }
      }
    }
    if (parts.length > 0) text = parts.join('');
  }
  return {
    ...(text !== undefined ? { text } : { problem: 'the response carries no output text' }),
    ...(result.data.model !== undefined ? { model: result.data.model } : {}),
    ...(result.data.usage !== undefined
      ? {
          usage: {
            inputTokens: result.data.usage.input_tokens ?? null,
            cachedInputTokens: result.data.usage.input_tokens_details?.cached_tokens ?? null,
            outputTokens: result.data.usage.output_tokens ?? null,
          },
        }
      : {}),
  };
}

export const openAiModelsResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string(),
            owned_by: z.string().optional(),
            created: z.number().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/** True when the error body indicates the structured-output mode is unsupported. */
export function indicatesStructuredOutputUnsupported(status: number | undefined, bodyExcerpt: string | undefined): boolean {
  if (status !== 400 && status !== 422) return false;
  const text = (bodyExcerpt ?? '').toLowerCase();
  return /response_format|json_schema|json schema|structured output|text\.format/.test(text);
}

/**
 * Redact every occurrence of a secret value from retained text. Applied to
 * anything persisted or surfaced (raw bodies, error excerpts, diagnostics).
 */
export function redactSecretValue(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join('<redacted>');
}

/** The next weaker structured-output mode for the EXPLICIT fallback option. */
export function weakerStructuredOutputMode(
  mode: 'json-schema' | 'json-object' | 'strict-json-prompt',
): 'json-object' | 'strict-json-prompt' | undefined {
  if (mode === 'json-schema') return 'json-object';
  if (mode === 'json-object') return 'strict-json-prompt';
  return undefined;
}
