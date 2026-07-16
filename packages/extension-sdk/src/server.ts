import type { AnalyzerInput, AnalyzerResult } from './analyzer.js';
import type { ExporterInput, ExporterResult } from './exporter.js';
import type { ExtensionManifest } from './manifest.js';
import { operationSchemas } from './operation-schemas.js';
import type { ExtensionPermissions } from './permissions.js';
import { noPermissions } from './permissions.js';
import {
  cancelParamsSchema,
  createLineDecoder,
  EXTENSION_PROTOCOL_ERRORS,
  extensionRequestSchema,
  initializeParamsSchema,
  invokeParamsSchema,
  serializeProtocolMessage,
  type ExtensionRequest,
  type ExtensionResponse,
} from './protocol.js';
import type {
  RunnerDetectInput,
  RunnerDetectOutput,
  RunnerModelListOutput,
  RunnerStageInput,
  RunnerStageOutput,
  RunnerTaskInput,
  RunnerTaskOutput,
} from './runner.js';
import { sameMajor } from './semver.js';
import type { VerifierInput, VerifierResult } from './verifier.js';
import { EXTENSION_PROTOCOL_VERSION } from './version.js';

/**
 * The stdio extension server.
 *
 * Guarantees for authors and for the host:
 *   - stdout carries protocol messages only; `context.log` writes to stderr
 *   - every request produces exactly one response
 *   - handler errors become structured protocol errors without stack traces
 *     (opt in with `includeStackTraces` for local debugging only)
 *   - inputs and outputs are schema-validated and size-bounded on this side
 *     too, so a buggy handler fails safely instead of corrupting the stream
 *   - cancellation aborts the handler's AbortSignal and answers the original
 *     request with a `cancelled` error
 */
export interface InvocationContext {
  readonly signal: AbortSignal;
  readonly grantedPermissions: ExtensionPermissions;
  readonly configuration: Record<string, unknown> | undefined;
  /** Log to stderr. Never write to stdout from a handler. */
  readonly log: (message: string) => void;
}

export type OperationHandler = (
  payload: unknown,
  context: InvocationContext,
) => Promise<unknown> | unknown;

export interface ExtensionServerOptions {
  readonly manifest: ExtensionManifest;
  readonly handlers: Readonly<Record<string, OperationHandler>>;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly logOutput?: NodeJS.WritableStream;
  /** Include stack traces in protocol errors. Never enable in production. */
  readonly includeStackTraces?: boolean;
}

export interface ExtensionServer {
  /** Serve until shutdown is requested or the input stream ends. */
  run(): Promise<void>;
}

interface ProtocolErrorShape {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createExtensionServer(options: ExtensionServerOptions): ExtensionServer {
  const manifest = options.manifest;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const logOutput = options.logOutput ?? process.stderr;
  const includeStackTraces = options.includeStackTraces === true;

  let initialized = false;
  let grantedPermissions: ExtensionPermissions = noPermissions();
  let finished = false;
  const inflight = new Map<string, AbortController>();
  const responded = new Set<string>();

  const log = (message: string): void => {
    logOutput.write(`${message}\n`);
  };

  const send = (response: ExtensionResponse): void => {
    if (finished) {
      return;
    }
    try {
      output.write(serializeProtocolMessage(response));
    } catch {
      const fallback: ExtensionResponse = {
        jsonrpc: '2.0',
        id: response.id,
        error: {
          code: EXTENSION_PROTOCOL_ERRORS.outputTooLarge,
          message: 'response exceeded the protocol message size limit',
          data: { extensionCode: 'SBE025' },
        },
      };
      output.write(serializeProtocolMessage(fallback));
    }
  };

  const respondOnce = (id: string, body: { result?: unknown; error?: ProtocolErrorShape }): void => {
    if (responded.has(id)) {
      return;
    }
    responded.add(id);
    if (body.error !== undefined) {
      send({ jsonrpc: '2.0', id, error: body.error });
    } else {
      send({ jsonrpc: '2.0', id, result: body.result });
    }
  };

