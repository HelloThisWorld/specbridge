import { Buffer } from 'node:buffer';
import { z } from 'zod';

/**
 * Provider-independent runner event model (v0.6, frozen).
 *
 * Adapters translate their provider's native event stream into these
 * normalized events so orchestration, attempt records, and reporting never
 * parse provider formats.
 *
 * Reasoning boundary: hidden chain-of-thought / private reasoning content is
 * NEVER normalized as assistant content and never written into normalized
 * events. Adapters may retain only safe status metadata (e.g. that a
 * reasoning item occurred, token counts) — enforced by the payload size
 * limit plus adapter conformance.
 */

export const RUNNER_EVENT_SCHEMA_VERSION = '1.0.0';

export const NORMALIZED_RUNNER_EVENT_TYPES = [
  'runner.started',
  'runner.completed',
  'session.started',
  'turn.started',
  'turn.completed',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'command.started',
  'command.completed',
  'file.changed',
  'plan.updated',
  'usage.updated',
  'warning',
  'error',
] as const;
export type NormalizedRunnerEventType = (typeof NORMALIZED_RUNNER_EVENT_TYPES)[number];

/** Hard ceiling for one serialized event payload (bytes). */
export const MAX_EVENT_PAYLOAD_BYTES = 32 * 1024;

const safePayloadValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const normalizedRunnerEventSchema = z
  .object({
    schemaVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default(RUNNER_EVENT_SCHEMA_VERSION),
    type: z.enum(NORMALIZED_RUNNER_EVENT_TYPES),
    timestamp: z.string().min(1),
    /** Runner implementation name (e.g. "codex-cli"). */
    runner: z.string().min(1),
    /** Runner profile name (e.g. "codex-default"). */
    profile: z.string().min(1),
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    providerSessionId: z.string().optional(),
    /** Original provider event type, when safe to record. */
    providerEventType: z.string().max(200).optional(),
    /** Flat, safe payload: strings/numbers/booleans/null only, size-limited. */
    payload: z.record(safePayloadValue).default({}),
  })
  .strict()
  .superRefine((event, ctx) => {
    const serialized = JSON.stringify(event.payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload'],
        message: `event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
      });
    }
  });
export type NormalizedRunnerEvent = z.infer<typeof normalizedRunnerEventSchema>;

export interface EventEnvelopeContext {
  runner: string;
  profile: string;
  runId: string;
  attemptId: string;
  providerSessionId?: string;
}

/** Truncate a string payload value defensively (payload limit still applies). */
export function boundedPayloadText(value: string, maxChars = 2000): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}… [truncated]`;
}
