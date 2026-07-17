import { PassThrough } from 'node:stream';
import type { ExtensionManifest } from './manifest.js';
import type { ExtensionPermissions } from './permissions.js';
import { noPermissions } from './permissions.js';
import {
  createLineDecoder,
  extensionResponseSchema,
  serializeProtocolMessage,
  type ExtensionProtocolMethod,
  type ExtensionResponse,
} from './protocol.js';
import {
  createExtensionServer,
  type ExtensionServer,
  type OperationHandler,
} from './server.js';
import { EXTENSION_PROTOCOL_VERSION } from './version.js';

/**
 * In-process testing utilities.
 *
 * `connectLoopback` runs an extension server over in-memory streams so unit
 * tests and first-party conformance checks can exercise the exact protocol
 * without spawning a child process. Process-level behavior (spawn, kill,
 * stdout hygiene of a real child) is intentionally out of scope here — the
 * SpecBridge host tests cover that with real fixture processes.
 */
export interface LoopbackConnection {
  /** Send one request and resolve its response envelope. */
  request(method: ExtensionProtocolMethod, params?: Record<string, unknown>): Promise<ExtensionResponse>;
  /** Send one request; resolve `result` or reject with the protocol error. */
  requestResult(method: ExtensionProtocolMethod, params?: Record<string, unknown>): Promise<unknown>;
  /** Everything the extension wrote to its log (stderr-equivalent) stream. */
  readonly logLines: string[];
  /** Request shutdown and wait for the server loop to finish. */
  close(): Promise<void>;
}

export interface LoopbackOptions {
  readonly manifest: ExtensionManifest;
  readonly handlers: Readonly<Record<string, OperationHandler>>;
  readonly includeStackTraces?: boolean;
}

export class LoopbackProtocolError extends Error {
  readonly code: number;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: number, message: string, data: Record<string, unknown> | undefined) {
    super(message);
    this.name = 'LoopbackProtocolError';
    this.code = code;
    this.data = data;
  }
}

export function connectLoopback(options: LoopbackOptions): LoopbackConnection {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const logStream = new PassThrough();
  const logLines: string[] = [];
  logStream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length > 0) {
        logLines.push(line);
      }
    }
  });

  const serverOptions: Parameters<typeof createExtensionServer>[0] = {
    manifest: options.manifest,
    handlers: options.handlers,
    input: toServer,
    output: fromServer,
    logOutput: logStream,
    ...(options.includeStackTraces === undefined
      ? {}
      : { includeStackTraces: options.includeStackTraces }),
  };
  const server: ExtensionServer = createExtensionServer(serverOptions);
  const done = server.run();

  const pending = new Map<string, (response: ExtensionResponse) => void>();
  const decoder = createLineDecoder({
    onLine: (line) => {
      const parsed = extensionResponseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        return;
      }
      const resolver = pending.get(parsed.data.id);
      if (resolver !== undefined) {
        pending.delete(parsed.data.id);
        resolver(parsed.data);
      }
    },
    onOverflow: () => {
      // Loopback responses are bounded by the server itself.
    },
  });
  fromServer.on('data', (chunk: Buffer) => decoder.push(chunk));

  let nextId = 0;

  const request = (
    method: ExtensionProtocolMethod,
    params?: Record<string, unknown>,
  ): Promise<ExtensionResponse> => {
    nextId += 1;
    const id = `loopback-${nextId}`;
    return new Promise<ExtensionResponse>((resolve) => {
      pending.set(id, resolve);
      toServer.write(
        serializeProtocolMessage(
          params === undefined
            ? { jsonrpc: '2.0', id, method }
            : { jsonrpc: '2.0', id, method, params },
        ),
      );
    });
  };

  return {
    request,
    async requestResult(method, params) {
      const response = await request(method, params);
      if (response.error !== undefined) {
        throw new LoopbackProtocolError(
          response.error.code,
          response.error.message,
          response.error.data,
        );
      }
      return response.result;
    },
    logLines,
    async close() {
      await request('extension.shutdown');
      await done;
      toServer.destroy();
      fromServer.destroy();
      logStream.destroy();
    },
  };
}

/** Valid initialize params for a manifest, with optional overrides. */
export function initializeParamsFor(
  manifest: ExtensionManifest,
  overrides?: Partial<{
    protocolVersion: string;
    specbridgeVersion: string;
    extensionId: string;
    extensionVersion: string;
    operation: string;
    grantedPermissions: ExtensionPermissions;
  }>,
): Record<string, unknown> {
  return {
    protocolVersion: overrides?.protocolVersion ?? EXTENSION_PROTOCOL_VERSION,
    specbridgeVersion: overrides?.specbridgeVersion ?? '1.0.0',
    extensionId: overrides?.extensionId ?? manifest.id,
    extensionVersion: overrides?.extensionVersion ?? manifest.version,
    ...(overrides?.operation === undefined ? {} : { operation: overrides.operation }),
    grantedPermissions: overrides?.grantedPermissions ?? manifest.permissions,
  };
}

/**
 * Initialize, invoke one operation, shut down, and return the operation
 * output. The fastest way to unit-test a handler end to end.
 */
export async function invokeExtensionOnce(options: {
  manifest: ExtensionManifest;
  handlers: Readonly<Record<string, OperationHandler>>;
  operation: string;
  payload: unknown;
  grantedPermissions?: ExtensionPermissions;
  configuration?: Record<string, unknown>;
}): Promise<unknown> {
  const connection = connectLoopback({ manifest: options.manifest, handlers: options.handlers });
  try {
    await connection.requestResult(
      'initialize',
      initializeParamsFor(options.manifest, {
        operation: options.operation,
        grantedPermissions: options.grantedPermissions ?? noPermissions(),
      }),
    );
    const result = (await connection.requestResult('extension.invoke', {
      operation: options.operation,
      payload: options.payload,
      ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    })) as { operation: string; output: unknown };
    return result.output;
  } finally {
    await connection.close();
  }
}