  return {
    run(): Promise<void> {
      return new Promise<void>((resolve) => {
        const finish = (): void => {
          if (finished) {
            return;
          }
          finished = true;
          for (const controller of inflight.values()) {
            controller.abort();
          }
          inflight.clear();
          input.removeListener('data', onData);
          input.removeListener('end', onEnd);
          input.removeListener('error', onEnd);
          resolve();
        };

        const handleInvoke = async (request: ExtensionRequest): Promise<void> => {
          const params = invokeParamsSchema.safeParse(request.params ?? {});
          if (!params.success) {
            respondOnce(request.id, {
              error: {
                code: EXTENSION_PROTOCOL_ERRORS.invalidParams,
                message: `invalid invoke params: ${params.error.issues[0]?.message ?? 'unknown'}`,
              },
            });
            return;
          }
          const { operation, payload, configuration } = params.data;
          if (!manifest.capabilities.operations.includes(operation)) {
            respondOnce(request.id, {
              error: {
                code: EXTENSION_PROTOCOL_ERRORS.unsupportedOperation,
                message: `operation "${operation}" is not declared by this extension`,
                data: { extensionCode: 'SBE021' },
              },
            });
            return;
          }
          const handler = options.handlers[operation];
          if (handler === undefined) {
            respondOnce(request.id, {
              error: {
                code: EXTENSION_PROTOCOL_ERRORS.unsupportedOperation,
                message: `operation "${operation}" has no registered handler`,
                data: { extensionCode: 'SBE021' },
              },
            });
            return;
          }

          const schemas = operationSchemas(operation);
          let validatedPayload: unknown = payload;
          if (schemas !== undefined) {
            const parsed = schemas.input.safeParse(payload);
            if (!parsed.success) {
              respondOnce(request.id, {
                error: {
                  code: EXTENSION_PROTOCOL_ERRORS.invalidParams,
                  message:
                    `invalid ${operation} payload: ` +
                    `${parsed.error.issues[0]?.path.join('.') ?? ''} ` +
                    `${parsed.error.issues[0]?.message ?? 'unknown'}`.trim(),
                },
              });
              return;
            }
            validatedPayload = parsed.data;
          }

          const controller = new AbortController();
          inflight.set(request.id, controller);
          try {
            const context: InvocationContext = {
              signal: controller.signal,
              grantedPermissions,
              configuration,
              log,
            };
            const rawResult = await handler(validatedPayload, context);
            if (controller.signal.aborted) {
              respondOnce(request.id, {
                error: {
                  code: EXTENSION_PROTOCOL_ERRORS.cancelled,
                  message: 'operation was cancelled',
                  data: { extensionCode: 'SBE024' },
                },
              });
              return;
            }
            if (schemas !== undefined) {
              const validatedOutput = schemas.output.safeParse(rawResult);
              if (!validatedOutput.success) {
                respondOnce(request.id, {
                  error: {
                    code: EXTENSION_PROTOCOL_ERRORS.invalidOutput,
                    message:
                      `handler returned an invalid ${operation} result: ` +
                      `${validatedOutput.error.issues[0]?.path.join('.') ?? ''} ` +
                      `${validatedOutput.error.issues[0]?.message ?? 'unknown'}`.trim(),
                  },
                });
                return;
              }
              respondOnce(request.id, {
                result: { operation, output: validatedOutput.data },
              });
              return;
            }
            respondOnce(request.id, { result: { operation, output: rawResult } });
          } catch (error) {
            if (controller.signal.aborted) {
              respondOnce(request.id, {
                error: {
                  code: EXTENSION_PROTOCOL_ERRORS.cancelled,
                  message: 'operation was cancelled',
                  data: { extensionCode: 'SBE024' },
                },
              });
              return;
            }
            const data: Record<string, unknown> = { extensionCode: 'SBE030' };
            if (includeStackTraces && error instanceof Error && error.stack !== undefined) {
              data['stack'] = error.stack;
            }
            respondOnce(request.id, {
              error: {
                code: EXTENSION_PROTOCOL_ERRORS.handlerError,
                message: `handler failed: ${errorMessage(error)}`,
                data,
              },
            });
          } finally {
            inflight.delete(request.id);
          }
        };

        const handleRequest = (request: ExtensionRequest): void => {
          if (responded.has(request.id) || inflight.has(request.id)) {
            respondOnce(`${request.id}:duplicate`, {
              error: {
                code: EXTENSION_PROTOCOL_ERRORS.invalidRequest,
                message: `duplicate request id "${request.id}"`,
              },
            });
            return;
          }

          switch (request.method) {
            case 'initialize': {
              const params = initializeParamsSchema.safeParse(request.params ?? {});
              if (!params.success) {
                respondOnce(request.id, {
                  error: {
                    code: EXTENSION_PROTOCOL_ERRORS.invalidParams,
                    message: `invalid initialize params: ${params.error.issues[0]?.message ?? 'unknown'}`,
                  },
                });
                return;
              }
              if (!sameMajor(params.data.protocolVersion, EXTENSION_PROTOCOL_VERSION)) {
                respondOnce(request.id, {
                  error: {
                    code: EXTENSION_PROTOCOL_ERRORS.handlerError,
                    message:
                      `protocol version ${params.data.protocolVersion} is not supported ` +
                      `(extension speaks ${EXTENSION_PROTOCOL_VERSION})`,
                    data: { extensionCode: 'SBE007' },
                  },
                });
                return;
              }
              if (
                params.data.extensionId !== manifest.id ||
                params.data.extensionVersion !== manifest.version
              ) {
                respondOnce(request.id, {
                  error: {
                    code: EXTENSION_PROTOCOL_ERRORS.handlerError,
                    message:
                      `identity mismatch: host expected ${params.data.extensionId}@` +
                      `${params.data.extensionVersion}, extension is ${manifest.id}@${manifest.version}`,
                    data: { extensionCode: 'SBE020' },
                  },
                });
                return;
              }
              initialized = true;
              grantedPermissions = params.data.grantedPermissions;
              respondOnce(request.id, {
                result: {
                  protocolVersion: EXTENSION_PROTOCOL_VERSION,
                  extensionId: manifest.id,
                  extensionVersion: manifest.version,
                  capabilities: manifest.capabilities,
                },
              });
              return;
            }
            case 'extension.getMetadata': {
              respondOnce(request.id, {
                result: {
                  id: manifest.id,
                  version: manifest.version,
                  kind: manifest.kind,
                  displayName: manifest.displayName,
                  protocolVersion: EXTENSION_PROTOCOL_VERSION,
                },
              });
              return;
            }
            case 'extension.invoke': {
              if (!initialized) {
                respondOnce(request.id, {
                  error: {
                    code: EXTENSION_PROTOCOL_ERRORS.notInitialized,
                    message: 'initialize must be called before extension.invoke',
                  },
                });
                return;
              }
              void handleInvoke(request);
              return;
            }
            case 'extension.cancel': {
              const params = cancelParamsSchema.safeParse(request.params ?? {});
              if (!params.success) {
                respondOnce(request.id, {
                  error: {
                    code: EXTENSION_PROTOCOL_ERRORS.invalidParams,
                    message: 'invalid cancel params',
                  },
                });
                return;
              }
              const target = inflight.get(params.data.targetId);
              if (target !== undefined) {
                target.abort();
              }
              respondOnce(request.id, { result: { cancelled: target !== undefined } });
              return;
            }
            case 'extension.shutdown': {
              respondOnce(request.id, { result: { ok: true } });
              finish();
              return;
            }
          }
        };

        const onLine = (line: string): void => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            respondOnce('invalid', {
              error: {
                code: EXTENSION_PROTOCOL_ERRORS.parseError,
                message: 'request line is not valid JSON',
              },
            });
            return;
          }
          const request = extensionRequestSchema.safeParse(parsed);
          if (!request.success) {
            respondOnce('invalid', {
              error: {
                code: EXTENSION_PROTOCOL_ERRORS.invalidRequest,
                message: 'request does not match the extension protocol envelope',
              },
            });
            return;
          }
          responded.delete('invalid');
          handleRequest(request.data);
        };

        const decoder = createLineDecoder({
          onLine,
          onOverflow: (bytes) => {
            respondOnce('invalid', {
              error: {
                code: EXTENSION_PROTOCOL_ERRORS.outputTooLarge,
                message: `request line of ${bytes} bytes exceeds the protocol limit`,
                data: { extensionCode: 'SBE025' },
              },
            });
            finish();
          },
        });

        const onData = (chunk: Buffer | string): void => {
          decoder.push(chunk);
        };
        const onEnd = (): void => {
          decoder.end();
          finish();
        };

        input.on('data', onData);
        input.once('end', onEnd);
        input.once('error', onEnd);
      });
    },
  };
}

