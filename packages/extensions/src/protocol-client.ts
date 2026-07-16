import {
  EXTENSION_PROTOCOL_VERSION,
  extensionResponseSchema,
  initializeResultSchema,
  invokeResultSchema,
  operationSchemas,
  serializeProtocolMessage,
  type ExtensionManifest,
  type ExtensionResponse,
} from '@specbridge/extension-sdk';
import { SPECBRIDGE_VERSION } from '@specbridge/templates';
import type { EnabledExtension } from './enablement.js';
import { ExtensionError } from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import { spawnExtensionProcess, type ExtensionProcessHandle } from './process-host.js';

/**
 * Host-side protocol client: one process per invocation session.
 *
 * The client owns the full lifecycle — spawn, initialize handshake with
 * identity and capability validation, operation invocation with timeout and
 * cancellation, best-effort shutdown, and guaranteed termination. Protocol
 * corruption (non-JSON stdout, schema-invalid responses, oversized lines)
 * fails the invocation and kills the process; it can never crash SpecBridge.
 */
export interface ExtensionInvocationOptions {
  readonly operation: string;
  readonly payload: unknown;
  readonly configuration?: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly specbridgeVersion?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface ExtensionInvocationOutcome {
  readonly output: unknown;
  readonly durationMs: number;
  /** Bounded, secret-redacted stderr tail for diagnostics. */
  readonly stderr: string;
  /** Bounded, secret-redacted protocol transcript for audit. */
  readonly protocolLog: readonly string[];
}

const MAX_PROTOCOL_LOG_LINES = 200;
const SHUTDOWN_GRACE_MS = 1000;

function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      redacted = redacted.split(secret).join('[redacted]');
    }
  }
  return redacted;
}

class InvocationSession {
  private readonly pending = new Map<string, (response: ExtensionResponse) => void>();
  private readonly protocolLog: string[] = [];
  private corrupted: string | undefined;
  private nextId = 0;

  constructor(
    private readonly handle: ExtensionProcessHandle,
    private readonly secrets: readonly string[],
  ) {
    handle.onLine((line) => this.onLine(line));
    handle.onProtocolCorruption((detail) => {
      this.corrupted = detail;
      this.failAll();
      handle.terminate();
    });
    handle.onExit(() => this.failAll());
  }

  get corruptionDetail(): string | undefined {
    return this.corrupted;
  }

  get log(): readonly string[] {
    return this.protocolLog;
  }

  private record(direction: 'send' | 'recv', line: string): void {
    if (this.protocolLog.length < MAX_PROTOCOL_LOG_LINES) {
      this.protocolLog.push(`${direction} ${redact(line, this.secrets)}`);
    }
  }

  private onLine(line: string): void {
    this.record('recv', line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.corrupted = 'stdout produced a non-JSON line';
      this.failAll();
      this.handle.terminate();
      return;
    }
    const response = extensionResponseSchema.safeParse(parsed);
    if (!response.success) {
      this.corrupted = 'stdout produced a line that is not a valid protocol response';
      this.failAll();
      this.handle.terminate();
      return;
    }
    const resolver = this.pending.get(response.data.id);
    if (resolver === undefined) {
      this.corrupted = `received a response for unknown request id "${response.data.id}"`;
      this.failAll();
      this.handle.terminate();
      return;
    }
    this.pending.delete(response.data.id);
    resolver(response.data);
  }

  private failAll(): void {
    for (const [, resolver] of this.pending) {
      resolver({
        jsonrpc: '2.0',
        id: 'terminated',
        error: { code: -32603, message: 'extension process terminated' },
      });
    }
    this.pending.clear();
  }

  /** The id the next request() call will use. */
  peekNextId(): string {
    return `host-${this.nextId + 1}`;
  }

  request(
    method: 'initialize' | 'extension.invoke' | 'extension.cancel' | 'extension.shutdown',
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ExtensionResponse | 'timeout'> {
    this.nextId += 1;
    const id = `host-${this.nextId}`;
    const line = serializeProtocolMessage({ jsonrpc: '2.0', id, method, params });
    this.record('send', line.trimEnd());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve('timeout');
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.handle.send(line);
    });
  }
}

function protocolError(session: InvocationSession, detail: string): ExtensionError {
  const effective = session.corruptionDetail ?? detail;
  const isOversize = effective.includes('exceeds the protocol message limit') || effective.includes('byte limit');
  return new ExtensionError(
    isOversize ? 'SBE025' : 'SBE022',
    `${effective}.`,
    isOversize
      ? 'The extension produced more output than the protocol allows; reduce its result size.'
      : 'The extension violated the stdio protocol. Report this to the extension author; ' +
        'stdout must carry protocol messages only and logs must go to stderr.',
  );
}

