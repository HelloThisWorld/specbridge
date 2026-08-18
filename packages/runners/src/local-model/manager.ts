import { statSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { execa } from 'execa';
import type { LocalInferenceConfig } from '@specbridge/core';
import { validateLocalInferenceConfig } from '@specbridge/core';
import { safeHttpRequest } from '../shared/http-client.js';

/**
 * LocalModelManager: the managed llama.cpp server lifecycle.
 *
 * One manager owns at most one `llama-server` child process and shares it
 * across every logical reasoning role — planner, critic, diagnoser,
 * replanner, classifier all talk to the same loopback endpoint with
 * different prompts. Roles are cheap; model loads are not.
 *
 * Safety properties, all tested:
 *   - nothing spawns unless the configuration is enabled and coherent, and
 *     both the executable and the model file actually exist
 *   - the server binds to 127.0.0.1 ONLY; the bind address is not a
 *     configuration value, and reserved flags cannot reach extraArgs
 *   - argv arrays only — no shell ever sees these values
 *   - stdout/stderr are captured into a bounded ring; a chatty server
 *     cannot grow memory without bound
 *   - readiness is an observed /health success, never an assumption
 *   - an unexpected exit marks the manager failed; the NEXT ensureStarted
 *     may restart within the bounded restart budget (never a background
 *     restart loop)
 *   - an idle server is stopped after the configured quiet period, and
 *     stop() always reaps the child (SIGTERM, then SIGKILL)
 *
 * A local model process failure is a WORKER failure. Nothing in this module
 * touches job or task state — the orchestration layer classifies manager
 * failures separately from implementation failures.
 */

export type LocalModelStatus = 'stopped' | 'starting' | 'ready' | 'failed';

export type LocalModelStartFailureKind =
  | 'disabled'
  | 'invalid-config'
  | 'executable-missing'
  | 'model-missing'
  | 'spawn-failed'
  | 'startup-timeout'
  | 'process-exited'
  | 'restart-budget-exhausted'
  | 'cancelled';

export type LocalModelStartResult =
  | { ok: true; baseUrl: string; port: number; restarted: boolean }
  | { ok: false; kind: LocalModelStartFailureKind; problem: string };

export interface LocalModelEvent {
  type: 'starting' | 'ready' | 'stopped' | 'exited' | 'start-failed';
  detail: string;
  at: string;
}

export interface LocalModelManagerOptions {
  config: LocalInferenceConfig;
  clock?: () => Date;
  /** Structured lifecycle events (drivers record these as job events). */
  onEvent?: (event: LocalModelEvent) => void;
  /** Health-poll interval override (tests only). */
  healthPollMs?: number;
}

/** Bounded append-only text ring. */
class BoundedLog {
  private chunks: string[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  append(chunk: string): void {
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift() ?? '';
      this.bytes -= Buffer.byteLength(removed, 'utf8');
    }
  }
  excerpt(maxChars = 4_000): string {
    const joined = this.chunks.join('');
    return joined.length > maxChars ? joined.slice(-maxChars) : joined;
  }
}

/**
 * The structural slice of an execa subprocess the manager relies on. Kept
 * minimal so execa's parameterized promise type stays an implementation
 * detail (its full generic shape does not survive exactOptionalPropertyTypes
 * assignments to a field).
 */
type ManagedChild = Promise<unknown> & {
  kill: (signal?: NodeJS.Signals | number) => boolean;
  stdout?: NodeJS.ReadableStream | null | undefined;
  stderr?: NodeJS.ReadableStream | null | undefined;
};

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function fileExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export class LocalModelManager {
  private readonly config: LocalInferenceConfig;
  private readonly clock: () => Date;
  private readonly onEvent: ((event: LocalModelEvent) => void) | undefined;
  private readonly healthPollMs: number;

  private child: ManagedChild | undefined;
  private childExited = false;
  private currentStatus: LocalModelStatus = 'stopped';
  private currentPort = 0;
  private restarts = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly log: BoundedLog;

  constructor(options: LocalModelManagerOptions) {
    this.config = options.config;
    this.clock = options.clock ?? ((): Date => new Date());
    this.onEvent = options.onEvent;
    this.healthPollMs = Math.max(50, options.healthPollMs ?? 500);
    this.log = new BoundedLog(this.config.maxLogBytes);
  }

  status(): LocalModelStatus {
    return this.currentStatus;
  }

  /** The OpenAI-compatible base URL, when the server is ready. */
  endpoint(): string | undefined {
    return this.currentStatus === 'ready' ? `http://127.0.0.1:${this.currentPort}/v1` : undefined;
  }

  restartCount(): number {
    return this.restarts;
  }

  /** Bounded tail of the server's stdout/stderr (diagnostics only). */
  logsExcerpt(maxChars = 4_000): string {
    return this.log.excerpt(maxChars);
  }

  private emit(type: LocalModelEvent['type'], detail: string): void {
    this.onEvent?.({ type, detail, at: this.clock().toISOString() });
  }

  /**
   * Ensure the managed server is running and healthy. Idempotent: a ready
   * server returns immediately; a stopped or failed one starts (within the
   * restart budget); concurrent callers share one startup.
   */
  private startupInFlight: Promise<LocalModelStartResult> | undefined;

  async ensureStarted(signal?: AbortSignal): Promise<LocalModelStartResult> {
    if (this.currentStatus === 'ready' && this.child !== undefined && !this.childExited) {
      this.touch();
      return { ok: true, baseUrl: `http://127.0.0.1:${this.currentPort}/v1`, port: this.currentPort, restarted: false };
    }
    if (this.startupInFlight !== undefined) return this.startupInFlight;
    this.startupInFlight = this.startOnce(signal).finally(() => {
      this.startupInFlight = undefined;
    });
    return this.startupInFlight;
  }

  private async startOnce(signal?: AbortSignal): Promise<LocalModelStartResult> {
    const config = this.config;
    if (!config.enabled) {
      return { ok: false, kind: 'disabled', problem: 'localInference.enabled is false.' };
    }
    const validation = validateLocalInferenceConfig(config);
    if (!validation.ok) {
      return { ok: false, kind: 'invalid-config', problem: validation.problems.join(' ') };
    }
    const executable = config.executable as string;
    const model = config.model as string;
    if (!fileExists(executable)) {
      return {
        ok: false,
        kind: 'executable-missing',
        problem: `The llama.cpp server executable was not found at ${executable}.`,
      };
    }
    if (!fileExists(model)) {
      return { ok: false, kind: 'model-missing', problem: `The GGUF model file was not found at ${model}.` };
    }

    // A previous process failed: restarting is bounded, and only ever
    // happens here — lazily, on the next request — never in the background.
    const restarted = this.currentStatus === 'failed';
    if (restarted) {
      if (this.restarts >= config.maxRestarts) {
        return {
          ok: false,
          kind: 'restart-budget-exhausted',
          problem:
            `The local model process failed and the restart budget (${config.maxRestarts}) is exhausted. ` +
            'Reasoning escalates instead of restarting again.',
        };
      }
      this.restarts += 1;
    }

    const port = config.port !== 0 ? config.port : await allocateLoopbackPort();
    this.currentPort = port;
    this.currentStatus = 'starting';
    this.childExited = false;
    this.stopping = false;
    this.emit('starting', `llama-server on 127.0.0.1:${port} (model ${model})`);

    // The bind address is a constant. There is deliberately no code path in
    // which any configuration value reaches --host: executableArgs and
    // extraArgs both reject the reserved flags at parse time.
    const argv = [
      ...config.executableArgs,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-m',
      model,
      '-c',
      String(config.contextSize),
      '-np',
      String(config.parallel),
      ...(config.gpuLayers !== null ? ['-ngl', String(config.gpuLayers)] : []),
      ...config.extraArgs,
    ];

    let child: ManagedChild;
    try {
      child = execa(executable, argv, {
        cwd: process.cwd(),
        reject: false,
        buffer: false,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      }) as unknown as ManagedChild;
    } catch (cause) {
      this.currentStatus = 'failed';
      return {
        ok: false,
        kind: 'spawn-failed',
        problem: `llama-server could not be spawned: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.log.append(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => this.log.append(chunk.toString('utf8')));
    void child.then(() => {
      this.childExited = true;
      if (!this.stopping) {
        this.currentStatus = 'failed';
        this.emit('exited', `llama-server exited unexpectedly (restarts used: ${this.restarts}/${config.maxRestarts})`);
      }
    });

    // Wait for observed health, bounded by the startup timeout.
    const deadline = Date.now() + config.startupTimeoutMs;
    for (;;) {
      if (signal?.aborted === true) {
        await this.stop('startup cancelled');
        return { ok: false, kind: 'cancelled', problem: 'Startup was cancelled.' };
      }
      if (this.childExited) {
        this.currentStatus = 'failed';
        this.emit('start-failed', 'the server process exited during startup');
        return {
          ok: false,
          kind: 'process-exited',
          problem: `llama-server exited during startup. Last output: ${this.log.excerpt(500) || '(none)'}`,
        };
      }
      if (Date.now() > deadline) {
        await this.stop('startup timeout');
        this.currentStatus = 'failed';
        this.emit('start-failed', `no healthy response within ${config.startupTimeoutMs} ms`);
        return {
          ok: false,
          kind: 'startup-timeout',
          problem: `llama-server did not become healthy within ${config.startupTimeoutMs} ms.`,
        };
      }
      const health = await safeHttpRequest({
        method: 'GET',
        url: `http://127.0.0.1:${port}/health`,
        timeoutMs: Math.min(2_000, config.startupTimeoutMs),
        maxResponseBytes: 4_096,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (health.ok && health.status === 200) break;
      await new Promise<void>((resolve) => setTimeout(resolve, this.healthPollMs));
    }

    this.currentStatus = 'ready';
    this.emit('ready', `llama-server healthy on 127.0.0.1:${port}`);
    this.touch();
    return { ok: true, baseUrl: `http://127.0.0.1:${port}/v1`, port, restarted };
  }

  /** Record activity: postpones the idle shutdown. Call once per request. */
  touch(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (this.currentStatus !== 'ready') return;
    this.idleTimer = setTimeout(() => {
      void this.stop('idle shutdown');
    }, this.config.idleShutdownMs);
    // The idle timer must never keep the owning process alive.
    this.idleTimer.unref?.();
  }

  /** Stop the managed server and reap the child. Safe to call repeatedly. */
  async stop(reason = 'stop requested'): Promise<void> {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const child = this.child;
    this.stopping = true;
    if (child !== undefined && !this.childExited) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (!this.childExited) child.kill('SIGKILL');
      }, 3_000);
      killTimer.unref?.();
      await child.catch(() => undefined);
      clearTimeout(killTimer);
    }
    this.child = undefined;
    // An unexpected exit already marked the manager failed; an intentional
    // stop must not launder that into 'stopped', or the bounded restart
    // accounting would lose track of the failure.
    if (this.currentStatus !== 'failed') {
      this.currentStatus = 'stopped';
    }
    this.emit('stopped', reason);
  }
}