/** Typed helper for analyzer extensions. */
export function createAnalyzerExtension(options: {
  manifest: ExtensionManifest;
  analyze: (input: AnalyzerInput, context: InvocationContext) => Promise<AnalyzerResult> | AnalyzerResult;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  logOutput?: NodeJS.WritableStream;
  includeStackTraces?: boolean;
}): ExtensionServer {
  const { manifest, analyze, ...rest } = options;
  return createExtensionServer({
    manifest,
    handlers: {
      'analyzer.analyze': (payload, context) => analyze(payload as AnalyzerInput, context),
    },
    ...rest,
  });
}

/** Typed helper for verifier extensions. */
export function createVerifierExtension(options: {
  manifest: ExtensionManifest;
  verify: (input: VerifierInput, context: InvocationContext) => Promise<VerifierResult> | VerifierResult;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  logOutput?: NodeJS.WritableStream;
  includeStackTraces?: boolean;
}): ExtensionServer {
  const { manifest, verify, ...rest } = options;
  return createExtensionServer({
    manifest,
    handlers: {
      'verifier.verify': (payload, context) => verify(payload as VerifierInput, context),
    },
    ...rest,
  });
}

/** Typed helper for exporter extensions. */
export function createExporterExtension(options: {
  manifest: ExtensionManifest;
  export: (input: ExporterInput, context: InvocationContext) => Promise<ExporterResult> | ExporterResult;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  logOutput?: NodeJS.WritableStream;
  includeStackTraces?: boolean;
}): ExtensionServer {
  const { manifest, export: exportFn, ...rest } = options;
  return createExtensionServer({
    manifest,
    handlers: {
      'exporter.export': (payload, context) => exportFn(payload as ExporterInput, context),
    },
    ...rest,
  });
}

