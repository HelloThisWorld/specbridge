import { HarnessClient, RequestTimeoutError, SdkProtocolError, TransportClosedError, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client';

/**
 * DshSdkAdapter — the ONLY SpecBridge module that touches the official
 * DeepSeek Harness SDK (vNext.3).
 *
 * Everything above this file (runner, events, errors, orchestration) speaks
 * SpecBridge-local shapes; nothing exported here re-exposes an upstream
 * class or type, so a breaking DSH SDK change is absorbed in exactly one
 * place and DSH/Cordis types cannot leak into SpecBridge domain packages.
 *
 * Tested against `@deepseek-ai/dsh-sdk-client@0.1.1-rc.1` (see
 * DSH_SDK_TESTED_VERSION). The adapter drives the package-root
 * `HarnessClient` — the SDK's documented lower-level protocol client —
 * rather than the `DeepSeekHarness` owned-run wrapper, because SpecBridge
 * must observe the `initialize` result (runtime identity + version) and the
 * wrapper performs its handshake internally without exposing it. The
 * activity-interval collection below (enqueue receipt → whole-agent idle)
 * follows the SDK's documented `run()` semantics exactly.
 *
 * Upstream facts this adapter is built on:
 *
 *   - the launch spec is explicit (`command`/`args`); there is no bundled
 *     runtime resolution on the TypeScript side;
 *   - `HarnessClientOptions.env` REPLACES the child environment when given —
 *     the caller owns credential policy (SpecBridge passes an allowlist);
 *   - the wire has NO mid-turn cancel: abandoning a run means closing the
 *     runtime, and `close()` walks a bounded shutdown → stdin-EOF → SIGTERM
 *     → SIGKILL ladder until the child has actually exited;
 *   - a run settles at the next whole-agent idle and is otherwise unbounded
 *     — the caller enforces its own deadline via {@link DshSdkAdapter.close};
 *   - the handshake returns the wire-stable server identity
 *     `deepseek-harness-sdk-runtime` plus the runtime version.
 */

/** The exact upstream SDK version this adapter was written and tested against. */
export const DSH_SDK_TESTED_VERSION = '0.1.1-rc.1';

/** Wire-stable identity the runtime must report from `initialize`. */
export const DSH_RUNTIME_SERVER_NAME = 'deepseek-harness-sdk-runtime';

/** Hard cap on retained notifications per run (mirrors MAX_RETAINED_EVENTS). */
export const MAX_RETAINED_DSH_NOTIFICATIONS = 5000;

/** One server-to-client notification, as a plain SpecBridge-local shape. */
export interface DshNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface DshLaunchSpec {
  command: string;
  args: string[];
  /** Working directory for the runtime process AND the handshake cwd. */
  workspaceRoot: string;
  /** COMPLETE child environment (allowlist-built; never full inheritance). */
  env: Record<string, string>;
  /** Provider route for `initialize` (required by the wire protocol). */
  provider: string;
  /** Model for `initialize` (required by the wire protocol). */
  model: string;
  /** Optional output-token cap inherited by the runtime's agents. */
  maxTokens?: number | undefined;
  /** Bound for individual protocol requests (initialize/prompt/shutdown). */
  requestTimeoutMs: number;
}

/** Why the adapter deliberately closed the runtime mid-run. */
export type DshCloseCause = 'cancelled' | 'timed-out' | 'session-unavailable';

/** Classified SDK/transport failure in SpecBridge-local vocabulary. */
export interface DshFailure {
  kind:
    | 'launch'
    | 'transport-closed'
    | 'request-timeout'
    | 'protocol-violation'
    | 'rpc-error'
    | 'identity-mismatch'
    | 'closed-by-adapter'
    | 'unknown';
  message: string;
  /** JSON-RPC error code, when the runtime answered with one. */
  rpcCode?: number | undefined;
  /** The deliberate close cause, when SpecBridge itself ended the run. */
  closeCause?: DshCloseCause | undefined;
}

export class DshAdapterError extends Error {
  readonly failure: DshFailure;
  constructor(failure: DshFailure) {
    super(failure.message);
    this.name = 'DshAdapterError';
    this.failure = failure;
  }
}

export interface DshHandshake {
  serverName: string;
  serverVersion: string;
}

export interface DshRunObservation {
  sessionId: string;
  /** Concatenated text of the interval's last assistant message ('' when none). */
  finalResponse: string;
  /** Retained notifications in wire order (bounded; excess is counted). */
  notifications: DshNotification[];
  droppedNotifications: number;
}

export interface DshRunOptions {
  sessionId: string;
  prompt: string;
  /** Streaming observer; called for every notification BEFORE retention caps. */
  onNotification?: ((notification: DshNotification) => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(event: unknown, messageId: string): boolean {
  if (!isRecord(event) || event['type'] !== 'agent/inbox/spliced' || !isRecord(event['data'])) {
    return false;
  }
  const inserted = event['data']['inserted'];
  return (
    Array.isArray(inserted) &&
    inserted.some((message) => isRecord(message) && message['id'] === messageId)
  );
}

/** Concatenated text blocks of the last assistant/message event ('' when none). */
export function lastAssistantText(notifications: readonly DshNotification[], sessionId: string): string {
  for (let index = notifications.length - 1; index >= 0; index--) {
    const notification = notifications[index];
    if (notification === undefined || notification.method !== 'session.event') continue;
    if (notification.params['sessionId'] !== sessionId) continue;
    const event = notification.params['event'];
    if (!isRecord(event) || event['type'] !== 'assistant/message' || !isRecord(event['data'])) continue;
    const message = event['data']['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) continue;
    return message['content']
      .filter((block): block is { type: string; text: string } =>
        isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string')
      .map((block) => block.text)
      .join('');
  }
  return '';
}

function classify(error: unknown, closeCause: DshCloseCause | undefined): DshFailure {
  if (closeCause !== undefined) {
    return {
      kind: 'closed-by-adapter',
      message: `the runtime was closed by SpecBridge (${closeCause})`,
      closeCause,
    };
  }
  if (error instanceof JsonRpcResponseError) {
    return {
      kind: 'rpc-error',
      message: error.message,
      rpcCode: typeof error.code === 'number' ? error.code : undefined,
    };
  }
  if (error instanceof RequestTimeoutError) {
    return { kind: 'request-timeout', message: error.message };
  }
  if (error instanceof SdkProtocolError) {
    return { kind: 'protocol-violation', message: error.message };
  }
  if (error instanceof TransportClosedError) {
    // "The runtime subprocess is gone or unusable: it exited, its stdio
    // closed, or it was never launchable." Distinguish never-launchable so
    // remediation stays accurate.
    const message = error.message;
    if (/ENOENT|EACCES|not launchable|never launchable|spawn/i.test(message)) {
      return { kind: 'launch', message };
    }
    return { kind: 'transport-closed', message };
  }
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

/**
 * One adapter instance owns one runtime subprocess lifecycle: open →
 * runPrompt* → close. Instances are single-use like the underlying client —
 * a closed adapter refuses reuse.
 */
export class DshSdkAdapter {
  private readonly spec: DshLaunchSpec;
  private client: HarnessClient | undefined;
  private closeCause: DshCloseCause | undefined;
  private closed = false;
  private lastPartial: { notifications: DshNotification[]; droppedNotifications: number } = {
    notifications: [],
    droppedNotifications: 0,
  };

  constructor(spec: DshLaunchSpec) {
    this.spec = spec;
  }

  /** The deliberate close cause, if SpecBridge ended the runtime itself. */
  get deliberateCloseCause(): DshCloseCause | undefined {
    return this.closeCause;
  }

  /** Notifications observed before the most recent run settled (bounded). */
  get partialObservation(): { notifications: DshNotification[]; droppedNotifications: number } {
    return this.lastPartial;
  }

  private instance(): HarnessClient {
    if (this.closed) {
      throw new DshAdapterError({
        kind: 'closed-by-adapter',
        message: 'the adapter is closed; a closed adapter refuses reuse',
        closeCause: this.closeCause,
      });
    }
    this.client ??= new HarnessClient({
      command: this.spec.command,
      args: this.spec.args,
      cwd: this.spec.workspaceRoot,
      env: this.spec.env,
      requestTimeoutMs: this.spec.requestTimeoutMs,
    });
    return this.client;
  }

  /**
   * Spawn the runtime and perform the `initialize` handshake once. Verifies
   * the wire-stable server identity: a runtime answering with a different
   * name is incompatible, and SpecBridge refuses to run agentic work on it.
   */
  async open(): Promise<DshHandshake> {
    const client = this.instance();
    try {
      client.start();
      const result = await client.initialize({
        cwd: this.spec.workspaceRoot,
        provider: this.spec.provider,
        model: this.spec.model,
        ...(this.spec.maxTokens !== undefined ? { maxTokens: this.spec.maxTokens } : {}),
      });
      const identity: DshHandshake = {
        serverName: result.serverInfo.name,
        serverVersion: result.serverInfo.version,
      };
      if (identity.serverName !== DSH_RUNTIME_SERVER_NAME) {
        throw new DshAdapterError({
          kind: 'identity-mismatch',
          message:
            `the launched runtime identifies as "${identity.serverName || '(none)'}" — expected ` +
            `"${DSH_RUNTIME_SERVER_NAME}". SpecBridge refuses to run agentic work on an ` +
            'unrecognized runtime.',
        });
      }
      return identity;
    } catch (error) {
      if (error instanceof DshAdapterError) throw error;
      throw new DshAdapterError(classify(error, this.closeCause));
    }
  }

  /**
   * Queue one prompt on the named session and collect the activity interval
   * from the durable enqueue receipt through the next whole-agent idle —
   * the SDK's documented owned-run semantics. UNBOUNDED by itself: callers
   * enforce deadlines by calling {@link close} (there is no wire cancel).
   */
  async runPrompt(options: DshRunOptions): Promise<DshRunObservation> {
    const client = this.instance();
    const retained: DshNotification[] = [];
    let dropped = 0;
    const collect = (notification: DshNotification): void => {
      options.onNotification?.(notification);
      if (retained.length < MAX_RETAINED_DSH_NOTIFICATIONS) retained.push(notification);
      else dropped += 1;
    };
    const subscription = client.subscribeSessionTree(options.sessionId);
    try {
      const messageId = await client.prompt(options.sessionId, [
        { type: 'text', text: options.prompt },
      ]);
      let received = false;
      for (;;) {
        const raw = await subscription.next();
        const notification: DshNotification = { method: raw.method, params: raw.params };
        if (!received) {
          if (
            notification.method !== 'session.event' ||
            notification.params['sessionId'] !== options.sessionId ||
            !isInboxReceipt(notification.params['event'], messageId)
          ) {
            continue;
          }
          received = true;
        }
        collect(notification);
        if (
          notification.method === 'session.status' &&
          notification.params['sessionId'] === options.sessionId &&
          notification.params['status'] === 'idle'
        ) {
          break;
        }
      }
      return {
        sessionId: options.sessionId,
        finalResponse: lastAssistantText(retained, options.sessionId),
        notifications: retained,
        droppedNotifications: dropped,
      };
    } catch (error) {
      if (error instanceof DshAdapterError) throw error;
      throw new DshAdapterError(classify(error, this.closeCause));
    } finally {
      subscription.close();
      this.lastPartial = { notifications: retained, droppedNotifications: dropped };
    }
  }

  /**
   * Tear the runtime down to quiescence: best-effort protocol `shutdown`,
   * then the SDK's stdin-EOF → SIGTERM → SIGKILL ladder, resolving only
   * after the child has actually exited. Idempotent. `cause` marks a
   * DELIBERATE SpecBridge close (cancellation, deadline, or a failed
   * session-continuity check) so the run rejection that follows is
   * classified by intent instead of as a provider failure.
   */
  async close(cause?: DshCloseCause): Promise<void> {
    if (cause !== undefined && this.closeCause === undefined) this.closeCause = cause;
    this.closed = true;
    const client = this.client;
    if (client === undefined) return;
    try {
      await client.close();
    } catch {
      // Teardown is best-effort beyond the SDK's own ladder; the ladder
      // itself only throws when the child cannot be terminated at all, and
      // retrying here could not do better.
    }
  }
}

/** Classify an unknown error thrown across the adapter boundary. */
export function dshFailureOf(error: unknown): DshFailure {
  if (error instanceof DshAdapterError) return error.failure;
  return classify(error, undefined);
}