function validateHandshake(
  enabled: EnabledExtension,
  result: unknown,
  operation: string,
): void {
  const parsed = initializeResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new ExtensionError(
      'SBE019',
      'the extension returned an invalid initialize result.',
      'Rebuild the extension with a compatible extension SDK.',
    );
  }
  const manifest: ExtensionManifest = enabled.manifest;
  if (parsed.data.extensionId !== manifest.id || parsed.data.extensionVersion !== manifest.version) {
    throw new ExtensionError(
      'SBE020',
      `the running extension identifies as ${parsed.data.extensionId}@${parsed.data.extensionVersion}, ` +
        `but the installed manifest declares ${manifest.id}@${manifest.version}.`,
      'Reinstall the extension from a trusted source.',
    );
  }
  const major = (version: string): string => version.split('.')[0] ?? '';
  if (major(parsed.data.protocolVersion) !== major(EXTENSION_PROTOCOL_VERSION)) {
    throw new ExtensionError(
      'SBE007',
      `the extension speaks protocol ${parsed.data.protocolVersion}, ` +
        `this SpecBridge speaks ${EXTENSION_PROTOCOL_VERSION}.`,
      'Install an extension version compatible with this SpecBridge release.',
    );
  }
  const declared = new Set(manifest.capabilities.operations);
  for (const reported of parsed.data.capabilities.operations) {
    if (!declared.has(reported)) {
      throw new ExtensionError(
        'SBE021',
        `the extension reported operation "${reported}" that its manifest does not declare.`,
        'Runtime capability escalation is not allowed; reinstall a consistent extension version.',
      );
    }
  }
  if (!parsed.data.capabilities.operations.includes(operation)) {
    throw new ExtensionError(
      'SBE021',
      `the extension does not support the requested operation "${operation}".`,
      `Declared operations: ${parsed.data.capabilities.operations.join(', ') || 'none'}.`,
    );
  }
}

/**
 * Run one operation against an enabled extension in a fresh child process.
 */