export interface RunnerExtensionHandlers {
  detect: (input: RunnerDetectInput, context: InvocationContext) => Promise<RunnerDetectOutput> | RunnerDetectOutput;
  generateStage?: (input: RunnerStageInput, context: InvocationContext) => Promise<RunnerStageOutput> | RunnerStageOutput;
  refineStage?: (input: RunnerStageInput, context: InvocationContext) => Promise<RunnerStageOutput> | RunnerStageOutput;
  executeTask?: (input: RunnerTaskInput, context: InvocationContext) => Promise<RunnerTaskOutput> | RunnerTaskOutput;
  resumeTask?: (input: RunnerTaskInput, context: InvocationContext) => Promise<RunnerTaskOutput> | RunnerTaskOutput;
  listModels?: (input: Record<string, never>, context: InvocationContext) => Promise<RunnerModelListOutput> | RunnerModelListOutput;
}

/** Typed helper for runner extensions (frozen v0.6.0 semantics over stdio). */
export function createRunnerExtension(options: {
  manifest: ExtensionManifest;
  handlers: RunnerExtensionHandlers;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  logOutput?: NodeJS.WritableStream;
  includeStackTraces?: boolean;
}): ExtensionServer {
  const { manifest, handlers, ...rest } = options;
  const mapped: Record<string, OperationHandler> = {
    'runner.detect': (payload, context) => handlers.detect(payload as RunnerDetectInput, context),
  };
  if (handlers.generateStage) {
    const generate = handlers.generateStage;
    mapped['runner.generateStage'] = (payload, context) =>
      generate(payload as RunnerStageInput, context);
  }
  if (handlers.refineStage) {
    const refine = handlers.refineStage;
    mapped['runner.refineStage'] = (payload, context) =>
      refine(payload as RunnerStageInput, context);
  }
  if (handlers.executeTask) {
    const execute = handlers.executeTask;
    mapped['runner.executeTask'] = (payload, context) =>
      execute(payload as RunnerTaskInput, context);
  }
  if (handlers.resumeTask) {
    const resume = handlers.resumeTask;
    mapped['runner.resumeTask'] = (payload, context) =>
      resume(payload as RunnerTaskInput, context);
  }
  if (handlers.listModels) {
    const listModels = handlers.listModels;
    mapped['runner.listModels'] = (payload, context) =>
      listModels(payload as Record<string, never>, context);
  }
  return createExtensionServer({ manifest, handlers: mapped, ...rest });
}
