import { z } from 'zod';
import { extensionCapabilitiesSchema } from './capabilities.js';
import { extensionPermissionsSchema } from './permissions.js';

/**
 * The versioned stdio extension protocol.
 *
 * Framing is JSON Lines: exactly one JSON object per line, requests and
 * responses in JSON-RPC 2.0 shape. Extension stdout is reserved for protocol
 * messages; all extension logging goes to stderr. Both sides bound message
 * sizes before parsing.
 */
export const MAX_PROTOCOL_MESSAGE_BYTES = 2 * 1024 * 1024;

export const EXTENSION_PROTOCOL_METHODS = [
  'initialize',
  'extension.getMetadata',
  'extension.invoke',
  'extension.cancel',
  'extension.shutdown',
] as const;

export type ExtensionProtocolMethod = (typeof EXTENSION_PROTOCOL_METHODS)[number];

/** JSON-RPC error codes used by the extension protocol. */
export const EXTENSION_PROTOCOL_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  handlerError: -32000,
  cancelled: -32001,
  outputTooLarge: -32002,
  notInitialized: -32003,
  unsupportedOperation: -32004,
  invalidOutput: -32005,
} as const;

const REQUEST_ID = z.string().min(1).max(128);

export const extensionRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: REQUEST_ID,
    method: z.enum(EXTENSION_PROTOCOL_METHODS),
    params: z.record(z.unknown()).optional(),
  })
  .strict();

export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;

export const extensionResponseErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string().min(1).max(4000),
    data: z.record(z.unknown()).optional(),
  })
  .strict();

export const extensionResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: REQUEST_ID,
    result: z.unknown().optional(),
    error: extensionResponseErrorSchema.optional(),
  })
  .strict()
  .refine(
    (message) => (message.result === undefined) !== (message.error === undefined),
    'response must carry exactly one of result or error',
  );

export type ExtensionResponse = z.infer<typeof extensionResponseSchema>;
export type ExtensionResponseError = z.infer<typeof extensionResponseErrorSchema>;

export const initializeParamsSchema = z
  .object({
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    specbridgeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    extensionId: z.string().min(1).max(64),
    extensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    operation: z.string().min(1).max(80).optional(),
    grantedPermissions: extensionPermissionsSchema,
  })
  .strict();

export type InitializeParams = z.infer<typeof initializeParamsSchema>;

export const initializeResultSchema = z
  .object({
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    extensionId: z.string().min(1).max(64),
    extensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    capabilities: extensionCapabilitiesSchema,
  })
  .strict();

export type InitializeResult = z.infer<typeof initializeResultSchema>;

export const getMetadataResultSchema = z
  .object({
    id: z.string().min(1).max(64),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    kind: z.string().min(1).max(40),
    displayName: z.string().min(1).max(100),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();

export type GetMetadataResult = z.infer<typeof getMetadataResultSchema>;

export const invokeParamsSchema = z
  .object({
    operation: z.string().min(1).max(80),
    payload: z.unknown(),
    configuration: z.record(z.unknown()).optional(),
  })
  .strict();

export type InvokeParams = z.infer<typeof invokeParamsSchema>;

export const invokeResultSchema = z
  .object({
    operation: z.string().min(1).max(80),
    output: z.unknown(),
  })
  .strict();

export type InvokeResult = z.infer<typeof invokeResultSchema>;

export const cancelParamsSchema = z
  .object({
    targetId: REQUEST_ID,
  })
  .strict();

export type CancelParams = z.infer<typeof cancelParamsSchema>;

export const cancelResultSchema = z
  .object({
    cancelled: z.boolean(),
  })
  .strict();

export const shutdownResultSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

/**
 * Serialize a protocol message to a single line. Throws when the encoded
 * message exceeds the protocol message limit; JSON.stringify never emits raw
 * newlines, so the result is always exactly one line.
 */
export function serializeProtocolMessage(message: ExtensionRequest | ExtensionResponse): string {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_MESSAGE_BYTES) {
    throw new Error(
      `protocol message exceeds ${MAX_PROTOCOL_MESSAGE_BYTES} bytes and cannot be sent`,
    );
  }
  return `${line}\n`;
}

export interface LineDecoderOptions {
  readonly maxLineBytes?: number;
  readonly onLine: (line: string) => void;
  /** Called once when a line exceeds the limit; decoding stops afterwards. */
  readonly onOverflow: (bytes: number) => void;
}

export interface LineDecoder {
  readonly push: (chunk: Buffer | string) => void;
  /** Flush a trailing unterminated line (used at stream end). */
  readonly end: () => void;
}

/**
 * Incremental newline-delimited decoder with a hard per-line byte bound. The
 * bound protects both sides from unbounded buffering when the peer
 * misbehaves.
 */
export function createLineDecoder(options: LineDecoderOptions): LineDecoder {
  const maxLineBytes = options.maxLineBytes ?? MAX_PROTOCOL_MESSAGE_BYTES;
  let buffered = Buffer.alloc(0);
  let overflowed = false;

  const push = (chunk: Buffer | string): void => {
    if (overflowed) {
      return;
    }
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buffered = buffered.length === 0 ? Buffer.from(incoming) : Buffer.concat([buffered, incoming]);
    let newlineIndex = buffered.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const lineBuffer = buffered.subarray(0, newlineIndex);
      buffered = buffered.subarray(newlineIndex + 1);
      if (lineBuffer.length > maxLineBytes) {
        overflowed = true;
        options.onOverflow(lineBuffer.length);
        return;
      }
      const line = lineBuffer.toString('utf8').replace(/\r$/, '');
      if (line.trim().length > 0) {
        options.onLine(line);
      }
      newlineIndex = buffered.indexOf(0x0a);
    }
    if (buffered.length > maxLineBytes) {
      overflowed = true;
      options.onOverflow(buffered.length);
    }
  };

  const end = (): void => {
    if (overflowed || buffered.length === 0) {
      return;
    }
    const line = buffered.toString('utf8').replace(/\r$/, '');
    buffered = Buffer.alloc(0);
    if (line.trim().length > 0) {
      options.onLine(line);
    }
  };

  return { push, end };
}