export async function invokeExtensionOperation(
  enabled: EnabledExtension,
  options: ExtensionInvocationOptions,
): Promise<ExtensionInvocationOutcome> {
  const manifest = enabled.manifest;
  if (manifest.entrypoint === undefined) {
    throw new ExtensionError(
      'SBE012',
      `extension "${manifest.id}" is data-only and cannot be invoked.`,
      'Only executable extension kinds support invocation.',
    );
  }
  if (!manifest.capabilities.operations.includes(options.operation)) {
    throw new ExtensionError(
      'SBE021',
      `extension "${manifest.id}" does not declare operation "${options.operation}".`,
      `Declared operations: ${manifest.capabilities.operations.join(', ') || 'none'}.`,
    );
  }

  const environment = options.environment ?? process.env;
  const secrets: string[] = [];
  for (const name of manifest.permissions.environmentVariables) {
    const value = environment[name];
    if (value !== undefined && value.length > 0) {
      secrets.push(value);
    }
  }

  const startedAt = Date.now();
  const handle = spawnExtensionProcess({
    installedDir: enabled.installedDir,
    entrypoint: manifest.entrypoint,
    grantedEnvironmentVariables: manifest.permissions.environmentVariables,
    environment,
  });
  const session = new InvocationSession(handle, secrets);

  const finishOutcome = (output: unknown): ExtensionInvocationOutcome => ({
    output,
    durationMs: Date.now() - startedAt,
    stderr: redact(handle.stderrText(), secrets),
    protocolLog: session.log,
  });

  const fail = (error: ExtensionError): never => {
    handle.terminate();
    throw error;
  };

  try {
    const startupTimeoutMs = options.startupTimeoutMs ?? EXTENSION_LIMITS.startupTimeoutMs;
    const initResponse = await session.request(
      'initialize',
      {
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        specbridgeVersion: options.specbridgeVersion ?? SPECBRIDGE_VERSION,
        extensionId: manifest.id,
        extensionVersion: manifest.version,
        operation: options.operation,
        grantedPermissions: manifest.permissions,
      },
      startupTimeoutMs,
    );
    if (initResponse === 'timeout') {
      fail(
        new ExtensionError(
          'SBE019',
          `the extension did not answer initialize within ${startupTimeoutMs} ms.`,
          'Check `specbridge extension doctor` and the extension logs (stderr).',
        ),
      );
      throw new Error('unreachable');
    }
    if (session.corruptionDetail !== undefined) {
      fail(protocolError(session, 'protocol corrupted during initialize'));
    }
    if (initResponse.error !== undefined) {
      fail(
        new ExtensionError(
          'SBE019',
          `initialize failed: ${initResponse.error.message}.`,
          'Check the extension logs (stderr) and its compatibility declaration.',
        ),
      );
    }
    validateHandshake(enabled, initResponse.result, options.operation);

    const timeoutMs = options.timeoutMs ?? EXTENSION_LIMITS.defaultOperationTimeoutMs;
    const invokeId = session.peekNextId();
    let cancelRequested = false;
    const onAbort = (): void => {
      cancelRequested = true;
      // Best-effort cooperative cancel; the timeout below still bounds us.
      void session.request('extension.cancel', { targetId: invokeId }, 1000);
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        fail(
          new ExtensionError(
            'SBE024',
            `operation "${options.operation}" was cancelled before it started.`,
            'No result was used; re-run the operation when ready.',
          ),
        );
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const invokeResponse = await session.request(
      'extension.invoke',
      {
        operation: options.operation,
        payload: options.payload,
        ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
      },
      timeoutMs,
    );
    if (options.signal !== undefined) {
      options.signal.removeEventListener('abort', onAbort);
    }

    if (invokeResponse === 'timeout') {
      fail(
        new ExtensionError(
          'SBE023',
          `operation "${options.operation}" timed out after ${timeoutMs} ms.`,
          'Increase the timeout or investigate the extension; the process was terminated.',
        ),
      );
      throw new Error('unreachable');
    }
    if (session.corruptionDetail !== undefined) {
      fail(protocolError(session, 'protocol corrupted during invocation'));
    }
    if (cancelRequested) {
      fail(
        new ExtensionError(
          'SBE024',
          `operation "${options.operation}" was cancelled.`,
          'No result was used; re-run the operation when ready.',
        ),
      );
    }
    if (invokeResponse.error !== undefined) {
      const extensionCode = invokeResponse.error.data?.['extensionCode'];
      fail(
        new ExtensionError(
          extensionCode === 'SBE024' ? 'SBE024' : extensionCode === 'SBE025' ? 'SBE025' : 'SBE030',
          `operation "${options.operation}" failed: ${invokeResponse.error.message}.`,
          'Check the extension logs (stderr tail) for details.',
        ),
      );
    }

    const invokeResult = invokeResultSchema.safeParse(invokeResponse.result);
    if (!invokeResult.success || invokeResult.data.operation !== options.operation) {
      fail(protocolError(session, 'the invoke result envelope is invalid'));
      throw new Error('unreachable');
    }
    const schemas = operationSchemas(options.operation);
    let output: unknown = invokeResult.data.output;
    if (schemas !== undefined) {
      const validated = schemas.output.safeParse(output);
      if (!validated.success) {
        fail(
          new ExtensionError(
            'SBE030',
            `the extension returned an invalid ${options.operation} result: ` +
              `${validated.error.issues[0]?.path.join('.') ?? ''} ` +
              `${validated.error.issues[0]?.message ?? 'unknown'}`.trim() + '.',
            'Report this to the extension author; the result was discarded.',
          ),
        );
      } else {
        output = validated.data;
      }
    }

    await session.request('extension.shutdown', {}, SHUTDOWN_GRACE_MS);
    handle.terminate();
    await handle.exited;
    return finishOutcome(output);
  } finally {
    handle.terminate();
  }
}

/**
 * Doctor-grade probe: spawn, initialize, shut down. Never invokes an
 * extension's business operation and performs no network requests itself.
 */
export async function probeExtensionHandshake(
  enabled: EnabledExtension,
  options: { startupTimeoutMs?: number; environment?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ ok: boolean; detail: string; stderr: string }> {
  const manifest = enabled.manifest;
  if (manifest.entrypoint === undefined) {
    return { ok: true, detail: 'data-only extension; no process to probe', stderr: '' };
  }
  const handle = spawnExtensionProcess({
    installedDir: enabled.installedDir,
    entrypoint: manifest.entrypoint,
    grantedEnvironmentVariables: manifest.permissions.environmentVariables,
    environment: options.environment ?? process.env,
  });
  const session = new InvocationSession(handle, []);
  try {
    const response = await session.request(
      'initialize',
      {
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        specbridgeVersion: SPECBRIDGE_VERSION,
        extensionId: manifest.id,
        extensionVersion: manifest.version,
        grantedPermissions: manifest.permissions,
      },
      options.startupTimeoutMs ?? EXTENSION_LIMITS.startupTimeoutMs,
    );
    if (response === 'timeout') {
      return { ok: false, detail: 'initialize timed out', stderr: handle.stderrText() };
    }
    if (session.corruptionDetail !== undefined) {
      return { ok: false, detail: session.corruptionDetail, stderr: handle.stderrText() };
    }
    if (response.error !== undefined) {
      return { ok: false, detail: `initialize failed: ${response.error.message}`, stderr: handle.stderrText() };
    }
    try {
      validateHandshake(enabled, response.result, manifest.capabilities.operations[0] ?? '');
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        stderr: handle.stderrText(),
      };
    }
    await session.request('extension.shutdown', {}, SHUTDOWN_GRACE_MS);
    return { ok: true, detail: 'handshake succeeded', stderr: handle.stderrText() };
  } finally {
    handle.terminate();
  }
}
